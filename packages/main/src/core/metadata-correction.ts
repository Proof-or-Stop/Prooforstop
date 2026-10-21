/**
 * Old-PoS run 31: Story-metadata review findings become owner corrections.
 *
 * A metadata finding (core/metadata-finding-class.ts) names a checklist item
 * field (userSees, or verificationIntent rows) whose text contradicts the
 * request. It is not repair work: the owner corrects the text with ONE
 * checklist_update (metadataCorrection=true), and the framework verifies the
 * cited text actually changed before the correction clears:
 *   - the field's text differs from the text the reviewer judged (fieldHash);
 *   - the reviewer's corrected value, when one is extracted, is now stated;
 *   - a wrong statement (`a == b`, `a -> b`) is no longer stated.
 * Corrections come from lane findings reclassified at import (process event
 * review_metadata_finding_reclassified, fieldHash recorded then) and from
 * stored open findings that cite Story metadata (critic proposals, legacy rows,
 * or product findings that also cite checklist text; their judged text is the
 * checklist committed before the finding was recorded). They are deduped by
 * (item, field) across lanes and rounds.
 *
 * Literal sweep (run 31 D5: a wrong literal lived in userSees and an intent row, another
 * in an intent row and userSees; each checker fixed one copy): every other
 * occurrence of the wrong literal across all items' userSees / intent rows is
 * listed in the same correction step.
 *
 * Old-PoS run 44 (R2, run44-analysis.md §2.3): a reviewer may cite only a short
 * quoted literal (`"x"`) of a statement the field makes. A short literal alone is
 * never swept (it matches unrelated text), so it is widened to the field's own
 * statement around it (its backticked span, else its clause); a reviewer sentence
 * that differs from that statement only in the literal's slot is the corrected
 * value. Each applied correction is journaled (metadata_correction_applied, the
 * field's text before and after), so the lane evidence of the round is judged
 * against the text before the correction without any extracted corrected value
 * (metadataCorrectionCheckpoints); an intent-row correction (a pinned value) is
 * never reverted.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { ChecklistItem, Finding } from './types.js';
import { digestCanonicalJson } from './digest.js';
import { isStoryMetadataFile, isStoryMetadataFinding } from './metadata-finding-class.js';
import { REPAIR_VALUE_CHANGED_EVENT, repairRowPatches, type RepairRowPatch, type RepairValueChange } from './repair-value-change.js';
import { shellQuote } from './shell-quote.js';

export type MetadataField = 'userSees' | 'verificationIntent';

export interface MetadataCorrection {
  itemId: string;
  field: MetadataField;
  rowRefs: string[];
  /** The wrong literal the cited field states (as written there), or null when none was extracted. */
  wrongLiteral: string | null;
  /** The reviewer's value for it (quote style of the field), or null. */
  correctedValue: string | null;
  /** Digest of the field text the reviewer judged. */
  fieldHash: string | null;
  /**
   * Old-PoS run 68 (core/repair-value-change.ts): row patches the framework derived from a
   * verified finding's repair (the expected value its test changed); PLAN applies them as
   * a framework step. Absent for reviewer-cited corrections (the owner authors those).
   */
  patches?: Array<Pick<RepairRowPatch, 'ref' | 'desc' | 'derivation'>>;
}

export interface MetadataCorrectionSource { desc: string; lane?: string; reviewRunId?: string; findingId?: string }

export interface OpenMetadataCorrection extends MetadataCorrection {
  key: string;
  sources: MetadataCorrectionSource[];
}

/** One occurrence of a literal in a checklist field. */
export interface LiteralOccurrence { itemId: string; field: MetadataField; ref: string }

export const METADATA_FINDING_RECLASSIFIED_EVENT = 'review_metadata_finding_reclassified';
export const METADATA_CORRECTION_UNCHANGED = 'metadata_correction_unchanged';
/** Old-PoS run 44: one applied correction of one item field (userSees: the text before and after; intent rows: hashes only). */
export const METADATA_CORRECTION_APPLIED_EVENT = 'metadata_correction_applied';

const LANES = ['happy', 'edge', 'adversarial'] as const;

/** The text of one item field a metadata correction judges. */
export function metadataFieldText(item: Pick<ChecklistItem, 'userSees' | 'verificationIntent'>, field: MetadataField): string {
  if (field === 'userSees') return item.userSees ?? '';
  return LANES.flatMap(lane => (item.verificationIntent?.[lane] ?? []).map((row, index) =>
    `${lane}:${index} ${row.desc ?? ''} ${(row as { derivation?: { computation?: string } }).derivation?.computation ?? ''}`)).join('\n');
}

export function metadataFieldHash(item: Pick<ChecklistItem, 'userSees' | 'verificationIntent'>, field: MetadataField): string {
  return digestCanonicalJson({ field, text: metadataFieldText(item, field) });
}

