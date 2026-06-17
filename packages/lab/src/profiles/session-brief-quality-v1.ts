/**
 * @task B-780e
 * @checklist CHK-001
 * @title session-brief-quality-v1 quantifies Lattice session entrypoint output
 * @type feature
 * @priority high
 * @description
 *   session_brief 是每个 session 的第一眼流程入口。这个 profile 用 deterministic
 *   rubric 检查输出是否包含 story/phase/checklist/reviewer/artifact/git/next step 等
 *   关键信息，并把命中与缺失项写入 contentSummary 供 compare 展示。
 * @changes
 *   - [CHK-001] 新增 session-brief-quality-v1 profile
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

export function evaluateSessionBriefQualityProfile(ctx: LabProfileContext): LabRunMetrics {
  const text = ctx.content.toLowerCase();
  const checks: Record<string, boolean> = {
    story: text.includes('story') || text.includes('**story**'),
    phase: text.includes('phase') || text.includes('**phase**'),
    checklist: text.includes('checklist'),
    reviewerStatus: text.includes('reviewer status') || text.includes('reviewer'),
    artifactStatus: text.includes('artifacts') || text.includes('artifact'),
    gitStatus: text.includes('git') || text.includes('working tree'),
    nextStep: text.includes('next step') || text.includes('→ next') || text.includes('→ 下一步'),
    runtimeHealth: text.includes('runtime health') || text.includes('worktree registered'),
  };
  const submetrics = Object.fromEntries(Object.entries(checks).map(([key, value]) => [key, ratio(value)]));
  const quality = Object.values(submetrics).reduce((sum, value) => sum + value, 0) / Object.values(submetrics).length;
  const lineCount = countLines(ctx.content);
  const latencyPenalty = lineCount <= 80 ? 0 : Math.min(1, (lineCount - 80) / 160);
  const complexityPenalty = Math.min(1, ctx.changedFiles * 0.04 + ctx.changedLines / 500);

  return {
    profile: 'session-brief-quality-v1',
    quality: Number(quality.toFixed(4)),
    latencyPenalty: Number(latencyPenalty.toFixed(4)),
    complexityPenalty: Number(complexityPenalty.toFixed(4)),
    stabilityPenalty: 0,
    submetrics,
    contentSummary: Object.entries(checks).map(([key, value]) => summarize(key, value)),
    notes: [`lineCount=${lineCount}`],
  };
}
