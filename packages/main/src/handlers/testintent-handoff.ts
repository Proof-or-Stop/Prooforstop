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
        `You are the proof-or-stop-verification-intent agent for Proof-or-Stop story ${args.storyId}.`,
        '',
        'Follow the repository proof-or-stop-verification-intent agent contract:',
        '- First review checklist split quality against the story description.',
        '- If the split is wrong, report concrete checklist changes and stop.',
        '- If the split is acceptable, write verificationIntent for each testable item via proof-or-stop checklist_update.',
        '- Run or inspect the repository-wide baseline before freezing any repository-scoped acceptance.',
        '- Priority follows the behavior and risk being tested, not the happy/edge/adversarial lane. Do not mechanically assign one priority per lane.',
        '- Keep Story-focused behavior as scope=focused, expectation=absolute_pass, requirementSource=story; make it must when the Story actually requires that behavior.',
        '- A repository-wide command with a pre-existing or environmental failure must use priority=should, expectation=no_new_regressions, requirementSource=repository_health, and a baselineRef pointing to the inspected pre-change run; never turn repository health into a must.',
        '- An absolute repository-wide must is allowed only when the user/task or official verifier explicitly requires it; record requirementSource=external_verifier and a requirementRef to that source.',
        '- Main agent must not write verificationIntent; you own this handoff.',
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
        '{"happy":[{"desc":"focused action/condition -> expected result; WHY: coverage intent","type":"cli","priority":"must","scope":"focused","expectation":"absolute_pass","requirementSource":"story"}],"edge":[{"desc":"focused boundary condition -> expected result; WHY: ...","type":"cli","priority":"must","scope":"focused","expectation":"absolute_pass","requirementSource":"story"}],"adversarial":[{"desc":"focused failure timing -> expected result; WHY: ...","type":"logic","priority":"must","scope":"focused","expectation":"absolute_pass","requirementSource":"story"}]}',
        '',
        'Use type=browser only for browser-visible UI interaction. Use verification evidence kind=waiver for truly non-automatable docs/config/process items; use waiverType=deferred_gate_evidence only for gate-self-test cases that cannot be verified until a later phase.',
        '',
        'After updating, run:',
        `proof-or-stop story_review '{"storyId":"${args.storyId}"}'`,
        '',
        'Report: split review result, per-item intent counts, skipped null-intent items and reasons.',
      ].join('\n');

      return {
        storyId: args.storyId,
        agent: 'proof-or-stop-verification-intent',
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
          'Send prompt to the proof-or-stop-verification-intent agent in the story worktree.',
          'Let that agent update checklist verificationIntent via proof-or-stop checklist_update.',
          `Run proof-or-stop story_review '{"storyId":"${args.storyId}"}' again.`,
        ],
        commandExamples: missingIntentItems.map((item) =>
          `proof-or-stop checklist_update '{"storyId":"${args.storyId}","itemId":"${item.id}","verificationIntent":{"happy":[{"desc":"...","type":"cli","priority":"must","scope":"focused","expectation":"absolute_pass","requirementSource":"story"}],"edge":[{"desc":"...","type":"cli","priority":"must","scope":"focused","expectation":"absolute_pass","requirementSource":"story"}],"adversarial":[{"desc":"...","type":"logic","priority":"must","scope":"focused","expectation":"absolute_pass","requirementSource":"story"}]},"agent":"proof-or-stop-verification-intent"}'`
        ),
        prompt,
      };
    },
  };
}
