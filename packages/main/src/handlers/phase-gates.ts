/**
 * B-56d3 (Lifecycle Phase 2, Story 3a): phase-gates — transition gate runner.
 *
 * The transition gate logic was mechanically relocated here from
 * handlers/story-advance.ts with ZERO semantic change — gate decisions,
 * fail-closed semantics, error wording, and the koala validate test-evidence
 * write timing are byte-identical before and after the move (preMortem #1).
 *
 * What lives here:
 *   - runReviewToTestPreflightGate  — REVIEW→TEST CLI preflight orchestration
 *                                     (logging / fail-closed catch / error
 *                                     shaping around handlers/review-preflight)
 *   - runValidateGate               — the koala validate --json gate (writes
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
import type { StoryPhase } from '../core/types.js';
import { getStateName, getGuardFailureReason } from '../core/machine.js';
import { resolveLocalCodexVerifyCommand } from '../core/codex-adapter-checks.js';
import { currentMaterialHash } from '../core/evidence-freshness.js';
import { reportHealthIssue } from '../core/health.js';
import { execSync } from 'child_process';
import {
  buildDoneChecklist,
  renderDoneChecklist,
  type DoneCheckRow,
} from '../core/done-oracle.js';
import {
  runScopeGate,
} from './scope-contract.js';
import { renderScopeCheckResult } from '../core/scope-contract.js';

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
        `Cannot enter TEST: CLI gate preflight 失败 (${failedGates})\n\n` +
        rendered +
        `\n\n→ 修复上述 gate 后重跑 koala story_advance --phase=TEST\n` +
        `→ 单独复跑: koala validate --channel --story=${storyId} / --concept / --lint；docs-drift 随 preflight 执行；Codex adapter 用 ${codexVerifyCmd}`,
      );
    }
    ctx.log?.('CLI gate preflight: all pass');
  } catch (e: any) {
    if (e?.message?.startsWith('Cannot enter TEST')) throw e;
    // 预检查本身失败（review-preflight.ts import 失败等）→ fail-closed
    const message = e instanceof Error ? e.message : String(e);
    const codexVerifyCmd = resolveLocalCodexVerifyCommand(ctx.root);
    throw new Error(
      `Cannot enter TEST: CLI gate preflight 执行异常\n` +
      `${message}\n\n` +
      `→ 修复 review-preflight gate 后重跑 koala story_advance --phase=TEST\n` +
      `→ 单独复跑: koala validate --channel --story=${storyId} / --concept / --lint；docs-drift 随 preflight 执行；Codex adapter 用 ${codexVerifyCmd}`,
    );
  }
}

/**
 * Scope contract gate for transitions that freeze, verify, or complete work.
 *
 * Missing contract remains backward-compatible. When a contract exists:
 * - enforce + fail blocks the transition.
 * - shadow/local warnings are rendered but do not block.
 * - pass is rendered so users can see the scope check ran.
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
  if (!result) return '';
  const rendered = renderScopeCheckResult(result);
  if (result.status === 'fail') {
    throw new Error(
      `Cannot enter ${phase}: ${result.summary}\n\n` +
      rendered +
      `\n\n→ 修复 out-of-scope diff，或用 scope_contract_acknowledge 记录必要扩展后重跑 story_advance --phase=${phase}`,
    );
  }
  // CHK-004 B-a30e: advisory warning copy — name recovery path depending on phase.
  if (result.status === 'warn') {
    const recoveryHint = (phase === 'TEST' || phase === 'DONE')
      ? `→ Scope warnings (advisory, not blocking) — roll back to DEV to acknowledge via scope_contract_acknowledge, or verify via delivery reviewer.`
      : `→ Scope warnings (advisory, not blocking) — acknowledge via scope_contract_acknowledge if the expansion is intentional, then proceed.`;
    return `\n\n${rendered}\n\n${recoveryHint}`;
  }
  return `\n\n${rendered}`;
}

/**
 * DEV→TEST koala validate gate.
 *
 * 自动调 koala validate，写 test-evidence.json。
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
  ctx.log?.('DEV→TEST gate: running koala validate --json...');
  try {
    const { createVerifierHandlers } = await import('./verifier.js');
    const verifierHandlers = createVerifierHandlers(ctx);
    const jsonResult = await verifierHandlers.validate({ json: true, story: storyId });
    const parsed = JSON.parse(String(jsonResult));

    // 写入 test-evidence.json（DONE gate 消费）
    // B-c622 CHK-009: 记录 headHash 供 DONE gate evidence freshness 检查
    let evidenceHeadHash = '';
    try {
      evidenceHeadHash = execSync('git rev-parse HEAD', { cwd: ctx.root, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch { /* 无法获取 HEAD，跳过 */ }
    const evidenceMaterialHash = currentMaterialHash(ctx.root);
    store.writeTestEvidence(storyId, {
      command: `koala validate --story=${storyId} --json`,
      output: String(jsonResult),
      result: parsed.allPass ? 'PASS' : 'FAIL',
      timestamp: new Date().toISOString(),
      ...(evidenceHeadHash ? { headHash: evidenceHeadHash } : {}),
      ...(evidenceMaterialHash ? { materialHash: evidenceMaterialHash } : {}),
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
        `Cannot enter TEST: koala validate 未通过` +
        (failedDetails.length > 0 ? `（${failedDetails.length} 项命令失败）` : '') +
        (missingCoverage > 0 ? `（verification coverage 缺 ${missingCoverage} 项）` : '') +
        '\n' +
        sections.join('\n') +
        '\n\n→ 修复后重跑 koala validate，再 story_advance --phase=TEST'
      );
    }
    ctx.log?.('validate PASS, writing test-evidence.json');
  } catch (e: any) {
    if (e.message?.includes('Cannot enter TEST')) throw e;
    const message = e instanceof Error ? e.message : String(e);
    try {
      store.writeTestEvidence(storyId, {
        command: `koala validate --story=${storyId} --json`,
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
      `Cannot enter TEST: koala validate 执行异常\n` +
      `${message}\n\n` +
      `→ 修复 validate runner 后重跑 koala validate --story=${storyId} --json\n` +
      `→ 然后重跑 koala story_advance --phase=TEST`,
    );
  }
}

/**
 * TEST→DONE done-oracle gate adapter.
 *
 * 构建并渲染 DONE Final Checklist（consumes core/done-oracle.ts —
 * buildDoneChecklist + renderDoneChecklist）。无论 advance 成功失败都会输出
 * 这份 checklist，强制主 agent 读一遍多层验证状态。对应 OMX ralph 的
 * <Final_Checklist>。
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
): string {
  const checkRows: DoneCheckRow[] = buildDoneChecklist(storyId, store, root);
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
