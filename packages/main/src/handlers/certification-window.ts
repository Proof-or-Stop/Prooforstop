import { currentPrecertFastIdentity } from './validation-identity.js';
import type { HandlerContext } from './context.js';
import { execFileSync } from 'node:child_process';
import { autoCommitStoryMetadata, matchesRuntimeCommitSubject } from '../core/auto-commit-metadata.js';
import { reportHealthIssue } from '../core/health.js';
import { existsSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
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
  evaluateCertificationWindowAdmit,
  currentPrecertCheapCheckReceipt,
  isSaturatedReviewInventoryForPrecert,
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
  type CertificationWindowAdmitFacts,
  type CertificationWindowCurrentIdentity,
  type CertificationWindowFrozenIdentity,
  type CertificationWindowInventoryBinding,
  type CertificationWindowStatusProjection,
  type ReviewInventoryAdmitPair,
} from '../core/certification-window.js';

function persistHint(root: string, storyId: string, command: string): string {
  try {
    return autoCommitStoryMetadata(root, storyId, command);
  } catch (error) {
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
  // Canonical agent bodies are runtime prompt inputs, matching their host mirrors.
  ['manifest-semantic', /^packages\/main\/templates\/agents\/[^/]+\.md$/],
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

const PRECERT_INVENTORY_METADATA_REASONS = [
  'review_inventory_begin',
  'review_run_start',
  'review_pass_set',
  'finding_add',
  'finding_resolve',
  'review_inventory_critic_set',
  'review_inventory_wave_advance',
  'review_inventory_finalize',
] as const;

function gitText(gitCwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: gitCwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The signed workspace and the StoryStore can reach the same directory through
 * different aliases (notably macOS /var -> /private/var). The continuity proof
 * is path-sensitive, so it must compare the filesystem's canonical identities,
 * and it must fail closed when either proof endpoint does not exist.
 */
function canonicalExistingPath(path: string): string | null {
  try {
    return existsSync(path) ? realpathSync(path) : null;
  } catch {
    return null;
  }
}

/**
 * REVIEW evidence and the bounded inventory protocol both write metadata after
 * an inventory cutoff. Permit only that exact bookkeeping chain, and no other
 * HEAD drift, before PRE_CERT consumes inventory. Cancellation and drift-status
 * commits are deliberately excluded: neither can lie on the lineage of a valid
 * unconsumed FINALIZED receipt. The consume lock remains the final all-hash
 * race fence.
 */
function hasVerifiedInventoryMetadataHeadContinuity(args: {
  gitCwd: string;
  storyMetadataPath: string;
  storyId: string;
  receiptHead?: string;
  currentHead?: string;
}): boolean {
  const { gitCwd, storyMetadataPath, storyId, receiptHead, currentHead } = args;
  if (!receiptHead || !currentHead || receiptHead === currentHead) return false;
  if (!/^[0-9a-f]{40,64}$/i.test(receiptHead) || !/^[0-9a-f]{40,64}$/i.test(currentHead)) return false;

  const canonicalGitCwd = canonicalExistingPath(gitCwd);
  const canonicalStoryMetadataPath = canonicalExistingPath(storyMetadataPath);
  if (!canonicalGitCwd || !canonicalStoryMetadataPath) return false;

  const storyRel = relative(canonicalGitCwd, canonicalStoryMetadataPath).replaceAll('\\', '/');
  if (!storyRel || storyRel === '.' || storyRel.startsWith('../') || storyRel.startsWith('/')) return false;
  const storyPrefix = `${storyRel.replace(/\/+$/, '')}/`;
  const ancestor = gitText(gitCwd, ['merge-base', '--is-ancestor', receiptHead, currentHead]);
  if (ancestor === null) return false;
  const commitsText = gitText(gitCwd, ['rev-list', '--reverse', `${receiptHead}..${currentHead}`]);
  if (!commitsText) return false;

  for (const commit of commitsText.split(/\s+/).filter(Boolean)) {
    const parents = gitText(gitCwd, ['show', '-s', '--format=%P', commit]);
    const subject = gitText(gitCwd, ['show', '-s', '--format=%s', commit]);
    const pathsText = gitText(gitCwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', commit]);
    if (!parents || parents.split(/\s+/).filter(Boolean).length !== 1 || !subject || pathsText === null) return false;
    if (!PRECERT_INVENTORY_METADATA_REASONS.some(reason => (
      matchesRuntimeCommitSubject(subject, `record ${storyId} ${reason} metadata`)
    ))) return false;
    const paths = pathsText.split('\n').filter(Boolean);
    if (paths.length === 0 || paths.some(path => !path.startsWith(storyPrefix))) return false;
  }
  return true;
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
    ).missingRequired;
  } catch {
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
  const inventory = readInventoryPair(apis, ctx.store, storyId);
  const inventoryHeadMetadataContinuity = hasVerifiedInventoryMetadataHeadContinuity({
    gitCwd,
    storyMetadataPath: ctx.store.storyDirPath(storyId),
    storyId,
    receiptHead: inventory?.receipt?.cutoff?.headHash ?? inventory?.epoch?.cutoff?.headHash,
    currentHead: headHash,
  });
  let cheapCheckReceipt = null;
  try {
    cheapCheckReceipt = currentPrecertCheapCheckReceipt({
      currentIdentity: currentPrecertFastIdentity(ctx, storyId),
      data: ctx.store.readCertificationWindows(storyId),
      storyId,
      headHash,
      materialHash,
      storyFilesHash,
    });
  } catch {
    // An unreadable/tampered cheap receipt is intentionally indistinguishable
    // from an absent one at the admit boundary: both fail closed without
    // consuming the inventory receipt.
  }
  return {
    inventoryApisPresent: true,
    inventory,
    inventorySaturated: isSaturatedReviewInventoryForPrecert(apis, inventory, storyId),
    cheapCheckReceipt,
    currentStoryId: storyId,
    headHash,
    inventoryHeadMetadataContinuity,
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

export function createCertificationWindowHandlers(ctx: HandlerContext) {
  return {
    certification_window_begin(args: { storyId: string }): string {
      const storyId = args.storyId.trim();
      if (!storyId) throw new Error('certification_window_begin: storyId is required');

      const existing = refreshCertificationWindowLineage({
        store: ctx.store,
        storyId,
        current: currentCertificationIdentity(ctx, storyId),
      });
      if (existing.window && (existing.window.state === 'ADMITTED' || existing.window.state === 'RUNNING')) {
        return render(projectCertificationWindowStatus(storyId, existing.window, existing.receipt, existing.advisory));
      }

      const apis = loadReviewInventoryAdmitApis();
      if (!apis) {
        const window = persistBlockedCertificationWindow({
          store: ctx.store,
          storyId,
          blockerCode: PRE_CERT_INVENTORY_NOT_FINALIZED,
          blockerDetail: `[pre_cert_inventory_api_absent] Review inventory admit APIs are absent; begin stays fail-closed and does not stub-always-admit. Inventory completeness is not PRE_CERT.`,
        });
        const hint = persistHint(ctx.root, storyId, 'certification_window_begin');
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
        const hint = persistHint(ctx.root, storyId, 'certification_window_begin');
        refuseBlocked(render(projectCertificationWindowStatus(storyId, window, null), hint));
      }

      let consumedReceiptId = facts.inventory?.receipt?.receiptId;
      try {
        const consumed = apis.consumeReviewInventoryCompletenessReceipt(
          ctx.store,
          storyId,
          facts.inventory?.epoch?.reviewRound ?? facts.inventory?.receipt?.reviewRound ?? '',
          {
            materialHash: facts.materialHash ?? '',
            ...(facts.storyFilesHash ? { storyFilesHash: facts.storyFilesHash } : {}),
          },
          () => {
            const current = currentCertificationIdentity(ctx, storyId);
            if (current.headHash !== facts.headHash
              || current.materialHash !== facts.materialHash
              || current.storyFilesHash !== facts.storyFilesHash) {
              throw new Error(
                'REVIEW_INVENTORY_PRE_CERT_BLOCKED: current certification identity changed before inventory consume',
              );
            }
            const currentInventory = readInventoryPair(apis, ctx.store, storyId);
            if (!isSaturatedReviewInventoryForPrecert(apis, currentInventory, storyId)) {
              throw new Error(
                'REVIEW_INVENTORY_PRE_CERT_BLOCKED: current inventory is not a signed B-3f3d saturated FINALIZED receipt',
              );
            }
          },
        );
        if (!consumed) {
          throw new Error('consumeReviewInventoryCompletenessReceipt returned no receipt id');
        }
        consumedReceiptId = consumed;
      } catch (error) {
        const window = persistBlockedCertificationWindow({
          store: ctx.store,
          storyId,
          blockerCode: PRE_CERT_INVENTORY_NOT_FINALIZED,
          blockerDetail: `Inventory consume failed: ${error instanceof Error ? error.message : String(error)}`,
          inventory: inventoryBinding(facts.inventory),
        });
        const hint = persistHint(ctx.root, storyId, 'certification_window_begin');
        refuseBlocked(render(projectCertificationWindowStatus(storyId, window, null), hint));
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
      });
      const hint = persistHint(ctx.root, storyId, 'certification_window_begin');
      return render(projectCertificationWindowStatus(storyId, admitted.window, admitted.receipt), hint);
    },

    certification_window_status(args: { storyId: string }): string {
      const storyId = args.storyId.trim();
      if (!storyId) throw new Error('certification_window_status: storyId is required');
      const refreshed = refreshCertificationWindowLineage({
        store: ctx.store,
        storyId,
        current: currentCertificationIdentity(ctx, storyId),
      });
      return render(projectCertificationWindowStatus(storyId, refreshed.window, refreshed.receipt, refreshed.advisory));
    },

    certification_window_cancel(args: { storyId: string; reason: string }): string {
      const storyId = args.storyId.trim();
      if (!storyId) throw new Error('certification_window_cancel: storyId is required');
      const window = persistCancelledCertificationWindow({
        store: ctx.store,
        storyId,
        reason: args.reason,
      });
      const hint = persistHint(ctx.root, storyId, 'certification_window_cancel');
      return render(projectCertificationWindowStatus(storyId, window, null), hint);
    },
  };
}
