/**
 * Lab lean, item 1 (bench-staging/oldpos/lean-pipeline.md; EXPERIMENTAL `implementation.grouping: "story"`, implied
 * by `pipeline.lean=on`): ONE managed implementer run for every open checklist item of a Story.
 *
 * Old PoS ran one managed implementer dispatch per item (runs 59-61: 6 serial dispatches per run; runs 93/94/96:
 * DEV 11.8 min mean against a 7.8-min baseline for the whole task), each paying the submit / Codex start /
 * orientation cost (about 40-45 s) and an owner `next --run` turn between items (critical-path-59-61.md §7 row 3).
 * New PoS has the owner implement the whole change in one session. Here the bound item keeps its ordinary dispatch
 * prompt (above this block); every OTHER open item is one section of the same brief with the per-item material the
 * item's own dispatch would carry: context, userSees, declared files, the planned verification intents with their
 * pinned commands and test names, the exact required output, and caller extras (the counterpart probe lines).
 *
 * Per-item evidence and verification binding are kept: each item's work is committed under a message naming its id
 * (the framework's only proof that the run implemented it); the bound item's own completion call marks it done (its
 * one-shot capability is unchanged); every other item is verified by the framework (its pinned intents through
 * verification_run, a signed receipt each) and marked done by a framework step (handlers/next-driver.ts
 * `story_item_done`); an item no commit names, or whose pinned verification fails, gets its own implementer run as
 * without the switch. The DEV->REVIEW evidence chain, exact-text, removed-guard and intent-conflict gates are unchanged.
 *
 * Lab lean-dev (old-PoS runs 117 / 118): a Story run's commit marks a member done ONCE (storyRunMemberClaimUsed). A
 * member a gate reopens after that (exact-text, removed-guard, probe rows) is new work the commit predates: it gets its
 * own implementer run, as without the switch. Before, the same commit re-closed the reopened member, the gate reopened
 * it, and `next --run` alternated story_item_done / exact_text_prefix_assertion with no launch (runs 117 / 118).
 */
import { appendExactRequiredOutput } from './exact-required-output.js';
import { IMPLEMENTER_COMMIT_AUTHOR } from './item-done-commit.js';
import type { ChecklistItem } from './types.js';

export const STORY_RUN_BLOCK_BEGIN = '--- BEGIN STORY RUN';
export const STORY_RUN_BLOCK_END = '--- END STORY RUN ---';

const at = (text: unknown): number => (typeof text === 'string' ? Date.parse(text) : Number.NaN);

/**
 * Lab lean-dev (old-PoS runs 117 / 118): whether a Story run's claim on member `itemId` is already used, i.e. the item
 * moved to done (any path: the framework's story_item_done, the owner, a worker) at or after `since` (the run's
 * creation). Read from the checklist audit log (a status change with a reason) and the process events (a successful
 * `subagent_result` is appended on every move to done). A done mark before the run, another item, a failed result and a
 * done->done rewrite do not use it.
 */
export function storyRunMemberClaimUsed(args: {
  itemId: string;
  since: string;
  events: ReadonlyArray<{ type?: unknown; checklistId?: unknown; success?: unknown; timestamp?: unknown }>;
  auditLog?: ReadonlyArray<{ itemId?: unknown; from?: unknown; to?: unknown; timestamp?: unknown }>;
}): boolean {
  const since = at(args.since);
  if (!Number.isFinite(since)) return false;
  const after = (stamp: unknown): boolean => { const time = at(stamp); return Number.isFinite(time) && time >= since; };
  return args.events.some(event => event.type === 'subagent_result' && event.checklistId === args.itemId && event.success !== false && after(event.timestamp))
    || (args.auditLog ?? []).some(row => row.itemId === args.itemId && row.to === 'done' && row.from !== 'done' && after(row.timestamp));
}

type IntentRows = Partial<Record<string, Array<{ id?: string; desc?: string; verification?: { command?: string; selector?: string } }>>>;

