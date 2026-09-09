import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { STATE_DIR_NAMES } from './brand-paths.js';
import {
  BOUNDARY_ONLY_MEMORY_LAYERS,
  MEMORY_BENCHMARK_TEXT_NOTE,
  SCOREABLE_MEMORY_LAYERS,
  type BoundaryOnlyMemoryLayer,
  type MemoryLayer,
  type ScoreableMemoryLayer,
} from './memory-benchmark.js';

export const MEMORY_BENCHMARK_REAL_DATA_SCHEMA_VERSION = 'proof-or-stop.memory_benchmark_real_data.v1';
export const MEMORY_BENCHMARK_REAL_DATA_NOTE =
  'Real-data baseline export is non-authoritative: it is not Proof-or-Stop lifecycle gate authority, review pass, validation evidence, delivery check, receipt, vector DB, or production memory architecture.';

type SourceType =
  | 'activity'
  | 'story'
  | 'checklist'
  | 'summary'
  | 'evidence'
  | 'process-event'
  | 'dev-memory';

type Verdict = 'PASS' | 'FAIL';

export interface MemoryBenchmarkRealDataOptions {
  root: string;
  outputDir?: string;
}

export interface MemoryBenchmarkRealDataSourceStats {
  sourcePath: string;
  sourceHash: string | null;
  sourceType: SourceType | 'story-root';
  exists: boolean;
  records: number;
  scoreableRecords: number;
  boundaryOnlyRecords: number;
  errors: string[];
}

export interface MemoryBenchmarkRealDataCorpusRecord {
  schemaVersion: string;
  recordId: string;
  layer: MemoryLayer;
  sourcePath: string;
  sourceHash: string;
  sourceType: SourceType;
  sourceLine?: number;
  storyId?: string;
  itemId?: string;
  factType: string;
  scoreable: boolean;
  boundaryOnly: boolean;
  text: string;
  fact: Record<string, unknown>;
  note: string;
}

export interface MemoryBenchmarkRealDataGoldRecord {
  schemaVersion: string;
  goldId: string;
  recordId: string;
  layer: ScoreableMemoryLayer;
  sourcePath: string;
  sourceHash: string;
  factType: string;
  expectedText: string;
  scoreable: true;
  note: string;
}

export interface MemoryBenchmarkRealDataQueryRecord {
  schemaVersion: string;
  queryId: string;
  goldId: string;
  recordId: string;
  layer: ScoreableMemoryLayer;
  sourcePath: string;
  sourceHash: string;
  query: string;
  scoreable: true;
  note: string;
}

export interface MemoryBenchmarkRealDataResultRecord {
  schemaVersion: string;
  queryId: string;
  goldId: string;
  recordId: string;
  layer: ScoreableMemoryLayer;
  sourcePath: string;
  sourceHash: string;
  matched: boolean;
  boundaryOnly: false;
  note: string;
}

export interface MemoryBenchmarkRealDataOutputFiles {
  corpus: string;
  gold: string;
  queries: string;
  result: string;
}

export interface MemoryBenchmarkRealDataStats {
  corpusRecords: number;
  scoreableCorpusRecords: number;
  boundaryOnlyCorpusRecords: number;
  activityScoreableRecords: number;
  storyScoreableRecords: number;
  checklistScoreableRecords: number;
  summaryScoreableRecords: number;
  evidenceScoreableRecords: number;
  devMemoryBoundaryRecords: number;
  goldRecords: number;
  queryRecords: number;
  resultRecords: number;
  boundaryGoldRecords: number;
  boundaryQueryRecords: number;
  exactRecordMatchRate: number;
}

export interface MemoryBenchmarkRealDataRunResult {
  schemaVersion: string;
  generatedAt: string;
  root: string;
  note: string;
  virtualBenchmarkNote: string;
  verdict: Verdict;
  pass: boolean;
  reasons: string[];
  stats: MemoryBenchmarkRealDataStats;
  layers: {
    scoreable: readonly ScoreableMemoryLayer[];
    boundaryOnly: readonly BoundaryOnlyMemoryLayer[];
  };
  sources: MemoryBenchmarkRealDataSourceStats[];
  outputFiles?: MemoryBenchmarkRealDataOutputFiles;
  corpus: MemoryBenchmarkRealDataCorpusRecord[];
  gold: MemoryBenchmarkRealDataGoldRecord[];
  queries: MemoryBenchmarkRealDataQueryRecord[];
  results: MemoryBenchmarkRealDataResultRecord[];
}

interface SourceFile {
  sourcePath: string;
  sourceHash: string;
  text: string;
}

interface SourceAccumulator {
  sourcePath: string;
  sourceHash: string | null;
  sourceType: MemoryBenchmarkRealDataSourceStats['sourceType'];
  exists: boolean;
  records: number;
  scoreableRecords: number;
  boundaryOnlyRecords: number;
  errors: string[];
}

interface AddRecordInput {
  layer: MemoryLayer;
  sourceType: SourceType;
  sourcePath: string;
  sourceHash: string;
  sourceLine?: number;
  storyId?: string;
  itemId?: string;
  factType: string;
  scoreable: boolean;
  text: string;
  fact: Record<string, unknown>;
}

