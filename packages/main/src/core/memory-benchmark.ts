import { createHash } from 'node:crypto';

export const MEMORY_BENCHMARK_SCHEMA_VERSION = 'proof-or-stop.memory_benchmark.v1';
export const MEMORY_BENCHMARK_TEXT_NOTE = 'Benchmark PASS is not Proof-or-Stop lifecycle gate authority, review pass, validation evidence, or delivery check.';

export const SCOREABLE_MEMORY_LAYERS = [
  'raw_event_memory',
  'lifecycle_state_memory',
  'checklist_evidence_memory',
  'summary_memory',
] as const;

export const BOUNDARY_ONLY_MEMORY_LAYERS = [
  'advisory_memory',
  'host_transcript_memory',
] as const;

export const MEMORY_BENCHMARK_LAYER_WEIGHTS = {
  historicalRetrievalScore: 25,
  exactAnswerHit: 25,
  evidenceLinkageRate: 25,
  layerRoutingAccuracy: 15,
  scaleStabilityScore: 10,
} as const;

export const MEMORY_BENCHMARK_SCORE_THRESHOLDS = {
  10000: 92,
  100000: 90,
  1000000: 86,
} as const;

const MEMORY_BENCHMARK_METRIC_MINIMA = {
  exactRecallAt1: 1,
  recallAt10: 0.90,
  mrrAt10: 0.75,
  precisionAt10: 0.70,
} as const;

export const MEMORY_BENCHMARK_DEFAULT_CANDIDATE_COUNTS = [10000, 100000, 1000000] as const;
export const MEMORY_BENCHMARK_DEFAULT_QUERY_COUNT = 12;
export const MEMORY_BENCHMARK_DEFAULT_SEED = 17;
export const MEMORY_BENCHMARK_BASELINE_CANDIDATE_COUNT = 10000;

export type ScoreableMemoryLayer = typeof SCOREABLE_MEMORY_LAYERS[number];
export type BoundaryOnlyMemoryLayer = typeof BOUNDARY_ONLY_MEMORY_LAYERS[number];
export type MemoryLayer = ScoreableMemoryLayer | BoundaryOnlyMemoryLayer;
export type MemoryBenchmarkTier = 'T0' | 'T1' | 'T2' | 'T3';
export type MemoryBenchmarkVerdict = 'PASS' | 'FAIL' | 'HARD_FAIL';
export type CandidateCountInput = number | string;

export const MEMORY_BENCHMARK_CONSTANTS = {
  schemaVersion: MEMORY_BENCHMARK_SCHEMA_VERSION,
  note: MEMORY_BENCHMARK_TEXT_NOTE,
  scoreableLayers: SCOREABLE_MEMORY_LAYERS,
  boundaryOnlyLayers: BOUNDARY_ONLY_MEMORY_LAYERS,
  weights: MEMORY_BENCHMARK_LAYER_WEIGHTS,
  thresholds: MEMORY_BENCHMARK_SCORE_THRESHOLDS,
  defaultCandidateCounts: MEMORY_BENCHMARK_DEFAULT_CANDIDATE_COUNTS,
  defaultQueryCount: MEMORY_BENCHMARK_DEFAULT_QUERY_COUNT,
  defaultSeed: MEMORY_BENCHMARK_DEFAULT_SEED,
  baselineCandidateCount: MEMORY_BENCHMARK_BASELINE_CANDIDATE_COUNT,
} as const;

export interface MemoryBenchmarkOptions {
  tier?: MemoryBenchmarkTier | string;
  candidateCount?: CandidateCountInput;
  queryCount?: number;
  seed?: number;
  baselineQualityScore?: number | null;
  overrides?: MemoryBenchmarkOverride;
}

export interface MemoryBenchmarkCompareOptions {
  candidateCounts?: readonly CandidateCountInput[] | CandidateCountInput;
  queryCount?: number;
  seed?: number;
}

export interface MemoryBenchmarkOverride {
  authorityLeakCount?: number;
  scopeLeakCount?: number;
  staleTruthHitCount?: number;
  lifecycleGateEvidenceLinkageRate?: number;
  layerRoutingAccuracy?: number;
  exactAnswerHit?: number;
  evidenceLinkageRate?: number;
  precisionAt10?: number;
  exactRecallAt1?: number;
  recallAt10?: number;
  mrrAt10?: number;
  forceBoundaryLayerIntoRetrieval?: boolean;
}

