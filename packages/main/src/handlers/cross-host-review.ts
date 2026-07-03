import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { HandlerContext } from './context.js';
import { resolveStoryCommandWorkspace } from './context.js';
import { submitLocalVerdict, type FormatArgs } from './verdict.js';
import { canonicalDigest } from '../core/authority-signing.js';
import {
  currentGitHead,
  currentMaterialHash,
  currentStoryFilesHash,
  GIT_TREE_OUTPUT_MAX_BUFFER,
} from '../core/evidence-freshness.js';
import { LATTICE_DIR } from '../core/lattice-paths.js';
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

/** Fail-closed reason: the worktree carries uncommitted MATERIAL (source) state, so the HEAD materialHash cannot honestly bind a review Codex runs against the LIVE tree. */
export const CROSS_HOST_REVIEW_DIRTY_WORKTREE = 'cross_host_review_dirty_worktree' as const;

/**
 * Integrity preflight (host-B escalation-lane fix): FAIL CLOSED before any codex
 * spawn when the worktree has uncommitted MATERIAL (source) drift versus HEAD.
 *
 * WHY: the recorded verdict is bound to `currentMaterialHash(root,'HEAD',...)`,
 * which hashes the COMMITTED tree (`git ls-tree HEAD`). But the Codex review leaf
 * runs `codex exec -C <worktree>` against the LIVE worktree. If the worktree has
 * uncommitted modifications to tracked files OR untracked files that Codex would
 * see, Codex reviews a DIFFERENT tree than the HEAD materialHash the verdict is
 * bound to — so a `pass` bound to HEAD could reflect a review of uncommitted code
 * that is later discarded. Throwing here guarantees HEAD === the tree Codex
 * reviews (modulo `.lattice/` metadata Codex never reads), so the bound
 * materialHash is HONEST. This matches the repo's "commit before review"
 * discipline.
 *
 * `.lattice/` EXCLUSION: the story's own Lattice metadata dir churns constantly
 * DURING a story (activity log, locks, the story's own test-evidence/checklist),
 * and Codex reviews SOURCE, not story bookkeeping — so any path under `.lattice/`
 * is dropped from the material set. Everything else that git reports (tracked
 * modifications + untracked files via `--untracked-files=all`) counts as material
 * drift.
 *
 * NOTE ON `currentMaterialHash`: it has no clean working-tree hash mode — it only
 * hashes a git ref via `git ls-tree -r <ref>` (the committed tree), so it cannot
 * be repointed at the live worktree. The fail-closed dirty preflight is therefore
 * the correct fix: keep the honest committed-tree hash and refuse to bind it to a
 * review of a dirty tree.
 */
function assertMaterialCleanForReview(gitCwd: string): void {
  let raw: string;
  try {
    raw = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: GIT_TREE_OUTPUT_MAX_BUFFER,
    }).trim();
  } catch (err) {
    // Fail closed: if we cannot even determine the worktree state, we cannot
    // assert HEAD honestly binds the reviewed tree.
    throw new Error(
      `cross_host_review: ${CROSS_HOST_REVIEW_DIRTY_WORKTREE} — cannot inspect worktree state to confirm it matches HEAD `
      + `(${err instanceof Error ? err.message : String(err)}); refusing to spawn the codex review subprocess.`,
    );
  }
  if (!raw) return;
  const latticePrefix = `${LATTICE_DIR}/`; // e.g. ".lattice/"
  const material: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.length < 4) continue;
    // Porcelain v1: "XY <path>" or "XY <old> -> <new>" for renames.
    const pathText = line.slice(3).trim();
    const paths = pathText.includes(' -> ')
      ? pathText.split(' -> ').map(p => p.trim().replace(/^"|"$/g, ''))
      : [pathText.replace(/^"|"$/g, '')];
    for (const path of paths) {
      const normalized = path.replace(/\\/g, '/');
      if (!normalized) continue;
      // Drop the story's own Lattice metadata dir — Codex reviews source, not
      // story bookkeeping, and `.lattice/` churns constantly during a story.
      if (normalized === LATTICE_DIR || normalized.startsWith(latticePrefix)) continue;
      material.push(normalized);
    }
  }
  if (material.length > 0) {
    const sample = [...new Set(material)].sort().slice(0, 5).join(', ');
    throw new Error(
      `cross_host_review: ${CROSS_HOST_REVIEW_DIRTY_WORKTREE} — the worktree has uncommitted MATERIAL (source) changes `
      + `versus HEAD (${sample}${material.length > 5 ? ', …' : ''}). Codex reviews the LIVE worktree, but the recorded `
      + `verdict binds to the HEAD materialHash (the committed tree), so a review of uncommitted code would be bound to a `
      + `tree it did not review. Commit or stash the source changes before cross_host_review (commit-before-review), or `
      + `exclude only .lattice/ metadata. Refusing to spawn the codex review subprocess (fail-closed).`,
    );
  }
}

