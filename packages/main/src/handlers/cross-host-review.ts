import { readFileSync } from 'node:fs';
import type { HandlerContext } from './context.js';
import { resolveStoryCommandWorkspace } from './context.js';
import { submitLocalVerdict, type FormatArgs } from './verdict.js';
import { canonicalDigest } from '../core/authority-signing.js';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { isCanonicalStoryId } from '../core/lifecycle-registry.js';
import type { Finding } from '../core/adversarial-review.js';
import { FINDING_SEVERITIES } from '../core/adversarial-review.js';
import {
  runCodexReviewLeaf,
  type CodexReviewRunner,
  type CodexReviewVerdict,
} from '../core/codex-review-leaf.js';
import {
  diffFindings,
  jointDecision,
  type DisagreementReport,
  type JointDecisionResult,
} from '../core/cross-host-review.js';
import {
  checkDispatchPolicy,
  type DispatchPolicy,
} from '../core/dispatch-policy.js';

const DEFAULT_TIMEOUT_MINUTES = 12;

/**
 * Env-var names that must NEVER be forwarded to the review subprocess. Kept
 * deliberately broad (F-007): beyond the obvious secret words it also catches
 * credential-bearing connection strings (DATABASE/DSN/CONNECTION), auth/session
 * material (AUTH/SESSION/COOKIE/PRIVATE/ACCESS), and any *_URL/_URI (which routinely
 * embed inline credentials, e.g. DATABASE_URL). A read-only code reviewer never
 * needs these, so stripping them by default is safe.
 */
const UNSAFE_ENV_PATTERN = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|(^|_)KEY|AUTH|SESSION|COOKIE|PRIVATE|ACCESS|DATABASE|(^|_)DSN|CONNECTION|_URL$|_URI$/i;

/**
 * F-004/F-007: build the redacted env the review-only codex subprocess is allowed
 * to see, from the base process env and the authorized policy. Fail-closed layering:
 *   1. If the policy declares an `envAllowlist`, ONLY those names may pass
 *      (everything else is dropped) — a strict allowlist. NOTE: an EMPTY allowlist
 *      (the default) does NOT strip everything — it means "no allowlist restriction",
 *      so steps 2-3 are the only guard. Policies handling sensitive environments
 *      SHOULD set an explicit envAllowlist; the broad UNSAFE_ENV_PATTERN below is the
 *      backstop when they do not.
 *   2. Any name matching the policy `envDenylist` is removed.
 *   3. Any name matching the broad secret/credential pattern is removed regardless
 *      of the lists — provider transcripts must never carry operator secrets.
 * The result is a concrete env object (never `process.env` by reference).
 */
function buildRedactedEnv(base: NodeJS.ProcessEnv, policy: DispatchPolicy): NodeJS.ProcessEnv {
  const allowlist = new Set((policy.envAllowlist ?? []).map(name => name.trim()).filter(Boolean));
  const denylist = new Set((policy.envDenylist ?? []).map(name => name.trim()).filter(Boolean));
  const redacted: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (allowlist.size > 0 && !allowlist.has(name)) continue;
    if (denylist.has(name)) continue;
    if (UNSAFE_ENV_PATTERN.test(name)) continue;
    redacted[name] = value;
  }
  return redacted;
}

export type CrossHostReviewArgs = {
  storyId: string;
  /**
   * F-004: the review-only dispatch policy that authorizes and constrains the
   * codex review subprocess. Either a named policy (loaded from
   * .lattice/dispatch-policies/<name>.json) or an inline DispatchPolicy object —
   * both are accepted by checkDispatchPolicy. REQUIRED: the handler fails closed
   * (no codex spawn) when it is missing or unauthorized.
   */
  policy?: string | DispatchPolicy;
  hostAFindingsFile?: string;
  hostA?: string;
  hostB?: string;
  runId?: string;
  timeoutMinutes?: number;
} & FormatArgs;

export interface CrossHostReviewResult {
  schemaVersion: 'lattice.cross_host_review.v1';
  storyId: string;
  runId: string;
  materialDigest: string;
  storyFilesHash: string;
  hostA: {
    hostId: string;
    provider: string;
    decision: 'pass' | 'fail' | 'blocked';
    verdictId: string;
    findingCount: number;
  };
  hostB: {
    hostId: string;
    provider: string;
    decision: 'pass' | 'fail' | 'blocked';
    verdictId: string;
    findingCount: number;
    /** Present on a fail-closed synthesized verdict (no parseable / material mismatch). */
    reason?: string;
  };
  disagreement: DisagreementReport;
  jointDecision: JointDecisionResult;
  /** sha256 of the raw Codex stdout — provenance only; raw stdout is NEVER surfaced. */
  stdoutDigest: string;
  codexExitCode: number | null;
  codexTimedOut: boolean;
}

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.json === true || args?.format === 'json';
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function derivedSession(storyId: string, hostId: string): string {
  return `xhr:${storyId}:${hostId}:session`;
}

