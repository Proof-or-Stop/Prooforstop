import { rethrowIntentAmendmentIntegrityError } from '../core/verification-intent-amendment.js';
/**
 * B-56d3 (Lifecycle Phase 2, Story 3a): phase-gates — transition gate runner.
 *
 * The transition gate logic was mechanically relocated here from
 * handlers/story-advance.ts with ZERO semantic change — gate decisions,
 * fail-closed semantics and error wording are preserved across the move
 * (preMortem #1). The verifier owns canonical validation-evidence persistence.
 *
 * What lives here:
 *   - runReviewToTestPreflightGate  — REVIEW→TEST CLI preflight orchestration
 *                                     (logging / fail-closed catch / error
 *                                     shaping around handlers/review-preflight)
 *   - runValidateGate               — the proof-or-stop validate --json gate
 *                                     (consumes verifier-owned evidence)
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
import type { ChecklistData, RedEvidenceData, StoryPhase, ReviewLoopIteration, ScopeCheckResult, ScopeViolation, ProofStoryGateMode } from '../core/types.js';
import {
  describeRedEvidenceReadFailure,
  redEvidenceRepairGuidance,
  renderRedEvidenceQuarantineNotice,
} from '../core/red-evidence-artifact-validation.js';
import { listActiveLoops, deriveLatestLoopRecord } from '../core/review-loop.js';
import { getStateName, getGuardFailureReason } from '../core/machine.js';
import { resolveLocalCodexVerifyCommand } from '../core/codex-adapter-checks.js';
import { tryCaptureEvidenceHashSnapshot } from '../core/evidence-freshness.js';
import { loadConfig } from '../core/config.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { currentMilestoneStatusEvidenceBinding } from '../core/milestone-status.js';
import {
  buildDoneChecklist,
  renderDoneChecklist,
  type DoneCheckRow,
} from '../core/done-oracle.js';
import {
  runScopeGateAndDiffPack,
  emitSemanticDegradationEvent,
} from './scope-contract.js';
import { buildScopeDiffPack } from '../core/scope-diff-pack.js';
import { renderScopeCheckResult } from '../core/scope-contract.js';
import {
  evaluateDoneIntentEquivalence,
  evaluateReviewCompleteness,
  type ProofStoryDiagnosticInput,
} from '../core/proofstory.js';
import { readTrustedProofStoryScopeArtifacts } from '../core/closeout-trust.js';
import { tryBuildMaterialClassificationSnapshotForDiagnostics } from '../core/material-code-policy.js';
import type { ValidationEvidenceAdmissibility } from '../core/validation-evidence-admissibility.js';
import { assessStoredValidationPassAdmissibility, dynamicValidationCoverageAdmission } from './validation-pass-admissibility.js';
export { assessStoredValidationPassAdmissibility } from './validation-pass-admissibility.js';
import { assertTestAdmissibleRoutineValidationWindow } from './verifier.js';
import { PRE_CERT_ROUTINE_PASS_REQUIRED } from '../core/certification-window.js';

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

function currentProofStoryEvidenceBinding(store: StoryStore, storyId: string, root?: string): ProofStoryDiagnosticInput['currentEvidenceBinding'] {
  if (!root) return undefined;
  try {
    const gitCwd = resolveGitCwd({ store, storyId, metadataRoot: root, projectRoot: root });
    return currentMilestoneStatusEvidenceBinding(gitCwd, root);
  } catch {
    // Freshness detection is a diagnostic; a resolution failure must never break
    // the read-path gate. Absent binding => base coverage semantics only.
    return undefined;
  }
}

/**
 * B-956f FIX G: production materialClassification for the gate diagnostic
 * input. Resolution failures yield undefined — the field is DIAGNOSTIC and a
 * broken policy/config surfaces through the fail-closed resolve/floor/repro
 * consumers, never by breaking a phase gate.
 */
function proofStoryMaterialClassification(store: StoryStore, storyId: string, root?: string) {
  if (!root) return undefined;
  let gitCwd: string | undefined;
  try {
    gitCwd = resolveGitCwd({ store, storyId, metadataRoot: root, projectRoot: root });
  } catch {
    gitCwd = undefined;
  }
  return tryBuildMaterialClassificationSnapshotForDiagnostics(root, gitCwd);
}

/**
 * B-2aa7 CHK-006. The REVIEW and DONE gates run their whole body inside this, so
 * an unreadable artifact surfaces as a gate-shaped failure naming the corruption
 * and the repair path, rather than as a bare read-boundary throw.
 *
 * Wrapping happens HERE, at the terminal operator-facing site, and deliberately
 * NOT inside `proofStoryDiagnosticInput`: that builder is shared, and the typed
 * `RedEvidenceArtifactError` / `RedEvidenceSchemaError` classes escaping it are
 * load-bearing for other consumers (`red-b2aa7-artifact-validation.mjs`'s
 * exclusion guard asserts B-506e's class by name through exactly that path). A
 * shared builder must not launder a typed error into a plain one.
 *
 * Anything that is not an artifact fault is rethrown untouched — a blanket catch
 * here is what produced the §4 `story_review` degradation in the first place.
 */
