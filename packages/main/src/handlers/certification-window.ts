import { isDeepStrictEqual } from 'node:util';
import { withValidationMetadataWrite } from '../core/validation-execution-lock.js';
import { withReviewInventoryMutationLock, verifyReviewInventoryEpoch, verifyReviewInventoryReceipt } from '../core/review-inventory-epoch.js';
import { persistAdmittingCertificationWindow, nonInventoryAdmitRefusal, windowAuthorizesHeavyCertification, type CertificationWindow } from '../core/certification-window.js';
import { isValidationMetadataBusy } from '../core/validation-execution-lock.js';
import { rethrowIntentAmendmentIntegrityError } from '../core/verification-intent-amendment.js';
import type { HandlerContext } from './context.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { reportHealthIssue } from '../core/health.js';
import { existsSync, realpathSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { isFindingBlocking } from '../core/advisory.js';
import { loadConfig } from '../core/config.js';
import {
  currentGitHead,
  currentMaterialHash,
  currentStoryFilesHash,
  EMPTY_STORY_FILES_HASH,
} from '../core/evidence-freshness.js';
// B-5a15 main-merge: main deleted currentStoryFileHashEntries; this now uses main's
// resolveStoryChangedFiles from story-aware-validation.ts. It is NOT signature- or
// behaviour-identical, so the compensating code below is load-bearing -- do not remove it:
//  - it THROWS with no merge base where our helper returned undefined, hence the try/catch
//    that restores the original `return undefined` contract;
//  - it returns `blobId` where ours returned `objectId`;
//  - it sorts with localeCompare, which F-334 forbids for hash material. That is safe ONLY
//    because the digest below re-sorts the joined `path\0blobId` strings with a bare
//    .sort() (byte order), matching currentStoryFilesHash. Keep that re-sort.
//  - it takes an extra 4th param and drops per-path dedupe; neither is reachable here.
import { resolveStoryChangedFiles, type StoryChangedFile } from '../core/story-aware-validation.js';
import {
  CAUSAL_DEPENDENCY_DOMAINS,
  causalDigest,
  causalDependencyContextDigests,
  evaluateCausalDependencies,
  type CausalDependencyDomain,
  type CausalDependencyNode,
  type CausalDependencyDecision,
} from '../core/causal-evidence.js';
import { resolveEffectiveBlockingSeverities } from '../core/guard-utils.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { buildVerificationCoverage } from '../core/verification.js';
import { createVerificationEvidenceGateEvaluator } from '../core/proof-admissibility.js';
import { resolveWorkflowPolicy } from '../core/workflow-policy.js';
import {
  classifyDonePrepareWorktree,
  donePrepareExpectedMainSha,
  isDonePrepareGitIndexReadable,
  isDonePrepareMainAncestor,
  isEvidenceTargetWritable,
  nonRuntimeDirtyEntries,
} from '../core/done-prepare-validation-reuse.js';
import {
  CERTIFICATION_WINDOW_SCHEMA,
  evaluateCertificationWindowAdmit,
  inspectCertificationWindowLineage,
  loadReviewInventoryAdmitApis,
  loadVerifiedCertificationWindow,
  persistAdmittedCertificationWindow,
  persistBlockedCertificationWindow,
  persistCancelledCertificationWindow,
  projectCertificationWindowStatus,
  refreshCertificationWindowLineage,
  renderCertificationWindowStatus,
  PRECERT_TEST_IDENTITY,
  PRECERT_VERIFIER_IDENTITY,
  PRE_CERT_INVENTORY_NOT_FINALIZED,
  PRE_CERT_WINDOW_INVALIDATED,
  type CertificationWindowAdmitFacts,
  type CertificationWindowCurrentIdentity,
  type CertificationWindowFrozenIdentity,
  type CertificationWindowInventoryBinding,
  type CertificationWindowStatusProjection,
  type ReviewInventoryAdmitPair,
} from '../core/certification-window.js';
import { REVIEW_INVENTORY_EPOCHS_SCHEMA } from '../core/review-inventory-epoch.js';
import { assertActiveIdentityConsumerContract } from '../core/active-identity-consumer-contract.js';

function persistHint(root: string, storyId: string, command: string, state: string): string {
  try {
    return autoCommitStoryMetadata(root, storyId, command);
  } catch (error) {
    if (isValidationMetadataBusy(error)) throw new Error(`${String(error)}; certification window state ${state} is already recorded; inspect certification_window_status and retry the original ${command} request`);
    const reported = error instanceof Error ? error : { message: String(error) };
    reportHealthIssue(`persist:certification-window:${command}`, reported, { storyId, root });
    return '';
  }
}

function render(projection: CertificationWindowStatusProjection, hint = ''): string {
  const text = renderCertificationWindowStatus(projection);
  return hint ? `${text}${hint}` : text;
}

function refuseBlocked(text: string): never {
  throw new Error(text);
}

function readInventoryPair(
  apis: NonNullable<ReturnType<typeof loadReviewInventoryAdmitApis>>,
  store: unknown,
  storyId: string,
): ReviewInventoryAdmitPair | null {
  try {
    return apis.finalizedUnconsumedReviewInventory(store, storyId);
  } catch {
    return null;
  }
}

const CERTIFICATION_INPUT_IDS = CAUSAL_DEPENDENCY_DOMAINS.map(domain => `certification:${domain}`);

/**
 * B-5a15 F-325: real causal edges between the certification domains.
 *
 * The previous shape was `dependencyIds: [CAUSAL_DEPENDENCY_DOMAINS[index - 1]]`, i.e. a
 * straight chain following ARRAY DECLARATION ORDER. That is not a causal relationship: a
 * test-only change invalidated build-input, manifest-semantic, integration AND
 * review-subject, contradicting CHK-003:edge:0's requirement that each domain has a
 * distinct invalidation boundary and only the declared dependent closure goes stale.
 *
 * Each entry lists the domains a node is DOWNSTREAM of, derived from what
 * CERTIFICATION_DOMAIN_PATH_RULES actually classifies into each domain:
 *  - build-input    (lockfiles, tsconfig, *.config.json) compiles everything -> upstream of all
 *  - source         (packages/main/src, excl. tasks) is exercised by tests and driven by bins
 *  - manifest-semantic (host adapter dirs) is consumed by the integration entrypoints
 *  - test           (tests/, src/tasks/) additionally consumes integration, because 24 files
 *                   in the test domain EXECUTE integration-domain artifacts -- e.g.
 *                   codex-heartbeat-timeout-smoke.ts:273 runs `bin/proof-or-stop.js`. Without
 *                   this edge a bin/ change reruns only certification-integration, then
 *                   causalRerunComplete admits the gate while certification-test still holds
 *                   evidence earned against the OLD bin (B-5a15 F-337).
 *  - integration    (bin/, scripts/, .githooks/, sibling packages) additionally consumes
 *                   review-subject, because scripts/ contains contract verifiers that read
 *                   docs as LOAD-BEARING assertion inputs -- verify-process-fact-contract.mjs
 *                   asserts over AGENTS.md and five docs/requirements/decisions/*.md files,
 *                   and it is DONE-required via test:serial-reference. Omitting this edge
 *                   under-invalidates: a docs-only edit would leave certification-integration
 *                   reported FRESH when a real input of it changed (B-5a15 F-336).
 *  - review-subject (docs/, AGENTS|CLAUDE|README) is terminal: nothing is built from docs
 */
const CERTIFICATION_DOMAIN_DEPENDENCIES: Readonly<Record<CausalDependencyDomain, readonly CausalDependencyDomain[]>> = {
  'build-input': [],
  'source': ['build-input'],
  'manifest-semantic': ['build-input'],
  'test': ['build-input', 'source', 'integration'],
  'integration': ['build-input', 'source', 'manifest-semantic', 'review-subject'],
  'review-subject': [],
};

// A build-like basename alone does not establish a current build surface. Admit
// repo-root inputs and the existing package/entrypoint/integration roots only;
// unknown namespaces stay unclassified, including live historical metadata.
// This shared definition also excludes those exact files from the broad
// integration surfaces. All other overlaps still fail closed, not first-match.
const CERTIFICATION_BUILD_INPUT_PATH_PATTERN = /^(?:(?:bin|scripts|\.githooks|packages\/[^/]+)\/(?:[^/]+\/)*)?(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|tsconfig(?:\.[^/]+)?\.json|lattice\.config\.json|proof-or-stop\.config\.json)$/;
const CERTIFICATION_NON_BUILD_INPUT_PREFIX = `^(?!${CERTIFICATION_BUILD_INPUT_PATH_PATTERN.source})`;

// Exported for the B-5a15:F-393 regression test only. certificationDomainForPath
// requires `matches.length === 1`, so the rules must stay mutually exclusive by
// hand -- a second matching rule fails closed to undefined exactly like no match,
// and aborts the whole causal-input derivation. Exporting the DATA (not the
// classifier) lets a test assert that invariant without widening behavioural API.
export const CERTIFICATION_DOMAIN_PATH_RULES: ReadonlyArray<readonly [CausalDependencyDomain, RegExp]> = [
  ['test', /^packages\/main\/(?:tests\/|src\/tasks\/)/],
  ['build-input', CERTIFICATION_BUILD_INPUT_PATH_PATTERN],
  ['manifest-semantic', /^(?:\.proof-or-stop-codex|\.codex|\.claude)\//],
  ['manifest-semantic', /^\.proof-or-stop\/proof-or-stop\.json$/],
  // B-5a15: `scripts/` here anchors at the repo root, so a per-package verifier
  // script such as packages/graph/scripts/verify-missing-assets-fail.mjs matched NO
  // rule. Because certificationDomainForPath requires exactly one match, an unmatched
  // path made deriveCertificationDomainInputHashes return undefined for the whole
  // story, which blocked certification_window_begin with
  // [pre_cert_causal_freshness_required]. Package-local scripts are integration
  // surface for the same reason root scripts/ is: they are executable verifiers, not
  // product source.
  //
  // The added alternative EXCLUDES utils and lab, which the rule above already
  // covers wholesale. certificationDomainForPath requires `matches.length === 1`,
  // so a path matching two rules is treated as ambiguous and returns undefined --
  // identically to matching none. A first draft of this fix used a bare
  // `packages/[^/]+/scripts/`, which made packages/utils/scripts/** and
  // packages/lab/scripts/** double-match and would have broken certification for
  // any future story touching them, while passing here only because this story
  // touches neither. Verified by enumeration, not by inspection.
  ['integration', new RegExp(`${CERTIFICATION_NON_BUILD_INPUT_PREFIX}(?:bin|scripts|\\.githooks|packages/(?:utils|lab))/`)],
  ['integration', new RegExp(`${CERTIFICATION_NON_BUILD_INPUT_PREFIX}packages/(?!utils/|lab/)[^/]+/scripts/`)],
  ['source', /^packages\/main\/src\/(?!tasks\/)/],
  ['review-subject', /^(?:docs\/|(?:AGENTS|CLAUDE|README)(?:\.[^/]+)?$)/],
  // Tracked release provenance is review material, not runtime/build input or
  // authoritative gate evidence. Bind exact blobs/tombstones and invalidate the
  // existing review-subject -> integration -> test closure; unknown siblings refuse.
  ['review-subject', /^\.proof-or-stop\/(?:artifact-releases|capability-releases)\.jsonl$/],
];

function certificationDomainForPath(path: string): CausalDependencyDomain | undefined {
  const matches = CERTIFICATION_DOMAIN_PATH_RULES.filter(([, pattern]) => pattern.test(path));
  return matches.length === 1 ? matches[0][0] : undefined;
}

// Migration-only audit inputs, never a restored runtime namespace. The shared
// Git resolver retains these deleted paths and rename old sides after identity
// cutover. Keep their full path/tombstone in the review subject and its dependent
// integration/test closure; live old-namespace files and unknown shapes refuse.
const HISTORICAL_STORY_MIGRATION_PATH = /^\.lattice\/story\/actives\/B-[A-Za-z0-9][A-Za-z0-9-]*\/(?:background\.md|checklist\.json|execution-boundary\.json|index\.json|init-check\.json|process-events\.jsonl|scope-boundary\.json|scope-freeze-check\.json)$/;

function certificationDomainForEntry(entry: StoryChangedFile): CausalDependencyDomain | undefined {
  if (HISTORICAL_STORY_MIGRATION_PATH.test(entry.path)) {
    return entry.blobId === '<deleted>'
      && (entry.status === 'deleted' || (entry.status === 'renamed' && entry.oldPath === entry.path))
      ? 'review-subject'
      : undefined;
  }
  return certificationDomainForPath(entry.path);
}

/**
 * Derive one stable causal input from each declared domain's story-owned
 * files. Unknown or ambiguously classified paths deliberately return
 * undefined so the evaluator falls back to strict whole-tree freshness.
 */
export function deriveCertificationDomainInputHashes(
  gitCwd: string,
  ref = 'HEAD',
  metadataRoot: string = gitCwd,
): Record<string, string> | undefined {
  let entries;
  try { entries = resolveStoryChangedFiles(gitCwd, ref, metadataRoot); }
  catch { return undefined; }
  const byDomain = new Map<CausalDependencyDomain, string[]>(
    CAUSAL_DEPENDENCY_DOMAINS.map(domain => [domain, []]),
  );
  for (const entry of entries) {
    const domain = certificationDomainForEntry(entry);
    if (!domain) return undefined;
    byDomain.get(domain)!.push(`${entry.path}\0${entry.blobId || '<deleted>'}`);
  }
  return Object.fromEntries(CAUSAL_DEPENDENCY_DOMAINS.map(domain => [
    `certification:${domain}`,
    causalDigest(byDomain.get(domain)!.sort()),
  ]));
}

export function buildCertificationDecision(
  storyId: string,
  current: CertificationWindowCurrentIdentity,
  frozen?: CertificationWindowFrozenIdentity,
): CausalDependencyDecision | undefined {
  if (!current.materialHash || !current.storyFilesHash) return undefined;
  const currentStoryFilesHash = current.storyFilesHash;
  const previous = frozen ?? {
    headHash: current.headHash ?? '',
    materialHash: current.materialHash,
    storyFilesHash: current.storyFilesHash,
    causalInputHashes: current.causalInputHashes,
    expectedMainSha: '',
    verifierIdentity: PRECERT_VERIFIER_IDENTITY,
    testIdentity: PRECERT_TEST_IDENTITY,
  };
  const emptyStoryFilesHash = previous.storyFilesHash === EMPTY_STORY_FILES_HASH
    || current.storyFilesHash === EMPTY_STORY_FILES_HASH;
  // CertificationWindow is the production consumer of the declared causal
  // DAG. Its current materialization has one authoritative story-owned
  // snapshot, so each domain is represented explicitly while the snapshot is
  // fanned through the transitive domain graph. This keeps the production path
  // fail-closed and observable instead of silently evaluating nodes: [].
  const currentInputHashes = current.causalInputHashes ?? {};
  const previousInputHashes = previous.causalInputHashes ?? {};
  const nodes: CausalDependencyNode[] = CAUSAL_DEPENDENCY_DOMAINS.map((domain, index) => ({
    id: `certification-${domain}`,
    domain,
    inputIds: [CERTIFICATION_INPUT_IDS[index]],
    ...(CERTIFICATION_DOMAIN_DEPENDENCIES[domain].length > 0
      ? { dependencyIds: CERTIFICATION_DOMAIN_DEPENDENCIES[domain].map(dep => `certification-${dep}`) }
      : {}),
    recordedInputHashes: { [CERTIFICATION_INPUT_IDS[index]]: previousInputHashes[CERTIFICATION_INPUT_IDS[index]] ?? '' },
  }));
  const contextDigests = causalDependencyContextDigests(nodes, currentInputHashes);
  current.causalDependencyGraphDigest = contextDigests.dependencyGraphDigest;
  current.causalInputHashesDigest = contextDigests.currentInputHashesDigest;
  return evaluateCausalDependencies({
    storyId,
    nodes,
    currentInputHashes,
    previousMaterialHash: previous.materialHash,
    currentMaterialHash: current.materialHash,
    previousStoryFilesHash: previous.storyFilesHash,
    currentStoryFilesHash,
    ...(previous.headHash !== undefined ? { previousHeadHash: previous.headHash } : {}),
    ...(current.headHash !== undefined ? { currentHeadHash: current.headHash } : {}),
    doneRequired: emptyStoryFilesHash,
  });
}

function collectAdmitFacts(
  ctx: HandlerContext,
  storyId: string,
  apis: NonNullable<ReturnType<typeof loadReviewInventoryAdmitApis>>,
): CertificationWindowAdmitFacts {
  const gitCwd = resolveGitCwd({
    store: ctx.store,
    storyId,
    metadataRoot: ctx.root,
    projectRoot: ctx.root,
  });
  const headHash = currentGitHead(gitCwd);
  const materialHash = currentMaterialHash(gitCwd, 'HEAD', ctx.root);
  const storyFilesHash = currentStoryFilesHash(gitCwd, 'HEAD', ctx.root);
  const identity = currentCertificationIdentity(ctx, storyId);
  const expectedMainSha = donePrepareExpectedMainSha(gitCwd);
  let missingRequiredIntents = 0;
  try {
    // headHash-only metadata commits are not a re-run signal when storyFilesHash still matches.
    missingRequiredIntents = buildVerificationCoverage(
      ctx.store.readChecklist(storyId),
      headHash,
      (_evidenceHead, evidence) => {
        const recorded = evidence?.storyFilesHash;
        return Boolean(storyFilesHash && recorded && recorded === storyFilesHash);
      },
      { receiptAdmissibility: createVerificationEvidenceGateEvaluator(ctx.root, storyId) },
    ).missingRequired;
  } catch (intentIntegrityError) { rethrowIntentAmendmentIntegrityError(intentIntegrityError);
    missingRequiredIntents = Number.MAX_SAFE_INTEGER;
  }
  let openBlockingFindingIds: string[] = [];
  try {
    const story = ctx.store.readStory(storyId);
    const policy = resolveWorkflowPolicy(loadConfig(ctx.root), story);
    const { effectiveBlockingSeverities, roundCount } = resolveEffectiveBlockingSeverities(ctx.store, storyId, policy);
    openBlockingFindingIds = ctx.store.readFindings(storyId).findings
      .filter(finding => isFindingBlocking(finding, effectiveBlockingSeverities, roundCount))
      .map(finding => finding.id);
  } catch {
    openBlockingFindingIds = ['<findings-unreadable>'];
  }
  let dirtyNonRuntimePaths: string[] = [];
  try {
    dirtyNonRuntimePaths = nonRuntimeDirtyEntries(classifyDonePrepareWorktree({
      root: ctx.root,
      gitCwd,
      storyId,
      store: ctx.store,
    })).map(entry => entry.path);
  } catch {
    dirtyNonRuntimePaths = ['<dirty-classifier-unreadable>'];
  }
  return {
    inventoryApisPresent: true,
    inventory: readInventoryPair(apis, ctx.store, storyId),
    currentStoryId: storyId,
    headHash,
    materialHash,
    storyFilesHash,
    expectedMainSha,
    mainIsAncestor: isDonePrepareMainAncestor(gitCwd),
    openBlockingFindingIds,
    missingRequiredIntents,
    dirtyNonRuntimePaths,
    gitIndexReadable: isDonePrepareGitIndexReadable(gitCwd),
    evidenceTargetWritable: isEvidenceTargetWritable(ctx.store.storyDirPath(storyId)),
    causalInputHashes: identity.causalInputHashes,
    causalDependencyGraphDigest: identity.causalDependencyGraphDigest,
    causalInputHashesDigest: identity.causalInputHashesDigest,
    causalDecision: identity.causalDecision,
  };
}

export function currentCertificationIdentity(
  ctx: HandlerContext,
  storyId: string,
): CertificationWindowCurrentIdentity {
  const gitCwd = resolveGitCwd({
    store: ctx.store,
    storyId,
    metadataRoot: ctx.root,
    projectRoot: ctx.root,
  });
  const headHash = currentGitHead(gitCwd);
  const materialHash = currentMaterialHash(gitCwd, 'HEAD', ctx.root);
  const storyFilesHash = currentStoryFilesHash(gitCwd, 'HEAD', ctx.root);
  const causalInputHashes = deriveCertificationDomainInputHashes(gitCwd, 'HEAD', ctx.root);
  const gitRepo = existsSync(join(gitCwd, '.git'));
  const identity: CertificationWindowCurrentIdentity = {
    storyId,
    headHash,
    materialHash,
    storyFilesHash,
    causalInputHashes,
    verifierIdentity: PRECERT_VERIFIER_IDENTITY,
    testIdentity: PRECERT_TEST_IDENTITY,
    hashUnavailable: gitRepo && (!materialHash || !storyFilesHash),
  };
  if (!identity.hashUnavailable) {
    const loaded = loadVerifiedCertificationWindow(ctx.store, storyId);
    const frozen = loaded.window?.state === 'ADMITTED' || loaded.window?.state === 'RUNNING'
      ? loaded.window.frozen
      : undefined;
    identity.causalDecision = buildCertificationDecision(storyId, identity, frozen);
  }
  return identity;
}

function inventoryBinding(pair: ReviewInventoryAdmitPair | null, consumedReceiptId?: string): CertificationWindowInventoryBinding {
  return {
    epochId: pair?.epoch?.epochId,
    receiptId: consumedReceiptId ?? pair?.receipt?.receiptId,
    authority: pair?.receipt?.authority,
    authorizesTest: pair?.receipt?.authorizesTest,
  };
}

function recoverPendingAdmission(ctx: HandlerContext, storyId: string, expected: CertificationWindow | null): string | null {
  const loaded = loadVerifiedCertificationWindow(ctx.store, storyId);
  const pending = loaded.window;
  if (expected?.state === 'ADMITTING' && pending && (pending.state === 'ADMITTED' || pending.state === 'RUNNING')
    && pending.windowId === expected.windowId && isDeepStrictEqual(pending.frozen, expected.frozen)
    && isDeepStrictEqual(pending.inventory, expected.inventory) && pending.createdAt === expected.createdAt
    && windowAuthorizesHeavyCertification(pending, loaded.receipt)) {
    const refreshed = refreshCertificationWindowLineage({ store: ctx.store, storyId, current: currentCertificationIdentity(ctx, storyId) });
    if (refreshed.window?.windowId === expected.windowId && windowAuthorizesHeavyCertification(refreshed.window, refreshed.receipt))
      return render(projectCertificationWindowStatus(storyId, refreshed.window, refreshed.receipt, refreshed.advisory));
    throw new Error('PRE_CERT_ADMISSION_PENDING: concurrently completed attempt is no longer fresh');
  }
  if (expected?.state === 'ADMITTING' && (pending?.state !== 'ADMITTING' || pending.windowId !== expected.windowId || pending._hash !== expected._hash)) throw new Error('PRE_CERT_ADMISSION_PENDING: pending attempt changed while waiting');
  if (pending?.state !== 'ADMITTING') return null;
  if (expected?.state !== 'ADMITTING') throw new Error('PRE_CERT_ADMISSION_PENDING: new pending attempt appeared while waiting; retry');

    const frozen = pending.frozen;
    const current = currentCertificationIdentity(ctx, storyId);
    if (!frozen || current.verifierIdentity !== frozen.verifierIdentity || current.testIdentity !== frozen.testIdentity || current.headHash !== frozen.headHash || current.materialHash !== frozen.materialHash || current.storyFilesHash !== frozen.storyFilesHash || !isDeepStrictEqual(current.causalInputHashes, frozen.causalInputHashes)) throw new Error('PRE_CERT_ADMISSION_PENDING: frozen inputs changed; no authority restored; cancel the pending window with certification_window_cancel, then begin a fresh inventory epoch');
    const data = ctx.store.readReviewInventoryEpochs(storyId);
    const epoch = data.epochs.at(-1);
    const receipt = data.receipts.find(row => row.receiptId === pending.inventory?.receiptId);
    if (!epoch || !receipt || !verifyReviewInventoryEpoch(epoch) || !verifyReviewInventoryReceipt(receipt)
      || epoch.epochId !== pending.inventory?.epochId || epoch.receiptId !== receipt.receiptId || receipt.epochId !== epoch.epochId
      || epoch.storyId !== storyId || receipt.storyId !== storyId || epoch.state !== 'FINALIZED' || receipt.invalidatedAt
      || receipt.authority !== 'inventory-completeness-only' || receipt.authorizesTest !== false
      || !Number.isFinite(Date.parse(pending.createdAt)) || !Number.isFinite(Date.parse(receipt.issuedAt))
      || Date.parse(pending.createdAt) < Date.parse(receipt.issuedAt)
      || (receipt.consumedAt !== undefined && (!Number.isFinite(Date.parse(receipt.consumedAt)) || Date.parse(receipt.consumedAt) < Date.parse(pending.createdAt)))
      || epoch.cutoff.materialHash !== frozen.materialHash || receipt.cutoff.materialHash !== frozen.materialHash
      || (epoch.cutoff.storyFilesHash ?? '') !== frozen.storyFilesHash || (receipt.cutoff.storyFilesHash ?? '') !== frozen.storyFilesHash)
      throw new Error('PRE_CERT_ADMISSION_PENDING: inventory binding invalid; consumed authority was not reset');
    const apis = loadReviewInventoryAdmitApis();
    if (!apis?.consumeReviewInventoryCompletenessReceiptUnlocked) throw new Error('PRE_CERT_ADMISSION_PENDING: inventory API unavailable');
    const facts = collectAdmitFacts(ctx, storyId, apis);
    const canonicalPath = (path: string): string => join(realpathSync(dirname(path)), basename(path));
    const own = new Set(['certification-window.json', 'review-inventory-epochs.json'].map(name => canonicalPath(ctx.store.storyFilePath(storyId, name))));
    const gitCwd = resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
    // Exact frozen causal equality above is stricter than a selective causal
    // decision. Reuse the normal non-inventory prerequisites as well.
    const prerequisite = nonInventoryAdmitRefusal({ ...facts,
      dirtyNonRuntimePaths: facts.dirtyNonRuntimePaths.filter(path => { try { return !own.has(canonicalPath(join(gitCwd, path))); } catch { return true; } }),
    });
    if (facts.expectedMainSha !== frozen.expectedMainSha || !prerequisite.admit) throw new Error(`PRE_CERT_ADMISSION_PENDING: current admission prerequisites changed: ${prerequisite.blockerDetail ?? 'expected main changed'}`);
    if (Boolean(epoch.consumedAt) !== Boolean(receipt.consumedAt)) throw new Error('PRE_CERT_ADMISSION_PENDING: partial inventory consumption');
    if (receipt.consumedAt) {
      if (epoch.consumedByCertificationWindowId !== pending.windowId || receipt.consumedByCertificationWindowId !== pending.windowId || epoch.consumedAt !== receipt.consumedAt) throw new Error('PRE_CERT_ADMISSION_PENDING: consumption belongs to another attempt');
    } else {
      apis.consumeReviewInventoryCompletenessReceiptUnlocked(ctx.store, storyId, epoch.reviewRound, { materialHash: frozen.materialHash, storyFilesHash: frozen.storyFilesHash }, undefined, pending.windowId);
    }
    const admitted = persistAdmittedCertificationWindow({ store: ctx.store, storyId, frozen, inventory: pending.inventory!, expectedPendingWindowId: pending.windowId });
    return render(projectCertificationWindowStatus(storyId, admitted.window, admitted.receipt), persistHint(ctx.root, storyId, 'certification_window_begin', admitted.window.state));
}

export function createCertificationWindowHandlers(ctx: HandlerContext) {
  return {
    certification_window_begin(args: { storyId: string }): string {
      const storyId = args.storyId.trim();
      if (!storyId) throw new Error('certification_window_begin: storyId is required');
      const expectedPending = loadVerifiedCertificationWindow(ctx.store, storyId).window;
      return withReviewInventoryMutationLock(ctx.store, storyId, () => withValidationMetadataWrite(ctx.store.projectRoot, storyId, () => {
      const recovered = recoverPendingAdmission(ctx, storyId, expectedPending);
      if (recovered !== null) return recovered;


      const existing = refreshCertificationWindowLineage({
        store: ctx.store,
        storyId,
        current: currentCertificationIdentity(ctx, storyId),
      });
      if (existing.window && (existing.window.state === 'ADMITTED' || existing.window.state === 'RUNNING')) {
        return render(projectCertificationWindowStatus(storyId, existing.window, existing.receipt, existing.advisory));
      }

      const apis = loadReviewInventoryAdmitApis();
      if (!apis?.consumeReviewInventoryCompletenessReceiptUnlocked) {
        const window = persistBlockedCertificationWindow({
          store: ctx.store,
          storyId,
          blockerCode: PRE_CERT_INVENTORY_NOT_FINALIZED,
          blockerDetail: `[pre_cert_inventory_api_absent] Review inventory admit APIs are absent; begin stays fail-closed and does not stub-always-admit. Inventory completeness is not PRE_CERT.`,
        });
        const hint = persistHint(ctx.root, storyId, 'certification_window_begin', window.state);
        refuseBlocked(render(projectCertificationWindowStatus(storyId, window, null), hint));
      }

      const facts = collectAdmitFacts(ctx, storyId, apis);
      const decision = evaluateCertificationWindowAdmit(facts);
      if (!decision.admit) {
        const window = persistBlockedCertificationWindow({
          store: ctx.store,
          storyId,
          blockerCode: decision.blockerCode ?? PRE_CERT_INVENTORY_NOT_FINALIZED,
          blockerDetail: decision.blockerDetail ?? 'PRE_CERT admit refused.',
          inventory: inventoryBinding(facts.inventory),
        });
        const hint = persistHint(ctx.root, storyId, 'certification_window_begin', window.state);
        refuseBlocked(render(projectCertificationWindowStatus(storyId, window, null), hint));
      }

      const frozen = {
        headHash: facts.headHash ?? '', materialHash: facts.materialHash ?? '', storyFilesHash: facts.storyFilesHash ?? '',
        causalInputHashes: facts.causalInputHashes, expectedMainSha: facts.expectedMainSha ?? '',
        verifierIdentity: PRECERT_VERIFIER_IDENTITY, testIdentity: PRECERT_TEST_IDENTITY,
      };
      const pending = persistAdmittingCertificationWindow({ store: ctx.store, storyId, frozen, inventory: inventoryBinding(facts.inventory) });
      let consumedReceiptId = facts.inventory?.receipt?.receiptId;
      try {
        const consumed = apis.consumeReviewInventoryCompletenessReceiptUnlocked(
          ctx.store,
          storyId,
          facts.inventory?.epoch?.reviewRound ?? facts.inventory?.receipt?.reviewRound ?? '',
          {
            materialHash: facts.materialHash ?? '',
            ...(facts.storyFilesHash ? { storyFilesHash: facts.storyFilesHash } : {}),
          },
          undefined, pending.windowId,
        );
        if (!consumed) {
          throw new Error('consumeReviewInventoryCompletenessReceipt returned no receipt id');
        }
        consumedReceiptId = consumed;
      } catch (error) {
        throw new Error(`PRE_CERT_ADMISSION_PENDING: consumption outcome retained for recovery; ${String(error)}`);
      }

      const admitted = persistAdmittedCertificationWindow({
        store: ctx.store,
        storyId,
        frozen: {
          headHash: facts.headHash ?? '',
          materialHash: facts.materialHash ?? '',
          storyFilesHash: facts.storyFilesHash ?? '',
          causalInputHashes: facts.causalInputHashes,
          expectedMainSha: facts.expectedMainSha ?? '',
          verifierIdentity: PRECERT_VERIFIER_IDENTITY,
          testIdentity: PRECERT_TEST_IDENTITY,
        },
        inventory: inventoryBinding(facts.inventory, consumedReceiptId),
        expectedPendingWindowId: pending.windowId,
      });
      const hint = persistHint(ctx.root, storyId, 'certification_window_begin', admitted.window.state);
      return render(projectCertificationWindowStatus(storyId, admitted.window, admitted.receipt), hint);
      }));
    },

    certification_window_status(args: { storyId: string; refresh?: boolean }): string {
      assertActiveIdentityConsumerContract('certification-window', CERTIFICATION_WINDOW_SCHEMA);
      assertActiveIdentityConsumerContract('review-inventory-epoch', REVIEW_INVENTORY_EPOCHS_SCHEMA);
      const storyId = args.storyId.trim();
      if (!storyId) throw new Error('certification_window_status: storyId is required');
      const current = currentCertificationIdentity(ctx, storyId);
      const inspected = inspectCertificationWindowLineage({
        store: ctx.store,
        storyId,
        current,
      });
      if (args.refresh === true && inspected.drift.drifted) {
        const refreshed = refreshCertificationWindowLineage({ store: ctx.store, storyId, current });
        return render(projectCertificationWindowStatus(storyId, refreshed.window, refreshed.receipt, refreshed.advisory));
      }
      const projection = projectCertificationWindowStatus(storyId, inspected.window, inspected.receipt, inspected.drift.advisory);
      if (!inspected.drift.drifted) return render(projection);
      return render({
        ...projection,
        blockerCode: PRE_CERT_WINDOW_INVALIDATED,
        observedDriftReason: inspected.drift.reason ?? 'certification subject changed',
        nextCommand: `proof-or-stop certification_window_status --storyId=${storyId} --refresh=true`,
      });
    },

    certification_window_cancel(args: { storyId: string; reason: string }): string {
      const storyId = args.storyId.trim();
      if (!storyId) throw new Error('certification_window_cancel: storyId is required');
      return withReviewInventoryMutationLock(ctx.store, storyId, () => withValidationMetadataWrite(ctx.store.projectRoot, storyId, () => {
      const window = persistCancelledCertificationWindow({
        store: ctx.store,
        storyId,
        reason: args.reason,
      });
      const hint = persistHint(ctx.root, storyId, 'certification_window_cancel', window.state);
      return render(projectCertificationWindowStatus(storyId, window, null), hint);
      }));
    },
  };
}
