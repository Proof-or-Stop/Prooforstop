/**
 * An excludes rationale checked against the Story's own items (A/B switch
 * plan.exclusionRationaleCheck, default on; core/ab-variants.ts).
 *
 * Old-PoS run 43 (bench-staging/oldpos/run43-analysis.md §1.3, §5.2 fix 2):
 * the scope-plan reviewer flagged a "keep the existing <operation> behavior
 * unchanged" sentence as a gap; the owner closed it with an excludes entry
 * whose rationale ("this Story only adds <another form>") was false, because
 * another item of the same Story adds a new variant of that very operation,
 * and the reviewer's rerun accepted the exclusion without checking it. The
 * covering row every earlier run had was dropped, and with it any reason to
 * look at the new variant's behaviour next to the existing one.
 *
 * Deterministic part (no model): the behaviour a scope row names is reduced to
 * its content terms (stemmed words without the scope / modality vocabulary such
 * as keep, existing, unchanged, behavior); an item changes that behaviour when
 * its title, userSees and declared modify / create file names share at least
 * two of those terms and at least 60% of them. Such a row cannot be closed by
 * an excludes entry:
 *   - scope_check_save refuses an `excluded` row of that kind (the reviewer
 *     saves it as a gap naming the item, or covered when a row states it);
 *   - story_review rejects one in a verdict saved earlier (the check off, or a
 *     legacy verdict) with ONE Next: a covering row on that item;
 *   - the plain gap remedy names that item instead of offering an excludes
 *     entry; scopePlanRerunReason reruns a verdict holding such a row once the
 *     checklist changed.
 * A row naming fewer than two content terms is left to the reviewer (the
 * scope-plan dispatch carries the same rule as an instruction).
 */
import { exclusionRationaleCheckOn } from './ab-variants.js';
import { loadConfig } from './config.js';
import type { ChecklistItem } from './types.js';

/** Scope / modality vocabulary: it says how a behaviour is treated, not which behaviour. */
const SCOPE_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'nor', 'of', 'to', 'in', 'on', 'at', 'for', 'from', 'with', 'without', 'as', 'by', 'into', 'via', 'per',
  'is', 'are', 'be', 'been', 'being', 'was', 'were', 'it', 'its', 'this', 'that', 'these', 'those', 'their', 'there',
  'not', 'no', 'only', 'all', 'any', 'each', 'every', 'same', 'other', 'also', 'still', 'just', 'than', 'then', 'when', 'where', 'which', 'while',
  'must', 'should', 'shall', 'may', 'can', 'could', 'would', 'will', 'do', 'does', 'did', 'done', 'need', 'needs',
  'keep', 'keeps', 'kept', 'keeping', 'preserve', 'preserves', 'preserved', 'retain', 'retains', 'maintain', 'maintains', 'leave', 'leaves', 'left',
  'existing', 'exist', 'exists', 'current', 'currently', 'previous', 'prior', 'old', 'legacy', 'original', 'today',
  'unchanged', 'change', 'changes', 'changed', 'changing', 'alter', 'alters', 'altered', 'altering', 'modify', 'modifies', 'modified', 'touch', 'touches', 'touched', 'affect', 'affects', 'affected',
  'behavior', 'behaviors', 'behaviour', 'behaviours', 'semantic', 'semantics', 'work', 'works', 'working', 'support', 'supports', 'supported', 'handle', 'handles', 'handling',
  'add', 'adds', 'added', 'new', 'use', 'uses', 'used', 'using', 'make', 'makes', 'story', 'item', 'items', 'feature', 'features', 'scope', 'test', 'tests', 'case', 'cases',
  'go', 'ts', 'js', 'py', 'rs', 'md',
]);

function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 6 && word.endsWith('ment')) return word.slice(0, -4);
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && /(?:s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Content terms of a text: camelCase / snake / kebab split, lower-cased, stemmed, scope vocabulary dropped. */
export function behaviourTerms(text: string): Set<string> {
  const out = new Set<string>();
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  for (const raw of spaced.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || /^\d+$/.test(raw) || SCOPE_WORDS.has(raw)) continue;
    const word = stem(raw);
    if (word.length >= 3 && !SCOPE_WORDS.has(word)) out.add(word);
  }
  return out;
}

export interface BehaviourItem { id: string; title: string; shared: string[] }

type ItemLike = Pick<ChecklistItem, 'id' | 'title' | 'userSees' | 'status'> & { files?: { modify?: readonly string[]; create?: readonly string[] } };

const fileStems = (item: ItemLike): string[] => [...(item.files?.modify ?? []), ...(item.files?.create ?? [])]
  .map(path => path.split('/').at(-1)!.replace(/\.[^.]+$/, ''));

