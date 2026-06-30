import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, rmSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
import type {
  StoryInfo, ChecklistData, BugData, TestEvidenceData, ReviewData,
  UnderstandingData, DecisionData, StorySummaryData,
  StoryTestRun, StoryTestRunsData, FindingData, EvalEvidenceData,
  StoryProcessMetrics, ProcessEvent, ScopeCheckData, InitCheckData, ReviewPassData,
  DeliveryCheckData, ImplementationReviewResultData, ReviewRunData, GrillData,
  DeclaredArtifactsData, ScopeContractData, GuardSessionData, ReviewLoopRecord,
  ScopeBoundaryData, ExecutionBoundaryData, ScopeFreezeCheckData, DoneRequiredEvidenceData,
  ScopeExtensionProposalData, ScopeExtensionDecisionData, ScopeDiscardDigestData,
  DecisionDocProposalFile, OriginalIntentSnapshotData, MilestoneLedgerData,
  ProofStoryContractData, IntentCollisionData, ScopeShrinkageDecisionData,
  RedEvidenceData, ProofStorySpikeData, ProofStorySlicePlanData, ProofStoryParentLedgerRollupData,
} from './types.js';
import { REVIEW_LOOP_FILENAME } from './review-loop.js';
import { CAPSULE_DIR_NAME, type StoryCapsuleData, type StoryCapsuleRunData } from './story-capsule.js';
import type { ClusterData } from './cluster-types.js';
import { appendProcessEvent as appendProcessEventFn, readProcessEvents as readProcessEventsFn } from './process-events.js';
import { loadConfig } from './config.js';
import { LEGACY_DOCS_STORY_DIR, uniqueRelPaths } from './lattice-paths.js';
import { normalizeLegacyPhase, phaseRank } from './phase-flow.js';

type JsonCandidate<T> = {
  filePath: string;
  data: T;
};

type LegacyReceiptRefDocument = Record<string, unknown>;

class StoryArtifactMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoryArtifactMissingError';
  }
}

export class StoryStore {
  private baseDir: string;
  private legacyBaseDirs: string[];
  private storyDirRelValue: string;