// B-cc10 F-028: these hardcoded the deprecated spelling only, so on a migrated repo the
// benchmark reported verdict=FAIL "missing real activity source" while 1500+ real lines
// sat under the canonical dir. Derive every accepted spelling, canonical first.
const DEFAULT_STORY_ROOTS = [
  ...STATE_DIR_NAMES.map((dir) => `${dir}/story/actives`),
  'docs/story/actives',
] as const;
const PROTECTED_STORY_OUTPUT_ROOTS = [
  ...STATE_DIR_NAMES.map((dir) => `${dir}/story`),
  'docs/story',
] as const;
const PROTECTED_FIXTURE_OUTPUT_ROOTS = ['packages/main/tests/fixtures'] as const;
const ACTIVITY_SOURCE_CANDIDATES = STATE_DIR_NAMES.map((dir) => `${dir}/activity.jsonl`);
const DEV_MEMORY_SOURCE_CANDIDATES = STATE_DIR_NAMES.map((dir) => `${dir}/dev-memory/experience.jsonl`);
/** First existing candidate, canonical first; falls back to canonical for error text. */
function resolveSource(root: string, candidates: readonly string[]): string {
  for (const rel of candidates) {
    if (existsSync(join(root, rel))) return rel;
  }
  return candidates[0];
}

const STORY_EVIDENCE_JSON_FILES = [
  'test-evidence.json',
  'delivery-check.json',
  'review-passes.json',
  'review-runs.json',
  'findings.json',
  'review-pass.json',
  'implementation-review.json',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function recordDigest(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

function normalizeRelPath(root: string, absPath: string): string {
  return relative(root, absPath).replace(/\\/g, '/');
}

function sourceAbsPath(root: string, sourcePath: string): string {
  return join(root, sourcePath);
}

function normalizeProjectRelPath(root: string, candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!trimmed) return null;
  const absPath = isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed);
  const rel = relative(root, absPath).replace(/\\/g, '/');
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return null;
  return rel;
}

function isPathUnderOrEqual(relPath: string, protectedRelPath: string): boolean {
  const normalizedRelPath = relPath.toLowerCase();
  const normalizedProtectedRelPath = protectedRelPath.toLowerCase();
  return normalizedRelPath === normalizedProtectedRelPath || normalizedRelPath.startsWith(`${normalizedProtectedRelPath}/`);
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function compact(value: unknown, maxLength = 360): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  const normalized = (raw ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function sourceStatsKey(sourcePath: string, sourceHash: string | null): string {
  return `${sourcePath}\0${sourceHash ?? ''}`;
}

function registerSource(
  sources: Map<string, SourceAccumulator>,
  input: Pick<SourceAccumulator, 'sourcePath' | 'sourceHash' | 'sourceType' | 'exists'>,
): SourceAccumulator {
  const key = sourceStatsKey(input.sourcePath, input.sourceHash);
  const existing = sources.get(key);
  if (existing) return existing;
  const next: SourceAccumulator = {
    ...input,
    records: 0,
    scoreableRecords: 0,
    boundaryOnlyRecords: 0,
    errors: [],
  };
  sources.set(key, next);
  return next;
}

function readSourceFile(
  root: string,
  sourcePath: string,
  sourceType: MemoryBenchmarkRealDataSourceStats['sourceType'],
  sources: Map<string, SourceAccumulator>,
): SourceFile | null {
  const absPath = sourceAbsPath(root, sourcePath);
  if (!existsSync(absPath)) {
    registerSource(sources, { sourcePath, sourceHash: null, sourceType, exists: false });
    return null;
  }
  try {
    const text = readFileSync(absPath, 'utf-8');
    const sourceHash = hashText(text);
    registerSource(sources, { sourcePath, sourceHash, sourceType, exists: true });
    return { sourcePath, sourceHash, text };
  } catch (error) {
    const stat = registerSource(sources, { sourcePath, sourceHash: null, sourceType, exists: true });
    stat.errors.push(`read failed: ${(error as Error).message}`);
    return null;
  }
}

function addCorpusRecord(
  sources: Map<string, SourceAccumulator>,
  corpus: MemoryBenchmarkRealDataCorpusRecord[],
  input: AddRecordInput,
): void {
  const boundaryOnly = !input.scoreable;
  const recordId = `${input.factType}:${recordDigest([
    input.sourcePath,
    input.sourceHash,
    input.sourceLine,
    input.storyId,
    input.itemId,
    input.factType,
    input.text,
  ])}`;
  const record: MemoryBenchmarkRealDataCorpusRecord = {
    schemaVersion: MEMORY_BENCHMARK_REAL_DATA_SCHEMA_VERSION,
    recordId,
    layer: input.layer,
    sourcePath: input.sourcePath,
    sourceHash: input.sourceHash,
    sourceType: input.sourceType,
    sourceLine: input.sourceLine,
    storyId: input.storyId,
    itemId: input.itemId,
    factType: input.factType,
    scoreable: input.scoreable,
    boundaryOnly,
    text: input.text,
    fact: input.fact,
    note: MEMORY_BENCHMARK_REAL_DATA_NOTE,
  };
  corpus.push(record);

  const stat = registerSource(sources, {
    sourcePath: input.sourcePath,
    sourceHash: input.sourceHash,
    sourceType: input.sourceType,
    exists: true,
  });
  stat.records += 1;
  if (input.scoreable) stat.scoreableRecords += 1;
  else stat.boundaryOnlyRecords += 1;
}

function parseJson(source: SourceFile, sources: Map<string, SourceAccumulator>): unknown | null {
  try {
    return JSON.parse(source.text);
  } catch (error) {
    const stat = registerSource(sources, {
      sourcePath: source.sourcePath,
      sourceHash: source.sourceHash,
      sourceType: 'story',
      exists: true,
    });
    stat.errors.push(`json parse failed: ${(error as Error).message}`);
    return null;
  }
}

function parseJsonl(source: SourceFile, sourceType: SourceType, sources: Map<string, SourceAccumulator>): Array<{ line: number; value: unknown }> {
  const parsed: Array<{ line: number; value: unknown }> = [];
  const stat = registerSource(sources, {
    sourcePath: source.sourcePath,
    sourceHash: source.sourceHash,
    sourceType,
    exists: true,
  });
  const lines = source.text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      parsed.push({ line: index + 1, value: JSON.parse(line) });
    } catch (error) {
      stat.errors.push(`line ${index + 1} json parse failed: ${(error as Error).message}`);
    }
  }
  return parsed;
}

