/**
 * Lab run137 (bench-staging/oldpos/run137-analysis.md "Framework waste", fix M; new-PoS ADR-056 / ADR-070 direction):
 * the repair regression check, run by the managed worker (core/managed-host-run.ts) before a finding-repair run seals.
 *
 * Run 137: the repair of F-006 (commit e95659fc6c41) broke resolved F-004's covering test. Nothing told the repairer;
 * the run sealed, `finding_resolve`'s regression guard rejected it 30 s later, opened F-008 `[regression-of F-004]` and
 * sent the Story to PLAN (finding_conflict_pin): about 23 min until F-008 was resolved. The same check, run while the
 * repair's session is still open, hands the failing output back to that session instead.
 *
 * repairRegressionFailures runs, on the work tree after the repair's commits (launchHead..HEAD):
 *   - the covering tests of every resolved finding of the Story, exactly as finding_resolve's guard would
 *     (resolved-finding-guard.ts regressionGuardCheck, same exclusions: the conflict partner a repair supersedes, a
 *     regression-superseded guard, a guard whose cited files the repair did not touch), on a throw-away event store:
 *     nothing is journaled as a guard verdict, finding_resolve stays the gate;
 *     lab stale-cross-pin (run 149): the guard's `sanctioned_repair` excuse applies here too (a row a later resolved
 *     finding's repair re-pinned is no failure of this repair: no resumed turn); its sanction commit is the
 *     framework-appended repair-commit marker of the resolution and must be an ancestor of the launch head (nothing this
 *     run committed, HEAD included, sanctions; finding_resolve re-checks it on the managed run binding);
 *     lab group-conflict-blame (run 150): for a grouped run each member's commit is the run's newest commit whose message
 *     names it (the grouped-run binding rule, ab-dispatch-grouping.ts commitMessageNamesFinding; else HEAD), so the
 *     guard's blame split (groupBlameAttribution) names the implicated and cleared members in the resumed-turn prompt;
 *   - the pinned checklist verifications (`verification.command` + selector) whose command names a package (path) the
 *     repair changed: one that fails now and passed at the repair's launch head is a regression of this repair; one
 *     failing at launch too is not its doing (reported nowhere). Bounded: PINNED_MAX distinct commands.
 * repairRegressionFollowUp is the ONE resumed-turn prompt for the failures. Nothing here reads an owner-writable runtime
 * file: the findings, checklist and Story base come from the Story metadata and git, every result from a fresh run.
 * Switch remediation.regressionCheck (default OFF since old-PoS runs 149-151; on = the lab arm: the check and the [caller-check] lines).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChecklistItem, Finding } from './types.js';
import { collectVerificationIntents } from './verification.js';
import { regressionGuardCheck, repairCommitFromResolution, runCommand } from './resolved-finding-guard.js';
import { commitMessageNamesFinding } from './ab-dispatch-grouping.js';

export const MANAGED_REPAIR_REGRESSION_CHECK_MAX_ATTEMPTS = 2;
const PINNED_MAX = 8;
const OUTPUT_TAIL = 1_500;

export interface RepairRegressionFailure {
  kind: 'resolved_finding' | 'pinned_verification';
  /** The resolved finding id, or the pinned row ref (CHK-001:happy:0). */
  id: string;
  command: string;
  outputTail: string;
  /** Lab group-conflict-blame: of a grouped run, the members whose commits broke the check and those proven clear. */
  implicated?: string[];
  cleared?: string[];
}

function tryGit(gitCwd: string, args: string[]): string | null {
  try { return execFileSync('git', args, { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).trim(); } catch { return null; }
}

/** Lab group-conflict-blame: per member, the newest commit in launchHead..head whose message names it (absent: none). */
function memberCommitsOf(gitCwd: string, storyId: string, findingIds: readonly string[], launchHead: string, head: string): Map<string, string> {
  const out = new Map<string, string>();
  if (findingIds.length < 2) return out;
  const log = tryGit(gitCwd, ['log', '--format=%x00%H%x1f%B', `${launchHead}..${head}`]) ?? '';
  for (const block of log.split('\0').filter(Boolean)) {
    const [commit = '', message = ''] = block.split('\x1f');
    for (const id of findingIds) if (!out.has(id) && commit.trim() && commitMessageNamesFinding(message, storyId, id)) out.set(id, commit.trim());
  }
  return out;
}

const tail = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length > OUTPUT_TAIL ? `…${trimmed.slice(-OUTPUT_TAIL)}` : trimmed;
};

