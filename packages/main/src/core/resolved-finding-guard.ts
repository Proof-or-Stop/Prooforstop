/**
 * Resolved-finding integrity (old-PoS run 46; no switch: detection-neutral or
 * detection-adding, never skipping a check).
 *
 * Run 46 (bench-staging/oldpos/run46-analysis.md §0, §2.3 items 3-5, §5): a
 * correct repair of finding A was reversed by the repair of a later finding B
 * (a sibling-parity finding that picked the wrong oracle); two lanes re-found
 * the regression, and both re-found findings were closed as duplicates of A
 * with a coverage test that never ran their own probe, while A's repair had
 * already been overwritten. Later lanes trusted `resolved`. A verified finding
 * was closed formally, not substantively, and the defect shipped.
 *
 * This module holds the mechanics; handlers/finding.ts and next-driver.ts call it.
 *
 *   - findingRepros: a finding's own repro (an explicit `Repro: \`...\``
 *     marker, else the probe-like code spans of its description).
 *   - regressionTargets: the resolved finding ids a finding declares it
 *     re-found (`[regression-of F-001]`, "reintroduces F-001", ...).
 *   - findingGuard: the covering verification recorded when a finding was
 *     resolved: the Go tests its repair commit added or changed (as they stood
 *     in that commit), or the passing coverage run that closed it as a
 *     duplicate (as its tests stood at that HEAD).
 *   - runFindingGuard: re-runs it on the current code with the test source as
 *     recorded (a later repair that also rewrote the test cannot hide the
 *     reversal); a build failure of the restored test source is inconclusive
 *     and falls back to the current test source.
 *   - regressionGuardCheck: after a repair, every resolved finding whose cited
 *     files changed since its resolution is re-verified; a failure blames the
 *     repairs that touched those files (lab group-conflict-blame: of several
 *     with separable commits, only those after the newest member commit where
 *     the recorded test passes; they are not accepted) and the caller
 *     opens a regression finding (the finding ledger keeps exactly one terminal
 *     transition per finding, so a reopen is a new open finding
 *     `[regression-of <id>]` carrying the resolved finding's case).
 *   - canonicalFixLiveness / reproCoverage: the duplicate-closure checks (the
 *     canonical's fix is still live; the cited coverage runs the duplicate's
 *     own repro).
 *
 * Old-PoS run 58 (bench-staging/oldpos/run58-analysis.md §4, §7 fixes A-C): the
 * guard replayed every row of every test function a repair commit touched, as
 * the commit wrote it. Rows of OTHER cases encoded behaviour a later pin or a
 * later, more correct repair legitimately changed, so the guard fired 45 times,
 * opened 7 stale `[regression-of]` findings and rejected 4 correct repairs.
 *   A. scope `repro`: of a repair's Go test functions only those stating the
 *      finding's repro run, and within a table literal only the rows stating it
 *      (filterGoTestRows); the whole functions run only when the finding states
 *      no repro or no test row states it (scope `functions`).
 *   B. before blaming, a failed guard is judged against the current checklist
 *      pins of its case (a row pinning the snapshot's value keeps the blame; a
 *      row pinning another value excuses it: the pin decides) and, with no pin,
 *      against the Story base: the restored test run on the base fails exactly
 *      as it does on the current code (the code keeps the base's behaviour of
 *      that case) = the snapshot was wrong, not the repair (`excused`). A test
 *      the base cannot build (new behaviour) is never excused.
 *   C. checklist epoch: a guard whose case rows changed after the finding's
 *      resolution to a value the snapshot does not state is retired (process
 *      event `resolved_finding_guard_retired`); a whole-function guard runs on
 *      the current test source once any item's intent changed since.
 *
 * Lab stale-cross-pin (old-PoS run 149, Story B-55bd; switch remediation.staleCrossPin, default on): a grouped repair
 * committed F-001 and then F-002, whose fix re-pinned a DEV row of another case inside F-001's touched test function;
 * both were resolved in one batch, whose members were never guarded against each other, so F-001's scope-`functions`
 * guard was born stale. A later test-only repair of F-003 was told it broke F-001 (two resumed turns) and finding_resolve
 * opened F-004 `[regression-of F-001]` ("a later commit"), one more repair session that changed only tests.
 *   D. a failed guard whose only failing rows a later framework-bound repair of another verified finding, resolved before
 *      the repairs being judged (never the judged repair, a batch sibling, or what the judged run committed), re-pinned
 *      (staleCrossPinSources: its commit removed and re-added a line stating the failure-quoted case and changed a
 *      product file the guard cites; the row is not the guarded finding's own and does not state its repro) is re-run
 *      without those rows; passing, it is excused (`excused: sanctioned_repair`, `sanctionedBy`, `staleCases`): no
 *      blame, no regression finding, no resumed turn. The sanction comes from the managed run binding (finding_resolve)
 *      or the framework-appended repair-commit marker (dry run), never from free text such as an `[intent-conflict]`.
 *   E. at a batch acceptance, a member whose repair commit precedes another member's is guarded against the later
 *      members (event `batchSiblings`); a failure there blames only those later members, so a real sibling regression is
 *      decided where it is created. A failure explained only by a later sibling's re-pin is journaled `deferred` (neither
 *      blamed nor excused; a sibling being judged sanctions nothing) and is excused once that sibling is resolved.
 *
 * Lab group-conflict-blame (old-PoS run 150, Story B-9985; switch remediation.groupConflictBlame, default on): one grouped
 * repair committed F-007, F-008 and F-009 (one commit chain); only F-009's fix contradicts resolved F-001's covering test.
 * The guard blamed every repair whose commit touched F-001's cited file, so all three were rejected and re-repaired
 * through finding_conflict_pin (~33 min).
 *   G. a failed guard that blames two or more repairs with separable commits (groupBlameAttribution: distinct commits on
 *      one ancestry chain, each after the guard's snapshot) is re-run as recorded (the snapshot's test source, never the
 *      judged commits') at the member commits, newest-but-one first; at the newest commit where it passes, every blamed
 *      member whose commit is that commit or an ancestor of it is cleared (its work is proven not to break the guard)
 *      and only the later members stay blamed (event `blameAttribution`). The newest member is never cleared, so a
 *      blame is never emptied and the regression always stays open; one shared commit, no passing member commit, or a
 *      non-linear set keep every member blamed. Only git commits and executed tests decide, never report text.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import type { ChecklistItem, DuplicateCoverageReceipt, Finding } from './types.js';
import { loadConfig } from './config.js';
// Old-PoS run 68: leaf module (core/repair-value-change.ts uses them without this module's imports).
import { isTestPath, normalizeProbe } from './probe-text.js';
import { isFrameworkSettled } from './finding-conflict-settle.js';
import { commitsDiffText } from './commits-diff-text.js';
import { groupConflictBlameOn, staleCrossPinOn } from './ab-variants.js';
export { isTestPath, normalizeProbe };
import { parseAllowlistedCommand, resolveEvidenceCommandTimeoutMs, tokenizeCommandString } from './validation-executor.js';
import { effectiveValidationCommandEnvironment } from './validation-command-environment.js';
import { changedGoTestFunctions, parsePinnedTestSelection, parseUnifiedZeroDiff, pinSelectsGoTest } from './evidence-chain-check.js';

/** Process event: one re-run of a resolved finding's covering verification. */
export const REGRESSION_GUARD_EVENT = 'resolved_finding_guard_checked';
/** Old-PoS run 58 (C): a guard retired by the checklist epoch (its case was re-pinned after its resolution). */
export const REGRESSION_GUARD_RETIRED_EVENT = 'resolved_finding_guard_retired';

const REPRO_MAX = 6;
const OUTPUT_TAIL_MAX = 1200;

// ---------------------------------------------------------------------------
// Repros and regression markers

const RUNNER_WORD = /^(?:go|npm|npx|node|yarn|pnpm|bun|deno|python3?|pytest|cargo|make|bash|sh|zsh|jest|vitest|mvn|gradle|ruby|rspec|php|dotnet|java)\s/;


/**
 * A backticked span that reads as a probe input: an assignment, or a call /
 * index on a name, carrying a concrete literal; never a path, a file:line, a
 * runner command or a bare value (an output such as `[1, 2]` or an error text).
 */
