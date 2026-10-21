/**
 * Lab run131 (bench-staging/oldpos/run127-129-phase-cost.md: run 128 REM2 32 min, run 129 timed out; run131-analysis.md):
 * the null-end / pinned-test ping-pong. A resolved finding G's covering test states the value a checklist row pins for a
 * case (e.g. a null bound is an error); an open finding F demands the opposite (it should behave like an omitted value).
 * Each repair of F broke G's test, the resolved-finding guard rejected it ([repair_breaks_resolved_finding]), and
 * findingConflictOf (core/resolved-finding-guard.ts) kind `rejected` sent the Story back to PLAN (`finding_conflict_pin`)
 * every time, because every rejection is a NEW conflict whose `since` postdates the pin.
 *
 * The framework decides such a conflict ONCE by precedence (request text > base behaviour > reviewer opinion):
 *   - the case is pinned by a current checklist row, and G's recorded covering test states that same pin
 *     (guardStatesPins agrees). The row's derivation passed the PLAN gates (request quote, base form, counterpart), so the
 *     pin is the request / base side; F is the reviewer opinion.
 *   - winner `request` when the pinning row's requestQuote is a sentence of the request, else `checklist_pin`.
 *   - F loses: closed by ONE framework step (finding_resolve disposition finding_conflict_settled, resolutionType
 *     superseded, `[finding_conflict_settled]` reason, severity unchanged), journaled (runtime/finding-conflict/<story>.jsonl).
 *   - a later finding re-judging the same case against the same resolved finding (kind `same_case`) is settled by that
 *     record while the pin still agrees; a re-pin to F's side (pins disagree) reopens the question as before.
 * Not settled (today's route stands): a `[precedent-conflict]` finding, a case no row pins (lab run137: the framework pin
 * of core/finding-conflict-pin.ts decides it when the request or F's stated Story base value does; else one
 * finding_conflict_pin), a pin that disagrees with G's test (the guard excuses the repair; F is repaired against the pin).
 * Rollback: remediation.conflictSettle=off.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';
import { isFileStateSettled } from './file-state-conflict.js';
import { normalizeProbe } from './probe-text.js';

export const FINDING_CONFLICT_SETTLED = 'finding_conflict_settled';
export const FINDING_CONFLICT_REASON_PREFIX = `[${FINDING_CONFLICT_SETTLED}]`;
export const FINDING_CONFLICT_PRECEDENCE = 'request text > base behaviour > reviewer opinion';
const SCHEMA = 'proof-or-stop.finding_conflict_settle.v1' as const;

interface ResolvedSlice { status?: string; resolutionType?: string; resolvedReason?: string }

/** A finding the framework closed as the losing side of a finding conflict. */
export function isConflictSettled(finding: ResolvedSlice): boolean {
  return finding.status === 'resolved' && finding.resolutionType === 'superseded' && String(finding.resolvedReason ?? '').startsWith(FINDING_CONFLICT_REASON_PREFIX);
}

/** Closed by a framework settlement (file-state or finding conflict): never guarded, never a conflict partner, never re-verified. */
export function isFrameworkSettled(finding: ResolvedSlice): boolean {
  return isFileStateSettled(finding) || isConflictSettled(finding);
}

export type ConflictKind = 'precedent' | 'rejected' | 'same_case';
export interface ConflictSlice { findingId: string; resolvedId: string | null; kind?: ConflictKind; since?: string; why: string }
interface FindingSlice { id: string; desc?: string; severity?: string }
type IntentRow = { desc?: string; derivation?: { requestQuote?: string; computation?: string } };
interface ItemSlice { id: string; verificationIntent?: Partial<Record<'happy' | 'edge' | 'adversarial', IntentRow[]>> }
export interface SettledCase { resolvedId: string; cases: string[]; winner: string }

/** Lab run137: `story_base` = the framework pin's Story base side (core/finding-conflict-pin.ts, no checklist row pins the case). */
export interface ConflictSettlement { settle: true; winner: 'request' | 'checklist_pin' | 'story_base'; reason: string; cases: string[]; resolvedId: string }

const short = (id: string): string => id.replace(/^[^:]+:/, '');
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();
const sameCase = (a: string, b: string): boolean => {
  const x = normalizeProbe(a); const y = normalizeProbe(b);
  return x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x));
};

/** The rows citing one of `repros` (item id, lane, row). */
function pinningRows(items: readonly ItemSlice[] | undefined, repros: readonly string[]): Array<{ itemId: string; row: IntentRow }> {
  const probes = repros.map(normalizeProbe).filter(probe => probe.length >= 4);
  if (!items || !probes.length) return [];
  const out: Array<{ itemId: string; row: IntentRow }> = [];
  for (const item of items) {
    for (const lane of ['happy', 'edge', 'adversarial'] as const) {
      for (const row of item.verificationIntent?.[lane] ?? []) {
        if (probes.some(probe => normalizeProbe(String(row.desc ?? '')).includes(probe))) out.push({ itemId: item.id, row });
      }
    }
  }
  return out;
}