function derivedKey(storyId: string, hostId: string): string {
  return `xhr:${storyId}:${hostId}:key`;
}

function isFindingSeverity(value: unknown): value is Finding['severity'] {
  return typeof value === 'string' && (FINDING_SEVERITIES as readonly string[]).includes(value);
}

/**
 * Parse + validate the host-A (Claude) findings from a JSON file. Must be a JSON
 * array of `Finding`. Any malformed entry fails closed with a descriptive error
 * (host A is the caller-authored input; we do not silently drop its findings).
 */
function loadHostAFindings(path: string): Finding[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`cross_host_review: cannot read hostAFindingsFile "${path}": ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`cross_host_review: hostAFindingsFile "${path}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`cross_host_review: hostAFindingsFile "${path}" must contain a JSON array of Finding objects`);
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`cross_host_review: hostAFindingsFile "${path}" entry ${index} is not an object`);
    }
    const f = entry as Record<string, unknown>;
    if (!isFindingSeverity(f.severity)) {
      throw new Error(`cross_host_review: hostAFindingsFile "${path}" entry ${index} has invalid severity (expected ${FINDING_SEVERITIES.join('|')})`);
    }
    if (typeof f.title !== 'string' || typeof f.file !== 'string' || typeof f.line !== 'number'
      || typeof f.issue !== 'string' || typeof f.fix !== 'string') {
      throw new Error(`cross_host_review: hostAFindingsFile "${path}" entry ${index} is missing required Finding fields (title/file/line/issue/fix)`);
    }
    return {
      severity: f.severity,
      title: f.title,
      file: f.file,
      line: f.line,
      issue: f.issue,
      fix: f.fix,
    };
  });
}

function deriveValidationDigest(storyId: string, materialDigest: string, storyFilesHash: string, headHash?: string): string {
  return canonicalDigest({
    schemaVersion: 'lattice.cross_host_review.validation_digest.v1',
    storyId,
    headHash,
    materialDigest,
    storyFilesHash,
  });
}

function derivePromptDigest(
  storyId: string,
  host: { hostId: string; provider: string; sessionId: string; keyId: string },
  materialDigest: string,
  storyFilesHash: string,
): string {
  return canonicalDigest({
    schemaVersion: 'lattice.cross_host_review.prompt_digest.v1',
    purpose: 'local crypto-deferred automatic cross-host adversarial review',
    storyId,
    hostId: host.hostId,
    provider: host.provider,
    sessionId: host.sessionId,
    keyId: host.keyId,
    materialDigest,
    storyFilesHash,
  });
}

function formatResult(result: CrossHostReviewResult): string {
  return [
    `Cross-host review (${result.schemaVersion})`,
    `storyId: ${result.storyId}`,
    `runId: ${result.runId}`,
    `materialDigest: ${result.materialDigest}`,
    `storyFilesHash: ${result.storyFilesHash}`,
    `hostA: ${result.hostA.provider}/${result.hostA.hostId} decision=${result.hostA.decision} findings=${result.hostA.findingCount}`,
    `hostB: ${result.hostB.provider}/${result.hostB.hostId} decision=${result.hostB.decision} findings=${result.hostB.findingCount}${result.hostB.reason ? ` reason=${result.hostB.reason}` : ''}`,
    `disagreement: ${result.disagreement.hasDisagreement} (onlyHostA=${result.disagreement.onlyHostA.length}, onlyHostB=${result.disagreement.onlyHostB.length}, agreed=${result.disagreement.agreed.length})`,
    `jointDecision: ${result.jointDecision.jointDecision}${result.jointDecision.blockedReason ? ` — ${result.jointDecision.blockedReason}` : ''}`,
    `stdoutDigest: ${result.stdoutDigest}`,
    `codexExitCode: ${result.codexExitCode}`,
    `codexTimedOut: ${result.codexTimedOut}`,
    'admissibilityStatus: local-cross-host-review-recorded',
    'evidenceScope: local-cross-host-review',
  ].join('\n');
}

/**
 * F-004: load + ENFORCE the review-only dispatch policy that authorizes the codex
 * review subprocess. Accepts a named policy (loaded from disk by checkDispatchPolicy)
 * or an inline DispatchPolicy. FAIL-CLOSED — throws (so no codex leaf is ever
 * spawned) when:
 *   - no policy is supplied;
 *   - the policy does not exist / is malformed / is otherwise refused;
 *   - the policy does not grant allowReviewOnlyRealHostSubprocess for a codex host
 *     (i.e. it does not actually authorize an independent read-only codex reviewer).
 * Returns the normalized authorized policy so its env/timeout constraints can be
 * applied to the spawn.
 */
