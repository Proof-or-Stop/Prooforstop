/**
 * Init Check handler — koala init_check_set command shell + metadata lock.
 *
 * The signature/gate primitives (INIT_CHECK_SALT, REQUIRED_INIT_CHECK_AGENTS,
 * normalize/match/results helpers, missingRequiredInitCheckAgents,
 * blockingInitCheckIssues, computeBackgroundHash, computeChecklistHash,
 * signInitCheck, recomputeInitCheckHash) live in core/init-check-gate.ts so that
 * core consumers (machine.ts) can verify the hash and evaluate the INIT_CHECK
 * gate without an upward core→handlers import (B-37e9 F-001 layering fix). This
 * file imports them and re-exports them for backward-compatible callers while
 * keeping the init_check_set handler factory and the metadata-write lock here.
 *
 * INIT → INIT_CHECK 硬门槛产物 init-check.json 的签名结构与 gate 语义详见
 * core/init-check-gate.ts 模块注释。
 */

import { mkdirSync, rmSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { StoryStore } from '../core/store.js';
import type { HandlerContext } from './context.js';
import type { InitCheckData, InitCheckIssue } from '../core/types.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { currentMaterialHash } from '../core/evidence-freshness.js';
import { getSessionId } from '../core/story-owner-lease.js';
import {
  INIT_CHECK_SALT,
  REQUIRED_INIT_CHECK_AGENTS,
  INIT_CHECK_FALLBACK_AGENT_SUFFIX,
  normalizeAgentId,
  initCheckAgentMatches,
  initCheckAgentResults,
  initCheckAttestationMode,
  missingRequiredInitCheckAgents,
  blockingInitCheckIssues,
  computeBackgroundHash,
  computeChecklistHash,
  signInitCheck,
  recomputeInitCheckHash,
} from '../core/init-check-gate.js';

// Backward-compatible re-exports: existing importers (core/machine.ts now reads
// from core directly; story-create.ts / draft-check.ts still import from here).
export {
  INIT_CHECK_SALT,
  REQUIRED_INIT_CHECK_AGENTS,
  INIT_CHECK_FALLBACK_AGENT_SUFFIX,
  normalizeAgentId,
  initCheckAgentMatches,
  initCheckAgentResults,
  initCheckAttestationMode,
  missingRequiredInitCheckAgents,
  blockingInitCheckIssues,
  computeBackgroundHash,
  computeChecklistHash,
  signInitCheck,
  recomputeInitCheckHash,
};

/** B-95d8 CHK-001: minimum length for a manual fallback attestation reason. */
export const INIT_CHECK_FALLBACK_REASON_MIN = 30;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withInitCheckLock<T>(store: StoryStore, storyId: string, fn: () => T): T {
  const lockDir = store.storyFilePath(storyId, 'init-check.lock');
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (e: any) {
      try {
        const ageMs = Date.now() - statSync(lockDir).mtimeMs;
        if (ageMs > 10000) rmSync(lockDir, { recursive: true, force: true });
      } catch { /* PROBE: lock disappeared between mkdir attempts */ }
      if (Date.now() > deadline) {
        throw new Error(`init_check_set: timed out waiting for metadata lock (${e?.message || e})`);
      }
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/**
 * init_check_set handler 工厂。
 *
 * 由 koala-review-story-init subagent 调用（CHK-002 模板），写入 init-check.json。
 * 不校验调用方 agentId（EXP-001 已证伪 subagent 与主 agent 在 CLI 视角下机械可区分性）；
 * agentId 仅作为 reviewer 自报的审计字段透传。反自豁免靠 (1) 签名机制 +
 * (2) reviewer 模板 fence + (3) CLAUDE.md 行为规约 三层（同 B-ed3e scope-check 已落地架构）。
 *
 * 三层校验（packages/koala/CLAUDE.md「Handler 编码约定」）：
 * - Zod schema：cli-engine.ts 注册端定义 issues 数组结构 + severity enum + desc min(1)
 * - runtime（本 handler 入口）：再校验 desc.trim().length >= 1，防绕过 Zod 路径
 * - gate 决策点（CHK-005 实现）：消费 init-check.json.issues 时按同标准 trim 校验
 */
export function createInitCheckHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const { store, root } = ctx;
  return {
    init_check_set(args: {
      storyId: string;
      issues: InitCheckIssue[];
      agent?: string;
      agentId?: string;
    }): string {
      return withInitCheckLock(store, args.storyId, () => {
      // 1) story 存在性校验（同 scope_check_save 套路）
      let title = '';
      let description = '';
      let reviewRound = '';
      try {
        const story = store.readStory(args.storyId);
        title = story.title;
        description = story.description;
        reviewRound = story.currentReviewRound || '';
      } catch {
        throw new Error(`Story ${args.storyId} not found`);
      }

      // 2) issues runtime 校验（防 Zod 绕过路径，与 gate 端 trim 标准对齐）
      const issues = Array.isArray(args.issues) ? args.issues : [];
      for (const issue of issues) {
        if (!issue || typeof issue.desc !== 'string' || issue.desc.trim().length < 1) {
          throw new Error(
            `init_check_set: 每个 issue.desc 必须 trim 后 ≥ 1 字符（reviewer 主观判断需具体）`,
          );
        }
      }

      // 3) 计算签名所需的三块 hash
      const backgroundHash = computeBackgroundHash(root, args.storyId);
      let items: Array<{ title: string; context?: string }> = [];
      try {
        const checklist = store.readChecklist(args.storyId);
        items = checklist.items.map(i => ({ title: i.title, context: i.context }));
      } catch {
        // checklist.json 不存在时按空数组算 hash（与 recomputeInitCheckHash 行为一致）
      }
      const checklistHash = computeChecklistHash(items);

      // 4) 调签名函数（与 recomputeInitCheckHash 共用 signInitCheck，单一真相源）
      const _hash = signInitCheck(args.storyId, backgroundHash, title, description, checklistHash, reviewRound);

      // 5) 构造 InitCheckData 并落盘
      const checkedAt = new Date().toISOString();
      const agentId = normalizeAgentId(args.agentId || args.agent);
      const previous = store.readInitCheck(args.storyId);
      const agentResults = previous ? initCheckAgentResults(previous).filter(
        result => !initCheckAgentMatches(result.agentId, agentId) && result.agentId !== agentId,
      ) : [];
      agentResults.push({ agentId, checkedAt, issues });

      const data: InitCheckData = {
        storyId: args.storyId,
        checkedAt,
        reviewRound,
        agentId,
        issues,
        agentResults,
        _hash,
      };
      store.writeInitCheck(args.storyId, data);

      // 6) 返回值含按 severity 分桶的 issue 计数（advisory 模式：critical 也不阻塞这里，
      //    由 reviewer 模板自律拒调；CHK-005 gate 端 advance 成功消息再 echo critical 警告）
      let critical = 0, high = 0, medium = 0, low = 0;
      for (const issue of issues) {
        switch (issue.severity) {
          case 'critical': critical++; break;
          case 'high': high++; break;
          case 'medium': medium++; break;
          case 'low': low++; break;
        }
      }
      const missing = missingRequiredInitCheckAgents(data);
      const commitHint = autoCommitStoryMetadata(root, args.storyId, 'init_check_set');
      return `Init check saved for ${args.storyId}: ${issues.length} issues (${critical}/${high}/${medium}/${low}); recorded agents: ${agentResults.map(r => r.agentId || '<unknown>').join(', ')}${missing.length > 0 ? `; missing required agents: ${missing.join(', ')}` : ''}${commitHint}`;
      });
    },

    /**
     * init_check_repair — B-95d8 CHK-001 explicit, auditable INIT_CHECK fallback.
     *
     * For environments that cannot spawn the koala-review-story-init / product-reviewer
     * subagents (no init reviewer available). Produces a SIGNED init-check.json that
     * `canEnterInitCheck` / `getGuardFailureReason` accept — WITHOUT weakening the gate:
     *
     *  - The signature is computed by the SAME `signInitCheck` over the SAME domain
     *    (background/title/description/checklist). Editing any signed story content
     *    afterwards still triggers `init_check_tampered` (the recompute diverges).
     *  - Required-reviewer coverage is satisfied by recording each required agent as
     *    `<required>@fallback`; `initCheckAgentMatches` accepts the `<required>@`
     *    prefix, so missingRequiredInitCheckAgents is empty, while the `@fallback`
     *    suffix + `fallback` block keep the manual attestation mechanically
     *    distinguishable from an independent reviewer run (initCheckAttestationMode).
     *  - Operator-supplied issues still flow through blockingInitCheckIssues: attesting
     *    a high/critical issue self-blocks (you cannot fallback past a real blocker).
     *
     * NOT default-on: rejects (no file written, no phase change) unless BOTH an
     * explicit `acknowledge: true` AND a `fallbackReason` (>= 30 chars) are supplied.
     * Does NOT check agentId mechanically (EXP-001: caller identity is not mechanically
     * distinguishable in the Bash CLI).
     */
    init_check_repair(args: {
      storyId: string;
      fallbackReason: string;
      acknowledge?: boolean;
      mode?: 'repair' | 'fallback';
      evidenceRefs?: string[];
      issues?: InitCheckIssue[];
      actor?: string;
    }): string {
      // --- Controlled-opt-in preflight (runtime, NOT Zod-only; CLAUDE.md Handler 约定) ---
      // These guards MUST run before any read/write so a refusal produces ZERO file
      // write and ZERO phase change. Default-disabled = both ack + reason required.
      if (args.acknowledge !== true) {
        throw new Error(
          'init_check_repair: refused — this fallback bypasses the independent INIT reviewer and is disabled by default. ' +
          'Re-run with explicit acknowledgement: pass acknowledge=true to confirm you are deliberately attesting in lieu of koala-review-story-init / product-reviewer.',
        );
      }
      const reason = (args.fallbackReason ?? '').trim();
      if (reason.length < INIT_CHECK_FALLBACK_REASON_MIN) {
        throw new Error(
          `init_check_repair: refused — fallbackReason must be >= ${INIT_CHECK_FALLBACK_REASON_MIN} characters (got ${reason.length}). ` +
          'State why the init reviewer cannot run and what you checked in its place; this is recorded as durable audit attestation.',
        );
      }
      const mode = args.mode ?? 'repair';
      if (mode !== 'repair' && mode !== 'fallback') {
        throw new Error(`init_check_repair: mode must be 'repair' or 'fallback' (got ${JSON.stringify(args.mode)})`);
      }
      const evidenceRefs = Array.isArray(args.evidenceRefs)
        ? args.evidenceRefs.map(r => String(r).trim()).filter(r => r.length > 0)
        : [];
      // issues runtime validation mirrors init_check_set (defend the bypass path).
      const issues = Array.isArray(args.issues) ? args.issues : [];
      for (const issue of issues) {
        if (!issue || typeof issue.desc !== 'string' || issue.desc.trim().length < 1) {
          throw new Error('init_check_repair: 每个 issue.desc 必须 trim 后 ≥ 1 字符');
        }
      }

      return withInitCheckLock(store, args.storyId, () => {
        // 1) story existence (preflight already passed; refusal above wrote nothing).
        let title = '';
        let description = '';
        let reviewRound = '';
        try {
          const story = store.readStory(args.storyId);
          title = story.title;
          description = story.description;
          reviewRound = story.currentReviewRound || '';
        } catch {
          throw new Error(`Story ${args.storyId} not found`);
        }

        // 2) Sign over the SAME domain as init_check_set (single source of truth).
        const backgroundHash = computeBackgroundHash(root, args.storyId);
        let items: Array<{ title: string; context?: string }> = [];
        try {
          const checklist = store.readChecklist(args.storyId);
          items = checklist.items.map(i => ({ title: i.title, context: i.context }));
        } catch {
          // checklist absent → empty array hash (matches recomputeInitCheckHash).
        }
        const checklistHash = computeChecklistHash(items);
        const _hash = signInitCheck(args.storyId, backgroundHash, title, description, checklistHash, reviewRound);

        // 3) Required-reviewer coverage via `<required>@fallback` records. The bare
        //    operator-supplied issues land on the story-init record (so they flow
        //    through blockingInitCheckIssues); the product-reviewer record is clean.
        const checkedAt = new Date().toISOString();
        const agentResults = REQUIRED_INIT_CHECK_AGENTS.map((required, idx) => ({
          agentId: `${required}@${INIT_CHECK_FALLBACK_AGENT_SUFFIX}`,
          checkedAt,
          issues: idx === 0 ? issues : [],
        }));

        // 4) Audit attestation block (NOT in signature domain; surface + traceability).
        let headHash: string | undefined;
        try {
          headHash = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() || undefined;
        } catch { /* PROBE: non-git or unavailable, omit headHash */ }
        const materialHash = currentMaterialHash(root) || undefined;
        let actor = (args.actor ?? '').trim();
        if (!actor) {
          try {
            actor = execSync('git config user.name', { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
          } catch { /* PROBE: no git identity, leave actor empty */ }
        }
        let session: string | undefined;
        try {
          session = getSessionId() || undefined;
        } catch { /* PROBE: session id unavailable */ }

        const data: InitCheckData = {
          storyId: args.storyId,
          checkedAt,
          reviewRound,
          agentId: `${REQUIRED_INIT_CHECK_AGENTS[0]}@${INIT_CHECK_FALLBACK_AGENT_SUFFIX}`,
          issues,
          agentResults,
          fallback: {
            mode,
            reason,
            ...(evidenceRefs.length > 0 ? { evidenceRefs } : {}),
            ...(actor ? { actor } : {}),
            ...(session ? { session } : {}),
            attestedAt: checkedAt,
            ...(headHash ? { headHash } : {}),
            ...(materialHash ? { materialHash } : {}),
          },
          _hash,
        };
        store.writeInitCheck(args.storyId, data);

        // 5) Durable audit event in the process timeline (advisory; init-check.json
        //    is the signed truth, this is the activity-log projection).
        try {
          store.appendProcessEvent(args.storyId, {
            type: 'init_check_fallback',
            mode,
            ...(actor ? { actor } : {}),
            ...(session ? { session } : {}),
            ...(headHash ? { headHash } : {}),
          });
        } catch (e) {
          console.warn(`[process-events] append failed for ${args.storyId}:`, (e as Error).message);
        }

        const blockers = blockingInitCheckIssues(data);
        const commitHint = autoCommitStoryMetadata(root, args.storyId, 'init_check_repair');
        const auditLine = `⚠ fallback 已记入审计事件（actor=${actor || '<unknown>'}, mode=${mode}${session ? `, session=${session}` : ''}），未绕过签名校验`;
        const boundaryLine = `⚠ Fallback only repairs INIT_CHECK; it does not authorize implementation and does not replace later PLAN/DEV/REVIEW/TEST reviewers.`;
        if (blockers.length > 0) {
          // Operator attested blocking issues → gate still blocks. Be explicit.
          const lines = blockers.slice(0, 8).map(({ issue }) => `  - ${issue.severity} ${issue.id ? `${issue.id} ` : ''}${issue.desc}`);
          return `✓ init-check.json 已生成（fallback 通道，签名域不变）\n${auditLine}\n${boundaryLine}\n⚠ 但记录了 high/critical issue，INIT_CHECK gate 仍会阻塞，请先修复并重跑：\n${lines.join('\n')}${commitHint}`;
        }
        return `✓ init-check.json 已生成（fallback 通道，签名域不变）\n${auditLine}\n${boundaryLine}\n→ 现在可运行 koala story_advance --storyId=${args.storyId} --phase=INIT_CHECK${commitHint}`;
      });
    },
  };
}
