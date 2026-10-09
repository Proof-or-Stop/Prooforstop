/**
 * Pre-REVIEW evidence-chain check: framework-owned, never a review finding.
 *
 * Review findings must be real product defects. Evidence-chain problems are
 * detected here, mechanically, before REVIEW, and each report names exactly
 * ONE next action:
 *
 *   stale_receipt    a must/should intent's receipt is stale (material or
 *                    environment moved since it ran). Blocking. Next action:
 *                    `verification_evidence_refresh_stale`, which reruns every
 *                    stale pinned command in one call.
 *   missing_receipt  an executable must/should intent has no admissible
 *                    receipt (no pin, never run, or a non-mechanical row).
 *                    Blocking for `must` (the REVIEW evidence gate refuses it
 *                    anyway), advisory for `should`. Next action: run the pins
 *                    (`verification_run --pending`); for intents without a pin,
 *                    ONE `verification_evidence_batch_add` template whose
 *                    command/selector/note the agent authors.
 *   unbound_test     a Go test function added or changed in the Story diff that
 *                    no intent's pinned `go test` command selects. Advisory.
 *                    Next action: a bind template whose intent is the agent's
 *                    choice, only if the test proves that intent.
 *
 * Which test proves which intent is a JUDGMENT, never mechanics (run 16: the
 * first changed test of the item's files was proposed, as a framework step,
 * for an intent it does not exercise, with a fabricated "X proves: <desc>"
 * note; `next --run` would have pinned it immutably). So the check never
 * chooses: an unpinned intent gets ranked CANDIDATE tests with why (literals of
 * the intent found in the test body, then shared name tokens) and every next
 * action that binds a test leaves the command/intent and the note to the agent.
 *
 * The unbound-test scan is language-aware only where selection is mechanical:
 * Go (`func TestX(t *testing.T)` + `go test [pkgs] -run/-skip`). Any pinned
 * command whose test selection cannot be computed (make, a shell, an import
 * path outside the module, a regex JS cannot express) skips the scan and says
 * why; it never guesses. JS/TS test selection is not scanned.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, posix } from 'node:path';
import type { ChecklistData, ChecklistItem, VerificationCoverageEntry, VerificationIntentItem, VerificationIntentType } from './types.js';
import { collectVerificationIntents, isExecutableIntentType } from './verification.js';
import { tokenizeCommandString } from './validation-executor.js';

export type EvidenceChainIssueKind = 'stale_receipt' | 'missing_receipt' | 'unbound_test';

export interface GoTestRef {
  name: string;
  file: string;
  packageDir: string;
  /** Source of the test function at HEAD (bounded), when the scan read it; used only to rank candidates. */
  body?: string;
}

/** A changed test that MAY prove an unpinned intent; the agent decides. */
export interface EvidenceChainCandidate {
  test: GoTestRef;
  /** Exact `go test` command that selects only this test. */
  command: string;
  selector: string;
  /** Why it is listed: intent literals found in its body, shared name tokens, or neither. */
  why: string;
  score: number;
}

export interface EvidenceChainIssue {
  kind: EvidenceChainIssueKind;
  blocking: boolean;
  detail: string;
  nextAction: string;
  intentRef?: string;
  itemId?: string;
  priority?: string;
  test?: GoTestRef;
  /** missing_receipt without a pin: changed tests of the item that may prove it, best first. */
  candidates?: EvidenceChainCandidate[];
}

export interface EvidenceChainReport {
  storyId: string;
  issues: EvidenceChainIssue[];
  blocking: boolean;
  /** The ONE next action (first blocking issue, else first advisory), or null when clean. */
  nextAction: string | null;
  /** `checked`, `not_applicable` (no Go test changed) or `skipped: <reason>`. */
  unboundTestScan: string;
}

