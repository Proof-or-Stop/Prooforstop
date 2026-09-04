
import { existsSync } from 'fs';
import { isAbsolute, join } from 'path';
import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import { execSync } from 'child_process';
import { checkEvidenceFreshnessForGit, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import type { ChecklistData, ChecklistItem, ChecklistStatus, FrozenClaimSnapshot, StoryInfo, VerificationEvidence, VerificationExecutionReceipt, VerificationIntent, VerificationIntentItem, VerificationIntentPin, VerificationIntentType, VerificationLane, VerificationPinNarrowingRecord } from '../core/types.js';
import { claimDigest } from '../core/frozen-claim-drift.js';
import { buildVerificationCoverage, collectRecordedPinnedReceipts, collectVerificationIntents, computeRecordedReceiptSetDigest, detectEvidenceRowContradiction, evaluateSelectorNarrowing, isExecutableIntentType, makeEvidence, NARROWING_TAIL_BOUNDED_NOTE, renderVerificationPinNarrowCommand, VERIFICATION_LANES, VERIFICATION_PIN_NARROWING_PRECONDITION } from '../core/verification.js';
import { DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS, EVIDENCE_COMMAND_TIMEOUT_CAP_MS, parseAllowlistedCommand, runSingleAllowlistedCommand, type SingleCommandExecutionResult } from '../core/validation-executor.js';
import { configuredValidationCommands } from './verifier.js';
import { createHash } from 'crypto';
import { isDeliveredChecklistStatus, isTerminalChecklistStatus, isWithdrawnChecklistStatus } from '../core/checklist-status.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { withMkdirLock } from '../core/mkdir-lock.js';
import { effectiveExcludedKeywords, normalizeBoundaryArray, scanExcludedKeywordHits } from '../core/scope-anti-expansion.js';
import type { ScopeFreezeTextSource } from '../core/types.js';
import { resolveAgentMutationAuthority } from '../core/agent-dispatch-registry.js';
import {
  isAcceptanceMatrixDerivedEvidence,
  plannedPathDeclarationSnapshot,
  validatePlannedPathDeclarationsForChecklistItem,
  verificationIntentHasPlannedPathDeclarations,
} from '../core/acceptance-topology.js';
import { BRAND_ENV_PREFIX, readBrandEnv } from '../core/brand-env.js';

const INIT_REVIEWER_CHECKLIST_MUTATION_BLOCKED_AGENTS = new Set([
  'proof-or-stop-review-story-init',
  'product-reviewer',
]);

type VerificationEvidenceKindInput = VerificationEvidence['kind'] | 'cli' | 'logic';
type VerificationEvidenceInput = Omit<VerificationEvidence, 'kind'> & { kind: VerificationEvidenceKindInput };
type ChecklistGetArgs = { storyId: string; slim?: boolean; fields?: string[] };

/**
 * Resolve the configured validate.commands timeout for a pinned verification command.
 * An explicit, audited per-evidence override still takes precedence at the call site.
 */
export function resolvePinnedCommandTimeoutMs(root: string, command: string): number | undefined {
  const { executable, args } = parseAllowlistedCommand(command);
  const configured = configuredValidationCommands(root);
  const match = configured.find(
    candidate => candidate.command === executable
      && candidate.args.length === args.length
      && candidate.args.every((arg, index) => arg === args[index]),
  );
  return match?.timeoutMs;
}

function pickTopLevelFields<T extends Record<string, unknown>>(value: T, fields?: string[]): Partial<T> {
  const requested = (fields || []).map(field => field.trim()).filter(Boolean);
  if (requested.length === 0) return value;
  const selected: Partial<T> = {};
  for (const field of requested) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      selected[field as keyof T] = value[field as keyof T];
    }
  }
  return selected;
}

function verificationIntentCounts(intent: VerificationIntent | undefined): Record<VerificationLane, number> & { total: number; must: number } {
  let total = 0;
  let must = 0;
  const counts = {
    happy: intent?.happy?.length ?? 0,
    edge: intent?.edge?.length ?? 0,
    adversarial: intent?.adversarial?.length ?? 0,
  };
  for (const lane of VERIFICATION_LANES) {
    total += counts[lane];
    must += (intent?.[lane] || []).filter(item => item.priority === 'must').length;
  }
  return { ...counts, total, must };
}

function verificationEvidenceCounts(evidence: VerificationEvidence[] | undefined): {
  total: number;
  passing: number;
  failing: number;
  waivers: number;
} {
  const list = evidence || [];
  return {
    total: list.length,
    passing: list.filter(item => item.kind !== 'waiver' && item.result !== 'fail').length,
    failing: list.filter(item => item.result === 'fail').length,
    waivers: list.filter(item => item.kind === 'waiver').length,
  };
}

export function summarizeChecklist(cl: ChecklistData): {
  total: number;
  done: number;
  inProgress: number;
  pending: number;
  withdrawn: number;
} {
  return {
    total: cl.items.length,
    // B-1909 CHK-002: `done` stays DELIVERED-only (never counts withdrawn); a
    // withdrawn item is terminal-but-not-delivered and gets its own count.
    done: cl.items.filter(item => isDeliveredChecklistStatus(item.status)).length,
    inProgress: cl.items.filter(item => item.status === 'in_progress').length,
    pending: cl.items.filter(item => item.status === 'pending').length,
    withdrawn: cl.items.filter(item => isWithdrawnChecklistStatus(item.status)).length,
  };
}

export function renderSlimChecklist(storyId: string, cl: ChecklistData): Record<string, unknown> {
  return {
    storyId,
    counts: summarizeChecklist(cl),
    items: cl.items.map(item => ({
      id: item.id,
      title: item.title,
      status: item.status,
      verificationIntent: verificationIntentCounts(item.verificationIntent),
      verificationEvidence: verificationEvidenceCounts(item.verificationEvidence),
    })),
  };
}

/**
 * B-6812 CHK-001: delegates to the shared `withMkdirLock` primitive.
 *
 * B-d877 R3 FIX B: the lock dir is relocated OUT of the git-tracked story dir to
 * the gitignored shared `.proof-or-stop/locks/checklist/<id>-checklist.lock` so the
 * universal holder.json can never be committed inside `.proof-or-stop/story/actives/`
 * and dirty the tree. External behavior (mutual exclusion) is unchanged.
 */
function withChecklistLock<T>(ctx: HandlerContext, storyId: string, fn: () => T): T {
  const lockDir = ctx.store.runtimeLockDirPath(storyId, 'checklist', 'checklist');
  return withMkdirLock(lockDir, fn, { label: 'checklist metadata' });
}

/**
 * B-45ed CHK-008: Given a storyId, return the relative path if background.md exists, otherwise return null.
 */
function resolveBackgroundPath(root: string, store: HandlerContext['store'], storyId: string): string | null {
  const rel = `${store.storyDirRel()}/${storyId}/background.md`;
  const abs = join(root, rel);
  return existsSync(abs) ? rel : null;
}

function assertChecklistMutationCwd(store: HandlerContext['store'], storyId: string): StoryInfo {
  const story = store.readStory(storyId);
  assertCwdInWorktree(store, storyId);
  return story;
}

function checklistActorFrom(args: { agent?: string; actor?: string }): string {
  const explicit = args.agent?.trim() || args.actor?.trim();
  if (explicit) return explicit;
  return readBrandEnv('AGENT')?.trim() || process.env.USER?.trim() || 'main-agent';
}

function isInitReviewerChecklistActor(actor: string): boolean {
  return INIT_REVIEWER_CHECKLIST_MUTATION_BLOCKED_AGENTS.has(actor.trim());
}

function assertInitReviewerChecklistMutationAllowed(args: {
  story: StoryInfo;
  command: 'checklist_add' | 'checklist_update';
  actor: string;
  mutatesDefinition: boolean;
}): void {
  if (args.story.phase !== 'INIT') return;
  if (!args.mutatesDefinition) return;
  if (!isInitReviewerChecklistActor(args.actor)) return;
  throw new Error(
    `${args.command} refused: INIT reviewer lane "${args.actor}" cannot directly modify checklist title/context/excludes in INIT. [init_reviewer_checklist_mutation_blocked]\n` +
    `→ Record requested expansion with scope_extension_proposal; the main agent may then accept/reject via scope_extension_decide and rerun scope_freeze_check.`,
  );
}

