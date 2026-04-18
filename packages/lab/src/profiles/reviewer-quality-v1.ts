/**
 * @task B-a591
 * @checklist CHK-002
 * @title reviewer-quality-v1 scores reviewer prompt quality with a deterministic rubric
 * @type feature
 * @priority high
 * @description
 *   第一版评分必须完全离线且可复现。reviewer-quality-v1 不跑模型，而是根据
 *   reviewer prompt 是否包含关键审核约束、长度成本与特定 volatility markers
 *   生成质量与 penalty 指标，供 scoring core 比较 baseline 与 candidate。
 * @changes
 *   - [CHK-002] 为 test-case-reviewer prompt 提供 deterministic 的 metric extractor
 *   - [CHK-004] 用 [lab:volatile] / [lab:crash-on-repeat] 标记支持 stability 测试
 */
import type { LabProfileContext, LabRunMetrics } from '../types.js';

function ratio(condition: boolean): number {
  return condition ? 1 : 0;
}

function includesAll(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function countLines(text: string): number {
  return text.split('\n').length;
}

export function evaluateReviewerQualityProfile(ctx: LabProfileContext): LabRunMetrics {
  const text = ctx.content.toLowerCase();
  const submetrics: Record<string, number> = {
    reviewerAuthority: ratio(text.includes('判定权在你')),
    noTestAuto: ratio(includesAll(text, ['不要运行 test_auto', '不运行 test_auto'])),
    fileLineEvidence: ratio(text.includes('file:line')),
    severityGuidance: ratio(text.includes('severity')),
    capGuidance: ratio(includesAll(text, ['5 轮 cap', '5轮 cap'])),
    noModifyCode: ratio(text.includes('不修改代码') && text.includes('不修改测试')),
    reviewerOutputShape: ratio(text.includes('testintent_check') && text.includes('原样转告')),
  };
  const quality =
    Object.values(submetrics).reduce((sum, value) => sum + value, 0) /
    Object.values(submetrics).length;

  const lineCount = countLines(ctx.content);
  const latencyPenalty = lineCount <= 140 ? 0 : Math.min(1, (lineCount - 140) / 140);
  const complexityPenalty = Math.min(1, ctx.changedFiles * 0.08 + ctx.changedLines / 300);
  let qualityAdjustment = 0;
  if (text.includes('[lab:boost-reviewer]')) qualityAdjustment += 0.12;
  if (text.includes('[lab:weaken-reviewer]')) qualityAdjustment -= 0.12;
  if (text.includes('[lab:soft-volatile]')) {
    qualityAdjustment += ctx.repeatIndex % 2 === 0 ? 0.03 : -0.03;
  }
  if (text.includes('[lab:volatile]')) {
    qualityAdjustment += ctx.repeatIndex % 2 === 0 ? 0.14 : -0.14;
  }
  if (text.includes('[lab:crash-on-repeat]') && ctx.repeatIndex > 0) {
    throw new Error('reviewer-quality-v1 simulated crash on repeat');
  }

  return {
    profile: 'reviewer-quality-v1',
    quality: Math.max(0, Math.min(1, Number((quality + qualityAdjustment).toFixed(4)))),
    latencyPenalty: Number(latencyPenalty.toFixed(4)),
    complexityPenalty: Number(complexityPenalty.toFixed(4)),
    stabilityPenalty: 0,
    submetrics,
    notes: [
      `lineCount=${lineCount}`,
      `changedFiles=${ctx.changedFiles}`,
      `changedLines=${ctx.changedLines}`,
    ],
  };
}
