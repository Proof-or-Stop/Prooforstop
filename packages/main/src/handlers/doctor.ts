/**
 * koala doctor — 输出最近 24 小时的 health issue（按 category 分组）
 *
 * 让用户能定期 `koala doctor` 检查 koala 自己有没有隐藏的 PERSIST 失败。
 * 之前这些失败被 silent catch 吞掉，事后无法回溯。
 *
 * B-7241 follow-up: `--repair` 模式扫 `.worktrees/` 下的孤儿目录
 * （git worktree list 里没有但目录还在的）并 rm -rf 清理。针对
 * DONE 合并后因为 activity.jsonl / tmp 运行时产物残留导致 git
 * worktree remove 静默只清 registry 不清目录的场景。
 */

import { execFileSync, execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import type { HandlerContext } from './context.js';
import { readHealthIssues, summarizeHealthIssues, getHealthPath } from '../core/health.js';
import { loadConfig } from '../core/config.js';
import { renderCodexAdapterChecks, runCodexAdapterChecks } from '../core/codex-adapter-checks.js';
import { formatValidationCommand } from '../core/validation-executor.js';
import { scanValidationSetup, type ValidationSetupScan } from './verifier.js';

export function createDoctorHandlers(ctx: HandlerContext) {
  const { root, store } = ctx;

  return {
    doctor(args?: { format?: 'text' | 'json'; limit?: number; repair?: boolean }): string | object {
      const limit = args?.limit ?? 1000;
      const issues = readHealthIssues(limit);
      const summary = summarizeHealthIssues(issues);
      const codex = runCodexAdapterChecks(root, {
        executeHeartbeats: true,
        registryNames: ctx.getAllToolNames?.(),
      });
      const validation = scanValidationSetup(root);

      // B-7241 follow-up: scan for orphan worktrees (directory exists but
      // `git worktree list` doesn't know about it). This typically happens
      // after a DONE merge when Claude Code's activity.jsonl hook or tmp/
      // runtime files kept file handles open during `git worktree remove`,
      // so git deregistered the worktree but left the dir behind.
      let orphanScan = scanOrphanWorktrees(root, store);
      const repaired: string[] = [];
      const repairFailed: Array<{ path: string; error: string }> = [];
      let cleanupTargets = collectWorktreeCleanupTargets(orphanScan);
      if (args?.repair && cleanupTargets.length > 0) {
        for (const target of cleanupTargets) {
          try {
            tryWorktreeRemove(root, target);
            removePathWithTimeout(target);
            removeStaleWorktreeAdminDirs(root, target);
            deleteTerminalStoryBranch(root, store, basename(target));
            if (existsSync(target)) {
              throw new Error('path still exists after rm -rf');
            }
            repaired.push(target);
          } catch (e: any) {
            markRepairIgnored(target, e.message || String(e));
            repairFailed.push({ path: target, error: e.message || String(e) });
          }
        }
        try {
          execFileSync('git', ['worktree', 'prune', '--expire', 'now'], {
            cwd: root,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch (e: any) {
          repairFailed.push({ path: '<git worktree prune>', error: e.message || String(e) });
        }
        orphanScan = scanOrphanWorktrees(root, store);
        cleanupTargets = collectWorktreeCleanupTargets(orphanScan);
      }

      if (args?.format === 'json') {
        return {
          healthPath: getHealthPath(),
          ...summary,
          worktrees: {
            registered: orphanScan.registered,
            orphanDirs: orphanScan.orphans,
            terminalRegistered: orphanScan.terminalRegistered,
            terminalDirs: orphanScan.terminalDirs,
            needsRepair: cleanupTargets.length > 0,
            repaired,
            repairFailed,
            repairRequested: !!args?.repair,
          },
          codex,
          validation,
        };
      }

      // text 输出
      const lines: string[] = [];
      lines.push(`koala doctor — health issues`);
      lines.push(`  source: ${getHealthPath()}`);
      lines.push(`  total : ${summary.total} issues recorded`);
      lines.push(`  shown : ${summary.recent.length} (${summary.recentWindow === '24h' ? 'last 24h' : 'most recent'})`);
      lines.push('');

      if (summary.total === 0 && cleanupTargets.length === 0) {
        lines.push('✓ No health issues recorded. koala is healthy.');
      } else if (summary.total === 0) {
        lines.push('⚠ No health issues recorded, but worktree cleanup issues were found.');
      } else {
        lines.push('By category:');
        const sorted = Object.entries(summary.byCategory).sort((a, b) => b[1] - a[1]);
        for (const [cat, count] of sorted) {
          lines.push(`  ${cat.padEnd(30)} ${count}`);
        }
        lines.push('');

        lines.push('Recent issues:');
        for (const issue of summary.recent.slice(0, 20)) {
          const ctxStr = Object.entries(issue.context)
            .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
            .join(' ');
          lines.push(`  [${issue.timestamp}] ${issue.category}`);
          lines.push(`    error: ${issue.error}`);
          if (ctxStr) lines.push(`    context: ${ctxStr}`);
        }
        if (summary.recent.length > 20) {
          lines.push(`  ... and ${summary.recent.length - 20} more (use --format=json for full list)`);
        }
        lines.push('');
        lines.push(`→ 这些 issue 都是非致命错误（被 reportHealthIssue 接住），但可能预示数据/审计不完整。`);
        lines.push(`→ 如需清空：rm ${getHealthPath()}`);
        lines.push('');
      }

      // Worktree orphan section
      lines.push('Worktree scan:');
      lines.push(`  registered: ${orphanScan.registered.length}`);
      lines.push(`  terminal registered: ${orphanScan.terminalRegistered.length}`);
      lines.push(`  orphan dirs        : ${orphanScan.orphans.length}`);
      lines.push(`  terminal dirs      : ${orphanScan.terminalDirs.length}`);
      if (cleanupTargets.length === 0) {
        lines.push('  ✓ No orphan or terminal worktree cleanup issues.');
      } else {
        if (orphanScan.terminalRegistered.length > 0) {
          lines.push('  Terminal registered worktrees:');
          for (const p of orphanScan.terminalRegistered) lines.push(`  - ${p}`);
        }
        if (orphanScan.orphans.length > 0) {
          lines.push('  Orphan directories:');
          for (const o of orphanScan.orphans) lines.push(`  - ${o}`);
        }
        const alreadyListed = new Set([...orphanScan.terminalRegistered, ...orphanScan.orphans]);
        const terminalDirsOnly = orphanScan.terminalDirs.filter(p => !alreadyListed.has(p));
        if (terminalDirsOnly.length > 0) {
          lines.push('  Terminal directories:');
          for (const p of terminalDirsOnly) lines.push(`  - ${p}`);
        }
        if (args?.repair) {
          lines.push('');
          lines.push(`Repair:`);
          for (const p of repaired) lines.push(`  ✓ removed ${p}`);
          for (const f of repairFailed) lines.push(`  ✗ ${f.path}: ${f.error}`);
        } else {
          lines.push('');
          lines.push(`→ terminal registered = story 已 DONE/DISCARDED 但 git 仍注册 worktree。`);
          lines.push(`→ orphan dirs = 目录仍在 .worktrees/ 下但 git worktree list 已不认识。`);
          lines.push(`→ terminal dirs = DONE/DISCARDED story 的 worktree 目录仍存在。`);
          lines.push(`→ 重跑: koala doctor --repair 清理这些残留。`);
        }
      }

      lines.push('');
      lines.push(renderValidationScan(validation));
      lines.push('');
      lines.push('Codex adapter scan:');
      lines.push(renderCodexAdapterChecks(codex).split('\n').map((line, index) => index === 0 ? `  ${line}` : `  ${line}`).join('\n'));

      return lines.join('\n');
    },
  };
}

function renderValidationScan(scan: ValidationSetupScan): string {
  const lines: string[] = [];
  lines.push('Validation scan:');
  const fileSummary = scan.validateFiles
    .map((file) => `${file.name}=${file.present ? 'present' : 'missing'}`)
    .join(', ');
  lines.push(`  validate files: ${fileSummary}`);
  lines.push(`  active validate file: ${scan.validateFile ?? 'none'}`);

  lines.push(`  configured commands: ${scan.configuredCommands.length}`);
  if (scan.configuredCommands.length > 0) {
    for (const cmd of scan.configuredCommands) {
      const shell = cmd.shell ? ' shell=true' : '';
      const optional = cmd.optional ? ' optional=true' : '';
      lines.push(`  - ${cmd.label}: ${formatValidationCommand(cmd)}${shell}${optional}`);
    }
  }

  const fallbackLabels = scan.discoveredFallbackLabels.length > 0
    ? scan.discoveredFallbackLabels.join(', ')
    : 'none';
  lines.push(`  discovered fallback labels: ${fallbackLabels}`);
  lines.push(`  no-validator warning: ${scan.noValidatorWarning ? 'yes' : 'no'}`);

  if (scan.configuredShellStyleCommands.length === 0) {
    lines.push('  configured shell receipts: none');
  } else {
    const receiptStatus = scan.configuredShellReceiptsIntentional ? 'intentional' : 'needs attention';
    lines.push(`  configured shell receipts: ${receiptStatus}`);
    for (const cmd of scan.configuredShellStyleCommands) {
      lines.push(`  - ${cmd.label}: shell=${cmd.shell ? 'true' : 'false'} source=${cmd.source}`);
    }
  }

  if (scan.warnings.length > 0) {
    lines.push('  warnings:');
    for (const warning of scan.warnings) lines.push(`  - ${warning}`);
  } else {
    lines.push('  warnings: none');
  }
  lines.push('  note: fallback command discovery is advisory; configure validate.command(s) for an explicit project gate.');
  return lines.join('\n');
}

/**
 * 扫描 .worktrees/ 目录下的孤儿条目。
 *
 * 孤儿 = 目录存在于 worktreeDir 下，但 `git worktree list --porcelain` 没有
 * 把它列为活动的 worktree。典型成因：`git worktree remove` 因为 activity.jsonl
 * 等 gitignored 运行时产物被 hook 持续写入，git 静默只清 registry 而没删目录。
 */
function scanOrphanWorktrees(root: string, store: HandlerContext['store']): {
  registered: string[];
  orphans: string[];
  terminalRegistered: string[];
  terminalDirs: string[];
} {
  const cfg = loadConfig(root);
  const worktreeDirName = cfg.worktreeDir || '.worktrees';

  // Find repo root from the current root
  let repoRoot: string;
  try {
    repoRoot = execSync('git rev-parse --show-toplevel', { cwd: root, encoding: 'utf-8' }).trim();
  } catch {
    return { registered: [], orphans: [], terminalRegistered: [], terminalDirs: [] };
  }

  const worktreeBase = join(repoRoot, worktreeDirName);

  // Collect the set of paths git currently considers active worktrees
  let registered: string[] = [];
  try {
    const raw = execSync('git worktree list --porcelain', { cwd: repoRoot, encoding: 'utf-8' });
    registered = raw
      .split(/\r?\n/)
      .filter(l => l.startsWith('worktree '))
      .map(l => l.slice('worktree '.length).trim())
      .map(p => p.replace(/\\/g, '/'));
  } catch {
    return { registered: [], orphans: [], terminalRegistered: [], terminalDirs: [] };
  }

  // Directories directly under worktreeBase
  let entries: string[] = [];
  if (existsSync(worktreeBase)) {
    try {
      entries = readdirSync(worktreeBase);
    } catch {
      entries = [];
    }
  }

  const orphans: string[] = [];
  const terminalDirs: string[] = [];
  for (const name of entries) {
    const abs = join(worktreeBase, name);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    if (isRepairIgnoredDir(abs)) continue;
    if (isTerminalStory(store, name)) terminalDirs.push(abs);
    const norm = abs.replace(/\\/g, '/');
    const matched = registered.some(r => r === norm);
    if (!matched) orphans.push(abs);
  }

  const terminalRegistered = registered.filter((p) => {
    const norm = p.replace(/\\/g, '/');
    if (!norm.startsWith(worktreeBase.replace(/\\/g, '/') + '/')) return false;
    return isTerminalStory(store, basename(p));
  });

  return { registered, orphans, terminalRegistered, terminalDirs };
}

function collectWorktreeCleanupTargets(scan: {
  orphans: string[];
  terminalRegistered: string[];
  terminalDirs: string[];
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of [...scan.terminalRegistered, ...scan.orphans, ...scan.terminalDirs]) {
    const key = path.replace(/\\/g, '/');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

function tryWorktreeRemove(root: string, target: string): void {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', target], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
  } catch {
    // Best-effort repair: target may already be an orphan dir, or a prunable
    // registered worktree whose metadata is removed by the prune step.
  }
}

function isRepairIgnoredDir(target: string): boolean {
  return existsSync(join(target, '.koala-repair-ignore'));
}

function markRepairIgnored(target: string, reason: string): void {
  try {
    writeFileSync(
      join(target, '.koala-repair-ignore'),
      JSON.stringify({ reason, timestamp: new Date().toISOString() }, null, 2) + '\n',
      'utf-8',
    );
  } catch {
    // PERSIST: repair failure is already surfaced in repairFailed.
  }
}

function removePathWithTimeout(target: string): void {
  execFileSync('rm', ['-rf', target], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30000,
  });
}

function removeStaleWorktreeAdminDirs(root: string, target: string): string[] {
  const removed: string[] = [];
  const storyId = basename(target);
  const branch = `story/${storyId}`;
  const branchRef = `refs/heads/${branch}`;
  const expectedPath = resolve(target).replace(/\\/g, '/');
  let commonDir: string;
  try {
    commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return removed;
  }
  const adminBase = isAbsolute(commonDir) ? join(commonDir, 'worktrees') : join(root, commonDir, 'worktrees');
  let names: string[] = [];
  try {
    names = readdirSync(adminBase);
  } catch {
    return removed;
  }
  for (const name of names) {
    const adminDir = join(adminBase, name);
    let matches = name === storyId;
    try {
      const gitdir = readFileSync(join(adminDir, 'gitdir'), 'utf-8').trim();
      const gitdirPath = gitdir.endsWith('/.git') || gitdir.endsWith('\\.git') ? dirname(gitdir) : gitdir;
      if (resolve(gitdirPath).replace(/\\/g, '/') === expectedPath) matches = true;
    } catch { /* PROBE: malformed stale worktree metadata */ }
    try {
      const head = readFileSync(join(adminDir, 'HEAD'), 'utf-8').trim();
      if (head === `ref: ${branchRef}` || head === `ref: ${branch}`) matches = true;
    } catch { /* PROBE: malformed stale worktree metadata */ }
    if (!matches) continue;
    try {
      rmSync(adminDir, { recursive: true, force: true });
      removed.push(adminDir);
    } catch { /* MUTATION: caller rescans and reports repairFailed if residue remains */ }
  }
  return removed;
}

function deleteTerminalStoryBranch(root: string, store: HandlerContext['store'], storyId: string): void {
  if (!isTerminalStory(store, storyId)) return;
  const branch = `story/${storyId}`;
  try {
    execFileSync('git', ['branch', '-D', branch], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    // PROBE: branch may already be gone; doctor repair is idempotent.
  }
}

function isTerminalStory(store: HandlerContext['store'], storyId: string): boolean {
  try {
    const story = store.readStory(storyId);
    return story.phase === 'DONE' || story.phase === 'DISCARDED';
  } catch {
    return false;
  }
}