function collectActivity(
  root: string,
  sources: Map<string, SourceAccumulator>,
  corpus: MemoryBenchmarkRealDataCorpusRecord[],
): void {
  const source = readSourceFile(root, resolveSource(root, ACTIVITY_SOURCE_CANDIDATES), 'activity', sources);
  if (!source) return;
  for (const entry of parseJsonl(source, 'activity', sources)) {
    if (!isRecord(entry.value)) continue;
    const detail = isRecord(entry.value.detail) ? entry.value.detail : {};
    const args = isRecord(entry.value.args)
      ? entry.value.args
      : isRecord(detail.args)
        ? detail.args
        : {};
    const storyId = safeString(entry.value.storyId) || safeString(args.storyId) || safeString(args.story);
    const command =
      safeString(entry.value.tool)
      || safeString(detail.tool)
      || safeString(detail.command)
      || safeString(detail.type)
      || safeString(entry.value.detail)
      || safeString(entry.value.command)
      || safeString(entry.value.type)
      || 'unknown';
    const status = safeString(entry.value.status) || safeString(detail.status);
    const legacySuccess = typeof entry.value.success === 'boolean' ? entry.value.success : undefined;
    const success = legacySuccess ?? (
      status ? ['ok', 'success', 'pass', 'passed'].includes(status.toLowerCase()) : undefined
    );
    const outcome = status || (legacySuccess === undefined ? undefined : legacySuccess ? 'success' : 'failure');
    const timestamp = safeString(entry.value.timestamp) || safeString(entry.value.startTime) || safeString(entry.value.endTime);
    const text = `activity command=${command} story=${storyId ?? 'n/a'} outcome=${outcome ?? 'n/a'} success=${success ?? 'n/a'} time=${timestamp ?? 'n/a'}`;
    addCorpusRecord(sources, corpus, {
      layer: 'raw_event_memory',
      sourceType: 'activity',
      sourcePath: source.sourcePath,
      sourceHash: source.sourceHash,
      sourceLine: entry.line,
      storyId,
      factType: 'activity_event',
      scoreable: true,
      text,
      fact: { command, storyId, status: outcome, success, timestamp },
    });
  }
}

function resolveStoryRootPaths(root: string): string[] {
  const roots = new Set<string>(DEFAULT_STORY_ROOTS);
  try {
    const configured = normalizeProjectRelPath(root, loadConfig(root).storyDir);
    if (configured) roots.add(configured);
  } catch {
    // Missing config should not make path resolution nondeterministic.
  }
  return [...roots].sort();
}

