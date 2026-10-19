/**
 * Lab plan-deadend (old-PoS run 121, bench-staging/oldpos/run121-analysis.md): PLAN never ends on "none runnable" while a
 * scope-plan gap blocks DEV.
 *
 * Run 121 (pipeline.lean=on) ended in PLAN, reward 0. The last story_review round had three scope_gap blockers:
 *   (1) the scope-plan reviewer, sourcing docs/.../array.md, reported that the doc promises an inclusive two-part range
 *       while the existing evaluator excludes the end (a pre-existing doc/code drift; the request never names the doc and
 *       asks for no documentation work);
 *   (2) and (3) two coverage gaps (multibyte two-part string ranges; rune vs byte length in string assignment) whose text
 *       matched neither the precedent-conflict template nor the changing-behaviour template (scope-exclusion-rationale.ts).
 * story_review's generic gap text offered an excludes entry with `--itemId=<CHK-id>` and no row patch, so `next`'s
 * storyReviewBlockersStep found no command to hand over: the agent step plan_review_blockers had no command and
 * renderNextStep printed `Next: none runnable (see Why)`, which the owner's guidance treats as a stop.
 *
 * Here, each such gap gets one runnable remedy:
 *   - docDriftSettlement: a gap sourced from a documentation file (or naming one when the source is unset) that reports a
 *     conflict with the existing behaviour, on a doc the request neither names nor asks to change and no item of the Story
 *     modifies, is pre-existing doc/code drift outside the Story. Precedence request text > scope boundary > reviewer
 *     opinion (the same order as core/file-state-conflict.ts): story_review records it as settled by the framework
 *     (advisory `scope_gap_doc_drift_settled`) instead of a blocker no checklist row can answer. The Story keeps the
 *     behaviour the request and the base set; REVIEW's pre-existing disposition handles a later drift finding the same
 *     way. Switch plan.docDriftSettle (default on, `off` = rollback).
 *   - plainScopeGapRemedy: every other plain gap names a ready covering-row patch (`<item>:edge:+`, placeholders the owner
 *     authors) on the item the gap names, else the item whose title / userSees / files share the most of its terms, else
 *     the first open item; the excludes route stays named for reference-only material. A coverage gap therefore becomes a
 *     row (detection kept), never a silent stop.
 * Detection: the doc settle waives only a reviewer gap on unrequested documentation that no item changes; any gap the
 * request or an item makes the Story's own stays a blocker with its row patch.
 */
import { behaviourTerms, itemsChangingBehaviour } from './scope-exclusion-rationale.js';
import { requestAsksDocsChange } from './boundary-path-excludes.js';
import { isDocumentationPath, normalizeScopePath, pathMatchesScopePattern } from './scope-path-classifier.js';

export const SCOPE_GAP_DOC_DRIFT_SETTLED = 'scope_gap_doc_drift_settled';

/** Story artifacts the scope-plan reviewer cites as a gap's source: never product documentation. */
const STORY_ARTIFACTS = new Set(['request.md', 'background.md', 'plan.md', 'decision.md', 'understanding.md', 'proof-or-stop.md']);
const DOC_PATH = /(?<![\w./-])(?:[\w.-]+\/)*[\w.-]+\.(?:md|mdx|rst|adoc)\b/gi;
/** The gap reports a conflict between what the doc says and what exists (not a missing promise). */
const CONFLICT_WORDS = /\b(?:conflict\w*|contradict\w*|drift\w*|stale|outdated|out of date|mismatch\w*|inconsisten\w*|disagree\w*|wrong(?:ly)?|incorrect\w*)\b/i;
const SAYS_WHILE_EXISTING = /\b(?:says?|states?|shows?|claims?|documents?|promises?|describes?)\b[^.;]*\b(?:while|but|whereas|although)\b[^.;]*\b(?:existing|base|current|actual|evaluator|implementation|code)\b/i;

type ItemLike = { id: string; title?: string; userSees?: unknown; status?: string; files?: { modify?: readonly string[]; create?: readonly string[] } };

const productDoc = (path: string): string | null => {
  const normalized = normalizeScopePath(path.trim());
  if (!normalized || normalized.startsWith('.proof-or-stop/')) return null;
  const base = normalized.split('/').pop()!.toLowerCase();
  if (STORY_ARTIFACTS.has(base)) return null;
  return isDocumentationPath(normalized) ? normalized : null;
};

/** The product documentation a gap is about: its source when that is a doc; else (no source) the docs its text names. */
export function gapDocPaths(gap: { feature: string; source?: string | null }): string[] {
  const source = String(gap.source ?? '').trim();
  if (source) {
    const doc = productDoc(source);
    return doc ? [doc] : [];
  }
  return [...new Set([...gap.feature.matchAll(DOC_PATH)].map(match => productDoc(match[0])).filter((path): path is string => Boolean(path)))];
}

/**
 * The framework's settlement of a pre-existing doc/code drift gap (see the module header), or null when the gap stays a
 * blocker: not about product documentation, not a conflict with existing behaviour, a doc the request names or asks to
 * change (documentation work, or the doc's path / file name), a doc an item of the Story modifies, a behaviour an item of
 * the Story adds or changes (the exclusion check's own predicate: then the doc may describe what the Story must do), or
 * no request text.
 */