/** The Story's items (withdrawn ones aside) whose own title, userSees and modify / create file names name the behaviour. */
export function itemsChangingBehaviour(feature: string, items: readonly ItemLike[]): BehaviourItem[] {
  const terms = behaviourTerms(feature);
  if (terms.size < 2) return [];
  const need = Math.max(2, Math.ceil(terms.size * 0.6));
  const out: BehaviourItem[] = [];
  for (const item of items) {
    if (item.status === 'withdrawn') continue;
    const own = behaviourTerms([item.title, typeof item.userSees === 'string' ? item.userSees : '', ...fileStems(item)].join(' '));
    const shared = [...terms].filter(term => own.has(term));
    if (shared.length >= need) out.push({ id: item.id, title: item.title, shared });
  }
  return out;
}

export interface ExclusionContradiction { feature: string; rationale: string; items: BehaviourItem[] }

/** The verdict's `excluded` rows whose named behaviour an item of the Story adds or changes. */
export function contradictedExclusions(
  scope: { features?: ReadonlyArray<{ feature: string; status: string; excluded_by?: string | null }> },
  checklist: { items: readonly ItemLike[] },
): ExclusionContradiction[] {
  const out: ExclusionContradiction[] = [];
  for (const row of scope.features ?? []) {
    if (row.status !== 'excluded' || !row.feature) continue;
    const items = itemsChangingBehaviour(row.feature, checklist.items);
    if (items.length) out.push({ feature: row.feature, rationale: row.excluded_by ?? '', items });
  }
  return out;
}

/** Whether the check is on for this project (default on; a malformed value or an unreadable config keeps on). */
export function exclusionRationaleCheckActive(root: string): boolean {
  try { return exclusionRationaleCheckOn(loadConfig(root)); } catch { return true; }
}

/** The scope-plan reviewer's half of the check (dispatch prompt line). */
export const SCOPE_PLAN_EXCLUSION_CHECK = '- Exclusion check: an excludes entry closes a row only when its reason holds against this Story\'s own items. If any item\'s title, userSees or files add or change the behaviour the row names (a new variant of the same operation counts), the row is a gap naming that item, never excluded; scope_check_save refuses such an exclusion [scope_exclusion_contradicted]. On a rerun, re-check every exclusion added since the previous verdict this way.';

const itemList = (items: readonly BehaviourItem[]): string =>
  items.map(item => `${item.id} ("${item.title}"; shared terms: ${item.shared.join(', ')})`).join(', ');

/** scope_check_save refusal text for the contradicted rows of a payload. */
export function exclusionRefusal(rows: readonly ExclusionContradiction[]): string {
  return 'scope_check_save refused [scope_exclusion_contradicted]: an excludes entry cannot close a behaviour another item of this Story adds or changes. '
    + rows.map(row => `"${row.feature}" is saved as excluded ("${row.rationale.slice(0, 200)}"), but ${itemList(row.items)} names that behaviour.`).join(' ')
    + ' Save each such row as status="gap" whose feature names the item (the owner adds a covering row to it), or as status="covered" with covered_by when a row of that item already states the behaviour; then call scope_check_save again with the complete payload.';
}

/** story_review blocker text for one contradicted row: ONE Next, a covering row on the first named item. */
export function exclusionRejection(storyId: string, row: ExclusionContradiction, rerun: string, rerunWhat: string): string {
  const target = row.items[0]!;
  return `scope exclusion rejected [scope_exclusion_contradicted]: "${row.feature}" is closed by the excludes rationale "${row.rationale.slice(0, 200)}", but ${itemList(row.items)} of this Story adds or changes that behaviour, so the rationale does not hold. `
    + `Next (PLAN): add a covering row to ${target.id} that runs the existing behaviour and the new variant on the same operand cases, and drop that excludes entry `
    + `(\`proof-or-stop checklist_update --storyId=${storyId} --itemId=${target.id} --verificationIntent='<full intent with the covering row>'\`); then run \`${rerun}\`: ${rerunWhat}.`;
}

/** The scope_gap remedy when an item of the Story changes the gap's behaviour (no excludes route). */
export function gapCoveredByItemRemedy(storyId: string, feature: string, source: string, items: readonly BehaviourItem[], rerun: string, rerunWhat: string): string {
  const target = items[0]!;
  return `scope gap${source}: the scope-plan reviewer found "${feature}" neither covered nor excluded, and ${itemList(items)} of this Story adds or changes that behaviour, so an excludes entry cannot close it. `
    + `Next (PLAN, no INIT reopen): add a covering row to ${target.id} that runs the existing behaviour and the new variant on the same operand cases `
    + `(\`proof-or-stop checklist_update --storyId=${storyId} --itemId=${target.id} --verificationIntent='<full intent with the covering row>'\`); then run \`${rerun}\`: ${rerunWhat}.`;
}