function listStoryDirs(root: string, sources: Map<string, SourceAccumulator>): Array<{ storyId: string; sourcePath: string; absPath: string }> {
  const dirs: Array<{ storyId: string; sourcePath: string; absPath: string }> = [];
  for (const storyRoot of resolveStoryRootPaths(root)) {
    const absRoot = sourceAbsPath(root, storyRoot);
    if (!existsSync(absRoot)) {
      registerSource(sources, { sourcePath: storyRoot, sourceHash: null, sourceType: 'story-root', exists: false });
      continue;
    }
    registerSource(sources, { sourcePath: storyRoot, sourceHash: null, sourceType: 'story-root', exists: true });
    for (const entry of readdirSync(absRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      dirs.push({
        storyId: entry.name,
        sourcePath: `${storyRoot}/${entry.name}`,
        absPath: join(absRoot, entry.name),
      });
    }
  }
  return dirs;
}

function collectStoryIndex(
  source: SourceFile,
  sources: Map<string, SourceAccumulator>,
  corpus: MemoryBenchmarkRealDataCorpusRecord[],
): void {
  const parsed = parseJson(source, sources);
  if (!isRecord(parsed)) return;
  const storyId = safeString(parsed.storyId) || safeString(parsed.id) || safeString(parsed.name);
  const phase = safeString(parsed.phase) || 'unknown';
  const title = safeString(parsed.title) || safeString(parsed.name) || 'untitled';
  const priority = safeString(parsed.priority) || 'unknown';
  addCorpusRecord(sources, corpus, {
    layer: 'lifecycle_state_memory',
    sourceType: 'story',
    sourcePath: source.sourcePath,
    sourceHash: source.sourceHash,
    storyId,
    factType: 'story_state',
    scoreable: true,
    text: `story ${storyId ?? 'unknown'} phase=${phase} priority=${priority} title=${title}`,
    fact: { storyId, phase, priority, title, type: parsed.type, createdAt: parsed.createdAt, endedAt: parsed.endedAt },
  });

  const events = Array.isArray(parsed.events) ? parsed.events : [];
  events.forEach((event, index) => {
    if (!isRecord(event)) return;
    const eventPhase = safeString(event.phase) || 'unknown';
    const action = safeString(event.action) || 'unknown';
    const timestamp = safeString(event.timestamp);
    addCorpusRecord(sources, corpus, {
      layer: 'lifecycle_state_memory',
      sourceType: 'story',
      sourcePath: source.sourcePath,
      sourceHash: source.sourceHash,
      storyId,
      factType: 'story_event',
      scoreable: true,
      text: `story ${storyId ?? 'unknown'} event ${index + 1}: action=${action} phase=${eventPhase} time=${timestamp ?? 'n/a'}`,
      fact: { storyId, action, phase: eventPhase, timestamp, agent: event.agent, sessionId: event.sessionId },
    });
  });
}

function collectChecklist(
  source: SourceFile,
  sources: Map<string, SourceAccumulator>,
  corpus: MemoryBenchmarkRealDataCorpusRecord[],
  storyIdFromDir: string,
): void {
  const parsed = parseJson(source, sources);
  if (!isRecord(parsed)) return;
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const itemId = safeString(item.id) || 'unknown';
    const title = safeString(item.title) || 'untitled';
    const status = safeString(item.status) || 'unknown';
    addCorpusRecord(sources, corpus, {
      layer: 'checklist_evidence_memory',
      sourceType: 'checklist',
      sourcePath: source.sourcePath,
      sourceHash: source.sourceHash,
      storyId: storyIdFromDir,
      itemId,
      factType: 'checklist_item',
      scoreable: true,
      text: `checklist ${storyIdFromDir} ${itemId} status=${status} title=${title}`,
      fact: { storyId: storyIdFromDir, itemId, status, title, context: item.context },
    });

    const verificationIntent = isRecord(item.verificationIntent) ? item.verificationIntent : {};
    for (const lane of ['happy', 'edge', 'adversarial'] as const) {
      const laneItems = Array.isArray(verificationIntent[lane]) ? verificationIntent[lane] : [];
      laneItems.forEach((intent, index) => {
        if (!isRecord(intent)) return;
        addCorpusRecord(sources, corpus, {
          layer: 'checklist_evidence_memory',
          sourceType: 'checklist',
          sourcePath: source.sourcePath,
          sourceHash: source.sourceHash,
          storyId: storyIdFromDir,
          itemId,
          factType: 'verification_intent',
          scoreable: true,
          text: `verification intent ${storyIdFromDir} ${itemId}:${lane}:${index} type=${safeString(intent.type) ?? 'unknown'} desc=${compact(intent.desc)}`,
          fact: { storyId: storyIdFromDir, itemId, lane, index, desc: intent.desc, type: intent.type },
        });
      });
    }

    const evidence = Array.isArray(item.verificationEvidence) ? item.verificationEvidence : [];
    evidence.forEach((entry, index) => {
      if (!isRecord(entry)) return;
      addCorpusRecord(sources, corpus, {
        layer: 'checklist_evidence_memory',
        sourceType: 'evidence',
        sourcePath: source.sourcePath,
        sourceHash: source.sourceHash,
        storyId: storyIdFromDir,
        itemId,
        factType: 'verification_evidence',
        scoreable: true,
        text: `verification evidence ${storyIdFromDir} ${itemId} #${index + 1} intent=${safeString(entry.intentRef) ?? 'n/a'} kind=${safeString(entry.kind) ?? 'n/a'} result=${safeString(entry.result) ?? 'n/a'} note=${compact(entry.note)}`,
        fact: {
          storyId: storyIdFromDir,
          itemId,
          index,
          intentRef: entry.intentRef,
          kind: entry.kind,
          result: entry.result,
          command: entry.command,
          file: entry.file,
          note: entry.note,
        },
      });
    });
  }

  const auditLog = Array.isArray(parsed.auditLog) ? parsed.auditLog : [];
  auditLog.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    addCorpusRecord(sources, corpus, {
      layer: 'raw_event_memory',
      sourceType: 'process-event',
      sourcePath: source.sourcePath,
      sourceHash: source.sourceHash,
      storyId: storyIdFromDir,
      itemId: safeString(entry.itemId),
      factType: 'checklist_audit_event',
      scoreable: true,
      text: `checklist audit ${storyIdFromDir} #${index + 1} item=${safeString(entry.itemId) ?? 'n/a'} action=${safeString(entry.action) ?? 'n/a'} from=${safeString(entry.from) ?? 'n/a'} to=${safeString(entry.to) ?? 'n/a'}`,
      fact: { storyId: storyIdFromDir, index, itemId: entry.itemId, action: entry.action, from: entry.from, to: entry.to, timestamp: entry.timestamp },
    });
  });
}

