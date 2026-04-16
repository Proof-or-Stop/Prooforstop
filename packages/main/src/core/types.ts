
export type StoryPhase = 'IDEA' | 'INIT' | 'INIT_CHECK' | 'PLAN' | 'DEV' | 'TEST_CASE' | 'TEST_CASE_REVIEW' | 'TEST' | 'DONE' | 'DISCARDED';

export type StoryType = 'feature' | 'bug' | 'refactor' | 'chore';
export type StoryLane = 'mainline' | 'supporting' | 'exploratory';
export type StoryParallelSafety = 'yes' | 'no' | 'plan_only';

export interface StoryEvent {
  phase: StoryPhase;
  action: 'create' | 'advance' | 'discard';
  timestamp: string;
  branch?: string;
  user?: string;
  sessionId?: string;
  agent?: string;
  reason?: string;
}

export interface StoryInfo {
  storyId: string;
  name: string;
  title: string;
  description: string;
  type: StoryType;
  phase: StoryPhase;
  priority: string;
  source?: string;
  depends?: string[];
  lane?: StoryLane;
  parallelSafe?: StoryParallelSafety;
  sharedHotspots?: string[];
  blockingFor?: string[];
  /** 关键词：领域/模块/概念，用于查重和盘点（不与 checklist item 挂钩） */
  keywords?: string[];
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  events?: StoryEvent[];
  worktree?: {
    path: string;
    branch: string;
    createdAt: string;
  };
  /** 高风险信号（OMX 风格自动检测）：触发的关键词分类 */
  riskSignals?: Array<{ category: string; matched: string }>;
  /**
   * B-5010 CHK-004: 被主 agent 显式驳回的 risk signal（误报白名单）。
   * story_review 在判断 isHighRisk / advisory message 时会跳过被 dismiss 的
   * category。dismiss 是 append-only，不支持撤销（复盘时能看到驳回理由）。
   */
  riskSignalsDismissed?: Array<{ category: string; reason: string; at: string }>;
}

export type ChecklistStatus = 'pending' | 'in_progress' | 'done';

export type TestIntentType = 'cli_blackbox' | 'browser_blackbox';

export interface TestIntentItem {
  desc: string;
  type: TestIntentType;
  results?: TestIntentResult[];
}

export interface TestIntentResult {
  time: string;
  pass?: boolean;  // undefined = 纯回复（对话上下文），不是判定
  note: string;
  role?: 'reviewer' | 'author' | 'intent';  // reviewer=审核方, author=主agent, intent=test-intent agent
}

/** 每条 testIntent 可以是新结构 {desc,type} 或旧格式纯字符串（兼容迁移前数据） */
export type TestIntentEntry = TestIntentItem | string;

export interface TestIntent {
  happy: TestIntentEntry[];
  edge: TestIntentEntry[];
  adversarial: TestIntentEntry[];
}

export interface ChecklistItem {
  id: string;
  title: string;
  /** 根因/参考方案，给执行 agent 提供上下文（可选） */
  context?: string;
  /** 测试意图三栏：正常/边界/对抗（可选）；null = 显式不可自动化测试 */
  testIntent?: TestIntent | null;
  /** 关联文档路径，PLAN 阶段手动声明，三次提醒（DEV/done/DONE）使用 */
  relatedDocs?: string[];
  /**
   * B-5010 CHK-002: item 所属阶段。默认 'DEV'。
   * - 'DEV'：DEV 阶段工作，进入 TEST_CASE 前必须 done
   * - 'TEST_CASE'：TEST_CASE 阶段工作（fixture 编写 / perf sanity 等），
   *   不纳入 DEV→TEST_CASE 门禁，但 TEST_CASE→TEST_CASE_REVIEW 时仍要求 done
   * 避免 fixture 类 item 的鸡生蛋：原本 CHK-007/008 这类要求 done 才能进 TEST_CASE
   * 但实际工作必须在 TEST_CASE 阶段做，只能先撒谎 mark done。
   */
  phase?: 'DEV' | 'TEST_CASE';
  status: ChecklistStatus;
  startTime: string | null;
  endTime: string | null;
}