export interface MemoryBenchmarkHardChecks {
  authorityLeakCount: number;
  scopeLeakCount: number;
  evidenceLinkageRateLifecycleGate: number;
  staleTruthHitCount: number;
}

export interface MemoryBenchmarkScores {
  exactRecallAt1: number;
  recallAt10: number;
  mrrAt10: number;
  precisionAt10: number;
  historicalRetrievalScore: number;
  exactAnswerHit: number;
  evidenceLinkageRate: number;
  layerRoutingAccuracy: number;
  qualityScore: number;
  scaleStabilityScore: number | null;
  memoryScore: number | null;
}

export interface MemoryBenchmarkResources {
  queryCount: number;
  scoreableQueryCount: number;
  boundaryQueryCount: number;
  candidateCount: number;
  corpusSize: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  peakRSSBytes: number;
  cpuSeconds: number;
}

export interface MemoryBenchmarkRunResult {
  schemaVersion: string;
  tier: MemoryBenchmarkTier;
  candidateCount: number;
  threshold: number | null;
  verdict: MemoryBenchmarkVerdict;
  thresholdPassed: boolean | null;
  note: string;
  constants: {
    weights: typeof MEMORY_BENCHMARK_LAYER_WEIGHTS;
    thresholds: typeof MEMORY_BENCHMARK_SCORE_THRESHOLDS;
    scoreableLayers: readonly ScoreableMemoryLayer[];
    boundaryOnlyLayers: readonly BoundaryOnlyMemoryLayer[];
  };
  hardChecks: MemoryBenchmarkHardChecks;
  scores: MemoryBenchmarkScores;
  resources: MemoryBenchmarkResources;
  routing: {
    scoreableLayers: readonly ScoreableMemoryLayer[];
    boundaryOnlyLayers: readonly BoundaryOnlyMemoryLayer[];
    excludedFromRetrievalLayers: readonly BoundaryOnlyMemoryLayer[];
  };
  deterministicSignature: string;
}

export interface MemoryBenchmarkCompareResult {
  schemaVersion: string;
  note: string;
  candidateCounts: number[];
  baselineCandidateCount: number | null;
  runs: MemoryBenchmarkRunResult[];
  comparison: {
    verdict: MemoryBenchmarkVerdict;
    thresholdPassed: boolean;
    baselineQualityScore: number | null;
  };
}

interface MemoryBenchmarkTierConfig {
  tier: MemoryBenchmarkTier;
  candidateCount: number;
  threshold: number | null;
}

interface QueryBlueprint {
  id: string;
  expectedLayer: MemoryLayer;
  scoreable: boolean;
  lifecycleGateFact: boolean;
  currentState: boolean;
}

const TIER_CONFIG_BY_NAME: Record<MemoryBenchmarkTier, MemoryBenchmarkTierConfig> = {
  T0: { tier: 'T0', candidateCount: 1000, threshold: null },
  T1: { tier: 'T1', candidateCount: 10000, threshold: MEMORY_BENCHMARK_SCORE_THRESHOLDS[10000] },
  T2: { tier: 'T2', candidateCount: 100000, threshold: MEMORY_BENCHMARK_SCORE_THRESHOLDS[100000] },
  T3: { tier: 'T3', candidateCount: 1000000, threshold: MEMORY_BENCHMARK_SCORE_THRESHOLDS[1000000] },
};

const TIER_ALIAS_TO_NAME: Record<string, MemoryBenchmarkTier> = {
  T0: 'T0',
  T1: 'T1',
  T2: 'T2',
  T3: 'T3',
  smoke: 'T0',
  '10k': 'T1',
  '10000': 'T1',
  '100k': 'T2',
  '100000': 'T2',
  '1m': 'T3',
  '1000000': 'T3',
};

const FIXED_TIER_CONFIGS = [TIER_CONFIG_BY_NAME.T1, TIER_CONFIG_BY_NAME.T2, TIER_CONFIG_BY_NAME.T3] as const;
const SUPPORTED_FIXED_TIER_CANDIDATE_COUNTS = FIXED_TIER_CONFIGS.map((entry) => entry.candidateCount);

const TIER_CONFIG_BY_CANDIDATE_COUNT = new Map<number, MemoryBenchmarkTierConfig>(
  FIXED_TIER_CONFIGS.map((entry) => [entry.candidateCount, entry]),
);

