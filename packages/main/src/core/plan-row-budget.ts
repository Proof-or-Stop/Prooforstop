/**
 * EXPERIMENTAL A/B switch `plan.rowBudget` (default off; lab plan-light,
 * structural-cost-analysis.md §7 item 4).
 *
 * Old-PoS runs 22-57 authored 32-88 pinned intent rows per Story, and the
 * implementer writes one pinned test per row (run 40: 92 implementer requests
 * for 40 rows). Many rows are further literal examples of a behaviour another
 * row of the same item already pins (`a[1:3]`, `a[2:4]`, `a[0:5]` of one
 * positive two-bound read). New PoS plans a handful of claims.
 *
 * With the switch on:
 *   - guidance (story_create template, story_create output): one row per
 *     distinct behaviour, i.e. per operand class of one form, and never drop a
 *     request-literal example or an exact-text row;
 *   - a soft check (never blocking): rows whose every case repeats the operand
 *     class signature of an earlier row of the same item are listed with ONE
 *     checklist_update that would drop them. Request-literal and exact-text
 *     rows are never listed.
 *
 * Operand class signature (generic, no task values): string literals become
 * S (empty: S0, non-ASCII: SU), numbers N (zero: N0, negative: -N), null/nil
 * NULL, booleans B, literal lists L (empty: L0) and maps M (empty: M0),
 * assigned names V1, V2, ... in order; whitespace dropped. The pinned output
 * gets the same abstraction and an error pin is `error`, so an empty result,
 * an error and a value are different behaviours of the same input class.
 */
import type { ChecklistItem } from './types.js';
import { VERIFICATION_LANES } from './verification.js';
import { itemProbeCases, type ProbeCase } from './request-probes.js';
import { requestLiteralExamples } from './plan-pin-probe.js';
import { shellQuote } from './shell-quote.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';
import type { AbVariantEvidence } from './ab-variants.js';

export const ROW_BUDGET_ADVISORY = 'row_budget';
export const ROW_BUDGET_SCHEMA = 'proof-or-stop.plan-row-budget.v1' as const;

export const ROW_BUDGET_GUIDANCE = 'Row budget (A/B plan.rowBudget=on): state ONE intent row per distinct behaviour, i.e. per operand class of one form '
  + '(positive / zero / negative / omitted / explicit null / out of range / empty / non-ASCII / error case), not several literal examples of the same class; '
  + 'every extra row becomes one more pinned test the implementer writes. Never drop an example the request states literally or an exact-text row.';

const LITERAL_TOKENS = 'S|S0|SU|N|N0|-N|NULL|B|L|L0|M|M0';
const LIST = new RegExp(`(^|[^\\w)\\]])\\[\\s*(?:(?:${LITERAL_TOKENS})\\s*,\\s*)*(?:${LITERAL_TOKENS})\\s*\\]`, 'g');
const MAP = new RegExp(`\\{\\s*(?:(?:S|N|[A-Za-z_]\\w*)\\s*:\\s*(?:${LITERAL_TOKENS})\\s*,?\\s*)+\\}`, 'g');

/** The operand class signature of a code fragment (see the module comment). */
export function operandClassSignature(code: string): string {
  let text = code.replace(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g, (_match, double: string | undefined, single: string | undefined) => {
    const body = double ?? single ?? '';
    return body === '' ? 'S0' : /[^\x00-\x7f]/.test(body) ? 'SU' : 'S';
  });
  text = text.replace(/(?<![\w.])(-?)(\d+(?:\.\d+)?)(?![\w.])/g, (_match, sign: string, digits: string) => (Number(digits) === 0 ? 'N0' : sign ? '-N' : 'N'));
  text = text.replace(/\b(?:null|nil|None)\b/g, 'NULL').replace(/\b(?:true|false|True|False)\b/g, 'B');
  for (let pass = 0; pass < 6; pass += 1) {
    const before = text;
    text = text.replace(/(^|[^\w)\]])\[\s*\]/g, '$1L0').replace(LIST, '$1L').replace(/\{\s*\}/g, 'M0').replace(MAP, 'M');
    if (text === before) break;
  }
  const names = new Map<string, string>();
  for (const match of text.matchAll(/(?:^|;)\s*([A-Za-z_]\w*)\s*=(?!=)/g)) if (!names.has(match[1]!)) names.set(match[1]!, `V${names.size + 1}`);
  for (const [name, alias] of names) text = text.replace(new RegExp(`\\b${name}\\b`, 'g'), alias);
  return text.replace(/\s+/g, '');
}

const caseSignature = (probe: ProbeCase): string =>
  `${operandClassSignature(probe.code)} -> ${probe.pinned.kind === 'error' ? 'error' : operandClassSignature(probe.pinnedText)}`;

export interface RowBudgetExtra { itemId: string; ref: string; sameAs: string; signature: string }

