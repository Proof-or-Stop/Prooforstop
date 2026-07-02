import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { resolveGlobalMemoryPath, resolveProjectMemoryPath, writeEntries, type DevMemoryEntry } from './dev-memory.js';
import { digestCanonicalJson, digestText } from './digest.js';
import type { Playbook, PlaybookStatus } from './experience-layer-types.js';
import { writePlaybooks, writeSignatureRegistry, type SignatureRegistryData } from './learning-store.js';
import {
  buildMemoryFreshnessPack,
  classifyMemoryFreshnessPack,
  type BuildMemoryFreshnessPackOptions,
  type MemoryFreshnessClass,
  type MemoryFreshnessPack,
} from './playbook-runtime-memory.js';
import {
  clearRuntimeMemoryPackCache,
  getRuntimeMemoryPackCacheStats,
  type RuntimeMemoryPackCacheStats,
} from './playbook-runtime-memory-cache.js';
import {
  rebuildRuntimeMemoryIndex,
  getRuntimeMemoryIndexCandidateStats,
  resetRuntimeMemoryIndexCandidateStats,
  type RuntimeMemoryIndexCandidateStats,
  type RuntimeMemoryIndex,
} from './playbook-runtime-memory-index.js';

export type PlaybookRuntimeBaselineProfile = 'small' | 'full';

export interface PlaybookRuntimeBaselineManifest {
  schemaVersion: 'proofbound.memory-playbook-baseline.v1';
  profile: PlaybookRuntimeBaselineProfile;
  seed: number;
  recordCount: number;
  partitionCounts: Record<BaselinePartition, number>;
  fullProfileExactMillion: boolean;
  recordsDigest: string;
  goldDigest: string;
  corruptRows: number;
  manifestDigest: string;
  authority: 'non_authoritative';
  gateEvidence: false;
}

export interface PlaybookRuntimeBaselineGenerateResult {
  outputDir: string;
  recordsPath: string;
  goldPath: string;
  manifestPath: string;
  manifest: PlaybookRuntimeBaselineManifest;
}

export interface PlaybookRuntimeBaselineVerifyResult {
  status: 'pass' | 'fail';
  inputDir: string;
  generatedInput: boolean;
  generatedOutputKept: boolean;
  profile: PlaybookRuntimeBaselineProfile;
  requestedProfile?: PlaybookRuntimeBaselineProfile;
  recordCount: number;
  expectedProfileRecordCount: number;
  fullProfileExactMillion: boolean;
  requestedProfileMatches: boolean;
  profileRecordCountMatches: boolean;
  fullProfileExactMillionMatches: boolean;
  recordsDigestStable: boolean;
  goldDigestStable: boolean;
  manifestDigestStable: boolean;
  staleDetected: boolean;
  correctness: {
    expectedIdsFoundRate: number;
    goldQueryPresenceRate: number;
    goldRecordPresenceRate: number;
    expectedSuppressedIdsFoundRate: number;
    expectedDeprecatedTermHitsFoundRate: number;
    currentOverSupersededPreferenceRate: number;
    candidateFalseSurfaceRate: number;
    supersededFalseSurfaceRate: number;
    deprecatedFalseSurfaceRate: number;
    malformedRowsSkipped: number;
    partitionContractPass: boolean;
    sourceDigestMutationMatrixPass: boolean;
  };
  thresholds: {
    expectedIdsFoundRate: number;
    goldQueryPresenceRate: number;
    goldRecordPresenceRate: number;
    expectedSuppressedIdsFoundRate: number;
    expectedDeprecatedTermHitsFoundRate: number;
    currentOverSupersededPreferenceRate: number;
    candidateFalseSurfaceRateMax: number;
    supersededFalseSurfaceRateMax: number;
    deprecatedFalseSurfaceRateMax: number;
  };
  sourceDigestMutationMatrix: SourceDigestMutationMatrixResult;
  performance: {
    elapsedMs: number;
    peakRssBytes: number;
    peakHeapUsedBytes: number;
  };
  authority: 'non_authoritative';
  gateEvidence: false;
}

interface BaselineRecord {
  id: string;
  kind: 'memory' | 'playbook';
  status: string;
  text: string;
  partition?: BaselinePartition;
  recordClass?: BaselineRecordClass;
  supersedes?: string[];
}

export type BaselinePartition =
  | 'general-irrelevant'
  | 'tool-workflow'
  | 'supersession'
  | 'host-policy'
  | 'stale-doc'
  | 'repro-first'
  | 'parent-roadmap'
  | 'playbook-candidates'
  | 'active-playbooks'
  | 'malformed-adversarial';

export type BaselineRecordClass =
  | 'host-policy'
  | 'truth-first'
  | 'intent-totality'
  | 'repro-first'
  | 'candidate-only'
  | 'source-digest-mutation'
  | 'superseded-default'
  | 'deprecated-brand-residue'
  | 'noise';

interface BaselineGoldRecord extends BaselineRecord {
  id: string;
  kind: 'memory' | 'playbook';
  status: string;
  text: string;
  partition: BaselinePartition;
  recordClass: BaselineRecordClass;
}

interface BaselineGoldQuery {
  id: string;
  query: string;
  expectedIds: readonly string[];
  mustNotSurfaceIds: readonly string[];
  expectedSuppressedIds?: readonly string[];
  expectedDeprecatedTermHits?: readonly string[];
  supersededPreference?: {
    currentId: string;
    supersededId: string;
  };
}

interface RuntimeGoldQueryResult {
  queryId: string;
  surfacedIds: string[];
  suppressedSupersededIds: string[];
  deprecatedTermHits: string[];
  expectedIdsFound: number;
  expectedSuppressedIdsFound: number;
  expectedDeprecatedTermHitsFound: number;
  candidateFalseSurfaces: number;
  supersededFalseSurfaces: number;
  deprecatedFalseSurfaces: number;
  mustNotSurfaceTotal: number;
  currentOverSupersededPreferencePass: boolean;
  missingExpectedIds: string[];
  unexpectedSurfacedIds: string[];
}

export interface SourceDigestMutationMatrixResult {
  projectMemoryRelevant: MemoryFreshnessClass;
  projectMemoryIrrelevant: MemoryFreshnessClass;
  globalMemoryRelevant: MemoryFreshnessClass;
  globalMemoryIrrelevant: MemoryFreshnessClass;
  playbookRelevant: MemoryFreshnessClass;
  playbookIrrelevant: MemoryFreshnessClass;
  signatureRegistryRelevant: MemoryFreshnessClass;
  signatureRegistryIrrelevant: MemoryFreshnessClass;
  initialSurfacePass: boolean;
  pass: boolean;
}

export interface PlaybookRuntimeOptimizedParityReport {
  schemaVersion: 'proofbound.memory-playbook-optimized-parity.v1';
  profile: PlaybookRuntimeBaselineProfile;
  recordCount: number;
  queryCount: number;
  referenceFullScanMs: number;
  indexedColdMs: number;
  indexedWarmCacheMs: number;
  targetWarmMs: number;
  targetStatus: 'met' | 'unmet';
  performancePolicy: 'report-first';
  parityPass: boolean;
  referenceResultDigest: string;
  indexedColdResultDigest: string;
  indexedWarmCacheResultDigest: string;
  resultDigestSource: 'MemoryFreshnessPack';
  runtimeCorpus: {
    sourceRecordCount: number;
    devMemoryRecordCount: number;
    playbookRecordCount: number;
    malformedRowsSkipped: number;
    fullCorpusMaterialized: boolean;
  };
  indexedColdUsesRuntimeIndex: boolean;
  indexedColdRuntimeIndexRecordCounts: RuntimeMemoryIndex['manifest']['recordCounts'];
  warmCacheStats: RuntimeMemoryPackCacheStats;
  cacheHitRate: number;
  latency: {
    p50Ms: number;
    p95Ms: number;
  };
  timingBreakdown: {
    corpusMaterializeMs: number;
    indexBuildMs: number;
    referenceQueryMs: number;
    indexedColdQueryMs: number;
    warmPrimeQueryMs: number;
    indexedWarmQueryMs: number;
    queryCount: number;
    tokenMatching: {
      indexedCold: RuntimeMemoryIndexCandidateStats;
      warmPrime: RuntimeMemoryIndexCandidateStats;
      indexedWarm: RuntimeMemoryIndexCandidateStats;
    };
    cache: RuntimeMemoryPackCacheStats;
  };
  performance: {
    peakRssBytes: number;
    peakHeapUsedBytes: number;
  };
  authority: 'non_authoritative';
  gateEvidence: false;
}

