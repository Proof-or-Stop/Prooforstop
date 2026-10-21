/**
 * Lab round-cut N3 (bench-staging/oldpos/run74-75-analysis.md §7 N3): accepted duplicates are closed
 * by the framework.
 *
 * Run 75 spent three owner turns (about 2.4 min) on critic duplicates whose coverage the owner only
 * had to name: the canonical finding's repair commit had added the test that runs the duplicate's
 * own repro, and the framework then ran it. When that is mechanically true, the framework names the
 * same coverage itself: a Go test function the canonical repair commit added or changed whose body
 * (at the current head) states every repro span of the duplicate (`Repro:` / `Probe:` spans, else
 * its probe-like code spans, core/resolved-finding-guard.ts findingRepros). The closure then runs
 * exactly as before (finding_resolve duplicateOf + coverage: the repro check, the live-canonical
 * check, the coverage run; a refusal is recorded and the finding gets its own repair). A duplicate
 * that states no repro, or whose repro no such test states, keeps the owner step.
 *
 * Detection-neutral: the same verification and refusal path; only who authors the coverage command.
 *
 * Lab run132 (bench-staging/oldpos/run133-analysis.md item 4 D, 16.8 min observed): when the framework cannot name the
 * coverage, the owner step carried placeholders only, and run 133's owner spent 9 calls guessing where the findings,
 * the canonical repair and its tests are. `duplicateCoverageSuggestion` prefills the call from the same facts: the Go
 * test function the canonical's repair commit added or changed that shares most terms with the duplicate's text, its
 * commit, and a resolution citing both. The framework still runs the coverage and refuses one
 * that does not pass or does not run the duplicate's repro, exactly as for an owner-authored call.
 */
import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import type { Finding } from './types.js';
import { findingRepros, goTestBodies, repairCommitFromResolution, reproCoverage } from './resolved-finding-guard.js';

export interface FrameworkDuplicateCoverage { command: string; selector: string; test: string; file: string; commit: string; resolution: string }

function git(cwd: string, args: string[]): string | null {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }); } catch { return null; }
}

/** Go test functions a commit added or changed (by the new-side lines of its diff), per test file. */
export function commitTestFunctions(gitCwd: string, commit: string): Array<{ file: string; name: string }> {
  const files = (git(gitCwd, ['show', '--no-renames', '--name-only', '--format=', commit]) ?? '').split('\n').map(line => line.trim()).filter(path => path.endsWith('_test.go'));
  const out: Array<{ file: string; name: string }> = [];
  for (const file of files.slice(0, 20)) {
    const after = git(gitCwd, ['show', `${commit}:${file}`]);
    if (!after) continue;
    const touched = new Set<number>();
    for (const match of (git(gitCwd, ['show', '-U0', '--no-color', '--format=', commit, '--', file]) ?? '').matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const start = Number(match[1]); const count = match[2] === undefined ? 1 : Number(match[2]);
      for (let line = start; line < start + Math.max(count, 1); line += 1) touched.add(line);
    }
    const lines = after.split('\n');
    for (const [name, body] of goTestBodies(after)) {
      const start = lines.findIndex(line => new RegExp(`^func\\s+${name}\\s*\\(`).test(line)) + 1;
      if (start <= 0) continue;
      const end = start + body.split('\n').length - 1;
      if ([...touched].some(line => line >= start && line <= end)) out.push({ file, name });
    }
  }
  return out;
}

/**
 * The framework's coverage of a duplicate through its canonical's repair, or null (no repair commit,
 * no stated repro, no Go test of that commit stating every repro span at the current head).
 */
export function frameworkDuplicateCoverage(args: { gitCwd: string; finding: Pick<Finding, 'id' | 'desc'>; canonical: Pick<Finding, 'id' | 'resolvedReason'> & { resolutionType?: Finding['resolutionType'] } }): FrameworkDuplicateCoverage | null {
  const { repros } = findingRepros(args.finding.desc ?? '');
  if (!repros.length) return null;
  const commit = repairCommitFromResolution(args.gitCwd, args.canonical);
  if (!commit) return null;
  for (const candidate of commitTestFunctions(args.gitCwd, commit)) {
    const current = git(args.gitCwd, ['show', `HEAD:${candidate.file}`]);
    const body = current ? goTestBodies(current).get(candidate.name) : undefined;
    if (!body) continue;
    const dir = posix.dirname(candidate.file);
    const command = `go test -v ${dir === '.' ? '.' : `./${dir}`} -run ^${candidate.name}$`;
    const coverage = reproCoverage({ desc: args.finding.desc ?? '', sourceText: body, command });
    if (!coverage.checked || coverage.missing.length) continue;
    const short = (id: string): string => id.split(':').pop() ?? id;
    return { command, selector: `--- PASS: ${candidate.name}`, test: candidate.name, file: candidate.file, commit,
      resolution: `duplicate of ${short(args.canonical.id)}: its repair ${commit.slice(0, 12)} added or changed ${candidate.name} (${candidate.file}), which runs this finding's repro ${coverage.repros.map(repro => `\`${repro}\``).join(', ')} (coverage named by the framework)` };
  }
  return null;
}

export interface DuplicateCoverageSuggestion { command: string; selector: string; test: string; file: string; commit: string; others: string[]; resolution: string }

/** Lab run132: lower-case terms of a text (identifiers and words of four letters or more). */
const terms = (text: string): Set<string> => new Set((text.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? []).map(term => term.toLowerCase()));

/**
 * Lab run132 (run 133 D): the prefilled coverage of a duplicate through its canonical's repair commit: the Go test
 * function of that commit sharing most terms with the duplicate's text (the first one on a tie), or null (no repair
 * commit, no Go test in it). `others` names the commit's other tests for the owner.
 */
export function duplicateCoverageSuggestion(args: { gitCwd: string; finding: Pick<Finding, 'id' | 'desc'>; canonical: Pick<Finding, 'id' | 'resolvedReason'> & { resolutionType?: Finding['resolutionType'] } }): DuplicateCoverageSuggestion | null {
  const commit = repairCommitFromResolution(args.gitCwd, args.canonical);
  if (!commit) return null;
  const tests = commitTestFunctions(args.gitCwd, commit);
  if (!tests.length) return null;
  const want = terms(args.finding.desc ?? '');
  const scored = tests.map(test => {
    const current = git(args.gitCwd, ['show', `HEAD:${test.file}`]);
    const body = current ? goTestBodies(current).get(test.name) ?? '' : '';
    return { ...test, score: [...terms(`${test.name} ${body}`)].filter(term => want.has(term)).length };
  });
  const chosen = scored.reduce((best, test) => (test.score > best.score ? test : best), scored[0]!);
  const dir = posix.dirname(chosen.file);
  const short = (id: string): string => id.split(':').pop() ?? id;
  return { command: `go test -v ${dir === '.' ? '.' : `./${dir}`} -run ^${chosen.name}$`, selector: `--- PASS: ${chosen.name}`, test: chosen.name, file: chosen.file, commit,
    others: [...new Set(scored.map(test => test.name))].filter(name => name !== chosen.name),
    resolution: `duplicate of ${short(args.canonical.id)}: its repair ${commit.slice(0, 12)} added or changed ${chosen.name} (${chosen.file}), which runs this finding's case` };
}