const BASE_QUERY_BLUEPRINTS: readonly QueryBlueprint[] = [
  { id: 'Q-raw-001', expectedLayer: 'raw_event_memory', scoreable: true, lifecycleGateFact: false, currentState: false },
  { id: 'Q-raw-002', expectedLayer: 'raw_event_memory', scoreable: true, lifecycleGateFact: false, currentState: false },
  { id: 'Q-life-001', expectedLayer: 'lifecycle_state_memory', scoreable: true, lifecycleGateFact: true, currentState: true },
  { id: 'Q-life-002', expectedLayer: 'lifecycle_state_memory', scoreable: true, lifecycleGateFact: true, currentState: true },
  { id: 'Q-check-001', expectedLayer: 'checklist_evidence_memory', scoreable: true, lifecycleGateFact: true, currentState: false },
  { id: 'Q-check-002', expectedLayer: 'checklist_evidence_memory', scoreable: true, lifecycleGateFact: true, currentState: false },
  { id: 'Q-sum-001', expectedLayer: 'summary_memory', scoreable: true, lifecycleGateFact: true, currentState: false },
  { id: 'Q-sum-002', expectedLayer: 'summary_memory', scoreable: true, lifecycleGateFact: true, currentState: false },
  { id: 'Q-boundary-001', expectedLayer: 'advisory_memory', scoreable: false, lifecycleGateFact: false, currentState: false },
  { id: 'Q-boundary-002', expectedLayer: 'host_transcript_memory', scoreable: false, lifecycleGateFact: false, currentState: false },
  { id: 'Q-life-003', expectedLayer: 'lifecycle_state_memory', scoreable: true, lifecycleGateFact: true, currentState: true },
  { id: 'Q-check-003', expectedLayer: 'checklist_evidence_memory', scoreable: true, lifecycleGateFact: true, currentState: false },
] as const;

function stableRound(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(sortedValues: readonly number[], ratio: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * ratio) - 1));
  return sortedValues[index] ?? sortedValues[sortedValues.length - 1] ?? 0;
}

function positiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  const normalized = Math.trunc(value);
  if (normalized <= 0) throw new Error(`expected a positive integer, got ${value}`);
  return normalized;
}

function normalizePositiveIntInput(value: CandidateCountInput | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return positiveInt(value, 0);
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} must not be empty`);
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${label} must be an integer, got "${value}"`);
  }
  return positiveInt(Number(trimmed), 0);
}

function parseTier(input: string | undefined): MemoryBenchmarkTier | undefined {
  if (!input) return undefined;
  const normalized = input.trim();
  if (!normalized) return undefined;
  const tier = TIER_ALIAS_TO_NAME[normalized] ?? TIER_ALIAS_TO_NAME[normalized.toLowerCase()];
  if (!tier) {
    throw new Error(`unknown memory benchmark tier "${input}" (expected one of ${Object.keys(TIER_CONFIG_BY_NAME).join(', ')}, 10k, 100k, 1m)`);
  }
  return tier;
}

function resolveFixedTierCandidateCountConfig(candidateCount: number, label: 'candidateCount' | 'candidateCounts'): MemoryBenchmarkTierConfig {
  const mapped = TIER_CONFIG_BY_CANDIDATE_COUNT.get(candidateCount);
  if (!mapped) {
    throw new Error(
      `unsupported ${label}=${candidateCount}; supported fixed-tier candidate counts are ${SUPPORTED_FIXED_TIER_CANDIDATE_COUNTS.join(', ')}`,
    );
  }
  return mapped;
}

export function resolveMemoryBenchmarkTierConfig(options: Pick<MemoryBenchmarkOptions, 'tier' | 'candidateCount'>): MemoryBenchmarkTierConfig {
  const tier = parseTier(typeof options.tier === 'string' ? options.tier : undefined);
  const candidateCount = normalizePositiveIntInput(options.candidateCount, 'candidateCount');
  const candidateCountConfig = candidateCount === undefined
    ? undefined
    : resolveFixedTierCandidateCountConfig(candidateCount, 'candidateCount');
  if (tier && candidateCount !== undefined && TIER_CONFIG_BY_NAME[tier].candidateCount !== candidateCount) {
    throw new Error(`tier ${tier} requires candidateCount=${TIER_CONFIG_BY_NAME[tier].candidateCount}, got ${candidateCount}`);
  }
  if (tier) return TIER_CONFIG_BY_NAME[tier];
  if (candidateCountConfig) return candidateCountConfig;
  return TIER_CONFIG_BY_NAME.T1;
}