const PROFILE_COUNTS: Record<PlaybookRuntimeBaselineProfile, number> = {
  small: 1_000,
  full: 1_000_000,
};

const BASELINE_RUNTIME_SHORTLIST_LIMIT = 96;
const BASELINE_RUNTIME_FIXED_TIME = '2026-07-01T00:00:00.000Z';
const BASELINE_DEPRECATED_BRAND_MARKER = 'deprecated-brand-marker';
const BASELINE_DEPRECATED_BRAND_ALIAS = 'legacy-brand-marker';

const BASELINE_PARTITIONS: readonly BaselinePartition[] = [
  'general-irrelevant',
  'tool-workflow',
  'supersession',
  'host-policy',
  'stale-doc',
  'repro-first',
  'parent-roadmap',
  'playbook-candidates',
  'active-playbooks',
  'malformed-adversarial',
];

const BASELINE_PARTITION_SMALL_COUNTS: Record<BaselinePartition, number> = {
  'general-irrelevant': 520,
  'tool-workflow': 120,
  supersession: 100,
  'host-policy': 60,
  'stale-doc': 60,
  'repro-first': 50,
  'parent-roadmap': 40,
  'playbook-candidates': 30,
  'active-playbooks': 15,
  'malformed-adversarial': 5,
};

const GOLD_QUERIES: readonly BaselineGoldQuery[] = [
  {
    id: 'host-policy',
    query: 'codex cli claude code agy fallback unavailable quota limited',
    expectedIds: ['mem-host-current', 'pb-host-policy-active'],
    mustNotSurfaceIds: ['pb-host-policy-candidate'],
  },
  {
    id: 'truth-first',
    query: 'old plan says task missing but current facts are done',
    expectedIds: ['mem-truth-current', 'pb-truth-first-active'],
    mustNotSurfaceIds: ['mem-truth-superseded'],
    expectedSuppressedIds: ['mem-truth-superseded'],
    supersededPreference: { currentId: 'mem-truth-current', supersededId: 'mem-truth-superseded' },
  },
  {
    id: 'intent-totality',
    query: 'parent roadmap all milestones complete delivery closure',
    expectedIds: ['mem-parent-totality-current', 'pb-intent-totality-active'],
    mustNotSurfaceIds: ['pb-parent-candidate'],
  },
  {
    id: 'repro-first',
    query: 'repro first red failure before fixing story',
    expectedIds: ['mem-repro-first-current', 'pb-repro-first-active'],
    mustNotSurfaceIds: [],
  },
  {
    id: 'candidate-only',
    query: 'playbook candidate only inert runtime guidance boundary',
    expectedIds: ['mem-candidate-only-boundary'],
    mustNotSurfaceIds: ['pb-candidate-only'],
  },
  {
    id: 'source-digest-mutation',
    query: 'memory pack stale digest source mutation matrix project global playbook signature',
    expectedIds: ['mem-source-mutation-current', 'pb-source-mutation-active'],
    mustNotSurfaceIds: [],
  },
  {
    id: 'superseded-default',
    query: 'superseded memory default old lesson latest replacement',
    expectedIds: ['mem-superseded-default-current'],
    mustNotSurfaceIds: ['mem-superseded-default-old'],
    expectedSuppressedIds: ['mem-superseded-default-old'],
    supersededPreference: { currentId: 'mem-superseded-default-current', supersededId: 'mem-superseded-default-old' },
  },
  {
    id: 'deprecated-brand-residue',
    query: `deprecated brand residue ${BASELINE_DEPRECATED_BRAND_MARKER} scanner current proofbound guidance`,
    expectedIds: ['mem-deprecated-brand-current'],
    mustNotSurfaceIds: ['mem-deprecated-brand-residue', 'pb-deprecated-brand-residue-candidate'],
    expectedSuppressedIds: ['mem-deprecated-brand-residue'],
    expectedDeprecatedTermHits: [BASELINE_DEPRECATED_BRAND_MARKER],
    supersededPreference: { currentId: 'mem-deprecated-brand-current', supersededId: 'mem-deprecated-brand-residue' },
  },
];

const GOLD_RECORDS: readonly BaselineGoldRecord[] = [
  {
    id: 'mem-host-current',
    kind: 'memory',
    status: 'current',
    partition: 'host-policy',
    recordClass: 'host-policy',
    text: 'host-policy codex-cli claude-cli agy fallback unavailable quota-limited timed-out explicit substitute primary hosts',
  },
  {
    id: 'pb-host-policy-active',
    kind: 'playbook',
    status: 'active',
    partition: 'active-playbooks',
    recordClass: 'host-policy',
    text: 'host-policy codex-cli claude-cli agy-cli fallback only primary failure signal',
  },
  {
    id: 'pb-host-policy-candidate',
    kind: 'playbook',
    status: 'candidate',
    partition: 'playbook-candidates',
    recordClass: 'host-policy',
    text: 'candidate agy fallback should not surface',
  },
  {
    id: 'mem-truth-current',
    kind: 'memory',
    status: 'current',
    partition: 'stale-doc',
    recordClass: 'truth-first',
    text: 'truth-first stale-doc current facts beat old planning prose',
    supersedes: ['mem-truth-superseded'],
  },
  {
    id: 'mem-truth-superseded',
    kind: 'memory',
    status: 'superseded',
    partition: 'supersession',
    recordClass: 'truth-first',
    text: 'old stale-doc plan superseded by current facts',
  },
  {
    id: 'pb-truth-first-active',
    kind: 'playbook',
    status: 'active',
    partition: 'active-playbooks',
    recordClass: 'truth-first',
    text: 'truth-first stale-doc current structured facts before claiming missing work',
  },
  {
    id: 'mem-parent-totality-current',
    kind: 'memory',
    status: 'current',
    partition: 'parent-roadmap',
    recordClass: 'intent-totality',
    text: 'parent roadmap intent-totality delivery all milestones structured rollup',
  },
  {
    id: 'pb-intent-totality-active',
    kind: 'playbook',
    status: 'active',
    partition: 'active-playbooks',
    recordClass: 'intent-totality',
    text: 'intent-totality delivery parent roadmap ParentRollupResult current facts',
  },
  {
    id: 'pb-parent-candidate',
    kind: 'playbook',
    status: 'candidate',
    partition: 'playbook-candidates',
    recordClass: 'intent-totality',
    text: 'candidate parent roadmap totality should not surface',
  },
  {
    id: 'mem-repro-first-current',
    kind: 'memory',
    status: 'current',
    partition: 'repro-first',
    recordClass: 'repro-first',
    text: 'repro-first red failing evidence before fix story intake',
  },
  {
    id: 'pb-repro-first-active',
    kind: 'playbook',
    status: 'active',
    partition: 'active-playbooks',
    recordClass: 'repro-first',
    text: 'repro-first story intake red green relation verification',
  },
  {
    id: 'mem-candidate-only-boundary',
    kind: 'memory',
    status: 'current',
    partition: 'playbook-candidates',
    recordClass: 'candidate-only',
    text: 'playbook candidate only inert runtime guidance boundary candidates remain non authoritative',
  },
  {
    id: 'pb-candidate-only',
    kind: 'playbook',
    status: 'candidate',
    partition: 'playbook-candidates',
    recordClass: 'candidate-only',
    text: 'playbook candidate only should never surface as active runtime guidance',
  },
  {
    id: 'mem-source-mutation-current',
    kind: 'memory',
    status: 'current',
    partition: 'tool-workflow',
    recordClass: 'source-digest-mutation',
    text: 'memory pack stale digest source mutation matrix project global playbook signature relevant row',
  },
  {
    id: 'pb-source-mutation-active',
    kind: 'playbook',
    status: 'active',
    partition: 'active-playbooks',
    recordClass: 'source-digest-mutation',
    text: 'memory pack stale digest source mutation matrix active playbook row',
  },
  {
    id: 'mem-superseded-default-current',
    kind: 'memory',
    status: 'current',
    partition: 'supersession',
    recordClass: 'superseded-default',
    text: 'superseded memory default latest replacement inherits old lesson query',
    supersedes: ['mem-superseded-default-old'],
  },
  {
    id: 'mem-superseded-default-old',
    kind: 'memory',
    status: 'superseded',
    partition: 'supersession',
    recordClass: 'superseded-default',
    text: 'superseded memory default old lesson should be suppressed by default',
  },
  {
    id: 'mem-deprecated-brand-current',
    kind: 'memory',
    status: 'current',
    partition: 'stale-doc',
    recordClass: 'deprecated-brand-residue',
    text: `deprecated brand residue ${BASELINE_DEPRECATED_BRAND_MARKER} scanner says use current proofbound guidance not legacy brand defaults`,
    supersedes: ['mem-deprecated-brand-residue'],
  },
  {
    id: 'mem-deprecated-brand-residue',
    kind: 'memory',
    status: 'deprecated',
    partition: 'malformed-adversarial',
    recordClass: 'deprecated-brand-residue',
    text: `deprecated brand residue ${BASELINE_DEPRECATED_BRAND_MARKER} legacy default should not surface as current guidance`,
  },
  {
    id: 'pb-deprecated-brand-residue-candidate',
    kind: 'playbook',
    status: 'candidate',
    partition: 'playbook-candidates',
    recordClass: 'deprecated-brand-residue',
    text: `deprecated brand residue ${BASELINE_DEPRECATED_BRAND_MARKER} candidate should remain inert scanner input`,
  },
];

