import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
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
  type CodexReviewLeafResult,
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

/** Fail-closed reason: the worktree carries uncommitted MATERIAL (source) state, so the HEAD materialHash cannot honestly bind a review result. */
export const CROSS_HOST_REVIEW_DIRTY_WORKTREE = 'cross_host_review_dirty_worktree' as const;
/** Fail-closed reason: the committed HEAD moved after the review binding was computed, so the verdict would bind to a stale commit. */
export const CROSS_HOST_REVIEW_HEAD_DRIFT = 'cross_host_review_head_drift' as const;

/**
 * Integrity preflight (host-B escalation-lane fix): FAIL CLOSED before any codex
 * spawn when the worktree has uncommitted MATERIAL (source) drift versus HEAD.
 *
 * WHY: the recorded verdict is bound to `currentMaterialHash(root,'HEAD',...)`,
 * which hashes the COMMITTED tree (`git ls-tree HEAD`). Codex reviews a detached
 * snapshot of that committed tree, so the live worktree must not contain material
 * source edits that are outside the captured commit. Throwing here guarantees the
 * operator's source state is exactly the captured HEAD tree (modulo `.lattice/`
 * metadata Codex never reads), so the bound materialHash is HONEST. This matches
 * the repo's "commit before review" discipline.
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
      + `versus HEAD (${sample}${material.length > 5 ? ', …' : ''}). Codex reviews a detached snapshot of HEAD, and the `
      + `recorded verdict binds to that HEAD materialHash (the committed tree), so uncommitted source state would make the `
      + `operator-facing review result misleading. Commit or stash the source changes before cross_host_review (commit-before-review), or `
      + `exclude only .lattice/ metadata. Refusing to spawn the codex review subprocess (fail-closed).`,
    );
  }
}

/**
 * The MINIMAL SAFE BASE set a CLI subprocess needs to run correctly (locale,
 * paths, tty geometry, temp dirs, identity). This is a CLOSED ALLOWLIST: ONLY these
 * exact names (plus the exact standard POSIX locale categories in SAFE_LC_ENV_NAMES)
 * are ever forwarded to the review subprocess. Everything else — including any
 * unknown credential-bearing env var (GITHUB_PAT, CI_JOB_JWT, HTTP(S)_PROXY,
 * ALL_PROXY, DATABASE_URL, …) — is dropped BY DEFAULT because it is not in this set,
 * closing the env-leak class at the root by construction (no denylist to keep
 * chasing, and the policy's `envAllowlist` cannot inject any additional var into the
 * review spawn). None of these carry secrets; PWD/TMPDIR/etc. are paths, not
 * credentials.
 */