function collectSummary(
  source: SourceFile,
  sources: Map<string, SourceAccumulator>,
  corpus: MemoryBenchmarkRealDataCorpusRecord[],
  storyIdFromDir: string,
): void {
  const parsed = parseJson(source, sources);
  if (!isRecord(parsed)) return;
  const storyId = safeString(parsed.storyId) || storyIdFromDir;
  addCorpusRecord(sources, corpus, {
    layer: 'summary_memory',
    sourceType: 'summary',
    sourcePath: source.sourcePath,
    sourceHash: source.sourceHash,
    storyId,
    factType: 'story_summary',
    scoreable: true,
    text: `summary ${storyId} outcome=${safeString(parsed.acceptanceVerdict) ?? 'n/a'} changes=${compact(parsed.changes)} usage=${compact(parsed.usage)} limitations=${compact(parsed.limitations)}`,
    fact: {
      storyId,
      changes: parsed.changes,
      usage: parsed.usage,
      expectedOutcome: parsed.expectedOutcome,
      actualTranscript: parsed.actualTranscript,
      outcomeDiff: parsed.outcomeDiff,
      acceptanceVerdict: parsed.acceptanceVerdict,
      limitations: parsed.limitations,
    },
  });
}

function collectGenericEvidenceJson(
  source: SourceFile,
  sources: Map<string, SourceAccumulator>,
  corpus: MemoryBenchmarkRealDataCorpusRecord[],
  storyIdFromDir: string,
): void {
  const parsed = parseJson(source, sources);
  if (parsed === null) return;
  addCorpusRecord(sources, corpus, {
    layer: 'checklist_evidence_memory',
    sourceType: 'evidence',
    sourcePath: source.sourcePath,
    sourceHash: source.sourceHash,
    storyId: storyIdFromDir,
    factType: 'story_evidence_artifact',
    scoreable: true,
    text: `evidence artifact ${storyIdFromDir} ${source.sourcePath}: ${compact(parsed)}`,
    fact: { storyId: storyIdFromDir, excerpt: compact(parsed, 900) },
  });
}

function collectProcessEvents(
  source: SourceFile,
  sources: Map<string, SourceAccumulator>,
  corpus: MemoryBenchmarkRealDataCorpusRecord[],
  storyIdFromDir: string,
): void {
  for (const entry of parseJsonl(source, 'process-event', sources)) {
    if (!isRecord(entry.value)) continue;
    const type = safeString(entry.value.type) || safeString(entry.value.command) || 'unknown';
    const timestamp = safeString(entry.value.timestamp) || safeString(entry.value.createdAt);
    addCorpusRecord(sources, corpus, {
      layer: 'raw_event_memory',
      sourceType: 'process-event',
      sourcePath: source.sourcePath,
      sourceHash: source.sourceHash,
      sourceLine: entry.line,
      storyId: storyIdFromDir,
      factType: 'story_process_event',
      scoreable: true,
      text: `process event ${storyIdFromDir} type=${type} time=${timestamp ?? 'n/a'} data=${compact(entry.value)}`,
      fact: { storyId: storyIdFromDir, type, timestamp, excerpt: compact(entry.value, 900) },
    });
  }
}

function collectDevMemoryJsonl(
  source: SourceFile,
  sources: Map<string, SourceAccumulator>,
  corpus: MemoryBenchmarkRealDataCorpusRecord[],
  storyId?: string,
): void {
  for (const entry of parseJsonl(source, 'dev-memory', sources)) {
    if (!isRecord(entry.value)) continue;
    const id = safeString(entry.value.id) || `line-${entry.line}`;
    const summary = safeString(entry.value.summary) || compact(entry.value);
    addCorpusRecord(sources, corpus, {
      layer: 'advisory_memory',
      sourceType: 'dev-memory',
      sourcePath: source.sourcePath,
      sourceHash: source.sourceHash,
      sourceLine: entry.line,
      storyId: storyId || safeString(entry.value.sourceStoryId),
      factType: 'dev_memory_boundary',
      scoreable: false,
      text: `dev-memory advisory ${id}: ${summary}`,
      fact: {
        id,
        storyId: storyId || entry.value.sourceStoryId,
        category: entry.value.category,
        scope: entry.value.scope,
        summary: entry.value.summary,
        authority: entry.value.authority,
        gateEvidence: entry.value.gateEvidence,
      },
    });
  }
}

function collectStoryArtifacts(
  root: string,
  sources: Map<string, SourceAccumulator>,
  corpus: MemoryBenchmarkRealDataCorpusRecord[],
): void {
  for (const storyDir of listStoryDirs(root, sources)) {
    const readStoryFile = (fileName: string, sourceType: MemoryBenchmarkRealDataSourceStats['sourceType']): SourceFile | null => {
      const absPath = join(storyDir.absPath, fileName);
      if (!existsSync(absPath)) return null;
      return readSourceFile(root, normalizeRelPath(root, absPath), sourceType, sources);
    };

    const index = readStoryFile('index.json', 'story');
    if (index) collectStoryIndex(index, sources, corpus);

    const checklist = readStoryFile('checklist.json', 'checklist');
    if (checklist) collectChecklist(checklist, sources, corpus, storyDir.storyId);

    const summary = readStoryFile('summary.json', 'summary');
    if (summary) collectSummary(summary, sources, corpus, storyDir.storyId);

    for (const evidenceFile of STORY_EVIDENCE_JSON_FILES) {
      const evidence = readStoryFile(evidenceFile, 'evidence');
      if (evidence) collectGenericEvidenceJson(evidence, sources, corpus, storyDir.storyId);
    }

    const processEvents = readStoryFile('process-events.jsonl', 'process-event');
    if (processEvents) collectProcessEvents(processEvents, sources, corpus, storyDir.storyId);

    const devMemoryCandidates = readStoryFile('dev-memory-candidates.jsonl', 'dev-memory');
    if (devMemoryCandidates) collectDevMemoryJsonl(devMemoryCandidates, sources, corpus, storyDir.storyId);
  }
}

