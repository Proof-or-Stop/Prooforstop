/**
 * Fixture runner shared kernel — reused by the three handlers test_auto / test_story / test_fixture.
 *
 * Only pure functions and factory functions go here; no handlers are attached directly. All state is passed in via parameters; the upper-layer handler
 * decides how to scan files, group, write bugs, and write evidence.
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { loadConfig } from '../core/config.js';
import { FixtureProfilerSession, type ProfileNode } from '../tasks/profiler.js';
import type { StoryStore } from '../core/store.js';
import { getFixtureExecutor, isExecutableCase } from './fixture-executors.js';

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

/** $file placeholder is replaced with the compiled .js path */
export function resolveFilePlaceholder(execute: string, file: string, root: string): string {
  const config = loadConfig(root);
  const outDir = config.outDir || 'dist';
  const relPath = file.replace(/\.ts$/, '') + '.js';
  let jsPath = join(root, outDir, relPath);
  // fallback: dist may not exist under the worktree, try looking it up from git toplevel
  if (!existsSync(jsPath)) {
    const gitCwd = root;
    try {
      const toplevel = execSync('git rev-parse --show-toplevel', { cwd: gitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      const fallback = join(toplevel, outDir, relPath);
      if (existsSync(fallback)) jsPath = fallback;
    } catch { /* not a git repo, use original path */ }
  }
  const jsUrl = pathToFileURL(jsPath).href;
  return execute.replace(/\$file/g, jsUrl);
}

/** Promise timeout wrapper */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)),
  ]);
}

/** Recursive deep equal — order-independent (object keys do not depend on insertion order) */
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
 * B-5010 CHK-001: object subset matching. actual must contain every key of expect with equal values
 * (subset semantics also apply recursively to nested objects; arrays still use strict deep equal; primitives use strict equality).
 * actual is allowed to have fields beyond what expect specifies, so that the execute return can include debug info without
 * causing the case to fail.
 */
