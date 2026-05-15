/**
 * @task B-4b22
 * @title Single-source-of-truth dirty gate policy table + evaluator
 *
 * One pure-data table maps every `DIRTY_WORKTREE_CATEGORIES` entry (defined in
 * dirty-worktree.ts, B-6326) to a `{ blocking, auditReason }` decision.
 * `evaluateDirtyGate` consumes a typed classification + gate context and emits
 * an aggregate result (counts, audit events, single-line summary) consumed by
 * BOTH `story-advance.ts` (TEST pre-check + DONE gate `git-working-tree` row)
 * AND `validation-executor.ts` (side-effect guard wording).
 *
 * Safety contract (preMortem anchors from B-4b22 decision):
 *
 *   #1 (exhaustive guard): `assertPolicyCovers()` iterates
 *      DIRTY_WORKTREE_CATEGORIES and throws if any future enum value is
 *      missing from DIRTY_GATE_POLICY. Called both at module load AND at the
 *      start of every `evaluateDirtyGate` invocation so neither hot-reload
 *      nor refactored import order can bypass it.
 *
 *   #2 (audit-write fallback): if a writer is supplied AND throws, the
 *      evaluator catches the error, sets `auditFailure = "AUDIT WRITE FAILED:
 *      <msg>"`, and FORCES `allPass = false`. Silent passing when audit log
 *      cannot be persisted is forbidden — the gate degrades to BLOCKING.
 *
 *   #3 (single source of truth): Consumers MUST import this module and pass
 *      the typed classification through `evaluateDirtyGate`. They must NOT
 *      enumerate DIRTY_WORKTREE_CATEGORIES literal values inline (grep-based
 *      smoke assertion enforces this in flow-stability-smoke).
 */

import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import {
  DIRTY_WORKTREE_CATEGORIES,
  type DirtyWorktreeCategory,
  type DirtyWorktreeClassification,
} from './dirty-worktree.js';

export interface DirtyGatePolicyEntry {
  readonly blocking: boolean;
  readonly auditReason: string;
}

/**
 * One-row-per-category allowlist. material_source_changes / fixture_changes /
 * unexpected_dirty_files stay blocking everywhere they used to block;
 * koala_metadata / runtime_artifact / declared_artifact are the only three
 * categories explicitly handled by upstream channels (B-3506 auto-commit,
 * B-6326 classifier, B-cf60 artifact_declare) and therefore get the pass.
 *
 * Unknown future categories MUST be added to this table AND to
 * DIRTY_WORKTREE_CATEGORIES — `assertPolicyCovers` will throw otherwise.
 */
export const DIRTY_GATE_POLICY: Readonly<Record<DirtyWorktreeCategory, DirtyGatePolicyEntry>> = {
  koala_metadata_changes: {
    blocking: false,
    auditReason: 'koala-owned story metadata; auto-committed by B-3506 helper',
  },
  runtime_artifact_changes: {
    blocking: false,
    auditReason: 'runtime artifact registered in runtime-artifact-registry',
  },
  declared_artifact_changes: {
    blocking: false,
    auditReason: 'declared by koala artifact_declare (B-cf60); referenced by verificationEvidence or delivery-check',
  },
  material_source_changes: {
    blocking: true,
    auditReason: 'material source/config drift — must commit or revert before TEST/DONE',
  },
  fixture_changes: {
    blocking: true,
    auditReason: 'fixture drift — review and commit or revert',
  },
  unexpected_dirty_files: {
    blocking: true,
    auditReason: 'unexpected dirty path — investigate, commit, or remove',
  },
} as const;

/**
 * preMortem #1 anchor — exhaustive coverage guard.
 *
 * Throws when DIRTY_WORKTREE_CATEGORIES contains a value NOT present in
 * DIRTY_GATE_POLICY. The message names the missing category and points at
 * the fix site (this file). Smoke test asserts the registry-vs-policy
 * invariant by both length equality AND `assertPolicyCovers()` not throwing.
 */
export function assertPolicyCovers(): void {
  for (const c of DIRTY_WORKTREE_CATEGORIES) {
    if (!(c in DIRTY_GATE_POLICY)) {
      throw new Error(
        `dirty-gate-policy: category "${c}" missing from DIRTY_GATE_POLICY table; ` +
        `update DIRTY_GATE_POLICY in packages/main/src/core/dirty-gate-policy.ts ` +
        `to cover all DIRTY_WORKTREE_CATEGORIES`,
      );
    }
  }
}

// Run once at module load — defense in depth so callers that forget to call
// evaluateDirtyGate (e.g. importing the table directly) still trip the guard.
assertPolicyCovers();

export type DirtyGateName = 'test-pre-check' | 'done-gate' | 'validate-side-effect';

export interface AuditEvent {
  type: 'dirty_gate_audit';
  storyId: string;
  gate: DirtyGateName;
  category: DirtyWorktreeCategory;
  pathCount: number;
  /** Truncated to first 5 sample paths. pathCount keeps the real count. */
  paths: string[];
  reason: string;
  timestamp: string;
}

/** Max sample paths per audit event. pathCount stays accurate beyond this. */
export const AUDIT_PATH_SAMPLE_LIMIT = 5;

export type AuditWriter = (event: AuditEvent) => void;

export interface EvaluateDirtyGateContext {
  storyId: string;
  gate: DirtyGateName;
  /** When null/undefined → skip writing (smoke/test use). Throws on fs failure. */
  writer?: AuditWriter | null;
  /** ISO timestamp generator; defaults to () => new Date().toISOString(). */
  now?: () => string;
}

