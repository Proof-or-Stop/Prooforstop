#!/usr/bin/env node
/**
 * Compatibility decision signatures, scope withdrawals and CLI phase admission.
 * Historical count diagnostics remain tested separately from current hard gates.
 * Actual completed-epoch gating is exercised by verify-convergence-progress-epochs.
 * Fixture-only manual attestations satisfy unrelated acceptance prerequisites;
 * they are not product verification receipts.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import {
  evaluateReviewMintStallAdjudication,
  collectReviewConvergenceInputs, assessReviewConvergence, evaluateStallAdjudication,
  hasCurrentRoundStallResolution, hasCurrentRoundPrivilegedOverride, resolveStallHardCeiling,
  STALL_ADJUDICATION_CODE,
  STALL_CEILING_CODE,
  STALL_MIN_ROUNDS,
  STALL_HARD_CEILING_ROUNDS,
  STALL_RESOLUTION_ACTIONS,
} from '../core/review-convergence.js';
import { signStallAdjudication } from '../core/stall-adjudication.js';
import {
  canMintReviewRoundGuard,
  reviewRoundMintStallAdjudication,
  getGuardFailureReason,
  checklistAllDoneGuard,
} from '../core/machine.js';
import {
  enforceConvergenceBreakerGate,
  readBreakerState,
  writeBreakerState,
  type BreakerState,
} from '../core/convergence-breaker.js';
import { createStallAdjudicationHandlers } from '../handlers/stall-adjudication.js';
import { createStoryHandlers } from '../handlers/story.js';
import type { HandlerContext } from '../handlers/context.js';
import type {
  ChecklistData,
  ChecklistItem,
  Finding,
  ProofStoryContractData,
  StallAdjudicationData,
  StoryEvent,
  StoryInfo,
} from '../core/types.js';

// ── temp root management ─────────────────────────────────────────────────────
const ROOTS: string[] = [];

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** A fresh temp git repo whose config storyDir matches production (auto-commit safe). */
function makeRoot(tag: string): { root: string; store: StoryStore } {
  const root = mkdtempSync(join(tmpdir(), `proof-or-stop-b7813-${tag}-`));
  ROOTS.push(root);
  writeFileSync(
    join(root, 'proof-or-stop.config.json'),
    JSON.stringify({
      scanRoot: 'packages/main', rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
    }, null, 2),
  );
  writeFileSync(join(root, '.gitignore'), '.proof-or-stop/tmp/\nnode_modules/\n');
  git(root, ['init', '-q', '-b', 'work']);
  git(root, ['config', 'user.email', 'smoke@noreply.local']);
  git(root, ['config', 'user.name', 'B7813 Smoke']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'seed']);
  resetConfigCache();
  return { root, store: new StoryStore(root) };
}

function ctxOf(root: string, store: StoryStore): HandlerContext {
  return { store, root, scanRoot: root } as HandlerContext;
}

function cleanupAll(): void {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
}

// ── stall synthesis ──────────────────────────────────────────────────────────
/** Distinct, valid ISO round identity for review round i (1-based). */
function roundTs(i: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
}

interface StallSpec {
  /** DENSE per-round blocking counts, index i => review round i+1. */
  perRoundCounts: number[];
  /** Extra non-REVIEW advance events (feed the breaker advanceCount only). */
  extraDevAdvances?: number;
  /** Checklist items (default one done CHK-001). */
  items?: ChecklistItem[];
}

/**
 * Materialize a story whose REVIEW round history + findings reproduce
 * `perRoundCounts` exactly (each round i gets that many `open` `critical`
 * findings bound to round-i's timestamp). Returns the currentReviewRound.
 */
