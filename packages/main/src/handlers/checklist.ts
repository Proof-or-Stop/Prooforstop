
import { existsSync } from 'fs';
import { join } from 'path';
import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import { execSync } from 'child_process';
import { checkEvidenceFreshnessForGit, currentMaterialHash } from '../core/evidence-freshness.js';
import type { ChecklistStatus, StoryInfo, VerificationEvidence, VerificationIntent } from '../core/types.js';
import { buildVerificationCoverage, makeEvidence } from '../core/verification.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { withMkdirLock } from '../core/mkdir-lock.js';
import { authorityModeEnabled } from '../core/authority-mode.js';
import { createAuthoritySubmitter, resolveAuthoritySettings } from '../core/authority-submit.js';

type VerificationEvidenceKindInput = VerificationEvidence['kind'] | 'cli' | 'logic';
type VerificationEvidenceInput = Omit<VerificationEvidence, 'kind'> & { kind: VerificationEvidenceKindInput };

/**
 * B-6812 CHK-001: delegates to the shared `withMkdirLock` primitive. Lock path
 * stays `<story>/checklist.lock`; external behavior is unchanged.
 */
function withChecklistLock<T>(ctx: HandlerContext, storyId: string, fn: () => T): T {
  const lockDir = ctx.store.storyFilePath(storyId, 'checklist.lock');
  return withMkdirLock(lockDir, fn, { label: 'checklist metadata' });
}

/**
 * B-45ed CHK-008: 给定 storyId，若 background.md 存在则返回相对路径，否则返回 null。
 */
function resolveBackgroundPath(root: string, store: HandlerContext['store'], storyId: string): string | null {
  const rel = `${store.storyDirRel()}/${storyId}/background.md`;
  const abs = join(root, rel);
  return existsSync(abs) ? rel : null;
}

function assertChecklistMutationCwd(store: HandlerContext['store'], storyId: string): StoryInfo {
  const story = store.readStory(storyId);
  assertCwdInWorktree(store, storyId);
  return story;
}

