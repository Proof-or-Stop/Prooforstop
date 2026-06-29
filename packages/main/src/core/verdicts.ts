import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalDigest } from './authority-signing.js';
import { LATTICE_DIR } from './lattice-paths.js';
import {
  FINAL_HOST_REVIEW_PROMPT_PROFILE,
  buildFinalHostReviewPromptDigestInput,
  type AuthorityVerdictClaim,
  type AuthorityVerdictReceipt,
  type AuthorityVerdictReconciliation,
} from './authority-contracts.js';

type AuthorityVerdictPromptClaim = Partial<Pick<
  AuthorityVerdictClaim,
  | 'reviewWaveId'
  | 'provider'
  | 'reviewPromptProfile'
  | 'reviewPromptDigest'
  | 'checkedReceiptId'
  | 'checkedGateInputDigest'
  | 'checkedEvidenceRefs'
  | 'checkedValidationDigest'
  | 'checkedMaterialHash'
  | 'checkedCommit'
>>;

const REQUIRED_FINAL_HOST_CHECK_WAVES = 3;
const MIN_FINAL_HOSTS_PER_REVIEW_WAVE = 2;

export type VerdictMode = 'local' | 'authority';
export type VerdictDecision = 'pass' | 'fail' | 'blocked';

/**
 * Truth source §X9 reconciliation: when a required independent verifier verdict
 * fails, certification is blocked. `block` stops the run; `repair_then_reverify`
 * returns the Story to DEV, runs repair, and — after any material change — forces
 * fresh validation, a fresh receipt (authority mode), and a fresh review wave.
 */
export type DisagreementBehavior = 'block' | 'repair_then_reverify';

export interface HostVerdict {
  schemaVersion: 'lattice.host_verdict.v1';
  verdictId: string;
  mode: VerdictMode;
  storyId?: string;
  jobId?: string;
  runId: string;
  hostId: string;
  provider: 'codex' | 'claude' | 'gemini' | string;
  sessionId: string;
  keyId?: string;
  decision: VerdictDecision;
  materialDigest: string;
  storyFilesHash?: string;
  validationDigest?: string;
  gateInputDigest?: string;
  receiptId?: string;
  promptDigest?: string;
  issuedAt: string;
  note: string;
}

export interface VerdictSummary {
  schemaVersion: 'lattice.verdict_summary.v1';
  mode: VerdictMode;
  storyId?: string;
  jobId?: string;
  runId: string;
  totalVerdicts: number;
  requiredHosts: number;
  independentHosts: number;
  passingIndependentHosts: number;
  failingIndependentHosts: number;
  duplicateVerdicts: number;
  // Verdicts excluded because their anchors (validation/material/receipt) no longer
  // match the current review wave — e.g. a repair produced fresh anchors, so prior
  // verdicts are stale for certification (§X9 "all previous affected verdicts are
  // stale"). 0 when no `currentAnchor` is supplied.
  staleVerdicts: number;
  localReviewEvidenceRefs: string[];
  localReviewCertified: boolean;
  authorityDone: boolean;
  receiptVerified: boolean;
  fullAuthorityDone: boolean;
  multiHostVerified: boolean;
  authorityServerContact: boolean;
  status: 'pass' | 'blocked';
  blockedReason?: string;
  verdicts: HostVerdict[];
}

export interface VerdictRunSummary {
  runId: string;
  latestIssuedAt: string | null;
  totalVerdicts: number;
  requiredHosts: number;
  independentHosts: number;
  passingIndependentHosts: number;
  failingIndependentHosts: number;
  duplicateVerdicts: number;
  staleVerdicts: number;
  localReviewCertified: boolean;
  authorityDone: boolean;
  fullAuthorityDone: boolean;
  multiHostVerified: boolean;
  status: VerdictSummary['status'];
  blockedReason?: string;
}

export interface VerdictRunDiagnostics {
  schemaVersion: 'lattice.verdict_run_diagnostics.v1';
  mode: VerdictMode;
  storyId?: string;
  jobId?: string;
  selectedRunId: string;
  defaultRunId: 'default-run';
  runCount: number;
  allRunIds: string[];
  allRuns: VerdictRunSummary[];
  latestRuns: VerdictRunSummary[];
  authorityServerContact: false;
  diagnosticOnly: true;
}

