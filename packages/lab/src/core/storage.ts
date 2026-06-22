/**
 * @task B-9ba3
 * @checklist CHK-001
 * @title lattice-lab storage keeps experiments and runs auditable
 * @type feature
 * @priority high
 * @description
 *   lattice-lab 的实验价值在于“每次尝试都能被追溯和比较”。storage 负责把
 *   experiment config、run artifacts、summary 和 placeholder result 统一落到
 *   experiments/ 目录，形成后续 compare/promote 的最小数据面。
 * @changes
 *   - [CHK-001] 新增 experiments/configs baselines runs 的落盘协议
 *   - [CHK-003] 为 run 创建 config snapshot、metrics、result、summary 等基础文件
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import type { LabBaselineRecord, LabExperimentConfig, LabRunMetrics, LabRunResult } from '../types.js';
import { validateExperimentConfig } from './config.js';

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function writeJson(path: string, data: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function resolveConfigPath(root: string, configPath: string): string {
  return isAbsolute(configPath) ? configPath : join(root, configPath);
}

export function ensureExperimentDirs(root: string, config: LabExperimentConfig): void {
  ensureDir(join(root, 'experiments'));
  ensureDir(join(root, 'experiments', 'configs'));
  ensureDir(join(root, config.outputs.baselineDir));
  ensureDir(join(root, config.outputs.runDir));
}

export function writeExperimentConfig(root: string, config: LabExperimentConfig): string {
  validateExperimentConfig(config);
  ensureExperimentDirs(root, config);
  const path = join(root, 'experiments', 'configs', `${config.id}.json`);
  writeJson(path, config);
  return path;
}

export function readExperimentConfig(root: string, configPath: string): LabExperimentConfig {
  const resolved = resolveConfigPath(root, configPath);
  const config = JSON.parse(readFileSync(resolved, 'utf8')) as LabExperimentConfig;
  validateExperimentConfig(config);
  return config;
}

export function nextRunId(root: string, config: LabExperimentConfig): string {
  ensureExperimentDirs(root, config);
  const runRoot = join(root, config.outputs.runDir);
  const indices = readdirSync(runRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^run-\d+$/.test(entry.name))
    .map((entry) => Number(entry.name.slice(4)))
    .filter((value) => Number.isFinite(value));
  const next = (indices.length ? Math.max(...indices) : 0) + 1;
  return `run-${String(next).padStart(3, '0')}`;
}

export function writeRunArtifacts(args: {
  root: string;
  config: LabExperimentConfig;
  runId: string;
  configSnapshot: LabExperimentConfig;
  metrics: LabRunMetrics;
  result: LabRunResult;
  summary: string;
}): string {
  const runDir = join(args.root, args.config.outputs.runDir, args.runId);
  ensureDir(runDir);
  ensureDir(join(runDir, 'logs'));
  writeJson(join(runDir, 'config.snapshot.json'), args.configSnapshot);
  writeJson(join(runDir, 'metrics.json'), args.metrics);
  writeJson(join(runDir, 'result.json'), args.result);
  writeFileSync(join(runDir, 'summary.md'), args.summary, 'utf8');
  return runDir;
}

export function writeBaselineRecord(root: string, config: LabExperimentConfig, record: LabBaselineRecord): string {
  ensureExperimentDirs(root, config);
  const path = join(root, config.outputs.baselineDir, `${config.id}.json`);
  writeJson(path, record);
  return path;
}

export function readBaselineRecord(root: string, config: LabExperimentConfig): LabBaselineRecord | null {
  const path = join(root, config.outputs.baselineDir, `${config.id}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as LabBaselineRecord;
}

export function listRunResults(root: string, config: LabExperimentConfig): Array<{ runId: string; result: LabRunResult }> {
  const runRoot = join(root, config.outputs.runDir);
  if (!existsSync(runRoot)) return [];
  return readdirSync(runRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(runRoot, entry.name, 'result.json')))
    .map((entry) => ({
      runId: entry.name,
      result: JSON.parse(readFileSync(join(runRoot, entry.name, 'result.json'), 'utf8')) as LabRunResult,
    }))
    .sort((a, b) => a.runId.localeCompare(b.runId));
}
