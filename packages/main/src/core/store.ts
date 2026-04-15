import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import type {
  StoryInfo, ChecklistData, BugData, TestEvidenceData, ReviewData,
  UnderstandingData, DecisionData, StorySummaryData, ImplementationReviewResultData,
  StoryTestRun, StoryTestRunsData,
} from './types.js';

export class StoryStore {
  private baseDir: string;

  constructor(projectRoot: string) {
    this.baseDir = join(projectRoot, 'docs', 'story', 'actives');
  }

  private storyDir(storyId: string): string {
    return join(this.baseDir, storyId);
  }

  private ensureDir(storyId: string): void {
    const dir = this.storyDir(storyId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  private readJson<T>(storyId: string, file: string): T {
    const filePath = join(this.storyDir(storyId), file);
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  }

  private writeJson<T>(storyId: string, file: string, data: T): void {
    this.ensureDir(storyId);
    const filePath = join(this.storyDir(storyId), file);
    writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }

  // ── Story ──

  readStory(storyId: string): StoryInfo {
    return this.readJson<StoryInfo>(storyId, 'index.json');
  }

  writeStory(storyId: string, data: StoryInfo): void {
    this.writeJson(storyId, 'index.json', data);
  }

  storyExists(storyId: string): boolean {
    return existsSync(join(this.storyDir(storyId), 'index.json'));
  }

  listStoryIds(): string[] {
    if (!existsSync(this.baseDir)) return [];
    return readdirSync(this.baseDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && existsSync(join(this.baseDir, d.name, 'index.json')))
      .map(d => d.name);
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
    } catch { /* PROBE: missing bug.json means "no bugs yet" */
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
    } catch { /* PROBE: test-evidence.json is optional before the first test run */
      return null;
    }
  }

  writeTestEvidence(storyId: string, data: TestEvidenceData): void {
    this.writeJson(storyId, 'test-evidence.json', data);
  }

  // ── Review ──

  readReview(storyId: string): ReviewData {
    try {
      return this.readJson<ReviewData>(storyId, 'review.json');
    } catch { /* PROBE: review.json is absent until the first story_review */
      return { reviews: [] };
    }
  }

  writeReview(storyId: string, data: ReviewData): void {
    this.writeJson(storyId, 'review.json', data);
  }

  // ── Implementation review results ──

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
    } catch { /* PROBE: understanding.json is optional before PLAN intake is recorded */
      return null;
    }
  }

  writeUnderstanding(storyId: string, data: UnderstandingData): void {
    this.writeJson(storyId, 'understanding.json', data);
  }

  // ── Decision (RALPLAN-DR 结构化决策，OMX 风格) ──

  readDecision(storyId: string): DecisionData | null {
    try {
      return this.readJson<DecisionData>(storyId, 'decision.json');
    } catch { /* PROBE: decision.json is optional for non-high-risk stories */
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
    } catch { /* PROBE: summary.json exists only near DONE */
      return null;
    }
  }

  writeSummary(storyId: string, data: StorySummaryData): void {
    this.writeJson(storyId, 'summary.json', data);
  }

  // ── Test Runs (B-1522: append-only log of every test_story invocation) ──

  readTestRuns(storyId: string): StoryTestRunsData {
    try {
      return this.readJson<StoryTestRunsData>(storyId, 'test-runs.json');
    } catch { /* PROBE: append-only test history starts empty */
      return { runs: [] };
    }
  }

  appendTestRun(storyId: string, run: StoryTestRun): void {
    const data = this.readTestRuns(storyId);
    data.runs.push(run);
    this.writeJson(storyId, 'test-runs.json', data);
  }
}