  constructor(projectRoot: string) {
    const config = loadConfig(projectRoot);
    this.storyDirRelValue = config.storyDir.replace(/\\/g, '/');
    this.baseDir = join(projectRoot, config.storyDir);
    this.legacyBaseDirs = uniqueRelPaths([
      LEGACY_DOCS_STORY_DIR,
    ])
      .filter((rel) => rel !== this.storyDirRelValue)
      .map((rel) => join(projectRoot, rel));
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

  readStoryBackground(storyId: string): string | null {
    for (const dir of this.candidateStoryDirs(storyId)) {
      const filePath = join(dir, 'background.md');
      if (existsSync(filePath)) return readFileSync(filePath, 'utf-8');
    }
    return null;
  }

  private storyDir(storyId: string): string {
    return join(this.baseDir, storyId);
  }

  private candidateStoryDirs(storyId: string): string[] {
    const configured = this.storyDir(storyId);
    return [configured, ...this.legacyBaseDirs.map((base) => join(base, storyId))];
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
      mkdirSync(dirname(filePath), { recursive: true });
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
    for (const base of [this.baseDir, ...this.legacyBaseDirs]) {
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

  readDoneRequiredEvidence(storyId: string): DoneRequiredEvidenceData | null {
    try {
      return this.readJson<DoneRequiredEvidenceData>(storyId, 'done-required-evidence.json');
    } catch (e) {
      if (e instanceof StoryArtifactMissingError) return null;
      throw e;
    }
  }

  writeDoneRequiredEvidence(storyId: string, data: DoneRequiredEvidenceData): void {
    this.writeJson(storyId, 'done-required-evidence.json', data);
  }

  // ── Eval Evidence (evaluator agent scoring) ──

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

  // ── Understanding (Pre-context Intake snapshot) ──

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

  // ── Decision (RALPLAN-DR structured decision) ──

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

  // ── Decision doc promotion proposals ──

  readDecisionDocProposals(storyId: string): DecisionDocProposalFile {
    try {
      return this.readJson<DecisionDocProposalFile>(storyId, 'decision-doc-proposals.json');
    } catch (e) {
      if (e instanceof StoryArtifactMissingError) {
        return {
          schemaVersion: 'lattice.decision_doc_proposals.v1',
          storyId,
          updatedAt: '',
          proposals: [],
        };
      }
      throw e;
    }
  }

  writeDecisionDocProposals(storyId: string, data: DecisionDocProposalFile): void {
    this.writeJson(storyId, 'decision-doc-proposals.json', data);
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

  // ── Findings (Proofbound reviewer findings) ──
  // B-9bd9 CHK-002: Finding type extended with driftHash / lastSeenAt / firstSeenRound / resolvedReason / resolvedAt
  // The three new fields are only used by the audit meta-store (B-META-framework-audit); legacy findings without these fields are treated as legacy,
  // JSON passthrough does not affect serialization.

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

  // ── Clusters (B-e8c8 / B-9d95 CHK-005: finding clustering) ──
  //
  // Storage location: docs/story/actives/<storyId>/clusters.json
  // Returns { clusters: [] } when read is missing (consistent with the null-safe style of findings/review).

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

  // ── Scope Check (B-d4d1: read scope-check.json written by lattice-review-scope-plan agent) ──

  readScopeCheck(storyId: string): ScopeCheckData | null {
    try {
      const raw = this.readJson<ScopeCheckData>(storyId, 'scope-check.json');
      // B-ed3e CHK-002: legacy scope-check.json lacks summary.orphanSuspect/drift / feature.source fields,
      // use ?? as fallback during deserialization to avoid PLAN gate crashes. Signature domain excludes these fields so _hash is unaffected.
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
    // Serialize as-is, do not strip new fields (new fields are not in the signature domain so have no impact on legacy gates).
    this.writeJson(storyId, 'scope-check.json', data);
  }

  // ── Init Check (B-e71f: read/write init-check.json written by lattice-review-story-init agent) ──

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

  // ── Scope Anti-Expansion (B-85ba: INIT→INIT_CHECK boundary freeze gate) ──

  readScopeBoundary(storyId: string): ScopeBoundaryData | null {
    try {
      return this.readJson<ScopeBoundaryData>(storyId, 'scope-boundary.json');
    } catch (e) {
      if (e instanceof StoryArtifactMissingError) return null;
      throw e;
    }
  }

  writeScopeBoundary(storyId: string, data: ScopeBoundaryData): void {
    this.writeJson(storyId, 'scope-boundary.json', data);
  }

  readExecutionBoundary(storyId: string): ExecutionBoundaryData | null {
    try {
      return this.readJson<ExecutionBoundaryData>(storyId, 'execution-boundary.json');
    } catch (e) {
      if (e instanceof StoryArtifactMissingError) return null;
      throw e;
    }
  }

  writeExecutionBoundary(storyId: string, data: ExecutionBoundaryData): void {
    this.writeJson(storyId, 'execution-boundary.json', data);
  }

  readScopeFreezeCheck(storyId: string): ScopeFreezeCheckData | null {
    try {
      return this.readJson<ScopeFreezeCheckData>(storyId, 'scope-freeze-check.json');
    } catch (e) {
      if (e instanceof StoryArtifactMissingError) return null;
      throw e;
    }
  }

  writeScopeFreezeCheck(storyId: string, data: ScopeFreezeCheckData): void {
    this.writeJson(storyId, 'scope-freeze-check.json', data);
  }

  readScopeExtensionProposals(storyId: string): ScopeExtensionProposalData {
    try {
      return this.readJson<ScopeExtensionProposalData>(storyId, 'scope-extension-proposals.json');
    } catch (e) {
      if (e instanceof StoryArtifactMissingError) return { storyId, updatedAt: '', proposals: [] };
      throw e;
    }
  }

  writeScopeExtensionProposals(storyId: string, data: ScopeExtensionProposalData): void {
    this.writeJson(storyId, 'scope-extension-proposals.json', data);
  }

  readScopeExtensionDecisions(storyId: string): ScopeExtensionDecisionData {
    try {
      return this.readJson<ScopeExtensionDecisionData>(storyId, 'scope-extension-decisions.json');
    } catch (e) {
      if (e instanceof StoryArtifactMissingError) return { storyId, updatedAt: '', decisions: [] };
      throw e;
    }
  }

  writeScopeExtensionDecisions(storyId: string, data: ScopeExtensionDecisionData): void {
    this.writeJson(storyId, 'scope-extension-decisions.json', data);
  }

  readScopeDiscardDigest(storyId: string): ScopeDiscardDigestData {
    try {
      return this.readJson<ScopeDiscardDigestData>(storyId, 'scope-discard-digest.json');
    } catch (e) {
      if (e instanceof StoryArtifactMissingError) return { storyId, updatedAt: '', entries: [] };
      throw e;
    }
  }

  readScopeDiscardDigestForFreeze(storyId: string): ScopeDiscardDigestData {
    const merged: ScopeDiscardDigestData = {
      storyId,
      updatedAt: '',
      entries: [],
    };
    const seen = new Set<string>();
    const addEntries = (sourceStoryId: string, data: ScopeDiscardDigestData): void => {
      if (data.updatedAt && (!merged.updatedAt || this.timestampOf(data.updatedAt) > this.timestampOf(merged.updatedAt))) {
        merged.updatedAt = data.updatedAt;
      }
      for (const entry of data.entries ?? []) {
        const key = `${entry.storyId ?? sourceStoryId}::${entry.digest}::${(entry.terms ?? []).join('|')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.entries.push(entry);
      }
    };

    addEntries(storyId, this.readScopeDiscardDigest(storyId));
    for (const otherStoryId of this.listStoryIds()) {
      if (otherStoryId === storyId) continue;
      let story: StoryInfo;
      try {
        story = this.readStory(otherStoryId);
      } catch {
        continue;
      }
      if (story.phase !== 'DISCARDED') continue;
      try {
        addEntries(otherStoryId, this.readScopeDiscardDigest(otherStoryId));
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        throw new Error(`Scope discard digest for discarded story ${otherStoryId} could not be read: ${reason}`);
      }
    }
    return merged;
  }

  writeScopeDiscardDigest(storyId: string, data: ScopeDiscardDigestData): void {
    this.writeJson(storyId, 'scope-discard-digest.json', data);
  }

  // ── Delivery Check (B-35ed: TEST→DONE hard gate artifact delivery-check.json) ──

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

  // ── Scope Contract (B-be27: story-scoped allowed-file contract) ──

  readScopeContract(storyId: string): ScopeContractData | null {
    try {
      return this.readJson<ScopeContractData>(storyId, 'scope-contract.json');
    } catch (e) {
      // PROBE/fail-closed (B-6bfd CHK-006): a MISSING contract means a legacy /
      // not-yet scope-protected story → null (backward compatible). But a contract
      // file that EXISTS yet cannot be parsed (corrupt / truncated / unreadable)
      // must surface, NOT silently downgrade a scope-protected story to "no
      // contract" (which would let the scope/semantic/binding gates skip =
      // bypass). Mirrors readGrill: missing → null, corrupt → throw.
      if (e instanceof StoryArtifactMissingError) return null;
      throw e;
    }
  }

  writeScopeContract(storyId: string, data: ScopeContractData): void {
    this.writeJson(storyId, 'scope-contract.json', data);
  }

  // ── ProofStory intent hardening diagnostic artifacts (B-7287 M0-M2) ──

  readOriginalIntentSnapshot(storyId: string): OriginalIntentSnapshotData | null {
    try {
      return this.readJson<OriginalIntentSnapshotData>(storyId, 'original-intent-snapshot.json');
    } catch (e) {
      if (e instanceof StoryArtifactMissingError) return null;
      throw e;
    }
  }

  writeOriginalIntentSnapshot(storyId: string, data: OriginalIntentSnapshotData): void {
    this.writeJson(storyId, 'original-intent-snapshot.json', data);
  }

  readMilestoneLedger(storyId: string): MilestoneLedgerData | null {
    try {
      return this.readJson<MilestoneLedgerData>(storyId, 'milestone-ledger.json');
    } catch (e) {
      if (e instanceof StoryArtifactMissingError) return null;
      throw e;
    }
  }

  writeMilestoneLedger(storyId: string, data: MilestoneLedgerData): void {
    this.writeJson(storyId, 'milestone-ledger.json', data);
  }

  readProofStorySlicePlan(storyId: string): ProofStorySlicePlanData | null {
    try {
      return this.readJson<ProofStorySlicePlanData>(storyId, 'slice-plan.json');
    } catch (e) {
      if (e instanceof StoryArtifactMissingError) return null;
      throw e;
    }
  }

  writeProofStorySlicePlan(storyId: string, data: ProofStorySlicePlanData): void {
    this.writeJson(storyId, 'slice-plan.json', data);
  }

  readProofStoryParentLedgerRollup(storyId: string): ProofStoryParentLedgerRollupData | null {
    try {
      return this.readJson<ProofStoryParentLedgerRollupData>(storyId, 'parent-ledger-rollup.json');
    } catch (e) {
      if (e instanceof StoryArtifactMissingError) return null;
      throw e;
    }
  }

  writeProofStoryParentLedgerRollup(storyId: string, data: ProofStoryParentLedgerRollupData): void {
    this.writeJson(storyId, 'parent-ledger-rollup.json', data);
  }

  readProofStoryContract(storyId: string): ProofStoryContractData | null {
    try {
      return this.readJson<ProofStoryContractData>(storyId, 'proofstory.json');
    } catch (e) {
      if (e instanceof StoryArtifactMissingError) return null;
      throw e;
    }
  }

  writeProofStoryContract(storyId: string, data: ProofStoryContractData): void {
    this.writeJson(storyId, 'proofstory.json', data);
  }

  readIntentCollision(storyId: string): IntentCollisionData | null {
    try {
      return this.readJson<IntentCollisionData>(storyId, 'intent-collision.json');
    } catch (e) {
      if (e instanceof StoryArtifactMissingError) return null;
      throw e;
    }
  }

  writeIntentCollision(storyId: string, data: IntentCollisionData): void {
    this.writeJson(storyId, 'intent-collision.json', data);
  }

  readScopeShrinkageDecision(storyId: string): ScopeShrinkageDecisionData | null {
    try {
      return this.readJson<ScopeShrinkageDecisionData>(storyId, 'scope-shrinkage-decision.json');
    } catch (e) {
      if (e instanceof StoryArtifactMissingError) return null;
      throw e;
    }
  }

  writeScopeShrinkageDecision(storyId: string, data: ScopeShrinkageDecisionData): void {
    this.writeJson(storyId, 'scope-shrinkage-decision.json', data);
  }

  readRedEvidence(storyId: string): RedEvidenceData | null {
    try {
      return this.readJson<RedEvidenceData>(storyId, 'red-evidence.json');
    } catch (e) {
      if (e instanceof StoryArtifactMissingError) return null;
      throw e;
    }
  }

  writeRedEvidence(storyId: string, data: RedEvidenceData): void {
    this.writeJson(storyId, 'red-evidence.json', data);
  }

  readProofStorySpikes(storyId: string): ProofStorySpikeData | null {
    try {
      return this.readJson<ProofStorySpikeData>(storyId, 'spike.json');
    } catch (e) {
      if (e instanceof StoryArtifactMissingError) return null;
      throw e;
    }
  }

  writeProofStorySpikes(storyId: string, data: ProofStorySpikeData): void {
    this.writeJson(storyId, 'spike.json', data);
  }

  // ── Guard Session (B-6bfd CHK-004: scope-guard projection, NOT a write authority) ──
  //
  // Storage location: <storyDir>/<storyId>/guard-session.json
  // This is a scope protection projection, not a write authority; owner lease is still the source of truth for write coordination.
  // Returns null when read is missing (null-safe in the same style as scope-contract).

  readGuardSession(storyId: string): GuardSessionData | null {
    try {
      return this.readJson<GuardSessionData>(storyId, 'guard-session.json');
    } catch {
      return null;
    }
  }

  writeGuardSession(storyId: string, data: GuardSessionData): void {
    this.writeJson(storyId, 'guard-session.json', data);
  }

  // ── Declared Artifacts (B-cf60: per-story declared product output paths) ──
  //
  // Storage location: <storyDir>/<storyId>/declared-artifacts.json
  // Returns { entries: [] } when read is missing (consistent with the null-safe style of findings/review).

  readDeclaredArtifacts(storyId: string): DeclaredArtifactsData {
    try {
      return this.readJson<DeclaredArtifactsData>(storyId, 'declared-artifacts.json');
    } catch {
      return { entries: [] };
    }
  }

  writeDeclaredArtifacts(storyId: string, data: DeclaredArtifactsData): void {
    this.writeJson(storyId, 'declared-artifacts.json', data);
  }

  // ── Legacy legacy receipt refs (retired server projection; read-only compatibility) ──

  readLegacyReceiptRefs(storyId: string): LegacyReceiptRefDocument | null {
    try {
      return this.readJson<LegacyReceiptRefDocument>(storyId, 'authority-receipt-refs.json');
    } catch (e) {
      if (e instanceof StoryArtifactMissingError) return null;
      throw e;
    }
  }

  writeLegacyReceiptRefs(storyId: string, data: LegacyReceiptRefDocument): void {
    this.writeJson(storyId, 'authority-receipt-refs.json', data);
  }

  // ── Story Capsule (B-42c0: resumable handoff projection) ──

  capsuleDirPath(storyId: string): string {
    return join(this.storyDir(storyId), CAPSULE_DIR_NAME);
  }

  capsuleFilePath(storyId: string, file: string): string {
    return join(this.capsuleDirPath(storyId), file);
  }

  capsuleRunDirPath(storyId: string, runId: string): string {
    return join(this.capsuleDirPath(storyId), 'runs', runId);
  }

  readStoryCapsule(storyId: string): StoryCapsuleData | null {
    try {
      return this.readJson<StoryCapsuleData>(storyId, `${CAPSULE_DIR_NAME}/capsule.json`);
    } catch {
      return null;
    }
  }

  writeStoryCapsule(storyId: string, data: StoryCapsuleData): void {
    this.writeJson(storyId, `${CAPSULE_DIR_NAME}/capsule.json`, data);
  }

  readStoryCapsuleMarkdown(storyId: string, file: 'session-brief.md' | 'handoff.md'): string | null {
    const path = this.capsuleFilePath(storyId, file);
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  }

  writeStoryCapsuleMarkdown(storyId: string, file: 'session-brief.md' | 'handoff.md', content: string): void {
    const path = this.capsuleFilePath(storyId, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
  }

  writeCapsuleRun(storyId: string, run: StoryCapsuleRunData, files: {
    transcript: string;
    metrics?: Record<string, unknown>;
    artifacts?: Record<string, unknown>;
  }): void {
    const runDir = this.capsuleRunDirPath(storyId, run.runId);
    this.writeJson(storyId, `${CAPSULE_DIR_NAME}/runs/${run.runId}/run.json`, run);
    this.writeJson(storyId, `${CAPSULE_DIR_NAME}/runs/${run.runId}/metrics.json`, files.metrics ?? run.metrics ?? {});
    this.writeJson(storyId, `${CAPSULE_DIR_NAME}/runs/${run.runId}/artifacts.json`, files.artifacts ?? run.artifacts ?? {});
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'transcript.md'), files.transcript.endsWith('\n') ? files.transcript : `${files.transcript}\n`, 'utf-8');
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

  // ── Review Loop (B-7a34: append-only JSONL loop records) ──
  //
  // Physical file: <storyDir>/<storyId>/review-loops.jsonl
  // Gate consumers group records by loopId and read the latest record's status.
  // status='open' blocks REVIEW -> TEST.

  readReviewLoopRecords(storyId: string): ReviewLoopRecord[] {
    const filePath = join(this.storyDir(storyId), REVIEW_LOOP_FILENAME);
    if (!existsSync(filePath)) return [];
    const content = readFileSync(filePath, 'utf-8');
    const records: ReviewLoopRecord[] = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as ReviewLoopRecord);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`${REVIEW_LOOP_FILENAME}:${i + 1} malformed JSON: ${msg}`);
      }
    }
    return records;
  }

  appendReviewLoopRecord(storyId: string, record: ReviewLoopRecord): void {
    this.ensureDir(storyId);
    const filePath = join(this.storyDir(storyId), REVIEW_LOOP_FILENAME);
    appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
  }

  /** Write the full record list (replaces file). Intended for tests only. */
  writeReviewLoopRecords(storyId: string, records: ReviewLoopRecord[]): void {
    this.ensureDir(storyId);
    const filePath = join(this.storyDir(storyId), REVIEW_LOOP_FILENAME);
    const lines = records.map(r => JSON.stringify(r)).join('\n');
    writeFileSync(filePath, lines ? lines + '\n' : '', 'utf-8');
  }
}
