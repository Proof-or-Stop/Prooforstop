#!/usr/bin/env node
/**
 * B-1507 CHK-004 — RED-first / mutation-killing smoke that drives ALL THREE
 * B-1507 behaviors through their REAL entry points (built handlers / CLI / the
 * pure guard logic — never a reimplemented copy):
 *
 *   A. verification_run           (handlers/checklist.ts): executes an intent's
 *      PINNED verifier via enforceAndStampEvidence, writes a receipt
 *      {exitCode:0, selectorMatched:true, mechanical:true} with a receipt-derived
 *      result, and REFUSES on no-pin / exit-nonzero / unresolved intentRef.
 *   B. verification_evidence_refresh_stale (async): RE-EXECUTES a pinned mechanical
 *      row on drift and re-stamps a fresh receipt bound to the NEW materialHash
 *      when it still passes (NOT demoted); leaves the row demoted/non-mechanical
 *      when the pin now fails (no laundering); a pin-LESS row keeps demote-only
 *      behavior (B-3b88 coexistence).
 *   C. verification_pin_guard_check (handlers/evidence-pin-guard.ts + the pure
 *      core): DENIES a mismatched --command (JSON-blob form) and a mismatched
 *      --selector (--k=v form); ALLOWS a matching write / verification_run /
 *      unpinned intent / non-proof-or-stop command; FAIL-OPEN on a nonexistent story or
 *      unparseable input. Adversarial: the enforceAndStampEvidence HANDLER still
 *      refuses the same mismatch when the guard/hook is bypassed (seatbelt is
 *      non-load-bearing).
 *   D. Codex + Claude PreToolUse hook e2e: the host shims spawn the REAL built CLI
 *      and exit 2 on a deny for a synthesized PreToolUse payload. The Claude Bash
 *      matcher is fully asserted. Codex's REAL emitted shell tool_name is NOT
 *      confirmable in this environment (see PENDING-REAL-TOKEN below); the e2e
 *      asserts only that the documented CANDIDATE tokens (shell|local_shell|
 *      exec_command) fire — never a false green that Codex coverage is confirmed.
 *   E. stale-refresh exact-semantics dedupe: identical command/selector/timeout
 *      rows execute once and receive one cloned receipt per intent; selector or
 *      timeout differences remain distinct; one shared failure demotes all rows.
 *
 * RED-first: each core assertion mutation-kills — reverting the corresponding
 * behavior (make refresh demote instead of re-execute; make the guard always-allow;
 * make verification_run mint an unexecuted covered row) makes THIS smoke FAIL.
 *
 * Prints `verification-run-and-guard-smoke: PASS` + exit 0 on success; prints a
 * diagnostic + exit 1 (via a thrown assertion) on any failure.
 */

import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StoryStore } from '../core/store.js';
import { acquireOwnerLease } from '../core/story-owner-lease.js';
import { createChecklistHandlers, refreshStaleEvidenceMetadataOnly } from '../handlers/checklist.js';
import { createEvidencePinGuardHandlers } from '../handlers/evidence-pin-guard.js';
import { buildVerificationCoverage } from '../core/verification.js';
import { currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { resetConfigCache } from '../core/config.js';
import type {
  ChecklistData,
  StoryInfo,
  VerificationExecutionReceipt,
  VerificationIntentItem,
  VerificationIntentType,
} from '../core/types.js';

// ── Repo-anchored asset paths (dist layout: packages/main/dist/tasks/<this>.js) ──
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const REAL_CLI = join(REPO_ROOT, 'packages', 'main', 'dist', 'cli.js');
const CLAUDE_HOOK = join(REPO_ROOT, '.claude', 'hooks', 'proof-or-stop-evidence-pretool.cjs');
const CODEX_HOOK = join(REPO_ROOT, '.codex', 'hooks', 'proof-or-stop-evidence-pretool.cjs');

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

async function expectRejection(promise: Promise<unknown>, marker: RegExp, label: string): Promise<void> {
  let threw = false;
  try {
    await promise;
  } catch (e) {
    threw = true;
    const msg = e instanceof Error ? e.message : String(e);
    assert.match(msg, marker, `${label}: expected rejection matching ${marker}, got: ${msg}`);
  }
  assert.ok(threw, `${label}: expected the operation to be REFUSED but it succeeded`);
}

// ── Fully-controlled pinned commands (allowlisted: leading token `node`). ──
const SELECTOR = 'MARKER_OK';
const PASS_CMD = `node -e "console.log('MARKER_OK')"`;           // always passes, ignores material
const NONZERO_CMD = `node -e "console.log('MARKER_OK'); process.exit(3)"`; // selector present, exit != 0
const DIFFERENT_CMD = `node -e "console.log(1)"`;               // never matches PASS_CMD (guard mismatch)
// Reads flag.txt: passes when it holds MARKER_OK, FAILS (selector absent) when it holds BROKEN.
const READ_FLAG_CMD = `node -e "process.stdout.write(require('fs').readFileSync('flag.txt','utf8'))"`;

interface Env {
  root: string;
  store: StoryStore;
  handlers: ReturnType<typeof createChecklistHandlers>;
  guard: ReturnType<typeof createEvidencePinGuardHandlers>;
  storyId: string;
}

/** Build an isolated temp git repo + story + single checklist item carrying `intents`. */
function makeEnv(storyId: string, intents: VerificationIntentItem[]): Env {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-b1507-'));
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
  }, null, 2));
  // Causal execution keys require a resolved tool version. npm runs this smoke
  // with packages/main as process.cwd(), so seed the minimal manifest that the
  // resolver expects in an isolated fixture repo.
  write(root, 'packages/main/package.json', JSON.stringify({ name: '@proof-or-stop/core', version: '0.0.0-smoke' }, null, 2));
  write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
  git(root, ['init', '-b', 'work']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'B1507 Smoke']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed']);
  git(root, ['branch', 'main']);
  resetConfigCache();
  const store = new StoryStore(root);
  const at = '2026-07-25T00:00:00.000Z';
  const story: StoryInfo = {
    storyId, name: 'b1507-smoke', title: 'verification_run + refresh + guard smoke',
    description: 'smoke', type: 'chore', phase: 'DEV', priority: 'medium',
    createdAt: at, startedAt: at, endedAt: null,
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001', title: 'exercise B-1507 behaviors', context: 'ctx', status: 'in_progress',
      startTime: null, endTime: null,
      verificationIntent: { happy: intents, edge: [], adversarial: [] },
    }],
  };
  store.writeStory(storyId, story);
  acquireOwnerLease(store.storyDirPath(storyId), { command: 'smoke_fixture_setup', cwd: root });
  store.writeChecklist(storyId, checklist);
  const handlers = createChecklistHandlers({ store, root, scanRoot: join(root, 'packages/main') });
  const guard = createEvidencePinGuardHandlers({ store, root, scanRoot: join(root, 'packages/main') });
  return { root, store, handlers, guard, storyId };
}