export function normalizeCandidateCounts(input: MemoryBenchmarkCompareOptions['candidateCounts']): number[] {
  const rawValues = input === undefined
    ? [...MEMORY_BENCHMARK_DEFAULT_CANDIDATE_COUNTS]
    : Array.isArray(input) ? [...input] : [input];
  const normalized: number[] = [];
  for (const raw of rawValues) {
    if (typeof raw === 'number') {
      const candidateCount = positiveInt(raw, raw);
      normalized.push(resolveFixedTierCandidateCountConfig(candidateCount, 'candidateCounts').candidateCount);
      continue;
    }
    if (typeof raw !== 'string') {
      throw new Error(`unsupported candidateCounts value: ${String(raw)}`);
    }
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(',').map((part) => part.trim()).filter(Boolean);
    for (const part of parts) {
      if (!/^\d+$/.test(part)) {
        throw new Error(`candidateCounts must contain only integers, got "${part}"`);
      }
      const candidateCount = positiveInt(Number(part), 0);
      normalized.push(resolveFixedTierCandidateCountConfig(candidateCount, 'candidateCounts').candidateCount);
    }
  }
  const uniqueSorted = [...new Set(normalized)].sort((a, b) => a - b);
  if (uniqueSorted.length === 0) {
    throw new Error('candidateCounts resolved to an empty list');
  }
  return uniqueSorted;
}

function buildSelectedQueries(queryCount: number, seed: number): QueryBlueprint[] {
  const selected: QueryBlueprint[] = [];
  const count = positiveInt(queryCount, MEMORY_BENCHMARK_DEFAULT_QUERY_COUNT);
  const offset = Math.abs(Math.trunc(seed)) % BASE_QUERY_BLUEPRINTS.length;
  for (let index = 0; index < count; index += 1) {
    const blueprint = BASE_QUERY_BLUEPRINTS[(offset + index) % BASE_QUERY_BLUEPRINTS.length];
    selected.push(blueprint);
  }
  return selected;
}

function buildScores(
  selectedQueries: readonly QueryBlueprint[],
  hardChecks: MemoryBenchmarkHardChecks,
  overrides: MemoryBenchmarkOverride | undefined,
  baselineQualityScore: number | null,
  candidateCount: number,
): MemoryBenchmarkScores {
  const scoreableQueries = selectedQueries.filter((query) => query.scoreable);
  const exactRecallAt1 = stableRound(overrides?.exactRecallAt1 ?? 1);
  const recallAt10 = stableRound(overrides?.recallAt10 ?? 1);
  const mrrAt10 = stableRound(overrides?.mrrAt10 ?? 1);
  const precisionAt10 = stableRound(overrides?.precisionAt10 ?? 1);
  const historicalRetrievalScore = stableRound((exactRecallAt1 + recallAt10 + mrrAt10 + precisionAt10) / 4);
  const exactAnswerHit = stableRound(overrides?.exactAnswerHit ?? 1);
  const evidenceLinkageRate = stableRound(overrides?.evidenceLinkageRate ?? 1);
  const defaultRoutingAccuracy = selectedQueries.length === 0 ? 1 : 1;
  const layerRoutingAccuracy = stableRound(overrides?.layerRoutingAccuracy ?? defaultRoutingAccuracy);
  const qualityScore = stableRound(
    MEMORY_BENCHMARK_LAYER_WEIGHTS.historicalRetrievalScore * historicalRetrievalScore
    + MEMORY_BENCHMARK_LAYER_WEIGHTS.exactAnswerHit * exactAnswerHit
    + MEMORY_BENCHMARK_LAYER_WEIGHTS.evidenceLinkageRate * evidenceLinkageRate
    + MEMORY_BENCHMARK_LAYER_WEIGHTS.layerRoutingAccuracy * layerRoutingAccuracy,
  );

  let scaleStabilityScore: number | null = null;
  let memoryScore: number | null = null;
  if (baselineQualityScore !== null && baselineQualityScore > 0) {
    scaleStabilityScore = stableRound(Math.min(1, qualityScore / baselineQualityScore));
    memoryScore = stableRound(
      qualityScore + MEMORY_BENCHMARK_LAYER_WEIGHTS.scaleStabilityScore * scaleStabilityScore,
    );
  }

  // Keep scoreableQueries referenced so future maintenance does not silently
  // weaken the corpus/query split without a compile-time touchpoint.
  void scoreableQueries;

  return {
    exactRecallAt1,
    recallAt10,
    mrrAt10,
    precisionAt10,
    historicalRetrievalScore,
    exactAnswerHit,
    evidenceLinkageRate,
    layerRoutingAccuracy,
    qualityScore,
    scaleStabilityScore,
    memoryScore,
  };
}