/** The repository paths a command names (`./pkg`, `pkg/...`, `dir/file.ext`), normalized (no `./`, no `/...`). */
function commandPaths(command: string): string[] {
  return command.split(/\s+/).filter(token => /^\.{1,2}\//.test(token) || (/\//.test(token) && !/^-/.test(token) && !/^[a-z]+:\/\//i.test(token)))
    .map(token => token.replace(/^['"]|['"]$/g, '').replace(/^\.\//, '').replace(/\/\.\.\.$|\/$/g, '').replace(/^\.\.\.$/, ''));
}

/** Whether a command names one of the changed files or a directory containing one (`./...` names every package). */
function commandTouches(command: string, changed: readonly string[]): boolean {
  if (/(?:^|\s)\.\/\.\.\.(?:\s|$)/.test(command)) return changed.length > 0;
  return commandPaths(command).some(path => path && changed.some(file => file === path || file.startsWith(`${path}/`)));
}

/** Run one pinned command in `cwd`: passed = exit 0 and the selector printed. */
function runPinned(projectRoot: string, cwd: string, command: string, selector: string): { passed: boolean; output: string } | null {
  try {
    const result = runCommand(projectRoot, cwd, command);
    if (result.missingTool) return null;
    return { passed: result.status === 0 && (!selector || result.output.includes(selector)), output: result.output };
  } catch { return null; }
}

/** `fn` in a temporary detached worktree of `ref` (removed afterwards); null when the checkout fails. */
function atRef<T>(gitCwd: string, ref: string, fn: (dir: string) => T): T | null {
  const dir = mkdtempSync(join(tmpdir(), 'pos-repair-regression-'));
  const checkout = join(dir, 'checkout');
  try {
    if (tryGit(gitCwd, ['worktree', 'add', '--detach', '--quiet', checkout, ref]) === null) return null;
    return fn(checkout);
  } finally {
    tryGit(gitCwd, ['worktree', 'remove', '--force', checkout]);
    rmSync(dir, { recursive: true, force: true });
    tryGit(gitCwd, ['worktree', 'prune']);
  }
}

/**
 * The regressions the repair's commits (launchHead..headRef) introduce: resolved findings whose covering test now fails
 * and pinned checklist verifications of the changed packages that passed at launch and fail now. Empty when the repair
 * committed nothing.
 */
export function repairRegressionFailures(args: { projectRoot: string; gitCwd: string; storyId: string; findings: readonly Finding[];
  items: ReadonlyArray<Pick<ChecklistItem, 'id' | 'verificationIntent'>>; findingIds: readonly string[]; launchHead: string;
  events: ReadonlyArray<Record<string, unknown>>; baseRef: string | null; headRef?: string;
  /** The checklist as committed before a time (the guard's checklist epoch); absent = the current checklist only. */
  checklistAt?: (iso: string) => ReadonlyArray<Pick<ChecklistItem, 'id' | 'verificationIntent'>> | undefined;
  /** Evidence sink for this module's own events (never a guard verdict). */
  onEvent?: (event: Record<string, unknown>) => void }): { failures: RepairRegressionFailure[]; changed: string[] } {
  const head = tryGit(args.gitCwd, ['rev-parse', '--verify', `${args.headRef ?? 'HEAD'}^{commit}`]);
  if (!head || !args.findingIds.length) return { failures: [], changed: [] };
  if (head === tryGit(args.gitCwd, ['rev-parse', '--verify', `${args.launchHead}^{commit}`])) return { failures: [], changed: [] };
  const changed = (tryGit(args.gitCwd, ['diff', '--name-only', '--no-renames', args.launchHead, head, '--']) ?? '').split('\n').map(row => row.trim()).filter(Boolean);
  if (!changed.length) return { failures: [], changed };
  const failures: RepairRegressionFailure[] = [];
  // 1. Resolved findings: finding_resolve's own guard, on a throw-away store (a dry run, no verdict journaled).
  const dryStore = { readProcessEvents: () => [...args.events] as Array<Record<string, unknown>>, appendProcessEvent: () => undefined };
  try {
    const guardFailures = regressionGuardCheck({ store: dryStore, projectRoot: args.projectRoot, gitCwd: args.gitCwd, storyId: args.storyId, findings: args.findings,
      repairs: args.findingIds.map(findingId => ({ findingId, commit: head })), repairCommitOf: finding => repairCommitFromResolution(args.gitCwd, finding),
      coverageOf: () => null, headHash: null, materialHash: null, baseRef: args.baseRef,
      // Lab stale-cross-pin: nothing this run committed (its launch head .. HEAD) can sanction a re-pin.
      judgedBase: args.launchHead,
      memberCommits: memberCommitsOf(args.gitCwd, args.storyId, args.findingIds, args.launchHead, head),
      ...(args.checklistAt ? { checklist: { current: args.items, at: args.checklistAt } } : {}) });
    for (const failure of guardFailures) {
      failures.push({ kind: 'resolved_finding', id: failure.guarded.id, command: failure.result.command, outputTail: tail(failure.result.outputTail),
        ...(failure.attribution ? { implicated: failure.attribution.implicated, cleared: failure.attribution.cleared } : {}) });
    }
  } catch (error) {
    args.onEvent?.({ type: 'repair_regression_guard_error', error: error instanceof Error ? error.message.slice(0, 400) : String(error) });
  }
  // 2. Pinned checklist verifications naming a changed package: fails now, passed at launch.
  const pinned = new Map<string, { ref: string; selector: string }>();
  for (const item of args.items) {
    for (const row of collectVerificationIntents(item as ChecklistItem)) {
      const pin = row.intent.verification;
      if (!pin?.command || pinned.has(pin.command) || !commandTouches(pin.command, changed)) continue;
      pinned.set(pin.command, { ref: row.ref, selector: pin.selector ?? '' });
    }
  }
  for (const [command, { ref, selector }] of [...pinned].slice(0, PINNED_MAX)) {
    const now = runPinned(args.projectRoot, args.gitCwd, command, selector);
    if (!now || now.passed) continue;
    const before = atRef(args.gitCwd, args.launchHead, dir => runPinned(args.projectRoot, dir, command, selector));
    if (!before?.passed) continue;
    failures.push({ kind: 'pinned_verification', id: ref, command, outputTail: tail(now.output) });
  }
  return { failures, changed };
}

const short = (id: string): string => id.replace(/^[^:]+:(?=F-)/, '');

/** The ONE resumed-turn prompt that hands the regressions back to the repair's own session. */
export function repairRegressionFollowUp(failures: readonly RepairRegressionFailure[], findingIds: readonly string[]): string {
  return [
    `Regression check (framework, before this run ends): your repair of ${findingIds.map(short).join(', ')} broke ${failures.length} check${failures.length > 1 ? 's' : ''} that passed before it:`,
    ...failures.flatMap(failure => [
      failure.kind === 'resolved_finding'
        ? `- resolved finding ${short(failure.id)}: its covering test as recorded at its resolution now fails: \`${failure.command}\``
        : `- pinned checklist verification ${failure.id}: \`${failure.command}\` passed at your launch and fails now`,
      ...(failure.implicated?.length ? [`  framework per-commit check: it still passes after the commits of ${(failure.cleared ?? []).map(short).join(', ')} and fails after those of `
        + `${failure.implicated.map(short).join(', ')}: only ${failure.implicated.map(short).join(', ')} broke it (keep the other repairs as they are)`] : []),
      `  output: ${failure.outputTail.replace(/\s*\n\s*/g, ' | ').slice(0, 900)}`,
    ]),
    '- Fix the product code so these pass again and keep your own repair (one new commit). Do not edit, skip or weaken the resolved finding\'s test or the pinned check to get green: the framework re-runs them as recorded.',
    '- If the request or the Story base truly requires the behaviour your repair introduced (the old test pins the wrong value), do not change the code back: say so in your report with one `[intent-conflict]` line naming the case, the old test and the request sentence or base result that decides it.',
    'Then reply with your complete final report again (every line it had, including the [intent-conflict] section).',
  ].join('\n');
}
