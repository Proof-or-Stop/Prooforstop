/**
 * Python 白盒测试执行器
 *
 * 生成临时 Python 脚本 → import 目标模块 → 调用函数 → stdout 输出 JSON 结果
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { loadConfig } from '../config.js';
import { compareResult } from './test-executor.js';
import type { TestCase } from './test-runner.js';

export interface PythonExecutionResult {
  functionName: string;
  sourceFile: string;
  cases: Array<{
    name: string;
    passed: boolean;
    actual?: unknown;
    expected?: unknown;
    error?: string;
    durationMs: number;
  }>;
  allPassed: boolean;
  totalDurationMs: number;
}

/** 生成调用 Python 函数的临时脚本 */
function generatePythonScript(
  sourceFile: string,
  functionName: string,
  input: unknown,
  scanRoot: string,
  constructArgs?: unknown[],
): string {
  // sourceFile: "utils/math.py" → module: "utils.math"
  const modulePath = sourceFile.replace(/\.py$/, '').replace(/[/\\]/g, '.');
  const inputJson = JSON.stringify(input);
  const constructJson = JSON.stringify(constructArgs || []);

  // 支持 "ClassName.methodName" 格式
  const hasDot = functionName.includes('.');
  const [className, methodName] = hasDot ? functionName.split('.') : ['', functionName];

  const resolveTarget = hasDot
    ? `
cls = getattr(mod, '${className}', None)
if cls is None:
    print(json.dumps({"error": "Class ${className} not found in ${modulePath}"}))
    sys.exit(0)
construct_args = json.loads('${constructJson.replace(/'/g, "\\'")}')
try:
    instance = cls(*construct_args)
    fn = getattr(instance, '${methodName}', None)
except TypeError:
    # 不是类，当作命名空间
    fn = getattr(cls, '${methodName}', None)
if fn is None:
    print(json.dumps({"error": "Method ${methodName} not found on ${className}"}))
    sys.exit(0)
`
    : `
fn = getattr(mod, '${functionName}', None)
if fn is None:
    print(json.dumps({"error": "Function ${functionName} not found in ${modulePath}"}))
    sys.exit(0)
`;

  return `
import sys, json, time, importlib
sys.path.insert(0, '${scanRoot.replace(/\\/g, '/')}')

mod = importlib.import_module('${modulePath}')
${resolveTarget}
input_data = json.loads('${inputJson.replace(/'/g, "\\'")}')
start = time.time()
try:
    if isinstance(input_data, list):
        result = fn(*input_data)
    elif isinstance(input_data, dict):
        result = fn(**input_data)
    else:
        result = fn(input_data)

    # Serialize result
    try:
        result_json = json.loads(json.dumps(result, default=str))
    except:
        result_json = str(result)

    elapsed = (time.time() - start) * 1000
    print(json.dumps({"ok": True, "result": result_json, "durationMs": elapsed}))
except Exception as e:
    elapsed = (time.time() - start) * 1000
    print(json.dumps({"ok": False, "error": str(e), "durationMs": elapsed}))
`;
}

/** 执行 Python 函数并返回结果 */
export function executePythonFunction(
  projectRoot: string,
  sourceFile: string,
  functionName: string,
  input: unknown,
  constructArgs?: unknown[],
): { ok: boolean; result?: unknown; error?: string; durationMs: number } {
  const absRoot = resolve(projectRoot);
  const config = loadConfig(absRoot);
  const scanRoot = join(absRoot, config.scanRoot);
  const script = generatePythonScript(sourceFile, functionName, input, scanRoot, constructArgs);
  const tmpScript = join(absRoot, '.koala-tmp-test.py');

  try {
    writeFileSync(tmpScript, script);
    const output = execSync(`python "${tmpScript}"`, {
      encoding: 'utf-8',
      timeout: 10000,
      cwd: projectRoot,
    });
    return JSON.parse(output.trim());
  } catch (e: any) {
    return { ok: false, error: e.message, durationMs: 0 };
  } finally {
    try { unlinkSync(tmpScript); } catch {}
  }
}

/** 执行 Python 函数的所有 fixture cases */
export function executePythonTestCases(
  projectRoot: string,
  sourceFile: string,
  functionName: string,
  cases: TestCase[],
): PythonExecutionResult {
  const results: PythonExecutionResult['cases'] = [];
  const startTotal = Date.now();

  for (const tc of cases) {
    const targetFn = tc.fn || functionName;
    const startCase = Date.now();

    if (tc.throws) {
      const r = executePythonFunction(projectRoot, sourceFile, targetFn, tc.input, tc.construct);
      const durationMs = Date.now() - startCase;
      if (!r.ok && r.error?.includes(tc.throws)) {
        results.push({ name: tc.name, passed: true, durationMs });
      } else if (!r.ok) {
        results.push({ name: tc.name, passed: false, error: `Expected error containing "${tc.throws}", got: "${r.error}"`, durationMs });
      } else {
        results.push({ name: tc.name, passed: false, error: `Expected to throw "${tc.throws}" but did not throw`, durationMs });
      }
    } else {
      const r = executePythonFunction(projectRoot, sourceFile, targetFn, tc.input, tc.construct);
      const durationMs = Date.now() - startCase;
      if (!r.ok) {
        results.push({ name: tc.name, passed: false, error: r.error, durationMs });
        continue;
      }
      if (tc.expect !== undefined) {
        const exp = tc.expect as Record<string, unknown>;
        if (exp && typeof exp === 'object' && 'pattern' in exp) {
          const regex = new RegExp(exp.pattern as string);
          const testStr = typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
          if (regex.test(testStr)) {
            results.push({ name: tc.name, passed: true, actual: r.result, expected: tc.expect, durationMs });
          } else {
            results.push({ name: tc.name, passed: false, actual: r.result, expected: tc.expect, error: `Pattern /${exp.pattern}/ did not match`, durationMs });
          }
        } else {
          const cmp = compareResult(r.result, tc.expect);
          if (cmp.match) {
            results.push({ name: tc.name, passed: true, actual: r.result, expected: tc.expect, durationMs });
          } else {
            results.push({ name: tc.name, passed: false, actual: r.result, expected: tc.expect, error: cmp.diff, durationMs });
          }
        }
      } else {
        results.push({ name: tc.name, passed: true, actual: r.result, durationMs });
      }
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
