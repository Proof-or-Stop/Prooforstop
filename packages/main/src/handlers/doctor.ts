/**
 * lattice doctor — output health issues from the last 24 hours (grouped by category)
 *
 * Lets users periodically run `lattice doctor` to check whether Lattice itself has hidden PERSIST failures.
 * Previously these failures were silently swallowed by catch, making post-hoc retrospection impossible.
 *
 * B-7241 follow-up: `--repair` mode scans for orphan directories under `.worktrees/`
 * (those not in git worktree list but whose directories still exist) and rm -rf cleans them up. Targets
 * the scenario where after DONE merge, git worktree remove silently only clears the registry without
 * clearing the directory because of leftover runtime artifacts like activity.jsonl / tmp.
 */

import { execFileSync, execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import type { HandlerContext } from './context.js';
import { readHealthIssues, summarizeHealthIssues, getHealthPath } from '../core/health.js';
import { loadConfig } from '../core/config.js';
import { renderCodexAdapterChecks, runCodexAdapterChecks } from '../core/codex-adapter-checks.js';
import { findRuntimeArtifactEntry, isRepairableTrackedRuntimeArtifactPath } from '../core/runtime-artifact-registry.js';
import { formatValidationCommand } from '../core/validation-executor.js';
import { renderRuntimeEnvironmentReport, renderRuntimeFootprintSummary, runRuntimeEnvironmentChecks } from '../core/runtime-environment-checks.js';
import { scanValidationSetup, type ValidationSetupScan } from './verifier.js';
import { detectPartialDoneStories, renderPartialDoneSummary } from '../core/partial-done-recovery.js';
import { renderMainWriteLockScan, scanMainWriteLock } from '../core/main-write-lock-doctor.js';
import { renderStoryOwnerLeaseScan, scanStoryOwnerLeases } from '../core/story-owner-lease-doctor.js';

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
      const runtime = runRuntimeEnvironmentChecks(root);
      let trackedRuntimeArtifacts = scanTrackedRuntimeArtifacts(root);
      const runtimeArtifactsRepaired: string[] = [];
      const runtimeArtifactsRepairFailed: Array<{ path: string; error: string }> = [];

      // B-7241 follow-up: scan for orphan worktrees (directory exists but
      // `git worktree list` doesn't know about it). This typically happens
      // after a DONE merge when Claude Code's activity.jsonl hook or tmp/
      // runtime files kept file handles open during `git worktree remove`,
      // so git deregistered the worktree but left the dir behind.
      let orphanScan = scanOrphanWorktrees(root, store);
      const partialDone = detectPartialDoneStories(root, store);
      // B-f60c CHK-004: scan the unified main write lock for a stuck/stale
      // leftover (a crashed holder's lock). An active in-flight lock (within
      // the stale window) is reported as healthy, never misflagged as stuck.
      const mainWriteLock = scanMainWriteLock(root);
      // B-c55d CHK-005: scan every active story's owner-lease.json for a STALE
      // lease (heartbeat older than the 30-minute threshold). An active lease
      // within the window is reported as healthy, never misflagged.
      const storyOwnerLeases = scanStoryOwnerLeases(store);
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
      if (args?.repair && trackedRuntimeArtifacts.some((artifact) => artifact.repairable)) {
        for (const artifact of trackedRuntimeArtifacts) {
          if (!artifact.repairable) continue;
          try {
            execFileSync('git', ['rm', '--cached', '--', artifact.path], {
              cwd: root,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            runtimeArtifactsRepaired.push(artifact.path);
          } catch (e: any) {
            runtimeArtifactsRepairFailed.push({ path: artifact.path, error: e.message || String(e) });
          }
        }
        trackedRuntimeArtifacts = scanTrackedRuntimeArtifacts(root);
      }

      if (args?.format === 'json') {
        return {
          runtimeMode: runtime.runtimeMode,
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
          partialDone: {
            stories: partialDone,
            needsRecovery: partialDone.length > 0,
          },
          mainWriteLock: {
            lockPath: mainWriteLock.lockPath,
            state: mainWriteLock.state,
            ageMs: mainWriteLock.ageMs,
            ageLabel: mainWriteLock.ageLabel,
            staleMs: mainWriteLock.staleMs,
            holder: mainWriteLock.holder,
            stuck: mainWriteLock.state === 'stuck',
          },
          storyOwnerLeases: {
            leases: storyOwnerLeases.leases,
            stale: storyOwnerLeases.stale,
            terminalStale: storyOwnerLeases.terminalStale,
            hasStale: storyOwnerLeases.stale.length > 0,
            hasTerminalStale: storyOwnerLeases.terminalStale.length > 0,
          },
          codex,
          validation,
          runtime,
          runtimeArtifacts: {
            tracked: trackedRuntimeArtifacts,
            needsRepair: trackedRuntimeArtifacts.some((artifact) => artifact.repairable),
            repaired: runtimeArtifactsRepaired,
            repairFailed: runtimeArtifactsRepairFailed,
            repairRequested: !!args?.repair,
          },
        };
      }

      // text output
      const lines: string[] = [];
      lines.push(renderRuntimeFootprintSummary(runtime.runtimeMode));
      lines.push('');
      lines.push(`lattice doctor — health issues`);
      lines.push(`  source: ${getHealthPath()}`);
      lines.push(`  total : ${summary.total} issues recorded`);
      lines.push(`  shown : ${summary.recent.length} (${summary.recentWindow === '24h' ? 'last 24h' : 'most recent'})`);
      lines.push('');

      if (summary.total === 0 && cleanupTargets.length === 0 && trackedRuntimeArtifacts.length === 0 && partialDone.length === 0) {
        lines.push('✓ No health issues recorded. Lattice is healthy.');
      } else if (summary.total === 0 && cleanupTargets.length > 0) {
        lines.push('⚠ No health issues recorded, but worktree cleanup issues were found.');
      } else if (summary.total === 0 && partialDone.length > 0) {
        lines.push('⚠ No health issues recorded, but partial-DONE recovery issues were found.');
      } else if (summary.total === 0) {
        lines.push('⚠ No health issues recorded, but tracked runtime artifacts were found.');
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
        lines.push(`→ These issues are all non-fatal errors (caught by reportHealthIssue), but may indicate incomplete data/audit.`);
        lines.push(`→ To clear: rm ${getHealthPath()}`);
        lines.push('');
      }

      lines.push('Runtime artifacts:');
      if (trackedRuntimeArtifacts.length === 0) {
        lines.push('  ✓ no tracked runtime artifacts found');
        if (args?.repair) {
          for (const path of runtimeArtifactsRepaired) lines.push(`  ✓ untracked ${path}`);
          for (const failed of runtimeArtifactsRepairFailed) lines.push(`  ✗ ${failed.path}: ${failed.error}`);
        }
      } else {
        for (const artifact of trackedRuntimeArtifacts) {
          lines.push(`  - ${artifact.path} [${artifact.entryId}]${artifact.repairable ? ` -> ${artifact.repairCommand}` : ' (manual review)'}`);
        }
        if (args?.repair) {
          if (runtimeArtifactsRepaired.length > 0) {
            for (const path of runtimeArtifactsRepaired) lines.push(`  ✓ untracked ${path}`);
          }
          for (const failed of runtimeArtifactsRepairFailed) {
            lines.push(`  ✗ ${failed.path}: ${failed.error}`);
          }
        } else {
          lines.push('→ Re-run: lattice doctor --repair to untrack repairable runtime artifacts.');
        }
      }
      lines.push('');

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
          lines.push(`→ terminal registered = story already DONE/DISCARDED but git still registers the worktree.`);
          lines.push(`→ orphan dirs = directory still exists under .worktrees/ but git worktree list no longer recognizes it.`);
          lines.push(`→ terminal dirs = worktree directory of DONE/DISCARDED story still exists.`);
          lines.push(`→ Rerun: lattice doctor --repair to clean up these leftovers.`);
        }
      }

      lines.push('');
      lines.push('Partial-DONE scan:');
      for (const line of renderPartialDoneSummary(partialDone)) lines.push(line);
      if (partialDone.length > 0) {
        lines.push('→ partial-DONE = story.phase is DONE but story branch is not merged into main.');
        lines.push('→ Run the listed lattice done_recover command after main is clean.');
      }

      lines.push('');
      for (const line of renderMainWriteLockScan(mainWriteLock)) lines.push(line);

      lines.push('');
      for (const line of renderStoryOwnerLeaseScan(storyOwnerLeases)) lines.push(line);

      lines.push('');
      lines.push(renderRuntimeEnvironmentReport(runtime));
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

interface TrackedRuntimeArtifact {
  path: string;
  entryId: string;
  ignorePatterns: string[];
  materialHash: 'exclude' | 'include';
  volatile: boolean;
  repairable: boolean;
  repairCommand: string;
}

function renderGitRmCachedCommand(path: string): string {
  return `git rm --cached -- ${renderPosixShellArg(path)}`;
}

function renderPosixShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function scanTrackedRuntimeArtifacts(root: string): TrackedRuntimeArtifact[] {
  let raw = '';
  try {
    raw = execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const tracked: TrackedRuntimeArtifact[] = [];
  for (const path of raw.split('\0').filter(Boolean)) {
    const artifact = findRuntimeArtifactEntry(path);
    if (!artifact) continue;
    const key = `${artifact.id}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tracked.push({
      path,
      entryId: artifact.id,
      ignorePatterns: artifact.ignorePatterns,
      materialHash: artifact.materialHash,
      volatile: artifact.volatile,
      repairable: isRepairableTrackedRuntimeArtifactPath(path),
      repairCommand: renderGitRmCachedCommand(path),
    });
  }
  tracked.sort((a, b) => a.path.localeCompare(b.path));
  return tracked;
}

/**
 * Scans for orphan entries under the .worktrees/ directory.
 *
 * Orphan = directory exists under worktreeDir, but `git worktree list --porcelain` does not
 * list it as an active worktree. Typical cause: `git worktree remove` because gitignored runtime
 * artifacts like activity.jsonl are continuously written by hooks, git silently only clears the registry without removing the directory.
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
