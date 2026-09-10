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
 *   B. verification_evidence_refresh_stale (async): groups stale rows by selector-free
 *      execution identity. A proven-unchanged policy-owned capsule may reuse immutable
 *      evidence with zero subprocesses; otherwise freshness fails closed to at most one
 *      real rerun per affected execution key. Timeout/nonzero failure demotes every
 *      dependent row, selector mismatch demotes only its row, and a pin-less row retains
 *      demote-only behavior (B-3b88 coexistence).
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
 *   E. stale-refresh execution fan-out: execution identity is command + resolved
 *      cwd + effective timeout. Selectors remain independent assertions over one
 *      shared execution output; timeout differences remain distinct; one shared
 *      execution failure demotes all dependent rows. The B-aa5f regression shape
 *      proves 71 intents over two commands launch exactly two refresh executions.
 *
 * RED-first: each core assertion mutation-kills — reverting the corresponding
 * behavior (make refresh demote instead of re-execute; make the guard always-allow;
 * make verification_run mint an unexecuted covered row) makes THIS smoke FAIL.
 *
 * Prints `verification-run-and-guard-smoke: PASS` + exit 0 on success; prints a
 * diagnostic + exit 1 (via a thrown assertion) on any failure.
 */

import { strict as assert } from 'node:assert';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StoryStore } from '../core/store.js';
import { PROOF_OR_STOP_DIR } from '../core/proof-or-stop-paths.js';
import { acquireOwnerLease } from '../core/story-owner-lease.js';
import { createChecklistHandlers, narrowVerificationPin, refreshStaleEvidenceMetadataOnly } from '../handlers/checklist.js';
import { createEvidencePinGuardHandlers } from '../handlers/evidence-pin-guard.js';
import { createDonePrepareHandlers } from '../handlers/done-prepare.js';
import { buildVerificationCoverage } from '../core/verification.js';
import { createVerificationEvidenceGateEvaluator } from '../core/proof-admissibility.js';
import { currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { resetConfigCache } from '../core/config.js';
import type {
  ChecklistData,
  StoryInfo,
  VerificationEvidence,
  VerificationExecutionReceipt,
  VerificationIntentItem,
  VerificationIntentType,
  VerificationReceiptBundleV5,
  VerificationSplitReceipt,
} from '../core/types.js';
import {
  isSplitVerificationReceipt,
  isReusableVerificationReceipt,
  planVerificationExecutionReuse,
  prepareVerificationExecutionIdentity,
  validateVerificationReceipt,
  createVerificationExecutionReceipt,
  createVerificationAssertionReceipt,
  withVerificationExecutionLocks,
  verificationExecutionLockPath,
} from '../core/verification-execution-evidence.js';
import { computeCanonicalDigest, listArtifacts } from '../core/evidence/artifact-store.js';
import { assessVerifierDependencyManifest } from '../core/evidence-freshness.js';
import { effectiveValidationCommandEnvironment } from '../core/validation-command-environment.js';
import { runSingleAllowlistedCommand } from '../core/validation-executor.js';
import {
  CAUSAL_MAX_OUTPUT_CHARS, CAUSAL_OUTPUT_TAIL_CHARS,
  DEFAULT_CAUSAL_SELECTOR_POLICY, effectiveCausalEnvironment, executeCausalEvidence, importCausalEvidenceReceipt,
  preflightCausalEvidence, verifyCausalEvidenceReceipt,
  type CausalEvidenceReceipt, type CausalExecutionIdentityInput, type CausalPreflightFacts,
} from '../core/causal-evidence.js';
import {
  buildVerificationReuseCapsuleInvocation,
  verificationReuseCapsuleEnforcementSupported,
} from '../core/verification-reuse-capsule.js';
import {
  canonicalDigest as signingCanonicalDigest,
  generateEd25519KeyPair,
  signCanonical,
} from '../core/authority-signing.js';

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
interface Env {
  root: string;
  store: StoryStore;
  handlers: ReturnType<typeof createChecklistHandlers>;
  guard: ReturnType<typeof createEvidencePinGuardHandlers>;
  storyId: string;
  launchCounter: { count: number };
}

/** Build an isolated temp git repo + story + single checklist item carrying `intents`. */
function makeEnv(
  storyId: string,
  intents: VerificationIntentItem[],
  runnerAfterExecution?: (command: string, cwd: string) => void | Promise<void>,
  log?: (message: string) => void,
): Env {
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
  const launchCounter = { count: 0 };
  const handlers = createChecklistHandlers({
    ...(log ? { log } : {}),
    store,
    root,
    scanRoot: join(root, 'packages/main'),
    verificationCommandRunner: async (command, cwd, timeoutMs) => {
      launchCounter.count++;
      const result = await runSingleAllowlistedCommand(command, root, {
        cwd,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      await runnerAfterExecution?.(command, cwd);
      return result;
    },
  });
  const guard = createEvidencePinGuardHandlers({ store, root, scanRoot: join(root, 'packages/main') });
  return { root, store, handlers, guard, storyId, launchCounter };
}

function cleanup(env: { root: string }): void {
  rmSync(env.root, { recursive: true, force: true });
}

function findEvidence(env: Env, intentRef: string) {
  const cl = env.store.readChecklist(env.storyId);
  return cl.items[0].verificationEvidence?.find(e => e.intentRef === intentRef);
}

function verificationFreshnessHashBinding(env: Env, intentRef: string) {
  const evidence = findEvidence(env, intentRef);
  return {
    evidenceHeadHash: evidence?.headHash,
    evidenceMaterialHash: evidence?.materialHash,
    evidenceStoryFilesHash: evidence?.storyFilesHash,
    currentHeadHash: git(env.root, ['rev-parse', 'HEAD']),
    currentMaterialHash: currentMaterialHash(env.root, 'HEAD', env.root),
    currentStoryFilesHash: currentStoryFilesHash(env.root, 'HEAD', env.root),
  };
}

function splitReceipt(env: Env, intentRef: string): VerificationReceiptBundleV5 {
  const receipt = findEvidence(env, intentRef)?.receipt;
  assert.ok(
    isReusableVerificationReceipt(receipt),
    `${intentRef}: expected VerificationReceiptBundleV5 with VerificationAssertionReceiptV2 and VerificationExecutionReceiptV3`,
  );
  return receipt;
}

function reusableReceipt(env: Env, intentRef: string): VerificationReceiptBundleV5 {
  const receipt = findEvidence(env, intentRef)?.receipt;
  assert.ok(
    isReusableVerificationReceipt(receipt),
    `${intentRef}: expected reuse-capable VerificationReceiptBundleV5 with VerificationExecutionReceiptV3 component`,
  );
  return receipt;
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
    const split = splitReceipt(env, 'INT-RUN-OK');
    assert.equal(
      Object.prototype.hasOwnProperty.call(split.executionReceipt, 'selectorMatched'),
      false,
      'A1: execution receipt contains no selector outcome',
    );
    assert.equal(split.assertionReceipt.intentRef, 'INT-RUN-OK', 'A1: assertion binds its intentRef');
    assert.equal(split.assertionReceipt.selectorDigest, sha256Hex(SELECTOR), 'A1: assertion binds the immutable selector digest');
    assert.equal(split.assertionReceipt.matcherVersion, 'literal-includes.v1', 'A1: assertion binds matcher semantics');
    assert.equal(
      split.assertionReceipt.executionReceiptDigest,
      split.executionReceipt.executionReceiptDigest,
      'A1: assertion binds its execution receipt',
    );
    assert.equal(split.assertionReceipt.outputDigest, split.executionReceipt.outputArtifact.outputDigest,
      'A1: assertion and execution bind the same full output');
    assert.equal(split.assertionReceipt.matched, true, 'A1: assertion records its independent match result');
    const validSplit = validateVerificationReceipt(env.root, split, {
      intentRef: 'INT-RUN-OK',
      selector: SELECTOR,
      storyId: env.storyId,
    });
    assert.equal(validSplit.ok, true, `A1: split receipt and full-output artifact validate: ${validSplit.errors.join('; ')}`);
    assert.equal(validSplit.output, 'MARKER_OK\n', 'A1: authoritative read returns complete artifact output');
    assert.equal(validSplit.reusable, false, 'A1: CHK-002 receipt has no cross-state reuse authority');

    // A1 tamper matrix: canonical artifact bytes, execution facts, assertion facts,
    // and expected selector binding all fail closed at the authoritative validator.
    const objectPath = join(
      env.root,
      '.proof-or-stop',
      'evidence',
      'objects',
      'sha256',
      `${split.executionReceipt.outputArtifact.artifactDigest}.json`,
    );
    const originalObject = readFileSync(objectPath, 'utf8');
    const tamperedObject = JSON.parse(originalObject) as { payload: { output: string } };
    tamperedObject.payload.output = 'FORGED_OUTPUT\n';
    writeFileSync(objectPath, `${JSON.stringify(tamperedObject, null, 2)}\n`);
    assert.equal(
      validateVerificationReceipt(env.root, split, { intentRef: 'INT-RUN-OK', selector: SELECTOR }).ok,
      false,
      'A1: tampered full-output artifact fails closed',
    );
    writeFileSync(objectPath, originalObject);

    const tamperedExecution = structuredClone(split);
    tamperedExecution.executionReceipt.durationMs += 1;
    assert.equal(
      validateVerificationReceipt(env.root, tamperedExecution, { intentRef: 'INT-RUN-OK', selector: SELECTOR }).ok,
      false,
      'A1: tampered execution receipt fails closed',
    );
    const tamperedAssertion = structuredClone(split);
    tamperedAssertion.assertionReceipt.matched = false;
    assert.equal(
      validateVerificationReceipt(env.root, tamperedAssertion, { intentRef: 'INT-RUN-OK', selector: SELECTOR }).ok,
      false,
      'A1: tampered assertion receipt fails closed',
    );
    assert.equal(
      validateVerificationReceipt(env.root, split, { intentRef: 'INT-RUN-OK', selector: 'FORGED_SELECTOR' }).ok,
      false,
      'A1: selector substitution fails closed',
    );
    const legacyReceipt: VerificationExecutionReceipt = {
      exitCode: 0,
      outputDigest: sha256Hex('MARKER_OK\n'),
      outputTail: 'MARKER_OK\n',
      selectorMatched: true,
      executedAt: '2026-09-03T00:00:00.000Z',
    };
    const legacyValidation = validateVerificationReceipt(env.root, legacyReceipt, {
      intentRef: 'INT-RUN-OK',
      selector: SELECTOR,
    });
    assert.equal(legacyValidation.ok, true, 'A1: legacy combined receipt remains readable');
    assert.equal(legacyValidation.kind, 'legacy-readable-only', 'A1: legacy receipt is explicitly classified');
    assert.equal(legacyValidation.reusable, false, 'A1: legacy receipt cannot authorize reuse');
    assert.equal(legacyValidation.promotable, false, 'A1: legacy receipt cannot be promoted into split evidence');
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
  const progress: string[] = [];
  const env = makeEnv('B-refB', [
    intent('INT-REEXEC', 'cli'),  // pinned via add to PASS_CMD (always re-passes)
    intent('INT-REEXEC-DUP', 'cli'), // shares one command execution with INT-REEXEC during refresh
    intent('INT-FAIL', 'cli'),    // pinned via add to flagCountingCommand (re-fails once flag flips)
    intent('INT-PINLESS', 'cli'), // NO pin — a hand-written mechanical row (B-3b88 coexistence)
    intent('INT-DOC', 'docs'),    // docs intent with a deliberate pinned mechanical verifier
    intent('INT-MANUAL', 'manual'), // manual intent can also deliberately pin a verifier
  ], undefined, message => progress.push(message));
  try {
    // Seed a material file the flagCountingCommand pin depends on, so re-execution outcome is controllable.
    write(env.root, 'flag.txt', 'MARKER_OK');
    git(env.root, ['add', 'flag.txt']);
    git(env.root, ['commit', '-m', 'flag=MARKER_OK']);

    const refreshCountPath = join(env.root, PROOF_OR_STOP_DIR, 'runtime', 'refresh-count.log');
    const sharedCountingCommand = `node -e "const f=require('fs');f.mkdirSync('${PROOF_OR_STOP_DIR}/runtime',{recursive:true});f.appendFileSync('${PROOF_OR_STOP_DIR}/runtime/refresh-count.log','x\\n');console.log('MARKER_OK')"`;
    const flagCountingCommand = `node -e "const f=require('fs');f.mkdirSync('${PROOF_OR_STOP_DIR}/runtime',{recursive:true});f.appendFileSync('${PROOF_OR_STOP_DIR}/runtime/refresh-count.log','flag\\n');process.stdout.write(f.readFileSync('flag.txt','utf8'))"`;
    // Pin + record two PASSING mechanical rows backed by the exact same command.
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-REEXEC', kind: 'integration_test',
      command: sharedCountingCommand, selector: SELECTOR, result: 'pass', note: 'pin + pass the shared verifier',
    });
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-REEXEC-DUP', kind: 'integration_test',
      command: sharedCountingCommand, selector: SELECTOR, result: 'pass', note: 'pin + pass the shared verifier again',
    });
    // Pin + record a PASSING mechanical row for INT-FAIL (flagCountingCommand passes while flag=MARKER_OK).
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-FAIL', kind: 'integration_test',
      command: flagCountingCommand, selector: SELECTOR, result: 'pass', note: 'pin + pass the flag-dependent verifier',
    });
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-DOC', kind: 'docs_check',
      command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'pin + pass the documentation verifier',
    });
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-MANUAL', kind: 'manual_transcript',
      command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'pin + pass the manual intent verifier',
    });
    writeFileSync(refreshCountPath, '');

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

    // DRIFT: flip flag.txt to BROKEN and commit → material tree changes → all rows go stale.
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
    assert.equal(findEvidence(env, 'INT-MANUAL')?.mechanical, false,
      'B: metadata-only refresh demotes the pinned manual receipt before recovery');

    // Run the REAL async re-executing refresh.
    const out = await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
    assert.match(out, /Refreshed \d+\/\d+/, 'B: refresh reported a refresh count');
    assert.equal(
      readFileSync(refreshCountPath, 'utf8').trim().split('\n').filter(Boolean).length,
      2,
      'B0: two unique cwd+command pins execute exactly once while duplicate intents share one execution',
    );
    assert.match(progress.join('\n'), /validate progress: command 1\/3 started verification-evidence-command:/,
      'B0: refresh exposes the first unique pinned command through the shared validation progress surface');
    assert.match(progress.join('\n'), /validate progress: command 2\/3 started verification-evidence-command:/,
      'B0: refresh exposes the second unique pinned command with the exact aggregate ordinal');
    assert.match(progress.join('\n'), /validate progress: command 1\/3 ended verification-evidence-command:/);
    assert.match(progress.join('\n'), /validate progress: command 2\/3 ended verification-evidence-command:/);
    assert.match(progress.join('\n'), /validate progress: command 3\/3 started verification-evidence-command:/, 'Pinned docs/manual share a third raw command rather than being skipped');
    assert.match(progress.join('\n'), /validate progress: command 3\/3 ended verification-evidence-command:/);

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
    const duplicateAfter = findEvidence(env, 'INT-REEXEC-DUP');
    assert.equal(duplicateAfter?.mechanical, true, 'B1: a second intent sharing the execution is independently stamped mechanical:true');
    assert.equal(duplicateAfter?.receipt?.selectorMatched, true, 'B1: the shared output independently satisfies the duplicate intent selector');

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
    assert.match(pinlessAfter?.nonMechanicalReason ?? '', /not re-run here/u,
      'B3: genuinely unexecuted demotion retains the existing non-execution provenance');

    // B4: a deliberately pinned docs verifier is recovered too. This locks the
    // B3F3D-006-H3 path: docs/manual types are not skipped merely because their
    // intent type is non-executable by default.
    const manualAfter = findEvidence(env, 'INT-MANUAL');
    assert.equal(manualAfter?.mechanical, true, 'B4: pinned manual verifier re-earns mechanical authority');
    assert.equal(manualAfter?.receipt?.selectorMatched, true, 'B4: pinned manual selector matched on recovery');
    assert.equal(manualAfter?.receipt?.exitCode, 0, 'B4: pinned manual verifier actually exited zero');
    assert.equal(manualAfter?.materialHash, material1, 'B4: recovered manual receipt binds current material');
    const docAfter = findEvidence(env, 'INT-DOC');
    assert.equal(docAfter?.mechanical, true, 'B4: pinned docs verifier re-earns mechanical authority');
    assert.equal(docAfter?.receipt?.selectorMatched, true, 'B4: pinned docs selector matched on recovery');
    assert.equal(docAfter?.materialHash, material1, 'B4: recovered docs receipt binds current material');

    // Gate cross-check: only successfully re-executed rows cover; failing/pinless stay uncovered.
    const cov = buildVerificationCoverage(env.store.readChecklist(env.storyId));
    assert.equal(cov.entries.find(e => e.intentRef === 'INT-REEXEC')?.status, 'covered', 'B: re-executed row covers');
    assert.equal(cov.entries.find(e => e.intentRef === 'INT-FAIL')?.status, 'non_mechanical', 'B: demoted-fail row is uncovered');
    assert.equal(cov.entries.find(e => e.intentRef === 'INT-PINLESS')?.status, 'non_mechanical', 'B: demoted pin-less row is uncovered');
    assert.equal(cov.entries.find(e => e.intentRef === 'INT-DOC')?.status, 'covered', 'B: recovered pinned docs row covers');
    assert.equal(cov.entries.find(e => e.intentRef === 'INT-MANUAL')?.status, 'covered', 'B: recovered pinned manual row covers');
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
// E. stale refresh execution fan-out — real child-process execution count.
// ════════════════════════════════════════════════════════════════════════════

function externalVerifierCommand(counterPath: string, outputPath: string, exitCodePath?: string, gitIndexRefreshRoot?: string): string {
  const script = [
    `require('fs').appendFileSync(${JSON.stringify(counterPath)}, 'x')`,
    ...(gitIndexRefreshRoot ? [
      `require('fs').utimesSync(${JSON.stringify(join(gitIndexRefreshRoot, 'packages/main/src/base.ts'))}, new Date(), new Date())`,
      // This disposable fixture deliberately changes its own index stat cache,
      // even when the outer validation disables optional writes to the real index.
      `require('child_process').execFileSync('git',['status','--short'],{cwd:${JSON.stringify(gitIndexRefreshRoot)},env:{...process.env,GIT_OPTIONAL_LOCKS:'1'}})`,
    ] : []),
    `process.stdout.write(require('fs').readFileSync(${JSON.stringify(outputPath)}, 'utf8'))`,
    ...(exitCodePath
      ? [`process.exit(Number(require('fs').readFileSync(${JSON.stringify(exitCodePath)}, 'utf8')))`]
      : []),
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
    kind?: VerificationEvidence['kind'];
    commandTimeoutMs?: number;
    commandTimeoutReason?: string;
    file?: string;
  },
): Promise<void> {
  await env.handlers.verification_evidence_add({
    storyId: env.storyId,
    itemId: 'CHK-001',
    intentRef: args.intentRef,
    kind: args.kind ?? 'integration_test',
    command: args.command,
    selector: args.selector,
    result: 'pass',
    note: `seed ${args.intentRef}`,
    ...(args.file ? { file: args.file } : {}),
    ...(args.commandTimeoutMs !== undefined ? { commandTimeoutMs: args.commandTimeoutMs } : {}),
    ...(args.commandTimeoutReason ? { commandTimeoutReason: args.commandTimeoutReason } : {}),
  });
}

function executionCount(counterPath: string): number {
  return readFileSync(counterPath, 'utf8').length;
}

function writeSelfAttestedDependencyManifest(
  root: string,
  path: string,
  files: string[],
  overrides: Partial<{
    fileClosure: 'complete' | 'partial';
    deterministic: boolean;
    dynamicFileReads: boolean;
    networkInputs: boolean;
    undeclaredEnvironment: boolean;
    sideEffects: boolean;
    environmentVariables: string[];
  }> = {},
): void {
  const environmentVariables = overrides.environmentVariables
    ?? Object.keys(effectiveValidationCommandEnvironment(process.env, undefined, root)).sort();
  write(root, path, `${JSON.stringify({
    schemaVersion: 'proof-or-stop.verifier-dependency-manifest.v1',
    fileClosure: overrides.fileClosure ?? 'complete',
    files,
    environmentVariables,
    deterministic: overrides.deterministic ?? true,
    dynamicFileReads: overrides.dynamicFileReads ?? false,
    networkInputs: overrides.networkInputs ?? false,
    undeclaredEnvironment: overrides.undeclaredEnvironment ?? false,
    sideEffects: overrides.sideEffects ?? false,
  }, null, 2)}\n`);
}

