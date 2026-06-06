import type { HandlerContext } from './context.js';
import {
  submitVerdict,
  summarizeVerdicts,
  type VerdictDecision,
  type VerdictMode,
} from '../core/verdicts.js';

type FormatArgs = { json?: boolean; format?: 'text' | 'json' };

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.json === true || args?.format === 'json';
}

function render(title: string, result: Record<string, unknown>): string {
  return [
    title,
    ...Object.entries(result).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.length : String(value)}`),
  ].join('\n');
}

type SubmitArgs = {
  verdictFile?: string;
  storyId?: string;
  jobId?: string;
  runId?: string;
  hostId?: string;
  provider?: string;
  sessionId?: string;
  keyId?: string;
  decision?: VerdictDecision;
  materialDigest?: string;
  validationDigest?: string;
  gateInputDigest?: string;
  receiptId?: string;
  promptDigest?: string;
  note?: string;
} & FormatArgs;

export function createVerdictHandlers(ctx: HandlerContext) {
  const submit = (mode: VerdictMode, args: SubmitArgs) => {
    const verdict = submitVerdict(ctx.root, { ...args, mode });
    if (mode === 'local' && verdict.storyId) {
      ctx.store.appendProcessEvent(verdict.storyId, {
        type: 'host_verdict',
        mode,
        verdictId: verdict.verdictId,
        runId: verdict.runId,
        hostId: verdict.hostId,
        provider: verdict.provider,
        decision: verdict.decision,
        materialDigest: verdict.materialDigest,
      });
    }
    return verdict;
  };

  const list = (mode: VerdictMode, args: { storyId?: string; jobId?: string; runId?: string; requiredHosts?: number } & FormatArgs) => {
    const id = mode === 'authority' ? args.jobId : args.storyId;
    if (!id) throw new Error(mode === 'authority' ? 'jobId is required' : 'storyId is required');
    return summarizeVerdicts(ctx.root, mode, id, args.runId || 'default-run', args.requiredHosts || 2);
  };

  return {
    autopilot_review_submit(args: SubmitArgs = {}) {
      const result = submit('local', args);
      return wantsJson(args) ? result : render(`Lattice autopilot review submit (${result.schemaVersion})`, result as unknown as Record<string, unknown>);
    },
    autopilot_review_status(args: { storyId: string; runId?: string; requiredHosts?: number } & FormatArgs) {
      const result = list('local', args);
      return wantsJson(args) ? result : render(`Lattice autopilot review status (${result.schemaVersion})`, result as unknown as Record<string, unknown>);
    },
    authority_verdict_submit(args: SubmitArgs = {}) {
      const result = submit('authority', args);
      return wantsJson(args) ? result : render(`Lattice authority verdict submit (${result.schemaVersion})`, result as unknown as Record<string, unknown>);
    },
    authority_verdict_list(args: { jobId: string; runId?: string; requiredHosts?: number } & FormatArgs) {
      const result = list('authority', args);
      return wantsJson(args) ? result : render(`Lattice authority verdict list (${result.schemaVersion})`, result as unknown as Record<string, unknown>);
    },
    authority_job_status(args: { jobId: string; runId?: string; requiredHosts?: number } & FormatArgs) {
      const verdictSummary = list('authority', args);
      const result = {
        schemaVersion: 'lattice.authority_job_status.v1' as const,
        jobId: args.jobId,
        runId: args.runId || 'default-run',
        requiredHosts: args.requiredHosts || 2,
        status: verdictSummary.status,
        totalVerdicts: verdictSummary.totalVerdicts,
        independentHosts: verdictSummary.independentHosts,
        passingIndependentHosts: verdictSummary.passingIndependentHosts,
        failingIndependentHosts: verdictSummary.failingIndependentHosts,
        multiHostVerified: verdictSummary.multiHostVerified,
        fullAuthorityDone: verdictSummary.fullAuthorityDone,
        // authorityDone is never minted from host verdicts. A passing multi-host
        // wave (even one carrying a receiptId) is not a verified native
        // gate_decision receipt; that verification is owned by the authority
        // executor / receipt verifier, so job status always reports false here.
        authorityDone: false,
        nativeReceiptRequired: true,
        blockedReason: verdictSummary.blockedReason,
        verdictSummary,
      };
      return wantsJson(args) ? result : render(`Lattice authority job status (${result.schemaVersion})`, result as unknown as Record<string, unknown>);
    },
  };
}
