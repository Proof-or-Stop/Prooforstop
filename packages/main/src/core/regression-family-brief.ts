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
 *
 * Lab run89 (run88-89-analysis.md §3.4, §5 fix 3): run 89's printer family ran F-004 -> F-007 -> F-010 -> F-011, one
 * more variant per round, each repair's `[family]` lines wrong for the next one, because the mechanism under repair
 * existed only to satisfy an invented pin no request sentence states. From the second `[regression-of]` link of a chain
 * on (the third report of one mechanism) the brief adds a mechanism-level block: name what requires the mechanism in a
 * `[mechanism]` line (a request sentence verbatim, a pinned row, or none); none requires it -> remove it and restore the
 * base behaviour; only a row requires it -> `[pin-doubt]` (the framework re-derives the row); a request sentence
 * requires it -> fix the whole mechanism with one generated test over every kind it touches. The managed worker asks
 * for a missing or unverifiable `[mechanism]` line in the same session (core/repair-report-lines.ts).
 */
import { execFileSync } from 'node:child_process';
import type { Finding } from './types.js';
import { findingRepros, regressionTargets, repairCommitFromResolution } from './resolved-finding-guard.js';
import { recordMechanismRequirement } from './repair-report-lines.js';

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

/**
 * The regression chain ending at `finding`, oldest first (short ids): each step follows the first `[regression-of]` target
 * that exists in `findings`. One finding = no chain; `[F-001, F-002]` = one link; three or more = a mechanism-level repair.
 */
export function regressionChain(findings: readonly Pick<Finding, 'id' | 'desc'>[], storyId: string, finding: Pick<Finding, 'id' | 'desc'>): string[] {
  const chain: string[] = [finding.id];
  const seen = new Set(chain);
  let current: Pick<Finding, 'id' | 'desc'> | undefined = finding;
  while (current) {
    const next: Pick<Finding, 'id' | 'desc'> | undefined = regressionTargets(current.desc ?? '', storyId).map(id => findings.find(row => row.id === id)).find((row): row is Finding => Boolean(row) && !seen.has(row!.id));
    if (!next) break;
    chain.unshift(next.id);
    seen.add(next.id);
    current = next;
  }
  return chain.map(id => shortId(storyId, id));
}

/** Links from which the repair is mechanism-level (the second `[regression-of]` of one chain). */
export const MECHANISM_CHAIN_LINKS = 2;

/** The mechanism-level block of a chain's repair prompt (run 89 F-010: the third report of one mechanism). */
export function mechanismRepairLines(chain: readonly string[]): string[] {
  return [
    `Mechanism-level repair (framework): this is report ${chain.length} of one mechanism (${chain.join(' -> ')}); each earlier repair fixed one more variant and the next round found the next one. Before patching another variant:`,
    '- Name the mechanism under repair (the function or change those repairs edited) and what requires it, in ONE report line: `[mechanism] <mechanism>: required by request "<verbatim request sentence>"`, or `[mechanism] <mechanism>: required by row <CHK-NNN:lane:i>`, or `[mechanism] <mechanism>: none -> removed`.',
    '- If no request sentence and no row requires it, the repair is to remove the mechanism (and the tests and rows that pin only it), restoring the Story base behaviour for those inputs; do not patch another variant.',
    '- If only a pinned row requires it and the request is silent, keep the Story base behaviour and report `[pin-doubt] <CHK-NNN:lane:i> | base prints: <base output> | request: silent` (the framework re-derives the row).',
    '- If a request sentence requires it, fix the whole mechanism at once with ONE test that iterates over every node / input kind the mechanism touches (generated from the type or kind list, not a hand-picked few).',
    '- A final report without a valid [mechanism] line is asked for it before your run ends.',
  ];
}

/**
 * Record the `[mechanism]` line a chain finding's repair owes (read by the managed worker's report follow-up) when the
 * chain has at least MECHANISM_CHAIN_LINKS links and the brief carries the block. Returns whether it was recorded.
 */
export function recordChainMechanismRequirement(args: { root: string; storyId: string; findings: readonly Finding[]; finding: Pick<Finding, 'id' | 'desc'>; requestText: string | null }): boolean {
  const earlier = regressionTargets(args.finding.desc ?? '', args.storyId).some(id => args.findings.some(row => row.id === id && row.status === 'resolved'));
  const chain = regressionChain(args.findings, args.storyId, args.finding);
  if (!earlier || chain.length - 1 < MECHANISM_CHAIN_LINKS) return false;
  recordMechanismRequirement(args.root, args.storyId, { findingId: args.finding.id, chain, requestText: args.requestText });
  return true;
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
  // Lab run89 (fix 3): from the second [regression-of] link on, the repair is about the mechanism, not the next variant.
  const chain = regressionChain(args.findings, storyId, finding);
  if (chain.length - 1 >= MECHANISM_CHAIN_LINKS) lines.push(...mechanismRepairLines(chain));
  return lines;
}