export interface EvaluateDirtyGateResult {
  allPass: boolean;
  blockingCounts: Partial<Record<DirtyWorktreeCategory, number>>;
  passingCounts: Partial<Record<DirtyWorktreeCategory, number>>;
  auditEvents: AuditEvent[];
  /** Single-line summary, e.g. "blocking=2 (material_source_changes=1,fixture_changes=1); passed=1 (koala_metadata_changes=1)". */
  summary: string;
  /** "AUDIT WRITE FAILED: <msg>" when writer threw; null otherwise. */
  auditFailure: string | null;
}

const BLOCKING_CATEGORY_NAMES = DIRTY_WORKTREE_CATEGORIES.filter((c) => DIRTY_GATE_POLICY[c].blocking);
const PASSING_CATEGORY_NAMES = DIRTY_WORKTREE_CATEGORIES.filter((c) => !DIRTY_GATE_POLICY[c].blocking);

function renderCategoryGroup(prefix: string, counts: Partial<Record<DirtyWorktreeCategory, number>>): string {
  const entries = DIRTY_WORKTREE_CATEGORIES
    .filter((c) => (counts[c] ?? 0) > 0)
    .map((c) => `${c}=${counts[c]}`);
  if (entries.length === 0) {
    // No populated categories — emit zero-count form referencing category-name
    // list so downstream renderers stay informative even when no row exists.
    const total = Object.values(counts).reduce((acc, n) => acc + (n ?? 0), 0);
    if (prefix === 'blocking') {
      // blocking=0 always references the 3 blocking category names (so users
      // see what would have blocked).
      return `${prefix}=${total} (${BLOCKING_CATEGORY_NAMES.join('+').replace(/_changes/g, '').replace(/unexpected_dirty_files/, 'unexpected')})`;
    }
    return `${prefix}=${total}`;
  }
  const total = entries.reduce((acc, e) => acc + Number(e.split('=')[1]), 0);
  return `${prefix}=${total} (${entries.join(',')})`;
}

/**
 * Pure evaluator. Empty classification → allPass=true, zero counts, no audit.
 *
 * Writer semantics:
 *   - undefined / null → skip write (smoke/test use). No audit recorded.
 *   - present → invoked once per non-empty passing category. If it throws,
 *     allPass is forced false and auditFailure is set (preMortem #2 anchor).
 *     Already-collected audit events in this run are still returned for
 *     post-mortem visibility, but the gate degrades to blocking.
 */
export function evaluateDirtyGate(
  classification: DirtyWorktreeClassification,
  ctx: EvaluateDirtyGateContext,
): EvaluateDirtyGateResult {
  assertPolicyCovers();
  const now = ctx.now ?? (() => new Date().toISOString());

  const blockingCounts: Partial<Record<DirtyWorktreeCategory, number>> = {};
  const passingCounts: Partial<Record<DirtyWorktreeCategory, number>> = {};
  const auditEvents: AuditEvent[] = [];
  let auditFailure: string | null = null;

  for (const category of DIRTY_WORKTREE_CATEGORIES) {
    const entries = classification.groups[category];
    if (!entries || entries.length === 0) continue;

    const policy = DIRTY_GATE_POLICY[category];
    if (policy.blocking) {
      blockingCounts[category] = entries.length;
      continue;
    }

    passingCounts[category] = entries.length;
    const paths = entries.slice(0, AUDIT_PATH_SAMPLE_LIMIT).map((e) => e.path);
    const event: AuditEvent = {
      type: 'dirty_gate_audit',
      storyId: ctx.storyId,
      gate: ctx.gate,
      category,
      pathCount: entries.length,
      paths,
      reason: policy.auditReason,
      timestamp: now(),
    };
    auditEvents.push(event);

    if (ctx.writer) {
      try {
        ctx.writer(event);
      } catch (err: any) {
        auditFailure = `AUDIT WRITE FAILED: ${err?.message || String(err)}`;
        // preMortem #2: stop calling writer after first failure; we will force
        // allPass=false below. Continuing would just multiply error messages.
        break;
      }
    }
  }

  const blockingTotal = Object.values(blockingCounts).reduce((acc, n) => acc + (n ?? 0), 0);
  const passingTotal = Object.values(passingCounts).reduce((acc, n) => acc + (n ?? 0), 0);

  // allPass: no blocking entries AND no audit-write failure.
  const allPass = blockingTotal === 0 && auditFailure === null;

  const blockingSegment = renderCategoryGroup('blocking', blockingCounts);
  const passingSegment = renderCategoryGroup('passed', passingCounts);
  let summary: string;
  if (blockingTotal === 0 && passingTotal === 0) {
    // Empty classification → uniform short-form summary used by smoke tests.
    summary = 'blocking=0; passed=0';
  } else {
    summary = `${blockingSegment}; ${passingSegment}`;
  }

  return { allPass, blockingCounts, passingCounts, auditEvents, summary, auditFailure };
}

/**
 * Production audit writer: append-only JSONL into
 * `<projectRoot>/<storyDir>/<storyId>/process-events.jsonl`.
 *
 * Throws on fs error so `evaluateDirtyGate` catches and degrades the gate.
 *
 * Parameters:
 *   - projectRoot: repository root (absolute path)
 *   - storyDirRel: config.storyDir (e.g. ".koala/story/actives")
 *   - storyId: story id (e.g. "B-4b22")
 */
export function defaultAuditWriter(projectRoot: string, storyDirRel: string, storyId: string): AuditWriter {
  const storyDir = join(projectRoot, storyDirRel, storyId);
  const filePath = join(storyDir, 'process-events.jsonl');
  return (event: AuditEvent) => {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf-8');
  };
}