function collectProjectDevMemory(
  root: string,
  sources: Map<string, SourceAccumulator>,
  corpus: MemoryBenchmarkRealDataCorpusRecord[],
): void {
  const source = readSourceFile(root, resolveSource(root, DEV_MEMORY_SOURCE_CANDIDATES), 'dev-memory', sources);
  if (!source) return;
  collectDevMemoryJsonl(source, sources, corpus);
}

function queryFor(record: MemoryBenchmarkRealDataCorpusRecord): string {
  const storySuffix = record.storyId ? ` for story ${record.storyId}` : '';
  if (record.layer === 'raw_event_memory') return `Retrieve the real lifecycle event fact${storySuffix} from ${record.sourcePath}.`;
  if (record.layer === 'lifecycle_state_memory') return `Retrieve the real lifecycle state fact${storySuffix} from ${record.sourcePath}.`;
  if (record.layer === 'checklist_evidence_memory') return `Retrieve the real checklist or evidence fact${storySuffix}${record.itemId ? ` item ${record.itemId}` : ''} from ${record.sourcePath}.`;
  return `Retrieve the real story summary fact${storySuffix} from ${record.sourcePath}.`;
}

function buildGoldAndQueries(corpus: readonly MemoryBenchmarkRealDataCorpusRecord[]): {
  gold: MemoryBenchmarkRealDataGoldRecord[];
  queries: MemoryBenchmarkRealDataQueryRecord[];
  results: MemoryBenchmarkRealDataResultRecord[];
} {
  const gold: MemoryBenchmarkRealDataGoldRecord[] = [];
  const queries: MemoryBenchmarkRealDataQueryRecord[] = [];
  const results: MemoryBenchmarkRealDataResultRecord[] = [];
  const scoreableLayers = new Set<MemoryLayer>(SCOREABLE_MEMORY_LAYERS);
  for (const record of corpus) {
    if (!record.scoreable || !scoreableLayers.has(record.layer)) continue;
    const layer = record.layer as ScoreableMemoryLayer;
    const goldId = `gold:${recordDigest([record.recordId, record.sourceHash, record.text])}`;
    const queryId = `query:${recordDigest([goldId, record.layer, record.sourcePath])}`;
    gold.push({
      schemaVersion: MEMORY_BENCHMARK_REAL_DATA_SCHEMA_VERSION,
      goldId,
      recordId: record.recordId,
      layer,
      sourcePath: record.sourcePath,
      sourceHash: record.sourceHash,
      factType: record.factType,
      expectedText: record.text,
      scoreable: true,
      note: MEMORY_BENCHMARK_REAL_DATA_NOTE,
    });
    queries.push({
      schemaVersion: MEMORY_BENCHMARK_REAL_DATA_SCHEMA_VERSION,
      queryId,
      goldId,
      recordId: record.recordId,
      layer,
      sourcePath: record.sourcePath,
      sourceHash: record.sourceHash,
      query: queryFor(record),
      scoreable: true,
      note: MEMORY_BENCHMARK_REAL_DATA_NOTE,
    });
    results.push({
      schemaVersion: MEMORY_BENCHMARK_REAL_DATA_SCHEMA_VERSION,
      queryId,
      goldId,
      recordId: record.recordId,
      layer,
      sourcePath: record.sourcePath,
      sourceHash: record.sourceHash,
      matched: true,
      boundaryOnly: false,
      note: MEMORY_BENCHMARK_REAL_DATA_NOTE,
    });
  }
  return { gold, queries, results };
}

function buildStats(
  corpus: readonly MemoryBenchmarkRealDataCorpusRecord[],
  gold: readonly MemoryBenchmarkRealDataGoldRecord[],
  queries: readonly MemoryBenchmarkRealDataQueryRecord[],
  results: readonly MemoryBenchmarkRealDataResultRecord[],
): MemoryBenchmarkRealDataStats {
  const scoreableCorpus = corpus.filter((record) => record.scoreable);
  const resultMatches = results.filter((record) => record.matched).length;
  return {
    corpusRecords: corpus.length,
    scoreableCorpusRecords: scoreableCorpus.length,
    boundaryOnlyCorpusRecords: corpus.filter((record) => record.boundaryOnly).length,
    activityScoreableRecords: scoreableCorpus.filter((record) => record.sourceType === 'activity').length,
    storyScoreableRecords: scoreableCorpus.filter((record) => record.sourceType === 'story' || record.sourceType === 'process-event').length,
    checklistScoreableRecords: scoreableCorpus.filter((record) => record.sourceType === 'checklist').length,
    summaryScoreableRecords: scoreableCorpus.filter((record) => record.sourceType === 'summary').length,
    evidenceScoreableRecords: scoreableCorpus.filter((record) => record.sourceType === 'evidence').length,
    devMemoryBoundaryRecords: corpus.filter((record) => record.sourceType === 'dev-memory' && record.boundaryOnly).length,
    goldRecords: gold.length,
    queryRecords: queries.length,
    resultRecords: results.length,
    boundaryGoldRecords: gold.filter((record) => !SCOREABLE_MEMORY_LAYERS.includes(record.layer)).length,
    boundaryQueryRecords: queries.filter((record) => !SCOREABLE_MEMORY_LAYERS.includes(record.layer)).length,
    exactRecordMatchRate: results.length === 0 ? 0 : resultMatches / results.length,
  };
}