export interface VerdictSubmitArgs {
  mode: VerdictMode;
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
  storyFilesHash?: string;
  validationDigest?: string;
  gateInputDigest?: string;
  receiptId?: string;
  promptDigest?: string;
  note?: string;
}

function baseDir(root: string, mode: VerdictMode, id: string): string {
  return join(root, LATTICE_DIR, mode === 'authority' ? 'authority-verdicts' : 'autopilot-verdicts', id);
}

function readVerdictFile(root: string, file: string): Partial<HostVerdict> {
  const path = file.startsWith('/') ? file : join(root, file);
  return JSON.parse(readFileSync(path, 'utf8')) as Partial<HostVerdict>;
}

function norm(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

// Link keys that, when SHARED by two verdicts, prove they originate from the same
// host and therefore must not both count toward independent host coverage. Truth
// source §X9: independence requires DIFFERENT registered host ids AND a materially
// independent execution dimension; same host id, same provider session, or same
// credential/key binding are explicitly non-independent. Two verdicts collapse when
// they share ANY of:
//   - host id  — "same host id" is never independent (a host cannot certify itself
//     twice by varying provider/key), so a shared hostId alone collapses;
//   - session  — same-session / same provider session verdicts do not add independence;
//   - key id   — a shared credential/key binding is the same actor (only when present).
// Grouping is transitive: if A~B by host and B~C by session, A, B, and C are one host.
// Components are trimmed/lower-cased so trivial whitespace/case variants cannot
// masquerade as a distinct host.
function linkKeysOf(verdict: HostVerdict): string[] {
  const keys = [`host:${norm(verdict.hostId)}`, `session:${norm(verdict.sessionId)}`];
  const keyId = norm(verdict.keyId);
  if (keyId) keys.push(`key:${keyId}`);
  return keys;
}

// Union-find over link keys: collapse all verdicts that transitively share a host id,
// session, or key binding into one independent-host bucket. Fail-closed — any shared
// origin dimension merges, so a single host cannot inflate independence by rotating
// provider, session, or key.
function groupByIndependentHost(all: HostVerdict[]): HostVerdict[][] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cursor = x;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    parent.set(find(a), find(b));
  };

  all.forEach((_, index) => parent.set(index, index));
  const keyOwner = new Map<string, number>();
  all.forEach((verdict, index) => {
    for (const key of linkKeysOf(verdict)) {
      const owner = keyOwner.get(key);
      if (owner === undefined) keyOwner.set(key, index);
      else union(owner, index);
    }
  });

  const groups = new Map<number, HostVerdict[]>();
  all.forEach((verdict, index) => {
    const root = find(index);
    const bucket = groups.get(root);
    if (bucket) bucket.push(verdict);
    else groups.set(root, [verdict]);
  });
  return [...groups.values()];
}

function idFor(args: VerdictSubmitArgs): string {
  if (args.mode === 'authority') {
    if (!args.jobId) throw new Error('jobId is required for authority verdicts');
    return args.jobId;
  }
  if (!args.storyId) throw new Error('storyId is required for local autopilot review verdicts');
  return args.storyId;
}

