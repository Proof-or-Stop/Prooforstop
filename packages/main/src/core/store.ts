import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, rmSync, appendFileSync, utimesSync } from 'fs';
import { dirname, join } from 'path';
import type {
  StoryInfo, ChecklistData, BugData, TestEvidenceData, ReviewData,
  UnderstandingData, DecisionData, StorySummaryData,
  StoryTestRun, StoryTestRunsData, FindingData, EvalEvidenceData,
  StoryProcessMetrics, ProcessEvent, ScopeCheckData, InitCheckData, StallAdjudicationData, ReviewPassData,
  DeliveryCheckData, ImplementationReviewResultData, ReviewRunData, GrillData,
  DeclaredArtifactsData, ScopeContractData, GuardSessionData, ReviewLoopRecord,
  ScopeBoundaryData, ExecutionBoundaryData, ScopeFreezeCheckData, DoneRequiredEvidenceData,
  DevMemoryPreflightAckData,
  ScopeExtensionProposalData, ScopeExtensionDecisionData, ScopeDiscardDigestData,
  DecisionDocProposalFile, OriginalIntentSnapshotData, MilestoneLedgerData,
  ProofStoryContractData, IntentCollisionData, ScopeShrinkageDecisionData,
  RedEvidenceData, ProofStorySpikeData, ProofStorySlicePlanData, ProofStoryParentLedgerRollupData,
  AcceptanceBasisArtifactV1,
  PreReviewCheckArtifactV1,
  AcceptanceRolloutArtifactV1,
  TopologyCriticReceiptV1, TopologyExclusionApprovalsDataV1,
  CausalEvidenceReceipt,
} from './types.js';
import type { RedTargetBindingsFile } from './red-evidence/target-bindings.js';
import {
  redEvidenceArtifactParseError,
  retainQuarantinedRecordsOnWrite,
  validateRedEvidenceArtifact,
} from './red-evidence-artifact-validation.js';
import { REVIEW_LOOP_FILENAME } from './review-loop.js';
import { CAPSULE_DIR_NAME, type StoryCapsuleData, type StoryCapsuleRunData } from './story-capsule.js';
import type { ClusterData } from './cluster-types.js';
import type { MilestoneCloseoutSnapshot } from './milestone-status.js';
import type { CandidateSpecSetArtifact } from './candidate-spec-routing.js';
import { appendProcessEvent as appendProcessEventFn, readProcessEvents as readProcessEventsFn } from './process-events.js';
import { storyRuntimeLockPath } from './validation-execution-lock.js';
import { acquireMkdirLock, withMkdirLock } from './mkdir-lock.js';
import { loadConfig } from './config.js';
import { LEGACY_DOCS_STORY_DIR, PROOF_OR_STOP_STORY_DIR_NAMES, uniqueRelPaths } from './proof-or-stop-paths.js';
import { normalizeLegacyPhase, phaseRank } from './phase-flow.js';
import type { PromptEnvelopeData } from './prompt-contracts.js';
import {
  CERTIFICATION_WINDOW_FILE,
  emptyCertificationWindowData,
  type CertificationWindowData,
} from './certification-window.js';
import {
  REVIEW_INVENTORY_EPOCHS_FILE,
  emptyReviewInventoryEpochData,
  type ReviewInventoryEpochData,
} from './review-inventory-epoch.js';
import {
  CAUSAL_RECEIPT_DIRECTORY,
  CAUSAL_RECEIPT_INDEX_FILE,
  causalDigest,
  computeCausalReceiptHash,
  verifyCausalEvidenceReceipt,
} from './causal-evidence.js';

type JsonCandidate<T> = {
  filePath: string;
  data: T;
};

type LegacyReceiptRefDocument = Record<string, unknown>;

