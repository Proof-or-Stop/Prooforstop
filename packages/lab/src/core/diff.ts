/**
 * @task B-17a6
 * @checklist CHK-001
 * @title koala-lab diff core emits a real candidate patch artifact for reviewer targets
 * @type feature
 * @priority high
 * @description
 *   reviewer MVP 的关键不只是 score，而是 run 目录里真的有一份可审查的 patch。
 *   这里负责从 baseline ref 与当前 workspace 的 editableFiles 之间生成统一 diff，
 *   并在落盘前再用 patch policy 做一次白名单校验。
 * @changes
 *   - [CHK-001] 为 lab_run 生成真实 patch.diff
 *   - [CHK-001] 对 no-op diff 与越权 patch 给出结构化结果
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { LabExperimentConfig } from '../types.js';
import { evaluatePatchPolicy, parsePatchTouchedPaths } from './patch-policy.js';

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export function createCandidatePatch(args: {
  root: string;
  config: LabExperimentConfig;
  runId: string;
}): {
  patchPath: string | null;
  patchText: string;
  touchedPaths: string[];
  violations: string[];
} {
  const patchText = execFileSync('git', ['diff', '--binary', args.config.baseline.ref, '--', ...args.config.target.editableFiles], {
    cwd: args.root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (!patchText.trim()) {
    return {
      patchPath: null,
      patchText: '',
      touchedPaths: [],
      violations: [],
    };
  }

  const touchedPaths = parsePatchTouchedPaths(patchText);
  const report = evaluatePatchPolicy(args.root, args.config, touchedPaths);
  if (!report.ok) {
    return {
      patchPath: null,
      patchText,
      touchedPaths: report.touchedPaths,
      violations: report.violations,
    };
  }

  const relativePatchPath = `${args.config.outputs.runDir}/${args.runId}/patch.diff`;
  const absolutePatchPath = join(args.root, relativePatchPath);
  ensureDir(dirname(absolutePatchPath));
  writeFileSync(absolutePatchPath, patchText, 'utf8');

  return {
    patchPath: relativePatchPath,
    patchText,
    touchedPaths: report.touchedPaths,
    violations: [],
  };
}
