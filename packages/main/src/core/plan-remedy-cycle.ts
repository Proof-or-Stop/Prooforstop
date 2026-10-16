/**
 * Lab run102 (bench-staging/oldpos/run100-103-analysis.md §1, §5 item 2): a framework-level cycle breaker for PLAN remedies.
 *
 * Run 102: `plan_pin_dispute` removed a row and excluded its case; the next `next` returned `counterpart_coverage_missing`
 * asking for a row on exactly that case; the owner re-added it, the reviewer disputed it again, and the two framework remedies
 * alternated ten times until the owner stopped (reward 0). Each remedy was right by its own rule; nothing compared them.
 *
 * Every PLAN remedy step that requires a case (a row must exist for it) or drops one (a row removed / the case excluded)
 * journals the cases it touches, `runtime/plan-remedy/<storyId>.jsonl`, keyed `<item>|<operation>|<class>` (the counterpart
 * gate's case key) or `<item>|row|<case side>`. Before a step is offered, `planRemedyConflict` checks whether it REVERSES the
 * latest remedy another step gave on the same case (or a settlement recorded for it). A reversal is resolved once, by the
 * framework's precedence, never alternated:
 *
 *   request text (rank 3) > the Story base: the same receiver's counterpart / a base probe (rank 2) > the scope-plan reviewer's
 *   opinion or a skippable lint (rank 1); on a tie the side that keeps the row (require) wins: a test row never lowers detection.
 *
 * The resolution is journaled as a settlement: the winner's direction stands for that case; a later offer against it by a
 * lower authority is suppressed (its gap on the settled rows is settled for story_review, core/counterpart-coverage.ts
 * counterpartSettledGaps), so `next` always has ONE consistent runnable step.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';
import { counterpartRowRoles, type CounterpartCoverageResult } from './counterpart-coverage.js';

export const PLAN_REMEDY_SCHEMA = 'proof-or-stop.plan-remedy.v1' as const;
export const PLAN_REMEDY_CYCLE = 'plan_remedy_cycle';

export type RemedyDir = 'drop' | 'require';
export interface RemedyKey { key: string; dir: RemedyDir; ref?: string }
export interface RemedyOffer { kind: string; keys: RemedyKey[] }

/** The authority each PLAN remedy step speaks for (its precedence rank). */
const AUTHORITY: Record<string, { rank: number; label: string }> = {
  request_pin_check: { rank: 3, label: 'the request text' },
  counterpart_coverage_missing: { rank: 2, label: 'the same receiver\'s counterpart in the Story base' },
  pin_probe_mismatch: { rank: 2, label: 'a probe of the Story base' },
  pin_oracle_mismatch: { rank: 2, label: 'the project\'s evaluator on the Story base' },
  plan_pin_dispute: { rank: 1, label: 'the scope-plan reviewer\'s opinion' },
  pin_audit_correction: { rank: 1, label: 'the scope-plan reviewer\'s opinion' },
  plan_review_blockers: { rank: 1, label: 'the scope-plan reviewer\'s opinion' },
  unstated_pin_check: { rank: 1, label: 'a skippable PLAN lint' },
};
export const remedyAuthority = (kind: string): { rank: number; label: string } => AUTHORITY[kind] ?? { rank: 1, label: kind };
export const PLAN_REMEDY_PRECEDENCE = 'request text > the Story base (the same receiver\'s counterpart, a base probe) > the scope-plan reviewer\'s opinion; on a tie the remedy that keeps the row';

interface OfferEntry { schema: typeof PLAN_REMEDY_SCHEMA; at: 'offer'; checkedAt: string; kind: string; keys: RemedyKey[] }
interface SettleEntry { schema: typeof PLAN_REMEDY_SCHEMA; at: 'settle'; checkedAt: string; key: string; dir: RemedyDir; winner: string; loser: string; why: string; refs?: string[]; desc?: string }
type Entry = OfferEntry | SettleEntry;

export interface RemedyConflict {
  key: string;
  previous: { kind: string; dir: RemedyDir; settled: boolean };
  candidate: { kind: string; dir: RemedyDir };
  winner: string;
  winnerDir: RemedyDir;
  candidateWins: boolean;
  why: string;
}

const journal = (root: string, storyId: string): string => join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'plan-remedy', `${storyId}.jsonl`);

function entries(root: string, storyId: string): Entry[] {
  try {
    return readFileSync(journal(root, storyId), 'utf8').split('\n').flatMap(line => {
      try { const row = JSON.parse(line) as Entry; return row?.schema === PLAN_REMEDY_SCHEMA ? [row] : []; } catch { return []; }
    });
  } catch { return []; }
}

function append(root: string, storyId: string, entry: Entry): void {
  try {
    mkdirSync(dirname(journal(root, storyId)), { recursive: true });
    writeFileSync(journal(root, storyId), `${JSON.stringify(entry)}\n`, { flag: 'a' });
  } catch { /* evidence; the gate predicates never depend on a write succeeding */ }
}

function resolve(key: string, previous: RemedyConflict['previous'], candidate: RemedyConflict['candidate']): RemedyConflict {
  const prior = remedyAuthority(previous.kind);
  const next = remedyAuthority(candidate.kind);
  const candidateWins = next.rank > prior.rank || (next.rank === prior.rank && candidate.dir === 'require');
  const winner = candidateWins ? candidate.kind : previous.kind;
  const winnerDir = candidateWins ? candidate.dir : previous.dir;
  const verb = (dir: RemedyDir): string => (dir === 'require' ? 'requires a row for' : 'drops');
  const why = `[${PLAN_REMEDY_CYCLE}] ${candidate.kind} ${verb(candidate.dir)} the case ${key}, which ${previous.kind}${previous.settled ? ' (settled)' : ''} ${verb(previous.dir)}: `
    + `the two remedies would alternate. Resolved by the framework's precedence (${PLAN_REMEDY_PRECEDENCE}): ${winner} (${remedyAuthority(winner).label}) stands`;
  return { key, previous, candidate, winner, winnerDir, candidateWins, why };
}

