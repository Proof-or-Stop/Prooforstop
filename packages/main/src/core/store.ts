import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, rmSync } from 'fs';
import { join } from 'path';
import type {
  StoryInfo, ChecklistData, BugData, TestEvidenceData, ReviewData,
  UnderstandingData, DecisionData, StorySummaryData,
  StoryTestRun, StoryTestRunsData, FindingData, EvalEvidenceData,
  StoryProcessMetrics, ProcessEvent, ScopeCheckData, InitCheckData, ReviewPassData,
  DeliveryCheckData, ImplementationReviewResultData, ReviewRunData, GrillData,
} from './types.js';
import type { ClusterData } from './cluster-types.js';
import { appendProcessEvent as appendProcessEventFn, readProcessEvents as readProcessEventsFn } from './process-events.js';
import { loadConfig } from './config.js';
import { normalizeLegacyPhase, phaseRank } from './phase-flow.js';

type JsonCandidate<T> = {
  filePath: string;
  data: T;
};

class StoryArtifactMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoryArtifactMissingError';
  }
}

export class StoryStore {
  private baseDir: string;
  private legacyBaseDir: string;
  private storyDirRelValue: string;

  constructor(projectRoot: string) {
    const config = loadConfig(projectRoot);
    this.storyDirRelValue = config.storyDir.replace(/\\/g, '/');
    this.baseDir = join(projectRoot, config.storyDir);
    this.legacyBaseDir = join(projectRoot, 'docs', 'story', 'actives');
  }

  storyDirRel(): string {
    return this.storyDirRelValue;
  }

  storyDirPath(storyId: string): string {
    return this.storyDir(storyId);
  }

  storyFilePath(storyId: string, file: string): string {
    return join(this.storyDir(storyId), file);
  }

  private storyDir(storyId: string): string {
    return join(this.baseDir, storyId);
  }

  private candidateStoryDirs(storyId: string): string[] {
    const configured = this.storyDir(storyId);
    const legacy = join(this.legacyBaseDir, storyId);
    return configured === legacy ? [configured] : [configured, legacy];
  }