function withRedEvidenceCorruptionContext<T>(storyId: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    const corruption = describeRedEvidenceReadFailure(e);
    if (corruption === null) throw e;
    throw new Error(
      `ProofStory gate evidence cannot be read for ${storyId}: its red-evidence artifact is corrupt, which is NOT the `
        + `same as an absent one — the gate has no evidence to evaluate.\n${corruption}\n${redEvidenceRepairGuidance(storyId)}`,
    );
  }
}

/**
 * B-2aa7 CHK-006. The QUARANTINED case never throws: `records` reaches the gate
 * clean, so the report says `missing_red_evidence` — the wording for an ABSENT
 * artifact. This banner is prepended to the gate's own rendering so corruption
 * stays distinguishable from absence. It DECORATES the rendering only and never
 * changes `blocking`, so no gate verdict moves because of it.
 */
function redEvidenceCorruptionBanner(storyId: string, input: ProofStoryDiagnosticInput): string {
  const corruption = renderRedEvidenceQuarantineNotice(storyId, input.redEvidence);
  return corruption === null ? '' : `${corruption}\n${redEvidenceRepairGuidance(storyId)}\n\n`;
}

// Exported for the language-neutral-gates smoke (B-956f FIX H): the smoke
// drives THIS production builder and asserts materialClassification arrives.
export function proofStoryDiagnosticInput(store: StoryStore, storyId: string, root?: string): ProofStoryDiagnosticInput {
  let checklist: ChecklistData;
  try {
    checklist = store.readChecklist(storyId);
  } catch (error) {
    rethrowIntentAmendmentIntegrityError(error);
    checklist = { items: [] };
  }
  const trusted = readTrustedProofStoryScopeArtifacts(store, storyId);
  return {
    story: store.readStory(storyId),
    checklist,
    originalIntentSnapshot: store.readOriginalIntentSnapshot(storyId),
    milestoneLedger: trusted.ledger,
    slicePlan: trusted.slicePlan,
    parentLedgerRollup: trusted.parentRollup,
    proofStoryContract: store.readProofStoryContract(storyId),
    intentCollision: store.readIntentCollision(storyId),
    scopeContract: store.readScopeContract(storyId),
    scopeShrinkageDecision: store.readScopeShrinkageDecision(storyId),
    // B-2aa7 CHK-006: the typed read-boundary error propagates from here
    // UNCHANGED. Callers add operator context via
    // `withRedEvidenceCorruptionContext`; laundering the class in this shared
    // builder would break every consumer that discriminates on it.
    redEvidence: store.readRedEvidence(storyId),
    spikeEvidence: store.readProofStorySpikes(storyId),
    summary: store.readSummary(storyId),
    currentEvidenceBinding: currentProofStoryEvidenceBinding(store, storyId, root),
    materialClassification: proofStoryMaterialClassification(store, storyId, root),
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

// B-f7b3 (F-001/F-003): exported so the reconciliation smoke can pin the config
// default to 'observe' against the REAL resolver (not a re-implemented `?? 'observe'`
// in the test). Flipping the fallback below to `?? 'enforce'` MUST fail that smoke —
// see packages/main/src/tasks/milestone-done-gate-reconciliation-smoke.ts.
export function configuredProofStoryMode(ctx: HandlerContext, key: 'reviewGateMode' | 'doneGateMode'): ProofStoryGateMode {
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
        : ' hint=remove change or use acceptance_amendment_propose in DEV for independent approval';
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
    const proofStoryInput = withRedEvidenceCorruptionContext(storyId, () => proofStoryDiagnosticInput(store, storyId, ctx.root));
    const proofStoryReport = evaluateReviewCompleteness(proofStoryInput, proofStoryMode);
    const renderedProofStory = redEvidenceCorruptionBanner(storyId, proofStoryInput) + renderProofStoryRows(
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
        `\n\n→ 修复上述 gate 后重跑 proof-or-stop story_advance --phase=TEST\n` +
        `→ 单独复跑: proof-or-stop validate --channel --story=${storyId} / --concept / --lint；docs-drift 随 preflight 执行；Codex adapter 用 ${codexVerifyCmd}`,
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
      `→ 修复 review-preflight gate 后重跑 proof-or-stop story_advance --phase=TEST\n` +
      `→ 单独复跑: proof-or-stop validate --channel --story=${storyId} / --concept / --lint；docs-drift 随 preflight 执行；Codex adapter 用 ${codexVerifyCmd}`,
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
    const gitCwd = resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });
    // B-956f FIX 6: compute the full diff pack (git diff + TS AST parsing) ONCE
    // and share it between the scope gate and the degradation-event emission —
    // previously it was built twice per transition when a scope contract existed.
    const scopeGate = runScopeGateAndDiffPack(storyId, ctx.store, ctx.root, gitCwd);
    result = scopeGate.result;
    // B-956f: emit the language-neutral semantic-degradation event regardless of
    // whether a scope contract exists. The no-contract early return in
    // runScopeGate must NOT bypass diagnostics, so a pure-.go/.rs/.py story still
    // surfaces exactly one deduped semantic_analysis_unavailable event during the
    // mutating transition validation. Best-effort: never blocks the transition.
    try {
      // Reuse the contract path's pack; only the no-contract path (no pack) builds one.
      const diffPack = scopeGate.diffPack ?? buildScopeDiffPack(ctx.root, undefined, gitCwd);
      emitSemanticDegradationEvent(ctx.store, storyId, diffPack);
    } catch { /* degradation diagnostics are advisory; never block the transition */ }
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
    try { checklist = ctx.store.readChecklist(storyId); } catch (error) { rethrowIntentAmendmentIntegrityError(error); /* missing checklist → legacy */ }
    if (checklistHasFileDeclarations(checklist)) {
      // New-scope story: BLOCK — file declarations require an explicit contract.
      throw new Error(
        `Cannot enter ${phase}: scope-contract.json missing for a new-scope story [missing_scope_contract]\n\n` +
        `Story ${storyId} declares file scopes in its checklist but has no scope contract.\n` +
        `→ Run: proof-or-stop scope_contract_init_from_plan '{"storyId":"${storyId}"}'\n` +
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
      `\n\n→ 修复 out-of-scope diff，或回到 DEV 用 acceptance_amendment_propose 提交必要扩展并取得独立批准后重跑 story_advance --phase=${phase}`,
    );
  }
  // CHK-004 B-a30e: advisory warning copy — name recovery path depending on phase.
  if (result.status === 'warn') {
    const recoveryHint = (phase === 'TEST' || phase === 'DONE')
      ? `→ Scope warnings (advisory, not blocking) — roll back to DEV to propose necessary expansion via acceptance_amendment_propose, or revert the change.`
      : `→ Scope warnings (advisory, not blocking) — use acceptance_amendment_propose in DEV if the expansion is intentional, or revert the change.`;
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
  try { checklist = ctx.store.readChecklist(storyId); } catch (error) { rethrowIntentAmendmentIntegrityError(error); return ''; }
  if (!checklistHasFileDeclarations(checklist)) return '';

  // Contract already exists — no advisory needed.
  try {
    const contract = ctx.store.readScopeContract(storyId);
    if (contract !== null) return '';
  } catch { /* corrupt contract → still show advisory; REVIEW will fail-closed */ }

  return (
    `\n\n⚠ Scope contract: not initialized — this story declares file scopes in its checklist.\n` +
    `   Run before REVIEW: proof-or-stop scope_contract_init_from_plan '{"storyId":"${storyId}"}'\n` +
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
  const input = withRedEvidenceCorruptionContext(storyId, () => proofStoryDiagnosticInput(ctx.store, storyId, ctx.root));
  const report = evaluateDoneIntentEquivalence(input, mode);
  const rendered = redEvidenceCorruptionBanner(storyId, input) + renderProofStoryRows(
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

function renderPhaseGateAdmissibilityReasons(result: ValidationEvidenceAdmissibility, validateCommand: string): string {
  const rendered = result.reasonCodes.map((code, index) => {
    const detail = result.reasons[index] ?? code;
    switch (code) {
      case 'evidence_missing':
      case 'result_not_pass': return '';
      case 'command_mismatch': return `existing validation PASS command is not ${validateCommand}`;
      case 'output_invalid_json': return 'existing validation PASS output is not valid JSON';
      case 'output_not_all_pass': return 'existing validation PASS output is not allPass/allPassed=true';
      case 'coverage_missing': return 'existing validation PASS is missing verificationCoverage from proof-or-stop validate';
      case 'coverage_missing_required': return 'existing validation PASS verificationCoverage is missing missingRequired';
      case 'coverage_gap': return `existing validation PASS has ${result.evidence?.verificationCoverage?.missingRequired ?? '?'} required verification coverage gap(s)`;
      case 'coverage_entries_missing': return 'existing validation PASS verificationCoverage has no entries snapshot';
      case 'coverage_stale': return 'existing validation PASS verificationCoverage does not match current checklist verificationIntent inputs or current verificationEvidence records';
      case 'freshness_bindings_missing': return 'existing validation PASS is missing headHash/materialHash freshness bindings';
      case 'blocking_dirty': return detail;
      default: return `existing validation PASS is stale (${detail})`;
    }
  }).filter(Boolean);
  return [...new Set(rendered)].join('; ');
}

/**
 * REVIEW→TEST routine validation evidence gate.
 *
 * This gate consumes a current signed PASS produced by the one unscoped
 * story-scoped routine suite in REVIEW. It deliberately has no verifier
 * dependency or execution fallback: allowing TEST entry to call validate
 * would create a second routine-suite authority after PRE_CERT admission.
 *
 * Missing, stale, malformed, or non-PASS evidence therefore fails closed
 * before any validation child can be discovered or spawned. Recovery returns
 * to DEV, then re-establishes the REVIEW PRE_CERT workflow and its sole
 * unscoped `proof-or-stop validate --story=<id> --json` execution.
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
  const validateCommand = `proof-or-stop validate --story=${storyId} --json`;
  // Guard before consulting reusable evidence: a terminal/missing PRE_CERT
  // window cannot be bypassed by an otherwise current PASS.
  assertTestAdmissibleRoutineValidationWindow(ctx, storyId);
  const admissibility = assessStoredValidationPassAdmissibility(ctx, storyId, { allowDynamicCoverage: true });
  if (admissibility.ok) {
    ctx.log?.(`REVIEW→TEST gate: existing validation PASS is fresh; TEST reuses it without rerunning proof-or-stop validate (admissible lineage=${admissibility.lineage}).`);
    return;
  }
  const refusalReason = renderPhaseGateAdmissibilityReasons(admissibility, validateCommand)
    || 'the current signed REVIEW routine PASS is missing';
  ctx.log?.(`REVIEW→TEST gate: ${refusalReason}; refusing to execute a second routine suite.`);
  throw new Error(
    `[${PRE_CERT_ROUTINE_PASS_REQUIRED}] Cannot enter TEST: ${refusalReason}.\n` +
    'TEST never invokes proof-or-stop validate or starts configured validation children.\n\n' +
    `→ Return to DEV: proof-or-stop story_advance --storyId=${storyId} --phase=DEV\n` +
    '→ Re-enter REVIEW, complete the signed inventory and PRE_CERT window, then run the sole routine suite:\n' +
    `  ${validateCommand}`,
  );
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
  const storedEvidence = store.readTestEvidence(storyId);
  if (storedEvidence?.result === 'PASS') {
    try {
      const output = JSON.parse(storedEvidence.output);
      if (dynamicValidationCoverageAdmission(output, true).dynamicOrigin) {
        const admissibility = assessStoredValidationPassAdmissibility(
          { root, store } as HandlerContext,
          storyId,
          { allowDynamicCoverage: true },
        );
        if (!admissibility.ok) {
          throw new Error(
            'Cannot enter DONE: stored dynamic routine PASS is not admissible: '
            + admissibility.reasons.join('; ')
            + `. Re-run proof-or-stop validate --story=${storyId} --full --json for canonical recovery.`,
          );
        }
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        // Legacy non-JSON PASS evidence remains governed by buildDoneChecklist.
      } else {
        throw error;
      }
    }
  }
  const evidenceHashSnapshot = tryCaptureEvidenceHashSnapshot({ gitCwd, metadataRoot: root, ref: 'HEAD' });
  const checkRows: DoneCheckRow[] = buildDoneChecklist(storyId, store, root, { gitCwd, evidenceHashSnapshot });
  const rendered = renderDoneChecklist(storyId, checkRows);
  const failed = checkRows.filter(r => r.status === 'fail');

  if (failed.length > 0) {
    const hints = failed.flatMap(r => r.hint ? [r.hint] : []);
    // B-83aa CHK-003 (DISCLOSED): use the row produced by buildDoneChecklist as
    // the sole resolved snapshot classification. The builder may deliberately
    // recapture a caller-supplied partial/stale snapshot, so independently
    // classifying the original argument could contradict the rendered rows.
    const bindingRow = checkRows.find(r => r.id === 'evidence-hash-snapshot');
    const bindingLine = bindingRow
      ? `\n\nEvidence hash snapshot binding (${bindingRow.status === 'fail' ? 'fail closed' : 'disclosed'}): ${bindingRow.detail}`
      : '';
    throw new Error(
      rendered + '\n\n' +
      `Cannot enter DONE: ${failed.length} 项检查未通过` +
      bindingLine +
      (hints.length > 0 ? '\n\n修复建议:\n' + hints.map(h => `→ ${h}`).join('\n') : '')
    );
  }

  return rendered;
}
