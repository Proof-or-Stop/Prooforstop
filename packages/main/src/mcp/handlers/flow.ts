import type { HandlerContext } from './context.js';
import { scan, extractFlows } from '../../tasks/extract.js';
import { validateFlows } from '../../tasks/validate.js';

export function createFlowHandlers(ctx: HandlerContext) {
  const { scanRoot } = ctx;
  return {
    // ── Flow 工具 ─────────────────────────────────

    flow_trace(args: { name: string }): string {
      const tasks = scan(scanRoot);
      const chains = extractFlows(tasks);
      const chain = chains.find(c => c.name === args.name);
      if (!chain) {
        const available = chains.map(c => c.name).join(', ');
        throw new Error(`Flow "${args.name}" not found. Available flows: ${available || 'none'}`);
      }
      const validation = validateFlows([chain], tasks);
      return JSON.stringify({ flow: chain, validation: { issues: validation.issues, passed: validation.passed } }, null, 2);
    },

    flow_list(): string {
      const tasks = scan(scanRoot);
      const chains = extractFlows(tasks);
      const validation = validateFlows(chains, tasks);
      const summary = chains.map(c => ({
        name: c.name,
        steps: c.steps.length,
        complete: c.complete,
        issues: validation.issues.filter(i => i.flow === c.name).length,
      }));
      return JSON.stringify(summary, null, 2);
    },
  };
}
