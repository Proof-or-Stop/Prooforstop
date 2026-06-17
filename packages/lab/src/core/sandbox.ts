/**
 * @task B-9ba3
 * @checklist CHK-003
 * @title lattice-lab sandbox creates isolated git worktrees for experiments
 * @type feature
 * @priority high
 * @description
 *   lattice-lab 不能在当前工作区里直接做实验。sandbox 负责为每次 run 规划独立
 *   branch/worktree 路径，并在 confirm 后创建隔离 worktree，让实验和正式开发、
 *   story worktree 互不污染。
 * @changes
 *   - [CHK-003] 为 lab run 生成独立 sandbox path 和 branch
 *   - [CHK-003] confirm 模式下创建 git linked worktree
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { loadLabProjectConfig } from './project-config.js';
import type { LabExperimentConfig, LabSandboxPlan } from '../types.js';

function git(gitCwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: gitCwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function resolveRepoRoot(root: string): string {
  const topLevel = git(root, ['rev-parse', '--show-toplevel']);
  const commonDirRaw = git(root, ['rev-parse', '--git-common-dir']);
  if (commonDirRaw.endsWith('/.git') || commonDirRaw.endsWith('\\.git')) {
    return dirname(commonDirRaw);
  }
  if (commonDirRaw === '.git') {
    return topLevel;
  }
  return dirname(join(topLevel, commonDirRaw));
}

export function planSandbox(root: string, config: LabExperimentConfig, runId: string): LabSandboxPlan {
  const repoRoot = resolveRepoRoot(root);
  const labProjectConfig = loadLabProjectConfig(root);
  const worktreeDir = labProjectConfig.worktreeDir || '.worktrees';
  return {
    repoRootPath: repoRoot,
    worktreeDir,
    sandboxPath: join(repoRoot, worktreeDir, `${config.id}-${runId}`),
    branch: `lab/${config.id}/${runId}`,
  };
}

export function createSandbox(root: string, plan: LabSandboxPlan): void {
  mkdirSync(dirname(plan.sandboxPath), { recursive: true });
  const gitCwd = root;
  const existingBranch = git(gitCwd, ['branch', '--list', '--format=%(refname:short)', plan.branch]);
  if (existingBranch === plan.branch) {
    throw new Error(`lab sandbox branch 已存在: ${plan.branch}`);
  }
  if (existsSync(plan.sandboxPath)) {
    throw new Error(`lab sandbox 路径已存在: ${plan.sandboxPath}`);
  }
  execFileSync('git', ['worktree', 'add', '-b', plan.branch, plan.sandboxPath, 'HEAD'], {
    cwd: gitCwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
