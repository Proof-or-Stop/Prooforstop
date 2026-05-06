
export type {
  ValidationCommand,
  ValidationCommandResult,
  ValidationPlan,
  ValidationResult,
  ValidationStatus,
} from './validation-types.js';

export type StoryPhase = 'IDEA' | 'INIT' | 'INIT_CHECK' | 'PLAN' | 'DEV' | 'REVIEW' | 'TEST' | 'DONE' | 'DISCARDED'
  // Legacy phases kept for backward compat with existing story data
  | 'TEST_CASE' | 'TEST_CASE_REVIEW'
  // B-9bd9 CHK-002: meta-story 专用 phase，永不进 DONE（跨 story 容器，只挂 finding）
  | 'META';

export type StoryType = 'feature' | 'bug' | 'refactor' | 'chore' | 'meta';

export interface StoryEvent {
  phase: StoryPhase;
  action: 'create' | 'advance' | 'discard' | 'reviewer_forced';
  timestamp: string;
  branch?: string;
  user?: string;
  sessionId?: string;
  agent?: string;
  reason?: string;
  reviewer?: string;
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
  /** 当前 REVIEW 轮次 ID（ISO 8601 时间戳），每次进入 REVIEW 时生成 */
  currentReviewRound?: string;
  /** 高风险信号（OMX 风格自动检测）：触发的关键词分类 */
  riskSignals?: Array<{ category: string; matched: string }>;
  /**
   * B-5010 CHK-004: 被主 agent 显式驳回的 risk signal（误报白名单）。
   * story_review 在判断 isHighRisk / advisory message 时会跳过被 dismiss 的
   * category。dismiss 是 append-only，不支持撤销（复盘时能看到驳回理由）。
   */
  riskSignalsDismissed?: Array<{ category: string; reason: string; at: string }>;

  // Parallel policy fields (B-c622)
  lane?: 'mainline' | 'supporting' | 'exploratory';
  parallelSafe?: 'yes' | 'no' | 'plan_only';
  sharedHotspots?: string[];
  blockingFor?: string[];
}

export type ChecklistStatus = 'pending' | 'in_progress' | 'done';

export type VerificationLane = 'happy' | 'edge' | 'adversarial';
export type VerificationIntentType = 'logic' | 'cli' | 'browser' | 'manual' | 'docs';
export type VerificationRequiredIn = 'light' | 'balanced' | 'strict';
export type VerificationPriority = 'must' | 'should' | 'nice';
export type VerificationEvidenceKind = 'logic_test' | 'integration_test' | 'browser_test' | 'manual_transcript' | 'docs_check' | 'waiver';
export const VERIFICATION_EVIDENCE_VERDICTS = ['success', 'blocked_classified', 'audit_only', 'waived'] as const;
export type VerificationEvidenceVerdict = typeof VERIFICATION_EVIDENCE_VERDICTS[number];

export function formatVerificationEvidenceVerdict(verdict: VerificationEvidenceVerdict): string {
  return verdict.replaceAll('_', '-');
}

export interface VerificationIntentItem {
  /** Optional stable id. If absent, Koala derives CHK-001:happy:0 from lane/index. */
  id?: string;
  desc: string;
  type: VerificationIntentType;
  requiredIn?: VerificationRequiredIn;
  priority?: VerificationPriority;
}

export type VerificationIntent = Record<VerificationLane, VerificationIntentItem[]>;

export interface VerificationEvidence {
  /** Reference like CHK-001:happy:0 or a custom VerificationIntentItem.id. */
  intentRef: string;
  kind: VerificationEvidenceKind;
  /** Human-facing classification; does not override result/pass/fail gate semantics. */
  verdict?: VerificationEvidenceVerdict;
  /** Deferred waivers are temporary gate-self-test receipts and must be replaced by real evidence before TEST. */
  waiverType?: 'permanent' | 'deferred_gate_evidence';
  file?: string;
  command?: string;
  result?: 'pass' | 'fail';
  note: string;
  /** Optional git HEAD captured when evidence was recorded. */
  headHash?: string;
  /** Hash of tracked non-story-metadata files captured when evidence was recorded. */
  materialHash?: string;
  timestamp?: string;
}