const RUNNER_EXECUTABLES = new Set([
  'make', 'gmake', 'just', 'task', 'bash', 'sh', 'zsh', 'dash', 'fish', 'npm', 'npx', 'yarn', 'pnpm', 'bun', 'deno',
  'node', 'python', 'python3', 'docker', 'podman', 'bazel', 'bazelisk', 'mage', 'gotestsum', 'ginkgo', 'richgo',
]);
/** `go test` / test-binary flags that take a separate value argument. */
const GO_TEST_VALUE_FLAGS = new Set([
  'run', 'skip', 'count', 'timeout', 'tags', 'p', 'parallel', 'cpu', 'bench', 'benchtime', 'coverprofile', 'covermode',
  'coverpkg', 'o', 'exec', 'mod', 'modfile', 'ldflags', 'gcflags', 'asmflags', 'blockprofile', 'blockprofilerate',
  'cpuprofile', 'memprofile', 'memprofilerate', 'mutexprofile', 'mutexprofilefraction', 'outputdir', 'trace', 'shuffle',
  'fuzz', 'fuzztime', 'fuzzminimizetime', 'list', 'C', 'overlay', 'pgo', 'toolexec', 'installsuffix', 'pkgdir', 'vet',
  'compiler', 'gccgoflags', 'buildmode', 'buildvcs', 'reldir',
]);

type PinSelection =
  | { kind: 'go_test'; packages: Array<{ dir: string; recursive: boolean }>; run: RegExp | null; skip: RegExp | null }
  | { kind: 'not_go_test' }
  | { kind: 'opaque'; reason: string };

/** Top-level element of a Go `-run`/`-skip` pattern ('/' separates subtest levels outside [] and ()). */
function goPatternTopLevel(pattern: string): { top: string; levels: number } {
  let depthParen = 0; let inClass = false; let levels = 1; let top: string | null = null; let current = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\' && i + 1 < pattern.length) { current += ch + pattern[++i]; continue; }
    if (inClass) { if (ch === ']') inClass = false; current += ch; continue; }
    if (ch === '[') inClass = true;
    else if (ch === '(') depthParen += 1;
    else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
    else if (ch === '/' && depthParen === 0) { if (top === null) top = current; current = ''; levels += 1; continue; }
    current += ch;
  }
  return { top: top ?? current, levels };
}