function writeCapsuleManifest(root: string, path: string, files: string[]): void {
  write(root, path, `${JSON.stringify({
    schemaVersion: 'proof-or-stop.verifier-dependency-manifest.v2',
    capsuleProfile: 'proof-or-stop.verification-reuse-capsule.v1',
    files,
  }, null, 2)}\n`);
}

function capsuleCommand(root: string, manifestPath: string, files: string[]): string {
  return buildVerificationReuseCapsuleInvocation({ cwd: root, manifestPath, files }).command;
}

async function partE(): Promise<{
  subprocessExecutionCount: number;
  executionReceiptCount: number;
  assertionReceiptCount: number;
  outputArtifactCount: number;
}> {
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
        // The real B-fe8f verifier runs git probes that refresh the index stat
        // cache. Force that otherwise-benign identity drift here: a per-row
        // stamper produces a second causal identity and later fails canonical
        // import, while representative-once grouping has one immutable stamp.
        const command = externalVerifierCommand(counter, output, undefined, env.root);
        await seedPinnedReceipt(env, { intentRef: 'INT-SHARED-A', command, selector: 'SHARED_OK' });
        await seedPinnedReceipt(env, { intentRef: 'INT-SHARED-B', command, selector: 'SHARED_OK' });
        writeFileSync(counter, '');
        commitRefreshDrift(env, 'same-key');
        const indexPath = resolve(env.root, git(env.root, ['rev-parse', '--git-path', 'index']));
        const indexBefore = createHash('sha256').update(readFileSync(indexPath)).digest('hex');

        await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
        const indexAfter = createHash('sha256').update(readFileSync(indexPath)).digest('hex');
        assert.equal(executionCount(counter), 1, 'E1: one exact execution key runs once for two stale rows');
        assert.notEqual(indexAfter, indexBefore, 'E1: verifier refreshed git index identity during the shared execution');
        const a = findEvidence(env, 'INT-SHARED-A');
        const b = findEvidence(env, 'INT-SHARED-B');
        assert.equal(a?.mechanical, true, 'E1: first shared row remains mechanical');
        assert.equal(b?.mechanical, true, 'E1: second shared row remains mechanical');
        assert.ok(a?.receipt && b?.receipt, 'E1: both rows receive receipts');
        assert.deepEqual(
          splitReceipt(env, 'INT-SHARED-A').executionReceipt,
          splitReceipt(env, 'INT-SHARED-B').executionReceipt,
          'E1: shared rows bind the same selector-free execution receipt',
        );
        assert.notEqual(
          splitReceipt(env, 'INT-SHARED-A').assertionReceipt.assertionReceiptDigest,
          splitReceipt(env, 'INT-SHARED-B').assertionReceipt.assertionReceiptDigest,
          'E1: shared execution still yields independent per-intent assertions',
        );
        assert.match(a!.receipt!.executedAt, /^\d{4}-\d{2}-\d{2}T/u, 'E1: receipt timestamp is an ISO execution time');
        assert.equal(a!.receipt!.outputDigest, sha256Hex('SHARED_OK\n'), 'E1: receipt digest binds the real shared output');
      } finally { cleanup(env); }
    }

    // E2: selectors and descriptive timeout provenance do not split execution.
    // Different effective timeouts still do: default, 5000ms, and 7000ms are
    // three executions. Per-row override reasons remain independently preserved;
    // a nonmatching selector fails closed without poisoning peer assertions.
    {
      const env = makeEnv('B-refresh-dedupe-distinct', [
        intent('INT-SELECTOR-A', 'cli'),
        intent('INT-SELECTOR-B', 'logic'),
        intent('INT-SELECTOR-MISS', 'cli'),
        intent('INT-TIMEOUT-A', 'cli'),
        intent('INT-TIMEOUT-B', 'browser'),
        intent('INT-PROVENANCE-C', 'logic'),
      ]);
      try {
        const counter = join(externalRoot, 'distinct-counter.txt');
        const output = join(externalRoot, 'distinct-output.txt');
        writeFileSync(counter, '');
        writeFileSync(output, 'SELECTOR_A SELECTOR_B SELECTOR_GONE\n');
        const command = externalVerifierCommand(counter, output, undefined, env.root);
        await seedPinnedReceipt(env, { intentRef: 'INT-SELECTOR-A', command, selector: 'SELECTOR_A' });
        await seedPinnedReceipt(env, {
          intentRef: 'INT-SELECTOR-B', command, selector: 'SELECTOR_B', kind: 'logic_test',
        });
        await seedPinnedReceipt(env, { intentRef: 'INT-SELECTOR-MISS', command, selector: 'SELECTOR_GONE' });
        await seedPinnedReceipt(env, {
          intentRef: 'INT-TIMEOUT-A', command, selector: 'SELECTOR_A', commandTimeoutMs: 5000,
          commandTimeoutReason: 'The dedupe smoke needs an attributable first timeout provenance.',
        });
        await seedPinnedReceipt(env, {
          intentRef: 'INT-TIMEOUT-B', command, selector: 'SELECTOR_A', kind: 'browser_test', commandTimeoutMs: 7000,
          commandTimeoutReason: 'The dedupe smoke needs an attributable second timeout provenance.',
        });
        await seedPinnedReceipt(env, {
          intentRef: 'INT-PROVENANCE-C', command, selector: 'SELECTOR_A', kind: 'logic_test', commandTimeoutMs: 5000,
          commandTimeoutReason: 'The dedupe smoke needs distinct provenance at the same timeout value.',
        });
        writeFileSync(counter, '');
        writeFileSync(output, 'SELECTOR_A SELECTOR_B\n');
        commitRefreshDrift(env, 'distinct-keys');
        const indexPath = resolve(env.root, git(env.root, ['rev-parse', '--git-path', 'index']));
        const indexBefore = createHash('sha256').update(readFileSync(indexPath)).digest('hex');

        await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
        assert.equal(executionCount(counter), 3, 'E2: only different effective timeout values split execution');
        assert.equal(
          findEvidence(env, 'INT-SELECTOR-A')?.receipt?.executedAt,
          findEvidence(env, 'INT-SELECTOR-B')?.receipt?.executedAt,
          'E2: different selectors share one execution timestamp',
        );
        const indexAfter = createHash('sha256').update(readFileSync(indexPath)).digest('hex');
        assert.notEqual(indexAfter, indexBefore, 'E2: raw verifier refreshed git index without cross-receipt identity mismatch');
        const selectorA = findEvidence(env, 'INT-SELECTOR-A');
        const selectorB = findEvidence(env, 'INT-SELECTOR-B');
        assert.equal(selectorA?.receipt?.selector, 'SELECTOR_A', 'E2: first selector owns its evidence verdict');
        assert.equal(selectorB?.receipt?.selector, 'SELECTOR_B', 'E2: second selector owns its evidence verdict');
        assert.equal(selectorA?.receipt?.selectorMatched, true, 'E2: first selector independently matched');
        assert.equal(selectorB?.receipt?.selectorMatched, true, 'E2: second selector independently matched');
        assert.notEqual(splitReceipt(env, 'INT-SELECTOR-A').assertionReceipt.assertionReceiptDigest,
          splitReceipt(env, 'INT-SELECTOR-B').assertionReceipt.assertionReceiptDigest,
          'E2: selector-specific evidence identities remain distinct over one raw run');
        assert.deepEqual(splitReceipt(env, 'INT-SELECTOR-A').executionReceipt,
          splitReceipt(env, 'INT-SELECTOR-B').executionReceipt,
          'E2: independent selector assertions preserve the same signed source execution');
        assert.equal(selectorA?.receipt?.outputDigest, selectorB?.receipt?.outputDigest,
          'E2: selector verdicts bind the same immutable raw output');
        assert.equal(findEvidence(env, 'INT-SELECTOR-MISS')?.mechanical, false,
          'E2: nonmatching selector is independently demoted');
        assert.equal(findEvidence(env, 'INT-SELECTOR-MISS')?.receipt, undefined,
          'E2: nonmatching selector receives no mechanical receipt');
        assert.equal(findEvidence(env, 'INT-TIMEOUT-A')?.receipt?.timeoutOverride?.timeoutMs, 5000,
          'E2: first timeout provenance survives refresh');
        assert.equal(findEvidence(env, 'INT-TIMEOUT-B')?.receipt?.timeoutOverride?.timeoutMs, 7000,
          'E2: second timeout provenance survives refresh');
        assert.equal(
          findEvidence(env, 'INT-TIMEOUT-A')?.receipt?.executedAt,
          findEvidence(env, 'INT-PROVENANCE-C')?.receipt?.executedAt,
          'E2: the same effective timeout shares execution despite different descriptive provenance',
        );
        assert.notEqual(
          findEvidence(env, 'INT-TIMEOUT-A')?.receipt?.timeoutOverride?.reason,
          findEvidence(env, 'INT-PROVENANCE-C')?.receipt?.timeoutOverride?.reason,
          'E2: each assertion retains its own audited timeout reason',
        );
      } finally { cleanup(env); }
    }

    // Independent selector verdicts must not turn shared execution into a false PASS.
    {
      const env = makeEnv('B-refresh-mixed-selectors', [
        intent('INT-MIX-A', 'cli'),
        intent('INT-MIX-B', 'cli'),
      ]);
      try {
        const counter = join(externalRoot, 'mixed-counter.txt');
        const output = join(externalRoot, 'mixed-output.txt');
        writeFileSync(counter, '');
        writeFileSync(output, 'MIX_A MIX_B\n');
        const command = externalVerifierCommand(counter, output);
        await seedPinnedReceipt(env, { intentRef: 'INT-MIX-A', command, selector: 'MIX_A' });
        await seedPinnedReceipt(env, { intentRef: 'INT-MIX-B', command, selector: 'MIX_B' });
        writeFileSync(counter, '');
        writeFileSync(output, 'MIX_A\n');
        commitRefreshDrift(env, 'mixed-selectors');

        await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
        assert.equal(executionCount(counter), 1, 'E2 mixed: selectors share one child execution');
        const a = findEvidence(env, 'INT-MIX-A');
        const b = findEvidence(env, 'INT-MIX-B');
        assert.equal(a?.mechanical, true, 'E2 mixed: matching selector retains mechanical evidence');
        assert.equal(a?.receipt?.selector, 'MIX_A', 'E2 mixed: passing receipt binds the matching selector');
        assert.equal(a?.receipt?.selectorMatched, true, 'E2 mixed: matching selector has a true verdict');
        assert.equal(b?.mechanical, false, 'E2 mixed: absent selector is demoted independently');
        assert.equal(b?.receipt, undefined, 'E2 mixed: shared execution never fabricates the absent selector PASS');
      } finally { cleanup(env); }
    }

    // E3: selectors are independent assertions over one successful execution.
    // Removing one selector demotes only that row; its sibling still passes.
    {
      const env = makeEnv('B-refresh-dedupe-failure', [
        intent('INT-KEEP', 'cli'),
        intent('INT-MISSING', 'cli'),
      ]);
      try {
        const counter = join(externalRoot, 'failure-counter.txt');
        const output = join(externalRoot, 'failure-output.txt');
        writeFileSync(counter, '');
        writeFileSync(output, `KEEP_OK MISSING_OK\n${'x'.repeat(20_000)}\n`);
        const command = externalVerifierCommand(counter, output);
        await seedPinnedReceipt(env, { intentRef: 'INT-KEEP', command, selector: 'KEEP_OK' });
        await seedPinnedReceipt(env, { intentRef: 'INT-MISSING', command, selector: 'MISSING_OK' });
        writeFileSync(counter, '');
        writeFileSync(output, `KEEP_OK\n${'x'.repeat(20_000)}\n`);
        commitRefreshDrift(env, 'independent-selector');

        await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
        assert.equal(executionCount(counter), 1, 'E3: two selectors share one successful execution');
        assert.equal(findEvidence(env, 'INT-KEEP')?.mechanical, true, 'E3: matching selector remains mechanical');
        assert.equal(findEvidence(env, 'INT-KEEP')?.receipt?.selectorMatched, true, 'E3: matching selector receives a receipt');
        assert.doesNotMatch(
          findEvidence(env, 'INT-KEEP')?.receipt?.outputTail ?? '',
          /KEEP_OK/u,
          'E3: selector is evaluated over complete output, not the bounded diagnostic tail',
        );
        assert.equal(findEvidence(env, 'INT-MISSING')?.mechanical, false, 'E3: absent selector demotes only its row');
        assert.equal(findEvidence(env, 'INT-MISSING')?.receipt, undefined, 'E3: absent selector receives no fabricated receipt');
      } finally { cleanup(env); }
    }

    // E3b: execution failure is shared. One nonzero subprocess produces no pass
    // stamp for any dependent assertion, even though every selector is present.
    {
      const env = makeEnv('B-refresh-dedupe-nonzero', [
        intent('INT-NONZERO-A', 'cli'),
        intent('INT-NONZERO-B', 'cli'),
      ]);
      try {
        const counter = join(externalRoot, 'nonzero-counter.txt');
        const output = join(externalRoot, 'nonzero-output.txt');
        const exitCode = join(externalRoot, 'nonzero-exit.txt');
        writeFileSync(counter, '');
        writeFileSync(output, 'NONZERO_A NONZERO_B\n');
        writeFileSync(exitCode, '0');
        const command = externalVerifierCommand(counter, output, exitCode);
        await seedPinnedReceipt(env, { intentRef: 'INT-NONZERO-A', command, selector: 'NONZERO_A' });
        await seedPinnedReceipt(env, { intentRef: 'INT-NONZERO-B', command, selector: 'NONZERO_B' });
        writeFileSync(counter, '');
        writeFileSync(exitCode, '3');
        commitRefreshDrift(env, 'shared-nonzero');

        const refreshOutput = await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
        assert.equal(executionCount(counter), 1, 'E3b: one shared nonzero execution is attempted once');
        const reasons: string[] = [];
        for (const ref of ['INT-NONZERO-A', 'INT-NONZERO-B']) {
          const row = findEvidence(env, ref);
          assert.equal(row?.mechanical, false, `E3b: ${ref} is demoted after the shared nonzero execution`);
          assert.equal(row?.receipt, undefined, `E3b: ${ref} receives no pass receipt after nonzero exit`);
          assert.match(row?.nonMechanicalReason ?? '', /shared execution was attempted and exited nonzero/u,
            `E3b: ${ref} persists truthful shared nonzero execution provenance`);
          assert.match(row?.nonMechanicalReason ?? '', /executionKey=[0-9a-f]{64}; exitCode=3/u,
            `E3b: ${ref} binds the failed execution identity and exit code`);
          assert.doesNotMatch(row?.nonMechanicalReason ?? '', /not re-run here/u,
            `E3b: ${ref} must not claim the attempted subprocess was skipped`);
          reasons.push(row?.nonMechanicalReason ?? '');
        }
        assert.equal(reasons[0], reasons[1], 'E3b: every dependent assertion records the same shared execution failure');
        assert.match(refreshOutput, /\[verification_refresh_execution_nonzero\]/u,
          'E3b: handler output reports the persisted nonzero execution failure diagnostic');
      } finally { cleanup(env); }
    }

    // E3c / F-015: timeout is observed from the production executor, not a stubbed
    // result. Both rows share one execution identity, so the one killed subprocess
    // invalidates every dependent assertion and no pass receipt can survive.
    {
      const env = makeEnv('B-refresh-dedupe-timeout', [
        intent('INT-TIMEOUT-SHARED-A', 'cli'),
        intent('INT-TIMEOUT-SHARED-B', 'cli'),
      ]);
      try {
        const counter = join(externalRoot, 'timeout-counter.txt');
        const output = join(externalRoot, 'timeout-output.txt');
        const delay = join(externalRoot, 'timeout-delay.txt');
        writeFileSync(counter, '');
        writeFileSync(output, 'TIMEOUT_SHARED_A TIMEOUT_SHARED_B\n');
        writeFileSync(delay, '0');
        const script = [
          `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x')`,
          `const delay=Number(require('fs').readFileSync(${JSON.stringify(delay)}, 'utf8'))`,
          `setTimeout(()=>process.stdout.write(require('fs').readFileSync(${JSON.stringify(output)}, 'utf8')),delay)`,
        ].join(';');
        const command = `node -e ${JSON.stringify(script)}`;
        const timeoutReason = 'Exercise the production timeout fan-out path with one shared execution identity.';
        await seedPinnedReceipt(env, {
          intentRef: 'INT-TIMEOUT-SHARED-A', command, selector: 'TIMEOUT_SHARED_A',
          commandTimeoutMs: 500, commandTimeoutReason: timeoutReason,
        });
        await seedPinnedReceipt(env, {
          intentRef: 'INT-TIMEOUT-SHARED-B', command, selector: 'TIMEOUT_SHARED_B',
          commandTimeoutMs: 500, commandTimeoutReason: timeoutReason,
        });
        writeFileSync(counter, '');
        writeFileSync(delay, '1500');
        commitRefreshDrift(env, 'shared-timeout');

        const refreshOutput = await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
        assert.equal(executionCount(counter), 1, 'E3c: shared execution times out through exactly one production subprocess');
        const timeoutRows = ['INT-TIMEOUT-SHARED-A', 'INT-TIMEOUT-SHARED-B']
          .map(ref => ({ ref, row: findEvidence(env, ref) }));
        const passReceiptCount = timeoutRows.filter(({ row }) => row?.mechanical === true && row.receipt !== undefined).length;
        for (const { ref, row } of timeoutRows) {
          assert.equal(row?.mechanical, false, `E3c: ${ref} is demoted after the shared timeout`);
          assert.equal(row?.receipt, undefined, `E3c: ${ref} receives no pass receipt after timeout`);
          assert.match(row?.nonMechanicalReason ?? '', /shared execution was attempted and timed out/u,
            `E3c: ${ref} persists truthful shared timeout provenance`);
          assert.match(row?.nonMechanicalReason ?? '', /executionKey=[0-9a-f]{64}; timeoutMs=500/u,
            `E3c: ${ref} binds the failed execution identity and armed timeout`);
          assert.doesNotMatch(row?.nonMechanicalReason ?? '', /not re-run here/u,
            `E3c: ${ref} must not claim the attempted subprocess was skipped`);
        }
        assert.equal(timeoutRows[0]?.row?.nonMechanicalReason, timeoutRows[1]?.row?.nonMechanicalReason,
          'E3c: every dependent assertion records the same shared timeout failure');
        assert.equal(passReceiptCount, 0, 'E3c: no dependent assertion retains a passing receipt');
        assert.match(refreshOutput, /\[verification_refresh_execution_timeout\]/u,
          'E3c: handler output reports the persisted timeout execution failure diagnostic');
        console.log(
          'baa5f-execution-failure-fans-out timeout=true subprocessExecutionCount=1 assertionsFailed=2 passReceiptCount=0 ' +
          `persistedReason=${JSON.stringify(timeoutRows[0]?.row?.nonMechanicalReason)}`,
        );
      } finally { cleanup(env); }
    }

    // E4 / B-aa5f RED: reproduce the B-fe8f amplification shape through the real
    // stale-refresh handler. Seeding intentionally runs every intent once, so reset
    // both counters before drift; the measured count below is refresh-owned only.
    // The output for each command contains every selector in its group, allowing the
    // fixture to distinguish duplicate scheduling from selector assertion failure.
    {
      const fullIntentCount = 58;
      const redIntentCount = 13;
      const intents = [
        ...Array.from({ length: fullIntentCount }, (_, index) => intent(`FULL-${index}`, 'cli')),
        ...Array.from({ length: redIntentCount }, (_, index) => intent(`RED-${index}`, 'cli')),
      ];
      const env = makeEnv('B-aa5f-fanout-71x2', intents);
      try {
        const fullCounter = join(externalRoot, 'baa5f-full-counter.txt');
        const redCounter = join(externalRoot, 'baa5f-red-counter.txt');
        const fullOutput = join(externalRoot, 'baa5f-full-output.txt');
        const redOutput = join(externalRoot, 'baa5f-red-output.txt');
        writeFileSync(fullCounter, '');
        writeFileSync(redCounter, '');
        writeFileSync(fullOutput, `${Array.from({ length: fullIntentCount }, (_, index) => `FULL_SELECTOR_${index}`).join('\n')}\n`);
        writeFileSync(redOutput, `${Array.from({ length: redIntentCount }, (_, index) => `RED_SELECTOR_${index}`).join('\n')}\n`);
        const fullCommand = externalVerifierCommand(fullCounter, fullOutput);
        const redCommand = externalVerifierCommand(redCounter, redOutput);

        await env.handlers.verification_evidence_batch_add({
          storyId: env.storyId,
          evidences: [
            ...Array.from({ length: fullIntentCount }, (_, index) => ({
              itemId: 'CHK-001',
              intentRef: `FULL-${index}`,
              kind: 'integration_test' as const,
              command: fullCommand,
              selector: `FULL_SELECTOR_${index}`,
              result: 'pass' as const,
              note: `seed FULL-${index}`,
            })),
            ...Array.from({ length: redIntentCount }, (_, index) => ({
              itemId: 'CHK-001',
              intentRef: `RED-${index}`,
              kind: 'integration_test' as const,
              command: redCommand,
              selector: `RED_SELECTOR_${index}`,
              result: 'pass' as const,
              note: `seed RED-${index}`,
            })),
          ],
        });
        assert.equal(
          executionCount(fullCounter) + executionCount(redCounter),
          2,
          'E4 fixture setup: batch fan-out seeds 71 assertions with two executions',
        );

        writeFileSync(fullCounter, '');
        writeFileSync(redCounter, '');
        commitRefreshDrift(env, 'baa5f-71x2');
        await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });

        const subprocessExecutionCount = executionCount(fullCounter) + executionCount(redCounter);
        const evidence = env.store.readChecklist(env.storyId).items[0].verificationEvidence ?? [];
        const splitReceipts = evidence
          .map(row => row.receipt)
          .filter((receipt): receipt is VerificationSplitReceipt => isSplitVerificationReceipt(receipt));
        const assertionReceiptCount = splitReceipts.filter(receipt =>
          validateVerificationReceipt(env.root, receipt, {
            intentRef: receipt.assertionReceipt.intentRef,
            selector: receipt.assertionReceipt.intentRef.startsWith('FULL-')
              ? `FULL_SELECTOR_${receipt.assertionReceipt.intentRef.slice('FULL-'.length)}`
              : `RED_SELECTOR_${receipt.assertionReceipt.intentRef.slice('RED-'.length)}`,
            storyId: env.storyId,
          }).ok
          && receipt.assertionReceipt.matched
          && receipt.executionReceipt.exitCode === 0,
        ).length;
        const executionReceiptCount = new Set(
          splitReceipts.map(receipt => receipt.executionReceipt.executionReceiptDigest),
        ).size;
        const outputArtifactCount = listArtifacts(env.root, 'verification-output').length;
        assert.equal(evidence.filter(row =>
          row.mechanical === true
          && row.result === 'pass'
          && row.receipt?.exitCode === 0
          && row.receipt.selectorMatched === true,
        ).length, 71, 'E4: compatibility projection remains readable for all 71 rows');
        console.log(
          `B-aa5f fanout actualExecutionCount=${subprocessExecutionCount} ` +
          `expectedExecutionCount=2 executionReceiptCount=${executionReceiptCount} ` +
          `assertionReceiptCount=${assertionReceiptCount} outputArtifactCount=${outputArtifactCount}`,
        );
        assert.equal(executionReceiptCount, 2, 'E4: two subprocesses produce two unique execution receipts');
        assert.equal(assertionReceiptCount, 71, 'E4: all 71 immutable selectors receive independent passing receipts');
        assert.equal(outputArtifactCount, 2, 'E4: two command outputs are stored as two content-addressed artifacts');
        assert.equal(
          subprocessExecutionCount,
          2,
          'E4: 71 intents over two commands launch exactly two refresh-owned verifier executions',
        );
        return { subprocessExecutionCount, executionReceiptCount, assertionReceiptCount, outputArtifactCount };
      } finally { cleanup(env); }
    }
  } finally {
    rmSync(externalRoot, { recursive: true, force: true });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// F. CHK-003 — input-scoped reuse with explicit complete dependency manifests
// ════════════════════════════════════════════════════════════════════════════
async function partF(): Promise<void> {
  // Two deterministic commands with disjoint closures: unrelated Story drift
  // reuses both, then changing only A's closure executes A and reuses B.
  {
    const env = makeEnv('B-aa5f-input-scoped-reuse', [
      intent('INT-REUSE-A', 'cli'),
      intent('INT-REUSE-B', 'cli'),
    ]);
    try {
      const inputA = 'packages/main/src/reuse-a.txt';
      const inputB = 'packages/main/src/reuse-b.txt';
      const manifestA = 'packages/main/reuse-a.verification-dependencies.json';
      const manifestB = 'packages/main/reuse-b.verification-dependencies.json';
      write(env.root, inputA, 'REUSE_A\n');
      write(env.root, inputB, 'REUSE_B\n');
      writeCapsuleManifest(env.root, manifestA, [inputA]);
      writeCapsuleManifest(env.root, manifestB, [inputB]);
      git(env.root, ['add', inputA, inputB, manifestA, manifestB]);
      git(env.root, ['commit', '-m', 'add verifier dependency closures']);
      const commandA = capsuleCommand(env.root, manifestA, [inputA]);
      const commandB = capsuleCommand(env.root, manifestB, [inputB]);
      const capsuleProbe = await runSingleAllowlistedCommand(commandA, env.root, { cwd: env.root, timeoutMs: 5000 });
      assert.equal(capsuleProbe.code, 0, `F1: canonical capsule seed probe failed: ${capsuleProbe.output}`);
      await seedPinnedReceipt(env, { intentRef: 'INT-REUSE-A', command: commandA, selector: 'REUSE_A', file: manifestA });
      await seedPinnedReceipt(env, { intentRef: 'INT-REUSE-B', command: commandB, selector: 'REUSE_B', file: manifestB });
      const initialA = reusableReceipt(env, 'INT-REUSE-A').executionReceipt.executionReceiptDigest;
      const initialB = reusableReceipt(env, 'INT-REUSE-B').executionReceipt.executionReceiptDigest;
      const preReuseDecision = planVerificationExecutionReuse({
        projectRoot: env.root,
        storyId: env.storyId,
        priorReceipt: reusableReceipt(env, 'INT-REUSE-A'),
        intentRef: 'INT-REUSE-A',
        selector: 'REUSE_A',
        command: commandA,
        cwd: reusableReceipt(env, 'INT-REUSE-A').executionReceipt.cwd,
        effectiveTimeoutMs: reusableReceipt(env, 'INT-REUSE-A').executionReceipt.effectiveTimeoutMs,
        manifestPath: manifestA,
        freshnessHashBinding: verificationFreshnessHashBinding(env, 'INT-REUSE-A'),
      });
      const storedPreReuse = reusableReceipt(env, 'INT-REUSE-A').executionReceipt;
      assert.equal(preReuseDecision.reusable, true,
        `F1 preflight: complete receipt should be reusable (${preReuseDecision.reason}; stored=${storedPreReuse.executionIdentityDigest}, current=${preReuseDecision.identity.executionIdentityDigest})`);

      env.launchCounter.count = 0;
      commitRefreshDrift(env, 'input-unrelated');
      await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
      const unrelated = [reusableReceipt(env, 'INT-REUSE-A'), reusableReceipt(env, 'INT-REUSE-B')];
      const unrelatedExecutions = env.launchCounter.count;
      const unrelatedReuseReceipts = new Set(unrelated.map(receipt => receipt.reuseReceipt?.reuseReceiptDigest).filter(Boolean)).size;
      assert.equal(unrelatedExecutions, 0, 'F1: unrelated Story drift launches no verifier subprocess');
      assert.equal(unrelatedReuseReceipts, 2, 'F1: both command identities receive auditable reuse receipts');
      assert.equal(unrelated[0].executionReceipt.executionReceiptDigest, initialA, 'F1: reuse never rewrites execution A');
      assert.equal(unrelated[1].executionReceipt.executionReceiptDigest, initialB, 'F1: reuse never rewrites execution B');
      for (const [receipt, intentRef, selector] of [
        [unrelated[0], 'INT-REUSE-A', 'REUSE_A'],
        [unrelated[1], 'INT-REUSE-B', 'REUSE_B'],
      ] as const) {
        const validation = validateVerificationReceipt(env.root, receipt, { intentRef, selector, storyId: env.storyId });
        assert.equal(validation.ok, true, `F1: ${intentRef} reuse receipt and immutable artifact validate`);
        assert.equal(validation.reusable, true, `F1: ${intentRef} retains a complete reusable identity`);
      }
      const tamperedReuse = structuredClone(unrelated[0]);
      tamperedReuse.reuseReceipt!.reusedAt = '2099-01-01T00:00:00.000Z';
      assert.equal(
        validateVerificationReceipt(env.root, tamperedReuse, {
          intentRef: 'INT-REUSE-A', selector: 'REUSE_A', storyId: env.storyId,
        }).ok,
        false,
        'F1: tampering with an auditable reuse receipt fails closed',
      );
      const legacyReuse = planVerificationExecutionReuse({
        projectRoot: env.root,
        storyId: env.storyId,
        priorReceipt: {
          exitCode: 0,
          outputDigest: sha256Hex('REUSE_A\n'),
          outputTail: 'REUSE_A\n',
          selectorMatched: true,
          executedAt: '2026-09-03T00:00:00.000Z',
          timeoutMs: unrelated[0].executionReceipt.effectiveTimeoutMs,
        },
        intentRef: 'INT-REUSE-A',
        selector: 'REUSE_A',
        command: commandA,
        cwd: unrelated[0].executionReceipt.cwd,
        effectiveTimeoutMs: unrelated[0].executionReceipt.effectiveTimeoutMs,
        manifestPath: manifestA,
        freshnessHashBinding: verificationFreshnessHashBinding(env, 'INT-REUSE-A'),
      });
      assert.equal(legacyReuse.reusable, false, 'F1: a legacy combined receipt cannot be promoted into reuse');
      assert.equal(legacyReuse.reason, 'legacy_or_nonreusable_receipt', 'F1: legacy reuse denial is explicit');
      console.log(`unrelatedDrift executions=${unrelatedExecutions} reuseReceipts=${unrelatedReuseReceipts}`);

      write(env.root, inputA, 'REUSE_A changed\n');
      git(env.root, ['add', inputA]);
      git(env.root, ['commit', '-m', 'change only verifier A input closure']);
      env.launchCounter.count = 0;
      await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
      const changedA = reusableReceipt(env, 'INT-REUSE-A');
      const unchangedB = reusableReceipt(env, 'INT-REUSE-B');
      const changed = [changedA, unchangedB];
      const changedExecutions = env.launchCounter.count;
      const changedReuseReceipts = new Set(changed.map(receipt => receipt.reuseReceipt?.reuseReceiptDigest).filter(Boolean)).size;
      assert.equal(changedExecutions, 1, 'F2: one changed input closure launches exactly one verifier subprocess');
      assert.equal(changedReuseReceipts, 1, 'F2: the unchanged command receives exactly one reuse receipt');
      assert.notEqual(changedA.executionReceipt.executionReceiptDigest, initialA, 'F2: changed closure produces a new execution');
      assert.equal(unchangedB.executionReceipt.executionReceiptDigest, initialB, 'F2: unchanged closure retains immutable prior execution');
      console.log(`oneInputChanged executions=${changedExecutions} reuseReceipts=${changedReuseReceipts}`);
    } finally { cleanup(env); }
  }

  // An explicitly partial closure executes on every stale refresh. The same
  // assessor rejects every other uncertainty class before reuse planning.
  {
    const env = makeEnv('B-aa5f-incomplete-closure', [intent('INT-INCOMPLETE', 'cli')]);
    try {
      const input = 'packages/main/src/incomplete.txt';
      const manifest = 'packages/main/incomplete.verification-dependencies.json';
      write(env.root, input, 'INCOMPLETE_OK\n');
      writeCapsuleManifest(env.root, manifest, [input, input]);
      git(env.root, ['add', input, manifest]);
      git(env.root, ['commit', '-m', 'add intentionally partial verifier closure']);
      const command = capsuleCommand(env.root, manifest, [input, input]);
      await seedPinnedReceipt(env, { intentRef: 'INT-INCOMPLETE', command, selector: 'INCOMPLETE_OK', file: manifest });
      const before = reusableReceipt(env, 'INT-INCOMPLETE').executionReceipt.executionReceiptDigest;
      env.launchCounter.count = 0;
      commitRefreshDrift(env, 'incomplete-closure');
      await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
      const after = reusableReceipt(env, 'INT-INCOMPLETE');
      assert.equal(after.reuseReceipt, undefined, 'F3: partial closure cannot mint a reuse receipt');
      assert.equal(after.executionReceipt.reuseDeniedReason, 'incomplete_input_closure', 'F3: receipt records stable denial reason');
      assert.notEqual(after.executionReceipt.executionReceiptDigest, before, 'F3: partial closure forces a fresh execution');
      assert.equal(env.launchCounter.count, 1, 'F3: partial closure launches one real subprocess');
      console.log('reuse=denied reason=incomplete_input_closure');

      assert.equal(assessVerifierDependencyManifest({ gitCwd: env.root }).reason, 'missing_dependency_manifest');
      const missingInputManifest = 'packages/main/missing-input.verification-dependencies.json';
      writeCapsuleManifest(env.root, missingInputManifest, ['packages/main/src/does-not-exist.txt']);
      const missingInputCommand = capsuleCommand(env.root, missingInputManifest, ['packages/main/src/does-not-exist.txt']);
      const missingInputIdentity = prepareVerificationExecutionIdentity({
        command: missingInputCommand,
        cwd: env.root,
        effectiveTimeoutMs: 5000,
        manifestPath: missingInputManifest,
      });
      assert.equal(missingInputIdentity.reason, 'missing_input', 'F3: a missing capsule input denies reuse');
    } finally { cleanup(env); }
  }

  // Authority and sandbox boundary: v1 is self-attestation only, and a v2
  // manifest cannot bless arbitrary code. Only the byte-exact policy capsule
  // receives a complete input identity and the executor's closed environment.
  {
    const env = makeEnv('B-aa5f-capsule-authority', [intent('INT-CAPSULE', 'cli')]);
    let escapedAbsolutePath: string | undefined;
    // The smoke itself may be launched by runSingleAllowlistedCommand, whose
    // ordinary-command tracer arrives through NODE_OPTIONS. Permission probes
    // must exercise the requested capability, not fail earlier while preloading
    // that outer tracer under the probe's deliberately narrow read grant.
    const inheritedNodeOptions = process.env.NODE_OPTIONS;
    delete process.env.NODE_OPTIONS;
    try {
      const declared = 'packages/main/src/capsule-declared.txt';
      const hidden = 'packages/main/src/capsule-hidden.txt';
      const v1 = 'packages/main/self-attested.verification-dependencies.json';
      const v2 = 'packages/main/capsule.verification-dependencies.json';
      const preload = 'packages/main/src/capsule-preload.cjs';
      write(env.root, declared, 'CAPSULE_OK\n');
      write(env.root, hidden, 'HIDDEN\n');
      write(env.root, preload, "console.log('INJECTED_PRELOAD')\n");
      writeSelfAttestedDependencyManifest(env.root, v1, [declared]);
      writeCapsuleManifest(env.root, v2, [declared]);
      const arbitrary = `node -e ${JSON.stringify(`process.stdout.write(require('fs').readFileSync(${JSON.stringify(declared)},'utf8'))`)}`;
      const underDeclared = `node -e ${JSON.stringify(`const f=require('fs');process.stdout.write(f.readFileSync(${JSON.stringify(declared)},'utf8')+f.readFileSync(${JSON.stringify(hidden)},'utf8'))`)}`;
      const capsule = capsuleCommand(env.root, v2, [declared]);
      const identity = (command: string, manifestPath: string) => prepareVerificationExecutionIdentity({
        command, cwd: env.root, effectiveTimeoutMs: 5000, manifestPath,
      });
      assert.equal(identity(arbitrary, v1).reason, 'untrusted_dependency_manifest',
        'F4: self-attested v1 completeness has no reuse authority');
      assert.equal(identity(underDeclared, v1).reason, 'untrusted_dependency_manifest',
        'F4: an under-declared arbitrary reader cannot conceal an input');
      assert.equal(identity(arbitrary, v2).reason, 'untrusted_dependency_manifest',
        'F4: a declarative manifest cannot authorize arbitrary JavaScript');
      assert.equal(identity(capsule, v2).reusable, true, 'F4: exact policy-owned capsule is reusable');
      console.log('reuse authority selfAttested=denied arbitraryCommand=denied capsule=admitted');

      const allowedFlagsDescriptor = Object.getOwnPropertyDescriptor(process, 'allowedNodeEnvironmentFlags');
      assert.ok(allowedFlagsDescriptor, 'F4: Node exposes an allowedNodeEnvironmentFlags feature descriptor');
      try {
        Object.defineProperty(process, 'allowedNodeEnvironmentFlags', {
          configurable: true,
          value: new Set(['--permission']),
        });
        assert.equal(verificationReuseCapsuleEnforcementSupported(), false,
          'F4: a runtime missing any required permission primitive is unsupported');
        assert.throws(
          () => buildVerificationReuseCapsuleInvocation({ cwd: env.root, manifestPath: v2, files: [declared] }),
          /unsupported_capsule_enforcement/u,
          'F4: unsupported permission enforcement fails closed before constructing a capsule command',
        );
        assert.equal(identity(arbitrary, v2).reason, 'unsupported_capsule_enforcement',
          'F4: unsupported permission enforcement cannot mint reusable identity');
      } finally {
        Object.defineProperty(process, 'allowedNodeEnvironmentFlags', allowedFlagsDescriptor);
      }
      assert.equal(verificationReuseCapsuleEnforcementSupported(), true,
        'F4: this runner must provide every permission primitive required by the reusable capsule; unsupported runtimes fail closed before capsule construction');
      const restricted = (
        source: string,
        options: { readPaths?: string[]; flags?: string[] } = {},
      ) => [
        'node', '--permission',
        ...(options.flags ?? []),
        ...(options.readPaths ?? [join(env.root, declared)]).map(path => `--allow-fs-read=${path}`),
        '-e', JSON.stringify(source),
      ].join(' ');
      const assertPermissionDenial = async (
        label: string,
        source: string,
        options: { readPaths?: string[]; flags?: string[]; pattern?: RegExp } = {},
      ) => {
        const command = restricted(source, options);
        const denied = await runSingleAllowlistedCommand(command, env.root, { cwd: env.root, timeoutMs: 5000 });
        assert.equal(denied.timedOut, false, `F4: ${label} attempt completes as an explicit denial, not a timeout`);
        assert.notEqual(denied.code, 0, `F4: Node permission model denies ${label}`);
        assert.match(denied.output, options.pattern ?? /ERR_ACCESS_DENIED|Access to this API has been restricted/u,
          `F4: ${label} reports a permission denial rather than an unrelated runtime failure`);
        assert.equal(identity(command, v2).reusable, false,
          `F4: the non-canonical ${label} attempt cannot mint reusable evidence`);
      };

      await assertPermissionDenial(
        'an undeclared file read',
        `process.stdout.write(require('fs').readFileSync(${JSON.stringify(join(env.root, hidden))},'utf8'))`,
      );
      await assertPermissionDenial(
        'filesystem writes',
        `require('fs').writeFileSync(${JSON.stringify(join(env.root, declared))},'FORGED')`,
      );
      await assertPermissionDenial(
        'subprocesses',
        "require('child_process').execFileSync(process.execPath,['-e','process.exit(0)'])",
      );
      await assertPermissionDenial(
        'network access',
        "require('net').connect({host:'127.0.0.1',port:9})",
      );
      await assertPermissionDenial(
        'worker creation',
        "new (require('node:worker_threads').Worker)('0',{eval:true})",
      );

      const fakeAddon = join(env.root, 'packages/main/src/capsule-native.node');
      writeFileSync(fakeAddon, 'not a native addon');
      await assertPermissionDenial(
        'native addon loading',
        `process.dlopen({exports:{}},${JSON.stringify(fakeAddon)})`,
        { readPaths: [fakeAddon], pattern: /ERR_DLOPEN_DISABLED|loading addons is disabled/u },
      );
      await assertPermissionDenial(
        'FFI loading',
        "require('node:ffi').dlopen('/definitely/missing-proof-or-stop-library.so')",
        { flags: ['--experimental-ffi'], pattern: /ERR_ACCESS_DENIED|--allow-ffi/u },
      );
      await assertPermissionDenial(
        'WASI creation',
        "new (require('node:wasi').WASI)({version:'preview1'})",
        { pattern: /ERR_ACCESS_DENIED|--allow-wasi/u },
      );
      await assertPermissionDenial(
        'inspector activation',
        "require('node:inspector').open(0)",
        { pattern: /ERR_ACCESS_DENIED|--allow-inspector/u },
      );

      // Path traversal and symlink aliases are exercised through the exact capsule
      // command, then rejected by the mechanically validated input closure before
      // they can authorize reuse. The command may read what its explicit OS-level
      // permission grants; that never upgrades the invalid manifest into authority.
      const escapedName = `capsule-escaped-${process.pid}.txt`;
      const escaped = `../${escapedName}`;
      escapedAbsolutePath = join(env.root, escaped);
      writeFileSync(escapedAbsolutePath, 'ESCAPED\n');
      const escapedManifest = 'packages/main/escaped.verification-dependencies.json';
      writeCapsuleManifest(env.root, escapedManifest, [escaped]);
      const escapedCommand = capsuleCommand(env.root, escapedManifest, [escaped]);
      const escapedAttempt = await runSingleAllowlistedCommand(escapedCommand, env.root, { cwd: env.root, timeoutMs: 5000 });
      assert.equal(escapedAttempt.timedOut, false, 'F4: escaped-path capsule attempt actually completes');
      assert.equal(escapedAttempt.code, 0, 'F4: escaped-path attack is genuinely exercised at the process boundary');
      assert.equal(escapedAttempt.output, 'ESCAPED\n', 'F4: OS permission alone would read the escaped input');
      assert.equal(identity(escapedCommand, escapedManifest).reason, 'unsafe_input_path',
        'F4: escaped path cannot mint reusable evidence even when explicitly granted to the process');

      const symlink = 'packages/main/src/capsule-link.txt';
      symlinkSync(join(env.root, hidden), join(env.root, symlink));
      const symlinkManifest = 'packages/main/symlink.verification-dependencies.json';
      writeCapsuleManifest(env.root, symlinkManifest, [symlink]);
      const symlinkCommand = capsuleCommand(env.root, symlinkManifest, [symlink]);
      const symlinkAttempt = await runSingleAllowlistedCommand(symlinkCommand, env.root, { cwd: env.root, timeoutMs: 5000 });
      assert.equal(symlinkAttempt.timedOut, false, 'F4: symlink capsule attempt actually completes');
      assert.equal(symlinkAttempt.code, 0, 'F4: symlink-read attack is genuinely exercised at the process boundary');
      assert.equal(symlinkAttempt.output, 'HIDDEN\n', 'F4: OS permission alone follows the symlink to hidden input');
      assert.equal(identity(symlinkCommand, symlinkManifest).reason, 'non_regular_input',
        'F4: symlink input cannot mint reusable evidence');

      const dynamicImport = capsule.replace(' -e ', ` --import=${join(env.root, preload)} -e `);
      const widened = capsule.replace(' --permission ', ' --permission --allow-net --allow-child-process ');
      assert.equal(identity(dynamicImport, v2).reason, 'untrusted_dependency_manifest',
        'F4: loader/dynamic-import injection changes canonical argv and loses authority');
      assert.equal(identity(widened, v2).reason, 'untrusted_dependency_manifest',
        'F4: permission widening changes canonical argv and loses authority');

      const previousNodeOptions = process.env.NODE_OPTIONS;
      process.env.NODE_OPTIONS = `--require=${join(env.root, preload)}`;
      try {
        const closed = await runSingleAllowlistedCommand(capsule, env.root, { cwd: env.root, timeoutMs: 5000 });
        assert.equal(closed.code, 0, `F4: canonical capsule executes under enforced permissions (${closed.output})`);
        assert.equal(closed.output, 'CAPSULE_OK\n', 'F4: ambient NODE_OPTIONS preload is absent from closed environment');
      } finally {
        if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
        else process.env.NODE_OPTIONS = previousNodeOptions;
      }
      console.log('capsule sandbox undeclaredRead=denied env=closed network=denied child=denied write=denied dynamicImport=denied injection=denied');
      console.log('capsule direct attacks enforcement=supported_true_denial unsupported=fail_closed escapedPath=nonreusable symlink=nonreusable worker=denied addon=denied ffi=denied wasi=denied inspector=denied');
    } finally {
      if (inheritedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = inheritedNodeOptions;
      if (escapedAbsolutePath) rmSync(escapedAbsolutePath, { force: true });
      cleanup(env);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// G. CHK-005 — producer locking, launch/issue TOCTOU, compatibility boundaries
// ════════════════════════════════════════════════════════════════════════════
async function partG(): Promise<void> {
  // Two REAL concurrent handler calls contend on one execution identity. The
  // waiter rereads the publisher's checklist state inside the producer lock.
  {
    const env = makeEnv('B-aa5f-concurrent-refresh', [
      intent('INT-CONCURRENT-A', 'cli'),
      intent('INT-CONCURRENT-B', 'cli'),
    ]);
    try {
      const input = 'packages/main/src/concurrent-input.txt';
      const manifest = 'packages/main/concurrent.verification-dependencies.json';
      write(env.root, input, 'CONCURRENT_A seed\nCONCURRENT_B seed\n');
      writeCapsuleManifest(env.root, manifest, [input]);
      git(env.root, ['add', input, manifest]);
      git(env.root, ['commit', '-m', 'add concurrent verifier closure']);
      const command = capsuleCommand(env.root, manifest, [input]);
      await seedPinnedReceipt(env, { intentRef: 'INT-CONCURRENT-A', command, selector: 'CONCURRENT_A', file: manifest });
      await seedPinnedReceipt(env, { intentRef: 'INT-CONCURRENT-B', command, selector: 'CONCURRENT_B', file: manifest });
      write(env.root, input, 'CONCURRENT_A current\nCONCURRENT_B current\n');
      git(env.root, ['add', input]);
      git(env.root, ['commit', '-m', 'change concurrent verifier input']);
      env.launchCounter.count = 0;
      const results = await Promise.all([
        env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId }),
        env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId }),
      ]);
      assert.equal(results.length, 2, 'G1: both concurrent handler calls complete');
      const receiptsValid = [
        ['INT-CONCURRENT-A', 'CONCURRENT_A'],
        ['INT-CONCURRENT-B', 'CONCURRENT_B'],
      ].filter(([intentRef, selector]) => {
        const receipt = findEvidence(env, intentRef)?.receipt;
        return Boolean(receipt && validateVerificationReceipt(env.root, receipt, {
          intentRef, selector, storyId: env.storyId,
        }).ok);
      }).length;
      assert.equal(env.launchCounter.count, 1, 'G1: producer lock permits exactly one subprocess');
      assert.equal(receiptsValid, 2, 'G1: both independent assertions consume valid immutable evidence');
      console.log(`concurrentRefreshCalls=2 subprocessExecutionCount=${env.launchCounter.count} receiptsValid=${receiptsValid}`);
    } finally { cleanup(env); }
  }

  // Every producer entrypoint shares the same selector-free key. These are real
  // overlapping handler calls, not receipt-derived lock proxies.
  {
    const slowCommand = `node -e "setTimeout(() => console.log('MARKER_OK'), 100)"`;
    const env = makeEnv('B-aa5f-concurrent-add', [intent('INT-ADD', 'cli')]);
    try {
      const add = () => env.handlers.verification_evidence_add({
        storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-ADD', kind: 'integration_test',
        command: slowCommand, selector: SELECTOR, result: 'pass', note: 'concurrent add publication',
      });
      await Promise.all([add(), add()]);
      assert.equal(env.launchCounter.count, 1, 'G1b: add/add overlap launches one subprocess');
      assert.equal(validateVerificationReceipt(env.root, splitReceipt(env, 'INT-ADD'), {
        intentRef: 'INT-ADD', selector: SELECTOR, storyId: env.storyId,
      }).ok, true, 'G1b: add/add waiter consumes valid evidence');
    } finally { cleanup(env); }
  }
  {
    const slowCommand = `node -e "setTimeout(() => console.log('MARKER_OK'), 100)"`;
    const env = makeEnv('B-aa5f-concurrent-run', [intent('INT-RUN', 'cli', { command: slowCommand, selector: SELECTOR })]);
    try {
      await Promise.all([
        env.handlers.verification_run({ storyId: env.storyId, intentRef: 'INT-RUN' }),
        env.handlers.verification_run({ storyId: env.storyId, intentRef: 'INT-RUN' }),
      ]);
      assert.equal(env.launchCounter.count, 1, 'G1c: run/run overlap launches one subprocess');
      assert.equal(validateVerificationReceipt(env.root, splitReceipt(env, 'INT-RUN'), {
        intentRef: 'INT-RUN', selector: SELECTOR, storyId: env.storyId,
      }).ok, true, 'G1c: run/run waiter consumes valid evidence');
    } finally { cleanup(env); }
  }
  {
    const command = `node -e "setTimeout(() => console.log('CROSS_A\\nCROSS_B'), 100)"`;
    const env = makeEnv('B-aa5f-cross-intent-add-run', [
      intent('INT-A', 'cli'),
      intent('INT-B', 'cli', { command, selector: 'CROSS_B' }),
    ]);
    try {
      await Promise.all([
        env.handlers.verification_evidence_add({
          storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-A', kind: 'integration_test',
          command, selector: 'CROSS_A', result: 'pass', note: 'cross-intent add producer',
        }),
        env.handlers.verification_run({ storyId: env.storyId, intentRef: 'INT-B', note: 'cross-intent run waiter' }),
      ]);
      const receiptA = splitReceipt(env, 'INT-A');
      const receiptB = splitReceipt(env, 'INT-B');
      assert.equal(env.launchCounter.count, 1, 'G1d: add(A)/run(B) same identity launches exactly once');
      assert.equal(receiptA.executionReceipt.executionReceiptDigest, receiptB.executionReceipt.executionReceiptDigest,
        'G1d: cross-intent waiter shares only the immutable execution receipt');
      assert.notEqual(receiptA.assertionReceipt.assertionReceiptDigest, receiptB.assertionReceipt.assertionReceiptDigest,
        'G1d: each selector receives an independently signed assertion');
      assert.equal(validateVerificationReceipt(env.root, receiptA, {
        intentRef: 'INT-A', selector: 'CROSS_A', storyId: env.storyId,
      }).ok, true, 'G1d: producer assertion validates independently');
      assert.equal(validateVerificationReceipt(env.root, receiptB, {
        intentRef: 'INT-B', selector: 'CROSS_B', storyId: env.storyId,
      }).ok, true, 'G1d: waiter assertion validates independently');
      console.log('crossIntent addRun launches=1 sharedExecution=true independentAssertions=true');
    } finally { cleanup(env); }
  }
  {
    const blockerCommand = `node -e "setTimeout(() => console.log('REUSE_LOCK_BLOCKER'), 100)"`;
    let releaseBlocker!: () => void;
    let reportBlockerHeld!: () => void;
    let holdBlocker = false;
    const blockerRelease = new Promise<void>(resolveRelease => { releaseBlocker = resolveRelease; });
    const blockerHeld = new Promise<void>(resolveHeld => { reportBlockerHeld = resolveHeld; });
    const env = makeEnv('B-aa5f-cross-intent-reused-publication', [
      intent('INT-REUSE-LOCK-BLOCKER', 'cli'),
      intent('INT-REUSE-PUBLISHER', 'cli'),
      intent('INT-REUSE-WAITER', 'cli'),
    ], async command => {
      if (holdBlocker && command === blockerCommand) {
        reportBlockerHeld();
        await blockerRelease;
      }
    });
    try {
      const input = 'packages/main/src/reused-publication-input.txt';
      const manifest = 'packages/main/reused-publication.verification-dependencies.json';
      write(env.root, input, 'REUSE_PUBLISHER\nREUSE_WAITER\n');
      writeCapsuleManifest(env.root, manifest, [input]);
      git(env.root, ['add', input, manifest]);
      git(env.root, ['commit', '-m', 'add reused publication closure']);
      const command = capsuleCommand(env.root, manifest, [input]);
      await seedPinnedReceipt(env, {
        intentRef: 'INT-REUSE-LOCK-BLOCKER', command: blockerCommand, selector: 'REUSE_LOCK_BLOCKER',
      });
      await seedPinnedReceipt(env, {
        intentRef: 'INT-REUSE-PUBLISHER', command, selector: 'REUSE_PUBLISHER', file: manifest,
      });
      await seedPinnedReceipt(env, {
        intentRef: 'INT-REUSE-WAITER', command, selector: 'REUSE_WAITER', file: manifest,
      });
      // Keep the waiter's immutable pin and manifest provenance, but remove its
      // receipt and mark the row failed so only the other intent is a stale-refresh
      // publisher while both calls contend on the same execution identity.
      const checklist = env.store.readChecklist(env.storyId);
      const waiterSeed = checklist.items[0].verificationEvidence
        ?.find(evidence => evidence.intentRef === 'INT-REUSE-WAITER');
      assert.ok(waiterSeed, 'G1e: waiter seed evidence exists');
      delete waiterSeed.receipt;
      waiterSeed.mechanical = false;
      waiterSeed.result = 'fail';
      env.store.writeChecklist(env.storyId, checklist);
      commitRefreshDrift(env, 'cross-intent-reused-publication');
      env.launchCounter.count = 0;
      holdBlocker = true;
      const refresh = env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
      await blockerHeld;
      const waiterRun = env.handlers.verification_run({
        storyId: env.storyId, intentRef: 'INT-REUSE-WAITER', note: 'consume cross-intent reused publication',
      });
      await new Promise<void>(resolveTurn => setImmediate(resolveTurn));
      releaseBlocker();
      await Promise.all([refresh, waiterRun]);
      const publisher = reusableReceipt(env, 'INT-REUSE-PUBLISHER');
      const waiter = reusableReceipt(env, 'INT-REUSE-WAITER');
      assert.equal(env.launchCounter.count, 1,
        'G1e: only the deliberate lock-holder launches; the reused-publication waiter does not');
      assert.equal(waiter.publicationMode, 'reused',
        'G1e: waiter preserves reused publication mode instead of relabelling it executed');
      assert.equal(waiter.reuseReceiptDigest, publisher.reuseReceiptDigest,
        'G1e: waiter binds the exact signed reuse lineage published under the shared key');
      assert.equal(waiter.executionReceipt.executionReceiptDigest, publisher.executionReceipt.executionReceiptDigest,
        'G1e: waiter shares the publisher immutable execution');
      assert.notEqual(waiter.assertionReceipt.assertionReceiptDigest, publisher.assertionReceipt.assertionReceiptDigest,
        'G1e: waiter still receives an independently signed selector assertion');
      assert.equal(validateVerificationReceipt(env.root, waiter, {
        intentRef: 'INT-REUSE-WAITER', selector: 'REUSE_WAITER', storyId: env.storyId,
      }).ok, true, 'G1e: cross-intent reused publication validates with intact lineage');
      console.log('crossIntent reusedPublication waiterLaunches=0 lineage=preserved');
    } finally { cleanup(env); }
  }
  {
    const command = `node -e "console.log('BATCH_A\\nBATCH_B')"`;
    const env = makeEnv('B-aa5f-batch-fanout-lock', [intent('INT-BATCH-A', 'cli'), intent('INT-BATCH-B', 'cli')]);
    try {
      await env.handlers.verification_evidence_batch_add({ storyId: env.storyId, evidences: [
        { itemId: 'CHK-001', intentRef: 'INT-BATCH-A', kind: 'integration_test', command, selector: 'BATCH_A', result: 'pass', note: 'batch fanout A' },
        { itemId: 'CHK-001', intentRef: 'INT-BATCH-B', kind: 'integration_test', command, selector: 'BATCH_B', result: 'pass', note: 'batch fanout B' },
      ] });
      assert.equal(env.launchCounter.count, 1, 'G1d: same-key batch fans out one subprocess');
      assert.equal(splitReceipt(env, 'INT-BATCH-A').executionReceipt.executionReceiptDigest,
        splitReceipt(env, 'INT-BATCH-B').executionReceipt.executionReceiptDigest,
        'G1d: batch assertions share the immutable execution receipt');
    } finally { cleanup(env); }
  }
  {
    const env = makeEnv('B-aa5f-concurrent-batch-refresh', [intent('INT-CROSS', 'cli')]);
    try {
      const input = 'packages/main/src/cross-input.txt';
      const manifest = 'packages/main/cross.verification-dependencies.json';
      write(env.root, input, 'CROSS_OK seed\n');
      writeCapsuleManifest(env.root, manifest, [input]);
      git(env.root, ['add', input, manifest]);
      git(env.root, ['commit', '-m', 'add cross-entry closure']);
      const command = capsuleCommand(env.root, manifest, [input]);
      await seedPinnedReceipt(env, { intentRef: 'INT-CROSS', command, selector: 'CROSS_OK', file: manifest });
      write(env.root, input, 'CROSS_OK current\n');
      git(env.root, ['add', input]);
      git(env.root, ['commit', '-m', 'change cross-entry closure']);
      env.launchCounter.count = 0;
      await Promise.all([
        env.handlers.verification_evidence_batch_add({ storyId: env.storyId, evidences: [{
          itemId: 'CHK-001', intentRef: 'INT-CROSS', kind: 'integration_test', file: manifest,
          command, selector: 'CROSS_OK', result: 'pass', note: 'cross entry batch publication',
        }] }),
        env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId }),
      ]);
      assert.equal(env.launchCounter.count, 1, 'G1e: batch/refresh overlap launches one subprocess');
      assert.equal(validateVerificationReceipt(env.root, splitReceipt(env, 'INT-CROSS'), {
        intentRef: 'INT-CROSS', selector: 'CROSS_OK', storyId: env.storyId,
      }).ok, true, 'G1e: batch/refresh consumers observe valid evidence');
      console.log('producer lock matrix addAdd=1 runRun=1 batchRefresh=1 receiptsValid=3');
    } finally { cleanup(env); }
  }

  // The command mutates its declared input only in the refresh run. The launch
  // snapshot and pre-issuance snapshot therefore differ; no artifact or receipt
  // from that run may be accepted.
  {
    let armMutation = false;
    const input = 'packages/main/src/toctou-input.txt';
    const env = makeEnv('B-aa5f-input-changed-during-run', [intent('INT-TOCTOU', 'cli')], (_command, cwd) => {
      if (armMutation) writeFileSync(join(cwd, input), 'CHANGED_DURING_EXECUTION\n');
    });
    try {
      const manifest = 'packages/main/toctou.verification-dependencies.json';
      write(env.root, input, 'MUTABLE_OK SAFE\n');
      writeCapsuleManifest(env.root, manifest, [input]);
      git(env.root, ['add', input, manifest]);
      git(env.root, ['commit', '-m', 'add toctou verifier closure']);
      const command = capsuleCommand(env.root, manifest, [input]);
      await seedPinnedReceipt(env, { intentRef: 'INT-TOCTOU', command, selector: 'MUTABLE_OK', file: manifest });
      const artifactsBefore = listArtifacts(env.root, 'verification-output').length;
      write(env.root, input, 'MUTABLE_OK TRIGGER\n');
      git(env.root, ['add', input]);
      git(env.root, ['commit', '-m', 'arm toctou mutation']);
      armMutation = true;
      const output = await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
      assert.match(output, /receiptIssued=false reason=input_changed_during_execution/,
        'G2: input mutation returns the stable fail-closed diagnostic');
      assert.equal(listArtifacts(env.root, 'verification-output').length, artifactsBefore,
        'G2: changed input issues no output artifact');
      assert.equal(findEvidence(env, 'INT-TOCTOU')?.receipt, undefined,
        'G2: changed input issues no execution/assertion/reuse receipt');
      console.log('receiptIssued=false reason=input_changed_during_execution');
    } finally { cleanup(env); }
  }

  // Ordinary evidence writes remain immutable. B-1482's separately authorized
  // narrowing entry point is intentionally outside this write path.
  {
    const env = makeEnv('B-aa5f-selector-compatibility', [intent('INT-SELECTOR', 'cli')]);
    try {
      await seedPinnedReceipt(env, { intentRef: 'INT-SELECTOR', command: PASS_CMD, selector: SELECTOR });
      await expectRejection(env.handlers.verification_evidence_add({
        storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-SELECTOR', kind: 'integration_test',
        command: PASS_CMD, selector: 'MARKER', result: 'pass', note: 'widen selector',
      }), /receipt_selector_mismatch/, 'G3 widening');
      await expectRejection(env.handlers.verification_evidence_add({
        storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-SELECTOR', kind: 'integration_test',
        command: PASS_CMD, selector: 'UNPROVED_REPIN', result: 'pass', note: 'substitute selector',
      }), /receipt_selector_mismatch/, 'G3 substitution/unproved repin');
      assert.equal(splitReceipt(env, 'INT-SELECTOR').assertionReceipt.selectorDigest, sha256Hex(SELECTOR),
        'G3: refused transitions leave the original selector receipt immutable');
      console.log('selector compatibility PASS');
    } finally { cleanup(env); }
  }

  // Missing material/Story hashes force execution. A missing input digest makes
  // the receipt invalid and leaves the row demoted; neither path can reuse it.
  {
    const env = makeEnv('B-aa5f-partial-hash-compatibility', [intent('INT-HASH', 'cli')]);
    try {
      const input = 'packages/main/src/hash-input.txt';
      const manifest = 'packages/main/hash.verification-dependencies.json';
      write(env.root, input, 'HASH_OK\n');
      writeCapsuleManifest(env.root, manifest, [input]);
      git(env.root, ['add', input, manifest]);
      git(env.root, ['commit', '-m', 'add hash verifier closure']);
      const command = capsuleCommand(env.root, manifest, [input]);
      await seedPinnedReceipt(env, { intentRef: 'INT-HASH', command, selector: 'HASH_OK', file: manifest });

      let checklist = env.store.readChecklist(env.storyId);
      delete checklist.items[0].verificationEvidence![0].materialHash;
      env.store.writeChecklist(env.storyId, checklist);
      commitRefreshDrift(env, 'missing-material-hash');
      env.launchCounter.count = 0;
      await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
      assert.equal(env.launchCounter.count, 1, 'G4: missing material hash cannot authorize reuse');
      assert.equal(reusableReceipt(env, 'INT-HASH').reuseReceipt, undefined, 'G4: missing material hash minted no reuse receipt');

      checklist = env.store.readChecklist(env.storyId);
      delete checklist.items[0].verificationEvidence![0].storyFilesHash;
      env.store.writeChecklist(env.storyId, checklist);
      commitRefreshDrift(env, 'missing-story-hash');
      env.launchCounter.count = 0;
      await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
      assert.equal(env.launchCounter.count, 1, 'G4: missing Story hash cannot authorize reuse');

      for (const field of ['headHash', 'materialHash', 'storyFilesHash'] as const) {
        checklist = env.store.readChecklist(env.storyId);
        checklist.items[0].verificationEvidence![0][field] = 'f';
        env.store.writeChecklist(env.storyId, checklist);
        env.launchCounter.count = 0;
        await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
        assert.equal(env.launchCounter.count, 1, `G4: malformed non-empty ${field} cannot authorize reuse`);
        assert.equal(reusableReceipt(env, 'INT-HASH').reuseReceipt, undefined,
          `G4: malformed non-empty ${field} minted no reuse receipt`);
      }

      checklist = env.store.readChecklist(env.storyId);
      const receipt = checklist.items[0].verificationEvidence![0].receipt as VerificationReceiptBundleV5;
      receipt.executionReceipt.evidenceInputDigest = null;
      env.store.writeChecklist(env.storyId, checklist);
      commitRefreshDrift(env, 'missing-input-hash');
      env.launchCounter.count = 0;
      await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
      assert.equal(env.launchCounter.count, 0, 'G4: invalid partial input binding is not promoted or executed as trusted evidence');
      assert.equal(findEvidence(env, 'INT-HASH')?.receipt, undefined, 'G4: partial input receipt remains fail-closed/demoted');
      console.log('partial-hash PASS');
    } finally { cleanup(env); }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// H. CHK-004 — lifecycle coverage validates the authoritative V5 bundle and its V3 execution component
// ════════════════════════════════════════════════════════════════════════════
function gateCoverage(env: Env, checklist: ChecklistData = env.store.readChecklist(env.storyId)) {
  return buildVerificationCoverage(checklist, undefined, undefined, {
    receiptAdmissibility: createVerificationEvidenceGateEvaluator(env.root, env.storyId),
  });
}

function gateDiagnostic(env: Env, checklist: ChecklistData): string {
  return gateCoverage(env, checklist).entries[0]?.evidence?.nonMechanicalReason ?? '';
}

async function partH(): Promise<void> {
  // Fresh real execution without a complete manifest is admissible only via
  // strict Story/material freshness. The same gate rejects prose, legacy, and
  // caller-shaped records even when they claim PASS-shaped fields.
  {
    const env = makeEnv('B-aa5f-lifecycle-strict-fallback', [
      intent('INT-GATE', 'cli', { command: PASS_CMD, selector: SELECTOR }),
    ]);
    try {
      await env.handlers.verification_run({ storyId: env.storyId, intentRef: 'INT-GATE', note: 'gate baseline' });
      assert.equal(gateCoverage(env).missingRequired, 0,
        'H1: a validated fresh real execution remains admissible under strict fallback');

      const baseline = env.store.readChecklist(env.storyId);
      const narrative = structuredClone(baseline);
      narrative.items[0].verificationEvidence![0] = {
        ...narrative.items[0].verificationEvidence![0],
        mechanical: undefined,
        receipt: undefined,
        result: 'pass',
        note: 'PASS narrative only',
      };
      assert.match(gateDiagnostic(env, narrative), /verification_receipt_missing/,
        'H1: narrative PASS cannot satisfy an executable lifecycle gate');

      const legacy = structuredClone(baseline);
      legacy.items[0].verificationEvidence![0].receipt = {
        exitCode: 0,
        outputDigest: sha256Hex('MARKER_OK\n'),
        outputTail: 'MARKER_OK\n',
        selectorMatched: true,
        executedAt: '2026-09-03T00:00:00.000Z',
      };
      assert.match(gateDiagnostic(env, legacy), /verification_receipt_legacy/,
        'H1: legacy combined receipt remains readable but cannot satisfy lifecycle admission');

      const callerShaped = structuredClone(baseline);
      callerShaped.items[0].verificationEvidence![0].receipt = {
        schemaVersion: 'proof-or-stop.verification-receipt-bundle.v4',
        exitCode: 0,
        selectorMatched: true,
      } as any;
      assert.match(gateDiagnostic(env, callerShaped), /verification_receipt_invalid/,
        'H1: caller-authored receipt-shaped object fails closed with a stable diagnostic');

      const partialHash = structuredClone(baseline);
      delete partialHash.items[0].verificationEvidence![0].storyFilesHash;
      assert.match(gateDiagnostic(env, partialHash), /verification_receipt_stale/,
        'H1: partial freshness hashes cannot satisfy strict fallback');
      for (const field of ['headHash', 'materialHash', 'storyFilesHash'] as const) {
        const malformedHash = structuredClone(baseline);
        malformedHash.items[0].verificationEvidence![0][field] = 'f';
        assert.match(gateDiagnostic(env, malformedHash), /verification_receipt_stale/,
          `H1: malformed non-empty ${field} cannot satisfy lifecycle admission`);
      }

      // F-001: change material on main, then merge it. The Story-owned hash is
      // unchanged, so the generic advisory path would accept this; strict
      // fallback must instead reject and execute the untrusted verifier once.
      git(env.root, ['checkout', 'main']);
      write(env.root, 'packages/main/src/base.ts', 'export const base = "changed-on-main";\n');
      git(env.root, ['add', 'packages/main/src/base.ts']);
      git(env.root, ['commit', '-m', 'material drift outside story diff']);
      git(env.root, ['checkout', 'work']);
      git(env.root, ['merge', '--no-edit', 'main']);
      env.launchCounter.count = 0;
      assert.ok(gateCoverage(env).missingRequired > 0,
        'H1: untrusted closure is stale when material changes even if storyFilesHash stays equal');
      await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
      assert.equal(env.launchCounter.count, 1,
        'H1: strict material drift with equal Story hash reruns the verifier exactly once');
      assert.equal(gateCoverage(env).missingRequired, 0,
        'H1: the new strict execution becomes admissible at current material');
    } finally { cleanup(env); }
  }

  // Complete closure: gates recompute the current input identity and validate
  // artifact/execution/assertion/reuse integrity rather than trusting fields.
  {
    const env = makeEnv('B-aa5f-lifecycle-complete', [intent('INT-COMPLETE', 'cli')]);
    try {
      const input = 'packages/main/src/gate-input.txt';
      const manifest = 'packages/main/gate.verification-dependencies.json';
      write(env.root, input, 'GATE_OK\n');
      writeCapsuleManifest(env.root, manifest, [input]);
      git(env.root, ['add', input, manifest]);
      git(env.root, ['commit', '-m', 'add gate verifier closure']);
      const command = capsuleCommand(env.root, manifest, [input]);
      await seedPinnedReceipt(env, { intentRef: 'INT-COMPLETE', command, selector: 'GATE_OK', file: manifest });
      assert.equal(gateCoverage(env).missingRequired, 0, 'H2: valid V5 bundle with V3 execution and V2 assertion satisfies gate');
      const executedBaseline = structuredClone(reusableReceipt(env, 'INT-COMPLETE'));

      const recomputedGraph = structuredClone(executedBaseline) as any;
      recomputedGraph.executionReceipt.durationMs += 1;
      const { executionReceiptDigest: _executionDigest, authenticity: _executionAuth, ...executionSubject } = recomputedGraph.executionReceipt;
      recomputedGraph.executionReceipt.executionReceiptDigest = computeCanonicalDigest(executionSubject);
      recomputedGraph.assertionReceipt.executionReceiptDigest = recomputedGraph.executionReceipt.executionReceiptDigest;
      const { assertionReceiptDigest: _assertionDigest, authenticity: _assertionAuth, ...assertionSubject } = recomputedGraph.assertionReceipt;
      recomputedGraph.assertionReceipt.assertionReceiptDigest = computeCanonicalDigest(assertionSubject);
      recomputedGraph.bundleBinding.executionReceiptDigest = recomputedGraph.executionReceipt.executionReceiptDigest;
      recomputedGraph.bundleBinding.assertionReceiptDigest = recomputedGraph.assertionReceipt.assertionReceiptDigest;
      recomputedGraph.bundleReceiptDigest = computeCanonicalDigest(recomputedGraph.bundleBinding);
      const recomputedChecklist = env.store.readChecklist(env.storyId);
      recomputedChecklist.items[0].verificationEvidence![0].receipt = recomputedGraph;
      assert.match(gateDiagnostic(env, recomputedChecklist), /verification_receipt_invalid/,
        'H2: recomputing every canonical graph digest cannot forge the trusted execution/assertion signatures');

      const attacker = generateEd25519KeyPair();
      const keySwap = structuredClone(executedBaseline) as any;
      for (const [domain, record] of [
        ['execution', keySwap.executionReceipt],
        ['assertion', keySwap.assertionReceipt],
      ] as const) {
        const { authenticity: _trustedAuthenticity, ...signedRecord } = record;
        record.authenticity = {
          schemaVersion: 'proof-or-stop.verification-record-authenticity.v1',
          domain,
          keyId: `sha256:${signingCanonicalDigest(attacker.publicKey)}`,
          signerPublicKey: attacker.publicKey,
          signature: signCanonical({
            schemaVersion: 'proof-or-stop.verification-record.v1', domain, record: signedRecord,
          }, attacker.privateKey),
        };
      }
      const keySwapChecklist = env.store.readChecklist(env.storyId);
      keySwapChecklist.items[0].verificationEvidence![0].receipt = keySwap;
      assert.match(gateDiagnostic(env, keySwapChecklist), /verification_receipt_invalid/,
        'H2: a self-consistent attacker key swap cannot replace the git-common-dir trusted signer');

      const receipt = reusableReceipt(env, 'INT-COMPLETE');
      const objectPath = join(env.root, '.proof-or-stop', 'evidence', 'objects', 'sha256', `${receipt.executionReceipt.outputArtifact.artifactDigest}.json`);
      const originalObject = readFileSync(objectPath, 'utf8');
      const tamperedObject = JSON.parse(originalObject) as { payload: { output: string } };
      tamperedObject.payload.output = 'FORGED_GATE_OK\n';
      writeFileSync(objectPath, `${JSON.stringify(tamperedObject, null, 2)}\n`);
      assert.match(gateDiagnostic(env, env.store.readChecklist(env.storyId)), /verification_receipt_invalid/,
        'H2: lifecycle gate rejects tampered full-output artifact');
      writeFileSync(objectPath, originalObject);

      const assertionTamper = env.store.readChecklist(env.storyId);
      (assertionTamper.items[0].verificationEvidence![0].receipt as VerificationReceiptBundleV5)
        .assertionReceipt.matched = false;
      assert.match(gateDiagnostic(env, assertionTamper), /verification_receipt_invalid/,
        'H2: lifecycle gate rejects tampered assertion receipt');

      const executionTamper = env.store.readChecklist(env.storyId);
      (executionTamper.items[0].verificationEvidence![0].receipt as VerificationReceiptBundleV5)
        .executionReceipt.durationMs += 1;
      assert.match(gateDiagnostic(env, executionTamper), /verification_receipt_invalid/,
        'H2: lifecycle gate rejects tampered execution receipt');

      const receiptTailMismatch = env.store.readChecklist(env.storyId);
      const tailReceipt = receiptTailMismatch.items[0].verificationEvidence![0].receipt as VerificationReceiptBundleV5;
      assert.equal(validateVerificationReceipt(env.root, tailReceipt, {
        intentRef: 'INT-COMPLETE', selector: 'GATE_OK', storyId: env.storyId,
      }).ok, true, 'H2: the current receipt is valid before changing only its display summary');
      tailReceipt.outputTail += 'UNRECORDED_DISPLAY_SUMMARY\n';
      const tailValidation = validateVerificationReceipt(env.root, tailReceipt, {
        intentRef: 'INT-COMPLETE', selector: 'GATE_OK', storyId: env.storyId,
      });
      assert.equal(tailValidation.ok, false, 'H2: authoritative validator rejects a top-level outputTail mismatch');
      assert.ok(tailValidation.errors.includes('receipt outputTail compatibility mismatch'),
        'H2: display summary must equal the canonical tail of complete authenticated output');
      assert.match(gateDiagnostic(env, receiptTailMismatch), /verification_receipt_invalid/,
        'H2: lifecycle gate rejects the top-level outputTail mismatch');

      const receiptSelectorTamper = env.store.readChecklist(env.storyId);
      const tamperedSelectorReceipt = receiptSelectorTamper.items[0].verificationEvidence![0]
        .receipt as VerificationReceiptBundleV5;
      tamperedSelectorReceipt.selector = 'FORGED_SELECTOR_NEVER_EXECUTED';
      env.store.writeChecklist(env.storyId, receiptSelectorTamper);
      const persistedSelectorTamper = reusableReceipt(env, 'INT-COMPLETE');
      const selectorValidation = validateVerificationReceipt(env.root, persistedSelectorTamper, {
        intentRef: 'INT-COMPLETE', selector: 'GATE_OK', storyId: env.storyId,
      });
      assert.equal(selectorValidation.ok, false,
        'H2: authoritative validator rejects a persisted top-level selector-only tamper');
      assert.ok(selectorValidation.errors.includes('receipt selector compatibility digest mismatch'),
        'H2: selector projection is bound to the independently signed assertion selector digest');
      assert.match(gateDiagnostic(env, env.store.readChecklist(env.storyId)), /verification_receipt_invalid/,
        'H2: lifecycle gate rejects the persisted top-level selector-only tamper');
      const restoredSelectorReceipt = env.store.readChecklist(env.storyId);
      restoredSelectorReceipt.items[0].verificationEvidence![0].receipt = structuredClone(executedBaseline);
      env.store.writeChecklist(env.storyId, restoredSelectorReceipt);

      const malformedDigest = env.store.readChecklist(env.storyId);
      (malformedDigest.items[0].verificationEvidence![0].receipt as VerificationReceiptBundleV5)
        .executionReceipt.environmentDigest = 'f';
      assert.match(gateDiagnostic(env, malformedDigest), /verification_receipt_invalid/,
        'H2: lifecycle gate rejects malformed non-empty receipt digests');

      const selectorTamper = env.store.readChecklist(env.storyId);
      selectorTamper.items[0].verificationIntent!.happy![0].verification!.selector = 'FORGED_SELECTOR';
      assert.match(gateDiagnostic(env, selectorTamper), /verification_receipt_invalid/,
        'H2: lifecycle gate rejects selector substitution');

      write(env.root, 'packages/main/src/unrelated-gate-drift.ts', 'export const unrelated = true;\n');
      git(env.root, ['add', 'packages/main/src/unrelated-gate-drift.ts']);
      git(env.root, ['commit', '-m', 'unrelated gate drift']);
      env.launchCounter.count = 0;
      await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
      assert.equal(env.launchCounter.count, 0, 'H2: unchanged complete input closure reuses without a subprocess');
      assert.ok(reusableReceipt(env, 'INT-COMPLETE').reuseReceipt, 'H2: refresh publishes an auditable reuse receipt');
      assert.equal(gateCoverage(env).missingRequired, 0, 'H2: valid reuse lineage satisfies lifecycle gate');

      const strippedReuse = env.store.readChecklist(env.storyId);
      delete (strippedReuse.items[0].verificationEvidence![0].receipt as any).reuseReceipt;
      assert.match(gateDiagnostic(env, strippedReuse), /verification_receipt_invalid/,
        'H2: deleting the complete reuseReceipt from a reused publication fails closed');

      const injectedReuse = env.store.readChecklist(env.storyId);
      injectedReuse.items[0].verificationEvidence![0].receipt = structuredClone(executedBaseline);
      (injectedReuse.items[0].verificationEvidence![0].receipt as any).reuseReceipt =
        structuredClone(reusableReceipt(env, 'INT-COMPLETE').reuseReceipt);
      assert.match(gateDiagnostic(env, injectedReuse), /verification_receipt_invalid/,
        'H2: adding reuse lineage to an executed publication fails closed');

      const reuseTamper = env.store.readChecklist(env.storyId);
      (reuseTamper.items[0].verificationEvidence![0].receipt as VerificationReceiptBundleV5)
        .reuseReceipt!.reuseReceiptDigest = '0'.repeat(64);
      assert.match(gateDiagnostic(env, reuseTamper), /verification_receipt_invalid/,
        'H2: lifecycle gate rejects tampered reuse receipt');

      const recomputedReuse = env.store.readChecklist(env.storyId);
      const recomputedBundle = recomputedReuse.items[0].verificationEvidence![0].receipt as VerificationReceiptBundleV5;
      assert.ok(recomputedBundle.reuseReceipt, 'H2: recompute attack requires reused publication');
      recomputedBundle.reuseReceipt.reusedAt = '2099-01-01T00:00:00.000Z';
      const { reuseReceiptDigest: _oldReuseDigest, authenticity: _reuseAuthenticity, ...recomputedSubject } = recomputedBundle.reuseReceipt;
      recomputedBundle.reuseReceipt.reuseReceiptDigest = computeCanonicalDigest(recomputedSubject);
      assert.match(gateDiagnostic(env, recomputedReuse), /verification_receipt_invalid/,
        'H2: recomputing a mutated reuse digest cannot repair assertion/bundle cross-links');

      const modeTamper = env.store.readChecklist(env.storyId);
      (modeTamper.items[0].verificationEvidence![0].receipt as VerificationReceiptBundleV5)
        .assertionReceipt.publicationMode = 'executed';
      assert.match(gateDiagnostic(env, modeTamper), /verification_receipt_invalid/,
        'H2: mutating an assertion publication-mode cross-link fails closed');

      write(env.root, input, 'GATE_CHANGED\n');
      assert.match(gateDiagnostic(env, env.store.readChecklist(env.storyId)), /verification_receipt_stale/,
        'H2: changed declared input invalidates prior execution evidence before refresh');
      env.launchCounter.count = 0;
      await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
      assert.equal(env.launchCounter.count, 1,
        'H2: lost capsule authority is classified stale and forces one real execution even when Git hashes match');
      assert.equal(findEvidence(env, 'INT-COMPLETE')?.receipt, undefined,
        'H2: failed assertion after authority loss is demoted rather than freshness-restamped');
      console.log('lostCapsuleAuthority stale=true executions=1 receiptRestamped=false');
      console.log('receiptSignatures execution=PASS assertion=PASS reuse=PASS graphRecompute=denied keySwap=denied');
      console.log('lifecycle receipt admissibility PASS');
    } finally { cleanup(env); }
  }
}

// CHK-007: live failures, not edits to stored identity digests. Each assertion is
// collected independently so the first defect cannot hide the other RED cases.
async function collectRepairChecks(body: (check: (label: string, fn: () => unknown | Promise<unknown>) => Promise<void>) => Promise<void>): Promise<void> {
  const errors: string[] = [];
  await body(async (label, fn) => {
    try { await fn(); } catch (error) {
      const detail = `${label}: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(detail);
      console.error(`[repair assertion FAIL] ${detail}`);
    }
  });
  assert.equal(errors.length, 0, errors.join('\n'));
}

function evidenceContext(env: Env) {
  return { store: env.store, root: env.root, scanRoot: join(env.root, 'packages/main') };
}

async function doneIdentityPreview(env: Env): Promise<{ transcript: string; blockedAt?: string }> {
  const story = env.store.readStory(env.storyId);
  const previousCwd = process.cwd();
  env.store.writeStory(env.storyId, { ...story, phase: 'TEST', worktree: { path: env.root, branch: 'work', createdAt: story.createdAt } });
  try {
    process.chdir(env.root);
    return await createDonePrepareHandlers(evidenceContext(env)).done_prepare({
      storyId: env.storyId, dryRun: true, mergeMain: false, refreshStale: false,
      validate: false, build: false, json: true,
    });
  } finally {
    process.chdir(previousCwd);
    env.store.writeStory(env.storyId, story);
  }
}

// F078 extends the existing live-toolchain contract without changing its frozen
// CHK-007 matrix: actual PATH-selected node bytes, not the host's process.execPath.
async function partLNodePathIdentity(): Promise<void> {
  const external = mkdtempSync(join(tmpdir(), 'baa5f-node-path-'));
  const bin = join(external, 'bin');
  const emptyBin = join(external, 'empty-bin');
  const log = join(external, 'children.jsonl');
  mkdirSync(bin); mkdirSync(emptyBin); writeFileSync(log, '');
  const priorPath = process.env.PATH;
  const fixedPath = `${bin}:${priorPath ?? ''}`;
  const writeWrapper = (name: string, version: string) => {
    const body = `require('fs').appendFileSync(${JSON.stringify(log)},JSON.stringify({tag:${JSON.stringify(name)},pid:process.pid})+'\\n');` +
      `console.log('NODE_PATH_A NODE_PATH_B',${JSON.stringify(version)});`;
    writeFileSync(join(bin, name), `#!${process.execPath}\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  writeWrapper('node', 'NODE_CONTROL'); writeWrapper('npm', 'STABLE_CONTROL');
  process.env.PATH = fixedPath;
  const refs = ['NODE-A', 'NODE-B', 'STABLE-A', 'STABLE-B'];
  const env = makeEnv('B-aa5f-node-path', refs.map(ref => intent(ref, 'cli')));
  try {
    write(env.root, '.gitignore', '.proof-or-stop/evidence/\n.proof-or-stop/runtime/\n.proof-or-stop/locks/\n.proof-or-stop/learning/runtime-memory-pack-cache/\n');
    git(env.root, ['add', '.gitignore']); git(env.root, ['commit', '-m', 'ignore node-path fixture runtime']);
    for (let i = 0; i < refs.length; i++) await seedPinnedReceipt(env, {
      intentRef: refs[i], command: i < 2 ? 'node --version' : 'npm --version',
      selector: i % 2 ? 'NODE_PATH_B' : 'NODE_PATH_A',
    });
    const before = env.store.readChecklist(env.storyId);
    const binding = verificationFreshnessHashBinding(env, refs[0]);
    const old = splitReceipt(env, refs[0]);
    const timeoutMs = old.executionReceipt.effectiveTimeoutMs;
    assert.equal(gateCoverage(env).entries.filter(row => row.status === 'covered').length, 4,
      'F078 authentic ordinary unchanged-input controls are current');
    assert.match((await doneIdentityPreview(env)).transcript, /staleEvidenceRefresh: PASS/);
    assert.match(refreshStaleEvidenceMetadataOnly(evidenceContext(env), env.storyId, true), /No stale verification evidence/);
    const normalRun = await runSingleAllowlistedCommand('node --version', env.root, { cwd: env.root, timeoutMs });
    assert.equal(normalRun.code, 0); assert.match(normalRun.output, /NODE_CONTROL/);
    console.log('F078 normal-control authenticV5=true current=true actualOutput=NODE_CONTROL');
    writeWrapper('node', 'NODE_CHANGED');
    const changedRun = await runSingleAllowlistedCommand('node --version', env.root, { cwd: env.root, timeoutMs });
    assert.equal(changedRun.code, 0); assert.match(changedRun.output, /NODE_CHANGED/);
    assert.notEqual(changedRun.output, normalRun.output, 'F078 actual executable-byte change changes real output');
    assert.equal(process.env.PATH, fixedPath, 'F078 PATH string is unchanged across executable-byte drift');
    assert.deepEqual(env.store.readChecklist(env.storyId), before, 'F078 old receipt bytes remain unchanged');
    assert.deepEqual(verificationFreshnessHashBinding(env, refs[0]), binding, 'F078 all Git freshness bindings remain unchanged');
    assert.equal(validateVerificationReceipt(env.root, old, {
      storyId: env.storyId, intentRef: refs[0], selector: 'NODE_PATH_A', command: 'node --version',
    }).ok, true, 'F078 old signed graph retains historical authenticity after live executable drift');
    console.log('F078 drift actualOutput=NODE_CHANGED unchangedPATH=true unchangedGit=true unchangedReceipt=true');

    await collectRepairChecks(async check => {
      await check('F078 actual PATH node executable identity changes', () => {
        const current = prepareVerificationExecutionIdentity({ command: 'node --version', cwd: old.executionReceipt.cwd, effectiveTimeoutMs: timeoutMs });
        assert.notEqual(current.toolchainDigest, old.executionReceipt.toolchainDigest,
          'F078 actual PATH-selected node bytes must change the toolchain identity');
        assert.notEqual(current.executionIdentityDigest, old.executionReceipt.executionIdentityDigest);
        assert.equal(current.environmentDigest, old.executionReceipt.environmentDigest);
      });
      await check('F078 live gate rejects changed node while stable executable stays current', () => {
        const rows = gateCoverage(env).entries;
        assert.deepEqual(rows.map(row => row.status), ['stale', 'stale', 'covered', 'covered']);
      });
      await check('F078 refresh selects changed actual node', () => {
        assert.doesNotMatch(refreshStaleEvidenceMetadataOnly(evidenceContext(env), env.storyId, true), /No stale verification evidence/);
      });
      await check('F078 DONE rejects changed actual node', async () => {
        const preview = await doneIdentityPreview(env);
        assert.equal(preview.blockedAt, 'evidenceFreshness', preview.transcript);
        assert.match(preview.transcript, /staleEvidenceRefresh: BLOCKED/);
        assert.ok(preview.transcript.includes('node --version'));
      });
      writeFileSync(log, ''); env.launchCounter.count = 0;
      await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
      await check('F078 refresh executes affected physical key once for two selectors', () => {
        const children = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { tag: string; pid: number });
        assert.equal(children.length, 1, 'F078 real refresh must execute exactly one affected node child');
        assert.equal(new Set(children.map(row => row.pid)).size, 1);
        assert.deepEqual(children.map(row => row.tag), ['node']);
        assert.equal(env.launchCounter.count, 1);
        const a = splitReceipt(env, refs[0]), b = splitReceipt(env, refs[1]);
        assert.deepEqual(a.executionReceipt, b.executionReceipt);
        assert.notEqual(a.assertionReceipt.assertionReceiptDigest, b.assertionReceipt.assertionReceiptDigest);
        assert.notEqual(a.executionReceipt.executionReceiptDigest, old.executionReceipt.executionReceiptDigest);
        assert.match(validateVerificationReceipt(env.root, a, { storyId: env.storyId, intentRef: refs[0], selector: 'NODE_PATH_A' }).output!, /NODE_CHANGED/);
        assert.equal(gateCoverage(env).entries.filter(row => row.status === 'covered').length, 4);
        for (const ref of refs) {
          assert.equal(splitReceipt(env, ref).reuseReceipt, undefined);
          assert.equal(splitReceipt(env, ref).executionReceipt.inputClosureComplete, false);
        }
      });
      writeFileSync(log, ''); env.launchCounter.count = 0;
      for (let i = 0; i < 2; i++) await env.handlers.verification_run({ storyId: env.storyId, itemId: 'CHK-001', intentRef: refs[0] });
      assert.equal(env.launchCounter.count, 2, 'F078 ordinary repeated verification still really executes twice');
      assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 2);
      assert.equal(splitReceipt(env, refs[0]).reuseReceipt, undefined);

      // The same PATH entry resolves from the child cwd, not the agent cwd.
      const childCwd = join(external, 'child-cwd'); mkdirSync(childCwd);
      process.env.PATH = `${relative(childCwd, bin)}:${priorPath ?? ''}`;
      const relativeBefore = prepareVerificationExecutionIdentity({ command: 'node --version', cwd: childCwd, effectiveTimeoutMs: timeoutMs });
      const relativeNormal = await runSingleAllowlistedCommand('node --version', env.root, { cwd: childCwd, timeoutMs });
      assert.match(relativeNormal.output, /NODE_CHANGED/);
      writeWrapper('node', 'NODE_RELATIVE_CHANGED');
      const relativeChanged = await runSingleAllowlistedCommand('node --version', env.root, { cwd: childCwd, timeoutMs });
      assert.match(relativeChanged.output, /NODE_RELATIVE_CHANGED/);
      await check('F078 relative PATH resolves against actual child cwd', () => {
        const current = prepareVerificationExecutionIdentity({ command: 'node --version', cwd: childCwd, effectiveTimeoutMs: timeoutMs });
        assert.notEqual(current.toolchainDigest, relativeBefore.toolchainDigest);
        assert.equal(current.environmentDigest, relativeBefore.environmentDigest);
      });

      process.env.PATH = fixedPath;
      const cap = makeEnv('B-aa5f-node-path-capsule', [intent('CAP-PATH', 'cli')]);
      try {
        assert.equal(verificationReuseCapsuleEnforcementSupported(), true);
        const input = 'packages/main/src/path-cap.txt', manifest = 'packages/main/path.verification-dependencies.json';
        write(cap.root, input, 'CAPSULE_CLOSED_PATH_OK\n'); writeCapsuleManifest(cap.root, manifest, [input]);
        git(cap.root, ['add', input, manifest]); git(cap.root, ['commit', '-m', 'capsule path positive control']);
        const command = capsuleCommand(cap.root, manifest, [input]);
        await seedPinnedReceipt(cap, { intentRef: 'CAP-PATH', command, selector: 'CAPSULE_CLOSED_PATH_OK', file: manifest });
        const original = splitReceipt(cap, 'CAP-PATH');
        const identity = (withManifest: boolean) => prepareVerificationExecutionIdentity({ command, cwd: cap.root,
          effectiveTimeoutMs: original.executionReceipt.effectiveTimeoutMs, ...(withManifest ? { manifestPath: manifest } : {}) });
        const withManifest = identity(true), withoutManifest = identity(false);
        process.env.PATH = `${emptyBin}:${priorPath ?? ''}`;
        const actual = await runSingleAllowlistedCommand(command, cap.root, { cwd: cap.root, timeoutMs: original.timeoutMs });
        assert.equal(actual.code, 0); assert.equal(actual.output, 'CAPSULE_CLOSED_PATH_OK\n');
        await check('F078 exact capsule invocation ignores ambient PATH independent of metadata manifest', () => {
          for (const [provided, prior] of [[true, withManifest], [false, withoutManifest]] as const) {
            const current = identity(provided);
            assert.equal(current.toolchainDigest, prior.toolchainDigest);
            assert.equal(current.environmentDigest, prior.environmentDigest,
              'F078 actual capsule environment selection is not conditional on evidence manifest metadata');
          }
          assert.equal(gateCoverage(cap).entries[0].status, 'covered');
        });
        commitRefreshDrift(cap, 'unrelated-path-drift'); cap.launchCounter.count = 0;
        await cap.handlers.verification_evidence_refresh_stale({ storyId: cap.storyId });
        assert.equal(cap.launchCounter.count, 0, 'F078 unrelated capsule drift retains zero-execution reuse');
        assert.ok(splitReceipt(cap, 'CAP-PATH').reuseReceipt);
        assert.deepEqual(splitReceipt(cap, 'CAP-PATH').executionReceipt, original.executionReceipt);
        assert.equal(gateCoverage(cap).entries[0].status, 'covered');
      } finally { cleanup(cap); }

      process.env.PATH = emptyBin;
      const unavailable = await runSingleAllowlistedCommand('node --version', env.root, { cwd: env.root, timeoutMs });
      assert.notEqual(unavailable.code, 0, 'F078 empty search path really cannot execute node');
      await check('F078 unresolved actual executable is fail-closed', () => {
        assert.throws(() => prepareVerificationExecutionIdentity({ command: 'node --version', cwd: env.root, effectiveTimeoutMs: timeoutMs }),
          /toolchain|executable|resolution/i, 'F078 unavailable child identity cannot become a digest of null or the host runtime');
      });
    });
  } finally {
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    cleanup(env); rmSync(external, { recursive: true, force: true });
  }
}

// CHK-008 adds only the missing causal bridge boundary. Existing B/E/F/I
// controls still prove pinless/failure/manual recovery, 71x2, closure and live
// environment isolation; the complete integration marker is emitted after all.
async function partKCausalIntegration(): Promise<void> {
  const env = makeEnv('B-causal-integration', [
    intent('K-CLI', 'cli'), intent('K-DOCS', 'docs'), intent('K-MANUAL', 'manual'),
    intent('K-TIMEOUT', 'logic'),
  ]);
  // The probe retains a prefix AND suffix, in addition to its separate tail.
  // Pad both sides past either exported bound so K_DOCS is absent from all
  // bounded diagnostics while remaining present in authenticated full output.
  const diagnosticPadding = Math.max(CAUSAL_MAX_OUTPUT_CHARS, CAUSAL_OUTPUT_TAIL_CHARS) + 1;
  const command = `node -e "process.stdout.write('K_CLI K_MANUAL K_TIMEOUT '+ 'x'.repeat(${diagnosticPadding}) +' K_DOCS '+ 'y'.repeat(${diagnosticPadding}))"`;
  const signed: CausalEvidenceReceipt[] = [];
  const writeReceipt = env.store.writeCausalEvidenceReceipt.bind(env.store);
  env.store.writeCausalEvidenceReceipt = (storyId, receipt) => {
    assert.ok(verifyCausalEvidenceReceipt(receipt, receipt.executionKey), 'K: production causal receipt is genuinely signed');
    signed.push(structuredClone(receipt));
    writeReceipt(storyId, receipt);
  };
  try {
    const batchRows = [
      ['K-CLI', 'K_CLI', 'integration_test', 5000], ['K-DOCS', 'K_DOCS', 'docs_check', 5000],
      ['K-MANUAL', 'K_MANUAL', 'manual_transcript', 5000], ['K-TIMEOUT', 'K_TIMEOUT', 'logic_test', 7000],
    ] as const;
    const batchResponse = await env.handlers.verification_evidence_batch_add({
      storyId: env.storyId,
      evidences: batchRows.map(([intentRef, selector, kind, timeout]) => ({
        itemId: 'CHK-001', intentRef, command, selector, kind, result: 'pass',
        note: `CHK008 actual batch observation for ${intentRef}`,
        commandTimeoutMs: timeout,
        commandTimeoutReason: `CHK008 genuine ${intentRef} timeout provenance remains assertion-local.`,
      })),
    });
    assert.match(batchResponse, /CausalEvidence: intentCount=4 uniqueExecutionKeys=2 commandExecutions=2 cacheHitRate=50%/,
      'K: causal ledger counts every independently evaluated intent, including shared-execution followers');
    assert.equal(env.launchCounter.count, 2, 'K: per-intent ledger accounting never reruns a shared execution');
    assert.equal(signed.length, 2, 'K: followers never re-sign the source execution');
    assert.equal(new Set(batchRows.map(([id]) => splitReceipt(env, id).assertionReceipt.intentRef)).size, 4,
      'K: the four ledger intents retain independent authenticated selector assertions');
    commitRefreshDrift(env, 'causal-integration');
    signed.length = 0;
    env.launchCounter.count = 0;
    await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
    assert.equal(env.launchCounter.count, 2, 'K: selector/type/kind/provenance fan-out shares execution; effective timeouts isolate');
    assert.equal(signed.length, 2, 'K: each physical observation has one signed causal source');
    const receipts = ['K-CLI', 'K-DOCS', 'K-MANUAL', 'K-TIMEOUT'].map(id => splitReceipt(env, id));
    assert.deepEqual(receipts[0].executionReceipt, receipts[1].executionReceipt, 'K: docs fan-out retains immutable execution bytes');
    assert.deepEqual(receipts[0].executionReceipt, receipts[2].executionReceipt, 'K: manual fan-out retains immutable execution bytes');
    assert.notEqual(receipts[0].executionReceipt.executionIdentityDigest, receipts[3].executionReceipt.executionIdentityDigest,
      'K: effective-timeout separation is physical, not assertion-only');
    for (const receipt of receipts) assert.ok(validateVerificationReceipt(env.root, receipt, {
      storyId: env.storyId, intentRef: receipt.assertionReceipt.intentRef,
      selector: receipt.selector!, command,
    }).ok, 'K: current V5 assertion independently authenticates its selector and complete output');

    const identityFor = (receipt: CausalEvidenceReceipt): CausalExecutionIdentityInput => ({
      ...receipt.identity, selectorPolicy: DEFAULT_CAUSAL_SELECTOR_POLICY,
      effectiveEnvironment: effectiveCausalEnvironment(undefined, receipt.identity.cwd),
    });
    const sourceFacts = (signed[0].identity.inputs as { preflightFacts: CausalPreflightFacts }).preflightFacts;
    const boundedDiagnostic = await executeCausalEvidence({
      identity: identityFor(signed[0]), selector: 'K_DOCS', receiptStore: env.store,
      preflight: preflightCausalEvidence(sourceFacts, () => true, identityFor(signed[0])),
      revalidateBeforeRun: () => true,
      run: async () => { throw new Error('K: diagnostic replay must not launch another execution'); },
    });
    assert.equal(signed[0].outputProbe.includes('K_DOCS'), false, 'K: bounded diagnostic probe still omits the middle-of-large-output selector');
    assert.ok(signed[0].selectorOutput, 'K: causal replay binds durable complete selector output');
    assert.equal(boundedDiagnostic.disposition, 'reused', 'K: complete-output replay does not launch another execution');
    assert.equal(boundedDiagnostic.verdict.matched, true, 'K: authenticated complete causal output finds the middle-of-large-output selector');
    assert.equal(splitReceipt(env, 'K-DOCS').selectorMatched, true, 'K: authenticated complete-output V5 assertion agrees with causal replay');
    const sourceBytes = signed.map(receipt => JSON.stringify(receipt));
    let imports = 0;
    for (const receipt of signed) importCausalEvidenceReceipt({
      receipt, expectedStoryId: env.storyId, expectedExecutionKey: receipt.executionKey,
      currentIdentity: identityFor(receipt), revalidate: () => true, commit: () => { imports++; },
    });
    assert.equal(imports, 2, 'K: valid same-identity imports pass');
    assert.throws(() => importCausalEvidenceReceipt({
      receipt: signed[0], expectedStoryId: env.storyId, expectedExecutionKey: signed[0].executionKey,
      currentIdentity: identityFor(signed[1]), revalidate: () => true, commit: () => { imports++; },
    }), /causal_.*mismatch/, 'K: cross-identity cached import snapshot is refused');
    const facts = (signed[0].identity.inputs as { preflightFacts: CausalPreflightFacts }).preflightFacts;
    const crossedPreflight = preflightCausalEvidence(facts, () => true, identityFor(signed[1]));
    let crossedRuns = 0;
    await expectRejection(executeCausalEvidence({
      identity: identityFor(signed[0]), selector: 'K_CLI', preflight: crossedPreflight,
      revalidateBeforeRun: () => true,
      run: async () => { crossedRuns++; throw new Error('crossed preflight must never reach execution'); },
    }), /causal_preflight_invalid/, 'K: cross-identity cached preflight is refused before execution');
    assert.equal(crossedRuns, 0);
    assert.equal(imports, 2, 'K: invalid import never publishes');
    assert.deepEqual(signed.map(receipt => JSON.stringify(receipt)), sourceBytes, 'K: import never rewrites signed execution bytes or time');

    const timeFailures: string[] = [];
    const beforeOrdinary = signed.length;
    const beforeOrdinaryRuns = env.launchCounter.count;
    const beforeOrdinaryHead = git(env.root, ['rev-parse', 'HEAD']);
    for (let i = 0; i < 2; i++) await env.handlers.verification_run({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'K-CLI',
    });
    assert.equal(env.launchCounter.count - beforeOrdinaryRuns, 2, 'K: ordinary repeated verification really executes twice');
    assert.equal(git(env.root, ['rev-parse', 'HEAD']), beforeOrdinaryHead, 'K: repeated-observation control holds Git freshness fixed');
    if (signed.length - beforeOrdinary !== 2) timeFailures.push('new ordinary executions borrowed an older same-key CAS observation');

    const priorChecklist = env.store.readChecklist(env.storyId);
    const readReceipt = env.store.readCausalEvidenceReceipt.bind(env.store);
    env.store.readCausalEvidenceReceipt = (storyId, key) => {
      const actual = readReceipt(storyId, key);
      return actual ? signed.find(receipt => receipt.executionKey !== key) ?? actual : actual;
    };
    await expectRejection(env.handlers.verification_run({ storyId: env.storyId, itemId: 'CHK-001', intentRef: 'K-CLI' }),
      /causal_(?:receipt_tampered|commit_snapshot_invalid|import_revalidation_failed)/,
      'K: actual production import refuses substituted signed CAS receipt');
    env.store.readCausalEvidenceReceipt = readReceipt;
    assert.deepEqual(env.store.readChecklist(env.storyId), priorChecklist, 'K: cross-identity refusal leaves prior receipts and pins unchanged');

    for (const receipt of receipts) {
      const source = signed.find(candidate => candidate.timeoutMs === receipt.executionReceipt.effectiveTimeoutMs)!;
      assert.equal(source.outputDigest, receipt.outputDigest, 'K: causal and V3 receipts bind the same actual output');
      if (receipt.executedAt !== source.executedAt || receipt.executionReceipt.executedAt !== source.executedAt) {
        timeFailures.push(`${receipt.assertionReceipt.intentRef}: source=${source.executedAt} execution=${receipt.executedAt}`);
      }
    }
    assert.equal(timeFailures.length, 0, `K: fan-out retains source signed execution time, never publication time: ${timeFailures.join('; ')}`);
    console.log('CHK008 causal matrix: same-identity import, crossed preflight/CAS refusal, signed time/bytes and timeout fan-out verified');
  } finally { cleanup(env); }
}

// F088/F089 additions deliberately precede the frozen F057-to-Runner matrix.
async function partMLegacyMetadataMaintenance(): Promise<void> {
  for (const mode of ['sync', 'async'] as const) {
    const ids = ['MANUAL', 'COMMAND', 'FAILED', 'WAIVER', 'DEFERRED', 'NOHEAD', 'CURRENT', 'PINNED', 'RECEIPT'];
    const env = makeEnv(`B-aa5f-legacy-${mode}`, ids.map(id => intent(id, 'logic',
      id === 'PINNED' ? { command: PASS_CMD, selector: SELECTOR } : undefined)));
    try {
      const old = {
        headHash: git(env.root, ['rev-parse', 'HEAD']),
        materialHash: currentMaterialHash(env.root, 'HEAD', env.root),
        storyFilesHash: currentStoryFilesHash(env.root, 'HEAD', env.root),
      };
      const rows: VerificationEvidence[] = ids.map(id => ({
        intentRef: id, kind: 'manual_transcript', result: 'pass', note: `retained ${id}`, ...old,
      }));
      rows[1].command = PASS_CMD;
      rows[2].result = 'fail';
      rows[3].kind = 'waiver';
      rows[4].kind = 'waiver'; rows[4].waiverType = 'deferred_gate_evidence';
      delete rows[5].headHash;
      // An invalid receipt-shaped legacy row must not enter the receipt-less fallback.
      rows[8].receipt = { exitCode: 0, selectorMatched: true } as VerificationEvidence['receipt'];
      const cl = env.store.readChecklist(env.storyId);
      cl.items[0].verificationEvidence = rows;
      env.store.writeChecklist(env.storyId, cl);
      commitRefreshDrift(env, `F089-${mode}`);
      const current = {
        headHash: git(env.root, ['rev-parse', 'HEAD']),
        materialHash: currentMaterialHash(env.root, 'HEAD', env.root),
        storyFilesHash: currentStoryFilesHash(env.root, 'HEAD', env.root),
      };
      Object.assign(rows[6], current);
      env.store.writeChecklist(env.storyId, cl);
      const before = structuredClone(env.store.readChecklist(env.storyId));
      const refresh = async (dryRun: boolean) => mode === 'sync'
        ? refreshStaleEvidenceMetadataOnly({ store: env.store, root: env.root, scanRoot: join(env.root, 'packages/main') }, env.storyId, dryRun)
        : await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId, dryRun });
      const preview = await refresh(true);
      assert.match(preview, /DRY-RUN/, `F089 ${mode}: stale receipt-less rows remain maintenance candidates`);
      assert.deepEqual(env.store.readChecklist(env.storyId), before, `F089 ${mode}: dry-run is read-only`);
      const output = await refresh(false);
      assert.match(output, /Refreshed 2\/2 stale evidence/, `F089 ${mode}: refresh only eligible stale legacy rows`);
      for (const id of ['MANUAL', 'COMMAND']) {
        const row = findEvidence(env, id)!;
        assert.equal(row.headHash, current.headHash);
        assert.equal(row.materialHash, current.materialHash);
        assert.equal(row.storyFilesHash, current.storyFilesHash);
        assert.equal(row.note, `retained ${id}`);
        assert.equal(row.receipt, undefined, `F089 ${mode}: no receipt is invented`);
        assert.notEqual(row.mechanical, true, `F089 ${mode}: metadata never grants execution authority`);
        assert.equal(gateCoverage(env).entries.find(e => e.intentRef === id)?.status,
          id === 'MANUAL' ? 'non_mechanical' : 'stale',
          'F089: manual remains non-mechanical; audited command demotion still requires execution');
      }
      assert.equal(findEvidence(env, 'COMMAND')?.mechanical, false, 'F089: unexecuted command-backed PASS is explicitly demoted');
      assert.match(findEvidence(env, 'COMMAND')?.nonMechanicalReason ?? '', /receipt invalidated/);
      for (const id of ids.slice(2)) {
        assert.deepEqual(findEvidence(env, id), before.items[0].verificationEvidence!.find(e => e.intentRef === id),
          `F089 ${mode}: failed, waived, deferred, missing-head, current, pinned and receipt-bearing rows are not restamped`);
      }
      assert.equal(env.launchCounter.count, 0, `F089 ${mode}: metadata-only rows never launch a subprocess`);
    } finally { cleanup(env); }
  }
  console.log('B-aa5f F089 legacy-metadata-maintenance PASS');
}