const squash = (text: string): string => text.replace(/\s+/g, '');
const swapQuotes = (text: string): string => text.replace(/['"]/g, quote => (quote === '"' ? "'" : '"'));

/** The form of `literal` the text states (quote style either way, whitespace aside), or null. */
export function statedForm(text: string, literal: string): string | null {
  const body = squash(text);
  for (const form of [literal, swapQuotes(literal)]) if (form && body.includes(squash(form))) return form;
  return null;
}

const isStatement = (literal: string): boolean => /==|->|=>|→/.test(literal);
const innerOf = (literal: string): string => literal.replace(/^['"`]|['"`]$/g, '');
/** A literal too short to locate on its own (the sweep skips it; it is widened to the statement around it). */
const isShortLiteral = (literal: string): boolean => !isStatement(literal) && innerOf(literal).length < 4;

/**
 * Old-PoS run 44: the field's own statement around a short literal: the
 * backticked span holding it, else its clause (at most 4 words each side, within
 * one sentence). Prefers an occurrence inside a backticked span. Null when the
 * field does not state the literal.
 */
export function enclosingStatement(fieldText: string, literal: string): string | null {
  const forms = [literal, swapQuotes(literal)];
  for (const span of fieldText.matchAll(/`([^`\n]{4,200})`/g)) {
    const text = span[1]!.trim();
    if (forms.some(form => text.includes(form)) && text !== literal) return text;
  }
  for (const form of forms) {
    const at = fieldText.indexOf(form);
    if (at < 0) continue;
    const before = fieldText.slice(0, at).split(/[;.\n`]/).at(-1)!.split(/\s+/).filter(Boolean).slice(-4);
    const after = fieldText.slice(at + form.length).split(/[;.\n`]/)[0]!.split(/\s+/).filter(Boolean).slice(0, 4);
    const clause = [...before, form, ...after].join(' ').replace(/\s+([,:)])/g, '$1').trim();
    return clause.length > form.length && clause.includes(form) && statedForm(fieldText, clause) ? clause : null;
  }
  return null;
}

/**
 * Old-PoS run 44: a reviewer sentence (absent from the field) that, with one word
 * replaced by the short wrong literal, is a statement the field makes: that
 * statement (as stated) is the wrong literal and the sentence its corrected value.
 */
function slotSubstitution(fieldText: string, short: string, absent: readonly string[]): { wrong: string; corrected: string } | null {
  for (const sentence of absent) {
    if (sentence.length < 6 || isShortLiteral(sentence)) continue;
    for (const word of sentence.matchAll(/[^\s"'`:;,()]+/g)) {
      const candidate = sentence.slice(0, word.index) + short + sentence.slice(word.index! + word[0].length);
      const form = statedForm(fieldText, candidate);
      if (form) return { wrong: form, corrected: sentence };
    }
  }
  return null;
}
const rhs = (literal: string): string => literal.split(/\s*(?:==|->|=>|→)\s*/).at(-1)!.trim();
const lhs = (literal: string): string => literal.split(/\s*(?:==|->|=>|→)\s*/)[0]!.trim();

/** Backticked spans, then double- and single-quoted strings outside them. */
export function descLiterals(desc: string): string[] {
  const out: string[] = [];
  for (const match of desc.matchAll(/`([^`\n]{2,200})`/g)) out.push(match[1]!.trim());
  const bare = desc.replace(/`[^`\n]*`/g, ' ');
  for (const match of bare.matchAll(/"([^"\n]{1,120})"/g)) out.push(`"${match[1]}"`);
  for (const match of bare.matchAll(/(?<![A-Za-z0-9])'([^'\n]{1,120})'(?![A-Za-z0-9])/g)) out.push(`'${match[1]}'`);
  return [...new Set(out.filter(literal => literal.length >= 2))];
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const kept = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = kept;
    }
  }
  return row[b.length]!;
}

