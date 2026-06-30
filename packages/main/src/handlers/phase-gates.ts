/**
 * B-56d3 (Lifecycle Phase 2, Story 3a): phase-gates — transition gate runner.
 *
 * The transition gate logic was mechanically relocated here from
 * handlers/story-advance.ts with ZERO semantic change — gate decisions,
 * fail-closed semantics, error wording, and the lattice validate test-evidence
 * write timing are byte-identical before and after the move (preMortem #1).
 *
 * What lives here:
 *   - runReviewToTestPreflightGate  — REVIEW→TEST CLI preflight orchestration
 *                                     (logging / fail-closed catch / error
 *                                     shaping around handlers/review-preflight)
 *   - runValidateGate               — the lattice validate --json gate (writes
 *                                     test-evidence.json — see annotation below)
 *   - runDoneOracleGate             — the TEST→DONE done-oracle gate adapter
 *                                     (consumes core/done-oracle.ts)
 *   - resolveGuardFailure           — the cwd/guard-failure adapter (gate hint
 *                                     rendering for an actor that refuses an
 *                                     event)
 *
 * Layering: this module lives in handlers/ (NOT core/) on purpose. It depends
 * on handler-only modules (review-preflight.ts, verifier.ts, HandlerContext).
 * A core/ module importing those would be a core→handlers layer violation, so
 * phase-gates.ts is placed alongside them in handlers/. It must NOT import
 * handlers/story-advance.js (no circular import — preMortem #2);
 * transition-orchestrator imports phase-gates, never the reverse.
 */

