
import type { HandlerContext } from './context.js';
import type { BugRecord, BugEvidence } from '../core/types.js';
import { extractBugs } from '../tasks/bug-report.js';
import { computeProcessMetrics } from '../core/process-metrics.js';

export function createBugHandlers(ctx: HandlerContext) {
  const { store } = ctx;
  return {
    bug_report(args: {
      storyId: string;
      id: string;
      title: string;
      checklistId?: string;
      fixtureId?: string;
    }): string {
      const data = store.readBugs(args.storyId);
      if (data.bugs.find(b => b.id === args.id)) {
        throw new Error(`Bug ${args.id} already exists`);
      }
      const bug: BugRecord = {
        id: args.id,
        title: args.title,
        status: 'open',
        foundAt: new Date().toISOString(),
        fixedAt: null,
        ...(args.checklistId ? { checklistId: args.checklistId } : {}),
        ...(args.fixtureId ? { fixtureId: args.fixtureId } : {}),
      };
      data.bugs.push(bug);
      store.writeBugs(args.storyId, data);
      return `Bug ${args.id} reported` + (args.fixtureId ? ` (fixtureId: ${args.fixtureId})` : '');
    },

    async bug_update(args: {
      storyId: string;
      id: string;
      status: 'open' | 'fixed';
      evidence?: BugEvidence;
    }): Promise<string> {
      const data = store.readBugs(args.storyId);
      const bug = data.bugs.find(b => b.id === args.id);
      if (!bug) throw new Error(`Bug ${args.id} not found`);

      // 标记 fixed（验证走 koala validate，不在 bug_update 里自动跑）
      let resultMsg: string;
      if (args.status === 'fixed') {
        if (!args.evidence) {
          return `⚠ Bug ${args.id}: 标 fixed 时建议提供 evidence（symptom / rootCause / fixEvidence）。` +
            ` 用法: koala bug_update '{"storyId":"...","id":"...","status":"fixed","evidence":{"symptom":"...","reproSteps":["..."],"rootCause":"...","fixEvidence":"..."}}'`;
        }
        bug.status = 'fixed';
        bug.fixedAt = new Date().toISOString();
        bug.evidence = args.evidence;
        store.writeBugs(args.storyId, data);
        resultMsg = `Bug ${args.id} updated to fixed (✓ evidence recorded: rootCause="${args.evidence.rootCause}")`;
      } else {
        // B-aa48 CHK-002: detect reopen (was fixed, now open)
        const wasFixed = bug.status === 'fixed';
        bug.status = args.status;
        store.writeBugs(args.storyId, data);

        if (wasFixed && args.status === 'open') {
          try {
            store.appendProcessEvent(args.storyId, {
              type: 'bug_reopened',
              bugId: args.id,
            });
          } catch (e) {
            console.warn(`[process-events] append failed for ${args.storyId}:`, (e as Error).message);
          }
        }

        resultMsg = `Bug ${args.id} updated to ${args.status}`;
      }

      // B-abd8: auto-recompute process metrics (once, after either branch)
      try {
        const pm = computeProcessMetrics(args.storyId, store, ctx.root);
        store.writeProcessMetrics(args.storyId, pm);
      } catch (e) {
        console.warn(`[process-metrics] recompute failed for ${args.storyId}:`, (e as Error).message);
      }

      return resultMsg;
    },

    bug_list(args: { storyId: string }) {
      return store.readBugs(args.storyId);
    },

    bug_analyze(args?: { format?: 'json' | 'markdown' }) {
      const report = extractBugs(ctx.root);
      if (args?.format === 'markdown') {
        return { _dashboard: report.markdown, _hint: '请完整展示 Markdown 报告' };
      }
      return {
        _dashboard: report.markdown,
        _hint: '请将质量报告展示在最前面，Markdown 格式',
        summary: report.summary,
        bugs: report.bugs,
        storyMetrics: report.storyMetrics,
      };
    },
  };
}
