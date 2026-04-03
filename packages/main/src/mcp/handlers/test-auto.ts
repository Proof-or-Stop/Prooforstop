import { execSync } from 'child_process';
import type { HandlerContext } from './context.js';
import { scan, extractFlows } from '../../tasks/extract.js';
import { loadFixture } from '../../tasks/test-runner.js';
import type { FunctionExecutionResult, CaseExecutionResult } from '../../tasks/test-executor.js';
import { compareResult, withTimeout, importAndExecute, resolvePlaceholders } from '../../tasks/test-executor.js';
import { generateMissingFixtures } from '../../tasks/test-fixture-gen.js';
import { runFlowE2E } from '../../tasks/test-flow-e2e.js';
import type { FlowE2EResult } from '../../tasks/test-flow-e2e.js';
import { parseDiffFunctions, checkDrift } from '../../tasks/drift-check.js';
import type { DriftResult } from '../../tasks/drift-check.js';
import { validateFixtureCase } from './fixture.js';
import type { TestCase } from '../../tasks/test-runner.js';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { StoryStore } from '../../story/store.js';
import { createToolHandlers } from '../tools.js';
import { loadConfig } from '../../config.js';
import { executeBrowserCases, type BrowserStep, type BrowserCaseResult } from '../../tasks/browser-executor.js';
import { executeCliCases, type CliCaseResult } from '../../tasks/cli-executor.js';
import { executePythonTestCases } from '../../tasks/python-executor.js';
import { readFileSync } from 'fs';

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * 通过 handlers 或 importAndExecute 执行 fixture cases
 * handler 函数 → 直接调用（同一个 ctx，共享 store）
 * 纯函数 → fallback importAndExecute
 */
/** 解析 input 中的 $prev.xxx 引用 */
function resolveContextRefs(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$prev\.(\w+)/g, (_, key) => String(context[key] ?? ''));
  }
  if (Array.isArray(value)) {
    return value.map(v => resolveContextRefs(v, context));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveContextRefs(v, context);
    }
    return out;
  }
  return value;
}

/** 从 handler 返回值提取字段到 context */
function extractToContext(result: unknown, context: Record<string, unknown>): void {
  if (typeof result === 'string') {
    // 提取常见 ID 模式
    const storyMatch = result.match(/Story\s+(B-[a-f0-9]+)/i);
    if (storyMatch) context.storyId = storyMatch[1];
    const bugMatch = result.match(/Bug\s+(BUG-\d+)/i);
    if (bugMatch) context.bugId = bugMatch[1];
    const testMatch = result.match(/evidence\s+(TE-\d+)/i);
    if (testMatch) context.testId = testMatch[1];
    const phaseMatch = result.match(/advanced to\s+(\w+)/);
    if (phaseMatch) context.phase = phaseMatch[1];
    const itemMatch = result.match(/(CHK-\d+)/);
    if (itemMatch) context.itemId = itemMatch[1];
  } else if (result && typeof result === 'object') {
    Object.assign(context, result);
  }
}

