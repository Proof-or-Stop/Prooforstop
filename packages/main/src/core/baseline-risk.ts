import { execFileSync } from 'child_process';

export interface BaselineRiskEntry {
  code: string;
  path: string;
  volatile: boolean;
}

export interface BaselineRisk {
  total: number;
  materialTotal: number;
  entries: BaselineRiskEntry[];
  materialEntries: BaselineRiskEntry[];
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

function parseStatusPath(line: string): string | null {
  const raw = line.slice(3).trim();
  if (!raw) return null;
  const renameMarker = ' -> ';
  const path = raw.includes(renameMarker)
    ? raw.slice(raw.indexOf(renameMarker) + renameMarker.length)
    : raw;
  return normalizePath(path.replace(/^"|"$/g, ''));
}

function isUnder(path: string, parent: string): boolean {
  const p = normalizePath(path);
  const base = normalizePath(parent).replace(/\/+$/, '');
  return p === base || p.startsWith(`${base}/`);
}

function isVolatilePath(path: string): boolean {
  return path.startsWith('.omx/') || path === 'docs/story/activity.jsonl';
}

export function collectBaselineRisk(
  repoRoot: string,
  opts: { excludePaths?: string[]; maxEntries?: number } = {},
): BaselineRisk {
  const excluded = (opts.excludePaths || []).map(normalizePath);
  const maxEntries = opts.maxEntries ?? 8;
  let raw = '';
  try {
    raw = execFileSync('git', ['status', '--porcelain', '-uall'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).replace(/\n+$/, '');
  } catch {
    return { total: 0, materialTotal: 0, entries: [], materialEntries: [] };
  }
  if (!raw) return { total: 0, materialTotal: 0, entries: [], materialEntries: [] };

  const all = raw.split('\n')
    .map((line) => {
      const path = parseStatusPath(line);
      if (!path) return null;
      return { code: line.slice(0, 2), path, volatile: isVolatilePath(path) };
    })
    .filter((entry): entry is BaselineRiskEntry => Boolean(entry))
    .filter((entry) => !excluded.some((parent) => isUnder(entry.path, parent)));

  const material = all.filter((entry) => !entry.volatile);
  return {
    total: all.length,
    materialTotal: material.length,
    entries: all.slice(0, maxEntries),
    materialEntries: material.slice(0, maxEntries),
  };
}

export function renderBaselineRiskLines(risk: BaselineRisk, opts: {
  prefix?: string;
  includeVolatileSummary?: boolean;
} = {}): string[] {
  if (risk.materialTotal === 0) return [];
  const prefix = opts.prefix || '⚠ Baseline risk';
  const lines = [
    `${prefix}: ${risk.materialTotal} dirty/untracked path(s) will NOT be visible inside story worktrees unless committed or copied.`,
  ];
  for (const entry of risk.materialEntries) {
    lines.push(`  - ${entry.code.trim() || 'M'} ${entry.path}`);
  }
  if (risk.materialTotal > risk.materialEntries.length) {
    lines.push(`  - ... ${risk.materialTotal - risk.materialEntries.length} more`);
  }
  if (opts.includeVolatileSummary && risk.total > risk.materialTotal) {
    lines.push(`  (${risk.total - risk.materialTotal} volatile workspace path(s) hidden)`);
  }
  lines.push('→ Commit, stash, or intentionally copy these files before relying on the worktree baseline.');
  return lines;
}
