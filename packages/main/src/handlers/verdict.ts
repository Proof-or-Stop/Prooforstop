import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HandlerContext } from './context.js';
import {
  submitVerdict,
  summarizeVerdictRuns,
  summarizeVerdicts,
  type VerdictDecision,
  type VerdictMode,
  type DisagreementBehavior,
  type VerdictRunDiagnostics,
  type VerdictRunSummary,
  type VerdictSummary,
} from '../core/verdicts.js';
import {
  resolveAuthorityVerdictBacking,
  submitAuthorityJobFromPlan,
  submitAuthorityHostVerdict,
  listAuthorityHostVerdicts,
  authorityJobVerdictStatus,
  type AuthorityFetch,
} from '../core/authority-client.js';
import {
  FINAL_HOST_REVIEW_PROMPT_PROFILE,
  type AuthorityVerdictClaim,
} from '../core/authority-contracts.js';
import { readPlannerRun, type JobPlan } from '../core/planner.js';

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
    render(`Lattice autopilot review status (${result.schemaVersion})`, selectedRun as unknown as Record<string, unknown>),
    `runs: ${allRunIds.length > 0 ? allRunIds.join(', ') : '<none>'}`,
    `latestRuns: ${latestRuns.length}`,
    ...latestRuns.map(run => `  - ${formatRunSummary(run)}`),
    `allRuns: ${allRuns.length}`,
    `diagnosticOnly: ${runDiagnostics.diagnosticOnly}`,
    `authorityServerContact: ${runDiagnostics.authorityServerContact}`,
  ].join('\n');
}

/** Test/injection seams — not part of the CLI schema. */
interface AuthorityBackingSeams {
  _fetchImpl?: AuthorityFetch;
  _env?: Record<string, string | undefined>;
  authorityURL?: string;
}

type SubmitArgs = {
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
  note?: string;
} & FormatArgs &
  AuthorityBackingSeams;

type JobStatusArgs = {
  jobId: string;
  runId?: string;
  requiredHosts?: number;
  disagreementBehavior?: DisagreementBehavior;
  receiptFile?: string;
  receiptProjectId?: string;
  receiptStoryId?: string;
  serverKeyId?: string;
  expectedDecisionDigest?: string;
  gateInputDigest?: string;
} & FormatArgs &
  AuthorityBackingSeams;

type JobCreateArgs = {
  jobPlanFile?: string;
  runId?: string;
  provider?: 'codex' | 'claude-code' | 'gemini';
  role?: 'planner' | 'implementer' | 'reviewer' | 'explorer' | 'tester';
  promptRef?: string;
  promptHash?: string;
  cwd?: string;
  canWrite?: boolean;
  canRunShell?: boolean;
  mutatesStory?: boolean;
} & FormatArgs &
  AuthorityBackingSeams;

type ReceiptFetchArgs = {
  receiptId: string;
  outputFile?: string;
} & FormatArgs &
  AuthorityBackingSeams;

