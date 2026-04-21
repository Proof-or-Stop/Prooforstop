/**
 * validate-lint — CLI gate: tsc + ruff + import-graph 边界
 *
 * koala validate 默认在 spawn validate.ts 前先跑三类 lint；任一 fail 则整体 fail
 * 并提前返回不 spawn。工具不可用（tsc 缺失、ruff 未安装）或对应配置文件不存在
 * → 该子检查 skipped，整体不因此 fail（graceful degrade）。
 *
 * 三类子检查：
 *   (a) tsc --noEmit        — 若 projectRoot/tsconfig.json 存在
 *   (b) ruff check          — 若 projectRoot/pyproject.toml 存在且 ruff 可用
 *   (c) import-graph 边界    — 扫 src/shells/**\/*.ts，禁止 import 任何 `.../fn` 或 `.../fn.js`
 *
 * 输出结构：
 *   {
 *     provider: "koala-lint",
 *     status: "pass" | "fail" | "skipped",
 *     summary: string,
 *     details: string[],
 *     checks: {
 *       tsc?: { status, output? },
 *       ruff?: { status, output? },
 *       importGraph?: { status, violations: { file, line, importee }[] }
 *     }
 *   }
 *
 * 参考 docs/koala/reviewer-redesign.md §三 S1 第 3 条。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// B-5a28 CHK-002: 递归扫 tsconfig 时跳过的目录。抽为常量便于测试覆盖 +
// 后续 story 按需扩展。不含通用 IDE/editor 目录（.idea / .vscode 不会有
// tsconfig 污染）。`.worktrees` 避免 sub-agent 在自己的 worktree 里又扫到
// 其他 story 的 worktree（自递归）。
export const TSCONFIG_IGNORE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  '.worktrees',
  '.git',
]);

// LintSubStatus / TscCheck / RuffCheck / ImportGraphViolation /
// ImportGraphCheck / LintChecks are internal shapes consumed only by
// this module and its tests — kept non-exported per F-005 (tests import
// from this file directly, not from the package boundary). Downstream
// callers (review-preflight.ts) only need LintResult / CommandRunner /
// FileExists / FileReader, which remain exported.
type LintSubStatus = 'pass' | 'fail' | 'skipped';

interface TscCheck {
  status: LintSubStatus;
  /** 工具报错/输出片段（skip 时可缺省） */
  output?: string;
}

interface RuffCheck {
  status: LintSubStatus;
  output?: string;
}

interface ImportGraphViolation {
  file: string;
  line: number;
  importee: string;
}

interface ImportGraphCheck {
  status: LintSubStatus;
  violations: ImportGraphViolation[];
}

interface LintChecks {
  tsc?: TscCheck;
  ruff?: RuffCheck;
  importGraph?: ImportGraphCheck;
}

export interface LintResult {
  provider: 'koala-lint';
  status: LintSubStatus;
  summary: string;
  details: string[];
  checks: LintChecks;
}

// ── 依赖注入 ──

export interface CommandRunner {
  /**
   * 执行命令，返回 { code, output, spawnError }。
   * spawnError=true 表示 binary 不存在（ENOENT）——调用方应把这类视为 skipped。
   */
  (cmd: string, args: string[], cwd: string): {
    code: number;
    output: string;
    spawnError: boolean;
  };
}

const defaultRunner: CommandRunner = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
    shell: false,
  });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { code: -1, output: r.error.message, spawnError: true };
    }
    return { code: r.status ?? 1, output: (r.stdout ?? '') + (r.stderr ?? '') + r.error.message, spawnError: false };
  }
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  return { code: r.status ?? 1, output: out, spawnError: false };
};

/** 文件枚举器（测试可注入） */
export type FileReader = (filePath: string) => string;
export type FileExists = (filePath: string) => boolean;

// ── tsc ──

