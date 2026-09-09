import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import type {
  ReviewLoopClose,
  ReviewLoopDecision,
  ReviewLoopIteration,
  ReviewLoopPolicy,
  ReviewLoopRecord,
  ReviewLoopRollbackRef,
  ReviewLoopStart,
  ReviewLoopStatus,
  ReviewLoopTrigger,
} from '../core/types.js';
import {
  DEFAULT_REVIEW_LOOP_POLICY,
  deriveLatestLoopRecord,
  listActiveLoops,
  nextIterationNumber,
  validateRollbackRef,
  validateResolvedCloseInvariant,
  validateTriggerRefs,
} from '../core/review-loop.js';
import { ensureCurrentReviewRound } from '../core/review-run.js';
import { currentMaterialHash } from '../core/evidence-freshness.js';
import { readBrandEnv } from '../core/brand-env.js';

type FormatArgs = { json?: boolean; format?: 'text' | 'json' };

type ReviewLoopStore = {
  readReviewLoopRecords?: (storyId: string) => ReviewLoopRecord[] | { records: ReviewLoopRecord[] };
  appendReviewLoopRecord?: (storyId: string, record: ReviewLoopRecord) => void;
};

type ReviewLoopStartArgs = {
  storyId: string;
  loopId?: string;
  reviewRound?: string;
  trigger: ReviewLoopTrigger;
  rollbackRef: ReviewLoopRollbackRef;
  actor?: string;
} & FormatArgs;

type ReviewLoopIterationArgs = {
  storyId: string;
  loopId: string;
  reviewRound?: string;
  trigger: ReviewLoopTrigger;
  host: ReviewLoopIteration['host'];
  rollbackRef: ReviewLoopRollbackRef;
  reflection: ReviewLoopIteration['reflection'];
  evaluation?: Partial<ReviewLoopIteration['evaluation']>;
  decision: ReviewLoopDecision;
  decisionReason: string;
  nextAction?: ReviewLoopIteration['nextAction'];
  actor?: string;
} & FormatArgs;

type ReviewLoopCloseArgs = {
  storyId: string;
  loopId: string;
  reviewRound?: string;
  status: Exclude<ReviewLoopStatus, 'open'>;
  trigger: ReviewLoopTrigger;
  materialHash: string;
  resolvedEvidenceRefs?: string[];
  supersedingEvidenceRefs?: string[];
  closeReason: string;
  actor?: string;
} & FormatArgs;

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.json === true || args?.format === 'json';
}

function actor(argsActor?: string): string {
  return argsActor?.trim() || readBrandEnv('AGENT') || process.env.USER || 'main';
}

function requireReviewLoopStore(store: unknown): Required<ReviewLoopStore> {
  const candidate = store as ReviewLoopStore;
  if (typeof candidate.readReviewLoopRecords !== 'function' || typeof candidate.appendReviewLoopRecord !== 'function') {
    throw new Error(
      'review_loop storage helpers are unavailable: expected StoryStore.readReviewLoopRecords(storyId) ' +
      'and StoryStore.appendReviewLoopRecord(storyId, record) from CHK-001.',
    );
  }
  return candidate as Required<ReviewLoopStore>;
}

function readRecords(store: unknown, storyId: string): ReviewLoopRecord[] {
  const result = requireReviewLoopStore(store).readReviewLoopRecords(storyId);
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.records)) return result.records;
  throw new Error('readReviewLoopRecords returned an unsupported shape; expected ReviewLoopRecord[] or { records }.');
}

function appendRecord(store: unknown, storyId: string, record: ReviewLoopRecord): void {
  requireReviewLoopStore(store).appendReviewLoopRecord(storyId, record);
}

function requireReviewPhase(ctx: HandlerContext, storyId: string, commandName: string): string {
  assertCwdInWorktree(ctx.store, storyId);
  const story = ensureCurrentReviewRound(ctx.store, storyId, commandName);
  return story.currentReviewRound as string;
}