function readJsonFile(root: string, file: string): Record<string, unknown> {
  const path = file.startsWith('/') ? file : join(root, file);
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function loadJobPlan(root: string, args: JobCreateArgs): JobPlan {
  if (args.jobPlanFile) return readJsonFile(root, args.jobPlanFile) as unknown as JobPlan;
  if (args.runId) {
    const record = readPlannerRun(root, args.runId);
    if (record.jobPlan) return record.jobPlan;
  }
  throw new Error('jobPlanFile or runId with a persisted jobPlan is required');
}

/**
 * Build the server-side §X9 verdict claim from a verdict file (the full record) plus
 * explicit CLI overrides. CLI args win over file fields. Identity fields (hostId /
 * session / key) are intentionally NOT sent — the Authority derives them from the
 * authenticated request context, never from the body.
 */
function buildAuthorityClaim(root: string, args: SubmitArgs): AuthorityVerdictClaim {
  const file = (args.verdictFile ? readJsonFile(root, args.verdictFile) : {}) as Partial<AuthorityVerdictClaim> & {
    materialDigest?: string;
  };
  const pick = <T>(...vals: (T | undefined)[]): T | undefined => vals.find(v => v !== undefined);
  return {
    runId: pick(args.runId, file.runId) ?? 'default-run',
    storyId: pick(args.storyId, file.storyId) ?? '',
    role: pick(args.role, file.role) ?? 'verifier',
    provider: pick(args.provider, file.provider) ?? 'unknown',
    model: pick(args.model, file.model),
    decision: pick(args.decision, file.decision) ?? 'blocked',
    reviewWaveId: pick(args.reviewWaveId, file.reviewWaveId),
    reviewPromptProfile: pick(args.promptProfile, file.reviewPromptProfile) ?? FINAL_HOST_REVIEW_PROMPT_PROFILE,
    reviewPromptDigest: pick(args.promptDigest, file.reviewPromptDigest),
    checkedEvidenceRefs: file.checkedEvidenceRefs,
    checkedReceiptId: pick(args.receiptId, file.checkedReceiptId),
    checkedGateInputDigest: pick(args.gateInputDigest, file.checkedGateInputDigest),
    checkedValidationDigest: pick(args.validationDigest, file.checkedValidationDigest),
    checkedMaterialHash: pick(args.materialDigest, file.checkedMaterialHash, file.materialDigest),
    checkedCommit: file.checkedCommit,
    commandsRun: file.commandsRun,
    findings: file.findings,
    artifactDigest: pick(args.artifactDigest, file.artifactDigest),
    issuedAt: file.issuedAt,
  };
}

export function createVerdictHandlers(ctx: HandlerContext) {
  const submitLocal = (mode: VerdictMode, args: SubmitArgs) => {
    const verdict = submitVerdict(ctx.root, { ...args, mode });
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
        validationDigest: verdict.validationDigest,
        promptDigest: verdict.promptDigest,
      });
    }
    return verdict;
  };

  const listLocal = (
    mode: VerdictMode,
    args: { storyId?: string; jobId?: string; runId?: string; requiredHosts?: number } & FormatArgs,
  ) => {
    const id = mode === 'authority' ? args.jobId : args.storyId;
    if (!id) throw new Error(mode === 'authority' ? 'jobId is required' : 'storyId is required');
    return summarizeVerdicts(ctx.root, mode, id, args.runId || 'default-run', args.requiredHosts || 2);
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
      return wantsJson(args) ? result : render(`Lattice autopilot review submit (${result.schemaVersion})`, result as unknown as Record<string, unknown>);
    },
    autopilot_review_status(args: { storyId: string; runId?: string; requiredHosts?: number } & FormatArgs) {
      const result = localReviewStatus(args);
      return wantsJson(args) ? result : formatAutopilotReviewStatus(result);
    },

    async authority_job_create(args: JobCreateArgs = {}) {
      const jobPlan = loadJobPlan(ctx.root, args);
      const outcome = await submitAuthorityJobFromPlan(jobPlan, {
        env: args._env,
        fetchImpl: args._fetchImpl,
        authorityURL: args.authorityURL,
        cwd: args.cwd ?? ctx.root,
        provider: args.provider,
        role: args.role,
        promptRef: args.promptRef,
        promptHash: args.promptHash,
        canWrite: args.canWrite,
        canRunShell: args.canRunShell,
        mutatesStory: args.mutatesStory,
      });
      if (!outcome.ok) {
        throw new Error(`authority job create blocked (${outcome.transport}): ${outcome.reason ?? 'unknown error'}`);
      }
      const result = {
        schemaVersion: 'lattice.authority_job_create.v1' as const,
        backing: 'authority-server' as const,
        ok: outcome.ok,
        accepted: outcome.accepted,
        jobId: outcome.jobId,
        runId: outcome.runId,
        storyId: outcome.storyId,
        plannedStepsDigest: outcome.plannedStepsDigest,
        transport: outcome.transport,
      };
      return wantsJson(args) ? result : render(`Lattice authority job create (${result.schemaVersion})`, result as unknown as Record<string, unknown>);
    },

    async authority_receipt_fetch(args: ReceiptFetchArgs) {
      if (!args.receiptId) throw new Error('receiptId is required');
      const backing = resolveAuthorityVerdictBacking({ env: args._env, fetchImpl: args._fetchImpl, authorityURL: args.authorityURL, cwd: ctx.root });
      if (backing.mode !== 'server' || !backing.client) {
        throw new Error(`authority receipt fetch requires server-backed Authority config: ${backing.reason}`);
      }
      const outcome = await backing.client.fetchReceipt(args.receiptId);
      if (!outcome.ok || !outcome.data) {
        throw new Error(`authority receipt fetch failed (${outcome.kind}): ${outcome.message ?? 'unknown error'}`);
      }
      if (args.outputFile) {
        const path = args.outputFile.startsWith('/') ? args.outputFile : join(ctx.root, args.outputFile);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(outcome.data, null, 2)}\n`);
      }
      const result = {
        schemaVersion: 'lattice.authority_receipt_fetch.v1' as const,
        backing: 'authority-server' as const,
        ok: true,
        receiptId: args.receiptId,
        outputFile: args.outputFile ?? null,
        receipt: args.outputFile ? undefined : outcome.data,
      };
      return wantsJson(args) ? result : render(`Lattice authority receipt fetch (${result.schemaVersion})`, result as unknown as Record<string, unknown>);
    },

    async authority_verdict_submit(args: SubmitArgs = {}) {
      const backing = resolveAuthorityVerdictBacking({ env: args._env, fetchImpl: args._fetchImpl, authorityURL: args.authorityURL, cwd: ctx.root });
      if (backing.mode === 'server' && backing.client) {
        if (!args.jobId) throw new Error('jobId is required for authority verdicts');
        const claim = buildAuthorityClaim(ctx.root, args);
        const outcome = await submitAuthorityHostVerdict(backing.client, args.jobId, claim, {
          env: args._env,
          cwd: ctx.root,
        });
        if (!outcome.ok) {
          throw new Error(`authority verdict submit blocked (${outcome.transport}): ${outcome.reason ?? 'unknown error'}`);
        }
        return wantsJson(args) ? outcome : render('Lattice authority verdict submit (server-backed)', outcome as unknown as Record<string, unknown>);
      }
      // Local-storage fallback (non-authority / no URL) — preserved verbatim.
      const result = submitLocal('authority', args);
      return wantsJson(args) ? result : render(`Lattice authority verdict submit (${result.schemaVersion})`, result as unknown as Record<string, unknown>);
    },

    async authority_verdict_list(args: { jobId: string; runId?: string; requiredHosts?: number } & FormatArgs & AuthorityBackingSeams) {
      const backing = resolveAuthorityVerdictBacking({ env: args._env, fetchImpl: args._fetchImpl, authorityURL: args.authorityURL, cwd: ctx.root });
      if (backing.mode === 'server' && backing.client) {
        if (!args.jobId) throw new Error('jobId is required');
        const outcome = await listAuthorityHostVerdicts(backing.client, args.jobId);
        if (!outcome.ok) {
          throw new Error(`authority verdict list failed (${outcome.transport}): ${outcome.reason ?? 'unknown error'}`);
        }
        return wantsJson(args) ? outcome : render('Lattice authority verdict list (server-backed)', outcome as unknown as Record<string, unknown>);
      }
      const result = listLocal('authority', args);
      return wantsJson(args) ? result : render(`Lattice authority verdict list (${result.schemaVersion})`, result as unknown as Record<string, unknown>);
    },

    async authority_job_status(args: JobStatusArgs) {
      const backing = resolveAuthorityVerdictBacking({ env: args._env, fetchImpl: args._fetchImpl, authorityURL: args.authorityURL, cwd: ctx.root });
      if (backing.mode === 'server' && backing.client) {
        if (!args.jobId) throw new Error('jobId is required');
        const receipt = args.receiptFile ? readJsonFile(ctx.root, args.receiptFile) : undefined;
        const status = await authorityJobVerdictStatus(
          backing.client,
          {
            jobId: args.jobId,
            runId: args.runId,
            disagreementBehavior: args.disagreementBehavior,
            receipt,
            expectedProjectId: args.receiptProjectId,
            expectedStoryId: args.receiptStoryId,
            expectedServerKeyId: args.serverKeyId,
            expectedDecisionDigest: args.expectedDecisionDigest,
            expectedGateInputDigest: args.gateInputDigest,
          },
          args._env,
        );
        if (!status.ok) {
          throw new Error(`authority job status failed (${status.transport}): ${status.reason ?? 'unknown error'}`);
        }
        const result = {
          schemaVersion: 'lattice.authority_job_status.v2' as const,
          backing: 'authority-server' as const,
          jobId: status.jobId,
          runId: status.runId,
          // authorityDone is the per-run verified gate_decision receipt half. It is
          // false unless a receiptFile was supplied AND verified — never minted from
          // host agreement alone.
          authorityDone: status.certification?.authorityDone ?? false,
          receiptVerified: status.certification?.receiptVerified ?? false,
          nativeReceiptRequired: true,
          multiHostVerified: status.certification?.multiHostVerified ?? false,
          fullAuthorityDone: status.certification?.fullAuthorityDone ?? false,
          status: status.certification?.status ?? 'blocked',
          blockedReason: status.certification?.blockedReason,
          nextAction: status.certification?.nextAction,
          certification: status.certification,
        };
        return wantsJson(args) ? result : render(`Lattice authority job status (${result.schemaVersion})`, result as unknown as Record<string, unknown>);
      }

      // Local-storage fallback (non-authority / no URL) — preserved verbatim.
      const verdictSummary = listLocal('authority', args);
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