/** The planned verification intents of one item, each with its pinned command and test name (as the item's own prompt lists them). */
export function pinnedVerificationLines(intent: IntentRows | undefined): string[] {
  const rows: string[] = [];
  for (const lane of ['happy', 'edge', 'adversarial']) {
    for (const entry of intent?.[lane] ?? []) {
      const pin = entry.verification?.command
        ? ` — pinned: \`${entry.verification.command}\`${entry.verification.selector ? ` (test name: ${entry.verification.selector})` : ''}`
        : '';
      rows.push(`- ${entry.id ?? lane} [${lane}] ${entry.desc ?? ''}${pin}`);
    }
  }
  return rows.length ? ['Planned verification intents (pins are immutable in DEV; gates replay each pinned command exactly):', ...rows] : [];
}

const quote = (text: string): string => text.replace(/"/g, "'");

/**
 * The Story-run block appended to the bound item's dispatch prompt: one section per OTHER item of `items` (the bound
 * item `primaryId` is the prompt above and is not repeated), the commit rule and who marks which item done.
 */
export function renderStoryRunSection(args: {
  storyId: string;
  primaryId: string;
  items: readonly ChecklistItem[];
  /** Extra per-item lines (e.g. the counterpart probe block of that item). */
  extrasFor?: (itemId: string) => readonly string[];
}): string[] {
  const { storyId, primaryId } = args;
  const others = args.items.filter(item => item.id !== primaryId);
  const ids = args.items.map(item => item.id);
  const lines = [
    '',
    `${STORY_RUN_BLOCK_BEGIN} (A/B implementation.grouping=story, experimental; lab lean) ---`,
    `This ONE run implements every open checklist item of the Story, not only ${primaryId}: ${ids.join(', ')}. Read the repository once and implement the items in order; each item below is its own section with the same contract as ${primaryId} above (its intents, pinned commands and test names, exact output, report lines).`,
    'For EACH item below:',
    '- implement it and make each of its pinned commands pass as written (name the tests exactly as pinned);',
    `- commit its work with the command in its section (one commit per item; when items change the same lines, ONE commit whose message names every item id it implements is accepted), as the canonical implementer author;`,
    '- its [intent-conflict], [pin-doubt] and [counterpart] report lines name its own refs (for example CHK-00N:edge:1); one final report covers every item.',
    `Commit these items BEFORE the completion call of ${primaryId} above: that call commits ${primaryId}'s files under ${primaryId}'s id and marks only ${primaryId} done. Do not call checklist_update for any other item.`,
    'The framework marks each other item done after this run: it checks that a commit of this run names the item, runs the item\'s pinned verification itself and records it, then marks the item done. An item no commit names, or whose pinned verification fails, gets its own implementer run afterwards.',
  ];
  for (const item of others) {
    const files = item.files;
    lines.push('');
    lines.push(`### ${item.id}: ${item.title}`);
    lines.push(`Context: ${item.context || '(not declared)'}`);
    if (item.userSees) lines.push(`User sees: ${item.userSees}`);
    lines.push(`Files: modify ${files?.modify.join(', ') || '(none)'}; create ${files?.create.join(', ') || '(none)'}; test ${files?.test.join(', ') || '(none)'}`);
    lines.push(...pinnedVerificationLines(item.verificationIntent as IntentRows | undefined));
    const exact: string[] = [];
    appendExactRequiredOutput(exact, [item]);
    lines.push(...exact.filter(line => line !== ''));
    lines.push(...(args.extrasFor?.(item.id) ?? []));
    lines.push(`Commit: git add <the files you changed for ${item.id}> && git commit --author="${IMPLEMENTER_COMMIT_AUTHOR}" -m "${quote(`${storyId} ${item.id}: ${item.title}`)}"`);
  }
  lines.push(STORY_RUN_BLOCK_END);
  return lines;
}
