/**
 * Evaluate handler — proof-or-stop evaluate
 *
 * 调用 evaluator agent 通过 browser API 像用户一样操作应用，
 * 按功能完整性和可用性两个维度打分。
 *
 * 前置条件：
 * - 项目 proof-or-stop.config.json
 *   配了 browser.devCommand（否则跳过）
 * - proof-or-stop serve --dev 已经在运行（或由本命令启动）
 *
 * 结果写入 story 的 eval-evidence.json，DONE gate 消费。
 */

import type { HandlerContext } from './context.js';
import type { EvalEvidenceData } from '../core/types.js';
import { loadConfig } from '../core/config.js';
import { computeProcessMetrics } from '../core/process-metrics.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { assembleFullPromptEnvelope, buildFullTaskContext, verifyPromptEnvelopeIntegrity } from '../core/prompt-envelope.js';
import { BASELINE_RUNTIME_CONTRACT } from '../core/prompt-measurement.js';
import { captureReviewRunSnapshot } from '../core/review-run.js';
import { promptRoleContract, resolvePromptEnvelopeRolloutMode, resolvePromptRoleBody } from '../core/prompt-role-contract-registry.js';
import { withReviewMetadataTicketLock } from '../core/mkdir-lock.js';

export function createEvaluateHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    /**
     * proof-or-stop evaluate --story=B-xxx [--port=3456]
     *
     * 检查项目 shells 配置，按声明决定 spawn 哪个 evaluator：
     * - 有 browser.devCommand → spawn proof-or-stop-evaluator（browser）
     * - 有 cli.command → spawn proof-or-stop-evaluator-cli（bridge API + CLI spawn）
     * - 都有 → 都跑
     * - 都没有 → 尝试读 .proof-or-stop-serve.json 判断是否有活跃 serve 进程，有则跑 CLI evaluator
     *
     * evaluator agent 的输出（JSON）由主 agent 解析后调 proof-or-stop evaluate_save 写入 evidence。
     */
    evaluate(args: { storyId: string; port?: number }): string {
      const config = loadConfig(ctx.root);

      const hasBrowser = !!config.browser?.devCommand;
      const hasCli = !!config.cli?.command;

      // 没有任何 shell 配置 → 跳过
      if (!hasBrowser && !hasCli) {
        return JSON.stringify({
          skipped: true,
          reason: 'No browser.devCommand or cli.command in proof-or-stop.config.json — no evaluator target',
        });
      }

      const port = args.port ?? 3456;
      const serveUrl = `http://localhost:${port}`;

      // 读 checklist 给 evaluator
      let checklistSummary = '';
      try {
        const cl = ctx.store.readChecklist(args.storyId);
        checklistSummary = cl.items
          .map(it => `- ${it.id}: ${it.title}${it.userSees ? ` (userSees: ${it.userSees})` : ''}`)
          .join('\n');
      } catch {
        checklistSummary = '(checklist not found)';
      }

      const evaluators: string[] = [];
      if (hasBrowser) evaluators.push('proof-or-stop-evaluator');
      if (hasCli) evaluators.push('proof-or-stop-evaluator-cli');

      const instructions: string[] = [];
      if (hasBrowser) {
        instructions.push(`1. 确保 proof-or-stop serve --dev="${config.browser!.devCommand}" 正在运行（端口 ${port}）`);
        instructions.push(`2. 用 Agent tool 调 proof-or-stop-evaluator agent，传入 serveUrl="${serveUrl}" 和 checklist`);
      }
      if (hasCli) {
        const step = hasBrowser ? 3 : 1;
        instructions.push(`${step}. 确保 proof-or-stop serve 正在运行（端口 ${port}）`);
        instructions.push(`${step + 1}. 用 Agent tool 调 proof-or-stop-evaluator-cli agent，传入 serveUrl="${serveUrl}", checklist, hasCliShell=true`);
      }
      const lastStep = instructions.length + 1;
      instructions.push(`${lastStep}. 解析 evaluator 返回的 JSON`);
      instructions.push(`${lastStep + 1}. 调 proof-or-stop evaluate_save 写入结果`);

      let promptEnvelope: Record<string, unknown> | undefined;
      if (resolvePromptEnvelopeRolloutMode('proof-or-stop-evaluator', config.promptEnvelope) === 'full-envelope') {
        const story = ctx.store.readStory(args.storyId);
        const snapshot = captureReviewRunSnapshot(ctx.root, { storyId: args.storyId, storyPhase: story.phase }, ctx.root);
        const taskContext = buildFullTaskContext({
          story,
          checklist: ctx.store.readChecklist(args.storyId),
          ...snapshot,
          scopeContract: ctx.store.readScopeContract(args.storyId),
        });
        const assembly = assembleFullPromptEnvelope({
          roleContract: promptRoleContract('proof-or-stop-evaluator'),
          runtimeContract: BASELINE_RUNTIME_CONTRACT,
          rolePrompt: resolvePromptRoleBody('proof-or-stop-evaluator', config.promptEnvelope).body,
          taskContext,
          dispatchKind: 'story-dispatch',
          dispatchPrompt: instructions.join('\n'),
          createdAt: new Date().toISOString(),
        });
        const lockDir = ctx.store.runtimeLockDirPath(args.storyId, 'review-run', 'review-runs');
        withReviewMetadataTicketLock(lockDir, `evaluate for ${args.storyId}/proof-or-stop-evaluator`, () => {
          const data = ctx.store.readPromptEnvelopes(args.storyId);
          const existing = data.envelopes.find(candidate => candidate.envelopeId === assembly.envelope.envelopeId);
          if (existing && !verifyPromptEnvelopeIntegrity(existing)) {
            throw new Error(`evaluate: persisted envelope ${existing.envelopeId} failed integrity verification`);
          }
          if (!existing) {
            data.envelopes.push(assembly.envelope);
            ctx.store.writePromptEnvelopes(args.storyId, data);
          }
          const persisted = ctx.store.readPromptEnvelopes(args.storyId).envelopes.find(
            candidate => candidate.envelopeId === assembly.envelope.envelopeId,
          );
          if (!persisted || !verifyPromptEnvelopeIntegrity(persisted)) {
            throw new Error(`evaluate: envelope ${assembly.envelope.envelopeId} was not durably persisted`);
          }
        });
        promptEnvelope = {
          envelopeId: assembly.envelope.envelopeId,
          roleId: assembly.envelope.roleId,
          dispatchKind: assembly.envelope.dispatchKind,
          assembledPromptDigest: assembly.envelope.assembledPromptDigest,
          contextDigest: assembly.envelope.contextDigest,
          prompt: assembly.prompt,
        };
      }

      return JSON.stringify({
        skipped: false,
        action: 'run_evaluator_agent',
        evaluators,
        serveUrl,
        devCommand: config.browser?.devCommand ?? null,
        cliCommand: config.cli?.command ?? null,
        storyId: args.storyId,
        checklist: checklistSummary,
        instructions: instructions.join('\n'),
        ...(promptEnvelope ? { promptEnvelope } : {}),
      });
    },

    /**
     * proof-or-stop evaluate_save --story=B-xxx --result='{ ... }'
     *
     * 主 agent 拿到 evaluator 输出后调此命令写入 eval-evidence.json。
     */
    evaluate_save(args: { storyId: string; result: string }): string {
      let parsed: any;
      try {
        parsed = JSON.parse(args.result);
      } catch {
        throw new Error('evaluate_save: result must be valid JSON');
      }

      // 基本校验
      if (!parsed.scores || typeof parsed.scores.functionality !== 'number' || typeof parsed.scores.usability !== 'number') {
        throw new Error('evaluate_save: result must have scores.functionality and scores.usability');
      }
      if (typeof parsed.pass !== 'boolean') {
        throw new Error('evaluate_save: result must have pass (boolean)');
      }

      const evidence: EvalEvidenceData = {
        scores: {
          functionality: parsed.scores.functionality,
          usability: parsed.scores.usability,
        },
        total: parsed.total ?? (parsed.scores.functionality + parsed.scores.usability),
        pass: parsed.pass,
        itemResults: parsed.itemResults || [],
        findings: parsed.findings || [],
        timestamp: new Date().toISOString(),
      };

      ctx.store.writeEvalEvidence(args.storyId, evidence);

      // B-abd8: auto-recompute process metrics
      try {
        const pm = computeProcessMetrics(args.storyId, ctx.store, ctx.root);
        ctx.store.writeProcessMetrics(args.storyId, pm);
      } catch (e) {
        console.warn(`[process-metrics] recompute failed for ${args.storyId}:`, (e as Error).message);
      }
      const commitHint = autoCommitStoryMetadata(ctx.root, args.storyId, 'evaluate_save', {
        closeoutArtifactPaths: ['eval-evidence.json'],
      });

      const icon = evidence.pass ? '✓' : '✗';
      return `${icon} Eval evidence saved: functionality=${evidence.scores.functionality} usability=${evidence.scores.usability} total=${evidence.total} pass=${evidence.pass}${commitHint}`;
    },
  };
}
