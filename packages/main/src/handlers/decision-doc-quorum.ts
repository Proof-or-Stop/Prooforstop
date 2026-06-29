import type { HandlerContext } from './context.js';

type FormatArgs = { json?: boolean; format?: 'text' | 'json' };

type DecisionDocQuorumCheckArgs = {
  storyId: string;
} & FormatArgs;

type DecisionDocQuorumCore = {
  evaluateDecisionDocQuorum(args: { projectRoot: string; storyId: string; store: HandlerContext['store'] }): unknown | Promise<unknown>;
  formatDecisionDocQuorumFailure?: (report: unknown) => string;
  formatDecisionDocQuorumReport?: (report: unknown) => string;
};

const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

function wantsJson(args: FormatArgs | undefined): boolean {
  return args?.json === true || args?.format === 'json';
}

async function loadDecisionDocQuorumCore(): Promise<DecisionDocQuorumCore> {
  try {
    const mod = await dynamicImport(new URL('../core/decision-doc-quorum.js', import.meta.url).href);
    const core = mod as Partial<DecisionDocQuorumCore>;
    if (typeof core.evaluateDecisionDocQuorum !== 'function') {
      throw new Error('missing evaluateDecisionDocQuorum export');
    }
    return core as DecisionDocQuorumCore;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`decision_doc_quorum_check core is unavailable: ${message}`);
  }
}

function fallbackText(report: unknown): string {
  const record = report && typeof report === 'object' ? report as Record<string, unknown> : {};
  const ok = record.ok === true;
  const applicable = record.applicable !== false;
  const materialDigest = typeof record.materialDigest === 'string' ? record.materialDigest : '<missing>';
  return [
    `Decision doc quorum diagnostic (${ok ? 'pass' : 'incomplete'})`,
    `applicable: ${String(applicable)}`,
    `materialDigest: ${materialDigest}`,
    'doneRequirement: classification-only; review_escalation_status decides whether DONE requires escalation',
    'authorityBoundary: local quorum evidence only; not local proof-admissibility or release readiness',
  ].join('\n');
}

export function createDecisionDocQuorumHandlers(ctx: HandlerContext) {
  return {
    async decision_doc_quorum_check(args: DecisionDocQuorumCheckArgs) {
      const core = await loadDecisionDocQuorumCore();
      const report = await core.evaluateDecisionDocQuorum({
        projectRoot: ctx.root,
        storyId: args.storyId,
        store: ctx.store,
      });

      if (wantsJson(args)) return report;
      if (typeof core.formatDecisionDocQuorumReport === 'function') return core.formatDecisionDocQuorumReport(report);
      if (typeof core.formatDecisionDocQuorumFailure === 'function') return core.formatDecisionDocQuorumFailure(report);
      return fallbackText(report);
    },
  };
}