/**
 * The framework's decision for one finding conflict, or null when it is not the framework's to decide (see the module
 * comment). `pins` is guardStatesPins for the resolved finding's guard (null = no row pins the case).
 */
export function findingConflictSettlement(args: { finding: FindingSlice; conflict: ConflictSlice; guarded: FindingSlice | null | undefined;
  pins: { pins: string[]; agrees: boolean } | null; items: readonly ItemSlice[] | undefined; requestText: string | null; repros: readonly string[];
  settledCases?: readonly SettledCase[] }): ConflictSettlement | null {
  const { finding, conflict } = args;
  const resolvedId = conflict.resolvedId;
  if (!resolvedId || conflict.kind === 'precedent' || /\[precedent-conflict\]/i.test(finding.desc ?? '')) return null;
  if (args.pins && !args.pins.agrees) return null;
  const cases = [...new Set(args.repros)].filter(repro => normalizeProbe(repro).length >= 4);
  if (!cases.length) return null;
  const record = (args.settledCases ?? []).find(row => row.resolvedId === resolvedId && row.cases.some(done => cases.some(own => sameCase(own, done))));
  const pinnedNow = Boolean(args.pins?.agrees && args.pins.pins.length);
  if (!pinnedNow && !record) return null;
  if (!pinnedNow && conflict.kind !== 'same_case') return null;
  const rows = pinningRows(args.items, cases);
  const request = args.requestText ? flat(args.requestText) : '';
  const quoted = rows.find(entry => {
    const quote = flat(String(entry.row.derivation?.requestQuote ?? '')).replace(/^[-*]\s*/, '');
    return quote.length >= 8 && request.includes(quote);
  });
  const winner: ConflictSettlement['winner'] = quoted ? 'request' : record?.winner === 'request' ? 'request' : 'checklist_pin';
  const caseText = cases.map(repro => `\`${repro}\``).join(', ');
  const pinText = args.pins?.pins.length ? ` (${args.pins.pins.join(', ')})` : '';
  const side = winner === 'request'
    ? `the request states it (${quoted ? `"${String(quoted.row.derivation?.requestQuote ?? '').trim().slice(0, 160)}"` : 'settled earlier'}), the checklist${quoted ? ` row ${quoted.itemId}` : ''} pins it${pinText} and resolved ${short(resolvedId)}'s covering test states the same`
    : `the request is silent; the checklist${rows[0] ? ` row ${rows[0].itemId}` : ''} pins it${pinText} (its PLAN derivation passed the base-form and counterpart checks) and resolved ${short(resolvedId)}'s covering test states the same`;
  const reason = `${FINDING_CONFLICT_REASON_PREFIX} ${short(finding.id)} demands the opposite of resolved ${short(resolvedId)} for ${caseText}`
    + `${record && !pinnedNow ? ' (a case the framework already settled)' : ` (${conflict.why})`}. Decided once by the framework's precedence (${FINDING_CONFLICT_PRECEDENCE}): ${side}. `
    + `${short(finding.id)} is the reviewer-opinion side: closed without a repair; severity unchanged. A re-pin of the case in PLAN (re-pin: <case> was <old>, now <new>) reopens it.`;
  return { settle: true, winner, reason, cases, resolvedId };
}

// ---------------------------------------------------------------------------
// Journal

interface Entry { schema: typeof SCHEMA; at: string; findingId: string; resolvedId: string; cases: string[]; winner: string; why: string }

const journal = (root: string, storyId: string): string => join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'finding-conflict', `${storyId}.jsonl`);

function entries(root: string, storyId: string): Entry[] {
  try {
    return readFileSync(journal(root, storyId), 'utf8').split('\n').flatMap(line => {
      try { const row = JSON.parse(line) as Entry; return row?.schema === SCHEMA ? [row] : []; } catch { return []; }
    });
  } catch { return []; }
}

/** Journal one settlement once per (finding, resolved finding) pair (evidence; no gate depends on the write succeeding). */
export function recordConflictSettlement(root: string, storyId: string, entry: { findingId: string; resolvedId: string; cases: string[]; winner: string; why: string }): void {
  try {
    if (entries(root, storyId).some(row => row.findingId === entry.findingId && row.resolvedId === entry.resolvedId)) return;
    mkdirSync(dirname(journal(root, storyId)), { recursive: true });
    writeFileSync(journal(root, storyId), `${JSON.stringify({ schema: SCHEMA, at: new Date().toISOString(), ...entry })}\n`, { flag: 'a' });
  } catch { /* evidence only */ }
}

/** The settled pairs, journal order. */
export function conflictSettlements(root: string, storyId: string): Array<{ findingId: string; resolvedId: string; cases: string[]; winner: string; why: string }> {
  return entries(root, storyId).map(({ findingId, resolvedId, cases, winner, why }) => ({ findingId, resolvedId, cases, winner, why }));
}
