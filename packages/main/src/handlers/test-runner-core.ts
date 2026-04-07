/**
 * Fixture runner 共享内核 — 被 test_auto / test_story / test_fixture 三个 handler 复用。
 *
 * 这里只放纯函数和工厂函数，不直接挂 handler。任何状态都通过参数传入；上层 handler
 * 决定怎么扫描文件、分组、写 bug、写 evidence。
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { loadConfig } from '../core/config.js';
import { FixtureProfilerSession, type ProfileNode } from '../tasks/profiler.js';
import type { StoryStore } from '../core/store.js';

export const DEFAULT_TIMEOUT_MS = 180000;

export interface CaseResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs: number;
  trace?: ProfileNode[];
}

export interface FixtureResult {
  file: string;
  cases: CaseResult[];
  allPassed: boolean;
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** $file 占位符替换为编译后 .js 路径 */
export function resolveFilePlaceholder(execute: string, file: string, root: string): string {
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
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)),
  ]);
}

/** 递归 deep equal — 顺序无关（object key 不依赖插入顺序） */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/**
 * B-5010 CHK-001: 对象 subset 匹配。actual 必须包含 expect 的每个键且值相等
 * （递归进入嵌套对象时同样 subset 语义；数组仍然严格 deep equal；原始值严格相等）。
 * 允许 actual 含有 expect 之外的字段，这样 execute return 可以放调试信息而不
 * 导致 case fail。
 */
function subsetMatch(actual: unknown, expect: unknown): boolean {
  // 原始值或 null：严格相等。
  if (expect === null || typeof expect !== 'object') return actual === expect;
  // 数组：sequence 语义严格相等（不做 subset，避免漏掉元素 silently pass）。
  if (Array.isArray(expect)) return deepEqual(actual, expect);
  // 对象：actual 也得是非 null 对象且非数组。
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const ao = actual as Record<string, unknown>;
  const eo = expect as Record<string, unknown>;
  for (const k of Object.keys(eo)) {
    if (!Object.prototype.hasOwnProperty.call(ao, k)) return false;
    if (!subsetMatch(ao[k], eo[k])) return false;
  }
  return true;
}

/**
 * expect 匹配。三种模式：
 *   1. `{pattern: "regex"}` — 把 actual 字符串化后做正则匹配（旧行为）
 *   2. 对象 — **subset match**（B-5010 CHK-001 新语义）：actual 必须包含 expect
 *      的所有键且值相等；actual 可含额外字段而不 fail，方便 execute return
 *      里放调试信息
 *   3. 原始值 / 数组 — 严格 deep equal（旧行为）
 *
 * 向后兼容：旧 fixture 里所有 expect 字段都能被 actual 精确匹配的 case 仍然 pass；
 * 新行为只对"actual 多字段"的场景变成 pass（原本会 fail）。
 */
