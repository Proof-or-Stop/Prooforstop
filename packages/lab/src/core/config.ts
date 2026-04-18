/**
 * @task B-9ba3
 * @checklist CHK-001
 * @title koala-lab config defaults define the safe offline baseline
 * @type feature
 * @priority high
 * @description
 *   koala-lab 第一版的价值在于“默认安全”，不是让实验无限自由。这里集中生成
 *   experiment.json 的安全默认值，并拒绝任何试图把 story/fixture 变更打开的
 *   配置，保证离线优化模块从一开始就和正式流程隔离。
 * @changes
 *   - [CHK-001] 为 experiment/run/result schema 提供统一默认值
 *   - [CHK-004] 在配置层拒绝 allowStoryMutation / allowFixtureMutation 这类越权开关
 */
import type { LabExperimentConfig, LabTargetConfig } from '../types.js';

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function defaultTarget(targetId: string, editableFiles?: string[]): LabTargetConfig {
  if (editableFiles && editableFiles.length > 0) {
    return {
      kind: 'prompt',
      id: targetId,
      entryFile: editableFiles[0],
      editableFiles,
    };
  }

  const defaults: Record<string, string[]> = {
    'test-case-reviewer': ['.Codex/agents/test-case-reviewer.md'],
    'test-intent': ['.Codex/agents/test-intent.md'],
    'session-brief': ['packages/main/src/handlers/session.ts'],
  };
  const resolved = defaults[targetId];
  if (!resolved) {
    throw new Error(`未知 koala-lab target: ${targetId}`);
  }
  return {
    kind: 'prompt',
    id: targetId,
    entryFile: resolved[0],
    editableFiles: resolved,
  };
}

export function buildExperimentConfig(args: {
  id?: string;
  name?: string;
  target: string;
  profile: string;
  editableFiles?: string[];
}): LabExperimentConfig {
  const target = defaultTarget(args.target, args.editableFiles);
  const profileSlug = slugify(args.profile);
  const targetAlias: Record<string, string> = {
    'test-case-reviewer': 'reviewer',
    'test-intent': 'intent',
    'session-brief': 'session-brief',
  };
  const targetSlug = targetAlias[target.id] || slugify(target.id.replace(/^test-/, ''));
  const id = args.id || `lab-${targetSlug}-${profileSlug}`;
  const name = args.name || `Optimize ${target.id}`;

  return {
    $schema: 'koala-lab/experiment.v1',
    id,
    name,
    status: 'draft',
    mode: 'offline',
    target,
    baseline: {
      source: 'working-tree',
      ref: 'HEAD',
    },
    dataset: {
      profile: args.profile,
      source: 'lab-dataset',
      datasetId: `${profileSlug}-sample-v1`,
      trainSplit: 0.6,
      devSplit: 0.2,
      holdoutSplit: 0.2,
    },
    budget: {
      maxIterations: 8,
      maxWallClockMinutes: 75,
      perIterationTimeoutMinutes: 8,
      repeatsPerCandidate: 2,
    },
    candidatePolicy: {
      strategy: 'rewrite_prompt',
      maxChangedFiles: 1,
      maxChangedLines: 35,
      allowDependencyChanges: false,
      allowStoryMutation: false,
      allowFixtureMutation: false,
      allowDocsStoryMutation: false,
      allowTestsFixturesMutation: false,
    },
    selectionPolicy: {
      minScoreGain: 0.03,
      requireNoRegression: true,
      requireHoldoutPass: true,
      tieBreak: 'lower_complexity',
    },
    scoring: {
      qualityWeight: 0.6,
      latencyWeight: 0.15,
      complexityWeight: 0.15,
      stabilityWeight: 0.1,
    },
    guards: {
      mustRunInIsolatedWorktree: true,
      forbidMainBranchWrite: true,
      forbidDestructiveGit: true,
    },
    outputs: {
      runDir: `experiments/runs/${id}`,
      baselineDir: 'experiments/baselines',
      reportFormat: 'md',
    },
  };
}

export function validateExperimentConfig(config: LabExperimentConfig): void {
  if (config.mode !== 'offline') {
    throw new Error(`koala-lab 第一版仅支持 offline 模式，当前收到: ${config.mode}`);
  }
  if (config.candidatePolicy.allowStoryMutation || config.candidatePolicy.allowFixtureMutation) {
    throw new Error('koala-lab 第一版不允许打开 allowStoryMutation / allowFixtureMutation');
  }
  if (config.candidatePolicy.allowDocsStoryMutation || config.candidatePolicy.allowTestsFixturesMutation) {
    throw new Error('koala-lab 第一版不允许修改 docs/story 或 tests/fixtures');
  }
  if (config.target.editableFiles.length === 0) {
    throw new Error('koala-lab 目标至少需要一个 editableFiles 入口');
  }
}