/** The wrong literal the field states and the reviewer's value for it (best effort; null when not extractable). */
export function extractLiteralPair(desc: string, fieldText: string): { wrongLiteral: string | null; correctedValue: string | null } {
  const literals = descLiterals(desc);
  const present: string[] = [];
  const absent: string[] = [];
  for (const literal of literals) {
    const form = statedForm(fieldText, literal);
    if (form) present.push(form); else absent.push(literal);
  }
  if (present.length === 0) return { wrongLiteral: null, correctedValue: null };
  const statements = present.filter(isStatement).sort((a, b) => b.length - a.length);
  const match = (wrong: string, candidates: string[]): string | null => {
    if (!candidates.length) return null;
    const target = isStatement(wrong) ? rhs(wrong) : wrong;
    const sameSide = isStatement(wrong) ? candidates.filter(candidate => isStatement(candidate) && squash(lhs(candidate)) === squash(lhs(wrong))) : [];
    if (sameSide.length) return sameSide[0]!;
    const scored = candidates.filter(candidate => !isStatement(candidate))
      .map(candidate => ({ candidate, distance: editDistance(squash(target), squash(candidate)) }))
      .sort((a, b) => a.distance - b.distance);
    const best = scored[0];
    return best && best.distance <= Math.max(2, Math.ceil(Math.max(target.length, best.candidate.length) * 0.6)) ? best.candidate : null;
  };
  const quoteStyle = (wrong: string, value: string | null): string | null => {
    if (!value) return null;
    return /"/.test(wrong) && !/"/.test(value) && /'/.test(value) ? swapQuotes(value) : value;
  };
  if (statements.length) {
    const wrong = statements[0]!;
    return { wrongLiteral: wrong, correctedValue: quoteStyle(wrong, match(wrong, absent)) };
  }
  let best: { wrong: string; corrected: string; distance: number } | null = null;
  for (const wrong of present) {
    const corrected = match(wrong, absent);
    if (!corrected) continue;
    const distance = editDistance(squash(wrong), squash(corrected));
    if (!best || distance < best.distance) best = { wrong, corrected, distance };
  }
  if (best) return { wrongLiteral: best.wrong, correctedValue: quoteStyle(best.wrong, best.corrected) };
  // Old-PoS run 44: a short literal is located through the field's own statement around it.
  const last = present.at(-1)!;
  if (isShortLiteral(last)) {
    const slot = slotSubstitution(fieldText, last, absent);
    if (slot) return { wrongLiteral: slot.wrong, correctedValue: slot.corrected };
    const longer = present.filter(literal => literal !== last && !isShortLiteral(literal) && squash(literal).includes(squash(innerOf(last)))).sort((a, b) => b.length - a.length)[0];
    return { wrongLiteral: longer ?? enclosingStatement(fieldText, last) ?? last, correctedValue: null };
  }
  return { wrongLiteral: last, correctedValue: null };
}

/** The item a `checklist.json:<line>` citation points into (the nearest item id at or above that line). */
function itemAtChecklistLine(lines: readonly string[], line: number): { itemId: string; field: MetadataField | null } | null {
  for (let index = Math.min(line, lines.length) - 1; index >= 0; index -= 1) {
    const id = lines[index]!.match(/"id":\s*"(CHK-\d+)"/)?.[1];
    if (id) {
      const cited = lines[line - 1] ?? '';
      return { itemId: id, field: /"userSees"/.test(cited) ? 'userSees' : /"desc"|"computation"|"verificationIntent"/.test(cited) ? 'verificationIntent' : null };
    }
  }
  return null;
}

/**
 * The corrections a metadata-citing finding text asks for, against the
 * checklist the reviewer judged (`items`, and its JSON text for line
 * citations). One per cited item.
 */
export function extractMetadataCorrections(desc: string, items: readonly ChecklistItem[], checklistText = ''): MetadataCorrection[] {
  // Old-PoS run 33: `CHK-003 edge:8` (space) names the same row as `CHK-003:edge:8`.
  const rowRefs = [...new Set([...desc.matchAll(/\b(CHK-\d+)[: ](happy|edge|adversarial):(\d+)\b/g)].map(match => `${match[1]}:${match[2]}:${match[3]}`))];
  const lines = checklistText.split('\n');
  const cited = new Map<string, MetadataField | null>();
  for (const match of desc.matchAll(/\bCHK-\d+\b/g)) if (!cited.has(match[0])) cited.set(match[0], null);
  if (cited.size === 0) {
    for (const match of desc.matchAll(/checklist\.json:(\d+)/g)) {
      const at = itemAtChecklistLine(lines, Number(match[1]));
      if (at && !cited.has(at.itemId)) cited.set(at.itemId, at.field);
    }
  }
  const out: MetadataCorrection[] = [];
  for (const [itemId, lineField] of cited) {
    const item = items.find(row => row.id === itemId);
    if (!item) continue;
    const refs = rowRefs.filter(ref => ref.startsWith(`${itemId}:`));
    const field: MetadataField = refs.length ? 'verificationIntent'
      : lineField ?? (/usersees/i.test(desc) ? 'userSees'
        : /intent|\brows?\b|\bpins?\b|verification/i.test(desc) ? 'verificationIntent'
          : extractLiteralPair(desc, metadataFieldText(item, 'userSees')).wrongLiteral ? 'userSees' : 'verificationIntent');
    const pair = extractLiteralPair(desc, metadataFieldText(item, field));
    out.push({ itemId, field, rowRefs: refs, ...pair, fieldHash: metadataFieldHash(item, field) });
  }
  return out;
}

/** Whether the item now states what the correction asks (see the module comment). */
export function metadataCorrectionCleared(item: Pick<ChecklistItem, 'userSees' | 'verificationIntent'> | undefined, correction: MetadataCorrection): boolean {
  if (!item) return true;
  const text = metadataFieldText(item, correction.field);
  if (correction.fieldHash && metadataFieldHash(item, correction.field) === correction.fieldHash) return false;
  if (correction.correctedValue && !statedForm(text, correction.correctedValue)) return false;
  if (correction.wrongLiteral && isStatement(correction.wrongLiteral) && statedForm(text, correction.wrongLiteral)) return false;
  return true;
}

