import type { HandlerContext } from './context.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { isFindingBlocking } from '../core/advisory.js';
import { loadConfig } from '../core/config.js';
import {
  currentGitHead,
  currentMaterialHash,
  currentStoryFilesHash,
} from '../core/evidence-freshness.js';
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
  renderCertificationWindowStatus,
  PRECERT_TEST_IDENTITY,
  PRECERT_VERIFIER_IDENTITY,
  PRE_CERT_INVENTORY_NOT_FINALIZED,
  type CertificationWindowAdmitFacts,
  type CertificationWindowInventoryBinding,
  type CertificationWindowStatusProjection,
  type ReviewInventoryAdmitPair,
} from '../core/certification-window.js';

function persistHint(root: string, storyId: string, command: string): string {
  try {
    return autoCommitStoryMetadata(root, storyId, command);
  } catch {
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
  const expectedMainSha = donePrepareExpectedMainSha(gitCwd);
  let missingRequiredIntents = 0;
  try {
    missingRequiredIntents = buildVerificationCoverage(ctx.store.readChecklist(storyId), headHash).missingRequired;
  } catch {
    missingRequiredIntents = 0;
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
    openBlockingFindingIds = [];
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
  };
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

      const existing = loadVerifiedCertificationWindow(ctx.store, storyId);
      if (existing.window && (existing.window.state === 'ADMITTED' || existing.window.state === 'RUNNING')) {
        return render(projectCertificationWindowStatus(storyId, existing.window, existing.receipt));
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
        const consumed = apis.consumeReviewInventoryReceipt(
          ctx.store,
          storyId,
          facts.inventory?.epoch?.reviewRound ?? facts.inventory?.receipt?.reviewRound ?? '',
          {
            materialHash: facts.materialHash ?? '',
            ...(facts.storyFilesHash ? { storyFilesHash: facts.storyFilesHash } : {}),
          },
        );
        if (!consumed) {
          throw new Error('consumeReviewInventoryReceipt returned no receipt id');
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
      const { window, receipt } = loadVerifiedCertificationWindow(ctx.store, storyId);
      return render(projectCertificationWindowStatus(storyId, window, receipt));
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