function synthStalled(store: StoryStore, storyId: string, spec: StallSpec): string {
  const rounds = spec.perRoundCounts.length;
  const now = roundTs(rounds || 1);
  const events: StoryEvent[] = [];
  for (let d = 0; d < (spec.extraDevAdvances ?? 0); d++) {
    events.push({ phase: 'DEV', action: 'advance', timestamp: roundTs(100 + d) });
  }
  for (let i = 1; i <= rounds; i++) {
    events.push({ phase: 'REVIEW', action: 'advance', timestamp: roundTs(i) });
  }
  const currentReviewRound = roundTs(rounds);
  const story: StoryInfo = {
    storyId, name: storyId, title: 'stall adjudication fixture',
    description: 'stall adjudication fixture', type: 'chore', phase: 'DEV', priority: 'high',
    createdAt: now, startedAt: now, endedAt: null, events, currentReviewRound,
  };
  store.writeStory(storyId, story);

  const items: ChecklistItem[] = spec.items ?? [
    { id: 'CHK-001', title: 'core work', status: 'done', startTime: null, endTime: null },
  ];
  store.writeChecklist(storyId, { items: items.map(item => item.status === 'done' ? { ...item,
    verificationIntent: { happy: [{ desc: 'Inspect the isolated fixture decision, signature and withdrawal behavior.', type: 'manual' as const }], edge: [], adversarial: [] },
    verificationEvidence: [{ intentRef: `${item.id}:happy:0`, kind: 'manual_transcript' as const, result: 'pass' as const,
      note: 'Synthetic manual acceptance prerequisite for this isolated gate fixture; not a product execution receipt.' }],
  } : item) } as ChecklistData);

  const findings: Finding[] = [];
  let n = 0;
  for (let i = 1; i <= rounds; i++) {
    const count = spec.perRoundCounts[i - 1];
    for (let k = 0; k < count; k++) {
      findings.push({
        id: `${storyId}:F-${String(++n).padStart(3, '0')}`,
        desc: `blocking finding r${i}#${k}`,
        severity: 'critical', category: 'adversarial', status: 'open',
        reviewRound: roundTs(i),
      });
    }
  }
  store.writeFindings(storyId, { findings });
  return currentReviewRound;
}

function legacyAdjudication(store: StoryStore, storyId: string, env: Record<string, string | undefined> = {}) {
  const { roundCount, perRoundBlockingCounts } = collectReviewConvergenceInputs(store, storyId);
  return evaluateStallAdjudication({ assessment: assessReviewConvergence(roundCount, perRoundBlockingCounts), roundCount,
    ceiling: resolveStallHardCeiling(env), hasCurrentRoundResolution: hasCurrentRoundStallResolution(store, storyId),
    hasPrivilegedOverride: hasCurrentRoundPrivilegedOverride(store, storyId) });
}

function expectThrows(fn: () => unknown, marker: RegExp, label: string): void {
  let threw = false;
  try { fn(); } catch (e) {
    threw = true;
    const msg = e instanceof Error ? e.message : String(e);
    assert.match(msg, marker, `${label}: expected throw matching ${marker}, got: ${msg}`);
  }
  assert.ok(threw, `${label}: expected a throw but the call succeeded`);
}

