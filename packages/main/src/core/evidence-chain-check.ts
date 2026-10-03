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
 *                    anyway), advisory for `should`. Next action: run the pin
 *                    (`verification_run`) or record one (`verification_evidence_add`).
 *   unbound_test     a Go test function added or changed in the Story diff that
 *                    no intent's pinned `go test` command selects. Advisory.
 *                    Next action: bind it to an unpinned intent of the item
 *                    whose files contain the test.
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

export interface GoTestRef { name: string; file: string; packageDir: string }

export interface EvidenceChainIssue {
  kind: EvidenceChainIssueKind;
  blocking: boolean;
  detail: string;
  nextAction: string;
  intentRef?: string;
  itemId?: string;
  priority?: string;
  test?: GoTestRef;
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

/** Go test functions of one file whose line span intersects the changed new-side lines (1-based). */
export function changedGoTestFunctions(content: string, changedLines: ReadonlySet<number> | 'all'): string[] {
  const lines = content.split('\n');
  const names: string[] = [];
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
    if (changedLines === 'all') { names.push(name); continue; }
    for (let line = i + 1; line <= end + 1; line++) {
      if (changedLines.has(line)) { names.push(name); break; }
    }
  }
  return names;
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
    const names = changedGoTestFunctions(content, added ? 'all' : (diff.get(file) ?? new Set()));
    const packageDir = posix.dirname(file) === '.' ? '' : posix.dirname(file);
    for (const name of names) tests.push({ name, file, packageDir });
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

function evidenceAddCommand(storyId: string, itemId: string, intentRef: string, kind: string, command: string, selector: string, note: string): string {
  return cliLine('verification_evidence_add', { storyId, itemId, intentRef, kind, command, selector, note });
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
    let nextAction: string;
    if (pin && priority === 'must') {
      nextAction = pendingBatch;
    } else if (pin) {
      nextAction = cliLine('verification_run', { storyId, intentRef: entry.intentRef });
    } else {
      const candidate = unbound.find(row => row.owners.some(owner => owner.id === item.id));
      nextAction = candidate
        ? evidenceAddCommand(storyId, item.id, entry.intentRef, evidenceKindFor(entry.type), goTestCommand(candidate.test),
          `--- PASS: ${candidate.test.name}`, `${candidate.test.name} proves: ${entry.desc}`.slice(0, 200))
        : evidenceAddCommand(storyId, item.id, entry.intentRef, evidenceKindFor(entry.type), '<executable and argv of the test that proves it>',
          '<text its passing output prints>', `<which behavior of ${entry.intentRef} the test proves>`);
    }
    issues.push({ kind: 'missing_receipt', blocking: priority === 'must', intentRef: entry.intentRef, itemId: entry.itemId, priority,
      detail: `${entry.intentRef} (${priority}) has no admissible receipt${pin ? ` for its pinned command \`${pin.command}\`` : ' and no pinned command'}${entry.evidence?.nonMechanicalReason ? `: ${entry.evidence.nonMechanicalReason}` : ''}`,
      nextAction });
  }

  for (const { test, owners } of unbound) {
    // Suggest the first item whose files contain the test and that still has an unpinned intent.
    const withTarget = owners.map(owner => ({ owner, target: unpinnedExecutableIntents(owner)[0] })).find(row => row.target);
    const item = withTarget?.owner ?? owners[0] ?? null;
    const target = withTarget?.target;
    const nextAction = item && target
      ? evidenceAddCommand(storyId, item.id, target.ref, evidenceKindFor(target.intent.type), goTestCommand(test), `--- PASS: ${test.name}`,
        `${test.name} proves: ${target.intent.desc}`.slice(0, 200))
      : item
        ? `No action if ${test.name} is an extra regression test. Every intent of ${owners.map(owner => owner.id).join(', ')} is already pinned and pins are immutable; if ${test.name} is the only test of a userSees behavior, record that behavior with proof-or-stop acceptance_amendment_propose --storyId=${storyId}.`
        : `No action if ${test.name} is an extra regression test; no checklist item lists ${test.file}. If it is the only test of a userSees behavior, record that behavior with proof-or-stop acceptance_amendment_propose --storyId=${storyId}.`;
    issues.push({ kind: 'unbound_test', blocking: false, test, ...(item ? { itemId: item.id } : {}), ...(target ? { intentRef: target.ref } : {}),
      detail: `${test.name} (${test.file}) changed in this Story and is selected by no intent's pinned command${target ? `; bind it to ${target.ref} of ${item!.id}` : ''}`,
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
