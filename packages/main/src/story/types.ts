
export type StoryPhase = 'IDEA' | 'PLAN' | 'DEV' | 'TEST' | 'DONE';

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

export interface ChecklistItem {
  id: string;
  title: string;
  /** 根因/参考方案，给执行 agent 提供上下文（可选） */
  context?: string;
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

export type BugStatus = 'open' | 'fixed';

export interface BugRecord {
  id: string;
  title: string;
  status: BugStatus;
  foundAt: string;
  fixedAt: string | null;
  /** 关联的 checklist 项 ID（可选） */
  checklistId?: string;
}

export interface BugData {
  bugs: BugRecord[];
}

export type TestResult = 'PASS' | 'FAIL';

export interface TestEvidenceEntry {
  id: string;
  scenario: string;
  command: string;
  output: string;
  expected: string;
  result: TestResult;
  timestamp: string;
}

export interface TestEvidenceData {
  environment?: {
    node: string;
    os: string;
    timestamp: string;
  };
  tests: TestEvidenceEntry[];
}
