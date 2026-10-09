/**
 * Old-PoS run 31 (REM2): a repair worker, blocked from editing checklist.json,
 * "repaired" a userSees finding with a Go test that parses
 * `.proof-or-stop/story/actives/B-6f26/checklist.json`, and it shipped in
 * model.patch. Product code and tests never read PoS metadata: the scope gate
 * (REVIEW/TEST/DONE entry) refuses any added line of a product file (not Story
 * metadata, not a runtime artifact) that references this Story's metadata
 * directory: the Story id together with `.proof-or-stop` or `story/actives`.
 * Generic `.proof-or-stop` mentions (e.g. PoS developing itself) are not
 * refused; only a reference to this Story's own metadata is.
 */
import { execFileSync } from 'node:child_process';
import { isMaterialExcludedPath } from './material-path-policy.js';
import { resolveRepositoryBaseline } from './git-baseline.js';

export const SCOPE_STORY_METADATA_REFERENCE = 'scope_story_metadata_reference';

export interface StoryMetadataReference { path: string; line: string }

/** Added product lines (Story base to the work tree) that reference the Story's own metadata. */
export function storyMetadataReferences(gitCwd: string, storyId: string, metadataRoot = gitCwd): StoryMetadataReference[] {
  const baseline = resolveRepositoryBaseline(gitCwd);
  if (!baseline?.mergeBase) return [];
  let diff = '';
  try {
    diff = execFileSync('git', ['diff', '-U0', '--no-color', '--no-ext-diff', baseline.mergeBase], { cwd: gitCwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return []; }
  const id = storyId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reference = new RegExp(`(?:\\.proof-or-stop|story[/\\\\"', ]+actives)[^\\n]*\\b${id}\\b|\\b${id}\\b[^\\n]*(?:\\.proof-or-stop|story[/\\\\"', ]+actives)`);
  const out: StoryMetadataReference[] = [];
  let path: string | null = null;
  for (const row of diff.split('\n')) {
    if (row.startsWith('+++ ')) {
      const target = row.slice(4).trim();
      path = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (path && isMaterialExcludedPath(path, metadataRoot)) path = null;
      continue;
    }
    if (!path || !row.startsWith('+') || row.startsWith('+++')) continue;
    if (reference.test(row)) out.push({ path, line: row.slice(1).trim().slice(0, 200) });
  }
  return out;
}

/** The scope-gate refusal, or null. */
export function storyMetadataReferenceRefusal(phase: string, gitCwd: string, storyId: string, metadataRoot = gitCwd): string | null {
  const rows = storyMetadataReferences(gitCwd, storyId, metadataRoot);
  if (rows.length === 0) return null;
  return `Cannot enter ${phase}: product code references this Story's PoS metadata (.proof-or-stop/.../${storyId}) [${SCOPE_STORY_METADATA_REFERENCE}]:\n`
    + rows.slice(0, 8).map(row => `  - ${row.path}: ${row.line}`).join('\n')
    + '\n→ Product code and tests never read PoS metadata (checklist.json is the Story\'s acceptance text, not a fixture): remove these lines and test the behavior itself. '
    + 'A wrong checklist text is corrected with checklist_update (metadataCorrection), never by a test.';
}