import type { HandlerContext } from './context.js';
import type { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryPhase, ReviewLoopIteration, ScopeCheckResult, ScopeViolation, ProofStoryGateMode } from '../core/types.js';
import { listActiveLoops, deriveLatestLoopRecord } from '../core/review-loop.js';
import { getStateName, getGuardFailureReason } from '../core/machine.js';
import { resolveLocalCodexVerifyCommand } from '../core/codex-adapter-checks.js';
import { checkEvidenceFreshnessForGit, currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { reportHealthIssue } from '../core/health.js';
import { loadConfig } from '../core/config.js';
import { resolveWorkflowPolicy } from '../core/workflow-policy.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { execSync } from 'child_process';
import {
  classifyGitStatusRows,
  classifierOptionsForCheck,
  isBlockingDirty,
  readGitStatusLines,
} from '../core/dirty-worktree-gate.js';
import { buildVerificationCoverage } from '../core/verification.js';
import {
  buildDoneChecklist,
  renderDoneChecklist,
  type DoneCheckRow,
} from '../core/done-oracle.js';
import {
  runScopeGate,
} from './scope-contract.js';
import { renderScopeCheckResult } from '../core/scope-contract.js';
import {
  evaluateDoneIntentEquivalence,
  evaluateReviewCompleteness,
  type ProofStoryDiagnosticInput,
} from '../core/proofstory.js';

type ScopeLifecycleRow = {
  id?: string;
  status?: string;
  detail?: string;
  hint?: string;
  source?: string;
  blocking?: boolean;
  path?: string;
  rule?: string;
  assuranceLabel?: string;
};

/**
 * Returns true if any checklist item has non-empty file declarations
 * (files.modify / files.create / files.test). Used to distinguish "new-scope"
 * stories (which require a scope contract) from legacy stories (which predate
 * file declarations and remain backward-compatible without one).
 */
export function checklistHasFileDeclarations(checklist: ChecklistData | null | undefined): boolean {
  if (!checklist) return false;
  for (const item of checklist.items) {
    if (
      (item.files?.modify && item.files.modify.length > 0) ||
      (item.files?.create && item.files.create.length > 0) ||
      (item.files?.test && item.files.test.length > 0)
    ) {
      return true;
    }
  }
  return false;
}

function proofStoryDiagnosticInput(store: StoryStore, storyId: string): ProofStoryDiagnosticInput {
  let checklist: ChecklistData;
  try {
    checklist = store.readChecklist(storyId);
  } catch {
    checklist = { items: [] };
  }
  return {
    story: store.readStory(storyId),
    checklist,
    originalIntentSnapshot: store.readOriginalIntentSnapshot(storyId),
    milestoneLedger: store.readMilestoneLedger(storyId),
    slicePlan: store.readProofStorySlicePlan(storyId),
    parentLedgerRollup: store.readProofStoryParentLedgerRollup(storyId),
    proofStoryContract: store.readProofStoryContract(storyId),
    intentCollision: store.readIntentCollision(storyId),
    scopeContract: store.readScopeContract(storyId),
    scopeShrinkageDecision: store.readScopeShrinkageDecision(storyId),
    redEvidence: store.readRedEvidence(storyId),
    spikeEvidence: store.readProofStorySpikes(storyId),
    summary: store.readSummary(storyId),
  };
}

function renderProofStoryRows(label: string, mode: ProofStoryGateMode, status: string, blocking: boolean, gaps: Array<{ code: string; message: string }>): string {
  return [
    `${label}: ${status} (mode=${mode}, blocking=${blocking ? 'yes' : 'no'})`,
    ...(gaps.length === 0
      ? ['  - no gaps']
      : gaps.map((gap) => `  - ${gap.code}: ${gap.message}`)),
  ].join('\n');
}

function configuredProofStoryMode(ctx: HandlerContext, key: 'reviewGateMode' | 'doneGateMode'): ProofStoryGateMode {
  return loadConfig(ctx.root).proofStory?.[key] ?? 'observe';
}

/**
 * cwd/guard-failure adapter.
 *
 * When the xstate actor refuses the requested transition event, resolve the
 * human-readable guard failure reason. The caller decides whether canSend is
 * false; this function only shapes the error message.
 *
 * B-6974: this adapter NO LONGER stops the actor — actor lifecycle is owned
 * solely by transition-orchestrator.ts, which stops it in a single finally on
 * every exit path. `actor` is still read here (getStateName) to render the
 * fallback "Cannot transition from <state> to <phase>" message.
 */
export function resolveGuardFailure(
  actor: ReturnType<typeof import('../core/machine.js').createStoryActor>,
  storyId: string,
  store: StoryStore,
  phase: StoryPhase,
  root: string,
): Error {
  const reason = getGuardFailureReason(storyId, store, phase, root);
  const currentState = getStateName(actor);
  return new Error(
    reason || `Cannot transition from ${currentState} to ${phase}`,
  );
}

/**
 * B-7a34 CHK-003: Review loop gate for REVIEW→TEST.
 *
 * Blocks REVIEW→TEST while any review loop record has status='open'.
 * Resolved close (status='resolved') clears this gate only; blocked and
 * escalated closes (status='blocked'|'escalated') also clear this gate
 * because they are not 'open' — but they do not unblock underlying
 * finding/review/validation gates.
 *
 * Runs synchronously before CLI preflight gates so a clear error is
 * surfaced without needing CLI tooling to execute.
 *
 * On gate failure: throws "Cannot enter TEST" with loopId, decision, and
 * nextAction for each open loop. On success: returns normally (no-op).
 */
export function runReviewLoopGate(storyId: string, store: StoryStore): void {
  let records;
  try {
    records = store.readReviewLoopRecords(storyId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot enter TEST: review loop records could not be read [review_loop_record_error]\n` +
      `  - ${msg}\n\n` +
      `→ 修复 review-loops evidence 后重跑 story_advance --phase=TEST`,
    );
  }
  const activeLoops = listActiveLoops(records);
  if (activeLoops.length === 0) return;

  const details = activeLoops.map(loopId => {
    const latest = deriveLatestLoopRecord(records, loopId);
    const parts: string[] = [`loopId=${loopId}`];
    if (latest && latest.event === 'iteration') {
      const iter = latest as ReviewLoopIteration;
      parts.push(`decision=${iter.decision}`);
      if (iter.nextAction) {
        const naEntries = Object.entries(iter.nextAction)
          .filter(([, v]) => v != null)
          .map(([k, v]) => `${k}=${String(v)}`);
        if (naEntries.length > 0) parts.push(`nextAction={${naEntries.join(', ')}}`);
      }
    }
    return `  [open_loop] ${parts.join(', ')}`;
  });

  throw new Error(
    `Cannot enter TEST: active review loop(s) block REVIEW→TEST [open_review_loop]\n` +
    `${details.join('\n')}\n\n` +
    `→ 关闭所有 open loop（review_loop_close --status=resolved）后确保 trigger refs 已 resolved，再重跑 story_advance --phase=TEST`,
  );
}

function scopeRowId(v: ScopeViolation): string {
  return `scope:${v.rule}:${v.path}`.replace(/\s+/g, '_');
}

function lifecycleStatusForViolation(v: ScopeViolation, resultStatus: ScopeCheckResult['status']): 'fail' | 'warn' {
  if (v.acknowledged) return 'warn';
  return resultStatus === 'fail' ? 'fail' : 'warn';
}

function lifecycleBlockingForViolation(v: ScopeViolation, resultStatus: ScopeCheckResult['status']): boolean {
  return !v.acknowledged && resultStatus === 'fail';
}

function renderScopeLifecycleRows(result: ScopeCheckResult, phase: StoryPhase): string {
  const explicitRows = (result as ScopeCheckResult & {
    rows?: ScopeLifecycleRow[];
    lifecycleRows?: ScopeLifecycleRow[];
  }).rows ?? (result as ScopeCheckResult & { lifecycleRows?: ScopeLifecycleRow[] }).lifecycleRows;

  if (Array.isArray(explicitRows) && explicitRows.length > 0) {
    return [
      'Scope gate rows:',
      ...explicitRows.map((row, index) => {
        const id = row.id ?? `scope-row:${index + 1}`;
        const status = row.status ?? 'unknown';
        const blocking = row.blocking === undefined ? 'unknown' : String(row.blocking);
        const source = row.source ? ` source=${row.source}` : '';
        const path = row.path ? ` path=${row.path}` : '';
        const rule = row.rule ? ` rule=${row.rule}` : '';
        const assurance = row.assuranceLabel ? ` assurance=${row.assuranceLabel}` : '';
        const detail = row.detail ? ` detail=${row.detail}` : '';
        const hint = row.hint ? ` hint=${row.hint}` : '';
        return `  [${id}] status=${status} blocking=${blocking} phase=${phase}${source}${path}${rule}${assurance}${detail}${hint}`;
      }),
    ].join('\n');
  }

  const problems = [...result.violations, ...result.warnings];
  if (problems.length === 0) return '';
  return [
    'Scope gate rows:',
    ...problems.map((v) => {
      const status = lifecycleStatusForViolation(v, result.status);
      const blocking = lifecycleBlockingForViolation(v, result.status);
      const anchor = v.anchor ? ` anchor=${v.anchor}` : '';
      const digest = v.hunkDigest ? ` hunkDigest=${v.hunkDigest}` : '';
      const assurance = v.acknowledged ? ' assurance=acknowledged-expansion' : '';
      const hint = v.acknowledged
        ? ' hint=review acknowledged expansion before accepting lifecycle progress'
        : ' hint=remove change or record an explicit scope_contract_acknowledge in DEV/REVIEW';
      return `  [${scopeRowId(v)}] status=${status} blocking=${blocking} phase=${phase} source=scope-contract path=${v.path} rule=${v.rule}${anchor}${digest}${assurance}${hint}`;
    }),
  ].join('\n');
}

/**
 * REVIEW→TEST CLI preflight gate.
 *
 * F-019 (B-9d95 Round 1 review): REVIEW→TEST preflight 跑 CLI gates。
 * runReviewCliGates 聚合 checkCommitAuthor / checkConcept / checkLint /
 * docs-drift，并在 Codex adapter 触点存在时追加 codex-adapter gate。
 * 任一 fail 即 block；快速通道走 runReviewCliGates 内部的 fastChannel
 * 路径（常规 gate 统一 skip），与 F-015 修正后的 computeChannel 口径一致。
 *
 * Fail-closed (preMortem #1): the same try/catch shape as the inline original
 * — a preflight infrastructure failure (e.g. review-preflight.ts import
 * failure) still throws "Cannot enter TEST", never silently advances.
 *
 * On gate failure / infrastructure failure this throws; on success it returns
 * normally.
 *
 * B-6974: this gate NO LONGER stops the actor on failure — actor lifecycle is
 * owned solely by transition-orchestrator.ts, which stops it in a single
 * finally on every exit path (including the thrown-error path here). The
 * `actor` parameter is kept for signature stability but is no longer used.
 */
export async function runReviewToTestPreflightGate(
  ctx: HandlerContext,
  storyId: string,
  _actor: { stop(): void },
): Promise<void> {
  const { store } = ctx;
  // B-7a34 CHK-003: review loop gate runs before CLI gates (sync, no tooling required).
  runReviewLoopGate(storyId, store);
  const proofStoryMode = configuredProofStoryMode(ctx, 'reviewGateMode');
  if (proofStoryMode !== 'observe') {
    const proofStoryReport = evaluateReviewCompleteness(proofStoryDiagnosticInput(store, storyId), proofStoryMode);
    const renderedProofStory = renderProofStoryRows(
      'ProofStory REVIEW completeness',
      proofStoryReport.mode,
      proofStoryReport.status,
      proofStoryReport.blocking,
      proofStoryReport.gaps,
    );
    if (proofStoryReport.blocking) {
      throw new Error(
        `Cannot enter TEST: ProofStory REVIEW completeness gate did not pass\n\n` +
        renderedProofStory +
        `\n\n→ Resolve ProofStory completeness gaps or set proofStory.reviewGateMode to observe/warn before rerunning story_advance --phase=TEST.`,
      );
    }
    ctx.log?.(renderedProofStory);
  }
  ctx.log?.('REVIEW→TEST preflight: running CLI gates (channel/concept/lint/docs-drift plus conditional codex-adapter)...');
  try {
    const { runReviewCliGates, renderPreflight } = await import('./review-preflight.js');
    const preflight = runReviewCliGates(storyId, {
      store,
      projectRoot: ctx.root,
      registryNames: ctx.getAllToolNames?.(),
    });
    const codexVerifyCmd = resolveLocalCodexVerifyCommand(ctx.root);
    if (!preflight.ok) {
      const rendered = renderPreflight(preflight);
      const failedGates = preflight.gates.filter(g => !g.ok).map(g => g.name).join(', ');
      throw new Error(
        `Cannot enter TEST: CLI gate preflight did not pass (${failedGates})\n\n` +
        rendered +
        `\n\n→ 修复上述 gate 后重跑 lattice story_advance --phase=TEST\n` +
        `→ 单独复跑: lattice validate --channel --story=${storyId} / --concept / --lint；docs-drift 随 preflight 执行；Codex adapter 用 ${codexVerifyCmd}`,
      );
    }
    if (preflight.gates.some(g => g.status === 'warn')) {
      ctx.log?.(renderPreflight(preflight));
    } else {
      ctx.log?.('CLI gate preflight: all pass');
    }
  } catch (e: any) {
    if (e?.message?.startsWith('Cannot enter TEST')) throw e;
    // 预检查本身失败（review-preflight.ts import 失败等）→ fail-closed
    const message = e instanceof Error ? e.message : String(e);
    const codexVerifyCmd = resolveLocalCodexVerifyCommand(ctx.root);
    throw new Error(
      `Cannot enter TEST: CLI gate preflight execution error\n` +
      `${message}\n\n` +
      `→ 修复 review-preflight gate 后重跑 lattice story_advance --phase=TEST\n` +
      `→ 单独复跑: lattice validate --channel --story=${storyId} / --concept / --lint；docs-drift 随 preflight 执行；Codex adapter 用 ${codexVerifyCmd}`,
    );
  }
}

/**
 * Scope contract gate for transitions that freeze, verify, or complete work.
 *
 * New-scope stories (checklist items declare files) require a scope contract:
 * - Missing contract BLOCKS the transition [missing_scope_contract].
 * - Corrupt contract BLOCKS the transition [scope_contract_unreadable].
 * - enforce + fail BLOCKS the transition.
 * - shadow/local warnings are rendered but do not block.
 * - pass is rendered so users can see the scope check ran.
 *
 * Legacy stories (no file declarations in checklist) remain backward-compatible:
 * - Missing contract emits a visible degradation warning at REVIEW only (silent
 *   at TEST/DONE to avoid noise on repeated transitions).
 */
export function runScopeTransitionGate(
  ctx: HandlerContext,
  storyId: string,
  phase: StoryPhase,
): string {
  let result;
  try {
    result = runScopeGate(storyId, ctx.store, ctx.root);
  } catch (e) {
    // B-6bfd CHK-006 fail-closed: readScopeContract throws when an existing
    // scope-contract.json is corrupt/unreadable (vs. null for a genuinely
    // missing contract). Surface this as a hard, clear gate failure rather than
    // silently treating a scope-protected story as no-contract (= bypass).
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Cannot enter ${phase}: scope-contract.json is unreadable/corrupt [scope_contract_unreadable]\n` +
      `${message}\n\n` +
      `→ Fix or recreate the contract (scope_contract_set / scope_contract_init_from_plan), then rerun story_advance --phase=${phase}.\n` +
      `   Refusing to advance: a corrupt scope contract must not downgrade a scope-protected story to no scope protection.`,
    );
  }
  if (!result) {
    // No scope contract: distinguish new-scope stories (must have contract) from
    // legacy stories (backward-compatible, visible degradation at REVIEW only).
    let checklist: ChecklistData | null = null;
    try { checklist = ctx.store.readChecklist(storyId); } catch { /* missing checklist → legacy */ }
    if (checklistHasFileDeclarations(checklist)) {
      // New-scope story: BLOCK — file declarations require an explicit contract.
      throw new Error(
        `Cannot enter ${phase}: scope-contract.json missing for a new-scope story [missing_scope_contract]\n\n` +
        `Story ${storyId} declares file scopes in its checklist but has no scope contract.\n` +
        `→ Run: lattice scope_contract_init_from_plan '{"storyId":"${storyId}"}'\n` +
        `   Then rerun story_advance --phase=${phase}`,
      );
    }
    // Legacy story: degrade visibly at REVIEW only; silent at TEST/DONE.
    if (phase === 'REVIEW') {
      return `\n\n⚠ Scope protection: none (legacy story — checklist items have no file declarations; ` +
        `add files to checklist items and run scope_contract_init_from_plan to enable scope enforcement)`;
    }
    return '';
  }
  const rendered = renderScopeCheckResult(result);
  const rowDetails = renderScopeLifecycleRows(result, phase);
  const renderedWithRows = rowDetails ? `${rendered}\n${rowDetails}` : rendered;
  if (result.status === 'fail') {
    throw new Error(
      `Cannot enter ${phase}: ${result.summary}\n\n` +
      renderedWithRows +
      `\n\n→ 修复 out-of-scope diff，或用 scope_contract_acknowledge 记录必要扩展后重跑 story_advance --phase=${phase}`,
    );
  }
  // CHK-004 B-a30e: advisory warning copy — name recovery path depending on phase.
  if (result.status === 'warn') {
    const recoveryHint = (phase === 'TEST' || phase === 'DONE')
      ? `→ Scope warnings (advisory, not blocking) — roll back to DEV to acknowledge via scope_contract_acknowledge, or verify via delivery reviewer.`
      : `→ Scope warnings (advisory, not blocking) — acknowledge via scope_contract_acknowledge if the expansion is intentional, then proceed.`;
    return `\n\n${renderedWithRows}\n\n${recoveryHint}`;
  }
  return `\n\n${renderedWithRows}`;
}

/**
 * PLAN→DEV scope contract advisory.
 *
 * When advancing to DEV, if the story declares file scopes in its checklist
 * but no scope-contract.json has been created yet, emit a soft advisory
 * recommending scope_contract_init_from_plan. Does NOT block — the contract
 * can still be created during DEV — but the advisory is visible early so
 * developers know to run it before REVIEW (which will hard-block without it).
 *
 * Returns '' if no advisory needed (legacy story, or contract already exists).
 */
export function runPlanToDevScopeAdvice(ctx: HandlerContext, storyId: string): string {
  let checklist: ChecklistData | null = null;
  try { checklist = ctx.store.readChecklist(storyId); } catch { return ''; }
  if (!checklistHasFileDeclarations(checklist)) return '';

  // Contract already exists — no advisory needed.
  try {
    const contract = ctx.store.readScopeContract(storyId);
    if (contract !== null) return '';
  } catch { /* corrupt contract → still show advisory; REVIEW will fail-closed */ }

  return (
    `\n\n⚠ Scope contract: not initialized — this story declares file scopes in its checklist.\n` +
    `   Run before REVIEW: lattice scope_contract_init_from_plan '{"storyId":"${storyId}"}'\n` +
    `   Advancing to REVIEW without a scope contract will BLOCK for this new-scope story.`
  );
}

export function runLegacyReceiptTransitionGate(
  ctx: HandlerContext,
  storyId: string,
  targetPhase: Extract<StoryPhase, 'TEST' | 'DONE'>,
): string {
  if (targetPhase !== 'DONE') return '';
  const mode = configuredProofStoryMode(ctx, 'doneGateMode');
  if (mode === 'observe') return '';
  const report = evaluateDoneIntentEquivalence(proofStoryDiagnosticInput(ctx.store, storyId), mode);
  const rendered = renderProofStoryRows(
    'ProofStory DONE intent equivalence',
    report.mode,
    report.status,
    report.blocking,
    report.gaps,
  );
  if (report.blocking) {
    throw new Error(
      `Cannot enter DONE: ProofStory intent equivalence gate did not pass\n\n` +
      rendered +
      `\n\n→ Cover required milestones with passing verification evidence or record an explicit scope_shrinkage_decision_set before rerunning story_advance --phase=DONE.`,
    );
  }
  return `\n\n${rendered}`;
}

function canonicalCoverageSnapshotFromReport(coverage: any): string | null {
  if (!Array.isArray(coverage?.entries)) return null;
  const rows = coverage.entries.map((entry: any) => ({
    intentRef: String(entry?.intentRef ?? ''),
    itemId: String(entry?.itemId ?? ''),
    lane: String(entry?.lane ?? ''),
    desc: String(entry?.desc ?? ''),
    type: String(entry?.type ?? ''),
    priority: String(entry?.priority ?? 'must'),
    status: String(entry?.status ?? ''),
    evidence: entry?.evidence ? {
      kind: String(entry.evidence.kind ?? ''),
      result: String(entry.evidence.result ?? ''),
      command: String(entry.evidence.command ?? ''),
      waiverType: String(entry.evidence.waiverType ?? ''),
      verdict: String(entry.evidence.verdict ?? ''),
    } : null,
  }));
  rows.sort((a: any, b: any) => a.intentRef.localeCompare(b.intentRef));
  return JSON.stringify({
    total: typeof coverage.total === 'number' ? coverage.total : null,
    required: typeof coverage.required === 'number' ? coverage.required : null,
    covered: typeof coverage.covered === 'number' ? coverage.covered : null,
    missingRequired: typeof coverage.missingRequired === 'number' ? coverage.missingRequired : null,
    entries: rows,
  });
}

function currentChecklistCoverageSnapshot(ctx: HandlerContext, storyId: string): string {
  const story = ctx.store.readStory(storyId);
  const checklist = ctx.store.readChecklist(storyId);
  const gitCwd = resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
  const head = currentGitHead(gitCwd);
  const policy = resolveWorkflowPolicy(loadConfig(ctx.root), story);
  const coverage = buildVerificationCoverage(
    checklist,
    head,
    (headHash, evidence) => checkEvidenceFreshnessForGit(
      gitCwd,
      headHash,
      evidence?.materialHash,
      ctx.root,
      evidence?.storyFilesHash,
    ).fresh,
    { deferredGateEvidence: 'missing', evidenceQualityProfile: policy.profile },
  );
  return canonicalCoverageSnapshotFromReport(coverage) ?? JSON.stringify({ entries: [] });
}

function coverageInputsMatchCurrentChecklist(ctx: HandlerContext, storyId: string, coverage: any): { ok: boolean; reason?: string } {
  const recorded = canonicalCoverageSnapshotFromReport(coverage);
  if (!recorded) return { ok: false, reason: 'existing validation PASS verificationCoverage has no entries snapshot' };
  const current = currentChecklistCoverageSnapshot(ctx, storyId);
  if (recorded !== current) {
    return { ok: false, reason: 'existing validation PASS verificationCoverage does not match current checklist verificationIntent inputs or current verificationEvidence records' };
  }
  return { ok: true };
}

function storedValidateOutputIsPassing(output: string): { ok: boolean; reason?: string } {
  try {
    const parsed = JSON.parse(output);
    if (parsed?.allPass === true || parsed?.allPassed === true) return { ok: true };
    return { ok: false, reason: 'existing validation PASS output is not allPass/allPassed=true' };
  } catch {
    return { ok: false, reason: 'existing validation PASS output is not valid JSON' };
  }
}

function blockingDirtyWorktreeReason(ctx: HandlerContext, storyId: string, gitCwd: string): string {
  const status = readGitStatusLines(gitCwd);
  if (!status.ok) return `unable to read git status for validation evidence skip (${status.error})`;
  const config = loadConfig(ctx.root);
  const classification = classifyGitStatusRows(status.lines, classifierOptionsForCheck(config, storyId, ctx.store, ctx.root));
  const blocked = isBlockingDirty(classification);
  if (!blocked.blocked) return '';
  const sample = blocked.blockingPaths.slice(0, 5).join(', ');
  const suffix = blocked.blockingPaths.length > 5 ? ', ...' : '';
  return `current worktree has blocking dirty path(s): ${sample}${suffix}`;
}

/**
 * DEV→TEST lattice validate gate.
 *
 * 自动调 lattice validate，写 test-evidence.json。
 *
 * behavior-preserving side effect: this gate writes test-evidence.json via
 * store.writeTestEvidence — both on the PASS path (DONE gate consumes it) and
 * on the validate-execution-error path. The write is NOT pure; B-56d3 keeps
 * the side effect inline by design (the story explicitly does not force this
 * gate pure). The evidence-write timing is byte-identical to the inline
 * original — the PASS write happens before the allPass check, the FAIL write
 * happens in the catch before the rethrow.
 *
 * Fail-closed (preMortem #1): validate throw / JSON-parse failure each still
 * block TEST — the catch rethrows "Cannot enter TEST" and never advances.
 *
 * On gate failure / execution failure this throws; on success it returns
 * normally.
 *
 * B-6974: this gate NO LONGER stops the actor on failure — actor lifecycle is
 * owned solely by transition-orchestrator.ts, which stops it in a single
 * finally on every exit path (including the thrown-error path here). The
 * `actor` parameter is kept for signature stability but is no longer used.
 */
export async function runValidateGate(
  ctx: HandlerContext,
  storyId: string,
  _actor: { stop(): void },
): Promise<void> {
  const { store } = ctx;
  const existingEvidence = store.readTestEvidence(storyId);
  const validateCommand = `lattice validate --story=${storyId} --json`;
  let rerunReason = '';
  if (existingEvidence?.result === 'PASS') {
    const coverage = existingEvidence.verificationCoverage;
    if (existingEvidence.command !== validateCommand) {
      rerunReason = `existing validation PASS command is not ${validateCommand}`;
    } else {
      const outputPass = storedValidateOutputIsPassing(existingEvidence.output);
      if (!outputPass.ok) {
        rerunReason = outputPass.reason || 'existing validation PASS output is not passing';
      }
    }
    if (!rerunReason) {
      if (!coverage) {
        rerunReason = 'existing validation PASS is missing verificationCoverage from lattice validate';
      } else if (typeof coverage.missingRequired !== 'number') {
        rerunReason = 'existing validation PASS verificationCoverage is missing missingRequired';
      } else if (coverage.missingRequired !== 0) {
        rerunReason = `existing validation PASS has ${coverage.missingRequired} required verification coverage gap(s)`;
      } else {
        const coverageInputMatch = coverageInputsMatchCurrentChecklist(ctx, storyId, coverage);
        if (!coverageInputMatch.ok) {
          rerunReason = coverageInputMatch.reason || 'existing validation PASS verificationCoverage is stale';
        }
      }
    }
    if (!rerunReason && existingEvidence.headHash && existingEvidence.materialHash) {
      const evidenceGitCwd = resolveGitCwd({ store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
      const dirtyReason = blockingDirtyWorktreeReason(ctx, storyId, evidenceGitCwd);
      if (dirtyReason) {
        rerunReason = dirtyReason;
      } else {
        const freshness = checkEvidenceFreshnessForGit(
          evidenceGitCwd,
          existingEvidence.headHash,
          existingEvidence.materialHash,
          ctx.root,
          existingEvidence.storyFilesHash,
        );
        if (freshness.fresh) {
          const warningSuffix = freshness.warnings?.length ? ` (${freshness.warnings.join('; ')})` : '';
          ctx.log?.(`DEV→TEST gate: existing validation PASS is fresh${warningSuffix}; skipping lattice validate rerun.`);
          return;
        }
        rerunReason = `existing validation PASS is stale (${freshness.reason})`;
      }
    } else if (!rerunReason) {
      rerunReason = 'existing validation PASS is missing headHash/materialHash freshness bindings';
    }
  }

  ctx.log?.(rerunReason
    ? `DEV→TEST gate: ${rerunReason}; running lattice validate --json...`
    : 'DEV→TEST gate: running lattice validate --json...');
  try {
    const { createVerifierHandlers } = await import('./verifier.js');
    const verifierHandlers = createVerifierHandlers(ctx);
    const jsonResult = await verifierHandlers.validate({ json: true, story: storyId });
    const parsed = JSON.parse(String(jsonResult));

    // 写入 test-evidence.json（DONE gate 消费）
    // B-c622 CHK-009: 记录 headHash 供 DONE gate evidence freshness 检查
    // B-6666 CHK-002: resolve the git invocation cwd at this write boundary so
    // the headHash/materialHash recorded here are computed from the SAME real
    // gitRoot the DONE-path freshness check later recomputes against. On a
    // wrapper-root layout, writing with a bare metadataRoot would record
    // undefined hashes while the DONE read (resolved gitCwd) yields defined ones
    // → false mismatch → false-block. resolveGitCwd falls back to ctx.root for
    // plain repos (byte-identical) and never throws.
    const evidenceGitCwd = resolveGitCwd({ store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
    let evidenceHeadHash = '';
    try {
      evidenceHeadHash = execSync('git rev-parse HEAD', { cwd: evidenceGitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch { /* 无法获取 HEAD，跳过 */ }
    // B-6666 F-001 (REVIEW fix): pass ctx.root as metadataRoot so the recorded
    // materialHash uses the metadataRoot's custom-storyDir exclusion — matching
    // what the DONE-path freshness recompute does — instead of resolving config
    // from the gitCwd. Plain repos pass root==gitCwd (byte-identical).
    const evidenceMaterialHash = currentMaterialHash(evidenceGitCwd, 'HEAD', ctx.root);
    const evidenceStoryFilesHash = currentStoryFilesHash(evidenceGitCwd, 'HEAD', ctx.root);
    store.writeTestEvidence(storyId, {
      command: validateCommand,
      output: String(jsonResult),
      result: parsed.allPass ? 'PASS' : 'FAIL',
      timestamp: new Date().toISOString(),
      ...(evidenceHeadHash ? { headHash: evidenceHeadHash } : {}),
      ...(evidenceMaterialHash ? { materialHash: evidenceMaterialHash } : {}),
      ...(evidenceStoryFilesHash ? { storyFilesHash: evidenceStoryFilesHash } : {}),
      ...(parsed.verificationCoverage ? { verificationCoverage: parsed.verificationCoverage } : {}),
    });

    if (!parsed.allPass) {
      const failedDetails = (parsed.details || []).filter((d: string) => d.startsWith('✗'));
      const coverage = parsed.verificationCoverage;
      const missingCoverage = coverage?.missingRequired ?? 0;
      const coverageLines = Array.isArray(coverage?.entries)
        ? coverage.entries
          .filter((e: any) => e.priority === 'must' && !['covered', 'waived'].includes(e.status))
          .map((e: any) => `  - ${e.intentRef} [${e.status}] ${e.desc}`)
        : [];
      const sections = [
        failedDetails.length > 0 ? failedDetails.join('\n') : '',
        missingCoverage > 0
          ? `Verification coverage 不足: ${coverage.covered}/${coverage.total} covered, ${missingCoverage} required missing\n${coverageLines.join('\n')}`
          : '',
        parsed.summary ? `Summary: ${parsed.summary}` : '',
      ].filter(Boolean);
      throw new Error(
        `Cannot enter TEST: lattice validate did not pass` +
        (failedDetails.length > 0 ? `（${failedDetails.length} 项命令失败）` : '') +
        (missingCoverage > 0 ? `（verification coverage 缺 ${missingCoverage} 项）` : '') +
        '\n' +
        sections.join('\n') +
        '\n\n→ 修复后重跑 lattice validate，再 story_advance --phase=TEST'
      );
    }
    ctx.log?.('validate PASS, writing test-evidence.json');
  } catch (e: any) {
    if (e.message?.includes('Cannot enter TEST')) throw e;
    const message = e instanceof Error ? e.message : String(e);
    try {
      store.writeTestEvidence(storyId, {
        command: validateCommand,
        output: `validate execution error: ${message}`,
        result: 'FAIL',
        timestamp: new Date().toISOString(),
      });
    } catch (persistError) {
      reportHealthIssue('persist:testEvidence', persistError as Error, {
        storyId,
        phase: 'TEST',
        gate: 'validate-execution-error',
      });
    }
    throw new Error(
      `Cannot enter TEST: lattice validate execution error\n` +
      `${message}\n\n` +
      `→ 修复 validate runner 后重跑 lattice validate --story=${storyId} --json\n` +
      `→ 然后重跑 lattice story_advance --phase=TEST`,
    );
  }
}

/**
 * TEST→DONE done-oracle gate adapter.
 *
 * 构建并渲染 DONE Final Checklist（consumes core/done-oracle.ts —
 * buildDoneChecklist + renderDoneChecklist）。无论 advance 成功失败都会输出
 * 这份 checklist，强制主 agent 读一遍多层验证状态。
 *
 * On gate failure this throws; on success it returns the rendered checklist
 * string. B-9027 (Story 3b): runDonePreMergeGate in done-effects.ts wraps this
 * call and returns the rendered checklist as an explicit value; the
 * orchestrator holds it in a local variable and passes it to
 * applyDoneMergeEffects for the downstream DONE merge block — no global stash.
 *
 * B-6974: this gate NO LONGER stops the actor on failure — actor lifecycle is
 * owned solely by transition-orchestrator.ts, which stops it in a single
 * finally on every exit path (including the thrown-error path here). The
 * `actor` parameter is kept for signature stability but is no longer used.
 */
export function runDoneOracleGate(
  storyId: string,
  store: StoryStore,
  root: string,
  _actor: { stop(): void },
  // B-6666 CHK-001: the resolved git cwd (wrapper-root aware), threaded from
  // runDonePreMergeGate. `root` (metadataRoot) still drives store/config reads;
  // only the DONE-oracle git probes use gitCwd. Defaults to root for callers
  // that have not resolved a gitCwd (plain repos / read-only projections) so
  // behavior is byte-identical.
  gitCwd: string = root,
): string {
  const checkRows: DoneCheckRow[] = buildDoneChecklist(storyId, store, root, { gitCwd });
  const rendered = renderDoneChecklist(storyId, checkRows);
  const failed = checkRows.filter(r => r.status === 'fail');

  if (failed.length > 0) {
    const hints = failed.flatMap(r => r.hint ? [r.hint] : []);
    throw new Error(
      rendered + '\n\n' +
      `Cannot enter DONE: ${failed.length} 项检查未通过` +
      (hints.length > 0 ? '\n\n修复建议:\n' + hints.map(h => `→ ${h}`).join('\n') : '')
    );
  }

  return rendered;
}
