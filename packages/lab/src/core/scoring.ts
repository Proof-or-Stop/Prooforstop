/**
 * @task B-a591
 * @checklist CHK-001
 * @title lattice-lab scoring core turns metric bundles into comparable scores
 * @type feature
 * @priority high
 * @description
 *   profile 返回的只是质量与 penalty 指标，真正的可比性来自统一的 total score
 *   公式、稳定性惩罚和 kept/discard 规则。这里把这些逻辑集中起来，避免每个
 *   profile 各自解释“什么叫更好”。
 * @changes
 *   - [CHK-001] 新增 total score 统一计算与非法输入校验
 *   - [CHK-003] 新增 baseline/candidate 的 keep-discard 决策逻辑
 *   - [CHK-004] 新增重复评估的 stddev 与 crash 惩罚
 */
import type {
  LabRunMetrics,
  LabScoringConfig,
  LabSelectionPolicy,
  LabScoreDecision,
} from '../types.js';

function round(value: number): number {
  return Number(value.toFixed(4));
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function ensureFinite(label: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`lattice-lab invalid ${label}: ${value}`);
  }
}

export function validateMetrics(metrics: LabRunMetrics): void {
  ensureFinite('quality', metrics.quality);
  ensureFinite('latencyPenalty', metrics.latencyPenalty);
  ensureFinite('complexityPenalty', metrics.complexityPenalty);
  ensureFinite('stabilityPenalty', metrics.stabilityPenalty);
}

export function computeTotalScore(metrics: LabRunMetrics, scoring: LabScoringConfig): number {
  validateMetrics(metrics);
  ensureFinite('qualityWeight', scoring.qualityWeight);
  ensureFinite('latencyWeight', scoring.latencyWeight);
  ensureFinite('complexityWeight', scoring.complexityWeight);
  ensureFinite('stabilityWeight', scoring.stabilityWeight);
  const total =
    clamp01(metrics.quality) * scoring.qualityWeight -
    clamp01(metrics.latencyPenalty) * scoring.latencyWeight -
    clamp01(metrics.complexityPenalty) * scoring.complexityWeight -
    clamp01(metrics.stabilityPenalty) * scoring.stabilityWeight;
  return round(clamp01(total));
}

export function computeNormalizedScore(metrics: LabRunMetrics): number {
  validateMetrics(metrics);
  const normalized =
    clamp01(metrics.quality) -
    clamp01(metrics.latencyPenalty) * 0.15 -
    clamp01(metrics.complexityPenalty) * 0.15 -
    clamp01(metrics.stabilityPenalty) * 0.1;
  return round(clamp01(normalized));
}

export function computeStdDev(values: number[]): number {
  if (values.length <= 1) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length;
  return round(Math.sqrt(variance));
}

export function computeStabilityPenalty(args: {
  repeatScores: number[];
  hadCrash: boolean;
}): { penalty: number; stddev: number } {
  const stddev = computeStdDev(args.repeatScores);
  let penalty = 0;
  if (stddev > 0.03) {
    penalty += Math.min(1, round(stddev * 4));
  }
  if (args.hadCrash) {
    penalty += 0.5;
  }
  return {
    penalty: round(clamp01(penalty)),
    stddev,
  };
}

export function decideCandidate(args: {
  baselineScore: number;
  candidateScore: number;
  selection: LabSelectionPolicy;
}): LabScoreDecision {
  ensureFinite('baselineScore', args.baselineScore);
  ensureFinite('candidateScore', args.candidateScore);
  const delta = round(args.candidateScore - args.baselineScore);

  if (args.selection.requireNoRegression && delta < 0) {
    return {
      status: 'rejected',
      delta,
      reason: `candidate regressed below baseline (${args.candidateScore} < ${args.baselineScore})`,
    };
  }
  if (delta < args.selection.minScoreGain) {
    return {
      status: 'rejected',
      delta,
      reason: `candidate delta ${delta} is below minScoreGain ${args.selection.minScoreGain}`,
    };
  }
  return {
    status: 'kept',
    delta,
    reason: `candidate beat baseline by ${delta}`,
  };
}