/**
 * B-5a28 CHK-002: 递归枚举 projectRoot 下所有 tsconfig.json。
 *
 * 为什么递归：monorepo 子包（如 packages/koala/packages/main/tsconfig.json）
 * 的编译错误被单根扫描漏掉——整个 koala 包 TS2451 编译错误在 B-9bd9 / B-9d95
 * 两个 story DONE 后才被独立 sonnet reviewer 发现。根因是旧 runTsc 写死
 * `<projectRoot>/tsconfig.json`，avalon 根无 tsconfig.json → skipped → 永远
 * 看不到子包错误。
 *
 * 排除 TSCONFIG_IGNORE_DIRS（node_modules / dist / build / .worktrees / .git），
 * 否则会扫进依赖里的 tsconfig 或相邻 worktree 的副本。
 *
 * **F-005 symlink 防护**：默认用 `lstatSync`（不跟随 symlink），并一律跳过
 * symlink 目录。理由：npm link / pnpm / workspace protocol 场景下 node_modules
 * 下常有 symlink 指回仓库根或其它 package 目录，若 stat() 跟随这些链接，
 * TSCONFIG_IGNORE_DIRS 的名字匹配只剪「叫 node_modules 的目录」而管不到「经
 * symlink 到达的 node_modules 目标」，会导致无限递归 / 栈无限增长。跳过
 * symlink 比 visited realpath Set 更简单且零误伤（需要扫 symlink 到的目标
 * 是极少见的边缘需求，当真需要再补 followSymlinks 开关）。
 *
 * 返回**绝对路径数组**（依赖 fileExists 判目录存在；readdir/stat 允许注入便于
 * 单测 fixture 化）。失败路径（stat/readdir 抛错）静默跳过，不 fail 整个扫描。
 *
 * **签名**：`findTsconfigs(projectRoot, deps?: { readdir?, stat?, fileExists? })`。
 * 第二参是**依赖注入接口**（不是 options）——黑名单由模块级常量
 * TSCONFIG_IGNORE_DIRS 固定，扩展需改常量，不从调用方传入。
 */
export function findTsconfigs(
  projectRoot: string,
  deps?: {
    readdir?: (p: string) => string[];
    stat?: (p: string) => { isDirectory(): boolean; isFile(): boolean; isSymbolicLink?(): boolean };
    fileExists?: FileExists;
  },
): string[] {
  const readdir = deps?.readdir ?? ((p) => readdirSync(p));
  // F-005: 默认用 lstat（不跟随 symlink），同时保留 deps.stat 注入接口；
  // 注入的 stat 也应提供 isSymbolicLink() 以便同样跳过软链（测试可省略）。
  const stat = deps?.stat ?? ((p) => lstatSync(p));
  const fileExists = deps?.fileExists ?? existsSync;
  try {
    if (!fileExists(projectRoot)) return [];
  } catch {
    return [];
  }
  const out: string[] = [];
  const stack: string[] = [projectRoot];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdir(dir); } catch { continue; }
    for (const e of entries) {
      if (TSCONFIG_IGNORE_DIRS.has(e)) continue;
      const full = join(dir, e);
      let s: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink?(): boolean };
      try { s = stat(full); } catch { continue; }
      // F-005: symlink 一律跳过，防止 npm link 指向仓库根 / 其它包造成的无限递归。
      if (typeof s.isSymbolicLink === 'function' && s.isSymbolicLink()) continue;
      if (s.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!s.isFile()) continue;
      if (e === 'tsconfig.json') out.push(full);
    }
  }
  // 稳定排序便于测试断言 + 失败输出可读
  out.sort();
  return out;
}

/**
 * Run `npx tsc --noEmit -p <tsconfigPath>` for a single tsconfig.
 *
 * 返回值：
 *   - { kind: 'pass' }
 *   - { kind: 'fail', output }
 *   - { kind: 'toolMissing', output } —— 工具（tsc / npx）都不可用
 */