/**
 * The conflict the offer would start, or null: the offer reverses, on one of its cases, the latest remedy another step gave
 * (or the settlement recorded for that case). Repeats of the same step are never a conflict.
 */
export function planRemedyConflict(root: string, storyId: string, offer: RemedyOffer): RemedyConflict | null {
  const rows = entries(root, storyId);
  for (const key of offer.keys) {
    const settled = rows.filter((row): row is SettleEntry => row.at === 'settle' && row.key === key.key).at(-1);
    if (settled) {
      if (settled.dir === key.dir) continue;
      return resolve(key.key, { kind: settled.winner, dir: settled.dir, settled: true }, { kind: offer.kind, dir: key.dir });
    }
    const previous = rows.filter((row): row is OfferEntry => row.at === 'offer' && row.kind !== offer.kind && row.keys.some(candidate => candidate.key === key.key)).at(-1);
    const dir = previous?.keys.find(candidate => candidate.key === key.key)?.dir;
    if (previous && dir && dir !== key.dir) return resolve(key.key, { kind: previous.kind, dir, settled: false }, { kind: offer.kind, dir: key.dir });
  }
  return null;
}

/** Journal an offered remedy and, when it resolved a conflict, the settlement (winner, direction, the losing step). */
export function recordPlanRemedy(root: string, storyId: string, offer: RemedyOffer, conflict?: RemedyConflict | null, settled?: { refs?: string[]; desc?: string }): void {
  // A step `next` prints again unchanged (the owner has not run it yet) is journaled once.
  const latest = entries(root, storyId).filter(row => row.at === 'offer').at(-1) as OfferEntry | undefined;
  const repeat = latest?.kind === offer.kind && JSON.stringify(latest.keys) === JSON.stringify(offer.keys);
  if (offer.keys.length && !repeat) append(root, storyId, { schema: PLAN_REMEDY_SCHEMA, at: 'offer', checkedAt: new Date().toISOString(), kind: offer.kind, keys: offer.keys });
  if (conflict) {
    append(root, storyId, { schema: PLAN_REMEDY_SCHEMA, at: 'settle', checkedAt: new Date().toISOString(), key: conflict.key, dir: conflict.winnerDir,
      winner: conflict.winner, loser: conflict.candidateWins ? conflict.previous.kind : conflict.candidate.kind, why: conflict.why, ...(settled ?? {}) });
  }
}

/** Journal a settlement the framework decides directly (a disputed required row with no remedy left: it stands). */
export function recordRemedySettlement(root: string, storyId: string, entry: { key: string; dir: RemedyDir; winner: string; loser: string; why: string; refs?: string[]; desc?: string }): void {
  append(root, storyId, { schema: PLAN_REMEDY_SCHEMA, at: 'settle', checkedAt: new Date().toISOString(), ...entry });
}

/** The cases with a settlement (latest first wins per key). */
export function settledRemedyKeys(root: string, storyId: string): string[] {
  return [...new Set(entries(root, storyId).filter((row): row is SettleEntry => row.at === 'settle').map(row => row.key))];
}

/**
 * Rows whose reviewer gap the framework settled: a settlement won by a higher authority than the reviewer that keeps the
 * case (`require`), for the rows that currently exercise the case (`rowsOfKey`) or the refs it recorded (when the row still
 * reads as recorded). Returns ref -> why.
 */
export function remedySettledRefs(root: string, storyId: string, rowsOfKey: (key: string) => string[], descOf: (ref: string) => string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of entries(root, storyId)) {
    if (row.at !== 'settle' || row.dir !== 'require' || remedyAuthority(row.winner).rank <= remedyAuthority(row.loser).rank) continue;
    const refs = row.refs?.length ? row.refs.filter(ref => row.desc === undefined || descOf(ref) === row.desc) : rowsOfKey(row.key);
    for (const ref of refs) out.set(ref, row.why);
  }
  return out;
}

/**
 * Lab run102: rows whose gap the PLAN remedy cycle breaker settled (core/plan-remedy-cycle.ts): the rows that currently
 * exercise a settled counterpart case, or the refs a settlement recorded while they still read as recorded.
 */
export function remedySettledRefsOf(root: string, storyId: string, counterpart: Pick<CounterpartCoverageResult, 'checks'> | null,
  items: ReadonlyArray<{ id: string; verificationIntent?: Partial<Record<string, ReadonlyArray<{ desc?: unknown }>>> }>): Map<string, string> {
  const roles = counterpartRowRoles(counterpart);
  const byKey = new Map<string, string[]>();
  for (const [ref, list] of roles) for (const role of list) if (role.role !== 'contradicted' && !role.repin) byKey.set(role.key, [...(byKey.get(role.key) ?? []), ref]);
  const descOf = (ref: string): string | null => {
    const [itemId, lane, index] = ref.split(':');
    const row = (items.find(item => item.id === itemId)?.verificationIntent?.[lane as 'edge'] ?? [])[Number(index)] as { desc?: string } | undefined;
    return row?.desc ?? null;
  };
  return remedySettledRefs(root, storyId, key => byKey.get(key) ?? [], descOf);
}