function normalizeList(value: string[] | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.map((item) => item.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeTrigger(trigger: ReviewLoopTrigger): ReviewLoopTrigger {
  const normalized = {
    findingIds: normalizeList(trigger.findingIds),
    bugIds: normalizeList(trigger.bugIds),
    validationFailureRefs: normalizeList(trigger.validationFailureRefs),
    scopeViolationRefs: normalizeList(trigger.scopeViolationRefs),
  };
  const error = validateTriggerRefs(normalized);
  if (error) throw new Error(`review_loop trigger invalid: ${error}`);
  return normalized;
}

function normalizeRollbackRef(ref: ReviewLoopRollbackRef): ReviewLoopRollbackRef {
  const normalized = {
    headHash: ref.headHash.trim().toLowerCase(),
    diffHash: ref.diffHash.trim().toLowerCase(),
    materialHash: ref.materialHash.trim().toLowerCase(),
    ...(ref.scopeContractHash?.trim() ? { scopeContractHash: ref.scopeContractHash.trim().toLowerCase() } : {}),
  };
  const error = validateRollbackRef(normalized);
  if (error) throw new Error(`review_loop rollbackRef invalid: ${error}`);
  return normalized;
}

function nextLoopId(storyId: string, records: ReviewLoopRecord[]): string {
  const next = records.reduce((max, record) => {
    const match = record.loopId.match(/:RL-(\d+)$/);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0) + 1;
  return `${storyId}:RL-${String(next).padStart(3, '0')}`;
}

function nextIteration(loopId: string, records: ReviewLoopRecord[]): number {
  return nextIterationNumber(records, loopId);
}

function assertLoopOpen(loopId: string, records: ReviewLoopRecord[]): void {
  const latest = deriveLatestLoopRecord(records, loopId);
  if (!latest) throw new Error(`review loop not found: ${loopId}`);
  if (latest.status !== 'open') throw new Error(`review loop ${loopId} is already ${latest.status}`);
}

function statusProjection(storyId: string, records: ReviewLoopRecord[], loopId?: string) {
  const selected = loopId ? records.filter((record) => record.loopId === loopId) : records;
  const loopIds = [...new Set(selected.map((record) => record.loopId))];
  const activeLoopIds = new Set(listActiveLoops(records));
  const latest = loopId ? deriveLatestLoopRecord(records, loopId) ?? null : null;
  return {
    schemaVersion: 'proof-or-stop.review_loop_status.v1',
    storyId,
    loopId: loopId ?? null,
    active: loopId ? activeLoopIds.has(loopId) : activeLoopIds.size > 0,
    latest,
    loops: loopIds.map((id) => {
      const loopRecords = selected.filter((record) => record.loopId === id);
      const latestForLoop = deriveLatestLoopRecord(records, id);
      const start = loopRecords.find((record): record is ReviewLoopStart => record.event === 'start');
      const iterations = loopRecords.filter((record): record is ReviewLoopIteration => record.event === 'iteration');
      return {
        loopId: id,
        reviewRound: start?.reviewRound ?? latestForLoop?.reviewRound ?? iterations.at(-1)?.reviewRound ?? '',
        status: latestForLoop?.status ?? 'open',
        active: activeLoopIds.has(id),
        latest: latestForLoop ?? null,
        trigger: start?.trigger ?? latestForLoop?.trigger ?? iterations.at(-1)?.trigger,
        openedAt: start?.openedAt,
        closedAt: latestForLoop?.event === 'close' ? latestForLoop.closedAt : undefined,
        iterationCount: iterations.length,
        lastDecision: iterations.at(-1)?.decision,
        lastDecisionReason: iterations.at(-1)?.decisionReason,
      };
    }),
    records: selected,
  };
}

function renderStatus(status: ReturnType<typeof statusProjection>): string {
  if (status.loops.length === 0) {
    return status.loopId
      ? `No review loop records found for ${status.loopId}.`
      : `No review loop records found for ${status.storyId}.`;
  }
  return [
    `Review loops for ${status.storyId}`,
    ...status.loops.map((loop) =>
      `- ${loop.loopId} [${loop.status}] round=${loop.reviewRound || 'unknown'} iterations=${loop.iterationCount}` +
      (loop.lastDecision ? ` lastDecision=${loop.lastDecision}` : ''),
    ),
  ].join('\n');
}

function renderPolicy(policy: ReviewLoopPolicy): string {
  return [
    `Review loop policy (${policy.schemaVersion})`,
    `maxIterations: ${policy.maxIterations}`,
    `maxNoProgressIterations: ${policy.maxNoProgressIterations}`,
    `maxRuntimeMinutes: ${policy.maxRuntimeMinutes}`,
    `maxCostUSD: ${policy.maxCostUSD}`,
    `allowAutoHandoff: ${policy.allowAutoHandoff}`,
    `allowAutoRollback: ${policy.allowAutoRollback}`,
    `requireHumanForScopeExpansion: ${policy.requireHumanForScopeExpansion}`,
    `requireHumanForProtectedFiles: ${policy.requireHumanForProtectedFiles}`,
    `stopOnTestRegression: ${policy.stopOnTestRegression}`,
    `stopOnScopeViolation: ${policy.stopOnScopeViolation}`,
  ].join('\n');
}

export function createReviewLoopHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    review_loop_start(args: ReviewLoopStartArgs) {
      const currentReviewRound = requireReviewPhase(ctx, args.storyId, 'review_loop_start');
      const records = readRecords(ctx.store, args.storyId);
      const loopId = args.loopId?.trim() || nextLoopId(args.storyId, records);
      if (records.some((record) => record.loopId === loopId)) {
        throw new Error(`review loop already exists: ${loopId}`);
      }
      const record: ReviewLoopStart = {
        schemaVersion: 'proof-or-stop.review_loop_start.v1',
        event: 'start',
        loopId,
        storyId: args.storyId,
        reviewRound: args.reviewRound?.trim() || currentReviewRound,
        status: 'open',
        trigger: normalizeTrigger(args.trigger),
        rollbackRef: normalizeRollbackRef(args.rollbackRef),
        openedAt: new Date().toISOString(),
        actor: actor(args.actor),
      };
      appendRecord(ctx.store, args.storyId, record);
      if (wantsJson(args)) return record;
      return `Review loop ${record.loopId} started for ${args.storyId} (round ${record.reviewRound}).`;
    },

    review_loop_iteration_add(args: ReviewLoopIterationArgs) {
      const currentReviewRound = requireReviewPhase(ctx, args.storyId, 'review_loop_iteration_add');
      const records = readRecords(ctx.store, args.storyId);
      assertLoopOpen(args.loopId, records);
      const record: ReviewLoopIteration = {
        schemaVersion: 'proof-or-stop.review_loop_iteration.v1',
        event: 'iteration',
        loopId: args.loopId,
        storyId: args.storyId,
        reviewRound: args.reviewRound?.trim() || currentReviewRound,
        status: 'open',
        iteration: nextIteration(args.loopId, records),
        trigger: normalizeTrigger(args.trigger),
        host: {
          hostId: args.host.hostId.trim(),
          ...(args.host.capabilitySnapshotRef?.trim() ? { capabilitySnapshotRef: args.host.capabilitySnapshotRef.trim() } : {}),
          ...(Array.isArray(args.host.visibleDegradations) ? { visibleDegradations: normalizeList(args.host.visibleDegradations) ?? [] } : {}),
        },
        rollbackRef: normalizeRollbackRef(args.rollbackRef),
        reflection: args.reflection,
        evaluation: {
          costMeasured: args.evaluation?.costMeasured ?? false,
          commandsRun: args.evaluation?.commandsRun ?? [],
          evidenceRefs: args.evaluation?.evidenceRefs ?? [],
          ...(args.evaluation?.progressScore !== undefined ? { progressScore: args.evaluation.progressScore } : {}),
          ...(args.evaluation?.riskScore !== undefined ? { riskScore: args.evaluation.riskScore } : {}),
          ...(args.evaluation?.regressionScore !== undefined ? { regressionScore: args.evaluation.regressionScore } : {}),
          ...(args.evaluation?.confidenceScore !== undefined ? { confidenceScore: args.evaluation.confidenceScore } : {}),
          ...(args.evaluation?.costUsedUSD !== undefined ? { costUsedUSD: args.evaluation.costUsedUSD } : {}),
          ...(args.evaluation?.timeUsedMs !== undefined ? { timeUsedMs: args.evaluation.timeUsedMs } : {}),
        },
        decision: args.decision,
        decisionReason: args.decisionReason,
        ...(args.nextAction ? { nextAction: args.nextAction } : {}),
        createdAt: new Date().toISOString(),
        actor: actor(args.actor),
      };
      appendRecord(ctx.store, args.storyId, record);
      if (wantsJson(args)) return record;
      return `Review loop ${record.loopId} iteration ${record.iteration} recorded (decision=${record.decision}).`;
    },

    review_loop_status(args: { storyId: string; loopId?: string } & FormatArgs) {
      ctx.store.readStory(args.storyId);
      const status = statusProjection(args.storyId, readRecords(ctx.store, args.storyId), args.loopId);
      if (wantsJson(args)) return status;
      return renderStatus(status);
    },

    review_loop_close(args: ReviewLoopCloseArgs) {
      const currentReviewRound = requireReviewPhase(ctx, args.storyId, 'review_loop_close');
      const records = readRecords(ctx.store, args.storyId);
      assertLoopOpen(args.loopId, records);
      const materialHash = args.materialHash.trim();
      const resolvedEvidenceRefs = normalizeList(args.resolvedEvidenceRefs);
      const supersedingEvidenceRefs = normalizeList(args.supersedingEvidenceRefs);
      const closeError = validateResolvedCloseInvariant(
        args.status,
        materialHash,
        resolvedEvidenceRefs,
        supersedingEvidenceRefs,
        currentMaterialHash(ctx.root),
      );
      if (closeError) throw new Error(`review_loop_close invalid: ${closeError}`);
      const record: ReviewLoopClose = {
        schemaVersion: 'proof-or-stop.review_loop_close.v1',
        event: 'close',
        loopId: args.loopId,
        storyId: args.storyId,
        reviewRound: args.reviewRound?.trim() || currentReviewRound,
        status: args.status,
        trigger: normalizeTrigger(args.trigger),
        materialHash,
        ...(resolvedEvidenceRefs ? { resolvedEvidenceRefs } : {}),
        ...(supersedingEvidenceRefs ? { supersedingEvidenceRefs } : {}),
        closeReason: args.closeReason,
        closedAt: new Date().toISOString(),
        actor: actor(args.actor),
      };
      appendRecord(ctx.store, args.storyId, record);
      if (wantsJson(args)) return record;
      return `Review loop ${record.loopId} closed as ${record.status}.`;
    },

    review_loop_policy_show(args: FormatArgs = {}) {
      if (wantsJson(args)) return DEFAULT_REVIEW_LOOP_POLICY;
      return renderPolicy(DEFAULT_REVIEW_LOOP_POLICY);
    },
  };
}