function runSingleTsc(
  tsconfigPath: string,
  cwd: string,
  run: CommandRunner,
): { kind: 'pass' } | { kind: 'fail'; output: string } | { kind: 'toolMissing'; output: string } {
  const attempts: Array<{ cmd: string; args: string[] }> = [
    { cmd: 'npx', args: ['--no-install', 'tsc', '--noEmit', '-p', tsconfigPath] },
    { cmd: 'tsc', args: ['--noEmit', '-p', tsconfigPath] },
  ];
  let lastOutput = '';
  for (const { cmd, args } of attempts) {
    const r = run(cmd, args, cwd);
    if (r.spawnError) {
      lastOutput = r.output;
      continue;
    }
    // F-018: npx exit 非 0 + "could not determine executable" 这类输出视为工具缺失
    if (isNpxToolNotFound(r.output)) {
      lastOutput = r.output;
      continue;
    }
    return r.code === 0
      ? { kind: 'pass' }
      : { kind: 'fail', output: r.output.trim() };
  }
  return { kind: 'toolMissing', output: lastOutput };
}

/**
 * B-5a28 CHK-002: 递归扫 projectRoot 下所有 tsconfig.json 并逐个 `tsc --noEmit -p`。
 *
 * 整体规则：
 *   - 空结果（无任何 tsconfig）→ skipped，output='no tsconfig.json found'
 *   - 任一工具缺失导致无法跑任何 tsc → skipped，output='tsc not found: ...'
 *     （即第一个 tsconfig 就 toolMissing，后续的也必然同样 —— 直接短路）
 *   - 任一 tsconfig fail → 整体 fail；output 汇总所有失败 tsconfig 的
 *     路径 + 编译器输出，以便人眼和 cluster reviewer 定位
 *   - 全部 pass → 整体 pass，output='tsc: checked N tsconfigs'
 *     （格式固定为 "tsc: checked N tsconfigs"，N=扫到的 tsconfig 数量）
 *
 * 接口不变：仍接受 projectRoot + 可选 run/fileExists；额外接受 readdir/stat
 * 注入给 findTsconfigs，便于 CHK-003 单测不真扫磁盘。
 */
export function runTsc(deps: {
  projectRoot: string;
  run?: CommandRunner;
  fileExists?: FileExists;
  readdir?: (p: string) => string[];
  stat?: (p: string) => { isDirectory(): boolean; isFile(): boolean };
}): TscCheck {
  const run = deps.run ?? defaultRunner;
  const tsconfigs = findTsconfigs(deps.projectRoot, {
    readdir: deps.readdir,
    stat: deps.stat,
    fileExists: deps.fileExists,
  });
  if (tsconfigs.length === 0) {
    return { status: 'skipped', output: 'no tsconfig.json found' };
  }

  // F-007 / F-014: 显式追踪 passes 计数，别拿 fails.length === 0 当「没跑过」
  // 的代理条件。旧代码场景 [pass, pass, toolMissing] 会错误短路返回 skipped，
  // 吞掉所有前面 pass 的结果。正确语义：
  //   - 「一个 tsc 都没成功启动过」（passes=0 && fails=0）→ skipped
  //   - 「至少跑过一个」→ 后续任意 toolMissing 当 fail 记录（别无声吞）
  const fails: Array<{ path: string; output: string }> = [];
  let passes = 0;
  for (const tsconfig of tsconfigs) {
    const r = runSingleTsc(tsconfig, deps.projectRoot, run);
    if (r.kind === 'toolMissing') {
      // 工具缺失：只有「从未有过 pass 且从未有过 fail」时视为 skipped。
      if (passes === 0 && fails.length === 0) {
        return { status: 'skipped', output: `tsc not found: ${r.output}` };
      }
      // 前面已经有 pass 或 fail（证明工具能跑），后续突然 toolMissing 很怪，
      // 当成一个 fail 记录进去让人看到——别让 pass 被静默吞掉。
      fails.push({ path: tsconfig, output: `tsc tool missing: ${r.output}` });
      continue;
    }
    if (r.kind === 'fail') {
      fails.push({ path: tsconfig, output: r.output });
      continue;
    }
    // r.kind === 'pass'
    passes++;
  }

  if (fails.length > 0) {
    const header = `tsc: ${fails.length} of ${tsconfigs.length} tsconfig${tsconfigs.length === 1 ? '' : 's'} failed`;
    const body = fails.map(f => {
      const rel = relative(deps.projectRoot, f.path) || f.path;
      return `=== ${rel} ===\n${f.output}`;
    }).join('\n\n');
    return { status: 'fail', output: `${header}\n${body}` };
  }

  return { status: 'pass', output: `tsc: checked ${tsconfigs.length} tsconfigs` };
}

