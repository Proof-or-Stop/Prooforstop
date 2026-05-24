/**
 * @task B-6bfd
 * @checklist CHK-002
 * @title Mechanical scope diff pack
 * @type feature
 * @priority high
 * @description
 *   Builds a compact, deterministic diff context pack for semantic scope
 *   review. The pack is a reviewer input, not a new truth source.
 * @changes
 *   - [CHK-002] Add diffPackHash, changed files, hunks, anchors, key paths, and parseFallback.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScopeDiffHunk, ScopeDiffPack } from './types.js';
import { readChangedFiles } from './scope-contract.js';

export function digestScopeDiffPack(pack: Omit<ScopeDiffPack, 'diffPackHash'>): string {
  return createHash('sha256').update(JSON.stringify({
    changedFiles: pack.changedFiles,
    hunks: pack.hunks.map(h => ({
      path: h.path,
      oldStart: h.oldStart,
      oldLines: h.oldLines,
      newStart: h.newStart,
      newLines: h.newLines,
      header: h.header,
      anchor: h.anchor,
      keyPath: h.keyPath,
      parseFallback: h.parseFallback,
      hunkDigest: h.hunkDigest,
      changeKind: h.changeKind,
    })),
  })).digest('hex');
}

function hashHunk(path: string, header: string, body: string[]): string {
  return createHash('sha256').update([path, header, ...body].join('\n')).digest('hex');
}

function parseHunkHeader(line: string): { oldStart: number; oldLines: number; newStart: number; newLines: number } | null {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    oldLines: match[2] ? Number(match[2]) : 1,
    newStart: Number(match[3]),
    newLines: match[4] ? Number(match[4]) : 1,
  };
}

function inferChangeKind(body: string[]): ScopeDiffHunk['changeKind'] {
  const added = body.some(line => line.startsWith('+') && !line.startsWith('+++'));
  const removed = body.some(line => line.startsWith('-') && !line.startsWith('---'));
  if (added && removed) return 'modify';
  if (added) return 'add';
  if (removed) return 'remove';
  return 'modify';
}

function nearestTsAnchor(source: string, lineNumber: number): string | undefined {
  const lines = source.split(/\r?\n/);
  const limit = Math.max(0, Math.min(lineNumber - 1, lines.length - 1));
  for (let i = limit; i >= 0; i--) {
    const line = lines[i];
    const fn = line.match(/\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/);
    if (fn) return fn[1];
    const cls = line.match(/\bclass\s+([A-Za-z_$][\w$]*)\b/);
    if (cls) return cls[1];
    const constant = line.match(/\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (constant) return constant[1];
    const method = line.match(/^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/);
    if (method) return method[1];
  }
  return undefined;
}

function inferPackageKeyPath(body: string[]): string | undefined {
  for (const raw of body) {
    if (!raw.startsWith('+') && !raw.startsWith('-')) continue;
    const line = raw.slice(1);
    const match = line.match(/"([^"]+)"\s*:/);
    if (match) return match[1];
  }
  return undefined;
}

export function parseUnifiedDiff(projectRoot: string, diffText: string): ScopeDiffHunk[] {
  const hunks: ScopeDiffHunk[] = [];
  let currentPath = '';
  let currentHeader = '';
  let currentRange: ReturnType<typeof parseHunkHeader> = null;
  let currentBody: string[] = [];

  function flush(): void {
    if (!currentPath || !currentHeader || !currentRange) return;
    const sourcePath = join(projectRoot, currentPath);
    const isTsLike = /\.(ts|tsx|js|jsx|mts|mjs|cts|cjs)$/.test(currentPath);
    const isPackageJson = currentPath.endsWith('package.json') || currentPath.endsWith('.json');
    let anchor: string | undefined;
    let keyPath: string | undefined;
    let parseFallback: string | undefined;
    if (isTsLike && existsSync(sourcePath)) {
      anchor = nearestTsAnchor(readFileSync(sourcePath, 'utf8'), currentRange.newStart);
      if (!anchor) parseFallback = 'no_nearest_ts_anchor';
    } else if (isPackageJson) {
      keyPath = inferPackageKeyPath(currentBody);
      if (!keyPath) parseFallback = 'no_json_key_detected';
    } else {
      parseFallback = 'unsupported_file_type';
    }
    hunks.push({
      path: currentPath,
      oldStart: currentRange.oldStart,
      oldLines: currentRange.oldLines,
      newStart: currentRange.newStart,
      newLines: currentRange.newLines,
      header: currentHeader,
      anchor,
      keyPath,
      parseFallback,
      changeKind: inferChangeKind(currentBody),
      hunkDigest: hashHunk(currentPath, currentHeader, currentBody),
    });
  }

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      flush();
      currentPath = '';
      currentHeader = '';
      currentRange = null;
      currentBody = [];
      continue;
    }
    if (line.startsWith('+++ b/')) {
      currentPath = line.slice('+++ b/'.length);
      continue;
    }
    if (line.startsWith('@@ ')) {
      flush();
      currentHeader = line;
      currentRange = parseHunkHeader(line);
      currentBody = [];
      continue;
    }
    if (currentHeader) currentBody.push(line);
  }
  flush();
  return hunks;
}

function readUnifiedDiff(projectRoot: string): string {
  const parts: string[] = [];
  for (const args of [
    ['diff', '--unified=20', 'main...HEAD'],
    ['diff', '--unified=20'],
    ['diff', '--unified=20', '--cached'],
  ]) {
    try {
      const output = execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (output) parts.push(output);
    } catch { /* ignore non-git contexts */ }
  }
  return parts.join('\n');
}

export function buildScopeDiffPack(projectRoot: string, now = new Date().toISOString()): ScopeDiffPack {
  const packWithoutHash = {
    changedFiles: readChangedFiles(projectRoot),
    hunks: parseUnifiedDiff(projectRoot, readUnifiedDiff(projectRoot)),
    generatedAt: now,
  };
  return {
    ...packWithoutHash,
    diffPackHash: digestScopeDiffPack(packWithoutHash),
  };
}
