import { createHash } from 'node:crypto';
import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import {
  isUsageLedgerEnabled,
  recordDispatchPreflight,
  recordDispatchUnavailableFinal,
  type DispatchPreflightHandle,
  type DispatchUsageContext,
  type DispatchUsageOptions,
} from '../core/usage-ledger/dispatch-usage.js';
import {
  REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_EVENT,
  REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE,
  REVIEW_ESCALATION_FALLBACK_ELIGIBILITIES,
  REVIEW_HOST_AVAILABILITY_CANONICAL_HOSTS,
  REVIEW_HOST_AVAILABILITY_PROBE_COMMAND,
  assessReviewHostAvailabilityForFallbackEligibility,
  evaluateReviewEscalation,
  formatReviewEscalationReport,
  isReviewEscalationFallbackEligibility,
  probeReviewHostAvailability,
  resolveCompletedReviewEscalationSnapshot,
  type ReviewEscalationFallbackEligibility,
} from '../core/review-escalation.js';
import {
  buildReviewEscalationGuidance,
  buildReviewAssuranceFloorGuidance,
  evaluateReviewAssuranceFloor,
  renderReviewAssuranceGuidance,
} from '../core/review-assurance-floor.js';
import type { HostExecutionFailureKind } from '../core/host-execution-readiness.js';
import { readBrandEnv } from '../core/brand-env.js';

type FormatArgs = { json?: boolean; format?: 'text' | 'json' };

type ReviewEscalationStatusArgs = {
  storyId: string;
} & FormatArgs;

type ReviewEscalationFallbackSetArgs = {
  storyId: string;
  eligibility: ReviewEscalationFallbackEligibility;
  reason: string;
  evidenceRefs?: string[];
  approvalRef?: string;
  materialHash?: string;
  storyFilesHash?: string;
  actor?: string;
} & FormatArgs;

type ReviewHostAvailabilityProbeArgs = {
  storyId: string;
  materialHash?: string;
  storyFilesHash?: string;
  timeoutMs?: number;
  actor?: string;
} & FormatArgs;

type ReviewEscalationPolicySetArgs = {
  storyId: string;
  policyVersion: string;
  sourcePolicyRef: string;
  rolloutStage: string;
  milestoneId?: string;
  riskClass?: string;
  degradedFallbackAllowed: boolean;
  issuer?: string;
  approver?: string;
  materialHash?: string;
  headHash?: string;
  actor?: string;
} & FormatArgs;

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.json === true || args?.format === 'json';
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringArray(values: unknown): string[] {
  return Array.isArray(values)
    ? values.map(value => normalizeString(value)).filter(Boolean)
    : [];
}

// ===========================================================================
// B-70e9 CHK-003: usage-ledger coverage for the host readiness probe.
//
// Each canonical host readiness probe makes a real (tiny) LLM call but the probe
// RESULT (frozen B-d8ef surface, core/host-execution-readiness.ts) does NOT retain
// the host stdout, so there is no usage envelope to parse without changing that
// frozen contract. We therefore record, PER probed host, a preflight estimate over
// the fixed probe prompt (sequence 1) plus an UNAVAILABLE final (sequence 2,
// superseding the estimate) with reason 'probe_output_not_retained'. This makes the
// probe VISIBLE in the ledger (the story goal) without touching core probe internals
// or fabricating a token count. All wiring is fail-open: a ledger error must never
// break the probe command.
// ===========================================================================

/**
 * The fixed host readiness probe prompt. Mirrors the frozen (unexported) literal
 * HOST_EXECUTION_READINESS_PROMPT in core/host-execution-readiness.ts — reconstructed
 * here rather than plumbed through the frozen probe return shape.
 */
export const HOST_READINESS_PROBE_PROMPT = 'Reply READY and do not run tools.';
export const HOST_READINESS_PROBE_AGENT_TYPE = 'host-readiness-probe';
export const HOST_READINESS_PROBE_UNAVAILABLE_REASON = 'probe_output_not_retained';

/** Best-effort project-root hash for a usage-ledger context (mirrors the host_run handler). */
function projectRootHashForProbe(root: string): string {
  return `sha256:${createHash('sha256').update(root, 'utf8').digest('hex')}`;
}

