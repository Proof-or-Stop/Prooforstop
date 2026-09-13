import type { HandlerContext } from './context.js';
import { resolveStoryCommandWorkspace } from './context.js';
import {
  submitVerdict,
  summarizeVerdictRuns,
  summarizeVerdicts,
  type HostVerdict,
  type VerdictDecision,
  type VerdictMode,
  type VerdictRunDiagnostics,
  type VerdictRunSummary,
  type VerdictSummary,
} from '../core/verdicts.js';
import type { ProcessEventAppendIdentity } from '../core/process-events.js';
import { currentStoryFilesHash } from '../core/evidence-freshness.js';
import { deriveHostVerdictBindings } from '../core/host-verdict-bindings.js';
import { isCanonicalStoryId } from '../core/lifecycle-registry.js';
import { PROOF_OR_STOP_DIR } from '../core/proof-or-stop-paths.js';
import { withOfficialValidationExecution } from '../core/validation-execution-lock.js';
import { assessStoredValidationPassAdmissibility } from './phase-gates.js';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

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
    render(`Proof-or-Stop autopilot review status (${result.schemaVersion})`, selectedRun as unknown as Record<string, unknown>),
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
  deriveBindings?: boolean;
} & FormatArgs;

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function assertMatchingBinding(name: string, supplied: unknown, canonical: string): void {
  const value = normalizeString(supplied);
  if (value && value !== canonical) {
    throw new Error(`autopilot_review_submit --deriveBindings: supplied ${name} does not match the canonical current value`);
  }
}

function validateDerivedBindingRequest(args: SubmitArgs): {
  storyId: string;
  hostId: string;
  provider: string;
  sessionId: string;
} {
  const storyId = normalizeString(args.storyId);
  if (!isCanonicalStoryId(storyId)) {
    throw new Error('autopilot_review_submit --deriveBindings requires a canonical storyId');
  }
  if (args.decision !== 'pass') {
    throw new Error('autopilot_review_submit --deriveBindings is only valid for decision=pass');
  }
  const hostId = normalizeString(args.hostId);
  const provider = normalizeString(args.provider);
  const sessionId = normalizeString(args.sessionId);
  if (!hostId || !provider || !sessionId) {
    throw new Error('autopilot_review_submit --deriveBindings requires explicit non-empty hostId, provider, and sessionId');
  }

  return { storyId, hostId, provider, sessionId };
}

async function submitWithDerivedBindings(ctx: HandlerContext, args: SubmitArgs) {
  const identity = validateDerivedBindingRequest(args);
  const workspace = resolveStoryCommandWorkspace(ctx.store, identity.storyId, ctx.root);
  const projectRoot = workspace.signedWorkspaceRoot;
  return withOfficialValidationExecution({
    root: ctx.root,
    storyId: identity.storyId,
    workspaceRoot: projectRoot,
    requireGitIdentity: true,
    command: 'autopilot_review_submit --deriveBindings',
    onWaitProgress: (message) => ctx.log?.(message),
  }, () => {
    const admissibility = assessStoredValidationPassAdmissibility(ctx, identity.storyId, { allowDynamicCoverage: true });
    if (!admissibility.ok || !admissibility.evidence || !admissibility.headHash || !admissibility.materialHash || !admissibility.storyFilesHash) {
      throw new Error(`autopilot_review_submit --deriveBindings requires canonical current PASS validation evidence: ${admissibility.reasons.join('; ')}`);
    }
    const materialDigest = admissibility.materialHash;
    const storyFilesHash = admissibility.storyFilesHash;

    const bindings = deriveHostVerdictBindings({
      storyId: identity.storyId,
      headHash: admissibility.headHash,
      materialDigest,
      storyFilesHash,
      testEvidence: admissibility.evidence,
      hostId: identity.hostId,
      provider: identity.provider,
      sessionId: identity.sessionId,
    });
    assertMatchingBinding('materialDigest', args.materialDigest, materialDigest);
    assertMatchingBinding('storyFilesHash', args.storyFilesHash, storyFilesHash);
    assertMatchingBinding('keyId', args.keyId, bindings.keyId);
    assertMatchingBinding('validationDigest', args.validationDigest, bindings.validationDigest);
    assertMatchingBinding('promptDigest', args.promptDigest, bindings.promptDigest);

    return submitLocalVerdict(ctx, 'local', {
      ...args,
      ...identity,
      materialDigest,
      storyFilesHash,
      keyId: bindings.keyId,
      validationDigest: bindings.validationDigest,
      promptDigest: bindings.promptDigest,
    });
  });
}

export interface LocalVerdictOutputIdentity {
  processEvent: ProcessEventAppendIdentity;
  verdictJson: {
    filePath: string;
    bytes: Buffer;
  };
}

export interface LocalVerdictWriteResult {
  verdict: HostVerdict;
  outputIdentity: LocalVerdictOutputIdentity;
}

function writeVerdict(ctx: HandlerContext, mode: VerdictMode, args: SubmitArgs): {
  verdict: HostVerdict;
  outputIdentity?: LocalVerdictOutputIdentity;
} {
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
  const verdictJson = {
    filePath: join(
      ctx.root,
      PROOF_OR_STOP_DIR,
      mode === 'authority' ? 'authority-verdicts' : 'autopilot-verdicts',
      verdict.storyId || verdict.jobId || 'global',
      `${verdict.verdictId}.json`,
    ),
    bytes: Buffer.from(`${JSON.stringify(verdict, null, 2)}\n`),
  };
  if (mode === 'local' && verdict.storyId) {
    try {
      const processEvent = ctx.store.appendProcessEvent(verdict.storyId, {
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
      return { verdict, outputIdentity: { processEvent, verdictJson } };
    } catch (error) {
      try {
        if (existsSync(verdictJson.filePath) && readFileSync(verdictJson.filePath).equals(verdictJson.bytes)) {
          rmSync(verdictJson.filePath);
        }
      } catch {
        // Preserve a concurrently changed/unreadable verdict file and retain the writer failure.
      }
      throw error;
    }
  }
  return { verdict };
}

export function submitLocalVerdict(ctx: HandlerContext, mode: VerdictMode, args: SubmitArgs): HostVerdict {
  return writeVerdict(ctx, mode, args).verdict;
}

export function submitLocalVerdictWithOutputIdentity(
  ctx: HandlerContext,
  args: SubmitArgs,
): LocalVerdictWriteResult {
  const written = writeVerdict(ctx, 'local', args);
  if (!written.outputIdentity) {
    throw new Error('local verdict writer did not return its exact output identity');
  }
  return { verdict: written.verdict, outputIdentity: written.outputIdentity };
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
      if (args.deriveBindings) {
        return submitWithDerivedBindings(ctx, args).then(result => wantsJson(args)
          ? result
          : render(`Proof-or-Stop autopilot review submit (${result.schemaVersion})`, result as unknown as Record<string, unknown>));
      }
      const result = submitLocal('local', args);
      return wantsJson(args) ? result : render(`Proof-or-Stop autopilot review submit (${result.schemaVersion})`, result as unknown as Record<string, unknown>);
    },
    autopilot_review_status(args: { storyId: string; runId?: string; requiredHosts?: number } & FormatArgs) {
      const result = localReviewStatus(args);
      return wantsJson(args) ? result : formatAutopilotReviewStatus(result);
    },
  };
}
