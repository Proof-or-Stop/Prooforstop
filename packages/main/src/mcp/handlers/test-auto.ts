import { execSync } from 'child_process';
import type { HandlerContext } from './context.js';
import { loadConfig } from '../../config.js';
import { existsSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { executeBrowserCases, type BrowserStep, type BrowserCaseResult } from '../../tasks/browser-executor.js';
import { FixtureProfilerSession, type ProfileNode } from '../../tasks/profiler.js';
import { saveTraceSnapshot, loadTraceSnapshot } from '../../tasks/trace-store.js';
import { diffTraces, summarizeDiff } from '../../tasks/trace-diff.js';

const DEFAULT_TIMEOUT_MS = 10000;

interface CaseResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
  trace?: ProfileNode[];
}

interface FixtureResult {
  file: string;
  cases: CaseResult[];
  allPassed: boolean;
}

/** $file 占位符替换为编译后 .js 路径 */
function resolveFilePlaceholder(execute: string, file: string, root: string): string {
  const config = loadConfig(root);
  const outDir = config.outDir || 'dist';
  const relPath = file.replace(/\.ts$/, '') + '.js';
  let jsPath = join(root, outDir, relPath);
  // fallback: worktree 下 dist 可能不存在，尝试从 git toplevel 查找
  if (!existsSync(jsPath)) {
    try {
      const toplevel = execSync('git rev-parse --show-toplevel', { cwd: root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      const fallback = join(toplevel, outDir, relPath);
      if (existsSync(fallback)) jsPath = fallback;
    } catch { /* not a git repo, use original path */ }
  }
  const jsUrl = pathToFileURL(jsPath).href;
  return execute.replace(/\$file/g, jsUrl);
}

/** Promise 超时包装 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)),
  ]);
}

/** expect 匹配 */
function matchExpect(actual: unknown, expect: unknown): { passed: boolean; error?: string } {
  const exp = expect as Record<string, unknown>;
  if (exp && typeof exp === 'object' && 'pattern' in exp) {
    const regex = new RegExp(exp.pattern as string);
    const testStr = typeof actual === 'string' ? actual : JSON.stringify(actual);
    if (regex.test(testStr)) return { passed: true };
    return { passed: false, error: `Pattern /${exp.pattern}/ did not match: ${typeof testStr === 'string' ? testStr.slice(0, 200) : testStr}` };
  }
  // deep equal
  const actualStr = JSON.stringify(actual);
  const expectStr = JSON.stringify(expect);
  if (actualStr === expectStr) return { passed: true };
  return { passed: false, error: `Expected ${expectStr}, got ${actualStr}` };
}

/** 禁止的 execute 模式 — 防止 agent 通过 fs/child_process 绕过沙箱 */
const SANDBOX_BLOCKED_PATTERNS = [
  { pattern: /\bimport\s*\(\s*["']fs["']/, msg: 'import("fs") 被禁止，文件操作请使用 $handlers' },
  { pattern: /\bimport\s*\(\s*["']node:fs["']/, msg: 'import("node:fs") 被禁止，文件操作请使用 $handlers' },
  { pattern: /\bimport\s*\(\s*["']child_process["']/, msg: 'import("child_process") 被禁止' },
  { pattern: /\bimport\s*\(\s*["']node:child_process["']/, msg: 'import("node:child_process") 被禁止' },
  { pattern: /\brequire\s*\(\s*["']fs["']/, msg: 'require("fs") 被禁止，文件操作请使用 $handlers' },
  { pattern: /\brequire\s*\(\s*["']child_process["']/, msg: 'require("child_process") 被禁止' },
];

function validateSandbox(execute: string): string | null {
  for (const { pattern, msg } of SANDBOX_BLOCKED_PATTERNS) {
    if (pattern.test(execute)) return msg;
  }
  return null;
}

/** 执行单条 case 的 execute 函数体。execute 中可用 $handlers、$root、$ctx、$testStory */
async function runCase(c: any, root: string, handlers: Record<string, Function>, sharedCtx: Record<string, unknown>, profilerSession: FixtureProfilerSession | null, testStoryFactory?: Function, currentCaseIds?: Set<string>): Promise<CaseResult> {
  const start = Date.now();

  try {
    // CHK-003: 沙箱静态检查（sandbox: false 可跳过，用于合法的测试 setup）
    if (c.sandbox !== false) {
      const sandboxError = validateSandbox(c.execute as string);
      if (sandboxError) {
        return { name: c.name, passed: false, error: `[sandbox] ${sandboxError}，如确需直接访问请在 case 中设置 sandbox: false`, durationMs: Date.now() - start };
      }
    }

    // CHK-004: start profiling via shared fixture-level session
    if (profilerSession) {
      try { await profilerSession.startCase(); } catch { /* non-fatal */ }
    }

    // 替换 $file
    let code = c.execute as string;
    if (c.file) {
      code = resolveFilePlaceholder(code, c.file, root);
    }

    // 包成 async function，注入 $handlers、$root、$ctx、$testStory
    // 禁止 case 内部调 test runner（会递归/卡死）
    const BLOCKED_IN_CASE = ['test_auto', 'test_story', 'browser_test'];
    const safeHandlers: Record<string, Function> = { ...handlers };
    for (const blocked of BLOCKED_IN_CASE) {
      safeHandlers[blocked] = () => { throw new Error(blocked + ' 禁止在 fixture case 内调用'); };
    }
    // test_fixture 允许调用，但禁止调用当前 fixture 文件中的 case（防止自引用）
    if (currentCaseIds && currentCaseIds.size > 0) {
      const origTestFixture = handlers.test_fixture;
      safeHandlers.test_fixture = (args: { fixtureId: string }) => {
        if (currentCaseIds.has(args.fixtureId)) {
          throw new Error('test_fixture 禁止调用当前 fixture 中的 case（自引用）');
        }
        return origTestFixture(args);
      };
    }
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    const fn = new AsyncFunction('$handlers', '$root', '$ctx', '$testStory', code);
    const $testStory = testStoryFactory || (() => { throw new Error('$testStory not available'); });

    let result: CaseResult;

    if (c.throws) {
      let threw = false;
      let thrownError = '';
      try {
        await withTimeout(fn(safeHandlers, root, sharedCtx, $testStory), DEFAULT_TIMEOUT_MS);
      } catch (e: any) {
        threw = true;
        thrownError = e?.message || String(e);
      }
      const durationMs = Date.now() - start;
      if (threw && thrownError.includes(c.throws)) {
        result = { name: c.name, passed: true, durationMs };
      } else if (threw) {
        result = { name: c.name, passed: false, error: `Expected error containing "${c.throws}", got: "${thrownError}"`, durationMs };
      } else {
        result = { name: c.name, passed: false, error: `Expected to throw "${c.throws}" but did not throw`, durationMs };
      }
    } else {
      const actual = await withTimeout(fn(safeHandlers, root, sharedCtx, $testStory), DEFAULT_TIMEOUT_MS);
      const durationMs = Date.now() - start;
      if (c.expect !== undefined) {
        const r = matchExpect(actual, c.expect);
        result = { name: c.name, passed: r.passed, error: r.error, durationMs };
      } else {
        result = { name: c.name, passed: true, durationMs };
      }
    }

    // CHK-004: stop profiling and collect trace via shared session
    if (profilerSession) {
      try {
        result.trace = await profilerSession.stopCase();
      } catch { /* trace collection failure is non-fatal */ }
    }

    return result;
  } catch (e: any) {
    // Stop profiler on error too
    if (profilerSession) {
      try { await profilerSession.stopCase(); } catch {}
    }
    return { name: c.name, passed: false, error: e?.message || String(e), durationMs: Date.now() - start };
  }
}

/** CHK-003: 构建链拓扑 — 将 cases 分为独立 case 和链式 case 组 */
function buildChainGroups(cases: any[]): { chains: any[][]; standalone: any[] } {
  const byId = new Map<string, any>();
  for (const c of cases) { if (c._id) byId.set(c._id, c); }

  const visited = new Set<string>();
  const chains: any[][] = [];
  const standalone: any[] = [];

  for (const c of cases) {
    if (!c._id) { standalone.push(c); continue; }
    if (visited.has(c._id)) continue;

    // 没有链关系 → 独立
    if (!c.prevCaseId && !c.nextCaseId) { standalone.push(c); visited.add(c._id); continue; }

    // 找链头（无 prevCaseId 或 prev 不在当前集合中）
    let head = c;
    const seen = new Set<string>();
    while (head.prevCaseId && byId.has(head.prevCaseId) && !seen.has(head.prevCaseId)) {
      seen.add(head._id);
      head = byId.get(head.prevCaseId)!;
    }

    // 沿 nextCaseId 遍历整条链
    const chain: any[] = [];
    let cur: any = head;
    const chainSeen = new Set<string>();
    while (cur && !chainSeen.has(cur._id)) {
      chainSeen.add(cur._id);
      visited.add(cur._id);
      chain.push(cur);
      cur = cur.nextCaseId ? byId.get(cur.nextCaseId) : null;
    }
    chains.push(chain);
  }

  return { chains, standalone };
}

/** CHK-006: 在所有 fixture 中按 _id 查找 case 及其所在 fixture 信息 */
function findCaseById(fixturesDir: string, fixtureId: string): { filePath: string; fileName: string; cases: any[]; targetCase: any } | null {
  const scanDir = (dir: string): string[] => {
    const files: string[] = [];
    if (!existsSync(dir)) return files;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) files.push(...scanDir(join(dir, entry.name)));
      else if (entry.name.endsWith('.json') && !entry.name.endsWith('.trace.json')) files.push(join(dir, entry.name));
    }
    return files;
  };
  for (const fp of scanDir(fixturesDir)) {
    try {
      const content = JSON.parse(readFileSync(fp, 'utf-8'));
      const cases = content.cases || [];
      const target = cases.find((c: any) => c._id === fixtureId);
      if (target) {
        return { filePath: fp, fileName: fp.replace(fixturesDir + '/', '').replace(fixturesDir + '\\', ''), cases, targetCase: target };
      }
    } catch { /* skip */ }
  }
  return null;
}

export function createTestAutoHandlers(ctx: HandlerContext) {
  const { root } = ctx;
  const progress = ctx.log || (() => {});

  return {
    async test_auto(args: { storyId?: string; enableProfiler?: boolean }): Promise<string> {
      // 递归防护：fixture case 里调 $handlers.test_auto() 时跳过，防止无限递归卡死
      if ((globalThis as any).__koalaTestAutoRunning) {
        return JSON.stringify({ hint: '→ test_auto 递归调用被跳过', allPassed: true, totalCases: 0, passedCases: 0, failedCases: 0, warnings: [], details: [] });
      }
      (globalThis as any).__koalaTestAutoRunning = true;
      try {
      // === 递归防护 end ===

      const warnings: string[] = [];
      const traceWarnings: string[] = [];
      const config = loadConfig(root);

      // koala 自身项目禁止全量测试（自己测自己会副作用污染）
      try {
        const pkgPath = join(root, 'packages', 'main', 'package.json');
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
          if (pkg.name === '@koala-agent/core') {
            throw new Error('koala 自身项目禁止 test_auto 全量测试（会自己测自己导��副作用污染）。请用 test_story 按 storyId 跑');
          }
        }
      } catch (e: any) {
        if (e.message.includes('禁止 test_auto')) throw e;
      }

      // CHK-004: storyId 已废弃
      if (args.storyId) {
        warnings.push('⚠ storyId 已废弃，test_auto 现在始终执行全量回归。story 级测试请用 test_story');
      }
      progress(`[DEBUG] root=${root}`);
      progress(`[DEBUG] config.fixturesDir=${config.fixturesDir}`);
      try { progress(`[DEBUG] koala.config.json: ${readFileSync(join(root, 'koala.config.json'), 'utf-8').slice(0, 50).replace(/\n/g, ' ')}`); } catch(e: any) { progress(`[DEBUG] config read err: ${e.message}`); }
      progress(`test_auto start: full regression`);

      // 创建 handlers 供 execute 中的 $handlers 使用
      const { StoryStore } = await import('../../story/store.js');
      const { createToolHandlers } = await import('../tools.js');
      const testStore = new StoryStore(root);
      const handlers = createToolHandlers(testStore, root, ctx.log) as Record<string, Function>;

      // 快照：记录 test_auto 开始前已有的分支，用于结束后清理
      let branchesBefore: Set<string>;
      try {
        branchesBefore = new Set(
          execSync('git branch --format="%(refname:short)"', { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
        );
      } catch { branchesBefore = new Set(); }

      // $testStory 工厂 — 创建指定 phase/checklist 的临时 story
      const tempStoryIds: string[] = [];
      const testStoryFactory = async (opts: { phase?: string; checklist?: Array<{ id: string; title: string; status?: string }> } = {}) => {
        const storyId = (handlers as any)._nextStoryId?.() || `TEST-${Date.now().toString(36)}`;
        const phase = opts.phase || 'DEV';
        testStore.writeStory(storyId, {
          storyId, name: `test-${storyId}`, title: '[temp] test story',
          description: 'Auto-created by $testStory factory',
          type: 'chore' as any, phase: phase as any, priority: 'low',
          createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), endedAt: null,
          events: [{ phase: phase as any, action: 'create', timestamp: new Date().toISOString() }],
        });
        const items = (opts.checklist || []).map(c => ({
          id: c.id, title: c.title, status: (c.status || 'pending') as any, startTime: null, endTime: null,
        }));
        testStore.writeChecklist(storyId, { items });
        tempStoryIds.push(storyId);
        return storyId;
      };

      // Step 1: 扫描所有 fixture 文件，收集 case
      const fixturesDir = join(root, config.fixturesDir);
      const fixtureResults: FixtureResult[] = [];
      const errors: string[] = [];

      if (!existsSync(fixturesDir)) {
        return JSON.stringify({ hint: '→ fixture 目录不存在', warnings: ['fixture 目录不存在'], allPassed: true });
      }

      const fixtureFiles: string[] = [];
      const scanDir = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) { scanDir(join(dir, entry.name)); continue; }
          if (entry.name.endsWith('.json')) fixtureFiles.push(join(dir, entry.name));
        }
      };
      scanDir(fixturesDir);
      progress(`[DEBUG] fixturesDir=${fixturesDir} exists=${existsSync(fixturesDir)} files=${fixtureFiles.length}`);
      if (fixtureFiles.length > 0) progress(`[DEBUG] first file: ${fixtureFiles[0]}`);

      // Step 2: 逐文件执行 case（CHK-004: 全量回归，不再按 storyId 过滤）
      for (const fp of fixtureFiles) {
        let content: any;
        try {
          content = JSON.parse(readFileSync(fp, 'utf-8'));
        } catch (e: any) {
          warnings.push(`fixture 解析失败: ${fp}: ${e.message}`);
          continue;
        }

        const cases = content.cases || [];
        if (cases.length === 0) continue;

        // 只执行有 execute 字段的新格式 case
        const executableCases = cases.filter((c: any) => c.execute);
        progress(`[DEBUG] ${fp.split(/[/\\]/).pop()}: total=${cases.length} executable=${executableCases.length}`);
        if (executableCases.length === 0) continue;

        const fileName = fp.replace(fixturesDir + '/', '').replace(fixturesDir + '\\', '');
        const caseResults: CaseResult[] = [];
        // 当前 fixture 的所有 case _id，用于 test_fixture 自引用检测
        const fileCaseIds = new Set<string>(cases.map((c: any) => c._id).filter(Boolean));

        const enableProfiler = args.enableProfiler !== false; // default on

        // CHK-003: 按链拓扑分组执行
        const { chains, standalone } = buildChainGroups(executableCases);
        const groups: { cases: any[]; isChain: boolean }[] = [
          ...standalone.map(c => ({ cases: [c], isChain: false })),
          ...chains.map(c => ({ cases: c, isChain: true })),
        ];

        for (const group of groups) {
          const sharedCtx: Record<string, unknown> = {};
          let profilerSession: FixtureProfilerSession | null = null;
          if (enableProfiler) {
            try {
              profilerSession = new FixtureProfilerSession();
              await profilerSession.open();
            } catch { profilerSession = null; }
          }
          try {
            for (const c of group.cases) {
              // DEBUG: 追踪 koala.config.json 被谁改了
              const _cfgPath = join(root, 'koala.config.json');
              let _cfgBefore = '';
              try { _cfgBefore = readFileSync(_cfgPath, 'utf-8').slice(0, 30); } catch {}
              progress(`${fileName}:${c.name} START → config: ${_cfgBefore.replace(/\n/g, ' ')}`);

              const result = await runCase(c, root, handlers, sharedCtx, profilerSession, testStoryFactory, fileCaseIds);
              caseResults.push(result);

              let _cfgAfter = '';
              try { _cfgAfter = readFileSync(_cfgPath, 'utf-8').slice(0, 30); } catch {}
              progress(`${fileName}:${c.name} END → config: ${_cfgAfter.replace(/\n/g, ' ')}`);

              if (result.trace && result.trace.length > 0) {
                const lastSnap = loadTraceSnapshot(root, fileName, c.name);
                if (lastSnap) {
                  const diff = diffTraces(lastSnap.trace, result.trace);
                  if (diff.added.length > 0 || diff.removed.length > 0 || diff.forked.length > 0) {
                    const summary = summarizeDiff(diff);
                    traceWarnings.push(`${fileName}:${c.name}: trace 变化 — ${summary.split('\n')[0]}`);
                  }
                }
                if (result.passed) {
                  try { saveTraceSnapshot(root, fileName, c.name, result.trace); } catch {}
                }
              }
            }
          } catch (e: any) {
            errors.push(`${fileName}: ${e.message}`);
          } finally {
            if (profilerSession) { try { await profilerSession.close(); } catch {} }
            // CHK-003: 每组执行完 cleanup（独立 case 立即、链式在链尾）
            try {
              execSync(`git restore "${config.fixturesDir}"`, { cwd: root, stdio: 'pipe' });
              execSync(`git clean -fd "${config.fixturesDir}"`, { cwd: root, stdio: 'pipe' });
            } catch {}
          }
        }

        fixtureResults.push({
          file: fileName,
          cases: caseResults,
          allPassed: caseResults.every(r => r.passed),
        });
      }

      // 清理 $testStory 创建的临时 story
      for (const id of tempStoryIds) {
        try { rmSync(join(root, 'docs', 'story', 'actives', id), { recursive: true, force: true }); } catch {}
      }

      // 清理 fixture 执行中创建的临时分支
      try {
        const branchesAfter = execSync('git branch --format="%(refname:short)"', { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
        for (const b of branchesAfter) {
          if (!branchesBefore.has(b) && b !== 'main' && b !== 'master') {
            try { execSync(`git branch -D "${b}"`, { cwd: root, stdio: 'pipe' }); } catch {}
          }
        }
      } catch {}

      // Step 3: Browser tests
      let browserResults: BrowserCaseResult[] = [];
      if (config.browser?.devCommand) {
        const browserCases: Array<{ name: string; steps: BrowserStep[] }> = [];
        for (const fp of fixtureFiles) {
          try {
            const content = JSON.parse(readFileSync(fp, 'utf-8'));
            for (const c of content.cases || []) {
              if (c.run_type === 'browser' && c.execute) {
                // browser case 的 execute 可以包含 steps 或直接代码
                browserCases.push({ name: c.name, steps: c.steps || [] });
              }
            }
          } catch { /* ignore */ }
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
            progress(`browser test: ${browserResults.filter(r => r.passed).length}/${browserResults.length} passed`);
          } catch (e: any) {
            warnings.push(`Browser tests failed: ${e.message}`);
          }
        }
      }

      // CHK-004: test_auto 全量回归不写 bug/evidence（用 test_story 写）
      const totalCases = fixtureResults.reduce((sum, r) => sum + r.cases.length, 0);
      const passedCases = fixtureResults.reduce((sum, r) => sum + r.cases.filter(c => c.passed).length, 0);
      const browserAllPassed = browserResults.every(r => r.passed);
      const allPassed = fixtureResults.every(r => r.allPassed) && errors.length === 0 && browserAllPassed;

      const hint = allPassed ? '→ 全量回归通过' : '→ 有失败项，请修复后重跑';

      return JSON.stringify({
        hint,
        _hint: warnings.length > 0 ? '⚠ 请审查 warnings' : undefined,
        warnings,
        traceWarnings: traceWarnings.length > 0 ? traceWarnings : undefined,
        totalCases,
        passedCases,
        failedCases: totalCases - passedCases,
        executionErrors: errors,
        browserTests: browserResults.length > 0 ? {
          total: browserResults.length,
          passed: browserResults.filter(r => r.passed).length,
          results: browserResults,
        } : undefined,
        allPassed,
        details: fixtureResults.map(r => ({
          file: r.file,
          cases: r.cases.length,
          passed: r.cases.filter(c => c.passed).length,
          failed: r.cases.filter(c => !c.passed).map(c => ({ name: c.name, error: c.error })),
        })),
      }, null, 2);

      } finally { (globalThis as any).__koalaTestAutoRunning = false; }
    },

    /** CHK-005: story 级测试 — 只跑关联 case，写 bug/evidence */
    async test_story(args: { storyId: string }): Promise<string> {
      // 递归防护
      if ((globalThis as any).__koalaTestRunning) {
        return JSON.stringify({ hint: '→ test_story 递归调用被跳过', allPassed: true, storyId: args.storyId, totalCases: 0, passedCases: 0, failedCases: 0, warnings: [], details: [] });
      }
      (globalThis as any).__koalaTestRunning = true;
      try {
      const config = loadConfig(root);
      const fixturesDir = join(root, config.fixturesDir);
      const warnings: string[] = [];
      const errors: string[] = [];

      const storyId = args.storyId;

      // 收集 story checklist item IDs
      let storyItemIds: Set<string>;
      try {
        const checklist = ctx.store.readChecklist(storyId);
        storyItemIds = new Set(checklist.items.map(i => i.id));
      } catch {
        throw new Error(`无法读取 story ${storyId} 的 checklist`);
      }

      // 创建 handlers
      const { StoryStore } = await import('../../story/store.js');
      const { createToolHandlers } = await import('../tools.js');
      const testStore = new StoryStore(root);
      const handlers = createToolHandlers(testStore, root, ctx.log) as Record<string, Function>;

      // $testStory factory
      const tempStoryIds: string[] = [];
      const testStoryFactory = async (opts: { phase?: string; checklist?: Array<{ id: string; title: string; status?: string }> } = {}) => {
        const sid = (handlers as any)._nextStoryId?.() || `TEST-${Date.now().toString(36)}`;
        const phase = opts.phase || 'DEV';
        testStore.writeStory(sid, {
          storyId: sid, name: `test-${sid}`, title: '[temp] test story',
          description: 'Auto-created by $testStory factory',
          type: 'chore' as any, phase: phase as any, priority: 'low',
          createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), endedAt: null,
          events: [{ phase: phase as any, action: 'create', timestamp: new Date().toISOString() }],
        });
        const items = (opts.checklist || []).map(c => ({
          id: c.id, title: c.title, status: (c.status || 'pending') as any, startTime: null, endTime: null,
        }));
        testStore.writeChecklist(sid, { items });
        tempStoryIds.push(sid);
        return sid;
      };

      // 扫描 fixture
      if (!existsSync(fixturesDir)) throw new Error('fixture 目录不存在');
      const fixtureFiles: string[] = [];
      const scanDir = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) { scanDir(join(dir, entry.name)); continue; }
          if (entry.name.endsWith('.json') && !entry.name.endsWith('.trace.json')) fixtureFiles.push(join(dir, entry.name));
        }
      };
      scanDir(fixturesDir);

      const fixtureResults: FixtureResult[] = [];

      for (const fp of fixtureFiles) {
        let content: any;
        try { content = JSON.parse(readFileSync(fp, 'utf-8')); } catch (e: any) { warnings.push(`fixture 解析失败: ${fp}: ${e.message}`); continue; }
        const cases = content.cases || [];
        if (cases.length === 0) continue;

        // 过滤：只跑 intentRef 匹配当前 story checklist 的 case
        // intentRef 格式: "CHK-001:happy:0" 或 "B-xxx:CHK-001:happy:0"（含 storyId 前缀）
        let executableCases = cases.filter((c: any) => c.execute);
        executableCases = executableCases.filter((c: any) => {
          if (!c.intentRef) return false;
          const ref = c.intentRef as string;
          const parts = ref.split(':');
          // 如果 intentRef 以 storyId 前缀开头（如 B-xxx:CHK-001:happy:0），精确匹配
          if (parts[0].startsWith(storyId.charAt(0) + '-')) {
            return parts[0] === storyId && storyItemIds.has(parts[1]);
          }
          // 旧格式（CHK-001:happy:0），fallback 匹配 item ID
          return storyItemIds.has(parts[0]);
        });
        if (executableCases.length === 0) continue;

        const fileName = fp.replace(fixturesDir + '/', '').replace(fixturesDir + '\\', '');
        const caseResults: CaseResult[] = [];
        const fileCaseIds = new Set<string>(cases.map((c: any) => c._id).filter(Boolean));

        const { chains, standalone } = buildChainGroups(executableCases);
        const groups = [
          ...standalone.map(c => ({ cases: [c] })),
          ...chains.map(c => ({ cases: c })),
        ];

        for (const group of groups) {
          const sharedCtx: Record<string, unknown> = {};
          try {
            for (const c of group.cases) {
              const result = await runCase(c, root, handlers, sharedCtx, null, testStoryFactory, fileCaseIds);
              caseResults.push(result);
              progress(`${fileName}:${c.name}: ${result.passed ? 'PASS' : 'FAIL'}${result.error ? ' — ' + result.error.slice(0, 100) : ''}`);
            }
          } catch (e: any) {
            errors.push(`${fileName}: ${e.message}`);
          } finally {
            try {
              execSync(`git restore "${config.fixturesDir}"`, { cwd: root, stdio: 'pipe' });
              execSync(`git clean -fd "${config.fixturesDir}"`, { cwd: root, stdio: 'pipe' });
            } catch {}
          }
        }

        fixtureResults.push({ file: fileName, cases: caseResults, allPassed: caseResults.every(r => r.passed) });
      }

      // 清理临时 story
      for (const id of tempStoryIds) {
        try { rmSync(join(root, 'docs', 'story', 'actives', id), { recursive: true, force: true }); } catch {}
      }

      // Auto bug report/fix — CHK-007: 使用 fixtureId
      const autoBugResults: Array<{ caseName: string; fixturePath: string; bugId: string; fixtureId?: string; action: 'created' | 'fixed' }> = [];
      const bugData = ctx.store.readBugs(storyId);
      for (const fr of fixtureResults) {
        for (const cr of fr.cases) {
          // 找原始 case 的 _id
          const origCase = cases_findByName(fixturesDir, fr.file, cr.name);
          const caseFixtureId = origCase?._id;
          if (!caseFixtureId) continue; // 无 _id 的旧 case 跳过 bug 关联

          // bug id 基于 fixtureId
          const bugId = `BUG-${caseFixtureId.slice(0, 8)}`;
          const existingBug = bugData.bugs.find(b => b.fixtureId === caseFixtureId);

          if (!cr.passed && !existingBug) {
            let diagnose: import('../../story/types.js').BugDiagnose | undefined;
            try {
              const lastSnap = loadTraceSnapshot(root, fr.file, cr.name);
              const traceDiffResult = (lastSnap && cr.trace) ? diffTraces(lastSnap.trace, cr.trace) : null;
              diagnose = {
                rootCause: [cr.error || 'unknown error'],
                traceDiff: traceDiffResult ? { added: traceDiffResult.added.length, removed: traceDiffResult.removed.length, forked: traceDiffResult.forked.length } : null,
                suggestedFix: traceDiffResult?.forked.length ? `从 ${traceDiffResult.forked[0].fn} 处调用链分叉` : '检查 case 报错信息定位根因',
              };
            } catch {}
            bugData.bugs.push({
              id: bugId,
              title: `[auto] ${fr.file}:${cr.name} — ${(cr.error || 'unknown error').slice(0, 100)}`,
              status: 'open',
              foundAt: new Date().toISOString(),
              fixedAt: null,
              fixtureId: caseFixtureId,
              ...(diagnose ? { diagnose } : {}),
            });
            autoBugResults.push({ caseName: cr.name, fixturePath: fr.file, bugId, fixtureId: caseFixtureId, action: 'created' });
          } else if (cr.passed && existingBug && existingBug.status === 'open') {
            existingBug.status = 'fixed';
            existingBug.fixedAt = new Date().toISOString();
            autoBugResults.push({ caseName: cr.name, fixturePath: fr.file, bugId: existingBug.id, action: 'fixed' });
          }
        }
      }
      if (autoBugResults.length > 0) ctx.store.writeBugs(storyId, bugData);

      // Evidence — 覆盖式：只保留最后一次结果
      const totalCasesS = fixtureResults.reduce((sum, r) => sum + r.cases.length, 0);
      const passedCasesS = fixtureResults.reduce((sum, r) => sum + r.cases.filter(c => c.passed).length, 0);
      const allPassedS = fixtureResults.every(r => r.allPassed) && errors.length === 0;
      try {
        ctx.store.writeTestEvidence(storyId, {
          command: `koala test_story '{"storyId":"${storyId}"}'`,
          output: JSON.stringify({ totalCases: totalCasesS, passedCases: passedCasesS, failedCases: totalCasesS - passedCasesS, allPassed: allPassedS }),
          result: allPassedS ? 'PASS' : 'FAIL',
          timestamp: new Date().toISOString(),
          environment: { node: process.version, os: `${process.platform} ${process.arch}` },
        });
      } catch {}

      const hintS = allPassedS
        ? `→ story ${storyId} 全部通过，请 commit 后执行: story_advance('${storyId}', 'DONE')`
        : `→ 有失败项，修复后重跑: test_story('${storyId}')`;

      return JSON.stringify({
        hint: hintS,
        storyId,
        warnings,
        totalCases: totalCasesS,
        passedCases: passedCasesS,
        failedCases: totalCasesS - passedCasesS,
        executionErrors: errors,
        autoBugs: autoBugResults.length > 0 ? autoBugResults : undefined,
        allPassed: allPassedS,
        details: fixtureResults.map(r => ({
          file: r.file,
          cases: r.cases.length,
          passed: r.cases.filter(c => c.passed).length,
          failed: r.cases.filter(c => !c.passed).map(c => ({ name: c.name, error: c.error })),
        })),
      }, null, 2);

      } finally { (globalThis as any).__koalaTestRunning = false; }
    },

    /** CHK-006: 单 case / 单链测试 — 按 fixtureId(uuid) 定位 */
    async test_fixture(args: { fixtureId: string }): Promise<string> {
      const config = loadConfig(root);
      const fixturesDir = join(root, config.fixturesDir);

      const found = findCaseById(fixturesDir, args.fixtureId);
      if (!found) throw new Error(`未找到 _id="${args.fixtureId}" 的 fixture case`);

      // 拒绝链中间节点：有 prevCaseId 说明不是链头
      if (found.targetCase.prevCaseId) {
        throw new Error(`fixtureId="${args.fixtureId}" 是链中间节点（有 prevCaseId），请传链头 case 的 fixtureId`);
      }

      // 沿 nextCaseId 收集链
      const byId = new Map<string, any>();
      for (const c of found.cases) { if (c._id) byId.set(c._id, c); }

      const chain: any[] = [];
      let cur: any = found.targetCase;
      const chainSeen = new Set<string>();
      while (cur && !chainSeen.has(cur._id)) {
        chainSeen.add(cur._id);
        chain.push(cur);
        cur = cur.nextCaseId ? byId.get(cur.nextCaseId) : null;
      }

      // 只跑有 execute 的 case
      const executableCases = chain.filter((c: any) => c.execute);
      if (executableCases.length === 0) throw new Error('链中无可执行 case');

      // 创建 handlers
      const { StoryStore } = await import('../../story/store.js');
      const { createToolHandlers } = await import('../tools.js');
      const testStore = new StoryStore(root);
      const handlers = createToolHandlers(testStore, root, ctx.log) as Record<string, Function>;

      const sharedCtx: Record<string, unknown> = {};
      const caseResults: CaseResult[] = [];
      const fileCaseIds = new Set<string>(found.cases.map((c: any) => c._id).filter(Boolean));

      try {
        for (const c of executableCases) {
          const result = await runCase(c, root, handlers, sharedCtx, null, undefined, fileCaseIds);
          caseResults.push(result);
          progress(`${found.fileName}:${c.name}: ${result.passed ? 'PASS' : 'FAIL'}${result.error ? ' — ' + result.error.slice(0, 100) : ''}`);
        }
      } finally {
        try {
          execSync(`git restore "${config.fixturesDir}"`, { cwd: root, stdio: 'pipe' });
          execSync(`git clean -fd "${config.fixturesDir}"`, { cwd: root, stdio: 'pipe' });
        } catch {}
      }

      const allPassed = caseResults.every(r => r.passed);
      return JSON.stringify({
        hint: allPassed ? '→ 全部通过' : '→ 有失败项',
        fixtureId: args.fixtureId,
        fileName: found.fileName,
        totalCases: caseResults.length,
        passedCases: caseResults.filter(r => r.passed).length,
        failedCases: caseResults.filter(r => !r.passed).length,
        allPassed,
        details: caseResults.map(r => ({
          name: r.name,
          passed: r.passed,
          error: r.error,
          durationMs: r.durationMs,
        })),
      }, null, 2);
    },
  };
}

/** 在 fixture 文件中按 name 查找 case（用于获取 _id） */
function cases_findByName(fixturesDir: string, fileName: string, caseName: string): any | null {
  try {
    const fp = join(fixturesDir, fileName);
    const content = JSON.parse(readFileSync(fp, 'utf-8'));
    return (content.cases || []).find((c: any) => c.name === caseName) || null;
  } catch { return null; }
}
