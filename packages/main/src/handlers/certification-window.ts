import type { HandlerContext } from './context.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { reportHealthIssue } from '../core/health.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isFindingBlocking } from '../core/advisory.js';
import { loadConfig } from '../core/config.js';
import {
  currentGitHead,
  currentMaterialHash,
  currentStoryFileHashEntries,
  currentStoryFilesHash,
  EMPTY_STORY_FILES_HASH,
} from '../core/evidence-freshness.js';
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

const CERTIFICATION_DOMAIN_PATH_RULES: ReadonlyArray<readonly [CausalDependencyDomain, RegExp]> = [
  ['test', /^packages\/main\/(?:tests\/|src\/tasks\/)/],
  ['build-input', /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|tsconfig(?:\.[^/]+)?\.json|lattice\.config\.json|proof-or-stop\.config\.json)$/],
  ['manifest-semantic', /^(?:\.proof-or-stop-codex|\.codex|\.claude)\//],
  ['manifest-semantic', /^\.proof-or-stop\/proof-or-stop\.json$/],
  ['integration', /^(?:bin|scripts|\.githooks|packages\/(?:utils|lab))\//],
  ['source', /^packages\/main\/src\/(?!tasks\/)/],
  ['review-subject', /^(?:docs\/|(?:AGENTS|CLAUDE|README)(?:\.[^/]+)?$)/],
];

function certificationDomainForPath(path: string): CausalDependencyDomain | undefined {
  const matches = CERTIFICATION_DOMAIN_PATH_RULES.filter(([, pattern]) => pattern.test(path));
  return matches.length === 1 ? matches[0][0] : undefined;
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
  const entries = currentStoryFileHashEntries(gitCwd, ref, metadataRoot);
  if (!entries) return undefined;
  const byDomain = new Map<CausalDependencyDomain, string[]>(
    CAUSAL_DEPENDENCY_DOMAINS.map(domain => [domain, []]),
  );
  for (const entry of entries) {
    const domain = certificationDomainForPath(entry.path);
    if (!domain) return undefined;
    byDomain.get(domain)!.push(`${entry.path}\0${entry.objectId || '<deleted>'}`);
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
    ...(index > 0 ? { dependencyIds: [`certification-${CAUSAL_DEPENDENCY_DOMAINS[index - 1]}`] } : {}),
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
