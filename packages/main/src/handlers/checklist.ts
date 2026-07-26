
import { existsSync } from 'fs';
import { join } from 'path';
import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import { execSync } from 'child_process';
import { checkEvidenceFreshnessForGit, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import type { ChecklistData, ChecklistItem, ChecklistStatus, StoryInfo, VerificationEvidence, VerificationExecutionReceipt, VerificationIntent, VerificationIntentItem, VerificationIntentPin, VerificationIntentType, VerificationLane } from '../core/types.js';
import { buildVerificationCoverage, collectVerificationIntents, isExecutableIntentType, makeEvidence, VERIFICATION_LANES } from '../core/verification.js';
import { runSingleAllowlistedCommand, type SingleCommandExecutionResult } from '../core/validation-executor.js';
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

const INIT_REVIEWER_CHECKLIST_MUTATION_BLOCKED_AGENTS = new Set([
  'lattice-review-story-init',
  'product-reviewer',
]);

type VerificationEvidenceKindInput = VerificationEvidence['kind'] | 'cli' | 'logic';
type VerificationEvidenceInput = Omit<VerificationEvidence, 'kind'> & { kind: VerificationEvidenceKindInput };
type ChecklistGetArgs = { storyId: string; slim?: boolean; fields?: string[] };

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
 * the gitignored shared `.lattice/locks/checklist/<id>-checklist.lock` so the
 * universal holder.json can never be committed inside `.lattice/story/actives/`
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
  return process.env.LATTICE_AGENT?.trim() || process.env.USER?.trim() || 'main-agent';
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
  return `Advisory: milestone ledger exists for ${storyId}; if this new checklist item (${itemId}) changes milestone coverage, update/sync the ledger with \`lattice milestone_ledger_add\` or an explicit ledger update.`;
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
  intentRef: string;
  kind: VerificationEvidence['kind'];
  command?: string;
  selector?: string;
  result?: 'pass' | 'fail';
  nonMechanicalReason?: string;
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

type SingleCommandRunner = (command: string, cwd: string) => Promise<SingleCommandExecutionResult>;

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
 *        Stamp the receipt {exitCode,outputDigest,outputTail,selectorMatched,executedAt}.
 *   d. Executable + audited escape (nonMechanicalReason ≥ 30) → record non-mechanical,
 *        attributable, no execution (still demoted by the coverage gate).
 *   e. Executable + no selector + no pin + no escape → LEGACY-shaped write: stored as-is,
 *        mechanical left undefined (grandfathered), no execution.
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

  // Legacy-shaped write for an executable intent (no selector, no pin) → grandfather.
  // Enforcement is opt-in via a selector on the first write, then mandatory (the pin
  // is immutable). This is what keeps in-flight stories and legacy fixtures loadable.
  if (!existingPin && !callerSelector) {
    return {
      evidencePatch: {
        ...(input.result ? { result: input.result } : {}),
        ...(callerCommand ? { command: callerCommand } : {}),
      },
    };
  }

  // Mechanical path: determine the immutable pinned command + selector.
  let pinCommand: string;
  let pinSelector: string;
  let pinToSet: EnforceAndStampResult['pin'];
  if (existingPin) {
    if (!callerCommand) {
      throw new Error(
        `verification evidence refused: receipt-command-mismatch: expected ${existingPin.command}, got <none> (executable intent ${input.intentRef} is pinned; the command must be provided and match) [receipt_command_mismatch]`,
      );
    }
    if (callerCommand !== existingPin.command) {
      throw new Error(
        `verification evidence refused: receipt-command-mismatch: expected ${existingPin.command}, got ${callerCommand} (the verification pin is immutable) [receipt_command_mismatch]`,
      );
    }
    if (callerSelector && callerSelector !== existingPin.selector) {
      throw new Error(
        `verification evidence refused: receipt-selector-mismatch: expected ${existingPin.selector}, got ${callerSelector} (the verification pin is immutable) [receipt_selector_mismatch]`,
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
  const run = await deps.runCommand(pinCommand, deps.cwd);
  const exitOk = run.code === 0 && !run.timedOut;
  const selectorMatched = run.output.includes(pinSelector);

  // Refuse: a caller cannot claim pass when the command did not exit 0.
  if (input.result === 'pass' && !exitOk) {
    throw new Error(
      `verification evidence refused: pinned command exited ${run.code}${run.timedOut ? ' (timed out)' : ''} but result:pass was claimed for ${input.intentRef} [receipt_exit_nonzero]`,
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
    executedAt: new Date().toISOString(),
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
          `Run lattice scope_shrinkage_decision_set with withdrawnChecklistItemRefs including ${args.itemId}. [withdrawn_requires_scope_shrinkage_decision]`,
        );
      }

      // USER is retained below for human audit attribution, but it is not a
      // dispatched-agent identity. Only an explicit actor/agent or
      // LATTICE_AGENT participates in registry authorization.
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
            ? `From PLAN: run lattice story_advance '{"storyId":"${args.storyId}","phase":"INIT","reason":"<why the frozen title must change>"}', edit the title, then re-run INIT review and re-advance INIT_CHECK -> PLAN`
            : `From DEV: first roll back to PLAN with lattice story_advance '{"storyId":"${args.storyId}","phase":"PLAN"}', then lattice story_advance '{"storyId":"${args.storyId}","phase":"INIT","reason":"<why>"}'`}. ` +
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
        item.verificationEvidence = args.verificationEvidence.map(ev => normalizeEvidence(resolveStoryGitCwd(args.storyId), root, ev));
        results.push(`verificationEvidence updated (${args.verificationEvidence.length})`);
      }

      if (args.status) {
        item.status = args.status;
        if (args.status === 'in_progress' && !item.startTime) {
          item.startTime = now;
        }
        if (args.status === 'done') {
          item.endTime = now;
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
      // pure conclusion so `lattice checklist_update | tail` pipelines are unaffected.
      try {
        const persisted = store.readChecklist(args.storyId).items.find(i => i.id === args.itemId);
        const persistedStatus = persisted ? persisted.status : '<unknown>';
        process.stderr.write(
          `↻ Written and persistence confirmed: ${args.itemId} current status=${persistedStatus}. ` +
          `For long sessions please reload (lattice checklist_get / session_brief) before relying on the snapshot.\n`,
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
      attestation?: VerificationEvidence['attestation'];
      actorTrust?: VerificationEvidence['actorTrust'];
      factProvenance?: VerificationEvidence['factProvenance'];
    }): Promise<string> {
      // Local-only evidence write: record scoped Proofbound evidence and never POST.
      if (!args.note || args.note.trim().length < 5) {
        throw new Error('verification_evidence_add: note must be ≥ 5 characters, explaining why the evidence covers the intent');
      }
      assertEvidenceIsNotAcceptanceMatrixProjection(args);
      const kind = normalizeEvidenceKind(args.kind);
      if (args.waiverType && kind !== 'waiver') {
        throw new Error('verification_evidence_add: waiverType can only be used with kind=waiver');
      }

      // B-ec67: run the pinned command / resolve enforcement OUTSIDE the checklist
      // lock (execution is async; withChecklistLock releases synchronously). The
      // pin write + evidence write then happen atomically inside the lock.
      const gitCwd = resolveStoryGitCwd(args.storyId);
      const preItem = store.readChecklist(args.storyId).items.find(i => i.id === args.itemId);
      if (!preItem) throw new Error(`Checklist item ${args.itemId} not found`);
      const stamp = await enforceAndStampEvidence(
        preItem,
        { intentRef: args.intentRef, kind, command: args.command, selector: args.selector, result: args.result, nonMechanicalReason: args.nonMechanicalReason },
        { runCommand: (command, cwd) => runSingleAllowlistedCommand(command, root, { cwd }), cwd: gitCwd },
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
        const receiptNote = evidence.receipt ? `, receipt exit=${evidence.receipt.exitCode} selectorMatched=${evidence.receipt.selectorMatched}` : '';
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
        normalizedKinds.push(kind);
      }

      // B-ec67: run enforcement (incl. pinned-command execution) for EVERY entry through
      // the SAME shared helper as the single-add path, OUTSIDE the checklist lock. Any
      // refusal throws before the all-or-nothing write below, so the batch path is never
      // an unguarded bypass.
      const gitCwd = resolveStoryGitCwd(args.storyId);
      const runCommand: SingleCommandRunner = (command, cwd) => runSingleAllowlistedCommand(command, root, { cwd });
      const preCl = store.readChecklist(args.storyId);
      const stamps: EnforceAndStampResult[] = [];
      for (let i = 0; i < args.evidences.length; i++) {
        const entry = args.evidences[i];
        const item = preCl.items.find(it => it.id === entry.itemId);
        if (!item) throw new Error(`Checklist item ${entry.itemId} not found`);
        stamps.push(await enforceAndStampEvidence(
          item,
          { intentRef: entry.intentRef, kind: normalizedKinds[i], command: entry.command, selector: entry.selector, result: entry.result, nonMechanicalReason: entry.nonMechanicalReason },
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

    verification_evidence_refresh_stale(args: {
      storyId: string;
      dryRun?: boolean;
    }): string {
      return withChecklistLock(ctx, args.storyId, () => {
      const cl = store.readChecklist(args.storyId);
      let headHash = '';
      // B-75f0 CHK-001: refresh freshness from the RESOLVED gitRoot, not the bare
      // metadataRoot. On a wrapper-root layout the bare root is not a git repo, so
      // `git rev-parse HEAD` threw and refresh was impossible. metadataRoot stays
      // `root` for the storyDir-aware material exclusion. Plain repos: gitCwd==root.
      const refreshGitCwd = resolveStoryGitCwd(args.storyId);
      try {
        headHash = execSync('git rev-parse HEAD', { cwd: refreshGitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      } catch {
        throw new Error('verification_evidence_refresh_stale: cannot read git HEAD in current directory, unable to refresh freshness');
      }
      const materialHash = currentMaterialHash(refreshGitCwd, 'HEAD', root);
      const storyFilesHash = currentStoryFilesHash(refreshGitCwd, 'HEAD', root);
      const coverage = buildVerificationCoverage(
        cl,
        headHash,
        (oldHeadHash, evidence) => checkEvidenceFreshnessForGit(refreshGitCwd, oldHeadHash, evidence?.materialHash, root, evidence?.storyFilesHash).fresh,
        { deferredGateEvidence: 'missing' },
      );
      const stale = coverage.entries.filter(e => e.status === 'stale' && e.evidence);
      if (stale.length === 0) {
        return `No stale verification evidence for ${args.storyId}`;
      }

      const lines = [
        `${args.dryRun ? '[DRY-RUN] ' : ''}Stale verification evidence for ${args.storyId}: ${stale.length}`,
      ];
      let refreshed = 0;
      for (const entry of stale) {
        const item = cl.items.find(i => i.id === entry.itemId);
        const existing = item?.verificationEvidence || [];
        const idx = existing.findIndex(e => e.intentRef === entry.intentRef);
        const ev = idx >= 0 ? existing[idx] : entry.evidence;
        lines.push(`  - ${entry.intentRef}: ${ev?.command || ev?.file || ev?.kind || 'evidence'} → ${headHash.slice(0, 7)}`);
        if (args.dryRun || !item || idx < 0 || !ev) continue;
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
        });
        item.verificationEvidence = existing;
        refreshed++;
      }

      if (!args.dryRun) store.writeChecklist(args.storyId, cl);
      lines.push(args.dryRun
        ? '→ Rerun the above command without dryRun to refresh evidence metadata'
        : `Refreshed ${refreshed}/${stale.length} stale evidence item(s). Re-run lattice validate --story=${args.storyId} --json`);
      if (!args.dryRun) {
        const commitHint = autoCommitStoryMetadata(root, args.storyId, 'verification_evidence_refresh_stale');
        if (commitHint) lines.push(commitHint.replace(/^\n/, ''));
      }
      return lines.join('\n');
      });
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
        lines.push(`Wrote ${filled.length} reconstructed intent(s). Re-run lattice validate --story=${args.storyId} --json`);
        if (commitHint) lines.push(commitHint.replace(/^\n/, ''));
        return lines.join('\n');
      });
    },


  };
}
