/**
 * @task B-780e
 * @checklist CHK-002
 * @title story-review-quality-v1 quantifies PLAN gate review output
 * @type feature
 * @priority high
 * @description
 *   story_review 是 PLAN gate 的关键输出。这个 profile 检查 review JSON/text 是否
 *   包含 issueCount/blockerCount、missing testIntent、riskSignals、decision/preMortem
 *   与 actionable hint 等信号，并输出 contentSummary 解释分数。
 * @changes
 *   - [CHK-002] 新增 story-review-quality-v1 profile
 */
import type { LabProfileContext, LabRunMetrics } from '../types.js';

function ratio(condition: boolean): number {
  return condition ? 1 : 0;
}

function countLines(text: string): number {
  return text.split('\n').length;
}

function summarize(label: string, present: boolean): string {
  return `${present ? 'has' : 'missing'} ${label}`;
}

export function evaluateStoryReviewQualityProfile(ctx: LabProfileContext): LabRunMetrics {
  const text = ctx.content.toLowerCase();
  const checks: Record<string, boolean> = {
    issueCount: text.includes('issuecount') || text.includes('issue count'),
    blockerCount: text.includes('blockercount') || text.includes('blocker'),
    missingIntent: text.includes('missing_intent') || text.includes('缺少 testintent'),
    riskSignals: text.includes('risksignals') || text.includes('高风险信号'),
    decisionGate: text.includes('decision') || text.includes('premortem'),
    reviewPrompt: text.includes('_reviewprompt') || text.includes('请审查'),
    actionableHint: text.includes('_hint') || text.includes('下一步') || text.includes('修复'),
    intentCoverage: text.includes('intentcoverage') || text.includes('intent coverage'),
  };
  const submetrics = Object.fromEntries(Object.entries(checks).map(([key, value]) => [key, ratio(value)]));
  const quality = Object.values(submetrics).reduce((sum, value) => sum + value, 0) / Object.values(submetrics).length;
  const lineCount = countLines(ctx.content);
  const latencyPenalty = lineCount <= 220 ? 0 : Math.min(1, (lineCount - 220) / 300);
  const complexityPenalty = Math.min(1, ctx.changedFiles * 0.04 + ctx.changedLines / 500);

  return {
    profile: 'story-review-quality-v1',
    quality: Number(quality.toFixed(4)),
    latencyPenalty: Number(latencyPenalty.toFixed(4)),
    complexityPenalty: Number(complexityPenalty.toFixed(4)),
    stabilityPenalty: 0,
    submetrics,
    contentSummary: Object.entries(checks).map(([key, value]) => summarize(key, value)),
    notes: [`lineCount=${lineCount}`],
  };
}
