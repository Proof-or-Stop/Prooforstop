/**
 * Old-PoS run 68 (bench-staging/oldpos/run68-analysis.md §5 link 1, fix 3): a repair
 * that changes an expected value re-pins the checklist rows stating the old one.
 *
 * Run 68 R1 found a real defect; the finding-repair run fixed the code AND changed the
 * expected literal of the table-test rows that asserted the defective value. Two
 * checklist intent rows still pinned `<case> -> <old value>` (intents are owner metadata,
 * frozen outside PLAN), so the round-2 lanes reported them as Story-metadata corrections,
 * which cost two wasted lane waves, a dead end, a REVIEW->DEV->PLAN trip, a scope-plan
 * rerun and a third round (+34 min).
 *
 * Now, when `finding_resolve` accepts a repair (single or batch form), the framework reads
 * the repair commit's own test diff: a removed / added line pair in a test file that
 * differs in exactly ONE string literal, everything else (the case) identical, is an
 * expected value the repair changed (`testLiteralChanges`). When a current intent row
 * states that case with the old value (`<case> -> <old>`, inside one backticked span,
 * as two spans joined by the arrow, or as the whole row), the change is journaled
 * (process event `repair_expected_value_changed`) and becomes an open intent-row
 * correction (core/metadata-correction.ts): `next` takes the Story to PLAN (framework
 * hop) and applies the row patch itself (a framework `checklist_update` with
 * `metadataCorrection=true`, `intentRows`) before the next round. The patched row keeps
 * its quote style and states the re-pin (`re-pin: <case> was <old>, now <new>` in its
 * derivation computation, or in its desc when it has none), so the run-58 pin-reversal
 * rule holds; its request quote is kept.
 *
 * Never weakened: a case the request states literally (`<case> -> <value>` examples of
 * request.md) is never re-pinned (the request outranks a repair; a contradiction is the
 * review's), a row whose patched intent would fail the derivation rule is left to the
 * owner, and only the verified finding's own repair commit is read. Detection-neutral:
 * no lane, critic, round or verification is skipped; the checklist only stops stating
 * a value the code and its tests no longer have for that case.
 *
 * Generic: string literals of any language's test files; no task values.
 */
import { execFileSync } from 'node:child_process';
import type { ChecklistItem, VerificationIntent } from './types.js';
import { VERIFICATION_LANES } from './verification.js';
import { isTestPath, normalizeProbe } from './probe-text.js';
import { requestLiteralExamples } from './request-literal-examples.js';
import { closestRequestSentence, intentDerivationRows } from './intent-derivation.js';

export const REPAIR_VALUE_CHANGED_EVENT = 'repair_expected_value_changed';

/** One expected literal a repair commit changed in a test file. */
export interface RepairValueChange {
  file: string;
  /** The removed line (trimmed): the case as tested before the repair. */
  before: string;
  /** The added line (trimmed). */
  after: string;
  /** The changed literal as written before / after (quotes included). */
  old: string;
  new: string;
}

/** A framework row patch: `<case> -> <old>` restated with the repaired value. */
export interface RepairRowPatch {
  itemId: string;
  ref: string;
  desc: string;
  derivation?: Record<string, unknown>;
  caseText: string;
  oldValue: string;
  newValue: string;
  /** The statement the row made (as stated) and makes after the patch. */
  wrongStatement: string;
  correctedStatement: string;
}