const causalEvidenceFlights = new Map<string, Promise<unknown>>();
const CAUSAL_EVIDENCE_LOCK_STALE_MS = 120_000;
const CAUSAL_EVIDENCE_LOCK_DEADLINE_MS = 7_260_000;
const CAUSAL_EVIDENCE_LOCK_HEARTBEAT_MS = 2_000;

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
  private projectRootValue: string;

  constructor(projectRoot: string) {
    const config = loadConfig(projectRoot);
    this.projectRootValue = projectRoot;
    this.storyDirRelValue = config.storyDir.replace(/\\/g, '/');
    this.baseDir = join(projectRoot, config.storyDir);
    // B-cc10 F-006 (critical): the read-both fallback must include EVERY accepted
    // state-dir spelling, not just the older docs/ migration. PROOF_OR_STOP_STORY_DIR_NAMES
    // is the canonical read-side list (it already gates hash exclusion in
    // evidence-freshness.ts) but was never wired into discovery here, so a story
    // directory merged in under the deprecated `.proof-or-stop/` spelling was invisible:
    // story_get returned {"story": null} at exit 0 while the files sat on disk.
    // Writes are unaffected — they still go only to the configured canonical dir.
    this.legacyBaseDirs = uniqueRelPaths([
      LEGACY_DOCS_STORY_DIR,
      ...PROOF_OR_STOP_STORY_DIR_NAMES,
    ])
      .filter((rel) => rel !== this.storyDirRelValue)
      .map((rel) => join(projectRoot, rel));
  }

  /** Repository root this store was constructed against (absolute path). */
  get projectRoot(): string {
    return this.projectRootValue;
  }

  /**
   * B-d877 R3 FIX B: resolve a per-story RUNTIME lock dir under the gitignored,
   * shared `.proof-or-stop/locks/<category>/` prefix instead of inside the git-tracked
   * story metadata dir. Used by the checklist / finding / review-run / init-check
   * / prompt-envelope / process-event append locks so a transient `holder.json`
   * can never be committed inside the story dir and dirty the tree.
   */
  runtimeLockDirPath(storyId: string, category: string, name: string): string {
    return storyRuntimeLockPath(this.projectRootValue, category, storyId, name);
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
    return this.readJsonCandidate<T>(storyId, file).data;
  }

  /**
   * `readJson`, but the chosen candidate's PATH comes back with the data.
   *
   * `wrapParseError` (B-2aa7 CHK-004, §10.2.1 row E7) lets one artifact turn the
   * raw `SyntaxError` that `JSON.parse` throws — which names neither the file nor
   * the story — into a TYPED error naming the path, at the only place where the
   * path is still in scope. Omitting it rethrows the original error verbatim, so
   * every other artifact's read behaviour is byte-for-byte unchanged.
   */
  private readJsonCandidate<T>(
    storyId: string,
    file: string,
    wrapParseError?: (cause: unknown, filePath: string) => Error,
  ): JsonCandidate<T> {
    const tried: string[] = [];
    const candidates: JsonCandidate<T>[] = [];
    for (const dir of this.candidateStoryDirs(storyId)) {
      const filePath = join(dir, file);
      tried.push(filePath);
      if (existsSync(filePath)) {
        let data: T;
        try {
          data = JSON.parse(readFileSync(filePath, 'utf-8')) as T;
        } catch (e) {
          throw wrapParseError ? wrapParseError(e, filePath) : e;
        }
        candidates.push({ filePath, data });
      }
    }
    if (candidates.length > 0) return this.chooseJsonCandidate(file, candidates);
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

  // ── CausalEvidence CAS receipts ──
  // Receipts are runtime-owned story artifacts. They are addressed by the
  // immutable receipt hash, while the small index maps an exact execution key
  // to that address. A different payload can never replace either address.
  causalEvidenceReceiptPath(storyId: string, receiptHash: string): string {
    return join(this.storyDir(storyId), CAUSAL_RECEIPT_DIRECTORY, `${receiptHash}.json`);
  }

  private recoverOrphanedCausalEvidenceReceipt(
    storyId: string,
    executionKey: string,
  ): CausalEvidenceReceipt | null {
    const receiptsDir = this.storyFilePath(storyId, CAUSAL_RECEIPT_DIRECTORY);
    if (!existsSync(receiptsDir)) return null;

    const matches: CausalEvidenceReceipt[] = [];
    for (const entry of readdirSync(receiptsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const receiptHash = entry.name.slice(0, -'.json'.length);
      try {
        const receipt = JSON.parse(readFileSync(join(receiptsDir, entry.name), 'utf8')) as CausalEvidenceReceipt;
        if (
          receipt.receiptHash === receiptHash
          && receipt.reusable
          && verifyCausalEvidenceReceipt(receipt, executionKey)
        ) {
          matches.push(receipt);
        }
      } catch {
        // Ignore unrelated or incomplete orphan files; only a valid, exact CAS
        // receipt can be promoted back into the execution-key index.
      }
    }

    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new Error(`Multiple CausalEvidence receipts match execution key ${executionKey} [causal_receipt_ambiguous]`);
    }

    // An index write can fail after the immutable receipt write succeeds. Reuse
    // that exact receipt and rebuild only its missing index entry before the
    // caller decides whether a command needs to run.
    const [receipt] = matches;
    this.writeCausalEvidenceReceipt(storyId, receipt);
    return receipt;
  }

  readCausalEvidenceReceipt(storyId: string, executionKey: string): CausalEvidenceReceipt | null {
    const indexPath = this.storyFilePath(storyId, CAUSAL_RECEIPT_INDEX_FILE);
    if (!existsSync(indexPath)) return this.recoverOrphanedCausalEvidenceReceipt(storyId, executionKey);
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { receipts?: Record<string, string> };
    const receiptHash = index.receipts?.[executionKey];
    if (!receiptHash) return this.recoverOrphanedCausalEvidenceReceipt(storyId, executionKey);
    const receiptPath = this.causalEvidenceReceiptPath(storyId, receiptHash);
    if (!existsSync(receiptPath)) throw new Error(`CausalEvidence receipt ${receiptHash} is missing [causal_receipt_missing]`);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as CausalEvidenceReceipt;
    if (receipt.receiptHash !== receiptHash || !verifyCausalEvidenceReceipt(receipt, executionKey)) {
      throw new Error(`CausalEvidence receipt ${receiptHash} failed integrity validation [causal_receipt_tampered]`);
    }
    return receipt;
  }

  /**
   * Serialize one reusable execution key across requests and Store instances.
   * The process-local flight prevents a synchronous mkdir waiter from blocking
   * the event loop when two requests share this process; the durable lock keeps
   * separate processes from launching the same child concurrently.
   */
  async withCausalEvidenceExecution<T>(
    storyId: string,
    executionKey: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const lockPath = this.runtimeLockDirPath(
      storyId,
      'causal-evidence',
      `key-${causalDigest(executionKey)}`,
    );
    const existingFlight = causalEvidenceFlights.get(lockPath);
    if (existingFlight) return await (existingFlight as Promise<T>);

    const flight = Promise.resolve().then(async () => {
      const lock = acquireMkdirLock(lockPath, {
        label: `causal evidence ${storyId}`,
        staleMs: CAUSAL_EVIDENCE_LOCK_STALE_MS,
        deadlineMs: CAUSAL_EVIDENCE_LOCK_DEADLINE_MS,
      });
      const heartbeat = setInterval(() => {
        try {
          const now = new Date();
          utimesSync(lock.lockDir, now, now);
        } catch {
          /* The lock remains authoritative; heartbeat is stale-reclaim liveness. */
        }
      }, CAUSAL_EVIDENCE_LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();
      try {
        return await fn();
      } finally {
        clearInterval(heartbeat);
        lock.release();
      }
    });
    causalEvidenceFlights.set(lockPath, flight);
    try {
      return await flight as T;
    } finally {
      if (causalEvidenceFlights.get(lockPath) === flight) causalEvidenceFlights.delete(lockPath);
    }
  }

  writeCausalEvidenceReceipt(storyId: string, receipt: CausalEvidenceReceipt): void {
    if (!verifyCausalEvidenceReceipt(receipt)) {
      throw new Error('CausalEvidence receipt refused: invalid or partial receipt [causal_receipt_invalid]');
    }
    const indexLockPath = this.runtimeLockDirPath(storyId, 'causal-evidence-index', 'receipts');
    withMkdirLock(indexLockPath, () => {
      const indexPath = this.storyFilePath(storyId, CAUSAL_RECEIPT_INDEX_FILE);
      let index: { schemaVersion: 'proofbound.causal-evidence-index.v1'; receipts: Record<string, string> } = {
        schemaVersion: 'proofbound.causal-evidence-index.v1',
        receipts: {},
      };
      if (existsSync(indexPath)) index = JSON.parse(readFileSync(indexPath, 'utf8')) as typeof index;
      const priorHash = index.receipts[receipt.executionKey];
      if (priorHash && priorHash !== receipt.receiptHash) {
        throw new Error(`CausalEvidence execution key ${receipt.executionKey} already points to ${priorHash}; refusing overwrite [causal_receipt_overwrite]`);
      }
      const receiptPath = this.causalEvidenceReceiptPath(storyId, receipt.receiptHash);
      const serialized = JSON.stringify(receipt, null, 2) + '\n';
      if (existsSync(receiptPath)) {
        const priorBytes = readFileSync(receiptPath, 'utf8');
        if (priorBytes !== serialized) {
          throw new Error(`CausalEvidence CAS address ${receipt.receiptHash} contains different bytes [causal_receipt_collision]`);
        }
      } else {
        this.writeJsonFile(receiptPath, receipt);
      }
      index.receipts[receipt.executionKey] = receipt.receiptHash;
      this.writeJsonFile(indexPath, index);
      // Defensive check: the in-memory receipt hash is the same address that was
      // written, and future callers cannot accidentally persist a re-hashed row.
      if (computeCausalReceiptHash(receipt) !== receipt.receiptHash) {
        throw new Error('CausalEvidence receipt hash changed during persistence [causal_receipt_hash_drift]');
      }
    }, { label: `causal evidence index ${storyId}` });
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

  readCandidateSpecSet(storyId: string): CandidateSpecSetArtifact | null {
    try {
      return this.readJson<CandidateSpecSetArtifact>(storyId, 'candidate-spec-set.json');
    } catch (e) {
      if (e instanceof StoryArtifactMissingError) return null;
      throw e;
    }
  }

  writeCandidateSpecSet(storyId: string, data: CandidateSpecSetArtifact): void {
    this.writeJson(storyId, 'candidate-spec-set.json', data);
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

  // ── Findings (Proof-or-Stop reviewer findings) ──
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

  readPromptEnvelopes(storyId: string): PromptEnvelopeData {
    try {
      return this.readJson<PromptEnvelopeData>(storyId, 'prompt-envelopes.json');
    } catch {
      return { envelopes: [] };
    }
  }

  writePromptEnvelopes(storyId: string, data: PromptEnvelopeData): void {
    this.writeJson(storyId, 'prompt-envelopes.json', data);
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

  // ── Scope Check (B-d4d1: read scope-check.json written by proof-or-stop-review-scope-plan agent) ──

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

  // ── Init Check (B-e71f: read/write init-check.json written by proof-or-stop-review-story-init agent) ──

  /**
   * UNVERIFIED read, BY DECISION (B-8df9 CHK-003) — returns whatever bytes are on disk,
   * with the stored `_hash` NOT checked. Refusing to TRUST is not the same as refusing to
   * READ, and this function deliberately does only the second-weakest of those:
   *
   *  - Verifying here is not even well-defined at this layer: the expected hash is a
   *    function of the story's title / description / background.md / checklist / review
   *    round, and the module that computes it (core/init-check-gate.ts) obtains all of
   *    them THROUGH this store — `recomputeInitCheckHash` calls `readInitCheck` for the
   *    persisted verdict it hashes, so a verifying read would recurse into its own verifier.
   *  - Most callers are read-only surfaces — `story_get`, the INIT preflight report, the
   *    session brief, the artifact-contract probe — and the gate's own tamper path is one
   *    of them: it must hold the untrusted record in hand to be able to REPORT
   *    `init_check_tampered` at all. Throwing here would make an unverifiable record
   *    unreportable and would strand every historical file signed under an older domain.
   *
   * Consequently the trust boundary lives one layer up and is explicit: any caller that
   * DECIDES on this record's contents (which reviewers are covered, which issues were
   * raised, what gets carried into a re-signed file) must first pass it through
   * `initCheckSignatureIsValid` / `initCheckHashMatches` in core/init-check-gate.ts.
   * Rendering it is fine. Believing it is not.
   */
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

  // ── Stall Adjudication (B-7813 CHK-002: stall_resolution_set writes the signed
  // stall-adjudication.json consumed by the DEV→REVIEW convergence-stall mint gate) ──

  readStallAdjudication(storyId: string): StallAdjudicationData | null {
    try {
      return this.readJson<StallAdjudicationData>(storyId, 'stall-adjudication.json');
    } catch {
      return null;
    }
  }

  writeStallAdjudication(storyId: string, data: StallAdjudicationData): void {
    this.writeJson(storyId, 'stall-adjudication.json', data);
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

  // B-a7c5 CHK-001: per-story dev-memory preflight acknowledgement, consumed
  // by evaluateDevMemoryPreflightGate at every DEV-entry door.
  readDevMemoryPreflightAck(storyId: string): DevMemoryPreflightAckData | null {
    try {
      return this.readJson<DevMemoryPreflightAckData>(storyId, 'dev-memory-preflight-ack.json');
    } catch (e) {
      if (e instanceof StoryArtifactMissingError) return null;
      throw e;
    }
  }

  writeDevMemoryPreflightAck(storyId: string, data: DevMemoryPreflightAckData): void {
    this.writeJson(storyId, 'dev-memory-preflight-ack.json', data);
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

  readMilestoneCloseout(storyId: string): MilestoneCloseoutSnapshot | null {
    try {
      return this.readJson<MilestoneCloseoutSnapshot>(storyId, 'milestone-closeout.json');
    } catch (e) {
      if (e instanceof StoryArtifactMissingError) return null;
      throw e;
    }
  }

  writeMilestoneCloseout(storyId: string, data: MilestoneCloseoutSnapshot): void {
    this.writeJson(storyId, 'milestone-closeout.json', data);
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

  readAcceptanceBasis(storyId: string): AcceptanceBasisArtifactV1 | null {
    try {
      return this.readJson<AcceptanceBasisArtifactV1>(storyId, 'acceptance-basis.json');
    } catch {
      return null;
    }
  }

  writeAcceptanceBasis(storyId: string, data: AcceptanceBasisArtifactV1): void {
    this.writeJson(storyId, 'acceptance-basis.json', data);
  }

  readCertificationWindows(storyId: string): CertificationWindowData {
    try {
      const data = this.readJson<CertificationWindowData>(storyId, CERTIFICATION_WINDOW_FILE);
      return {
        schemaVersion: data.schemaVersion ?? emptyCertificationWindowData().schemaVersion,
        windows: Array.isArray(data.windows) ? data.windows : [],
        receipts: Array.isArray(data.receipts) ? data.receipts : [],
      };
    } catch (e) {
      if (e instanceof StoryArtifactMissingError) return emptyCertificationWindowData();
      throw e;
    }
  }

  writeCertificationWindows(storyId: string, data: CertificationWindowData): void {
    this.writeJson(storyId, CERTIFICATION_WINDOW_FILE, data);
  }

  readReviewInventoryEpochs(storyId: string): ReviewInventoryEpochData {
    try {
      const data = this.readJson<ReviewInventoryEpochData>(storyId, REVIEW_INVENTORY_EPOCHS_FILE);
      return {
        schemaVersion: data.schemaVersion ?? emptyReviewInventoryEpochData().schemaVersion,
        epochs: Array.isArray(data.epochs) ? data.epochs : [],
        receipts: Array.isArray(data.receipts) ? data.receipts : [],
        criticReceipts: Array.isArray(data.criticReceipts) ? data.criticReceipts : [],
      };
    } catch (e) {
      if (e instanceof StoryArtifactMissingError) return emptyReviewInventoryEpochData();
      throw e;
    }
  }

  writeReviewInventoryEpochs(storyId: string, data: ReviewInventoryEpochData): void {
    this.writeJson(storyId, REVIEW_INVENTORY_EPOCHS_FILE, data);
  }

  readPreReviewCheck(storyId: string): PreReviewCheckArtifactV1 | null {
    try { return this.readJson<PreReviewCheckArtifactV1>(storyId, 'pre-review-check.json'); }
    catch (e) { if (e instanceof StoryArtifactMissingError) return null; throw e; }
  }

  writePreReviewCheck(storyId: string, data: PreReviewCheckArtifactV1): void {
    this.writeJson(storyId, 'pre-review-check.json', data);
  }

  readAcceptanceRolloutReport(storyId: string): AcceptanceRolloutArtifactV1 | null {
    try { return this.readJson<AcceptanceRolloutArtifactV1>(storyId, 'acceptance-rollout-report.json'); }
    catch (e) { if (e instanceof StoryArtifactMissingError) return null; throw e; }
  }

  writeAcceptanceRolloutReport(storyId: string, data: AcceptanceRolloutArtifactV1): void {
    this.writeJson(storyId, 'acceptance-rollout-report.json', data);
  }

  readTopologyCriticReceipt(storyId: string): TopologyCriticReceiptV1 | null {
    try { return this.readJson<TopologyCriticReceiptV1>(storyId, 'topology-critic-receipt.json'); }
    catch (e) { if (e instanceof StoryArtifactMissingError) return null; throw e; }
  }

  writeTopologyCriticReceipt(storyId: string, data: TopologyCriticReceiptV1): void {
    this.writeJson(storyId, 'topology-critic-receipt.json', data);
  }

  readTopologyExclusionApprovals(storyId: string): TopologyExclusionApprovalsDataV1 {
    try { return this.readJson<TopologyExclusionApprovalsDataV1>(storyId, 'topology-exclusion-approvals.json'); }
    catch (e) {
      if (e instanceof StoryArtifactMissingError) return { schemaVersion: 'proofstory.topology_exclusion_approvals.v1', storyId, approvals: [] };
      throw e;
    }
  }

  writeTopologyExclusionApprovals(storyId: string, data: TopologyExclusionApprovalsDataV1): void {
    this.writeJson(storyId, 'topology-exclusion-approvals.json', data);
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

  /**
   * The trust boundary between the on-disk red-evidence file and the typed
   * domain (B-2aa7, decisions D-1/D-3/D-4/D-8). This method is the I/O shell:
   * it locates and parses the file, and `core/red-evidence-artifact-validation.ts`
   * — a pure leaf — decides what is well-formed.
   *
   * Three outcomes, and they are deliberately different:
   *  - ABSENT file        -> `null`, the ordinary not-configured path (row E4/B3).
   *  - ENVELOPE fault     -> a typed `RedEvidenceArtifactError` NAMING THE PATH,
   *                          including an unparseable file (row E7 requires a
   *                          throw, just a typed one). Validated BEFORE any
   *                          record, so an envelope fault can never be reported
   *                          as a record fault (§2.4).
   *  - MALFORMED RECORD   -> D-4 quarantine: `records` keeps only well-formed
   *                          entries and the rejected ones are RETAINED on
   *                          `malformedRecords`. Never dropped, never thrown.
   *
   * The W2c / B-506e unsupported-per-record-schemaVersion rejection is unchanged
   * and still runs ahead of the v1 shape check; it now sits behind the envelope
   * check, which is what stops it being handed the characters of a string.
   *
   * `malformedRecords` on the returned value is ALWAYS this read's own
   * classification. The validator strips any occurrence of that key found on
   * disk, so the file cannot tell this method what was quarantined — which it
   * must not be able to do, because `writeRedEvidence` below re-inserts every
   * quarantined `value` back into `records`, and `records` is gate evidence.
   */
  readRedEvidence(storyId: string): RedEvidenceData | null {
    const artifactFile = 'red-evidence.json';
    let candidate: JsonCandidate<unknown>;
    try {
      candidate = this.readJsonCandidate<unknown>(storyId, artifactFile, (cause, filePath) =>
        redEvidenceArtifactParseError(filePath, cause));
    } catch (e) {
      if (e instanceof StoryArtifactMissingError) return null;
      throw e;
    }
    return validateRedEvidenceArtifact(candidate.data, candidate.filePath);
  }

  /**
   * The WRITE counterpart of {@link StoryStore.readRedEvidence}, and the point
   * where D-4's "never drop" stops depending on every caller remembering it.
   *
   * `readRedEvidence` hands the typed domain a CLEAN `records` array and retains
   * the rejected entries on the derived `malformedRecords` key, so any writer
   * that rebuilds an envelope from that clean array persists the clean subset and
   * DELETES the quarantined originals. `restoreQuarantinedRecords` lets a caller
   * avoid that; `red_evidence_create` calls it. The chain appender cannot — it
   * lives under `core/red-evidence/`, owned by the merged sibling B-506e — and
   * the corruption precheck the chain commands were given instead runs BEFORE
   * the chain lock, while the appender re-reads INSIDE it. An artifact that
   * becomes malformed between those two reads is quarantined by the locked read
   * and dropped by the rebuild, with the pre-lock refusal none the wiser.
   *
   * So the rule is applied HERE, to whatever is about to be persisted, and it
   * therefore holds for every writer, present and future, blocked or not.
   * `retainQuarantinedRecordsOnWrite` is pure and fails closed: it re-inserts
   * each retained entry at its on-disk index, strips the derived key so it is
   * never persisted, and throws rather than write a lossy envelope when the
   * reconstruction cannot be proven.
   *
   * `data` is whatever the caller passes, and this method does not read the
   * artifact first, so an IN-MEMORY payload arrives here with its
   * `malformedRecords` intact — nothing had stripped it. Only entries the
   * validator itself derived are honoured (provenance, not shape: an entry is
   * five ordinary members and a literal can look perfect), and a payload
   * claiming any other is REFUSED rather than written, because writing it would
   * persist an envelope missing the records it claims are quarantined. Pass the
   * object `readRedEvidence` returned, or a spread of it, and this is a no-op.
   */
  writeRedEvidence(storyId: string, data: RedEvidenceData): void {
    this.writeJson(storyId, 'red-evidence.json', retainQuarantinedRecordsOnWrite(data));
  }

  // ── Red target bindings (W2b / B-e10d, §1.1.3) ──
  //
  // Storage location: <storyDir>/<storyId>/red-target-bindings.json, schema
  // proofstory.red_target_bindings.v1. Exactly one binding per
  // acceptanceTargetRef; the uniqueness / digest / committed-tree semantics live
  // in core/red-evidence/target-bindings.ts. Read is null-safe on cold start.
  readRedTargetBindings(storyId: string): RedTargetBindingsFile | null {
    try {
      return this.readJson<RedTargetBindingsFile>(storyId, 'red-target-bindings.json');
    } catch (e) {
      if (e instanceof StoryArtifactMissingError) return null;
      throw e;
    }
  }

  writeRedTargetBindings(storyId: string, data: RedTargetBindingsFile): void {
    this.writeJson(storyId, 'red-target-bindings.json', data);
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

  appendProcessEvent(storyId: string, event: Omit<ProcessEvent, 'timestamp'>) {
    const dir = this.storyDir(storyId);
    // B-d877 R3 FIX B: serialize the append on a RELOCATED lock under the
    // gitignored shared `.proof-or-stop/locks/process-events/` prefix (not inside the
    // git-tracked story dir) so a transient holder.json can never be committed.
    return appendProcessEventFn(dir, event, this.runtimeLockDirPath(storyId, 'process-events', 'process-events-append'));
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
