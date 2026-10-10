/**
 * Exact user-visible strings a checklist item states, copied verbatim for the
 * implementer and finding-repair prompts.
 *
 * Benchmark run 13: the item's userSees and verification intents
 * named the exact error text, but the implementer prompt only pointed at
 * plan.md, so workers shipped working behavior with paraphrased error strings
 * and the owner paid an extra implementer round per item to correct them.
 *
 * Extraction is literal-only. It never paraphrases and never synthesizes a
 * string: every returned text is a substring of the item's own userSees,
 * verification-intent desc, or a non-logic intent's pinned output selector.
 * - fenced ``` blocks in userSees/desc: each output line (lines starting with
 *   `$ ` or `> ` are commands the user types, not output, and are skipped);
 * - inline `backtick` and "double-quoted" / “curly-quoted” literals that look
 *   like messages (contain whitespace, `:` or `=`), excluding the item's own
 *   pinned commands;
 * - the pinned selector of cli/browser/manual intents (the string the gate
 *   requires in captured output). Logic-intent selectors are test names and are
 *   already listed with the pinned verification commands.
 */
import type { ChecklistItem, Finding } from './types.js';

export const EXACT_OUTPUT_HEADER = 'Exact required output — must match byte-for-byte';
const MAX_ENTRIES = 24;
const MAX_ENTRY_CHARS = 500;
const MAX_TOTAL_CHARS = 4000;

interface ExactString { source: string; text: string }

function literalsFrom(raw: string, pinnedCommands: ReadonlySet<string>): string[] {
  const out: string[] = [];
  let rest = raw.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, body: string) => {
    for (const line of body.split('\n')) {
      const text = line.trimEnd();
      if (!text.trim() || /^\s*[$>] /.test(text)) continue;
      out.push(text.trim());
    }
    return ' ';
  });
  const messageLike = (s: string): boolean => s.length >= 3 && /[\s:=]/.test(s) && !pinnedCommands.has(s);
  rest = rest.replace(/`([^`\n]+)`/g, (_m, lit: string) => {
    if (messageLike(lit)) out.push(lit);
    return ' ';
  });
  for (const m of rest.matchAll(/"([^"\n]+)"|“([^”\n]+)”/g)) {
    const lit = m[1] ?? m[2] ?? '';
    if (messageLike(lit)) out.push(lit);
  }
  return out;
}

export function exactRequiredOutputStrings(item: ChecklistItem): ExactString[] {
  const lanes = ['happy', 'edge', 'adversarial'] as const;
  const intents = lanes.flatMap(lane => (item.verificationIntent?.[lane] ?? []).map((entry, i) => ({ entry, id: entry.id ?? `${item.id}:${lane}:${i}` })));
  const pinnedCommands = new Set(intents.map(({ entry }) => entry.verification?.command).filter((c): c is string => typeof c === 'string'));
  const found: ExactString[] = [];
  if (typeof item.userSees === 'string') {
    for (const text of literalsFrom(item.userSees, pinnedCommands)) found.push({ source: `${item.id} userSees`, text });
  }
  for (const { entry, id } of intents) {
    if (typeof entry.desc === 'string') {
      for (const text of literalsFrom(entry.desc, pinnedCommands)) found.push({ source: `${id} intent`, text });
    }
    const selector = entry.verification?.selector;
    if (entry.type !== 'logic' && typeof selector === 'string' && selector.trim()) {
      found.push({ source: `${id} pinned output selector`, text: selector });
    }
  }
  const seen = new Set<string>();
  return found.filter(({ text }) => (seen.has(text) ? false : (seen.add(text), true)));
}

/** Items a finding names by id (CHK-NNN in desc) or whose declared files overlap the finding's files. */
export function itemsForFinding(items: readonly ChecklistItem[], finding: Finding): ChecklistItem[] {
  const named = new Set(finding.desc?.match(/\bCHK-\d+\b/g) ?? []);
  const files = new Set(finding.files ?? []);
  return items.filter(item => item.status !== 'withdrawn' && (named.has(item.id)
    || [...(item.files?.modify ?? []), ...(item.files?.create ?? []), ...(item.files?.test ?? [])].some(f => files.has(f))));
}

/** Append the bounded verbatim section; appends nothing when the items state no exact string. */
export function appendExactRequiredOutput(lines: string[], items: readonly ChecklistItem[]): void {
  const all = items.flatMap(exactRequiredOutputStrings);
  if (all.length === 0) return;
  const rows: string[] = [];
  let total = 0;
  let omitted = 0;
  for (const { source, text } of all) {
    const row = `- [${source}] ${text}`;
    if (text.length > MAX_ENTRY_CHARS || rows.length >= MAX_ENTRIES || total + row.length > MAX_TOTAL_CHARS) { omitted++; continue; }
    rows.push(row);
    total += row.length;
  }
  lines.push('');
  lines.push(`${EXACT_OUTPUT_HEADER} (copied verbatim from the checklist item; each text after "] " is the required user-visible string):`);
  lines.push(...rows);
  if (omitted > 0) {
    lines.push(`- ${omitted} more exact string(s) omitted to keep this prompt bounded; read them in the item's userSees and verificationIntent via proof-or-stop checklist_get.`);
  }
  lines.push('- Emit these strings exactly: same words, spelling, case, punctuation, spacing and field order. Do not paraphrase or "improve" them. A placeholder such as <X> stands for the runtime value. Assert each exact string in a test that compares it exactly (full-string equality), not a prefix / contains comparison and not a project test helper that wraps one; next reopens the item before REVIEW otherwise.');
}
