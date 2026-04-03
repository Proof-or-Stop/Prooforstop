

import { pathToFileURL } from 'url';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { loadConfig } from '../config.js';
import type { TestCase } from './test-runner.js';

/** 执行单个 case 的结果 */
export interface CaseExecutionResult {
  name: string;
  passed: boolean;
  actual?: unknown;
  expected?: unknown;
  error?: string;
  durationMs: number;
}

/** 执行一个函数所有 case 的结果 */
export interface FunctionExecutionResult {
  functionName: string;
  sourceFile: string;
  cases: CaseExecutionResult[];
  allPassed: boolean;
  totalDurationMs: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

export function resolvePlaceholders(value: unknown, projectRoot: string): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/\$SCAN_ROOT/g, join(projectRoot, loadConfig(projectRoot).scanRoot))
      .replace(/\$PROJECT_ROOT/g, projectRoot);
  }
  if (Array.isArray(value)) {
    return value.map(v => resolvePlaceholders(v, projectRoot));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolvePlaceholders(v, projectRoot);
    }
    return out;
  }
  return value;
}

export function compareResult(actual: unknown, expected: unknown): { match: boolean; diff?: string } {
  // Null/undefined check
  if (expected === null || expected === undefined) {
    if (actual === expected) return { match: true };
    return { match: false, diff: `expected ${expected}, got ${JSON.stringify(actual)}` };
  }

  // Primitive comparison
  if (typeof expected !== 'object') {
    if (actual === expected) return { match: true };
    return { match: false, diff: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` };
  }

  // Array comparison
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return { match: false, diff: `expected array, got ${typeof actual}` };
    }
    if (actual.length !== expected.length) {
      return { match: false, diff: `expected array length ${expected.length}, got ${actual.length}` };
    }
    for (let i = 0; i < expected.length; i++) {
      const sub = compareResult(actual[i], expected[i]);
      if (!sub.match) {
        return { match: false, diff: `[${i}]: ${sub.diff}` };
      }
    }
    return { match: true };
  }

  // Object partial match: every key in expected must match in actual
  if (typeof actual !== 'object' || actual === null) {
    const hint = typeof actual === 'string'
      ? '。handler 返回 string 但 expect 是 object，如需匹配字符串内容请改用 expect: { pattern: "regex" }'
      : '';
    return { match: false, diff: `expected object, got ${typeof actual}${hint}` };
  }
  const exp = expected as Record<string, unknown>;
  const act = actual as Record<string, unknown>;
  for (const key of Object.keys(exp)) {
    if (!(key in act)) {
      return { match: false, diff: `missing key "${key}"` };
    }
    const sub = compareResult(act[key], exp[key]);
    if (!sub.match) {
      return { match: false, diff: `${key}: ${sub.diff}` };
    }
  }
  return { match: true };
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Test timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export function createMockStore(): Record<string, (...args: any[]) => any> {
  const data: Record<string, any> = {};
  return {
    readStory: (id: string) => data[`story:${id}`] || { storyId: id, title: 'mock', phase: 'DEV' },
    writeStory: (id: string, d: any) => { data[`story:${id}`] = d; },
    readChecklist: (id: string) => data[`cl:${id}`] || { items: [] },
    writeChecklist: (id: string, d: any) => { data[`cl:${id}`] = d; },
    readBugs: (id: string) => data[`bugs:${id}`] || { bugs: [] },
    writeBugs: (id: string, d: any) => { data[`bugs:${id}`] = d; },
    readTestEvidence: (id: string) => data[`te:${id}`] || { tests: [], environment: null },
    writeTestEvidence: (id: string, d: any) => { data[`te:${id}`] = d; },
    storyExists: (id: string) => !!data[`story:${id}`],
    listStoryIds: () => Object.keys(data).filter(k => k.startsWith('story:')).map(k => k.slice(6)),
  };
}

export function createMockDependencies(): Record<string, unknown> {
  return {
    store: createMockStore(),
    projectRoot: process.cwd(),
  };
}

export async function importAndExecute(
  projectRoot: string,
  sourceFile: string,
  functionName: string,
  input: unknown,
  constructArgs?: unknown[],
): Promise<unknown> {
  // Convert .ts source path to compiled .js path
  const normalizedSource = sourceFile.replace(/\\/g, '/');
  const jsFile = normalizedSource.replace(/\.tsx?$/, '.js');
  const config = loadConfig(projectRoot);
  // outDir 替换 scanRoot 前缀：src/game-logic.ts → dist/game-logic.js
  // 没配 outDir 时直接用原路径：src/game-logic.ts → src/game-logic.js
  let resolvedJs = jsFile;
  if (config.outDir && config.outDir !== config.scanRoot) {
    const scanPrefix = config.scanRoot.replace(/\\/g, '/').replace(/\/$/, '') + '/';
    if (resolvedJs.startsWith(scanPrefix)) {
      resolvedJs = config.outDir.replace(/\/$/, '') + '/' + resolvedJs.slice(scanPrefix.length);
    }
  }
  const fullPath = join(projectRoot, resolvedJs);

  if (!existsSync(fullPath)) {
    throw new Error(`Compiled file not found: ${fullPath}. Run npm run build first.`);
  }

  const moduleUrl = pathToFileURL(fullPath).href;
  // Use dynamic import with cache busting
  const mod = await import(`${moduleUrl}?t=${Date.now()}`);

  let fn: Function | undefined;

  // 支持 "ClassName.methodName" 格式：实例化类后调用方法
  if (functionName.includes('.')) {
    const [className, methodName] = functionName.split('.');
    const cls = mod[className] || mod.default?.[className];
    if (typeof cls === 'function') {
      // 尝试作为类实例化
      try {
        const instance = new cls(...(constructArgs || []));
        fn = typeof instance[methodName] === 'function'
          ? instance[methodName].bind(instance)
          : undefined;
      } catch {
        // 不是构造函数，当作命名空间/静态方法
        if (typeof cls[methodName] === 'function') {
          fn = cls[methodName].bind(cls);
        }
      }
    } else if (cls && typeof cls === 'object' && typeof cls[methodName] === 'function') {
      // 普通对象（命名空间）
      fn = cls[methodName].bind(cls);
    }
    if (!fn) {
      throw new Error(`SKIP: "${functionName}" not found in ${jsFile}. Class "${className}" available: ${cls ? Object.getOwnPropertyNames(cls.prototype || cls).join(', ') : 'not exported'}`);
    }
  } else {
    fn = mod[functionName] || mod.default?.[functionName];
    if (typeof fn !== 'function') {
      throw new Error(`SKIP: Function "${functionName}" is not a direct export in ${jsFile} (available: ${Object.keys(mod).join(', ')})`);
    }
  }

  // Call with input — if input is an array, spread as arguments; if object, pass as single arg
  const args = Array.isArray(input) ? input : [input];
  const result = fn(...args);

  // Handle async results
  if (result && typeof result.then === 'function') {
    return await withTimeout(result, DEFAULT_TIMEOUT_MS);
  }
  return result;
}

export async function executeTestCases(
  projectRoot: string,
  sourceFile: string,
  functionName: string,
  cases: TestCase[],
): Promise<FunctionExecutionResult> {
  const results: CaseExecutionResult[] = [];
  const startTotal = Date.now();

  for (const tc of cases) {
    // fn 字段路由到指定函数（前置 case 用 fn 指向其他函数）
    const targetFn = tc.fn || functionName;
    // Resolve path placeholders in input
    const resolvedInput = resolvePlaceholders(tc.input, projectRoot);
    const startCase = Date.now();
    try {
      if (tc.throws) {
        // Expect an error
        let threw = false;
        let thrownError = '';
        try {
          await importAndExecute(projectRoot, sourceFile, targetFn, resolvedInput, tc.construct);
        } catch (e: any) {
          threw = true;
          thrownError = e?.message || String(e);
        }
        const durationMs = Date.now() - startCase;
        if (threw && thrownError.includes(tc.throws)) {
          results.push({ name: tc.name, passed: true, durationMs });
        } else if (threw) {
          results.push({
            name: tc.name,
            passed: false,
            error: `Expected error containing "${tc.throws}", got: "${thrownError}"`,
            durationMs,
          });
        } else {
          results.push({
            name: tc.name,
            passed: false,
            error: `Expected to throw "${tc.throws}" but did not throw`,
            durationMs,
          });
        }
      } else {
        // Expect a result
        const actual = await importAndExecute(projectRoot, sourceFile, targetFn, resolvedInput, tc.construct);
        const durationMs = Date.now() - startCase;
        if (tc.expect !== undefined) {
          const exp = tc.expect as Record<string, unknown>;
          if (exp && typeof exp === 'object' && 'pattern' in exp) {
            const regex = new RegExp(exp.pattern as string);
            const testStr = typeof actual === 'string' ? actual : JSON.stringify(actual);
            if (regex.test(testStr)) {
              results.push({ name: tc.name, passed: true, actual, expected: tc.expect, durationMs });
            } else {
              results.push({ name: tc.name, passed: false, actual, expected: tc.expect, error: `Pattern /${exp.pattern}/ did not match`, durationMs });
            }
          } else {
            const cmp = compareResult(actual, tc.expect);
            if (cmp.match) {
              results.push({ name: tc.name, passed: true, actual, expected: tc.expect, durationMs });
            } else {
              results.push({
                name: tc.name,
                passed: false,
                actual,
                expected: tc.expect,
                error: cmp.diff,
                durationMs,
              });
            }
          }
        } else {
          // No expect and no throws — just check it doesn't crash
          results.push({ name: tc.name, passed: true, actual, durationMs });
        }
      }
    } catch (e: any) {
      results.push({
        name: tc.name,
        passed: false,
        error: e?.message || String(e),
        durationMs: Date.now() - startCase,
      });
    }
  }

  return {
    functionName,
    sourceFile,
    cases: results,
    allPassed: results.every(r => r.passed),
    totalDurationMs: Date.now() - startTotal,
  };
}
