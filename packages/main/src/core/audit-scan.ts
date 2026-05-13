/**
 * audit-scan — 机械扫 CLAUDE.md 承诺 vs 实际 CLI 行为 drift（B-9bd9 CHK-001）。
 *
 * 三个 scanner 纯函数：
 *   - scanCommandDrift: 抽 `koala <cmd>` 命令名 → 跑 `koala <cmd> --help`，exit≠0 → drift
 *   - scanFlagDrift:    抽 `koala <cmd> ... --<flag>` → `koala <cmd> --help` 不含 → drift
 *   - scanPathDrift:    抽文档里的路径断言 → 全仓 grep → 找不到 → drift
 *
 * 所有 scanner 都是纯函数（输入 md 文本 + 仓根）；顶层 `runMechanicalAudit`
 * 聚合，返回 `{drifts, skipped}`。skipped 记录跑不起来的命令（ENOENT / 超时 /
 * 权限），不计入 drift，避免把 koala 自己没安装当成文档错误。
 */

import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkDocsDrift,
  DOCS_DRIFT_ALLOWLIST,
} from '../handlers/validate-docs-drift.js';

export interface DriftCandidate {
  sectionPath: string; // 例："CLAUDE.md#koala CLI 速查"
  symbol: string;      // 例："koala finding_cluster" / "--channel" / "foo/bar.json"
  driftType: 'missing-command' | 'missing-flag' | 'missing-path';
  severity: 'medium' | 'low';
  desc: string;        // 一行可读描述（finding desc 用）
  evidence: string;    // 证据（help 输出片段 / grep 缺失信息）
}

export interface SkippedEntry {
  sectionPath: string;
  symbol: string;
  driftType: 'missing-command' | 'missing-flag' | 'missing-path';
  reason: string; // "timeout" / "ENOENT" / ...
}

export interface AuditReport {
  drifts: DriftCandidate[];
  skipped: SkippedEntry[];
}

/** 内部：抽每行最近的一级 heading（"# " / "## " / "### " 等） */
function buildHeadingIndex(md: string): Array<{ line: number; heading: string }> {
  const out: Array<{ line: number; heading: string }> = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#{1,6}\s+(.+?)\s*$/);
    if (m) out.push({ line: i, heading: m[1] });
  }
  return out;
}

function headingFor(lineNo: number, headings: Array<{ line: number; heading: string }>): string {
  let last = '';
  for (const h of headings) {
    if (h.line <= lineNo) last = h.heading;
    else break;
  }
  return last;
}

/**
 * 命令名白名单——不是真的 koala 命令（文档里的关键字），扫到这些不发 drift。
 * help/status/init 都是真命令但不走 --help 检测（有专门 bin 入口或者会 hang）。
 */
const COMMAND_SCAN_IGNORE = new Set<string>([
  'help', 'init', 'status',
]);

/**
 * 明确 YAGNI 的命令白名单——CLAUDE.md 文本明确说明「为何不提供此 CLI」的命令。
 * 扫到这些不报 missing-command drift（是 false positive），记入 skipped with reason=explicit-yagni-whitelist。
 * 例：`koala audit_config_set`（packages/koala/CLAUDE.md 明确说明改 JSON 即可，不造命令）。
 */
const EXPLICIT_YAGNI_COMMANDS = new Set<string>([
  'audit_config_set',
]);

/**
 * scanCommandDrift: 从 md 里抽形如 `koala <cmd>` 的命令名；
 * 对每个不在 ignore 列表的，跑 `koala <cmd> --help`，exit≠0 → drift。
 *
 * 正则：\bkoala\s+([a-z][a-z0-9_]*)\b
 * 裸 koala（无参数）不抽；$(koala) 等表达式也不会误抽（前缀不是 $ 字母直连）。
 */