export interface ChecklistAuditEntry {
  timestamp: string;
  phase: StoryPhase;
  itemId: string;
  action: 'update' | 'delete';
  from: ChecklistStatus;
  to: ChecklistStatus;
  reason: string;
  agent?: string;
}

export interface ChecklistData {
  items: ChecklistItem[];
  auditLog?: ChecklistAuditEntry[];
}

export interface ReviewIssue {
  type: string;
  severity?: 'blocker' | 'advisory';
  itemId?: string;
  message: string;
}

export type StoryAdvanceReasonCode =
  | 'missing_test_intent'
  | 'story_review_missing'
  | 'story_review_failed'
  | 'review_signature_invalid'
  | 'dev_checklist_incomplete'
  | 'review_failed'
  | 'test_evidence_missing'
  | 'test_failed'
  | 'bug_open'
  | 'transition_blocked';

export interface PhaseInvariantIssue {
  code: string;
  detail: string;
}

export interface PhaseGateDecision {
  targetPhase: string;
  ok: boolean;
  outcome: 'allow' | 'block' | 'rollback';
  reasonCode: StoryAdvanceReasonCode | null;
  issues: PhaseInvariantIssue[];
  humanHint: string | null;
  rollbackPhase?: StoryPhase | null;
}

export interface ReviewEntry {
  timestamp: string;
  issueCount: number;
  blockerCount?: number;
  issues: ReviewIssue[];
  _hash?: string;
}

export interface ReviewData {
  reviews: ReviewEntry[];
}

export interface ImplementationReviewFinding {
  file: string;
  line: number;
  why: string;
  severity: 'info' | 'medium' | 'high';
}

