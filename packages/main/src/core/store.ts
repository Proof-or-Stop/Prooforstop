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

  /**
   * @task B-1dc6
   * @checklist CHK-001
   * @title Story lifecycle truth source is persisted by Koala store
   * @type feature
   * @priority high
   * @description
   *   stack-layering 的边界原则要求长期 project state 由 Koala 持有，而不是由
   *   外部 workflow 自己定义。readStory 作为 story 生命周期真相源读取入口，
   *   负责从 story index.json 取出当前 phase、events、worktree 等持久化状态。
   * @changes
   *   - [CHK-001] 把 story 生命周期真相源回链到 StoryStore.readStory
   *   - [CHK-001] 让 gap_analyze 能把长期 project state 持有点追溯到具体代码入口
   */
  readStory(storyId: string): StoryInfo {
    return this.readJson<StoryInfo>(storyId, 'index.json');
  }

  /**
   * @task B-1dc6
   * @checklist CHK-001
   * @title Story lifecycle truth source is written back through Koala store
   * @type feature
   * @priority high
   * @description
   *   writeStory 是 story 生命周期真相源的持久化写入入口。PLAN/DEV/TEST/DONE
   *   等 phase 的最终记录都会通过这里落到 index.json，而不是由外部 workflow
   *   自己持有或定义。
   * @changes
   *   - [CHK-001] 把 story 生命周期真相源的持久化协议回链到 StoryStore.writeStory
   */
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

  /**
   * @task B-1dc6
   * @checklist CHK-001
   * @title Bug protocol is stored by Koala instead of external workflow state
   * @type feature
   * @priority high
   * @description
   *   stack-layering 要求 bug/evidence 的持久化协议由 Koala 自己定义。readBugs
   *   是 bug.json 的统一读取入口，保证 bug 生命周期和状态不依赖外部 workflow
   *   私有状态。
   * @changes
   *   - [CHK-001] 把 bug 持久化协议回链到 StoryStore.readBugs
   */
  readBugs(storyId: string): BugData {
    try {
      return this.readJson<BugData>(storyId, 'bug.json');
    } catch { /* PROBE: missing bug.json means "no bugs yet" */
      return { bugs: [] };
    }
  }

  /**
   * @task B-1dc6
   * @checklist CHK-001
   * @title Bug protocol is persisted through Koala bug store
   * @type feature
   * @priority high
   * @description
   *   writeBugs 把 bug.json 作为长期 project state 的一部分持久化，确保 bug
   *   状态由 Koala 的 store 协议统一维护。
   * @changes
   *   - [CHK-001] 把 bug.json 写入入口回链到 StoryStore.writeBugs
   */
  writeBugs(storyId: string, data: BugData): void {
    this.writeJson(storyId, 'bug.json', data);
  }

  // ── Test Evidence ──

  /**
   * @task B-1dc6
   * @checklist CHK-001
   * @title Test evidence protocol is owned by Koala store
   * @type feature
   * @priority high
   * @description
   *   readTestEvidence 负责读取 story 级 test-evidence.json。它是 gate 最终判定
   *   和完成总结依赖的长期 project state，不应由外部 workflow 另行定义。
   * @changes
   *   - [CHK-001] 把 test evidence 持久化协议回链到 StoryStore.readTestEvidence
   */
  readTestEvidence(storyId: string): TestEvidenceData | null {
    try {
      return this.readJson<TestEvidenceData>(storyId, 'test-evidence.json');
    } catch { /* PROBE: test-evidence.json is optional before the first test run */
      return null;
    }
  }

  /**
   * @task B-1dc6
   * @checklist CHK-001
   * @title Test evidence persistence is controlled by Koala
   * @type feature
   * @priority high
   * @description
   *   writeTestEvidence 把 story 级测试证据写入 test-evidence.json，让 gate 的
   *   最终判定记录和 evidence 协议留在 Koala 的 store 中，而不是散落在外部
   *   workflow 私有状态里。
   * @changes
   *   - [CHK-001] 把 test-evidence.json 写入入口回链到 StoryStore.writeTestEvidence
   */
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
