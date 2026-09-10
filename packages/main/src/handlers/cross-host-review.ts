import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { resolveManagedReviewIsolation, preflightManagedReadonlyHost } from '../core/managed-review-lane-policy.js';
import { preflightManagedProviderState } from '../core/managed-review-provider-state.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { HandlerContext } from './context.js';
import { resolveStoryCommandWorkspace } from './context.js';
import type { FormatArgs } from './verdict.js';
import { canonicalDigest } from '../core/authority-signing.js';
import { isMaterialExcludedPath } from '../core/material-path-policy.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import {
  currentGitHead,
  currentMaterialHash,
  currentStoryFilesHash,
  GIT_TREE_OUTPUT_MAX_BUFFER,
} from '../core/evidence-freshness.js';
import { PROOF_OR_STOP_DIR } from '../core/proof-or-stop-paths.js';
import { isCanonicalStoryId } from '../core/lifecycle-registry.js';
import type { Finding } from '../core/adversarial-review.js';
import { FINDING_SEVERITIES } from '../core/adversarial-review.js';
import {
  runCodexReviewLeaf,
  type CodexReviewLeafResult,
  type CodexReviewRunner,
  type CodexReviewRunnerResult,
  type CodexReviewVerdict,
} from '../core/codex-review-leaf.js';
import {
  getManagedHostRunStatus,
  cleanupManagedCrossHostReviewWorktree,
  managedHostRunReceipt,
  readManagedHostRunBinding,
  readManagedHostRunOutput,
  readManagedHostRunResult,
  runManagedHostRunWorker,
  submitManagedHostRun,
  type ManagedHostRunWorkerLauncher,
} from '../core/managed-host-run.js';
import type { HostRunRunner } from '../core/host-run.js';
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
import type { HostVerdict, VerdictDecision } from '../core/verdicts.js';
import { appendRawProcessEventBytes } from '../core/process-events.js';
import { reportHealthIssue } from '../core/health.js';

export const CROSS_HOST_REVIEW_DEFAULT_TIMEOUT_MINUTES = 12;