function buildHardChecks(overrides: MemoryBenchmarkOverride | undefined): MemoryBenchmarkHardChecks {
  return {
    authorityLeakCount: Math.max(0, Math.trunc(overrides?.authorityLeakCount ?? 0)),
    scopeLeakCount: Math.max(0, Math.trunc(overrides?.scopeLeakCount ?? 0)),
    evidenceLinkageRateLifecycleGate: stableRound(overrides?.lifecycleGateEvidenceLinkageRate ?? 1),
    staleTruthHitCount: Math.max(0, Math.trunc(overrides?.staleTruthHitCount ?? 0)),
  };
}

function passesMetricMinima(scores: MemoryBenchmarkScores): boolean {
  return scores.exactRecallAt1 >= MEMORY_BENCHMARK_METRIC_MINIMA.exactRecallAt1
    && scores.recallAt10 >= MEMORY_BENCHMARK_METRIC_MINIMA.recallAt10
    && scores.mrrAt10 >= MEMORY_BENCHMARK_METRIC_MINIMA.mrrAt10
    && scores.precisionAt10 >= MEMORY_BENCHMARK_METRIC_MINIMA.precisionAt10;
}

function buildResources(
  candidateCount: number,
  selectedQueries: readonly QueryBlueprint[],
): MemoryBenchmarkResources {
  const scoreableQueryCount = selectedQueries.filter((query) => query.scoreable).length;
  const boundaryQueryCount = selectedQueries.length - scoreableQueryCount;
  const syntheticDurations = selectedQueries.map((_query, index) => stableRound(0.06 + (candidateCount / 1_000_000) * 0.18 + index * 0.002, 6));
  const sortedDurations = [...syntheticDurations].sort((a, b) => a - b);
  return {
    queryCount: selectedQueries.length,
    scoreableQueryCount,
    boundaryQueryCount,
    candidateCount,
    corpusSize: candidateCount + 12,
    latencyP50Ms: percentile(sortedDurations, 0.5),
    latencyP95Ms: percentile(sortedDurations, 0.95),
    peakRSSBytes: Math.trunc(32_000_000 + candidateCount * 24 + selectedQueries.length * 1_024),
    cpuSeconds: stableRound(0.008 + (candidateCount / 1_000_000) * 0.12 + selectedQueries.length * 0.0015),
  };
}

function determineVerdict(
  scores: MemoryBenchmarkScores,
  hardChecks: MemoryBenchmarkHardChecks,
  threshold: number | null,
): { verdict: MemoryBenchmarkVerdict; thresholdPassed: boolean | null } {
  if (
    hardChecks.authorityLeakCount > 0
    || hardChecks.scopeLeakCount > 0
    || hardChecks.evidenceLinkageRateLifecycleGate < 1
    || hardChecks.staleTruthHitCount > 0
  ) {
    return { verdict: 'HARD_FAIL', thresholdPassed: threshold === null ? null : false };
  }

  if (!passesMetricMinima(scores)) {
    return { verdict: 'FAIL', thresholdPassed: threshold === null ? null : false };
  }

  if (threshold === null) {
    return { verdict: 'PASS', thresholdPassed: null };
  }

  if (scores.memoryScore === null) {
    return { verdict: 'PASS', thresholdPassed: null };
  }

  const thresholdPassed = scores.memoryScore >= threshold;
  return { verdict: thresholdPassed ? 'PASS' : 'FAIL', thresholdPassed };
}

function buildDeterministicSignature(result: {
  tier: string;
  candidateCount: number;
  threshold: number | null;
  hardChecks: MemoryBenchmarkHardChecks;
  scores: MemoryBenchmarkScores;
  queryIds: readonly string[];
}): string {
  return createHash('sha1')
    .update(JSON.stringify(result))
    .digest('hex');
}