async function partNLiveProducerOwnership(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-baa5f-lock-regression-'));
  const wait = (ms: number) => new Promise<void>(resolveWait => setTimeout(resolveWait, ms));
  const events: Array<{ event: string; label: string; pid: number; ppid: number; at: number; childPid?: number }> = [];
  const workers: Array<{ proc: ChildProcess; done: Promise<number | null> }> = [];
  const paused = new Set<ChildProcess>();
  const childOwners = new Map<number, number>();
  const active = new Set<number>();
  let maximum = 0;
  const workerCode = `
    import { spawn } from 'node:child_process';
    const [moduleUrl, root, key, label, duration, mode] = process.argv.slice(1);
    const emit = (event, extra = {}) => console.log(JSON.stringify({ event, label, pid: process.pid, ppid: process.ppid, at: Date.now(), ...extra }));
    const { withVerificationExecutionLocks } = await import(moduleUrl);
    if (mode === 'choosing-A' || mode === 'choosing-B') {
      // Deterministic filesystem interleaving in owned child processes only.
      // These UUIDs are acquisition tie-breakers, not session/receipt identities.
      const fs = (await import('node:fs')).default;
      const crypto = (await import('node:crypto')).default;
      const { syncBuiltinESMExports } = await import('node:module');
      const ownId = mode === 'choosing-A' ? '00000000-0000-4000-8000-000000000002' : '00000000-0000-4000-8000-000000000001';
      crypto.randomUUID = () => ownId;
      const rename = fs.renameSync, lstat = fs.lstatSync;
      let ownTicketPublished = false;
      const barrier = name => root + '/' + name;
      const waitFile = path => {
        const limit = Date.now() + 10000;
        while (!fs.existsSync(path)) {
          if (Date.now() > limit) throw new Error('choosing interleaving barrier timed out: ' + path);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      };
      fs.renameSync = (from, to) => {
        if (String(from).endsWith(ownId + '.choosing')) {
          if (mode === 'choosing-B') { emit('choosing-pending'); waitFile(barrier('allow-b-publication')); }
          rename(from, to); ownTicketPublished = true;
          if (mode === 'choosing-B') fs.writeFileSync(barrier('b-published'), 'published');
          return;
        }
        return rename(from, to);
      };
      fs.lstatSync = (path, ...args) => {
        if (mode === 'choosing-A' && ownTicketPublished && String(path).endsWith('00000000-0000-4000-8000-000000000001.choosing')) {
          emit('choosing-snapshot-observed');
          fs.writeFileSync(barrier('allow-b-publication'), 'publish');
          waitFile(barrier('b-published'));
        }
        return lstat(path, ...args);
      };
      syncBuiltinESMExports();
    }
    emit('worker-ready');
    await withVerificationExecutionLocks(root, [key], async () => {
      emit('acquired');
      if (mode === 'exit-owner') process.exit(0); // Deliberately no child: this proves dead-holder recovery, not orphan-child containment.
      const child = spawn(process.execPath, ['-e',
        'const label=process.argv[1]; const emit=event=>console.log(JSON.stringify({event,label,pid:process.pid,ppid:process.ppid,at:Date.now()})); emit("child-start"); setTimeout(()=>emit("child-end"), Number(process.argv[2]));', label, duration],
        { stdio: ['ignore', 'inherit', 'inherit'] });
      emit('child-spawned', { childPid: child.pid });
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      if (code !== 0) throw new Error('owned child failed: ' + code);
    });
    emit('complete');
  `;
  const start = (key: string, label: string, duration: number, mode = 'normal') => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', workerCode,
      pathToFileURL(join(HERE, '../core/verification-execution-evidence.js')).href, root, key, label, String(duration), mode],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = '';
    let parseError: unknown;
    proc.stdout!.on('data', chunk => {
      pending += String(chunk);
      while (pending.includes('\n')) {
        const end = pending.indexOf('\n'); const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line) continue;
        try {
          const row = JSON.parse(line) as typeof events[number];
          events.push(row);
          console.log(`F088 owned-process ${line}`);
          if (row.event === 'child-spawned') childOwners.set(row.childPid!, row.pid);
          if (row.event === 'child-start') {
            assert.equal(childOwners.get(row.pid), row.ppid, 'F088: real leaf belongs to a spawned fixture worker');
            active.add(row.pid); maximum = Math.max(maximum, active.size);
          }
          if (row.event === 'child-end') active.delete(row.pid);
        } catch (error) { parseError = error; }
      }
    });
    proc.stderr!.on('data', chunk => console.error(`F088 ${label}: ${String(chunk).trim()}`));
    const done = new Promise<number | null>((resolveDone, reject) => {
      proc.once('error', reject);
      proc.once('close', code => parseError ? reject(parseError) : resolveDone(code));
    });
    const worker = { proc, done }; workers.push(worker); return worker;
  };
  const within = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`F088 owned-process deadline ${timeoutMs}ms`)), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };
  const event = async (name: string, label: string) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const row = events.find(e => e.event === name && e.label === label);
      if (row) return row;
      await wait(20);
    }
    throw new Error(`F088 missing ${name} for ${label}`);
  };
  try {
    let concurrent = 0; let maxLocal = 0;
    await within(Promise.all(Array.from({ length: 3 }, () => withVerificationExecutionLocks(root, ['same-process'], async () => {
      concurrent++; maxLocal = Math.max(maxLocal, concurrent); await wait(40); concurrent--;
    }))), 5000);
    assert.equal(maxLocal, 1, 'F088: same-process Promise contention must yield the event loop');
    await assert.rejects(withVerificationExecutionLocks(root, ['throwing'], async () => { throw new Error('owned callback failure'); }), /owned callback failure/);
    await within(withVerificationExecutionLocks(root, ['throwing'], async () => undefined), 5000);
    const healthyA = start('healthy', 'healthy-A', 400);
    await event('child-start', 'healthy-A');
    const healthyB = start('healthy', 'healthy-B', 400);
    assert.deepEqual(await within(Promise.all([healthyA.done, healthyB.done]), 10_000), [0, 0]);
    assert.equal(maximum, 1, 'F088: healthy actual subprocesses serialize');
    if (process.platform !== 'win32') {
      const a = start('paused-live', 'paused-A', 37_000);
      const leaf = await event('child-start', 'paused-A');
      assert.equal(leaf.ppid, a.proc.pid);
      process.kill(a.proc.pid!, 0); process.kill(leaf.pid, 0);
      a.proc.kill('SIGSTOP'); paused.add(a.proc);
      const pausedAt = Date.now();
      await wait(31_000); // Real lease expiry is the fault, never a forged mtime or clock.
      assert.ok(Date.now() - pausedAt > 30_000);
      process.kill(a.proc.pid!, 0); process.kill(leaf.pid, 0);
      const state = execFileSync('ps', ['-p', String(a.proc.pid), '-o', 'state='], { encoding: 'utf8' });
      assert.match(state, /T/, 'F088: exact owned worker is still live and stopped');
      const b = start('paused-live', 'paused-B', 600);
      await event('worker-ready', 'paused-B');
      await wait(700);
      process.kill(a.proc.pid!, 0); process.kill(leaf.pid, 0);
      console.log(`F088 realPauseMs=${Date.now() - pausedAt} ownerAlive=true childAlive=true maxSimultaneous=${maximum}`);
      a.proc.kill('SIGCONT'); paused.delete(a.proc);
      assert.deepEqual(await within(Promise.all([a.done, b.done]), 15_000), [0, 0]);
      assert.equal(maximum, 1, 'F088: a live paused owner beyond 30s must not permit a second live producer');
      const aEnd = events.find(e => e.event === 'child-end' && e.label === 'paused-A')!;
      const bStart = events.find(e => e.event === 'child-start' && e.label === 'paused-B')!;
      assert.ok(bStart.at >= aEnd.at, 'F088: successor starts only after predecessor child completes');
    } else {
      console.log('F088 POSIX SIGSTOP case not executed on win32; native Windows pause coverage is not claimed');
    }
    // B chooses ticket 1 first, A chooses the same number with a later UUID.
    // Publish B between A's readdir and lstat of B.choosing: ENOENT must rescan,
    // not silently omit B and let both real child commands acquire.
    const choosingB = start('choosing-race', 'choosing-B', 500, 'choosing-B');
    await event('choosing-pending', 'choosing-B');
    const choosingA = start('choosing-race', 'choosing-A', 100, 'choosing-A');
    await event('choosing-snapshot-observed', 'choosing-A');
    assert.deepEqual(await within(Promise.all([choosingA.done, choosingB.done]), 10_000), [0, 0]);
    assert.equal(maximum, 1, 'F088: choosing-to-ticket publication invalidates the entire reader snapshot');
    const dead = start('dead-owner', 'dead-owner', 0, 'exit-owner');
    await event('acquired', 'dead-owner');
    assert.equal(await within(dead.done, 5000), 0);
    assert.throws(() => process.kill(dead.proc.pid!, 0), /ESRCH/);
    const recovery = start('dead-owner', 'dead-recovery', 50);
    assert.equal(await within(recovery.done, 35_000), 0, 'F088: a genuinely exited owner without an orphan child is recoverable');
    // Legacy/malformed runtime layouts must fail closed; these are not forged receipts.
    for (const layout of ['legacy', 'malformed']) {
      const path = verificationExecutionLockPath(root, layout);
      mkdirSync(path, { recursive: true });
      const originalOwner = layout === 'legacy'
        ? JSON.stringify({ ownerId: 'owned-legacy-control', pid: process.pid, acquiredAt: new Date().toISOString() }) : '{';
      writeFileSync(join(path, 'owner.json'), originalOwner);
      const blocked = start(layout, layout, 50);
      await event('worker-ready', layout);
      await wait(100);
      assert.equal(events.some(e => e.event === 'acquired' && e.label === layout), false, 'F088: existing ownership is never ignored');
      if (blocked.proc.exitCode === null && blocked.proc.signalCode === null) blocked.proc.kill('SIGTERM');
      await within(blocked.done, 5000);
      assert.equal(readFileSync(join(path, 'owner.json'), 'utf8'), originalOwner);
    }
    const ownedQueue = verificationExecutionLockPath(root, 'healthy');
    assert.deepEqual(readdirSync(ownedQueue), ['protocol'], 'F088: normal release leaves no acquisition token');
    const partialToken = join(ownedQueue, '0000000000000001-00000000-0000-4000-8000-000000000003.ticket');
    const partialBytes = JSON.stringify({ schemaVersion: 'proof-or-stop.verification-execution-ticket.v1', ownerId: '00000000-0000-4000-8000-000000000003' });
    writeFileSync(partialToken, partialBytes);
    let enteredPartial = false;
    await assert.rejects(withVerificationExecutionLocks(root, ['healthy'], async () => { enteredPartial = true; }), /verification_execution_lock_invalid_owner/);
    assert.equal(enteredPartial, false, 'F088: partial ticket ownership cannot grant admission');
    assert.equal(readFileSync(partialToken, 'utf8'), partialBytes, 'F088: malformed ownership is not silently reclaimed');
    rmSync(partialToken);
    console.log('B-aa5f F088 live-producer-ownership PASS');
  } finally {
    for (const proc of paused) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGCONT');
    for (const pid of active) {
      try { process.kill(pid, 'SIGTERM'); } catch (error: any) { if (error?.code !== 'ESRCH') throw error; }
    }
    for (const { proc } of workers) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
    await within(Promise.all(workers.map(w => w.done)), 5000);
    rmSync(root, { recursive: true, force: true });
  }
}

