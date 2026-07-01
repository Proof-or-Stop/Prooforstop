import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, closeSync, writeFileSync, writeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { resolveProjectMemoryPath, writeEntries, type DevMemoryEntry } from './dev-memory.js';
import { digestCanonicalJson, digestText } from './digest.js';
import type { Playbook, PlaybookStatus } from './experience-layer-types.js';
import { writePlaybooks } from './learning-store.js';
import { buildMemoryFreshnessPack } from './playbook-runtime-memory.js';

export type PlaybookRuntimeBaselineProfile = 'small' | 'full';

export interface PlaybookRuntimeBaselineManifest {
  schemaVersion: 'proofbound.memory-playbook-baseline.v1';
  profile: PlaybookRuntimeBaselineProfile;
  seed: number;
  recordCount: number;
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
  profile: PlaybookRuntimeBaselineProfile;
  recordCount: number;
  fullProfileExactMillion: boolean;
  manifestDigestStable: boolean;
  staleDetected: boolean;
  correctness: {
    expectedIdsFoundRate: number;
    currentOverSupersededPreferenceRate: number;
    candidateFalseSurfaceRate: number;
    supersededFalseSurfaceRate: number;
    deprecatedFalseSurfaceRate: number;
    malformedRowsSkipped: number;
  };
  thresholds: {
    expectedIdsFoundRate: number;
    currentOverSupersededPreferenceRate: number;
    candidateFalseSurfaceRateMax: number;
    deprecatedFalseSurfaceRateMax: number;
  };
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
  supersedes?: string[];
}

interface RuntimeGoldQueryResult {
  queryId: string;
  surfacedIds: string[];
  expectedIdsFound: number;
  candidateFalseSurfaces: number;
  supersededFalseSurfaces: number;
  mustNotSurfaceTotal: number;
}

const PROFILE_COUNTS: Record<PlaybookRuntimeBaselineProfile, number> = {
  small: 1_000,
  full: 1_000_000,
};

const BASELINE_RUNTIME_SHORTLIST_LIMIT = 96;
const BASELINE_RUNTIME_FIXED_TIME = '2026-07-01T00:00:00.000Z';

const GOLD_QUERIES = [
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
] as const;

const GOLD_RECORDS = [
  ['mem-host-current', 'memory', 'current', 'host-policy codex-cli claude-cli agy fallback unavailable quota-limited timed-out explicit substitute primary hosts'],
  ['pb-host-policy-active', 'playbook', 'active', 'host-policy codex-cli claude-cli agy-cli fallback only primary failure signal'],
  ['pb-host-policy-candidate', 'playbook', 'candidate', 'candidate agy fallback should not surface'],
  ['mem-truth-current', 'memory', 'current', 'truth-first stale-doc current facts beat old planning prose'],
  ['mem-truth-superseded', 'memory', 'superseded', 'old stale-doc plan superseded by current facts'],
  ['pb-truth-first-active', 'playbook', 'active', 'truth-first stale-doc current structured facts before claiming missing work'],
  ['mem-parent-totality-current', 'memory', 'current', 'parent roadmap intent-totality delivery all milestones structured rollup'],
  ['pb-intent-totality-active', 'playbook', 'active', 'intent-totality delivery parent roadmap ParentRollupResult current facts'],
  ['pb-parent-candidate', 'playbook', 'candidate', 'candidate parent roadmap totality should not surface'],
  ['mem-repro-first-current', 'memory', 'current', 'repro-first red failing evidence before fix story intake'],
  ['pb-repro-first-active', 'playbook', 'active', 'repro-first story intake red green relation verification'],
] as const satisfies ReadonlyArray<readonly [string, BaselineRecord['kind'], string, string]>;

const BASELINE_SUPERSEDES: Record<string, string[]> = {
  'mem-truth-current': ['mem-truth-superseded'],
};

function outputDirFor(profile: PlaybookRuntimeBaselineProfile, outputDir?: string): string {
  if (outputDir) return outputDir;
  return mkdtempSync(join(tmpdir(), `proofbound-memory-playbook-${profile}-`));
}

function recordLine(id: string, kind: string, status: string, text: string): string {
  const supersedes = BASELINE_SUPERSEDES[id];
  return JSON.stringify({
    id,
    kind,
    status,
    text,
    ...(supersedes ? { supersedes } : {}),
  });
}

