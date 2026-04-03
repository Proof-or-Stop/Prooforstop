
import type { HandlerContext } from './context.js';
import type { TestEvidenceEntry, TestEvidenceData } from '../../story/types.js';

export function createTestHandlers(ctx: HandlerContext) {
  const { store } = ctx;
  return {
    test_add(args: {
      storyId: string;
      id: string;
      scenario: string;
      command: string;
      output: string;
      expected: string;
      result: 'PASS' | 'FAIL';
    }): string {
      const data = store.readTestEvidence(args.storyId);
      if (data.tests.find(t => t.id === args.id)) {
        throw new Error(`Test evidence ${args.id} already exists`);
      }
      if (!data.environment) {
        data.environment = {
          node: process.version,
          os: `${process.platform} ${process.arch}`,
          timestamp: new Date().toISOString(),
        };
      }
      const entry: TestEvidenceEntry = {
        id: args.id,
        scenario: args.scenario,
        command: args.command,
        output: args.output,
        expected: args.expected,
        result: args.result,
        timestamp: new Date().toISOString(),
      };
      data.tests.push(entry);
      store.writeTestEvidence(args.storyId, data);
      return `Test evidence ${args.id} added (${args.result})`;
    },

    test_list(args: { storyId: string }): TestEvidenceData {
      return store.readTestEvidence(args.storyId);
    },
  };
}