function authorizeReviewPolicy(root: string, policy: string | DispatchPolicy | undefined): DispatchPolicy {
  if (policy === undefined || (typeof policy === 'string' && policy.trim() === '')) {
    throw new Error(
      'cross_host_review: a review-only dispatch policy is required to spawn the codex review subprocess; '
      + 'refusing to run an unconstrained subprocess (fail-closed). Pass --policy=<name> or an inline policy '
      + 'that grants allowReviewOnlyRealHostSubprocess for a codex host.',
    );
  }
  const check = checkDispatchPolicy(root, policy);
  if (!check.authorized) {
    throw new Error(
      `cross_host_review: dispatch policy "${check.policy}" is not authorized (${check.status}); `
      + `refusing to spawn the codex review subprocess. reasons: ${check.reasons.join('; ') || '(none)'}`,
    );
  }
  const authorized = check.normalizedPolicy;
  const grantsReviewOnlyCodex = authorized.allowReviewOnlyRealHostSubprocess === true
    && (authorized.allowedHosts ?? []).includes('codex');
  if (!grantsReviewOnlyCodex) {
    throw new Error(
      `cross_host_review: dispatch policy "${authorized.policy}" does not grant a read-only codex reviewer `
      + '(requires allowReviewOnlyRealHostSubprocess=true AND codex in allowedHosts); '
      + 'refusing to spawn the codex review subprocess (fail-closed).',
    );
  }
  return authorized;
}

export interface CreateCrossHostReviewHandlersOptions {
  /** Injectable Codex process seam so the smoke can pass a fake (no real CLI). */
  codexRunner?: CodexReviewRunner;
}