async function runBaa5fRepairPair(): Promise<void> {
  const failures: string[] = [];
  for (const [name, run] of [['F089', partMLegacyMetadataMaintenance], ['F088', partNLiveProducerOwnership]] as const) {
    try { await run(); } catch (error) {
      const detail = `${name}: ${error instanceof Error ? error.stack : String(error)}`;
      failures.push(detail); console.error(`[B-aa5f repair regression] ${detail}`);
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
}

async function partIIdentityDrift(): Promise<void> {
  await collectRepairChecks(async check => {
    for (const drift of ['environment', 'toolchain'] as const) {
      const external = mkdtempSync(join(tmpdir(), 'baa5f-live-identity-'));
      const log = join(external, 'children.jsonl');
      const bin = join(external, 'bin');
      mkdirSync(bin);
      writeFileSync(log, '');
      const priorPath = process.env.PATH;
      const key = 'B_AA5F_REAL_ENVIRONMENT_CHANGE';
      const priorValue = process.env[key];
      process.env.PATH = `${bin}:${priorPath ?? ''}`;
      process.env[key] = 'normal-control';
      const childCode = (tag: string, version: string) =>
        `require('fs').appendFileSync(${JSON.stringify(log)},JSON.stringify({tag:${JSON.stringify(tag)},pid:process.pid})+'\\n');` +
        `console.log('IDENTITY_A IDENTITY_B',${JSON.stringify(version)},process.env.${key})`;
      const wrapper = join(bin, 'npm');
      const writeTool = (version: string) => {
        writeFileSync(wrapper, `#!${process.execPath}\n${childCode('tool', version)}\n`);
        chmodSync(wrapper, 0o755);
      };
      writeTool('tool-v1');
      const commands = drift === 'environment'
        ? ['one', 'two'].map(tag => `node -e ${JSON.stringify(childCode(tag, 'env-verifier'))}`)
        : ['npm --version', `node -e ${JSON.stringify(childCode('node-control', 'unchanged'))}`];
      const refs = ['LIVE-0-A', 'LIVE-0-B', 'LIVE-1-A', 'LIVE-1-B'];
      const env = makeEnv(`B-aa5f-live-${drift}`, refs.map(ref => intent(ref, 'cli')));
      try {
        // Ignore fixture-owned runtime/artifacts before earning any receipts.
        // DONE's clean-tree gate must pass honestly; it
        // must not be bypassed or mistake the fixture's own cache for source.
        write(env.root, '.gitignore', '.proof-or-stop/evidence/\n.proof-or-stop/runtime/\n.proof-or-stop/locks/\n.proof-or-stop/learning/runtime-memory-pack-cache/\n');
        git(env.root, ['add', '.gitignore']);
        git(env.root, ['commit', '-m', 'ignore fixture runtime artifacts before execution']);
        for (let index = 0; index < refs.length; index++) {
          await seedPinnedReceipt(env, { intentRef: refs[index], command: commands[Math.floor(index / 2)], selector: index % 2 ? 'IDENTITY_B' : 'IDENTITY_A' });
        }
        const before = env.store.readChecklist(env.storyId);
        const gitBefore = verificationFreshnessHashBinding(env, refs[0]);
        assert.equal(gateCoverage(env).entries.filter(entry => entry.status === 'covered').length, 4, `F057 ${drift}: unchanged-input control is admissible`);
        const normalDone = await doneIdentityPreview(env);
        assert.match(normalDone.transcript, /staleEvidenceRefresh: PASS/,
          `F057 ${drift}: normal DONE classification reaches its real freshness step\n${normalDone.transcript}`);
        assert.match(refreshStaleEvidenceMetadataOnly(evidenceContext(env), env.storyId, true), /No stale verification evidence/);
        console.log(`F057 ${drift} normal-control admissible=true doneFresh=true`);
        const oldIdentity = splitReceipt(env, refs[0]).executionReceipt;
        if (drift === 'environment') process.env[key] = 'changed-after-signed-execution';
        else writeTool('tool-v2-real-behavior-change');
        const currentIdentity = prepareVerificationExecutionIdentity({ command: commands[0], cwd: env.root, effectiveTimeoutMs: oldIdentity.effectiveTimeoutMs });
        assert.notEqual(currentIdentity.executionIdentityDigest, oldIdentity.executionIdentityDigest, 'F057: live execution identity really changed');
        assert.notEqual(drift === 'environment' ? currentIdentity.environmentDigest : currentIdentity.toolchainDigest,
          drift === 'environment' ? oldIdentity.environmentDigest : oldIdentity.toolchainDigest);
        assert.deepEqual(env.store.readChecklist(env.storyId), before, 'F057: drift changed no receipt bytes');
        assert.deepEqual(verificationFreshnessHashBinding(env, refs[0]), gitBefore, 'F057: drift changed no Git freshness bindings');
        await check(`F057 ${drift} gate denies actual live drift`, () => {
          const coverage = gateCoverage(env);
          assert.equal(coverage.entries[0].status, 'stale', 'changed live identity must be stale-needs-execution, not covered/non_mechanical');
          if (drift === 'toolchain') assert.equal(coverage.entries[2].status, 'covered', 'unaffected executable remains current');
        });
        await check(`F057 ${drift} refresh selects actual live drift`, () => {
          assert.doesNotMatch(refreshStaleEvidenceMetadataOnly(evidenceContext(env), env.storyId, true), /No stale verification evidence/);
        });
        await check(`F057 ${drift} DONE selects actual live drift`, async () => {
          const preview = await doneIdentityPreview(env);
          assert.equal(preview.blockedAt, 'evidenceFreshness', preview.transcript);
          assert.match(preview.transcript, /staleEvidenceRefresh: BLOCKED/);
          assert.ok(preview.transcript.includes(commands[0]), 'DONE names the affected command');
        });
        writeFileSync(log, '');
        env.launchCounter.count = 0;
        await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
        const launches = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { pid: number; tag: string });
        const expected = drift === 'environment' ? 2 : 1;
        await check(`F057 ${drift} real refresh launches each affected identity once`, () => {
          assert.equal(launches.length, expected, 'actual child-written log counts executions, not receipt publications');
          assert.equal(new Set(launches.map(row => row.pid)).size, expected);
          assert.equal(env.launchCounter.count, expected);
          if (drift === 'toolchain') assert.deepEqual(launches.map(row => row.tag), ['tool']);
          assert.equal(gateCoverage(env).entries.filter(entry => entry.status === 'covered').length, 4, 'renewed observations are admissible');
          for (const ref of refs) {
            const receipt = splitReceipt(env, ref);
            assert.equal(receipt.executionReceipt.inputClosureComplete, false);
            assert.equal(receipt.reuseReceipt, undefined, 'ordinary execution never earns persistent reuse');
          }
        });
      } finally {
        cleanup(env);
        if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
        if (priorValue === undefined) delete process.env[key]; else process.env[key] = priorValue;
        rmSync(external, { recursive: true, force: true });
      }
    }
  });
}

async function partJPublicationBinding(): Promise<void> {
  const env = makeEnv('B-aa5f-publication-binding', [intent('PUB-A', 'cli'), intent('PUB-B', 'cli')]);
  try {
    await seedPinnedReceipt(env, { intentRef: 'PUB-A', command: PASS_CMD, selector: SELECTOR });
    await seedPinnedReceipt(env, { intentRef: 'PUB-B', command: PASS_CMD, selector: SELECTOR });
    assert.equal(gateCoverage(env).entries.filter(entry => entry.status === 'covered').length, 2, 'F058: genuine current normal controls are admissible');
    const originals = env.store.readChecklist(env.storyId);
    // Retained low-level legacy issuer observes a REAL child; no manufactured
    // result, static key, copied cwd, schema-string downgrade or signature edit.
    const run = await runSingleAllowlistedCommand(PASS_CMD, env.root, { cwd: env.root });
    const execution = createVerificationExecutionReceipt({ projectRoot: env.root, storyId: env.storyId, command: PASS_CMD, cwd: env.root, run });
    const legacy = createVerificationAssertionReceipt({ projectRoot: env.root, storyId: env.storyId, executionReceipt: execution, intentRef: 'PUB-A', selector: SELECTOR });
    assert.equal(legacy.schemaVersion, 'proof-or-stop.verification-receipt-bundle.v4');
    assert.equal(validateVerificationReceipt(env.root, legacy, { storyId: env.storyId, intentRef: 'PUB-A', selector: SELECTOR }).ok, true);
    const original = { ...findEvidence(env, 'PUB-A')!, receipt: legacy };
    commitRefreshDrift(env, 'actual-publication-material-change');
    const attack: VerificationEvidence = {
      ...original,
      headHash: git(env.root, ['rev-parse', 'HEAD']),
      materialHash: currentMaterialHash(env.root, 'HEAD', env.root),
      storyFilesHash: currentStoryFilesHash(env.root, 'HEAD', env.root),
    };
    assert.notEqual(original.materialHash, attack.materialHash, 'F058: actual fixture material drift happened');
    assert.deepEqual(attack.receipt, original.receipt, 'F058: every legacy signed byte is unchanged');
    const attacked = env.store.readChecklist(env.storyId);
    attacked.items[0].verificationEvidence = [attack];
    console.log('F058 controls actualLegacyExecution=true authenticAuditReadable=true materialDrift=true signedBytesChanged=false');
    assert.notEqual(gateCoverage(env, attacked).entries[0].status, 'covered',
      'F058 unsigned outer tuple rewrite must not launder an old signed V4 execution into current admission');
    // Reached only once the genuine baseline defect is fixed. These assertions
    // remain identical for GREEN and bind the full new-publication contract.
    const deniedReuse = planVerificationExecutionReuse({ projectRoot: env.root, storyId: env.storyId, priorReceipt: legacy,
      intentRef: 'PUB-A', selector: SELECTOR, command: PASS_CMD, cwd: env.root, effectiveTimeoutMs: run.timeoutMs,
      freshnessHashBinding: { evidenceHeadHash: attack.headHash, evidenceMaterialHash: attack.materialHash,
        evidenceStoryFilesHash: attack.storyFilesHash, currentHeadHash: attack.headHash,
        currentMaterialHash: attack.materialHash, currentStoryFilesHash: attack.storyFilesHash } });
    assert.equal(deniedReuse.reusable, false, 'legacy history has no reuse authority');
    assert.equal(validateVerificationReceipt(env.root, legacy, { storyId: env.storyId, intentRef: 'PUB-A', selector: SELECTOR }).promotable, false);
    env.store.writeChecklist(env.storyId, attacked);
    assert.throws(() => narrowVerificationPin(evidenceContext(env), { storyId: env.storyId, itemId: 'CHK-001', intentRef: 'PUB-A',
      selector: `${SELECTOR} stricter`, reason: 'legacy signed observations cannot authorize a new current narrowing' }),
    /not_authoritative|legacy/i, 'F058 authentic legacy V4 is not a narrowing witness');
    assert.deepEqual(env.store.readChecklist(env.storyId), attacked, 'F058 refused legacy narrowing rewrites nothing');
    const renewal = structuredClone(originals);
    renewal.items[0].verificationEvidence![0] = original;
    env.store.writeChecklist(env.storyId, renewal);
    env.launchCounter.count = 0;
    await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
    assert.equal(env.launchCounter.count, 1, 'authentic legacy renewal requires a real child');
    const current = findEvidence(env, 'PUB-A')!;
    const sibling = findEvidence(env, 'PUB-B')!;
    assert.deepEqual((current.receipt as any).executionReceipt, (sibling.receipt as any).executionReceipt,
      'F058 real renewal fan-out shares exactly one execution');
    assert.notEqual((current.receipt as any).assertionReceipt.assertionReceiptDigest, (sibling.receipt as any).assertionReceipt.assertionReceiptDigest,
      'F058 fan-out independently authenticates the selectors/intents');
    const bundle = current.receipt as unknown as Record<string, any>;
    assert.equal(bundle.schemaVersion, 'proof-or-stop.verification-receipt-bundle.v5');
    assert.equal(gateCoverage(env).entries[0].status, 'covered');
    assert.ok(bundle.publicationBinding, 'current publication has a signed context');
    for (const field of ['storyId', 'publicationMode', 'executionReceiptDigest', 'assertionReceiptDigest', 'reuseReceiptDigest', 'outputArtifactDigest', 'outputDigest']) {
      const changed = structuredClone(current);
      (changed.receipt as unknown as Record<string, any>).publicationBinding[field] = field === 'storyId' ? 'B-other-publication'
        : field === 'publicationMode' ? 'reused' : 'f'.repeat(64);
      assert.equal(validateVerificationReceipt(env.root, changed.receipt!, { storyId: env.storyId, intentRef: 'PUB-A', selector: SELECTOR }).ok,
        false, `F058 canonical-shaped signed ${field} tamper fails graph validation independently of gate freshness`);
      const cl = env.store.readChecklist(env.storyId);
      cl.items[0].verificationEvidence = [changed];
      assert.notEqual(gateCoverage(env, cl).entries[0].status, 'covered', `F058: signed ${field} tamper rejected`);
    }
    for (const field of ['headHash', 'materialHash', 'storyFilesHash']) {
      const changed = structuredClone(current);
      (changed.receipt as unknown as Record<string, any>).publicationBinding.freshness[field] = 'f'.repeat(field === 'headHash' ? 40 : 64);
      const validation = validateVerificationReceipt(env.root, changed.receipt!, { storyId: env.storyId, intentRef: 'PUB-A', selector: SELECTOR });
      assert.equal(validation.ok, false, `F058 canonical-shaped signed freshness ${field} fails without any outer-row freshness check`);
      assert.match(validation.errors.join('; '), /signature|authentic|binding/i);
      const cl = env.store.readChecklist(env.storyId);
      cl.items[0].verificationEvidence = [changed];
      assert.notEqual(gateCoverage(env, cl).entries[0].status, 'covered', `F058: signed freshness ${field} tamper rejected`);
    }
    for (const fresh of originals.items[0].verificationEvidence!) {
      assert.equal((fresh.receipt as any).schemaVersion, 'proof-or-stop.verification-receipt-bundle.v5', 'F058 canonical fresh producer emits current V5');
      assert.ok((fresh.receipt as any).publicationBinding, 'F058 fresh publication includes signed context');
    }
    assert.equal((sibling.receipt as any).schemaVersion, 'proof-or-stop.verification-receipt-bundle.v5');
    assert.ok((sibling.receipt as any).publicationBinding, 'F058 every fan-out assertion has current signed context');

    const cap = makeEnv('B-aa5f-publication-reuse', [intent('PUB-CAP', 'cli')]);
    try {
      assert.equal(verificationReuseCapsuleEnforcementSupported(), true, 'F058 supported reuse mode cannot be skipped');
      const input = 'packages/main/src/publication-cap.txt';
      const manifest = 'packages/main/publication.verification-dependencies.json';
      write(cap.root, input, 'PUBLICATION_CAP_OK\n');
      writeCapsuleManifest(cap.root, manifest, [input]);
      git(cap.root, ['add', input, manifest]); git(cap.root, ['commit', '-m', 'publication capsule']);
      const command = capsuleCommand(cap.root, manifest, [input]);
      await seedPinnedReceipt(cap, { intentRef: 'PUB-CAP', command, selector: 'PUBLICATION_CAP_OK', file: manifest });
      const beforeReuse = structuredClone(findEvidence(cap, 'PUB-CAP')!);
      commitRefreshDrift(cap, 'unrelated-publication-drift');
      cap.launchCounter.count = 0;
      await cap.handlers.verification_evidence_refresh_stale({ storyId: cap.storyId });
      const reused = findEvidence(cap, 'PUB-CAP')!;
      assert.equal(cap.launchCounter.count, 0, 'F058 actual capsule reuse has zero subprocesses');
      assert.equal(gateCoverage(cap).entries[0].status, 'covered');
      assert.equal((reused.receipt as any).schemaVersion, 'proof-or-stop.verification-receipt-bundle.v5');
      assert.equal((reused.receipt as any).publicationMode, 'reused');
      assert.deepEqual((reused.receipt as any).executionReceipt, (beforeReuse.receipt as any).executionReceipt, 'F058 reuse never rewrites execution history');
      const publication = (reused.receipt as any).publicationBinding;
      assert.equal(publication.storyId, cap.storyId);
      assert.equal(publication.publicationMode, 'reused');
      assert.deepEqual(publication.freshness, { headHash: reused.headHash, materialHash: reused.materialHash, storyFilesHash: reused.storyFilesHash });
      for (const field of ['storyId', 'publicationMode', 'executionReceiptDigest', 'assertionReceiptDigest', 'reuseReceiptDigest', 'outputArtifactDigest', 'outputDigest']) {
        const cl = cap.store.readChecklist(cap.storyId);
        (cl.items[0].verificationEvidence![0].receipt as any).publicationBinding[field] = field === 'storyId' ? 'B-other-publication'
          : field === 'publicationMode' ? 'executed' : 'f'.repeat(64);
        assert.equal(validateVerificationReceipt(cap.root, cl.items[0].verificationEvidence![0].receipt!, {
          storyId: cap.storyId, intentRef: 'PUB-CAP', selector: 'PUBLICATION_CAP_OK',
        }).ok, false, `F058 reused canonical-shaped ${field} fails independent graph authentication`);
        assert.notEqual(gateCoverage(cap, cl).entries[0].status, 'covered', `F058 reused signed ${field} rejected`);
      }
      for (const field of ['headHash', 'materialHash', 'storyFilesHash']) {
        const cl = cap.store.readChecklist(cap.storyId);
        (cl.items[0].verificationEvidence![0].receipt as any).publicationBinding.freshness[field] = 'f'.repeat(field === 'headHash' ? 40 : 64);
        const validation = validateVerificationReceipt(cap.root, cl.items[0].verificationEvidence![0].receipt!, {
          storyId: cap.storyId, intentRef: 'PUB-CAP', selector: 'PUBLICATION_CAP_OK',
        });
        assert.equal(validation.ok, false, `F058 reused signed freshness ${field} fails independent authentication`);
        assert.match(validation.errors.join('; '), /signature|authentic|binding/i);
        assert.notEqual(gateCoverage(cap, cl).entries[0].status, 'covered', `F058 reused signed freshness ${field} rejected`);
      }
    } finally { cleanup(cap); }
  } finally { cleanup(env); }
}

type VerificationFanoutShardReceipt = {
  codexNote?: string;
  fanout: Awaited<ReturnType<typeof partE>>;
};

async function runStoryIdentityShard(): Promise<void> {
  await runBaa5fRepairPair();
  await partLNodePathIdentity();
  await partKCausalIntegration();
  const repairFailures: string[] = [];
  for (const [name, run] of [['F057', partIIdentityDrift], ['F058', partJPublicationBinding]] as const) {
    try { await run(); } catch (error) {
      const detail = `${name}: ${error instanceof Error ? error.message : String(error)}`;
      repairFailures.push(detail);
      console.error(`[CHK-007 RED] ${detail}`);
    }
  }
  assert.equal(repairFailures.length, 0, repairFailures.join('\n'));
  console.log('B-aa5f F057 live-identity-drift PASS');
  console.log('B-aa5f F058 signed-publication-binding PASS');
  console.log('B-aa5f F078 actual-node-path-drift PASS');
  console.log('B-aa5f CHK008 causal-import-integration PASS');
}

async function runVerificationFoundationShard(): Promise<void> {
  await partA();
  await partA2Refusal();
  await partB();
  await partC();
}

async function runVerificationFanoutShard(): Promise<VerificationFanoutShardReceipt> {
  const codexNote = await partD();
  const fanout = await partE();
  return { ...(codexNote ? { codexNote } : {}), fanout };
}

async function runVerificationIntegrityShard(): Promise<void> {
  await partF();
  await partG();
  await partH();
}

function runVerificationShard<T>(argument: string, marker: string): Promise<{ receipt: T; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), argument], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', chunk => { stdout += String(chunk); });
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  return new Promise((resolveShard, rejectShard) => {
    child.once('error', rejectShard);
    child.once('close', code => {
      const markerLine = stdout.split(/\r?\n/).find(line => line.startsWith(marker));
      if (code !== 0 || !markerLine) {
        rejectShard(new Error(`verification shard ${argument} failed or omitted ${marker}: ${stderr || stdout}`));
        return;
      }
      resolveShard({
        receipt: JSON.parse(markerLine.slice(marker.length)) as T,
        stdout: stdout.split(/\r?\n/).filter(line => line && !line.startsWith(marker)).join('\n') + '\n',
        stderr,
      });
    });
  });
}