function noiseRecord(index: number): string {
  const classes = ['general', 'tool-workflow', 'host-policy', 'stale-doc', 'delivery', 'repro-first', 'parent-roadmap'];
  const cls = classes[index % classes.length];
  return recordLine(`noise-${index}`, 'memory', 'current', `${cls} deterministic baseline noise row ${index}`);
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
  query: typeof GOLD_QUERIES[number],
  shortlist: BaselineRecord[],
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
    }));
    const surfacedIds = [...pack.results.playbookIds, ...pack.results.devMemoryEntryIds];
    const surfaced = new Set(surfacedIds);
    const statusById = new Map(shortlist.map((record) => [record.id, record.status]));
    const mustNotSurfaceIds = [...query.mustNotSurfaceIds];
    return {
      queryId: query.id,
      surfacedIds,
      expectedIdsFound: query.expectedIds.filter((id) => surfaced.has(id)).length,
      candidateFalseSurfaces: mustNotSurfaceIds.filter((id) => surfaced.has(id) && (id.includes('candidate') || statusById.get(id) === 'candidate')).length,
      supersededFalseSurfaces: mustNotSurfaceIds.filter((id) => surfaced.has(id) && statusById.get(id) === 'superseded').length,
      mustNotSurfaceTotal: mustNotSurfaceIds.length,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
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
  if (existsSync(manifestPath)) {
    if (!args.force) throw new Error(`baseline output already exists: ${manifestPath}`);
    rmSync(outputDir, { recursive: true, force: true });
  }
  mkdirSync(outputDir, { recursive: true });

  const fd = openSync(recordsPath, 'w');
  let buffer = '';
  let corruptRows = 0;
  const flush = () => {
    if (buffer.length === 0) return;
    writeSync(fd, buffer);
    buffer = '';
  };
  const updateParts: string[] = [];
  try {
    for (let i = 0; i < recordCount; i += 1) {
      let line: string;
      if (i < GOLD_RECORDS.length) {
        const [id, kind, status, text] = GOLD_RECORDS[i];
        line = recordLine(id, kind, status, text);
      } else if (i % 200_000 === 199_999) {
        line = '{"id":"corrupt-row","kind":';
        corruptRows += 1;
      } else {
        line = noiseRecord(i);
      }
      updateParts.push(line);
      buffer += `${line}\n`;
      if (buffer.length > 1_000_000) flush();
    }
    flush();
  } finally {
    closeSync(fd);
  }

  const recordsDigest = digestText(updateParts.join('\n') + '\n');
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
    fullProfileExactMillion: profile === 'full' && recordCount === 1_000_000,
    recordsDigest,
    goldDigest,
    corruptRows,
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
} = {}): PlaybookRuntimeBaselineVerifyResult {
  const generated = args.inputDir
    ? undefined
    : generatePlaybookRuntimeBaseline({ profile: args.profile ?? 'small', seed: args.seed, force: true });
  const inputDir = args.inputDir ?? generated!.outputDir;
  const started = performance.now();
  const manifest = JSON.parse(readFileSync(join(inputDir, 'manifest.json'), 'utf8')) as PlaybookRuntimeBaselineManifest;
  const recordsRaw = readFileSync(join(inputDir, 'records.jsonl'), 'utf8');
  const staleDetected = digestText(recordsRaw) !== manifest.recordsDigest ? true : false;
  const gold = JSON.parse(readFileSync(join(inputDir, 'gold-queries.json'), 'utf8')) as { queries: typeof GOLD_QUERIES };
  const shortlists = new Map(gold.queries.map((query) => [query.id, [] as Array<{ record: BaselineRecord; score: number }>]));
  let validRows = 0;
  let malformedRowsSkipped = 0;
  for (const line of recordsRaw.split('\n')) {
    if (!line) continue;
    const row = parseBaselineRecord(line);
    if (!row) {
      malformedRowsSkipped += 1;
      continue;
    }
    validRows += 1;
    for (const query of gold.queries) {
      insertScoredRecord(shortlists.get(query.id)!, row, baselineRecordScore(query.query, row));
    }
  }
  const runtimeResults = gold.queries.map((query) =>
    runRuntimeGoldQuery(query, (shortlists.get(query.id) ?? []).map((item) => item.record)));
  const expectedIds = gold.queries.flatMap((query) => [...query.expectedIds]);
  const expectedFound = runtimeResults.reduce((sum, result) => sum + result.expectedIdsFound, 0);
  const candidateFalseSurfaces = runtimeResults.reduce((sum, result) => sum + result.candidateFalseSurfaces, 0);
  const supersededFalseSurfaces = runtimeResults.reduce((sum, result) => sum + result.supersededFalseSurfaces, 0);
  const mustNotSurfaceTotal = runtimeResults.reduce((sum, result) => sum + result.mustNotSurfaceTotal, 0);
  const expectedIdsFoundRate = expectedFound / Math.max(1, expectedIds.length);
  const candidateFalseSurfaceRate = candidateFalseSurfaces / Math.max(1, mustNotSurfaceTotal);
  const supersededFalseSurfaceRate = supersededFalseSurfaces / Math.max(1, mustNotSurfaceTotal);
  const truthFirst = runtimeResults.find((result) => result.queryId === 'truth-first');
  const currentOverSupersededPreferenceRate = truthFirst
    && truthFirst.surfacedIds.includes('mem-truth-current')
    && !truthFirst.surfacedIds.includes('mem-truth-superseded')
    ? 1
    : 0;
  const deprecatedFalseSurfaceRate = supersededFalseSurfaceRate;
  const manifestDomain = {
    schemaVersion: manifest.schemaVersion,
    profile: manifest.profile,
    seed: manifest.seed,
    recordCount: manifest.recordCount,
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
    currentOverSupersededPreferenceRate: 1,
    candidateFalseSurfaceRateMax: 0,
    deprecatedFalseSurfaceRateMax: 0,
  };
  const memory = process.memoryUsage();
  const pass = validRows + malformedRowsSkipped === manifest.recordCount
    && expectedIdsFoundRate >= thresholds.expectedIdsFoundRate
    && currentOverSupersededPreferenceRate >= thresholds.currentOverSupersededPreferenceRate
    && candidateFalseSurfaceRate <= thresholds.candidateFalseSurfaceRateMax
    && deprecatedFalseSurfaceRate <= thresholds.deprecatedFalseSurfaceRateMax
    && manifestDigestStable
    && staleDetected === false;
  return {
    status: pass ? 'pass' : 'fail',
    inputDir,
    profile: manifest.profile,
    recordCount: manifest.recordCount,
    fullProfileExactMillion: manifest.fullProfileExactMillion,
    manifestDigestStable,
    staleDetected,
    correctness: {
      expectedIdsFoundRate,
      currentOverSupersededPreferenceRate,
      candidateFalseSurfaceRate,
      supersededFalseSurfaceRate,
      deprecatedFalseSurfaceRate,
      malformedRowsSkipped,
    },
    thresholds,
    performance: {
      elapsedMs: Math.round(performance.now() - started),
      peakRssBytes: memory.rss,
      peakHeapUsedBytes: memory.heapUsed,
    },
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}
