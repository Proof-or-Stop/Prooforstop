
import type { HandlerContext } from './context.js';
import type { TestEvidenceData } from '../core/types.js';
import { currentMaterialHash } from '../core/evidence-freshness.js';
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
      // B-c622 CHK-009: Record headHash for DONE gate evidence freshness check
      let headHash = '';
      try {
        headHash = execSync('git rev-parse HEAD', { cwd: ctx.root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      } catch { /* Cannot get HEAD, skip */ }
      const materialHash = currentMaterialHash(ctx.root);
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
        ...(materialHash ? { materialHash } : {}),
      };
      store.writeTestEvidence(args.storyId, data);
      return `Test evidence updated (${args.result})`;
    },

    test_list(args: { storyId: string }): TestEvidenceData | { _empty: true; _mode: 'latest_snapshot'; _hint: string } | { _mode: 'latest_snapshot'; latest: TestEvidenceData; _hint: string } | null {
      const latest = store.readTestEvidence(args.storyId);
      if (!latest) {
        return {
          _empty: true,
          _mode: 'latest_snapshot',
          _hint: 'test_list currently returns the "last test evidence snapshot", not a historical list. There is no test evidence yet.',
        };
      }
      return {
        _mode: 'latest_snapshot',
        latest,
        _hint: 'test_list currently returns the "last test evidence snapshot", not a historical list. To view history, combine with test-runs / validate records to extend.',
      };
    },
  };
}