/** Why a correction is not cleared yet (one line), for refusals. */
export function describeMetadataCorrection(correction: MetadataCorrection): string {
  const parts = [`${correction.itemId} ${correction.field}${correction.rowRefs.length ? ` (${correction.rowRefs.join(', ')})` : ''}`];
  if (correction.wrongLiteral) parts.push(`states ${correction.wrongLiteral}`);
  if (correction.correctedValue) parts.push(`the reviewer's value: ${correction.correctedValue}`);
  return parts.join('; ');
}

/** Every occurrence of `literal` in the items' userSees and intent rows (sweep), except `skip`. */
export function literalOccurrences(items: readonly ChecklistItem[], literal: string, skip?: { itemId: string; field: MetadataField }): LiteralOccurrence[] {
  // A bare short literal is never swept (it matches unrelated text); extraction widens it to its statement (run 44).
  if (isShortLiteral(literal)) return [];
  const out: LiteralOccurrence[] = [];
  for (const item of items) {
    if (item.status === 'withdrawn') continue;
    if (statedForm(item.userSees ?? '', literal) && !(skip?.itemId === item.id && skip.field === 'userSees')) out.push({ itemId: item.id, field: 'userSees', ref: `${item.id} userSees` });
    if (skip?.itemId === item.id && skip.field === 'verificationIntent') continue;
    for (const lane of LANES) {
      (item.verificationIntent?.[lane] ?? []).forEach((row, index) => {
        const text = `${row.desc ?? ''} ${(row as { derivation?: { computation?: string } }).derivation?.computation ?? ''}`;
        if (statedForm(text, literal)) out.push({ itemId: item.id, field: 'verificationIntent', ref: `${item.id}:${lane}:${index}` });
      });
    }
  }
  return out;
}

type Store = {
  readProcessEvents(storyId: string): Array<Record<string, unknown> & { type: string }>;
  readChecklist(storyId: string): { items: ChecklistItem[] };
  readFindings(storyId: string): { findings: Finding[] };
  storyFilePath(storyId: string, name: string): string;
};