function buildReasons(stats: MemoryBenchmarkRealDataStats, sources: readonly MemoryBenchmarkRealDataSourceStats[]): string[] {
  const reasons: string[] = [];
  // B-cc10 F-028: match against EVERY accepted spelling. `sources` already holds the
  // path that was actually read, so no filesystem probe (and no `root`) is needed here.
  const activitySource = sources.find((source) => ACTIVITY_SOURCE_CANDIDATES.includes(source.sourcePath));
  const activityRel = activitySource?.sourcePath ?? ACTIVITY_SOURCE_CANDIDATES[0];
  const storyRoots = sources.filter((source) => source.sourceType === 'story-root');
  const existingStoryRoots = storyRoots.filter((source) => source.exists);
  if (!activitySource?.exists) reasons.push(`missing real activity source: ${activityRel}`);
  if (activitySource?.exists && stats.activityScoreableRecords === 0) reasons.push(`no scoreable activity records found in ${activityRel}`);
  if (existingStoryRoots.length === 0) {
    const expectedRoots = storyRoots.map((source) => source.sourcePath).join(', ') || DEFAULT_STORY_ROOTS.join(', ');
    reasons.push(`missing real story source root: ${expectedRoots}`);
  }
  if (existingStoryRoots.length > 0 && stats.storyScoreableRecords === 0) {
    reasons.push(`no scoreable story lifecycle records found in ${existingStoryRoots.map((source) => source.sourcePath).join(', ')}`);
  }
  if (stats.scoreableCorpusRecords === 0) reasons.push('no scoreable lifecycle corpus records were exported');
  if (stats.goldRecords === 0) reasons.push('no scoreable gold records were generated from real lifecycle data');
  if (stats.queryRecords === 0) reasons.push('no scoreable query records were generated from real lifecycle data');
  if (stats.boundaryGoldRecords > 0) reasons.push('boundary-only records leaked into gold scoring');
  if (stats.boundaryQueryRecords > 0) reasons.push('boundary-only records leaked into query scoring');
  for (const source of sources) {
    for (const error of source.errors) reasons.push(`${source.sourcePath}: ${error}`);
  }
  return reasons;
}

function sortedSources(sources: Map<string, SourceAccumulator>): MemoryBenchmarkRealDataSourceStats[] {
  return [...sources.values()]
    .map((source) => ({
      sourcePath: source.sourcePath,
      sourceHash: source.sourceHash,
      sourceType: source.sourceType,
      exists: source.exists,
      records: source.records,
      scoreableRecords: source.scoreableRecords,
      boundaryOnlyRecords: source.boundaryOnlyRecords,
      errors: [...source.errors],
    }))
    .sort((a, b) => a.sourcePath.localeCompare(b.sourcePath) || String(a.sourceHash).localeCompare(String(b.sourceHash)));
}

function writeJsonl(filePath: string, rows: readonly unknown[]): void {
  writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : ''), 'utf-8');
}

function assertAllowedOutputDir(root: string, outputDir: string): string {
  const absOutputDir = isAbsolute(outputDir) ? outputDir : resolve(root, outputDir);
  const rel = relative(root, absOutputDir).replace(/\\/g, '/');
  const protectedRoots = new Set<string>([
    ...PROTECTED_STORY_OUTPUT_ROOTS,
    ...PROTECTED_FIXTURE_OUTPUT_ROOTS,
  ]);
  try {
    const config = loadConfig(root);
    const configuredStoryDir = normalizeProjectRelPath(root, config.storyDir);
    const configuredFixturesDir = normalizeProjectRelPath(root, config.fixturesDir);
    if (configuredStoryDir) protectedRoots.add(configuredStoryDir);
    if (configuredFixturesDir) protectedRoots.add(configuredFixturesDir);
  } catch {
    // Config read failures should not weaken the built-in lifecycle protections.
  }
  for (const protectedRoot of [...protectedRoots].sort((a, b) => b.length - a.length)) {
    if (isPathUnderOrEqual(rel, protectedRoot)) {
      throw new Error(`memory_benchmark_real_data refuses to write outputDir under ${protectedRoot}`);
    }
  }
  return absOutputDir;
}

function assertOutputFilesDoNotExist(files: MemoryBenchmarkRealDataOutputFiles): void {
  const existing = Object.values(files).filter((filePath) => existsSync(filePath));
  if (existing.length > 0) {
    throw new Error(`memory_benchmark_real_data refuses to overwrite output files: ${existing.join(', ')}`);
  }
}

