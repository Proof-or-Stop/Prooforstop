import type { HandlerContext } from './context.js';
import {
  submitVerdict,
  summarizeVerdictRuns,
  summarizeVerdicts,
  type VerdictDecision,
  type VerdictMode,
  type VerdictRunDiagnostics,
  type VerdictRunSummary,
  type VerdictSummary,
} from '../core/verdicts.js';
import { currentStoryFilesHash } from '../core/evidence-freshness.js';

export type FormatArgs = { json?: boolean; format?: 'text' | 'json' };

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.json === true || args?.format === 'json';
}

function render(title: string, result: Record<string, unknown>): string {
  return [
    title,
    ...Object.entries(result).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.length : String(value)}`),
  ].join('\n');
}

type AutopilotReviewStatusResult = VerdictSummary & {
  runCount: number;
  allRunIds: string[];
  allRuns: VerdictRunSummary[];
  latestRuns: VerdictRunSummary[];
  runDiagnostics: VerdictRunDiagnostics;
};

function formatRunSummary(run: VerdictRunSummary): string {
  return `${run.runId}: ${run.status} ${run.passingIndependentHosts}/${run.requiredHosts} passing hosts, total=${run.totalVerdicts}, stale=${run.staleVerdicts}, duplicate=${run.duplicateVerdicts}`;
}

function formatAutopilotReviewStatus(result: AutopilotReviewStatusResult): string {
  const {
    allRunIds,
    allRuns,
    latestRuns,
    runDiagnostics,
    ...selectedRun
  } = result;
  return [
    render(`Proofbound autopilot review status (${result.schemaVersion})`, selectedRun as unknown as Record<string, unknown>),
    `runs: ${allRunIds.length > 0 ? allRunIds.join(', ') : '<none>'}`,
    `latestRuns: ${latestRuns.length}`,
    ...latestRuns.map(run => `  - ${formatRunSummary(run)}`),
    `allRuns: ${allRuns.length}`,
    `diagnosticOnly: ${runDiagnostics.diagnosticOnly}`,
    `authorityServerContact: ${runDiagnostics.authorityServerContact}`,
  ].join('\n');
}

export type SubmitArgs = {
  verdictFile?: string;
  storyId?: string;
  jobId?: string;
  runId?: string;
  hostId?: string;
  provider?: string;
  model?: string;
  role?: string;
  sessionId?: string;
  keyId?: string;
  reviewWaveId?: string;
  decision?: VerdictDecision;
  materialDigest?: string;
  validationDigest?: string;
  gateInputDigest?: string;
  receiptId?: string;
  promptProfile?: string;
  promptDigest?: string;
  artifactDigest?: string;
  storyFilesHash?: string;
  note?: string;
} & FormatArgs;

export function submitLocalVerdict(ctx: HandlerContext, mode: VerdictMode, args: SubmitArgs) {
  const missingBindingFields = mode === 'local' && args.storyId && args.decision === 'pass'
    ? ['materialDigest', 'validationDigest', 'promptDigest'].filter((field) => {
      if (field === 'materialDigest') return !args.materialDigest;
      if (field === 'validationDigest') return !args.validationDigest;
      return !args.promptDigest;
    })
    : [];
  if (missingBindingFields.length > 0) {
    const message = `Warning: autopilot_review_submit for story ${args.storyId} is missing binding field(s): ${missingBindingFields.join(', ')}`;
    console.warn(message);
    args = {
      ...args,
      note: args.note ? `${args.note}\n${message}` : message,
    };
  }

  const computedStoryFilesHash = mode === 'local' && args.storyId && !args.storyFilesHash
    ? currentStoryFilesHash(ctx.root, 'HEAD', ctx.root)
    : undefined;
  const verdict = submitVerdict(ctx.root, { ...args, ...(computedStoryFilesHash ? { storyFilesHash: computedStoryFilesHash } : {}), mode });
  if (mode === 'local' && verdict.storyId) {
    ctx.store.appendProcessEvent(verdict.storyId, {
      type: 'host_verdict',
      mode,
      verdictId: verdict.verdictId,
      runId: verdict.runId,
      hostId: verdict.hostId,
      provider: verdict.provider,
      sessionId: verdict.sessionId,
      keyId: verdict.keyId,
      decision: verdict.decision,
      materialDigest: verdict.materialDigest,
      ...(verdict.storyFilesHash ? { storyFilesHash: verdict.storyFilesHash } : {}),
      validationDigest: verdict.validationDigest,
      promptDigest: verdict.promptDigest,
    });
  }
  return verdict;
}

export function createVerdictHandlers(ctx: HandlerContext) {
  const submitLocal = (mode: VerdictMode, args: SubmitArgs) => {
    return submitLocalVerdict(ctx, mode, args);
  };

  const localReviewStatus = (args: { storyId: string; runId?: string; requiredHosts?: number } & FormatArgs): AutopilotReviewStatusResult => {
    const runId = args.runId || 'default-run';
    const requiredHosts = args.requiredHosts || 2;
    const selectedRun = summarizeVerdicts(ctx.root, 'local', args.storyId, runId, requiredHosts);
    const runDiagnostics = summarizeVerdictRuns(ctx.root, 'local', args.storyId, runId, requiredHosts);
    return {
      ...selectedRun,
      runCount: runDiagnostics.runCount,
      allRunIds: runDiagnostics.allRunIds,
      allRuns: runDiagnostics.allRuns,
      latestRuns: runDiagnostics.latestRuns,
      runDiagnostics,
    };
  };

  return {
    autopilot_review_submit(args: SubmitArgs = {}) {
      const result = submitLocal('local', args);
      return wantsJson(args) ? result : render(`Proofbound autopilot review submit (${result.schemaVersion})`, result as unknown as Record<string, unknown>);
    },
    autopilot_review_status(args: { storyId: string; runId?: string; requiredHosts?: number } & FormatArgs) {
      const result = localReviewStatus(args);
      return wantsJson(args) ? result : formatAutopilotReviewStatus(result);
    },
  };
}
