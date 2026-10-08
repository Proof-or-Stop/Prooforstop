/**
 * Old-PoS run 29 REM2 (bench-staging/oldpos/run28-29-analysis.md §3.4): the
 * grouped finding-repair worker put a second regression test in a NEW file
 * (evaluator/range_assignment_aliasing_f005_test.go) outside the Story's
 * declared files (scope contract allowedCreate: [], mode enforce). The repair
 * prompt never stated the allowed files, and only the REVIEW scope gate caught
 * it later, as an owner step (6 turns, ~1M). Two framework fixes:
 *
 *   1. renderAllowedFilesSection: the repair prompt states the scope contract's
 *      allowed modify / test / create lists and that no other file may be
 *      created or changed.
 *   2. managedWriterScopeViolations: when a managed writer run (finding repair,
 *      implementer) ends, the paths its commits and working tree changed since
 *      the run started are classified with the same scope-contract classifier
 *      the REVIEW gate uses. A blocking violation gets ONE same-session repair
 *      turn (managedWriterScopeRepairPrompt) with the exact paths and allowed
 *      lists, before the owner ever sees it. A violation that survives the turn
 *      is left to the existing REVIEW gate (never silently accepted).
 */
import { execFileSync } from 'node:child_process';
import { checkScopeContract } from './scope-contract.js';
import type { ScopeContractData } from './types.js';

/** Managed writer agents whose commits the worker scope-checks before sealing. */
export const MANAGED_SCOPE_CHECKED_WRITERS: readonly string[] = ['proof-or-stop-finding-repair', 'proof-or-stop-implementer'];

/** Same-session scope repair turns a managed writer gets (one actionable turn). */
export const MANAGED_WRITER_SCOPE_REPAIR_MAX_ATTEMPTS = 1;

export interface ManagedWriterScopeViolation { path: string; rule: string; nextAction: string }

const list = (values: readonly string[] | undefined): string => (values && values.length ? values.join(', ') : '(none)');

/** The repair/implementer prompt section naming the files this Story may touch (empty when no contract binds paths). */
export function renderAllowedFilesSection(contract: ScopeContractData | null): string[] {
  if (!contract || ![contract.allowedModify, contract.allowedTest, contract.allowedCreate].some(paths => paths.length > 0)) return [];
  return [
    `Allowed files (scope contract, mode=${contract.mode}; the REVIEW scope gate fails any other changed path):`,
    `- modify: ${list(contract.allowedModify)}`,
    `- test: ${list(contract.allowedTest)}`,
    `- create: ${list(contract.allowedCreate)}`,
    '- Put every new or changed test in an allowed test file above, next to the existing tests; do not create any other file and do not change a file outside these lists. '
      + 'If the repair truly needs another path, stop and report it (the owner proposes the scope change); do not write it.',
  ];
}

/** The commit the writer started on (null outside a Git worktree). */
export function managedWriterScopeBaseHead(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function changedSince(cwd: string, baseHead: string): string[] {
  const run = (argv: string[]): string => execFileSync('git', argv, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  const committed = run(['diff', '--name-only', '--no-renames', `${baseHead}..HEAD`]).split('\n');
  // Worktree changes the writer left uncommitted count too (the gate sees them).
  const pending = run(['status', '--porcelain', '--untracked-files=all', '--no-renames']).split('\n').map(line => line.slice(3));
  return [...new Set([...committed, ...pending].map(path => path.trim()).filter(Boolean))];
}

/**
 * Blocking scope violations among the paths a managed writer run changed since
 * `baseHead` (the same classifier and enforcement as the REVIEW scope gate).
 * Empty when no contract binds paths or the paths cannot be read. The caller
 * reads the contract (this module stays outside the store import cycle).
 */
export function managedWriterScopeViolations(args: { cwd: string; baseHead: string; contract: ScopeContractData | null }):
  ManagedWriterScopeViolation[] {
  const contract = args.contract;
  if (!contract) return [];
  let changed: string[];
  try { changed = changedSince(args.cwd, args.baseHead); } catch { return []; }
  if (!changed.length) return [];
  const result = checkScopeContract(contract, changed, { projectRoot: args.cwd, gitCwd: args.cwd });
  return (result.rows ?? []).filter(row => row.blocking).map(row => ({ path: row.path ?? row.source ?? row.id, rule: String(row.rule ?? 'out_of_scope'), nextAction: row.nextAction ?? '' }));
}

/** The one same-session turn asking the writer to bring its change back inside the declared files. */
export function managedWriterScopeRepairPrompt(violations: readonly ManagedWriterScopeViolation[], contract: ScopeContractData | null): string {
  return [
    'Scope check failed for the change you just committed (the REVIEW scope gate would refuse it):',
    ...violations.map(row => `- ${row.path}: ${row.rule}`),
    '',
    ...renderAllowedFilesSection(contract),
    '',
    'Fix it now in this worktree: move each test into an allowed test file (keep the test itself), revert or remove every other listed path '
      + '(`git rm` a file you created), rerun the focused tests, and make ONE new commit (never rewrite earlier commits). '
      + 'Keep the original commit message conventions (a finding id stays named in its commit). Then reply with one line: the commit SHA and what moved.',
  ].join('\n');
}