function subsetMatch(actual: unknown, expect: unknown): boolean {
  // Primitive value or null: strict equality.
  if (expect === null || typeof expect !== 'object') return actual === expect;
  // Array: strict equality with sequence semantics (no subset, to avoid silently passing when elements are missing).
  if (Array.isArray(expect)) return deepEqual(actual, expect);
  // Object: actual must also be a non-null object and not an array.
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
 * expect matching. Three modes:
 *   1. `{pattern: "regex"}` — stringify actual and perform regex matching (legacy behavior)
 *   2. Object — **subset match** (B-5010 CHK-001 new semantics): actual must contain
 *      all keys of expect with equal values; actual may contain additional fields without failing, convenient for putting debug info
 *      in the execute return
 *   3. Primitive value / array — strict deep equal (legacy behavior)
 *
 * Backward compatibility: cases in old fixtures where all expect fields can be exactly matched by actual still pass;
 * The new behavior only turns "actual has extra fields" scenarios into pass (which would have failed before).
 */
export function matchExpect(actual: unknown, expect: unknown): { passed: boolean; error?: string } {
  const exp = expect as Record<string, unknown>;
  if (exp && typeof exp === 'object' && !Array.isArray(exp) && 'pattern' in exp) {
    const regex = new RegExp(exp.pattern as string);
    const testStr = typeof actual === 'string' ? actual : JSON.stringify(actual);
    if (regex.test(testStr)) return { passed: true };
    return { passed: false, error: `Pattern /${exp.pattern}/ did not match: ${typeof testStr === 'string' ? testStr.slice(0, 200) : testStr}` };
  }
  // Object subset match / array / primitive value go through subsetMatch (which internally decides strict or subset)
  if (subsetMatch(actual, expect)) return { passed: true };
  return { passed: false, error: `Expected ${JSON.stringify(expect)}, got ${JSON.stringify(actual)}` };
}

/** Forbidden execute patterns — prevent agents from bypassing the sandbox via fs/child_process */
const SANDBOX_BLOCKED_PATTERNS = [
  { pattern: /\bimport\s*\(\s*["']fs["']/, msg: 'import("fs") is forbidden, use $handlers for file operations' },
  { pattern: /\bimport\s*\(\s*["']node:fs["']/, msg: 'import("node:fs") is forbidden, use $handlers for file operations' },
  { pattern: /\bimport\s*\(\s*["']child_process["']/, msg: 'import("child_process") is forbidden' },
  { pattern: /\bimport\s*\(\s*["']node:child_process["']/, msg: 'import("node:child_process") is forbidden' },
  { pattern: /\brequire\s*\(\s*["']fs["']/, msg: 'require("fs") is forbidden, use $handlers for file operations' },
  { pattern: /\brequire\s*\(\s*["']child_process["']/, msg: 'require("child_process") is forbidden' },
];

export function validateSandbox(execute: string): string | null {
  for (const { pattern, msg } of SANDBOX_BLOCKED_PATTERNS) {
    if (pattern.test(execute)) return msg;
  }
  return null;
}

export { isExecutableCase };

/** Body of the execute function for running a single case. $handlers, $root, $ctx, $testStory are available inside execute */
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
    // CHK-004: start profiling via shared fixture-level session
    if (profilerSession) {
      try { await profilerSession.startCase(); } catch { /* non-fatal */ }
    }

    const executor = getFixtureExecutor(c);
    if (!executor) {
      return { name: c.name, passed: false, error: 'fixture case is missing a usable executor (requires executor/execute/command)', durationMs: Date.now() - start };
    }
    const execute = () => executor.run(c, {
      root,
      handlers,
      sharedCtx,
      testStoryFactory,
      currentCaseIds,
      resolveFilePlaceholder,
      validateSandbox,
      withTimeout,
      timeoutMs: typeof c.timeoutMs === 'number' ? c.timeoutMs : DEFAULT_TIMEOUT_MS,
    });

    let result: CaseResult;

    if (c.throws) {
      let threw = false;
      let thrownError = '';
      try {
        await execute();
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
      const actual = await execute();
      const durationMs = Date.now() - start;
      if (c.expect !== undefined) {
        const r = matchExpect(actual, c.expect);
        // B-5010 CHK-001: attach case.debug field on failure (auxiliary diagnostic info produced during execution)
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

// ─── case topology / lookup ────────────────────────────────────────────────────────

/** CHK-003: build chain topology — split cases into standalone cases and chained case groups */
export function buildChainGroups(cases: any[]): { chains: any[][]; standalone: any[] } {
  const byId = new Map<string, any>();
  for (const c of cases) { if (c._id) byId.set(c._id, c); }

  const visited = new Set<string>();
  const chains: any[][] = [];
  const standalone: any[] = [];

  for (const c of cases) {
    if (!c._id) { standalone.push(c); continue; }
    if (visited.has(c._id)) continue;

    // No chain relationship → standalone
    if (!c.prevCaseId && !c.nextCaseId) { standalone.push(c); visited.add(c._id); continue; }

    // Find the chain head (no prevCaseId or prev is not in the current set)
    let head = c;
    const seen = new Set<string>();
    while (head.prevCaseId && byId.has(head.prevCaseId) && !seen.has(head.prevCaseId)) {
      seen.add(head._id);
      head = byId.get(head.prevCaseId)!;
    }

    // Walk the entire chain along nextCaseId
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

/** CHK-006: look up a case by _id across all fixtures and return the fixture info it belongs to */
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

/** Look up a case by name in a fixture file (used to obtain _id) */
export function findCaseByName(fixturesDir: string, fileName: string, caseName: string): any | null {
  try {
    const fp = join(fixturesDir, fileName);
    const content = JSON.parse(readFileSync(fp, 'utf-8'));
    return (content.cases || []).find((c: any) => c.name === caseName) || null;
  } catch { return null; }
}

/** Scan the fixture directory and return all .json file paths (skipping .trace.json) */
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

// ─── Isolated handlers / temporary stories ──────────────────────────────────────────────

/**
 * Creates a set of isolated handlers, dedicated for the fixture runner to call $handlers.* within sub-contexts.
 *
 * Obtains createToolHandlers via dynamic import to avoid runtime circular references.
 */
export async function createIsolatedHandlers(root: string, log?: (msg: string) => void) {
  const { StoryStore } = await import('../core/store.js');
  const { createToolHandlers } = await import('../registry.js');
  const testStore = new StoryStore(root);
  const handlers = createToolHandlers(testStore, root, log) as Record<string, Function>;
  return { handlers, testStore };
}

/**
 * Factory function: creates a $testStory factory closure for fixture cases to use in execute to
 * request temporary stories (specifying phase / checklist). All created storyIds are pushed into
 * the tempStoryIds array for cleanup.
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

/** Clean up the temporary story directories created by the fixture runner */
export function cleanupTempStories(root: string, tempStoryIds: string[]): void {
  const cfg = loadConfig(root);
  for (const id of tempStoryIds) {
    try { rmSync(join(root, cfg.storyDir, id), { recursive: true, force: true }); } catch {}
    try { rmSync(join(root, cfg.storyDir, id), { recursive: true, force: true }); } catch {}
  }
}

/** Clean up uncommitted changes in the fixture directory after running a group of cases */
export function cleanupFixtureDir(root: string, fixturesDirRel: string): void {
  try {
    execSync(`git restore "${fixturesDirRel}"`, { cwd: root, stdio: 'pipe' });
    execSync(`git clean -fd "${fixturesDirRel}"`, { cwd: root, stdio: 'pipe' });
  } catch { /* ignore */ }
}
