
import type { HandlerContext } from './context.js';

export function createChecklistHandlers(ctx: HandlerContext) {
  const { store } = ctx;
  return {
    checklist_get(args: { storyId: string }) {
      return store.readChecklist(args.storyId);
    },

    checklist_update(args: {
      storyId: string;
      itemId: string;
      status: 'pending' | 'in_progress' | 'done';
      reason?: string;
      agent?: string;
    }): string {
      const cl = store.readChecklist(args.storyId);
      const item = cl.items.find(i => i.id === args.itemId);
      if (!item) throw new Error(`Checklist item ${args.itemId} not found`);

      const now = new Date().toISOString();
      const oldStatus = item.status;
      item.status = args.status;
      if (args.status === 'in_progress' && !item.startTime) {
        item.startTime = now;
      }
      if (args.status === 'done') {
        item.endTime = now;
      }

      // 修改操作写审计日志（新建 pending→pending 不算修改）
      if (oldStatus !== args.status && args.reason) {
        const story = store.readStory(args.storyId);
        if (!cl.auditLog) cl.auditLog = [];
        cl.auditLog.push({
          timestamp: now,
          phase: story.phase,
          itemId: args.itemId,
          action: 'update',
          from: oldStatus,
          to: args.status,
          reason: args.reason,
          ...(args.agent ? { agent: args.agent } : {}),
        });
      }

      store.writeChecklist(args.storyId, cl);
      return `Checklist ${args.itemId} updated to ${args.status}`;
    },
  };
}