/**
 * F-018: detect `npx --no-install tsc` style "tool not found" output.
 *
 * npx 在目标工具不可用时会打印以下几种信息（不同版本略有不同）：
 *   - "npm ERR! could not determine executable to run"
 *   - "could not determine executable to run"
 *   - "npm ERR! 404 Not Found"
 *   - "npx: installed" / "npx: command not found"（旧版）
 *   - "npm error could not determine executable to run"（npm 10 之后）
 *
 * 这些都意味着 tsc 本身没装，与 tsc 编译失败（真实 lint fail）是两回事。
 */
export function isNpxToolNotFound(output: string): boolean {
  if (!output) return false;
  // 只匹配明确的 npx-找不到-工具 模式，避免把 tsc 真实 lint fail（如
  // "error TS2307: Cannot find module ..." 或包含 "not found" 的源码错误）
  // 误判为 skipped。这里的模式都是 npx/npm 本身输出的管理级错误。
  const patterns = [
    /could not determine executable to run/i,
    /npm\s+ERR!\s+404\s+not\s+found/i,
    /npm\s+error\s+404\s+not\s+found/i,
    /npx:\s+installed/i,
    /npx:\s+command not found/i,
    /npm\s+ERR!\s+code\s+E404/i,
  ];
  return patterns.some((re) => re.test(output));
}

// ── ruff ──

/**
 * Run `ruff check <projectRoot>`.
 * skipped 场景：pyproject.toml 不存在 or ruff 命令不可用。
 */
export function runRuff(deps: {
  projectRoot: string;
  run?: CommandRunner;
  fileExists?: FileExists;
}): RuffCheck {
  const fileExists = deps.fileExists ?? existsSync;
  const run = deps.run ?? defaultRunner;
  const pyproject = join(deps.projectRoot, 'pyproject.toml');
  if (!fileExists(pyproject)) {
    return { status: 'skipped', output: 'no pyproject.toml' };
  }
  const r = run('ruff', ['check', deps.projectRoot], deps.projectRoot);
  if (r.spawnError) {
    return { status: 'skipped', output: 'ruff not installed' };
  }
  return r.code === 0
    ? { status: 'pass' }
    : { status: 'fail', output: r.output.trim() };
}

// ── import-graph ──

/**
 * 判定某个 import 字符串是否违反 shells→fn 边界：
 *   - 路径的 basename 去掉 .js 扩展后恰为 "fn"
 *
 * 只匹配看起来像 core/fn 模块的 import，不会误伤 `from 'fastify'` 之类。
 */
export function isFnImport(importee: string): boolean {
  // strip surrounding whitespace
  const s = importee.trim();
  // last segment after /
  const lastSlash = s.lastIndexOf('/');
  const base = lastSlash >= 0 ? s.slice(lastSlash + 1) : s;
  // strip extension
  const name = base.endsWith('.js') ? base.slice(0, -3) : base.endsWith('.ts') ? base.slice(0, -3) : base;
  return name === 'fn';
}

/**
 * 扫描单个文件的 import 违规（按行号报告）。
 * 仅识别 static `import ... from '...'` / `export ... from '...'`，不扫动态 import()。
 */
export function scanImportsInFile(
  file: string,
  content: string,
): ImportGraphViolation[] {
  const out: ImportGraphViolation[] = [];
  const lines = content.split('\n');
  const re = /^\s*(?:import|export)\b[^'"`]*from\s*['"]([^'"]+)['"]/;
  // Single-line comment prefix (after leading whitespace). We intentionally
  // do NOT try to handle block comments `/* ... */` here — a proper lexer is
  // out of scope; the common false-positive was `// import ... from 'fn.js'`
  // appearing in docs/README snippets or commented-out code (F-012).
  const reLineComment = /^\s*\/\//;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (reLineComment.test(ln)) continue;
    const m = re.exec(ln);
    if (!m) continue;
    const importee = m[1];
    if (isFnImport(importee)) {
      out.push({ file, line: i + 1, importee });
    }
  }
  return out;
}

