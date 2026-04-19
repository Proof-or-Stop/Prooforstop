
import type { HandlerContext } from './context.js';
import type { TestEvidenceData } from '../core/types.js';
import { execSync } from 'child_process';

function readGitIdentity(cwd: string): { head: string | null; branch: string | null } {
  const read = (cmd: string): string | null => {
    try {
      const value = execSync(cmd, {
        cwd,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      return value || null;
    } catch { /* PROBE: manual evidence can be recorded from non-git roots */
      return null;
    }
  };
  return {
    head: read('git rev-parse HEAD'),
    branch: read('git rev-parse --abbrev-ref HEAD'),
  };
}

export function createTestHandlers(ctx: HandlerContext) {
  const { store, root } = ctx;
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
        git: readGitIdentity(root),
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