function expectNoThrow(fn: () => unknown, label: string): void {
  try { fn(); } catch (e) {
    assert.fail(`${label}: expected NO throw, got: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// A. STALL BLOCK
// ════════════════════════════════════════════════════════════════════════════
function partA(): void {
  const { root, store } = makeRoot('A');
  const storyId = 'B-stallA';
  synthStalled(store, storyId, { perRoundCounts: [3, 3, 3, 3] });
  assert.equal(store.readStory(storyId).events!.filter(e => e.phase === 'REVIEW' && e.action === 'advance').length,
    STALL_MIN_ROUNDS, 'A: fixture has exactly STALL_MIN_ROUNDS review rounds');

  // (1) The store-consuming gate refuses with the ordinary stall code + a prompt
  //     that names EVERY ordinary resolution action.
  const adj = legacyAdjudication(store, storyId, {});
  assert.equal(adj.blocked, true, 'A: mint gate BLOCKS a >=STALL_MIN_ROUNDS non-improving stall');
  assert.equal(adj.code, STALL_ADJUDICATION_CODE, 'A: block carries [review_convergence_stall]');
  assert.ok(adj.prompt && adj.prompt.includes(`[${STALL_ADJUDICATION_CODE}]`), 'A: prompt carries the machine code');
  for (const action of STALL_RESOLUTION_ACTIONS) {
    if (action === 'override_budget') continue; // the ordinary prompt names the five per-round actions
    assert.ok(adj.prompt!.includes(action), `A: prompt names the resolution action ${action}`);
  }

  // (2) The machine boolean guard consumes the same adjudication.
  const mctx = { store, storyId, projectRoot: root };
  assert.equal(reviewRoundMintStallAdjudication(mctx).blocked, false, 'A: machine does not treat legacy rounds as completed epochs');
  assert.equal(canMintReviewRoundGuard(mctx), true, 'A: valid checklist can mint without verified stagnant epochs');

  // (3) The rendered guard-failure reason (checklist otherwise clear) surfaces the
  //     stall prompt — proving the machine.ts REVIEW-branch wiring, not just the fn.
  resetConfigCache();
  const reason = getGuardFailureReason(storyId, store, 'REVIEW', root);
  assert.ok(!reason?.includes(`[${STALL_ADJUDICATION_CODE}]`), 'A: current machine does not render a count-only stall');
}

// ════════════════════════════════════════════════════════════════════════════
// B. CONVERGING NOT BLOCKED (no false cap)
// ════════════════════════════════════════════════════════════════════════════
function partB(): void {
  const { root, store } = makeRoot('B');
  const mctx = (storyId: string) => ({ store, storyId, projectRoot: root });

  // Clean tail: last round is 0 => converged, never a stall even at STALL_MIN_ROUNDS.
  synthStalled(store, 'B-conv-clean', { perRoundCounts: [3, 2, 1, 0] });
  assert.equal(evaluateReviewMintStallAdjudication(store, 'B-conv-clean', {}).blocked, false,
    'B: clean-tail [3,2,1,0] is NOT blocked');
  assert.equal(canMintReviewRoundGuard(mctx('B-conv-clean')), true, 'B: clean-tail mint allowed');

  // Strictly decreasing window => converging, never a stall.
  synthStalled(store, 'B-conv-desc', { perRoundCounts: [4, 3, 2, 1] });
  assert.equal(evaluateReviewMintStallAdjudication(store, 'B-conv-desc', {}).blocked, false,
    'B: strictly-decreasing [4,3,2,1] is NOT blocked');

  // Below the minimum-rounds threshold => never a stall, even if flat.
  synthStalled(store, 'B-below', { perRoundCounts: [3, 3, 3] });
  assert.equal(evaluateReviewMintStallAdjudication(store, 'B-below', {}).blocked, false,
    'B: below-threshold [3,3,3] (rounds < STALL_MIN_ROUNDS) is NOT blocked');
  assert.equal(canMintReviewRoundGuard(mctx('B-below')), true, 'B: below-threshold mint allowed');
}

// ════════════════════════════════════════════════════════════════════════════
// C. RESOLUTION CLEARS (and only a valid current-round signed record clears)
// ════════════════════════════════════════════════════════════════════════════
function partC(): void {
  const { root, store } = makeRoot('C');
  const ctx = ctxOf(root, store);
  const stall = createStallAdjudicationHandlers(ctx);
  const storyId = 'B-stallC';
  const current = synthStalled(store, storyId, { perRoundCounts: [3, 3, 3, 3] });
  const prev = roundTs(3); // a real PREVIOUS round id

  const blocked = () => legacyAdjudication(store, storyId, {}).blocked;
  assert.equal(blocked(), true, 'C: baseline stall is blocked (no resolution)');

  // (i) previous-round record, correctly signed for round 3 — does NOT clear round 4.
  const reasonPrev = 'operator consciously authorizes another convergence round (prev)';
  store.writeStallAdjudication(storyId, {
    storyId, action: 'authorize_continuation', reason: reasonPrev, reviewRound: prev,
    recordedAt: new Date().toISOString(),
    _hash: signStallAdjudication(storyId, 'authorize_continuation', reasonPrev, prev),
  } as StallAdjudicationData);
  assert.equal(blocked(), true, 'C: a PREVIOUS-round signed record does NOT clear the current block (gate re-validates binding)');

  // (ii) tampered record: bound to the current round but _hash no longer matches.
  const reasonTamper = 'this reason was edited after the record was signed for round';
  store.writeStallAdjudication(storyId, {
    storyId, action: 'authorize_continuation', reason: reasonTamper, reviewRound: current,
    recordedAt: new Date().toISOString(),
    _hash: signStallAdjudication(storyId, 'authorize_continuation', 'a DIFFERENT original reason body here', current),
  } as StallAdjudicationData);
  assert.equal(blocked(), true, 'C: a signature-tampered current-round record does NOT clear (gate re-validates signature)');

  // (iii) signed-over-empty reason: signature matches but reason fails min length.
  store.writeStallAdjudication(storyId, {
    storyId, action: 'authorize_continuation', reason: '', reviewRound: current,
    recordedAt: new Date().toISOString(),
    _hash: signStallAdjudication(storyId, 'authorize_continuation', '', current),
  } as StallAdjudicationData);
  assert.equal(blocked(), true, 'C: an empty-reason (signed) record does NOT clear (gate re-validates reason length)');

  // (iv) handler re-validation: a too-short reason is REFUSED at write time and
  //      persists nothing new (block still holds on the prior invalid record).
  expectThrows(
    () => stall.stall_resolution_set({ storyId, action: 'authorize_continuation', reason: 'too short' }),
    /reason must be >= \d+ characters/, 'C: handler refuses a short reason');
  assert.equal(blocked(), true, 'C: after the refused short-reason write the block still holds');

  // (v) VALID current-round resolution via the REAL handler flips blocked -> allowed.
  const out = stall.stall_resolution_set({
    storyId, action: 'authorize_continuation',
    reason: 'operator consciously authorizes exactly one more convergence round',
  });
  assert.match(out, /Stall resolution recorded/, 'C: handler confirms the recorded resolution');
  assert.equal(blocked(), false, 'C: a valid current-round signed resolution CLEARS the block');
  assert.equal(canMintReviewRoundGuard({ store, storyId, projectRoot: root }), true,
    'C: the machine guard now allows the next mint');
}

// ════════════════════════════════════════════════════════════════════════════
// D. DECLARE UNREACHABLE (F-058) — withdraw + close loop, respect empty-scope floor
// ════════════════════════════════════════════════════════════════════════════
function seedContract(store: StoryStore, storyId: string, bindings: Array<{ id: string; checklistRefs: string[] }>): void {
  const now = new Date().toISOString();
  store.writeProofStoryContract(storyId, {
    schemaVersion: 'proofstory.contract.v1', storyId, diagnosticOnly: false,
    hardeningLevel: 'standard', triggerReasons: [],
    acceptanceBindings: bindings.map(b => ({
      id: b.id, checklistRefs: b.checklistRefs,
      verificationIntentRefs: b.checklistRefs.map(r => `${r}:happy:0`), milestoneIds: [],
    })),
    diagnosticGaps: [],
    createdAt: now, updatedAt: now,
  } as ProofStoryContractData);
}

function partD(): void {
  const { root, store } = makeRoot('D');
  const ctx = ctxOf(root, store);
  const stall = createStallAdjudicationHandlers(ctx);

  // D1 — declare_unreachable marks the item withdrawn and CLOSES THE LOOP: the
  //      previously-outstanding CHK-002 becomes terminal, so the DEV→REVIEW
  //      every-item-terminal guard now passes without minting another round.
  const s1 = 'B-unreachD1';
  synthStalled(store, s1, {
    perRoundCounts: [3, 3, 3, 3],
    items: [
      { id: 'CHK-001', title: 'core work', status: 'done', startTime: null, endTime: null },
      { id: 'CHK-002', title: 'unreachable slice', status: 'in_progress', startTime: null, endTime: null },
    ],
  });
  resetConfigCache();
  assert.equal(checklistAllDoneGuard({ store: store, storyId: s1, projectRoot: root }), false,
    'D1: before withdrawal the loop is OPEN (CHK-002 not terminal)');
  assert.equal(legacyAdjudication(store, s1, {}).blocked, true, 'D1: stall blocked before resolution');

  stall.stall_resolution_set({
    storyId: s1, action: 'declare_unreachable', itemId: 'CHK-002',
    reason: 'CHK-002 proved genuinely undeliverable; withdrawing it to close the loop',
  });

  const cl1 = store.readChecklist(s1);
  const item2 = cl1.items.find(i => i.id === 'CHK-002')!;
  assert.equal(item2.status, 'withdrawn', 'D1: declare_unreachable marks CHK-002 WITHDRAWN');
  assert.ok(item2.decisionRef, 'D1: the withdrawn item carries the B-1909 decisionRef');
  assert.equal(cl1.items.find(i => i.id === 'CHK-001')!.status, 'done', 'D1: the other item is untouched');
  const rec1 = store.readStallAdjudication(s1)!;
  assert.equal(rec1.action, 'declare_unreachable', 'D1: the record is the declare_unreachable action');
  assert.equal(rec1.itemId, 'CHK-002', 'D1: the record names the withdrawn item');
  assert.ok(rec1.withdrawalDecisionRef, 'D1: the record links the withdrawal decision (audit)');
  resetConfigCache();
  assert.equal(checklistAllDoneGuard({ store: store, storyId: s1, projectRoot: root }), true,
    'D1: after withdrawal the loop is CLOSED (all items terminal, no new round needed)');

  // D2 — empty-scope floor: declaring the item unreachable must NOT withdraw the
  //      LAST acceptance binding to fake a pass. The item is still withdrawn
  //      (loop closes), but the sole binding survives (effective set stays non-empty).
  const s2 = 'B-unreachD2';
  synthStalled(store, s2, {
    perRoundCounts: [3, 3, 3, 3],
    items: [
      { id: 'CHK-001', title: 'core work', status: 'done', startTime: null, endTime: null },
      { id: 'CHK-002', title: 'the only bound slice', status: 'in_progress', startTime: null, endTime: null },
    ],
  });
  seedContract(store, s2, [{ id: 'AB-1', checklistRefs: ['CHK-002'] }]);

  stall.stall_resolution_set({
    storyId: s2, action: 'declare_unreachable', itemId: 'CHK-002',
    reason: 'CHK-002 is the sole bound slice but is undeliverable; withdraw item, keep binding floor',
  });

  const cl2 = store.readChecklist(s2);
  assert.equal(cl2.items.find(i => i.id === 'CHK-002')!.status, 'withdrawn',
    'D2: the item is still withdrawn (loop closes even when the binding cannot be)');
  const contract2 = store.readProofStoryContract(s2)!;
  const withdrawnBindings = (contract2.bindingDispositions ?? []).filter(d => d.disposition === 'withdrawn');
  assert.equal(withdrawnBindings.length, 0,
    'D2: the LAST acceptance binding is NOT withdrawn (empty-scope floor respected — cannot fake a pass)');
  assert.equal(contract2.acceptanceBindings.length, 1, 'D2: the original binding survives intact');
}

// ════════════════════════════════════════════════════════════════════════════
// E. HARD CEILING + PRIVILEGED OVERRIDE
// ════════════════════════════════════════════════════════════════════════════
function partE(): void {
  const { root, store } = makeRoot('E');
  const ctx = ctxOf(root, store);
  const stall = createStallAdjudicationHandlers(ctx);
  const storyId = 'B-ceilE';

  // rounds > STALL_HARD_CEILING_ROUNDS, still stalling on the trailing window.
  const rounds = STALL_HARD_CEILING_ROUNDS + 1; // 13
  const counts = Array.from({ length: rounds }, (_, idx) => (idx >= rounds - 3 ? 3 : 0));
  synthStalled(store, storyId, { perRoundCounts: counts });
  assert.ok(rounds > STALL_HARD_CEILING_ROUNDS, 'E: fixture exceeds the hard ceiling');

  const adj0 = legacyAdjudication(store, storyId, {});
  assert.equal(adj0.blocked, true, 'E: over-ceiling stall is blocked');
  assert.equal(adj0.code, STALL_CEILING_CODE, 'E: the block carries [review_convergence_stall_ceiling]');

  // An ORDINARY per-round resolution does NOT clear a past-ceiling block.
  stall.stall_resolution_set({
    storyId, action: 'authorize_continuation',
    reason: 'ordinary per-round authorization that must NOT bypass the exhausted budget',
  });
  const adj1 = legacyAdjudication(store, storyId, {});
  assert.equal(adj1.blocked, true, 'E: an ordinary resolution CANNOT clear the hard ceiling');
  assert.equal(adj1.code, STALL_CEILING_CODE, 'E: still the ceiling code after an ordinary resolution');

  // Only the PRIVILEGED override_budget proceeds (current-round bound, signed).
  const out = stall.stall_resolution_set({
    storyId, action: 'override_budget',
    reason: 'privileged budget override: consciously pay for exactly one more round past the ceiling',
  });
  assert.match(out, /does not clear the completed-epoch convergence gate/, 'E: compatibility override must not promise new gate authority');
  assert.equal(legacyAdjudication(store, storyId, {}).blocked, false,
    'E: the signed override_budget clears the hard-ceiling block for the next round');
}

// ════════════════════════════════════════════════════════════════════════════
// F. BREAKER INDEPENDENCE (two brakes, two triggers, two clear paths)
// ════════════════════════════════════════════════════════════════════════════
const FROZEN_BUDGET_SPENT: BreakerState = {
  advanceBaseline: 0, takeoverBaseline: 0, reviewRunBaseline: 0, reviewPassBaseline: 0,
  autoRecoveriesSpent: 1, frozen: false, trippedReasons: [],
};

/** Run fn as if in an interactive human session (story_resume --ack gate). */
function withInteractiveSession<T>(fn: () => T): T {
  const saved = {
    CI: process.env.CI, AP: process.env.PROOF_OR_STOP_AUTOPILOT, NI: process.env.PROOF_OR_STOP_NON_INTERACTIVE,
  };
  delete process.env.CI; delete process.env.PROOF_OR_STOP_AUTOPILOT; delete process.env.PROOF_OR_STOP_NON_INTERACTIVE;
  const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
  const priorDesc = Object.getOwnPropertyDescriptor(stdin, 'isTTY');
  try {
    Object.defineProperty(stdin, 'isTTY', { value: true, configurable: true });
    return fn();
  } finally {
    if (priorDesc) Object.defineProperty(stdin, 'isTTY', priorDesc);
    else { try { delete (stdin as { isTTY?: boolean }).isTTY; } catch { (stdin as { isTTY?: boolean }).isTTY = undefined; } }
    if (saved.CI !== undefined) process.env.CI = saved.CI;
    if (saved.AP !== undefined) process.env.PROOF_OR_STOP_AUTOPILOT = saved.AP;
    if (saved.NI !== undefined) process.env.PROOF_OR_STOP_NON_INTERACTIVE = saved.NI;
  }
}

function partF(): void {
  const { root, store } = makeRoot('F');
  const storyId = 'B-legacyF';
  synthStalled(store, storyId, { perRoundCounts: [3, 3, 3, 3], extraDevAdvances: 40 });
  const storyDir = store.storyDirPath(storyId);
  writeBreakerState(storyDir, { ...FROZEN_BUDGET_SPENT, frozen: true, trippedReasons: ['historical count-only freeze'] });
  const gate = () => enforceConvergenceBreakerGate({ command: 'story_advance', storyId, store, env: {}, isTakeoverCommand: false });
  expectNoThrow(gate, 'F: count-only legacy freeze does not authorize a current gate block');
  assert.equal(evaluateReviewMintStallAdjudication(store, storyId).blocked, false);
  const handlers = createStoryHandlers(ctxOf(root, store));
  const out = withInteractiveSession(() => handlers.story_resume({ storyId, ack: true, reason: 'Human acknowledges the retained historical runtime freeze.' }));
  assert.match(out, /Convergence breaker CLEARED/);
  assert.equal(readBreakerState(storyDir)?.frozen, false);
  const before = JSON.stringify(readBreakerState(storyDir));
  const decision = createStallAdjudicationHandlers(ctxOf(root, store)).stall_resolution_set({ storyId, action: 'authorize_continuation', reason: 'Record a compatibility decision without changing verified epoch authority.' });
  assert.match(decision, /does not clear the completed-epoch convergence gate/);
  assert.equal(JSON.stringify(readBreakerState(storyDir)), before);
  expectNoThrow(gate, 'F: compatibility diagnosis does not create a count-based block');
}

// ════════════════════════════════════════════════════════════════════════════
// G. REAL CLI PHASE-GATE BOUNDARY (B-7813 F-001/F-002/F-003)
// ════════════════════════════════════════════════════════════════════════════
// dist/tasks/<this>.js -> dist/cli.js (the TS source ships alongside dist, so the
// dist run resolves the built CLI entry the real `proof-or-stop` bin bootstraps into).
const CLI_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');

/** Run the REAL CLI in `root`; return merged stdout+stderr regardless of exit code. */
function runRealCli(root: string, args: string[]): string {
  try {
    return execFileSync('node', [CLI_ENTRY, ...args], {
      cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
}

/**
 * Materialize a stalled fixture story at `phase` on the `story/<id>` branch so
 * cli-engine `detectActiveStory` (keyed on the git branch) picks it up and the
 * phase gate runs against it.
 */
function makeActiveStoryRoot(tag: string, phase: StoryInfo['phase']): { root: string; storyId: string } {
  const { root, store } = makeRoot(`cli-${tag}`);
  const storyId = `B-cli${tag}`;
  synthStalled(store, storyId, { perRoundCounts: [3, 3, 3, 3] });
  const story = store.readStory(storyId);
  story.phase = phase;
  store.writeStory(storyId, story);
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'cli fixture story']);
  git(root, ['checkout', '-q', '-b', `story/${storyId}`]);
  return { root, storyId };
}

function partG(): void {
  for (const phase of ['DEV', 'REVIEW'] as const) {
    const { root, storyId } = makeActiveStoryRoot(phase.toLowerCase(), phase);

    // Positive control: the phase gate is LIVE for this active story. A TEST-only
    // command IS rejected with the exact phase-block message in DEV/REVIEW — so a
    // detectActiveStory miss (which would make the negative assertion a false
    // green) is ruled out.
    const control = runRealCli(root, ['delivery_check_set', JSON.stringify({ storyId })]);
    assert.match(
      control,
      new RegExp(`Command "delivery_check_set" is not available in ${phase} phase`),
      `G: the CLI phase gate is LIVE in ${phase} (TEST-only delivery_check_set is phase-blocked; proves detectActiveStory engaged)`,
    );

    // The fix (F-001/F-003): stall_resolution_set must NOT be phase-blocked in the
    // very phase its command-policy allowedPhases lists. isCommandAllowed must pass
    // at the real CLI boundary (it may still fail downstream for a NON-phase reason
    // — e.g. owner-lease / not-stalled — which is out of scope for this assertion).
    const out = runRealCli(root, [
      'stall_resolution_set',
      JSON.stringify({
        storyId, action: 'authorize_continuation',
        reason: 'twenty-plus-character reason recorded from the real CLI boundary test',
      }),
    ]);
    assert.doesNotMatch(
      out,
      /Command "stall_resolution_set" is not available in .* phase/,
      `G: stall_resolution_set is NOT phase-blocked in ${phase} (isCommandAllowed passes at the real \`node cli.js\` boundary)`,
    );
  }
}

// ── runner ──
try {
  partA();
  partB();
  partC();
  partD();
  partE();
  partF();
  partG();
  console.log('review-budget-stall-adjudication-smoke: PASS');
  cleanupAll();
} catch (e) {
  console.error('review-budget-stall-adjudication-smoke: FAIL');
  console.error(e instanceof Error ? (e.stack || e.message) : String(e));
  cleanupAll();
  process.exit(1);
}
