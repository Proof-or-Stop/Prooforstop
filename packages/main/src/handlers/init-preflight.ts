import type { HandlerContext } from './context.js';
import { isCanonicalStoryId } from '../core/lifecycle-registry.js';
import { getGuardFailureReason } from '../core/machine.js';
import { digestScopeFreezeCheck } from '../core/scope-anti-expansion.js';
import {
  missingRequiredInitCheckAgents,
  blockingInitCheckIssues,
  recomputeInitCheckHash,
} from '../core/init-check-gate.js';
import type { InitCheckData } from '../core/types.js';

interface InitPreflightArgs {
  storyId: string;
  format?: 'text' | 'json';
  json?: boolean;
  runCommands?: boolean;
  writeEvidence?: boolean;
  advancePhase?: boolean;
  launchReviewers?: boolean;
  authorityDone?: boolean;
  fullAuthorityDone?: boolean;
  productionDone?: boolean;
  write?: boolean;
  apply?: boolean;
  execute?: boolean;
}

/** One probed INIT→INIT_CHECK prerequisite row. */
type PrerequisiteStatus = 'PASS' | 'MISSING' | 'STALE' | 'BLOCKED' | 'ERROR';

interface PrerequisiteRow {
  id: string;
  status: PrerequisiteStatus;
  /** The exact `proofOrStop …` command that resolves a MISSING/STALE/BLOCKED row (no fix on PASS / ERROR). */
  fix?: string;
  /** Human-readable detail (the throw message on ERROR, or a short note on the non-PASS state). */
  detail?: string;
}

export interface InitPreflightReport {
  storyId: string;
  target: 'INIT_CHECK';
  prerequisites: PrerequisiteRow[];
  gate: {
    ready: boolean;
    blockedBy?: string;
  };
  mode: {
    runCommands: false;
    writeEvidence: false;
  };
}

function wantsJson(args: InitPreflightArgs): boolean {
  return args.json === true || args.format === 'json';
}

/**
 * Fail closed BEFORE any store read. init_preflight is a strictly read-only
 * INIT→INIT_CHECK prerequisite surveyor: it runs no commands and writes no
 * evidence/metadata. Any flag that would imply running a command, writing
 * evidence, advancing the lifecycle, launching reviewers, or claiming Authority
 * completion is rejected up front. There is NO --write/--apply/--execute path.
 */
