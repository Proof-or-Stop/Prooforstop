/**
 * @task B-9ba3
 * @checklist CHK-004
 * @title lattice-lab patch policy rejects writes outside the experiment whitelist
 * @type feature
 * @priority high
 * @description
 *   lattice-lab 第一版的关键护栏是“即便实验点子很好，也不能碰 story/fixture 和
 *   未授权源码”。patch policy 负责解析 touched paths，并基于 editableFiles 和
 *   永久禁止目录做双重校验。
 * @changes
 *   - [CHK-004] 拦截 docs/story 和 tests/fixtures 这类正式流程数据路径
 *   - [CHK-004] 仅允许候选 patch 触碰 experiment.target.editableFiles 白名单
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadLabProjectConfig } from './project-config.js';
import type { LabExperimentConfig, LabPatchPolicyReport } from '../types.js';

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\//, '');
}

function blockedPrefixes(root: string): string[] {
  const config = loadLabProjectConfig(root);
  const values = [config.storyDir, config.fixturesDir, 'docs/story', 'tests/fixtures'];
  return values.map((value) => normalize(value));
}

export function parsePatchTouchedPaths(patchText: string): string[] {
  const paths = new Set<string>();
  for (const line of patchText.split('\n')) {
    const match = line.match(/^(?:\+\+\+|---) [ab]\/(.+)$/);
    if (match && match[1] !== '/dev/null') {
      paths.add(normalize(match[1]));
    }
  }
  return [...paths];
}

export function evaluatePatchPolicy(root: string, config: LabExperimentConfig, touchedPaths: string[]): LabPatchPolicyReport {
  const normalized = touchedPaths.map(normalize);
  const editable = new Set(config.target.editableFiles.map(normalize));
  const blocked = blockedPrefixes(root);
  const violations: string[] = [];

  for (const path of normalized) {
    if (blocked.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      violations.push(`blocked protected path: ${path}`);
      continue;
    }
    if (!editable.has(path)) {
      violations.push(`path not in editableFiles whitelist: ${path}`);
    }
  }

  return {
    ok: violations.length === 0,
    touchedPaths: normalized,
    violations,
  };
}

export function readPatchFile(root: string, patchFile: string): string {
  const resolved = patchFile.startsWith('/') ? patchFile : join(root, patchFile);
  return readFileSync(resolved, 'utf8');
}