const GOLD_RECORD_IDS = new Set(GOLD_RECORDS.map((record) => record.id));

const BASELINE_SIGNATURE_REGISTRY: SignatureRegistryData = {
  tags: [
    {
      tag: BASELINE_DEPRECATED_BRAND_MARKER,
      status: 'deprecated',
      aliases: [BASELINE_DEPRECATED_BRAND_ALIAS],
      mergedInto: 'proofbound',
      createdBy: 'playbook-runtime-baseline',
      approvedBy: null,
    },
    {
      tag: 'proofbound',
      status: 'active',
      aliases: [],
      mergedInto: null,
      createdBy: 'playbook-runtime-baseline',
      approvedBy: 'playbook-runtime-baseline',
    },
  ],
};

function outputDirFor(profile: PlaybookRuntimeBaselineProfile, outputDir?: string): string {
  if (outputDir) return outputDir;
  return mkdtempSync(join(tmpdir(), `proofbound-memory-playbook-${profile}-`));
}

function ensureBaselineOutputWritable(outputDir: string, targetPaths: string[], force?: boolean): void {
  if (!existsSync(outputDir)) {
    const existingTargets = targetPaths.filter(existsSync);
    if (existingTargets.length > 0 && !force) {
      throw new Error(`baseline output target file already exists: ${existingTargets.join(', ')}`);
    }
    return;
  }

  if (force) {
    rmSync(outputDir, { recursive: true, force: true });
    return;
  }

  const stats = statSync(outputDir);
  if (!stats.isDirectory()) {
    throw new Error(`baseline output already exists and is not a directory: ${outputDir}`);
  }
  const entries = readdirSync(outputDir);
  const existingTargets = targetPaths.filter(existsSync);
  if (entries.length > 0 || existingTargets.length > 0) {
    const blockers = existingTargets.length > 0 ? existingTargets : entries.map((entry) => join(outputDir, entry));
    throw new Error(`baseline output directory must be empty unless force=true: ${blockers.join(', ')}`);
  }
}

function emptyPartitionCounts(): Record<BaselinePartition, number> {
  return Object.fromEntries(BASELINE_PARTITIONS.map((partition) => [partition, 0])) as Record<BaselinePartition, number>;
}

function partitionCountsFor(profile: PlaybookRuntimeBaselineProfile): Record<BaselinePartition, number> {
  const multiplier = profile === 'full' ? 1000 : 1;
  return Object.fromEntries(
    BASELINE_PARTITIONS.map((partition) => [partition, BASELINE_PARTITION_SMALL_COUNTS[partition] * multiplier]),
  ) as Record<BaselinePartition, number>;
}

function isBaselinePartition(value: unknown): value is BaselinePartition {
  return typeof value === 'string' && (BASELINE_PARTITIONS as readonly string[]).includes(value);
}

function isBaselineRecordClass(value: unknown): value is BaselineRecordClass {
  return typeof value === 'string'
    && [
      'host-policy',
      'truth-first',
      'intent-totality',
      'repro-first',
      'candidate-only',
      'source-digest-mutation',
      'superseded-default',
      'deprecated-brand-residue',
      'noise',
    ].includes(value);
}

function recordLine(record: BaselineRecord): string {
  return JSON.stringify({
    id: record.id,
    kind: record.kind,
    status: record.status,
    text: record.text,
    ...(record.partition ? { partition: record.partition } : {}),
    ...(record.recordClass ? { recordClass: record.recordClass } : {}),
    ...(record.supersedes ? { supersedes: record.supersedes } : {}),
  });
}

function malformedRecordLine(index: number): string {
  return `{"id":"corrupt-row-${index}","partition":"malformed-adversarial","kind":`;
}

function noiseRecord(partition: BaselinePartition, globalIndex: number, partitionIndex: number): string {
  const id = `noise-${partition}-${partitionIndex}`;
  switch (partition) {
    case 'general-irrelevant':
      return recordLine({
        id,
        kind: 'memory',
        status: 'current',
        partition,
        recordClass: 'noise',
        text: `ordinary unrelated memory garden row ${globalIndex}`,
      });
    case 'tool-workflow':
      return recordLine({
        id,
        kind: 'memory',
        status: 'current',
        partition,
        recordClass: 'noise',
        text: `tool workflow reusable note deterministic row ${globalIndex}`,
      });
    case 'supersession': {
      const pair = Math.floor(partitionIndex / 2);
      const oldId = `noise-supersession-old-${pair}`;
      if (partitionIndex % 2 === 0) {
        return recordLine({
          id: oldId,
          kind: 'memory',
          status: 'superseded',
          partition,
          recordClass: 'noise',
          text: `historical supersession chain row ${pair} legacy detail`,
        });
      }
      return recordLine({
        id: `noise-supersession-current-${pair}`,
        kind: 'memory',
        status: 'current',
        partition,
        recordClass: 'noise',
        text: `current supersession chain row ${pair} replacement detail`,
        supersedes: [oldId],
      });
    }
    case 'host-policy':
      return recordLine({
        id,
        kind: 'memory',
        status: 'current',
        partition,
        recordClass: 'noise',
        text: `host operational policy unrelated baseline row ${globalIndex}`,
      });
    case 'stale-doc':
      return recordLine({
        id,
        kind: 'memory',
        status: 'current',
        partition,
        recordClass: 'noise',
        text: `stale document truth ordering unrelated row ${globalIndex}`,
      });
    case 'repro-first':
      return recordLine({
        id,
        kind: 'memory',
        status: 'current',
        partition,
        recordClass: 'noise',
        text: `red repro intake unrelated row ${globalIndex}`,
      });
    case 'parent-roadmap':
      return recordLine({
        id,
        kind: 'memory',
        status: 'current',
        partition,
        recordClass: 'noise',
        text: `parent roadmap partial milestone unrelated row ${globalIndex}`,
      });
    case 'playbook-candidates':
      return recordLine({
        id,
        kind: 'playbook',
        status: 'candidate',
        partition,
        recordClass: 'noise',
        text: `candidate-only inert partition row ${globalIndex}`,
      });
    case 'active-playbooks':
      return recordLine({
        id,
        kind: 'playbook',
        status: 'active',
        partition,
        recordClass: 'noise',
        text: `active runtime guidance unrelated partition row ${globalIndex}`,
      });
    case 'malformed-adversarial':
      return recordLine({
        id,
        kind: partitionIndex % 2 === 0 ? 'memory' : 'playbook',
        status: partitionIndex % 2 === 0 ? 'deprecated' : 'archived',
        partition,
        recordClass: 'noise',
        text: `malformed adversarial deprecated residue decoy row ${globalIndex}`,
      });
  }
}