function cleanup(env: { root: string }): void {
  rmSync(env.root, { recursive: true, force: true });
}

function findEvidence(env: Env, intentRef: string) {
  const cl = env.store.readChecklist(env.storyId);
  return cl.items[0].verificationEvidence?.find(e => e.intentRef === intentRef);
}

function guardVerdict(env: Env, args: { commandString?: string; toolInputJson?: string }): { verdict: string; matched: boolean } {
  const out = env.guard.verification_pin_guard_check({ ...args, json: true });
  return JSON.parse(out) as { verdict: string; matched: boolean };
}

const intent = (id: string, type: VerificationIntentType, pin?: { command: string; selector: string }): VerificationIntentItem => ({
  id, desc: `intent ${id}`, type, priority: 'must', ...(pin ? { verification: pin } : {}),
});

// ════════════════════════════════════════════════════════════════════════════
// A. verification_run — executes the pin, writes a receipt, refuses on the 3 paths
// ════════════════════════════════════════════════════════════════════════════
async function partA(): Promise<void> {
  const env = makeEnv('B-runA', [
    intent('INT-RUN-OK', 'cli', { command: PASS_CMD, selector: SELECTOR }),
    intent('INT-NOPIN', 'cli'), // executable intent, no pin
  ]);
  try {
    // A1: happy — verification_run executes the PINNED command and stamps a receipt.
    await env.handlers.verification_run({ storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-RUN-OK', note: 'run the pinned verifier' });
    const ev = findEvidence(env, 'INT-RUN-OK');
    assert.ok(ev, 'A1: verification_run recorded an evidence row');
    assert.equal(ev.mechanical, true, 'A1: row is a mechanical tool-executed receipt');
    assert.ok(ev.receipt, 'A1: a receipt was stamped (proves the command actually ran)');
    assert.equal(ev.receipt.exitCode, 0, 'A1: receipt.exitCode is the REAL exit (0)');
    assert.equal(ev.receipt.selectorMatched, true, 'A1: receipt.selectorMatched proves the selector appeared in real output');
    assert.match(ev.receipt.outputDigest, /^[0-9a-f]{64}$/, 'A1: receipt.outputDigest is a sha256 over captured output');
    assert.match(ev.receipt.outputTail, /MARKER_OK/, 'A1: receipt.outputTail carries the real captured output');
    assert.equal(ev.receipt.outputDigest, sha256Hex(ev.receipt.outputTail), 'A1: digest == sha256(captured output) (short output)');
    // Result is DERIVED from the receipt, not authored by the caller (schema exposes no result field).
    assert.equal(ev.result, 'pass', 'A1: recorded result is DERIVED from the receipt (exit 0 + selector match)');
    // Gate: an executed receipt covers the executable intent.
    const cov = buildVerificationCoverage(env.store.readChecklist(env.storyId));
    const okEntry = cov.entries.find(e => e.intentRef === 'INT-RUN-OK');
    assert.equal(okEntry?.status, 'covered', 'A1: the executed receipt covers the executable intent');

    // A3: REFUSE — the intent has no pin → [verification_run_no_pin] (never mints an unexecuted row).
    await expectRejection(
      env.handlers.verification_run({ storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-NOPIN', note: 'no pin to run' }),
      /verification_run_no_pin/, 'A3: unpinned intent is refused',
    );
    assert.equal(findEvidence(env, 'INT-NOPIN'), undefined, 'A3: no row minted for the unpinned intent');

    // A4: REFUSE — the intentRef does not resolve to any intent → [intent_ref_unresolved].
    await expectRejection(
      env.handlers.verification_run({ storyId: env.storyId, intentRef: 'CHK-001:happy:99', note: 'unresolved ref' }),
      /intent_ref_unresolved/, 'A4: unresolved intentRef is refused',
    );
  } finally { cleanup(env); }
}

// ════════════════════════════════════════════════════════════════════════════
// A2 (isolated). exit-nonzero pin → [receipt_exit_nonzero]; NOTHING is minted.
//
// B-1507 F-005 hardening — fixture-state isolation + flake analysis. A2 failed
// ONCE in a live `validate` and was NOT reproducible in isolation (0/19 repro
// attempts by the reviewer). It runs in its OWN fresh temp repo + story here,
// carrying NO state from A1 (A1 does a real verification_run that stamps a
// receipt AND auto-commits story metadata — a git write that moves HEAD on the
// shared env). That carried mutation is the only cross-assertion coupling A2
// ever had; giving A2 a dedicated env removes it as a variable.
//
// What was checked (why the refusal reason itself is deterministic and robust,
// so the residual flake could only originate OUTSIDE the modeled refusal path):
//   • enforceAndStampEvidence evaluates the exit check (checklist.ts, `input.result
//     === 'pass' && !exitOk → [receipt_exit_nonzero]`) BEFORE the selector check
//     (`!selectorMatched → [receipt_selector_absent]`). verification_run pins
//     result:'pass', so [receipt_exit_nonzero] wins whenever the command does not
//     cleanly exit 0.
//   • runValidationCommand's Promise always RESOLVES, never rejects: a nonzero
//     exit (code=3), a timeout (normalized code=124), and a spawn 'error'
//     (runnerFailure → finish(null) → code=1) ALL yield !exitOk. So process-exit
//     race, subprocess timeout, and EAGAIN/EMFILE spawn failure under concurrent
//     validate load each still surface as [receipt_exit_nonzero] — the marker is
//     invariant to the node-command outcome.
//   • resolveStoryGitCwd cannot throw (try/catch → projectRoot fallback) and the
//     evidenceHashes git probe is inside the post-refusal lock, so neither can
//     inject a foreign rejection message ahead of enforceAndStampEvidence.
// Conclusion: the assertion's semantics are correct and were NOT weakened; the
// only remaining nondeterminism is transient host-level subprocess/FS pressure
// during a busy validate, which per-assertion fixture isolation now insulates.
async function partA2Refusal(): Promise<void> {
  const env = makeEnv('B-runA2', [
    intent('INT-RUN-FAIL', 'cli', { command: NONZERO_CMD, selector: SELECTOR }),
  ]);
  try {
    // The pinned command exits non-zero while verification_run's fixed internal
    // expectation is pass → [receipt_exit_nonzero]; NOTHING is minted.
    await expectRejection(
      env.handlers.verification_run({ storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-RUN-FAIL', note: 'nonzero pin' }),
      /receipt_exit_nonzero/, 'A2: exit-nonzero pin is refused',
    );
    assert.equal(findEvidence(env, 'INT-RUN-FAIL'), undefined, 'A2: no covered row is minted for the refused nonzero pin');
  } finally { cleanup(env); }
}

// ════════════════════════════════════════════════════════════════════════════
// B. refresh RE-EXECUTES on drift (not demote) when it still passes; leaves it
//    demoted when the pin now fails; a pin-LESS row keeps demote-only behavior.
// ════════════════════════════════════════════════════════════════════════════
async function partB(): Promise<void> {
  const env = makeEnv('B-refB', [
    intent('INT-REEXEC', 'cli'),  // pinned via add to PASS_CMD (always re-passes)
    intent('INT-FAIL', 'cli'),    // pinned via add to READ_FLAG_CMD (re-fails once flag flips)
    intent('INT-PINLESS', 'cli'), // NO pin — a hand-written mechanical row (B-3b88 coexistence)
    intent('INT-DOC', 'docs'),    // docs intent with a deliberate pinned mechanical verifier
  ]);
  try {
    // Seed a material file the READ_FLAG pin depends on, so re-execution outcome is controllable.
    write(env.root, 'flag.txt', 'MARKER_OK');
    git(env.root, ['add', 'flag.txt']);
    git(env.root, ['commit', '-m', 'flag=MARKER_OK']);

    // Pin + record a PASSING mechanical row for INT-REEXEC (PASS_CMD always passes).
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-REEXEC', kind: 'integration_test',
      command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'pin + pass the always-green verifier',
    });
    // Pin + record a PASSING mechanical row for INT-FAIL (READ_FLAG passes while flag=MARKER_OK).
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-FAIL', kind: 'integration_test',
      command: READ_FLAG_CMD, selector: SELECTOR, result: 'pass', note: 'pin + pass the flag-dependent verifier',
    });
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-DOC', kind: 'docs_check',
      command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'pin + pass the documentation verifier',
    });

    // Hand-write a pin-LESS mechanical row bound to the CURRENT head+material. The intent
    // has NO verification pin, so refresh's re-exec loop must SKIP it → demote-only path.
    const head0 = git(env.root, ['rev-parse', 'HEAD']);
    const material0 = currentMaterialHash(env.root, 'HEAD', env.root);
    const storyFiles0 = currentStoryFilesHash(env.root, 'HEAD', env.root);
    assert.ok(storyFiles0, 'B: main-backed temp repo has a storyFilesHash for causal freshness');
    const fakeReceipt: VerificationExecutionReceipt = {
      exitCode: 0, outputDigest: sha256Hex('MARKER_OK\n'), outputTail: 'MARKER_OK\n', selectorMatched: true,
      executedAt: '2026-07-25T00:00:00.000Z',
    };
    {
      const cl = env.store.readChecklist(env.storyId);
      const rows = cl.items[0].verificationEvidence || [];
      rows.push({
        intentRef: 'INT-PINLESS', kind: 'integration_test', result: 'pass', note: 'pin-less legacy mechanical row',
        headHash: head0, ...(material0 ? { materialHash: material0 } : {}),
        mechanical: true, receipt: fakeReceipt,
      });
      cl.items[0].verificationEvidence = rows;
      env.store.writeChecklist(env.storyId, cl);
    }

    // Snapshot the pre-refresh receipt identity for INT-REEXEC.
    const reexecBefore = findEvidence(env, 'INT-REEXEC');
    assert.equal(reexecBefore?.mechanical, true, 'B: INT-REEXEC starts as a mechanical row');
    const executedAtBefore = reexecBefore!.receipt!.executedAt;
    const materialBefore = reexecBefore!.materialHash;

    // DRIFT: flip flag.txt to BROKEN and commit → material tree changes → all 3 rows go stale.
    write(env.root, 'flag.txt', 'BROKEN');
    git(env.root, ['add', 'flag.txt']);
    git(env.root, ['commit', '-m', 'flag=BROKEN (material drift)']);
    const material1 = currentMaterialHash(env.root, 'HEAD', env.root);
    assert.ok(material1 && material1 !== materialBefore, 'B: material drift produced a NEW materialHash');

    // Reproduce the real recovery state: a metadata-only refresh cannot execute
    // commands, so it demotes and rebinds receipts to the current material.
    // The subsequent async refresh must recover these CURRENT non-mechanical
    // rows, not report that there is no stale evidence.
    refreshStaleEvidenceMetadataOnly({ store: env.store, root: env.root, scanRoot: env.root }, env.storyId);
    assert.equal(findEvidence(env, 'INT-DOC')?.mechanical, false,
      'B: metadata-only refresh demotes the pinned docs receipt before recovery');

    // Run the REAL async re-executing refresh.
    const out = await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
    assert.match(out, /Refreshed \d+\/\d+/, 'B: refresh reported a refresh count');

    // B1: INT-REEXEC still passes on re-run → RE-EXECUTED, stays mechanical:true, bound to
    //     the NEW materialHash (NOT demoted). Reverting refresh to DEMOTE kills this.
    const reexecAfter = findEvidence(env, 'INT-REEXEC');
    assert.equal(reexecAfter?.mechanical, true, 'B1: passing re-run stays mechanical:true (NOT demoted)');
    assert.ok(reexecAfter?.receipt, 'B1: a fresh receipt is present after re-execution');
    assert.equal(reexecAfter.receipt.exitCode, 0, 'B1: re-execution receipt exit 0');
    assert.equal(reexecAfter.receipt.selectorMatched, true, 'B1: re-execution selector matched');
    assert.equal(reexecAfter.result, 'pass', 'B1: re-execution derived pass');
    assert.equal(reexecAfter.materialHash, material1, 'B1: the fresh receipt is bound to the CURRENT (new) materialHash');
    assert.notEqual(reexecAfter.receipt.executedAt, executedAtBefore, 'B1: executedAt changed → the command was genuinely RE-RUN (not a carried-forward stale receipt)');

    // B2: INT-FAIL now fails on re-run (flag=BROKEN → selector absent) → LEFT demoted /
    //     non-mechanical, receipt stripped (no laundering back to covered). Reverting refresh
    //     to launder a failing re-run into mechanical:true kills this.
    const failAfter = findEvidence(env, 'INT-FAIL');
    assert.equal(failAfter?.mechanical, false, 'B2: a failing re-run leaves the row demoted (mechanical:false)');
    assert.equal(failAfter?.receipt, undefined, 'B2: the stale receipt is stripped (no laundering)');
    assert.ok(failAfter?.nonMechanicalReason, 'B2: an attributable demotion reason is recorded');

    // B3: INT-PINLESS keeps demote-only behavior (B-3b88 coexistence — the re-exec change is
    //     ADDITIVE and never re-executes a pin-less row). Reverting to re-execute/keep-covered
    //     everything would keep this mechanical:true and kill the assertion.
    const pinlessAfter = findEvidence(env, 'INT-PINLESS');
    assert.equal(pinlessAfter?.mechanical, false, 'B3: pin-less stale mechanical row is DEMOTED (demote-only)');
    assert.equal(pinlessAfter?.receipt, undefined, 'B3: pin-less demotion strips the receipt');

    // B4: a deliberately pinned docs verifier is recovered too. This locks the
    // B3F3D-006-H3 path: docs/manual types are not skipped merely because their
    // intent type is non-executable by default.
    const docAfter = findEvidence(env, 'INT-DOC');
    assert.equal(docAfter?.mechanical, true, 'B4: pinned docs verifier re-earns mechanical authority');
    assert.equal(docAfter?.receipt?.selectorMatched, true, 'B4: pinned docs selector matched on recovery');
    assert.equal(docAfter?.materialHash, material1, 'B4: recovered docs receipt binds current material');

    // Gate cross-check: only the re-executed row still covers; the other two are uncovered.
    const cov = buildVerificationCoverage(env.store.readChecklist(env.storyId));
    assert.equal(cov.entries.find(e => e.intentRef === 'INT-REEXEC')?.status, 'covered', 'B: re-executed row covers');
    assert.equal(cov.entries.find(e => e.intentRef === 'INT-FAIL')?.status, 'non_mechanical', 'B: demoted-fail row is uncovered');
    assert.equal(cov.entries.find(e => e.intentRef === 'INT-PINLESS')?.status, 'non_mechanical', 'B: demoted pin-less row is uncovered');
    assert.equal(cov.entries.find(e => e.intentRef === 'INT-DOC')?.status, 'covered', 'B: recovered pinned docs row covers');
  } finally { cleanup(env); }
}