export function matchExpect(actual: unknown, expect: unknown): { passed: boolean; error?: string } {
  const exp = expect as Record<string, unknown>;
  if (exp && typeof exp === 'object' && !Array.isArray(exp) && 'pattern' in exp) {
    const regex = new RegExp(exp.pattern as string);
    const testStr = typeof actual === 'string' ? actual : JSON.stringify(actual);
    if (regex.test(testStr)) return { passed: true };
    return { passed: false, error: `Pattern /${exp.pattern}/ did not match: ${typeof testStr === 'string' ? testStr.slice(0, 200) : testStr}` };
  }
  // 对象 subset 匹配 / 数组 / 原始值 走 subsetMatch（内部决定严格或子集）
  if (subsetMatch(actual, expect)) return { passed: true };
  return { passed: false, error: `Expected ${JSON.stringify(expect)}, got ${JSON.stringify(actual)}` };
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

export function validateSandbox(execute: string): string | null {
  for (const { pattern, msg } of SANDBOX_BLOCKED_PATTERNS) {
    if (pattern.test(execute)) return msg;
  }
  return null;
}

/** 执行单条 case 的 execute 函数体。execute 中可用 $handlers、$root、$ctx、$testStory */
export async function runCase(
  c: any,
  root: string,
  handlers: Record<string, Function>,
  sharedCtx: Record<string, unknown>,
  profilerSession: FixtureProfilerSession | null,
  testStoryFactory?: Function,
  currentCaseIds?: Set<string>,
): Promise<CaseResult> {
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
    const BLOCKED_IN_CASE = ['test_auto', 'test_story'];
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
        // B-5010 CHK-001: 失败时附带 case.debug 字段（执行期产生的辅助诊断信息）
        let error = r.error;
        if (!r.passed && c.debug !== undefined) {
          try { error = `${error}\n  debug: ${JSON.stringify(c.debug)}`; } catch { /* ignore */ }
        }
        result = { name: c.name, passed: r.passed, error, durationMs };
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

// ─── case 拓扑 / 查找 ────────────────────────────────────────────────────────

/** CHK-003: 构建链拓扑 — 将 cases 分为独立 case 和链式 case 组 */
export function buildChainGroups(cases: any[]): { chains: any[][]; standalone: any[] } {
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
export function findCaseById(fixturesDir: string, fixtureId: string): { filePath: string; fileName: string; cases: any[]; targetCase: any } | null {
  for (const fp of scanFixtureFiles(fixturesDir)) {
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

/** 在 fixture 文件中按 name 查找 case（用于获取 _id） */
export function findCaseByName(fixturesDir: string, fileName: string, caseName: string): any | null {
  try {
    const fp = join(fixturesDir, fileName);
    const content = JSON.parse(readFileSync(fp, 'utf-8'));
    return (content.cases || []).find((c: any) => c.name === caseName) || null;
  } catch { return null; }
}

/** 扫描 fixture 目录，返回所有 .json 文件路径（跳过 .trace.json） */
export function scanFixtureFiles(fixturesDir: string): string[] {
  const files: string[] = [];
  if (!existsSync(fixturesDir)) return files;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { walk(join(dir, entry.name)); continue; }
      if (entry.name.endsWith('.json') && !entry.name.endsWith('.trace.json')) {
        files.push(join(dir, entry.name));
      }
    }
  };
  walk(fixturesDir);
  return files;
}

// ─── 隔离 handlers / 临时 story ──────────────────────────────────────────────

/**
 * 创建一组隔离的 handlers，专供 fixture runner 在子上下文里调用 $handlers.* 用。
 *
 * 通过 dynamic import 拿 createToolHandlers，避免 runtime 循环引用。
 */
export async function createIsolatedHandlers(root: string, log?: (msg: string) => void) {
  const { StoryStore } = await import('../core/store.js');
  const { createToolHandlers } = await import('../registry.js');
  const testStore = new StoryStore(root);
  const handlers = createToolHandlers(testStore, root, log) as Record<string, Function>;
  return { handlers, testStore };
}

/**
 * 工厂函数：创建一个 $testStory factory 闭包，用于 fixture case 在 execute 中
 * 申请临时 story（指定 phase / checklist）。所有创建的 storyId 会 push 进
 * tempStoryIds 数组供清理。
 */
export function createTempStoryFactory(
  handlers: Record<string, Function>,
  testStore: StoryStore,
  tempStoryIds: string[],
) {
  return async (opts: { phase?: string; checklist?: Array<{ id: string; title: string; status?: string }> } = {}) => {
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
}

/** 清理 fixture runner 创建的临时 story 目录 */
export function cleanupTempStories(root: string, tempStoryIds: string[]): void {
  for (const id of tempStoryIds) {
    try { rmSync(join(root, 'docs', 'story', 'actives', id), { recursive: true, force: true }); } catch {}
  }
}

/** 跑完一组 case 后清理 fixture 目录的未提交改动 */
export function cleanupFixtureDir(root: string, fixturesDirRel: string): void {
  try {
    execSync(`git restore "${fixturesDirRel}"`, { cwd: root, stdio: 'pipe' });
    execSync(`git clean -fd "${fixturesDirRel}"`, { cwd: root, stdio: 'pipe' });
  } catch { /* ignore */ }
}