/** Map a canonical probe host name to its ledger host.kind (as in core/host-run.ts). */
function probeHostKind(host: string): string {
  return host === 'codex' ? 'codex' : host === 'claude' ? 'claude-code' : 'antigravity';
}

/** Map a canonical probe host name to its ledger provider name. */
function probeProviderName(host: string): string {
  return host === 'codex' ? 'openai' : host === 'claude' ? 'anthropic' : 'antigravity';
}

/** The per-host discriminator fields read from the frozen probe row shape (F-015). */
export interface HostReadinessProbeAttempt {
  host: string;
  failureKind: HostExecutionFailureKind;
  exitCode?: number;
  outputBytes?: number;
}

export interface HostReadinessProbeUsageInput {
  root: string;
  storyId: string | null;
  phase: string;
  /**
   * The probed hosts. `host` names the provider; `failureKind` (+ exitCode/outputBytes
   * for the wrong_launcher case) is the F-015 discriminator for whether a readiness
   * subprocess actually launched — see readinessProbeSubprocessLaunched.
   */
  hosts: ReadonlyArray<HostReadinessProbeAttempt>;
  env: NodeJS.ProcessEnv;
  recordedAt: string;
  projectRootHash: string;
}

export interface HostReadinessProbeUsageRow {
  host: string;
  recordId: string | null;
}

/**
 * F-015 discriminator: did this host's readiness-prompt subprocess actually launch?
 *
 * probeHostExecutionReadiness() only reaches the readiness-prompt spawnSync when a
 * host has BOTH an executablePath AND versionOk. Two failureKinds are decided
 * strictly BEFORE that spawn, so they represent NO subprocess and NO LLM call:
 *   - missing_executable : resolveExecutablePath found nothing (no --version, no readiness spawn)
 *   - version_failed     : --version ran but failed, so the readiness prompt was never spawned
 *
 * wrong_launcher is ambiguous. classifyHostExecutionReadiness() returns it from the
 * launcher-argv classification path BEFORE spawnSync (a non-spawn that carries NO
 * spawn-result evidence — no exitCode, no outputBytes), while
 * classifyHostExecutionFailure() can ALSO return it AFTER a real spawn when the
 * launched CLI rejected a flag (a classified result → outputBytes present). Only the
 * pre-spawn variety is a non-call, so wrong_launcher is skipped ONLY when the row
 * carries no spawn-result evidence.
 *
 * Every other failureKind (none / timeout / auth / silent_final_output / unsupported /
 * unknown) implies a classified spawn result — the subprocess DID launch — so those
 * keep recording a usage row. This is exactly the honest boundary the finding asks
 * for: skip phantom rows for hosts that never spawned the readiness prompt.
 */
function readinessProbeSubprocessLaunched(probed: HostReadinessProbeAttempt): boolean {
  if (probed.failureKind === 'missing_executable' || probed.failureKind === 'version_failed') {
    return false;
  }
  if (
    probed.failureKind === 'wrong_launcher' &&
    probed.exitCode === undefined &&
    probed.outputBytes === undefined
  ) {
    return false;
  }
  return true;
}

/**
 * PURE, testable wiring helper (no spawning): record a preflight + unavailable final
 * per probed host. Strict no-op when the ledger is OFF. Every ledger call is fail-open
 * so a writer error can never break the probe command. Returns the per-host final
 * recordIds for the smoke to assert.
 */
export function recordHostReadinessProbeUsage(input: HostReadinessProbeUsageInput): HostReadinessProbeUsageRow[] {
  const rows: HostReadinessProbeUsageRow[] = [];
  if (!isUsageLedgerEnabled(input.env)) return rows;

  for (const probed of input.hosts) {
    // F-015: skip hosts whose readiness prompt never spawned (missing_executable /
    // version_failed / pre-spawn wrong_launcher). Recording preflight+unavailable
    // rows for them would fabricate phantom LLM calls the host never made.
    if (!readinessProbeSubprocessLaunched(probed)) continue;
    const host = probed.host;
    const ctx: DispatchUsageContext = {
      storyId: input.storyId,
      phase: input.phase,
      agentType: HOST_READINESS_PROBE_AGENT_TYPE,
    };
    const opts: DispatchUsageOptions = {
      recordedAt: input.recordedAt,
      projectRootHash: input.projectRootHash,
      command: `host-readiness-probe:${host}`,
      host: { kind: probeHostKind(host) },
      env: input.env,
    };

    let handle: DispatchPreflightHandle | null = null;
    try {
      handle = recordDispatchPreflight(input.root, ctx, HOST_READINESS_PROBE_PROMPT, opts);
    } catch {
      handle = null;
    }

    let recordId: string | null = null;
    try {
      const res = recordDispatchUnavailableFinal(
        input.root,
        ctx,
        handle?.correlation ?? null,
        handle?.estimateRecordId ?? null,
        { name: probeProviderName(host), model: null },
        HOST_READINESS_PROBE_UNAVAILABLE_REASON,
        opts,
      );
      recordId = res.recordId;
    } catch {
      // The seam never breaks the probe.
    }
    rows.push({ host, recordId });
  }
  return rows;
}