async function runShardedVerification(): Promise<void> {
  const [storyShard, foundationShard, fanoutShard, integrityShard] = await Promise.all([
    runVerificationShard<{ ok: true }>('--baa5f-story-identity-shard', 'BAA5F_STORY_IDENTITY_SHARD_RECEIPT='),
    runVerificationShard<{ ok: true }>('--baa5f-verification-foundation-shard', 'BAA5F_VERIFICATION_FOUNDATION_SHARD_RECEIPT='),
    runVerificationShard<VerificationFanoutShardReceipt>('--baa5f-verification-fanout-shard', 'BAA5F_VERIFICATION_FANOUT_SHARD_RECEIPT='),
    runVerificationShard<{ ok: true }>('--baa5f-verification-integrity-shard', 'BAA5F_VERIFICATION_INTEGRITY_SHARD_RECEIPT='),
  ]);
  for (const shard of [storyShard, foundationShard, fanoutShard, integrityShard]) {
    process.stdout.write(shard.stdout);
    process.stderr.write(shard.stderr);
  }
  for (const [name, shard] of [
    ['Story identity', storyShard],
    ['verification foundation', foundationShard],
    ['verification integrity', integrityShard],
  ] as const) assert.equal(shard.receipt.ok, true, `${name} shard returns an explicit successful receipt`);
  const { codexNote, fanout } = fanoutShard.receipt;
  if (codexNote) console.log(codexNote);
  console.log(
    `verification receipt layering executionReceipts=${fanout.executionReceiptCount} ` +
    `assertionReceipts=${fanout.assertionReceiptCount} outputArtifacts=${fanout.outputArtifactCount} integrity=pass`,
  );
  console.log(
    `PASS verification-run-and-guard-smoke subprocessExecutionCount=${fanout.subprocessExecutionCount} ` +
    `assertionReceiptCount=${fanout.assertionReceiptCount}`,
  );
}