/** Backticked request spans (>= 3 chars), whitespace-free. */
function requestSpans(requestText: string | null): string[] {
  if (!requestText) return [];
  return [...requestText.matchAll(/`([^`\n]{3,})`/g)].map(match => match[1]!.replace(/\s+/g, ''));
}

const EXACT_ROW = /\bexact(?:ly)?\b|\bverbatim\b|\bwhole\s+(?:error|message)\b/i;

/**
 * Rows of one item whose every case repeats a signature an earlier row of the
 * item already pins, excluding request-literal and exact-text rows.
 */
export function rowBudgetExtras(items: readonly Pick<ChecklistItem, 'id' | 'status' | 'verificationIntent'>[], requestText: string | null): RowBudgetExtra[] {
  const spans = requestSpans(requestText);
  const examples = requestText ? requestLiteralExamples(requestText).map(example => example.input.replace(/\s+/g, '')) : [];
  const out: RowBudgetExtra[] = [];
  for (const item of items) {
    if (item.status === 'withdrawn') continue;
    const cases = itemProbeCases(item, { prose: true });
    const byRef = new Map<string, ProbeCase[]>();
    for (const probe of cases) byRef.set(probe.ref, [...(byRef.get(probe.ref) ?? []), probe]);
    const seen = new Map<string, string>();
    for (const lane of VERIFICATION_LANES) {
      for (const [index, row] of (item.verificationIntent?.[lane] ?? []).entries()) {
        const ref = row.id ?? `${item.id}:${lane}:${index}`;
        const rowCases = (byRef.get(ref) ?? []).filter(probe => !probe.unbound && probe.dropped.length === 0);
        if (!rowCases.length) continue;
        const desc = String(row.desc ?? '');
        const squashed = desc.replace(/\s+/g, '');
        const protectedRow = EXACT_ROW.test(desc)
          || spans.some(span => squashed.includes(span))
          || rowCases.some(probe => examples.includes(probe.code.replace(/\s+/g, '')));
        const signatures = rowCases.map(caseSignature);
        const fresh = signatures.filter(signature => !seen.has(signature));
        if (!fresh.length && !protectedRow) out.push({ itemId: item.id, ref, sameAs: seen.get(signatures[0]!)!, signature: signatures[0]! });
        for (const signature of signatures) if (!seen.has(signature)) seen.set(signature, ref);
      }
    }
  }
  return out;
}

/** The checklist_update payload that drops the listed rows of one item (the complete remaining verificationIntent). */
export function rowBudgetTrimPayload(storyId: string, item: Pick<ChecklistItem, 'id' | 'verificationIntent'>, refs: readonly string[]): Record<string, unknown> {
  const drop = new Set(refs);
  const intent: Record<string, unknown[]> = {};
  for (const lane of VERIFICATION_LANES) {
    intent[lane] = (item.verificationIntent?.[lane] ?? []).filter((row, index) => !drop.has(row.id ?? `${item.id}:${lane}:${index}`));
  }
  return { storyId, itemId: item.id, verificationIntent: intent };
}

/** The advisory text (one line per item, with its trim command), or '' when nothing repeats. */
export function rowBudgetNote(storyId: string, items: readonly Pick<ChecklistItem, 'id' | 'status' | 'verificationIntent'>[], requestText: string | null): string {
  const extras = rowBudgetExtras(items, requestText);
  if (!extras.length) return '';
  const total = items.filter(item => item.status !== 'withdrawn')
    .reduce((sum, item) => sum + VERIFICATION_LANES.reduce((lanes, lane) => lanes + (item.verificationIntent?.[lane]?.length ?? 0), 0), 0);
  const lines = [`Row budget (A/B plan.rowBudget=on, advisory [${ROW_BUDGET_ADVISORY}]): ${extras.length} of ${total} intent rows repeat an operand class an earlier row of the same item already pins; `
    + 'each is one more pinned test. Drop them unless a row tests a behaviour its signature misses (request-literal and exact-text rows are never listed):'];
  for (const itemId of [...new Set(extras.map(row => row.itemId))]) {
    const rows = extras.filter(row => row.itemId === itemId);
    lines.push(`- ${itemId}: ${rows.map(row => `${row.ref} (same class as ${row.sameAs}: ${row.signature})`).join(', ')}`);
    const item = items.find(entry => entry.id === itemId)!;
    lines.push(`  proof-or-stop checklist_update ${shellQuote(JSON.stringify(rowBudgetTrimPayload(storyId, item, rows.map(row => row.ref))))}`);
  }
  return lines.join('\n');
}

/** Intent rows of the open items. */
export function intentRowCount(items: readonly Pick<ChecklistItem, 'status' | 'verificationIntent'>[]): number {
  return items.filter(item => item.status !== 'withdrawn')
    .reduce((sum, item) => sum + VERIFICATION_LANES.reduce((lanes, lane) => lanes + (item.verificationIntent?.[lane]?.length ?? 0), 0), 0);
}

/**
 * The arm's evidence (`.proof-or-stop/runtime/plan-row-budget/<storyId>.json`): rows and listed extras at each
 * check, appended per phase/command, so a bench run shows the row count the owner kept after the advisory.
 */
export function recordRowBudgetEvidence(root: string, storyId: string, at: string, items: readonly Pick<ChecklistItem, 'id' | 'status' | 'verificationIntent'>[],
  requestText: string | null, abVariant: AbVariantEvidence | undefined): RowBudgetExtra[] {
  const extras = rowBudgetExtras(items, requestText);
  try {
    const dir = join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'plan-row-budget');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${storyId}.jsonl`), `${JSON.stringify({ schema: ROW_BUDGET_SCHEMA, storyId, at, checkedAt: new Date().toISOString(),
      ...(abVariant ? { abVariant } : {}), rows: intentRowCount(items), extras: extras.map(row => row.ref) })}\n`, { flag: 'a' });
  } catch { /* evidence only; the advisory never fails a command */ }
  return extras;
}