export interface ChecklistItem {
  id: string;
  title: string;
  /** 根因/参考方案，给执行 agent 提供上下文（可选） */
  context?: string;
  /** 关联文档路径，PLAN 阶段手动声明，三次提醒（DEV/done/DONE）使用 */
  relatedDocs?: string[];
  /** 用户可见输出描述：用户完成此 item 后在终端/UI 看到的具体文本（非抽象描述） */
  userSees?: string;
  /** 显式声明不做的功能点 */
  excludes?: string[];
  /**
   * B-45ed CHK-001: 受影响的文件集合，PLAN 阶段声明。
   * story_review 将用其与 understanding.touchpoints 做覆盖校验（CHK-002）。
   * modify: 需要修改的文件；create: 需要新建的文件；test: 需要覆盖的测试文件。
   */
  files?: {
    readonly modify: readonly string[];
    readonly create: readonly string[];
    readonly test: readonly string[];
  };
  /**
   * Test discipline folded into the second lifecycle:
   * PLAN records happy/edge/adversarial intent, DEV/REVIEW/TEST attach evidence.
   */
  verificationIntent?: VerificationIntent;
  verificationEvidence?: VerificationEvidence[];
  /** @deprecated Legacy item phase from TEST_CASE lifecycle. New flow uses DEV/REVIEW/TEST only. */
  phase?: 'DEV' | 'TEST_CASE';
  /** @deprecated Legacy testIntent kept for old story data and compatibility helpers. */
  testIntent?: TestIntent | null;
  status: ChecklistStatus;
  startTime: string | null;
  endTime: string | null;
}

export type TestIntentType = 'cli_blackbox' | 'browser_blackbox';

export interface TestIntentItem {
  desc: string;
  type: TestIntentType;
  results?: TestIntentResult[];
}

export interface TestIntentResult {
  time: string;
  pass?: boolean;
  note: string;
  role?: 'reviewer' | 'author' | 'intent';
}

export type TestIntentEntry = TestIntentItem | string;

/** @deprecated Use verificationIntent. */
export interface TestIntent {
  happy: TestIntentEntry[];
  edge: TestIntentEntry[];
  adversarial: TestIntentEntry[];
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
  /** delete 时记录被删 item 的原始内容，供 story_review 门禁展示 */
  removedTitle?: string;
  removedContext?: string;
  removedUserSees?: string;
  /** checklist_dispose 裁决结果 */
  disposition?: 'accept' | 'reject' | 'partial';
  justification?: string;
  disposedAt?: string;
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
  /** @deprecated Legacy field from trace profiler era, may exist in stored JSON */
  traceDiff?: { added: number; removed: number; forked: number } | null;
  suggestedFix: string;
}

/** 人工调试证据链（Systematic Debugging 产物） */
export interface BugEvidence {
  /** 用户可观测的症状描述 */
  symptom: string;
  /** 最小复现步骤 */
  reproSteps: string[];
  /** 调试过程中验证过的假设 */
  hypothesis?: string;
  /** 确认的根因 */
  rootCause: string;
  /** 修复点说明（改了什么、为什么有效） */
  fixEvidence: string;
  /** 复现测试路径（logicTest / integrationTest） */
  reproTest?: string;
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
  /** 自动诊断结果（validate fail 时填充） */
  diagnose?: BugDiagnose;
  /** 人工调试证据链（bug_update status=fixed 时填充） */
  evidence?: BugEvidence;
}

export interface BugData {
  bugs: BugRecord[];
}

export const STORY_OUTCOME_KINDS = ['success', 'blocked', 'audit_only'] as const;
export type StoryOutcomeKind = typeof STORY_OUTCOME_KINDS[number];

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
  /** 用户价值验收：PLAN/summary 预期的用户可见结果 */
  expectedOutcome?: string;
  /** 用户价值验收：真实运行后看到的 transcript / 输出摘要 */
  actualTranscript?: string;
  /** 用户价值验收：expected vs actual 的差异说明 */
  outcomeDiff?: string;
  /** 用户价值验收结论 */
  acceptanceVerdict?: 'accepted' | 'partial' | 'rejected';
  /** Terminal outcome classification for DONE stories; omitted legacy data defaults to success. */
  outcomeKind?: StoryOutcomeKind;
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
   * totalRuns = validate 调用次数；
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

export function isStoryOutcomeKind(outcomeKind: unknown): outcomeKind is StoryOutcomeKind {
  return typeof outcomeKind === 'string' && STORY_OUTCOME_KINDS.includes(outcomeKind as StoryOutcomeKind);
}

export function normalizeStoryOutcomeKind(outcomeKind: unknown): StoryOutcomeKind {
  return isStoryOutcomeKind(outcomeKind) ? outcomeKind : 'success';
}

