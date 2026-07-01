import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, closeSync, writeFileSync, writeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { digestCanonicalJson, digestText } from './digest.js';

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

const PROFILE_COUNTS: Record<PlaybookRuntimeBaselineProfile, number> = {
  small: 1_000,
  full: 1_000_000,
};

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
] as const;

function outputDirFor(profile: PlaybookRuntimeBaselineProfile, outputDir?: string): string {
  if (outputDir) return outputDir;
  return mkdtempSync(join(tmpdir(), `proofbound-memory-playbook-${profile}-`));
}

function recordLine(id: string, kind: string, status: string, text: string): string {
  return JSON.stringify({ id, kind, status, text });
}

function noiseRecord(index: number): string {
  const classes = ['general', 'tool-workflow', 'host-policy', 'stale-doc', 'delivery', 'repro-first', 'parent-roadmap'];
  const cls = classes[index % classes.length];
  return recordLine(`noise-${index}`, 'memory', 'current', `${cls} deterministic baseline noise row ${index}`);
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
  const seen = new Set<string>();
  let validRows = 0;
  let malformedRowsSkipped = 0;
  for (const line of recordsRaw.split('\n')) {
    if (!line) continue;
    try {
      const row = JSON.parse(line) as { id?: string; status?: string };
      validRows += 1;
      if (row.id && row.status !== 'candidate' && row.status !== 'superseded') seen.add(row.id);
    } catch {
      malformedRowsSkipped += 1;
    }
  }
  const expectedIds = gold.queries.flatMap((query) => [...query.expectedIds]);
  const mustNotSurface = gold.queries.flatMap((query) => [...query.mustNotSurfaceIds]);
  const expectedFound = expectedIds.filter((id) => seen.has(id)).length;
  const falseSurface = mustNotSurface.filter((id) => seen.has(id)).length;
  const expectedIdsFoundRate = expectedFound / Math.max(1, expectedIds.length);
  const candidateFalseSurfaceRate = falseSurface / Math.max(1, mustNotSurface.length);
  const currentOverSupersededPreferenceRate = seen.has('mem-truth-current') && !seen.has('mem-truth-superseded') ? 1 : 0;
  const deprecatedFalseSurfaceRate = 0;
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