export interface ImplementationReviewResultData {
  storyId: string;
  verdict: 'pass' | 'fail';
  findings: ImplementationReviewFinding[];
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export type BugStatus = 'open' | 'fixed';

export interface BugDiagnose {
  rootCause: string[];
  traceDiff: { added: number; removed: number; forked: number } | null;
  suggestedFix: string;
}

export interface BugRecord {
  id: string;
  title: string;
  status: BugStatus;
  foundAt: string;
  fixedAt: string | null;
  /** 关联的 checklist 项 ID（可选） */
  checklistId?: string;
  /** 关联的 fixture case uuid（可选） */
  fixtureId?: string;
  /** 自动诊断结果（test_auto fail 时填充） */
  diagnose?: BugDiagnose;
}

export interface BugData {
  bugs: BugRecord[];
}

/**
 * B-093b: Story completion summary written before advancing to DONE.
 *
 * Agents call `summary_set` to fill this. The `realMachineCoverage` field is
 * auto-scaffolded by scanning test-evidence + fixtures with `sandbox: false`,
 * so agents can't fabricate "已跑" claims. Agents only supply `skipReasons`
 * for the cases marked as not-run.
 *
 * Stored at `docs/story/actives/<storyId>/summary.json`.
 */
export interface StorySummaryData {
  /** Story ID, for sanity check on read/write */
  storyId: string;
  /** 改了什么：每个文件的关键改动，用户视角 */
  changes: string;
  /** 怎么用：slash command / tool / 调用示例 */
  usage: string;
  /** 真机验证覆盖：auto-scaffolded by koala, agent fills skipReasons only */
  realMachineCoverage: {
    /** Cases that were actually run (auto-populated from test-evidence.json + evidence per fixture) */
    ran: Array<{ name: string; where: string }>;
    /** Cases flagged as real-machine (sandbox:false) but NOT run; agent supplies reason per case */
    skipped: Array<{ name: string; where: string; reason: string }>;
  };
  /** 已知限制 / 设计偏离：测试没覆盖的场景、intent 和实现的差异 */
  limitations: string;
  /** 踩坑记录：做这个 story 的时候卡在哪、绕了几次路、下个人应该知道什么。强制字段，不能空 */
  pitfalls: string;
  /**
   * 每阶段进入次数 + 累计耗时（由 summary_set 自动从 story.events 计算）。
   * count = 进入该 phase 的 advance 事件数（回退再进算多次）；
   * durationMs = 在该 phase 停留的毫秒数（从进入到下一次 advance 离开，
   * 当前 phase 未离开时算到 now）。
   */
  phaseStats?: Record<string, { count: number; durationMs: number }>;
  /** 全 story 总耗时（startedAt→endedAt，或 createdAt→now 的 fallback），毫秒 */
  totalDurationMs?: number;
  /**
   * Fixture 执行统计（由 summary_set 从 test-runs.json 聚合）。
   * totalRuns = test_story 调用次数；
   * totalCases = 最近一次 run 的 totalCases（当前 story 绑定的 fixture case 数快照）；
   * cumulativeCasesRun = 所有 run 的 totalCases 之和（累计执行次数）；
   * cumulativePassedCases = 所有 run 的 passedCases 之和。
   */
  fixtureStats?: {
    totalRuns: number;
    totalCases: number;
    cumulativeCasesRun: number;
    cumulativePassedCases: number;
  };
  /** Bug 统计（由 summary_set 从 bug.json 聚合）。 */
  bugStats?: {
    found: number;
    fixed: number;
    open: number;
  };
  /** ISO 8601 write time */
  createdAt: string;
  /** ISO 8601 last update time */
  updatedAt: string;
}

/**
 * B-1522: Append-only log of every test_story invocation for a story.
 * test-evidence.json is overwrite-only and loses run history; this file
 * preserves the sequence so summary_set can compute cumulative stats.
 * Stored at `docs/story/actives/<storyId>/test-runs.json`.
 */
export interface StoryTestRun {
  timestamp: string;
  command: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  durationMs: number;
  result: 'PASS' | 'FAIL';
}

export interface StoryTestRunsData {
  runs: StoryTestRun[];
}

export type TestResult = 'PASS' | 'FAIL';

export interface TestEvidenceData {
  /** 最后一次测试的命令 */
  command: string;
  /** 最后一次测试的输出 */
  output: string;
  /** PASS / FAIL */
  result: TestResult;
  /** 时间戳 */
  timestamp: string;
  /** 运行环境 */
  environment?: {
    node: string;
    os: string;
  };
  /** 浏览器 trace 覆盖的函数名列表 */
  traceCoverage?: string[];
}

/**
 * RALPLAN-DR 结构化决策 (OMX ralplan 风格)。
 * PLAN 阶段应该为每个非 trivial story 落一份 decision.json，
 * 包含原则/驱动/备选/选择/pre-mortem。
 * 第一版软引入：priority=high 或 riskSignals 非空时 story_review 强制要求。
 */
export interface DecisionOption {
  name: string;
  pros: string[];
  cons: string[];
}

export interface PreMortemScenario {
  scenario: string;
  trigger: string;
  consequence: string;
  mitigation: string;
}

export interface DecisionData {
  /** 3-5 条设计原则 */
  principles: string[];
  /** top 3 关键约束 */
  drivers: string[];
  /** ≥ 2 个备选（或显式 invalidation rationale 说明为什么只剩一个）*/
  options: DecisionOption[];
  /** 选择的 option name */
  chosen: string;
  /** 选择理由（呼应 drivers）*/
  rationale: string;
  /** pre-mortem 失败场景（高风险 story 要求 ≥ 3）*/
  preMortem?: PreMortemScenario[];
  /** 时间戳 */
  timestamp: string;
}

/**
 * Pre-context Intake snapshot (OMX 风格)。
 * PLAN 阶段开拆 checklist 之前主 agent 应该先把对任务的理解结构化落下。
 * 第一版软引入：未填只 hint 提醒，不阻塞推进。
 */
export interface UnderstandingData {
  /** 一句话描述要解决的问题 */
  task: string;
  /** 完成后能观察到什么变化 */
  outcome: string;
  /** 已知事实（来自真相源、已有代码、上下文）*/
  facts: string[];
  /** 约束条件（必须遵守的规则、性能/兼容性要求）*/
  constraints: string[];
  /** 未知问题（开拆 checklist 时还没想清楚的）*/
  unknowns: string[];
  /** 可能的代码触点（影响范围）*/
  touchpoints: string[];
  /** 时间戳 */
  timestamp: string;
}