export function boundedCrossHostReviewTimeoutMinutes(
  requestedMinutes: number | undefined,
  policyMaxMinutes: number,
): number {
  if (typeof policyMaxMinutes !== 'number' || !Number.isFinite(policyMaxMinutes) || policyMaxMinutes <= 0) {
    throw new Error('cross_host_review: refusing to spawn without a valid maxRuntimeMinutes ceiling');
  }
  const requested = typeof requestedMinutes === 'number' && requestedMinutes > 0
    ? requestedMinutes
    : CROSS_HOST_REVIEW_DEFAULT_TIMEOUT_MINUTES;
  return Math.min(requested, policyMaxMinutes);
}

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
 * operator's source state is exactly the captured HEAD tree (modulo `.proof-or-stop/`
 * metadata Codex never reads), so the bound materialHash is HONEST. This matches
 * the repo's "commit before review" discipline.
 *
 * `.proof-or-stop/` EXCLUSION: the story's own ProofOrStop metadata dir churns constantly
 * DURING a story (activity log, locks, the story's own test-evidence/checklist),
 * and Codex reviews SOURCE, not story bookkeeping — so any path under `.proof-or-stop/`
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
// Exported for the porcelain first-row regression smoke (B-d6a0); not a CLI command.
export function assertMaterialCleanForReview(gitCwd: string): void {
  let raw: string;
  try {
    // No full-output trim(): it would strip the first porcelain row's leading
    // status space (" M path" -> "M path"), shifting the fixed-width path
    // offset so the first row's `.proof-or-stop/...` path reads as "proofOrStop/..." and
    // false-blocks the preflight on metadata-only dirt.
    raw = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: GIT_TREE_OUTPUT_MAX_BUFFER,
    });
  } catch (err) {
    // Fail closed: if we cannot even determine the worktree state, we cannot
    // assert HEAD honestly binds the reviewed tree.
    throw new Error(
      `cross_host_review: ${CROSS_HOST_REVIEW_DIRTY_WORKTREE} — cannot inspect worktree state to confirm it matches HEAD `
      + `(${err instanceof Error ? err.message : String(err)}); refusing to spawn the codex review subprocess.`,
    );
  }
  const rows = raw.split('\n').map(line => line.trimEnd()).filter(Boolean);
  if (rows.length === 0) return;
  const proofOrStopPrefix = `${PROOF_OR_STOP_DIR}/`; // e.g. ".proof-or-stop/"
  const material: string[] = [];
  for (const line of rows) {
    if (line.length < 4) continue;
    // Porcelain v1: "XY <path>" or "XY <old> -> <new>" for renames.
    const pathText = line.slice(3).trim();
    const paths = pathText.includes(' -> ')
      ? pathText.split(' -> ').map(p => p.trim().replace(/^"|"$/g, ''))
      : [pathText.replace(/^"|"$/g, '')];
    for (const path of paths) {
      const normalized = path.replace(/\\/g, '/');
      if (!normalized) continue;
      // Drop the story's own ProofOrStop metadata dir — Codex reviews source, not
      // story bookkeeping, and `.proof-or-stop/` churns constantly during a story.
      if (normalized === PROOF_OR_STOP_DIR || normalized.startsWith(proofOrStopPrefix)) continue;
      // B-137a main-merge fix: runtime artifacts (managed host-run claim/events/
      // result files) live under the state dir and are written BY this very
      // command, so a hand-rolled `.proof-or-stop/` prefix check misclassified
      // them as uncommitted SOURCE and fail-closed on the runtime's own output.
      // Defer to the canonical material policy -- the same one materialHash uses,
      // so "dirty MATERIAL" here means exactly what the recorded verdict binds to.
      if (isMaterialExcludedPath(normalized)) continue;
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
      + `exclude only .proof-or-stop/ metadata. Refusing to spawn the codex review subprocess (fail-closed).`,
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
   * .proof-or-stop/dispatch-policies/<name>.json) or an inline DispatchPolicy object —
   * both are accepted by checkDispatchPolicy. REQUIRED: the handler fails closed
   * (no codex spawn) when it is missing or unauthorized.
   */
  policy?: string | DispatchPolicy;
  hostAFindingsFile?: string;
  hostA?: string;
  hostB?: string;
  runId?: string;
  timeoutMinutes?: number;
  /** Resume/consume an already submitted cross-host ManagedHostRun; never spawns a replacement. */
  managedRunId?: string;
  /** Submit the managed Codex leaf and return its runId without consuming a verdict. */
  detach?: boolean;
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
    /** TRUE finding count (uncapped) — may exceed `findings.length` when the persisted array was capped. */
    findingCount: number;
    /** B-dc2e CHK-004: the SAME bounded array persisted in the verdict artifact (never raw stdout). */
    findings: PersistedReviewFinding[];
  };
  hostB: {
    hostId: string;
    provider: string;
    decision: 'pass' | 'fail' | 'blocked';
    verdictId: string;
    /** TRUE finding count (uncapped) — may exceed `findings.length` when the persisted array was capped. */
    findingCount: number;
    /** B-dc2e CHK-004: the SAME bounded array persisted in the verdict artifact (never raw stdout). */
    findings: PersistedReviewFinding[];
    /** Present on a fail-closed synthesized verdict (no parseable / material mismatch). */
    reason?: string;
  };
  disagreement: DisagreementReport;
  jointDecision: JointDecisionResult;
  /** sha256 of the raw Codex stdout — provenance only; raw stdout is NEVER surfaced. */
  stdoutDigest: string;
  codexExitCode: number | null;
  codexTimedOut: boolean;
  managedRunId: string;
  managedReceiptId: string;
}

export interface CrossHostReviewManagedSubmission {
  schemaVersion: 'lattice.cross_host_review_managed_submission.v1';
  storyId: string;
  managedRunId: string;
  state: string;
  deadlineAt: string;
  /** Controller-local process-event write failed after the durable run submission. Resume this exact run; do not spawn another. */
  bookkeepingError?: string;
}

class CrossHostReviewDetached extends Error {
  constructor(readonly submission: CrossHostReviewManagedSubmission) {
    super('cross_host_review managed leaf detached');
  }
}

/**
 * A durable provider submission must be returned to the operator even when
 * controller-local observability persistence fails.  This is intentionally a
 * typed internal signal rather than a string property on Error: the outer
 * handler returns the structured submission in both text and JSON modes.
 */
class CrossHostReviewSubmissionBookkeepingFailure extends Error {
  constructor(readonly submission: CrossHostReviewManagedSubmission, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`cross_host_review: managed run submitted but submission bookkeeping failed: ${message}`);
  }
}

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.json === true || args?.format === 'json';
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Best-effort project-root hash for a usage-ledger context (mirrors the host_run handler). */
function projectRootHashFor(root: string): string {
  return `sha256:${createHash('sha256').update(root, 'utf8').digest('hex')}`;
}

/**
 * B-70e9 CHK-003: resolve the honest story phase for usage attribution. Falls back to
 * 'adhoc' when the story cannot be read (never throws — attribution must not break the
 * review).
 */
