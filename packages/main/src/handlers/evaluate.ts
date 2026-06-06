/**
 * Evaluate handler — koala evaluate
 *
 * Invoke the evaluator agent to operate the application via the browser API like a user,
 * scoring on two dimensions: feature completeness and usability.
 *
 * Preconditions:
 * - Project koala.config.json has browser.devCommand configured (otherwise skip)
 * - koala serve --dev is already running (or started by this command)
 *
 * Results are written to the story's eval-evidence.json, consumed by the DONE gate.
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
     * Check the project shells configuration and decide which evaluator to spawn based on declarations:
     * - Has browser.devCommand → spawn koala-evaluator (browser)
     * - Has cli.command → spawn koala-evaluator-cli (bridge API + CLI spawn)
     * - Both → run both
     * - Neither → try reading .koala-serve.json to determine if there's an active serve process; if so, run the CLI evaluator
     *
     * The evaluator agent's output (JSON) is parsed by the main agent and then written as evidence via koala evaluate_save.
     */
    evaluate(args: { storyId: string; port?: number }): string {
      const config = loadConfig(ctx.root);

      const hasBrowser = !!config.browser?.devCommand;
      const hasCli = !!config.cli?.command;

      // No shell configuration at all → skip
      if (!hasBrowser && !hasCli) {
        return JSON.stringify({
          skipped: true,
          reason: 'No browser.devCommand or cli.command in koala.config.json — no evaluator target',
        });
      }

      const port = args.port ?? 3456;
      const serveUrl = `http://localhost:${port}`;

      // Read checklist for the evaluator
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
        instructions.push(`1. Ensure koala serve --dev="${config.browser!.devCommand}" is running (port ${port})`);
        instructions.push(`2. Use the Agent tool to invoke the koala-evaluator agent, passing serveUrl="${serveUrl}" and checklist`);
      }
      if (hasCli) {
        const step = hasBrowser ? 3 : 1;
        instructions.push(`${step}. Ensure koala serve is running (port ${port})`);
        instructions.push(`${step + 1}. Use the Agent tool to invoke the koala-evaluator-cli agent, passing serveUrl="${serveUrl}", checklist, hasCliShell=true`);
      }
      const lastStep = instructions.length + 1;
      instructions.push(`${lastStep}. Parse the JSON returned by the evaluator`);
      instructions.push(`${lastStep + 1}. Call koala evaluate_save to write the results`);

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
     * The main agent calls this command to write eval-evidence.json after receiving evaluator output.
     */
    evaluate_save(args: { storyId: string; result: string }): string {
      let parsed: any;
      try {
        parsed = JSON.parse(args.result);
      } catch {
        throw new Error('evaluate_save: result must be valid JSON');
      }

      // Basic validation
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