export function scanCommandDrift(
  md: string,
  mdPath: string,
  opts: { runHelp?: (cmd: string) => { ok: boolean; reason?: string; output?: string } } = {},
): { drifts: DriftCandidate[]; skipped: SkippedEntry[] } {
  const runHelp = opts.runHelp ?? defaultRunHelp;
  const headings = buildHeadingIndex(md);
  const lines = md.split('\n');
  const seen = new Set<string>();
  const drifts: DriftCandidate[] = [];
  const skipped: SkippedEntry[] = [];

  // 命令必须以字母或数字结尾，不允许裸 `story_` / `checklist_` 等前缀泛匹配
  const re = /\bkoala\s+([a-z](?:[a-z0-9_]*[a-z0-9])?)\b/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(line))) {
      const cmd = m[1];
      if (COMMAND_SCAN_IGNORE.has(cmd)) continue;
      if (seen.has(cmd)) continue;
      seen.add(cmd);
      const sectionPath = `${mdPath}#${headingFor(i, headings)}`;
      const symbol = `koala ${cmd}`;
      // 明确 YAGNI 的命令（CLAUDE.md 自己说明为何不提供此 CLI）→ 记 skipped 不报 drift
      if (EXPLICIT_YAGNI_COMMANDS.has(cmd)) {
        skipped.push({ sectionPath, symbol, driftType: 'missing-command', reason: 'explicit-yagni-whitelist' });
        continue;
      }
      const r = runHelp(cmd);
      if (r.ok) continue;
      if (r.reason && r.reason !== 'exit-nonzero') {
        // 跑不起来：ENOENT / timeout / 其他异常，记 skipped 不报 drift
        skipped.push({ sectionPath, symbol, driftType: 'missing-command', reason: r.reason });
        continue;
      }
      drifts.push({
        sectionPath,
        symbol,
        driftType: 'missing-command',
        severity: 'medium',
        desc: `CLAUDE.md 引用命令 \`koala ${cmd}\`，但 \`koala ${cmd} --help\` 非零退出（命令未注册或已删除）`,
        evidence: (r.output || '').slice(0, 400),
      });
    }
  }
  return { drifts, skipped };
}

/**
 * scanFlagDrift: 抽形如 `koala <cmd> [^\n]*--<flag>` 的 flag 断言；
 * 对每对 <cmd, flag> 跑 `koala <cmd> --help`，输出不含 `--<flag>` → drift。
 *
 * 注意：只扫 code fence / inline code 里的 flag，避免把"带 --json 选项"这种散文误抽。
 * 简化：直接用正则扫全文（文档 flag 一般都在 bash 片段里）。
 */
export function scanFlagDrift(
  md: string,
  mdPath: string,
  opts: { runHelp?: (cmd: string) => { ok: boolean; reason?: string; output?: string } } = {},
): { drifts: DriftCandidate[]; skipped: SkippedEntry[] } {
  const runHelp = opts.runHelp ?? defaultRunHelp;
  const headings = buildHeadingIndex(md);
  const lines = md.split('\n');
  const seen = new Set<string>(); // "cmd|flag"
  const drifts: DriftCandidate[] = [];
  const skipped: SkippedEntry[] = [];
  const helpCache = new Map<string, { ok: boolean; reason?: string; output?: string }>();

  // 单行可能出现多个 flag：`koala validate --full --json`
  const cmdRe = /\bkoala\s+([a-z](?:[a-z0-9_]*[a-z0-9])?)\b([^\n`]*)/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let cm: RegExpExecArray | null;
    cmdRe.lastIndex = 0;
    while ((cm = cmdRe.exec(line))) {
      const cmd = cm[1];
      if (COMMAND_SCAN_IGNORE.has(cmd)) continue;
      const tail = cm[2] || '';
      const flagRe = /--([a-z][a-z0-9-]*)/g;
      let fm: RegExpExecArray | null;
      while ((fm = flagRe.exec(tail))) {
        const flag = fm[1];
        const key = `${cmd}|${flag}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sectionPath = `${mdPath}#${headingFor(i, headings)}`;
        const symbol = `koala ${cmd} --${flag}`;
        let r = helpCache.get(cmd);
        if (!r) {
          r = runHelp(cmd);
          helpCache.set(cmd, r);
        }
        if (!r.ok) {
          // help 跑不起来（命令本身不存在 / 超时）：不在这里报 flag drift
          // scanCommandDrift 已经报过 missing-command，这里只记 skipped 一笔
          skipped.push({ sectionPath, symbol, driftType: 'missing-flag', reason: r.reason || 'help-not-runnable' });
          continue;
        }
        const output = r.output || '';
        // 简单包含搜索：--<flag> 出现即算存在
        if (output.includes(`--${flag}`)) continue;
        drifts.push({
          sectionPath,
          symbol,
          driftType: 'missing-flag',
          severity: 'medium',
          desc: `CLAUDE.md 引用 \`koala ${cmd} --${flag}\`，但 help 输出不含 \`--${flag}\` 参数`,
          evidence: output.slice(0, 400),
        });
      }
    }
  }
  return { drifts, skipped };
}

