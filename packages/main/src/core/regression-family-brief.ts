/**
 * Old-PoS run 73 (bench-staging/oldpos/run73-analysis.md §6 B): the family-complete repair brief of a
 * regression finding.
 *
 * Run 73's "selector evaluated twice" defect was repaired four times: the first repair fixed the
 * direct case with a test of the direct case only, and three later findings (tagged
 * `[regression-of F-007]`) re-found the same mechanism through other target shapes. A finding that
 * says it re-found a resolved finding says the earlier repair did not cover its case, so the repair
 * prompt carries what that repair changed (its diff) and the earlier finding's repro, and requires
 * ONE test over every call site and every target shape of the mechanism, listed in the final report
 * on a `[family-test]` line. Prompt only: nothing is skipped and every finding is still resolved
 * through its own verified repair. Generic wording, no task values.
 */
import { execFileSync } from 'node:child_process';
import type { Finding } from './types.js';
import { findingRepros, regressionTargets, repairCommitFromResolution } from './resolved-finding-guard.js';

const DIFF_MAX = 3500;
const DESC_MAX = 240;
const BRIEFS_MAX = 2;

const oneLine = (text: string, max: number): string => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const shortId = (storyId: string, id: string): string => (id.startsWith(`${storyId}:`) ? id.slice(storyId.length + 1) : id);

function repairDiff(gitCwd: string, commit: string): string {
  try {
    const text = execFileSync('git', ['show', '--format=', '--no-renames', '-U2', commit], { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
    return text.length > DIFF_MAX ? `${text.slice(0, DIFF_MAX)}\n… (diff truncated; read it with \`git show ${commit.slice(0, 12)}\`)` : text;
  } catch { return ''; }
}

/** The brief lines for one finding; empty when it names no resolved finding with a repair commit. */
export function regressionFamilyBrief(args: { findings: readonly Finding[]; storyId: string; finding: Pick<Finding, 'id' | 'desc'>; gitCwd: string }): string[] {
  const { storyId, finding } = args;
  const earlier = regressionTargets(finding.desc ?? '', storyId)
    .map(id => args.findings.find(row => row.id === id && row.status === 'resolved'))
    .filter((row): row is Finding => Boolean(row)).slice(0, BRIEFS_MAX);
  if (!earlier.length) return [];
  const lines: string[] = [`Family-complete repair (${shortId(storyId, finding.id)} re-found ${earlier.map(row => shortId(storyId, row.id)).join(', ')}, so the earlier repair did not cover this case):`];
  for (const row of earlier) {
    const repros = findingRepros(row.desc).repros;
    lines.push(`- ${shortId(storyId, row.id)} (resolved): ${oneLine(row.desc, DESC_MAX)}${repros.length ? ` Repro: ${repros.map(repro => `\`${repro}\``).join(', ')}` : ''}`);
    const commit = repairCommitFromResolution(args.gitCwd, row);
    const diff = commit ? repairDiff(args.gitCwd, commit) : '';
    if (diff.trim()) lines.push(`- ${shortId(storyId, row.id)}'s repair ${commit!.slice(0, 12)}, as committed (it fixed the case it listed, not this one):`, '```diff', diff.trimEnd(), '```');
  }
  lines.push('- Treat that diff as the earlier attempt at THIS mechanism, not as its fix. Before editing, list every call site and every target shape of the mechanism it changed (grep the function and each of its callers; include the computed, nested, negative and edge variants of the same call).');
  lines.push('- Add ONE test that covers every call site and every target shape of the mechanism: the earlier finding\'s repro, this finding\'s repro and each shape you found. Run it before you commit.');
  lines.push('- In your final report add one line `[family-test] <test name>: <shape>, <shape>, ...` listing what that test covers.');
  return lines;
}
