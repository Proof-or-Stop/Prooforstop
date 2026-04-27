/**
 * Evaluate handler — koala evaluate
 *
 * 调用 evaluator agent 通过 browser API 像用户一样操作应用，
 * 按功能完整性和可用性两个维度打分。
 *
 * 前置条件：
 * - 项目 koala.config.json 配了 browser.devCommand（否则跳过）
 * - koala serve --dev 已经在运行（或由本命令启动）
 *
 * 结果写入 story 的 eval-evidence.json，DONE gate 消费。
 */

import type { HandlerContext } from './context.js';
import type { EvalEvidenceData } from '../core/types.js';
import { loadConfig } from '../core/config.js';
import { computeProcessMetrics } from '../core/process-metrics.js';

export function createEvaluateHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    /**
     * koala evaluate --story=B-xxx [--port=3456]
     *
     * 检查项目 shells 配置，按声明决定 spawn 哪个 evaluator：
     * - 有 browser.devCommand → spawn koala-evaluator（browser）
     * - 有 cli.command → spawn koala-evaluator-cli（bridge API + CLI spawn）
     * - 都有 → 都跑
     * - 都没有 → 尝试读 .koala-serve.json 判断是否有活跃 serve 进程，有则跑 CLI evaluator
     *
     * evaluator agent 的输出（JSON）由主 agent 解析后调 koala evaluate_save 写入 evidence。
     */
    evaluate(args: { storyId: string; port?: number }): string {
      const config = loadConfig(ctx.root);

      const hasBrowser = !!config.browser?.devCommand;
      const hasCli = !!config.cli?.command;

      // 没有任何 shell 配置 → 跳过
      if (!hasBrowser && !hasCli) {
        return JSON.stringify({
          skipped: true,
          reason: 'No browser.devCommand or cli.command in koala.config.json — no evaluator target',
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
      if (hasBrowser) evaluators.push('koala-evaluator');
      if (hasCli) evaluators.push('koala-evaluator-cli');

      const instructions: string[] = [];
      if (hasBrowser) {
        instructions.push(`1. 确保 koala serve --dev="${config.browser!.devCommand}" 正在运行（端口 ${port}）`);
        instructions.push(`2. 用 Agent tool 调 koala-evaluator agent，传入 serveUrl="${serveUrl}" 和 checklist`);
      }
      if (hasCli) {
        const step = hasBrowser ? 3 : 1;
        instructions.push(`${step}. 确保 koala serve 正在运行（端口 ${port}）`);
        instructions.push(`${step + 1}. 用 Agent tool 调 koala-evaluator-cli agent，传入 serveUrl="${serveUrl}", checklist, hasCliShell=true`);
      }
      const lastStep = instructions.length + 1;
      instructions.push(`${lastStep}. 解析 evaluator 返回的 JSON`);
      instructions.push(`${lastStep + 1}. 调 koala evaluate_save 写入结果`);

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
      });
    },

    /**
     * koala evaluate_save --story=B-xxx --result='{ ... }'
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

      const icon = evidence.pass ? '✓' : '✗';
      return `${icon} Eval evidence saved: functionality=${evidence.scores.functionality} usability=${evidence.scores.usability} total=${evidence.total} pass=${evidence.pass}`;
    },
  };
}
