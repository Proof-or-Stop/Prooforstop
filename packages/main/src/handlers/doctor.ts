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
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import type { HandlerContext } from './context.js';
import { readHealthIssues, summarizeHealthIssues, getHealthPath } from '../core/health.js';
import { loadConfig } from '../core/config.js';
import { renderCodexAdapterChecks, runCodexAdapterChecks } from '../core/codex-adapter-checks.js';
import { findRuntimeArtifactEntry, isRepairableTrackedRuntimeArtifactPath } from '../core/runtime-artifact-registry.js';
import {
  AGENT_ASSET_MODE_RUNTIME_OWNED,
  mergeRuntimeGitignore,
  runtimeIgnoreMissing,
  scanProjectLocalManagedAgents,
} from '../core/managed-assets.js';
import {
  evaluateStoryMetadataProtection,
  type StoryMetadataProbe,
} from '../core/story-metadata-protection.js';
import { formatValidationCommand } from '../core/validation-executor.js';
import { renderRuntimeEnvironmentReport, renderRuntimeFootprintSummary, runRuntimeEnvironmentChecks } from '../core/runtime-environment-checks.js';
import { scanValidationSetup, type ValidationSetupScan } from './verifier.js';
import { detectPartialDoneStories, renderPartialDoneSummary } from '../core/partial-done-recovery.js';
import { renderMainWriteLockScan, scanMainWriteLock } from '../core/main-write-lock-doctor.js';
import { renderStoryOwnerLeaseScan, scanStoryOwnerLeases } from '../core/story-owner-lease-doctor.js';
import { renderGuardSessionDoctorSection, scanGuardSessions } from '../core/guard-session-doctor.js';
import {
  renderAuxiliaryClassification,
  repairAuxiliaryWorktreeResidues,
  scanAuxiliaryWorktreeResidues,
  type AuxiliaryCleanupResult,
} from '../core/auxiliary-worktree-cleanup.js';
import { LATTICE_REPAIR_IGNORE, LEGACY_KOALA_REPAIR_IGNORE } from '../core/lattice-paths.js';
import {
  evaluateStoryDirConfigInsideGitRoot,
  type StoryDirInsideGitRootResult,
} from '../core/story-signed-workspace-resolution.js';

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
      // B-097f: Claude agent prompts are runtime-owned (single source =
      // global ~/.claude/agents). Surface the mode + any stale project-local
      // managed agent files so historical projects are diagnosable.
      const projectAgentScan = scanProjectLocalManagedAgents(root);
      const agentAssets = {
        agentAssetMode: AGENT_ASSET_MODE_RUNTIME_OWNED,
        projectLocalManagedFiles: projectAgentScan.managedFiles,
        hasStaleProjectLocal: projectAgentScan.managedFiles.length > 0,
      };
      // B-1637: resolve the gitRoot ONCE and thread it as the cwd into every git
      // probe below, so wrapper-root projects (metadataRoot != gitRoot) no longer
      // print leading `fatal: not a git repository` lines. Falls back to `root`
      // when no gitRoot resolves → byte-identical for plain repos.
      const gitProbeCwd = resolveDoctorGitCwd(root);
      let trackedRuntimeArtifacts = scanTrackedRuntimeArtifacts(root, gitProbeCwd);
      const runtimeArtifactsRepaired: string[] = [];
      const runtimeArtifactsRepairFailed: Array<{ path: string; error: string }> = [];

      // B-7241 follow-up: scan for orphan worktrees (directory exists but
      // `git worktree list` doesn't know about it). This typically happens
      // after a DONE merge when Claude Code's activity.jsonl hook or tmp/
      // runtime files kept file handles open during `git worktree remove`,
      // so git deregistered the worktree but left the dir behind.
      let orphanScan = scanOrphanWorktrees(root, store, gitProbeCwd);
      let auxiliaryWorktrees = scanAuxiliaryWorktreeResidues(root, store);
      const auxiliaryRepaired: AuxiliaryCleanupResult[] = [];
      const auxiliaryRepairFailed: Array<{ path: string; error: string }> = [];
      const partialDone = detectPartialDoneStories(root, store);
      // B-f60c CHK-004: scan the unified main write lock for a stuck/stale
      // leftover (a crashed holder's lock). An active in-flight lock (within
      // the stale window) is reported as healthy, never misflagged as stuck.
      const mainWriteLock = scanMainWriteLock(root);
      // B-c55d CHK-005: scan every active story's owner-lease.json for a STALE
      // lease (heartbeat older than the 30-minute threshold). An active lease
      // within the window is reported as healthy, never misflagged.
      const storyOwnerLeases = scanStoryOwnerLeases(store);
      // Guard session scan: report prewrite scope guard status for active stories
      // and check whether the Claude Code PreToolUse hook is installed.
      const guardSessionScan = scanGuardSessions(store, root);
      // B-198c CHK-002: EARLY detection of the wrapper-root violation where the
      // configured storyDir resolves OUTSIDE the resolved gitRoot. The
      // git-backed lifecycle commits story metadata (scoped story branch + DONE
      // merge to main), which is impossible when story metadata lives outside
      // the gitRoot. The only other detectors are two LATE guards that fire at
      // INIT_CHECK bootstrap — by then INIT/PLAN effort is already invested.
      // This is id-independent: it depends only on configured storyDir base vs
      // resolved gitRoot, never throws, and a no-gitRoot condition is reported
      // separately (not as the violation).
      const storyDirGitRoot = evaluateStoryDirConfigInsideGitRoot({ metadataRoot: root });
      // B-854c CHK-003: scan active stories' metadata leaves for the
      // neither-tracked-nor-protected data-loss state (ClawCreek incident).
      let storyMetadataProtection = scanStoryMetadataProtection(root, store, gitProbeCwd);
      let storyMetadataRepair: { requested: boolean; wrote: boolean; error?: string } = {
        requested: !!args?.repair,
        wrote: false,
      };
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
        orphanScan = scanOrphanWorktrees(root, store, gitProbeCwd);
        cleanupTargets = collectWorktreeCleanupTargets(orphanScan);
      }
      if (args?.repair && auxiliaryWorktrees.some((candidate) => candidate.state === 'safe-cleanup')) {
        try {
          auxiliaryRepaired.push(...repairAuxiliaryWorktreeResidues(root, store));
          auxiliaryWorktrees = scanAuxiliaryWorktreeResidues(root, store);
        } catch (e: any) {
          auxiliaryRepairFailed.push({ path: '<auxiliary-worktree-cleanup>', error: e?.message || String(e) });
        }
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
        trackedRuntimeArtifacts = scanTrackedRuntimeArtifacts(root, gitProbeCwd);
      }

      // B-854c CHK-003: --repair installs the managed ignore-volatile/track-metadata
      // allowlist (reusing managed-assets mergeRuntimeGitignore — idempotent), then
      // re-scans so a safe project reports clear after repair and a second run is a no-op.
      if (args?.repair && storyMetadataProtection.evaluated && storyMetadataProtection.needsRepair) {
        const result = repairStoryMetadataAllowlist(root, gitProbeCwd);
        storyMetadataRepair = { requested: true, wrote: result.wrote, error: result.error };
        storyMetadataProtection = scanStoryMetadataProtection(root, store, gitProbeCwd);
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
            auxiliary: {
              all: auxiliaryWorktrees,
              safe: auxiliaryWorktrees.filter((candidate) => candidate.state === 'safe-cleanup'),
              unsafe: auxiliaryWorktrees.filter((candidate) => candidate.state !== 'safe-cleanup'),
              needsRepair: auxiliaryWorktrees.some((candidate) => candidate.state === 'safe-cleanup'),
              repaired: auxiliaryRepaired,
              repairFailed: auxiliaryRepairFailed,
            },
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
          guardSessions: {
            preToolUseHook: guardSessionScan.preToolUseHook,
            sessions: guardSessionScan.sessions,
            active: guardSessionScan.active,
            withViolations: guardSessionScan.withViolations,
            activeMissingHook: guardSessionScan.activeMissingHook,
            hasMisconfigured: guardSessionScan.activeMissingHook.length > 0,
            hasViolations: guardSessionScan.withViolations.length > 0,
          },
          storyDirGitRoot: {
            ok: storyDirGitRoot.ok,
            storyDirAbs: storyDirGitRoot.storyDirAbs,
            gitRootAbs: storyDirGitRoot.gitRootAbs,
            rel: storyDirGitRoot.rel,
            reason: storyDirGitRoot.reason ?? null,
            violation: storyDirGitRoot.reason === 'outside-gitroot',
            gitRootUnresolved: storyDirGitRoot.reason === 'gitroot-unresolved',
          },
          storyMetadataProtection: {
            evaluated: storyMetadataProtection.evaluated,
            unsafe: storyMetadataProtection.unsafe,
            leaves: storyMetadataProtection.leaves,
            unsafeLeaves: storyMetadataProtection.unsafeLeaves,
            allowlistMissing: storyMetadataProtection.allowlistMissing,
            needsRepair: storyMetadataProtection.needsRepair,
            repairRequested: storyMetadataRepair.requested,
            repairWrote: storyMetadataRepair.wrote,
            repairError: storyMetadataRepair.error ?? null,
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
          agentAssets,
        };
      }

      // text output
      const lines: string[] = [];
      lines.push(renderRuntimeFootprintSummary(runtime.runtimeMode));
      lines.push('');
      lines.push(`agentAssetMode: ${agentAssets.agentAssetMode}`);
      if (agentAssets.hasStaleProjectLocal) {
        lines.push(
          `  ⚠ ${agentAssets.projectLocalManagedFiles.length} managed agent file(s) in .claude/agents shadow the global ~/.claude/agents source; run lattice init --upgrade to migrate`,
        );
      } else {
        lines.push('  ✓ agent prompts resolve from the global ~/.claude/agents single source');
      }
      lines.push('');
      lines.push(`lattice doctor — health issues`);
      lines.push(`  source: ${getHealthPath()}`);
      lines.push(`  total : ${summary.total} issues recorded`);
      lines.push(`  shown : ${summary.recent.length} (${summary.recentWindow === '24h' ? 'last 24h' : 'most recent'})`);
      lines.push('');

      if (summary.total === 0 && cleanupTargets.length === 0 && auxiliaryWorktrees.length === 0 && trackedRuntimeArtifacts.length === 0 && partialDone.length === 0) {
        lines.push('✓ No health issues recorded. Lattice is healthy.');
      } else if (summary.total === 0 && (cleanupTargets.length > 0 || auxiliaryWorktrees.length > 0)) {
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
      lines.push(`  auxiliary residues : ${auxiliaryWorktrees.length}`);
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
      if (auxiliaryWorktrees.length > 0) {
        lines.push('');
        lines.push('  Auxiliary story worktrees:');
        for (const candidate of auxiliaryWorktrees) {
          lines.push(`  - ${renderAuxiliaryClassification(root, candidate)}`);
        }
        if (args?.repair) {
          for (const result of auxiliaryRepaired) {
            const label = renderAuxiliaryClassification(root, result.before);
            lines.push(`  ${result.cleaned ? '✓' : '⚠'} ${label}`);
            for (const action of result.actions) lines.push(`    ${action}`);
          }
          for (const failed of auxiliaryRepairFailed) lines.push(`  ✗ ${failed.path}: ${failed.error}`);
        } else {
          lines.push('  → safe-cleanup entries can be removed with: lattice doctor --repair');
          lines.push('  → dirty-worktree / missing-from-main / unknown entries require manual review.');
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
      for (const line of renderGuardSessionDoctorSection(guardSessionScan)) lines.push(line);

      lines.push('');
      for (const line of renderStoryDirGitRootScan(storyDirGitRoot)) lines.push(line);

      lines.push('');
      for (const line of renderStoryMetadataProtectionScan(storyMetadataProtection, storyMetadataRepair)) lines.push(line);

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

/**
 * B-198c CHK-002: render the storyDir-inside-gitRoot check.
 *
 * - violation (reason 'outside-gitroot') → distinct flagged check with the
 *   storyDir + gitRoot abs paths and the remediation pointer.
 * - gitRoot unresolvable (reason 'gitroot-unresolved') → informational, NOT
 *   treated as the violation.
 * - healthy → silent pass line.
 */
function renderStoryDirGitRootScan(result: StoryDirInsideGitRootResult): string[] {
  const lines: string[] = [];
  lines.push('storyDir / gitRoot scan:');
  if (result.reason === 'outside-gitroot') {
    lines.push('  ✗ storyDir resolves OUTSIDE the resolved gitRoot');
    lines.push(`      storyDir: ${result.storyDirAbs}`);
    lines.push(`      gitRoot:  ${result.gitRootAbs}`);
    lines.push('      The git-backed lifecycle cannot commit story metadata from here.');
    lines.push('      → configure storyDir so story metadata lives inside the gitRoot.');
  } else if (result.reason === 'gitroot-unresolved') {
    lines.push('  - gitRoot unresolved (no configured gitRoot and metadataRoot is not git-backed)');
    lines.push(`      storyDir: ${result.storyDirAbs}`);
    lines.push('      → storyDir-inside-gitRoot cannot be checked until a gitRoot resolves.');
  } else {
    lines.push('  ✓ storyDir resolves inside the resolved gitRoot');
  }
  return lines;
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
  lines.push('  note: fallback command discovery is advisory; configure validate.command(s) in lattice.config.json for an explicit project gate.');
  lines.push('  note: Swift / Package.swift is NOT in the automatic fallback set (Mac Native App demoted); opt in explicitly via validate.commands if needed.');
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

/**
 * B-1637: resolve the cwd doctor's git probes should run in.
 *
 * doctor previously ran every git probe with cwd=root (the metadataRoot). On a
 * WRAPPER-ROOT project (metadataRoot != gitRoot — e.g. ClawCreek with a non-git
 * wrapper root and a configured gitRoot subdir) the metadataRoot is NOT a git
 * repo, so each probe's `git` invocation emitted `fatal: not a git repository`.
 * Every probe is already wrapped in try/catch (graceful degradation), so this
 * was cosmetic stderr noise only — but it printed two leading fatal lines on an
 * otherwise healthy report.
 *
 * Reuse the id-independent, TOTAL project-level resolver (the same one doctor
 * already calls at the top of doctor() for the storyDir/gitRoot check, B-198c):
 *   evaluateStoryDirConfigInsideGitRoot({ metadataRoot: root }).gitRootAbs ?? root
 * A configured (valid) gitRoot wins, else the metadata root's own git toplevel,
 * else null → fall back to `root`. This mirrors B-2856 / B-3990's `?? root`
 * reroute and is cwd-only: it never changes git command text or what a probe
 * CHECKS. For a PLAIN repo (metadataRoot == gitRoot) the resolver yields the
 * metadata git root, which is the same repo as `root`, so probe behavior is
 * byte-identical. The resolver never throws.
 */
export function resolveDoctorGitCwd(root: string): string {
  return evaluateStoryDirConfigInsideGitRoot({ metadataRoot: root }).gitRootAbs ?? root;
}

function scanTrackedRuntimeArtifacts(root: string, gitCwd: string = root): TrackedRuntimeArtifact[] {
  let raw = '';
  try {
    raw = execFileSync('git', ['ls-files', '-z'], {
      cwd: gitCwd,
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
function scanOrphanWorktrees(root: string, store: HandlerContext['store'], gitCwd: string = root): {
  registered: string[];
  orphans: string[];
  terminalRegistered: string[];
  terminalDirs: string[];
} {
  const cfg = loadConfig(root);
  const worktreeDirName = cfg.worktreeDir || '.worktrees';

  // Find repo root from the resolved gitRoot (B-1637): on a wrapper-root project
  // `root` (metadataRoot) is not a git repo, so this discovery must run in the
  // resolved gitRoot. stdio piped so a caught failure does not leak a fatal line.
  let repoRoot: string;
  try {
    repoRoot = execSync('git rev-parse --show-toplevel', {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
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
  return existsSync(join(target, LATTICE_REPAIR_IGNORE))
    || existsSync(join(target, LEGACY_KOALA_REPAIR_IGNORE));
}

function markRepairIgnored(target: string, reason: string): void {
  try {
    writeFileSync(
      join(target, LATTICE_REPAIR_IGNORE),
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

// ── B-854c CHK-003: story metadata protection scan + --repair ────────────────

interface StoryMetadataLeafScan {
  storyId: string;
  leaf: string;
  tracked: boolean;
  ignored: boolean;
  unsafe: boolean;
}

interface StoryMetadataProtectionScan {
  /** false when git is unavailable / metadata not under a git root (cannot judge). */
  evaluated: boolean;
  leaves: StoryMetadataLeafScan[];
  unsafeLeaves: StoryMetadataLeafScan[];
  /** managed allowlist patterns still missing from .gitignore (repair installs them). */
  allowlistMissing: string[];
  /** true when any leaf is in the data-loss state. */
  unsafe: boolean;
  /** true when --repair should write the managed allowlist. */
  needsRepair: boolean;
}

function gitProbeRunner(repoRoot: string): (leaf: string) => StoryMetadataProbe {
  return (leaf: string): StoryMetadataProbe => {
    let tracked = false;
    try {
      const out = execFileSync('git', ['ls-files', '--', leaf], {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      tracked = out.trim().length > 0;
    } catch {
      tracked = false;
    }
    let ignored = false;
    try {
      // check-ignore exits 0 (echoing the path) when ignored, exit 1 (throws)
      // when not ignored — the safe negation-allowlist / no-ignore case.
      const out = execFileSync('git', ['check-ignore', '--', leaf], {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      ignored = out.trim().length > 0;
    } catch {
      ignored = false;
    }
    return { tracked, ignored };
  };
}

/**
 * Scan every active (non-terminal) story's metadata leaf (index.json) for the
 * neither-tracked-nor-protected data-loss state, reusing the shared pure
 * predicate. Resolves the git repo root and computes each leaf relative to it
 * (mirrors worktree.ts bootstrap). A safe project (tracked leaves OR a negation
 * allowlist that re-includes them) reports unsafe=false → no false positive.
 *
 * Stays within the standing invariant: this is a runtime scan that consumes
 * git's tracking/ignore facts; it does NOT claim validation evidence or process
 * facts, and it does not widen the runtime-artifact registry.
 */
function scanStoryMetadataProtection(root: string, store: HandlerContext['store'], gitCwd: string = root): StoryMetadataProtectionScan {
  // B-1637: discover repoRoot from the resolved gitRoot. On a wrapper-root
  // project `root` (metadataRoot) is not a git repo, so this `rev-parse` (which
  // DISCOVERS the repoRoot threaded into the per-leaf probes below) must run in
  // the resolved gitRoot — INIT review INIT-001 correction. stdio piped so a
  // caught failure does not leak a fatal line.
  let repoRoot: string;
  try {
    repoRoot = execSync('git rev-parse --show-toplevel', {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return { evaluated: false, leaves: [], unsafeLeaves: [], allowlistMissing: [], unsafe: false, needsRepair: false };
  }

  const canonicalRepoRoot = existsSync(repoRoot) ? realpathSync(repoRoot) : repoRoot;
  const runner = gitProbeRunner(canonicalRepoRoot);
  const storyDirRel = store.storyDirRel().replace(/\/$/, '');

  const leaves: StoryMetadataLeafScan[] = [];
  let ids: string[] = [];
  try {
    ids = store.listStoryIds();
  } catch {
    ids = [];
  }
  for (const storyId of ids) {
    if (isTerminalStory(store, storyId)) continue;
    const storyAbs = join(root, storyDirRel, storyId);
    const canonicalStoryAbs = existsSync(storyAbs) ? realpathSync(storyAbs) : storyAbs;
    const leafAbs = join(canonicalStoryAbs, 'index.json');
    if (!existsSync(leafAbs)) continue;
    const leafRel = relative(canonicalRepoRoot, leafAbs).replace(/\\/g, '/');
    // Skip stories whose metadata is not inside this git root (a separate
    // doctor check — storyDir/gitRoot scan — already covers that violation).
    if (!leafRel || isAbsolute(leafRel) || leafRel.split('/').includes('..')) continue;
    try {
      const result = evaluateStoryMetadataProtection({ metadataLeafPath: leafRel, runner });
      leaves.push({ storyId, leaf: leafRel, tracked: result.tracked, ignored: result.ignored, unsafe: result.unsafe });
    } catch {
      // PROBE: an unprobeable leaf is skipped, never miscounted as unsafe.
    }
  }

  const unsafeLeaves = leaves.filter((leaf) => leaf.unsafe);
  let gitignore: string | null = null;
  try {
    gitignore = readFileSync(join(canonicalRepoRoot, '.gitignore'), 'utf-8');
  } catch {
    gitignore = null;
  }
  const allowlistMissing = runtimeIgnoreMissing(gitignore);

  return {
    evaluated: true,
    leaves,
    unsafeLeaves,
    allowlistMissing,
    unsafe: unsafeLeaves.length > 0,
    // Repair is meaningful whenever a leaf is unsafe OR the managed allowlist is
    // not yet fully installed (so a fresh project gets the protective allowlist).
    needsRepair: unsafeLeaves.length > 0 || allowlistMissing.length > 0,
  };
}

/**
 * B-854c CHK-003: neutralize a pre-existing broad `.lattice/` (or `.lattice`)
 * DIRECTORY-form ignore line that would shadow the managed allowlist.
 *
 * Git rule: "it is not possible to re-include a file if a parent directory of
 * that file is excluded." A bare `.lattice/` directory ignore therefore makes
 * the `!.lattice/story/actives/**` negation INERT — the managed allowlist
 * (which uses the re-includable `.lattice/*` file glob) cannot take effect while
 * the directory-form line is present. We comment out ONLY that exact conflicting
 * line (appending an explanatory marker), preserving every other user line
 * byte-for-byte (preMortem #2: no wholesale rewrite / reorder). Idempotent: an
 * already-neutralized line is left untouched.
 */
const MANAGED_SUPERSEDE_MARKER = '# superseded by lattice managed allowlist (lattice doctor --repair)';

function neutralizeConflictingLatticeDirIgnore(content: string): { content: string; changed: boolean } {
  const lines = content.split('\n');
  let changed = false;
  const out = lines.map((line) => {
    const trimmed = line.trim();
    // Only the bare directory-form ignore conflicts; the re-includable file glob
    // `.lattice/*` and any negation `!...` lines are kept as-is.
    if (trimmed === '.lattice/' || trimmed === '.lattice') {
      changed = true;
      return `# ${line} ${MANAGED_SUPERSEDE_MARKER}`;
    }
    return line;
  });
  return { content: out.join('\n'), changed };
}

/**
 * --repair: install the managed ignore-volatile/track-metadata allowlist.
 *
 * Two surgical steps, both auditable and idempotent:
 *   1. Neutralize a conflicting bare `.lattice/` directory-form ignore line so
 *      the managed allowlist's `!.lattice/story/actives/**` re-inclusion can
 *      actually take effect (git's parent-directory rule).
 *   2. Reuse managed-assets `mergeRuntimeGitignore` (append-only inside
 *      BLOCK_START/END markers, dedupes) to add the allowlist.
 * Writes only when content changes, so a second --repair run is a no-op.
 */
function repairStoryMetadataAllowlist(root: string, gitCwd: string = root): { wrote: boolean; repoRoot: string | null; error?: string } {
  let repoRoot: string;
  try {
    repoRoot = execSync('git rev-parse --show-toplevel', { cwd: gitCwd, encoding: 'utf-8' }).trim();
  } catch (e: any) {
    return { wrote: false, repoRoot: null, error: e?.message || String(e) };
  }
  const canonicalRepoRoot = existsSync(repoRoot) ? realpathSync(repoRoot) : repoRoot;
  const gitignorePath = join(canonicalRepoRoot, '.gitignore');
  let existing: string | null = null;
  try {
    existing = readFileSync(gitignorePath, 'utf-8');
  } catch {
    existing = null;
  }
  const neutralized = existing === null
    ? { content: '', changed: false }
    : neutralizeConflictingLatticeDirIgnore(existing);
  const merged = mergeRuntimeGitignore(existing === null ? null : neutralized.content);
  if (!neutralized.changed && merged === (existing ?? '')) {
    return { wrote: false, repoRoot: canonicalRepoRoot };
  }
  try {
    writeFileSync(gitignorePath, merged);
    return { wrote: true, repoRoot: canonicalRepoRoot };
  } catch (e: any) {
    return { wrote: false, repoRoot: canonicalRepoRoot, error: e?.message || String(e) };
  }
}

/**
 * Render the story metadata protection scan as doctor text. A clear ✗ block +
 * `→ lattice doctor --repair` pointer when unsafe; a pass line otherwise.
 */
function renderStoryMetadataProtectionScan(
  scan: StoryMetadataProtectionScan,
  repair: { requested: boolean; wrote: boolean; error?: string },
): string[] {
  const lines: string[] = [];
  lines.push('Story metadata protection scan:');
  if (!scan.evaluated) {
    lines.push('  - not git-backed (cannot evaluate story metadata tracking/ignore state)');
    return lines;
  }
  if (scan.unsafe) {
    lines.push('  ✗ story metadata is neither git-tracked nor protected by the managed ignore allowlist');
    for (const leaf of scan.unsafeLeaves) {
      lines.push(`      ${leaf.storyId}: ${leaf.leaf} (ignored=${leaf.ignored}, tracked=${leaf.tracked})`);
    }
    lines.push('      A later `git clean -fdx` or wrong-branch checkout can PERMANENTLY delete this metadata');
    lines.push('      (this is exactly how ClawCreek lost 19 stories).');
  } else {
    lines.push(`  ✓ story metadata is tracked or protected (${scan.leaves.length} active leaf/leaves checked)`);
  }
  if (scan.allowlistMissing.length > 0) {
    lines.push(`  - managed ignore allowlist not fully installed (missing ${scan.allowlistMissing.length} pattern(s))`);
  }
  if (repair.requested) {
    if (repair.error) {
      lines.push(`  ✗ repair failed: ${repair.error}`);
    } else if (repair.wrote) {
      lines.push('  ✓ installed managed ignore-volatile/track-metadata allowlist in .gitignore');
      lines.push('  → `lattice doctor --repair` will be a no-op now; commit the .gitignore change, then `git add` + commit story metadata.');
    } else {
      lines.push('  ✓ managed allowlist already present (repair is a no-op)');
    }
  } else if (scan.needsRepair) {
    lines.push('  → lattice doctor --repair to install the managed allowlist so story metadata stays tracked while runtime stays ignored.');
  }
  return lines;
}
