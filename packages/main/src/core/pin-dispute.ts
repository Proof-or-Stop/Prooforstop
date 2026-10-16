/**
 * Lab run95 (bench-staging/oldpos/run93-96-analysis.md §5.2, §7 fix 1c): the scope-plan reviewer returned the same
 * blocker on the same row five verdicts in a row (run 95: `pin-audit <row>` on an owner-invented exact error); each time
 * `next` handed the owner the generic placeholder patch ("<row with the expected value the request gives>") and relaunched
 * a full reviewer (2.7-9.5 min each, +25 min in total). The owner tried five different values; none was stated by the
 * request.
 *
 * Escalation (framework-owned remedy, no round cap): when a gap of the current verdict cites a row that a gap of the
 * previous verdict cited too (the verdicts are the Git history of scope-check.json; scope_check_save commits each), the
 * dispute is not answered by another guess. `next` returns ONE step `plan_pin_dispute` whose command needs no authoring:
 *   relax   an error row (it pins an exact text) keeps its case and pins only that an error is raised (the request states
 *           no text for it): "<case> -> error";
 *   exclude a value row is removed and its case excluded, with the item's userSees edited in the same call so the
 *           exclusion check does not refuse it (core/scope-exclusion-rationale.ts exclusionUserSeesRemedy);
 *   re-pin  when the item itself adds the case (an exclusion cannot hold), the row is re-pinned to the value the request
 *           or a base probe of the same receiver gives (the one field left for the owner).
 * Lab run102 (run 102: ten offers alternating with the counterpart gate, owner stopped, reward 0): a row the counterpart gate
 * requires (core/counterpart-coverage.ts) is never removed nor its case excluded; see pinDisputeRemedy. Every remedy's case
 * also goes to the PLAN remedy cycle breaker (core/plan-remedy-cycle.ts).
 * The offer is journaled (`runtime/pin-dispute/<storyId>.jsonl`) and the reviewer's rerun context names the disputed rows
 * and the remedy applied (orientation, neutral). Only under EXPERIMENTAL A/B `plan.disputeConfirm=on` is that rerun a
 * confirmation re-review (ADR-043: the previous verdict stands for the untouched items), which can miss a new gap in an
 * unchanged row: detection-affecting, default off.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { ChecklistItem, ScopeCheckData } from './types.js';
import type { StoryStore } from './store.js';
import { VERIFICATION_LANES } from './verification.js';
import { caseSide, pinnedText, unstatedPinRowPatch } from './unstated-pin.js';
import { expectedSide, literals } from './exact-error-pin-lint.js';
import { exclusionUserSeesRemedy } from './scope-exclusion-rationale.js';
import { counterpartRowRoles, edgeLabel, rowPinsError, COUNTERPART_PRECEDENCE, type CounterpartCoverageResult } from './counterpart-coverage.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';

export const PIN_DISPUTE_SCHEMA = 'proof-or-stop.pin-dispute.v1' as const;
const ROW_REF = /\b(CHK-\d+):(happy|edge|adversarial):(\d+)\b/g;
const MAX_HISTORY = 8;
const ERROR_TEXT = /\b(?:error|errors|raise[sd]?|throws?|exception|fails?|failed|panic|reject(?:s|ed)?|invalid|not supported|cannot|expects?)\b/i;

type Verdict = Pick<ScopeCheckData, 'checkedAt' | 'features'>;

/** The Story's scope-plan verdicts, newest first, one per checkedAt (the current file first, then its Git history). */
export function scopeVerdictHistory(args: { store: Pick<StoryStore, 'readScopeCheck' | 'storyDirPath'>; storyId: string; gitCwd: string }): Verdict[] {
  const out: Verdict[] = [];
  const seen = new Set<string>();
  const push = (verdict: Verdict | null | undefined): void => {
    if (!verdict?.checkedAt || seen.has(verdict.checkedAt)) return;
    seen.add(verdict.checkedAt);
    out.push(verdict);
  };
  try { push(args.store.readScopeCheck(args.storyId)); } catch { /* none */ }
  try {
    const prefix = relative(realpathSync(args.gitCwd), realpathSync(args.store.storyDirPath(args.storyId))).replaceAll('\\', '/');
    if (prefix.startsWith('..')) return out;
    const git = (argv: string[]) => execFileSync('git', argv, { cwd: args.gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
    const commits = git(['log', `-${MAX_HISTORY}`, '--format=%H', '--', `${prefix}/scope-check.json`]).split('\n').filter(Boolean);
    for (const commit of commits) {
      try { push(JSON.parse(git(['show', `${commit}:${prefix}/scope-check.json`])) as Verdict); } catch { /* deleted at that commit */ }
    }
  } catch { /* no history: no dispute */ }
  return out;
}

/** Row refs a verdict's gap rows cite. */
export function gapRowRefs(verdict: Verdict): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const feature of verdict.features ?? []) {
    if (feature.status !== 'gap') continue;
    for (const match of feature.feature.matchAll(ROW_REF)) out.set(match[0], [...(out.get(match[0]) ?? []), feature.feature]);
  }
  return out;
}