export function submitVerdict(root: string, args: VerdictSubmitArgs, now = new Date()): HostVerdict {
  const fromFile = args.verdictFile ? readVerdictFile(root, args.verdictFile) : {};
  const merged = { ...fromFile, ...args };
  const mode = merged.mode;
  const runId = merged.runId || 'default-run';
  const hostId = merged.hostId || merged.provider || 'unknown-host';
  const provider = merged.provider || 'unknown';
  const sessionId = merged.sessionId || 'unknown-session';
  const decision = merged.decision || 'blocked';
  const materialDigest = merged.materialDigest || merged.validationDigest || merged.gateInputDigest || 'missing-material-digest';
  const base = {
    schemaVersion: 'lattice.host_verdict.v1' as const,
    mode,
    storyId: merged.storyId,
    jobId: merged.jobId,
    runId,
    hostId,
    provider,
    sessionId,
    keyId: merged.keyId,
    decision,
    materialDigest,
    storyFilesHash: merged.storyFilesHash,
    validationDigest: merged.validationDigest,
    gateInputDigest: merged.gateInputDigest,
    receiptId: merged.receiptId,
    promptDigest: merged.promptDigest,
    issuedAt: now.toISOString(),
    note: merged.note || 'host verdict submitted',
  };
  const verdict: HostVerdict = {
    ...base,
    verdictId: `verdict-${canonicalDigest(base).slice(0, 16)}`,
  };
  const dir = baseDir(root, mode, idFor(args));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${verdict.verdictId}.json`), JSON.stringify(verdict, null, 2) + '\n', 'utf8');
  return verdict;
}

export function listVerdicts(root: string, mode: VerdictMode, id: string): HostVerdict[] {
  const dir = baseDir(root, mode, id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')) as HostVerdict)
    .sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
}

/**
 * The current review-wave anchors. When supplied to {@link summarizeVerdicts}, any
 * verdict whose corresponding anchor does not match is treated as STALE (left over
 * from a prior wave / pre-repair chain) and excluded from independence and passing
 * counts. Fail-closed: only verdicts proven to belong to the current wave certify.
 * §X9: after a repair that changes validation/material/receipt state, all previous
 * affected verdicts are stale and a fresh review wave is required.
 */
export interface VerdictAnchor {
  validationDigest?: string;
  materialDigest?: string;
  receiptId?: string;
}

/** A verdict matches the current wave only when every SUPPLIED anchor matches. */
function verdictMatchesAnchor(verdict: HostVerdict, anchor: VerdictAnchor): boolean {
  if (anchor.validationDigest !== undefined && norm(verdict.validationDigest) !== norm(anchor.validationDigest)) return false;
  if (anchor.materialDigest !== undefined && norm(verdict.materialDigest) !== norm(anchor.materialDigest)) return false;
  if (anchor.receiptId !== undefined && norm(verdict.receiptId) !== norm(anchor.receiptId)) return false;
  return true;
}

export function summarizeVerdicts(
  root: string,
  mode: VerdictMode,
  id: string,
  runId = 'default-run',
  requiredHosts = 2,
  options: { currentAnchor?: VerdictAnchor } = {},
): VerdictSummary {
  const forRun = listVerdicts(root, mode, id).filter(verdict => verdict.runId === runId);
  // Fresh-review-wave gate (§X9): with a currentAnchor, drop verdicts whose anchors do
  // not match the current wave so a repair (fresh validation / material / receipt) can
  // never be certified by pre-repair verdicts.
  const anchor = options.currentAnchor;
  const all = anchor ? forRun.filter(verdict => verdictMatchesAnchor(verdict, anchor)) : forRun;
  const staleVerdicts = forRun.length - all.length;
  // requiredHosts is a hard floor: final review certification is always multi-host.
  // A 0 / 1 / negative / NaN value can never silently downgrade the requirement
  // below the Proofbound final-check floor.
  const required = Math.max(MIN_FINAL_HOSTS_PER_REVIEW_WAVE, Math.floor(Number(requiredHosts)) || MIN_FINAL_HOSTS_PER_REVIEW_WAVE);

  // Group verdicts so any duplicate same-host or same-session origin collapses to one
  // independent host (see linkKeysOf / groupByIndependentHost).
  const groups = groupByIndependentHost(all);
  const independentHosts = groups.length;
  const duplicateVerdicts = all.length - independentHosts;

  // A host counts as passing only if EVERY verdict it submitted passes (fail-closed):
  // a single failing independent verdict for an identity makes that host failing and
  // therefore blocks, even if the same host also submitted a pass.
  const passingHosts: HostVerdict[] = [];
  const failingHosts: HostVerdict[] = [];
  for (const bucket of groups) {
    const representative = bucket[bucket.length - 1];
    if (bucket.every(verdict => verdict.decision === 'pass')) passingHosts.push(representative);
    else failingHosts.push(representative);
  }

  const enough = passingHosts.length >= required;
  const noFailures = failingHosts.length === 0;
  const status = enough && noFailures ? 'pass' : 'blocked';
  const localReviewEvidenceRefs = mode === 'local'
    ? passingHosts.map(verdict => `host-verdict:${verdict.verdictId}`)
    : [];
  const localReviewCertified =
    mode === 'local' &&
    status === 'pass' &&
    localReviewEvidenceRefs.length >= required;

  // Truth source §X9: local review must NEVER set `multiHostVerified` (nor
  // `authorityDone` / `fullAuthorityDone`). `multiHostVerified` is strictly an
  // retired remote-mode projection of a passing host wave; a passing LOCAL wave is
  // expressed only via `localReviewCertified`. Setting it in local mode was the
  // semantic tension this gate had to resolve — local and retired compatibility
  // projections share one summarizer but the multi-host flag is not local DONE.
  const multiHostVerified = mode === 'authority' && status === 'pass';

  // Neither `authorityDone` nor `fullAuthorityDone` is ever minted from host
  // verdicts here. A `receiptId` carried in a verdict is not a verified native
  // gate_decision receipt. Per truth source §X9 `fullAuthorityDone` requires per-run
  // `authorityDone` (a verified native gate_decision receipt) PLUS a passing
  // multi-host wave; the receipt half can only be proven by the authority executor /
  // receipt verifier, so this summary can never satisfy it. Both authority-DONE flags
  // stay false so a summary can never overclaim DONE from host agreement alone.
  const receiptVerified = false;
  const fullAuthorityDone = false;
  const authorityServerContact = false;

  // Distinguish disagreement (a required independent verdict failed → reconcile or
  // return to DEV for repair, §X9 reconciliation) from a plain coverage shortfall.
  // A shortfall caused purely by staleness names the fresh review wave explicitly.
  let blockedReason: string | undefined;
  if (status !== 'pass') {
    if (failingHosts.length > 0) {
      blockedReason = `multi_host_disagreement: ${failingHosts.length} independent host verdict(s) failed; reconcile findings or return the Story to DEV for repair and re-review before certification`;
    } else if (staleVerdicts > 0) {
      blockedReason = `stale_review_wave: ${staleVerdicts} verdict(s) predate the current review wave (anchors changed after repair); requires ${required} passing independent host verdicts over the fresh validation/material/receipt anchors, have ${passingHosts.length}`;
    } else {
      blockedReason = `insufficient_independent_hosts: requires ${required} passing independent host verdicts with no failing verdicts, have ${passingHosts.length}`;
    }
  }
  return {
    schemaVersion: 'lattice.verdict_summary.v1',
    mode,
    storyId: mode === 'local' ? id : undefined,
    jobId: mode === 'authority' ? id : undefined,
    runId,
    totalVerdicts: forRun.length,
    requiredHosts: required,
    staleVerdicts,
    independentHosts,
    passingIndependentHosts: passingHosts.length,
    failingIndependentHosts: failingHosts.length,
    duplicateVerdicts,
    localReviewEvidenceRefs,
    localReviewCertified,
    authorityDone: false,
    receiptVerified,
    fullAuthorityDone,
    multiHostVerified,
    authorityServerContact,
    status,
    blockedReason,
    verdicts: all,
  };
}

function sortedRunIds(runIds: Iterable<string>): string[] {
  return [...new Set([...runIds].map(id => id.trim()).filter(Boolean))]
    .sort((a, b) => {
      if (a === 'default-run' && b !== 'default-run') return -1;
      if (b === 'default-run' && a !== 'default-run') return 1;
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    });
}

function summarizeRun(summary: VerdictSummary, latestIssuedAt: string | null): VerdictRunSummary {
  return {
    runId: summary.runId,
    latestIssuedAt,
    totalVerdicts: summary.totalVerdicts,
    requiredHosts: summary.requiredHosts,
    independentHosts: summary.independentHosts,
    passingIndependentHosts: summary.passingIndependentHosts,
    failingIndependentHosts: summary.failingIndependentHosts,
    duplicateVerdicts: summary.duplicateVerdicts,
    staleVerdicts: summary.staleVerdicts,
    localReviewCertified: summary.localReviewCertified,
    authorityDone: summary.authorityDone,
    fullAuthorityDone: summary.fullAuthorityDone,
    multiHostVerified: summary.multiHostVerified,
    status: summary.status,
    ...(summary.blockedReason ? { blockedReason: summary.blockedReason } : {}),
  };
}

export function summarizeVerdictRuns(
  root: string,
  mode: VerdictMode,
  id: string,
  selectedRunId = 'default-run',
  requiredHosts = 2,
  options: { currentAnchor?: VerdictAnchor; latestLimit?: number } = {},
): VerdictRunDiagnostics {
  const verdicts = listVerdicts(root, mode, id);
  const latestIssuedAtByRun = new Map<string, string>();
  for (const verdict of verdicts) {
    const runId = verdict.runId || 'default-run';
    const current = latestIssuedAtByRun.get(runId);
    if (!current || verdict.issuedAt > current) latestIssuedAtByRun.set(runId, verdict.issuedAt);
  }

  const allRunIds = sortedRunIds(['default-run', selectedRunId || 'default-run', ...verdicts.map(verdict => verdict.runId || 'default-run')]);
  const allRuns = allRunIds.map(runId => summarizeRun(
    summarizeVerdicts(root, mode, id, runId, requiredHosts, { currentAnchor: options.currentAnchor }),
    latestIssuedAtByRun.get(runId) ?? null,
  ));
  const latestLimit = Math.max(1, Math.floor(Number(options.latestLimit)) || 5);
  const latestRuns = [...allRuns]
    .sort((a, b) => {
      if (a.latestIssuedAt && b.latestIssuedAt && a.latestIssuedAt !== b.latestIssuedAt) {
        return b.latestIssuedAt.localeCompare(a.latestIssuedAt);
      }
      if (a.latestIssuedAt && !b.latestIssuedAt) return -1;
      if (!a.latestIssuedAt && b.latestIssuedAt) return 1;
      return sortedRunIds([a.runId, b.runId]).indexOf(a.runId) - sortedRunIds([a.runId, b.runId]).indexOf(b.runId);
    })
    .slice(0, latestLimit);

  return {
    schemaVersion: 'lattice.verdict_run_diagnostics.v1',
    mode,
    ...(mode === 'local' ? { storyId: id } : { jobId: id }),
    selectedRunId: selectedRunId || 'default-run',
    defaultRunId: 'default-run',
    runCount: allRuns.length,
    allRunIds,
    allRuns,
    latestRuns,
    authorityServerContact: false,
    diagnosticOnly: true,
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Legacy remote multi-host certification compatibility (truth source §X9) — pure helpers
//
// These functions hold compatibility certification logic for old verdict records.
// Keeping the logic here makes it unit testable without a network and keeps the
// contract honest:
//   - a host verdict can never be recorded ahead of the receipt it certifies;
//   - fullAuthorityDone needs BOTH a verified per-run gate_decision receipt AND a
//     server-satisfied independent-host reconciliation;
//   - a repair that mints a fresh receipt makes prior verdicts stale.
// ───────────────────────────────────────────────────────────────────────────────

export interface VerdictOrderingResult {
  ok: boolean;
  reason?: string;
}

/**
 * Receipt-before-verdict ordering (§X9 "Authority ordering"): Proofbound Authority
 * issues and stores the native gate_decision receipt BEFORE the multi-host gate is
 * evaluated, and verifier hosts inspect that verified receipt. So an Authority host
 * verdict is only well-formed when it names the gate_decision receipt + gate input
 * digest it checked. A submission missing either is rejected before any network call,
 * so a verdict can never be recorded ahead of the receipt it is supposed to certify.
 */
export function checkReceiptBeforeVerdict(
  claim: Pick<AuthorityVerdictClaim, 'checkedReceiptId' | 'checkedGateInputDigest'>,
): VerdictOrderingResult {
  const receiptId = (claim.checkedReceiptId ?? '').trim();
  if (!receiptId) {
    return {
      ok: false,
      reason:
        'receipt_required_before_verdict: an Authority host verdict must reference the verified gate_decision receiptId it inspected (§X9 receipt-before-verdict ordering); obtain and submit the gate receipt first',
    };
  }
  const gateInputDigest = (claim.checkedGateInputDigest ?? '').trim();
  if (!gateInputDigest) {
    return {
      ok: false,
      reason:
        'gate_input_digest_required_before_verdict: an Authority host verdict must reference the checkedGateInputDigest of the receipt-backed run (§X9)',
    };
  }
  return { ok: true };
}

export function checkFinalHostReviewPromptDigest(claim: AuthorityVerdictPromptClaim): VerdictOrderingResult {
  if ((claim.reviewPromptProfile ?? '').trim() !== FINAL_HOST_REVIEW_PROMPT_PROFILE) {
    return {
      ok: false,
      reason:
        `final_host_review_prompt_profile_required: Authority final host verdicts must use ${FINAL_HOST_REVIEW_PROMPT_PROFILE}`,
    };
  }

  const actualDigest = (claim.reviewPromptDigest ?? '').trim();
  if (!actualDigest) {
    return {
      ok: false,
      reason:
        'final_host_review_prompt_digest_required: final host verdicts must bind the four core review principles, including consistency of logic',
    };
  }

  const expectedDigest = canonicalDigest(buildFinalHostReviewPromptDigestInput(claim));
  if (actualDigest !== expectedDigest) {
    return {
      ok: false,
      reason:
        'final_host_review_prompt_digest_mismatch: final host verdict prompt digest must bind the canonical four-principle final host-check prompt',
    };
  }

  return { ok: true };
}

export interface FreshWavePartition {
  fresh: AuthorityVerdictReceipt[];
  /** Verdicts that checked a different (prior) receiptId — stale after a repair. */
  stale: AuthorityVerdictReceipt[];
  staleVerdictIds: string[];
}

/**
 * After a repair that produced a FRESH gate_decision receipt, host verdicts that
 * checked a PRIOR receiptId are stale for final certification (§X9 reconciliation:
 * "after any repair that changes … Authority gate input, all previous affected
 * verdicts are stale"). When the current receiptId is known, partition the listed
 * verdicts so stale or unbound ones block certification instead of silently counting.
 * A verdict with no recorded `checkedReceiptId` is NOT fresh for final
 * fullAuthorityDone: the verifier must name the receipt it inspected. When the
 * current gate input digest is known, the verdict must also name that digest.
 */
export function partitionFreshWaveVerdicts(
  verdicts: AuthorityVerdictReceipt[],
  currentReceiptId: string,
  currentGateInputDigest?: string,
): FreshWavePartition {
  const current = currentReceiptId.trim();
  const currentGate = typeof currentGateInputDigest === 'string' ? currentGateInputDigest.trim() : '';
  const fresh: AuthorityVerdictReceipt[] = [];
  const stale: AuthorityVerdictReceipt[] = [];
  for (const verdict of verdicts) {
    const checked = typeof verdict.checkedReceiptId === 'string' ? verdict.checkedReceiptId.trim() : '';
    const checkedGate = typeof verdict.checkedGateInputDigest === 'string' ? verdict.checkedGateInputDigest.trim() : '';
    if (!current || !checked || checked !== current || (currentGate && checkedGate !== currentGate)) stale.push(verdict);
    else fresh.push(verdict);
  }
  return { fresh, stale, staleVerdictIds: stale.map(v => v.verdictId) };
}

function intFloor(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

function serverBackedVerdict(verdict: AuthorityVerdictReceipt): boolean {
  if (typeof verdict.signature === 'string' && /^[0-9a-fA-F]{128}$/.test(verdict.signature.trim())) return true;
  // Python Proofbound Authority returns server-stored HostVerdictRecord objects from
  // GET /v1/jobs/{jobId}/verdicts with a `receiptId` binding instead of inlining the
  // host_verdict receipt signature. Treat that receipt-bound server record as
  // server-backed for final wave counting; independence and acceptance are still
  // owned by the Authority reconciliation, and fullAuthorityDone still separately
  // requires a verified native gate_decision receipt.
  return typeof verdict.receiptId === 'string' && verdict.receiptId.trim().length > 0;
}

/**
 * Fail-closed overlay for server-backed final certification.
 *
 * The Authority still owns authentication and the job-level reconciliation, but the
 * CLI only treats a review wave as satisfied when the server-listed verdict records
 * prove the baseline floor: signed host_verdict records from at least two distinct
 * host identities in that wave, with no failing verdict in the wave. Repeated host
 * ids collapse through the Set and never inflate a wave.
 */
export function deriveSignedServerReviewWaveReconciliation(
  reconciliation: AuthorityVerdictReconciliation,
  verdicts: AuthorityVerdictReceipt[],
): AuthorityVerdictReconciliation {
  const requiredHostsPerWave = Math.max(
    MIN_FINAL_HOSTS_PER_REVIEW_WAVE,
    intFloor(reconciliation.requiredHostCount, MIN_FINAL_HOSTS_PER_REVIEW_WAVE),
  );
  const byWave = new Map<string, { passingHosts: Set<string>; failing: boolean }>();
  for (const verdict of verdicts) {
    const reviewWaveId = typeof verdict.reviewWaveId === 'string' ? verdict.reviewWaveId.trim() : '';
    const hostId = typeof verdict.hostId === 'string' ? verdict.hostId.trim().toLowerCase() : '';
    if (!reviewWaveId || !hostId || !serverBackedVerdict(verdict)) continue;
    const wave = byWave.get(reviewWaveId) ?? { passingHosts: new Set<string>(), failing: false };
    if (verdict.decision === 'pass') {
      if (checkFinalHostReviewPromptDigest(verdict).ok) wave.passingHosts.add(hostId);
    } else {
      wave.failing = true;
    }
    byWave.set(reviewWaveId, wave);
  }
  const derivedRefs = [...byWave.entries()]
    .filter(([, wave]) => !wave.failing && wave.passingHosts.size >= requiredHostsPerWave)
    .map(([ref]) => ref);
  const reportedSatisfied =
    typeof reconciliation.satisfiedReviewWaveCount === 'number' && Number.isFinite(reconciliation.satisfiedReviewWaveCount)
      ? Math.max(0, Math.floor(reconciliation.satisfiedReviewWaveCount))
      : derivedRefs.length;
  return {
    ...reconciliation,
    requiredHostCount: Math.max(reconciliation.requiredHostCount, requiredHostsPerWave),
    satisfiedReviewWaveCount: Math.min(reportedSatisfied, derivedRefs.length),
    reviewWaveRefs: derivedRefs,
  };
}

export interface AuthorityCertificationInput {
  /** Authority-computed reconciliation over the job's verdict records (server owns it). */
  reconciliation: AuthorityVerdictReconciliation;
  /** Whether a per-run native gate_decision receipt was verified by the CLI. */
  receiptVerified: boolean;
  receiptId?: string;
  /** §X9 disagreement protocol; defaults to `block`. */
  disagreementBehavior?: DisagreementBehavior;
  /** Verdict ids that are stale for the current wave (see partitionFreshWaveVerdicts). */
  staleVerdictIds?: string[];
}

export interface AuthorityCertificationView {
  schemaVersion: 'lattice.authority_certification.v1';
  /** Per-run authority DONE: a verified native gate_decision receipt for this run. */
  authorityDone: boolean;
  receiptVerified: boolean;
  receiptId?: string;
  /** Server-satisfied independent-host reconciliation (the multi-host wave passed). */
  multiHostVerified: boolean;
  independentHosts: number;
  requiredHosts: number;
  passingIndependentHosts: number;
  failingIndependentHosts: number;
  satisfiedReviewWaves: number;
  requiredReviewWaves: number;
  reviewWaveRefs: string[];
  staleVerdicts: number;
  /** fullAuthorityDone = authorityDone AND multiHostVerified AND no stale/failing. */
  fullAuthorityDone: boolean;
  status: 'pass' | 'blocked';
  blockedReason?: string;
  nextAction?: string;
}

/**
 * Combine legacy reconciliation with per-run receipt verification into a
 * compatibility release-certification view.
 *
 * fullAuthorityDone is true only when ALL hold:
 *   1. a verified per-run native gate_decision receipt (authorityDone);
 *   2. the server-computed reconciliation is satisfied (enough independent passing
 *      hosts, no failing verdict);
 *   3. three bounded host-check waves are satisfied;
 *   4. no verdict is stale for the current review wave.
 * Any disagreement or staleness blocks; `disagreementBehavior` only shapes the
 * recommended nextAction (stop vs repair_then_reverify). Independence is never
 * recomputed here — the server's reconciliation is authoritative; this overlay can
 * only ADD fail-closed blocks, never inflate the wave.
 */
export function reconcileAuthorityCertification(
  input: AuthorityCertificationInput,
): AuthorityCertificationView {
  const recon = input.reconciliation;
  const staleVerdicts = input.staleVerdictIds?.length ?? 0;
  const behavior: DisagreementBehavior = input.disagreementBehavior ?? 'block';
  const authorityDone = input.receiptVerified === true;
  const independentHosts = intFloor(recon.independentHostCount);
  const requiredHosts = Math.max(MIN_FINAL_HOSTS_PER_REVIEW_WAVE, intFloor(recon.requiredHostCount));
  const passingIndependentHosts = intFloor(recon.passingIndependentHostCount);
  const failingIndependentHosts = intFloor(recon.failingIndependentHostCount);
  const failing = failingIndependentHosts > 0;
  const hostQuorumSatisfied = independentHosts >= requiredHosts && passingIndependentHosts >= requiredHosts;
  const serverSatisfied = recon.satisfied === true && !failing && hostQuorumSatisfied;
  const requiredReviewWaves = Math.max(
    typeof recon.requiredReviewWaveCount === 'number' && Number.isFinite(recon.requiredReviewWaveCount)
      ? Math.floor(recon.requiredReviewWaveCount)
      : 0,
    REQUIRED_FINAL_HOST_CHECK_WAVES,
  );
  const satisfiedReviewWaves =
    typeof recon.satisfiedReviewWaveCount === 'number' && Number.isFinite(recon.satisfiedReviewWaveCount)
      ? Math.max(0, Math.floor(recon.satisfiedReviewWaveCount))
      : serverSatisfied
        ? 1
        : 0;
  const reviewWaveRefs = Array.isArray(recon.reviewWaveRefs)
    ? recon.reviewWaveRefs.filter((ref): ref is string => typeof ref === 'string' && ref.trim() !== '')
    : [];
  const reviewWavesSatisfied = satisfiedReviewWaves >= requiredReviewWaves;
  const multiHostVerified = serverSatisfied && reviewWavesSatisfied && staleVerdicts === 0;
  const fullAuthorityDone = authorityDone && multiHostVerified;
  const status: 'pass' | 'blocked' = fullAuthorityDone ? 'pass' : 'blocked';

  let blockedReason: string | undefined;
  let nextAction: string | undefined;
  if (!fullAuthorityDone) {
    if (failing) {
      blockedReason = `multi_host_disagreement: ${recon.failingIndependentHostCount} independent host verdict(s) failed`;
      nextAction =
        behavior === 'repair_then_reverify'
          ? 'return Story to DEV, run repair steps, then re-validate, request and verify a fresh gate_decision receipt, and start a fresh review wave over the new chain (§X9)'
          : 'stop blocked with the failing verdict ids and findings; certification is blocked on multi-host disagreement (§X9)';
    } else if (staleVerdicts > 0) {
      blockedReason = `stale_review_wave_after_repair: ${staleVerdicts} verdict(s) checked a prior receipt; a fresh receipt requires fresh verifier verdicts over the new chain`;
      nextAction = 'collect fresh independent host verdicts that check the current gate_decision receipt before certifying (§X9)';
    } else if (!authorityDone) {
      blockedReason = 'local_assurance_incomplete: legacy fullAuthorityDone is not a live completion target; current assurance requires local proof-admissibility, receipt-bundle, and quorum evidence';
      nextAction = 'record fresh local proof-admissibility, receipt-bundle, and quorum evidence before any stronger DONE assurance claim';
    } else if (serverSatisfied && !reviewWavesSatisfied) {
      blockedReason = `insufficient_review_waves: requires ${requiredReviewWaves} satisfied final host-check wave(s), have ${satisfiedReviewWaves}`;
      nextAction = 'run the remaining final host-check waves over the same final anchors before claiming fullAuthorityDone (§X9)';
    } else {
      blockedReason = `insufficient_independent_hosts: requires ${requiredHosts} passing independent host verdict(s), have ${passingIndependentHosts}`;
      nextAction = 'collect additional independent verifier host verdicts before certifying (§X9)';
    }
  }

  return {
    schemaVersion: 'lattice.authority_certification.v1',
    authorityDone,
    receiptVerified: authorityDone,
    receiptId: input.receiptId,
    multiHostVerified,
    independentHosts,
    requiredHosts,
    passingIndependentHosts,
    failingIndependentHosts,
    satisfiedReviewWaves,
    requiredReviewWaves,
    reviewWaveRefs,
    staleVerdicts,
    fullAuthorityDone,
    status,
    blockedReason,
    nextAction,
  };
}