export function isProbeLike(span: string): boolean {
  const text = span.trim();
  if (normalizeProbe(text).length < 3 || RUNNER_WORD.test(text)) return false;
  if (/^[\w./-]+(?::\d+(?:-\d+)?)?$/.test(text)) return false;
  if (!/\d|"|'/.test(text)) return false;
  return /[A-Za-z_][\w.]*\s*[([]/.test(text) || /(?:^|[^=!<>:])=(?:$|[^=>])/.test(text);
}

/** A runner command span (`go test ...`, `npm test ...`): a repro the coverage command itself may be. */
export function isReproCommand(span: string): boolean {
  return RUNNER_WORD.test(span.trim());
}

/**
 * The finding's own repro: the spans after an explicit `Repro:` / `Probe:`
 * marker (all of them are required), else its probe-like code spans (any one
 * of them suffices). Empty when the description states no concrete case.
 */
export function findingRepros(desc: string): { explicit: boolean; repros: string[] } {
  const text = String(desc ?? '');
  const explicit: string[] = [];
  for (const marker of text.matchAll(/\b(?:repro|probe)s?\s*:\s*/gi)) {
    let rest = text.slice((marker.index ?? 0) + marker[0].length);
    for (;;) {
      const span = rest.match(/^(?:\s*(?:,|;|and|then|\+)\s*|\s*)`([^`\n]+)`/);
      if (!span) break;
      explicit.push(span[1]!.trim());
      rest = rest.slice(span[0].length);
    }
  }
  if (explicit.length) return { explicit: true, repros: [...new Set(explicit)].slice(0, REPRO_MAX) };
  const spans = [...text.matchAll(/`([^`\n]+)`/g)].map(match => match[1]!.trim()).filter(span => isProbeLike(span) || isReproCommand(span));
  return { explicit: false, repros: [...new Set(spans)].slice(0, REPRO_MAX) };
}

/** Full ids of the findings this one says it re-found (`[regression-of F-001]`, "reintroduces F-001", "regression of F-001", "reopens F-001"). */
export function regressionTargets(desc: string, storyId: string): string[] {
  const out = new Set<string>();
  const text = String(desc ?? '');
  const patterns = [/\[regression-of\s+(?:[\w-]+:)?(F-\d+)\]/gi, /\b(?:reintroduc\w*|regression\s+of|reopen\w*|re-?breaks?)\s+(?:the\s+)?(?:fix\s+(?:of|for)\s+)?(?:[\w-]+:)?(F-\d+)\b/gi];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) out.add(`${storyId}:${match[1]!.toUpperCase()}`);
  return [...out];
}

/**
 * Whether a coverage source runs the repro: an explicit repro needs every
 * span (or the coverage command itself, for a runner command); a heuristic
 * one needs at least one. `checked` is false when the finding states no repro.
 */
export function reproCoverage(args: { desc: string; sourceText: string; command: string }): { checked: boolean; explicit: boolean; repros: string[]; missing: string[] } {
  const { explicit, repros } = findingRepros(args.desc);
  if (!repros.length) return { checked: false, explicit, repros, missing: [] };
  const source = normalizeProbe(args.sourceText);
  const command = normalizeProbe(args.command);
  const covered = (repro: string): boolean => {
    const probe = normalizeProbe(repro);
    return isReproCommand(repro) ? command.includes(probe) || probe.includes(command) : source.includes(probe) || command.includes(probe);
  };
  const missing = repros.filter(repro => !covered(repro));
  return { checked: true, explicit, repros, missing: explicit ? missing : (missing.length === repros.length ? missing : []) };
}

// ---------------------------------------------------------------------------
// Git helpers

function git(gitCwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
}
function tryGit(gitCwd: string, args: string[]): string | null {
  try { return git(gitCwd, args); } catch { return null; }
}


/**
 * The repair commit a resolution names (`material commit <sha>` of a
 * framework-verified repair, `[repair commit <sha> ...]` of a batch resolve,
 * or any commit id it cites that changed a material file): the fallback when
 * no managed repair run is bound to the finding.
 */
export function repairCommitFromResolution(gitCwd: string, finding: Pick<Finding, 'resolvedReason'> & { resolutionType?: Finding['resolutionType'] }): string | null {
  // A disposition without a repair (it names the Story base and the reviewed head as evidence) has no repair commit.
  if (finding.resolutionType === 'preexisting_out_of_scope' || finding.resolutionType === 'accepted_risk') return null;
  // Lab run110: a file-state settlement repaired nothing either.
  if (isFrameworkSettled({ status: 'resolved', resolutionType: finding.resolutionType, resolvedReason: finding.resolvedReason })) return null;
  for (const match of String(finding.resolvedReason ?? '').matchAll(/\b[0-9a-f]{7,40}\b/g)) {
    const sha = tryGit(gitCwd, ['rev-parse', '--verify', '--quiet', `${match[0]}^{commit}`])?.trim();
    if (sha && commitFiles(gitCwd, sha).length) return sha;
  }
  return null;
}

/** Files a commit changed, with their status letter (A/M/D/R...). */
function commitFiles(gitCwd: string, commit: string): Array<{ path: string; status: string }> {
  const out = tryGit(gitCwd, ['show', '--no-renames', '--name-status', '--format=', commit]) ?? '';
  return out.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const [status, ...rest] = line.split('\t');
    return { status: (status ?? '').charAt(0), path: rest.join('\t') };
  }).filter(row => row.path);
}

/** Test function bodies of one Go test file, by name (brace-balanced span from the declaration). */
export function goTestBodies(content: string): Map<string, string> {
  const lines = content.split('\n');
  const out = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(/^func\s+(Test[^\s(]*)\s*\(\s*\w+\s+\*testing\.T\s*\)/);
    if (!match) continue;
    let depth = 0; let opened = false; let end = i;
    for (let j = i; j < lines.length; j++) {
      if (j > i && /^func\s/.test(lines[j]!)) { end = j - 1; break; }
      end = j;
      for (const ch of lines[j]!) { if (ch === '{') { depth += 1; opened = true; } else if (ch === '}') depth -= 1; }
      if (opened && depth <= 0) break;
    }
    out.set(match[1]!, lines.slice(i, end + 1).join('\n'));
  }
  return out;
}

function goModulePath(gitCwd: string, ref: string | null): string | null {
  const text = ref ? tryGit(gitCwd, ['show', `${ref}:go.mod`]) : (existsSync(join(gitCwd, 'go.mod')) ? readFileSync(join(gitCwd, 'go.mod'), 'utf8') : null);
  const match = text?.match(/^module\s+(\S+)/m);
  return match ? match[1]!.replace(/^"|"$/g, '') : null;
}

function fileAt(gitCwd: string, ref: string | null, path: string): string | null {
  if (ref) return tryGit(gitCwd, ['show', `${ref}:${path}`]);
  try { return readFileSync(join(gitCwd, path), 'utf8'); } catch { return null; }
}

/** The Go tests a `go test` command selects at `ref` (null = the work tree): file and body of each. */
export function goSelectedTests(gitCwd: string, command: string, ref: string | null): Array<{ name: string; file: string; body: string }> | null {
  const selection = parsePinnedTestSelection(command, goModulePath(gitCwd, ref));
  if (selection.kind !== 'go_test') return null;
  const listed = (ref ? tryGit(gitCwd, ['ls-tree', '-r', '--name-only', ref]) : tryGit(gitCwd, ['ls-files'])) ?? '';
  const files = listed.split('\n').map(line => line.trim()).filter(path => path.endsWith('_test.go'));
  const out: Array<{ name: string; file: string; body: string }> = [];
  for (const file of files) {
    const packageDir = posix.dirname(file) === '.' ? '' : posix.dirname(file);
    const inPackage = selection.packages.some(pkg => pkg.dir === packageDir || (pkg.recursive && (pkg.dir === '' || packageDir.startsWith(`${pkg.dir}/`))));
    if (!inPackage) continue;
    const content = fileAt(gitCwd, ref, file);
    if (content === null) continue;
    for (const [name, body] of goTestBodies(content)) {
      if (pinSelectsGoTest(selection, { name, file, packageDir })) out.push({ name, file, body });
    }
  }
  return out;
}

/**
 * The source a coverage command runs, for the repro check: the bodies of the
 * Go tests it selects; for another runner, the files its arguments name, else
 * the test files the Story changed (`fallbackFiles`).
 */
export function coverageSourceText(gitCwd: string, command: string, fallbackFiles: readonly string[] = []): string {
  const go = goSelectedTests(gitCwd, command, null);
  if (go) return go.map(test => test.body).join('\n');
  let tokens: string[] = [];
  try { tokens = tokenizeCommandString(command); } catch { tokens = []; }
  const named = tokens.map(token => token.split('::')[0]!).filter(token => /[./]/.test(token) && existsSync(join(gitCwd, token)) && !token.startsWith('-'));
  const files = named.length ? named : [...fallbackFiles];
  return files.map(file => { try { return readFileSync(join(gitCwd, file), 'utf8'); } catch { return ''; } }).join('\n').slice(0, 4 * 1024 * 1024);
}

// ---------------------------------------------------------------------------
// Guards

export interface FindingGuard {
  findingId: string;
  kind: 'repair' | 'duplicate';
  /** The commit whose test source the guard runs (the repair commit, or the HEAD of the duplicate's coverage run). */
  snapshotRef: string;
  runs: Array<{ command: string; selectors: string[] }>;
  testFiles: string[];
  /** Files whose change since the snapshot re-runs the guard (the finding's files and the repair's non-test files). */
  citedFiles: string[];
  /**
   * Old-PoS run 58 (A): `repro` = only the test functions (and table rows) stating the finding's
   * repro run; `functions` = every changed test function (no repro, or none stated in a test).
   */
  scope?: 'repro' | 'functions';
  /** The finding's code repros the guard judges (scope `repro`). */
  repros?: string[];
  /** Scope `repro`: the filtered snapshot bodies that replace the recorded ones when the guard runs. */
  filtered?: Array<{ file: string; name: string; original: string; body: string }>;
  /** Scope `repro`: the recorded text of the selected test functions (repro rows only), for the pin comparison. */
  recordedText?: string;
}

// ---------------------------------------------------------------------------
// Old-PoS run 58 (A): the finding's own repro rows of a Go table test

/** Top-level brace groups of a Go function body that are composite-literal elements (`{` after `{` or `,`), with their parent literal. */
function goLiteralRows(body: string): Array<{ start: number; end: number; parent: number }> {
  const rows: Array<{ start: number; end: number; parent: number }> = [];
  const stack: number[] = [];
  let last = '';
  let open: { start: number; depth: number; parent: number } | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '/' && body[i + 1] === '/') { const end = body.indexOf('\n', i); i = end < 0 ? body.length : end - 1; continue; }
    if (c === '/' && body[i + 1] === '*') { const end = body.indexOf('*/', i + 2); i = end < 0 ? body.length : end + 1; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < body.length && body[j] !== c && body[j] !== '\n') { if (body[j] === '\\') j++; j++; }
      i = j; last = c; continue;
    }
    if (c === '`') { const end = body.indexOf('`', i + 1); i = end < 0 ? body.length : end; last = c; continue; }
    if (c === '{') {
      if (!open && (last === '{' || last === ',') && stack.length) open = { start: i, depth: stack.length, parent: stack.at(-1)! };
      stack.push(i);
    } else if (c === '}') {
      stack.pop();
      if (open && stack.length === open.depth) { rows.push({ start: open.start, end: i, parent: open.parent }); open = null; }
    }
    if (!/\s/.test(c)) last = c;
  }
  return rows;
}

/**
 * Old-PoS run 58 (A): keep only the table rows of a Go test body that state one
 * of `repros` (whitespace- and escape-insensitive). Only a literal holding at
 * least one such row is filtered; every other literal and statement stays.
 * `matched`: the body states a repro at all; `dropped`: rows removed.
 */
export function filterGoTestRows(body: string, repros: readonly string[]): { body: string; matched: boolean; dropped: number } {
  const probes = repros.map(normalizeProbe).filter(probe => probe.length >= 4);
  const states = (text: string) => { const flat = normalizeProbe(text); return probes.some(probe => flat.includes(probe)); };
  if (!probes.length || !states(body)) return { body, matched: false, dropped: 0 };
  const rows = goLiteralRows(body);
  const hitParents = new Set(rows.filter(row => states(body.slice(row.start, row.end + 1))).map(row => row.parent));
  const drop = rows.filter(row => hitParents.has(row.parent) && !states(body.slice(row.start, row.end + 1)));
  if (!drop.length) return { body, matched: true, dropped: 0 };
  return { body: dropGoRows(body, drop), matched: true, dropped: drop.length };
}

