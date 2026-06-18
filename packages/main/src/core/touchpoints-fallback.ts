/**
 * F-021: touchpoints fallback scan.
 *
 * When understanding.touchpoints is empty (or understanding is not yet persisted), if the story actually modifies
 * `.md` files, the docs reviewer will be dropped because resolveOptInReviewers only looks at touchpoints.
 * Here we scan back the list of .md files from `git diff main...HEAD --name-only` as a fallback input for touchpoints
 * and pass it to resolveOptInReviewers.
 *
 * This function performs IO (git exec), so it does not belong in reviewer-opt-in.ts (which stays pure-function).
 * All callers needing "fallback when touchpoints is empty" (transition-effects / machine guards /
 * reviewer_list) should obtain it uniformly from here.
 */
import { execSync } from 'child_process';
import { loadConfig } from './config.js';
import { resolveProjectGitCwd } from './story-signed-workspace-resolution.js';

export function detectMdTouchpointsFromGit(root: string): string[] | undefined {
  // B-75f0 CHK-002: this helper is called from many id-less contexts (machine
  // guards, transition-effects, reviewer-list — several fall back to
  // process.cwd() with no storyId), so it takes only `root` and resolves the git
  // cwd id-independently. On a wrapper-root layout the passed root is the non-git
  // metadataRoot; resolveProjectGitCwd surveys the REAL gitRoot (configured
  // subdir or metadata git toplevel — config is loaded so a configured subdir is
  // honored) so the `git diff main...HEAD` that drives docs-reviewer routing runs
  // in the actual repo instead of failing in the wrapper. On a plain repo (or
  // when no gitRoot resolves) it returns `root` verbatim, byte-identical to
  // before. The `undefined` fallback on any git failure is preserved (callers
  // treat undefined as "no .md touchpoints detected", never crash).
  let gitCwd: string;
  try {
    gitCwd = resolveProjectGitCwd(root, root, loadConfig(root));
  } catch {
    gitCwd = root;
  }
  try {
    const out = execSync('git diff main...HEAD --name-only', {
      cwd: gitCwd,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!out) return undefined;
    const mdFiles = out.split('\n').filter(f => f.endsWith('.md'));
    return mdFiles.length > 0 ? mdFiles : undefined;
  } catch {
    return undefined;
  }
}