function assertChecklistScopeChangeAllowed(
  store: HandlerContext['store'],
  storyId: string,
  change: { itemId?: string; title?: string; context?: string; excludes?: string[] },
): void {
  const explicitExcludes = normalizeBoundaryArray(change.excludes);
  let scopeBoundary;
  try {
    scopeBoundary = store.readScopeBoundary(storyId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot update checklist: scope-boundary.json could not be read. [scope_boundary_unreadable]\n  - ${msg}`);
  }

  const keywords = normalizeBoundaryArray([
    ...effectiveExcludedKeywords(scopeBoundary, scopeBoundary?.mode ?? 'custom'),
    ...explicitExcludes,
  ]);
  if (keywords.length === 0) return;

  const sources: ScopeFreezeTextSource[] = [];
  if (change.title !== undefined) {
    sources.push({ source: 'checklist.title', text: change.title, ...(change.itemId ? { itemId: change.itemId } : {}) });
  }
  if (change.context !== undefined) {
    sources.push({ source: 'checklist.context', text: change.context, ...(change.itemId ? { itemId: change.itemId } : {}) });
  }
  for (const excluded of explicitExcludes) {
    sources.push({ source: 'checklist.excludes', text: excluded, ...(change.itemId ? { itemId: change.itemId } : {}), excluded: true });
  }
  if (sources.length === 0) return;

  const hit = scanExcludedKeywordHits(sources, keywords).find(item => !item.excluded);
  if (!hit) return;
  const itemRef = hit.itemId ? ` (${hit.itemId})` : '';
  throw new Error(
    `checklist change includes excluded scope keyword "${hit.keyword}" in ${hit.source}${itemRef}. [excluded_keyword_in_checklist]\n` +
    `→ Keep excluded directions in excludes, or route expansion through scope_extension_proposal and explicit scope_extension_decide.`,
  );
}

function hasMilestoneLedgerArtifact(store: HandlerContext['store'], storyId: string): boolean {
  try {
    return store.readMilestoneLedger(storyId) !== null;
  } catch {
    return existsSync(store.storyFilePath(storyId, 'milestone-ledger.json'));
  }
}

function checklistAddMilestoneLedgerAdvisory(storyId: string, itemId: string): string {
  return `Advisory: milestone ledger exists for ${storyId}; if this new checklist item (${itemId}) changes milestone coverage, update/sync the ledger with \`proof-or-stop milestone_ledger_add\` or an explicit ledger update.`;
}

export function assertChecklistAddAllowed(
  store: HandlerContext['store'],
  args: {
    storyId: string;
    title: string;
    context?: string;
    excludes?: string[];
    reason?: string;
    agent?: string;
    actor?: string;
  },
): StoryInfo {
  if (!args.title) throw new Error('title is required');

  const story = assertChecklistMutationCwd(store, args.storyId);
  if (story.phase === 'PLAN' && (!args.reason || args.reason.trim().length < 10)) {
    throw new Error('checklist_add in PLAN phase must provide reason ≥ 10 characters as a replan/scope audit signal, to prevent bypassing title/context freeze');
  }
  assertInitReviewerChecklistMutationAllowed({
    story,
    command: 'checklist_add',
    actor: checklistActorFrom(args),
    mutatesDefinition: true,
  });
  assertChecklistScopeChangeAllowed(store, args.storyId, {
    title: args.title,
    context: args.context,
    excludes: args.excludes,
  });
  return story;
}

/**
 * B-75f0 CHK-001: gitCwd is the RESOLVED git invocation cwd (wrapper-root aware);
 * metadataRoot is the config-load root for the storyDir-aware metadata exclusion.
 * Callers thread resolveGitCwd(...) at the handler boundary (where store +
 * args.storyId live). On a wrapper-root layout (metadataRoot != gitRoot) the bare
 * metadataRoot is not a git repo, so the old `git rev-parse HEAD` / git ls-tree
 * from there errored and BOTH freshness hashes were silently omitted. For a plain
 * repo (metadataRoot == gitRoot) resolveGitCwd returns root and metadataRoot
 * defaults to gitCwd, so the hashes are byte-identical to before.
 */
function evidenceHashes(gitCwd: string, metadataRoot: string = gitCwd): { headHash?: string; materialHash?: string; storyFilesHash?: string } {
  let headHash = '';
  try {
    headHash = execSync('git rev-parse HEAD', { cwd: gitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { /* PROBE: non-git or unavailable, omit freshness hash */ }
  const materialHash = currentMaterialHash(gitCwd, 'HEAD', metadataRoot);
  const storyFilesHash = currentStoryFilesHash(gitCwd, 'HEAD', metadataRoot);
  return {
    ...(headHash ? { headHash } : {}),
    ...(materialHash ? { materialHash } : {}),
    ...(storyFilesHash ? { storyFilesHash } : {}),
  };
}

/**
 * B-2296 CHK-002: pin an immutable {@link FrozenClaimSnapshot} onto a checklist item at
 * the status→done attestation transition, capturing the item's `userSees` claim digest
 * bound to the current story-owned material (storyFilesHash, the drift-authoritative field)
 * + git HEAD. Mutates `item` in place; returns true when a snapshot was written.
 *
 * DEFENSIVE — this NEVER throws: a snapshot failure must never break checklist_update.
 * Skips (no snapshot, returns false) when:
 *   - the item already has a `userSeesSnapshot` (immutable-once, mirroring the B-ec67
 *     pin-once model — a snapshot is never re-taken on a re-persist or read), OR
 *   - `userSees` is empty/absent (no frozen claim to snapshot), OR
 *   - a required hash / git value cannot be computed (prefer skipping over a partial /
 *     garbage snapshot: storyFilesHash is the drift signal and headHash anchors provenance).
 */
function captureUserSeesSnapshot(item: ChecklistItem, gitCwd: string, metadataRoot: string): boolean {
  try {
    if (item.userSeesSnapshot) return false; // immutable-once
    const userSees = item.userSees;
    if (!userSees || userSees.trim().length === 0) return false; // no claim to snapshot
    const hashes = evidenceHashes(gitCwd, metadataRoot);
    // storyFilesHash is drift-authoritative and headHash anchors provenance; without BOTH
    // a snapshot would be partial — skip rather than pin a garbage snapshot.
    if (!hashes.storyFilesHash || !hashes.headHash) return false;
    const snapshot: FrozenClaimSnapshot = {
      normalizedClaimDigest: claimDigest(userSees),
      storyFilesHash: hashes.storyFilesHash,
      headHash: hashes.headHash,
      attestedAt: new Date().toISOString(),
      ...(hashes.materialHash ? { materialHash: hashes.materialHash } : {}),
    };
    item.userSeesSnapshot = snapshot;
    return true;
  } catch {
    // Defensive: a snapshot failure must never break checklist_update.
    return false;
  }
}

function normalizeEvidenceKind(kind: VerificationEvidenceKindInput): VerificationEvidence['kind'] {
  if (kind === 'cli') return 'manual_transcript';
  if (kind === 'logic') return 'logic_test';
  return kind;
}

function normalizeEvidence(gitCwd: string, metadataRoot: string, input: VerificationEvidenceInput): VerificationEvidence {
  assertEvidenceIsNotAcceptanceMatrixProjection(input);
  const hashes = evidenceHashes(gitCwd, metadataRoot);
  const kind = normalizeEvidenceKind(input.kind);
  return makeEvidence({
    intentRef: input.intentRef,
    kind,
    ...(input.verdict ? { verdict: input.verdict } : {}),
    ...(input.waiverType ? { waiverType: input.waiverType } : {}),
    ...(input.file ? { file: input.file } : {}),
    ...(input.command ? { command: input.command } : {}),
    ...(input.result ? { result: input.result } : {}),
    note: input.note.trim(),
    headHash: input.headHash || hashes.headHash,
    materialHash: input.materialHash || hashes.materialHash,
    storyFilesHash: input.storyFilesHash || hashes.storyFilesHash,
    ...(input.attestation ? { attestation: input.attestation } : {}),
    // B-ec67 F-007/F-008: preserve the tool-execution provenance on re-persist so a valid
    // mechanical receipt or audited attestation survives a checklist_update bulk set
    // (previously dropped, which silently demoted an already-earned receipt to
    // mechanical:undefined and re-grandfathered it as covered). NOTE: for the
    // checklist_update path these fields are UNTRUSTED if caller-supplied — they arrive
    // here only after carryForwardOnDiskProvenance has replaced them with the PRESERVED
    // on-disk provenance (or stripped them). verification_evidence_add/_batch_add pass the
    // freshly enforced/stamped receipt directly. Either way input.* is trusted at this point.
    ...(input.mechanical !== undefined ? { mechanical: input.mechanical } : {}),
    ...(input.receipt ? { receipt: input.receipt } : {}),
    ...(input.nonMechanicalReason ? { nonMechanicalReason: input.nonMechanicalReason } : {}),
  });
}

function assertEvidenceIsNotAcceptanceMatrixProjection(input: { kind?: string; command?: string; note?: string }): void {
  if (!isAcceptanceMatrixDerivedEvidence(input)) return;
  throw new Error(
    'verification evidence refused: acceptance_matrix output is an L0 read-only projection and cannot satisfy verification or gate authority [acceptance_matrix_non_evidentiary_projection]',
  );
}

// ── B-ec67: tool-executed, selector-bearing evidence receipts ────────────────
// One shared enforce-and-stamp helper reached by BOTH verification_evidence_add
// and verification_evidence_batch_add so neither write path is an unguarded bypass.

const VERIFICATION_OUTPUT_TAIL_CHARS = 4000;
const MIN_NON_MECHANICAL_ESCAPE_REASON = 30;

// ── B-cdf6 (B-META F-012): bounded, audited per-evidence command timeout override ──
//
// PROBLEM: a verification intent whose proof IS "the root DONE-blocking suite passes"
// could not be witnessed by a tool-executed receipt. Every production call site ran the
// pinned command under DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS (270s) while that suite takes
// 21-24 min, so the run was KILLED mid-flight, no verdict line was ever printed, and the
// refusal named only [receipt_selector_absent] — a multi-attempt guessing game with no
// hint that a ceiling existed. The framework already knows this command legitimately
// needs longer: proof-or-stop.config.json gives the same `npm test` a 7200000ms budget as a
// DONE-required command. Only the evidence path disagreed.
//
// FIX (two parts): (1) a DISTINCT [receipt_command_timeout] refusal naming the elapsed
// budget, so a killed run is diagnosable in one line; (2) this bounded override so a
// legitimately long witness can earn a REAL receipt.
//
// The cap is exactly the value proof-or-stop.config.json already uses for the DONE-required
// root suite. Above the cap is REFUSED, never silently clamped — a caller who asked for
// more than the framework's own longest sanctioned budget has a design problem the tool
// must not paper over. The cap is imported from validation-executor.ts (the single source
// of truth shared with the Zod bound in command-catalog.ts) so the schema's first line of
// defense and this runtime re-validation can never drift apart.
const MAX_EVIDENCE_COMMAND_TIMEOUT_MS = EVIDENCE_COMMAND_TIMEOUT_CAP_MS;
/** Same floor as nonMechanicalReason: a raised budget is exceptional and must explain itself. */
const MIN_COMMAND_TIMEOUT_REASON = 30;

/**
 * B-cdf6 (B-META F-012): validate the audited timeout-override pair at the handler
 * entry. Per CLAUDE.md's Handler coding convention the Zod `.int().positive().max()` /
 * `.min(30)` constraints are only the FIRST line of defense: this runs on EVERY path
 * (CLI JSON, internal fn call, old JSON) so a bypassing payload is still rejected.
 *
 * Returns the effective ceiling (undefined = use the executor default), or throws.
 */
function resolveEvidenceCommandTimeout(
  label: string,
  input: { commandTimeoutMs?: number; commandTimeoutReason?: string },
): { timeoutMs: number; reason: string } | undefined {
  const raw = input.commandTimeoutMs;
  const reason = input.commandTimeoutReason?.trim() || '';

  if (raw === undefined || raw === null) {
    // A reason with no raised budget is a caller mistake worth naming: silently dropping
    // it would record an audit trail for an override that never happened.
    if (reason.length > 0) {
      throw new Error(
        `${label}: commandTimeoutReason was supplied without commandTimeoutMs — there is no raised budget to justify. ` +
        `Pass commandTimeoutMs (≤ ${MAX_EVIDENCE_COMMAND_TIMEOUT_MS}ms) or drop the reason. [command_timeout_reason_without_override]`,
      );
    }
    return undefined;
  }

  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(
      `${label}: commandTimeoutMs must be a positive integer number of milliseconds, got ${JSON.stringify(raw)} ` +
      `[command_timeout_invalid]`,
    );
  }
  if (raw > MAX_EVIDENCE_COMMAND_TIMEOUT_MS) {
    throw new Error(
      `${label}: commandTimeoutMs ${raw}ms exceeds the ${MAX_EVIDENCE_COMMAND_TIMEOUT_MS}ms cap (the longest budget the ` +
      `framework itself sanctions — proof-or-stop.config.json's DONE-required root suite). REFUSED rather than clamped: a ` +
      `witness that needs more than that is a design problem, not a budget problem. [command_timeout_above_cap]`,
    );
  }
  if (reason.length < MIN_COMMAND_TIMEOUT_REASON) {
    throw new Error(
      `${label}: raising the pinned command budget to ${raw}ms requires commandTimeoutReason ≥ ${MIN_COMMAND_TIMEOUT_REASON} ` +
      `characters explaining why this witness legitimately needs longer than the ${DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS}ms ` +
      `default. The reason is recorded on the receipt and is gate-visible. [command_timeout_reason_too_short]`,
    );
  }
  return { timeoutMs: raw, reason };
}

/**
 * B-cdf6 (B-META F-012): make a raised budget visible in the command's own stdout, not
 * only inside the persisted receipt, so an operator (and a reviewer reading a transcript)
 * sees at the moment of the write that this receipt was NOT earned under the default.
 */
/**
 * B-1482: render the selector the receipt was judged against. Returns '' for a receipt
 * written before B-1482, which genuinely has no recorded selector — the renderer must
 * not assume the field, and must not substitute the current pin for it.
 */
function renderReceiptSelectorNote(receipt: VerificationExecutionReceipt | undefined): string {
  const selector = receipt?.selector;
  if (!selector) return '';
  return ` selector=${JSON.stringify(selector)}`;
}

function renderTimeoutOverrideNote(receipt: VerificationExecutionReceipt | undefined): string {
  const override = receipt?.timeoutOverride;
  if (!override) return '';
  return `, timeoutOverride=${override.timeoutMs}ms (raised above the ${override.defaultTimeoutMs}ms default)`;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Bounded output tail (mirrors done-required-validation.ts:531 WITHOUT importing it). */
function boundedOutputTail(output: string): string {
  return output.length <= VERIFICATION_OUTPUT_TAIL_CHARS
    ? output
    : output.slice(output.length - VERIFICATION_OUTPUT_TAIL_CHARS);
}

/** Common shape of a single evidence write for the shared enforcement helper. */
interface EvidenceWriteInput {
  /**
   * B-1482 F-009: carried purely so a refusal can print a runnable narrowing command.
   * Optional because the stale-refresh path re-executes the pin itself and never
   * authors a mismatch; the rendered form falls back to a visible placeholder there.
   */
  storyId?: string;
  intentRef: string;
  kind: VerificationEvidence['kind'];
  command?: string;
  selector?: string;
  result?: 'pass' | 'fail';
  nonMechanicalReason?: string;
  /**
   * B-cdf6 (B-META F-012): bounded, audited raise of the pinned command's wall-clock
   * ceiling. Validated by {@link resolveEvidenceCommandTimeout} at the handler entry AND
   * re-checked inside {@link enforceAndStampEvidence} (the single enforcement boundary),
   * so no path — CLI, internal fn call, or batch entry — can arm an unjustified budget.
   */
  commandTimeoutMs?: number;
  commandTimeoutReason?: string;
}

/**
 * B-ec67: what the shared helper decides for one evidence write. `evidencePatch`
 * is merged into the makeEvidence args (result/mechanical/receipt/nonMechanicalReason);
 * `pin` is set on the intent (immutably) when the executable intent was pinned on this
 * first selector-bearing write.
 */
interface EnforceAndStampResult {
  evidencePatch: {
    result?: 'pass' | 'fail';
    command?: string;
    mechanical?: boolean;
    receipt?: VerificationExecutionReceipt;
    nonMechanicalReason?: string;
  };
  pin?: { lane: VerificationLane; index: number; verification: VerificationIntentPin };
}

/** Resolve intentRef → the intent on THIS item, aligned with the coverage gate's canonical ref. */
function resolveIntentForRef(
  item: ChecklistItem,
  intentRef: string,
): { lane: VerificationLane; index: number; intent: VerificationIntentItem } | undefined {
  const hit = collectVerificationIntents(item).find(c => c.ref === intentRef);
  return hit ? { lane: hit.lane, index: hit.index, intent: hit.intent } : undefined;
}

/**
 * B-ec67 F-008: caller-supplied tool-execution provenance is UNTRUSTED BY DESIGN.
 * The CLI schema (verificationEvidenceSchema, command-schemas.ts) explicitly .strip()s
 * mechanical / receipt / nonMechanicalReason, so a real `proof-or-stop checklist_update` caller
 * can never inject them (fabricating mechanical:true + a fake receipt to launder an
 * executable intent as covered = receipt injection). We ALSO drop any caller-supplied
 * provenance here so the internal fn-call path (which bypasses Zod) is protected the same.
 *
 * A tool-execution receipt / audited attestation therefore survives a checklist_update
 * re-persist (reordering the array, editing note/file/verdict metadata) ONLY by being
 * carried forward from the EXISTING on-disk evidence for the same intentRef — never from
 * the incoming row. A mechanical receipt is carried forward only when the caller does not
 * change the underlying evidence the receipt attests to (same command + same result); if
 * the caller changes command or result the stale receipt is dropped and the row is re-judged
 * as fresh (an executable intent then needs a real on-disk receipt or the guard refuses it).
 * This closes F-008's receipt-loss demotion (a legitimate re-persist previously stripped a
 * real receipt, silently re-grandfathering it) without opening a caller-receipt injection path.
 */
function carryForwardOnDiskProvenance(
  existing: readonly VerificationEvidence[] | undefined,
  incoming: VerificationEvidenceInput,
): VerificationEvidenceInput {
  // Discard caller-supplied provenance up front (untrusted-by-design).
  const { mechanical: _callerMechanical, receipt: _callerReceipt, nonMechanicalReason: _callerReason, ...trusted } = incoming;
  const prior = existing?.find(e => e.intentRef === incoming.intentRef);
  if (!prior || prior.mechanical === undefined) return trusted; // no prior, or legacy/undefined provenance: nothing to carry
  if (prior.mechanical === true) {
    // A receipt is bound to a specific command execution; carry it forward only when the
    // caller re-persists the SAME command + result (does not change the underlying evidence).
    const sameCommand = (incoming.command ?? undefined) === (prior.command ?? undefined);
    const sameResult = (incoming.result ?? undefined) === (prior.result ?? undefined);
    if (prior.receipt && sameCommand && sameResult) {
      return { ...trusted, mechanical: true, receipt: prior.receipt };
    }
    return trusted; // command/result changed → stale receipt dropped, row re-judged as fresh
  }
  // prior.mechanical === false → audited non-mechanical attestation; carry forward the
  // on-disk reason so a re-persist of an audited-escape row stays attributable (still
  // demoted by the coverage gate for executable intents).
  return {
    ...trusted,
    mechanical: false,
    ...(prior.nonMechanicalReason ? { nonMechanicalReason: prior.nonMechanicalReason } : {}),
  };
}

/**
 * B-ec67 F-007: guard for checklist_update's bulk `verificationEvidence` setter — the
 * THIRD evidence write path, which does NOT run the pinned command. For an EXECUTABLE
 * intent (logic|cli|browser) it refuses any incoming row that is not already a valid
 * mechanical receipt (mechanical:true + receipt) or an audited non-mechanical attestation
 * (mechanical:false + nonMechanicalReason ≥ N), so a raw fabricated result:pass row can
 * never be laundered as covered through this path. Rows that cannot launder executable
 * coverage are left alone: non-executable (manual|docs) intents, waivers, explicit fails,
 * and refs that do not resolve to an intent on this item. Callers with real executable
 * evidence are directed to verification_evidence_add / verification_evidence_batch_add,
 * which are the single enforcement boundary that actually executes the command.
 *
 * B-ec67 F-008 precision: the `ev` inspected here is the EFFECTIVE row produced by
 * carryForwardOnDiskProvenance — its mechanical / receipt / nonMechanicalReason reflect the
 * PRESERVED on-disk provenance for this intentRef, NEVER a caller-supplied value (those are
 * untrusted-by-design: .strip()ped by the CLI schema and dropped for the internal fn path).
 * So the accept branch keys off a REAL on-disk receipt and is reachable via the real CLI
 * only when re-persisting an intent that already earned one; a fabricated caller receipt has
 * been stripped to undefined here, leaving a raw executable row that is refused below.
 */
function assertChecklistUpdateEvidenceRowAllowed(item: ChecklistItem, ev: VerificationEvidenceInput): void {
  const resolved = resolveIntentForRef(item, ev.intentRef);
  // A ref that does not resolve to an intent on this item covers nothing at the gate,
  // and manual|docs intents are attestation-only — neither can launder executable coverage.
  if (!resolved || !isExecutableIntentType(resolved.intent.type)) return;
  if (normalizeEvidenceKind(ev.kind) === 'waiver') return; // explicit exemption, tracked separately
  if (ev.result === 'fail') return;                        // an explicit failure never launders coverage
  if (ev.mechanical === true) {
    if (!ev.receipt) {
      throw new Error(
        `checklist_update refused: verificationEvidence row for executable intent ${ev.intentRef} claims mechanical:true ` +
        `but carries no execution receipt. Record it through verification_evidence_add / verification_evidence_batch_add ` +
        `(which runs the pinned command and stamps the receipt). [checklist_update_evidence_receipt_missing]`,
      );
    }
    return;
  }
  if (ev.mechanical === false) {
    const reason = ev.nonMechanicalReason?.trim() || '';
    if (reason.length < MIN_NON_MECHANICAL_ESCAPE_REASON) {
      throw new Error(
        `checklist_update refused: verificationEvidence row for executable intent ${ev.intentRef} is a non-mechanical ` +
        `attestation (mechanical:false) but its nonMechanicalReason is missing or < ${MIN_NON_MECHANICAL_ESCAPE_REASON} characters. ` +
        `[checklist_update_evidence_reason_too_short]`,
      );
    }
    return;
  }
  // mechanical === undefined on an executable intent → a raw fabricated pass, OR a caller
  // receipt that was stripped as untrusted with no preserved on-disk receipt to fall back
  // on. Refuse: checklist_update does not execute pinned commands, so it cannot mint one.
  throw new Error(
    `checklist_update refused: verificationEvidence row for executable intent ${ev.intentRef} (type ${resolved.intent.type}) ` +
    `is neither a tool-executed receipt (mechanical:true) nor an audited attestation (mechanical:false + nonMechanicalReason). ` +
    `checklist_update does not execute pinned commands; route executable-intent evidence through verification_evidence_add / ` +
    `verification_evidence_batch_add so the command is actually run. [checklist_update_executable_evidence_unenforced]`,
  );
}

/**
 * B-cdf6 (B-META F-012): the runner now carries the per-run `timeoutMs`. It was always
 * accepted by runSingleAllowlistedCommand but no production call site forwarded one, so
 * every pinned evidence command silently ran under the 270s default. `undefined` means
 * "use the executor default" — the byte-identical pre-B-cdf6 behavior.
 */
type SingleCommandRunner = (command: string, cwd: string, timeoutMs?: number) => Promise<SingleCommandExecutionResult>;

/**
 * B-ec67 — THE single enforcement boundary for a verification-evidence write, called
 * by both single and batch handlers. Behavior:
 *   a. Resolve the intent; refuse if intentRef does not map to an intent on the item.
 *   b. Determine executable: logic|cli|browser vs attestation-only manual|docs.
 *   c. Executable + (selector provided OR intent already pinned) → mechanical path:
 *        PIN (immutable): first write sets verification from command+selector (both
 *        required); a later write's command must equal the pinned command (else
 *        receipt-command-mismatch); selector likewise immutable.
 *        EXECUTE the pinned command; refuse when pass is claimed but exit != 0, or the
 *        pinned selector is absent from output. Derive result FROM the receipt.
 *        Stamp the receipt {exitCode,outputDigest,outputTail,selectorMatched,selector,executedAt}.
 *   d. Executable + audited escape (nonMechanicalReason ≥ 30) → record non-mechanical,
 *        attributable, no execution (still demoted by the coverage gate).
 *   e. Executable + no selector + no pin + no escape → REFUSED (B-ec67 F-006): a NEW
 *        executable write can never mint mechanical:undefined here (which the gate would
 *        grandfather as covered). The caller must supply a selector or a nonMechanicalReason.
 *        Pre-mechanism legacy rows keep 'covered' at the GATE only (loaded from disk).
 *   f. manual|docs intents → attestation-only, mechanical:false, no execution, no refuse.
 *   g. waiver kind → explicit exemption, no execution.
 */
async function enforceAndStampEvidence(
  item: ChecklistItem,
  input: EvidenceWriteInput,
  deps: { runCommand: SingleCommandRunner; cwd: string },
): Promise<EnforceAndStampResult> {
  const resolved = resolveIntentForRef(item, input.intentRef);
  if (!resolved) {
    throw new Error(
      `verification evidence refused: intentRef ${input.intentRef} does not resolve to a verificationIntent on ${item.id} [intent_ref_unresolved]`,
    );
  }
  const { lane, index, intent } = resolved;
  const callerCommand = input.command?.trim() || undefined;
  const callerSelector = input.selector?.trim() || undefined;
  const escapeReason = input.nonMechanicalReason?.trim() || undefined;
  // B-cdf6 (B-META F-012): re-validate the audited timeout override HERE, at the single
  // enforcement boundary, not only at the two handler entries. This is the consuming
  // point required by CLAUDE.md's Handler coding convention: an internal fn call or a
  // future third call site that skips the entry check still cannot arm an unjustified or
  // above-cap budget. Runs BEFORE the waiver / attestation-only early returns so an
  // invalid override is refused rather than silently ignored on a non-executing path.
  const timeoutOverride = resolveEvidenceCommandTimeout('verification evidence refused', input);

  // waiver: explicit exemption, never executed
  if (input.kind === 'waiver') {
    return { evidencePatch: {} };
  }

  // attestation-only intent types
  if (!isExecutableIntentType(intent.type)) {
    return {
      evidencePatch: {
        mechanical: false,
        ...(input.result ? { result: input.result } : {}),
        ...(callerCommand ? { command: callerCommand } : {}),
      },
    };
  }

  const existingPin = intent.verification;

  // Audited escape for an executable intent: record non-mechanical WITHOUT execution.
  if (escapeReason && !existingPin && !callerSelector) {
    if (escapeReason.length < MIN_NON_MECHANICAL_ESCAPE_REASON) {
      throw new Error(
        `verification evidence refused: nonMechanicalReason must be ≥ ${MIN_NON_MECHANICAL_ESCAPE_REASON} characters to record a non-mechanical attestation for executable intent ${input.intentRef} [non_mechanical_reason_too_short]`,
      );
    }
    return {
      evidencePatch: {
        mechanical: false,
        nonMechanicalReason: escapeReason,
        ...(input.result ? { result: input.result } : {}),
        ...(callerCommand ? { command: callerCommand } : {}),
      },
    };
  }

  // B-ec67 F-006: an executable intent's NEW evidence write MUST be either a
  // tool-executed receipt (a selector pins + runs the command → mechanical:true) OR
  // an audited non-mechanical attestation (nonMechanicalReason ≥ N → mechanical:false).
  // A write that supplies NEITHER is REFUSED. The old "legacy-shaped" branch returned
  // an un-flagged patch here, leaving mechanical:undefined — which the coverage gate
  // grandfathers as 'covered'. That let a caller author command+result:pass for a
  // never-executed command and be scored identically to a real receipt (the exact
  // F-045/F-049/F-050/F-061 fabrication class this story exists to eliminate). Refuse
  // it so the handler can NEVER mint mechanical:undefined for a new executable write.
  // Genuinely pre-mechanism legacy rows keep their historical 'covered' status at the
  // GATE only (they are loaded from disk, never re-minted through this write path), so
  // after this closure `mechanical === undefined` ⟺ genuine pre-B-ec67 legacy data.
  if (!existingPin && !callerSelector) {
    throw new Error(
      `verification evidence refused: executable intent ${input.intentRef} (type ${intent.type}) requires EITHER a selector ` +
      `(to pin + execute the command, producing a mechanical receipt) OR a nonMechanicalReason ≥ ${MIN_NON_MECHANICAL_ESCAPE_REASON} ` +
      `characters (an audited non-mechanical attestation). A caller-authored command/result with no execution and no attestation ` +
      `is not accepted — it would silently grandfather as covered. [executable_intent_requires_selector_or_reason]`,
    );
  }

  // Mechanical path: determine the immutable pinned command + selector.
  let pinCommand: string;
  let pinSelector: string;
  let pinToSet: EnforceAndStampResult['pin'];
  if (existingPin) {
    // B-1482 F-009/F-015: the mechanical floor a DIRECT caller hits (no PreToolUse hook
    // installed or firing) must teach the same route the advisory seatbelt teaches, from
    // the same shared renderer — otherwise the primary path keeps handing out the
    // categorical "immutable" claim this story falsified.
    const narrowForm = renderVerificationPinNarrowCommand({
      ...(input.storyId !== undefined ? { storyId: input.storyId } : {}),
      itemId: item.id,
      intentRef: input.intentRef,
    });
    if (!callerCommand) {
      throw new Error(
        `verification evidence refused: receipt-command-mismatch: expected ${existingPin.command}, got <none> (executable intent ${input.intentRef} is pinned; the command must be provided and match) [receipt_command_mismatch]`,
      );
    }
    if (callerCommand !== existingPin.command) {
      throw new Error(
        `verification evidence refused: receipt-command-mismatch: expected ${existingPin.command}, got ${callerCommand} ` +
        `(an evidence write never moves the pin, and the one audited movement — \`${narrowForm}\` — re-points the ` +
        `SELECTOR only, never the pinned command. ${VERIFICATION_PIN_NARROWING_PRECONDITION}) [receipt_command_mismatch]`,
      );
    }
    if (callerSelector && callerSelector !== existingPin.selector) {
      throw new Error(
        `verification evidence refused: receipt-selector-mismatch: expected ${existingPin.selector}, got ${callerSelector} ` +
        `(an evidence write never moves the pin; the one audited movement is \`${narrowForm}\`. ` +
        `${VERIFICATION_PIN_NARROWING_PRECONDITION}) [receipt_selector_mismatch]`,
      );
    }
    pinCommand = existingPin.command;
    pinSelector = existingPin.selector;
  } else {
    // First selector-bearing write pins the intent; require BOTH command and selector.
    if (!callerCommand || !callerSelector) {
      throw new Error(
        `verification evidence refused: executable intent ${input.intentRef} requires BOTH command and selector to pin verification on the first evidence write [verification_pin_incomplete]`,
      );
    }
    pinCommand = callerCommand;
    pinSelector = callerSelector;
    pinToSet = { lane, index, verification: { command: pinCommand, selector: pinSelector } };
  }

  // Execute the pinned command; the receipt (not the caller) determines result.
  const run = await deps.runCommand(pinCommand, deps.cwd, timeoutOverride?.timeoutMs);
  // `!run.timedOut` is retained deliberately: the timeout refusal below already returns
  // for every timedOut run, so this is belt-and-braces should that ordering ever change.
  const exitOk = run.code === 0 && !run.timedOut;
  const selectorMatched = run.output.includes(pinSelector);

  // B-cdf6 (B-META F-012) — REFUSE FIRST, with a DISTINCT diagnosis: the runner KILLED
  // the pinned command at its wall-clock ceiling. This check MUST precede the selector
  // check: a killed run never got to print its verdict line, so the selector is trivially
  // absent and [receipt_selector_absent] would masquerade as "your selector is wrong" —
  // the exact multi-attempt guessing game F-012 records (three attempts refused at
  // ~270.3s, misdiagnosed first as a stdout capture problem, then as a clean-tree
  // assertion, before anyone read the executor and found the constant). Naming the budget
  // and the override turns that into a one-line diagnosis.
  if (run.timedOut) {
    const elapsed = Math.round(run.durationMs / 1000);
    const armed = run.timeoutMs;
    const raiseHint = armed >= MAX_EVIDENCE_COMMAND_TIMEOUT_MS
      ? `That is already the ${MAX_EVIDENCE_COMMAND_TIMEOUT_MS}ms cap, so this witness cannot be raised further — shrink the ` +
        `pinned command (a focused suite / single verifier) instead of widening the budget.`
      : `If this witness legitimately needs longer, re-run with commandTimeoutMs (≤ ${MAX_EVIDENCE_COMMAND_TIMEOUT_MS}ms) plus a ` +
        `commandTimeoutReason ≥ ${MIN_COMMAND_TIMEOUT_REASON} characters; the raised budget is recorded on the receipt. NOTE: the ` +
        `outer CLI watchdog still applies (5 min without output / 15 min total by default), so a multi-minute silent command also ` +
        `needs ${BRAND_ENV_PREFIX}IDLE_TIMEOUT_MS / ${BRAND_ENV_PREFIX}MAX_TIMEOUT_MS raised for the same invocation.`;
    throw new Error(
      `verification evidence refused: pinned command was KILLED at its ${armed}ms wall-clock ceiling after ~${elapsed}s ` +
      `(exit ${run.code}) for ${input.intentRef}, so it never printed a verdict and NO receipt can be minted. ` +
      `This is a TIMEOUT, not a wrong selector${timeoutOverride ? ' (a raised budget was already in effect)' : ''}. ${raiseHint} ` +
      `[receipt_command_timeout]`,
    );
  }
  // Refuse: a caller cannot claim pass when the command did not exit 0.
  if (input.result === 'pass' && !exitOk) {
    throw new Error(
      `verification evidence refused: pinned command exited ${run.code} but result:pass was claimed for ${input.intentRef} [receipt_exit_nonzero]`,
    );
  }
  // Refuse: the pinned selector must appear in captured output (kills same-command,
  // wrong/absent-case false passes). Applies regardless of the caller's claimed result.
  if (!selectorMatched) {
    throw new Error(
      `verification evidence refused: pinned selector "${pinSelector}" not found in command output for ${input.intentRef} [receipt_selector_absent]`,
    );
  }

  const receipt: VerificationExecutionReceipt = {
    exitCode: run.code,
    outputDigest: sha256Hex(run.output),
    outputTail: boundedOutputTail(run.output),
    selectorMatched,
    // B-1482: stamp the selector text beside the match verdict, so the receipt records
    // WHAT it was judged against and not merely THAT something matched. Taken from the
    // pin actually executed above (never from the caller — this block is inside the
    // tool-owned receipt that every caller-facing schema strips).
    selector: pinSelector,
    executedAt: new Date().toISOString(),
    // B-cdf6 (B-META F-012): always stamp the armed ceiling, and — only when the caller
    // RAISED it — an attributable override block, so a reviewer reading the receipt can
    // see this pass was earned under a raised budget rather than the default. Lives in
    // the tool-owned receipt, which every caller-facing schema strips, so it can never be
    // caller-injected onto a receipt actually earned under the default.
    timeoutMs: run.timeoutMs,
    ...(timeoutOverride
      ? {
          timeoutOverride: {
            timeoutMs: timeoutOverride.timeoutMs,
            defaultTimeoutMs: DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS,
            reason: timeoutOverride.reason,
          },
        }
      : {}),
  };
  const derivedResult: 'pass' | 'fail' = exitOk && selectorMatched ? 'pass' : 'fail';

  return {
    evidencePatch: {
      result: derivedResult,
      command: pinCommand,
      mechanical: true,
      receipt,
    },
    ...(pinToSet ? { pin: pinToSet } : {}),
  };
}

/**
 * B-ec67: apply a pin decision onto the freshly-read item under the checklist lock,
 * re-checking immutability so a concurrent writer cannot silently change the pin.
 */
function applyVerificationPin(
  item: ChecklistItem,
  pin: { lane: VerificationLane; index: number; verification: VerificationIntentPin },
): void {
  const laneIntents = item.verificationIntent?.[pin.lane];
  const intent = laneIntents?.[pin.index];
  if (!intent) {
    throw new Error(
      `verification evidence refused: intent ${item.id}:${pin.lane}:${pin.index} vanished before the pin could be written [verification_pin_target_missing]`,
    );
  }
  if (intent.verification) {
    if (intent.verification.command !== pin.verification.command || intent.verification.selector !== pin.verification.selector) {
      throw new Error(
        `verification evidence refused: receipt-command-mismatch: expected ${intent.verification.command}, got ${pin.verification.command} (the verification pin is immutable) [receipt_command_mismatch]`,
      );
    }
    return;
  }
  intent.verification = { command: pin.verification.command, selector: pin.verification.selector };
}

// ── B-1482: narrowing-only re-pin entry point ────────────────────────────────

/** Minimum length of the caller-supplied reason, matching the other audited escapes. */
const MIN_NARROWING_REASON = 30;

/** Exactly the fields a narrowing request may carry. Anything else is refused. */
const NARROWING_REQUEST_FIELDS = new Set(['storyId', 'itemId', 'intentRef', 'selector', 'reason']);

/**
 * Field names a caller might reach for to hand the tool an output, a transcript or a
 * receipt. None of them is an input: the proof reads recorded receipts only. They are
 * named explicitly so the refusal can say WHY rather than "unknown field".
 */
const NARROWING_INADMISSIBLE_OUTPUT_FIELDS = new Set([
  'transcript', 'transcripts', 'output', 'outputs', 'outputTail', 'tail',
  'stdout', 'stderr', 'log', 'logs', 'receipt', 'receipts', 'evidence', 'proof', 'run', 'runs',
]);

export interface VerificationPinNarrowingRequest {
  storyId: string;
  itemId: string;
  intentRef: string;
  /** The NEW, stricter selector. Accepted only when recorded receipts prove it stricter. */
  selector: string;
  /** Caller-supplied justification, retained on the record. Never a substitute for the proof. */
  reason: string;
}

/**
 * B-1482 — the ONLY way an evidence pin's selector may change, and it may change in
 * one direction only.
 *
 * Inputs are the story, the intent, the requested selector and a reason. There is no
 * transcript parameter, no output parameter and no receipt parameter, because a
 * caller-supplied rendering of a run could be fabricated; the proof is drawn entirely
 * from receipts this tool recorded (see `evaluateSelectorNarrowing`). A request that
 * carries such a field is refused before any proof is attempted, so it can never be
 * "considered and then ignored".
 *
 * The pinned COMMAND never changes here. Narrowing a selector answers "this pin matched
 * a failing run"; changing the command would be a different pin altogether and stays
 * refused by the existing immutability check.
 *
 * The bound: a recorded-receipt SET admits at most one narrowing. The set's digest is
 * retained on the accepted record and re-checked FIRST on every later request, so a
 * chain of narrowings cannot walk a pin down onto one hand-picked run without new
 * recorded evidence in between. Because a narrowing also requires a failing render
 * judged by the CURRENT pin, the new evidence that unlocks a second narrowing has to be
 * a genuine failing run that the narrowed selector still matched.
 */
export function narrowVerificationPin(ctx: HandlerContext, args: VerificationPinNarrowingRequest): string {
  const { store, root } = ctx;
  const raw = args as unknown as Record<string, unknown>;
  const offeredOutput = Object.keys(raw ?? {}).filter(key => NARROWING_INADMISSIBLE_OUTPUT_FIELDS.has(key));
  if (offeredOutput.length > 0) {
    throw new Error(
      `verification pin narrowing refused: ${offeredOutput.join(', ')} is not an input. A narrowing is proved ONLY from ` +
      `receipts this tool recorded for the pinned command; a caller-supplied transcript, output or receipt could be ` +
      `fabricated, so it is refused outright rather than weighed. [narrowing_caller_output_not_admissible]`,
    );
  }
  const unknownFields = Object.keys(raw ?? {}).filter(key => !NARROWING_REQUEST_FIELDS.has(key));
  if (unknownFields.length > 0) {
    throw new Error(
      `verification pin narrowing refused: unknown request field(s) ${unknownFields.join(', ')}; a narrowing request ` +
      `carries only ${[...NARROWING_REQUEST_FIELDS].join(', ')} [narrowing_unknown_input_field]`,
    );
  }
  const requestedSelector = (args.selector ?? '').trim();
  if (!requestedSelector) {
    throw new Error('verification pin narrowing refused: selector must be a non-empty string [narrowing_selector_empty]');
  }
  const reason = (args.reason ?? '').trim();
  if (reason.length < MIN_NARROWING_REASON) {
    throw new Error(
      `verification pin narrowing refused: reason must be at least ${MIN_NARROWING_REASON} characters explaining why the ` +
      `pinned selector is not discriminating; the reason is retained for audit and is never itself the proof ` +
      `[narrowing_reason_too_short]`,
    );
  }

  const gitCwd = resolveGitCwd({ store, storyId: args.storyId, metadataRoot: root, projectRoot: root });
  return withChecklistLock(ctx, args.storyId, () => {
    const cl = store.readChecklist(args.storyId);
    const item = cl.items.find(i => i.id === args.itemId);
    if (!item) throw new Error(`Checklist item ${args.itemId} not found`);
    const resolved = resolveIntentForRef(item, args.intentRef);
    if (!resolved) {
      throw new Error(
        `verification pin narrowing refused: intentRef ${args.intentRef} does not resolve to a verificationIntent on ${item.id} [intent_ref_unresolved]`,
      );
    }
    const { intent } = resolved;
    if (!isExecutableIntentType(intent.type)) {
      throw new Error(
        `verification pin narrowing refused: intent ${args.intentRef} is type ${intent.type}, which is attestation-only and carries no pin [narrowing_intent_not_executable]`,
      );
    }
    const pin = intent.verification;
    if (!pin) {
      throw new Error(
        `verification pin narrowing refused: intent ${args.intentRef} has no verification pin yet; the first selector-bearing evidence write pins it [narrowing_intent_not_pinned]`,
      );
    }

    const receipts = collectRecordedPinnedReceipts(cl, pin.command);
    const receiptSetDigest = computeRecordedReceiptSetDigest(receipts);
    const priorNarrowings = pin.narrowings ?? [];
    // The bound is checked BEFORE the proof, and deliberately so: a second narrowing
    // against unchanged receipts must be refused even when it WOULD be provable against
    // exactly those receipts. That is the whole point — repeated narrowing on one
    // recorded-receipt set is how a pin could be walked down onto a hand-picked run.
    const spent = priorNarrowings.find(record => record.receiptSetDigest === receiptSetDigest);
    if (spent) {
      throw new Error(
        `verification pin narrowing refused: this recorded-receipt set (${receiptSetDigest.slice(0, 12)}, ${receipts.length} receipt(s)) ` +
        `has already been narrowed once — ${JSON.stringify(spent.previousSelector)} to ${JSON.stringify(spent.selector)} at ${spent.narrowedAt}. ` +
        `A set of recorded receipts admits at most ONE narrowing; record new evidence (a failing render the CURRENT pin matched) ` +
        `before narrowing again. [narrowing_receipt_set_unchanged]`,
      );
    }

    const requestedAt = new Date().toISOString();
    const outcome = evaluateSelectorNarrowing({
      command: pin.command,
      previousSelector: pin.selector,
      selector: requestedSelector,
      receipts,
      requestedAt,
    });
    if (!outcome.ok) {
      throw new Error(`verification pin narrowing refused: ${outcome.message} [${outcome.code}]`);
    }

    const hashes = evidenceHashes(gitCwd, root);
    const record: VerificationPinNarrowingRecord = {
      previousSelector: pin.selector,
      selector: outcome.proof.selector,
      reason,
      command: pin.command,
      receiptSetDigest: outcome.proof.receiptSetDigest,
      failingReceiptIds: outcome.proof.failingReceiptIds,
      passingReceiptIds: outcome.proof.passingReceiptIds,
      materialKey: outcome.proof.materialKey,
      narrowedAt: requestedAt,
      ...hashes,
    };
    intent.verification = {
      command: pin.command,
      selector: outcome.proof.selector,
      narrowings: [...priorNarrowings, record],
    };
    store.writeChecklist(args.storyId, cl);
    const commitHint = autoCommitStoryMetadata(root, args.storyId, 'verification_pin_narrow');
    return (
      `Verification pin NARROWED for ${item.id} → ${args.intentRef}: selector ${JSON.stringify(record.previousSelector)} → ` +
      `${JSON.stringify(record.selector)} (pinned command unchanged: ${pin.command}). Reason: ${reason}. ` +
      `Proved from tool-recorded receipts only — failing render(s) the old selector matched: ${record.failingReceiptIds.join(', ')}; ` +
      `passing receipt(s) the new selector matches: ${record.passingReceiptIds.join(', ')}; ` +
      `recorded-receipt set ${record.receiptSetDigest.slice(0, 12)} (${receipts.length} receipt(s)), now spent — this set admits no further narrowing. ` +
      `${NARROWING_TAIL_BOUNDED_NOTE}${commitHint}`
    );
  });
}

/**
 * B-4e06 CHK-001: canonical structured intent ref — `CHK-001:happy:0`. Mirrors
 * verification.ts intentRef(). A ref scoped to an item
 * (`${item.id}:`) that does NOT match this is malformed → fail-closed.
 */
const STRUCTURED_INTENT_REF = /^(CHK-\d+):(happy|edge|adversarial):(\d+)$/;

/** Phases where verification_intent_repair is refused: pre-DEV scaffold + terminal/immutable. */
const INTENT_REPAIR_REFUSED_PHASES = new Set(['INIT', 'INIT_CHECK', 'DONE', 'DISCARDED', 'META']);

/** Map a recorded evidence kind to the closest verificationIntent type (lossy but stable). */
function mapEvidenceKindToIntentType(kind: VerificationEvidence['kind']): VerificationIntentType {
  switch (kind) {
    case 'logic_test': return 'logic';
    case 'integration_test': return 'cli';
    case 'browser_test': return 'browser';
    case 'manual_transcript': return 'manual';
    case 'docs_check': return 'docs';
    default: return 'cli';
  }
}

/**
 * B-1507: inverse of mapEvidenceKindToIntentType — pick the closest evidence kind for an
 * intent type. verification_run only executes pinned (executable) intents, so in practice
 * only logic|cli|browser are reachable; manual|docs are mapped for completeness.
 */
function intentTypeToEvidenceKind(type: VerificationIntentType): VerificationEvidence['kind'] {
  switch (type) {
    case 'logic': return 'logic_test';
    case 'cli': return 'integration_test';
    case 'browser': return 'browser_test';
    case 'manual': return 'manual_transcript';
    case 'docs': return 'docs_check';
    default: return 'integration_test';
  }
}

/** Reconstruct a human intent description from the evidence that proves it. */
function deriveIntentDesc(ev: VerificationEvidence): string {
  const source = (ev.note && ev.note.trim()) || ev.command || ev.file || ev.kind;
  const base = source.length > 140 ? `${source.slice(0, 137)}...` : source;
  return `Reconstructed from ${ev.kind} evidence: ${base}`;
}

/** PASSING evidence only seeds intent: never a waiver, never an explicit fail. */
function isPassingEvidence(ev: VerificationEvidence): boolean {
  return ev.kind !== 'waiver' && ev.result !== 'fail' && !isAcceptanceMatrixDerivedEvidence(ev);
}

/**
 * B-4e06 CHK-001: pure reconstruction. For every checklist item, fill the
 * MISSING verificationIntent lane slot that a passing, item-scoped, structured
 * evidence ref points at — never overwriting an authored intent, synthesizing
 * priority='should'. Mutates `cl` in place and returns the list of filled
 * `itemId:lane:index (type)` refs. Throws on a malformed item-scoped ref
 * (fail-closed). No I/O, so it is unit-testable without a git worktree.
 */
export function reconstructMissingIntentsFromEvidence(cl: ChecklistData): string[] {
  const filled: string[] = [];
  for (const item of cl.items) {
    for (const ev of item.verificationEvidence || []) {
      // Only refs scoped to THIS item; the `${item.id}:` prefix (with the colon)
      // guarantees the regex capture group m[1] === item.id, so no separate check.
      if (!ev.intentRef.startsWith(`${item.id}:`)) continue; // custom/foreign refs ignored
      const m = STRUCTURED_INTENT_REF.exec(ev.intentRef);
      if (!m) {
        throw new Error(`verification_intent_repair: malformed intentRef '${ev.intentRef}' on ${item.id} — expected CHK-N:(happy|edge|adversarial):N. Fix the evidence ref before repair.`);
      }
      if (!isPassingEvidence(ev)) continue; // never synthesize from failing/waiver evidence
      const lane = m[2] as VerificationLane;
      const index = Number(m[3]);
      const vi: VerificationIntent = item.verificationIntent || { happy: [], edge: [], adversarial: [] };
      for (const l of VERIFICATION_LANES) if (!vi[l]) vi[l] = [];
      if (vi[lane][index]) continue;        // never overwrite authored intent
      while (vi[lane].length < index) {
        vi[lane].push({ desc: 'Reconstructed placeholder (no evidence at this index)', type: 'logic', priority: 'nice' });
      }
      vi[lane][index] = {
        desc: deriveIntentDesc(ev),
        type: mapEvidenceKindToIntentType(ev.kind),
        priority: 'should',
      };
      item.verificationIntent = vi;
      filled.push(`${item.id}:${lane}:${index} (${vi[lane][index].type})`);
    }
  }
  return filled;
}

/**
 * B-1507 CHK-002: a receipt earned by RE-RUNNING a pinned command during a stale
 * refresh. Only ever populated by a real pass (mechanical:true + on-disk receipt) —
 * a failed / unavailable re-run leaves NO entry, so the row falls through to the
 * demote path. There is NO code path that mints one of these without a real pass.
 */
type ReexecStamp = {
  command?: string;
  result?: 'pass' | 'fail';
  mechanical: true;
  receipt: VerificationExecutionReceipt;
  /** Exact execution-semantics key used to prevent reuse after a concurrent pin/provenance change. */
  executionKey: string;
};

type StaleReexecCandidate = {
  item: ChecklistItem;
  input: EvidenceWriteInput;
  executionKey: string;
  rowKey: string;
};

type StaleRefreshContext = {
  refreshGitCwd: string;
  headHash: string;
  materialHash: string | undefined;
  storyFilesHash: string | undefined;
  /** Pre-lock checklist snapshot (used to resolve pins for re-execution). */
  cl: ChecklistData;
  stale: ReturnType<typeof buildVerificationCoverage>['entries'];
};

/**
 * B-1507 CHK-002: read-only snapshot of the current freshness hashes + the stale
 * verificationEvidence set. Shared by BOTH the synchronous metadata-only entry and
 * the re-executing CLI handler so the two paths compute the stale set identically.
 * Throws (mirroring the original handler) when git HEAD is unreadable.
 */
function collectStaleRefreshContext(ctx: HandlerContext, storyId: string): StaleRefreshContext {
  const { store, root } = ctx;
  // B-75f0 CHK-001: refresh freshness from the RESOLVED gitRoot, not the bare
  // metadataRoot. On a wrapper-root layout the bare root is not a git repo, so
  // `git rev-parse HEAD` threw and refresh was impossible. metadataRoot stays
  // `root` for the storyDir-aware material exclusion. Plain repos: gitCwd==root.
  const refreshGitCwd = resolveGitCwd({ store, storyId, metadataRoot: root, projectRoot: root });
  let headHash = '';
  try {
    headHash = execSync('git rev-parse HEAD', { cwd: refreshGitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    throw new Error('verification_evidence_refresh_stale: cannot read git HEAD in current directory, unable to refresh freshness');
  }
  const materialHash = currentMaterialHash(refreshGitCwd, 'HEAD', root);
  const storyFilesHash = currentStoryFilesHash(refreshGitCwd, 'HEAD', root);
  const cl = store.readChecklist(storyId);
  const coverage = buildVerificationCoverage(
    cl,
    headHash,
    (oldHeadHash, evidence) => checkEvidenceFreshnessForGit(refreshGitCwd, oldHeadHash, evidence?.materialHash, root, evidence?.storyFilesHash).fresh,
    { deferredGateEvidence: 'missing' },
  );
  const stale = coverage.entries.filter(e => e.status === 'stale' && e.evidence);
  return { refreshGitCwd, headHash, materialHash, storyFilesHash, cl, stale };
}

/**
 * Build the exact semantic identity of one stale pinned re-execution. The key is
 * deliberately stricter than command equality: selector, intent/evidence kind,
 * cwd, effective timeout, and the audited timeout provenance must all match.
 * This keeps dedupe inside one refresh invocation without weakening immutable-pin
 * or timeout-boundary enforcement for any individual intent.
 */
function staleReexecCandidate(
  root: string,
  refreshGitCwd: string,
  item: ChecklistItem,
  intentRef: string,
  evidence: VerificationEvidence | undefined,
): StaleReexecCandidate | undefined {
  const resolved = resolveIntentForRef(item, intentRef);
  const pin = resolved?.intent.verification;
  if (!resolved || !pin || !isExecutableIntentType(resolved.intent.type)) return undefined;

  const kind = intentTypeToEvidenceKind(resolved.intent.type);
  const priorOverride = evidence?.receipt?.timeoutOverride;
  const input: EvidenceWriteInput = {
    intentRef,
    kind,
    command: pin.command,
    selector: pin.selector,
    result: 'pass',
    ...(priorOverride
      ? { commandTimeoutMs: priorOverride.timeoutMs, commandTimeoutReason: priorOverride.reason }
      : {}),
  };
  // Validate every row's carried override before grouping. An invalid row remains
  // ungrouped and therefore takes the existing demotion path.
  const validatedOverride = resolveEvidenceCommandTimeout('verification evidence refused', input);
  const configuredTimeoutMs = validatedOverride
    ? undefined
    : resolvePinnedCommandTimeoutMs(root, pin.command);
  const effectiveTimeoutMs = validatedOverride?.timeoutMs
    ?? configuredTimeoutMs
    ?? DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS;
  const executionKey = JSON.stringify({
    version: 1,
    command: pin.command,
    selector: pin.selector,
    intentType: resolved.intent.type,
    evidenceKind: kind,
    cwd: refreshGitCwd,
    effectiveTimeoutMs,
    timeoutProvenance: priorOverride
      ? {
          source: 'carried-receipt-override',
          timeoutMs: validatedOverride?.timeoutMs,
          reason: validatedOverride?.reason,
          priorDefaultTimeoutMs: priorOverride.defaultTimeoutMs,
        }
      : {
          source: configuredTimeoutMs === undefined ? 'executor-default' : 'configured-command-timeout',
          configuredTimeoutMs: configuredTimeoutMs ?? null,
        },
  });
  return { item, input, executionKey, rowKey: `${item.id}::${intentRef}` };
}

/**
 * B-1507 CHK-002: the SINGLE synchronous write core for a stale refresh, run under the
 * checklist lock. For each stale row it does exactly ONE of two things:
 *   - `reexecByKey` has a pass-stamp for the row (its pinned command was RE-RUN and
 *     PASSED, computed by the async handler before the lock) → re-stamp a fresh
 *     mechanical:true receipt bound to the CURRENT head/material — the row stays covered.
 *   - otherwise (no pin / not re-run / the re-run did NOT pass) → the pre-B-1507
 *     behavior: DEMOTE a stale mechanical receipt to a non-mechanical attestation, else
 *     freshness-only re-stamp. A covered receipt is NEVER minted here without a real pass.
 */
function writeStaleRefresh(
  ctx: HandlerContext,
  storyId: string,
  computed: StaleRefreshContext,
  opts: { dryRun?: boolean; reexecByKey?: Map<string, ReexecStamp> } = {},
): string {
  const { store, root } = ctx;
  const { headHash, materialHash, storyFilesHash, stale } = computed;
  const reexecByKey = opts.reexecByKey ?? new Map<string, ReexecStamp>();
  return withChecklistLock(ctx, storyId, () => {
    const cl = store.readChecklist(storyId);
    const lines = [
      `${opts.dryRun ? '[DRY-RUN] ' : ''}Stale verification evidence for ${storyId}: ${stale.length}`,
    ];
    let refreshed = 0;
    for (const entry of stale) {
      const item = cl.items.find(i => i.id === entry.itemId);
      const existing = item?.verificationEvidence || [];
      const idx = existing.findIndex(e => e.intentRef === entry.intentRef);
      const ev = idx >= 0 ? existing[idx] : entry.evidence;
      lines.push(`  - ${entry.intentRef}: ${ev?.command || ev?.file || ev?.kind || 'evidence'} → ${headHash.slice(0, 7)}`);
      if (opts.dryRun || !item || idx < 0 || !ev) continue;
      const reexec = reexecByKey.get(`${entry.itemId}::${entry.intentRef}`);
      let currentExecutionKey: string | undefined;
      if (reexec) {
        try {
          currentExecutionKey = staleReexecCandidate(
            root,
            computed.refreshGitCwd,
            item,
            entry.intentRef,
            ev,
          )?.executionKey;
        } catch {
          // A concurrently changed/invalid timeout provenance cannot consume a
          // receipt earned under the pre-lock snapshot; leave it on demotion.
        }
      }
      if (reexec && currentExecutionKey === reexec.executionKey) {
        // B-1507 CHK-002: the pinned command was RE-RUN and PASSED through the same
        // enforceAndStampEvidence refusal path. Bind the FRESH receipt to the CURRENT
        // head/material so the row stays mechanical:true covered — no demotion.
        existing[idx] = makeEvidence({
          intentRef: ev.intentRef,
          kind: ev.kind,
          ...(ev.verdict ? { verdict: ev.verdict } : {}),
          ...(ev.waiverType ? { waiverType: ev.waiverType } : {}),
          ...(ev.file ? { file: ev.file } : {}),
          ...(reexec.command ? { command: reexec.command } : (ev.command ? { command: ev.command } : {})),
          ...(reexec.result ? { result: reexec.result } : (ev.result ? { result: ev.result } : {})),
          note: ev.note,
          headHash,
          ...(materialHash ? { materialHash } : {}),
          ...(storyFilesHash ? { storyFilesHash } : {}),
          ...(ev.attestation ? { attestation: ev.attestation } : {}),
          ...(ev.actorTrust ? { actorTrust: ev.actorTrust } : {}),
          ...(ev.factProvenance ? { factProvenance: ev.factProvenance } : {}),
          mechanical: true,
          receipt: reexec.receipt,
        });
        item.verificationEvidence = existing;
        refreshed++;
        continue;
      }
      // B-ec67 F-001: carry the tool-execution provenance forward so refresh does NOT
      // launder a demoted / receipt row back to mechanical:undefined (= grandfathered
      // covered). A mechanical:true receipt is DEMOTED to a non-mechanical attestation
      // here: without a fresh passing re-run the stale receipt must not keep covering.
      let refreshedMechanical = ev.mechanical;
      let refreshedReceipt = ev.receipt;
      let refreshedReason = ev.nonMechanicalReason;
      // B-3b88 CHK-002: ANY command-backed result:pass that reaches this path was NOT
      // re-executed (no fresh receipt above), so it must never be re-stamped as a
      // still-valid pass. Demote unconditionally — including legacy rows whose
      // `mechanical` is undefined, which would otherwise pass straight through and be
      // silently re-certified on new material (the F-045/F-046/F-047 laundering bug).
      const unexecutedCommandBackedPass = typeof ev.command === 'string'
        && ev.command.length > 0
        && ev.result === 'pass';
      if (ev.mechanical === true || unexecutedCommandBackedPass) {
        refreshedMechanical = false;
        refreshedReceipt = undefined;
        refreshedReason = ev.nonMechanicalReason
          ?? 'receipt invalidated by verification_evidence_refresh_stale: the material changed since execution and the pinned command was not re-run here; re-run verification_evidence_add to re-earn a mechanical receipt';
      }
      existing[idx] = makeEvidence({
        intentRef: ev.intentRef,
        kind: ev.kind,
        ...(ev.verdict ? { verdict: ev.verdict } : {}),
        ...(ev.waiverType ? { waiverType: ev.waiverType } : {}),
        ...(ev.file ? { file: ev.file } : {}),
        ...(ev.command ? { command: ev.command } : {}),
        ...(ev.result ? { result: ev.result } : {}),
        note: ev.note,
        headHash,
        ...(materialHash ? { materialHash } : {}),
        ...(storyFilesHash ? { storyFilesHash } : {}),
        ...(ev.attestation ? { attestation: ev.attestation } : {}),
        ...(ev.actorTrust ? { actorTrust: ev.actorTrust } : {}),
        ...(ev.factProvenance ? { factProvenance: ev.factProvenance } : {}),
        ...(refreshedMechanical !== undefined ? { mechanical: refreshedMechanical } : {}),
        ...(refreshedReceipt ? { receipt: refreshedReceipt } : {}),
        ...(refreshedReason ? { nonMechanicalReason: refreshedReason } : {}),
      });
      item.verificationEvidence = existing;
      refreshed++;
    }

    if (!opts.dryRun) store.writeChecklist(storyId, cl);
    lines.push(opts.dryRun
      ? '→ Rerun the above command without dryRun to refresh evidence metadata'
      : `Refreshed ${refreshed}/${stale.length} stale evidence item(s). Re-run proof-or-stop validate --story=${storyId} --json`);
    if (!opts.dryRun) {
      const commitHint = autoCommitStoryMetadata(root, storyId, 'verification_evidence_refresh_stale');
      if (commitHint) lines.push(commitHint.replace(/^\n/, ''));
    }
    return lines.join('\n');
  });
}

/**
 * B-1507 CHK-002: SYNCHRONOUS, metadata-only stale refresh that NEVER executes a
 * pinned command. This preserves the exact pre-B-1507 behavior (freshness re-stamp +
 * demote a stale mechanical receipt) for in-process callers whose OWN contract forbids
 * running a verification command as a side effect: `evidence_refresh` ("never runs a
 * command"), `done_prepare` (refuses / reruns command-backed rows on its own path), and
 * `recover_evidence` (refresh hashes, then validate). The RE-EXECUTING behavior lives
 * exclusively on the async `verification_evidence_refresh_stale` CLI handler below.
 */
export function refreshStaleEvidenceMetadataOnly(ctx: HandlerContext, storyId: string, dryRun = false): string {
  const computed = collectStaleRefreshContext(ctx, storyId);
  if (computed.stale.length === 0) {
    return `No stale verification evidence for ${storyId}`;
  }
  return writeStaleRefresh(ctx, storyId, computed, { dryRun });
}

export function createChecklistHandlers(ctx: HandlerContext) {
  const { store, root } = ctx;
  // B-75f0 CHK-001: resolve the authoritative git cwd for a story-scoped command.
  // Every verification-evidence handler here has args.storyId in scope, so it can
  // route freshness git probes through the single resolveGitCwd choke-point. On a
  // wrapper-root layout this returns the configured gitRoot subdir; on a plain
  // repo it returns `root` (byte-identical fallback). metadataRoot stays `root`
  // so the storyDir-aware metadata exclusion loads config from the right place.
  const resolveStoryGitCwd = (storyId: string): string =>
    resolveGitCwd({ store, storyId, metadataRoot: root, projectRoot: root });
  return {
    checklist_get(args: ChecklistGetArgs) {
      const full = store.readChecklist(args.storyId);
      if (!args.slim && !args.fields) return full;
      const result = args.slim ? renderSlimChecklist(args.storyId, full) : full as unknown as Record<string, unknown>;
      return pickTopLevelFields(result, args.fields);
    },

    checklist_add(args: {
      storyId: string;
      title: string;
      context?: string;
      relatedDocs?: string[];
      userSees?: string;
      excludes?: string[];
      files?: { modify: string[]; create: string[]; test: string[] };
      verificationIntent?: VerificationIntent;
      reason?: string;
      agent?: string;
      actor?: string;
    }): string {
      if (verificationIntentHasPlannedPathDeclarations(args.verificationIntent)) {
        throw new Error(
          'checklist_add refused: plannedPathDeclarations may only be authored by the dispatched verification-intent role through checklist_update during PLAN [planned_path_writer_not_authorized]',
        );
      }
      const story = assertChecklistAddAllowed(store, args);

      return withChecklistLock(ctx, args.storyId, () => {
      const cl = store.readChecklist(args.storyId);

      // Find the largest CHK number from existing items and allocate the next one
      let maxNum = 0;
      for (const item of cl.items) {
        const m = item.id.match(/^CHK-(\d+)$/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n > maxNum) maxNum = n;
        }
      }
      const nextId = `CHK-${String(maxNum + 1).padStart(3, '0')}`;

      // B-45ed CHK-008: When relatedDocs is not provided / is an empty array, automatically inject the background.md path (if the file exists).
      // If the caller has explicitly provided a non-empty relatedDocs, respect that choice and do not auto-insert.
      let effectiveRelatedDocs: string[] | undefined = args.relatedDocs;
      if (!effectiveRelatedDocs || effectiveRelatedDocs.length === 0) {
        const bgRel = resolveBackgroundPath(root, store, args.storyId);
        if (bgRel) {
          effectiveRelatedDocs = [bgRel];
        } else if (args.relatedDocs !== undefined) {
          // User explicitly passed an empty array and background.md does not exist → keep as empty array
          effectiveRelatedDocs = args.relatedDocs;
        } else {
          // Not passed && no background → do not write the relatedDocs field
          effectiveRelatedDocs = undefined;
        }
      }

      cl.items.push({
        id: nextId,
        title: args.title,
        context: args.context,
        ...(effectiveRelatedDocs !== undefined ? { relatedDocs: effectiveRelatedDocs } : {}),
        ...(args.userSees ? { userSees: args.userSees } : {}),
        ...(args.excludes !== undefined ? { excludes: args.excludes } : {}),
        ...(args.files !== undefined ? { files: {
          modify: args.files.modify ?? [],
          create: args.files.create ?? [],
          test: args.files.test ?? [],
        } } : {}),
        ...(args.verificationIntent !== undefined ? { verificationIntent: args.verificationIntent } : {}),
        status: 'pending',
        startTime: null,
        endTime: null,
      });

      if (story.phase === 'PLAN') {
        if (!cl.auditLog) cl.auditLog = [];
        cl.auditLog.push({
          timestamp: new Date().toISOString(),
          phase: story.phase,
          itemId: nextId,
          action: 'add',
          from: 'pending' as ChecklistStatus,
          to: 'pending' as ChecklistStatus,
          reason: args.reason!.trim(),
          addedTitle: args.title,
          addedContext: args.context || '',
        });
      }

      store.writeChecklist(args.storyId, cl);
      try {
        store.appendProcessEvent(args.storyId, {
          type: 'plan_updated',
          action: 'add',
          itemId: nextId,
          phase: story.phase,
        });
      } catch (e) {
        console.warn(`[process-events] append failed for ${args.storyId}:`, (e as Error).message);
      }
      const advisory = hasMilestoneLedgerArtifact(store, args.storyId)
        ? `\n${checklistAddMilestoneLedgerAdvisory(args.storyId, nextId)}`
        : '';
      return `Checklist item ${nextId} added to ${args.storyId}${advisory}`;
      });
    },

    checklist_remove(args: {
      storyId: string;
      itemId: string;
      disposition: 'accept' | 'reject' | 'partial';
      justification: string;
    }): string {
      // Justification must be given
      if (!args.justification || args.justification.trim().length < 10) {
        throw new Error('justification must be ≥ 10 characters, explaining why this checklist item is being removed');
      }
      const validDispositions = ['accept', 'reject', 'partial'];
      if (!validDispositions.includes(args.disposition)) {
        throw new Error(`disposition must be one of accept/reject/partial, received: ${args.disposition}`);
      }

      return withChecklistLock(ctx, args.storyId, () => {
      const cl = store.readChecklist(args.storyId);
      const idx = cl.items.findIndex(i => i.id === args.itemId);
      if (idx === -1) throw new Error(`Checklist item ${args.itemId} not found`);

      const item = cl.items[idx];
      // B-1909 CHK-002: withdrawn is terminal like done — a withdrawn item is a
      // durable audit record of a scope-shrinkage decision and must not be
      // silently deleted. (Removal is INIT-only anyway, where withdrawn cannot
      // yet exist, so this is defense-in-depth.)
      if (isTerminalChecklistStatus(item.status)) {
        const label = isWithdrawnChecklistStatus(item.status) ? 'withdrawn' : 'done';
        throw new Error(`Cannot remove ${args.itemId}: already ${label}. Re-open first if needed.`);
      }

      // Only the INIT phase allows removal. From INIT_CHECK onward, title/context is frozen;
      // if PLAN still allowed remove+add, it would be equivalent to bypassing the freeze gate of checklist_update.
      const story = assertChecklistMutationCwd(store, args.storyId);
      const allowedPhases = ['INIT'];
      if (!allowedPhases.includes(story.phase)) {
        throw new Error(`${story.phase} phase does not allow removing checklist items; from INIT_CHECK onward checklist title/context is frozen, to prevent remove+add bypass. New scope can only be added via checklist_add, the original item must remain for gate review`);
      }

      const removed = cl.items.splice(idx, 1)[0];

      // Audit log: record the complete removed item info + disposition, written automatically
      if (!cl.auditLog) cl.auditLog = [];
      cl.auditLog.push({
        timestamp: new Date().toISOString(),
        phase: story.phase,
        itemId: args.itemId,
        action: 'delete',
        from: removed.status,
        to: 'pending' as const,
        reason: args.justification.trim(),
        removedTitle: removed.title,
        removedContext: removed.context || '',
        removedUserSees: removed.userSees || '',
        disposition: args.disposition,
        justification: args.justification.trim(),
        disposedAt: new Date().toISOString(),
      });

      store.writeChecklist(args.storyId, cl);
      try {
        store.appendProcessEvent(args.storyId, {
          type: 'plan_updated',
          action: 'remove',
          itemId: args.itemId,
          phase: story.phase,
        });
      } catch (e) {
        console.warn(`[process-events] append failed for ${args.storyId}:`, (e as Error).message);
      }
      return `Checklist item ${args.itemId} ("${removed.title}") removed from ${args.storyId}\n` +
        `  disposition: ${args.disposition}\n` +
        `  justification: ${args.justification.trim()}\n` +
        `⚠ scope change recorded, story_review will display this removal for reviewer audit`;
      });
    },

    checklist_update(args: {
      storyId: string;
      itemId: string;
      status?: ChecklistStatus;
      title?: string;
      context?: string;
      relatedDocs?: string[];
      userSees?: string;
      excludes?: string[];
      files?: { modify: string[]; create: string[]; test: string[] };
      verificationIntent?: VerificationIntent;
      verificationEvidence?: VerificationEvidenceInput[];
      reason?: string;
      agent?: string;
      actor?: string;
      success?: boolean;
    }): string {
      if (!args.status && args.title === undefined && args.context === undefined && args.relatedDocs === undefined && args.userSees === undefined && args.excludes === undefined && args.files === undefined && args.verificationIntent === undefined && args.verificationEvidence === undefined) {
        throw new Error('At least one of status/title/context/relatedDocs/userSees/excludes/files/verificationIntent/verificationEvidence must be provided');
      }

      // B-1909 CHK-001/CHK-005: 'withdrawn' is a terminal disposition that can
      // only originate from a confirmed + userConfirmed scope-shrinkage decision.
      // The sole applier (scope_shrinkage_decision_set) writes the checklist
      // directly, never through checklist_update — so a direct withdrawn write
      // here is always unauthorized. Refused on BOTH the Zod and internal-fn path.
      if (args.status === 'withdrawn') {
        throw new Error(
          `checklist_update refused: status='withdrawn' cannot be set directly. ` +
          `A withdrawal must be recorded by scope_shrinkage_decision_set (the sole authorized applier), ` +
          `which stamps the item with a confirmed decision's decisionRef. ` +
          `Run proof-or-stop scope_shrinkage_decision_set with withdrawnChecklistItemRefs including ${args.itemId}. [withdrawn_requires_scope_shrinkage_decision]`,
        );
      }

      // USER is retained below for human audit attribution, but it is not a
      // dispatched-agent identity. Only an explicit actor/agent or
      // PROOF_OR_STOP_AGENT (deprecated alias PROOF_OR_STOP_AGENT) participates in registry authorization.
      const authority = resolveAgentMutationAuthority({
        command: 'checklist_update',
        payloadActors: [args.agent, args.actor],
      });
      const checklistActor = authority.actor || process.env.USER?.trim() || 'main-agent';
      const dispatchedRole = authority.entry;
      const incomingHasPlannedDeclarations = verificationIntentHasPlannedPathDeclarations(args.verificationIntent);
      const isDispatchedVerificationIntentWriter = dispatchedRole?.roleClass === 'verification-intent'
        && authority.source === 'dispatched-env';
      if (incomingHasPlannedDeclarations && !isDispatchedVerificationIntentWriter) {
        throw new Error(
          'checklist_update refused: plannedPathDeclarations require the dispatched verification-intent role during PLAN [planned_path_writer_not_authorized]',
        );
      }
      if (dispatchedRole?.roleClass === 'verification-intent') {
        const disallowed = [
          args.status !== undefined && 'status',
          args.title !== undefined && 'title',
          args.context !== undefined && 'context',
          args.relatedDocs !== undefined && 'relatedDocs',
          args.userSees !== undefined && 'userSees',
          args.excludes !== undefined && 'excludes',
          args.files !== undefined && 'files',
          args.verificationEvidence !== undefined && 'verificationEvidence',
        ].filter(Boolean);
        if (args.verificationIntent === undefined || disallowed.length > 0) {
          throw new Error(
            `checklist_update refused: verification-intent roles may write only verificationIntent and may not set ${disallowed.join(', ') || 'non-verification fields'}. [agent_dispatch_mutation_scope_denied]`,
          );
        }
      }

      return withChecklistLock(ctx, args.storyId, () => {
      // Truth source protection: DEV and later phases forbid modifying the fundamental information of checklist
      // checklist is the truth source; executors (main agent / subagent) cannot tamper with the requirement definition during execution
      //
      // B-9d95 CHK-008: userSees is split out from the protection scope of title/context and gated separately
      //   - title/context are protected from INIT_CHECK onward (PLAN modifications are rejected). To change them, reopen to INIT via `story_advance --phase=INIT` from PLAN — INIT is the ONLY phase where title/context is editable (B-8b69). INIT_CHECK stays protected, so the scope-freeze invariant is preserved.
      //   - userSees is a PLAN artifact (see CLAUDE.md checklist conventions), allowed to be added/modified during the PLAN phase,
      //     frozen from DEV onward (the executor must not tamper with the acceptance description during implementation)
      const story = assertChecklistMutationCwd(store, args.storyId);
      const titleContextFields = ['title', 'context'] as const;
      const titleContextProtectedPhases = ['INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE'];
      const userSeesProtectedPhases = ['DEV', 'REVIEW', 'TEST', 'DONE'];
      const verificationIntentProtectedPhases = ['DEV', 'REVIEW', 'TEST', 'DONE'];

      const attemptedTitleContext = titleContextFields.filter(f => args[f] !== undefined);
      assertInitReviewerChecklistMutationAllowed({
        story,
        command: 'checklist_update',
        actor: checklistActor,
        mutatesDefinition: attemptedTitleContext.length > 0 || args.excludes !== undefined,
      });
      if (attemptedTitleContext.length > 0 && titleContextProtectedPhases.includes(story.phase)) {
        throw new Error(
          `${attemptedTitleContext.join('/')} of ${args.itemId} cannot be modified during the ${story.phase} phase. ` +
          `checklist is the source of truth; from INIT_CHECK onward the executor must not tamper with requirement definitions. ` +
          `To change title/context, reopen to INIT — the only phase where they are editable. ` +
          // checklist_update is only reachable in INIT/PLAN/DEV (command-policy),
          // and INIT is not in titleContextProtectedPhases, so this refusal fires
          // only at PLAN and DEV — the two branches below cover exactly those.
          `${story.phase === 'PLAN'
            ? `From PLAN: run proof-or-stop story_advance '{"storyId":"${args.storyId}","phase":"INIT","reason":"<why the frozen title must change>"}', edit the title, then re-run INIT review and re-advance INIT_CHECK -> PLAN`
            : `From DEV: first roll back to PLAN with proof-or-stop story_advance '{"storyId":"${args.storyId}","phase":"PLAN"}', then proof-or-stop story_advance '{"storyId":"${args.storyId}","phase":"INIT","reason":"<why>"}'`}. ` +
          `(INIT_CHECK stays frozen and reopening resets non-pending checklist items to pending, so the scope-freeze invariant is preserved.)`
        );
      }

      if (args.userSees !== undefined && userSeesProtectedPhases.includes(story.phase)) {
        throw new Error(
          `userSees of ${args.itemId} cannot be modified during the ${story.phase} phase. ` +
          `userSees is frozen at the end of PLAN; from DEV onward the executor must not change the acceptance description. ` +
          `To adjust, use finding_add to request going back to PLAN`
        );
      }
      if (args.verificationIntent !== undefined && verificationIntentProtectedPhases.includes(story.phase)) {
        throw new Error(
          `verificationIntent of ${args.itemId} cannot be modified during the ${story.phase} phase. ` +
          `verificationIntent is the source of truth for test intent in the PLAN phase; after DEV you can only append verificationEvidence or use a finding to request going back to PLAN.`
        );
      }

      const cl = store.readChecklist(args.storyId);
      const item = cl.items.find(i => i.id === args.itemId);
      if (!item) throw new Error(`Checklist item ${args.itemId} not found`);
      if (args.verificationIntent !== undefined) {
        const existingDeclarationSnapshot = plannedPathDeclarationSnapshot(item.verificationIntent);
        const incomingDeclarationSnapshot = plannedPathDeclarationSnapshot(args.verificationIntent);
        if (existingDeclarationSnapshot !== incomingDeclarationSnapshot && !isDispatchedVerificationIntentWriter) {
          throw new Error(
            'checklist_update refused: only the dispatched verification-intent role may add, change, move, or remove plannedPathDeclarations during PLAN [planned_path_writer_not_authorized]',
          );
        }
        if (incomingHasPlannedDeclarations) validatePlannedPathDeclarationsForChecklistItem(item, args.verificationIntent);
      }
      if (args.files !== undefined
        && (verificationIntentHasPlannedPathDeclarations(item.verificationIntent) || incomingHasPlannedDeclarations)
        && JSON.stringify(args.files) !== JSON.stringify(item.files)) {
        throw new Error(
          'checklist_update refused: ChecklistItem.files entries referenced by plannedPathDeclarations are frozen [planned_path_file_binding_frozen]',
        );
      }
      assertChecklistScopeChangeAllowed(store, args.storyId, {
        title: args.title ?? (args.excludes !== undefined ? item.title : undefined),
        context: args.context ?? (args.excludes !== undefined ? item.context : undefined),
        excludes: args.excludes ?? item.excludes,
        itemId: args.itemId,
      });

      const results: string[] = [];
      const now = new Date().toISOString();
      const oldStatus = item.status;

      if (args.title !== undefined) {
        item.title = args.title;
        results.push(`title updated`);
      }
      if (args.context !== undefined) {
        item.context = args.context;
        results.push(`context updated`);
      }
      if (args.relatedDocs !== undefined) {
        item.relatedDocs = args.relatedDocs;
        results.push(`relatedDocs updated (${args.relatedDocs.length})`);
      }
      if (args.userSees !== undefined) {
        item.userSees = args.userSees;
        results.push(`userSees updated`);
      }
      if (args.excludes !== undefined) {
        item.excludes = args.excludes;
        results.push(`excludes updated (${args.excludes.length})`);
      }
      if (args.files !== undefined) {
        item.files = {
          modify: args.files.modify ?? [],
          create: args.files.create ?? [],
          test: args.files.test ?? [],
        };
        results.push(`files updated (modify:${item.files.modify.length} create:${item.files.create.length} test:${item.files.test.length})`);
      }
      if (args.verificationIntent !== undefined) {
        item.verificationIntent = args.verificationIntent;
        results.push(`verificationIntent updated`);
      }
      if (args.verificationEvidence !== undefined) {
        // B-ec67 F-007: this bulk setter is a THIRD verificationEvidence write path that
        // does NOT run the pinned command. Refuse an executable intent's row unless it is
        // already a valid mechanical receipt or an audited non-mechanical attestation, so
        // it cannot become an unguarded bypass of enforceAndStampEvidence. The
        // acceptance-matrix projection check runs FIRST (mirroring verification_evidence_add,
        // which rejects a matrix projection before enforcement) so a matrix-derived row is
        // rejected as a projection, not merely as an unenforced executable write.
        //
        // B-ec67 F-008: snapshot the EXISTING on-disk evidence BEFORE replacing it, then carry
        // forward each row's trusted provenance (mechanical/receipt/nonMechanicalReason) FROM
        // DISK — never from the caller — so a legitimate re-persist (reorder / metadata edit)
        // does not strip an already-earned receipt, while a fabricated caller receipt stays
        // untrusted and (for a fresh executable intent) is refused (carryForwardOnDiskProvenance).
        const priorEvidence = item.verificationEvidence;
        const effectiveEvidence = args.verificationEvidence.map(ev => carryForwardOnDiskProvenance(priorEvidence, ev));
        for (const ev of effectiveEvidence) {
          assertEvidenceIsNotAcceptanceMatrixProjection(ev);
          assertChecklistUpdateEvidenceRowAllowed(item, ev);
        }
        item.verificationEvidence = effectiveEvidence.map(ev => normalizeEvidence(resolveStoryGitCwd(args.storyId), root, ev));
        results.push(`verificationEvidence updated (${effectiveEvidence.length})`);
      }

      if (args.status) {
        item.status = args.status;
        if (args.status === 'in_progress' && !item.startTime) {
          item.startTime = now;
        }
        if (args.status === 'done') {
          item.endTime = now;
          // B-2296 CHK-002: pin the immutable frozen-claim snapshot at the attestation
          // transition — exactly once, on the first pending/in_progress → done (immutable
          // thereafter; skipped on a re-persist where the item was already done). Defensive:
          // captureUserSeesSnapshot never throws, so this can never break checklist_update.
          if (oldStatus !== 'done') {
            captureUserSeesSnapshot(item, resolveStoryGitCwd(args.storyId), root);
          }
        }

        // Modification operations write audit logs (new pending→pending does not count as a modification)
        if (oldStatus !== args.status && args.reason) {
          const story = store.readStory(args.storyId);
          if (!cl.auditLog) cl.auditLog = [];
          cl.auditLog.push({
            timestamp: now,
            phase: story.phase,
            itemId: args.itemId,
            action: 'update',
            from: oldStatus,
            to: args.status,
            reason: args.reason,
            ...(args.agent ? { agent: args.agent } : {}),
          });
        }
        results.push(`status → ${args.status}`);
      }

      store.writeChecklist(args.storyId, cl);

      // B-3511: append process events on status transitions
      if (args.status && oldStatus !== args.status) {
        try {
          if (args.status === 'in_progress') {
            store.appendProcessEvent(args.storyId, {
              type: 'dispatch',
              checklistId: args.itemId,
              ...(args.agent ? { agent: args.agent } : {}),
            });
          } else if (args.status === 'done') {
            store.appendProcessEvent(args.storyId, {
              type: 'subagent_result',
              checklistId: args.itemId,
              success: args.success !== false,
            });
          }
        } catch (e) {
          console.warn(`[process-events] append failed for ${args.storyId}:`, (e as Error).message);
        }
      }

      const commitHint = autoCommitStoryMetadata(root, args.storyId, 'checklist_update');

      // B-95d8 CHK-002: post-write reload reminder.
      // Re-read the FINAL persisted state (read-after-write) so a long session does
      // not keep trusting a stale pre-write snapshot (e.g. "still in_progress" when
      // the write already flipped it to done). The reminder goes to STDERR, never
      // stdout, following the B-6812 advisory-to-stderr precedent: stdout stays the
      // pure conclusion so `proof-or-stop checklist_update | tail` pipelines are unaffected.
      try {
        const persisted = store.readChecklist(args.storyId).items.find(i => i.id === args.itemId);
        const persistedStatus = persisted ? persisted.status : '<unknown>';
        process.stderr.write(
          `↻ Written and persistence confirmed: ${args.itemId} current status=${persistedStatus}. ` +
          `For long sessions please reload (proof-or-stop checklist_get / session_brief) before relying on the snapshot.\n`,
        );
      } catch (e) {
        // Reminder is advisory only — a read-back failure must never change the
        // write result or the stdout conclusion.
        console.warn(`[checklist_update] post-write reload reminder skipped for ${args.storyId}: ${(e as Error).message}`);
      }

      // CHK-003: when pending/in_progress → done and the item has relatedDocs, hint the related document list
      // B-45ed CHK-008: the done hint list uniformly includes background.md (if it exists and is not in item.relatedDocs), ensuring downstream sync alignment
      const transitionedToDone = args.status === 'done' && oldStatus !== 'done';
      if (transitionedToDone) {
        const docsList: string[] = [];
        if (Array.isArray(item.relatedDocs)) {
          for (const d of item.relatedDocs) docsList.push(d);
        }
        const bgRel = resolveBackgroundPath(root, store, args.storyId);
        if (bgRel && !docsList.includes(bgRel)) {
          docsList.push(bgRel);
        }
        if (docsList.length > 0) {
          const lines = docsList.map(d => `  - ${d}`).join('\n');
          return `Checklist ${args.itemId}: ${results.join(', ')}\n\n📄 Related documents (please check whether the code changes affect these documents and sync them while memory is fresh):\n${lines}${commitHint}`;
        }
      }

      return `Checklist ${args.itemId}: ${results.join(', ')}${commitHint}`;
      });
    },

    light_review(args: {
      storyId: string;
      checklistIds: string[];
      note?: string;
    }): string {
      if (!args.storyId) throw new Error('storyId is required');
      if (!Array.isArray(args.checklistIds) || args.checklistIds.length === 0) {
        throw new Error('checklistIds must be a non-empty array');
      }

      // Validate story exists
      store.readStory(args.storyId);

      // Validate checklist item IDs exist
      return withChecklistLock(ctx, args.storyId, () => {
      const cl = store.readChecklist(args.storyId);
      const validIds = new Set(cl.items.map(i => i.id));
      for (const id of args.checklistIds) {
        if (!validIds.has(id)) throw new Error(`Checklist item ${id} not found in ${args.storyId}`);
      }

      // Deduplicate checklistIds
      const uniqueIds = [...new Set(args.checklistIds)];

      // Append process event
      store.appendProcessEvent(args.storyId, {
        type: 'light_review',
        checklistIds: uniqueIds,
        ...(args.note ? { note: args.note } : {}),
      });

      const ids = uniqueIds.join(', ');
      return `Light review recorded for ${args.storyId} (items: ${ids})`;
      });
    },

    async verification_evidence_add(args: {
      storyId: string;
      itemId: string;
      intentRef: string;
      kind: VerificationEvidenceKindInput;
      verdict?: VerificationEvidence['verdict'];
      waiverType?: VerificationEvidence['waiverType'];
      file?: string;
      command?: string;
      selector?: string;
      result?: 'pass' | 'fail';
      note: string;
      nonMechanicalReason?: string;
      commandTimeoutMs?: number;
      commandTimeoutReason?: string;
      attestation?: VerificationEvidence['attestation'];
      actorTrust?: VerificationEvidence['actorTrust'];
      factProvenance?: VerificationEvidence['factProvenance'];
    }): Promise<string> {
      // Local-only evidence write: record scoped Proof-or-Stop evidence and never POST.
      if (!args.note || args.note.trim().length < 5) {
        throw new Error('verification_evidence_add: note must be ≥ 5 characters, explaining why the evidence covers the intent');
      }
      assertEvidenceIsNotAcceptanceMatrixProjection(args);
      const kind = normalizeEvidenceKind(args.kind);
      if (args.waiverType && kind !== 'waiver') {
        throw new Error('verification_evidence_add: waiverType can only be used with kind=waiver');
      }
      const contradiction = detectEvidenceRowContradiction({ command: args.command, file: args.file });
      if (contradiction) {
        throw new Error(`verification_evidence_add: ${contradiction}`);
      }
      // B-cdf6 (B-META F-012): handler-entry re-validation of the audited timeout override
      // (the Zod constraints are only the first line of defense). enforceAndStampEvidence
      // re-checks the same pair at the enforcement boundary.
      resolveEvidenceCommandTimeout('verification_evidence_add', args);

      // B-ec67: run the pinned command / resolve enforcement OUTSIDE the checklist
      // lock (execution is async; withChecklistLock releases synchronously). The
      // pin write + evidence write then happen atomically inside the lock.
      const gitCwd = resolveStoryGitCwd(args.storyId);
      const preItem = store.readChecklist(args.storyId).items.find(i => i.id === args.itemId);
      if (!preItem) throw new Error(`Checklist item ${args.itemId} not found`);
      const stamp = await enforceAndStampEvidence(
        preItem,
        {
          storyId: args.storyId,
          intentRef: args.intentRef, kind, command: args.command, selector: args.selector,
          result: args.result, nonMechanicalReason: args.nonMechanicalReason,
          ...(args.commandTimeoutMs !== undefined ? { commandTimeoutMs: args.commandTimeoutMs } : {}),
          ...(args.commandTimeoutReason !== undefined ? { commandTimeoutReason: args.commandTimeoutReason } : {}),
        },
        {
          runCommand: (command, cwd, timeoutMs) => {
            const effectiveTimeoutMs = timeoutMs ?? resolvePinnedCommandTimeoutMs(root, command);
            return runSingleAllowlistedCommand(
              command, root, { cwd, ...(effectiveTimeoutMs !== undefined ? { timeoutMs: effectiveTimeoutMs } : {}) },
            );
          },
          cwd: gitCwd,
        },
      );

      return withChecklistLock(ctx, args.storyId, () => {
        const cl = store.readChecklist(args.storyId);
        const item = cl.items.find(i => i.id === args.itemId);
        if (!item) throw new Error(`Checklist item ${args.itemId} not found`);
        if (stamp.pin) applyVerificationPin(item, stamp.pin);
        const hashes = evidenceHashes(gitCwd, root);
        const command = stamp.evidencePatch.command ?? (args.command ? args.command.trim() : undefined);
        const result = stamp.evidencePatch.result ?? args.result;

        const evidence = makeEvidence({
          intentRef: args.intentRef,
          kind,
          ...(args.verdict ? { verdict: args.verdict } : {}),
          ...(args.waiverType ? { waiverType: args.waiverType } : {}),
          ...(args.file ? { file: args.file } : {}),
          ...(command ? { command } : {}),
          ...(result ? { result } : {}),
          note: args.note.trim(),
          ...(stamp.evidencePatch.mechanical !== undefined ? { mechanical: stamp.evidencePatch.mechanical } : {}),
          ...(stamp.evidencePatch.receipt ? { receipt: stamp.evidencePatch.receipt } : {}),
          ...(stamp.evidencePatch.nonMechanicalReason ? { nonMechanicalReason: stamp.evidencePatch.nonMechanicalReason } : {}),
          ...(args.attestation ? { attestation: args.attestation } : {}),
          ...(args.actorTrust ? { actorTrust: args.actorTrust } : {}),
          ...(args.factProvenance ? { factProvenance: args.factProvenance } : {}),
          ...hashes,
        });

        const existing = item.verificationEvidence || [];
        const idx = existing.findIndex(e => e.intentRef === args.intentRef);
        if (idx >= 0) existing[idx] = evidence;
        else existing.push(evidence);
        item.verificationEvidence = existing;

        store.writeChecklist(args.storyId, cl);
        const aliasNote = kind !== args.kind ? `, alias ${args.kind}` : '';
        const receiptNote = evidence.receipt
          ? `, receipt exit=${evidence.receipt.exitCode} selectorMatched=${evidence.receipt.selectorMatched}${renderReceiptSelectorNote(evidence.receipt)}${renderTimeoutOverrideNote(evidence.receipt)}`
          : '';
        const commitHint = autoCommitStoryMetadata(root, args.storyId, 'verification_evidence_add');
        return `Verification evidence recorded for ${args.itemId} → ${args.intentRef} (${kind}${aliasNote}${receiptNote})${commitHint}`;
      });
    },

    async verification_evidence_batch_add(args: {
      storyId: string;
      evidences: Array<{
        itemId: string;
        intentRef: string;
        kind: VerificationEvidenceKindInput;
        verdict?: VerificationEvidence['verdict'];
        waiverType?: VerificationEvidence['waiverType'];
        file?: string;
        command?: string;
        selector?: string;
        result?: 'pass' | 'fail';
        note: string;
        nonMechanicalReason?: string;
        commandTimeoutMs?: number;
        commandTimeoutReason?: string;
        attestation?: VerificationEvidence['attestation'];
        actorTrust?: VerificationEvidence['actorTrust'];
        factProvenance?: VerificationEvidence['factProvenance'];
      }>;
    }): Promise<string> {
      if (!Array.isArray(args.evidences) || args.evidences.length === 0) {
        throw new Error('verification_evidence_batch_add: evidences must be a non-empty array');
      }

      // Local preflight for all entries; any failure throws before the local
      // all-or-nothing batch write.
      const normalizedKinds: VerificationEvidence['kind'][] = [];
      for (const entry of args.evidences) {
        if (!entry.note || entry.note.trim().length < 5) {
          throw new Error(`verification_evidence_batch_add: ${entry.itemId} → ${entry.intentRef} note must be ≥ 5 characters`);
        }
        assertEvidenceIsNotAcceptanceMatrixProjection(entry);
        const kind = normalizeEvidenceKind(entry.kind);
        if (entry.waiverType && kind !== 'waiver') {
          throw new Error(`verification_evidence_batch_add: ${entry.itemId} → ${entry.intentRef} waiverType can only be used with kind=waiver`);
        }
        const entryContradiction = detectEvidenceRowContradiction({ command: entry.command, file: entry.file });
        if (entryContradiction) {
          throw new Error(`verification_evidence_batch_add: ${entry.itemId} → ${entry.intentRef} ${entryContradiction}`);
        }
        // B-cdf6 (B-META F-012): per-entry handler-entry re-validation of the audited
        // timeout override, so ONE bad entry fails the whole batch BEFORE any command is
        // executed (all-or-nothing). enforceAndStampEvidence re-checks it as well.
        resolveEvidenceCommandTimeout(
          `verification_evidence_batch_add: ${entry.itemId} → ${entry.intentRef}`,
          entry,
        );
        normalizedKinds.push(kind);
      }

      // B-ec67: run enforcement (incl. pinned-command execution) for EVERY entry through
      // the SAME shared helper as the single-add path, OUTSIDE the checklist lock. Any
      // refusal throws before the all-or-nothing write below, so the batch path is never
      // an unguarded bypass.
      const gitCwd = resolveStoryGitCwd(args.storyId);
      const runCommand: SingleCommandRunner = (command, cwd, timeoutMs) => {
        const effectiveTimeoutMs = timeoutMs ?? resolvePinnedCommandTimeoutMs(root, command);
        return runSingleAllowlistedCommand(
          command, root, { cwd, ...(effectiveTimeoutMs !== undefined ? { timeoutMs: effectiveTimeoutMs } : {}) },
        );
      };
      const preCl = store.readChecklist(args.storyId);
      const stamps: EnforceAndStampResult[] = [];
      for (let i = 0; i < args.evidences.length; i++) {
        const entry = args.evidences[i];
        const item = preCl.items.find(it => it.id === entry.itemId);
        if (!item) throw new Error(`Checklist item ${entry.itemId} not found`);
        stamps.push(await enforceAndStampEvidence(
          item,
          {
            storyId: args.storyId,
            intentRef: entry.intentRef, kind: normalizedKinds[i], command: entry.command,
            selector: entry.selector, result: entry.result, nonMechanicalReason: entry.nonMechanicalReason,
            ...(entry.commandTimeoutMs !== undefined ? { commandTimeoutMs: entry.commandTimeoutMs } : {}),
            ...(entry.commandTimeoutReason !== undefined ? { commandTimeoutReason: entry.commandTimeoutReason } : {}),
          },
          { runCommand, cwd: gitCwd },
        ));
      }

      return withChecklistLock(ctx, args.storyId, () => {
        const cl = store.readChecklist(args.storyId);
        const hashes = evidenceHashes(gitCwd, root);
        let written = 0;
        args.evidences.forEach((entry, i) => {
          const kind = normalizedKinds[i];
          const stamp = stamps[i];
          const item = cl.items.find(it => it.id === entry.itemId);
          if (!item) throw new Error(`Checklist item ${entry.itemId} not found`);
          if (stamp.pin) applyVerificationPin(item, stamp.pin);
          const command = stamp.evidencePatch.command ?? (entry.command ? entry.command.trim() : undefined);
          const result = stamp.evidencePatch.result ?? entry.result;
          const evidence = makeEvidence({
            intentRef: entry.intentRef,
            kind,
            ...(entry.verdict ? { verdict: entry.verdict } : {}),
            ...(entry.waiverType ? { waiverType: entry.waiverType } : {}),
            ...(entry.file ? { file: entry.file } : {}),
            ...(command ? { command } : {}),
            ...(result ? { result } : {}),
            note: entry.note.trim(),
            ...(stamp.evidencePatch.mechanical !== undefined ? { mechanical: stamp.evidencePatch.mechanical } : {}),
            ...(stamp.evidencePatch.receipt ? { receipt: stamp.evidencePatch.receipt } : {}),
            ...(stamp.evidencePatch.nonMechanicalReason ? { nonMechanicalReason: stamp.evidencePatch.nonMechanicalReason } : {}),
            ...(entry.attestation ? { attestation: entry.attestation } : {}),
            ...(entry.actorTrust ? { actorTrust: entry.actorTrust } : {}),
            ...(entry.factProvenance ? { factProvenance: entry.factProvenance } : {}),
            ...hashes,
          });
          const existing = item.verificationEvidence || [];
          const idx = existing.findIndex(e => e.intentRef === entry.intentRef);
          if (idx >= 0) existing[idx] = evidence;
          else existing.push(evidence);
          item.verificationEvidence = existing;
          written++;
        });
        store.writeChecklist(args.storyId, cl);
        const commitHint = autoCommitStoryMetadata(root, args.storyId, 'verification_evidence_batch_add');
        return `Verification evidence batch recorded for ${args.storyId}: ${written} item intent(s)${commitHint}`;
      });
    },

    /**
     * B-1507 CHK-001 — the ergonomic tool-executed verification path. Resolves an
     * intentRef to its owning item's PINNED verification:{command,selector}, then runs
     * the PINNED command through the SAME enforceAndStampEvidence enforcement boundary
     * and the SAME runSingleAllowlistedCommand executor as verification_evidence_add,
     * writing the receipt-bearing evidence row in one atomic step under the checklist lock.
     *
     * The caller NEVER authors the command — it comes exclusively from the immutable pin
     * (the whole ergonomic point: there is no command parameter to fill in, so the
     * false-command mistake class has no on-ramp here). The recorded `result` is DERIVED
     * from the receipt (exit + selector match) inside enforceAndStampEvidence; the schema
     * exposes no caller result field. The internal `result: 'pass'` below is a FIXED
     * expectation (verification_run's purpose is to PROVE the pin passes), used only to
     * trigger the shared helper's honest refusal on a non-zero exit — it is never a
     * caller-controlled value and never becomes the recorded result on its own.
     *
     * REFUSALS (no covered row is ever minted):
     *   - the intentRef does not resolve to an intent on the story  → [intent_ref_unresolved]
     *   - the resolved intent has no pinned command/selector to run → [verification_run_no_pin]
     *   - the pinned command exits non-zero / the selector is absent → the shared helper
     *     refuses ([receipt_exit_nonzero] / [receipt_selector_absent]); nothing is written.
     */
    async verification_run(args: {
      storyId: string;
      intentRef: string;
      itemId?: string;
      note?: string;
      cwd?: string;
    }): Promise<string> {
      // Resolve the owning item + its pinned verifier OUTSIDE the checklist lock
      // (execution is async; the lock body is synchronous). The receipt write then
      // happens atomically inside the lock, mirroring verification_evidence_add.
      const preCl = store.readChecklist(args.storyId);
      let preItem: ChecklistItem | undefined;
      if (args.itemId) {
        preItem = preCl.items.find(i => i.id === args.itemId);
        if (!preItem) throw new Error(`Checklist item ${args.itemId} not found`);
      } else {
        // No itemId: find the item whose verificationIntent owns this ref (a custom
        // intent id can override the CHK-n:lane:i shape, so search rather than parse).
        preItem = preCl.items.find(i => collectVerificationIntents(i).some(c => c.ref === args.intentRef));
      }
      if (!preItem) {
        throw new Error(
          `verification_run refused: intentRef ${args.intentRef} does not resolve to a verificationIntent on any checklist item in ${args.storyId} [intent_ref_unresolved]`,
        );
      }
      const itemId = preItem.id;
      const resolved = resolveIntentForRef(preItem, args.intentRef);
      if (!resolved) {
        throw new Error(
          `verification_run refused: intentRef ${args.intentRef} does not resolve to a verificationIntent on ${itemId} [intent_ref_unresolved]`,
        );
      }
      const pin = resolved.intent.verification;
      if (!pin) {
        throw new Error(
          `verification_run refused: intent ${args.intentRef} (type ${resolved.intent.type}) has no pinned ` +
          `verification:{command,selector} — there is nothing to execute. Pin it first via verification_evidence_add ` +
          `(command+selector), or record an audited non-mechanical attestation; verification_run only re-runs an ` +
          `already-pinned verifier and never mints an unexecuted covered row. [verification_run_no_pin]`,
        );
      }

      const gitCwd = resolveStoryGitCwd(args.storyId);
      const runCwd = args.cwd ? (isAbsolute(args.cwd) ? args.cwd : join(gitCwd, args.cwd)) : gitCwd;
      const kind = intentTypeToEvidenceKind(resolved.intent.type);

      // Run the PINNED command through the shared enforcement boundary. We pass the pin's
      // OWN command+selector (never a caller value); result:'pass' is the fixed expectation
      // so a non-zero exit or absent selector is REFUSED here (no row minted).
      // enforceAndStampEvidence derives the recorded result from the actual receipt.
      //
      // B-cdf6 (B-META F-012): verification_run deliberately exposes NO timeout override —
      // its whole point is that the caller authors nothing, and the pin carries no budget.
      // It therefore keeps the executor default (byte-identical to pre-B-cdf6). A long
      // witness that needs a raised budget must be recorded via verification_evidence_add,
      // where the raise is attributable to a commandTimeoutReason. A timed-out run here
      // still gets the DISTINCT [receipt_command_timeout] diagnosis instead of a
      // misleading selector-absent refusal.
      const stamp = await enforceAndStampEvidence(
        preItem,
        { storyId: args.storyId, intentRef: args.intentRef, kind, command: pin.command, selector: pin.selector, result: 'pass' },
        {
          runCommand: (command, cwd, timeoutMs) => {
            const effectiveTimeoutMs = timeoutMs ?? resolvePinnedCommandTimeoutMs(root, command);
            return runSingleAllowlistedCommand(
              command, root, { cwd, ...(effectiveTimeoutMs !== undefined ? { timeoutMs: effectiveTimeoutMs } : {}) },
            );
          },
          cwd: runCwd,
        },
      );

      return withChecklistLock(ctx, args.storyId, () => {
        const cl = store.readChecklist(args.storyId);
        const item = cl.items.find(i => i.id === itemId);
        if (!item) throw new Error(`Checklist item ${itemId} not found`);
        if (stamp.pin) applyVerificationPin(item, stamp.pin); // defensive: pin already existed
        const hashes = evidenceHashes(gitCwd, root);
        const note = (args.note && args.note.trim().length >= 5)
          ? args.note.trim()
          : `verification_run executed the pinned verifier for ${args.intentRef}`;
        const evidence = makeEvidence({
          intentRef: args.intentRef,
          kind,
          ...(stamp.evidencePatch.command ? { command: stamp.evidencePatch.command } : {}),
          ...(stamp.evidencePatch.result ? { result: stamp.evidencePatch.result } : {}),
          note,
          ...(stamp.evidencePatch.mechanical !== undefined ? { mechanical: stamp.evidencePatch.mechanical } : {}),
          ...(stamp.evidencePatch.receipt ? { receipt: stamp.evidencePatch.receipt } : {}),
          ...hashes,
        });
        const existing = item.verificationEvidence || [];
        const idx = existing.findIndex(e => e.intentRef === args.intentRef);
        if (idx >= 0) existing[idx] = evidence;
        else existing.push(evidence);
        item.verificationEvidence = existing;
        store.writeChecklist(args.storyId, cl);
        const receiptNote = evidence.receipt
          ? `, receipt exit=${evidence.receipt.exitCode} selectorMatched=${evidence.receipt.selectorMatched}${renderReceiptSelectorNote(evidence.receipt)}`
          : '';
        const commitHint = autoCommitStoryMetadata(root, args.storyId, 'verification_run');
        return `Verification run recorded for ${itemId} → ${args.intentRef} (${kind}, ran pinned command${receiptNote})${commitHint}`;
      });
    },

    /**
     * B-1482 CHK-003: the narrowing-only re-pin, reachable as the `verification_pin_narrow`
     * command. A re-pin an operator cannot run delivers none of this story's value, so the
     * entry point is bound here rather than left as a code-only export.
     *
     * This method is a NAME BINDING ONLY: every check lives in `narrowVerificationPin`
     * (inadmissible caller output, unknown fields, empty selector, the 30-character reason
     * floor, the one-narrowing-per-recorded-receipt-set bound, and the recorded-receipt
     * proof itself). Per the Handler Encoding Conventions the CLI schema's `min(1)` /
     * `min(30)` constraints are only the FIRST line: the function re-checks both at runtime
     * after trimming, so an internal fn caller, an old JSON payload or any other path that
     * never touches Zod is refused identically.
     */
    verification_pin_narrow(args: VerificationPinNarrowingRequest): string {
      return narrowVerificationPin(ctx, args);
    },

    /**
     * B-1507 CHK-002: the stale-evidence refresh now RE-EXECUTES pinned executable rows
     * instead of demoting them. For every stale row whose intent carries an immutable
     * `verification:{command,selector}` (a mechanical receipt or any pinned executable
     * intent), the PINNED command is re-run OUTSIDE the checklist lock through the SAME
     * `enforceAndStampEvidence` refusal path + `runSingleAllowlistedCommand` executor as
     * `verification_run` / `verification_evidence_add` (no second executor). On a real
     * pass a fresh receipt bound to the CURRENT head/material is re-stamped and the row
     * stays `mechanical:true` covered. On ANY failure (exit != 0, selector absent,
     * command unavailable / not allowlisted, resolution error) the re-run throws, no
     * pass-stamp is recorded, and the row falls through to the pre-B-1507 demote path —
     * a covered receipt is NEVER re-minted without a real pass (no laundering). Rows
     * WITHOUT a pinned command keep the freshness-only / demote behavior unchanged.
     *
     * In-process callers whose contract forbids running a command as a side effect
     * (`evidence_refresh`, `done_prepare`, `recover_evidence`) use the synchronous
     * `refreshStaleEvidenceMetadataOnly` export instead of this re-executing handler.
     */
    async verification_evidence_refresh_stale(args: {
      storyId: string;
      dryRun?: boolean;
    }): Promise<string> {
      const computed = collectStaleRefreshContext(ctx, args.storyId);
      if (computed.stale.length === 0) {
        return `No stale verification evidence for ${args.storyId}`;
      }

      // Re-execute pinned executable rows OUTSIDE the checklist lock (execution is
      // async; the write body is synchronous). Rows with byte-identical execution
      // semantics share one invocation, but each row is independently pin/provenance
      // validated before grouping and again under the write lock before consuming the
      // shared receipt. Only a real mechanical pass records stamps for the group;
      // every failure leaves every grouped row absent so all take the demotion path.
      const reexecByKey = new Map<string, ReexecStamp>();
      if (!args.dryRun) {
        const groups = new Map<string, { representative: StaleReexecCandidate; rowKeys: string[] }>();
        for (const entry of computed.stale) {
          const item = computed.cl.items.find(i => i.id === entry.itemId);
          if (!item) continue;
          try {
            const candidate = staleReexecCandidate(
              root,
              computed.refreshGitCwd,
              item,
              entry.intentRef,
              entry.evidence,
            );
            if (!candidate) continue;
            const group = groups.get(candidate.executionKey);
            if (group) group.rowKeys.push(candidate.rowKey);
            else groups.set(candidate.executionKey, { representative: candidate, rowKeys: [candidate.rowKey] });
          } catch {
            // Invalid carried timeout/provenance: preserve the existing fail-closed
            // behavior by leaving this row unexecuted so writeStaleRefresh demotes it.
          }
        }

        for (const group of groups.values()) {
          const candidate = group.representative;
          try {
            const stamp = await enforceAndStampEvidence(
              candidate.item,
              candidate.input,
              {
                runCommand: (command, cwd, timeoutMs) => {
                  const effectiveTimeoutMs = timeoutMs ?? resolvePinnedCommandTimeoutMs(root, command);
                  return runSingleAllowlistedCommand(
                    command, root, { cwd, ...(effectiveTimeoutMs !== undefined ? { timeoutMs: effectiveTimeoutMs } : {}) },
                  );
                },
                cwd: computed.refreshGitCwd,
              },
            );
            if (stamp.evidencePatch.mechanical === true && stamp.evidencePatch.receipt) {
              for (const rowKey of group.rowKeys) {
                reexecByKey.set(rowKey, {
                  ...(stamp.evidencePatch.command ? { command: stamp.evidencePatch.command } : {}),
                  ...(stamp.evidencePatch.result ? { result: stamp.evidencePatch.result } : {}),
                  mechanical: true,
                  receipt: {
                    ...stamp.evidencePatch.receipt,
                    ...(stamp.evidencePatch.receipt.timeoutOverride
                      ? { timeoutOverride: { ...stamp.evidencePatch.receipt.timeoutOverride } }
                      : {}),
                  },
                  executionKey: candidate.executionKey,
                });
              }
            }
            // A non-mechanical / receiptless stamp is not a real pass → leave for demote.
          } catch {
            // exit != 0 / selector absent / command unavailable / not allowlisted /
            // resolution error: leave ALL rows sharing this exact key on the demote
            // path. NO laundering and no per-row retry that could exceed the watchdog.
          }
        }
      }

      return writeStaleRefresh(ctx, args.storyId, computed, { dryRun: args.dryRun, reexecByKey });
    },

    /**
     * B-4e06 CHK-001: audited legacy repair. Reconstructs ONLY missing
     * verificationIntent lanes from existing PASSING verificationEvidence, for
     * mid-flight stories adopted after evidence was already recorded. Never
     * overwrites authored intent; fail-closed on malformed refs; synthesized
     * intents are priority='should' so the backfill can never retroactively
     * weaponize the hard coverage gate. Refused in INIT/INIT_CHECK/terminal.
     */
    verification_intent_repair(args: {
      storyId: string;
      mode: 'fromEvidence';
      legacyRepair: boolean;
      reason: string;
      dryRun?: boolean;
    }): string {
      // --- LOCAL PREFLIGHT (fail-closed, BEFORE any read/write) ----------------
      if (args.mode !== 'fromEvidence') {
        throw new Error("verification_intent_repair: mode must be 'fromEvidence' (the only supported mode)");
      }
      if (args.legacyRepair !== true) {
        throw new Error('verification_intent_repair: legacyRepair must be explicitly true — confirm this is a legacy evidence-without-intent backfill, not normal PLAN work');
      }
      if (!args.reason || args.reason.trim().length < 30) {
        throw new Error('verification_intent_repair: reason must be ≥ 30 characters (substantial justification of what you verified)');
      }
      const story = assertChecklistMutationCwd(store, args.storyId);
      if (INTENT_REPAIR_REFUSED_PHASES.has(story.phase)) {
        throw new Error(`verification_intent_repair refused in ${story.phase} phase: only PLAN/DEV/REVIEW/TEST stories with mid-flight evidence can be repaired`);
      }
      return withChecklistLock(ctx, args.storyId, () => {
        const cl = store.readChecklist(args.storyId);
        const filled = reconstructMissingIntentsFromEvidence(cl);
        const header = `${args.dryRun ? '[DRY-RUN] ' : ''}verification_intent_repair (fromEvidence) for ${args.storyId}`;
        if (filled.length === 0) {
          return `${header}\nNo missing verificationIntent lanes with passing evidence — nothing to repair.`;
        }
        const lines = [header, `Reconstructed ${filled.length} intent lane(s) from passing evidence:`, ...filled.map(f => `  + ${f}`)];
        if (args.dryRun) {
          lines.push('→ Rerun without dryRun to write these reconstructed intents (priority=should).');
          return lines.join('\n');
        }
        store.writeChecklist(args.storyId, cl);
        const commitHint = autoCommitStoryMetadata(root, args.storyId, 'verification_intent_repair');
        lines.push(`Wrote ${filled.length} reconstructed intent(s). Re-run proof-or-stop validate --story=${args.storyId} --json`);
        if (commitHint) lines.push(commitHint.replace(/^\n/, ''));
        return lines.join('\n');
      });
    },


  };
}