/** The checklist committed before `before` (the text a stored finding's reviewer judged), or null. */
function committedChecklistBefore(gitCwd: string, checklistPath: string, before: string): { items: ChecklistItem[]; text: string } | null {
  try {
    const marker = checklistPath.lastIndexOf('.proof-or-stop/');
    const rel = marker >= 0 ? checklistPath.slice(marker) : relative(gitCwd, checklistPath);
    const sha = execFileSync('git', ['log', '-1', '--format=%H', `--before=${before}`, '--', rel], { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!sha) return null;
    const text = execFileSync('git', ['show', `${sha}:${rel}`], { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    return { items: (JSON.parse(text) as { items?: ChecklistItem[] }).items ?? [], text };
  } catch {
    return null;
  }
}

/** Whether a stored finding cites Story metadata (pure metadata or a product finding that also cites checklist text). */
export function findingCitesStoryMetadata(finding: Pick<Finding, 'files'>): boolean {
  return (finding.files ?? []).some(isStoryMetadataFile);
}

/** The corrections a stored finding's metadata citation asks for (judged text: the checklist committed before the finding). */
export function storedFindingCorrections(args: { store: Store; storyId: string; gitCwd: string; finding: Finding }): MetadataCorrection[] {
  if (!findingCitesStoryMetadata(args.finding)) return [];
  const path = args.store.storyFilePath(args.storyId, 'checklist.json');
  const judged = committedChecklistBefore(args.gitCwd, path, args.finding.createdAt ?? new Date().toISOString());
  const items = judged?.items ?? args.store.readChecklist(args.storyId).items;
  const corrections = extractMetadataCorrections(args.finding.desc, items, judged?.text ?? '');
  return judged ? corrections : corrections.map(row => ({ ...row, fieldHash: null }));
}

/**
 * Every metadata correction not cleared yet, deduped by (item, field): the
 * reclassified lane findings (process events) and stored open findings that cite
 * Story metadata. A wrong statement beats a bare value when sources disagree.
 */
export function openMetadataCorrections(args: { store: Store; storyId: string; gitCwd: string; includeCleared?: boolean }): OpenMetadataCorrection[] {
  const items = args.store.readChecklist(args.storyId).items;
  const byKey = new Map<string, OpenMetadataCorrection>();
  const add = (correction: MetadataCorrection, source: MetadataCorrectionSource): void => {
    if (!args.includeCleared && metadataCorrectionCleared(items.find(item => item.id === correction.itemId), correction)) return;
    const key = `${correction.itemId}|${correction.field}`;
    const current = byKey.get(key);
    if (!current) { byKey.set(key, { ...correction, key, sources: [source] }); return; }
    current.sources.push(source);
    current.rowRefs = [...new Set([...current.rowRefs, ...correction.rowRefs])];
    const better = correction.wrongLiteral && (!current.wrongLiteral || (isStatement(correction.wrongLiteral) && !isStatement(current.wrongLiteral)));
    if (better) { current.wrongLiteral = correction.wrongLiteral; current.correctedValue = correction.correctedValue ?? current.correctedValue; }
    else if (!current.correctedValue && correction.correctedValue) current.correctedValue = correction.correctedValue;
    if (correction.patches?.length) current.patches = [...(current.patches ?? []), ...correction.patches.filter(patch => !(current.patches ?? []).some(row => row.ref === patch.ref))];
  };
  let events: Array<Record<string, unknown>> = [];
  try { events = args.store.readProcessEvents(args.storyId).filter(event => event.type === METADATA_FINDING_RECLASSIFIED_EVENT); } catch { events = []; }
  for (const event of events) {
    for (const row of (event.reclassified ?? []) as Array<{ desc?: string; corrections?: MetadataCorrection[] }>) {
      for (const correction of row.corrections ?? []) add(correction, { desc: row.desc ?? '', lane: String(event.agent ?? ''), ...(event.reviewRunId ? { reviewRunId: String(event.reviewRunId) } : {}) });
    }
  }
  for (const finding of args.store.readFindings(args.storyId).findings ?? []) {
    if (finding.status !== 'open' || finding.evidenceState === 'disproven' || !findingCitesStoryMetadata(finding)) continue;
    for (const correction of storedFindingCorrections({ ...args, finding })) add(correction, { desc: finding.desc, findingId: finding.id, lane: finding.agent });
  }
  for (const derived of sweptIntentRowCorrections(args.store, args.storyId, items)) add(derived, { desc: `${derived.rowRefs.join(', ')} still state ${derived.wrongLiteral} (corrected elsewhere)` });
  for (const derived of repairValueCorrections(args.store, args.storyId, items)) add(derived.correction, derived.source);
  return [...byKey.values()];
}

/** The Story's request text for the request-literal guard (absent or unreadable: null). */
function storyRequestText(store: Pick<Store, 'storyFilePath'>, storyId: string): string | null {
  try { return readFileSync(store.storyFilePath(storyId, 'request.md'), 'utf8'); } catch { return null; }
}

/**
 * Old-PoS run 68 (fix 3, core/repair-value-change.ts): every intent row that still states,
 * for a case a verified finding's repair re-tested, the value that repair replaced is an
 * open intent-row correction of its item, with the framework's row patch (re-pin stated).
 * Derived from the journaled change and the CURRENT rows, so it clears as soon as the
 * rows state the repaired value; a case the request states literally is never included.
 */
function repairValueCorrections(store: Pick<Store, 'readProcessEvents' | 'storyFilePath'>, storyId: string, items: readonly ChecklistItem[]):
  Array<{ correction: MetadataCorrection; source: MetadataCorrectionSource }> {
  let events: Array<Record<string, unknown>> = [];
  try { events = store.readProcessEvents(storyId).filter(event => event.type === REPAIR_VALUE_CHANGED_EVENT); } catch { return []; }
  if (!events.length) return [];
  const requestText = storyRequestText(store, storyId);
  const out: Array<{ correction: MetadataCorrection; source: MetadataCorrectionSource }> = [];
  for (const event of events) {
    const changes = Array.isArray(event.changes) ? event.changes as RepairValueChange[] : [];
    const findingIds = Array.isArray(event.findingIds) ? (event.findingIds as unknown[]).map(String) : [];
    const commit = typeof event.commit === 'string' ? event.commit : '';
    const patches = repairRowPatches(items as ChecklistItem[], changes, requestText, { findingIds, commit });
    for (const itemId of [...new Set(patches.map(patch => patch.itemId))]) {
      const own = patches.filter(patch => patch.itemId === itemId);
      out.push({
        correction: { itemId, field: 'verificationIntent', rowRefs: own.map(patch => patch.ref), wrongLiteral: own[0]!.wrongStatement,
          correctedValue: own[0]!.correctedStatement, fieldHash: null, patches: own.map(patch => ({ ref: patch.ref, desc: patch.desc, ...(patch.derivation ? { derivation: patch.derivation } : {}) })) },
        source: { desc: `repair ${commit.slice(0, 12)} of ${findingIds.map(id => id.replace(/^[^:]+:/, '')).join(', ') || 'a verified finding'} changed the expected value: ${own.map(patch => `${patch.ref} ${patch.caseText}: ${patch.oldValue} -> ${patch.newValue}`).join('; ')}`,
          ...(findingIds[0] ? { findingId: findingIds[0] } : {}), lane: 'framework' },
      });
    }
  }
  return out;
}

/**
 * Old-PoS run 44 (F-021): the in-place correction fixed userSees, the sweep listed the
 * intent rows stating the same wrong literal, but intent rows are corrected only in
 * PLAN and nothing routed them there: a critic found them four rounds later. Every
 * intent row that still states, on its expected side (after its last `->` / `=>` /
 * `→` / `==`; a statement literal anywhere), the wrong literal of an applied
 * correction is an open intent-row correction of its item (next takes the Story to
 * PLAN for it). A short literal is never matched alone; an input occurrence is left.
 */
function sweptIntentRowCorrections(store: Pick<Store, 'readProcessEvents'>, storyId: string, items: readonly ChecklistItem[]): MetadataCorrection[] {
  let events: Array<Record<string, unknown>> = [];
  try { events = store.readProcessEvents(storyId); } catch { return []; }
  const literals = [...new Set(appliedCorrections(events).flatMap(row => (row as { wrongLiterals?: unknown }).wrongLiterals)
    .filter((literal): literal is string => typeof literal === 'string' && !isShortLiteral(literal)))];
  const out: MetadataCorrection[] = [];
  for (const literal of literals) {
    for (const item of items) {
      if (item.status === 'withdrawn') continue;
      const refs = LANES.flatMap(lane => (item.verificationIntent?.[lane] ?? []).flatMap((row, index) => {
        const text = `${row.desc ?? ''} ${(row as { derivation?: { computation?: string } }).derivation?.computation ?? ''}`;
        const expected = isStatement(literal) ? text : (row.desc ?? '').split(/->|=>|→|==/).slice(1).at(-1) ?? '';
        return expected && statedForm(expected, literal) ? [`${item.id}:${lane}:${index}`] : [];
      }));
      if (refs.length) out.push({ itemId: item.id, field: 'verificationIntent', rowRefs: refs, wrongLiteral: literal, correctedValue: null, fieldHash: metadataFieldHash(item, 'verificationIntent') });
    }
  }
  return out;
}

/** Stored open findings whose cited defect lies only in Story metadata (never repair work). */
export function isPureMetadataFinding(finding: Pick<Finding, 'files' | 'desc'>): boolean {
  return isStoryMetadataFinding(finding);
}

/** The corrections of lane findings reclassified as Story metadata at import (process events). */
function reclassifiedCorrections(store: Pick<Store, 'readProcessEvents'>, storyId: string): MetadataCorrection[] {
  let events: Array<Record<string, unknown>> = [];
  try { events = store.readProcessEvents(storyId).filter(event => event.type === METADATA_FINDING_RECLASSIFIED_EVENT); } catch { return []; }
  return events.flatMap(event => ((event.reclassified ?? []) as Array<{ corrections?: MetadataCorrection[] }>).flatMap(row => row.corrections ?? []));
}

const sameTarget = (a: MetadataCorrection, b: MetadataCorrection): boolean => a.itemId === b.itemId && a.field === b.field
  && (a.rowRefs.length === 0 || b.rowRefs.length === 0 || a.rowRefs.some(ref => b.rowRefs.includes(ref)));

/**
 * Old-PoS run 33 (F-003, run33-analysis.md §3.5): a metadata finding is
 * classified by its correction target, not by the lane that wrote it. A stored
 * finding that cites Story metadata is a metadata finding (corrected by the
 * owner, never repair work) when it is pure metadata, or when every correction
 * it asks for targets the same item field (and row, when both name rows) as a
 * lane finding the importer reclassified as metadata. Run 33's docs lane cited
 * the checklist, a product source file and its test ("the implementation correctly
 * returns ..."), was stored as a product finding and got a repair run that
 * added a test for already-correct behaviour, while the test-coverage lane's
 * copy of the same correction was reclassified. A finding with no such
 * reclassified twin stays a product finding (its metadata part is still
 * checked at resolve time).
 */
export function isMetadataTargetFinding(args: { store: Store; storyId: string; gitCwd: string; finding: Finding }): boolean {
  if (isPureMetadataFinding(args.finding)) return true;
  if (!findingCitesStoryMetadata(args.finding)) return false;
  const own = storedFindingCorrections(args);
  if (own.length === 0) return false;
  const reclassified = reclassifiedCorrections(args.store, args.storyId);
  return own.every(correction => reclassified.some(other => sameTarget(correction, other)));
}

/** One journaled applied correction (process event metadata_correction_applied). */
export interface AppliedMetadataCorrection {
  itemId: string;
  field: MetadataField;
  /** userSees: the field text before / after the correction (intent rows journal hashes only and are never reverted). */
  before?: string;
  after?: string;
}

function appliedCorrections(events: ReadonlyArray<Record<string, unknown>>): AppliedMetadataCorrection[] {
  return events.filter(event => event.type === METADATA_CORRECTION_APPLIED_EVENT)
    .map(event => event as unknown as AppliedMetadataCorrection)
    .filter(event => typeof event.itemId === 'string' && (event.field === 'userSees' || event.field === 'verificationIntent'));
}

/**
 * Old-PoS run 44 (R2): the checklists the round's lanes may have judged before
 * the applied Story-metadata corrections, newest correction reverted first (one
 * state per applied correction, item by item). Only userSees corrections are
 * reverted, each from its journaled before/after text, so no extracted corrected
 * value is needed. The chain stops (fail closed) at an intent-row correction (a
 * pinned expected value changed: evidence judged before it stays invalid) and at
 * a field that no longer states the correction's result (another edit followed).
 * Every other field is untouched: a lane envelope matches a checkpoint only when
 * the corrected text is the sole difference.
 */
export function metadataCorrectionCheckpoints(events: ReadonlyArray<Record<string, unknown>>, items: readonly ChecklistItem[]): ChecklistItem[][] {
  const out: ChecklistItem[][] = [];
  let state = items.map(item => ({ ...item }));
  for (const correction of appliedCorrections(events).reverse()) {
    if (correction.field !== 'userSees' || typeof correction.before !== 'string' || typeof correction.after !== 'string') break;
    const at = state.findIndex(item => item.id === correction.itemId);
    if (at < 0 || (state[at]!.userSees ?? '') !== correction.after) break;
    state = state.map((item, index) => (index === at ? { ...item, userSees: correction.before } : item));
    out.push(state);
  }
  return out;
}

/**
 * Old-PoS run 31: the userSees text the candidate-spec route judges. A verified
 * metadata correction (corrected value now stated in place of the reviewer-cited
 * wrong literal) is reverted for routing only, so an owner's text correction in
 * REVIEW does not stale the route and rerun every lane. Any other userSees edit
 * still changes the routing input (the reroute stays the safe fallback).
 * Old-PoS run 44: with the item named, every journaled applied correction of its
 * userSees is reverted from its recorded text first (newest first, while the text
 * is still that correction's result), with no corrected value needed.
 */
export function routingUserSees(store: Pick<Store, 'readProcessEvents'>, storyId: string, userSees: string | undefined, itemId?: string): string | undefined {
  if (!userSees) return userSees;
  let all: Array<Record<string, unknown> & { type: string }> = [];
  try { all = store.readProcessEvents(storyId); } catch { return userSees; }
  let text = userSees;
  if (itemId) {
    for (const correction of appliedCorrections(all).filter(row => row.itemId === itemId).reverse()) {
      if (correction.field !== 'userSees' || typeof correction.before !== 'string' || correction.after !== text) break;
      text = correction.before;
    }
  }
  const events = all.filter(event => event.type === METADATA_FINDING_RECLASSIFIED_EVENT);
  for (const event of events) {
    for (const row of (event.reclassified ?? []) as Array<{ corrections?: MetadataCorrection[] }>) {
      for (const correction of row.corrections ?? []) {
        if (correction.field !== 'userSees' || !correction.wrongLiteral || !correction.correctedValue) continue;
        if (text.includes(correction.correctedValue) && !text.includes(correction.wrongLiteral)) text = text.split(correction.correctedValue).join(correction.wrongLiteral);
      }
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// Lab run131 (run 131 PLAN-B: ~9 metadata_correction_unchanged + 6 metadata_correction_none refusals, ~5-6 min,
// ~12M owner tokens): the framework writes the corrected text; a refusal names the exact one next command.

/** `text` with every occurrence of `form` replaced by `to` (whitespace-insensitive); null when `form` is not there. */
function replaceStated(text: string, form: string, to: string): string | null {
  if (text.includes(form)) return text.split(form).join(to);
  const pattern = new RegExp(form.trim().split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'g');
  return pattern.test(text) ? text.replace(pattern, () => to) : null;
}

/** The corrected text of the wrong literal: the value side of a statement replaced, or the literal itself. */
function correctedLiteral(wrong: string, corrected: string): string {
  if (/==|->|=>|→/.test(corrected) || !/(?:==|->|=>|→|=)/.test(wrong)) return corrected;
  const at = Math.max(...['==', '->', '=>', '→', '='].map(op => wrong.lastIndexOf(op)));
  const op = ['==', '->', '=>', '→', '='].find(candidate => wrong.slice(at).startsWith(candidate))!;
  const lead = wrong.slice(0, at + op.length);
  const gap = wrong.slice(at + op.length).match(/^\s*/)?.[0] ?? ' ';
  return `${lead}${gap}${corrected}`;
}

/**
 * The ready correction of one item: its intent rows (`intentRows`, desc and computation corrected) or its userSees, with
 * the reviewer's value in place of the wrong literal; null when the reviewer gave no value, the literal is not stated, or
 * the result would not clear the correction.
 */
export function metadataCorrectionReadyPatch(item: Pick<ChecklistItem, 'id' | 'userSees' | 'verificationIntent'> | undefined, correction: MetadataCorrection):
  { userSees?: string; intentRows?: Array<{ ref: string; desc: string; derivation: { requestQuote: string; computation: string } }> } | null {
  if (!item || !correction.wrongLiteral || !correction.correctedValue) return null;
  const wrong = correction.wrongLiteral;
  if (correction.field === 'userSees') {
    const form = statedForm(item.userSees ?? '', wrong);
    const fixed = form ? replaceStated(item.userSees ?? '', form, correctedLiteral(form, correction.correctedValue)) : null;
    if (!fixed) return null;
    const out = { userSees: fixed };
    return metadataCorrectionCleared({ ...item, userSees: fixed }, correction) ? out : null;
  }
  const rows: Array<{ ref: string; desc: string; derivation: { requestQuote: string; computation: string } }> = [];
  const clone = structuredClone({ verificationIntent: item.verificationIntent ?? null }) as { verificationIntent: Record<string, Array<{ desc?: string; derivation?: { requestQuote?: string; computation?: string } }>> | null };
  for (const lane of LANES) {
    (clone.verificationIntent?.[lane] ?? []).forEach((row, index) => {
      const ref = `${item.id}:${lane}:${index}`;
      if (correction.rowRefs.length && !correction.rowRefs.includes(ref)) return;
      const desc = String(row.desc ?? '');
      const computation = String(row.derivation?.computation ?? '');
      const descForm = statedForm(desc, wrong);
      const compForm = statedForm(computation, wrong);
      if (!descForm && !compForm) return;
      const newDesc = descForm ? replaceStated(desc, descForm, correctedLiteral(descForm, correction.correctedValue!)) ?? desc : desc;
      let newComputation = compForm ? replaceStated(computation, compForm, correctedLiteral(compForm, correction.correctedValue!)) ?? computation : computation;
      if (!statedForm(newComputation, correction.correctedValue!)) newComputation = `${newComputation.trim()}${newComputation.trim() ? '; ' : ''}metadata correction: the cited statement now states ${correction.correctedValue}`;
      row.desc = newDesc;
      row.derivation = { ...(row.derivation ?? {}), requestQuote: String(row.derivation?.requestQuote ?? ''), computation: newComputation };
      rows.push({ ref, desc: newDesc, derivation: { requestQuote: String(row.derivation.requestQuote ?? ''), computation: newComputation } });
    });
  }
  if (!rows.length) return null;
  return metadataCorrectionCleared({ ...item, verificationIntent: clone.verificationIntent as never }, correction) ? { intentRows: rows } : null;
}

/** One ready checklist_update payload for an item's open corrections (rows of every correction merged), or null. */
export function metadataCorrectionReadyPayload(storyId: string, item: Pick<ChecklistItem, 'id' | 'userSees' | 'verificationIntent'> | undefined,
  corrections: readonly MetadataCorrection[], reason?: string): Record<string, unknown> | null {
  if (!item) return null;
  let current = structuredClone(item) as ChecklistItem;
  const rows = new Map<string, { ref: string; desc: string; derivation: { requestQuote: string; computation: string } }>();
  let userSees: string | undefined;
  for (const correction of corrections.filter(row => row.itemId === item.id)) {
    const patch = metadataCorrectionReadyPatch(current, correction);
    if (!patch) return null;
    if (patch.userSees !== undefined) { userSees = patch.userSees; current = { ...current, userSees }; }
    for (const row of patch.intentRows ?? []) {
      rows.set(row.ref, row);
      const [, lane, index] = row.ref.split(':');
      const target = (current.verificationIntent as unknown as Record<string, Array<Record<string, unknown>>> | undefined)?.[lane!]?.[Number(index)];
      if (target) { target.desc = row.desc; target.derivation = row.derivation; }
    }
  }
  if (!rows.size && userSees === undefined) return null;
  return { storyId, itemId: item.id, ...(userSees !== undefined ? { userSees } : {}), ...(rows.size ? { intentRows: [...rows.values()] } : {}),
    reason: reason ?? `Story-metadata correction: ${corrections.filter(row => row.itemId === item.id).map(row => `${row.wrongLiteral} -> ${row.correctedValue}`).join('; ').slice(0, 400)}`, metadataCorrection: true };
}

/** The Next of `[metadata_correction_unchanged]`: the ready rows of the item's corrections, else `next` (which names them). */
export function metadataCorrectionUnchangedNext(args: { storyId: string; item: Pick<ChecklistItem, 'id' | 'userSees' | 'verificationIntent'> | undefined; corrections: readonly MetadataCorrection[] }): string {
  const payload = metadataCorrectionReadyPayload(args.storyId, args.item, args.corrections);
  return payload ? `Next: proof-or-stop checklist_update ${shellQuote(JSON.stringify(payload))}`
    : `Next: proof-or-stop next --storyId=${args.storyId} (it names the wrong literal and the reviewer's value)`;
}

/**
 * The Next of `[metadata_correction_none]` (no open correction names the item): in PLAN the same update without the
 * correction flag (an ordinary PLAN edit); elsewhere `next`. The open corrections are named after it.
 */
export function metadataCorrectionNoneNext(args: { storyId: string; phase: string; args: Record<string, unknown>; open: readonly MetadataCorrection[] }): string {
  const { metadataCorrection: _flag, ...rest } = args.args;
  const named = args.open.length ? `\nOpen Story-metadata corrections (next routes them, one ready command each): ${args.open.slice(0, 6).map(describeMetadataCorrection).join(' | ')}` : '';
  const next = args.phase === 'PLAN' ? `Next: proof-or-stop checklist_update ${shellQuote(JSON.stringify(rest))}` : `Next: proof-or-stop next --storyId=${args.storyId}`;
  return `${next}${named}`;
}