function goRegex(pattern: string): RegExp | null {
  let source = pattern; let flags = '';
  const inline = source.match(/^\(\?([is]+)\)/);
  if (inline) { flags = inline[1]!; source = source.slice(inline[0].length); }
  if (/\(\?[^:=!<]/.test(source)) return null; // RE2 constructs JS does not share
  try { return new RegExp(source, flags); } catch { return null; }
}

function readGoModulePath(gitCwd: string): string | null {
  const path = join(gitCwd, 'go.mod');
  if (!existsSync(path)) return null;
  const match = readFileSync(path, 'utf8').match(/^module\s+(\S+)/m);
  return match ? match[1]!.replace(/^"|"$/g, '') : null;
}

function resolveGoPackage(arg: string, modulePath: string | null): { dir: string; recursive: boolean } | null {
  let pattern = arg;
  let recursive = false;
  if (pattern === '...' || pattern.endsWith('/...')) { recursive = true; pattern = pattern === '...' ? '.' : pattern.slice(0, -4); }
  if (pattern === '.' || pattern === './') return { dir: '', recursive };
  if (pattern.startsWith('./')) return { dir: posix.normalize(pattern.slice(2)).replace(/\/$/, ''), recursive };
  if (modulePath && (pattern === modulePath || pattern.startsWith(`${modulePath}/`))) {
    return { dir: pattern.slice(modulePath.length).replace(/^\//, ''), recursive };
  }
  return null;
}

export function parsePinnedTestSelection(command: string, modulePath: string | null): PinSelection {
  let tokens: string[];
  try { tokens = tokenizeCommandString(command); } catch { return { kind: 'opaque', reason: `untokenizable pinned command: ${command}` }; }
  let index = 0;
  if (tokens[index] && basename(tokens[index]!) === 'env') index += 1;
  while (tokens[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index += 1;
  const executable = tokens[index] ? basename(tokens[index]!) : '';
  if (!executable) return { kind: 'opaque', reason: `empty pinned command: ${command}` };
  if (executable !== 'go') {
    return RUNNER_EXECUTABLES.has(executable)
      ? { kind: 'opaque', reason: `pinned command runs through ${executable}; its Go test selection is not computable: ${command}` }
      : { kind: 'not_go_test' };
  }
  if (tokens[index + 1] !== 'test') return { kind: 'not_go_test' };
  let run: string | null = null;
  let skip: string | null = null;
  const packageArgs: string[] = [];
  for (let i = index + 2; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '-args' || token === '--args') break;
    if (token.startsWith('-')) {
      const body = token.replace(/^--?/, '').replace(/^test\./, '');
      const eq = body.indexOf('=');
      const name = eq >= 0 ? body.slice(0, eq) : body;
      const value = eq >= 0 ? body.slice(eq + 1) : (GO_TEST_VALUE_FLAGS.has(name) ? tokens[++i] ?? '' : null);
      if (name === 'run') run = value;
      else if (name === 'skip') skip = value;
      continue;
    }
    packageArgs.push(token);
  }
  const packages: Array<{ dir: string; recursive: boolean }> = [];
  for (const arg of packageArgs.length ? packageArgs : ['.']) {
    if (arg.endsWith('.go')) return { kind: 'opaque', reason: `pinned go test names files, not packages: ${command}` };
    const resolved = resolveGoPackage(arg, modulePath);
    if (!resolved) return { kind: 'opaque', reason: `pinned go test package ${arg} is outside the module or unresolvable: ${command}` };
    packages.push(resolved);
  }
  let runRegex: RegExp | null = null;
  if (run !== null && run !== '') {
    runRegex = goRegex(goPatternTopLevel(run).top);
    if (!runRegex) return { kind: 'opaque', reason: `pinned go test -run pattern is not computable: ${run}` };
  }
  let skipRegex: RegExp | null = null;
  if (skip !== null && skip !== '') {
    const { top, levels } = goPatternTopLevel(skip);
    // A multi-level -skip skips only subtests; the top-level test still runs.
    if (levels === 1) {
      skipRegex = goRegex(top);
      if (!skipRegex) return { kind: 'opaque', reason: `pinned go test -skip pattern is not computable: ${skip}` };
    }
  }
  return { kind: 'go_test', packages, run: runRegex, skip: skipRegex };
}

export function pinSelectsGoTest(selection: PinSelection, test: GoTestRef): boolean {
  if (selection.kind !== 'go_test') return false;
  const inPackage = selection.packages.some(pkg => pkg.dir === test.packageDir
    || (pkg.recursive && (pkg.dir === '' || test.packageDir.startsWith(`${pkg.dir}/`))));
  if (!inPackage) return false;
  if (selection.run && !selection.run.test(test.name)) return false;
  if (selection.skip && selection.skip.test(test.name)) return false;
  return true;
}

const GO_TEST_FUNC = /^func\s+(Test[^\s(]*)\s*\(\s*\w+\s+\*testing\.T\s*\)/;
const TEST_BODY_MAX_CHARS = 16_000;

/** Go test functions of one file with their 0-based line spans. */
function goTestFunctionSpans(lines: readonly string[]): Array<{ name: string; start: number; end: number }> {
  const spans: Array<{ name: string; start: number; end: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(GO_TEST_FUNC);
    if (!match) continue;
    const name = match[1]!;
    // Go runs TestXxx only when Xxx does not start with a lower-case letter.
    if (name.length > 4 && /^[a-z]/.test(name.slice(4))) continue;
    // Span: from the declaration to the line where its braces balance again
    // (a one-line `func TestX(t *testing.T) {}` ends on its own line), or the
    // line before the next top-level func when the braces never balance.
    let end = i;
    let depth = 0;
    let opened = false;
    for (let j = i; j < lines.length; j++) {
      if (j > i && /^func\s/.test(lines[j]!)) { end = j - 1; break; }
      end = j;
      for (const ch of lines[j]!) {
        if (ch === '{') { depth += 1; opened = true; } else if (ch === '}') depth -= 1;
      }
      if (opened && depth <= 0) break;
    }
    spans.push({ name, start: i, end });
  }
  return spans;
}

function changedSpans(content: string, changedLines: ReadonlySet<number> | 'all'): Array<{ name: string; body: string }> {
  const lines = content.split('\n');
  return goTestFunctionSpans(lines)
    .filter(span => {
      if (changedLines === 'all') return true;
      for (let line = span.start + 1; line <= span.end + 1; line++) if (changedLines.has(line)) return true;
      return false;
    })
    .map(span => ({ name: span.name, body: lines.slice(span.start, span.end + 1).join('\n').slice(0, TEST_BODY_MAX_CHARS) }));
}

/** Go test functions of one file whose line span intersects the changed new-side lines (1-based). */
export function changedGoTestFunctions(content: string, changedLines: ReadonlySet<number> | 'all'): string[] {
  return changedSpans(content, changedLines).map(span => span.name);
}

/** New-side changed lines per file from `git diff -U0` output. */
export function parseUnifiedZeroDiff(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let file: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim();
      file = path === '/dev/null' ? null : path.replace(/^b\//, '');
      if (file && !out.has(file)) out.set(file, new Set());
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!hunk || !file) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const lines = out.get(file)!;
    if (count === 0) { lines.add(start); lines.add(start + 1); continue; }
    for (let n = start; n < start + count; n++) lines.add(n);
  }
  return out;
}

function git(gitCwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

/** Go test functions added or changed between `base` and HEAD. */
export function collectChangedGoTests(gitCwd: string, base: string, changedPaths: ReadonlyArray<{ path: string; status: string }>): GoTestRef[] {
  const files = changedPaths.filter(row => row.status !== 'deleted' && row.path.endsWith('_test.go')).map(row => row.path);
  if (files.length === 0) return [];
  const diff = parseUnifiedZeroDiff(git(gitCwd, ['diff', '--no-color', '--no-ext-diff', '-U0', base, 'HEAD', '--', ...files]));
  const tests: GoTestRef[] = [];
  for (const file of files) {
    let content: string;
    try { content = git(gitCwd, ['show', `HEAD:${file}`]); } catch { continue; }
    const added = changedPaths.find(row => row.path === file)?.status === 'added';
    const spans = changedSpans(content, added ? 'all' : (diff.get(file) ?? new Set()));
    const packageDir = posix.dirname(file) === '.' ? '' : posix.dirname(file);
    for (const { name, body } of spans) tests.push({ name, file, packageDir, body });
  }
  return tests;
}

function evidenceKindFor(type: VerificationIntentType): string {
  switch (type) {
    case 'logic': return 'logic_test';
    case 'cli': return 'integration_test';
    case 'browser': return 'browser_test';
    case 'manual': return 'manual_transcript';
    case 'docs': return 'docs_check';
    default: return 'integration_test';
  }
}

function itemFiles(item: ChecklistItem): string[] {
  return [...(item.files?.test ?? []), ...(item.files?.create ?? []), ...(item.files?.modify ?? [])];
}

/** Items whose files list the test file; else items with a file in the same directory. */
function ownersOf(items: readonly ChecklistItem[], file: string): ChecklistItem[] {
  const exact = items.filter(item => itemFiles(item).includes(file));
  return exact.length ? exact : items.filter(item => itemFiles(item).some(path => posix.dirname(path) === posix.dirname(file)));
}

const PRIORITY_ORDER: Record<string, number> = { must: 0, should: 1, nice: 2 };

function unpinnedExecutableIntents(item: ChecklistItem): Array<{ ref: string; intent: VerificationIntentItem }> {
  return collectVerificationIntents(item)
    .filter(entry => isExecutableIntentType(entry.intent.type) && !entry.intent.verification)
    .sort((a, b) => (PRIORITY_ORDER[a.intent.priority ?? 'must'] ?? 3) - (PRIORITY_ORDER[b.intent.priority ?? 'must'] ?? 3))
    .map(entry => ({ ref: entry.ref, intent: entry.intent }));
}

function goTestCommand(test: GoTestRef): string {
  return `go test -v ${test.packageDir ? `./${test.packageDir}` : '.'} -run ^${test.name}$`;
}

/** One pasteable CLI line: the JSON payload single-quoted for a POSIX shell. */
function cliLine(command: string, payload: Record<string, unknown>): string {
  return `proof-or-stop ${command} '${JSON.stringify(payload).replace(/'/g, `'\\''`)}'`;
}

const MAX_CANDIDATES = 4;

/** A test reference without its body (reports stay bounded). */
function testRef(test: GoTestRef): GoTestRef {
  return { name: test.name, file: test.file, packageDir: test.packageDir };
}

/**
 * Code-like literals of an intent description: backticked text, bracket
 * expressions (with their prefix, e.g. `items[1 : 5]`, and each
 * bracket group), parenthesized groups and double-quoted strings.
 */
export function intentLiterals(desc: string): string[] {
  const out = new Set<string>();
  const add = (raw: string): void => {
    const text = raw.trim().replace(/[.,;]+$/, '');
    if (normalizeCode(text).length >= 3) out.add(text);
  };
  for (const match of desc.matchAll(/`([^`\n]+)`/g)) add(match[1]!);
  for (const match of desc.matchAll(/[^\s`]*\[[^\]\n]*\][^\s`,;]*/g)) {
    add(match[0]);
    for (const group of match[0].matchAll(/\[[^\]]*\]/g)) add(group[0]);
  }
  for (const match of desc.matchAll(/\([^()\n]*\)/g)) add(match[0]);
  for (const match of desc.matchAll(/"[^"\n]*"/g)) add(match[0]);
  return [...out];
}

/** Whitespace- and escape-insensitive form (a Go string literal escapes the quotes of `f("12345")`). */
function normalizeCode(text: string): string {
  return text.replace(/[\s\\]+/g, '');
}

function words(text: string): string[] {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).filter(word => word.length >= 3);
}

function sameWord(a: string, b: string): boolean {
  return a.length >= 4 && b.length >= 4 ? a.slice(0, 4) === b.slice(0, 4) : a === b;
}

/**
 * Rank changed tests as CANDIDATES for one unpinned intent. Ranking is a hint
 * for the agent, never a decision: literals of the intent found in the test
 * body weigh most, then words the test name shares with the description. Every
 * candidate says why it is listed, including "no literal" for a weak one.
 */
export function rankCandidateTests(desc: string, tests: readonly GoTestRef[], itemId: string): EvidenceChainCandidate[] {
  const literals = intentLiterals(desc);
  const descWords = [...new Set(words(desc))];
  return tests.map((test, index) => {
    const body = normalizeCode(test.body ?? '');
    const found = test.body === undefined ? [] : literals.filter(literal => body.includes(normalizeCode(literal)));
    const shared = [...new Set(words(test.name.replace(/^Test/, '')))].filter(word => descWords.some(other => sameWord(word, other)));
    const literalScore = found.reduce((sum, literal) => sum + normalizeCode(literal).length, 0);
    const reasons = [
      test.body === undefined ? 'body not read' : found.length
        ? `body contains ${found.slice(0, 3).join(', ')}`
        : 'no literal of the intent appears in its body',
      shared.length ? `name shares: ${shared.join(', ')}` : 'name shares no word with the intent',
      `changed in ${test.file}, a file ${itemId} lists`,
    ];
    return { test: testRef(test), command: goTestCommand(test), selector: `--- PASS: ${test.name}`, why: reasons.join('; '), score: literalScore * 10 + shared.length, index };
  })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_CANDIDATES)
    .map(({ index: _index, ...candidate }) => candidate);
}

function renderCandidates(candidates: readonly EvidenceChainCandidate[]): string {
  return candidates.map((candidate, index) => `${index + 1}) ${candidate.test.name} \`${candidate.command}\` (${candidate.why})`).join('; ');
}

/**
 * The pinned intents one `verification_run --pending` batch covers: every
 * must/should intent with a pinned verifier whose receipt is stale, and every
 * must intent with a pinned verifier whose receipt is missing or non-mechanical.
 * These are exactly the pinned rows the DEV→REVIEW evidence chain blocks on
 * (should-priority missing rows stay advisory). The batch handler and the
 * chain's next action read this one selection.
 */
export function pendingPinnedVerificationIntents(
  checklist: ChecklistData,
  coverage: readonly VerificationCoverageEntry[],
): Array<{ itemId: string; intentRef: string }> {
  const items = checklist.items.filter(item => item.status !== 'withdrawn');
  const pending: Array<{ itemId: string; intentRef: string }> = [];
  for (const entry of coverage) {
    if (entry.intentRef.endsWith(':missing-verification-intent')) continue;
    const priority = entry.priority ?? 'must';
    const stale = entry.status === 'stale' && (priority === 'must' || priority === 'should');
    const missing = (entry.status === 'missing' || entry.status === 'non_mechanical') && priority === 'must';
    if (!stale && !missing) continue;
    const item = items.find(row => row.id === entry.itemId);
    const intent = item ? collectVerificationIntents(item).find(row => row.ref === entry.intentRef)?.intent : undefined;
    if (!intent?.verification?.command) continue;
    pending.push({ itemId: entry.itemId, intentRef: entry.intentRef });
  }
  return pending;
}

export function evaluateEvidenceChain(input: {
  storyId: string;
  checklist: ChecklistData;
  coverage: readonly VerificationCoverageEntry[];
  /** Changed Go tests, or null when the scan could not run (reason in scanSkipReason). */
  changedGoTests: readonly GoTestRef[] | null;
  scanSkipReason?: string;
  goModulePath: string | null;
}): EvidenceChainReport {
  const { storyId, checklist } = input;
  const issues: EvidenceChainIssue[] = [];
  const items = checklist.items.filter(item => item.status !== 'withdrawn');
  const refresh = `proof-or-stop verification_evidence_refresh_stale --storyId=${storyId}`;
  // One batch for every blocking pinned row: each unique pinned execution runs
  // once and every intent pinned to it gets its own signed receipt, one commit.
  const pendingBatch = cliLine('verification_run', { storyId, pending: true });
  const missingPinned = new Set(pendingPinnedVerificationIntents(checklist, input.coverage)
    .map(row => row.intentRef));
  const batchMissing = input.coverage.some(entry => missingPinned.has(entry.intentRef)
    && (entry.status === 'missing' || entry.status === 'non_mechanical'));

  // Unbound Go tests first: a missing receipt's next action may name one.
  let unboundTestScan = 'not_applicable';
  const unbound: Array<{ test: GoTestRef; owners: ChecklistItem[] }> = [];
  if (input.changedGoTests === null) {
    unboundTestScan = `skipped: ${input.scanSkipReason ?? 'unavailable'}`;
  } else if (input.changedGoTests.length > 0) {
    const selections = items.flatMap(item => collectVerificationIntents(item))
      .map(entry => entry.intent.verification?.command)
      .filter((command): command is string => typeof command === 'string' && command.length > 0)
      .map(command => parsePinnedTestSelection(command, input.goModulePath));
    const opaque = selections.find((selection): selection is Extract<PinSelection, { kind: 'opaque' }> => selection.kind === 'opaque');
    if (opaque) {
      unboundTestScan = `skipped: ${opaque.reason}`;
    } else {
      unboundTestScan = 'checked';
      const seen = new Set<string>();
      for (const test of input.changedGoTests) {
        const key = `${test.packageDir}\0${test.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (selections.some(selection => pinSelectsGoTest(selection, test))) continue;
        unbound.push({ test, owners: ownersOf(items, test.file) });
      }
    }
  }

  const unpinnedMissing: Array<{ issue: EvidenceChainIssue; item: ChecklistItem; type: VerificationIntentType; top: EvidenceChainCandidate | undefined }> = [];
  for (const entry of input.coverage) {
    if (entry.intentRef.endsWith(':missing-verification-intent')) continue; // authoring gap, not evidence chain
    const priority = entry.priority ?? 'must';
    if (priority !== 'must' && priority !== 'should') continue;
    const item = items.find(row => row.id === entry.itemId);
    if (!item) continue;
    if (entry.status === 'stale') {
      // Stale rows keep refresh_stale (input-scoped reuse, shared-failure demotion)
      // unless a missing pinned row needs the batch anyway: then the same batch
      // reruns the stale pinned rows too, so no command runs twice.
      issues.push({ kind: 'stale_receipt', blocking: true, intentRef: entry.intentRef, itemId: entry.itemId, priority,
        detail: `${entry.intentRef} (${priority}) receipt is stale${entry.evidence?.nonMechanicalReason ? `: ${entry.evidence.nonMechanicalReason}` : ''}`,
        nextAction: batchMissing && missingPinned.has(entry.intentRef) ? pendingBatch : refresh });
      continue;
    }
    if (entry.status !== 'missing' && entry.status !== 'non_mechanical') continue;
    const intent = collectVerificationIntents(item).find(row => row.ref === entry.intentRef)?.intent;
    const executable = intent ? (isExecutableIntentType(intent.type) || !!intent.verification?.command) : isExecutableIntentType(entry.type);
    if (!executable) continue;
    const pin = intent?.verification;
    if (pin) {
      issues.push({ kind: 'missing_receipt', blocking: priority === 'must', intentRef: entry.intentRef, itemId: entry.itemId, priority,
        detail: `${entry.intentRef} (${priority}) has no admissible receipt for its pinned command \`${pin.command}\`${entry.evidence?.nonMechanicalReason ? `: ${entry.evidence.nonMechanicalReason}` : ''}`,
        nextAction: priority === 'must' ? pendingBatch : cliLine('verification_run', { storyId, intentRef: entry.intentRef }) });
      continue;
    }
    // No pin: which test proves it is the agent's judgment. List candidates
    // (changed tests of this item no pin selects), never pick one.
    const candidates = rankCandidateTests(entry.desc, unbound.filter(row => row.owners.some(owner => owner.id === item.id)).map(row => row.test), item.id);
    const issue: EvidenceChainIssue = { kind: 'missing_receipt', blocking: priority === 'must', intentRef: entry.intentRef, itemId: entry.itemId, priority,
      detail: `${entry.intentRef} (${priority}) has no admissible receipt and no pinned command${entry.evidence?.nonMechanicalReason ? `: ${entry.evidence.nonMechanicalReason}` : ''}; `
        + (candidates.length
          ? `candidate tests (choose the one that exercises "${entry.desc}", or name another; never bind a test that does not): ${renderCandidates(candidates)}`
          : `no candidate: no changed test of ${item.id} is unbound; name the test that exercises "${entry.desc}"`),
      nextAction: '', candidates };
    issues.push(issue);
    unpinnedMissing.push({ issue, item, type: entry.type, top: candidates[0] });
  }
  // Every missing unpinned intent shares ONE batch the agent completes: one
  // call, one checklist write (each command still runs and pins its intent).
  if (unpinnedMissing.length) {
    const batch = cliLine('verification_evidence_batch_add', { storyId, evidences: unpinnedMissing.map(({ issue, item, type, top }) => ({
      itemId: item.id, intentRef: issue.intentRef, kind: evidenceKindFor(type),
      command: `<executable and argv of the test that proves ${issue.intentRef}${top ? `; top candidate: ${top.command}` : ''}>`,
      selector: `<text its passing output prints${top ? `, e.g. ${top.selector}` : ''}>`,
      note: `<what that test asserts that proves ${issue.intentRef}>`,
    })) });
    for (const { issue } of unpinnedMissing) issue.nextAction = batch;
  }

  for (const { test, owners } of unbound) {
    // The first item whose files contain the test and that still has an
    // unpinned intent; WHICH of its intents the test proves (if any) is the
    // agent's choice, so the intent and the note stay placeholders.
    const withTargets = owners.map(owner => ({ owner, targets: unpinnedExecutableIntents(owner) })).find(row => row.targets.length > 0);
    const item = withTargets?.owner ?? owners[0] ?? null;
    const targets = withTargets?.targets ?? [];
    const nextAction = item && targets.length
      ? cliLine('verification_evidence_add', { storyId, itemId: item.id,
        intentRef: `<the unpinned intent of ${item.id} that ${test.name} proves, only if it does: ${targets.map(row => row.ref).join(' | ')}>`,
        kind: evidenceKindFor(targets[0]!.intent.type), command: goTestCommand(test), selector: `--- PASS: ${test.name}`,
        note: `<what ${test.name} asserts that proves that intent>` })
      : item
        ? `No action if ${test.name} is an extra regression test. Every intent of ${owners.map(owner => owner.id).join(', ')} is already pinned and pins are immutable; if ${test.name} is the only test of a userSees behavior, record that behavior with proof-or-stop acceptance_amendment_propose --storyId=${storyId}.`
        : `No action if ${test.name} is an extra regression test; no checklist item lists ${test.file}. If it is the only test of a userSees behavior, record that behavior with proof-or-stop acceptance_amendment_propose --storyId=${storyId}.`;
    issues.push({ kind: 'unbound_test', blocking: false, test: testRef(test), ...(item ? { itemId: item.id } : {}),
      detail: `${test.name} (${test.file}) changed in this Story and is selected by no intent's pinned command${targets.length ? `; if it proves one of ${item!.id}'s unpinned intents (${targets.map(row => row.ref).join(', ')}), bind it to that one` : ''}`,
      nextAction });
  }

  // Blocking first; among advisories a concrete command precedes a template.
  const isTemplate = (issue: EvidenceChainIssue): boolean => issue.nextAction.includes("'<") || issue.nextAction.includes('"<');
  const advisory = [
    ...issues.filter(issue => issue.kind === 'missing_receipt' && !issue.blocking),
    ...issues.filter(issue => issue.kind === 'unbound_test'),
  ];
  const ordered = [
    ...issues.filter(issue => issue.nextAction === pendingBatch),
    ...issues.filter(issue => issue.kind === 'stale_receipt' && issue.nextAction !== pendingBatch),
    ...issues.filter(issue => issue.kind === 'missing_receipt' && issue.blocking && issue.nextAction !== pendingBatch),
    ...advisory.filter(issue => !isTemplate(issue)),
    ...advisory.filter(isTemplate),
  ];
  return {
    storyId,
    issues: ordered,
    blocking: ordered.some(issue => issue.blocking),
    nextAction: ordered[0]?.nextAction ?? null,
    unboundTestScan,
  };
}

export function renderEvidenceChainReport(report: EvidenceChainReport): string {
  const status = report.blocking ? 'action_required' : report.issues.length > 0 ? 'advisory' : 'ok';
  return [
    '\nEvidence-chain check (framework-owned; never a review finding):',
    `  status=${status}; blocking=${report.blocking}; unboundTests=${report.unboundTestScan}`,
    ...report.issues.map(issue => `  - [${issue.kind}${issue.blocking ? '' : ', advisory'}] ${issue.detail}`),
    ...(report.nextAction ? [`  Next: ${report.nextAction}`] : []),
  ].join('\n');
}

export { readGoModulePath };
