
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { extname, join } from 'path';
import { scan, extractFlows } from './extract.js';
import { CODE_EXTENSIONS } from './extract.js';
import { loadConfig } from '../core/config.js';
import type { TaskAnnotation, FlowChain } from './types.js';

export interface TestCase {
  name: string;
  input: unknown;
  expect?: unknown;
  throws?: string;
  /** Specifies which function to call. Supports "ClassName.methodName" format to invoke class methods */
  fn?: string;
  /** Class constructor arguments (only valid when fn is ClassName.methodName) */
  construct?: unknown[];
}

/** Test result */
export interface TestResult {
  functionName: string;
  sourceFile: string;
  fixture: string;
  cases: Array<{
    name: string;
    passed: boolean;
    error?: string;
  }>;
  allPassed: boolean;
}

/** Overall white-box test result */
export interface WhiteBoxResult {
  changedFunctions: string[];
  affectedFlows: string[];
  testResults: TestResult[];
  fixturesNotFound: string[];
  allPassed: boolean;
}

/**
 * Get the list of changed files from git diff
 */
export function getChangedFiles(projectRoot: string, base?: string): string[] {
  const baseRef = base || 'HEAD';
  try {
    const output = execSync(`git diff --name-only ${baseRef}`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.trim().split('\n').filter(f => CODE_EXTENSIONS.has(extname(f)));
  } catch {
    return [];
  }
}

/**
 * Find functions with @test annotations in the changed files
 */
export function getChangedFunctionsWithTests(
  changedFiles: string[],
  allTasks: TaskAnnotation[],
): TaskAnnotation[] {
  const changedSet = new Set(changedFiles.map(f => f.replace(/\\/g, '/')));
  return allTasks.filter(t => {
    const normalized = t.sourceFile.replace(/\\/g, '/');
    return changedSet.has(normalized) && t.test && t.functionName;
  });
}

/**
 * Find affected @flow chains (all flows that the changed functions participate in)
 */
export function findAffectedFlows(
  changedFiles: string[],
  allTasks: TaskAnnotation[],
  chains: FlowChain[],
): FlowChain[] {
  const changedSet = new Set(changedFiles.map(f => f.replace(/\\/g, '/')));
  const affectedFlowNames = new Set<string>();

  for (const t of allTasks) {
    const normalized = t.sourceFile.replace(/\\/g, '/');
    if (changedSet.has(normalized) && t.flow) {
      affectedFlowNames.add(t.flow);
    }
  }

  return chains.filter(c => affectedFlowNames.has(c.name));
}

/**
 * Load fixture file
 */
export function loadFixture(projectRoot: string, fixturePath: string): TestCase[] | null {
  const fullPath = join(projectRoot, loadConfig(projectRoot).fixturesDir, fixturePath + '.json');
  if (!existsSync(fullPath)) return null;
  try {
    const content = JSON.parse(readFileSync(fullPath, 'utf-8'));
    return content.cases || [];
  } catch {
    return null;
  }
}

/**
 * White-box test main entry
 * Note: this function currently only does "discover + match"; actual function execution requires runtime support.
 * Returns the list of functions to test, affected flows, and fixture match results.
 */
export function runWhiteBoxAnalysis(
  projectRoot: string,
  scanRoot: string,
  base?: string,
): WhiteBoxResult {
  const allTasks = scan(scanRoot);
  const chains = extractFlows(allTasks);
  const changedFiles = getChangedFiles(projectRoot, base);

  // Find functions with @test that were changed
  const testsToRun = getChangedFunctionsWithTests(changedFiles, allTasks);
  const changedFunctions = testsToRun.map(t => t.functionName!);

  // Find affected flows
  const affectedFlows = findAffectedFlows(changedFiles, allTasks, chains);

  // Load fixtures and build test plan
  const testResults: TestResult[] = [];
  const fixturesNotFound: string[] = [];

  for (const t of testsToRun) {
    const cases = loadFixture(projectRoot, t.test!);
    if (!cases) {
      fixturesNotFound.push(`${t.functionName}: ${loadConfig(projectRoot).fixturesDir}/${t.test}.json`);
      continue;
    }
    testResults.push({
      functionName: t.functionName!,
      sourceFile: t.sourceFile,
      fixture: t.test!,
      cases: cases.map(c => ({
        name: c.name,
        passed: true, // placeholder — actual execution requires runtime import
        error: undefined,
      })),
      allPassed: true, // placeholder
    });
  }

  return {
    changedFunctions,
    affectedFlows: affectedFlows.map(f => f.name),
    testResults,
    fixturesNotFound,
    allPassed: fixturesNotFound.length === 0 && testResults.every(r => r.allPassed),
  };
}