export function docDriftSettlement(args: { feature: string; source?: string | null; items: readonly ItemLike[]; requestText: string | null | undefined }): { path: string; why: string } | null {
  const request = args.requestText ?? null;
  if (!request || !request.trim()) return null;
  const paths = gapDocPaths(args);
  if (paths.length === 0) return null;
  if (!CONFLICT_WORDS.test(args.feature) && !SAYS_WHILE_EXISTING.test(args.feature)) return null;
  if (requestAsksDocsChange(request)) return null;
  if (itemsChangingBehaviour(args.feature, args.items as never).length) return null;
  const lower = request.toLowerCase();
  for (const path of paths) {
    const base = path.split('/').pop()!.toLowerCase();
    if (lower.includes(path.toLowerCase()) || lower.includes(base)) return null;
    const modifying = args.items.find(item => item.status !== 'withdrawn'
      && [...(item.files?.modify ?? []), ...(item.files?.create ?? [])].some(pattern => pathMatchesScopePattern(path, pattern)));
    if (modifying) return null;
  }
  const path = paths[0]!;
  return { path, why: `${paths.join(', ')} is documentation the request neither names nor asks to change and no item of this Story modifies; `
    + 'its conflict with the existing behaviour is pre-existing doc/code drift outside this Story (precedence: request text > scope boundary > reviewer opinion). '
    + 'The Story keeps the behaviour the request and the base set and leaves the doc as it is (a follow-up may correct it); no checklist row and no reviewer rerun for it' };
}

/** The item a plain gap's covering row goes to: the first live item it names, else the best term overlap, else the first open item. */
export function gapCoveringTarget(feature: string, items: readonly ItemLike[]): string | null {
  const live = items.filter(item => item.status !== 'withdrawn');
  if (live.length === 0) return null;
  for (const match of feature.matchAll(/\bCHK-\d+\b/g)) {
    if (live.some(item => item.id === match[0])) return match[0];
  }
  const terms = behaviourTerms(feature);
  let best: { id: string; shared: number } | null = null;
  for (const item of live) {
    const stems = [...(item.files?.modify ?? []), ...(item.files?.create ?? [])].map(path => path.split('/').pop()!.replace(/\.[^.]+$/, ''));
    const own = behaviourTerms([item.title ?? '', typeof item.userSees === 'string' ? item.userSees : '', ...stems].join(' '));
    const shared = [...terms].filter(term => own.has(term)).length;
    if (shared > 0 && (!best || shared > best.shared)) best = { id: item.id, shared };
  }
  if (best) return best.id;
  return (live.find(item => item.status !== 'done') ?? live[0]!).id;
}

/** The appended covering row of a plain gap (placeholders the owner authors; nothing is pinned for it). */
export function gapCoveringRowPatch(itemId: string): Record<string, unknown> {
  return { ref: `${itemId}:edge:+`, desc: '<the case the gap names -> the expected result>',
    type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story',
    verification: { command: '<pinned test command, e.g. go test -v ./pkg -run ^TestName$>', selector: '<line its passing run prints, e.g. --- PASS: TestName>' },
    derivation: { requestQuote: '<the request sentence that decides the case, verbatim (a base-counterpart derivation only when no sentence speaks)>', computation: '<the steps from it to the pinned value>' } };
}

/**
 * story_review's blocker text for a plain scope gap (neither covered nor excluded, no other template): the reviewer's
 * finding, ONE ready covering row (story_review's row patches reach `next` as a batch), and the excludes route for
 * reference-only material, on the same item.
 */
export function plainScopeGapRemedy(args: { storyId: string; feature: string; source: string; items: readonly ItemLike[]; rerun: string; rerunWhat: string }): string {
  const { storyId, feature, source, rerun, rerunWhat } = args;
  const target = gapCoveringTarget(feature, args.items);
  const head = `scope gap${source}: the scope-plan reviewer found "${feature}" neither covered by a checklist item (title/userSees/verificationIntent) nor excluded by an item's excludes. `;
  const tail = `then run \`${rerun}\`: ${rerunWhat}. The INIT scope boundary is not an input of this verdict.`;
  if (!target) {
    return `${head}Next (PLAN, no INIT reopen): cover it in a checklist item, or, for reference-only material or an acknowledged constraint, append an excludes entry that names it and says why `
      + `(\`proof-or-stop checklist_update --storyId=${storyId} --itemId=<CHK-id> --excludes='[...current excludes, "${feature}: <why>"]'\`); ${tail}`;
  }
  return `${head}Next (PLAN, no INIT reopen): cover it with a row on ${target} that pins the case it names `
    + `(\`proof-or-stop checklist_update --storyId=${storyId} --itemId=${target} --intentRows='${JSON.stringify([gapCoveringRowPatch(target)])}'\`); `
    + `only for reference-only material or an acknowledged constraint, append an excludes entry to ${target} instead that names it and says why `
    + `(\`proof-or-stop checklist_update --storyId=${storyId} --itemId=${target} --excludes='[...current excludes, "${feature.slice(0, 160)}: <why>"]'\`); ${tail}`;
}