/** `body` without the given composite-literal rows (each with its trailing comma, and its whole line when it stands alone). */
function dropGoRows(body: string, drop: ReadonlyArray<{ start: number; end: number }>): string {
  let out = body;
  for (const row of [...drop].sort((a, b) => b.start - a.start)) {
    let start = row.start;
    let end = row.end + 1;
    while (end < out.length && /[ \t]/.test(out[end]!)) end++;
    if (out[end] === ',') end++;
    while (end < out.length && /[ \t]/.test(out[end]!)) end++;
    let lineStart = start;
    while (lineStart > 0 && /[ \t]/.test(out[lineStart - 1]!)) lineStart--;
    if ((lineStart === 0 || out[lineStart - 1] === '\n') && out[end] === '\n') { start = lineStart; end++; }
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

/**
 * The covering verification recorded when `finding` was resolved: for a
 * duplicate, its last passing coverage run; for a repair, the Go tests its
 * repair commit added or changed (one `go test -run` per package). Null when
 * nothing executable was recorded (then only the hunk check applies).
 */
export function findingGuard(args: { gitCwd: string; finding: Pick<Finding, 'id' | 'files' | 'resolutionType'> & { desc?: string }; repairCommit: string | null;
  coverage: DuplicateCoverageReceipt | null }): FindingGuard | null {
  const { gitCwd, finding } = args;
  const cited = new Set((finding.files ?? []).map(path => path.replace(/:\d.*$/, '')));
  if (finding.resolutionType === 'duplicate' && args.coverage?.passed && args.coverage.headHash) {
    const ref = args.coverage.headHash;
    const tests = goSelectedTests(gitCwd, args.coverage.command, ref);
    return { findingId: finding.id, kind: 'duplicate', snapshotRef: ref, runs: [{ command: args.coverage.command, selectors: [args.coverage.selector] }],
      testFiles: [...new Set((tests ?? []).map(test => test.file))], citedFiles: [...cited] };
  }
  const commit = args.repairCommit;
  if (!commit) return null;
  const files = commitFiles(gitCwd, commit);
  for (const row of files) if (!isTestPath(row.path)) cited.add(row.path);
  const goTests = files.filter(row => row.status !== 'D' && row.path.endsWith('_test.go'));
  if (!goTests.length) return null;
  const diff = parseUnifiedZeroDiff(tryGit(gitCwd, ['show', '-U0', '--no-renames', '--format=', commit, '--', ...goTests.map(row => row.path)]) ?? '');
  const changed: Array<{ file: string; dir: string; name: string; body: string }> = [];
  for (const row of goTests) {
    const content = fileAt(gitCwd, commit, row.path);
    if (content === null) continue;
    const names = changedGoTestFunctions(content, row.status === 'A' ? 'all' : (diff.get(row.path) ?? new Set()));
    const bodies = goTestBodies(content);
    const dir = posix.dirname(row.path) === '.' ? '' : posix.dirname(row.path);
    for (const name of names) changed.push({ file: row.path, dir, name, body: bodies.get(name) ?? '' });
  }
  if (!changed.length) return null;
  // Old-PoS run 58 (A): the finding's own repro rows, when its repair test states them.
  const repros = findingRepros(args.finding.desc ?? '').repros.filter(repro => !isReproCommand(repro));
  const filtered: NonNullable<FindingGuard['filtered']> = [];
  const own = repros.length ? changed.filter(test => {
    const kept = filterGoTestRows(test.body, repros);
    if (kept.matched && kept.dropped) filtered.push({ file: test.file, name: test.name, original: test.body, body: kept.body });
    return kept.matched;
  }) : [];
  const selected = own.length ? own : changed;
  const byPackage = new Map<string, Set<string>>();
  for (const test of selected) {
    const set = byPackage.get(test.dir) ?? new Set<string>();
    set.add(test.name);
    byPackage.set(test.dir, set);
  }
  const runs = [...byPackage].map(([dir, names]) => ({
    command: `go test -v ${dir ? `./${dir}` : '.'} -run ^(${[...names].join('|')})$`,
    selectors: [...names].map(name => `--- PASS: ${name}`),
  }));
  return { findingId: finding.id, kind: 'repair', snapshotRef: commit, runs, testFiles: [...new Set(selected.map(test => test.file))], citedFiles: [...cited],
    scope: own.length ? 'repro' : 'functions',
    ...(own.length ? { repros, filtered, recordedText: own.map(test => filtered.find(row => row.file === test.file && row.name === test.name)?.body ?? test.body).join('\n') } : {}) };
}

/** Whether a cited file of the guard (any material file when none is cited) changed between its snapshot and HEAD. */
export function guardTouched(gitCwd: string, guard: FindingGuard): boolean {
  const out = tryGit(gitCwd, ['diff', '--name-only', guard.snapshotRef, 'HEAD', ...(guard.citedFiles.length ? ['--', ...guard.citedFiles] : [])]);
  if (out === null) return true;
  const changed = out.split('\n').map(line => line.trim()).filter(Boolean);
  return guard.citedFiles.length ? changed.length > 0 : changed.some(path => !isTestPath(path));
}

export interface GuardResult { passed: boolean; inconclusive: boolean; command: string; outputTail: string; restoredTests: boolean }

export function runCommand(projectRoot: string, cwd: string, command: string): { status: number | null; output: string; missingTool: boolean } {
  const { executable, args } = parseAllowlistedCommand(command);
  let overrides;
  try { overrides = loadConfig(projectRoot).validate?.evidenceCommandTimeoutOverrides; } catch { overrides = undefined; }
  const run = spawnSync(executable, args, {
    cwd, encoding: 'utf8', timeout: resolveEvidenceCommandTimeoutMs({ executable, args }, overrides), maxBuffer: 32 * 1024 * 1024,
    env: effectiveValidationCommandEnvironment(process.env, undefined, cwd), stdio: ['ignore', 'pipe', 'pipe'],
  });
  const missingTool = (run.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}`, missingTool };
}

function runAll(projectRoot: string, cwd: string, guard: FindingGuard): { passed: boolean; buildFailed: boolean; missingTool: boolean; command: string; output: string } {
  for (const run of guard.runs) {
    let result;
    try { result = runCommand(projectRoot, cwd, run.command); } catch (error) {
      return { passed: false, buildFailed: false, missingTool: true, command: run.command, output: error instanceof Error ? error.message : String(error) };
    }
    const passed = result.status === 0 && run.selectors.every(selector => result.output.includes(selector));
    if (!passed) {
      return { passed: false, buildFailed: /\[build failed\]|\[setup failed\]|^#\s+\S+\n|cannot find package|undefined: /m.test(result.output),
        missingTool: result.missingTool, command: run.command, output: result.output };
    }
  }
  return { passed: true, buildFailed: false, missingTool: false, command: guard.runs.map(run => run.command).join(' && '), output: '' };
}

const tail = (text: string): string => text.trim().split('\n').slice(-10).join('\n').slice(-OUTPUT_TAIL_MAX);

/**
 * Re-run a guard on the current code. When its test files changed since the
 * snapshot, they run as recorded (in a temporary detached worktree of HEAD
 * with the snapshot's test files restored), so a repair that rewrote the test
 * along with the code cannot hide the reversal. A restored test source that no
 * longer builds is inconclusive: the guard then runs on the current test
 * source. A missing tool is inconclusive and never fails the guard.
 */
export function runFindingGuard(args: { projectRoot: string; gitCwd: string; guard: FindingGuard;
  /** Old-PoS run 58 (C): run on the current test source (a later checklist epoch made the snapshot non-authoritative). */
  currentTests?: boolean }): GuardResult & { output?: string } {
  const { projectRoot, gitCwd, guard } = args;
  const testsChanged = guard.testFiles.length > 0 && (tryGit(gitCwd, ['diff', '--name-only', guard.snapshotRef, 'HEAD', '--', ...guard.testFiles]) ?? '').trim() !== '';
  const current = (): GuardResult & { output?: string } => {
    const result = runAll(projectRoot, gitCwd, guard);
    return { passed: result.passed || result.missingTool, inconclusive: result.missingTool, command: result.command, outputTail: tail(result.output), restoredTests: false, output: result.output };
  };
  if (args.currentTests || (!testsChanged && !guard.filtered?.length)) return current();
  const restored = runRestoredAt({ projectRoot, gitCwd, guard, ref: 'HEAD' });
  if (!restored) return current();
  if (restored.passed) return { passed: true, inconclusive: false, command: restored.command, outputTail: '', restoredTests: true };
  if (restored.buildFailed || restored.missingTool) {
    const fallback = current();
    return { ...fallback, inconclusive: true, outputTail: fallback.passed ? `restored test source did not build; current tests pass\n${tail(restored.output)}` : fallback.outputTail };
  }
  return { passed: false, inconclusive: false, command: restored.command, outputTail: tail(restored.output), restoredTests: true, output: restored.output };
}

/** The guard's test files as recorded at its snapshot (scope `repro`: with only the repro rows), for a checkout. */
function restoredTestSources(gitCwd: string, guard: FindingGuard): Array<{ file: string; text: string | null }> {
  return guard.testFiles.map(file => {
    let text = tryGit(gitCwd, ['show', `${guard.snapshotRef}:${file}`]);
    for (const row of guard.filtered ?? []) if (text !== null && row.file === file) text = text.replace(row.original, row.body);
    return { file, text };
  });
}

/**
 * Run the guard in a temporary detached worktree of `ref` with its recorded test source restored (removed afterwards);
 * null when the checkout fails. `sources` replaces the recorded source (lab stale-cross-pin: the recorded source without
 * the stale rows).
 */
function runRestoredAt(args: { projectRoot: string; gitCwd: string; guard: FindingGuard; ref: string; sources?: ReadonlyArray<{ file: string; text: string | null }> }): ReturnType<typeof runAll> | null {
  const { gitCwd, guard } = args;
  const dir = mkdtempSync(join(tmpdir(), GUARD_TEMP_PREFIX));
  const checkout = join(dir, 'checkout');
  try {
    git(gitCwd, ['worktree', 'add', '--detach', '--quiet', checkout, args.ref]);
    for (const { file, text } of args.sources ?? restoredTestSources(gitCwd, guard)) {
      const target = join(checkout, file);
      if (text === null) { rmSync(target, { force: true }); continue; }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    return runAll(args.projectRoot, checkout, guard);
  } catch {
    return null;
  } finally {
    tryGit(gitCwd, ['worktree', 'remove', '--force', checkout]);
    rmSync(dir, { recursive: true, force: true });
    tryGit(gitCwd, ['worktree', 'prune']);
  }
}

/** The failure lines of a `go test` output (failing tests and their messages), timings dropped, sorted. */
export function failureSignature(output: string): string[] {
  return output.split('\n').map(line => line.replace(/\(\d+(?:\.\d+)?s\)/g, '').trim())
    .filter(line => /^--- FAIL:/.test(line) || /^[\w./-]+_test\.go:\d+:/.test(line)).sort();
}

// ---------------------------------------------------------------------------
// Lab stale-cross-pin (old-PoS run 149): a recorded row a later sanctioned repair re-pinned

/** Process-event excuse of a guard whose only failing rows a later framework-bound repair re-pinned. */
export const STALE_CROSS_PIN_EXCUSE = 'sanctioned_repair';

const isAncestor = (gitCwd: string, ancestor: string, descendant: string): boolean => {
  try { execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: gitCwd, stdio: 'ignore' }); return true; } catch { return false; }
};

/** The `-` / `+` lines a commit's diff gives one file (zero context). */
function commitDiffLines(gitCwd: string, commit: string, file: string): { removed: string[]; added: string[] } {
  const removed: string[] = []; const added: string[] = [];
  for (const line of (tryGit(gitCwd, ['show', '-U0', '--no-renames', '--format=', commit, '--', file]) ?? '').split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++')) continue;
    if (line.startsWith('-')) removed.push(line.slice(1)); else if (line.startsWith('+')) added.push(line.slice(1));
  }
  return { removed, added };
}

/** The Go string literals of a line (raw and interpreted, escapes kept as written). */
function goStringLiterals(line: string): string[] {
  return [...line.matchAll(/`([^`]*)`|"((?:[^"\\\n]|\\.)*)"/g)].map(match => match[1] ?? match[2] ?? '');
}

/**
 * The framework-appended repair commit of a resolution (`[repair commit <sha> of managed finding-repair run <id>]` of a
 * batch resolve, `material commit <sha> of managed finding-repair run <id>` of a framework-verified one): the LAST such
 * marker, so a marker quoted in owner-authored text before the framework's own never wins. Any other commit the text
 * names is no sanction (finding_resolve passes the managed run binding itself, handlers/finding.ts).
 */
export function frameworkRepairCommitOf(gitCwd: string, finding: Pick<Finding, 'resolvedReason'>): string | null {
  const marks = [...String(finding.resolvedReason ?? '').matchAll(/(?:\[repair commit|material commit) ([0-9a-f]{7,40}) of managed finding-repair run [^\s\]]+/g)];
  const sha = marks.at(-1)?.[1];
  return sha ? (tryGit(gitCwd, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`])?.trim() || null) : null;
}

export interface StaleCrossPinPlan {
  /** The recorded test source without the stale rows (one entry per guard test file). */
  sources: Array<{ file: string; text: string | null }>;
  /** The re-pinned case literals whose recorded rows were dropped. */
  staleCases: string[];
  /** The repairs whose commits re-pinned them. */
  sanctionedBy: Array<{ findingId: string; commit: string }>;
  droppedRows: number;
}

/**
 * Lab stale-cross-pin (old-PoS run 149): the recorded test source of a FAILED repair guard without its stale rows, or
 * null. A row is stale when ALL of these hold, each from git and the finding records (never from free text):
 *   - a failure line of the recorded run (`<file>_test.go:<n>: ...`) quotes a probe-like case literal;
 *   - a sanctioning repair (`sanctioners`: regressionGuardCheck passes only the framework-bound repair commits of verified
 *     findings resolved BEFORE the repairs being judged) whose commit descends from the guard's snapshot and is on HEAD, changed a non-test file the guard
 *     cites AND a guard test file, removing a line stating that case and adding a line stating it again (a re-pin; a
 *     deleted row or a test-only flip sanctions nothing);
 *   - the row is a composite-literal row of a selected test function and is NOT the guarded finding's own: no line its
 *     own repair commit added is in it, and it does not state the finding's repro.
 * Only whole stale rows are dropped (nothing the sanctioning commit added is applied), so the rest of the recorded test,
 * the guarded finding's own rows included, still has to pass. Duplicate-closure guards (no own repair diff) never qualify.
 */
export function staleCrossPinSources(args: { gitCwd: string; guard: FindingGuard; guarded: Pick<Finding, 'id' | 'desc'>; output: string;
  sanctioners: ReadonlyArray<{ findingId: string; commit: string }> }): StaleCrossPinPlan | null {
  const { gitCwd, guard } = args;
  if (guard.kind !== 'repair' || !guard.testFiles.length) return null;
  const failing = failureSignature(args.output).filter(line => /_test\.go:\d+:/.test(line)).map(normalizeProbe);
  if (!failing.length) return null;
  const cited = new Set(guard.citedFiles.filter(path => !isTestPath(path)));
  // Re-pinned cases quoted by a failure line, with the repairs that re-pinned them.
  const cases = new Map<string, { literal: string; by: Map<string, string> }>();
  const seen = new Set<string>();
  for (const row of args.sanctioners) {
    if (row.findingId === args.guarded.id || seen.has(`${row.findingId}\0${row.commit}`)) continue;
    seen.add(`${row.findingId}\0${row.commit}`);
    if (row.commit === guard.snapshotRef || !isAncestor(gitCwd, guard.snapshotRef, row.commit) || !isAncestor(gitCwd, row.commit, 'HEAD')) continue;
    const files = commitFiles(gitCwd, row.commit).map(file => file.path);
    if (!files.some(path => cited.has(path)) || !guard.testFiles.some(path => files.includes(path))) continue;
    const added = guard.testFiles.filter(path => files.includes(path)).map(path => commitDiffLines(gitCwd, row.commit, path));
    const addedFlat = added.flatMap(diff => diff.added).map(normalizeProbe);
    for (const literal of added.flatMap(diff => diff.removed).flatMap(goStringLiterals)) {
      const probe = normalizeProbe(literal);
      if (probe.length < 6 || !isProbeLike(literal.replace(/\\(["\\])/g, '$1'))) continue;
      if (!failing.some(line => line.includes(probe)) || !addedFlat.some(line => line.includes(probe))) continue;
      const entry = cases.get(probe) ?? { literal, by: new Map<string, string>() };
      entry.by.set(row.findingId, row.commit);
      cases.set(probe, entry);
    }
  }
  if (!cases.size) return null;
  // The guarded finding's own evidence: the test lines its repair commit added, and its repro.
  // Compared line by line (a row's full source lines, trailing punctuation included), so `{"c", F(c), "v"},` added by the
  // repair protects the row `{"c", F(c), "v"}`; bare brace lines carry no case and protect nothing.
  const own = new Set(guard.testFiles.flatMap(path => commitDiffLines(gitCwd, guard.snapshotRef, path).added).map(normalizeProbe).filter(line => line.length >= 4));
  const rowLines = (body: string, row: { start: number; end: number }): string[] => {
    const from = body.lastIndexOf('\n', row.start) + 1;
    const to = body.indexOf('\n', row.end);
    return body.slice(from, to < 0 ? body.length : to).split('\n').map(normalizeProbe);
  };
  const repros = findingRepros(args.guarded.desc ?? '').repros.filter(repro => !isReproCommand(repro)).map(normalizeProbe).filter(probe => probe.length >= 4);
  const names = new Set(guard.runs.flatMap(run => run.selectors.map(selector => selector.replace(/^--- PASS: /, ''))));
  const used = new Set<string>();
  let droppedRows = 0;
  const sources = restoredTestSources(gitCwd, guard).map(({ file, text }) => {
    if (text === null) return { file, text };
    let out = text;
    for (const [name, body] of goTestBodies(text)) {
      if (!names.has(name)) continue;
      const stale = goLiteralRows(body).filter(row => {
        const flat = normalizeProbe(body.slice(row.start, row.end + 1));
        const hit = [...cases.keys()].filter(probe => flat.includes(probe));
        if (!hit.length || rowLines(body, row).some(line => own.has(line)) || repros.some(probe => flat.includes(probe))) return false;
        for (const probe of hit) used.add(probe);
        return true;
      });
      if (!stale.length) continue;
      droppedRows += stale.length;
      const kept = dropGoRows(body, stale);
      out = out.replace(body, () => kept); // a function replacer: a Go body may contain `$&` / `$1`
    }
    return { file, text: out };
  });
  if (!droppedRows) return null;
  const sanctionedBy = new Map<string, string>();
  for (const probe of used) for (const [findingId, commit] of cases.get(probe)!.by) sanctionedBy.set(findingId, commit);
  return { sources, staleCases: [...used].map(probe => cases.get(probe)!.literal), droppedRows,
    sanctionedBy: [...sanctionedBy].map(([findingId, commit]) => ({ findingId, commit })) };
}

// ---------------------------------------------------------------------------
// Lab group-conflict-blame (old-PoS run 150): which member of a grouped repair broke a guard

/** Event evidence of a narrowed blame: who stays blamed, who is cleared, and the guard runs that decided it. */
export interface GroupBlameAttribution {
  implicated: string[];
  cleared: string[];
  /** The newest member commit where the guard's recorded test passes. */
  greenAt: string;
  checked: Array<{ commit: string; passed: boolean }>;
}

/**
 * Lab group-conflict-blame (old-PoS run 150): split a failed guard's blame among `blamed` repairs by executing the guard,
 * or null (ambiguous: keep blaming every member). Applies only when the members' commits (`commitOf`, default the
 * repair's own commit) are at least two distinct commits on ONE ancestry chain, each strictly after the guard's
 * snapshot. The recorded test (restoredTestSources: the snapshot's test files, its repro filter applied) runs in a
 * temporary checkout of each member commit but the newest, newest first; the first that passes (`greenAt`) clears every
 * member whose commit is it or an ancestor of it. A build failure, a missing tool or a failing run clears nothing at
 * that commit. The members after `greenAt` stay blamed, the newest always (whatever came after its commit is its
 * share), so the result never empties a blame. Commit labels only choose which member a commit belongs to (the
 * framework's managed-run binding); they can move blame between members, never drop it.
 */
export function groupBlameAttribution(args: { projectRoot: string; gitCwd: string; guard: FindingGuard;
  blamed: ReadonlyArray<{ findingId: string; commit: string }>; commitOf?: (findingId: string) => string | undefined }): GroupBlameAttribution | null {
  const { gitCwd, guard } = args;
  const full = (ref: string): string | null => tryGit(gitCwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])?.trim() || null;
  const members: Array<{ findingId: string; commit: string }> = [];
  for (const row of args.blamed) {
    const commit = full(args.commitOf?.(row.findingId) ?? row.commit);
    if (!commit) return null;
    members.push({ findingId: row.findingId, commit });
  }
  const commits = [...new Set(members.map(row => row.commit))];
  const snapshot = full(guard.snapshotRef);
  if (commits.length < 2 || !snapshot || commits.some(commit => commit === snapshot || !isAncestor(gitCwd, snapshot, commit))) return null;
  // One ancestry chain, oldest first (each commit an ancestor of the next).
  const chain = [...commits].sort((a, b) => (isAncestor(gitCwd, a, b) ? -1 : 1));
  for (let i = 0; i + 1 < chain.length; i++) if (!isAncestor(gitCwd, chain[i]!, chain[i + 1]!)) return null;
  const checked: GroupBlameAttribution['checked'] = [];
  for (let i = chain.length - 2; i >= 0; i--) {
    const run = runRestoredAt({ projectRoot: args.projectRoot, gitCwd, guard, ref: chain[i]! });
    const passed = Boolean(run?.passed && !run.missingTool);
    checked.push({ commit: chain[i]!, passed });
    if (!passed) continue;
    const upTo = new Set(chain.slice(0, i + 1));
    const cleared = members.filter(row => upTo.has(row.commit)).map(row => row.findingId);
    const implicated = members.filter(row => !upTo.has(row.commit)).map(row => row.findingId);
    if (!cleared.length || !implicated.length) return null;
    return { implicated: [...new Set(implicated)], cleared: [...new Set(cleared)], greenAt: chain[i]!, checked };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Old-PoS run 58 (B, C): the case's checklist pins

/** The checklist rows (normalized text) citing one of `repros`, per item and lane. */
export function rowsCitingCase(items: ReadonlyArray<Pick<ChecklistItem, 'id' | 'verificationIntent'>> | undefined, repros: readonly string[]): string[] {
  const probes = repros.map(normalizeProbe).filter(probe => probe.length >= 4);
  if (!items || !probes.length) return [];
  const out: string[] = [];
  for (const item of items) {
    for (const lane of ['happy', 'edge', 'adversarial'] as const) {
      for (const row of (item.verificationIntent as Record<string, Array<{ desc?: string; derivation?: { computation?: string } }> | undefined>)?.[lane] ?? []) {
        const text = normalizeProbe(String(row.desc ?? ''));
        if (probes.some(probe => text.includes(probe))) out.push(`${item.id}:${lane}:${text}`);
      }
    }
  }
  return out.sort();
}

/** The value a row pins for the case (right of its arrow, inside the span that states the case), normalized; null when none is stated. */
function pinnedValueOf(rowText: string, probes: readonly string[]): string | null {
  const spans = [...rowText.matchAll(/`([^`]+)`/g)].map(match => normalizeProbe(match[1]!));
  const flat = [...spans, rowText].find(text => probes.some(probe => text.includes(probe)) && /->|→|=>/.test(text));
  const value = flat?.split(/->|→|=>/).at(-1)?.replace(/`.*$/, '').trim();
  return value ? value : null;
}

/**
 * Whether the guard's recorded test rows state every value the current
 * checklist rows pin for its case (case text removed first, so an input that
 * repeats the value does not count). `pins` = values found; null = no pin.
 */
export function guardStatesPins(gitCwd: string, guard: FindingGuard, items: ReadonlyArray<Pick<ChecklistItem, 'id' | 'verificationIntent'>> | undefined):
  { pins: string[]; agrees: boolean } | null {
  const repros = guard.repros ?? [];
  const probes = repros.map(normalizeProbe).filter(probe => probe.length >= 4);
  const rows = rowsCitingCase(items, repros);
  if (!rows.length) return null;
  const pins = rows.map(row => pinnedValueOf(row.slice(row.indexOf(':', row.indexOf(':') + 1) + 1), probes)).filter((value): value is string => Boolean(value));
  if (!pins.length) return { pins, agrees: false };
  const recorded = guard.recordedText ?? restoredTestSources(gitCwd, guard).map(row => row.text ?? '').join('\n');
  let text = normalizeProbe(recorded);
  for (const probe of probes) text = text.split(probe).join('');
  return { pins, agrees: pins.every(pin => text.includes(pin)) };
}

// ---------------------------------------------------------------------------
// Repair hunk liveness

function oldSideLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let file: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ')) { const path = line.slice(4).trim(); file = path === '/dev/null' ? null : path.replace(/^a\//, ''); if (file && !out.has(file)) out.set(file, new Set()); continue; }
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/);
    if (!hunk || !file) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const lines = out.get(file)!;
    if (count === 0) { lines.add(start); lines.add(start + 1); continue; }
    for (let n = start; n < start + count; n++) lines.add(n);
  }
  return out;
}

/**
 * Whether a later commit rewrote lines a repair commit wrote in its non-test
 * files (the old side of `git diff <commit> HEAD` overlaps the commit's new
 * side). `by` names the newest later commit touching that file.
 */
export function repairHunkRewritten(gitCwd: string, commit: string): { rewritten: boolean; file?: string; by?: string } {
  const files = commitFiles(gitCwd, commit).filter(row => row.status !== 'D' && !isTestPath(row.path)).map(row => row.path);
  if (!files.length) return { rewritten: false };
  const written = parseUnifiedZeroDiff(tryGit(gitCwd, ['show', '-U0', '--no-renames', '--format=', commit, '--', ...files]) ?? '');
  const later = oldSideLines(tryGit(gitCwd, ['diff', '-U0', '--no-renames', commit, 'HEAD', '--', ...files]) ?? '');
  for (const file of files) {
    const mine = written.get(file);
    const theirs = later.get(file);
    if (!mine || !theirs) continue;
    for (const line of theirs) {
      if (mine.has(line)) {
        const by = (tryGit(gitCwd, ['log', '-1', '--format=%h', `${commit}..HEAD`, '--', file]) ?? '').trim();
        return { rewritten: true, file, by: by || undefined };
      }
    }
  }
  return { rewritten: false };
}

/**
 * Duplicate closure (a): the canonical's fix is still live when its repair
 * hunk was not rewritten since, or its covering verification still passes
 * when re-run now (test source as recorded). A canonical with neither a repair
 * commit nor a guard cannot be checked and counts as live.
 */
export function canonicalFixLiveness(args: { projectRoot: string; gitCwd: string; canonicalId: string; repairCommit: string | null; guard: FindingGuard | null }):
  { live: boolean; why: string; guard?: GuardResult } {
  const { canonicalId, repairCommit, guard } = args;
  const rewrite = repairCommit ? repairHunkRewritten(args.gitCwd, repairCommit) : null;
  if (rewrite && !rewrite.rewritten) return { live: true, why: `${canonicalId}'s repair commit ${repairCommit!.slice(0, 12)} is unchanged since` };
  const rewritten = rewrite ? `${canonicalId}'s repair commit ${repairCommit!.slice(0, 12)} was rewritten in ${rewrite.file}${rewrite.by ? ` by ${rewrite.by}` : ''}` : '';
  if (guard) {
    const result = runFindingGuard({ projectRoot: args.projectRoot, gitCwd: args.gitCwd, guard });
    if (result.passed) return { live: true, why: `${rewritten ? `${rewritten}, but ` : ''}${canonicalId}'s covering verification still passes (\`${result.command}\`)`, guard: result };
    return { live: false, why: `${rewritten ? `${rewritten} and ` : ''}${canonicalId}'s covering verification as recorded at its resolution now fails (\`${result.command}\`)`, guard: result };
  }
  if (rewrite?.rewritten) return { live: false, why: `${rewritten}, and no covering verification of ${canonicalId} is recorded to show its fix survived` };
  return { live: true, why: `${canonicalId} records no repair commit or covering verification to re-check` };
}

// ---------------------------------------------------------------------------
// One invocation for all passing guards (old-PoS run 73, E)

/**
 * The top-level declaration blocks of a Go source (a block starts at a column-0 func / type / var / const /
 * import / package line, or at the run of column-0 comment lines right above it; trailing blanks trimmed).
 */
export function goTopLevelBlocks(text: string): string[] {
  const lines = text.split('\n');
  const starts: number[] = [];
  let comment: number | null = null;
  lines.forEach((line, index) => {
    if (/^(?:func|type|var|const|import|package)\b/.test(line)) { starts.push(comment ?? index); comment = null; }
    else if (/^\/\//.test(line)) comment ??= index;
    else comment = null;
  });
  return starts.map((start, index) => lines.slice(start, starts[index + 1] ?? lines.length).join('\n').replace(/\s+$/, ''));
}

/**
 * Whether the guard's recorded test files are, as they stand in the working tree, the snapshot plus whole
 * declarations added later (every recorded top-level block present verbatim): then a run on the current tree
 * exercises the recorded test source exactly as the restored run does.
 */
function recordedTestsUnchanged(gitCwd: string, guard: FindingGuard): boolean {
  if (guard.filtered?.length) return false;
  for (const file of guard.testFiles) {
    const recorded = tryGit(gitCwd, ['show', `${guard.snapshotRef}:${file}`]);
    let current: string;
    try { current = readFileSync(join(gitCwd, file), 'utf8'); } catch { return false; }
    if (recorded === null) return false;
    const have = new Set(goTopLevelBlocks(current));
    if (!goTopLevelBlocks(recorded).every(block => have.has(block))) return false;
  }
  return true;
}

const UNION_COMMAND = /^go test -v (\S+) -run \^\(([A-Za-z0-9_|]+)\)\$$/;

/** The `go test` package and test names of a guard that a merged invocation can stand for, else null. */
function unionPlanOf(gitCwd: string, guard: FindingGuard, currentTests: boolean): { pkg: string; names: string[]; restoredTests: boolean } | null {
  if (guard.runs.length !== 1) return null;
  const match = guard.runs[0]!.command.match(UNION_COMMAND);
  if (!match) return null;
  const names = match[2]!.split('|').filter(Boolean);
  if (!names.length || guard.runs[0]!.selectors.length !== names.length || !names.every(name => guard.runs[0]!.selectors.includes(`--- PASS: ${name}`))) return null;
  const testsChanged = guard.testFiles.length > 0 && (tryGit(gitCwd, ['diff', '--name-only', guard.snapshotRef, 'HEAD', '--', ...guard.testFiles]) ?? '').trim() !== '';
  if (currentTests) return { pkg: match[1]!, names, restoredTests: false };
  if (guard.filtered?.length) return null;
  if (!testsChanged) return { pkg: match[1]!, names, restoredTests: false };
  return recordedTestsUnchanged(gitCwd, guard) ? { pkg: match[1]!, names, restoredTests: true } : null;
}

/**
 * Run the passing guards of one package in ONE `go test` invocation (the findings of a long review accumulate:
 * one invocation per resolved finding grew `finding_resolve` to 55 s). A merged pass stands for each member's own
 * pass (same package, same tests, recorded source unchanged); a merged failure, a build failure or a missing tool
 * stands for nothing: every member then runs on its own exactly as before, so a decision never changes.
 */
export function unionGuardPasses(args: { projectRoot: string; gitCwd: string; entries: ReadonlyArray<{ guard: FindingGuard; currentTests: boolean }> }): Map<string, GuardResult> {
  const byPackage = new Map<string, Array<{ guard: FindingGuard; names: string[]; restoredTests: boolean }>>();
  for (const { guard, currentTests } of args.entries) {
    const plan = unionPlanOf(args.gitCwd, guard, currentTests);
    if (plan) byPackage.set(plan.pkg, [...(byPackage.get(plan.pkg) ?? []), { guard, names: plan.names, restoredTests: plan.restoredTests }]);
  }
  const out = new Map<string, GuardResult>();
  for (const [pkg, members] of byPackage) {
    if (members.length < 2) continue;
    const names = [...new Set(members.flatMap(member => member.names))];
    let result;
    try { result = runCommand(args.projectRoot, args.gitCwd, `go test -v ${pkg} -run ^(${names.join('|')})$`); } catch { continue; }
    if (result.missingTool || result.status !== 0 || !names.every(name => result.output.includes(`--- PASS: ${name}`))) continue;
    for (const member of members) {
      out.set(member.guard.findingId, { passed: true, inconclusive: false, command: member.guard.runs.map(run => run.command).join(' && '), outputTail: '', restoredTests: member.restoredTests });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The post-repair guard check

/** Resolved findings that a later resolved regression finding superseded (their old test source no longer guards them). */
export function retiredGuards(findings: readonly Finding[], storyId: string): Set<string> {
  const out = new Set<string>();
  for (const row of findings) if (row.status === 'resolved') for (const id of regressionTargets(row.desc, storyId)) if (id !== row.id) out.add(id);
  return out;
}

/** Resolved findings a guard applies to (fixed or duplicate; never a pre-existing disposition, never dismissed). */
export function guardableResolved(findings: readonly Finding[]): Finding[] {
  return findings.filter(row => row.status === 'resolved' && row.resolutionType !== 'preexisting_out_of_scope' && !isFrameworkSettled(row));
}

export interface GuardFailure { guarded: Finding; guard: FindingGuard; result: GuardResult; blamed: Array<{ findingId: string; commit: string }>;
  /** Lab group-conflict-blame: the per-member split of a grouped blame (`blamed` then holds only the implicated members). */
  attribution?: GroupBlameAttribution }

export interface GuardEventStore {
  readProcessEvents(storyId: string): Array<Record<string, unknown>>;
  appendProcessEvent(storyId: string, event: Record<string, unknown> & { type: string }): unknown;
}

/**
 * After repairs (`repairs`: the findings being resolved and their repair
 * commits), re-verify every resolved finding whose cited files changed since
 * its own resolution. A passing result on the same material (or HEAD) is reused (process
 * event). A failure blames each repair whose commit changed one of the
 * guarded finding's cited files (all repairs when none is cited). Excluded:
 * the findings being resolved, a finding a member of the batch declares it
 * re-found (that member supersedes its guard), and findings a resolved
 * regression finding superseded. Lab group-conflict-blame: a failure blaming
 * several repairs with separable commits blames only the members after the
 * newest member commit where the recorded test passes (groupBlameAttribution).
 */
export function regressionGuardCheck(args: { store: GuardEventStore; projectRoot: string; gitCwd: string; storyId: string; findings: readonly Finding[];
  repairs: ReadonlyArray<{ findingId: string; commit: string }>; repairCommitOf: (finding: Finding) => string | null;
  coverageOf: (finding: Finding) => DuplicateCoverageReceipt | null; headHash: string | null; materialHash?: string | null;
  /** Old-PoS run 58 (B): the Story base the failing case is judged against before blaming. */
  baseRef?: string | null;
  /** Old-PoS run 58 (B, C): the checklist now and as committed before a time (the finding's resolution). */
  checklist?: { current: ReadonlyArray<Pick<ChecklistItem, 'id' | 'verificationIntent'>>; at: (iso: string) => ReadonlyArray<Pick<ChecklistItem, 'id' | 'verificationIntent'>> | undefined };
  /** Lab stale-cross-pin: remediation.staleCrossPin (absent = read from the project config; default on). */
  staleCrossPin?: boolean;
  /**
   * Lab stale-cross-pin: the framework-bound repair commit of a resolved finding that may sanction a re-pin (finding_resolve:
   * the managed run binding; absent = the framework-appended marker of its resolution, frameworkRepairCommitOf).
   */
  sanctionCommitOf?: (finding: Finding) => string | null;
  /**
   * Lab stale-cross-pin: the commit the judged work starts from (the managed dry run: the repair's launch head). A sanction
   * commit must be an ancestor of it, so nothing the judged run committed (HEAD included) can sanction.
   */
  judgedBase?: string | null;
  /** Lab group-conflict-blame: remediation.groupConflictBlame (absent = read from the project config; default on). */
  groupConflictBlame?: boolean;
  /**
   * Lab group-conflict-blame: each repair's own commit for the blame split when `repairs` carry one shared head (the
   * managed dry run: the run's newest commit naming the member); absent = the repair's commit.
   */
  memberCommits?: ReadonlyMap<string, string> }): GuardFailure[] {
  const { store, storyId, findings, repairs } = args;
  if (!repairs.length) return [];
  const staleOn = args.staleCrossPin ?? (() => { try { return staleCrossPinOn(loadConfig(args.projectRoot)); } catch { return true; } })();
  const blameOn = args.groupConflictBlame ?? (() => { try { return groupConflictBlameOn(loadConfig(args.projectRoot)); } catch { return true; } })();
  // Lab stale-cross-pin (run 149): a batch member whose repair commit precedes another member's commit is guarded against
  // the later ones (a grouped repair resolved in one batch was never checked against itself); the later members are blamed.
  const sibling = new Map<string, Set<string>>();
  if (staleOn) {
    for (const early of repairs) {
      const later = repairs.filter(row => row.findingId !== early.findingId && row.commit !== early.commit && isAncestor(args.gitCwd, early.commit, row.commit));
      if (later.length) sibling.set(early.findingId, new Set(later.map(row => row.findingId)));
    }
  }
  const batch = new Set(repairs.map(row => row.findingId).filter(id => !sibling.has(id)));
  const superseded = new Set(repairs.flatMap(row => regressionTargets(findings.find(f => f.id === row.findingId)?.desc ?? '', storyId)));
  const retired = retiredGuards(findings, storyId);
  let events: Array<Record<string, unknown>> = [];
  try { events = store.readProcessEvents(storyId); } catch { events = []; }
  // Old-PoS run 47: a batch member that conflicts with a resolved finding reached repair only after the owner's
  // checklist pin decided the case (next routes an unpinned conflict to PLAN); the pin supersedes that finding's old test.
  const rejectedNow = rejectedRepairCommits(events);
  for (const row of repairs) {
    const member = findings.find(f => f.id === row.findingId);
    const conflict = member ? findingConflictOf({ finding: member, findings, storyId, rejected: rejectedNow }) : null;
    if (conflict?.resolvedId) superseded.add(conflict.resolvedId);
  }
  const repairFiles = new Map(repairs.map(row => [row.findingId, new Set(commitFiles(args.gitCwd, row.commit).map(file => file.path))]));
  const failures: GuardFailure[] = [];
  const pending: Array<{ guarded: Finding; guard: FindingGuard; currentTests: boolean }> = [];
  const siblingMembers = findings.filter(row => sibling.has(row.id) && row.status === 'open');
  for (const guarded of [...guardableResolved(findings), ...siblingMembers]) {
    if (batch.has(guarded.id) || superseded.has(guarded.id) || retired.has(guarded.id)) continue;
    const ownCommit = sibling.has(guarded.id) ? repairs.find(row => row.findingId === guarded.id)!.commit : null;
    const guard = findingGuard({ gitCwd: args.gitCwd, finding: guarded, repairCommit: ownCommit ?? args.repairCommitOf(guarded), coverage: ownCommit ? null : args.coverageOf(guarded) });
    if (!guard || !guardTouched(args.gitCwd, guard)) continue;
    const reused = events.some(event => event.type === REGRESSION_GUARD_EVENT && event.findingId === guarded.id && (event.passed === true || typeof event.excused === 'string')
      && ((args.materialHash && event.materialHash === args.materialHash) || (args.headHash && event.headHash === args.headHash)));
    if (reused) continue;
    // Old-PoS run 58 (C): the checklist epoch. A case re-pinned since the resolution to a value the
    // recorded rows do not state retires the guard; a whole-function guard runs on the current tests.
    const then = args.checklist && guarded.resolvedAt ? args.checklist.at(guarded.resolvedAt) : undefined;
    let currentTests = false;
    if (args.checklist && then) {
      if (guard.scope === 'repro') {
        const before = rowsCitingCase(then, guard.repros ?? []);
        const now = rowsCitingCase(args.checklist.current, guard.repros ?? []);
        const pins = guardStatesPins(args.gitCwd, guard, args.checklist.current);
        if (JSON.stringify(before) !== JSON.stringify(now) && now.length && !pins?.agrees) {
          try {
            store.appendProcessEvent(storyId, { type: REGRESSION_GUARD_RETIRED_EVENT, findingId: guarded.id, reason: 'checklist_epoch', headHash: args.headHash,
              repros: guard.repros ?? [], rowsAtResolution: before.length, rowsNow: now.length, pins: pins?.pins ?? [] });
          } catch { /* evidence only */ }
          continue;
        }
      } else if (JSON.stringify(then.map(item => [item.id, item.verificationIntent ?? null])) !== JSON.stringify(args.checklist.current.map(item => [item.id, item.verificationIntent ?? null]))) {
        currentTests = true;
      }
    }
    pending.push({ guarded, guard, currentTests });
  }
  // Lab stale-cross-pin: the repairs that may sanction a re-pin, built once on demand. Only findings ALREADY resolved as
  // verified fixes, by a framework-bound repair commit that strictly precedes every repair being judged now (and, in the
  // dry run, the judged run's launch head): never a member of the current batch, never the judged repair itself, never
  // HEAD or anything else the judged run committed. A repair can never sanction away the guard that judges it.
  let sanctioners: Array<{ findingId: string; commit: string }> | null = null;
  const judgedIds = new Set(repairs.map(row => row.findingId));
  const sanctionersNow = (): Array<{ findingId: string; commit: string }> => {
    if (sanctioners) return sanctioners;
    sanctioners = guardableResolved(findings).filter(row => !judgedIds.has(row.id) && row.evidenceState === 'verified' && (row.resolutionType === undefined || row.resolutionType === 'fixed')).flatMap(row => {
      let commit: string | null = null;
      try { commit = args.sanctionCommitOf ? args.sanctionCommitOf(row) : frameworkRepairCommitOf(args.gitCwd, row); } catch { commit = null; }
      if (!commit) return [];
      if (repairs.some(judged => judged.commit === commit || !isAncestor(args.gitCwd, commit!, judged.commit))) return [];
      if (args.judgedBase !== undefined && (!args.judgedBase || !isAncestor(args.gitCwd, commit, args.judgedBase))) return [];
      return [{ findingId: row.id, commit }];
    });
    return sanctioners;
  };
  // Old-PoS run 73 (E): the guards that pass run in one invocation per package; any other (or failing) guard runs on its own.
  const merged = unionGuardPasses({ projectRoot: args.projectRoot, gitCwd: args.gitCwd, entries: pending });
  for (const { guarded, guard, currentTests } of pending) {
    const unionResult = merged.get(guard.findingId);
    const result: GuardResult & { output?: string } = unionResult ?? runFindingGuard({ projectRoot: args.projectRoot, gitCwd: args.gitCwd, guard, currentTests });
    // Old-PoS run 58 (B): the current pins of the case, else the Story base, before blaming.
    let excused: { reason: 'checklist_pin' | 'story_base' | typeof STALE_CROSS_PIN_EXCUSE; why: string; sanctionedBy?: Array<{ findingId: string; commit: string }>; staleCases?: string[] } | null = null;
    const later = sibling.get(guarded.id);
    /** A batch sibling whose only failing rows a later sibling re-pinned: neither blamed nor excused (it is judged once resolved). */
    let deferred: { why: string; repinnedBy: Array<{ findingId: string; commit: string }>; staleCases: string[] } | null = null;
    if (!result.passed && !result.inconclusive) {
      const pins = guard.scope === 'repro' && args.checklist ? guardStatesPins(args.gitCwd, guard, args.checklist.current) : null;
      if (pins && pins.pins.length && !pins.agrees) {
        excused = { reason: 'checklist_pin', why: `the current checklist pins ${pins.pins.join(', ')} for the case, which the recorded test does not state` };
      } else if (!pins && args.baseRef) {
        const base = runRestoredAt({ projectRoot: args.projectRoot, gitCwd: args.gitCwd, guard, ref: args.baseRef });
        const head = failureSignature(result.output ?? '');
        if (base && !base.passed && !base.buildFailed && !base.missingTool && head.length && JSON.stringify(failureSignature(base.output)) === JSON.stringify(head)) {
          excused = { reason: 'story_base', why: `the recorded test fails on the Story base ${args.baseRef.slice(0, 12)} exactly as on the current code (the code keeps the base behaviour of the case)` };
        }
      }
      // Lab stale-cross-pin (run 149): the only failing rows are ones a later framework-bound repair re-pinned.
      if (!excused && staleOn && result.restoredTests && !currentTests) {
        const plan = staleCrossPinSources({ gitCwd: args.gitCwd, guard, guarded, output: result.output ?? '', sanctioners: sanctionersNow() });
        const rerun = plan ? runRestoredAt({ projectRoot: args.projectRoot, gitCwd: args.gitCwd, guard, ref: 'HEAD', sources: plan.sources }) : null;
        if (plan && rerun?.passed) {
          const short = (id: string) => id.startsWith(`${storyId}:`) ? id.slice(storyId.length + 1) : id;
          excused = { reason: STALE_CROSS_PIN_EXCUSE, sanctionedBy: plan.sanctionedBy, staleCases: plan.staleCases,
            why: `stale cross-finding pin: the recorded rows of ${plan.staleCases.map(text => `\`${text}\``).join(', ')} were re-pinned by the repair of `
              + `${plan.sanctionedBy.map(row => `${short(row.findingId)} (commit ${row.commit.slice(0, 12)})`).join(', ')}, which also changed the product code; `
              + `without those ${plan.droppedRows} row(s) the recorded test of ${short(guarded.id)} passes (\`${rerun.command}\`)` };
        }
      }
      // The batch sibling path: the later siblings are being judged now and never sanction. When their re-pin explains every
      // failure the member is not blamed on them here (the batch never checked its members before: no weaker than that); it
      // is judged as a resolved finding later, where only an already-resolved repair can excuse it.
      if (!excused && later && staleOn && result.restoredTests && !currentTests) {
        const siblings = repairs.filter(row => later.has(row.findingId));
        const plan = staleCrossPinSources({ gitCwd: args.gitCwd, guard, guarded, output: result.output ?? '', sanctioners: siblings });
        const rerun = plan ? runRestoredAt({ projectRoot: args.projectRoot, gitCwd: args.gitCwd, guard, ref: 'HEAD', sources: plan.sources }) : null;
        if (plan && rerun?.passed) {
          deferred = { repinnedBy: plan.sanctionedBy, staleCases: plan.staleCases,
            why: `only rows a later batch sibling re-pinned fail (${plan.staleCases.map(text => `\`${text}\``).join(', ')}); not blamed in this batch, not excused` };
        }
      }
    }
    let blamed = result.passed || excused || deferred ? [] : repairs.filter(row => (!later || later.has(row.findingId)) && (!guard.citedFiles.length || guard.citedFiles.some(file => repairFiles.get(row.findingId)?.has(file))))
      .map(row => ({ findingId: row.findingId, commit: row.commit }));
    // Lab group-conflict-blame (run 150): with separable member commits only the members after the newest passing one stay blamed.
    let attribution: GroupBlameAttribution | null = null;
    if (blameOn && blamed.length > 1 && !currentTests) {
      try { attribution = groupBlameAttribution({ projectRoot: args.projectRoot, gitCwd: args.gitCwd, guard, blamed, commitOf: id => args.memberCommits?.get(id) }); } catch { attribution = null; }
      if (attribution) { const keep = new Set(attribution.implicated); blamed = blamed.filter(row => keep.has(row.findingId)); }
    }
    try {
      store.appendProcessEvent(storyId, { type: REGRESSION_GUARD_EVENT, findingId: guarded.id, headHash: args.headHash, materialHash: args.materialHash ?? null, passed: result.passed, inconclusive: result.inconclusive,
        command: result.command, restoredTests: result.restoredTests, scope: guard.scope ?? 'functions', ...(currentTests ? { currentTests: true } : {}), ...(unionResult ? { unionRun: true } : {}),
        ...(later ? { batchSiblings: [...later] } : {}),
        ...(result.passed ? {} : excused ? { outputTail: result.outputTail, excused: excused.reason, excusedWhy: excused.why,
          ...(excused.sanctionedBy ? { sanctionedBy: excused.sanctionedBy, staleCases: excused.staleCases } : {}) }
          : deferred ? { outputTail: result.outputTail, deferred: 'batch_sibling_repin', deferredWhy: deferred.why, repinnedBy: deferred.repinnedBy, staleCases: deferred.staleCases }
          : { outputTail: result.outputTail, rejectedRepairs: blamed, ...(attribution ? { blameAttribution: attribution } : {}) }) });
    } catch { /* the refusal still carries the facts */ }
    // A batch sibling's failure is a regression only of the later members that touched its files (anything else is judged
    // once the member is resolved, as before).
    if (!result.passed && !excused && !deferred && (!later || blamed.length)) failures.push({ guarded, guard, result, blamed, ...(attribution ? { attribution } : {}) });
  }
  return failures;
}

/** Repair commits rejected by a failed guard, per finding id (process events). */
export function rejectedRepairCommits(events: ReadonlyArray<Record<string, unknown>>): Map<string, Array<{ commit: string; guardedFindingId: string; command: string; at?: string }>> {
  const out = new Map<string, Array<{ commit: string; guardedFindingId: string; command: string; at?: string }>>();
  for (const event of events) {
    if (event.type !== REGRESSION_GUARD_EVENT || event.passed !== false || !Array.isArray(event.rejectedRepairs)) continue;
    for (const row of event.rejectedRepairs as Array<{ findingId?: unknown; commit?: unknown }>) {
      if (typeof row?.findingId !== 'string' || typeof row.commit !== 'string') continue;
      const list = out.get(row.findingId) ?? [];
      list.push({ commit: row.commit, guardedFindingId: String(event.findingId ?? ''), command: String(event.command ?? ''), ...(typeof event.timestamp === 'string' ? { at: event.timestamp } : {}) });
      out.set(row.findingId, list);
    }
  }
  return out;
}

/** The regression finding's description: the resolved finding's case, the guard that failed and what broke it. */
export function regressionFindingDesc(args: { storyId: string; guarded: Finding; result: GuardResult; blamed: ReadonlyArray<{ findingId: string; commit: string }> }): string {
  const short = (id: string) => id.startsWith(`${args.storyId}:`) ? id.slice(args.storyId.length + 1) : id;
  const by = args.blamed.length ? `the repair of ${args.blamed.map(row => `${short(row.findingId)} (commit ${row.commit.slice(0, 12)})`).join(', ')}` : 'a later commit';
  const repros = findingRepros(args.guarded.desc).repros;
  return `[regression-of ${short(args.guarded.id)}] ${by} broke resolved finding ${short(args.guarded.id)}: its covering verification as recorded at its resolution now fails `
    + `(\`${args.result.command}\`). ${repros.length ? `Repro: ${repros.map(repro => `\`${repro}\``).join(', ')}. ` : ''}`
    + `Resolved finding: ${args.guarded.desc.length > 600 ? `${args.guarded.desc.slice(0, 599)}…` : args.guarded.desc} Output: ${args.result.outputTail.replace(/\s*\n\s*/g, ' | ').slice(0, 500)}`;
}

/** The temp directory prefix of a guard worktree (cleanup and logs). */
export const GUARD_TEMP_PREFIX = 'pos-regression-guard-';

// ---------------------------------------------------------------------------
// Finding conflicts (old-PoS run 47 §2, §7 item 1)

/** Two repros state the same case: one normalised repro contains the other (at least 4 characters). */
function sameCase(a: string, b: string): boolean {
  const x = normalizeProbe(a); const y = normalizeProbe(b);
  return x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x));
}
const citedPaths = (row: Pick<Finding, 'files'>): Set<string> => new Set((row.files ?? []).map(path => path.replace(/:\d.*$/, '')));

export interface FindingConflict { findingId: string; resolvedId: string | null; why: string; since: string;
  /** Lab run131: which of the three shapes below (core/finding-conflict-settle.ts settles `rejected` / `same_case`). */
  kind?: 'precedent' | 'rejected' | 'same_case' }

/**
 * Old-PoS run 47 (12 rounds, one behaviour flipped between four policies): an
 * open finding whose demand contradicts a resolved finding's repair is not a
 * repair task. It conflicts when (a) the lane marked it `[precedent-conflict]`
 * (two base precedents disagree), (b) a repair of it was rejected because it
 * broke a resolved finding's covering verification, or (c) it states the same
 * case (repro) as a resolved finding on a shared cited file without declaring
 * itself a regression of that finding (it re-judges the case the other one's
 * repair settled). A regression (`[regression-of <id>]`, "reintroduces <id>")
 * or a duplicate of the resolved finding is not a conflict. The pin in the
 * checklist decides; `since` is when the conflict became known.
 */
export function findingConflictOf(args: { finding: Finding; findings: readonly Finding[]; storyId: string;
  rejected: ReadonlyMap<string, ReadonlyArray<{ commit: string; guardedFindingId: string; at?: string }>>; duplicateOf?: (id: string) => string | null }): FindingConflict | null {
  const { finding, storyId } = args;
  const short = (id: string) => id.startsWith(`${storyId}:`) ? id.slice(storyId.length + 1) : id;
  if (/\[precedent-conflict\]/i.test(finding.desc ?? '')) {
    return { findingId: finding.id, resolvedId: null, kind: 'precedent', since: finding.createdAt ?? '', why: `${short(finding.id)} reports that two base precedents disagree on a case nothing pins` };
  }
  const rejected = (args.rejected.get(finding.id) ?? []).at(-1);
  if (rejected?.guardedFindingId) {
    return { findingId: finding.id, resolvedId: rejected.guardedFindingId, kind: 'rejected', since: rejected.at ?? finding.createdAt ?? '',
      why: `the repair of ${short(finding.id)} (commit ${rejected.commit.slice(0, 12)}) was rejected: it broke resolved ${short(rejected.guardedFindingId)}'s covering verification, so the two demand opposite behaviour` };
  }
  const regressed = new Set(regressionTargets(finding.desc, storyId));
  const duplicateOf = args.duplicateOf?.(finding.id) ?? null;
  const repros = findingRepros(finding.desc).repros.filter(repro => !isReproCommand(repro));
  if (!repros.length) return null;
  const mine = citedPaths(finding);
  for (const resolved of guardableResolved(args.findings)) {
    if (resolved.id === finding.id || regressed.has(resolved.id) || duplicateOf === resolved.id) continue;
    if (regressionTargets(resolved.desc, storyId).length) continue;
    const theirs = citedPaths(resolved);
    if (mine.size && theirs.size && ![...mine].some(path => theirs.has(path))) continue;
    const shared = findingRepros(resolved.desc).repros.find(repro => repros.some(own => sameCase(own, repro)));
    if (shared) {
      return { findingId: finding.id, resolvedId: resolved.id, kind: 'same_case', since: finding.createdAt ?? '',
        why: `${short(finding.id)} re-judges the case \`${shared}\` that resolved ${short(resolved.id)}'s repair settled, without reporting a regression of it` };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prompt blocks

const shortId = (storyId: string, id: string): string => id.startsWith(`${storyId}:`) ? id.slice(storyId.length + 1) : id;
const oneLine = (text: string, max: number): string => {
  const flat = String(text ?? '').replace(/\s*\n\s*/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const RESOLVED_LIST_MAX = 6;

/**
 * Old-PoS run 46 (R5-R7 trusted `resolved`): the REVIEW lane block of resolved
 * findings to re-probe, same-lane first, each with its repro. Empty when no
 * resolved finding states a repro (round 1 has none).
 */
export function renderResolvedReprobe(findings: readonly Finding[], storyId: string, lane: string): string[] {
  const rows = guardableResolved(findings)
    .map(row => ({ row, repros: findingRepros(row.desc).repros }))
    .filter(entry => entry.repros.length > 0)
    .sort((a, b) => Number(b.row.agent === lane) - Number(a.row.agent === lane) || (b.row.resolvedAt ?? '').localeCompare(a.row.resolvedAt ?? ''))
    .slice(0, RESOLVED_LIST_MAX);
  if (!rows.length) return [];
  return [
    'Resolved findings (re-probe, do not trust the status): run each repro below once on the current code. If one fails again, report a finding that starts with `[regression-of <id>]`, quoting the repro and its output.',
    ...rows.map(({ row, repros }) => `- ${shortId(storyId, row.id)} (${row.resolutionType ?? 'resolved'}): ${oneLine(row.desc, 140)} Repro: ${repros.map(repro => `\`${repro}\``).join(', ')}`),
  ];
}

/**
 * Old-PoS run 46 (the F-011 repair reversed F-009's): the finding-repair
 * prompt block naming the resolved findings on the same code, any earlier
 * repair of this finding rejected by a guard, and the rule for a
 * `[precedent-conflict]` finding.
 */
export function renderRepairResolvedContext(args: { findings: readonly Finding[]; storyId: string; finding: Finding;
  rejected: ReadonlyArray<{ commit: string; guardedFindingId: string; command: string }>;
  /** Old-PoS run 47: every finding's rejected repairs (the conflict detector's input). */
  rejectedAll?: ReadonlyMap<string, ReadonlyArray<{ commit: string; guardedFindingId: string; at?: string }>> }): string[] {
  const { storyId, finding } = args;
  // Old-PoS run 47: a conflict reaches repair only after the owner pinned the case in the checklist.
  const rejectedAll = args.rejectedAll ?? new Map();
  const conflict = findingConflictOf({ finding, findings: args.findings, storyId, rejected: rejectedAll });
  const regressed = regressionTargets(finding.desc, storyId);
  const conflictPeers = args.findings.filter(row => row.id !== finding.id).map(row => findingConflictOf({ finding: row, findings: args.findings, storyId, rejected: rejectedAll }))
    .filter((row): row is FindingConflict => Boolean(row?.resolvedId && regressed.includes(row.resolvedId)));
  const pinned = conflict || conflictPeers.length;
  const mine = new Set((finding.files ?? []).map(path => path.replace(/:\d.*$/, '')));
  const decided = new Set<string>([...(conflict?.resolvedId ? [conflict.resolvedId] : []), ...regressed.filter(() => conflictPeers.length > 0)]);
  const touching = guardableResolved(args.findings).filter(row => row.id !== finding.id && !decided.has(row.id)
    && (!mine.size || !(row.files ?? []).length || (row.files ?? []).some(path => mine.has(path.replace(/:\d.*$/, '')))))
    .slice(-RESOLVED_LIST_MAX);
  const lines: string[] = [];
  if (touching.length) {
    lines.push('Resolved findings on the same code: do not reverse what they fixed (the framework re-runs their covering tests after your commit and rejects a repair that breaks one). If this finding truly contradicts one, declare `[intent-conflict]` instead of editing it back.');
    for (const row of touching) {
      const repros = findingRepros(row.desc).repros;
      lines.push(`- ${shortId(storyId, row.id)}: ${oneLine(row.desc, 160)}${repros.length ? ` Repro: ${repros.map(repro => `\`${repro}\``).join(', ')}` : ''}`);
    }
  }
  for (const row of args.rejected) {
    lines.push(`- Earlier repair commit ${row.commit.slice(0, 12)} of this finding was rejected: it broke resolved finding ${shortId(storyId, row.guardedFindingId)} (\`${row.command}\` fails as recorded at its resolution).`);
  }
  if (pinned) {
    lines.push(`This case was a finding conflict (${conflict ? conflict.why : conflictPeers.map(row => row.why).join('; ')}); the owner pinned it in the checklist, and the pin decides: implement exactly what the checklist states for this case (it outranks any earlier repair). If the code already does, add a test of the pinned row and commit it naming ${shortId(storyId, finding.id)}.`);
  } else if (/\[precedent-conflict\]/i.test(finding.desc ?? '')) {
    lines.push('This is a `[precedent-conflict]` finding: two base precedents disagree and nothing pins which applies. Do not pick a side in code; declare `[intent-conflict]` for the item it names so the owner pins it in PLAN.');
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Repair test integrity (old-PoS run 55, run53-56-delta-ab-analysis.md fix B)

const TEST_NAME_PATTERNS = [/^func\s+(Test\w*)\s*\(/, /^\s*def\s+(test_\w+)\s*\(/, /^\s*(?:it|test)\s*\(\s*(['"`])([^'"`]+)\1/];
function testNameOf(line: string): string | null {
  for (const pattern of TEST_NAME_PATTERNS) {
    const match = line.match(pattern);
    if (match) return match[2] ?? match[1] ?? null;
  }
  return null;
}

/**
 * Old-PoS run 55: a finding-repair run wrote a correct test, saw it fail, and
 * deleted it ("the Story base rejects it"), shipping the defect. A test the
 * repair added that fails is evidence of a product defect. Not a repair:
 *   (a) a test the run's own commits added (a test function / case name) that
 *       a later commit of the same run removes;
 *   (b) a commit that removes test lines running the finding's own repro
 *       without adding the repro back in that commit (deleted or weakened);
 * `commits` are the run's commits, oldest first. Null when none applies.
 */
export function repairTestIntegrityProblem(args: { gitCwd: string; commits: readonly string[]; desc: string }): string | null {
  const repros = findingRepros(args.desc).repros.filter(repro => !isReproCommand(repro)).map(normalizeProbe).filter(repro => repro.length >= 4);
  const addedNames = new Map<string, string>();
  if (!args.commits.length) return null;
  // One git call for the whole run (old to new): each commit's diff after a NUL + hash line.
  const all = commitsDiffText(args.gitCwd, args.commits);
  const diffs = new Map(all.split('\0').filter(Boolean).map(block => [block.slice(0, block.indexOf('\n')).trim(), block.slice(block.indexOf('\n') + 1)] as const));
  for (const commit of args.commits) {
    const short = commit.slice(0, 12);
    const diff = diffs.get(commit) ?? '';
    let file: string | null = null;
    const removed: Array<{ file: string; line: string }> = [];
    const added: Array<{ file: string; line: string }> = [];
    for (const line of diff.split('\n')) {
      if (line.startsWith('+++ ')) { const path = line.slice(4).trim(); file = path === '/dev/null' ? file : path.replace(/^b\//, ''); continue; }
      if (line.startsWith('--- ')) { const path = line.slice(4).trim(); file = path === '/dev/null' ? null : path.replace(/^a\//, ''); continue; }
      if (!file || !isTestPath(file)) continue;
      if (line.startsWith('-')) removed.push({ file, line: line.slice(1) });
      else if (line.startsWith('+')) added.push({ file, line: line.slice(1) });
    }
    const addedNow = new Set(added.map(row => testNameOf(row.line)).filter((name): name is string => Boolean(name)));
    for (const row of removed) {
      const name = testNameOf(row.line);
      if (name && addedNames.has(name) && !addedNow.has(name)) {
        return `commit ${short} removes test ${name} (${row.file}) that commit ${addedNames.get(name)} of the same repair added: a failing test the repair wrote is evidence of a product defect, never something to delete`;
      }
    }
    for (const repro of repros) {
      const gone = removed.find(row => normalizeProbe(row.line).includes(repro));
      if (gone && !added.some(row => normalizeProbe(row.line).includes(repro))) {
        return `commit ${short} deletes or weakens a test line that runs the finding's own repro (${gone.file}: \`${gone.line.trim().slice(0, 120)}\`) without restoring it`;
      }
    }
    for (const name of addedNow) addedNames.set(name, short);
  }
  return null;
}