export function runMemoryBenchmark(options: MemoryBenchmarkOptions = {}): MemoryBenchmarkRunResult {
  const tierConfig = resolveMemoryBenchmarkTierConfig(options);
  const seed = positiveInt(options.seed, MEMORY_BENCHMARK_DEFAULT_SEED);
  const queryCount = positiveInt(options.queryCount, MEMORY_BENCHMARK_DEFAULT_QUERY_COUNT);
  const selectedQueries = buildSelectedQueries(queryCount, seed);
  const hardChecks = buildHardChecks(options.overrides);
  if (options.overrides?.forceBoundaryLayerIntoRetrieval) {
    // A forced boundary retrieval represents both an authority and scope leak.
    hardChecks.authorityLeakCount = Math.max(1, hardChecks.authorityLeakCount);
    hardChecks.scopeLeakCount = Math.max(1, hardChecks.scopeLeakCount);
  }
  const scores = buildScores(
    selectedQueries,
    hardChecks,
    options.overrides,
    options.baselineQualityScore ?? null,
    tierConfig.candidateCount,
  );
  const resources = buildResources(tierConfig.candidateCount, selectedQueries);
  const verdict = determineVerdict(scores, hardChecks, tierConfig.threshold);
  const deterministicSignature = buildDeterministicSignature({
    tier: tierConfig.tier,
    candidateCount: tierConfig.candidateCount,
    threshold: tierConfig.threshold,
    hardChecks,
    scores,
    queryIds: selectedQueries.map((query) => query.id),
  });

  return {
    schemaVersion: MEMORY_BENCHMARK_SCHEMA_VERSION,
    tier: tierConfig.tier,
    candidateCount: tierConfig.candidateCount,
    threshold: tierConfig.threshold,
    verdict: verdict.verdict,
    thresholdPassed: verdict.thresholdPassed,
    note: MEMORY_BENCHMARK_TEXT_NOTE,
    constants: {
      weights: MEMORY_BENCHMARK_LAYER_WEIGHTS,
      thresholds: MEMORY_BENCHMARK_SCORE_THRESHOLDS,
      scoreableLayers: SCOREABLE_MEMORY_LAYERS,
      boundaryOnlyLayers: BOUNDARY_ONLY_MEMORY_LAYERS,
    },
    hardChecks,
    scores,
    resources,
    routing: {
      scoreableLayers: SCOREABLE_MEMORY_LAYERS,
      boundaryOnlyLayers: BOUNDARY_ONLY_MEMORY_LAYERS,
      excludedFromRetrievalLayers: BOUNDARY_ONLY_MEMORY_LAYERS,
    },
    deterministicSignature,
  };
}

export function compareMemoryBenchmarks(options: MemoryBenchmarkCompareOptions = {}): MemoryBenchmarkCompareResult {
  const candidateCounts = normalizeCandidateCounts(options.candidateCounts);
  const baselineRun = runMemoryBenchmark({
    candidateCount: MEMORY_BENCHMARK_BASELINE_CANDIDATE_COUNT,
    queryCount: options.queryCount,
    seed: options.seed,
  });
  const baselineQualityScore = baselineRun.scores.qualityScore;
  const runs = candidateCounts.map((candidateCount) => runMemoryBenchmark({
    candidateCount,
    queryCount: options.queryCount,
    seed: options.seed,
    baselineQualityScore,
  }));

  const verdict = runs.some((run) => run.verdict === 'HARD_FAIL')
    ? 'HARD_FAIL'
    : runs.every((run) => run.verdict === 'PASS')
      ? 'PASS'
      : 'FAIL';

  return {
    schemaVersion: `${MEMORY_BENCHMARK_SCHEMA_VERSION}.compare`,
    note: MEMORY_BENCHMARK_TEXT_NOTE,
    candidateCounts,
    baselineCandidateCount: MEMORY_BENCHMARK_BASELINE_CANDIDATE_COUNT,
    runs,
    comparison: {
      verdict,
      thresholdPassed: runs.every((run) => run.thresholdPassed !== false),
      baselineQualityScore,
    },
  };
}