// ════════════════════════════════════════════════════════════════════════════
// C. guard verdict (real handler + pure core) + adversarial floor-still-refuses
// ════════════════════════════════════════════════════════════════════════════
async function partC(): Promise<void> {
  const env = makeEnv('B-guardC', [
    intent('INT-PIN', 'cli'),    // pinned via add to PASS_CMD/SELECTOR
    intent('INT-NOPIN2', 'cli'), // executable, never pinned
  ]);
  try {
    // Pin INT-PIN by recording a passing mechanical row (immutable pin thereafter).
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-PIN', kind: 'integration_test',
      command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'pin the immutable verifier',
    });

    const addBlob = (o: Record<string, unknown>) => `node bin/proof-or-stop.js verification_evidence_add ${JSON.stringify(o)}`;

    // C1: DENY — mismatched --command (JSON-blob form). selector matches; only command differs.
    const denyCmd = guardVerdict(env, {
      commandString: addBlob({ storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-PIN', command: DIFFERENT_CMD, selector: SELECTOR, kind: 'integration_test', result: 'pass', note: 'x' }),
    });
    assert.equal(denyCmd.verdict, 'deny', 'C1: mismatched --command (JSON blob) is DENIED');

    // C2: DENY — mismatched --selector (--k=v form). No --command; only the selector differs.
    const denySel = guardVerdict(env, {
      commandString: `node bin/proof-or-stop.js verification_evidence_add --storyId=${env.storyId} --itemId=CHK-001 --intentRef=INT-PIN --selector=WRONG_SELECTOR --note=x`,
    });
    assert.equal(denySel.verdict, 'deny', 'C2: mismatched --selector (--k=v) is DENIED');

    // C3: ALLOW — command AND selector both match the pin.
    const allowMatch = guardVerdict(env, {
      commandString: addBlob({ storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-PIN', command: PASS_CMD, selector: SELECTOR, kind: 'integration_test', result: 'pass', note: 'x' }),
    });
    assert.equal(allowMatch.verdict, 'allow', 'C3: matching command/selector is ALLOWED');

    // C4: ALLOW — verification_run derives its command from the pin (nothing to mismatch).
    const allowRun = guardVerdict(env, {
      commandString: `node bin/proof-or-stop.js verification_run --storyId=${env.storyId} --intentRef=INT-PIN`,
    });
    assert.equal(allowRun.verdict, 'allow', 'C4: verification_run is ALLOWED');

    // C5: ALLOW — an unpinned intent (the first write will pin it).
    const allowUnpinned = guardVerdict(env, {
      commandString: addBlob({ storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-NOPIN2', command: DIFFERENT_CMD, selector: 'ANYTHING', kind: 'integration_test', result: 'pass', note: 'x' }),
    });
    assert.equal(allowUnpinned.verdict, 'allow', 'C5: unpinned intent is ALLOWED');

    // C6: ALLOW (no-decision) — not a proof-or-stop evidence-write command at all.
    const allowNonProofOrStop = guardVerdict(env, { commandString: 'git status -s' });
    assert.equal(allowNonProofOrStop.verdict, 'allow', 'C6: non-proof-or-stop command is ALLOWED (no-decision)');
    assert.equal(allowNonProofOrStop.matched, false, 'C6: non-proof-or-stop command is not matched as an evidence write');

    // C7: FAIL-OPEN — a WOULD-BE-deny (mismatched command) against a NONEXISTENT story:
    //     the store read fails → the seatbelt allows rather than blocking legitimate work.
    const failOpenStory = guardVerdict(env, {
      commandString: addBlob({ storyId: 'B-DOESNOTEXIST', itemId: 'CHK-001', intentRef: 'INT-PIN', command: DIFFERENT_CMD, selector: SELECTOR, kind: 'integration_test', result: 'pass', note: 'x' }),
    });
    assert.equal(failOpenStory.verdict, 'allow', 'C7: nonexistent story => FAIL-OPEN allow');

    // C8: FAIL-OPEN — unparseable tool input (no command to inspect) => allow.
    const failOpenParse = guardVerdict(env, { toolInputJson: '{ this is not valid json' });
    assert.equal(failOpenParse.verdict, 'allow', 'C8: unparseable input => FAIL-OPEN allow');
    assert.equal(failOpenParse.matched, false, 'C8: unparseable input yields a no-decision allow');

    // C9: ADVERSARIAL — bypass the seatbelt entirely and hit the enforceAndStampEvidence
    //     HANDLER with the same mismatched command: the FLOOR still refuses (the guard/hook
    //     is non-load-bearing). Removing the floor refusal kills this.
    await expectRejection(
      env.handlers.verification_evidence_add({
        storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-PIN', kind: 'integration_test',
        command: DIFFERENT_CMD, selector: SELECTOR, result: 'pass', note: 'bypass the hook; the floor must still refuse',
      }),
      /receipt_command_mismatch/, 'C9: the handler floor refuses the mismatch even with the hook bypassed',
    );
  } finally { cleanup(env); }
}

// ════════════════════════════════════════════════════════════════════════════
// D. host PreToolUse hook e2e — real shims spawn the real CLI and exit 2 on deny.
// ════════════════════════════════════════════════════════════════════════════

/** A temp repo that also exposes the REAL built CLI to the host hooks via a thin
 *  dist/cli.js shim (the hooks resolve `<root>/packages/main/dist/cli.js` first). */
function makeCliBackedEnv(storyId: string): Env {
  const env = makeEnv(storyId, [intent('INT-PIN', 'cli')]);
  // Thin shim: importing the real dist/cli.js runs runCli() (no ?query on its own url).
  write(env.root, 'packages/main/dist/cli.js', `import ${JSON.stringify(pathToFileURL(REAL_CLI).href)};\n`);
  return env;
}

/** Spawn a host hook with a synthesized PreToolUse payload; return its exit code. */
function runHook(hookPath: string, root: string, toolName: string, command: string): number {
  const payload = JSON.stringify({ tool_name: toolName, tool_input: { command }, cwd: root });
  const r = spawnSync(process.execPath, [hookPath], {
    input: payload,
    // PROOF_OR_STOP_PROJECT_ROOT pins the spawned CLI to THIS temp repo regardless of cwd walking.
    env: { ...process.env, PROOF_OR_STOP_PROJECT_ROOT: root },
    encoding: 'utf8',
    timeout: 20000,
  });
  return typeof r.status === 'number' ? r.status : -1;
}

async function partD(): Promise<string> {
  const env = makeCliBackedEnv('B-hookD');
  const notes: string[] = [];
  try {
    // Pin INT-PIN so the real CLI resolves a real immutable pin for the deny path.
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-PIN', kind: 'integration_test',
      command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'pin for the hook e2e',
    });

    const mismatchCmd = `node bin/proof-or-stop.js verification_evidence_add ${JSON.stringify({ storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-PIN', command: DIFFERENT_CMD, selector: SELECTOR, kind: 'integration_test', result: 'pass', note: 'e2e mismatch' })}`;
    const matchCmd = `node bin/proof-or-stop.js verification_evidence_add ${JSON.stringify({ storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-PIN', command: PASS_CMD, selector: SELECTOR, kind: 'integration_test', result: 'pass', note: 'e2e match' })}`;

    // D1: Claude Bash matcher — FULLY asserted (the real emitted tool_name is `Bash`).
    assert.equal(runHook(CLAUDE_HOOK, env.root, 'Bash', mismatchCmd), 2, 'D1: Claude Bash hook exits 2 (deny) on a mismatched evidence write');
    assert.equal(runHook(CLAUDE_HOOK, env.root, 'Bash', matchCmd), 0, 'D1: Claude Bash hook exits 0 (allow) on a matching evidence write');
    assert.equal(runHook(CLAUDE_HOOK, env.root, 'Edit', mismatchCmd), 0, 'D1: Claude hook does NOT fire for a non-Bash tool (fail-open exit 0)');

    // D2: Codex shell matcher — the shim FIRES (exit 2) for the DOCUMENTED CANDIDATE tokens.
    //     PENDING-REAL-TOKEN: Codex's REAL emitted shell tool_name is NOT confirmable in this
    //     environment (CHK-003). We assert only that the candidate tokens the shim matches DO
    //     fire; we do NOT assert that Codex actually emits one of them — see the NOTE below.
    const CODEX_CANDIDATES = ['shell', 'local_shell', 'exec_command'];
    for (const token of CODEX_CANDIDATES) {
      assert.equal(runHook(CODEX_HOOK, env.root, token, mismatchCmd), 2, `D2: Codex hook exits 2 (deny) for candidate tool_name=${token}`);
    }
    // A non-candidate tool_name must never fire (the shim is a true no-op there).
    assert.equal(runHook(CODEX_HOOK, env.root, 'apply_patch', mismatchCmd), 0, 'D2: Codex hook does NOT fire for a non-shell tool (fail-open exit 0)');
    // Matching command allowed even for a candidate token.
    assert.equal(runHook(CODEX_HOOK, env.root, 'shell', matchCmd), 0, 'D2: Codex hook exits 0 (allow) on a matching evidence write');

    notes.push(
      'NOTE (Codex): PENDING-REAL-TOKEN — asserted the shim FIRES exit-2 on deny for the documented ' +
      `candidate tokens (${CODEX_CANDIDATES.join('|')}); Codex's REAL emitted shell tool_name is NOT confirmed ` +
      'in this environment, so Codex coverage is CANDIDATE-only, not confirmed. Claude Bash is fully asserted.',
    );
    return notes.join('\n');
  } finally { cleanup(env); }
}

// ════════════════════════════════════════════════════════════════════════════
// E. stale refresh exact-semantics dedupe — real child-process execution count.
// ════════════════════════════════════════════════════════════════════════════

function externalVerifierCommand(counterPath: string, outputPath: string): string {
  const script = [
    `require('fs').appendFileSync(${JSON.stringify(counterPath)}, 'x')`,
    `process.stdout.write(require('fs').readFileSync(${JSON.stringify(outputPath)}, 'utf8'))`,
  ].join(';');
  return `node -e ${JSON.stringify(script)}`;
}

function commitRefreshDrift(env: Env, label: string): void {
  write(env.root, 'packages/main/src/refresh-drift.ts', `export const drift = ${JSON.stringify(label)};\n`);
  git(env.root, ['add', 'packages/main/src/refresh-drift.ts']);
  git(env.root, ['commit', '-m', `refresh drift ${label}`]);
}

async function seedPinnedReceipt(
  env: Env,
  args: {
    intentRef: string;
    command: string;
    selector: string;
    commandTimeoutMs?: number;
    commandTimeoutReason?: string;
  },
): Promise<void> {
  await env.handlers.verification_evidence_add({
    storyId: env.storyId,
    itemId: 'CHK-001',
    intentRef: args.intentRef,
    kind: 'integration_test',
    command: args.command,
    selector: args.selector,
    result: 'pass',
    note: `seed ${args.intentRef}`,
    ...(args.commandTimeoutMs !== undefined ? { commandTimeoutMs: args.commandTimeoutMs } : {}),
    ...(args.commandTimeoutReason ? { commandTimeoutReason: args.commandTimeoutReason } : {}),
  });
}

function executionCount(counterPath: string): number {
  return readFileSync(counterPath, 'utf8').length;
}

async function partE(): Promise<void> {
  const externalRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-refresh-dedupe-'));
  try {
    // E1: two intents with one exact pin/provenance key execute once. Each row
    // receives a cloned receipt whose timestamp and output digest describe that
    // one real execution, rather than a fabricated per-intent pass.
    {
      const env = makeEnv('B-refresh-dedupe-same', [
        intent('INT-SHARED-A', 'cli'),
        intent('INT-SHARED-B', 'cli'),
      ]);
      try {
        const counter = join(externalRoot, 'same-counter.txt');
        const output = join(externalRoot, 'same-output.txt');
        writeFileSync(counter, '');
        writeFileSync(output, 'SHARED_OK\n');
        const command = externalVerifierCommand(counter, output);
        await seedPinnedReceipt(env, { intentRef: 'INT-SHARED-A', command, selector: 'SHARED_OK' });
        await seedPinnedReceipt(env, { intentRef: 'INT-SHARED-B', command, selector: 'SHARED_OK' });
        writeFileSync(counter, '');
        commitRefreshDrift(env, 'same-key');

        await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
        assert.equal(executionCount(counter), 1, 'E1: one exact execution key runs once for two stale rows');
        const a = findEvidence(env, 'INT-SHARED-A');
        const b = findEvidence(env, 'INT-SHARED-B');
        assert.equal(a?.mechanical, true, 'E1: first shared row remains mechanical');
        assert.equal(b?.mechanical, true, 'E1: second shared row remains mechanical');
        assert.ok(a?.receipt && b?.receipt, 'E1: both rows receive receipts');
        assert.deepEqual(a!.receipt, b!.receipt, 'E1: shared rows bind cloned facts from the same execution');
        assert.match(a!.receipt!.executedAt, /^\d{4}-\d{2}-\d{2}T/u, 'E1: receipt timestamp is an ISO execution time');
        assert.equal(a!.receipt!.outputDigest, sha256Hex('SHARED_OK\n'), 'E1: receipt digest binds the real shared output');
      } finally { cleanup(env); }
    }

    // E2: selector and effective-timeout differences are execution semantics,
    // not presentation metadata. Five distinct keys must produce five runs.
    {
      const env = makeEnv('B-refresh-dedupe-distinct', [
        intent('INT-SELECTOR-A', 'cli'),
        intent('INT-SELECTOR-B', 'cli'),
        intent('INT-TIMEOUT-A', 'cli'),
        intent('INT-TIMEOUT-B', 'cli'),
        intent('INT-PROVENANCE-C', 'cli'),
      ]);
      try {
        const counter = join(externalRoot, 'distinct-counter.txt');
        const output = join(externalRoot, 'distinct-output.txt');
        writeFileSync(counter, '');
        writeFileSync(output, 'SELECTOR_A SELECTOR_B\n');
        const command = externalVerifierCommand(counter, output);
        await seedPinnedReceipt(env, { intentRef: 'INT-SELECTOR-A', command, selector: 'SELECTOR_A' });
        await seedPinnedReceipt(env, { intentRef: 'INT-SELECTOR-B', command, selector: 'SELECTOR_B' });
        await seedPinnedReceipt(env, {
          intentRef: 'INT-TIMEOUT-A', command, selector: 'SELECTOR_A', commandTimeoutMs: 5000,
          commandTimeoutReason: 'The dedupe smoke needs an attributable first timeout provenance.',
        });
        await seedPinnedReceipt(env, {
          intentRef: 'INT-TIMEOUT-B', command, selector: 'SELECTOR_A', commandTimeoutMs: 7000,
          commandTimeoutReason: 'The dedupe smoke needs an attributable second timeout provenance.',
        });
        await seedPinnedReceipt(env, {
          intentRef: 'INT-PROVENANCE-C', command, selector: 'SELECTOR_A', commandTimeoutMs: 5000,
          commandTimeoutReason: 'The dedupe smoke needs distinct provenance at the same timeout value.',
        });
        writeFileSync(counter, '');
        commitRefreshDrift(env, 'distinct-keys');

        await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
        assert.equal(executionCount(counter), 5, 'E2: different selector/effective-timeout/provenance keys never dedupe');
        assert.equal(findEvidence(env, 'INT-TIMEOUT-A')?.receipt?.timeoutOverride?.timeoutMs, 5000,
          'E2: first timeout provenance survives refresh');
        assert.equal(findEvidence(env, 'INT-TIMEOUT-B')?.receipt?.timeoutOverride?.timeoutMs, 7000,
          'E2: second timeout provenance survives refresh');
        assert.notEqual(
          findEvidence(env, 'INT-TIMEOUT-A')?.receipt?.timeoutOverride?.reason,
          findEvidence(env, 'INT-PROVENANCE-C')?.receipt?.timeoutOverride?.reason,
          'E2: same timeout with different audited provenance is not collapsed',
        );
      } finally { cleanup(env); }
    }

    // E3: a shared command that no longer emits the selector runs once, but its
    // failure produces zero pass stamps. Every row sharing that key is demoted.
    {
      const env = makeEnv('B-refresh-dedupe-failure', [
        intent('INT-FAIL-A', 'cli'),
        intent('INT-FAIL-B', 'cli'),
      ]);
      try {
        const counter = join(externalRoot, 'failure-counter.txt');
        const output = join(externalRoot, 'failure-output.txt');
        writeFileSync(counter, '');
        writeFileSync(output, 'WAS_GOOD\n');
        const command = externalVerifierCommand(counter, output);
        await seedPinnedReceipt(env, { intentRef: 'INT-FAIL-A', command, selector: 'WAS_GOOD' });
        await seedPinnedReceipt(env, { intentRef: 'INT-FAIL-B', command, selector: 'WAS_GOOD' });
        writeFileSync(counter, '');
        writeFileSync(output, 'NOW_BROKEN\n');
        commitRefreshDrift(env, 'shared-failure');

        await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
        assert.equal(executionCount(counter), 1, 'E3: one shared failing key is attempted once');
        for (const ref of ['INT-FAIL-A', 'INT-FAIL-B']) {
          const row = findEvidence(env, ref);
          assert.equal(row?.mechanical, false, `E3: ${ref} is demoted after the shared failure`);
          assert.equal(row?.receipt, undefined, `E3: ${ref} receives no fabricated pass receipt`);
        }
      } finally { cleanup(env); }
    }
  } finally {
    rmSync(externalRoot, { recursive: true, force: true });
  }
}

// ── Runner ──
(async () => {
  await partA();
  await partA2Refusal();
  await partB();
  await partC();
  const codexNote = await partD();
  await partE();
  if (codexNote) console.log(codexNote);
  console.log('verification-run-and-guard-smoke: PASS');
})().catch((e) => {
  console.error('verification-run-and-guard-smoke: FAIL');
  console.error(e instanceof Error ? (e.stack || e.message) : String(e));
  process.exit(1);
});
