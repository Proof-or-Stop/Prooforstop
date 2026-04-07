
import type { HandlerContext } from './context.js';
import type { TestEvidenceData } from '../core/types.js';

export function createTestHandlers(ctx: HandlerContext) {
  const { store } = ctx;
  return {
    test_add(args: {
      storyId: string;
      command: string;
      output: string;
      result: 'PASS' | 'FAIL';
    }): string {
      const data: TestEvidenceData = {
        command: args.command,
        output: args.output,
        result: args.result,
        timestamp: new Date().toISOString(),
        environment: {
          node: process.version,
          os: `${process.platform} ${process.arch}`,
        },
      };
      store.writeTestEvidence(args.storyId, data);
      return `Test evidence updated (${args.result})`;
    },

    test_list(args: { storyId: string }): TestEvidenceData | null {
      return store.readTestEvidence(args.storyId);
    },
  };
}
