import type { HandlerContext } from './context.js';
import {
  buildBaselineSuiteReport,
  renderBaselineSuiteMarkdown,
  writeBaselineSuiteReport,
  type BaselineSuiteReportOptions,
} from '../core/baseline-suite-report.js';

type BaselineSuiteReportArgs = {
  reports?: string | string[];
  outputDir?: string;
  suiteId?: string;
  minimumSuiteRequired?: boolean;
  productionNoP0P1BlockersFor30Days?: boolean;
  format?: 'text' | 'json';
  json?: boolean;
};

function wantsJson(args: BaselineSuiteReportArgs): boolean {
  return args.json === true || args.format === 'json';
}

export function createBaselineSuiteHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    baseline_suite_report(args: BaselineSuiteReportArgs = {}) {
      const options: BaselineSuiteReportOptions = {
        root: ctx.root,
        reports: args.reports,
        outputDir: args.outputDir,
        suiteId: args.suiteId,
        minimumSuiteRequired: args.minimumSuiteRequired,
        productionNoP0P1BlockersFor30Days: args.productionNoP0P1BlockersFor30Days,
      };
      const report = buildBaselineSuiteReport(options);
      writeBaselineSuiteReport(report);
      if (wantsJson(args)) return report;
      return [
        renderBaselineSuiteMarkdown(report).trimEnd(),
        '',
        `Wrote ${report.writtenFiles.json}`,
        `Wrote ${report.writtenFiles.markdown}`,
      ].join('\n');
    },
  };
}