export function formatStoryOutcomeKind(outcomeKind: StoryOutcomeKind): string {
  return outcomeKind === 'audit_only' ? 'audit-only' : outcomeKind;
}

/**
 * B-1522: Append-only log of every validate invocation for a story.
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

/** Finding: koala-reviewer 提出的发现项（替代 testIntent） */
export interface Finding {
  id: string;            // 格式 B-xxx:F-001
  desc: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: 'happy' | 'edge' | 'adversarial' | 'missing';
  status: 'open' | 'resolved' | 'dismissed';
  agent?: string;
  createdAt?: string;
  _hash?: string;
  reviewRound?: string;
  dismissReason?: string;
  dismissedAt?: string;
  /** B-e8c8 / B-9d95 CHK-005: 关联文件路径（用于 cluster files-overlap 判定 + 兜底从 desc 抽取） */
  files?: string[];
  /** B-e8c8: 当前所属 cluster ID（CL-xxx）；未归簇为 undefined */
  clusterId?: string;
  /** B-e8c8 CHK-010: commit `Resolves: CL-xxx` 自动 resolve 时的审计字段（格式 "CL-xxx@<sha7>"） */
  resolvedBy?: string;
  /**
   * B-9bd9 CHK-002: meta-story audit finding 专用字段（非 audit finding 留空即可，老 finding 视为 legacy）。
   * driftHash = sha1(sectionPath + symbol + driftType) 前 10 位，跨进程稳定，幂等去重。
   * lastSeenAt = 每轮 audit 若该 drift 仍存在则刷新（ISO 8601）。
   * firstSeenRound = 首次发现该 drift 的 round number（1-based，单调递增）。
   */
  driftHash?: string;
  lastSeenAt?: string;
  firstSeenRound?: number;
  /** auto-resolve 时留证据链，区别于普通 finding_resolve */
  resolvedReason?: string;
  resolvedAt?: string;
}

export interface FindingData {
  findings: Finding[];
}

/** Reviewer pass receipt: reviewer explicitly checked a round and found no blocker. */
export interface ReviewPass {
  id: string;
  agent: string;
  note: string;
  createdAt: string;
  reviewRound?: string;
  _hash?: string;
}

export interface ReviewPassData {
  passes: ReviewPass[];
}

/** Evaluator 打分证据（browser 项目 DONE gate 消费） */
export interface EvalEvidenceData {
  scores: { functionality: number; usability: number };
  total: number;
  pass: boolean;
  itemResults: Array<{ itemId: string; pass: boolean; note: string }>;
  findings: string[];
  timestamp: string;
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
  /** 测试时的 git HEAD hash（用于 DONE gate evidence freshness 检查） */
  headHash?: string;
  /** 测试时的非 Koala 元数据文件树 hash（metadata-only commit 不应让 evidence stale） */
  materialHash?: string;
  /** @deprecated Legacy evidence freshness field. New writes use headHash. */
  git?: {
    head: string | null;
    branch?: string | null;
  };
  /** Story-level verification intent coverage captured during validate/story_advance. */
  verificationCoverage?: VerificationCoverageReport;
}

export interface VerificationCoverageEntry {
  intentRef: string;
  itemId: string;
  lane: VerificationLane;
  desc: string;
  type: VerificationIntentType;
  priority: VerificationPriority;
  status: 'covered' | 'missing' | 'failed' | 'waived' | 'deferred' | 'stale';
  evidence?: VerificationEvidence;
}