/**
 * 递归枚举 src/shells/ 下所有 .ts / .tsx 文件。
 * 目录不存在 → 返回 null（调用方视为 skipped）。
 */
export function listShellFiles(
  projectRoot: string,
  deps?: {
    readdir?: (p: string) => string[];
    stat?: (p: string) => { isDirectory(): boolean; isFile(): boolean };
    fileExists?: FileExists;
  },
): string[] | null {
  const shellsDir = join(projectRoot, 'src', 'shells');
  const readdir = deps?.readdir ?? ((p) => readdirSync(p));
  const stat = deps?.stat ?? ((p) => statSync(p));
  const fileExists = deps?.fileExists ?? existsSync;
  try {
    if (!fileExists(shellsDir)) return null;
  } catch {
    return null;
  }
  const out: string[] = [];
  const stack: string[] = [shellsDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdir(dir); } catch { continue; }
    for (const e of entries) {
      const full = join(dir, e);
      let s;
      try { s = stat(full); } catch { continue; }
      if (s.isDirectory()) { stack.push(full); continue; }
      if (!s.isFile()) continue;
      if (e.endsWith('.ts') || e.endsWith('.tsx')) out.push(full);
    }
  }
  return out;
}

/**
 * Run import-graph 边界检查：扫 src/shells/**\/*.ts，禁止 import 任何 fn/fn.js。
 * 空目录或 src/shells/ 不存在 → skipped（不 fail）。
 */
export function runImportGraph(deps: {
  projectRoot: string;
  readdir?: (p: string) => string[];
  stat?: (p: string) => { isDirectory(): boolean; isFile(): boolean };
  readFile?: FileReader;
  fileExists?: FileExists;
}): ImportGraphCheck {
  const readFile = deps.readFile ?? ((p) => readFileSync(p, 'utf-8'));
  const files = listShellFiles(deps.projectRoot, {
    readdir: deps.readdir,
    stat: deps.stat,
    fileExists: deps.fileExists,
  });
  if (files === null) {
    return { status: 'skipped', violations: [] };
  }
  if (files.length === 0) {
    return { status: 'skipped', violations: [] };
  }
  const violations: ImportGraphViolation[] = [];
  for (const f of files) {
    let content: string;
    try { content = readFile(f); } catch { continue; }
    const rel = relative(deps.projectRoot, f);
    for (const v of scanImportsInFile(rel, content)) {
      violations.push(v);
    }
  }
  return violations.length === 0
    ? { status: 'pass', violations: [] }
    : { status: 'fail', violations };
}

// ── main entry ──

export interface CheckLintDeps {
  projectRoot: string;
  /** 注入 command runner（测试用）*/
  run?: CommandRunner;
  /** 注入 fs helpers（测试用）*/
  fileExists?: FileExists;
  readFile?: FileReader;
  readdir?: (p: string) => string[];
  stat?: (p: string) => { isDirectory(): boolean; isFile(): boolean };
}

/**
 * 核心入口：跑三类 lint，汇总结果。
 *
 * 整体 status：
 *   - 任一子检查 fail → fail
 *   - 全部 skipped    → skipped
 *   - 其他（至少一个 pass，其余 skipped 或 pass）→ pass
 */