/**
 * scanPathDrift: 从 md 里抽文档断言的文件路径，仓内 grep string literal 找不到 → drift（low）。
 *
 * 两种句式：
 *   1. 单独一个 a/b/c.{json|md|ts|js|py} 形式的相对路径
 *   2. "写入 <path>" / "存储于 <path>" / "存储位置：<path>"
 *
 * grep 策略：fs.existsSync 判文件实际存在；若不存在再 grep 全仓源代码（字符串字面量）。
 * 两者都失败 → drift。noise control：忽略路径自身以 "docs/story/" 开头（story 自己的路径不该被审计）。
 */
export function scanPathDrift(
  md: string,
  mdPath: string,
  repoRoot: string,
  opts: { grepLiteral?: (literal: string) => boolean; pathExists?: (abs: string) => boolean } = {},
): { drifts: DriftCandidate[]; skipped: SkippedEntry[] } {
  const headings = buildHeadingIndex(md);
  const lines = md.split('\n');
  const seen = new Set<string>();
  const drifts: DriftCandidate[] = [];
  const skipped: SkippedEntry[] = [];

  const grep = opts.grepLiteral ?? ((literal: string) => defaultGrepLiteral(literal, repoRoot));
  const pathExists = opts.pathExists ?? ((abs: string) => {
    try { return existsSync(abs); } catch { return false; }
  });

  // 句式 1：纯路径断言 a/b/c.ext
  const pathRe = /(?<![\w./-])((?:[a-z0-9][a-z0-9-_]*\/){1,}[a-z0-9][a-z0-9-_.]*\.(?:json|md|ts|js|py))/gi;
  // 句式 2：中文"写入 <path>" / "存储于 <path>" / "存储位置：<path>"
  const cnRe = /(?:写入|存储于|存储位置[:：]|路径[:：])\s*([a-zA-Z0-9./_\-]+\.(?:json|md|ts|js|py))/g;

  const collect = (p: string, lineNo: number) => {
    if (seen.has(p)) return;
    seen.add(p);
    // 忽略 story 自身产物路径（audit 不审 story 内产物）
    if (p.startsWith('docs/story/')) return;
    // 忽略明显是模板占位（含大写 X 或中文）
    if (/[A-Z]{3,}/.test(p)) return;

    const sectionPath = `${mdPath}#${headingFor(lineNo, headings)}`;
    const symbol = p;

    let exists = false;
    try {
      exists = pathExists(join(repoRoot, p));
    } catch {/* pass */}
    if (exists) return;

    let inCode = false;
    try {
      inCode = grep(p);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      skipped.push({ sectionPath, symbol, driftType: 'missing-path', reason: msg || 'grep-failed' });
      return;
    }
    if (inCode) return;

    drifts.push({
      sectionPath,
      symbol,
      driftType: 'missing-path',
      severity: 'low',
      desc: `CLAUDE.md 提到路径 \`${p}\` 但仓内文件不存在且无 string literal 引用`,
      evidence: `path not found at <repo>/${p}, no grep hit in source`,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    pathRe.lastIndex = 0;
    while ((m = pathRe.exec(line))) collect(m[1], i);
    cnRe.lastIndex = 0;
    while ((m = cnRe.exec(line))) collect(m[1], i);
  }
  return { drifts, skipped };
}

/**
 * runMechanicalAudit: 顶层聚合 scanner。
 *
 * 读 mdPaths（绝对路径数组），分别跑三个 scanner，合并 drifts/skipped。
 * mdPath 在 sectionPath 里以相对 repoRoot 的形式呈现（稳定 driftHash）。
 */
export function runMechanicalAudit(
  mdPaths: string[],
  repoRoot: string,
  opts: {
    runHelp?: (cmd: string) => { ok: boolean; reason?: string; output?: string };
    grepLiteral?: (literal: string) => boolean;
    pathExists?: (abs: string) => boolean;
    /** B-805f CHK-003: registry 命令名集合，提供时追加 docs-drift 纯函数对比（advisory） */
    registryNames?: Set<string>;
  } = {},
): AuditReport {
  const drifts: DriftCandidate[] = [];
  const skipped: SkippedEntry[] = [];

  for (const abs of mdPaths) {
    let md = '';
    try { md = readFileSync(abs, 'utf-8'); } catch { continue; }
    const rel = relPath(abs, repoRoot);

    const c = scanCommandDrift(md, rel, { runHelp: opts.runHelp });
    drifts.push(...c.drifts);
    skipped.push(...c.skipped);

    const f = scanFlagDrift(md, rel, { runHelp: opts.runHelp });
    drifts.push(...f.drifts);
    skipped.push(...f.skipped);

    const p = scanPathDrift(md, rel, repoRoot, { grepLiteral: opts.grepLiteral, pathExists: opts.pathExists });
    drifts.push(...p.drifts);
    skipped.push(...p.skipped);
  }

  // B-805f CHK-003: docs-drift registry-based scan (advisory, dedup vs scanCommandDrift)
  if (opts.registryNames && mdPaths.length > 0) {
    const allMd = mdPaths.map(abs => {
      try { return readFileSync(abs, 'utf-8'); } catch { return ''; }
    }).join('\n');
    const result = checkDocsDrift(allMd, opts.registryNames, DOCS_DRIFT_ALLOWLIST);
    for (const cmd of result.missing) {
      const alreadyCaught = drifts.some(d => d.symbol === `koala ${cmd}` && d.driftType === 'missing-command');
      if (!alreadyCaught) {
        drifts.push({
          sectionPath: 'docs-drift-registry',
          symbol: `koala ${cmd}`,
          driftType: 'missing-command',
          severity: 'low',
          desc: `CLAUDE.md 引用 \`koala ${cmd}\` 但 registry 无此命令（docs-drift advisory）`,
          evidence: 'registry.list() 不含此命令',
        });
      }
    }
  }

  return { drifts, skipped };
}

/** 默认 runHelp：调 `koala <cmd> --help`，2 秒超时。 */
function defaultRunHelp(cmd: string): { ok: boolean; reason?: string; output?: string } {
  try {
    const out = execFileSync('koala', [cmd, '--help'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: out };
  } catch (e: unknown) {
    const err = e as { code?: string; signal?: string; killed?: boolean; status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    if (err?.code === 'ENOENT') return { ok: false, reason: 'ENOENT' };
    if (err?.signal === 'SIGTERM' || err?.killed) return { ok: false, reason: 'timeout' };
    // koala 主入口通常把 stderr 当 help 输出
    const merged = (err?.stdout?.toString?.() || '') + (err?.stderr?.toString?.() || '');
    if (err?.status === 0) return { ok: true, output: merged };
    return { ok: false, reason: 'exit-nonzero', output: merged };
  }
}

/** 默认 grepLiteral：用 `git grep -F` 搜字符串字面量，不限文件类型。 */
function defaultGrepLiteral(literal: string, repoRoot: string): boolean {
  try {
    execSync(`git grep -F -l -- ${JSON.stringify(literal)}`, {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch (e: unknown) {
    const err = e as { status?: number };
    // git grep exit 1 = no match；其它 code 视为 grep 失败（往上抛会被 scanPathDrift 接住记 skipped）
    if (err?.status === 1) return false;
    if (err?.status === 0) return true;
    throw e;
  }
}

function relPath(abs: string, repoRoot: string): string {
  if (abs.startsWith(repoRoot + '/')) return abs.slice(repoRoot.length + 1);
  if (abs === repoRoot) return '.';
  return abs;
}
