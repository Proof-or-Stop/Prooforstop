/**
 * Story change manifest: the merge-base resolver and the NUL-framed changed-file
 * reader shared by evidence hashing (evidence-freshness) and the story-aware
 * validation planner. A leaf over git helpers only, so evidence-freshness does
 * not import the planner (that edge closed the 55-module core import cycle).
 * story-aware-validation re-exports everything here under its old names.
 */
import { readStoryGitBytes } from './story-git-bytes.js';
import { isMaterialExcludedPath } from './material-path-policy.js';
import { resolveRepositoryBaseline } from './git-baseline.js';

export interface StoryChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
  blobId?: string;
}

function objectIdsFromTree(raw: string, ref: string): Map<string, string> {
  const result = new Map<string, string>();
  try {
    for (const row of raw.split('\0')) {
      if (!row) continue;
      const tab = row.indexOf('\t');
      if (tab < 0) continue;
      const parts = row.slice(0, tab).trim().split(/\s+/);
      const path = row.slice(tab + 1);
      if (parts[2] && path) result.set(path, parts[2]);
    }
  } catch (error) {
    throw new Error(`story change manifest could not read tree ${ref}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return result;
}
export function resolveStoryMergeBase(gitCwd: string, head: string): string | undefined {
  return resolveRepositoryBaseline(gitCwd, head)?.mergeBase;
}

/** Shared changed-file resolver. Rename rows retain both old and new paths. */
export function resolveStoryChangedFiles(
  gitCwd: string,
  ref = 'HEAD',
  metadataRoot = gitCwd,
  explicitBaseHead?: string,
): StoryChangedFile[] {
  const base = explicitBaseHead?.trim() || resolveStoryMergeBase(gitCwd, ref);
  if (!base) {
    throw new Error(`story change manifest could not resolve a merge base for ${ref}`);
  }
  const raw = readStoryGitBytes(gitCwd, base, ref);
  const ids = objectIdsFromTree(raw.tree, ref);
  const out: StoryChangedFile[] = [];
  try {
    // NUL framing preserves Git path names, including Unicode, tabs and newlines.
    const fields = raw.diff.split('\0');
    if (fields.at(-1) === '') fields.pop();
    let cursor = 0;
    const nextPath = (): string => {
      const value = fields[cursor++];
      if (!value) throw new Error('missing path in NUL-delimited Git diff');
      return value;
    };
    const blobAt = (path: string): string => {
      const blob = ids.get(path);
      if (!blob) throw new Error(`missing target object for ${JSON.stringify(path)}`);
      return blob;
    };
    while (cursor < fields.length) {
      const code = fields[cursor++];
      if (!code || !/^(?:[ADMTUXB]|[RC][0-9]+)$/.test(code)) throw new Error('invalid Git diff status');
      const firstPath = nextPath();
      if (code.startsWith('R') || code.startsWith('C')) {
        const oldPath = firstPath;
        const path = nextPath();
        if (code.startsWith('R') && !isMaterialExcludedPath(oldPath, metadataRoot)) out.push({ path: oldPath, oldPath, status: 'renamed', blobId: '<deleted>' });
        if (!isMaterialExcludedPath(path, metadataRoot)) out.push({ path, oldPath, status: code.startsWith('R') ? 'renamed' : 'added', blobId: blobAt(path) });
      } else {
        const path = firstPath;
        if (isMaterialExcludedPath(path, metadataRoot)) continue;
        const status: StoryChangedFile['status'] = code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified';
        out.push({ path, status, blobId: status === 'deleted' ? '<deleted>' : blobAt(path) });
      }
    }
  } catch (error) {
    throw new Error(`story change manifest diff failed for ${base}..${ref}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || (a.oldPath || '').localeCompare(b.oldPath || ''));
}