const SAFE_BASE_ENV_NAMES = new Set<string>([
  'PATH',
  'HOME',
  'SHELL',
  'TERM',
  'LANG',
  'LANGUAGE',
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

/**
 * Bug13 (HIGH — LC_* prefix smuggling): the standard POSIX locale-category env
 * vars, as an EXACT allowlist. The earlier `SAFE_BASE_ENV_PREFIXES = ['LC_']`
 * blanket prefix forwarded ANY `LC_*` name, so a maliciously-named `LC_TOKEN` /
 * `LC_SECRET` / `LC_CREDENTIAL` would have reached the Codex subprocess. Replacing
 * the wildcard with this exact set of the standard locale categories (POSIX +
 * common glibc extensions) means only genuine locale vars are forwarded; any other
 * `LC_*` name (e.g. `LC_SECRET`) is not a known locale category and is dropped.
 */
const SAFE_LC_ENV_NAMES = new Set<string>([
  'LC_ALL',
  'LC_CTYPE',
  'LC_NUMERIC',
  'LC_TIME',
  'LC_COLLATE',
  'LC_MONETARY',
  'LC_MESSAGES',
  'LC_PAPER',
  'LC_NAME',
  'LC_ADDRESS',
  'LC_TELEPHONE',
  'LC_MEASUREMENT',
  'LC_IDENTIFICATION',
]);

/**
 * True when `name` belongs to the hardcoded minimal safe base set: an EXACT member
 * of SAFE_BASE_ENV_NAMES OR an EXACT standard POSIX locale category in
 * SAFE_LC_ENV_NAMES. There is NO wildcard prefix (Bug13 fix): an arbitrary `LC_*`
 * name that is not a known locale category (e.g. `LC_SECRET`, `LC_TOKEN`) is NOT a
 * safe base var and is dropped.
 */
function isSafeBaseEnvName(name: string): boolean {
  return SAFE_BASE_ENV_NAMES.has(name) || SAFE_LC_ENV_NAMES.has(name);
}

/**
 * F-004: build the redacted env the review-only codex subprocess is allowed to see,
 * from the base process env and the authorized policy. CLOSED-ALLOWLIST BY
 * CONSTRUCTION (root fix — closes the credential-leak class the earlier
 * denylist/allowlist-injection semantics kept re-opening):
 *   1. A name is forwarded ONLY if `isSafeBaseEnvName(name)` is true — i.e. it is in
 *      the hardcoded minimal SAFE_BASE_ENV set a CLI needs (PATH/HOME/locale/tmp/tty/
 *      identity, plus exact standard LC_* locale categories). Every other name is DROPPED. An unknown
 *      credential env var (GITHUB_PAT / CI_JOB_JWT / HTTP(S)_PROXY / ALL_PROXY /
 *      DATABASE_URL / …) never leaks — not because a denylist happened to name it,
 *      but because it is not a base var and nothing else is ever forwarded.
 *   2. The policy `envDenylist` can then further RESTRICT the base set — an operator
 *      may DROP a base var they do not want forwarded (e.g. deny PATH). It can only
 *      remove, never add.
 *
 * The policy's `envAllowlist` is intentionally NOT applied to the review spawn: a
 * read-only code reviewer needs no operator-specific/credential env, so an explicit
 * allowlist can no longer inject ANY var into the review subprocess. This closes the
 * credential-leak class BY CONSTRUCTION — there is no denylist left to be incomplete,
 * because no non-base var is ever forwarded regardless of what an operator lists.
 *
 * NOTE ON THE POLICY: `envAllowlist` is unused HERE by design, but the rest of the
 * policy (authorization + the finite-timeout ceiling) is still loaded, authorized,
 * and enforced by authorizeReviewPolicy — only env-allowlist injection into the
 * review spawn is dropped.
 *
 * The result is a concrete env object (never `process.env` by reference).
 */
export function buildRedactedEnv(base: NodeJS.ProcessEnv, policy: DispatchPolicy): NodeJS.ProcessEnv {
  const denylist = new Set((policy.envDenylist ?? []).map(name => name.trim()).filter(Boolean));
  const redacted: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    // (1) Closed allowlist by construction: forward ONLY the hardcoded safe base set.
    // The policy envAllowlist is intentionally NOT consulted — no operator entry can
    // inject a credential/arbitrary var into the review spawn.
    if (!isSafeBaseEnvName(name)) continue;
    // (2) An explicit denylist can restrict (drop) a base var.
    if (denylist.has(name)) continue;
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

interface CrossHostIdentity {
  hostId: string;
  provider: 'claude' | 'codex';
  sessionId: string;
  keyId: string;
}

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

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}

function derivedSession(storyId: string, hostId: string): string {
  return `xhr:${storyId}:${hostId}:session`;
}

function derivedKey(storyId: string, hostId: string): string {
  return `xhr:${storyId}:${hostId}:key`;
}

function assertHostIndependence(hostA: CrossHostIdentity, hostB: CrossHostIdentity): void {
  const shared: string[] = [];
  if (normalizeIdentity(hostA.hostId) === normalizeIdentity(hostB.hostId)) shared.push('hostId');
  if (normalizeIdentity(hostA.sessionId) === normalizeIdentity(hostB.sessionId)) shared.push('sessionId');
  if (normalizeIdentity(hostA.keyId) === normalizeIdentity(hostB.keyId)) shared.push('keyId');
  if (shared.length > 0) {
    throw new Error(
      `cross_host_review: hostA and hostB must be independent; shared ${shared.join(', ')} would collapse the cross-host proof surface`,
    );
  }
}

function assertReviewHeadStillCurrent(gitCwd: string, expectedHeadHash: string): void {
  const currentHead = currentGitHead(gitCwd);
  if (currentHead !== expectedHeadHash) {
    throw new Error(
      `cross_host_review: ${CROSS_HOST_REVIEW_HEAD_DRIFT} — HEAD changed from ${expectedHeadHash} to ${currentHead ?? 'unknown'} `
      + 'after the review binding was computed; refusing to record a verdict bound to a stale committed tree (fail-closed).',
    );
  }
}

function createCleanHeadReviewWorktree(projectRoot: string, headHash: string): { worktree: string; cleanup: () => void } {
  const parent = mkdtempSync(join(tmpdir(), 'lattice-xhr-review-'));
  const worktree = join(parent, 'worktree');
  try {
    execFileSync('git', ['worktree', 'add', '--detach', worktree, headHash], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: GIT_TREE_OUTPUT_MAX_BUFFER,
    });
  } catch (err) {
    rmSync(parent, { recursive: true, force: true });
    throw new Error(
      `cross_host_review: cannot create a clean HEAD review snapshot for codex at ${headHash} (${err instanceof Error ? err.message : String(err)}); `
      + 'refusing to review the mutable live worktree (fail-closed).',
    );
  }

  const cleanup = (): void => {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktree], {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: GIT_TREE_OUTPUT_MAX_BUFFER,
      });
    } catch {
      // Fall back to filesystem cleanup; git worktree prune can clean any leftover metadata.
    }
    rmSync(parent, { recursive: true, force: true });
  };
  return { worktree, cleanup };
}