async function executeCases(
  handlers: Record<string, Function>,
  projectRoot: string,
  sourceFile: string,
  functionName: string,
  cases: TestCase[],
): Promise<FunctionExecutionResult> {
  const results: CaseExecutionResult[] = [];
  const startTotal = Date.now();
  const context: Record<string, unknown> = {}; // case 间共享 context

  for (const tc of cases) {
    const targetFn = tc.fn || functionName;
    const targetHandler = handlers[targetFn];
    // 解析 input 中的 $prev.xxx 引用和路径占位符
    const resolvedInput = resolvePlaceholders(resolveContextRefs(tc.input, context), projectRoot);
    const startCase = Date.now();

    // 如果 handler 里没有，fallback 到 importAndExecute
    if (typeof targetHandler !== 'function') {
      try {
        const actual = await importAndExecute(projectRoot, sourceFile, targetFn, resolvedInput, tc.construct);
        extractToContext(actual, context);
        const durationMs = Date.now() - startCase;
        if (tc.throws) {
          results.push({ name: tc.name, passed: false, error: `Expected to throw "${tc.throws}" but did not throw`, durationMs });
        } else if (tc.expect !== undefined) {
          const r = matchExpect(actual, tc.expect);
          results.push({ name: tc.name, passed: r.passed, actual, expected: tc.expect, error: r.error, durationMs });
        } else {
          results.push({ name: tc.name, passed: true, actual, durationMs });
        }
      } catch (e: any) {
        const durationMs = Date.now() - startCase;
        if (tc.throws && e.message?.includes(tc.throws)) {
          results.push({ name: tc.name, passed: true, durationMs });
        } else if (e.message?.startsWith('SKIP:')) {
          results.push({ name: tc.name, passed: false, error: e.message, durationMs });
        } else {
          results.push({ name: tc.name, passed: false, error: e?.message || String(e), durationMs });
        }
      }
      continue;
    }

    // handler 直接调用
    try {
      if (tc.throws) {
        let threw = false;
        let thrownError = '';
        try {
          const r = targetHandler(resolvedInput);
          if (r && typeof r.then === 'function') await withTimeout(r, DEFAULT_TIMEOUT_MS);
        } catch (e: any) {
          threw = true;
          thrownError = e?.message || String(e);
        }
        const durationMs = Date.now() - startCase;
        if (threw && thrownError.includes(tc.throws)) {
          results.push({ name: tc.name, passed: true, durationMs });
        } else if (threw) {
          results.push({ name: tc.name, passed: false, error: `Expected error containing "${tc.throws}", got: "${thrownError}"`, durationMs });
        } else {
          results.push({ name: tc.name, passed: false, error: `Expected to throw "${tc.throws}" but did not throw`, durationMs });
        }
      } else {
        let actual = targetHandler(resolvedInput);
        if (actual && typeof actual.then === 'function') actual = await withTimeout(actual, DEFAULT_TIMEOUT_MS);
        extractToContext(actual, context);
        const durationMs = Date.now() - startCase;
        if (tc.expect !== undefined) {
          const r = matchExpect(actual, tc.expect);
          results.push({ name: tc.name, passed: r.passed, actual, expected: tc.expect, error: r.error, durationMs });
        } else {
          results.push({ name: tc.name, passed: true, actual, durationMs });
        }
      }
    } catch (e: any) {
      results.push({ name: tc.name, passed: false, error: e?.message || String(e), durationMs: Date.now() - startCase });
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

function matchExpect(actual: unknown, expect: unknown): { passed: boolean; error?: string } {
  const exp = expect as Record<string, unknown>;
  if (exp && typeof exp === 'object' && 'pattern' in exp) {
    const regex = new RegExp(exp.pattern as string);
    const testStr = typeof actual === 'string' ? actual : JSON.stringify(actual);
    if (regex.test(testStr)) return { passed: true };
    return { passed: false, error: `Pattern /${exp.pattern}/ did not match` };
  }
  const cmp = compareResult(actual, expect);
  return { passed: cmp.match, error: cmp.diff };
}

export function createTestAutoHandlers(ctx: HandlerContext) {
  const { store, root, scanRoot } = ctx;
  const progress = ctx.log || (() => {});

  return {
    async test_auto(args: { storyId?: string; base?: string; full?: boolean }): Promise<string> {
      const warnings: string[] = [];
      progress(`test_auto start: full=${!!args.full}, storyId=${args.storyId || 'none'}`);

      // 每次 test_auto 创建临时 store 隔离测试数据
      const tmpDir = mkdtempSync(join(tmpdir(), 'koala-test-'));
      mkdirSync(join(tmpDir, 'docs', 'story', 'actives'), { recursive: true });
      mkdirSync(join(tmpDir, 'docs', 'requirements'), { recursive: true });
      const testStore = new StoryStore(tmpDir);

      // 加载 handlers：临时 store 隔离数据，scanRoot 用真实的
      // createToolHandlers 内部用 root 算 scanRoot，所以传真实 root
      // 但替换 store 为临时的
      let handlers: Record<string, Function>;
      const config = loadConfig(root);
      if (config.testRuntime) {
        try {
          const runtimePath = join(root, config.testRuntime);
          const mod = await import(pathToFileURL(runtimePath).href);
          if (typeof mod.createTestHandlers === 'function') {
            handlers = mod.createTestHandlers(testStore, root);
          } else if (typeof mod.createToolHandlers === 'function') {
            handlers = mod.createToolHandlers(testStore, root);
          } else {
            handlers = mod.default || mod;
          }
        } catch {
          handlers = createToolHandlers(testStore, root) as Record<string, Function>;
        }
      } else {
        handlers = createToolHandlers(testStore, root) as Record<string, Function>;
      }

      // Step 1: Generate missing fixtures
      const genResult = generateMissingFixtures(root, scanRoot);

      // Step 2: Find functions to test
      const allTasks = scan(scanRoot);
      const tasksWithTests = allTasks.filter(t => t.test && t.functionName && t.functionName !== 'test_auto');
      const tasksWithoutTests = allTasks.filter(t => t.functionName && !t.test);
      if (tasksWithoutTests.length > 0) {
        warnings.push(`${tasksWithoutTests.length} 个函数缺少 @test 注释`);
      }

      // 检测多函数共享 fixture 但 case 无 fn
      const fixtureUsage = new Map<string, string[]>();
      for (const t of tasksWithTests) {
        const fns = fixtureUsage.get(t.test!) || [];
        fns.push(t.functionName!);
        fixtureUsage.set(t.test!, fns);
      }
      for (const [fixture, fns] of fixtureUsage) {
        if (fns.length > 1) {
          const cases = loadFixture(root, fixture);
          if (cases) {
            const noFn = cases.filter(c => !c.fn).length;
            if (noFn > 0) {
              warnings.push(`${fns.length} 个函数共享 fixture ${fixture}，但 ${noFn} 个 case 缺少 fn 字段（会导致笛卡尔积）`);
            }
          }
        }
      }

      // fixture 格式预扫
      const nonStandardWarned = new Set<string>();

      // Step 3: Execute fixture cases
      const executionResults: FunctionExecutionResult[] = [];
      const errors: string[] = [];

      for (const t of tasksWithTests) {
        const cases = loadFixture(root, t.test!);
        if (!cases || cases.length === 0) {
          warnings.push(`fixture 为空或不存在: ${t.test}`);
          continue;
        }

        if (!nonStandardWarned.has(t.test!)) {
          for (const c of cases) {
            const errs = validateFixtureCase(c as unknown as Record<string, unknown>);
            if (errs.length > 0) {
              warnings.push(`fixture ${t.test} case "${c.name}" 格式问题: ${errs.join('; ')}`);
              nonStandardWarned.add(t.test!);
              break;
            }
          }
        }

        try {
          if (config.language === 'python') {
            const result = executePythonTestCases(root, t.sourceFile, t.functionName!, cases);
            progress(`${t.functionName}: ${result.cases.filter(c => c.passed).length}/${result.cases.length} passed`);
            executionResults.push(result);
          } else {
            const result = await executeCases(handlers, root, t.sourceFile, t.functionName!, cases);
            const allSkipped = result.cases.every(c => c.error?.startsWith('SKIP:'));
            if (allSkipped && result.cases.length > 0) {
              warnings.push(`${t.functionName}: 非直接导出且不在 handlers 中，跳过`);
            }
            progress(`${t.functionName}: ${result.cases.filter(c => c.passed).length}/${result.cases.length} passed`);
            executionResults.push(result);
          }
        } catch (e: any) {
          errors.push(`${t.functionName}: ${e.message}`);
        }
      }

      // Step 4: Flow E2E
      const flowE2EResults: FlowE2EResult[] = [];
      const chains = extractFlows(allTasks);
      if (args.full) {
        for (const chain of chains) {
          flowE2EResults.push(await runFlowE2E(chain.name, scanRoot));
        }
      } else {
        const testedFunctions = new Set(executionResults.map(r => r.functionName));
        for (const chain of chains) {
          if (chain.steps.some(s => testedFunctions.has(s.functionName))) {
            flowE2EResults.push(await runFlowE2E(chain.name, scanRoot));
          }
        }
      }
      if (chains.length > 0 && flowE2EResults.length === 0 && !args.full) {
        warnings.push(`${chains.length} 条 flow 未被触发，用 full=true 全量跑`);
      }

      // Step 4.5: Browser tests
      let browserResults: BrowserCaseResult[] = [];
      let browserTrace: string[] = [];
      if (config.browser?.devCommand) {
        // 收集所有 browser fixture cases
        const browserCases: Array<{ name: string; steps: BrowserStep[] }> = [];
        for (const t of tasksWithTests) {
          const cases = loadFixture(root, t.test!);
          if (!cases) continue;
          for (const c of cases as any[]) {
            if (c.browser && c.steps) {
              browserCases.push({ name: c.name, steps: c.steps });
            }
          }
        }
        // 也扫描带 browser 的独立 fixture 文件
        const allFixtureFiles = new Set(tasksWithTests.map(t => t.test!));
        // 检查 fixturesDir 下所有 JSON
        const fixturesDir = join(root, config.fixturesDir);
        if (existsSync(fixturesDir)) {
          const { readdirSync } = await import('fs');
          const scanFixtures = (dir: string, prefix = '') => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              if (entry.isDirectory()) {
                scanFixtures(join(dir, entry.name), prefix + entry.name + '/');
              } else if (entry.name.endsWith('.json')) {
                const fixtureName = prefix + entry.name.replace('.json', '');
                if (!allFixtureFiles.has(fixtureName)) {
                  try {
                    const content = JSON.parse(readFileSync(join(dir, entry.name), 'utf-8'));
                    for (const c of content.cases || []) {
                      if (c.browser && c.steps) {
                        browserCases.push({ name: c.name, steps: c.steps });
                      }
                    }
                  } catch { /* ignore */ }
                }
              }
            }
          };
          scanFixtures(fixturesDir);
        }

        if (browserCases.length > 0) {
          progress(`browser test: ${browserCases.length} cases starting...`);
          try {
            const browserResult = await executeBrowserCases({
              devCommand: config.browser.devCommand,
              projectRoot: root,
              httpPort: config.browser.wsPort,
              onProgress: ctx.log || (() => {}),
            }, browserCases);
            browserResults = browserResult.cases;
            browserTrace = browserResult.coveredFunctions;
            progress(`browser test: ${browserResults.filter(r => r.passed).length}/${browserResults.length} passed, trace: ${browserTrace.length} functions`);
          } catch (e: any) {
            progress(`browser test failed: ${e.message}`);
            warnings.push(`Browser tests failed: ${e.message}`);
          }
        }
      }

      // Step 4.7: CLI tests
      let cliResults: CliCaseResult[] = [];
      {
        // 扫描所有 fixture 中带 cli: true 的 case
        const cliCases: Array<{ name: string; command: string; cwd: string; steps: any[]; timeoutMs?: number; env?: Record<string, string> }> = [];
        const fixturesDir = join(root, config.fixturesDir);
        if (existsSync(fixturesDir)) {
          const { readdirSync } = await import('fs');
          const scanCliFixtures = (dir: string) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              if (entry.isDirectory()) {
                scanCliFixtures(join(dir, entry.name));
              } else if (entry.name.endsWith('.json')) {
                try {
                  const content = JSON.parse(readFileSync(join(dir, entry.name), 'utf-8'));
                  for (const c of content.cases || []) {
                    if (c.cli && c.steps && c.command) {
                      const cwd = c.cwd ? resolvePlaceholders(c.cwd, root) as string : root;
                      cliCases.push({ name: c.name, command: c.command, cwd, steps: c.steps, timeoutMs: c.timeoutMs, env: c.env });
                    }
                  }
                } catch { /* ignore */ }
              }
            }
          };
          scanCliFixtures(fixturesDir);
        }

        if (cliCases.length > 0) progress(`cli test: ${cliCases.length} cases starting...`);
        for (const c of cliCases) {
          try {
            const cliResult = await executeCliCases(
              { command: c.command, cwd: c.cwd, timeoutMs: c.timeoutMs, env: c.env },
              [{ name: c.name, steps: c.steps }],
            );
            cliResults.push(...cliResult.cases);
            progress(`cli "${c.name}": ${cliResult.cases[0]?.passed ? 'PASS' : 'FAIL'}`);
          } catch (e: any) {
            progress(`cli "${c.name}" failed: ${e.message}`);
            warnings.push(`CLI test "${c.name}" failed: ${e.message}`);
          }
        }
      }

      // Step 4.8: Drift check（worktree 里用 main 作为 base，只比 story 分支的改动）
      let driftBase = args.base || 'HEAD~1';
      if (!args.base) {
        try {
          const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: root, encoding: 'utf-8' }).trim();
          if (branch.startsWith('story/') || branch.startsWith('worktree-')) {
            driftBase = 'main';
          }
        } catch {}
      }
      const diffFunctions = parseDiffFunctions(root, scanRoot, driftBase);
      const drifts = checkDrift(diffFunctions, allTasks);
      const driftResult: DriftResult = { base: driftBase, diffFunctions, drifts, passed: drifts.length === 0 };
      if (drifts.length > 0) {
        warnings.push(`注释漂移: ${drifts.length} 个改动函数缺少 @task 注释 (base=${driftBase})`);
      }

      // Step 5: Write test evidence
      if (args.storyId) {
        const evidence = store.readTestEvidence(args.storyId);
        evidence.tests = evidence.tests.filter(t => !t.id.startsWith('TE-AUTO-') && !t.id.startsWith('TE-E2E-') && !t.id.startsWith('TE-DRIFT-') && !t.id.startsWith('TE-CLI-'));
        if (!evidence.environment) {
          evidence.environment = { node: process.version, os: `${process.platform} ${process.arch}`, timestamp: new Date().toISOString() };
        }
        let teCounter = evidence.tests.length + 1;
        for (const result of executionResults) {
          for (const c of result.cases) {
            const teId = `TE-AUTO-${String(teCounter++).padStart(3, '0')}`;
            if (evidence.tests.find(t => t.scenario === `${result.functionName}:${c.name}`)) continue;
            evidence.tests.push({
              id: teId, scenario: `${result.functionName}:${c.name}`, command: `test_auto(${result.functionName})`,
              output: c.error || 'OK', expected: c.expected ? JSON.stringify(c.expected) : 'no error',
              result: c.passed ? 'PASS' : 'FAIL', timestamp: new Date().toISOString(),
            });
          }
        }
        for (const fe of flowE2EResults) {
          const teId = `TE-E2E-${String(teCounter++).padStart(3, '0')}`;
          if (evidence.tests.find(t => t.scenario === `flow-e2e:${fe.flow}`)) continue;
          evidence.tests.push({
            id: teId, scenario: `flow-e2e:${fe.flow}`, command: `runFlowE2E(${fe.flow})`,
            output: fe.allPassed ? 'ALL PASS' : fe.steps.filter(s => !s.passed).map(s => `${s.step}: ${s.error}`).join('; '),
            expected: 'all steps pass', result: fe.allPassed ? 'PASS' : 'FAIL', timestamp: new Date().toISOString(),
          });
        }
        for (const cr of cliResults) {
          const teId = `TE-CLI-${String(teCounter++).padStart(3, '0')}`;
          evidence.tests.push({
            id: teId, scenario: `cli:${cr.name}`, command: `executeCliCases`,
            output: cr.passed ? 'ALL PASS' : cr.steps.filter(s => !s.passed).map(s => s.error).join('; '),
            expected: 'all steps pass', result: cr.passed ? 'PASS' : 'FAIL', timestamp: new Date().toISOString(),
          });
        }
        if (driftResult.drifts.length > 0) {
          evidence.tests.push({
            id: `TE-DRIFT-${String(teCounter++).padStart(3, '0')}`, scenario: `drift-check(base=${driftResult.base})`,
            command: `parseDiffFunctions + checkDrift`, output: driftResult.drifts.map(d => `${d.file}:${d.functionName}`).join(', '),
            expected: 'no drift', result: 'FAIL', timestamp: new Date().toISOString(),
          });
        } else if (diffFunctions.length > 0) {
          evidence.tests.push({
            id: `TE-DRIFT-${String(teCounter++).padStart(3, '0')}`, scenario: `drift-check(base=${driftResult.base})`,
            command: `parseDiffFunctions + checkDrift`, output: `${diffFunctions.length} changed functions, all annotated`,
            expected: 'no drift', result: 'PASS', timestamp: new Date().toISOString(),
          });
        }
        store.writeTestEvidence(args.storyId, evidence);
      }

      // Cleanup temp store
      rmSync(tmpDir, { recursive: true, force: true });

      // Step 6: Summary
      const totalCases = executionResults.reduce((sum, r) => sum + r.cases.length, 0);
      const passedCases = executionResults.reduce((sum, r) => sum + r.cases.filter(c => c.passed).length, 0);
      const flowAllPassed = flowE2EResults.every(f => f.allPassed);
      const browserAllPassed = browserResults.every(r => r.passed);
      const cliAllPassed = cliResults.every(r => r.passed);
      const allPassed = executionResults.every(r => r.allPassed) && errors.length === 0 && flowAllPassed && browserAllPassed && cliAllPassed && driftResult.passed;

      return JSON.stringify({
        _hint: warnings.length > 0 ? '⚠ 请审查 warnings' : undefined,
        warnings,
        fixturesGenerated: genResult.generated.length,
        functionsTestedCount: executionResults.length,
        totalCases, passedCases, failedCases: totalCases - passedCases,
        executionErrors: errors,
        flowE2E: flowE2EResults.map(f => ({ flow: f.flow, allPassed: f.allPassed, steps: f.steps })),
        browserTests: browserResults.length > 0 ? { total: browserResults.length, passed: browserResults.filter(r => r.passed).length, traceCoverage: browserTrace, results: browserResults } : undefined,
        cliTests: cliResults.length > 0 ? { total: cliResults.length, passed: cliResults.filter(r => r.passed).length, results: cliResults } : undefined,
        driftCheck: { base: driftResult.base, changedFunctions: driftResult.diffFunctions.length, drifts: driftResult.drifts, passed: driftResult.passed },
        allPassed,
        details: executionResults.map(r => ({
          function: r.functionName, cases: r.cases.length,
          passed: r.cases.filter(c => c.passed).length,
          failed: r.cases.filter(c => !c.passed).map(c => ({ name: c.name, error: c.error })),
          durationMs: r.totalDurationMs,
        })),
      }, null, 2);
    },
  };
}