/**
 * Env-var names that must NEVER be forwarded to the review subprocess. Kept
 * deliberately broad (F-007): beyond the obvious secret words it also catches
 * credential-bearing connection strings (DATABASE/DSN/CONNECTION), auth/session
 * material (AUTH/SESSION/COOKIE/PRIVATE/ACCESS), and any *_URL/_URI (which routinely
 * embed inline credentials, e.g. DATABASE_URL). A read-only code reviewer never
 * needs these, so stripping them by default is safe.
 *
 * ROLE (post allowlist-by-default): this is now a SECONDARY belt-and-suspenders
 * filter applied even to names an operator explicitly allowlisted — so an operator
 * cannot accidentally allowlist a secret. The PRIMARY defense against unknown
 * credential env vars is the minimal safe base set below: an unknown credential
 * (POSTGRES_URL_NON_POOLING, GITHUB_PAT, CI_JOB_JWT, HTTPS_PROXY, …) is dropped
 * because it is NOT in the base set, not because it matched a pattern. That closes
 * the entire env-leak class a denylist could never fully enumerate.
 */
const UNSAFE_ENV_PATTERN = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|(^|_)KEY|AUTH|SESSION|COOKIE|PRIVATE|ACCESS|DATABASE|(^|_)DSN|CONNECTION|URL|URI/i;

/**
 * The MINIMAL SAFE BASE set a CLI subprocess needs to run correctly (locale,
 * paths, tty geometry, temp dirs, identity). This is an ALLOWLIST-BY-DEFAULT: only
 * these names (plus the LC_* locale prefix, plus the policy's explicit
 * `envAllowlist`) are ever forwarded. Everything else — including any unknown
 * credential-bearing env var — is dropped BY DEFAULT because it is not in this set,
 * closing the env-leak class at the root (no denylist to keep chasing). None of
 * these carry secrets; PWD/TMPDIR/etc. are paths, not credentials.
 */
const SAFE_BASE_ENV_NAMES = new Set<string>([
  'PATH',
  'HOME',
  'SHELL',
  'TERM',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USER',
  'LOGNAME',
  'PWD',
  'COLUMNS',
  'LINES',
  'TZ',
]);

/** LC_* locale vars (LC_CTYPE, LC_MESSAGES, LC_NUMERIC, …) are part of the safe base. */
const SAFE_BASE_ENV_PREFIXES = ['LC_'];

/** True when `name` belongs to the hardcoded minimal safe base set (exact or LC_* prefix). */
function isSafeBaseEnvName(name: string): boolean {
  if (SAFE_BASE_ENV_NAMES.has(name)) return true;
  return SAFE_BASE_ENV_PREFIXES.some(prefix => name.startsWith(prefix));
}

/**
 * F-004/F-007: build the redacted env the review-only codex subprocess is allowed
 * to see, from the base process env and the authorized policy. ALLOWLIST-BY-DEFAULT
 * (root fix — replaces the earlier denylist-only F-007 semantics):
 *   1. A name is forwardable ONLY if it is in the UNION of (a) the hardcoded minimal
 *      SAFE_BASE_ENV set a CLI needs (PATH/HOME/locale/tmp/tty/identity, plus LC_*)
 *      and (b) the policy's explicit `envAllowlist`. Every other name is DROPPED by
 *      default — an unknown credential env var never leaks, because it is not on the
 *      allowlist (not because a denylist happened to name it).
 *   2. The policy `envDenylist` still removes any listed name (an operator can prune
 *      a base var they do not want forwarded).
 *   3. The broad UNSAFE_ENV_PATTERN is applied as a SECONDARY belt-and-suspenders
 *      filter EVEN to allowlisted names — so an operator cannot accidentally
 *      allowlist a secret (checkDispatchPolicy also forbids secret names in
 *      envAllowlist; this is defense in depth).
 *
 * NOTE ON EMPTY POLICY ALLOWLIST: an empty `envAllowlist` (the default) now means
 * "minimal safe base set only" — NOT "forward everything minus a denylist". A policy
 * that needs an extra var (e.g. a proxy or a build cache dir) MUST list it in
 * envAllowlist; it will still be dropped if it hits the secret pattern.
 *
 * The result is a concrete env object (never `process.env` by reference).
 *
 * Exported for the smoke's direct belt-and-suspenders assertion: the handler's
 * upstream checkDispatchPolicy REFUSES a policy that allowlists a secret name, so
 * the "operator accidentally allowlisted a secret" defense-in-depth layer can only
 * be exercised by calling this directly with such a (never-authorized) policy.
 */
export function buildRedactedEnv(base: NodeJS.ProcessEnv, policy: DispatchPolicy): NodeJS.ProcessEnv {
  const allowlist = new Set((policy.envAllowlist ?? []).map(name => name.trim()).filter(Boolean));
  const denylist = new Set((policy.envDenylist ?? []).map(name => name.trim()).filter(Boolean));
  const redacted: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    // (1) Allowlist-by-default: forward ONLY the safe base set ∪ the policy allowlist.
    if (!isSafeBaseEnvName(name) && !allowlist.has(name)) continue;
    // (2) An explicit denylist can prune even a base/allowlisted var.
    if (denylist.has(name)) continue;
    // (3) Belt-and-suspenders: never forward a secret-looking name, even if allowlisted.
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

      // Integrity preflight (host-B escalation-lane fix): FAIL CLOSED before any
      // codex spawn if the worktree has uncommitted MATERIAL (source) drift versus
      // HEAD. Codex reviews the LIVE worktree (codex exec -C <worktree>), but the
      // recorded verdict binds to the HEAD materialHash (the committed tree). A
      // dirty tree would make Codex review code the HEAD materialHash does not
      // describe, so the bound hash would be dishonest. `.lattice/` metadata is
      // excluded (Codex never reads story bookkeeping, and it churns constantly).
      assertMaterialCleanForReview(projectRoot);

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
