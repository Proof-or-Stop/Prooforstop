/**
 * @task B-57e7
 * @checklist CHK-001
 * @title test-intent-prompt-quality-v1 scores the production test-intent agent prompt
 * @type feature
 * @priority high
 * @description
 *   test-intent-quality-v1 评估的是输出样本，不适合评估 agent prompt 文档。
 *   这个 profile 专门评估 test-intent prompt 是否包含 fixture-heavy、input/expect、
 *   WHY、desc/type、当前 verificationIntent 类型、非全局硬性要求和 adversarial 去重等生产规则。
 * @changes
 *   - [CHK-001] 新增 prompt-level test-intent profile
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

export function evaluateTestIntentPromptQualityProfile(ctx: LabProfileContext): LabRunMetrics {
  const text = ctx.content;
  const lower = text.toLowerCase();
  const supportedTypes = ['cli', 'browser', 'logic', 'manual', 'docs'];
  const checks: Record<string, boolean> = {
    fixtureHeavyGuidance: text.includes('fixture-heavy') && text.includes('推荐字段'),
    supportedTypes: supportedTypes.every((type) => new RegExp(`\\b${type}\\b`).test(lower)),
    descGuidance: text.includes('desc') && text.includes('操作/条件 → 预期结果'),
    whyGuidance: text.includes('WHY:') || text.includes('WHY') || text.includes('覆盖意图'),
    nonMandatory: text.includes('不是所有简单 story 的硬性要求') || text.includes('推荐字段'),
    unsupportedFieldsGuard: (text.includes('"input"') || text.includes('`input`')) &&
      (text.includes('"expect"') || text.includes('`expect`')) &&
      lower.includes('unsupported fields') &&
      lower.includes('do not emit'),
    adversarialDistinct: text.includes('materially different conditions') ||
      text.includes('adversarial 不是 edge 的重复') ||
      text.includes('edge/adversarial 不要只是 happy'),
  };
  const submetrics = Object.fromEntries(Object.entries(checks).map(([key, value]) => [key, ratio(value)]));
  const quality = Object.values(submetrics).reduce((sum, value) => sum + value, 0) / Object.values(submetrics).length;
  const lineCount = countLines(text);
  const latencyPenalty = lineCount <= 180 ? 0 : Math.min(1, (lineCount - 180) / 180);
  const complexityPenalty = Math.min(1, ctx.changedFiles * 0.04 + ctx.changedLines / 600);

  return {
    profile: 'test-intent-prompt-quality-v1',
    quality: Number(quality.toFixed(4)),
    latencyPenalty: Number(latencyPenalty.toFixed(4)),
    complexityPenalty: Number(complexityPenalty.toFixed(4)),
    stabilityPenalty: 0,
    submetrics,
    contentSummary: Object.entries(checks).map(([key, value]) => summarize(key, value)),
    notes: [`lineCount=${lineCount}`],
  };
}