export function checkLint(deps: CheckLintDeps): LintResult {
  const tsc = runTsc({
    projectRoot: deps.projectRoot,
    run: deps.run,
    fileExists: deps.fileExists,
    readdir: deps.readdir,
    stat: deps.stat,
  });
  const ruff = runRuff({
    projectRoot: deps.projectRoot,
    run: deps.run,
    fileExists: deps.fileExists,
  });
  const importGraph = runImportGraph({
    projectRoot: deps.projectRoot,
    readdir: deps.readdir,
    stat: deps.stat,
    readFile: deps.readFile,
    fileExists: deps.fileExists,
  });

  const checks: LintChecks = { tsc, ruff, importGraph };
  const subs: Array<[string, LintSubStatus]> = [
    ['tsc', tsc.status],
    ['ruff', ruff.status],
    ['importGraph', importGraph.status],
  ];

  const details: string[] = [];
  for (const [name, status] of subs) {
    if (status === 'skipped') {
      const why =
        name === 'tsc' ? tsc.output ?? '' :
        name === 'ruff' ? ruff.output ?? '' :
        '';
      details.push(`[lint] skipped: ${name}${why ? ` (${why})` : ''}`);
    } else if (status === 'fail') {
      if (name === 'importGraph') {
        details.push(`[lint] fail: import-graph (${importGraph.violations.length} violation${importGraph.violations.length === 1 ? '' : 's'})`);
        for (const v of importGraph.violations) {
          details.push(`  ${v.file}:${v.line}  → ${v.importee}`);
        }
      } else {
        const out = name === 'tsc' ? tsc.output : ruff.output;
        details.push(`[lint] fail: ${name}`);
        if (out) {
          for (const line of out.split('\n').slice(0, 40)) {
            if (line.trim()) details.push(`  ${line}`);
          }
        }
      }
    } else {
      // B-5a28 CHK-002: tsc pass 时把 "tsc: checked N tsconfigs" 带出，
      // 让 `koala validate --lint` 输出能直接看到扫描了几个 tsconfig。
      const passOut =
        name === 'tsc' ? tsc.output ?? '' :
        '';
      details.push(`[lint] pass: ${name}${passOut ? ` (${passOut})` : ''}`);
    }
  }

  const anyFail = subs.some(([, s]) => s === 'fail');
  const allSkipped = subs.every(([, s]) => s === 'skipped');
  let status: LintSubStatus;
  let summary: string;
  if (anyFail) {
    status = 'fail';
    const failed = subs.filter(([, s]) => s === 'fail').map(([n]) => n).join(', ');
    summary = `lint fail: ${failed}`;
  } else if (allSkipped) {
    status = 'skipped';
    summary = 'all lint checks skipped (no tsconfig/pyproject, no shells/)';
  } else {
    status = 'pass';
    const passed = subs.filter(([, s]) => s === 'pass').map(([n]) => n).join(', ');
    const skipped = subs.filter(([, s]) => s === 'skipped').map(([n]) => n);
    summary = skipped.length > 0
      ? `lint pass: ${passed} (skipped: ${skipped.join(', ')})`
      : `lint pass: ${passed}`;
  }

  return {
    provider: 'koala-lint',
    status,
    summary,
    details,
    checks,
  };
}

/**
 * B-9d95 CHK-006: CLI entry for `koala validate --lint`.
 *
 * 不 spawn pytest / 不跑全量 validate.ts——直接调 checkLint，输出
 * 结构化结果 + 人类可读渲染。用于 REVIEW→TEST preflight 独立分流。
 *
 * 判定：
 *   - status=pass 或 skipped → ok
 *   - status=fail            → ok=false
 */
export interface LintCliResult {
  ok: boolean;
  result: LintResult;
  rendered: string;
}

export function runLintGateCli(deps: CheckLintDeps): LintCliResult {
  const result = checkLint(deps);
  const ok = result.status === 'pass' || result.status === 'skipped';
  return { ok, result, rendered: renderLintResult(result) };
}

/** 渲染 LintResult 为人类可读文本 */
export function renderLintResult(r: LintResult): string {
  const lines: string[] = [];
  const icon = r.status === 'pass' ? '✓' : r.status === 'skipped' ? '·' : '✗';
  lines.push(`[lint] ${icon} ${r.status}: ${r.summary}`);
  for (const d of r.details) lines.push(`  ${d}`);
  return lines.join('\n');
}
