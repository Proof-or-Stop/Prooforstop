import {
  generatePromptMeasurementReport,
  type PromptMeasurementReport,
} from '../core/prompt-measurement.js';

function renderAvailability(value: { availability: string; tokens?: number; reason?: string }): string {
  return value.availability === 'available'
    ? `available(${value.tokens})`
    : `unavailable(${value.reason})`;
}

export function renderPromptMeasurementReportText(report: PromptMeasurementReport): string {
  const lines = [
    `Prompt measurement report (${report.schemaVersion})`,
    `reportDigest: ${report.reportDigest}`,
    `roles: ${report.aggregate.roleCount} (active=${report.aggregate.activeRoleCount}, compatibility=${report.aggregate.compatibilityRoleCount}, retired=${report.aggregate.retiredRoleCount})`,
    `algorithms: canonical=${report.algorithmVersions.canonicalSerialization} bytes=${report.algorithmVersions.bytes} lines=${report.algorithmVersions.lines} tokens=${report.algorithmVersions.tokenEstimator} repetition=${report.algorithmVersions.repetition}`,
    '',
  ];
  for (const record of report.records) {
    lines.push(
      `${record.roleId}: bytes=${record.bytes} lines=${record.lines} estimatedTokens=${record.estimatedTokens} repetition=${record.repetition.ratio.toFixed(6)} assembled=${renderAvailability(record.assembledPromptTokens)} knownDispatch=${renderAvailability(record.knownDispatchInputTokens)} providerProcessed=${renderAvailability(record.providerProcessedInputTokens)}`,
    );
  }
  lines.push(
    '',
    `aggregate: bytes=${report.aggregate.bytes} lines=${report.aggregate.lines} estimatedTokens=${report.aggregate.estimatedTokens} repetition=${report.aggregate.repetition.ratio.toFixed(6)}`,
    `aggregate.assembledPromptTokens: ${renderAvailability(report.aggregate.assembledPromptTokens)}`,
    `aggregate.knownDispatchInputTokens: ${renderAvailability(report.aggregate.knownDispatchInputTokens)}`,
    `aggregate.providerProcessedInputTokens: ${renderAvailability(report.aggregate.providerProcessedInputTokens)}`,
    'authority: L0 observational only; not review, validation, waiver, or lifecycle evidence.',
  );
  return lines.join('\n');
}

export function createPromptMeasurementHandlers(): Record<string, (...args: any[]) => any> {
  return {
    prompt_measurement_report(args: { format?: 'text' | 'json'; json?: boolean } = {}) {
      const report = generatePromptMeasurementReport();
      return args.format === 'json' || args.json === true
        ? report
        : renderPromptMeasurementReportText(report);
    },
  };
}
