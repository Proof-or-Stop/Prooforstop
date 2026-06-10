
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
  /** Source file (relative to scan root) */
  sourceFile: string;
  /** Starting line number of the comment block */
  sourceLine: number;
  /** Name of the function/method adjacent to the comment (if any) */
  functionName?: string;
  /** Function signature (if any), e.g. `async function foo(bar: string): Promise<void>` */
  functionSignature?: string;
  /** @flow chain name */
  flow?: string;
  /** @flow step number */
  step?: number;
  /** @flow input description */
  input?: string;
  /** @flow output description */
  output?: string;
  /** @flow next-step function name */
  next?: string;
  /** @test fixture path */
  test?: string;
}

/** Validation issue */
export interface ValidationIssue {
  loc: string;
  level: 'error' | 'warn';
  msg: string;
}

/** Validation result */
export interface ValidationResult {
  filesScanned: number;
  tasksFound: number;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  filesWithoutTask: string[];
  passed: boolean;
}

/** Coverage check item */
export interface CoverageItem {
  checklistId: string;
  title: string;
  covered: boolean;
  /** List of source code locations covering this checklist item */
  locations: Array<{ file: string; line: number; functionName?: string }>;
}

/** Coverage result */
export interface CoverageResult {
  storyId: string;
  total: number;
  covered: number;
  missing: number;
  items: CoverageItem[];
  passed: boolean;
}

/** Location result */
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

/** Scan/filter parameters */
export interface ExtractFilters {
  type?: string;
  priority?: string;
  version?: string;
  id?: string;
}


/** A single @flow step */
export interface FlowStep {
  flow: string;
  step: number;
  input?: string;
  output?: string;
  next?: string;
  /** Function information from TaskAnnotation */
  functionName: string;
  functionSignature?: string;
  sourceFile: string;
  sourceLine: number;
  task: string;
}

/** Complete business flow chain */
export interface FlowChain {
  name: string;
  steps: FlowStep[];
  complete: boolean;
}

/** @flow Validation issue */
export interface FlowValidationIssue {
  flow: string;
  step?: number;
  level: 'error' | 'warn';
  msg: string;
  loc: string;
}

/** @flow Validation result */
export interface FlowValidationResult {
  flows: FlowChain[];
  issues: FlowValidationIssue[];
  passed: boolean;
}
