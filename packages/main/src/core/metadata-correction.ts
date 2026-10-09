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
 * Literal sweep (run 31 D5: `hooo` lived in userSees and an intent row, `abc`
 * in an intent row and userSees; each checker fixed one copy): every other
 * occurrence of the wrong literal across all items' userSees / intent rows is
 * listed in the same correction step.
 */
import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import type { ChecklistItem, Finding } from './types.js';
import { digestCanonicalJson } from './digest.js';
import { isStoryMetadataFile, isStoryMetadataFinding } from './metadata-finding-class.js';

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
  return best ? { wrongLiteral: best.wrong, correctedValue: quoteStyle(best.wrong, best.corrected) } : { wrongLiteral: present.at(-1)!, correctedValue: null };
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
  const rowRefs = [...desc.matchAll(/\b(CHK-\d+):(happy|edge|adversarial):(\d+)\b/g)].map(match => match[0]);
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
  const inner = literal.replace(/^['"`]|['"`]$/g, '');
  if (!isStatement(literal) && inner.length < 4) return [];
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
  return [...byKey.values()];
}

/** Stored open findings whose cited defect lies only in Story metadata (never repair work). */
export function isPureMetadataFinding(finding: Pick<Finding, 'files' | 'desc'>): boolean {
  return isStoryMetadataFinding(finding);
}

/**
 * Old-PoS run 31: the userSees text the candidate-spec route judges. A verified
 * metadata correction (corrected value now stated in place of the reviewer-cited
 * wrong literal) is reverted for routing only, so an owner's text correction in
 * REVIEW does not stale the route and rerun every lane. Any other userSees edit
 * still changes the routing input (the reroute stays the safe fallback).
 */
export function routingUserSees(store: Pick<Store, 'readProcessEvents'>, storyId: string, userSees: string | undefined): string | undefined {
  if (!userSees) return userSees;
  let events: Array<Record<string, unknown>> = [];
  try { events = store.readProcessEvents(storyId).filter(event => event.type === METADATA_FINDING_RECLASSIFIED_EVENT); } catch { return userSees; }
  let text = userSees;
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
