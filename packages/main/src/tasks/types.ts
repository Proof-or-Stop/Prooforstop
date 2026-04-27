
export interface TaskAnnotation {
  task: string;
  checklist?: string[];
  title?: string;
  type?: string;
  priority?: string;
  version?: string;
  scope?: string;
  depends?: string[];
  author?: string;
  date?: string;
  description?: string;
  changes?: string[];
  affected?: string[];
  /** 来源文件（相对于扫描根目录） */
  sourceFile: string;
  /** 注释块起始行号 */
  sourceLine: number;
  /** 注释紧邻的函数/方法名（如有） */
  functionName?: string;
  /** 函数签名（如有），如 `async function foo(bar: string): Promise<void>` */
  functionSignature?: string;
  /** @flow 链路名称 */
  flow?: string;
  /** @flow 步骤序号 */
  step?: number;
  /** @flow 输入描述 */
  input?: string;
  /** @flow 输出描述 */
  output?: string;
  /** @flow 下一步函数名 */
  next?: string;
  /** @test fixture 路径 */
  test?: string;
}

/** 校验问题 */
export interface ValidationIssue {
  loc: string;
  level: 'error' | 'warn';
  msg: string;
}

/** 校验结果 */
export interface ValidationResult {
  filesScanned: number;
  tasksFound: number;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  filesWithoutTask: string[];
  passed: boolean;
}

/** 覆盖率检查项 */
export interface CoverageItem {
  checklistId: string;
  title: string;
  covered: boolean;
  /** 覆盖该 checklist 项的源码位置列表 */
  locations: Array<{ file: string; line: number; functionName?: string }>;
}

/** 覆盖率结果 */
export interface CoverageResult {
  storyId: string;
  total: number;
  covered: number;
  missing: number;
  items: CoverageItem[];
  passed: boolean;
}

/** 定位结果 */
export interface LocateResult {
  query: string;
  matches: Array<{
    task: string;
    checklist?: string[];
    title?: string;
    file: string;
    line: number;
    functionName?: string;
    functionSignature?: string;
  }>;
}

/** 扫描/筛选参数 */
export interface ExtractFilters {
  type?: string;
  priority?: string;
  version?: string;
  id?: string;
}


/** 单个 @flow 步骤 */
export interface FlowStep {
  flow: string;
  step: number;
  input?: string;
  output?: string;
  next?: string;
  /** 来自 TaskAnnotation 的函数信息 */
  functionName: string;
  functionSignature?: string;
  sourceFile: string;
  sourceLine: number;
  task: string;
}

/** 完整的业务流转链路 */
export interface FlowChain {
  name: string;
  steps: FlowStep[];
  complete: boolean;
}

/** @flow 校验问题 */
export interface FlowValidationIssue {
  flow: string;
  step?: number;
  level: 'error' | 'warn';
  msg: string;
  loc: string;
}

/** @flow 校验结果 */
export interface FlowValidationResult {
  flows: FlowChain[];
  issues: FlowValidationIssue[];
  passed: boolean;
}
