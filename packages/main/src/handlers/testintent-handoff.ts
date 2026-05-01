import type { HandlerContext } from './context.js';
import type { ChecklistItem } from '../core/types.js';
import { collectVerificationIntents } from '../core/verification.js';

function laneCount(item: ChecklistItem, lane: 'happy' | 'edge' | 'adversarial'): number {
  return item.verificationIntent?.[lane]?.length
    ?? (item.testIntent && item.testIntent !== null ? item.testIntent[lane]?.length ?? 0 : 0);
}

function itemNeedsIntent(item: ChecklistItem): boolean {
  if (item.testIntent === null) return false;
  return (item.verificationIntent?.happy?.length ?? 0) === 0
    && (!item.testIntent || !Array.isArray(item.testIntent.happy) || item.testIntent.happy.length === 0);
}

function compactChecklistItem(item: ChecklistItem) {
  return {
    id: item.id,
    title: item.title,
    context: item.context ?? '',
    phase: item.phase ?? 'DEV',
    status: item.status,
    verificationIntent: item.verificationIntent ?? undefined,
    legacyTestIntent: item.testIntent ?? undefined,
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
      const existingIntentItems = scopedItems.filter((item) => collectVerificationIntents(item).length > 0 || (item.testIntent && item.testIntent !== null));
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
        `Checklist items to review (${scopedItems.length}; missing verificationIntent.happy: ${missingList}):`,
        checklistJson,
        '',
        'For each testable item, write structured verificationIntent entries:',
        '{"happy":[{"desc":"操作/条件 -> 预期结果; WHY: 覆盖意图","type":"cli","priority":"must"}],"edge":[{"desc":"边界条件 -> 预期结果; WHY: ...","type":"cli","priority":"must"}],"adversarial":[{"desc":"对抗/失败时序 -> 预期结果; WHY: ...","type":"logic","priority":"must"}]}',
        '',
        'Use type=browser only for browser-visible UI interaction. Use verification evidence kind=waiver for truly non-automatable docs/config/process items; use waiverType=deferred_gate_evidence only for gate-self-test cases that cannot be verified until a later phase.',
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
          'Let that agent update checklist verificationIntent via koala checklist_update.',
          `Run koala story_review '{"storyId":"${args.storyId}"}' again.`,
        ],
        commandExamples: missingIntentItems.map((item) =>
          `koala checklist_update '{"storyId":"${args.storyId}","itemId":"${item.id}","verificationIntent":{"happy":[{"desc":"...","type":"cli","priority":"must"}],"edge":[{"desc":"...","type":"cli","priority":"must"}],"adversarial":[{"desc":"...","type":"logic","priority":"must"}]},"agent":"test-intent"}'`
        ),
        prompt,
      };
    },
  };
}
