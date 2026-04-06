
export type StoryPhase = 'IDEA' | 'INIT' | 'INIT_CHECK' | 'PLAN' | 'DEV' | 'TEST_CASE' | 'TEST_CASE_REVIEW' | 'TEST' | 'DONE' | 'DISCARDED';

export type StoryType = 'feature' | 'bug' | 'refactor' | 'chore';

export interface StoryEvent {
  phase: StoryPhase;
  action: 'create' | 'advance';
  timestamp: string;
  branch?: string;
  user?: string;
  sessionId?: string;
  agent?: string;
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
  /** 测试意图三栏：正常/边界/对抗（可选） */
  testIntent?: TestIntent;
  /** 关联文档路径，PLAN 阶段手动声明，三次提醒（DEV/done/DONE）使用 */
  relatedDocs?: string[];
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
