/**
 * Lab run132 (bench-staging/oldpos/run132-analysis.md I1): the INIT blocker guidance said "Fix each issue in the Story
 * (story_update / checklist_update / background)". `background` is no command, and story_update has no background
 * argument; run 132's owner sent the background to story_update (dropped, reported as updated) and then hunted 1.7 min
 * for `background_set`. The guidance now names the exact command for each input a blocking issue cites (its
 * requirementRef, else the CHK ids / "background" its text names); an issue citing nothing names every editor.
 */
import type { InitCheckIssue } from './types.js';

const BIN = 'proof-or-stop';
const STORY_FIELDS = new Set(['title', 'description', 'priority']);

type Target = { kind: 'background' } | { kind: 'item'; itemId: string; rowRef?: string } | { kind: 'story'; field: string }
  | { kind: 'scope-boundary' } | { kind: 'execution-boundary' };

/** The inputs one issue cites. */
function targetsOf(issue: InitCheckIssue): Target[] {
  const ref = String(issue.requirementRef ?? '').trim();
  const row = ref.match(/^verification-intent:(CHK-\d+):(happy|edge|adversarial):(\d+)$/);
  if (row) return [{ kind: 'item', itemId: row[1]!, rowRef: `${row[1]}:${row[2]}:${row[3]}` }];
  const item = ref.match(/^checklist:(CHK-\d+)$/);
  if (item) return [{ kind: 'item', itemId: item[1]! }];
  if (/^background:|^required-input:background$/.test(ref)) return [{ kind: 'background' }];
  const story = ref.match(/^story:(\w+)$/);
  if (story) return [{ kind: 'story', field: story[1]! }];
  if (/^(?:required-input:)?scope-boundary$/.test(ref)) return [{ kind: 'scope-boundary' }];
  if (/^(?:required-input:)?execution-boundary$/.test(ref)) return [{ kind: 'execution-boundary' }];
  const desc = String(issue.desc ?? '');
  const named: Target[] = [...new Set(desc.match(/\bCHK-\d+\b/g) ?? [])].map(itemId => ({ kind: 'item', itemId }));
  if (/\bbackground\b/i.test(desc)) named.push({ kind: 'background' });
  return named;
}

const json = (payload: Record<string, unknown>): string => `'${JSON.stringify(payload).replaceAll("'", `'"'"'`)}'`;

function commandOf(storyId: string, target: Target): string {
  switch (target.kind) {
    case 'background':
      return `background.md: ${BIN} background_set --storyId=${storyId} --content='<the whole four-section background.md>' (one section: ${BIN} background_append --storyId=${storyId} --section=<trigger_event|key_insight|tradeoff|conversation_texture> --content='<text>')`;
    case 'item':
      return target.rowRef
        ? `${target.rowRef}: ${BIN} checklist_update ${json({ storyId, itemId: target.itemId, intentRows: [{ ref: target.rowRef, desc: '<the corrected row>' }] })}`
        : `${target.itemId}: ${BIN} checklist_update ${json({ storyId, itemId: target.itemId, context: '<the corrected context (or title / userSees / intentRows, the field the issue names)>' })}`;
    case 'story':
      return STORY_FIELDS.has(target.field)
        ? `story ${target.field}: ${BIN} story_update --storyId=${storyId} --${target.field}=<the corrected ${target.field}>`
        : `story ${target.field}: no command edits it after story_create; fix it in the title / description (${BIN} story_update --storyId=${storyId} --description=<...>) or answer the issue there`;
    case 'scope-boundary':
      return `scope boundary: ${BIN} scope_boundary_set --storyId=${storyId} ... (see ${BIN} scope_boundary_set --help)`;
    case 'execution-boundary':
      return `execution boundary: ${BIN} execution_boundary_set --storyId=${storyId} ... (see ${BIN} execution_boundary_set --help)`;
  }
}

/** One line per cited input of the blocking issues (deduplicated, in issue order); an uncited issue names every editor. */
export function initBlockerFixCommands(storyId: string, blockers: ReadonlyArray<{ agentId?: string; issue: InitCheckIssue }>): string[] {
  const out = new Map<string, string>();
  const add = (target: Target): void => {
    const key = target.kind === 'item' ? `item:${target.rowRef ?? target.itemId}` : target.kind === 'story' ? `story:${target.field}` : target.kind;
    if (!out.has(key)) out.set(key, commandOf(storyId, target));
  };
  for (const { issue } of blockers) {
    const targets = targetsOf(issue);
    if (targets.length) { targets.forEach(add); continue; }
    add({ kind: 'background' });
    add({ kind: 'item', itemId: 'CHK-NNN' });
    add({ kind: 'story', field: 'description' });
  }
  return [...out.values()];
}