export interface VerificationCoverageReport {
  total: number;
  required: number;
  covered: number;
  missingRequired: number;
  entries: VerificationCoverageEntry[];
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

// ── Workflow Profile ──

export type WorkflowProfile = 'light' | 'balanced' | 'strict';

export type WorkflowPolicy = {
  profile: WorkflowProfile;
  quickPath: {
    enabled: boolean;
    maxChecklistItems: number;
    allowRiskSignals: boolean;
  };
  plan: {
    requireUnderstanding: 'always' | 'high_risk' | 'never';
    requireDecision: 'always' | 'high_risk' | 'never';
    requirePlanMd: 'always' | 'normal' | 'never';
    requireStoryReview: boolean;
  };
  subagents: {
    requireWorkerInNormalChannel: boolean;
    allowMainAgentCoding: boolean;
  };
  review: {
    requireReviewer: boolean;
    requireReviewerFinding: boolean;
    blockingSeverities: Array<'critical' | 'high' | 'medium'>;
    requireLightReview: boolean;
  };
  test: {
    requireValidatePass: boolean;
    requireAllBugsFixed: boolean;
    requireEvaluatorForBrowser: boolean;
  };
  done: {
    requireSummary: 'full' | 'minimal' | 'none';
    requireBranchSynced: boolean;
    requireCleanGit: boolean;
  };
};

// ── Process Metrics (B-abd8: Phase 2 telemetry) ──

export type MetricConfidence = 'high' | 'medium' | 'low' | 'unknown';

export interface ProcessMetricValue {
  value: number | boolean | string | null;
  unit?: 'count' | 'ratio' | 'ms' | 'hours' | 'bool' | 'text';
  confidence: MetricConfidence;
  sources: string[];
  note?: string;
}

export interface ProcessDimensionMetrics {
  effective: ProcessMetricValue;
  metrics: Record<string, ProcessMetricValue>;
  gaps?: string[];
}

export interface StoryProcessMetrics {
  storyId: string;
  generatedAt: string;
  sourceSnapshot: {
    hasUnderstanding: boolean;
    hasDecision: boolean;
    hasPlan: boolean;
    checklistItems: number;
    reviewRounds: number;
    findings: number;
    bugs: number;
    testRuns: number;
    hasEvalEvidence: boolean;
    hasSummary: boolean;
  };
  dimensions: {
    tdd: ProcessDimensionMetrics;
    requirementCompleteness: ProcessDimensionMetrics;
    debugging: ProcessDimensionMetrics;
    planning: ProcessDimensionMetrics;
    subagentCollaboration: ProcessDimensionMetrics;
    reviewDiscipline: ProcessDimensionMetrics;
  };
  overallGaps: string[];
}

// ── Process Events (B-aa48: Phase 3 telemetry) ──

export type ProcessEventType =
  | 'plan_reviewed'
  | 'bug_reopened'
  | 'dispatch'
  | 'subagent_result'
  | 'light_review'
  | 'plan_updated'
  | 'codex_cli'
  | 'codex_adapter_verification'
  | 'reviewer_finding'
  | 'review_pass';

export type ProcessEvent = {
  type: ProcessEventType;
  timestamp: string;
  [key: string]: unknown;
};

// ── Scope Check (B-d4d1: signed scope-check.json written by koala-review-scope-plan agent) ──
// B-ed3e CHK-002: schema 扩 5 档 + source 字段（向后兼容，老数据缺字段默认 undefined / 0）。
// 签名域（signScopeCheck 参数）不变：仍只含 storyId / timestamp / gaps / covered / reviewRound，
// 新加的 source / orphanSuspect / drift / openQuestions 不入 _hash（见 decision preMortem 1）。

export interface ScopeCheckFeature {
  feature: string;
  covered_by: string | null;
  /**
   * B-ed3e: 5 档状态。老 scope-check.json 只包含 covered/excluded/gap 三档，向后兼容。
   * - orphan-suspect: reviewer 在 decisions/ 全目录扫到 spec 承诺，但 checklist 未覆盖且未 excluded
   * - drift: spec 与实现偏离；**PLAN 阶段恒为空集**，留位给 S3（diff 输入 + phase 流程改造）
   */
  status: 'covered' | 'excluded' | 'gap' | 'orphan-suspect' | 'drift';
  excluded_by: string | null;
  /**
   * B-ed3e: 标注该 feature 来源，便于 reviewer 追溯。约定值：
   * - 'description'            （来自 story description）
   * - 'decisions:<path>'       （来自 decisions/ 全目录扫描，如 `decisions:docs/requirements/decisions/api.md`）
   * - 'relatedDocs:<path>'     （来自 checklist.relatedDocs，遗留兼容）
   * 类型保持 string 不做 literal union，以便未来扩展。老数据此字段缺失 → undefined。
   */
  source?: string;
}

export interface ScopeCheckData {
  storyId: string;
  checkedAt: string;
  features: ScopeCheckFeature[];
  /**
   * B-ed3e: summary 扩 orphanSuspect / drift 计数。
   * 老数据 readScopeCheck 时用 ?? 0 兜底，保证 PLAN gate 不崩。
   * drift 在 PLAN 阶段恒为 0（S3 才接 diff 输入）。
   */
  summary: {
    total: number;
    covered: number;
    excluded: number;
    gaps: number;
    orphanSuspect: number;
    drift: number;
  };
  /**
   * B-ed3e CHK-003: 第 6 通道 Open Questions。reviewer 在 decisions/ 全目录扫到
   * "看见但不归类"的矛盾/疑问时写入。主 agent 必须用 `koala scope_question_resolve`
   * 书面消解（防自我赦免）；PLAN gate 会 block 未 resolve 的 OQ。
   * 签名域不含此字段（resolution 是 main agent 动作，不进 reviewer 签名 _hash）。
   */
  openQuestions?: OpenQuestion[];
  reviewRound?: string;
  _hash: string;
}

// ── Init Check (B-e71f: signed init-check.json written by koala-review-story-init agent) ──
// INIT → INIT_CHECK 硬门槛产物。reviewer subagent 审查 background.md + checklist 初版后写入，
// `_hash` 覆盖 storyId / sha256(background.md) / title / description / sha256(checklist 初版) / reviewRound + INIT_CHECK_SALT。
// 主 agent 改 background / title / description / checklist 初版后 _hash 失配 → story_advance INIT_CHECK
// 报 init_check_tampered blocker（CHK-005 / CHK-006）。
// agentId 字段为 reviewer 自报 id，**仅审计追溯用**（EXP-001 证伪 agentId 机械可校验性，详见
// docs/story/actives/B-e71f/experiments/exp-001.md），不参与签名也不参与 gate 决策。
// issues 为 advisory：critical / high 不阻塞 INIT_CHECK 推进，由 reviewer 模板自律拒调 CLI 兜底
// （critical 时 reviewer 应 stdout 输出 issue list 让主 agent 改 background 后重启 reviewer，
// 不调 init_check_set）。

export interface InitCheckIssue {
  /**
   * reviewer 自分配的 id，如 "I-1" / "I-2"。
   * 与 cli-engine.ts init_check_set Zod schema (`id: z.string().optional()`) 对齐：
   * reviewer 可省略，省略时 JSON.stringify 会丢字段（不写空串），消费方需 narrow 处理。
   */
  id?: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** 具体描述（runtime 校验 trim().length >= 1，禁空白串） */
  desc: string;
}

/**
 * B-9975 CHK-002: Draft check data (parallel to InitCheckData but for drafts).
 * Written by draft_check_set, consumed by draft_issue_resolve.
 */
export interface DraftCheckData {
  draftName: string;
  checkedAt: string;
  reviewRound: string;
  agentId: string;
  issues: InitCheckIssue[];
  resolutions?: Record<string, string>;
  _hash: string;
}

/**
 * B-e71f F-013: 原 `InitCheckResolution` interface 已删除（声明但无引用，且
 * 决策已锁定 Concat-Advisory 通道——主 agent 修 background 后重跑 reviewer 即触发
 * _hash 失配自动重审，不再引入 `init_issue_resolve` 独立 CLI）。如未来需要手动消解
 * 通道，请新建专用类型而不是复活该死类型。
 */
export interface InitCheckData {
  storyId: string;
  /** ISO 8601 写入时刻 */
  checkedAt: string;
  /**
   * 写入时 story.currentReviewRound 快照（INIT 阶段为 ''）。
   * 抄 ScopeCheckData / scope-check.ts:14 套路，签名域包含此字段。
   */
  reviewRound: string;
  /**
   * Reviewer 自报 agent id（subagent session id 或人为标识）。
   * **不参与签名 / 不参与 gate 校验**，仅作为审计追溯字段（EXP-001 已证伪 agentId 机械区分能力）。
   */
  agentId: string;
  /**
   * Reviewer 提出的问题列表，advisory 模式：不阻塞 INIT_CHECK 推进，仅在 advance 成功消息中 echo。
   * 允许空数组（reviewer 认为完全合格时）。
   */
  issues: InitCheckIssue[];
  /**
   * Per-reviewer records. New writes upsert by agentId so separate init reviewers
   * cannot silently overwrite each other. Legacy init-check.json files without
   * this field are interpreted as one record from `agentId`.
   */
  agentResults?: Array<{
    agentId: string;
    checkedAt: string;
    issues: InitCheckIssue[];
  }>;
  /**
   * 签名：sha256(`${storyId}:${backgroundHash}:${title}:${description}:${checklistHash}:${reviewRound}:${INIT_CHECK_SALT}`)
   * 由 signInitCheck 计算。issues / agentId 不入签名域（issues 是 reviewer 主观判断，allow 后续修；
   * agentId 是 reviewer 自报易伪造，靠 reviewer 模板 fence 兜底）。
   */
  _hash: string;
}

// ── Delivery Check (B-35ed: TEST→DONE 硬门槛) ──

export interface DocsPromise {
  docPath: string;
  promise: string;
  /**
   * Optional reviewer-friendly status. DONE gate treats met/verified as
   * verified and waived as an explicit waiver, matching delivery_check_set help.
   */
  status?: 'met' | 'verified' | 'waived' | 'unverified';
  verifiedBy?: string;
  evidence?: string;
  /** 豁免理由（≥ 30 字符），入签名防事后篡改 */
  waiverReason?: string;
}

export interface RealMachineTest {
  featureId: string;
  transcript: string;
  /** 豁免理由（≥ 30 字符入 _hash 防事后篡改），无真机测试时必填 */
  waiverReason?: string;
}

export interface ClosingSelfCheck {
  hasRealMachineTest: boolean;
  hasEdgeCaseCoverage: boolean;
  hasUnresolvedTodos: boolean;
  summary: string;
}

export interface DeliveryCheckData {
  storyId: string;
  /** ISO 8601 写入时刻 */
  checkedAt: string;
  /** 写入时 story.currentReviewRound 快照 */
  reviewRound: string;
  /** Reviewer 自报 agent id，仅审计追溯（不参与签名） */
  agentId: string;
  docsPromises: DocsPromise[];
  realMachineTests: RealMachineTest[];
  closingSelfCheck: ClosingSelfCheck;
  /**
   * 签名：sha256(storyId:JSON(docsPromises):JSON(realMachineTests):JSON(closingSelfCheck):reviewRound:salt)
   */
  _hash: string;
}

/**
 * B-ed3e CHK-003: Open Question 条目。
 * - id: 如 "OQ-1" / "OQ-2"（reviewer 自己分配）
 * - q: 疑问文本
 * - evidence: reviewer 的观察证据（哪条 decisions/ 文件的哪段提到了什么）
 * - sourcePointers: 证据指向的 decisions/ 路径或 checklist item id
 * - resolution: 主 agent 通过 scope_question_resolve 填入的消解结论（≥ 20 字符）
 * - resolvedAt: resolution 写入时刻（ISO）
 */
export interface OpenQuestion {
  id: string;
  q: string;
  evidence: string;
  sourcePointers: string[];
  resolution?: string;
  resolvedAt?: string;
}

/** 全序：light=0 < balanced=1 < strict=2 */
export const PROFILE_ORDER: Record<WorkflowProfile, number> = {
  light: 0,
  balanced: 1,
  strict: 2,
};

export const WORKFLOW_PRESETS: Record<WorkflowProfile, WorkflowPolicy> = {
  light: {
    profile: 'light',
    quickPath: { enabled: true, maxChecklistItems: 5, allowRiskSignals: false },
    plan: { requireUnderstanding: 'never', requireDecision: 'never', requirePlanMd: 'never', requireStoryReview: false },
    subagents: { requireWorkerInNormalChannel: false, allowMainAgentCoding: true },
    review: { requireReviewer: false, requireReviewerFinding: false, blockingSeverities: ['critical'], requireLightReview: false },
    test: { requireValidatePass: true, requireAllBugsFixed: true, requireEvaluatorForBrowser: false },
    done: { requireSummary: 'minimal', requireBranchSynced: true, requireCleanGit: true },
  },
  balanced: {
    profile: 'balanced',
    quickPath: { enabled: true, maxChecklistItems: 2, allowRiskSignals: false },
    plan: { requireUnderstanding: 'always', requireDecision: 'high_risk', requirePlanMd: 'normal', requireStoryReview: true },
    subagents: { requireWorkerInNormalChannel: true, allowMainAgentCoding: false },
    review: { requireReviewer: true, requireReviewerFinding: true, blockingSeverities: ['critical', 'high'], requireLightReview: true },
    test: { requireValidatePass: true, requireAllBugsFixed: true, requireEvaluatorForBrowser: true },
    done: { requireSummary: 'full', requireBranchSynced: true, requireCleanGit: true },
  },
  strict: {
    profile: 'strict',
    quickPath: { enabled: false, maxChecklistItems: 0, allowRiskSignals: false },
    plan: { requireUnderstanding: 'always', requireDecision: 'always', requirePlanMd: 'always', requireStoryReview: true },
    subagents: { requireWorkerInNormalChannel: true, allowMainAgentCoding: false },
    review: { requireReviewer: true, requireReviewerFinding: true, blockingSeverities: ['critical', 'high', 'medium'], requireLightReview: true },
    test: { requireValidatePass: true, requireAllBugsFixed: true, requireEvaluatorForBrowser: true },
    done: { requireSummary: 'full', requireBranchSynced: true, requireCleanGit: true },
  },
};