function buildBaselineRows(profile: PlaybookRuntimeBaselineProfile): {
  rows: string[];
  partitionCounts: Record<BaselinePartition, number>;
  corruptRows: number;
} {
  const targetPartitionCounts = partitionCountsFor(profile);
  const emittedPartitionCounts = emptyPartitionCounts();
  const rows: string[] = [];
  let corruptRows = 0;

  const emit = (partition: BaselinePartition, line: string): void => {
    emittedPartitionCounts[partition] += 1;
    rows.push(line);
  };

  for (const record of GOLD_RECORDS) {
    if (emittedPartitionCounts[record.partition] >= targetPartitionCounts[record.partition]) {
      throw new Error(`baseline gold records exceed ${record.partition} partition count`);
    }
    emit(record.partition, recordLine(record));
  }

  const corruptRowsTarget = profile === 'full' ? 5 : 1;
  for (const partition of BASELINE_PARTITIONS) {
    while (emittedPartitionCounts[partition] < targetPartitionCounts[partition]) {
      const partitionIndex = emittedPartitionCounts[partition];
      if (partition === 'malformed-adversarial' && corruptRows < corruptRowsTarget) {
        emit(partition, malformedRecordLine(corruptRows));
        corruptRows += 1;
        continue;
      }
      emit(partition, noiseRecord(partition, rows.length, partitionIndex));
    }
  }

  return { rows, partitionCounts: emittedPartitionCounts, corruptRows };
}

function parseBaselineRecord(line: string): BaselineRecord | null {
  try {
    const parsed = JSON.parse(line) as Partial<BaselineRecord>;
    if (
      typeof parsed.id !== 'string'
      || (parsed.kind !== 'memory' && parsed.kind !== 'playbook')
      || typeof parsed.status !== 'string'
      || typeof parsed.text !== 'string'
    ) {
      return null;
    }
      return {
        id: parsed.id,
        kind: parsed.kind,
        status: parsed.status,
        text: parsed.text,
        ...(isBaselinePartition(parsed.partition) ? { partition: parsed.partition } : {}),
        ...(isBaselineRecordClass(parsed.recordClass) ? { recordClass: parsed.recordClass } : {}),
        ...(Array.isArray(parsed.supersedes)
          ? { supersedes: parsed.supersedes.filter((value): value is string => typeof value === 'string' && value.trim().length > 0) }
          : {}),
      };
  } catch {
    return null;
  }
}

function baselineTokens(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9._-]{1,}/g) ?? []))].sort();
}

function baselineRecordScore(query: string, record: BaselineRecord): number {
  const haystack = `${record.id} ${record.kind} ${record.status} ${record.text}`.toLowerCase();
  return baselineTokens(query).reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function insertScoredRecord(
  shortlist: Array<{ record: BaselineRecord; score: number }>,
  record: BaselineRecord,
  score: number,
): void {
  if (score <= 0) return;
  shortlist.push({ record, score });
  shortlist.sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));
  if (shortlist.length > BASELINE_RUNTIME_SHORTLIST_LIMIT) shortlist.length = BASELINE_RUNTIME_SHORTLIST_LIMIT;
}

function memoryEntryFromBaseline(record: BaselineRecord): DevMemoryEntry {
  return {
    id: record.id,
    createdAt: BASELINE_RUNTIME_FIXED_TIME,
    sourceAgent: 'playbook-runtime-baseline',
    category: 'workflow',
    scope: 'project',
    summary: record.text,
    trigger: record.text,
    lesson: record.text,
    reusePrompt: record.text,
    tags: (record.supersedes ?? []).map((id) => `supersedes-${id}`),
    evidenceRefs: [`baseline-record:${record.id}`],
    gateEvidence: false,
    authority: 'non_authoritative',
  };
}

function playbookStatusFromBaseline(status: string): PlaybookStatus {
  if (status === 'active' || status === 'candidate' || status === 'proposed' || status === 'stale' || status === 'archived') {
    return status;
  }
  return 'stale';
}

function playbookFromBaseline(record: BaselineRecord): Playbook {
  const keywords = baselineTokens(`${record.id} ${record.text}`).slice(0, 20);
  return {
    id: record.id,
    title: `${record.id} baseline playbook`,
    trigger: {
      keywords,
      fileKinds: ['ts'],
      storyPhases: ['DEV', 'TEST', 'DONE'],
    },
    check: record.text,
    pitfalls: [`Do not surface inactive baseline row ${record.id}.`],
    verification: [`Runtime baseline query must rank ${record.id} according to active status.`],
    lineage: {
      sourceStoryId: 'B-baseline',
      sourceFindingId: 'F-baseline',
      sourceSignature: record.id,
    },
    status: playbookStatusFromBaseline(record.status),
    usage: { surfacedCount: 0, resolvedHits: 0, dismissedHits: 0 },
  };
}

