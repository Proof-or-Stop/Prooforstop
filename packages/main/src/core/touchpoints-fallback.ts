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

export function detectMdTouchpointsFromGit(root: string): string[] | undefined {
  try {
    const out = execSync('git diff main...HEAD --name-only', {
      cwd: root,
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