function assertBoundary(args: InitPreflightArgs): void {
  const rejected: string[] = [];
  if (args.runCommands === true) rejected.push('runCommands=true');
  if (args.writeEvidence === true) rejected.push('writeEvidence=true');
  if (args.advancePhase === true) rejected.push('advancePhase=true');
  if (args.launchReviewers === true) rejected.push('launchReviewers=true');
  if (args.authorityDone === true) rejected.push('authorityDone=true');
  if (args.fullAuthorityDone === true) rejected.push('fullAuthorityDone=true');
  if (args.productionDone === true) rejected.push('productionDone=true');
  if (args.write === true) rejected.push('write=true');
  if (args.apply === true) rejected.push('apply=true');
  if (args.execute === true) rejected.push('execute=true');
  if (rejected.length === 0) return;
  throw new Error(
    `init_preflight refuses unsupported side effects: ${rejected.join(' and ')}. ` +
    'init_preflight is a strictly read-only INIT→INIT_CHECK prerequisite surveyor: no story facts were read, ' +
    'no commands were run, no evidence or metadata was written, no reviewers were launched, and no phase was advanced. ' +
    'The actual fixes are the per-row commands it prints (scope_boundary_set / execution_boundary_set / scope_freeze_check / ' +
    'scope_extension_decide / the two INIT reviewers + init_check_set).',
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Probe ONE prerequisite independently, catching every store throw so a corrupt
 * read for one row never crashes the survey nor silently passes — it surfaces as
 * its own [ERROR] row with the diagnostic message.
 */
function probe(id: string, fn: () => PrerequisiteRow): PrerequisiteRow {
  try {
    return fn();
  } catch (err) {
    return { id, status: 'ERROR', detail: errMessage(err) };
  }
}

/**
 * init-check is "valid" exactly the way machine.ts's INIT_CHECK gate treats it.
 * We mirror the gate's order of checks (machine.ts:826-858): the gate is only
 * applied while story.phase === 'INIT' (machine.ts:828 returns null otherwise —
 * IDEA→INIT_CHECK and post-INIT stories are NOT gated). So we ONLY flag a stale
 * _hash for an INIT-phase story; otherwise the present/missing/blocked checks run
 * the same as the gate. When applicable the order is: present (not
 * missing_init_check) → _hash matches its recomputed digest (else
 * init_check_tampered → [STALE]) → both required INIT reviewers persisted → no
 * blocking (critical/high) init-check issue. The _hash is recomputed via the SAME
 * recomputeInitCheckHash the gate uses (machine.ts:841), with the SAME
 * projectRoot, so a tampered/stale _hash surfaces as [STALE] here exactly as the
 * gate blocks with [init_check_tampered] — never a misleading [PASS] — and the
 * row never diverges from the (phase-gated) gate verdict on a post-INIT story.
 */
function initCheckRow(
  storyId: string,
  store: HandlerContext['store'],
  projectRoot: string,
  phase: string,
  initCheck: InitCheckData | null,
): PrerequisiteRow {
  const id = 'init-check';
  const fix =
    `run the two INIT reviewers (proof-or-stop-review-story-init + proof-or-stop-product-reviewer) then ` +
    `proof-or-stop init_check_set --storyId=${storyId}`;
  if (!initCheck) {
    return { id, status: 'MISSING', fix, detail: 'init-check.json is missing (no INIT reviewer has persisted yet)' };
  }
  // Mirror machine.ts:828+841-844: the init_check_tampered check is ONLY applied
  // for an INIT-phase story (the gate returns null/not-applicable otherwise).
  // Recompute the hash the SAME way the gate does and compare to the persisted _hash.
  if (phase === 'INIT') {
    const expectedHash = recomputeInitCheckHash(storyId, store, projectRoot);
    if (initCheck._hash !== expectedHash) {
      return {
        id,
        status: 'STALE',
        fix,
        detail: 'init-check.json _hash mismatch (background/title/description/checklist changed since signing) [init_check_tampered]',
      };
    }
  }
  const missingAgents = missingRequiredInitCheckAgents(initCheck);
  if (missingAgents.length > 0) {
    return {
      id,
      status: 'MISSING',
      fix,
      detail: `required INIT reviewer(s) not yet persisted: ${missingAgents.join(', ')}`,
    };
  }
  const blockers = blockingInitCheckIssues(initCheck);
  if (blockers.length > 0) {
    return {
      id,
      status: 'BLOCKED',
      fix,
      detail: `${blockers.length} blocking init-check issue(s): ${blockers
        .map((b) => `${b.agentId}:${b.issue.severity}`)
        .join(', ')}`,
    };
  }
  return { id, status: 'PASS' };
}

export function buildInitPreflightReport(ctx: HandlerContext, storyId: string): InitPreflightReport {
  const store = ctx.store;
  // The projectRoot the authoritative gate (machine.ts) resolves init-check
  // background/checklist hashes against. We pass the SAME root to both the
  // per-row probe and getGuardFailureReason so the row and the gate can never
  // disagree on _hash freshness.
  const projectRoot = ctx.root;
  const prerequisites: PrerequisiteRow[] = [];

  // 1) scope-boundary: present?
  prerequisites.push(
    probe('scope-boundary', () => {
      const boundary = store.readScopeBoundary(storyId);
      if (!boundary) {
        return {
          id: 'scope-boundary',
          status: 'MISSING',
          fix: `proof-or-stop scope_boundary_set --storyId=${storyId} --userConfirmed=true ...`,
          detail: 'scope-boundary.json is missing',
        };
      }
      return { id: 'scope-boundary', status: 'PASS' };
    }),
  );

  // 2) execution-boundary: present?
  prerequisites.push(
    probe('execution-boundary', () => {
      const boundary = store.readExecutionBoundary(storyId);
      if (!boundary) {
        return {
          id: 'execution-boundary',
          status: 'MISSING',
          fix: `proof-or-stop execution_boundary_set --storyId=${storyId} ...`,
          detail: 'execution-boundary.json is missing',
        };
      }
      return { id: 'execution-boundary', status: 'PASS' };
    }),
  );

  // 3) scope-freeze-check: present + status==='pass' + _hash matches its own digest.
  prerequisites.push(
    probe('scope-freeze-check', () => {
      const check = store.readScopeFreezeCheck(storyId);
      const fix = `proof-or-stop scope_freeze_check --storyId=${storyId}`;
      if (!check) {
        return {
          id: 'scope-freeze-check',
          status: 'MISSING',
          fix,
          detail: 'scope-freeze-check.json is missing',
        };
      }
      if (check._hash !== digestScopeFreezeCheck(check)) {
        return {
          id: 'scope-freeze-check',
          status: 'STALE',
          fix,
          detail: 'scope-freeze-check.json hash is stale or tampered',
        };
      }
      if (check.status !== 'pass') {
        return {
          id: 'scope-freeze-check',
          status: 'STALE',
          fix,
          detail: `scope-freeze-check.json status is ${check.status}`,
        };
      }
      return { id: 'scope-freeze-check', status: 'PASS' };
    }),
  );

  // 4) scope-extension-proposals: any still pending?
  prerequisites.push(
    probe('scope-extension-proposals', () => {
      const data = store.readScopeExtensionProposals(storyId);
      const pending = (data.proposals ?? []).filter((p) => p.status === 'pending');
      if (pending.length > 0) {
        return {
          id: 'scope-extension-proposals',
          status: 'BLOCKED',
          fix: `proof-or-stop scope_extension_decide --storyId=${storyId} --proposalId=${pending[0].proposalId} ...`,
          detail: `${pending.length} pending proposal(s): ${pending.map((p) => p.proposalId).join(', ')}`,
        };
      }
      return { id: 'scope-extension-proposals', status: 'PASS' };
    }),
  );

  // 5) init-check: present + (INIT-phase only) _hash fresh + both INIT reviewers +
  //    no blocking issue (mirrors machine.ts's INIT_CHECK gate order, incl. the
  //    phase-gated init_check_tampered check).
  prerequisites.push(
    probe('init-check', () => {
      const phase = store.readStory(storyId).phase;
      return initCheckRow(storyId, store, projectRoot, phase, store.readInitCheck(storyId));
    }),
  );

  // 6) scope-discard-digest: readable? (no user fix — a corrupt read surfaces as [ERROR]).
  prerequisites.push(
    probe('scope-discard-digest', () => {
      store.readScopeDiscardDigestForFreeze(storyId);
      return { id: 'scope-discard-digest', status: 'PASS' };
    }),
  );

  // AUTHORITATIVE verdict, BY CONSTRUCTION. gate.ready/blockedBy is the EXACT
  // result of the real INIT→INIT_CHECK gate: getGuardFailureReason returns null
  // IFF the machine would allow INIT→INIT_CHECK (it covers BOTH the scope
  // anti-expansion side AND init-check, including the _hash / init_check_tampered
  // check via recomputeInitCheckHash). We delegate entirely — no hand-rolled
  // readiness predicate — so the preflight can NEVER disagree with the real gate.
  // The per-row probes above remain the independent human checklist; this single
  // line is the source-of-truth gate verdict.
  const blockedReason = getGuardFailureReason(storyId, store, 'INIT_CHECK', projectRoot);
  const ready = blockedReason === null;

  return {
    storyId,
    target: 'INIT_CHECK',
    prerequisites,
    gate: ready ? { ready: true } : { ready: false, ...(blockedReason ? { blockedBy: blockedReason } : {}) },
    mode: { runCommands: false, writeEvidence: false },
  };
}

export function renderInitPreflightReport(report: InitPreflightReport): string {
  const lines = [
    `INIT preflight (${report.storyId} → ${report.target})`,
    'mode: read-only (no commands run, no evidence written)',
    '',
    'Prerequisites:',
  ];
  for (const row of report.prerequisites) {
    lines.push(`  [${row.status}] ${row.id}${row.detail ? ` — ${row.detail}` : ''}`);
    if (row.fix) lines.push(`        fix: ${row.fix}`);
  }
  lines.push('');
  if (report.gate.ready) {
    lines.push('gate: READY');
  } else {
    lines.push(`gate: BLOCKED (blockedBy=${report.gate.blockedBy ?? 'unknown'})`);
  }
  return lines.join('\n');
}

export function createInitPreflightHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  function initPreflight(args: InitPreflightArgs): InitPreflightReport | string {
    assertBoundary(args);
    if (!isCanonicalStoryId(args.storyId)) {
      throw new Error(
        `init_preflight refuses a non-canonical storyId: ${JSON.stringify(args.storyId)}. ` +
        'A storyId must be a path-safe canonical Proof-or-Stop id (e.g. B-1a2b); no story facts were read.',
      );
    }
    const report = buildInitPreflightReport(ctx, args.storyId);
    return wantsJson(args) ? report : renderInitPreflightReport(report);
  }

  return {
    init_preflight: initPreflight,
  };
}
