
import { setup, createActor, type SnapshotFrom } from 'xstate';
import type { StoryStore } from './store.js';

export interface StoryMachineContext {
  storyId: string;
  store: StoryStore;
}

export const storyMachine = setup({
  types: {
    context: {} as StoryMachineContext,
    input: {} as StoryMachineContext,
    events: {} as
      | { type: 'PLAN' }
      | { type: 'START' }
      | { type: 'REVIEW' }
      | { type: 'FINISH' },
  },
  guards: {
    checklistAllDone: ({ context }) => {
      const cl = context.store.readChecklist(context.storyId);
      return cl.items.every(item => item.status === 'done');
    },
    hasTestEvidence: ({ context }) => {
      const evidence = context.store.readTestEvidence(context.storyId);
      return evidence.tests.length > 0 && evidence.tests.every(t => t.result === 'PASS');
    },
    allBugsFixed: ({ context }) => {
      const bugs = context.store.readBugs(context.storyId);
      return bugs.bugs.every(b => b.status === 'fixed');
    },
    canFinish: ({ context }) => {
      const evidence = context.store.readTestEvidence(context.storyId);
      const hasEvidence = evidence.tests.length > 0 && evidence.tests.every(t => t.result === 'PASS');
      const bugs = context.store.readBugs(context.storyId);
      const bugsOk = bugs.bugs.every(b => b.status === 'fixed');
      return hasEvidence && bugsOk;
    },
  },
}).createMachine({
  id: 'story',
  context: ({ input }: { input: StoryMachineContext }) => input,
  initial: 'IDEA',
  states: {
    IDEA: {
      on: {
        PLAN: { target: 'PLAN' },
      },
    },
    PLAN: {
      on: {
        START: { target: 'DEV' },
      },
    },
    DEV: {
      on: {
        REVIEW: {
          target: 'TEST',
          guard: 'checklistAllDone',
        },
      },
    },
    TEST: {
      on: {
        FINISH: {
          target: 'DONE',
          guard: 'canFinish',
        },
        START: {
          target: 'DEV',
        },
      },
    },
    DONE: {
      type: 'final',
    },
  },
});

export type StoryMachineSnapshot = SnapshotFrom<typeof storyMachine>;

export function createStoryActor(
  storyId: string,
  store: StoryStore,
  restoredState?: string,
) {
  const context: StoryMachineContext = { storyId, store };

  if (restoredState) {
    const snapshot = storyMachine.resolveState({
      value: restoredState,
      context,
    });
    return createActor(storyMachine, { snapshot, input: context });
  }

  return createActor(storyMachine, { input: context });
}

export function getStateName(actor: ReturnType<typeof createActor<typeof storyMachine>>): string {
  const snapshot = actor.getSnapshot();
  return typeof snapshot.value === 'string' ? snapshot.value : JSON.stringify(snapshot.value);
}

export function getGuardFailureReason(
  storyId: string,
  store: StoryStore,
  targetPhase: string,
): string | null {
  if (targetPhase === 'TEST') {
    const cl = store.readChecklist(storyId);
    const pending = cl.items.filter(i => i.status !== 'done');
    if (pending.length > 0) {
      return `Cannot enter TEST: ${pending.length} checklist item(s) not done: ${pending.map(i => i.id).join(', ')}`;
    }
  }

  if (targetPhase === 'DONE') {
    const evidence = store.readTestEvidence(storyId);
    if (evidence.tests.length === 0) {
      return 'Cannot enter DONE: no test evidence found';
    }
    const failedTests = evidence.tests.filter(t => t.result !== 'PASS');
    if (failedTests.length > 0) {
      return `Cannot enter DONE: ${failedTests.length} test(s) not PASS: ${failedTests.map(t => t.id).join(', ')}`;
    }
    const bugs = store.readBugs(storyId);
    const openBugs = bugs.bugs.filter(b => b.status !== 'fixed');
    if (openBugs.length > 0) {
      return `Cannot enter DONE: ${openBugs.length} unfixed bug(s): ${openBugs.map(b => b.id).join(', ')}`;
    }
  }

  return null;
}