export interface DisputedRow { ref: string; itemId: string; lane: string; index: number; verdicts: number; features: string[] }

/** Rows a gap of the current verdict cites that a gap of the previous verdict cited too, with the length of that streak. */
export function disputedRows(history: readonly Verdict[]): DisputedRow[] {
  if (history.length < 2) return [];
  const refs = history.map(gapRowRefs);
  const out: DisputedRow[] = [];
  for (const [ref, features] of refs[0]!) {
    let streak = 1;
    while (streak < refs.length && refs[streak]!.has(ref)) streak += 1;
    if (streak < 2) continue;
    const match = ref.match(/^(CHK-\d+):(happy|edge|adversarial):(\d+)$/)!;
    out.push({ ref, itemId: match[1]!, lane: match[2]!, index: Number(match[3]), verdicts: streak, features });
  }
  return out;
}

/**
 * Lab run102: `counterpart` = re-pinned to the base counterpart's value (the counterpart gate requires the case); `settle` = no
 * command left (the required row already pins only the error): the framework records that the row stands and the gap is
 * settled. `note` is what the scope-plan rerun is told about the row; `key` / `dir` feed the PLAN remedy cycle breaker.
 */
export interface PinDisputeRemedy { ref: string; kind: 'relax' | 'exclude' | 'repin' | 'counterpart' | 'settle'; payload: Record<string, unknown> | null; why: string;
  note?: string; key?: string; dir?: 'drop' | 'require' }

type ItemLike = Pick<ChecklistItem, 'id' | 'title' | 'userSees' | 'status' | 'excludes'> & { verificationIntent?: ChecklistItem['verificationIntent']; files?: { modify?: readonly string[]; create?: readonly string[] } };

/**
 * The one remedy command of a disputed row (see the module header).
 * Lab run102 (run 102 deadlock): with the counterpart gate's result (`counterpart`), a row the gate requires for a case
 * (clear pair, added operation, strong evidence, request silent) is never removed nor its case excluded: a
 * counterpart-backed row gets no remedy (its gap is settled), an error pinned where the counterpart resolves the case and a
 * value that differs from the counterpart's are re-pinned to the counterpart value, any other error row is relaxed with its
 * case kept, and a row already pinning only the error is settled (it stands).
 */
