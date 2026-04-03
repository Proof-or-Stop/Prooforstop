
import type { HandlerContext } from './context.js';
import type { BugRecord } from '../../story/types.js';
import { extractBugs } from '../../tasks/bug-report.js';

export function createBugHandlers(ctx: HandlerContext) {
  const { store } = ctx;
  return {
    bug_report(args: {
      storyId: string;
      id: string;
      title: string;
      checklistId?: string;
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
      };
      data.bugs.push(bug);
      store.writeBugs(args.storyId, data);
      return `Bug ${args.id} reported` + (args.checklistId ? ` (linked to ${args.checklistId})` : '');
    },

    bug_update(args: {
      storyId: string;
      id: string;
      status: 'open' | 'fixed';
    }): string {
      const data = store.readBugs(args.storyId);
      const bug = data.bugs.find(b => b.id === args.id);
      if (!bug) throw new Error(`Bug ${args.id} not found`);
      bug.status = args.status;
      if (args.status === 'fixed') {
        bug.fixedAt = new Date().toISOString();
      }
      store.writeBugs(args.storyId, data);
      return `Bug ${args.id} updated to ${args.status}`;
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
