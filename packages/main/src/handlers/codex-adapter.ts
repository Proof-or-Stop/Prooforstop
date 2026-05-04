import { execSync } from 'node:child_process';
import type { HandlerContext } from './context.js';
import {
  renderCodexAdapterChecks,
  runCodexAdapterChecks,
} from '../core/codex-adapter-checks.js';

function detectStoryIdFromBranch(root: string): string | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return branch.startsWith('story/') ? branch.slice('story/'.length) : null;
  } catch {
    return null;
  }
}

export function createCodexAdapterHandlers(ctx: HandlerContext) {
  return {
    verify_codex(args: { json?: boolean; storyId?: string } = {}) {
      const storyId = args.storyId || detectStoryIdFromBranch(ctx.root) || undefined;
      const result = runCodexAdapterChecks(ctx.root, {
        executeHeartbeats: true,
        registryNames: ctx.getAllToolNames?.(),
        storyId,
        store: ctx.store,
      });
      if (storyId) {
        try {
          ctx.store.appendProcessEvent(storyId, {
            type: 'codex_adapter_verification',
            storyId,
            command: 'koala verify_codex',
            result: result.ok ? 'pass' : 'fail',
            summary: result.summary,
            failingChecks: result.checks
              .filter(check => check.hard && check.status === 'fail')
              .map(check => check.id),
          });
        } catch (e: any) {
          ctx.log?.(`[process-events] codex verification evidence append failed: ${e?.message || e}`);
        }
      }
      if (args.json) return result;
      const rendered = renderCodexAdapterChecks(result);
      if (!result.ok) throw new Error(rendered);
      return rendered;
    },
  };
}