export function pinDisputeRemedy(args: { storyId: string; item: ItemLike; dispute: DisputedRow; requestText: string | null;
  counterpart?: Pick<CounterpartCoverageResult, 'checks'> | null }): PinDisputeRemedy | null {
  const { storyId, item, dispute } = args;
  const row = (item.verificationIntent?.[dispute.lane as (typeof VERIFICATION_LANES)[number]] ?? [])[dispute.index] as { desc?: string; derivation?: { requestQuote?: string } } | undefined;
  if (!row?.desc) return null;
  const desc = String(row.desc);
  const side = expectedSide(desc);
  const minimal = /^\s*error\s*$/i.test(side) && side.length !== desc.length;
  const error = rowPinsError(desc) || ERROR_TEXT.test(side);
  const text = pinnedText(desc) ?? literals(side).find(value => /[A-Za-z]/.test(value)) ?? (error && !minimal && side.length !== desc.length ? side.trim() : null);
  const streak = `the scope-plan reviewer raised ${dispute.ref} in ${dispute.verdicts} consecutive verdicts`;
  const required = (counterpartRowRoles(args.counterpart).get(dispute.ref) ?? []).filter(role => role.required);
  if (required.length) {
    const role = required.find(entry => entry.role === 'contradicted') ?? required.find(entry => entry.role === 'backed') ?? required[0]!;
    const counterpartName = role.counterpart.replace(/ \(.*\)$/, '');
    const requirement = `${dispute.ref} is the row the framework's counterpart gate requires for the ${edgeLabel(role.edge)} case of ${role.operation} (the same receiver's counterpart ${role.counterpart} special-cases it`
      + `${role.resolves ? ` and resolves it: \`${role.resolves}\`` : ''}); removing it or excluding the case would re-open [counterpart_coverage_missing]`;
    const tail = { key: role.key };
    if (role.role === 'backed') return null;
    if (role.role === 'contradicted' || role.repin || (!error && !minimal)) {
      const ready = role.repin;
      const intentRow = ready
        ? { ref: dispute.ref, desc: ready.desc, derivation: { requestQuote: String(row.derivation?.requestQuote ?? ''), computation: ready.computation } }
        : { ref: dispute.ref, desc: `${caseSide(desc)} -> <the result ${counterpartName} gives for this case on the Story base (probe it), unless the request says otherwise>`,
          derivation: { requestQuote: String(row.derivation?.requestQuote ?? ''), computation: `<the ${counterpartName} base probe of this case and its result, then the pinned value>` } };
      return { ref: dispute.ref, kind: 'counterpart', payload: { storyId, itemId: item.id, intentRows: [intentRow], reason: `${streak}; re-pinned to the base counterpart's value (${COUNTERPART_PRECEDENCE})` },
        why: `${requirement}: re-pin it to the value ${counterpartName} gives${ready ? ` (ready: \`${ready.desc}\`)` : ''} instead of another guess (precedence: ${COUNTERPART_PRECEDENCE})`,
        note: `re-pinned to the base counterpart's value: the framework requires a row for this ${edgeLabel(role.edge)} case of ${role.operation} (the same receiver's counterpart ${role.counterpart} special-cases it) and the request is silent on it; judge the derivation from the counterpart, not the request's silence`,
        ...tail, dir: 'require' };
    }
    if (error && !minimal) {
      const patch = unstatedPinRowPatch({ itemId: item.id, ref: dispute.ref, desc, value: text ?? side.trim(), kind: 'unstated', error: true }, row, args.requestText);
      return { ref: dispute.ref, kind: 'relax', payload: { storyId, itemId: item.id, intentRows: [patch], reason: `${streak}; the row pins only the error, its case kept (the counterpart gate requires it)` },
        why: `${requirement}: keep the case and relax the row to \`${String(patch.desc).slice(0, 160)}\` (the request states no text for this error)`,
        note: `relaxed to the error only, the case kept: the framework requires a row for this ${edgeLabel(role.edge)} case of ${role.operation} (the same receiver's counterpart ${role.counterpart} special-cases it)`,
        ...tail };
    }
    return { ref: dispute.ref, kind: 'settle', payload: null,
      why: `${requirement}; it already pins only that an error is raised, so no remedy is left that keeps the case: the row stands and the framework settles the gap (precedence: ${COUNTERPART_PRECEDENCE})`,
      note: `kept as is (it pins only the error): the framework requires a row for this ${edgeLabel(role.edge)} case of ${role.operation} (the same receiver's counterpart ${role.counterpart} special-cases it)`,
      ...tail, dir: 'require' };
  }
  if (error && text) {
    const patch = unstatedPinRowPatch({ itemId: item.id, ref: dispute.ref, desc, value: text, kind: 'unstated', error: true }, row, args.requestText);
    return { ref: dispute.ref, kind: 'relax', payload: { storyId, itemId: item.id, intentRows: [patch], reason: `${streak}; the request states no text for this error, so the row pins only the error` },
      why: `${dispute.ref} pins the exact text \`${text.slice(0, 120)}\`, which the request does not state: relax it to \`${String(patch.desc).slice(0, 160)}\``};
  }
  const entry = `${caseSide(desc).slice(0, 200)}: the request does not state the expected value for this case (${streak})`;
  const excluded = exclusionUserSeesRemedy(entry, item);
  if (excluded.contradictedBy !== 'title_or_files') {
    const payload: Record<string, unknown> = { storyId, itemId: item.id, intentRows: [{ ref: dispute.ref, remove: true }], excludes: [...(item.excludes ?? []), entry],
      ...(excluded.contradictedBy === 'userSees' ? { userSees: excluded.userSees } : {}), reason: `${streak}; the case is excluded and its row removed` };
    return { ref: dispute.ref, kind: 'exclude', payload, dir: 'drop',
      why: `${dispute.ref}'s case is not settled by the request: remove the row and exclude the case${excluded.contradictedBy === 'userSees' ? `, and drop from ${item.id}'s userSees the clause(s) naming it (${excluded.dropped.map(clause => `"${clause.slice(0, 120)}"`).join(', ')}) so the exclusion is not refused [scope_exclusion_contradicted]` : ''}` };
  }
  return { ref: dispute.ref, kind: 'repin', payload: { storyId, itemId: item.id, intentRows: [{ ref: dispute.ref, desc: `${caseSide(desc)} -> <the value the request states, else the value a Story-base probe of the same receiver gives>`,
    derivation: { requestQuote: String(row.derivation?.requestQuote ?? ''), computation: '<the probe command and its output, or the request sentence and the steps to the value>' } }], reason: streak },
  why: `${item.id} itself adds ${dispute.ref}'s case (its title / files name it; shared terms: ${excluded.shared.join(', ')}), so an exclusion cannot hold: re-pin the row to the value the request states or a base probe of the same receiver gives` };
}

