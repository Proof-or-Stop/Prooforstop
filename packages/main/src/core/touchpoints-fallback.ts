/**
 * F-021: touchpoints 回退扫描。
 *
 * understanding.touchpoints 为空（或 understanding 未落地）时，story 若实际修改了
 * `.md` 文件也会因为 resolveOptInReviewers 只看 touchpoints 而丢掉 docs reviewer。
 * 这里回扫 `git diff main...HEAD --name-only` 的 .md 文件列表，作为 touchpoints
 * 的兜底输入交给 resolveOptInReviewers。
 *
 * 该函数做 IO（git exec），不放在 reviewer-opt-in.ts（那里保持纯函数）。
 * 所有需要"touchpoints 为空时回退"的调用方（story-advance / machine guards /
 * reviewer_list）统一从这里拿。
 */
import { execSync } from 'child_process';

export function detectMdTouchpointsFromGit(root: string): string[] | undefined {
  try {
    const out = execSync('git diff main...HEAD --name-only', {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    if (!out) return undefined;
    const mdFiles = out.split('\n').filter(f => f.endsWith('.md'));
    return mdFiles.length > 0 ? mdFiles : undefined;
  } catch {
    return undefined;
  }
}