function withIsolatedGlobalMemory<T>(fn: () => T): T {
  const previous = process.env.LATTICE_GLOBAL_MEMORY_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'proofbound-memory-baseline-global-'));
  process.env.LATTICE_GLOBAL_MEMORY_DIR = dir;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.LATTICE_GLOBAL_MEMORY_DIR;
    } else {
      process.env.LATTICE_GLOBAL_MEMORY_DIR = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function runRuntimeGoldQuery(
  query: BaselineGoldQuery,
  shortlist: BaselineRecord[],
  allStatusById: Map<string, string>,
  allClassById: Map<string, BaselineRecordClass>,
): RuntimeGoldQueryResult {
  const root = mkdtempSync(join(tmpdir(), 'proofbound-memory-baseline-runtime-'));
  try {
    const memoryEntries = shortlist
      .filter((record) => record.kind === 'memory')
      .map(memoryEntryFromBaseline);
    const playbooks = shortlist
      .filter((record) => record.kind === 'playbook')
      .map(playbookFromBaseline);
    writeEntries(resolveProjectMemoryPath(root), memoryEntries);
    writePlaybooks(root, playbooks);
    writeSignatureRegistry(root, BASELINE_SIGNATURE_REGISTRY);
    const pack = withIsolatedGlobalMemory(() => buildMemoryFreshnessPack({
      projectRoot: root,
      consumer: 'session_brief',
      query: query.query,
      touchedPaths: ['packages/main/src/baseline.ts'],
      storyPhase: 'TEST',
      maxEntries: 20,
      maxPlaybooks: 20,
      maxLines: 60,
      generatedAt: BASELINE_RUNTIME_FIXED_TIME,
      useIndex: false,
      useCache: false,
    }));
    const surfacedIds = [...pack.results.playbookIds, ...pack.results.devMemoryEntryIds];
    const surfaced = new Set(surfacedIds);
    const mustNotSurfaceIds = [...query.mustNotSurfaceIds];
    const expectedSuppressedIds = [...(query.expectedSuppressedIds ?? [])];
    const expectedDeprecatedTermHits = [...(query.expectedDeprecatedTermHits ?? [])];
    const currentOverSupersededPreferencePass = query.supersededPreference
      ? surfaced.has(query.supersededPreference.currentId)
        && !surfaced.has(query.supersededPreference.supersededId)
        && pack.results.suppressedSupersededIds.includes(query.supersededPreference.supersededId)
      : true;
    return {
      queryId: query.id,
      surfacedIds,
      suppressedSupersededIds: pack.results.suppressedSupersededIds,
      deprecatedTermHits: pack.results.deprecatedTermHits,
      expectedIdsFound: query.expectedIds.filter((id) => surfaced.has(id)).length,
      expectedSuppressedIdsFound: expectedSuppressedIds.filter((id) => pack.results.suppressedSupersededIds.includes(id)).length,
      expectedDeprecatedTermHitsFound: expectedDeprecatedTermHits.filter((id) => pack.results.deprecatedTermHits.includes(id)).length,
      candidateFalseSurfaces: mustNotSurfaceIds.filter((id) =>
        surfaced.has(id) && (id.includes('candidate') || allStatusById.get(id) === 'candidate')).length,
      supersededFalseSurfaces: mustNotSurfaceIds.filter((id) =>
        surfaced.has(id) && allStatusById.get(id) === 'superseded').length,
      deprecatedFalseSurfaces: mustNotSurfaceIds.filter((id) =>
        surfaced.has(id)
        && (allStatusById.get(id) === 'deprecated' || allClassById.get(id) === 'deprecated-brand-residue')).length,
      mustNotSurfaceTotal: mustNotSurfaceIds.length,
      currentOverSupersededPreferencePass,
      missingExpectedIds: query.expectedIds.filter((id) => !surfaced.has(id)),
      unexpectedSurfacedIds: mustNotSurfaceIds.filter((id) => surfaced.has(id)),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function matrixMemoryEntry(id: string, text: string, scope: DevMemoryEntry['scope'] = 'project'): DevMemoryEntry {
  return {
    id,
    createdAt: BASELINE_RUNTIME_FIXED_TIME,
    sourceAgent: 'playbook-runtime-baseline',
    category: 'workflow',
    scope,
    summary: text,
    trigger: text,
    lesson: text,
    reusePrompt: text,
    tags: [],
    evidenceRefs: [`baseline-matrix:${id}`],
    gateEvidence: false,
    authority: 'non_authoritative',
  };
}

function matrixPlaybook(
  id: string,
  text: string,
  overrides: Partial<Pick<Playbook['trigger'], 'fileKinds' | 'storyPhases'>> = {},
): Playbook {
  return {
    id,
    title: `${id} baseline matrix playbook`,
    trigger: {
      keywords: baselineTokens(`${id} ${text}`).slice(0, 20),
      fileKinds: overrides.fileKinds ?? ['ts'],
      storyPhases: overrides.storyPhases ?? ['TEST'],
    },
    check: text,
    pitfalls: ['Memory matrix playbooks remain non-authoritative.'],
    verification: ['Source digest matrix must classify relevant and irrelevant mutations.'],
    lineage: {
      sourceStoryId: 'B-baseline',
      sourceFindingId: 'F-source-digest-matrix',
      sourceSignature: id,
    },
    status: 'active',
    usage: { surfacedCount: 0, resolvedHits: 0, dismissedHits: 0 },
  };
}

function runMatrixScenario(mutator: (root: string, fixture: {
  projectEntry: DevMemoryEntry;
  globalEntry: DevMemoryEntry;
  activePlaybook: Playbook;
}) => void): {
  freshnessClass: MemoryFreshnessClass;
  initialSurfacePass: boolean;
} {
  const root = mkdtempSync(join(tmpdir(), 'proofbound-memory-baseline-matrix-'));
  try {
    return withIsolatedGlobalMemory(() => {
      const projectEntry = matrixMemoryEntry(
        'mem-source-mutation-current',
        'memory pack stale digest source mutation matrix project memory relevant row',
      );
      const globalEntry = matrixMemoryEntry(
        'mem-source-mutation-global',
        'memory pack stale digest source mutation matrix global memory relevant row',
        'global',
      );
      const activePlaybook = matrixPlaybook(
        'pb-source-mutation-active',
        'memory pack stale digest source mutation matrix active playbook relevant row',
      );
      writeEntries(resolveProjectMemoryPath(root), [projectEntry]);
      writeEntries(resolveGlobalMemoryPath(), [globalEntry]);
      writePlaybooks(root, [activePlaybook]);
      writeSignatureRegistry(root, BASELINE_SIGNATURE_REGISTRY);
      const pack = buildMemoryFreshnessPack({
        projectRoot: root,
        consumer: 'session_brief',
        query: `memory pack stale digest source mutation matrix ${BASELINE_DEPRECATED_BRAND_MARKER}`,
        touchedPaths: ['packages/main/src/baseline.ts'],
        storyPhase: 'TEST',
        maxEntries: 20,
        maxPlaybooks: 20,
        maxLines: 60,
        generatedAt: BASELINE_RUNTIME_FIXED_TIME,
        useIndex: false,
        useCache: false,
      });
      const initialSurfacePass = pack.results.devMemoryEntryIds.includes(projectEntry.id)
        && pack.results.devMemoryEntryIds.includes(globalEntry.id)
        && pack.results.playbookIds.includes(activePlaybook.id)
        && pack.results.deprecatedTermHits.includes(BASELINE_DEPRECATED_BRAND_MARKER)
        && pack.authority === 'non_authoritative'
        && pack.gateEvidence === false;
      mutator(root, { projectEntry, globalEntry, activePlaybook });
      return {
        freshnessClass: classifyMemoryFreshnessPack(pack).freshness.class,
        initialSurfacePass,
      };
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runSourceDigestMutationMatrix(): SourceDigestMutationMatrixResult {
  const projectRelevant = runMatrixScenario((_root, fixture) => {
    writeEntries(resolveProjectMemoryPath(_root), [
      { ...fixture.projectEntry, lesson: `${fixture.projectEntry.lesson} changed relevant project source` },
    ]);
  });
  const projectIrrelevant = runMatrixScenario((_root, fixture) => {
    writeEntries(resolveProjectMemoryPath(_root), [
      fixture.projectEntry,
      {
        ...matrixMemoryEntry('mem-unrelated-project-churn', 'append only project churn row outside active query'),
        evidenceRefs: ['unrelated:project-churn'],
      },
    ]);
  });
  const globalRelevant = runMatrixScenario((_root, fixture) => {
    writeEntries(resolveGlobalMemoryPath(), [
      { ...fixture.globalEntry, lesson: `${fixture.globalEntry.lesson} changed relevant global source` },
    ]);
  });
  const globalIrrelevant = runMatrixScenario((_root, fixture) => {
    writeEntries(resolveGlobalMemoryPath(), [
      fixture.globalEntry,
      {
        ...matrixMemoryEntry('mem-unrelated-global-churn', 'append only global churn row outside active query', 'global'),
        evidenceRefs: ['unrelated:global-churn'],
      },
    ]);
  });
  const playbookRelevant = runMatrixScenario((_root, fixture) => {
    writePlaybooks(_root, [
      { ...fixture.activePlaybook, check: `${fixture.activePlaybook.check} changed relevant playbook source` },
    ]);
  });
  const playbookIrrelevant = runMatrixScenario((_root, fixture) => {
    writePlaybooks(_root, [
      fixture.activePlaybook,
      {
        id: 'pb-unrelated-append',
        title: 'unrelated append row',
        trigger: { keywords: ['unrelated', 'append'], fileKinds: ['md'], storyPhases: ['PLAN'] },
        check: 'unrelated append row outside active query',
        pitfalls: ['This row should not match the active query.'],
        verification: ['Append row remains outside retrieval.'],
        lineage: {
          sourceStoryId: 'B-baseline',
          sourceFindingId: 'F-unrelated',
          sourceSignature: 'unrelated-append',
        },
        status: 'active',
        usage: { surfacedCount: 0, resolvedHits: 0, dismissedHits: 0 },
      },
    ]);
  });
  const signatureRegistryRelevant = runMatrixScenario((root) => {
    writeSignatureRegistry(root, {
      tags: BASELINE_SIGNATURE_REGISTRY.tags.map((tag) =>
        tag.tag === BASELINE_DEPRECATED_BRAND_MARKER ? { ...tag, createdBy: 'playbook-runtime-baseline-mutated' } : tag),
    });
  });
  const signatureRegistryIrrelevant = runMatrixScenario((root) => {
    writeSignatureRegistry(root, {
      tags: [
        ...BASELINE_SIGNATURE_REGISTRY.tags,
        {
          tag: 'unrelated-retired-term',
          status: 'deprecated',
          aliases: [],
          mergedInto: 'proofbound',
          createdBy: 'playbook-runtime-baseline',
          approvedBy: null,
        },
      ],
    });
  });
  const result: SourceDigestMutationMatrixResult = {
    projectMemoryRelevant: projectRelevant.freshnessClass,
    projectMemoryIrrelevant: projectIrrelevant.freshnessClass,
    globalMemoryRelevant: globalRelevant.freshnessClass,
    globalMemoryIrrelevant: globalIrrelevant.freshnessClass,
    playbookRelevant: playbookRelevant.freshnessClass,
    playbookIrrelevant: playbookIrrelevant.freshnessClass,
    signatureRegistryRelevant: signatureRegistryRelevant.freshnessClass,
    signatureRegistryIrrelevant: signatureRegistryIrrelevant.freshnessClass,
    initialSurfacePass: [
      projectRelevant,
      projectIrrelevant,
      globalRelevant,
      globalIrrelevant,
      playbookRelevant,
      playbookIrrelevant,
      signatureRegistryRelevant,
      signatureRegistryIrrelevant,
    ].every((scenario) => scenario.initialSurfacePass),
    pass: false,
  };
  result.pass = result.initialSurfacePass
    && result.projectMemoryRelevant === 'stale-relevant'
    && result.projectMemoryIrrelevant === 'stale-irrelevant'
    && result.globalMemoryRelevant === 'stale-relevant'
    && result.globalMemoryIrrelevant === 'stale-irrelevant'
    && result.playbookRelevant === 'stale-relevant'
    && result.playbookIrrelevant === 'stale-irrelevant'
    && result.signatureRegistryRelevant === 'stale-relevant'
    && result.signatureRegistryIrrelevant === 'stale-irrelevant';
  return result;
}

function roundedElapsed(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

interface RuntimeCorpusMaterialization {
  root: string;
  sourceRecordCount: number;
  devMemoryRecordCount: number;
  playbookRecordCount: number;
  malformedRowsSkipped: number;
}

interface RuntimePackQueryRun {
  elapsedMs: number;
  resultDigest: string;
  queryElapsedMs: number[];
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[index];
}

function runtimeCorpusMemoryEntry(record: BaselineRecord): DevMemoryEntry {
  const isGold = GOLD_RECORD_IDS.has(record.id);
  const text = isGold && record.text.trim().length >= 10
    ? record.text.trim()
    : 'baseline noise row';
  return {
    id: record.id,
    createdAt: BASELINE_RUNTIME_FIXED_TIME,
    sourceAgent: 'baseline',
    category: 'workflow',
    scope: 'project',
    summary: text,
    trigger: 'base trigger',
    lesson: 'base lesson',
    reusePrompt: 'reuse base',
    ...(isGold && record.supersedes ? { tags: record.supersedes.map((id) => `supersedes-${id}`) } : {}),
    gateEvidence: false,
    authority: 'non_authoritative',
  };
}

function runtimeCorpusPlaybookFromBaseline(record: BaselineRecord): Playbook {
  const text = GOLD_RECORD_IDS.has(record.id) ? record.text : `noise playbook ${record.id}`;
  return {
    id: record.id,
    title: `${record.id} baseline playbook`,
    trigger: {
      keywords: baselineTokens(`${record.id} ${text}`).slice(0, 20),
      fileKinds: ['ts'],
      storyPhases: ['DEV', 'TEST', 'DONE'],
    },
    check: text,
    pitfalls: ['advisory runtime'],
    verification: ['runtime parity'],
    lineage: {
      sourceStoryId: 'B-baseline',
      sourceFindingId: 'F-baseline',
      sourceSignature: record.id,
    },
    status: playbookStatusFromBaseline(record.status),
    usage: { surfacedCount: 0, resolvedHits: 0, dismissedHits: 0 },
  };
}

function writeRuntimeCorpusMemoryLine(fd: number, record: BaselineRecord, buffer: { value: string }): void {
  buffer.value += `${JSON.stringify(runtimeCorpusMemoryEntry(record))}\n`;
  if (buffer.value.length > 1_000_000) {
    writeSync(fd, buffer.value);
    buffer.value = '';
  }
}

function materializeRuntimeCorpus(recordsRaw: string): RuntimeCorpusMaterialization {
  const root = mkdtempSync(join(tmpdir(), 'proofbound-memory-baseline-runtime-corpus-'));
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
  }, null, 2) + '\n', 'utf8');

  const memoryPath = resolveProjectMemoryPath(root);
  mkdirSync(dirname(memoryPath), { recursive: true });
  const fd = openSync(memoryPath, 'w');
  const buffer = { value: '' };
  const playbooks: Playbook[] = [];
  let sourceRecordCount = 0;
  let devMemoryRecordCount = 0;
  let playbookRecordCount = 0;
  let malformedRowsSkipped = 0;

  try {
    for (const line of recordsRaw.split('\n')) {
      if (!line) continue;
      sourceRecordCount += 1;
      const record = parseBaselineRecord(line);
      if (!record) {
        malformedRowsSkipped += 1;
        continue;
      }
      if (record.kind === 'memory') {
        writeRuntimeCorpusMemoryLine(fd, record, buffer);
        devMemoryRecordCount += 1;
      } else {
        playbooks.push(runtimeCorpusPlaybookFromBaseline(record));
        playbookRecordCount += 1;
      }
    }
    if (buffer.value.length > 0) writeSync(fd, buffer.value);
  } finally {
    closeSync(fd);
  }

  writePlaybooks(root, playbooks);
  writeSignatureRegistry(root, BASELINE_SIGNATURE_REGISTRY);
  return { root, sourceRecordCount, devMemoryRecordCount, playbookRecordCount, malformedRowsSkipped };
}

function packOptionsForGoldQuery(
  root: string,
  query: BaselineGoldQuery,
  overrides: Partial<Omit<BuildMemoryFreshnessPackOptions, 'projectRoot' | 'query'>> = {},
): BuildMemoryFreshnessPackOptions {
  return {
    projectRoot: root,
    consumer: 'session_brief',
    query: query.query,
    touchedPaths: ['packages/main/src/baseline.ts'],
    storyPhase: 'TEST',
    maxEntries: 20,
    maxPlaybooks: 20,
    maxLines: 60,
    generatedAt: BASELINE_RUNTIME_FIXED_TIME,
    ...overrides,
  };
}

function memoryPackResultDigest(packs: Array<{ queryId: string; pack: MemoryFreshnessPack }>): string {
  const sorted = (values: string[]): string[] => [...new Set(values)].sort();
  return digestCanonicalJson(packs.map(({ queryId, pack }) => ({
    queryId,
    surfacedIds: sorted([...pack.results.playbookIds, ...pack.results.devMemoryEntryIds]),
    devMemoryEntryIds: sorted(pack.results.devMemoryEntryIds),
    playbookIds: sorted(pack.results.playbookIds),
    suppressedSupersededIds: sorted(pack.results.suppressedSupersededIds),
    deprecatedTermHits: sorted(pack.results.deprecatedTermHits),
    omittedCount: pack.render.omittedCount,
    maxLines: pack.render.maxLines,
    freshnessClass: pack.freshness.class,
    authority: pack.authority,
    gateEvidence: pack.gateEvidence,
  })));
}

function runRuntimePackQueries(
  root: string,
  gold: { queries: BaselineGoldQuery[] },
  overrides: Partial<Omit<BuildMemoryFreshnessPackOptions, 'projectRoot' | 'query'>> = {},
): RuntimePackQueryRun {
  const started = performance.now();
  const queryElapsedMs: number[] = [];
  const packs = gold.queries.map((query) => {
    const queryStarted = performance.now();
    const pack = buildMemoryFreshnessPack(packOptionsForGoldQuery(root, query, overrides));
    queryElapsedMs.push(Math.max(0, Math.round(performance.now() - queryStarted)));
    return { queryId: query.id, pack };
  });
  return {
    elapsedMs: roundedElapsed(started),
    resultDigest: memoryPackResultDigest(packs),
    queryElapsedMs,
  };
}

export function runPlaybookRuntimeOptimizedParityReport(args: {
  inputDir?: string;
  profile?: PlaybookRuntimeBaselineProfile;
  seed?: number;
  keepGenerated?: boolean;
  targetWarmMs?: number;
} = {}): PlaybookRuntimeOptimizedParityReport {
  const targetWarmMs = Math.max(1, Math.floor(args.targetWarmMs ?? 2000));
  const generated = args.inputDir
    ? undefined
    : generatePlaybookRuntimeBaseline({ profile: args.profile ?? 'small', seed: args.seed, force: true });
  const inputDir = args.inputDir ?? generated!.outputDir;
  try {
    const manifest = JSON.parse(readFileSync(join(inputDir, 'manifest.json'), 'utf8')) as PlaybookRuntimeBaselineManifest;
    const recordsRaw = readFileSync(join(inputDir, 'records.jsonl'), 'utf8');
    const gold = JSON.parse(readFileSync(join(inputDir, 'gold-queries.json'), 'utf8')) as { queries: BaselineGoldQuery[] };
    return withIsolatedGlobalMemory(() => {
      const corpusStarted = performance.now();
      const corpus = materializeRuntimeCorpus(recordsRaw);
      const corpusMaterializeMs = roundedElapsed(corpusStarted);
      try {
        clearRuntimeMemoryPackCache();
        const reference = runRuntimePackQueries(corpus.root, gold, { useIndex: false, useCache: false });
        const indexStarted = performance.now();
        const runtimeIndex = rebuildRuntimeMemoryIndex(corpus.root, BASELINE_RUNTIME_FIXED_TIME);
        const indexBuildMs = roundedElapsed(indexStarted);
        resetRuntimeMemoryIndexCandidateStats();
        const indexedCold = runRuntimePackQueries(corpus.root, gold, {
          runtimeIndex,
          useCache: false,
        });
        const indexedColdTokenStats = getRuntimeMemoryIndexCandidateStats();
        clearRuntimeMemoryPackCache();
        resetRuntimeMemoryIndexCandidateStats();
        const warmPrime = runRuntimePackQueries(corpus.root, gold, {
          runtimeIndex,
          useCache: true,
        });
        const warmPrimeTokenStats = getRuntimeMemoryIndexCandidateStats();
        resetRuntimeMemoryIndexCandidateStats();
        const indexedWarm = runRuntimePackQueries(corpus.root, gold, {
          runtimeIndex,
          useCache: true,
        });
        const indexedWarmTokenStats = getRuntimeMemoryIndexCandidateStats();
        const warmCacheStats = getRuntimeMemoryPackCacheStats();
        const parityPass = reference.resultDigest === indexedCold.resultDigest
          && indexedCold.resultDigest === indexedWarm.resultDigest;
        const memory = process.memoryUsage();
        const targetStatus = parityPass && indexedWarm.elapsedMs <= targetWarmMs ? 'met' : 'unmet';
        const cacheHitRate = warmCacheStats.hits / Math.max(1, warmCacheStats.hits + warmCacheStats.misses);
        const warmLatencies = indexedWarm.queryElapsedMs;
        return {
          schemaVersion: 'proofbound.memory-playbook-optimized-parity.v1',
          profile: manifest.profile,
          recordCount: manifest.recordCount,
          queryCount: gold.queries.length,
          referenceFullScanMs: reference.elapsedMs,
          indexedColdMs: indexedCold.elapsedMs,
          indexedWarmCacheMs: indexedWarm.elapsedMs,
          targetWarmMs,
          targetStatus,
          performancePolicy: 'report-first',
          parityPass,
          referenceResultDigest: reference.resultDigest,
          indexedColdResultDigest: indexedCold.resultDigest,
          indexedWarmCacheResultDigest: indexedWarm.resultDigest,
          resultDigestSource: 'MemoryFreshnessPack',
          runtimeCorpus: {
            sourceRecordCount: corpus.sourceRecordCount,
            devMemoryRecordCount: corpus.devMemoryRecordCount,
            playbookRecordCount: corpus.playbookRecordCount,
            malformedRowsSkipped: corpus.malformedRowsSkipped,
            fullCorpusMaterialized: corpus.sourceRecordCount === manifest.recordCount,
          },
          indexedColdUsesRuntimeIndex: runtimeIndex.manifest.recordCounts.devMemory === corpus.devMemoryRecordCount
            && runtimeIndex.manifest.recordCounts.playbooks === corpus.playbookRecordCount
            && runtimeIndex.manifest.recordCounts.signatureTags === BASELINE_SIGNATURE_REGISTRY.tags.length,
          indexedColdRuntimeIndexRecordCounts: runtimeIndex.manifest.recordCounts,
          warmCacheStats,
          cacheHitRate,
          latency: {
            p50Ms: percentile(warmLatencies, 50),
            p95Ms: percentile(warmLatencies, 95),
          },
          timingBreakdown: {
            corpusMaterializeMs,
            indexBuildMs,
            referenceQueryMs: reference.elapsedMs,
            indexedColdQueryMs: indexedCold.elapsedMs,
            warmPrimeQueryMs: warmPrime.elapsedMs,
            indexedWarmQueryMs: indexedWarm.elapsedMs,
            queryCount: gold.queries.length,
            tokenMatching: {
              indexedCold: indexedColdTokenStats,
              warmPrime: warmPrimeTokenStats,
              indexedWarm: indexedWarmTokenStats,
            },
            cache: warmCacheStats,
          },
          performance: {
            peakRssBytes: memory.rss,
            peakHeapUsedBytes: memory.heapUsed,
          },
          authority: 'non_authoritative',
          gateEvidence: false,
        };
      } finally {
        rmSync(corpus.root, { recursive: true, force: true });
        clearRuntimeMemoryPackCache();
      }
    });
  } finally {
    if (generated && args.keepGenerated !== true) {
      rmSync(generated.outputDir, { recursive: true, force: true });
    }
  }
}

export function generatePlaybookRuntimeBaseline(args: {
  profile?: PlaybookRuntimeBaselineProfile;
  outputDir?: string;
  seed?: number;
  force?: boolean;
} = {}): PlaybookRuntimeBaselineGenerateResult {
  const profile = args.profile ?? 'small';
  const recordCount = PROFILE_COUNTS[profile];
  const outputDir = outputDirFor(profile, args.outputDir);
  const recordsPath = join(outputDir, 'records.jsonl');
  const goldPath = join(outputDir, 'gold-queries.json');
  const manifestPath = join(outputDir, 'manifest.json');
  ensureBaselineOutputWritable(outputDir, [recordsPath, goldPath, manifestPath], args.force);
  mkdirSync(outputDir, { recursive: true });
  const baseline = buildBaselineRows(profile);
  if (baseline.rows.length !== recordCount) {
    throw new Error(`baseline generator produced ${baseline.rows.length} rows for ${profile}; expected ${recordCount}`);
  }

  const fd = openSync(recordsPath, 'w');
  let buffer = '';
  const flush = () => {
    if (buffer.length === 0) return;
    writeSync(fd, buffer);
    buffer = '';
  };
  try {
    for (const line of baseline.rows) {
      buffer += `${line}\n`;
      if (buffer.length > 1_000_000) flush();
    }
    flush();
  } finally {
    closeSync(fd);
  }

  const recordsDigest = digestText(baseline.rows.join('\n') + '\n');
  const gold = {
    schemaVersion: 'proofbound.memory-playbook-baseline.gold.v1',
    queries: GOLD_QUERIES,
  };
  const goldText = `${JSON.stringify(gold, null, 2)}\n`;
  writeFileSync(goldPath, goldText, 'utf8');
  const goldDigest = digestText(goldText);
  const manifestDomain = {
    schemaVersion: 'proofbound.memory-playbook-baseline.v1' as const,
    profile,
    seed: args.seed ?? 42,
    recordCount,
    partitionCounts: baseline.partitionCounts,
    fullProfileExactMillion: profile === 'full' && recordCount === 1_000_000,
    recordsDigest,
    goldDigest,
    corruptRows: baseline.corruptRows,
    authority: 'non_authoritative' as const,
    gateEvidence: false as const,
  };
  const manifest: PlaybookRuntimeBaselineManifest = {
    ...manifestDomain,
    manifestDigest: digestCanonicalJson(manifestDomain),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { outputDir, recordsPath, goldPath, manifestPath, manifest };
}

export function verifyPlaybookRuntimeBaseline(args: {
  inputDir?: string;
  profile?: PlaybookRuntimeBaselineProfile;
  seed?: number;
  generate?: boolean;
  keepGenerated?: boolean;
} = {}): PlaybookRuntimeBaselineVerifyResult {
  const started = performance.now();
  const generated = args.inputDir
    ? undefined
    : generatePlaybookRuntimeBaseline({ profile: args.profile ?? 'small', seed: args.seed, force: true });
  const inputDir = args.inputDir ?? generated!.outputDir;
  try {
    const manifest = JSON.parse(readFileSync(join(inputDir, 'manifest.json'), 'utf8')) as PlaybookRuntimeBaselineManifest;
    const recordsRaw = readFileSync(join(inputDir, 'records.jsonl'), 'utf8');
    const goldRaw = readFileSync(join(inputDir, 'gold-queries.json'), 'utf8');
    const recordsDigestStable = digestText(recordsRaw) === manifest.recordsDigest;
    const goldDigestStable = digestText(goldRaw) === manifest.goldDigest;
    const staleDetected = !recordsDigestStable || !goldDigestStable;
    const gold = JSON.parse(goldRaw) as { queries: BaselineGoldQuery[] };
    const shortlists = new Map(gold.queries.map((query) => [query.id, [] as Array<{ record: BaselineRecord; score: number }>]));
    const recordIds = new Set<string>();
    const statusById = new Map<string, string>();
    const classById = new Map<string, BaselineRecordClass>();
    const observedPartitionCounts = emptyPartitionCounts();
    let unknownPartitionRows = 0;
    let validRows = 0;
    let malformedRowsSkipped = 0;
    for (const line of recordsRaw.split('\n')) {
      if (!line) continue;
      const row = parseBaselineRecord(line);
      if (!row) {
        malformedRowsSkipped += 1;
        observedPartitionCounts['malformed-adversarial'] += 1;
        continue;
      }
      validRows += 1;
      recordIds.add(row.id);
      statusById.set(row.id, row.status);
      if (row.recordClass) classById.set(row.id, row.recordClass);
      if (row.partition) {
        observedPartitionCounts[row.partition] += 1;
      } else {
        unknownPartitionRows += 1;
      }
      for (const query of gold.queries) {
        insertScoredRecord(shortlists.get(query.id)!, row, baselineRecordScore(query.query, row));
      }
    }
    const runtimeResults = gold.queries.map((query) =>
      runRuntimeGoldQuery(query, (shortlists.get(query.id) ?? []).map((item) => item.record), statusById, classById));
    const requiredGoldQueryIds = GOLD_QUERIES.map((query) => query.id);
    const actualGoldQueryIds = new Set(gold.queries.map((query) => query.id));
    const goldQueryPresenceRate = requiredGoldQueryIds.filter((id) => actualGoldQueryIds.has(id)).length
      / Math.max(1, requiredGoldQueryIds.length);
    const requiredGoldRecordIds = GOLD_RECORDS.map((record) => record.id);
    const goldRecordPresenceRate = requiredGoldRecordIds.filter((id) => recordIds.has(id)).length
      / Math.max(1, requiredGoldRecordIds.length);
    const expectedIds = gold.queries.flatMap((query) => [...query.expectedIds]);
    const expectedSuppressedIds = gold.queries.flatMap((query) => [...(query.expectedSuppressedIds ?? [])]);
    const expectedDeprecatedTermHits = gold.queries.flatMap((query) => [...(query.expectedDeprecatedTermHits ?? [])]);
    const expectedFound = runtimeResults.reduce((sum, result) => sum + result.expectedIdsFound, 0);
    const expectedSuppressedFound = runtimeResults.reduce((sum, result) => sum + result.expectedSuppressedIdsFound, 0);
    const expectedDeprecatedTermHitsFound = runtimeResults.reduce((sum, result) => sum + result.expectedDeprecatedTermHitsFound, 0);
    const candidateFalseSurfaces = runtimeResults.reduce((sum, result) => sum + result.candidateFalseSurfaces, 0);
    const supersededFalseSurfaces = runtimeResults.reduce((sum, result) => sum + result.supersededFalseSurfaces, 0);
    const deprecatedFalseSurfaces = runtimeResults.reduce((sum, result) => sum + result.deprecatedFalseSurfaces, 0);
    const mustNotSurfaceTotal = runtimeResults.reduce((sum, result) => sum + result.mustNotSurfaceTotal, 0);
    const expectedIdsFoundRate = expectedFound / Math.max(1, expectedIds.length);
    const expectedSuppressedIdsFoundRate = expectedSuppressedFound / Math.max(1, expectedSuppressedIds.length);
    const expectedDeprecatedTermHitsFoundRate = expectedDeprecatedTermHitsFound / Math.max(1, expectedDeprecatedTermHits.length);
    const candidateFalseSurfaceRate = candidateFalseSurfaces / Math.max(1, mustNotSurfaceTotal);
    const supersededFalseSurfaceRate = supersededFalseSurfaces / Math.max(1, mustNotSurfaceTotal);
    const deprecatedFalseSurfaceRate = deprecatedFalseSurfaces / Math.max(1, mustNotSurfaceTotal);
    const supersededPreferenceChecks = runtimeResults.filter((result) =>
      Boolean(gold.queries.find((query) => query.id === result.queryId)?.supersededPreference));
    const currentOverSupersededPreferenceRate = supersededPreferenceChecks.filter((result) =>
      result.currentOverSupersededPreferencePass).length / Math.max(1, supersededPreferenceChecks.length);
    const manifestPartitionCounts = {
      ...emptyPartitionCounts(),
      ...(manifest.partitionCounts ?? {}),
    };
    const expectedPartitionCounts = partitionCountsFor(manifest.profile);
    const observedPartitionCountsMatchManifest = BASELINE_PARTITIONS.every((partition) =>
      observedPartitionCounts[partition] === manifestPartitionCounts[partition]);
    const manifestPartitionCountsMatchProfile = BASELINE_PARTITIONS.every((partition) =>
      manifestPartitionCounts[partition] === expectedPartitionCounts[partition]);
    const partitionContractPass = observedPartitionCountsMatchManifest
      && manifestPartitionCountsMatchProfile
      && unknownPartitionRows === 0;
    const sourceDigestMutationMatrix = runSourceDigestMutationMatrix();
    const manifestDomain = {
      schemaVersion: manifest.schemaVersion,
      profile: manifest.profile,
      seed: manifest.seed,
      recordCount: manifest.recordCount,
      partitionCounts: manifest.partitionCounts,
      fullProfileExactMillion: manifest.fullProfileExactMillion,
      recordsDigest: manifest.recordsDigest,
      goldDigest: manifest.goldDigest,
      corruptRows: manifest.corruptRows,
      authority: manifest.authority,
      gateEvidence: manifest.gateEvidence,
    };
    const manifestDigestStable = digestCanonicalJson(manifestDomain) === manifest.manifestDigest;
    const thresholds = {
      expectedIdsFoundRate: 1,
      goldQueryPresenceRate: 1,
      goldRecordPresenceRate: 1,
      expectedSuppressedIdsFoundRate: 1,
      expectedDeprecatedTermHitsFoundRate: 1,
      currentOverSupersededPreferenceRate: 1,
      candidateFalseSurfaceRateMax: 0,
      supersededFalseSurfaceRateMax: 0,
      deprecatedFalseSurfaceRateMax: 0,
    };
    const expectedProfileRecordCount = PROFILE_COUNTS[manifest.profile];
    const requestedProfileMatches = args.profile === undefined || manifest.profile === args.profile;
    const profileRecordCountMatches = manifest.recordCount === expectedProfileRecordCount;
    const fullProfileExactMillionMatches = manifest.fullProfileExactMillion === (manifest.profile === 'full' && manifest.recordCount === PROFILE_COUNTS.full);
    const memory = process.memoryUsage();
    const pass = validRows + malformedRowsSkipped === manifest.recordCount
      && requestedProfileMatches
      && profileRecordCountMatches
      && fullProfileExactMillionMatches
      && expectedIdsFoundRate >= thresholds.expectedIdsFoundRate
      && goldQueryPresenceRate >= thresholds.goldQueryPresenceRate
      && goldRecordPresenceRate >= thresholds.goldRecordPresenceRate
      && expectedSuppressedIdsFoundRate >= thresholds.expectedSuppressedIdsFoundRate
      && expectedDeprecatedTermHitsFoundRate >= thresholds.expectedDeprecatedTermHitsFoundRate
      && currentOverSupersededPreferenceRate >= thresholds.currentOverSupersededPreferenceRate
      && candidateFalseSurfaceRate <= thresholds.candidateFalseSurfaceRateMax
      && supersededFalseSurfaceRate <= thresholds.supersededFalseSurfaceRateMax
      && deprecatedFalseSurfaceRate <= thresholds.deprecatedFalseSurfaceRateMax
      && partitionContractPass
      && sourceDigestMutationMatrix.pass
      && manifestDigestStable
      && recordsDigestStable
      && goldDigestStable
      && staleDetected === false;
    return {
      status: pass ? 'pass' : 'fail',
      inputDir,
      generatedInput: Boolean(generated),
      generatedOutputKept: Boolean(generated && args.keepGenerated),
      profile: manifest.profile,
      ...(args.profile ? { requestedProfile: args.profile } : {}),
      recordCount: manifest.recordCount,
      expectedProfileRecordCount,
      fullProfileExactMillion: manifest.fullProfileExactMillion,
      requestedProfileMatches,
      profileRecordCountMatches,
      fullProfileExactMillionMatches,
      recordsDigestStable,
      goldDigestStable,
      manifestDigestStable,
      staleDetected,
      correctness: {
        expectedIdsFoundRate,
        goldQueryPresenceRate,
        goldRecordPresenceRate,
        expectedSuppressedIdsFoundRate,
        expectedDeprecatedTermHitsFoundRate,
        currentOverSupersededPreferenceRate,
        candidateFalseSurfaceRate,
        supersededFalseSurfaceRate,
        deprecatedFalseSurfaceRate,
        malformedRowsSkipped,
        partitionContractPass,
        sourceDigestMutationMatrixPass: sourceDigestMutationMatrix.pass,
      },
      thresholds,
      sourceDigestMutationMatrix,
      performance: {
        elapsedMs: Math.round(performance.now() - started),
        peakRssBytes: memory.rss,
        peakHeapUsedBytes: memory.heapUsed,
      },
      authority: 'non_authoritative',
      gateEvidence: false,
    };
  } finally {
    if (generated && args.keepGenerated !== true) {
      rmSync(generated.outputDir, { recursive: true, force: true });
    }
  }
}