// ---------------------------------------------------------------------------
// Journal (the offer) and the rerun context

const journal = (root: string, storyId: string): string => join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'pin-dispute', `${storyId}.jsonl`);

export function recordPinDispute(root: string, storyId: string, verdictAt: string, remedies: readonly PinDisputeRemedy[]): void {
  try {
    mkdirSync(dirname(journal(root, storyId)), { recursive: true });
    writeFileSync(journal(root, storyId), `${JSON.stringify({ schema: PIN_DISPUTE_SCHEMA, storyId, at: 'next_offer', checkedAt: new Date().toISOString(), verdictAt,
      rows: remedies.map(row => ({ ref: row.ref, kind: row.kind, ...(row.note ? { note: row.note } : {}) })) })}\n`, { flag: 'a' });
  } catch { /* evidence only */ }
}

/** The dispute offered on the verdict `verdictAt`, if any (the rerun after it is a dispute rerun). */
export function pinDisputeOffered(root: string, storyId: string, verdictAt: string | undefined): Array<{ ref: string; kind: string; note?: string }> | null {
  if (!verdictAt) return null;
  try {
    const rows = readFileSync(journal(root, storyId), 'utf8').split('\n').flatMap(line => {
      try { return [JSON.parse(line) as { verdictAt?: string; rows?: Array<{ ref: string; kind: string; note?: string }> }]; } catch { return []; }
    }).filter(row => row.verdictAt === verdictAt);
    return rows.length ? rows.at(-1)!.rows ?? [] : null;
  } catch { return null; }
}
