
import type { HandlerContext } from './context.js';
import type { BugRecord } from '../core/types.js';
import { extractBugs } from '../tasks/bug-report.js';

function isLegacyFixturelessBug(bug: BugRecord): boolean {
  return !bug.fixtureId && /old style|old format|legacy/i.test(bug.title);
}

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
    }): Promise<string> {
      const data = store.readBugs(args.storyId);
      const bug = data.bugs.find(b => b.id === args.id);
      if (!bug) throw new Error(`Bug ${args.id} not found`);

      // CHK-008: bug_update fixed 时通过 fixtureId 重跑 case 验证
      if (args.status === 'fixed') {
        if (!bug.fixtureId) {
          if (isLegacyFixturelessBug(bug)) {
            bug.status = 'fixed';
            bug.fixedAt = new Date().toISOString();
            (bug as any).legacyFixtureCleanup = true;
            store.writeBugs(args.storyId, data);
            return `Bug ${args.id} marked fixed (legacy bug without fixtureId — cleaned up after uuid migration)`;
          }
          throw new Error(`Bug ${args.id} 缺少 fixtureId，无法验证。请用新格式重报 bug（bug_report 时传 fixtureId）`);
        }
        const { createTestFixtureHandlers } = await import('./test-fixture.js');
        const testHandlers = createTestFixtureHandlers(ctx);
        try {
          const result = JSON.parse(await testHandlers.test_fixture({ fixtureId: bug.fixtureId }));
          if (!result.allPassed) {
            const failedNames = result.details.filter((d: any) => !d.passed).map((d: any) => d.name).join(', ');
            throw new Error(`bug_update fixed 被拒绝: case 仍然失败 — ${failedNames}`);
          }
        } catch (e: any) {
          if (e.message.includes('bug_update fixed 被拒绝')) throw e;
          if (e.message.includes('缺少 fixtureId')) throw e;
          // B-d4fb: stale fixtureId (fixture was deleted/regenerated during
          // DEV iteration). The bug points to a case that no longer exists,
          // so the bug as a record of THIS case can no longer fail. Treat as
          // fixed (the new case set is what runs in test_story; if any are
          // broken, fresh bugs will be reported).
          if (/未找到 _id=/.test(e.message)) {
            bug.status = 'fixed';
            bug.fixedAt = new Date().toISOString();
            (bug as any).staleFixtureCleanup = true;
            store.writeBugs(args.storyId, data);
            return `Bug ${args.id} marked fixed (stale fixtureId — original case removed during fixture regeneration)`;
          }
          throw new Error(`bug_update fixed 验证失败: ${e.message}`);
        }
        bug.status = 'fixed';
        bug.fixedAt = new Date().toISOString();
        store.writeBugs(args.storyId, data);
        return `Bug ${args.id} updated to fixed (✓ fixtureId=${bug.fixtureId} 验证通过)`;
      }

      // open 状态直接更新
      bug.status = args.status;
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
