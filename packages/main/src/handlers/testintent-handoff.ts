import type { HandlerContext } from './context.js';
import type { ChecklistItem } from '../core/types.js';

function laneCount(item: ChecklistItem, lane: 'happy' | 'edge' | 'adversarial'): number {
  return item.testIntent && item.testIntent !== null
    ? item.testIntent[lane]?.length ?? 0
    : 0;
}

function itemNeedsIntent(item: ChecklistItem): boolean {
  if (item.testIntent === null) return false;
  return !item.testIntent || !Array.isArray(item.testIntent.happy) || item.testIntent.happy.length === 0;
}

function compactChecklistItem(item: ChecklistItem) {
  return {
    id: item.id,
    title: item.title,
    context: item.context ?? '',
    phase: item.phase ?? 'DEV',
    status: item.status,
    testIntent: item.testIntent ?? undefined,
  };
}

export function createTestIntentHandoffHandlers(ctx: HandlerContext) {
  const { store } = ctx;

  return {
    testintent_handoff(args: { storyId: string; itemIds?: string[] }): object {
      const story = store.readStory(args.storyId);
      const checklist = store.readChecklist(args.storyId);
      const wanted = new Set(args.itemIds || []);
      const scopedItems = wanted.size > 0
        ? checklist.items.filter((item) => wanted.has(item.id))
        : checklist.items;

      if (wanted.size > 0 && scopedItems.length !== wanted.size) {
        const found = new Set(scopedItems.map((item) => item.id));
        const missing = [...wanted].filter((id) => !found.has(id));
        throw new Error(`Unknown checklist item(s): ${missing.join(', ')}`);
      }

      const missingIntentItems = scopedItems.filter(itemNeedsIntent);
      const nullIntentItems = scopedItems.filter((item) => item.testIntent === null);
      const existingIntentItems = scopedItems.filter((item) => item.testIntent && item.testIntent !== null);
      const worktreeHint = story.worktree?.path || ctx.root;
      const checklistJson = JSON.stringify(scopedItems.map(compactChecklistItem), null, 2);
      const missingList = missingIntentItems.map((item) => `${item.id} "${item.title}"`).join(', ') || '(none)';

      const prompt = [
        `You are the test-intent agent for Koala story ${args.storyId}.`,
        '',
        'Follow the repository test-intent agent contract:',
        '- First review checklist split quality against the story description.',
        '- If the split is wrong, report concrete checklist changes and stop.',
        '- If the split is acceptable, write testIntent for each testable item via koala checklist_update.',
        '- Main agent must not write testIntent; you own this handoff.',
        '- Do not edit docs/story or fixture JSON directly.',
        `- Run commands from this story worktree: ${worktreeHint}`,
        '',
        'Story:',
        `title: ${story.title}`,
        `type: ${story.type}`,
        `priority: ${story.priority}`,
        `phase: ${story.phase}`,
        `description: ${story.description}`,
        '',
        `Checklist items to review (${scopedItems.length}; missing testIntent.happy: ${missingList}):`,
        checklistJson,
        '',
        'For each testable item, write structured testIntent entries:',
        '{"happy":[{"desc":"操作/条件 -> 预期结果; WHY: 覆盖意图","type":"cli_blackbox"}],"edge":[{"desc":"边界条件 -> 预期结果; WHY: ...","type":"cli_blackbox"}],"adversarial":[{"desc":"对抗/失败时序 -> 预期结果; WHY: ...","type":"cli_blackbox"}]}',
        '',
        'Use browser_blackbox only for browser-visible UI interaction. Use testIntent:null only for truly non-automatable docs/config/process items.',
        '',
        'After updating, run:',
        `koala story_review '{"storyId":"${args.storyId}"}'`,
        '',
        'Report: split review result, per-item intent counts, skipped null-intent items and reasons.',
      ].join('\n');

      return {
        storyId: args.storyId,
        agent: 'test-intent',
        cwd: worktreeHint,
        summary: {
          totalItems: scopedItems.length,
          missingIntentItems: missingIntentItems.map((item) => item.id),
          existingIntentItems: existingIntentItems.map((item) => ({
            itemId: item.id,
            happy: laneCount(item, 'happy'),
            edge: laneCount(item, 'edge'),
            adversarial: laneCount(item, 'adversarial'),
          })),
          nullIntentItems: nullIntentItems.map((item) => item.id),
        },
        nextActions: [
          'Send prompt to the test-intent agent in the story worktree.',
          'Let that agent update checklist testIntent via koala checklist_update.',
          `Run koala story_review '{"storyId":"${args.storyId}"}' again.`,
        ],
        commandExamples: missingIntentItems.map((item) =>
          `koala checklist_update '{"storyId":"${args.storyId}","itemId":"${item.id}","testIntent":{"happy":[{"desc":"...","type":"cli_blackbox"}],"edge":[{"desc":"...","type":"cli_blackbox"}],"adversarial":[{"desc":"...","type":"cli_blackbox"}]},"agent":"test-intent"}'`
        ),
        prompt,
      };
    },
  };
}