/**
 * Resolve the honest story phase for probe usage attribution, falling back to 'probe'
 * when the story phase cannot be read. Never throws.
 */
function resolveProbeStoryPhase(ctx: HandlerContext, storyId: string): string {
  try {
    const phase = ctx.store.readStory(storyId)?.phase;
    return typeof phase === 'string' && phase.length > 0 ? phase : 'probe';
  } catch {
    return 'probe';
  }
}

export function createReviewEscalationHandlers(ctx: HandlerContext) {
  return {
    review_escalation_status(args: ReviewEscalationStatusArgs) {
      const gitCwd = resolveGitCwd({ store: ctx.store, storyId: args.storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
      const completedSnapshot = resolveCompletedReviewEscalationSnapshot({
        storyId: args.storyId,
        store: ctx.store,
      });
      const report = evaluateReviewEscalation({
        projectRoot: ctx.root,
        gitCwd,
        storyId: args.storyId,
        store: ctx.store,
        ...(completedSnapshot ? { materialHash: completedSnapshot.materialHash } : {}),
        ...(completedSnapshot?.storyFilesHash ? { storyFilesHash: completedSnapshot.storyFilesHash } : {}),
      });
      const projectedReport = completedSnapshot
        ? {
            ...report,
            advisories: [
              ...(report.advisories ?? []),
              `DONE historical snapshot from ${completedSnapshot.source}; current-material revalidation is not the default post-DONE status`,
            ],
          }
        : report;
      const floor = evaluateReviewAssuranceFloor({
        projectRoot: ctx.root,
        gitCwd,
        storyId: args.storyId,
        store: ctx.store,
        ...(completedSnapshot ? { materialHash: completedSnapshot.materialHash } : {}),
        ...(completedSnapshot?.storyFilesHash ? { storyFilesHash: completedSnapshot.storyFilesHash } : {}),
      });
      const escalationGuidance = buildReviewEscalationGuidance(projectedReport, args.storyId);
      const floorGuidance = buildReviewAssuranceFloorGuidance(floor);
      const reviewAssuranceGuidance = [escalationGuidance, floorGuidance].filter((guidance) => guidance.required);
      if (wantsJson(args)) {
        return {
          ...projectedReport,
          reviewAssuranceGuidance,
        };
      }
      const extraGuidance = reviewAssuranceGuidance.length > 0
        ? `\n\n${reviewAssuranceGuidance.map((guidance) => renderReviewAssuranceGuidance(guidance)).join('\n\n')}`
        : '';
      return `${formatReviewEscalationReport(projectedReport)}${extraGuidance}`;
    },

    review_escalation_policy_set(args: ReviewEscalationPolicySetArgs) {
      assertCwdInWorktree(ctx.store, args.storyId);
      const gitCwd = resolveGitCwd({ store: ctx.store, storyId: args.storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
      const policyVersion = normalizeString(args.policyVersion);
      const sourcePolicyRef = normalizeString(args.sourcePolicyRef);
      const rolloutStage = normalizeString(args.rolloutStage);
      const milestoneId = normalizeString(args.milestoneId);
      const riskClass = normalizeString(args.riskClass);
      const issuer = normalizeString(args.issuer) || normalizeString(args.actor) || readBrandEnv('AGENT') || process.env.USER || 'main';
      const approver = normalizeString(args.approver);
      if (!policyVersion) throw new Error('review_escalation_policy_set: policyVersion is required');
      if (!sourcePolicyRef) throw new Error('review_escalation_policy_set: sourcePolicyRef is required');
      if (!rolloutStage) throw new Error('review_escalation_policy_set: rolloutStage is required');
      if (!milestoneId && !riskClass) throw new Error('review_escalation_policy_set: provide milestoneId or riskClass');
      if (typeof args.degradedFallbackAllowed !== 'boolean') {
        throw new Error('review_escalation_policy_set: degradedFallbackAllowed must be boolean');
      }
      const freshMaterialHash = currentMaterialHash(gitCwd, 'HEAD', ctx.root);
      if (!freshMaterialHash) throw new Error('review_escalation_policy_set: cannot compute current material hash');
      const freshHeadHash = currentGitHead(gitCwd);
      if (!freshHeadHash) throw new Error('review_escalation_policy_set: cannot compute current git HEAD');
      const suppliedMaterialHash = normalizeString(args.materialHash);
      if (suppliedMaterialHash && suppliedMaterialHash !== freshMaterialHash) {
        throw new Error('review_escalation_policy_set: supplied materialHash is stale and does not match current material hash');
      }
      const suppliedHeadHash = normalizeString(args.headHash);
      if (suppliedHeadHash && suppliedHeadHash !== freshHeadHash) {
        throw new Error('review_escalation_policy_set: supplied headHash is stale and does not match current HEAD');
      }

      const issuedAt = new Date().toISOString();
      const policyId = `${args.storyId}:POL-${Date.now().toString(36)}`;
      ctx.store.appendProcessEvent(args.storyId, {
        type: REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_EVENT,
        storyId: args.storyId,
        command: 'review_escalation_policy_set',
        policyId,
        predicate: REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE,
        requires3x2: true,
        policyVersion,
        ...(milestoneId ? { milestoneId } : {}),
        ...(riskClass ? { riskClass } : {}),
        sourcePolicyRef,
        rolloutStage,
        degradedFallbackAllowed: args.degradedFallbackAllowed,
        issuer,
        ...(approver ? { approver } : {}),
        issuedAt,
        headHash: freshHeadHash,
        materialHash: freshMaterialHash,
        authorityDone: false,
        fullAuthorityDone: false,
        productionDone: false,
      });

      const report = evaluateReviewEscalation({
        projectRoot: ctx.root,
        gitCwd,
        storyId: args.storyId,
        store: ctx.store,
      });
      const commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, 'review_escalation_policy_set');
      if (wantsJson(args)) {
        return {
          schemaVersion: 'proof-or-stop.review_escalation_policy_set.v1',
          policyId,
          predicate: REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE,
          requires3x2: true,
          policyVersion,
          sourcePolicyRef,
          rolloutStage,
          degradedFallbackAllowed: args.degradedFallbackAllowed,
          headHash: freshHeadHash,
          materialHash: freshMaterialHash,
          authorityDone: false,
          fullAuthorityDone: false,
          productionDone: false,
          report,
        };
      }
      return [
        `Review escalation policy ${policyId} recorded`,
        `predicate: ${REVIEW_ESCALATION_EXPLICIT_HIGH_RISK_POLICY_PREDICATE}`,
        `requires3x2: true`,
        `policyVersion: ${policyVersion}`,
        `sourcePolicyRef: ${sourcePolicyRef}`,
        `rolloutStage: ${rolloutStage}`,
        `degradedFallbackAllowed: ${args.degradedFallbackAllowed}`,
        `materialHash: ${freshMaterialHash}`,
        `reviewEscalationRequired: ${report.required}`,
        'admissibilityStatus: local-review-policy-recorded',
        'assuranceLevel: local',
        'evidenceScope: review-escalation-policy',
        commitHint.trim(),
      ].filter(Boolean).join('\n');
    },

    review_host_availability_probe(args: ReviewHostAvailabilityProbeArgs) {
      assertCwdInWorktree(ctx.store, args.storyId);
      const gitCwd = resolveGitCwd({ store: ctx.store, storyId: args.storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
      const freshMaterialHash = currentMaterialHash(gitCwd, 'HEAD', ctx.root);
      if (!freshMaterialHash) {
        throw new Error('review_host_availability_probe: cannot compute current material hash');
      }
      const suppliedMaterialHash = normalizeString(args.materialHash);
      if (suppliedMaterialHash && suppliedMaterialHash !== freshMaterialHash) {
        throw new Error('review_host_availability_probe: supplied materialHash is stale and does not match current material hash');
      }
      const freshStoryFilesHash = currentStoryFilesHash(gitCwd, 'HEAD', ctx.root);
      const suppliedStoryFilesHash = normalizeString(args.storyFilesHash);
      if (suppliedStoryFilesHash && freshStoryFilesHash && suppliedStoryFilesHash !== freshStoryFilesHash) {
        throw new Error('review_host_availability_probe: supplied storyFilesHash is stale and does not match current story-owned file hash');
      }
      const timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs && args.timeoutMs > 0
        ? Math.min(Math.floor(args.timeoutMs), 30000)
        : undefined;
      const event = probeReviewHostAvailability({
        storyId: args.storyId,
        materialHash: freshMaterialHash,
        storyFilesHash: freshStoryFilesHash || suppliedStoryFilesHash || undefined,
        cwd: gitCwd,
        timeoutMs,
      });
      ctx.store.appendProcessEvent(args.storyId, {
        ...event,
        ...(normalizeString(args.actor) ? { actor: normalizeString(args.actor) } : {}),
      });

      // B-70e9 CHK-003: make the per-host readiness probe LLM calls visible in the
      // usage ledger. Fail-open — a ledger error must never break the probe command.
      try {
        recordHostReadinessProbeUsage({
          root: ctx.root,
          storyId: args.storyId,
          phase: resolveProbeStoryPhase(ctx, args.storyId),
          // Carry the F-015 discriminator (failureKind + spawn-result evidence) so the
          // helper records ONLY hosts whose readiness prompt actually spawned.
          hosts: event.hosts.map(row => ({
            host: row.host,
            failureKind: row.failureKind,
            ...(row.exitCode !== undefined ? { exitCode: row.exitCode } : {}),
            ...(row.outputBytes !== undefined ? { outputBytes: row.outputBytes } : {}),
          })),
          env: process.env,
          recordedAt: new Date().toISOString(),
          projectRootHash: projectRootHashForProbe(ctx.root),
        });
      } catch {
        // The usage ledger is diagnostics-only; never let it break the probe.
      }

      const commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, REVIEW_HOST_AVAILABILITY_PROBE_COMMAND);
      if (wantsJson(args)) {
        return event;
      }
      return [
        `Review host availability probe ${event.probeId} recorded`,
        `canonicalHosts: ${REVIEW_HOST_AVAILABILITY_CANONICAL_HOSTS.join(', ')}`,
        `availableHostCount: ${event.availableHostCount}`,
        `unavailableHostCount: ${event.unavailableHostCount}`,
        `executionReadyHostCount: ${event.executionReadyHostCount}`,
        `reviewReadyHostCount: ${event.reviewReadyHostCount}`,
        `materialHash: ${freshMaterialHash}`,
        ...(event.storyFilesHash ? [`storyFilesHash: ${event.storyFilesHash}`] : []),
        ...event.hosts.map(row => `  - ${row.host}: launcherSupport=${row.launcherSupport} executionReady=${row.executionReady} reviewReady=${row.reviewReady} progressMode=${row.progressMode} failureKind=${row.failureKind}${row.executablePath ? ` path=${row.executablePath}` : ''}${row.diagnostic ? ` (${row.diagnostic})` : row.error ? ` (${row.error})` : ''}${row.remediation ? ` remediation=${row.remediation}` : ''}`),
        'evidenceScope: review-host-availability-probe',
        commitHint.trim(),
      ].filter(Boolean).join('\n');
    },

    review_escalation_fallback_set(args: ReviewEscalationFallbackSetArgs) {
      assertCwdInWorktree(ctx.store, args.storyId);
      const gitCwd = resolveGitCwd({ store: ctx.store, storyId: args.storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
      if (!isReviewEscalationFallbackEligibility(args.eligibility)) {
        throw new Error(`review_escalation_fallback_set: eligibility must be one of ${REVIEW_ESCALATION_FALLBACK_ELIGIBILITIES.join('|')}`);
      }
      const reason = normalizeString(args.reason);
      if (reason.length < 20) {
        throw new Error('review_escalation_fallback_set: reason must be at least 20 characters and explain the selected degraded fallback eligibility and why lower-assurance 3x1 is being used');
      }
      const evidenceRefs = normalizeStringArray(args.evidenceRefs);
      const approvalRef = normalizeString(args.approvalRef);
      if (evidenceRefs.length === 0 && !approvalRef) {
        throw new Error('review_escalation_fallback_set: provide at least one evidenceRefs entry or approvalRef');
      }
      const freshMaterialHash = currentMaterialHash(gitCwd, 'HEAD', ctx.root);
      if (!freshMaterialHash) {
        throw new Error('review_escalation_fallback_set: cannot compute current material hash');
      }
      const suppliedMaterialHash = normalizeString(args.materialHash);
      if (suppliedMaterialHash && suppliedMaterialHash !== freshMaterialHash) {
        throw new Error('review_escalation_fallback_set: supplied materialHash is stale and does not match current material hash');
      }
      const freshStoryFilesHash = currentStoryFilesHash(gitCwd, 'HEAD', ctx.root);
      const suppliedStoryFilesHash = normalizeString(args.storyFilesHash);
      if (suppliedStoryFilesHash && freshStoryFilesHash && suppliedStoryFilesHash !== freshStoryFilesHash) {
        throw new Error('review_escalation_fallback_set: supplied storyFilesHash is stale and does not match current story-owned file hash');
      }
      const storyFilesHash = freshStoryFilesHash || suppliedStoryFilesHash;
      const hostAvailability = assessReviewHostAvailabilityForFallbackEligibility(
        ctx.store.readProcessEvents(args.storyId),
        args.eligibility,
        freshMaterialHash,
        storyFilesHash || null,
      );
      if (!hostAvailability.ok) {
        throw new Error(`review_escalation_fallback_set: ${hostAvailability.reasons.join('; ')}`);
      }
      const hostAvailabilityProbeId = hostAvailability.required
        ? hostAvailability.latestFreshProbe?.probeId
        : undefined;

      const fallbackId = `${args.storyId}:REF-${Date.now().toString(36)}`;
      const actor = normalizeString(args.actor) || readBrandEnv('AGENT') || process.env.USER || 'main';
      ctx.store.appendProcessEvent(args.storyId, {
        type: 'review_escalation_fallback',
        storyId: args.storyId,
        command: 'review_escalation_fallback_set',
        fallbackId,
        eligibility: args.eligibility,
        reason,
        evidenceRefs,
        ...(approvalRef ? { approvalRef } : {}),
        ...(hostAvailabilityProbeId ? { hostAvailabilityProbeId } : {}),
        materialHash: freshMaterialHash,
        ...(storyFilesHash ? { storyFilesHash } : {}),
        assuranceLevel: 'degraded-single-host',
        actor,
        authorityDone: false,
        fullAuthorityDone: false,
        productionDone: false,
      });

      const report = evaluateReviewEscalation({
        projectRoot: ctx.root,
        gitCwd,
        storyId: args.storyId,
        store: ctx.store,
      });
      const commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, 'review_escalation_fallback_set');
      if (wantsJson(args)) {
        return {
          schemaVersion: 'proof-or-stop.review_escalation_fallback_set.v1',
          fallbackId,
          materialHash: freshMaterialHash,
          ...(storyFilesHash ? { storyFilesHash } : {}),
          ...(hostAvailabilityProbeId ? { hostAvailabilityProbeId } : {}),
          assuranceLevel: 'degraded-single-host',
          authorityDone: false,
          fullAuthorityDone: false,
          productionDone: false,
          report,
        };
      }
      return [
        `Review escalation fallback ${fallbackId} recorded`,
        `assuranceLevel: degraded-single-host`,
        `materialHash: ${freshMaterialHash}`,
        ...(storyFilesHash ? [`storyFilesHash: ${storyFilesHash}`] : []),
        ...(hostAvailabilityProbeId ? [`hostAvailabilityProbeId: ${hostAvailabilityProbeId}`] : []),
        `reviewEscalationOk: ${report.ok}`,
        'admissibilityStatus: degraded-local-review-recorded',
        'assuranceLevel: degraded-single-host',
        'evidenceScope: review-escalation-fallback',
        commitHint.trim(),
      ].filter(Boolean).join('\n');
    },
  };
}