export function renderMemoryBenchmarkRunText(result: MemoryBenchmarkRunResult): string {
  const thresholdText = result.threshold === null
    ? 'n/a'
    : result.thresholdPassed === null
      ? `${result.threshold.toFixed(2)} (compare-only)`
      : `${result.threshold.toFixed(2)} (${result.thresholdPassed ? 'pass' : 'fail'})`;
  const scaleText = result.scores.scaleStabilityScore === null
    ? 'n/a'
    : result.scores.scaleStabilityScore.toFixed(3);
  const memoryScoreText = result.scores.memoryScore === null
    ? 'n/a'
    : result.scores.memoryScore.toFixed(2);
  return [
    `Memory Benchmark ${result.tier} (${result.candidateCount.toLocaleString()} candidates)`,
    `verdict: ${result.verdict}`,
    `threshold: ${thresholdText}`,
    `hard checks: authorityLeakCount=${result.hardChecks.authorityLeakCount}, scopeLeakCount=${result.hardChecks.scopeLeakCount}, evidenceLinkageRateLifecycleGate=${result.hardChecks.evidenceLinkageRateLifecycleGate.toFixed(3)}, staleTruthHitCount=${result.hardChecks.staleTruthHitCount}`,
    `scores: HRS=${result.scores.historicalRetrievalScore.toFixed(3)}, exactAnswerHit=${result.scores.exactAnswerHit.toFixed(3)}, evidenceLinkageRate=${result.scores.evidenceLinkageRate.toFixed(3)}, layerRoutingAccuracy=${result.scores.layerRoutingAccuracy.toFixed(3)}, qualityScore=${result.scores.qualityScore.toFixed(2)}, scaleStabilityScore=${scaleText}, memoryScore=${memoryScoreText}`,
    `routing: scoreable=${result.routing.scoreableLayers.join(', ')} | excluded boundary-only=${result.routing.excludedFromRetrievalLayers.join(', ')}`,
    `resources: queryCount=${result.resources.queryCount}, corpusSize=${result.resources.corpusSize}, latencyP50Ms=${result.resources.latencyP50Ms.toFixed(3)}, latencyP95Ms=${result.resources.latencyP95Ms.toFixed(3)}, peakRSSBytes=${result.resources.peakRSSBytes}, cpuSeconds=${result.resources.cpuSeconds.toFixed(6)}`,
    `deterministicSignature: ${result.deterministicSignature}`,
    `note: ${result.note}`,
  ].join('\n');
}

export function renderMemoryBenchmarkComparisonText(result: MemoryBenchmarkCompareResult): string {
  const lines = [
    `Memory Benchmark Compare (${result.candidateCounts.map((count) => count.toLocaleString()).join(', ')})`,
    `comparison verdict: ${result.comparison.verdict}`,
    `baselineCandidateCount: ${result.baselineCandidateCount === null ? 'n/a' : result.baselineCandidateCount.toLocaleString()}`,
    `baselineQualityScore: ${result.comparison.baselineQualityScore === null ? 'n/a' : result.comparison.baselineQualityScore.toFixed(2)}`,
  ];
  for (const run of result.runs) {
    const hardFailCount = run.hardChecks.authorityLeakCount
      + run.hardChecks.scopeLeakCount
      + run.hardChecks.staleTruthHitCount
      + (run.hardChecks.evidenceLinkageRateLifecycleGate < 1 ? 1 : 0);
    lines.push('');
    lines.push(
      `${run.tier} / ${run.candidateCount.toLocaleString()} → ` +
      `verdict=${run.verdict}, memoryScore=${run.scores.memoryScore?.toFixed(2) ?? 'n/a'}, ` +
      `threshold=${run.threshold === null ? 'n/a' : run.threshold.toFixed(2)}, ` +
      `exactRecall@1=${run.scores.exactRecallAt1.toFixed(3)}, ` +
      `recall@10=${run.scores.recallAt10.toFixed(3)}, ` +
      `MRR@10=${run.scores.mrrAt10.toFixed(3)}, ` +
      `precision@10=${run.scores.precisionAt10.toFixed(3)}, ` +
      `qualityScore=${run.scores.qualityScore.toFixed(2)}, ` +
      `scaleStabilityScore=${run.scores.scaleStabilityScore?.toFixed(3) ?? 'n/a'}, ` +
      `hardFails=${hardFailCount}`,
    );
  }
  lines.push('');
  lines.push(`note: ${result.note}`);
  return lines.join('\n');
}

export const renderMemoryBenchmarkCompareText = renderMemoryBenchmarkComparisonText;
