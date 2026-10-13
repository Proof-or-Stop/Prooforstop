/**
 * Old-PoS run 27 (§2 row 4b): the scope-plan reviewer rerun after a blocked
 * verdict started cold (run #2: 159 s, 0.72M input) although only a few
 * checklist rows changed. A rerun prompt now starts with the previous verdict
 * (its gaps, drift and orphan rows) and the checklist diff since that verdict,
 * so the reviewer checks first what the owner changed to answer it.
 *
 * Orientation only, never a narrower review: the prompt still asks for the
 * full trace, the full pin audit and the same-semantics rule over the current
 * checklist. The checklist the previous verdict judged is read from the Git
 * commit that published scope-check.json (scope_check_save auto-commits the
 * Story metadata), and used only when its digest equals the verdict's
 * checklistDigest; otherwise the diff is omitted and the prompt says so.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { relative } from 'node:path';
import type { StoryStore } from './store.js';
import type { ChecklistData, ChecklistItem, ScopeCheckData } from './types.js';
import { scopeReviewChecklistDigest } from './scope-check-integrity.js';
import { VERIFICATION_LANES } from './verification.js';
import { excludesEntryCheck } from './scope-exclusion-rationale.js';

const MAX_DIFF_LINES = 40;
const clip = (text: string, max = 200): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The checklist as of the commit that last published scope-check.json, or null. */
function checklistAtVerdict(gitCwd: string, storyDir: string, scope: Pick<ScopeCheckData, 'checklistDigest'>): ChecklistData | null {
  if (!scope.checklistDigest) return null;
  try {
    const prefix = relative(realpathSync(gitCwd), realpathSync(storyDir)).replaceAll('\\', '/');
    if (prefix.startsWith('..')) return null;
    const git = (argv: string[]) => execFileSync('git', argv, { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
    const commit = git(['log', '-1', '--format=%H', '--', `${prefix}/scope-check.json`]).trim();
    if (!commit) return null;
    const checklist = JSON.parse(git(['show', `${commit}:${prefix}/checklist.json`])) as ChecklistData;
    return scopeReviewChecklistDigest(checklist) === scope.checklistDigest ? checklist : null;
  } catch {
    return null;
  }
}

function intentRows(item: Pick<ChecklistItem, 'verificationIntent'>): string[] {
  return VERIFICATION_LANES.flatMap(lane => (item.verificationIntent?.[lane] ?? []).map(row => `${lane}: ${String(row.desc ?? '')}`));
}

/** Per-item checklist changes between the judged checklist and the current one. */
export function scopeChecklistDiff(before: Pick<ChecklistData, 'items'>, after: Pick<ChecklistData, 'items'>): string[] {
  const lines: string[] = [];
  const old = new Map(before.items.map(item => [item.id, item]));
  const now = new Map(after.items.map(item => [item.id, item]));
  for (const item of after.items) {
    const prior = old.get(item.id);
    if (!prior) { lines.push(`- ${item.id} added: ${clip(item.title)}`); continue; }
    const changes: string[] = [];
    if (prior.status !== item.status && (prior.status === 'withdrawn' || item.status === 'withdrawn')) changes.push(`  status ${prior.status} -> ${item.status}`);
    if (prior.title !== item.title) changes.push(`  title: ${clip(item.title)}`);
    if (JSON.stringify(prior.userSees ?? null) !== JSON.stringify(item.userSees ?? null)) changes.push(`  userSees: ${clip(JSON.stringify(item.userSees ?? null))}`);
    if (JSON.stringify(prior.excludes ?? []) !== JSON.stringify(item.excludes ?? [])) changes.push(`  excludes: ${clip(JSON.stringify(item.excludes ?? []))}`);
    const was = intentRows(prior);
    const is = intentRows(item);
    for (const row of is) if (!was.includes(row)) changes.push(`  + ${clip(row)}`);
    for (const row of was) if (!is.includes(row)) changes.push(`  - ${clip(row)}`);
    if (changes.length) lines.push(`- ${item.id} changed:`, ...changes);
  }
  for (const item of before.items) if (!now.has(item.id)) lines.push(`- ${item.id} removed: ${clip(item.title)}`);
  return lines;
}

/** Ids of the items added, removed or changed (in a field the diff shows) between two checklists. */
export function changedScopeItemIds(before: Pick<ChecklistData, 'items'>, after: Pick<ChecklistData, 'items'>): Set<string> {
  const out = new Set<string>();
  for (const line of scopeChecklistDiff(before, after)) {
    const id = line.match(/^- (CHK-\d+) (?:added|changed|removed)/)?.[1];
    if (id) out.add(id);
  }
  return out;
}

/**
 * Lab plan-light (A/B plan.reviewMerge=on, new PoS ADR-043): the rerun is a
 * confirmation re-review. The previous verdict stands for the rows of items the
 * diff does not touch; the reviewer copies them and re-judges only the flagged
 * rows and the changed items. Empty when the judged checklist is unknown.
 */
function confirmationLines(scope: ScopeCheckData, changed: ReadonlySet<string>): string[] {
  const keep = (scope.features ?? []).filter(feature => (feature.status === 'covered' || feature.status === 'excluded')
    && !String(feature.covered_by ?? '').split(/[,\s]+/).some(id => changed.has(id)));
  return [
    `Confirmation re-review (A/B plan.reviewMerge=on): the previous verdict stands for every row of an item the diff above does not touch. Re-judge only (1) the flagged rows listed above and (2) every request sentence and row of the changed items (${[...changed].join(', ') || 'none'}); aim for at most 6 commands. Copy each row below into your scope_check_save unchanged, then add your re-judged rows; the summary counts cover all of them.`,
    `Previous rows to copy unchanged (${keep.length}):`,
    ...keep.map(feature => `- ${JSON.stringify({ feature: feature.feature, covered_by: feature.covered_by ?? null, status: feature.status, excluded_by: feature.excluded_by ?? null, source: feature.source })}`),
  ];
}

const MAX_EXCLUDES_LINES = 12;

/**
 * Old-PoS runs 61 / 63: the owner's excludes entries in full (the checklist diff clips them at 200
 * characters, so the reviewer saw "String si…") with the framework's deterministic check result for
 * each against the flagged rows. Orientation only; the reviewer still judges every entry.
 */
function ownerExcludesLines(root: string, flagged: readonly string[], before: ChecklistData | null, current: ChecklistData): string[] {
  const old = new Map((before?.items ?? []).map(item => [item.id, new Set(item.excludes ?? [])]));
  const rows: string[] = [];
  for (const item of current.items) {
    for (const entry of item.excludes ?? []) {
      if (before && old.get(item.id)?.has(entry)) continue;
      rows.push(`- ${item.id}: "${(entry.length > 800 ? `${entry.slice(0, 799)}…` : entry).replace(/\s+/g, ' ')}" -> check: ${excludesEntryCheck(root, entry, flagged, current.items)}`);
    }
  }
  if (rows.length === 0) return [];
  return [`Owner excludes ${before ? 'added since that verdict' : '(all current entries)'}, in full, with the framework's deterministic check against the listed rows (re-raise a row an entry names only with the reason that entry's reason fails):`,
    ...rows.slice(0, MAX_EXCLUDES_LINES), ...(rows.length > MAX_EXCLUDES_LINES ? [`- +${rows.length - MAX_EXCLUDES_LINES} more entries (read checklist.json)`] : [])];
}

/** The rerun-context lines for the scope-plan prompt; empty when there is no previous verdict. */
export function renderScopePlanRerunContext(args: { store: StoryStore; storyId: string; gitCwd: string; root?: string; confirmation?: boolean }): string[] {
  let scope: ScopeCheckData | null = null;
  try { scope = args.store.readScopeCheck(args.storyId); } catch { scope = null; }
  if (!scope) return [];
  const flagged = (scope.features ?? []).filter(feature => feature.status !== 'covered' && feature.status !== 'excluded');
  const lines = ['', `Previous scope-plan verdict (${scope.checkedAt}${scope.deliveryRunId ? `, run ${scope.deliveryRunId}` : ''}): `
    + `${scope.summary?.covered ?? 0} covered, ${scope.summary?.excluded ?? 0} excluded, ${scope.summary?.gaps ?? 0} gap(s). This is a rerun: the owner changed the checklist to answer it.`];
  for (const feature of flagged.slice(0, 12)) lines.push(`- ${feature.status}: ${clip(feature.feature, 300)}`);
  if (flagged.length > 12) lines.push(`- +${flagged.length - 12} more`);
  let current: ChecklistData | null = null;
  try { current = args.store.readChecklist(args.storyId); } catch { current = null; }
  const before = current ? checklistAtVerdict(args.gitCwd, args.store.storyDirPath(args.storyId), scope) : null;
  if (before && current) {
    const diff = scopeChecklistDiff(before, current);
    lines.push(diff.length ? 'Checklist changes since that verdict:' : 'Checklist changes since that verdict: none.');
    lines.push(...diff.slice(0, MAX_DIFF_LINES));
    if (diff.length > MAX_DIFF_LINES) lines.push(`- +${diff.length - MAX_DIFF_LINES} more lines (read checklist.json)`);
    if (args.root) lines.push(...ownerExcludesLines(args.root, flagged.map(feature => feature.feature), before, current));
    if (args.confirmation) return [...lines, ...confirmationLines(scope, changedScopeItemIds(before, current))];
  } else {
    lines.push('Checklist changes since that verdict: not reconstructable; compare the listed rows with the current checklist.json yourself.');
    if (args.root && current) lines.push(...ownerExcludesLines(args.root, flagged.map(feature => feature.feature), null, current));
  }
  lines.push('Start by re-judging each listed row against the changed items above. This orientation never narrows the review: the full request trace, the full pin audit and the same-semantics rule below still apply to the current checklist.');
  return lines;
}