export function createCrossHostReviewHandlers(
  ctx: HandlerContext,
  options: CreateCrossHostReviewHandlersOptions = {},
) {
  return {
    async cross_host_review(args: CrossHostReviewArgs): Promise<CrossHostReviewResult | string> {
      const storyId = normalizeString(args.storyId);
      if (!storyId) throw new Error('cross_host_review: storyId is required');
      if (!isCanonicalStoryId(storyId)) {
        throw new Error(`cross_host_review: storyId "${storyId}" is not a canonical, path-safe Proofbound story id`);
      }

      const workspace = resolveStoryCommandWorkspace(ctx.store, storyId, ctx.root);
      const projectRoot = workspace.signedWorkspaceRoot;
      const metadataRoot = workspace.metadataRoot || ctx.root;

      const materialDigest = currentMaterialHash(projectRoot, 'HEAD', metadataRoot);
      if (!materialDigest) {
        throw new Error('cross_host_review: cannot compute current materialHash; refusing to record verdicts with an empty materialDigest');
      }
      const storyFilesHash = currentStoryFilesHash(projectRoot, 'HEAD', metadataRoot);
      if (!storyFilesHash) {
        throw new Error('cross_host_review: cannot compute current storyFilesHash; refusing to record verdicts without the story-owned file hash');
      }
      const headHash = currentGitHead(projectRoot);

      // F-004: authorize + load the review-only dispatch policy BEFORE anything
      // spawns. Fail-closed: on a missing / unauthorized / non-review-granting
      // policy this throws and NO codex subprocess is ever started, and no verdict
      // is recorded.
      const reviewPolicy = authorizeReviewPolicy(metadataRoot, args.policy);

      const hostAFindings: Finding[] = args.hostAFindingsFile
        ? loadHostAFindings(normalizeString(args.hostAFindingsFile))
        : [];

      // F-004: the effective runtime bound is the SMALLER of the caller-requested
      // timeout and the policy's maxRuntimeMinutes ceiling — the policy can only
      // TIGHTEN, never widen, the bound.
      const requestedMinutes = typeof args.timeoutMinutes === 'number' && args.timeoutMinutes > 0
        ? args.timeoutMinutes
        : DEFAULT_TIMEOUT_MINUTES;
      const policyMaxMinutes = typeof reviewPolicy.maxRuntimeMinutes === 'number' && reviewPolicy.maxRuntimeMinutes > 0
        ? reviewPolicy.maxRuntimeMinutes
        : requestedMinutes;
      const timeoutMinutes = Math.min(requestedMinutes, policyMaxMinutes);

      // F-004: the codex subprocess only sees a redacted env honoring the policy's
      // allowlist/denylist (and never operator secrets).
      const redactedEnv = buildRedactedEnv(process.env, reviewPolicy);

      // Host B (Codex): auto-run the read-only review leaf against the SAME
      // worktree so its embedded materialHash matches the computed digest.
      const leaf = await runCodexReviewLeaf(
        {
          storyId,
          storyWorktree: projectRoot,
          materialHash: materialDigest,
          hostAFindings,
          timeoutMs: timeoutMinutes * 60 * 1000,
          env: redactedEnv,
        },
        options.codexRunner,
      );
      const hostBVerdict: CodexReviewVerdict = leaf.hostBVerdict;

      const runId = normalizeString(args.runId) || `${storyId}-xhr-r1`;
      const validationDigest = deriveValidationDigest(storyId, materialDigest, storyFilesHash, headHash);

      // Independent host identities (distinct hostId/sessionId/keyId) so the two
      // verdicts never collapse in groupByIndependentHost (verdicts.ts).
      const hostAId = normalizeString(args.hostA) || 'claude-host-a';
      const hostBId = normalizeString(args.hostB) || 'codex-host-b';
      const hostAIdentity = {
        hostId: hostAId,
        provider: 'claude',
        sessionId: derivedSession(storyId, hostAId),
        keyId: derivedKey(storyId, hostAId),
      };
      const hostBIdentity = {
        hostId: hostBId,
        provider: 'codex',
        sessionId: derivedSession(storyId, hostBId),
        keyId: derivedKey(storyId, hostBId),
      };

      // Host A decision: derived from the caller-authored findings. Any
      // BLOCKER/MAJOR finding is a fail; otherwise pass. Host A is a review
      // conclusion the caller already reached, not a spawned second agent.
      const hostADecision: 'pass' | 'fail' = hostAFindings.some(
        f => f.severity === 'BLOCKER' || f.severity === 'MAJOR',
      ) ? 'fail' : 'pass';

      const hostAVerdictRecord = submitLocalVerdict(ctx, 'local', {
        storyId,
        runId,
        hostId: hostAIdentity.hostId,
        provider: hostAIdentity.provider,
        sessionId: hostAIdentity.sessionId,
        keyId: hostAIdentity.keyId,
        decision: hostADecision,
        materialDigest,
        storyFilesHash,
        validationDigest,
        promptDigest: derivePromptDigest(storyId, hostAIdentity, materialDigest, storyFilesHash),
        note: 'cross_host_review host A (Claude) verdict from caller-authored findings',
      });

      const hostBVerdictRecord = submitLocalVerdict(ctx, 'local', {
        storyId,
        runId,
        hostId: hostBIdentity.hostId,
        provider: hostBIdentity.provider,
        sessionId: hostBIdentity.sessionId,
        keyId: hostBIdentity.keyId,
        decision: hostBVerdict.decision,
        materialDigest,
        storyFilesHash,
        validationDigest,
        promptDigest: derivePromptDigest(storyId, hostBIdentity, materialDigest, storyFilesHash),
        note: `cross_host_review host B (Codex) verdict, stdoutDigest=${leaf.stdoutDigest}`,
      });

      const disagreement = diffFindings(hostAFindings, hostBVerdict.findings);
      // F-005: bind the joint decision to both hosts' material state so the
      // divergence guard is LIVE in production — a joint PASS can never be
      // asserted across two divergent code states. Host A reviewed the
      // orchestrator-computed materialDigest; host B's verdict carries its own
      // materialHash (already fail-closed-validated against materialDigest by the
      // leaf, so a genuine mismatch has already blocked host B upstream).
      const joint = jointDecision(hostADecision, hostBVerdict.decision, disagreement, {
        hostAMaterialHash: materialDigest,
        hostBMaterialHash: hostBVerdict.materialHash,
      });

      const result: CrossHostReviewResult = {
        schemaVersion: 'lattice.cross_host_review.v1',
        storyId,
        runId,
        materialDigest,
        storyFilesHash,
        hostA: {
          hostId: hostAIdentity.hostId,
          provider: hostAIdentity.provider,
          decision: hostADecision,
          verdictId: hostAVerdictRecord.verdictId,
          findingCount: hostAFindings.length,
        },
        hostB: {
          hostId: hostBIdentity.hostId,
          provider: hostBIdentity.provider,
          decision: hostBVerdict.decision,
          verdictId: hostBVerdictRecord.verdictId,
          findingCount: hostBVerdict.findings.length,
          ...(hostBVerdict.reason ? { reason: hostBVerdict.reason } : {}),
        },
        disagreement,
        jointDecision: joint,
        stdoutDigest: leaf.stdoutDigest,
        codexExitCode: leaf.exitCode,
        codexTimedOut: leaf.timedOut,
      };
      return wantsJson(args) ? result : formatResult(result);
    },
  };
}
