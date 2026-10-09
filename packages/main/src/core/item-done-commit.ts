/**
 * Old-PoS run 34 (bench-staging/oldpos/run34-analysis.md §4 sink 2): after the
 * pinned test passed, every implementer item ended with the same four turns
 * (`git diff --check` + `git status`, `git add` + `git commit --author=...`,
 * `checklist_update done`, the report), about 3 min / 3M per run. The
 * implementer's `checklist_update {status:'done', commit:{files}}` now does the
 * mechanical part in one call, with the same checks it made by hand:
 *   1. stage exactly the listed files;
 *   2. `git diff --cached --check` on them: a whitespace error is refused, the
 *      listed files are unstaged again and nothing is committed;
 *   3. commit them as the canonical implementer author with the item's message
 *      (`<storyId> <itemId>: <title>`), unless nothing changed (an earlier
 *      commit already holds them);
 * then checklist_update runs its own done checks unchanged. A done refused
 * after the commit keeps the commit, exactly as the hand-made commit was kept.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { isAbsolute, normalize } from 'node:path';

export const IMPLEMENTER_COMMIT_AUTHOR = 'proof-or-stop-implementer <proof-or-stop-implementer@noreply.local>';
export const ITEM_DONE_DIFF_CHECK_REFUSED = 'item_done_diff_check';
export const ITEM_DONE_FILES_INVALID = 'item_done_files_invalid';

export interface ItemDoneCommitInput { files?: unknown; message?: unknown }
export interface ItemDoneCommitResult { commit: string | null; files: string[]; status: string }

function git(cwd: string, args: string[]): { status: number; out: string } {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { status: run.status ?? -1, out: `${run.stdout ?? ''}${run.stderr ?? ''}`.trim() };
}

/** The listed files, validated: relative paths inside the worktree, never PoS metadata. */
export function itemDoneFiles(input: ItemDoneCommitInput | undefined): string[] {
  const files = input?.files;
  if (!Array.isArray(files) || files.length === 0 || files.some(file => typeof file !== 'string' || !file.trim())) {
    throw new Error(`checklist_update refused: commit.files must list the changed product/test files to commit (relative paths) [${ITEM_DONE_FILES_INVALID}]`);
  }
  const out = [...new Set((files as string[]).map(file => normalize(file.trim()).replace(/\\/g, '/')))];
  const bad = out.filter(file => isAbsolute(file) || file === '..' || file.startsWith('../') || file.startsWith('.proof-or-stop/') || file === '.proof-or-stop');
  if (bad.length) {
    throw new Error(`checklist_update refused: commit.files must be relative worktree paths outside .proof-or-stop/ (got ${bad.join(', ')}) [${ITEM_DONE_FILES_INVALID}]`);
  }
  return out;
}

/**
 * Stage, check and commit the item's files (steps 1-3 above). Throws with the
 * `git diff --check` output and nothing committed on a whitespace error.
 */
export function commitItemForDone(args: { gitCwd: string; input: ItemDoneCommitInput; defaultMessage: string; storyId: string }): ItemDoneCommitResult {
  const files = itemDoneFiles(args.input);
  const message = typeof args.input.message === 'string' && args.input.message.trim() ? args.input.message.trim() : args.defaultMessage;
  const added = git(args.gitCwd, ['add', '--', ...files]);
  if (added.status !== 0) throw new Error(`checklist_update refused: git add of commit.files failed: ${added.out.slice(0, 600)} [${ITEM_DONE_FILES_INVALID}]`);
  const check = git(args.gitCwd, ['diff', '--cached', '--check', '--', ...files]);
  if (check.status !== 0 || check.out) {
    git(args.gitCwd, ['reset', '-q', '--', ...files]);
    throw new Error(`checklist_update refused: git diff --check reports whitespace errors in the files to commit; nothing was committed and the item is not done [${ITEM_DONE_DIFF_CHECK_REFUSED}]\n${check.out.slice(0, 1500)}\n`
      + `Next: fix each listed line, then run the same checklist_update '${JSON.stringify({ storyId: args.storyId, status: 'done', commit: { files } })}' again (with your itemId).`);
  }
  const staged = git(args.gitCwd, ['diff', '--cached', '--name-only', '--', ...files]).out;
  let commit: string | null = null;
  if (staged) {
    const committed = git(args.gitCwd, ['commit', '-q', `--author=${IMPLEMENTER_COMMIT_AUTHOR}`, '-m', message, '--', ...files]);
    if (committed.status !== 0) throw new Error(`checklist_update refused: git commit failed: ${committed.out.slice(0, 800)} [${ITEM_DONE_FILES_INVALID}]`);
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: args.gitCwd, encoding: 'utf8' }).trim();
  }
  return { commit, files, status: git(args.gitCwd, ['status', '--short']).out };
}