function writeOutputFiles(
  root: string,
  outputDir: string,
  corpus: readonly MemoryBenchmarkRealDataCorpusRecord[],
  gold: readonly MemoryBenchmarkRealDataGoldRecord[],
  queries: readonly MemoryBenchmarkRealDataQueryRecord[],
  result: Omit<MemoryBenchmarkRealDataRunResult, 'corpus' | 'gold' | 'queries'>,
): MemoryBenchmarkRealDataOutputFiles {
  const absOutputDir = assertAllowedOutputDir(root, outputDir);
  const files: MemoryBenchmarkRealDataOutputFiles = {
    corpus: join(absOutputDir, 'corpus.jsonl'),
    gold: join(absOutputDir, 'gold.jsonl'),
    queries: join(absOutputDir, 'queries.jsonl'),
    result: join(absOutputDir, 'result.json'),
  };
  assertOutputFilesDoNotExist(files);
  mkdirSync(absOutputDir, { recursive: true });
  writeJsonl(files.corpus, corpus);
  writeJsonl(files.gold, gold);
  writeJsonl(files.queries, queries);
  writeFileSync(files.result, `${JSON.stringify(result, null, 2)}\n`, 'utf-8');
  return files;
}

export function runMemoryBenchmarkRealData(options: MemoryBenchmarkRealDataOptions): MemoryBenchmarkRealDataRunResult {
  const root = resolve(options.root);
  const sources = new Map<string, SourceAccumulator>();
  const corpus: MemoryBenchmarkRealDataCorpusRecord[] = [];

  collectActivity(root, sources, corpus);
  collectStoryArtifacts(root, sources, corpus);
  collectProjectDevMemory(root, sources, corpus);

  corpus.sort((a, b) => (
    a.sourcePath.localeCompare(b.sourcePath)
    || (a.sourceLine ?? 0) - (b.sourceLine ?? 0)
    || a.recordId.localeCompare(b.recordId)
  ));
  const { gold, queries, results } = buildGoldAndQueries(corpus);
  const sourceStats = sortedSources(sources);
  const stats = buildStats(corpus, gold, queries, results);
  const reasons = buildReasons(stats, sourceStats);
  const pass = reasons.length === 0;
  const baseResult = {
    schemaVersion: MEMORY_BENCHMARK_REAL_DATA_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    root,
    note: MEMORY_BENCHMARK_REAL_DATA_NOTE,
    virtualBenchmarkNote: MEMORY_BENCHMARK_TEXT_NOTE,
    verdict: pass ? 'PASS' as const : 'FAIL' as const,
    pass,
    reasons,
    stats,
    layers: {
      scoreable: SCOREABLE_MEMORY_LAYERS,
      boundaryOnly: BOUNDARY_ONLY_MEMORY_LAYERS,
    },
    sources: sourceStats,
    results,
  };
  const outputFiles = options.outputDir
    ? writeOutputFiles(root, options.outputDir, corpus, gold, queries, baseResult)
    : undefined;
  return {
    ...baseResult,
    outputFiles,
    corpus,
    gold,
    queries,
  };
}

function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

export function renderMemoryBenchmarkRealDataText(result: MemoryBenchmarkRealDataRunResult): string {
  const lines = [
    `Real Memory Benchmark Data: ${result.verdict}`,
    `note: ${result.note}`,
    `corpusRecords=${result.stats.corpusRecords} scoreableCorpusRecords=${result.stats.scoreableCorpusRecords} boundaryOnlyRecords=${result.stats.boundaryOnlyCorpusRecords}`,
    `goldRecords=${result.stats.goldRecords} queryRecords=${result.stats.queryRecords} resultRecords=${result.stats.resultRecords} exactRecordMatchRate=${result.stats.exactRecordMatchRate.toFixed(3)}`,
    `scoreableLayers=${result.layers.scoreable.join(',')}`,
    `boundaryOnlyLayers=${result.layers.boundaryOnly.join(',')} boundaryOnlyRecords=${result.stats.boundaryOnlyCorpusRecords} excludedFromScoring=true`,
    `scoreable by source: activity=${result.stats.activityScoreableRecords} story=${result.stats.storyScoreableRecords} checklist=${result.stats.checklistScoreableRecords} summary=${result.stats.summaryScoreableRecords} evidence=${result.stats.evidenceScoreableRecords}`,
    `devMemoryExcludedFromScoring=true devMemoryBoundaryRecords=${result.stats.devMemoryBoundaryRecords}`,
  ];
  if (result.reasons.length > 0) {
    lines.push('FAIL reasons:');
    for (const reason of result.reasons) lines.push(`  - ${reason}`);
  }
  lines.push('Sources:');
  for (const source of result.sources) {
    lines.push(`  - ${source.sourcePath} hash=${source.sourceHash ?? 'n/a'} records=${source.records} scoreable=${source.scoreableRecords} boundaryOnly=${source.boundaryOnlyRecords} exists=${source.exists}`);
  }
  if (result.outputFiles) {
    lines.push('Output files:');
    for (const [label, path] of Object.entries(result.outputFiles)) {
      const size = fileSize(path);
      lines.push(`  - ${label}: ${path}${size === null ? '' : ` (${size} bytes)`}`);
    }
  } else {
    const samples = result.corpus.filter((record) => record.scoreable).slice(0, 5);
    if (samples.length > 0) {
      lines.push('Sample scoreable records:');
      for (const record of samples) {
        lines.push(`  - ${record.recordId} layer=${record.layer} sourcePath=${record.sourcePath} sourceHash=${record.sourceHash} text=${compact(record.text, 160)}`);
      }
    }
  }
  return lines.join('\n');
}