function evidenceHashes(root: string): { headHash?: string; materialHash?: string } {
  let headHash = '';
  try {
    headHash = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { /* PROBE: non-git or unavailable, omit freshness hash */ }
  const materialHash = currentMaterialHash(root);
  return {
    ...(headHash ? { headHash } : {}),
    ...(materialHash ? { materialHash } : {}),
  };
}

function normalizeEvidenceKind(kind: VerificationEvidenceKindInput): VerificationEvidence['kind'] {
  if (kind === 'cli') return 'manual_transcript';
  if (kind === 'logic') return 'logic_test';
  return kind;
}

function normalizeEvidence(root: string, input: VerificationEvidenceInput): VerificationEvidence {
  const hashes = evidenceHashes(root);
  const kind = normalizeEvidenceKind(input.kind);
  return makeEvidence({
    intentRef: input.intentRef,
    kind,
    ...(input.verdict ? { verdict: input.verdict } : {}),
    ...(input.waiverType ? { waiverType: input.waiverType } : {}),
    ...(input.file ? { file: input.file } : {}),
    ...(input.command ? { command: input.command } : {}),
    ...(input.result ? { result: input.result } : {}),
    note: input.note.trim(),
    headHash: input.headHash || hashes.headHash,
    materialHash: input.materialHash || hashes.materialHash,
    ...(input.attestation ? { attestation: input.attestation } : {}),
  });
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
      reason?: string;
    }): string {
      if (!args.title) throw new Error('title is required');

      // 验证 story 存在；进入 worktree 流程后，checklist 只能在 story worktree 写。
      const story = assertChecklistMutationCwd(store, args.storyId);
      if (story.phase === 'PLAN' && (!args.reason || args.reason.trim().length < 10)) {
        throw new Error('PLAN 阶段 checklist_add 必须提供 reason ≥ 10 字符，作为 replan/scope audit 信号，避免绕过 title/context 冻结');
      }

      return withChecklistLock(ctx, args.storyId, () => {
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

      if (story.phase === 'PLAN') {
        if (!cl.auditLog) cl.auditLog = [];
        cl.auditLog.push({
          timestamp: new Date().toISOString(),
          phase: story.phase,
          itemId: nextId,
          action: 'add',
          from: 'pending' as ChecklistStatus,
          to: 'pending' as ChecklistStatus,
          reason: args.reason!.trim(),
          addedTitle: args.title,
          addedContext: args.context || '',
        });
      }

      store.writeChecklist(args.storyId, cl);
      try {
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
      });
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

      return withChecklistLock(ctx, args.storyId, () => {
      const cl = store.readChecklist(args.storyId);
      const idx = cl.items.findIndex(i => i.id === args.itemId);
      if (idx === -1) throw new Error(`Checklist item ${args.itemId} not found`);

      const item = cl.items[idx];
      if (item.status === 'done') {
        throw new Error(`Cannot remove ${args.itemId}: already done. Re-open first if needed.`);
      }

      // 只有 INIT 阶段允许删除。INIT_CHECK 起 title/context 已冻结；
      // 若 PLAN 仍允许 remove+add，就等价于绕过 checklist_update 的冻结门禁。
      const story = assertChecklistMutationCwd(store, args.storyId);
      const allowedPhases = ['INIT'];
      if (!allowedPhases.includes(story.phase)) {
        throw new Error(`${story.phase} 阶段不允许删除 checklist item；INIT_CHECK 起 checklist title/context 冻结，避免 remove+add 绕过。需要新增范围只能 checklist_add，原 item 继续保留给 gate 审查`);
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
      });
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
      verificationEvidence?: VerificationEvidenceInput[];
      reason?: string;
      agent?: string;
      success?: boolean;
    }): string {
      if (!args.status && args.title === undefined && args.context === undefined && args.relatedDocs === undefined && args.userSees === undefined && args.files === undefined && args.verificationIntent === undefined && args.verificationEvidence === undefined) {
        throw new Error('At least one of status/title/context/relatedDocs/userSees/files/verificationIntent/verificationEvidence must be provided');
      }

      return withChecklistLock(ctx, args.storyId, () => {
      // Truth source protection: DEV 及之后阶段禁止修改 checklist 的根本信息
      // checklist 是真相源，执行者（主 agent / subagent）不能在执行过程中篡改需求定义
      //
      // B-9d95 CHK-008: userSees 从 title/context 的保护域拆出，单独分档
      //   - title/context 在 INIT_CHECK 起保护（PLAN 想改也拒，需 story_advance 回 INIT_CHECK）
      //   - userSees 是 PLAN 产物（见 CLAUDE.md checklist 写法），允许 PLAN 阶段补写/修改，
      //     DEV 起冻结（执行者不得在实现过程中篡改验收描述）
      const story = assertChecklistMutationCwd(store, args.storyId);
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
        item.verificationEvidence = args.verificationEvidence.map(ev => normalizeEvidence(root, ev));
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

      const commitHint = autoCommitStoryMetadata(root, args.storyId, 'checklist_update');

      // B-95d8 CHK-002: post-write reload reminder.
      // Re-read the FINAL persisted state (read-after-write) so a long session does
      // not keep trusting a stale pre-write snapshot (e.g. "still in_progress" when
      // the write already flipped it to done). The reminder goes to STDERR, never
      // stdout, following the B-6812 advisory-to-stderr precedent: stdout stays the
      // pure conclusion so `koala checklist_update | tail` pipelines are unaffected.
      try {
        const persisted = store.readChecklist(args.storyId).items.find(i => i.id === args.itemId);
        const persistedStatus = persisted ? persisted.status : '<unknown>';
        process.stderr.write(
          `↻ 已写入并确认持久化：${args.itemId} 当前 status=${persistedStatus}。` +
          `长会话请重新加载（koala checklist_get / session_brief）后再依赖快照。\n`,
        );
      } catch (e) {
        // Reminder is advisory only — a read-back failure must never change the
        // write result or the stdout conclusion.
        console.warn(`[checklist_update] post-write reload reminder skipped for ${args.storyId}: ${(e as Error).message}`);
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
          return `Checklist ${args.itemId}: ${results.join(', ')}\n\n📄 关联文档（请检查代码改动是否影响这些文档，趁记忆热及时同步）：\n${lines}${commitHint}`;
        }
      }

      return `Checklist ${args.itemId}: ${results.join(', ')}${commitHint}`;
      });
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
      return withChecklistLock(ctx, args.storyId, () => {
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
      });
    },

    verification_evidence_add(args: {
      storyId: string;
      itemId: string;
      intentRef: string;
      kind: VerificationEvidenceKindInput;
      verdict?: VerificationEvidence['verdict'];
      waiverType?: VerificationEvidence['waiverType'];
      file?: string;
      command?: string;
      result?: 'pass' | 'fail';
      note: string;
      attestation?: VerificationEvidence['attestation'];
      actorTrust?: VerificationEvidence['actorTrust'];
      factProvenance?: VerificationEvidence['factProvenance'];
    }): string | Promise<string> {
      // --- LOCAL PREFLIGHT (must run BEFORE any authority POST; A-prepost) -------
      // These guards are duplicated here at the handler entry (not Zod-only) per
      // CLAUDE.md Handler 编码约定. They MUST stay first so a local failure produces
      // ZERO authority POST and ZERO local write (Blockers 1+2).
      if (!args.note || args.note.trim().length < 5) {
        throw new Error('verification_evidence_add: note 必须 ≥ 5 字符，说明 evidence 为什么覆盖该 intent');
      }
      const kind = normalizeEvidenceKind(args.kind);
      if (args.waiverType && kind !== 'waiver') {
        throw new Error('verification_evidence_add: waiverType 只能用于 kind=waiver');
      }

      const settings = resolveAuthoritySettings(ctx.authoritySettings);

      // The local-write closure runs IDENTICALLY in every mode. In enforce it only
      // runs after a successful POST; in shadow it runs regardless of POST result;
      // in off it runs without any authority interaction at all.
      const writeLocal = (): { hashes: ReturnType<typeof evidenceHashes>; message: string } => {
        return withChecklistLock(ctx, args.storyId, () => {
          const cl = store.readChecklist(args.storyId);
          const item = cl.items.find(i => i.id === args.itemId);
          // itemId existence is part of the local preflight: when authority is enabled
          // the same check is re-run in the preflight pass below BEFORE the POST so an
          // unknown item never triggers a POST.
          if (!item) throw new Error(`Checklist item ${args.itemId} not found`);

          const hashes = evidenceHashes(root);

          const evidence = makeEvidence({
            intentRef: args.intentRef,
            kind,
            ...(args.verdict ? { verdict: args.verdict } : {}),
            ...(args.waiverType ? { waiverType: args.waiverType } : {}),
            ...(args.file ? { file: args.file } : {}),
            ...(args.command ? { command: args.command } : {}),
            ...(args.result ? { result: args.result } : {}),
            note: args.note.trim(),
            ...(args.attestation ? { attestation: args.attestation } : {}),
            ...(args.actorTrust ? { actorTrust: args.actorTrust } : {}),
            ...(args.factProvenance ? { factProvenance: args.factProvenance } : {}),
            ...hashes,
          });

          const existing = item.verificationEvidence || [];
          const idx = existing.findIndex(e => e.intentRef === args.intentRef);
          if (idx >= 0) existing[idx] = evidence;
          else existing.push(evidence);
          item.verificationEvidence = existing;

          store.writeChecklist(args.storyId, cl);
          const aliasNote = kind !== args.kind ? `, alias ${args.kind}` : '';
          const commitHint = autoCommitStoryMetadata(root, args.storyId, 'verification_evidence_add');
          return { hashes, message: `Verification evidence recorded for ${args.itemId} → ${args.intentRef} (${kind}${aliasNote})${commitHint}` };
        });
      };

      // off: byte-identical to post-B-2157 main — zero network, synchronous.
      if (!authorityModeEnabled(settings.mode)) {
        return writeLocal().message;
      }

      // shadow / enforce: run remaining local preflight (itemId existence) BEFORE the
      // POST so a local failure short-circuits with zero POST, then POST, then write.
      return withChecklistLock(ctx, args.storyId, () => {
        const cl = store.readChecklist(args.storyId);
        const item = cl.items.find(i => i.id === args.itemId);
        if (!item) throw new Error(`Checklist item ${args.itemId} not found`);
        return Promise.resolve();
      }).then(async () => {
        const hashes = evidenceHashes(root);
        const submitter = ctx.authoritySubmitter ?? createAuthoritySubmitter(settings);
        const decision = await submitter.submitSingle({
          storyId: args.storyId,
          itemId: args.itemId,
          intentRef: args.intentRef,
          kind,
          ...(args.command ? { command: args.command } : {}),
          note: args.note.trim(),
          ...(hashes.headHash ? { headHash: hashes.headHash } : {}),
          ...(hashes.materialHash ? { materialHash: hashes.materialHash } : {}),
        });
        if (!decision.proceed) {
          // enforce: authority failed -> throw, leaving ZERO local write (Blocker 4).
          throw decision.error ?? new Error('authority POST failed');
        }
        if (decision.warning) process.stderr.write(`${decision.warning}\n`);
        return writeLocal().message;
      });
    },

    verification_evidence_batch_add(args: {
      storyId: string;
      evidences: Array<{
        itemId: string;
        intentRef: string;
        kind: VerificationEvidenceKindInput;
        verdict?: VerificationEvidence['verdict'];
        waiverType?: VerificationEvidence['waiverType'];
        file?: string;
        command?: string;
        result?: 'pass' | 'fail';
        note: string;
        attestation?: VerificationEvidence['attestation'];
        actorTrust?: VerificationEvidence['actorTrust'];
        factProvenance?: VerificationEvidence['factProvenance'];
      }>;
    }): string | Promise<string> {
      if (!Array.isArray(args.evidences) || args.evidences.length === 0) {
        throw new Error('verification_evidence_batch_add: evidences 必须是非空数组');
      }

      const settings = resolveAuthoritySettings(ctx.authoritySettings);

      // --- LOCAL PREFLIGHT for ALL entries (A-prepost all-or-nothing) -----------
      // Validate every entry's note/waiver/kind FIRST. itemId existence is checked
      // against the on-disk checklist inside `runPreflight`. Any failure throws here
      // -> ZERO batch POST + ZERO local write (no partial tail). Re-validated (not
      // Zod-only) per CLAUDE.md Handler 编码约定.
      const normalizedKinds: VerificationEvidence['kind'][] = [];
      for (const entry of args.evidences) {
        if (!entry.note || entry.note.trim().length < 5) {
          throw new Error(`verification_evidence_batch_add: ${entry.itemId} → ${entry.intentRef} note 必须 ≥ 5 字符`);
        }
        const kind = normalizeEvidenceKind(entry.kind);
        if (entry.waiverType && kind !== 'waiver') {
          throw new Error(`verification_evidence_batch_add: ${entry.itemId} → ${entry.intentRef} waiverType 只能用于 kind=waiver`);
        }
        normalizedKinds.push(kind);
      }

      // Local write closure — runs once for the WHOLE batch (all-or-nothing). In
      // enforce it only runs after a fully-accepted batch POST; in shadow regardless;
      // in off without any POST.
      const writeLocalBatch = (): string => {
        return withChecklistLock(ctx, args.storyId, () => {
          const cl = store.readChecklist(args.storyId);
          const hashes = evidenceHashes(root);
          let written = 0;
          args.evidences.forEach((entry, i) => {
            const kind = normalizedKinds[i];
            const item = cl.items.find(it => it.id === entry.itemId);
            if (!item) throw new Error(`Checklist item ${entry.itemId} not found`);
            const evidence = makeEvidence({
              intentRef: entry.intentRef,
              kind,
              ...(entry.verdict ? { verdict: entry.verdict } : {}),
              ...(entry.waiverType ? { waiverType: entry.waiverType } : {}),
              ...(entry.file ? { file: entry.file } : {}),
              ...(entry.command ? { command: entry.command } : {}),
              ...(entry.result ? { result: entry.result } : {}),
              note: entry.note.trim(),
              ...(entry.attestation ? { attestation: entry.attestation } : {}),
              ...(entry.actorTrust ? { actorTrust: entry.actorTrust } : {}),
              ...(entry.factProvenance ? { factProvenance: entry.factProvenance } : {}),
              ...hashes,
            });
            const existing = item.verificationEvidence || [];
            const idx = existing.findIndex(e => e.intentRef === entry.intentRef);
            if (idx >= 0) existing[idx] = evidence;
            else existing.push(evidence);
            item.verificationEvidence = existing;
            written++;
          });
          store.writeChecklist(args.storyId, cl);
          const commitHint = autoCommitStoryMetadata(root, args.storyId, 'verification_evidence_batch_add');
          return `Verification evidence batch recorded for ${args.storyId}: ${written} item intent(s)${commitHint}`;
        });
      };

      // Re-run the on-disk itemId-existence preflight for every entry. When authority
      // is enabled this MUST happen BEFORE the batch POST so an unknown item in any
      // entry yields zero POST + zero local write.
      const assertAllItemsExist = (): void => {
        withChecklistLock(ctx, args.storyId, () => {
          const cl = store.readChecklist(args.storyId);
          for (const entry of args.evidences) {
            if (!cl.items.some(it => it.id === entry.itemId)) {
              throw new Error(`Checklist item ${entry.itemId} not found`);
            }
          }
        });
      };

      // off: byte-identical to post-B-2157 main — zero network, synchronous.
      if (!authorityModeEnabled(settings.mode)) {
        assertAllItemsExist();
        return writeLocalBatch();
      }

      // shadow / enforce: preflight items -> single batch POST -> write all on accept.
      assertAllItemsExist();
      return (async () => {
        const hashes = evidenceHashes(root);
        const submitter = ctx.authoritySubmitter ?? createAuthoritySubmitter(settings);
        const decision = await submitter.submitBatch(
          args.evidences.map((entry, i) => ({
            storyId: args.storyId,
            itemId: entry.itemId,
            intentRef: entry.intentRef,
            kind: normalizedKinds[i],
            ...(entry.command ? { command: entry.command } : {}),
            note: entry.note.trim(),
            ...(hashes.headHash ? { headHash: hashes.headHash } : {}),
            ...(hashes.materialHash ? { materialHash: hashes.materialHash } : {}),
          })),
        );
        if (!decision.proceed) {
          // enforce: whole-batch authority failure -> throw, ZERO local writes (Blocker 4).
          throw decision.error ?? new Error('authority batch POST failed');
        }
        if (decision.warning) process.stderr.write(`${decision.warning}\n`);
        return writeLocalBatch();
      })();
    },

    verification_evidence_refresh_stale(args: {
      storyId: string;
      dryRun?: boolean;
    }): string {
      return withChecklistLock(ctx, args.storyId, () => {
      const cl = store.readChecklist(args.storyId);
      let headHash = '';
      try {
        headHash = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      } catch {
        throw new Error('verification_evidence_refresh_stale: 当前目录无法读取 git HEAD，不能刷新 freshness');
      }
      const materialHash = currentMaterialHash(root);
      const coverage = buildVerificationCoverage(
        cl,
        headHash,
        (oldHeadHash, evidence) => checkEvidenceFreshnessForGit(root, oldHeadHash, evidence?.materialHash).fresh,
        { deferredGateEvidence: 'missing' },
      );
      const stale = coverage.entries.filter(e => e.status === 'stale' && e.evidence);
      if (stale.length === 0) {
        return `No stale verification evidence for ${args.storyId}`;
      }

      const lines = [
        `${args.dryRun ? '[DRY-RUN] ' : ''}Stale verification evidence for ${args.storyId}: ${stale.length}`,
      ];
      let refreshed = 0;
      for (const entry of stale) {
        const item = cl.items.find(i => i.id === entry.itemId);
        const existing = item?.verificationEvidence || [];
        const idx = existing.findIndex(e => e.intentRef === entry.intentRef);
        const ev = idx >= 0 ? existing[idx] : entry.evidence;
        lines.push(`  - ${entry.intentRef}: ${ev?.command || ev?.file || ev?.kind || 'evidence'} → ${headHash.slice(0, 7)}`);
        if (args.dryRun || !item || idx < 0 || !ev) continue;
        existing[idx] = makeEvidence({
          intentRef: ev.intentRef,
          kind: ev.kind,
          ...(ev.verdict ? { verdict: ev.verdict } : {}),
          ...(ev.waiverType ? { waiverType: ev.waiverType } : {}),
          ...(ev.file ? { file: ev.file } : {}),
          ...(ev.command ? { command: ev.command } : {}),
          ...(ev.result ? { result: ev.result } : {}),
          note: ev.note,
          headHash,
          ...(materialHash ? { materialHash } : {}),
          ...(ev.attestation ? { attestation: ev.attestation } : {}),
          ...(ev.actorTrust ? { actorTrust: ev.actorTrust } : {}),
          ...(ev.factProvenance ? { factProvenance: ev.factProvenance } : {}),
        });
        item.verificationEvidence = existing;
        refreshed++;
      }

      if (!args.dryRun) store.writeChecklist(args.storyId, cl);
      lines.push(args.dryRun
        ? '→ 重跑上述 command 后去掉 dryRun 刷新 evidence metadata'
        : `Refreshed ${refreshed}/${stale.length} stale evidence item(s). Re-run koala validate --story=${args.storyId} --json`);
      if (!args.dryRun) {
        const commitHint = autoCommitStoryMetadata(root, args.storyId, 'verification_evidence_refresh_stale');
        if (commitHint) lines.push(commitHint.replace(/^\n/, ''));
      }
      return lines.join('\n');
      });
    },


  };
}
