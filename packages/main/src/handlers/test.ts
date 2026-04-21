
import type { HandlerContext } from './context.js';
import type { TestEvidenceData } from '../core/types.js';
import { execSync } from 'child_process';

export function createTestHandlers(ctx: HandlerContext) {
  const { store } = ctx;
  return {
    test_add(args: {
      storyId: string;
      command: string;
      output: string;
      result: 'PASS' | 'FAIL';
    }): string {
      // B-c622 CHK-009: 记录 headHash 供 DONE gate evidence freshness 检查
      let headHash = '';
      try {
        headHash = execSync('git rev-parse HEAD', { cwd: ctx.root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      } catch { /* 无法获取 HEAD，跳过 */ }
      const data: TestEvidenceData = {
        command: args.command,
        output: args.output,
        result: args.result,
        timestamp: new Date().toISOString(),
        environment: {
          node: process.version,
          os: `${process.platform} ${process.arch}`,
        },
        ...(headHash ? { headHash } : {}),
      };
      store.writeTestEvidence(args.storyId, data);
      return `Test evidence updated (${args.result})`;
    },

    test_list(args: { storyId: string }): TestEvidenceData | null {
      return store.readTestEvidence(args.storyId);
    },
  };
}