function resolveStoryPhaseForUsage(ctx: HandlerContext, storyId: string): string {
  try {
    const phase = ctx.store.readStory(storyId)?.phase;
    return typeof phase === 'string' && phase.length > 0 ? phase : 'adhoc';
  } catch {
    return 'adhoc';
  }
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

function cleanupHeadReviewWorktree(gitCwd: string, worktree: string): void {
  cleanupManagedCrossHostReviewWorktree(gitCwd, worktree);
}

async function resumedManagedRunAllowsSnapshotCleanup(root: string, runId: string): Promise<boolean> {
  try {
    const { run } = await getManagedHostRunStatus({ root, runId });
    const terminal = run.terminal;
    return terminal !== null
      && terminal.replacementSafe
      && terminal.processCleanup !== null
      && terminal.processCleanup.reaped
      && !terminal.processCleanup.residualProcessGroup;
  } catch {
    // A resume refusal must never turn missing/corrupt runtime facts into
    // authority to remove a cwd which may still be owned by the provider.
    return false;
  }
}

function createCleanHeadReviewWorktree(gitCwd: string, headHash: string): { worktree: string; cleanup: () => void } {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'proof-or-stop-xhr-review-')));
  const worktree = join(parent, 'worktree');
  try {
    execFileSync('git', ['worktree', 'add', '--detach', worktree, headHash], {
      cwd: gitCwd,
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

  const cleanup = (): void => cleanupHeadReviewWorktree(gitCwd, worktree);
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
    `managedRunId: ${result.managedRunId}`,
    `managedReceiptId: ${result.managedReceiptId}`,
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
  managedRunner?: HostRunRunner;
  launchWorker?: ManagedHostRunWorkerLauncher;
  /** Internal smoke seam for adversarial git-race coverage; never exposed through the CLI. */
  afterHeadCaptured?: () => void | Promise<void>;
  /** Internal smoke seam for final write-window race coverage; never exposed through the CLI. */
  beforeVerdictRecord?: () => void | Promise<void>;
  /** Internal smoke seam for post-write cleanup coverage; never exposed through the CLI. */
  afterVerdictPairWritten?: () => void | Promise<void>;
}

/**
 * B-dc2e CHK-004: a host's PARSED review finding as persisted in the verdict
 * artifact. This is structured evidence derived from the leaf's strict-schema
 * verdict (or the caller-authored host A findings file) — NEVER raw provider
 * stdout. Only the fields below are persisted; every string is length-capped and
 * the array is count-capped (see the PERSISTED_FINDING_* constants) so a runaway
 * provider cannot bloat the artifact. `findingCount` on the record keeps the TRUE
 * count so a capped array is visible to readers.
 */
export interface PersistedReviewFinding {
  severity: Finding['severity'];
  title: string;
  file: string;
  line: number;
  /** The leaf finding's `issue` text (what is wrong + why it matters). */
  description: string;
  fix: string;
  /**
   * B-dc2e F-001: the names of the fields above that were cut to their cap, in
   * field order; empty when nothing was cut. A cut field also ENDS with
   * PERSISTED_FINDING_TRUNCATION_MARKER, so both the JSON and a bare field
   * value show that the text is incomplete rather than organically that long.
   */
  truncatedFields: PersistedFindingTextField[];
}

/** The capped text fields of a persisted finding, in persisted order. */
export type PersistedFindingTextField = 'title' | 'file' | 'description' | 'fix';

/** Max persisted findings per host verdict; extras are dropped (findingCount stays true). */
export const PERSISTED_FINDING_COUNT_CAP = 50;
/** Max chars for a persisted finding `title`. */
export const PERSISTED_FINDING_TITLE_CAP = 200;
/** Max chars for a persisted finding `file` path. */
export const PERSISTED_FINDING_FILE_CAP = 300;
/** Max chars for a persisted finding `description` and `fix`. */
export const PERSISTED_FINDING_TEXT_CAP = 1000;
/**
 * Fixed suffix every cut field ends with (B-dc2e F-001). It counts toward the
 * field's cap, so a cut field is exactly `cap` chars long and the length
 * invariant a reader can check stays true; it is applied BEFORE digesting, so
 * the verdictId binds the marked text.
 */
export const PERSISTED_FINDING_TRUNCATION_MARKER = ' ...[truncated]';

function capText(value: unknown, cap: number): { text: string; truncated: boolean } {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= cap) return { text, truncated: false };
  const keep = Math.max(0, cap - PERSISTED_FINDING_TRUNCATION_MARKER.length);
  return { text: text.slice(0, keep) + PERSISTED_FINDING_TRUNCATION_MARKER, truncated: true };
}

function capLine(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Pure: project parsed findings onto the bounded persisted shape (count + per-field caps). */
export function boundPersistedFindings(findings: readonly Finding[]): PersistedReviewFinding[] {
  return findings.slice(0, PERSISTED_FINDING_COUNT_CAP).map(finding => {
    const capped: Array<[PersistedFindingTextField, ReturnType<typeof capText>]> = [
      ['title', capText(finding.title, PERSISTED_FINDING_TITLE_CAP)],
      ['file', capText(finding.file, PERSISTED_FINDING_FILE_CAP)],
      ['description', capText(finding.issue, PERSISTED_FINDING_TEXT_CAP)],
      ['fix', capText(finding.fix, PERSISTED_FINDING_TEXT_CAP)],
    ];
    const text = Object.fromEntries(capped.map(([field, { text }]) => [field, text])) as Record<PersistedFindingTextField, string>;
    return {
      severity: (FINDING_SEVERITIES as readonly string[]).includes(finding.severity) ? finding.severity : 'MINOR',
      title: text.title,
      file: text.file,
      line: capLine(finding.line),
      description: text.description,
      fix: text.fix,
      truncatedFields: capped.filter(([, { truncated }]) => truncated).map(([field]) => field),
    };
  });
}

/** A local host verdict record as written by cross_host_review: HostVerdict + bounded findings. */
export interface CrossHostVerdictRecord extends HostVerdict {
  findings: PersistedReviewFinding[];
  /** TRUE (uncapped) count of the host's findings. */
  findingCount: number;
}

async function runManagedCodexReview(
  ctx: HandlerContext,
  opts: {
    storyId: string;
    phase: string;
    storyWorktree: string;
    prompt: string;
    timeoutMs: number;
    environment: NodeJS.ProcessEnv;
    managedRunId?: string;
    detach?: boolean;
    /** Called synchronously once a fresh managed run has been durably submitted. */
    onManagedRunSubmitted?: (managedRunId: string) => void;
  },
  options: CreateCrossHostReviewHandlersOptions,
): Promise<CodexReviewRunnerResult & { managedRunId: string; managedReceiptId: string }> {
  const injectedOutcome: { value: CodexReviewRunnerResult | null } = { value: null };
  const managedRunner: HostRunRunner | undefined = options.managedRunner ?? (options.codexRunner
    ? async plan => {
      const outcome = await options.codexRunner!({
        prompt: plan.stdinText ?? '',
        storyWorktree: opts.storyWorktree,
        timeoutMs: opts.timeoutMs,
        env: opts.environment,
      });
      injectedOutcome.value = outcome;
      if (outcome.stdout) plan.onChunk?.({ stream: 'stdout', text: outcome.stdout });
      return {
        stdout: outcome.stdout,
        stderr: '',
        exitCode: outcome.exitCode ?? 1,
        timedOut: outcome.timedOut,
        timeoutKind: outcome.timedOut ? 'total_timeout' : null,
        terminalReason: outcome.timedOut ? 'total_timeout' : outcome.exitCode === 0 ? 'completed' : 'exit_nonzero',
      };
    }
    : undefined);
  const injectedLauncher: ManagedHostRunWorkerLauncher | undefined = managedRunner
    ? async request => {
      void runManagedHostRunWorker(request, { runner: managedRunner, env: process.env });
      return { pid: process.pid };
    }
    : undefined;
  let submitted;
  if (opts.managedRunId) {
    const binding = readManagedHostRunBinding(ctx.root, opts.managedRunId);
    const expectedPromptDigest = `sha256:${createHash('sha256').update(opts.prompt, 'utf8').digest('hex')}`;
    if (
      binding.host !== 'codex'
      || binding.storyId !== opts.storyId
      || binding.phase !== opts.phase
      || binding.agentType !== 'cross-host-review:codex'
      || binding.profile !== 'cross_host_review_codex'
      || binding.cwd !== opts.storyWorktree
      || binding.projectRootHash !== projectRootHashFor(ctx.root)
      || binding.promptDigest !== expectedPromptDigest
      || binding.timeoutMs > opts.timeoutMs
    ) {
      throw new Error('cross_host_review: managedRunId binding does not match the current story/policy/snapshot/prompt; refusing to resume or spawn a replacement');
    }
    submitted = (await getManagedHostRunStatus({ root: ctx.root, runId: opts.managedRunId })).run;
  } else {
    submitted = await submitManagedHostRun({
      root: ctx.root,
      cwd: opts.storyWorktree,
      host: 'codex',
      storyId: opts.storyId,
      phase: opts.phase,
      agentType: 'cross-host-review:codex',
      promptText: opts.prompt,
      timeoutMs: opts.timeoutMs,
      deadlineMs: opts.timeoutMs,
      projectRootHash: projectRootHashFor(ctx.root),
      profile: 'cross_host_review_codex',
      environment: opts.environment,
    }, { launchWorker: options.launchWorker ?? injectedLauncher });
    // Submission durable-writes the run binding before any controller-local
    // bookkeeping. Capture its identity before appendProcessEvent (or any later
    // setup) can throw so the caller's finally block never treats this provider
    // owned snapshot as cleanup-safe by default.
    opts.onManagedRunSubmitted?.(submitted.runId);
    try {
      ctx.store.appendProcessEvent(opts.storyId, {
        type: 'cross_host_review_managed_submitted',
        storyId: opts.storyId,
        managedRunId: submitted.runId,
        deadlineAt: submitted.deadlineAt,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      // A durable submission is still resumable when controller-local audit
      // bookkeeping fails. Record the persistence defect to the health channel
      // and return the exact run identity through the structured outer path so
      // an operator can resume it without manufacturing a duplicate provider.
      const cause = error instanceof Error ? error : new Error(String(error));
      reportHealthIssue('persist:crossHostReviewManagedSubmissionEvent', cause, {
        storyId: opts.storyId,
        managedRunId: submitted.runId,
        deadlineAt: submitted.deadlineAt,
      });
      throw new CrossHostReviewSubmissionBookkeepingFailure({
        schemaVersion: 'lattice.cross_host_review_managed_submission.v1',
        storyId: opts.storyId,
        managedRunId: submitted.runId,
        state: submitted.state,
        deadlineAt: submitted.deadlineAt,
        bookkeepingError: cause.message,
      }, cause);
    }
    if (opts.detach) {
      throw new CrossHostReviewDetached({
        schemaVersion: 'lattice.cross_host_review_managed_submission.v1',
        storyId: opts.storyId,
        managedRunId: submitted.runId,
        state: submitted.state,
        deadlineAt: submitted.deadlineAt,
      });
    }
  }
  let run = submitted;
  while (!run.terminal) {
    const status = await getManagedHostRunStatus({
      root: ctx.root,
      runId: run.runId,
      afterGeneration: run.generation,
      waitMs: 30_000,
    });
    run = status.run;
  }
  const stdoutChunks: string[] = [];
  let afterSequence = 0;
  let outputTruncated = false;
  let hasMore = true;
  while (hasMore) {
    const output = readManagedHostRunOutput({ root: ctx.root, runId: run.runId, afterSequence });
    afterSequence = output.nextSequence;
    hasMore = output.hasMore;
    outputTruncated ||= output.truncated;
    for (const frame of output.frames) {
      if (frame.stream === 'stdout') stdoutChunks.push(frame.text);
    }
  }
  const rawStdout = stdoutChunks.join('');
  const maxBytes = 8 * 1024 * 1024;
  const stdout = rawStdout.slice(0, maxBytes);
  const result = readManagedHostRunResult(ctx.root, run.runId);
  // Prefer the managed runner's digest of the complete stdout stream. The
  // retained journal is intentionally capped, so hashing `rawStdout` here
  // would collapse distinct streams that share the retained prefix.
  const stdoutDigest = injectedOutcome.value?.stdoutDigest
    ?? result?.stdoutDigest
    ?? createHash('sha256').update(rawStdout, 'utf8').digest('hex');
  const receipt = managedHostRunReceipt(ctx.root, run.runId);
  if (!run.terminal?.replacementSafe
    || run.terminal.processCleanup?.reaped !== true
    || run.terminal.processCleanup.residualProcessGroup) {
    // B-137a:F-114 — carry the runId on the error. This throw happens BEFORE the
    // `return { ... managedRunId }` below, so on a FRESH run (no --managedRunId) the
    // caller's `managedRunId` would still be '' when its finally block computes
    // `cleanupRunId = requestedManagedRunId || managedRunId`. That falsy value took
    // the ternary's else-branch, set resumeCleanupSafe = true, and force-removed the
    // snapshot worktree while this very terminal says the provider process group may
    // still be live — defeating resumedManagedRunAllowsSnapshotCleanup, which exists
    // precisely to prevent that. Tagging the error lets the caller resolve the real
    // runId and re-consult that guard instead of assuming cleanup is safe.
    const unsafeTerminalError = new Error('cross_host_review: managed provider terminal is not replacement-safe/reaped or retains a residual process group; refusing verdict consumption');
    (unsafeTerminalError as Error & { managedRunId?: string }).managedRunId = run.runId;
    throw unsafeTerminalError;
  }
  const terminalExitCode = run.state === 'completed'
    ? result?.exitCode ?? 0
    : result?.exitCode && result.exitCode !== 0
      ? result.exitCode
      : run.state === 'timed_out'
        ? 124
        : 1;
  return {
    stdout,
    stdoutDigest,
    exitCode: terminalExitCode,
    timedOut: run.state === 'timed_out' || result?.timedOut === true,
    truncated: injectedOutcome.value?.truncated === true || outputTruncated || rawStdout.length > maxBytes,
    managedRunId: run.runId,
    managedReceiptId: receipt.receiptId,
    blocked: result?.blocked === true,
    refusalReason: result?.refusalReason ?? null,
  };
}

interface CrossHostVerdictDraft {
  storyId: string;
  runId: string;
  hostId: string;
  provider: 'claude' | 'codex';
  sessionId: string;
  keyId: string;
  decision: VerdictDecision;
  materialDigest: string;
  storyFilesHash: string;
  validationDigest: string;
  promptDigest: string;
  receiptId?: string;
  note: string;
  /** Parsed findings (host B: leaf verdict; host A: caller-authored file); bounded on persist. */
  findings: readonly Finding[];
}

function buildLocalHostVerdict(draft: CrossHostVerdictDraft, issuedAt: string): CrossHostVerdictRecord {
  const base = {
    schemaVersion: 'lattice.host_verdict.v1' as const,
    mode: 'local' as const,
    storyId: draft.storyId,
    runId: draft.runId,
    hostId: draft.hostId,
    provider: draft.provider,
    sessionId: draft.sessionId,
    keyId: draft.keyId,
    decision: draft.decision,
    materialDigest: draft.materialDigest,
    storyFilesHash: draft.storyFilesHash,
    validationDigest: draft.validationDigest,
    promptDigest: draft.promptDigest,
    ...(draft.receiptId ? { receiptId: draft.receiptId } : {}),
    issuedAt,
    note: draft.note,
    // B-dc2e CHK-004: the bounded findings + true count are part of the digested
    // base so the verdictId binds the persisted finding text.
    findings: boundPersistedFindings(draft.findings),
    findingCount: draft.findings.length,
  };
  return {
    ...base,
    verdictId: `verdict-${canonicalDigest(base).slice(0, 16)}`,
  };
}

function writeCrossHostVerdictPair(
  ctx: HandlerContext,
  storyId: string,
  hostAVerdict: CrossHostVerdictRecord,
  hostBVerdict: CrossHostVerdictRecord,
): void {
  const dir = join(ctx.root, PROOF_OR_STOP_DIR, 'autopilot-verdicts', storyId);
  mkdirSync(dir, { recursive: true });
  const paths = [
    join(dir, `${hostAVerdict.verdictId}.json`),
    join(dir, `${hostBVerdict.verdictId}.json`),
  ];
  try {
    writeFileSync(paths[0], JSON.stringify(hostAVerdict, null, 2) + '\n', 'utf8');
    writeFileSync(paths[1], JSON.stringify(hostBVerdict, null, 2) + '\n', 'utf8');
  } catch (err) {
    for (const path of paths) rmSync(path, { force: true });
    throw err;
  }
}

function deleteCrossHostVerdictPair(ctx: HandlerContext, storyId: string, ...verdicts: HostVerdict[]): void {
  const dir = join(ctx.root, PROOF_OR_STOP_DIR, 'autopilot-verdicts', storyId);
  for (const verdict of verdicts) {
    rmSync(join(dir, `${verdict.verdictId}.json`), { force: true });
  }
}

function hostVerdictProcessEvent(verdict: HostVerdict): Record<string, unknown> {
  return {
    type: 'host_verdict',
    mode: verdict.mode,
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
    ...(verdict.receiptId ? { receiptId: verdict.receiptId } : {}),
    timestamp: new Date().toISOString(),
  };
}

function appendHostVerdictEvents(ctx: HandlerContext, storyId: string, ...verdicts: HostVerdict[]): void {
  const events = verdicts.filter(verdict => verdict.storyId).map(hostVerdictProcessEvent);
  if (events.length === 0) return;
  // B-d877 R4 (codex #3): pass the RELOCATED append lock dir (the same gitignored
  // shared `.proof-or-stop/locks/process-events/` path StoryStore.appendProcessEvent
  // uses). Previously this site omitted lockDir, so the append lock was created
  // inside the git-tracked story dir and a transient holder.json could dirty the
  // tree / fail the clean-tree gate.
  appendRawProcessEventBytes(
    ctx.store.storyDirPath(storyId),
    `${events.map(event => JSON.stringify(event)).join('\n')}\n`,
    ctx.store.runtimeLockDirPath(storyId, 'process-events', 'process-events-append'),
  );
}

export function createCrossHostReviewHandlers(
  ctx: HandlerContext,
  options: CreateCrossHostReviewHandlersOptions = {},
) {
  return {
    async cross_host_review(args: CrossHostReviewArgs): Promise<CrossHostReviewResult | CrossHostReviewManagedSubmission | string> {
      const storyId = normalizeString(args.storyId);
      if (!storyId) throw new Error('cross_host_review: storyId is required');
      if (!isCanonicalStoryId(storyId)) {
        throw new Error(`cross_host_review: storyId "${storyId}" is not a canonical, path-safe Proof-or-Stop story id`);
      }

      const workspace = resolveStoryCommandWorkspace(ctx.store, storyId, ctx.root);
      const projectRoot = workspace.signedWorkspaceRoot;
      const metadataRoot = workspace.metadataRoot || ctx.root;
      const gitCwd = resolveGitCwd({
        store: ctx.store,
        storyId,
        metadataRoot,
        projectRoot,
        cwd: projectRoot,
      });

      const headHash = currentGitHead(gitCwd);
      if (!headHash) {
        throw new Error('cross_host_review: cannot resolve current HEAD; refusing to record verdicts without a committed-tree binding');
      }
      await options.afterHeadCaptured?.();

      const materialDigest = currentMaterialHash(gitCwd, headHash, metadataRoot);
      if (!materialDigest) {
        throw new Error(`cross_host_review: cannot compute materialHash for captured HEAD ${headHash}; refusing to record verdicts with an empty materialDigest`);
      }
      const storyFilesHash = currentStoryFilesHash(gitCwd, headHash, metadataRoot);
      if (!storyFilesHash) {
        throw new Error(`cross_host_review: cannot compute storyFilesHash for captured HEAD ${headHash}; refusing to record verdicts without the story-owned file hash`);
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
        : CROSS_HOST_REVIEW_DEFAULT_TIMEOUT_MINUTES;
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
      const timeoutMinutes = boundedCrossHostReviewTimeoutMinutes(requestedMinutes, policyMaxMinutes);

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
      // must still be source-clean before we record the verdict. `.proof-or-stop/`
      // metadata is excluded (Codex never reads story bookkeeping, and it churns
      // constantly).
      assertMaterialCleanForReview(gitCwd);
      assertReviewHeadStillCurrent(gitCwd, headHash);

      // F-010: Codex must not review the mutable story worktree after the clean
      // preflight. Give it an immutable detached snapshot of the captured HEAD
      // SHA instead, then
      // re-check the original worktree before recording. A concurrent source edit
      // or clean HEAD move after the snapshot cannot influence what Codex reviewed,
      // and we refuse to bind/record the verdict if either drift is still present.
      const requestedManagedRunId = normalizeString(args.managedRunId);
      if (!requestedManagedRunId && resolveManagedReviewIsolation(ctx.root)) {
        // Credentials are selected by the trusted controller, before provider
        // environment redaction; only the derived private cache reaches Codex.
        const preflightEnvironment = {...process.env,...redactedEnv};
        preflightManagedReadonlyHost('codex', gitCwd, preflightEnvironment);
        preflightManagedProviderState('codex', preflightEnvironment);
      }
      const resumedBinding = requestedManagedRunId
        ? readManagedHostRunBinding(ctx.root, requestedManagedRunId)
        : null;
      if (resumedBinding && (!existsSync(resumedBinding.cwd) || resumedBinding.storyId !== storyId || resumedBinding.profile !== 'cross_host_review_codex')) {
        throw new Error('cross_host_review: managedRunId does not identify a resumable snapshot for this story');
      }
      const snapshot = resumedBinding
        ? { worktree: resumedBinding.cwd, cleanup: () => cleanupHeadReviewWorktree(gitCwd, resumedBinding.cwd) }
        : createCleanHeadReviewWorktree(gitCwd, headHash);
      let leaf: CodexReviewLeafResult;
      let managedRunId = '';
      let managedReceiptId = '';
      let preserveSnapshot = false;
      let verdictDurable = false;
      // B-137a:F-114 — an unsafe-terminal throw happens before managedRunId is
      // assigned, so capture the runId the error carries and feed it to the
      // cleanup-safety guard below instead of defaulting to "safe".
      let thrownManagedRunId = '';
      try {
        try {
          leaf = await runCodexReviewLeaf(
            {
              storyId,
              storyWorktree: snapshot.worktree,
              materialHash: materialDigest,
              hostAFindings,
              timeoutMs: timeoutMinutes * 60 * 1000,
              env: redactedEnv,
              managedExecution: true,
              // B-137a F-043: the managed worker owns the ONLY provider execution
              // here, and therefore the only usage-ledger lifecycle. Passing a
              // usageLedger binding to the wrapper leaf as well made it record a
              // SECOND estimate/final pair for that same provider execution
              // (measured: 4 rows
              // where the contract is 2). main's B-70e9 ledger binding belongs on
              // the unmanaged leaf path, not on this managed one.
            },
            async runnerOptions => {
              const outcome = await runManagedCodexReview(ctx, {
                storyId,
                phase: resolveStoryPhaseForUsage(ctx, storyId),
                storyWorktree: runnerOptions.storyWorktree,
                prompt: runnerOptions.prompt,
                timeoutMs: runnerOptions.timeoutMs,
                environment: runnerOptions.env ?? redactedEnv,
                ...(requestedManagedRunId ? { managedRunId: requestedManagedRunId } : {}),
                ...(args.detach === true ? { detach: true } : {}),
                onManagedRunSubmitted: submittedRunId => { managedRunId = submittedRunId; },
              }, options);
              managedRunId = outcome.managedRunId;
              managedReceiptId = outcome.managedReceiptId;
              return outcome;
            },
          );
        } catch (error) {
          if (error instanceof CrossHostReviewSubmissionBookkeepingFailure) {
            preserveSnapshot = true;
            return wantsJson(args)
              ? error.submission
              : `${error.submission.managedRunId} state=${error.submission.state} deadlineAt=${error.submission.deadlineAt} bookkeeping=failed`;
          }
          if (!(error instanceof CrossHostReviewDetached)) {
            // B-137a:F-114 — recover the runId the unsafe-terminal throw carries so the
            // finally block's cleanup-safety guard gets a real runId instead of ''.
            const tagged = (error as Error & { managedRunId?: string } | null)?.managedRunId;
            if (typeof tagged === 'string' && tagged.length > 0) thrownManagedRunId = tagged;
            throw error;
          }
          preserveSnapshot = true;
          return wantsJson(args)
            ? error.submission
            : `${error.submission.managedRunId} state=${error.submission.state} deadlineAt=${error.submission.deadlineAt}`;
        }
      assertReviewHeadStillCurrent(gitCwd, headHash);
      assertMaterialCleanForReview(gitCwd);
      const hostBVerdict: CodexReviewVerdict = leaf.hostBVerdict;

      const validationDigest = deriveValidationDigest(storyId, materialDigest, storyFilesHash, headHash);

      // Host A decision: derived from the caller-authored findings. Any
      // BLOCKER/MAJOR finding is a fail; otherwise pass. Host A is a review
      // conclusion the caller already reached, not a spawned second agent.
      const hostADecision: 'pass' | 'fail' = hostAFindings.some(
        f => f.severity === 'BLOCKER' || f.severity === 'MAJOR',
      ) ? 'fail' : 'pass';

      const hostAVerdictDraft: CrossHostVerdictDraft = {
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
        findings: hostAFindings,
      };

      const hostBVerdictDraft: CrossHostVerdictDraft = {
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
        receiptId: managedReceiptId,
        note: `cross_host_review host B (Codex) verdict, managedRunId=${managedRunId}, stdoutDigest=${leaf.stdoutDigest}`,
        findings: hostBVerdict.findings,
      };

      await options.beforeVerdictRecord?.();
      assertReviewHeadStillCurrent(gitCwd, headHash);
      assertMaterialCleanForReview(gitCwd);

      const issuedAt = new Date().toISOString();
      const hostAVerdictRecord = buildLocalHostVerdict(hostAVerdictDraft, issuedAt);
      const hostBVerdictRecord = buildLocalHostVerdict(hostBVerdictDraft, issuedAt);
      writeCrossHostVerdictPair(ctx, storyId, hostAVerdictRecord, hostBVerdictRecord);
      try {
        await options.afterVerdictPairWritten?.();
        assertReviewHeadStillCurrent(gitCwd, headHash);
        assertMaterialCleanForReview(gitCwd);
      } catch (err) {
        deleteCrossHostVerdictPair(ctx, storyId, hostAVerdictRecord, hostBVerdictRecord);
        throw err;
      }
      appendHostVerdictEvents(ctx, storyId, hostAVerdictRecord, hostBVerdictRecord);
      verdictDurable = true;

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
          findings: hostAVerdictRecord.findings,
        },
        hostB: {
          hostId: hostBIdentity.hostId,
          provider: hostBIdentity.provider,
          decision: hostBVerdict.decision,
          verdictId: hostBVerdictRecord.verdictId,
          findingCount: hostBVerdict.findings.length,
          findings: hostBVerdictRecord.findings,
          ...(hostBVerdict.reason ? { reason: hostBVerdict.reason } : {}),
        },
        disagreement,
        jointDecision: joint,
        stdoutDigest: leaf.stdoutDigest,
        codexExitCode: leaf.exitCode,
        codexTimedOut: leaf.timedOut,
        managedRunId,
        managedReceiptId,
      };
      return wantsJson(args) ? result : formatResult(result);
      } finally {
        if (!preserveSnapshot) {
          const cleanupRunId = requestedManagedRunId || managedRunId || thrownManagedRunId;
          if (cleanupRunId) {
            // A provider-owned snapshot must survive until local verdict/event
            // durability so a replacement can replay the completed managed run.
            if (verdictDurable) {
              const resumeCleanupSafe = await resumedManagedRunAllowsSnapshotCleanup(ctx.root, cleanupRunId);
              if (resumeCleanupSafe) snapshot.cleanup();
            }
          } else {
            snapshot.cleanup();
          }
        }
      }
    },
  };
}