const STRING_LITERAL = /"(?:[^"\\\n]|\\.)*"|`[^`\n]*`|'(?:[^'\\\n]|\\.)*'/g;
const squash = (text: string): string => text.replace(/\s+/g, '');
const unquote = (literal: string): string => literal.replace(/^(["'`])([\s\S]*)\1$/, '$2');

/** Pairs of (removed, added) line runs of equal length inside each test-file hunk. */
function changedLinePairs(diff: string): Array<{ file: string; removed: string; added: string }> {
  const out: Array<{ file: string; removed: string; added: string }> = [];
  let file: string | null = null;
  let removed: string[] = [];
  let added: string[] = [];
  const flush = (): void => {
    if (file && isTestPath(file) && removed.length && removed.length === added.length) {
      removed.forEach((line, index) => out.push({ file: file!, removed: line, added: added[index]! }));
    }
    removed = []; added = [];
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { flush(); file = null; continue; }
    if (line.startsWith('+++ ')) { flush(); const path = line.slice(4).trim(); file = path === '/dev/null' ? null : path.replace(/^b\//, ''); continue; }
    if (line.startsWith('--- ')) { flush(); continue; }
    if (line.startsWith('@@')) { flush(); continue; }
    if (line.startsWith('-')) { if (added.length) flush(); removed.push(line.slice(1)); continue; }
    if (line.startsWith('+')) { added.push(line.slice(1)); continue; }
    flush();
  }
  flush();
  return out;
}

/**
 * The expected literals a unified diff (`git show -U0`) changed in test files: a removed /
 * added line pair whose string literals differ in exactly one position while the rest of
 * the line (literals masked) is identical. Additions, deletions, product files and lines
 * that change the case too are ignored.
 */
export function testLiteralChanges(diff: string): RepairValueChange[] {
  const out: RepairValueChange[] = [];
  for (const pair of changedLinePairs(diff)) {
    const before = [...pair.removed.matchAll(STRING_LITERAL)].map(match => match[0]);
    const after = [...pair.added.matchAll(STRING_LITERAL)].map(match => match[0]);
    if (!before.length || before.length !== after.length) continue;
    if (squash(pair.removed.replace(STRING_LITERAL, '\u0000')) !== squash(pair.added.replace(STRING_LITERAL, '\u0000'))) continue;
    const differing = before.map((literal, index) => (literal === after[index] ? -1 : index)).filter(index => index >= 0);
    if (differing.length !== 1) continue;
    const at = differing[0]!;
    out.push({ file: pair.file, before: pair.removed.trim(), after: pair.added.trim(), old: before[at]!, new: after[at]! });
  }
  return out;
}

/** The test-literal changes of one commit (its own diff), or [] when unreadable. */
export function repairValueChangesOfCommit(gitCwd: string, commit: string): RepairValueChange[] {
  try {
    const diff = execFileSync('git', ['show', '--format=', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames', commit],
      { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    return testLiteralChanges(diff);
  } catch {
    return [];
  }
}

interface StatedPin { caseText: string; valueText: string; valueStart: number; statement: string }

/**
 * The `<case> -> <value>` statements of a row desc, with the value's offset in the desc:
 * one backticked span holding the arrow, two spans joined by it, or (no backticks) the
 * whole desc.
 */
function statedPins(desc: string): StatedPin[] {
  const out: StatedPin[] = [];
  const spans = [...desc.matchAll(/`([^`\n]+)`/g)].map(match => ({ text: match[1]!, start: match.index! + 1, end: match.index! + match[0].length }));
  for (const [index, span] of spans.entries()) {
    const arrow = span.text.match(/\s*(?:->|→|=>)\s*/);
    if (arrow && arrow.index !== undefined && arrow.index > 0) {
      const valueText = span.text.slice(arrow.index + arrow[0].length).trim();
      if (valueText) out.push({ caseText: span.text.slice(0, arrow.index).trim(), valueText, valueStart: span.start + arrow.index + arrow[0].length, statement: span.text.trim() });
      continue;
    }
    const next = spans[index + 1];
    if (!next || /->|→|=>/.test(next.text)) continue;
    const between = desc.slice(span.end, next.start - 1);
    if (!/^\s*(?:->|→|=>)\s*$/.test(between)) continue;
    out.push({ caseText: span.text.trim(), valueText: next.text, valueStart: next.start, statement: desc.slice(span.start - 1, next.end) });
  }
  if (spans.length === 0) {
    const arrow = desc.match(/\s*(?:->|→|=>)\s*/);
    if (arrow && arrow.index !== undefined && arrow.index > 0) {
      const valueText = desc.slice(arrow.index + arrow[0].length).trim();
      if (valueText) out.push({ caseText: desc.slice(0, arrow.index).trim(), valueText, valueStart: desc.indexOf(valueText, arrow.index + arrow[0].length), statement: desc.trim() });
    }
  }
  return out;
}

/** The value as the row should state it: the repaired literal in the row's own quote style. */
function restated(valueText: string, change: RepairValueChange): string | null {
  if (normalizeProbe(valueText) === normalizeProbe(change.old)) return change.new;
  if (normalizeProbe(valueText) === normalizeProbe(unquote(change.old))) return unquote(change.new);
  return null;
}

const describeFindings = (findingIds: readonly string[]): string => findingIds.map(id => id.replace(/^[^:]+:/, '')).join(', ');

/**
 * Row patches for every current intent row that states, for the case a change's test
 * line tests, the value the repair replaced. `requestText`: a case the request states
 * literally with that old value is never re-pinned; with a request, a patched row must
 * still satisfy the derivation rule (its request quote kept, else the closest request
 * sentence), otherwise it is left to the owner.
 */
export function repairRowPatches(items: readonly ChecklistItem[], changes: readonly RepairValueChange[], requestText: string | null,
  origin: { findingIds?: readonly string[]; commit?: string } = {}): RepairRowPatch[] {
  if (!changes.length) return [];
  const examples = requestText ? requestLiteralExamples(requestText) : [];
  const requestStates = (caseText: string, value: string): boolean => examples.some(example => squash(example.input) === squash(caseText)
    && [value, unquote(value)].some(form => normalizeProbe(example.output) === normalizeProbe(form) || normalizeProbe(unquote(example.output)) === normalizeProbe(form)));
  const why = `the repair${origin.findingIds?.length ? ` of verified finding(s) ${describeFindings(origin.findingIds)}` : ''}${origin.commit ? ` (commit ${origin.commit.slice(0, 12)})` : ''} changed this expected value in its test`;
  const out: RepairRowPatch[] = [];
  for (const item of items) {
    if (item.status === 'withdrawn' || !item.verificationIntent) continue;
    for (const lane of VERIFICATION_LANES) {
      (item.verificationIntent[lane] ?? []).forEach((row, index) => {
        const ref = `${item.id}:${lane}:${index}`;
        const desc = String(row.desc ?? '');
        for (const pin of statedPins(desc)) {
          if (squash(pin.caseText).length < 3) continue;
          const change = changes.find(candidate => squash(candidate.before).includes(squash(pin.caseText)) && squash(candidate.after).includes(squash(pin.caseText))
            && restated(pin.valueText, candidate) !== null);
          if (!change) continue;
          if (requestStates(pin.caseText, change.old)) continue;
          const newValue = restated(pin.valueText, change)!;
          const patchedDesc = `${desc.slice(0, pin.valueStart)}${newValue}${desc.slice(pin.valueStart + pin.valueText.length)}`;
          const repin = `re-pin: ${pin.caseText} was ${pin.valueText}, now ${newValue}: ${why}`;
          const derivation = row.derivation && typeof row.derivation === 'object'
            ? { ...(row.derivation as unknown as Record<string, unknown>), computation: repin }
            : requestText ? (() => { const quote = closestRequestSentence(desc, requestText); return quote ? { requestQuote: quote, computation: repin } : null; })() : undefined;
          if (derivation === null) continue;
          const at = pin.statement.lastIndexOf(pin.valueText);
          const patch: RepairRowPatch = { itemId: item.id, ref, desc: derivation ? patchedDesc : `${patchedDesc} (${repin})`,
            ...(derivation ? { derivation } : {}), caseText: pin.caseText, oldValue: pin.valueText, newValue,
            wrongStatement: pin.statement, correctedStatement: `${pin.statement.slice(0, at)}${newValue}${pin.statement.slice(at + pin.valueText.length)}` };
          if (requestText) {
            // The patched row must still satisfy the derivation rule on its own (other rows are not judged here).
            const intent = structuredClone(item.verificationIntent) as VerificationIntent;
            const rows = intent[lane] as unknown as Array<Record<string, unknown>>;
            rows[index] = { ...rows[index], desc: patch.desc, ...(patch.derivation ? { derivation: patch.derivation } : {}) };
            if (intentDerivationRows(item.id, intent, requestText).some(entry => entry.lane === lane && entry.index === index && entry.problem !== null)) continue;
          }
          out.push(patch);
          break;
        }
      });
    }
  }
  return out;
}
