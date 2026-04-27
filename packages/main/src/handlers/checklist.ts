
import { existsSync } from 'fs';
import { join } from 'path';
import type { HandlerContext } from './context.js';
import { execSync } from 'child_process';
import type { VerificationEvidence, VerificationIntent } from '../core/types.js';
import { makeEvidence } from '../core/verification.js';

/**
 * B-45ed CHK-008: 给定 storyId，若 background.md 存在则返回相对路径，否则返回 null。
 */
function resolveBackgroundPath(root: string, store: HandlerContext['store'], storyId: string): string | null {
  const rel = `${store.storyDirRel()}/${storyId}/background.md`;
  const abs = join(root, rel);
  return existsSync(abs) ? rel : null;
}

export function createChecklistHandlers(ctx: HandlerContext) {
  const { store, root } = ctx;
  return {
    checklist_get(args: { storyId: string }) {
      return store.readChecklist(args.storyId);
    },

    checklist_add(args: {
      storyId: string;
      title: string;
      context?: string;
      relatedDocs?: string[];
      userSees?: string;
      excludes?: string[];
      files?: { modify: string[]; create: string[]; test: string[] };
      verificationIntent?: VerificationIntent;
    }): string {
      if (!args.title) throw new Error('title is required');

      // 验证 story 存在
      store.readStory(args.storyId);

      const cl = store.readChecklist(args.storyId);

      // 从已有 item 中找最大 CHK 编号，分配下一个
      let maxNum = 0;
      for (const item of cl.items) {
        const m = item.id.match(/^CHK-(\d+)$/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n > maxNum) maxNum = n;
        }
      }
      const nextId = `CHK-${String(maxNum + 1).padStart(3, '0')}`;

      // B-45ed CHK-008: 当 relatedDocs 未提供 / 为空数组时，自动注入 background.md 路径（若文件存在）。
      // 若调用方已显式提供 relatedDocs 且非空，尊重其选择，不自动插入。
      let effectiveRelatedDocs: string[] | undefined = args.relatedDocs;
      if (!effectiveRelatedDocs || effectiveRelatedDocs.length === 0) {
        const bgRel = resolveBackgroundPath(root, store, args.storyId);
        if (bgRel) {
          effectiveRelatedDocs = [bgRel];
        } else if (args.relatedDocs !== undefined) {
          // 用户显式传了空数组且 background.md 不存在 → 保持空数组
          effectiveRelatedDocs = args.relatedDocs;
        } else {
          // 未传 && 无 background → 不写 relatedDocs 字段
          effectiveRelatedDocs = undefined;
        }
      }

      cl.items.push({
        id: nextId,
        title: args.title,
        context: args.context,
        ...(effectiveRelatedDocs !== undefined ? { relatedDocs: effectiveRelatedDocs } : {}),
        ...(args.userSees ? { userSees: args.userSees } : {}),
        ...(args.excludes !== undefined ? { excludes: args.excludes } : {}),
        ...(args.files !== undefined ? { files: {
          modify: args.files.modify ?? [],
          create: args.files.create ?? [],
          test: args.files.test ?? [],
        } } : {}),
        ...(args.verificationIntent !== undefined ? { verificationIntent: args.verificationIntent } : {}),
        status: 'pending',
        startTime: null,
        endTime: null,
      });

      store.writeChecklist(args.storyId, cl);
      try {
        const story = store.readStory(args.storyId);
        store.appendProcessEvent(args.storyId, {
          type: 'plan_updated',
          action: 'add',
          itemId: nextId,
          phase: story.phase,
        });
      } catch (e) {
        console.warn(`[process-events] append failed for ${args.storyId}:`, (e as Error).message);
      }
      return `Checklist item ${nextId} added to ${args.storyId}`;
    },

    checklist_remove(args: {
      storyId: string;
      itemId: string;
      disposition: 'accept' | 'reject' | 'partial';
      justification: string;
    }): string {
      // 必须给出裁决理由
      if (!args.justification || args.justification.trim().length < 10) {
        throw new Error('justification 必须 ≥ 10 字符，说明为什么要删除这条 checklist item');
      }
      const validDispositions = ['accept', 'reject', 'partial'];
      if (!validDispositions.includes(args.disposition)) {
        throw new Error(`disposition 必须是 accept/reject/partial 之一，收到: ${args.disposition}`);
      }

      const cl = store.readChecklist(args.storyId);
      const idx = cl.items.findIndex(i => i.id === args.itemId);
      if (idx === -1) throw new Error(`Checklist item ${args.itemId} not found`);

      const item = cl.items[idx];
      if (item.status === 'done') {
        throw new Error(`Cannot remove ${args.itemId}: already done. Re-open first if needed.`);
      }

      // 只有 INIT 和 PLAN 阶段允许删除，之后只能加不能删
      const story = store.readStory(args.storyId);
      const allowedPhases = ['INIT', 'PLAN'];
      if (!allowedPhases.includes(story.phase)) {
        throw new Error(`${story.phase} 阶段不允许删除 checklist item，只能 checklist_add 新增`);
      }

      const removed = cl.items.splice(idx, 1)[0];

      // 审计日志：记录完整的被删 item 信息 + 裁决，自动写入
      if (!cl.auditLog) cl.auditLog = [];
      cl.auditLog.push({
        timestamp: new Date().toISOString(),
        phase: story.phase,
        itemId: args.itemId,
        action: 'delete',
        from: removed.status,
        to: 'pending' as const,
        reason: args.justification.trim(),
        removedTitle: removed.title,
        removedContext: removed.context || '',
        removedUserSees: removed.userSees || '',
        disposition: args.disposition,
        justification: args.justification.trim(),
        disposedAt: new Date().toISOString(),
      });

      store.writeChecklist(args.storyId, cl);
      try {
        store.appendProcessEvent(args.storyId, {
          type: 'plan_updated',
          action: 'remove',
          itemId: args.itemId,
          phase: story.phase,
        });
      } catch (e) {
        console.warn(`[process-events] append failed for ${args.storyId}:`, (e as Error).message);
      }
      return `Checklist item ${args.itemId} ("${removed.title}") removed from ${args.storyId}\n` +
        `  disposition: ${args.disposition}\n` +
        `  justification: ${args.justification.trim()}\n` +
        `⚠ scope 变更已记录，story_review 会展示此删除供 reviewer 审查`;
    },

    checklist_update(args: {
      storyId: string;
      itemId: string;
      status?: 'pending' | 'in_progress' | 'done';
      title?: string;
      context?: string;
      relatedDocs?: string[];
      userSees?: string;
      files?: { modify: string[]; create: string[]; test: string[] };
      verificationIntent?: VerificationIntent;
      verificationEvidence?: VerificationEvidence[];
      reason?: string;
      agent?: string;
      success?: boolean;
    }): string {
      if (!args.status && args.title === undefined && args.context === undefined && args.relatedDocs === undefined && args.userSees === undefined && args.files === undefined && args.verificationIntent === undefined && args.verificationEvidence === undefined) {
        throw new Error('At least one of status/title/context/relatedDocs/userSees/files/verificationIntent/verificationEvidence must be provided');
      }

      // Truth source protection: DEV 及之后阶段禁止修改 checklist 的根本信息
      // checklist 是真相源，执行者（主 agent / subagent）不能在执行过程中篡改需求定义
      //
      // B-9d95 CHK-008: userSees 从 title/context 的保护域拆出，单独分档
      //   - title/context 在 INIT_CHECK 起保护（PLAN 想改也拒，需 story_advance 回 INIT_CHECK）
      //   - userSees 是 PLAN 产物（见 CLAUDE.md checklist 写法），允许 PLAN 阶段补写/修改，
      //     DEV 起冻结（执行者不得在实现过程中篡改验收描述）
      const story = store.readStory(args.storyId);
      const titleContextFields = ['title', 'context'] as const;
      const titleContextProtectedPhases = ['INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE'];
      const userSeesProtectedPhases = ['DEV', 'REVIEW', 'TEST', 'DONE'];
      const verificationIntentProtectedPhases = ['DEV', 'REVIEW', 'TEST', 'DONE'];

      const attemptedTitleContext = titleContextFields.filter(f => args[f] !== undefined);
      if (attemptedTitleContext.length > 0 && titleContextProtectedPhases.includes(story.phase)) {
        throw new Error(
          `${args.itemId} 的 ${attemptedTitleContext.join('/')} 在 ${story.phase} 阶段不可修改。` +
          `checklist 是真相源，INIT_CHECK 起执行者不得篡改需求定义。` +
          `如需变更标题/上下文，先 story_advance 回 INIT_CHECK`
        );
      }

      if (args.userSees !== undefined && userSeesProtectedPhases.includes(story.phase)) {
        throw new Error(
          `${args.itemId} 的 userSees 在 ${story.phase} 阶段不可修改。` +
          `userSees 冻结于 PLAN 末尾，DEV 起执行者不得改验收描述。` +
          `如需调整走 finding_add 申请回 PLAN`
        );
      }
      if (args.verificationIntent !== undefined && verificationIntentProtectedPhases.includes(story.phase)) {
        throw new Error(
          `${args.itemId} 的 verificationIntent 在 ${story.phase} 阶段不可修改。` +
          `verificationIntent 是 PLAN 阶段的测试意图真相源；DEV 之后只能追加 verificationEvidence 或由 finding 申请回 PLAN。`
        );
      }

      const cl = store.readChecklist(args.storyId);
      const item = cl.items.find(i => i.id === args.itemId);
      if (!item) throw new Error(`Checklist item ${args.itemId} not found`);

      const results: string[] = [];
      const now = new Date().toISOString();
      const oldStatus = item.status;

      if (args.title !== undefined) {
        item.title = args.title;
        results.push(`title updated`);
      }
      if (args.context !== undefined) {
        item.context = args.context;
        results.push(`context updated`);
      }
      if (args.relatedDocs !== undefined) {
        item.relatedDocs = args.relatedDocs;
        results.push(`relatedDocs updated (${args.relatedDocs.length})`);
      }
      if (args.userSees !== undefined) {
        item.userSees = args.userSees;
        results.push(`userSees updated`);
      }
      if (args.files !== undefined) {
        item.files = {
          modify: args.files.modify ?? [],
          create: args.files.create ?? [],
          test: args.files.test ?? [],
        };
        results.push(`files updated (modify:${item.files.modify.length} create:${item.files.create.length} test:${item.files.test.length})`);
      }
      if (args.verificationIntent !== undefined) {
        item.verificationIntent = args.verificationIntent;
        results.push(`verificationIntent updated`);
      }
      if (args.verificationEvidence !== undefined) {
        item.verificationEvidence = args.verificationEvidence;
        results.push(`verificationEvidence updated (${args.verificationEvidence.length})`);
      }

      if (args.status) {
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
        results.push(`status → ${args.status}`);
      }

      store.writeChecklist(args.storyId, cl);

      // B-3511: append process events on status transitions
      if (args.status && oldStatus !== args.status) {
        try {
          if (args.status === 'in_progress') {
            store.appendProcessEvent(args.storyId, {
              type: 'dispatch',
              checklistId: args.itemId,
              ...(args.agent ? { agent: args.agent } : {}),
            });
          } else if (args.status === 'done') {
            store.appendProcessEvent(args.storyId, {
              type: 'subagent_result',
              checklistId: args.itemId,
              success: args.success !== false,
            });
          }
        } catch (e) {
          console.warn(`[process-events] append failed for ${args.storyId}:`, (e as Error).message);
        }
      }

      // CHK-003: pending/in_progress → done 且 item 有 relatedDocs 时，hint 关联文档清单
      // B-45ed CHK-008: done hint 列表统一包含 background.md（若存在且不在 item.relatedDocs 内），保证下游同步对齐
      const transitionedToDone = args.status === 'done' && oldStatus !== 'done';
      if (transitionedToDone) {
        const docsList: string[] = [];
        if (Array.isArray(item.relatedDocs)) {
          for (const d of item.relatedDocs) docsList.push(d);
        }
        const bgRel = resolveBackgroundPath(root, store, args.storyId);
        if (bgRel && !docsList.includes(bgRel)) {
          docsList.push(bgRel);
        }
        if (docsList.length > 0) {
          const lines = docsList.map(d => `  - ${d}`).join('\n');
          return `Checklist ${args.itemId}: ${results.join(', ')}\n\n📄 关联文档（请检查代码改动是否影响这些文档，趁记忆热及时同步）：\n${lines}`;
        }
      }

      return `Checklist ${args.itemId}: ${results.join(', ')}`;
    },

    light_review(args: {
      storyId: string;
      checklistIds: string[];
      note?: string;
    }): string {
      if (!args.storyId) throw new Error('storyId is required');
      if (!Array.isArray(args.checklistIds) || args.checklistIds.length === 0) {
        throw new Error('checklistIds must be a non-empty array');
      }

      // Validate story exists
      store.readStory(args.storyId);

      // Validate checklist item IDs exist
      const cl = store.readChecklist(args.storyId);
      const validIds = new Set(cl.items.map(i => i.id));
      for (const id of args.checklistIds) {
        if (!validIds.has(id)) throw new Error(`Checklist item ${id} not found in ${args.storyId}`);
      }

      // Deduplicate checklistIds
      const uniqueIds = [...new Set(args.checklistIds)];

      // Append process event
      store.appendProcessEvent(args.storyId, {
        type: 'light_review',
        checklistIds: uniqueIds,
        ...(args.note ? { note: args.note } : {}),
      });

      const ids = uniqueIds.join(', ');
      return `Light review recorded for ${args.storyId} (items: ${ids})`;
    },

    verification_evidence_add(args: {
      storyId: string;
      itemId: string;
      intentRef: string;
      kind: VerificationEvidence['kind'];
      file?: string;
      command?: string;
      result?: 'pass' | 'fail';
      note: string;
    }): string {
      if (!args.note || args.note.trim().length < 5) {
        throw new Error('verification_evidence_add: note 必须 ≥ 5 字符，说明 evidence 为什么覆盖该 intent');
      }
      const cl = store.readChecklist(args.storyId);
      const item = cl.items.find(i => i.id === args.itemId);
      if (!item) throw new Error(`Checklist item ${args.itemId} not found`);

      let headHash = '';
      try {
        headHash = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      } catch { /* non-git or unavailable, omit freshness hash */ }

      const evidence = makeEvidence({
        intentRef: args.intentRef,
        kind: args.kind,
        ...(args.file ? { file: args.file } : {}),
        ...(args.command ? { command: args.command } : {}),
        ...(args.result ? { result: args.result } : {}),
        note: args.note.trim(),
        ...(headHash ? { headHash } : {}),
      });

      const existing = item.verificationEvidence || [];
      const idx = existing.findIndex(e => e.intentRef === args.intentRef);
      if (idx >= 0) existing[idx] = evidence;
      else existing.push(evidence);
      item.verificationEvidence = existing;

      store.writeChecklist(args.storyId, cl);
      return `Verification evidence recorded for ${args.itemId} → ${args.intentRef} (${args.kind})`;
    },


  };
}