// ── Runner ──
(async () => {
  if (process.argv.includes('--baa5f-repair-pair')) {
    await runBaa5fRepairPair();
    return;
  }
  if (process.argv.includes('--baa5f-story-identity-shard')) {
    await runStoryIdentityShard();
    console.log(`BAA5F_STORY_IDENTITY_SHARD_RECEIPT=${JSON.stringify({ ok: true })}`);
    return;
  }
  if (process.argv.includes('--baa5f-verification-foundation-shard')) {
    await runVerificationFoundationShard();
    console.log(`BAA5F_VERIFICATION_FOUNDATION_SHARD_RECEIPT=${JSON.stringify({ ok: true })}`);
    return;
  }
  if (process.argv.includes('--baa5f-verification-fanout-shard')) {
    console.log(`BAA5F_VERIFICATION_FANOUT_SHARD_RECEIPT=${JSON.stringify(await runVerificationFanoutShard())}`);
    return;
  }
  if (process.argv.includes('--baa5f-verification-integrity-shard')) {
    await runVerificationIntegrityShard();
    console.log(`BAA5F_VERIFICATION_INTEGRITY_SHARD_RECEIPT=${JSON.stringify({ ok: true })}`);
    return;
  }
  await runShardedVerification();
})().catch((e) => {
  console.error('verification-run-and-guard-smoke: FAIL');
  console.error(e instanceof Error ? (e.stack || e.message) : String(e));
  process.exit(1);
});