  private ensureDir(storyId: string): void {
    const dir = this.storyDir(storyId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  private readJson<T>(storyId: string, file: string): T {
    const tried: string[] = [];
    const candidates: JsonCandidate<T>[] = [];
    for (const dir of this.candidateStoryDirs(storyId)) {
      const filePath = join(dir, file);
      tried.push(filePath);
      if (existsSync(filePath)) {
        candidates.push({ filePath, data: JSON.parse(readFileSync(filePath, 'utf-8')) as T });
      }
    }
    if (candidates.length > 0) return this.chooseJsonCandidate(file, candidates).data;
    throw new StoryArtifactMissingError(`File not found: ${tried.join(' or ')}`);
  }

  private writeJson<T>(storyId: string, file: string, data: T): void {
    this.ensureDir(storyId);
    this.writeJsonFile(join(this.storyDir(storyId), file), data);
  }

  private writeJsonFile<T>(filePath: string, data: T): void {
    const serialized = JSON.stringify(data, null, 2) + '\n';
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(tmpPath, serialized, 'utf-8');
      JSON.parse(readFileSync(tmpPath, 'utf-8')); // post-write validation
      renameSync(tmpPath, filePath); // atomic replace
    } catch (e) {
      try { rmSync(tmpPath, { force: true }); } catch { /* best-effort cleanup */ }
      throw e;
    }
  }

  private chooseJsonCandidate<T>(file: string, candidates: JsonCandidate<T>[]): JsonCandidate<T> {
    if (candidates.length === 1) return candidates[0];
    if (file === 'index.json') {
      return candidates.reduce((best, candidate) =>
        this.compareStoryCandidate(candidate.data, best.data) > 0 ? candidate : best
      );
    }
    if (file === 'test-evidence.json') {
      return candidates.reduce((best, candidate) =>
        this.compareTimestampCandidate(candidate.data, best.data) > 0 ? candidate : best
      );
    }
    return candidates[0];
  }

  private compareStoryCandidate(a: unknown, b: unknown): number {
    const aStory = a as Partial<StoryInfo>;
    const bStory = b as Partial<StoryInfo>;
    const aRank = aStory.phase ? phaseRank(normalizeLegacyPhase(aStory.phase)) : -1;
    const bRank = bStory.phase ? phaseRank(normalizeLegacyPhase(bStory.phase)) : -1;
    if (aRank !== bRank) return aRank - bRank;
    return this.maxStoryTimestamp(aStory) - this.maxStoryTimestamp(bStory);
  }

  private compareTimestampCandidate(a: unknown, b: unknown): number {
    return this.timestampOf((a as { timestamp?: unknown }).timestamp) -
      this.timestampOf((b as { timestamp?: unknown }).timestamp);
  }

  private maxStoryTimestamp(story: Partial<StoryInfo>): number {
    const timestamps = [
      this.timestampOf((story as { createdAt?: unknown }).createdAt),
      this.timestampOf((story as { startedAt?: unknown }).startedAt),
      this.timestampOf((story as { endedAt?: unknown }).endedAt),
    ];
    const events = (story as { events?: Array<{ time?: unknown; timestamp?: unknown }> }).events;
    if (Array.isArray(events)) {
      for (const event of events) timestamps.push(this.timestampOf(event.time ?? event.timestamp));
    }
    return Math.max(0, ...timestamps);
  }

  private timestampOf(value: unknown): number {
    if (typeof value !== 'string') return 0;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  // ── Story ──

  readStory(storyId: string): StoryInfo {
    const story = this.readJson<StoryInfo>(storyId, 'index.json');
    const normalizedPhase = normalizeLegacyPhase(story.phase);
    return normalizedPhase === story.phase ? story : { ...story, phase: normalizedPhase };
  }

  writeStory(storyId: string, data: StoryInfo): void {
    this.writeJson(storyId, 'index.json', data);
  }

  storyExists(storyId: string): boolean {
    return this.candidateStoryDirs(storyId).some(dir => existsSync(join(dir, 'index.json')));
  }

  listStoryIds(): string[] {
    const ids = new Set<string>();
    for (const base of [this.baseDir, this.legacyBaseDir]) {
      if (!existsSync(base)) continue;
      for (const d of readdirSync(base, { withFileTypes: true })) {
        if (d.isDirectory() && existsSync(join(base, d.name, 'index.json'))) ids.add(d.name);
      }
    }
    return [...ids].sort();
  }

  // ── Checklist ──

  readChecklist(storyId: string): ChecklistData {
    return this.readJson<ChecklistData>(storyId, 'checklist.json');
  }

  writeChecklist(storyId: string, data: ChecklistData): void {
    this.writeJson(storyId, 'checklist.json', data);
  }

  // ── Bug ──

  readBugs(storyId: string): BugData {
    try {
      return this.readJson<BugData>(storyId, 'bug.json');
    } catch {
      return { bugs: [] };
    }
  }

  writeBugs(storyId: string, data: BugData): void {
    this.writeJson(storyId, 'bug.json', data);
  }

  // ── Test Evidence ──

  readTestEvidence(storyId: string): TestEvidenceData | null {
    try {
      return this.readJson<TestEvidenceData>(storyId, 'test-evidence.json');
    } catch {
      return null;
    }
  }

  writeTestEvidence(storyId: string, data: TestEvidenceData): void {
    this.writeJson(storyId, 'test-evidence.json', data);
  }

  // ── Eval Evidence (evaluator agent 打分) ──

  readEvalEvidence(storyId: string): EvalEvidenceData | null {
    try {
      return this.readJson<EvalEvidenceData>(storyId, 'eval-evidence.json');
    } catch {
      return null;
    }
  }

  writeEvalEvidence(storyId: string, data: EvalEvidenceData): void {
    this.writeJson(storyId, 'eval-evidence.json', data);
  }

  // ── Review ──

  readReview(storyId: string): ReviewData {
    try {
      return this.readJson<ReviewData>(storyId, 'review.json');
    } catch {
      return { reviews: [] };
    }
  }

  writeReview(storyId: string, data: ReviewData): void {
    this.writeJson(storyId, 'review.json', data);
  }

  // ── Legacy Implementation Review (kept so old imports compile; new flow uses findings) ──

  readImplementationReview(storyId: string): ImplementationReviewResultData | null {
    try {
      return this.readJson<ImplementationReviewResultData>(storyId, 'implementation-review.json');
    } catch {
      return null;
    }
  }

  writeImplementationReview(storyId: string, data: ImplementationReviewResultData): void {
    this.writeJson(storyId, 'implementation-review.json', data);
  }

  // ── Understanding (Pre-context Intake snapshot, OMX 风格) ──

  readUnderstanding(storyId: string): UnderstandingData | null {
    try {
      return this.readJson<UnderstandingData>(storyId, 'understanding.json');
    } catch {
      return null;
    }
  }

  writeUnderstanding(storyId: string, data: UnderstandingData): void {
    this.writeJson(storyId, 'understanding.json', data);
  }

  // ── Grill planning artifact ──

  readGrill(storyId: string): GrillData | null {
    try {
      return this.readJson<GrillData>(storyId, 'grill.json');
    } catch (e) {
      // PROBE: missing artifact means no grill context; corrupt existing JSON must surface.
      if (e instanceof StoryArtifactMissingError) return null;
      throw e;
    }
  }

  writeGrill(storyId: string, data: GrillData): void {
    this.writeJson(storyId, 'grill.json', data);
  }

  // ── Decision (RALPLAN-DR 结构化决策，OMX 风格) ──

  readDecision(storyId: string): DecisionData | null {
    try {
      return this.readJson<DecisionData>(storyId, 'decision.json');
    } catch {
      return null;
    }
  }

  writeDecision(storyId: string, data: DecisionData): void {
    this.writeJson(storyId, 'decision.json', data);
  }

  // ── Summary (B-093b: DONE-gate forced completion summary) ──

  readSummary(storyId: string): StorySummaryData | null {
    try {
      return this.readJson<StorySummaryData>(storyId, 'summary.json');
    } catch {
      return null;
    }
  }

  writeSummary(storyId: string, data: StorySummaryData): void {
    this.writeJson(storyId, 'summary.json', data);
  }

  // ── Findings (koala-reviewer 发现项) ──
  // B-9bd9 CHK-002: Finding 类型扩展 driftHash / lastSeenAt / firstSeenRound / resolvedReason / resolvedAt
  // 三个新字段仅 audit meta-store（B-META-framework-audit）使用；老 finding 无此字段视为 legacy，
  // JSON passthrough 不影响序列化。

  readFindings(storyId: string): FindingData {
    try {
      return this.readJson<FindingData>(storyId, 'findings.json');
    } catch {
      return { findings: [] };
    }
  }

  writeFindings(storyId: string, data: FindingData): void {
    this.writeJson(storyId, 'findings.json', data);
  }

  readReviewPasses(storyId: string): ReviewPassData {
    try {
      return this.readJson<ReviewPassData>(storyId, 'review-passes.json');
    } catch {
      return { passes: [] };
    }
  }

  writeReviewPasses(storyId: string, data: ReviewPassData): void {
    this.writeJson(storyId, 'review-passes.json', data);
  }

  readReviewRuns(storyId: string): ReviewRunData {
    try {
      return this.readJson<ReviewRunData>(storyId, 'review-runs.json');
    } catch {
      return { runs: [] };
    }
  }

  writeReviewRuns(storyId: string, data: ReviewRunData): void {
    this.writeJson(storyId, 'review-runs.json', data);
  }

  // ── Clusters (B-e8c8 / B-9d95 CHK-005: finding 聚簇) ──
  //
  // 存储位置：docs/story/actives/<storyId>/clusters.json
  // 读缺失时返回 { clusters: [] }（与 findings/review 的 null-safe 风格一致）。

  readClusters(storyId: string): ClusterData {
    try {
      return this.readJson<ClusterData>(storyId, 'clusters.json');
    } catch {
      return { clusters: [] };
    }
  }

  writeClusters(storyId: string, data: ClusterData): void {
    this.writeJson(storyId, 'clusters.json', data);
  }

  // ── Process Metrics (B-abd8: Phase 2 telemetry) ──

  readProcessMetrics(storyId: string): StoryProcessMetrics | null {
    try {
      return this.readJson<StoryProcessMetrics>(storyId, 'process-metrics.json');
    } catch {
      return null;
    }
  }

  writeProcessMetrics(storyId: string, data: StoryProcessMetrics): void {
    this.writeJson(storyId, 'process-metrics.json', data);
  }

  // ── Test Runs (B-1522: append-only log of every validate invocation) ──

  readTestRuns(storyId: string): StoryTestRunsData {
    try {
      return this.readJson<StoryTestRunsData>(storyId, 'test-runs.json');
    } catch {
      return { runs: [] };
    }
  }

  appendTestRun(storyId: string, run: StoryTestRun): void {
    const data = this.readTestRuns(storyId);
    data.runs.push(run);
    this.writeJson(storyId, 'test-runs.json', data);
  }

  // ── Scope Check (B-d4d1: read scope-check.json written by koala-review-scope-plan agent) ──

  readScopeCheck(storyId: string): ScopeCheckData | null {
    try {
      const raw = this.readJson<ScopeCheckData>(storyId, 'scope-check.json');
      // B-ed3e CHK-002: 老 scope-check.json 无 summary.orphanSuspect/drift / feature.source 字段，
      // 反序列化时用 ?? 兜底，避免 PLAN gate 崩溃。签名域不含这些字段故不影响 _hash。
      return {
        ...raw,
        summary: {
          total: raw.summary?.total ?? 0,
          covered: raw.summary?.covered ?? 0,
          excluded: raw.summary?.excluded ?? 0,
          gaps: raw.summary?.gaps ?? 0,
          orphanSuspect: raw.summary?.orphanSuspect ?? 0,
          drift: raw.summary?.drift ?? 0,
        },
      };
    } catch {
      return null;
    }
  }

  writeScopeCheck(storyId: string, data: ScopeCheckData): void {
    // 原样序列化，不剥新字段（新字段不入签名域故对老 gate 无影响）。
    this.writeJson(storyId, 'scope-check.json', data);
  }

  // ── Init Check (B-e71f: read/write init-check.json written by koala-review-story-init agent) ──

  readInitCheck(storyId: string): InitCheckData | null {
    try {
      return this.readJson<InitCheckData>(storyId, 'init-check.json');
    } catch {
      return null;
    }
  }

  writeInitCheck(storyId: string, data: InitCheckData): void {
    this.writeJson(storyId, 'init-check.json', data);
  }

  // ── Delivery Check (B-35ed: TEST→DONE 硬门槛产物 delivery-check.json) ──

  readDeliveryCheck(storyId: string): DeliveryCheckData | null {
    try {
      return this.readJson<DeliveryCheckData>(storyId, 'delivery-check.json');
    } catch {
      return null;
    }
  }

  writeDeliveryCheck(storyId: string, data: DeliveryCheckData): void {
    this.writeJson(storyId, 'delivery-check.json', data);
  }

  // ── Process Events (B-aa48: Phase 3 append-only event log) ──

  appendProcessEvent(storyId: string, event: Omit<ProcessEvent, 'timestamp'>): void {
    const dir = this.storyDir(storyId);
    appendProcessEventFn(dir, event);
  }

  readProcessEvents(storyId: string): ProcessEvent[] {
    const dir = this.storyDir(storyId);
    return readProcessEventsFn(dir);
  }
}