/**
 * STRICT Finding schema (sweep hardening). `.strict()` REJECTS unknown keys — the
 * host-A findings file is untrusted caller-supplied input, so an extra/contradictory
 * key (or a missing required field, or a wrong-typed field) must FAIL CLOSED, not be
 * silently dropped. Mirrors the frozen `Finding` shape (adversarial-review.ts).
 */
const hostAFindingSchema = z.object({
  severity: z.enum(FINDING_SEVERITIES),
  title: z.string(),
  file: z.string(),
  line: z.number(),
  issue: z.string(),
  fix: z.string(),
}).strict();

/** A JSON array of strict Finding objects. */
const hostAFindingsSchema = z.array(hostAFindingSchema);

/**
 * Parse + STRICTLY validate the host-A (Claude) findings from a JSON file. Must be a
 * JSON array of `Finding` with EXACTLY the frozen fields — no missing, no extra, no
 * wrong-typed keys. Any deviation fails closed with a descriptive error (host A is
 * caller-authored, untrusted input; we neither silently drop its findings nor trust
 * `JSON.parse` output that merely happens to carry the required fields).
 *
 * Sweep hardening: replaces the earlier hand-rolled per-field checks (which accepted
 * and silently dropped EXTRA keys) with a strict Zod array — closing the same
 * unknown-key trust-boundary gap fixed for the codex verdict schema.
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
  const result = hostAFindingsSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
    throw new Error(
      `cross_host_review: hostAFindingsFile "${path}" is not a strict array of Finding objects`
      + `${where}: ${issue ? issue.message : 'invalid'} `
      + `(each entry must have EXACTLY severity/title/file/line/issue/fix — no missing, extra, or wrong-typed keys)`,
    );
  }
  return result.data;
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
  // Bug10 (defense-in-depth): the runtime ceiling MUST be a real, finite, positive
  // number. checkDispatchPolicy now refuses a malformed record upstream (so a string
  // maxRuntimeMinutes never reaches here), but we re-assert it directly rather than
  // trusting the type: a non-number ceiling would otherwise be silently discarded by
  // the timeout computation and codex would run with the caller timeout instead of
  // the intended bound. Fail closed rather than spawn without an enforced ceiling.
  // Bug10 (defense-in-depth): the runtime ceiling MUST be a real, finite, positive
  // number. checkDispatchPolicy now refuses a malformed record upstream (so a string
  // maxRuntimeMinutes never reaches here), but we re-assert it directly rather than
  // trusting the type: a non-number ceiling would otherwise be silently discarded by
  // the timeout computation and codex would run with the caller timeout instead of
  // the intended bound. Fail closed rather than spawn without an enforced ceiling.
  if (typeof authorized.maxRuntimeMinutes !== 'number'
    || !Number.isFinite(authorized.maxRuntimeMinutes)
    || authorized.maxRuntimeMinutes <= 0) {
    throw new Error(
      `cross_host_review: dispatch policy "${authorized.policy}" has a malformed maxRuntimeMinutes ceiling `
      + `(${JSON.stringify(authorized.maxRuntimeMinutes)}); refusing to spawn the codex review subprocess without a `
      + 'valid runtime bound (fail-closed).',
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
      if (!headHash) {
        throw new Error('cross_host_review: cannot resolve current HEAD; refusing to record verdicts without a committed-tree binding');
      }

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
      // Bug10: the ceiling is trusted to be a real positive number here ONLY because
      // authorizeReviewPolicy already fail-closed-verified it (and checkDispatchPolicy
      // refused a malformed record upstream). We therefore use it DIRECTLY — no silent
      // `? ceiling : requestedMinutes` fallback that would let a non-number widen the
      // bound to the caller timeout. Re-assert as a final invariant to fail closed
      // rather than spawn without an enforced ceiling.
      // Bug10: the ceiling is trusted to be a real positive number here ONLY because
      // authorizeReviewPolicy already fail-closed-verified it (and checkDispatchPolicy
      // refused a malformed record upstream). We therefore use it DIRECTLY — no silent
      // `? ceiling : requestedMinutes` fallback that would let a non-number widen the
      // bound to the caller timeout. Re-assert as a final invariant to fail closed
      // rather than spawn without an enforced ceiling.
      const policyMaxMinutes = reviewPolicy.maxRuntimeMinutes;
      if (typeof policyMaxMinutes !== 'number' || !Number.isFinite(policyMaxMinutes) || policyMaxMinutes <= 0) {
        throw new Error(
          `cross_host_review: authorized policy "${reviewPolicy.policy}" yielded a non-numeric maxRuntimeMinutes ceiling `
          + `(${JSON.stringify(policyMaxMinutes)}); refusing to spawn the codex review subprocess without a valid runtime bound (fail-closed).`,
        );
      }
      const timeoutMinutes = Math.min(requestedMinutes, policyMaxMinutes);

      // F-004: the codex subprocess only sees a redacted env honoring the policy's
      // allowlist/denylist (and never operator secrets).
      const redactedEnv = buildRedactedEnv(process.env, reviewPolicy);

      const runId = normalizeString(args.runId) || `${storyId}-xhr-r1`;
      // Independent host identities (distinct hostId/sessionId/keyId) so the two
      // verdicts never collapse in groupByIndependentHost (verdicts.ts). F-011:
      // validate this BEFORE any Codex spawn or verdict record, so a caller cannot
      // manufacture an "independent" joint pass from the same host identity.
      const hostAId = normalizeString(args.hostA) || 'claude-host-a';
      const hostBId = normalizeString(args.hostB) || 'codex-host-b';
      const hostAIdentity: CrossHostIdentity = {
        hostId: hostAId,
        provider: 'claude',
        sessionId: derivedSession(storyId, hostAId),
        keyId: derivedKey(storyId, hostAId),
      };
      const hostBIdentity: CrossHostIdentity = {
        hostId: hostBId,
        provider: 'codex',
        sessionId: derivedSession(storyId, hostBId),
        keyId: derivedKey(storyId, hostBId),
      };
      assertHostIndependence(hostAIdentity, hostBIdentity);

      // Integrity preflight (host-B escalation-lane fix): FAIL CLOSED before any
      // codex spawn if the worktree has uncommitted MATERIAL (source) drift versus
      // HEAD. The recorded verdict binds to the HEAD materialHash (the committed
      // tree), so Codex must review a clean HEAD snapshot and the live worktree
      // must still be source-clean before we record the verdict. `.lattice/`
      // metadata is excluded (Codex never reads story bookkeeping, and it churns
      // constantly).
      assertMaterialCleanForReview(projectRoot);
      assertReviewHeadStillCurrent(projectRoot, headHash);

      // F-010: Codex must not review the mutable story worktree after the clean
      // preflight. Give it an immutable detached snapshot of the captured HEAD
      // SHA instead, then
      // re-check the original worktree before recording. A concurrent source edit
      // or clean HEAD move after the snapshot cannot influence what Codex reviewed,
      // and we refuse to bind/record the verdict if either drift is still present.
      const snapshot = createCleanHeadReviewWorktree(projectRoot, headHash);
      let leaf: CodexReviewLeafResult;
      try {
        leaf = await runCodexReviewLeaf(
          {
            storyId,
            storyWorktree: snapshot.worktree,
            materialHash: materialDigest,
            hostAFindings,
            timeoutMs: timeoutMinutes * 60 * 1000,
            env: redactedEnv,
          },
          options.codexRunner,
        );
      } finally {
        snapshot.cleanup();
      }
      assertReviewHeadStillCurrent(projectRoot, headHash);
      assertMaterialCleanForReview(projectRoot);
      const hostBVerdict: CodexReviewVerdict = leaf.hostBVerdict;

      const validationDigest = deriveValidationDigest(storyId, materialDigest, storyFilesHash, headHash);

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
