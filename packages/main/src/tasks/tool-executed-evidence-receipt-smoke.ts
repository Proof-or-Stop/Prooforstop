#!/usr/bin/env node
/**
 * B-ec67 CHK-006 — RED-first smoke for tool-executed, selector-bearing evidence
 * receipts. Drives the REAL handlers (verification_evidence_add AND
 * verification_evidence_batch_add) so both write paths are proven to reach the same
 * enforcement boundary, plus the coverage-gate demotion (buildVerificationCoverage).
 *
 * Prints `tool-executed-evidence-receipt-smoke: PASS` on success; throws (non-zero
 * exit) on any failed assertion.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { StoryStore } from '../core/store.js';
import { createChecklistHandlers } from '../handlers/checklist.js';
import { buildVerificationCoverage } from '../core/verification.js';
import { resetConfigCache } from '../core/config.js';
import { runValidationCommand } from '../core/validation-executor.js';
import type { ChecklistData, StoryInfo, VerificationExecutionReceipt, VerificationIntentType } from '../core/types.js';

// Mirror of the private sha256Hex / VERIFICATION_OUTPUT_TAIL_CHARS in
// handlers/checklist.ts (checklist.ts:308-313). Recomputed independently in-test so a
// broken digest computation or truncation bound is actually mutation-killed (F-002).
function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
const VERIFICATION_OUTPUT_TAIL_CHARS = 4000;

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
  assert.ok(threw, `${label}: expected the write to be REFUSED but it succeeded`);
}

interface Env {
  root: string;
  store: StoryStore;
  handlers: ReturnType<typeof createChecklistHandlers>;
  storyId: string;
}

/** Build an isolated temp git repo + story + checklist whose single item carries `intents`. */
function makeEnv(intents: Array<{ ref: string; type: VerificationIntentType }>): Env {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-ec67-'));
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
  }, null, 2));
  write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
  git(root, ['init', '-b', 'work']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'EC67 Smoke']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed']);
  resetConfigCache();
  const store = new StoryStore(root);
  const storyId = 'B-ec67s';
  const at = '2026-07-25T00:00:00.000Z';
  const story: StoryInfo = {
    storyId, name: 'ec67-smoke', title: 'tool-executed evidence receipt smoke',
    description: 'smoke', type: 'chore', phase: 'DEV', priority: 'medium',
    createdAt: at, startedAt: at, endedAt: null,
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001', title: 'exercise receipts', context: 'ctx', status: 'in_progress',
      startTime: null, endTime: null,
      verificationIntent: {
        happy: intents.map((it, i) => ({ id: it.ref, desc: `intent ${i}`, type: it.type, priority: 'must' as const })),
        edge: [], adversarial: [],
      },
    }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
  const handlers = createChecklistHandlers({ store, root, scanRoot: join(root, 'packages/main') });
  return { root, store, handlers, storyId };
}

function cleanup(env: Env): void {
  rmSync(env.root, { recursive: true, force: true });
}

// A trivial pinned command we fully control. The selector must appear in stdout.
const PASS_CMD = `node -e "console.log('MARKER_OK')"`;
const NO_SELECTOR_CMD = `node -e "console.log('SOMETHING_ELSE')"`;
const NONZERO_CMD = `node -e "console.log('MARKER_OK'); process.exit(3)"`;
const SELECTOR = 'MARKER_OK';

// ── 1. POSITIVE through verification_evidence_add: selector present + exit 0 →
//       receipt stamped, result derived, intent pinned. ─────────────────────────
{
  const env = makeEnv([{ ref: 'INT-A', type: 'cli' }]);
  try {
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-A', kind: 'integration_test',
      command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'happy path through single add',
    });
    const cl = env.store.readChecklist(env.storyId);
    const ev = cl.items[0].verificationEvidence?.find(e => e.intentRef === 'INT-A');
    assert.ok(ev, 'evidence recorded');
    assert.equal(ev.mechanical, true, 'evidence marked mechanical');
    assert.ok(ev.receipt, 'receipt stamped');
    assert.equal(ev.receipt.exitCode, 0, 'receipt.exitCode is the real exit');
    assert.equal(ev.receipt.selectorMatched, true, 'selector matched');
    assert.match(ev.receipt.outputDigest, /^[0-9a-f]{64}$/, 'outputDigest is sha256 hex');
    assert.match(ev.receipt.outputTail, /MARKER_OK/, 'outputTail carries real output');
    assert.ok(ev.receipt.executedAt, 'executedAt stamped');
    // F-002: the output is short (< tail bound) so outputTail IS the full captured
    // output; recompute sha256 of it and assert equality. If sha256Hex hashed the
    // wrong bytes (the mutation the reviewer applied), this equality would fail.
    assert.ok(ev.receipt.outputTail.length < VERIFICATION_OUTPUT_TAIL_CHARS, 'short output: tail is the full captured output');
    assert.equal(ev.receipt.outputDigest, sha256Hex(ev.receipt.outputTail), 'outputDigest == sha256(captured output)');
    assert.equal(ev.result, 'pass', 'result derived from receipt');
    const pin = cl.items[0].verificationIntent?.happy[0].verification;
    assert.ok(pin, 'intent pinned on first write');
    assert.equal(pin.command, PASS_CMD, 'pinned command');
    assert.equal(pin.selector, SELECTOR, 'pinned selector');
    // coverage: an executed receipt covers an executable intent
    const cov = buildVerificationCoverage(cl);
    assert.equal(cov.entries[0].status, 'covered', 'executed receipt covers executable intent');
    assert.equal(cov.missingRequired, 0);
  } finally { cleanup(env); }
}

// ── 2. POSITIVE through verification_evidence_batch_add (parity). ───────────────
{
  const env = makeEnv([{ ref: 'INT-B', type: 'cli' }]);
  try {
    await env.handlers.verification_evidence_batch_add({
      storyId: env.storyId,
      evidences: [{
        itemId: 'CHK-001', intentRef: 'INT-B', kind: 'integration_test',
        command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'happy path through batch add',
      }],
    });
    const cl = env.store.readChecklist(env.storyId);
    const ev = cl.items[0].verificationEvidence?.find(e => e.intentRef === 'INT-B');
    assert.ok(ev?.receipt, 'batch path stamps a receipt too');
    assert.equal(ev.mechanical, true);
    assert.equal(ev.result, 'pass', 'batch path derives result from receipt');
    assert.equal(cl.items[0].verificationIntent?.happy[0].verification?.command, PASS_CMD, 'batch path pins');
  } finally { cleanup(env); }
}

// ── 2b. F-002: a LONG captured output proves outputTail is BOUNDED (truncated to the
//        tail) while outputDigest is sha256 of the FULL untruncated output. ──────────
{
  const env = makeEnv([{ ref: 'INT-LONG', type: 'cli' }]);
  try {
    // Deterministic output we can reconstruct byte-for-byte: 'MARKER_OK' padded to 5000
    // chars with 'X' (no newline, no stderr) → longer than the 4000-char tail bound.
    const full = 'MARKER_OK'.padEnd(5000, 'X');
    const LONG_CMD = `node -e "process.stdout.write('MARKER_OK'.padEnd(5000,'X'))"`;
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-LONG', kind: 'integration_test',
      command: LONG_CMD, selector: SELECTOR, result: 'pass', note: 'long output proves the tail bound',
    });
    const cl = env.store.readChecklist(env.storyId);
    const ev = cl.items[0].verificationEvidence?.find(e => e.intentRef === 'INT-LONG');
    assert.ok(ev?.receipt, 'receipt stamped for long output');
    // Bounded: the tail is EXACTLY the last 4000 chars, not the full 5000.
    assert.equal(ev.receipt.outputTail.length, VERIFICATION_OUTPUT_TAIL_CHARS, 'outputTail is bounded to the tail size');
    assert.equal(ev.receipt.outputTail, full.slice(full.length - VERIFICATION_OUTPUT_TAIL_CHARS), 'outputTail is the LAST bytes of the output');
    // Digest is over the FULL output, not the truncated tail.
    assert.equal(ev.receipt.outputDigest, sha256Hex(full), 'outputDigest == sha256(FULL untruncated output)');
    assert.notEqual(sha256Hex(ev.receipt.outputTail), ev.receipt.outputDigest, 'digest covers more than the tail (bound is real, not a no-op)');
  } finally { cleanup(env); }
}

// ── 2c. B-212f BUG-001: receipt judgement must use the complete captured output even
//        when the selector occurs beyond the ordinary validation-result head window. The
//        public validation result remains bounded; only the pinned evidence path consumes
//        the already-captured complete bytes for matching, digesting, and its 4000-char tail.
{
  const env = makeEnv([{ ref: 'INT-BEYOND-WINDOW', type: 'cli' }]);
  try {
    const full = `${'X'.repeat(12_001)}MARKER_OK`;
    const command = `node -e "process.stdout.write('X'.repeat(12001) + 'MARKER_OK')"`;

    const routineResult = await runValidationCommand({
      label: 'bounded-routine-validation-output',
      command: 'node',
      args: ['-e', "process.stdout.write('X'.repeat(12001) + 'MARKER_OK')"],
    }, env.root);
    assert.equal(routineResult.output.slice(0, 12_000), 'X'.repeat(12_000), 'ordinary validation result retains exactly its bounded head window');
    assert.doesNotMatch(routineResult.output, /MARKER_OK/, 'ordinary validation result retains only its bounded head window');
    assert.match(routineResult.output, /\.\.\.\[truncated 10 chars\]$/, 'ordinary validation result describes the omitted bytes');

    await env.handlers.verification_evidence_add({
      storyId: env.storyId,
      itemId: 'CHK-001',
      intentRef: 'INT-BEYOND-WINDOW',
      kind: 'integration_test',
      command,
      selector: SELECTOR,
      result: 'pass',
      note: 'selector after the ordinary 12000-character validation output window',
    });

    const evidence = env.store.readChecklist(env.storyId).items[0].verificationEvidence
      ?.find(entry => entry.intentRef === 'INT-BEYOND-WINDOW');
    assert.ok(evidence?.receipt, 'selector beyond the ordinary validation window earns a receipt');
    assert.equal(evidence.receipt.selectorMatched, true, 'complete captured output is used for selector matching');
    assert.equal(evidence.receipt.outputDigest, sha256Hex(full), 'receipt digest covers complete captured output');
    assert.equal(evidence.receipt.outputTail.length, VERIFICATION_OUTPUT_TAIL_CHARS, 'persisted outputTail remains exactly 4000 characters');
    assert.equal(evidence.receipt.outputTail, full.slice(-VERIFICATION_OUTPUT_TAIL_CHARS), 'persisted outputTail is the complete output tail');
  } finally { cleanup(env); }
}

// ── 3. RED: selector absent from output is REFUSED (via BOTH entry points). ─────
{
  const env = makeEnv([{ ref: 'INT-C', type: 'cli' }]);
  try {
    await expectRejection(
      env.handlers.verification_evidence_add({
        storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-C', kind: 'integration_test',
        command: NO_SELECTOR_CMD, selector: SELECTOR, result: 'pass', note: 'selector-absent RED single',
      }),
      /receipt_selector_absent/, 'selector-absent single-add',
    );
    await expectRejection(
      env.handlers.verification_evidence_batch_add({
        storyId: env.storyId,
        evidences: [{ itemId: 'CHK-001', intentRef: 'INT-C', kind: 'integration_test', command: NO_SELECTOR_CMD, selector: SELECTOR, result: 'pass', note: 'selector-absent RED batch' }],
      }),
      /receipt_selector_absent/, 'selector-absent batch-add',
    );
    // nothing was written for the refused intent
    const cl = env.store.readChecklist(env.storyId);
    assert.equal(cl.items[0].verificationEvidence?.some(e => e.intentRef === 'INT-C') ?? false, false, 'refused row is not persisted');
  } finally { cleanup(env); }
}

// ── 4. REFUSE: exit != 0 while pass is claimed (BOTH entry points). ─────────────
{
  const env = makeEnv([{ ref: 'INT-D', type: 'cli' }]);
  try {
    await expectRejection(
      env.handlers.verification_evidence_add({
        storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-D', kind: 'integration_test',
        command: NONZERO_CMD, selector: SELECTOR, result: 'pass', note: 'nonzero exit but pass claimed single',
      }),
      /receipt_exit_nonzero/, 'exit-nonzero-pass single-add',
    );
    await expectRejection(
      env.handlers.verification_evidence_batch_add({
        storyId: env.storyId,
        evidences: [{ itemId: 'CHK-001', intentRef: 'INT-D', kind: 'integration_test', command: NONZERO_CMD, selector: SELECTOR, result: 'pass', note: 'nonzero exit but pass claimed batch' }],
      }),
      /receipt_exit_nonzero/, 'exit-nonzero-pass batch-add',
    );
  } finally { cleanup(env); }
}

// ── 5. REFUSE: intentRef does not resolve to an intent on the item (BOTH). ──────
{
  const env = makeEnv([{ ref: 'INT-E', type: 'cli' }]);
  try {
    await expectRejection(
      env.handlers.verification_evidence_add({
        storyId: env.storyId, itemId: 'CHK-001', intentRef: 'CHK-001:happy:9', kind: 'integration_test',
        command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'unresolved intentRef single',
      }),
      /intent_ref_unresolved/, 'intentRef-unresolved single-add',
    );
    await expectRejection(
      env.handlers.verification_evidence_batch_add({
        storyId: env.storyId,
        evidences: [{ itemId: 'CHK-001', intentRef: 'NOPE-404', kind: 'integration_test', command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'unresolved intentRef batch' }],
      }),
      /intent_ref_unresolved/, 'intentRef-unresolved batch-add',
    );
  } finally { cleanup(env); }
}

// ── 6. REFUSE: pinned-command mismatch / pin-change on the second write (BOTH). ─
{
  const env = makeEnv([{ ref: 'INT-F', type: 'cli' }]);
  try {
    // First write pins the command.
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-F', kind: 'integration_test',
      command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'first pins the command',
    });
    const OTHER_CMD = `node -e "console.log('MARKER_OK'); console.log('v2')"`;
    // Second write with a DIFFERENT command is refused (pin is immutable) — single path.
    await expectRejection(
      env.handlers.verification_evidence_add({
        storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-F', kind: 'integration_test',
        command: OTHER_CMD, selector: SELECTOR, result: 'pass', note: 'second write changes command single',
      }),
      /receipt_command_mismatch/, 'pin-change single-add',
    );
    // Second write with a DIFFERENT command is refused — batch path too.
    await expectRejection(
      env.handlers.verification_evidence_batch_add({
        storyId: env.storyId,
        evidences: [{ itemId: 'CHK-001', intentRef: 'INT-F', kind: 'integration_test', command: OTHER_CMD, selector: SELECTOR, result: 'pass', note: 'second write changes command batch' }],
      }),
      /receipt_command_mismatch/, 'pin-change batch-add',
    );
    // The pin is unchanged, and a second write with the SAME command re-executes and passes.
    const before = env.store.readChecklist(env.storyId).items[0].verificationIntent?.happy[0].verification;
    assert.equal(before?.command, PASS_CMD, 'pin unchanged after refused writes');
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-F', kind: 'integration_test',
      command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'same command re-executes',
    });
    const ev = env.store.readChecklist(env.storyId).items[0].verificationEvidence?.find(e => e.intentRef === 'INT-F');
    assert.equal(ev?.result, 'pass', 'same-command second write re-executes and passes');
    assert.ok(ev?.receipt, 're-executed write stamps a fresh receipt');
  } finally { cleanup(env); }
}

// ── 7. GATE: a manual attestation does NOT cover an executable intent, and a
//       legacy (unpinned, mechanical:undefined) evidence row still LOADS + covers. ─
{
  // 7a: a non-mechanical attestation recorded for an executable intent (via the
  //     audited escape) is stored but DEMOTED by the coverage gate.
  const env = makeEnv([{ ref: 'INT-G', type: 'cli' }]);
  try {
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-G', kind: 'manual_transcript',
      result: 'pass', note: 'manual attestation against an executable intent',
      nonMechanicalReason: 'execution genuinely impossible here; recorded as audited non-mechanical escape',
    });
    const cl = env.store.readChecklist(env.storyId);
    const ev = cl.items[0].verificationEvidence?.find(e => e.intentRef === 'INT-G');
    assert.equal(ev?.mechanical, false, 'escape records a non-mechanical attestation');
    assert.ok(ev?.nonMechanicalReason, 'escape reason is attributable/persisted');
    const cov = buildVerificationCoverage(cl);
    assert.equal(cov.entries[0].status, 'non_mechanical', 'manual attestation does NOT cover an executable intent');
    assert.equal(cov.missingRequired, 1, 'demoted attestation leaves the executable intent uncovered');
  } finally { cleanup(env); }

  // 7b: pure GATE fixture — mechanical:false attestation vs legacy mechanical:undefined.
  const demoted = buildVerificationCoverage({
    items: [{
      id: 'CHK-001', title: 't', status: 'done', startTime: null, endTime: null,
      verificationIntent: { happy: [{ id: 'INT-X', desc: 'exec', type: 'logic', priority: 'must' }], edge: [], adversarial: [] },
      verificationEvidence: [{ intentRef: 'INT-X', kind: 'manual_transcript', result: 'pass', note: 'manual', mechanical: false }],
    }],
  });
  assert.equal(demoted.entries[0].status, 'non_mechanical', 'gate demotes mechanical:false on an executable intent');
  assert.equal(demoted.missingRequired, 1);

  const legacy = buildVerificationCoverage({
    items: [{
      id: 'CHK-001', title: 't', status: 'done', startTime: null, endTime: null,
      verificationIntent: { happy: [{ id: 'INT-Y', desc: 'exec', type: 'logic', priority: 'must' }], edge: [], adversarial: [] },
      // legacy prose-only row: no pin, mechanical undefined, no receipt
      verificationEvidence: [{ intentRef: 'INT-Y', kind: 'logic_test', result: 'pass', note: 'legacy prose-only evidence' }],
    }],
  });
  assert.equal(legacy.entries[0].status, 'covered', 'legacy prose-only evidence still loads and is grandfathered (covered)');
  assert.equal(legacy.missingRequired, 0);

  // 7c: a genuinely manual INTENT keeps covering via its attestation (no demotion).
  const manualIntent = buildVerificationCoverage({
    items: [{
      id: 'CHK-001', title: 't', status: 'done', startTime: null, endTime: null,
      verificationIntent: { happy: [{ id: 'INT-Z', desc: 'manual', type: 'manual', priority: 'must' }], edge: [], adversarial: [] },
      verificationEvidence: [{ intentRef: 'INT-Z', kind: 'manual_transcript', result: 'pass', note: 'manual intent attestation', mechanical: false }],
    }],
  });
  assert.equal(manualIntent.entries[0].status, 'covered', 'a manual INTENT is still covered by its attestation');
}

// ── 8. F-006: a NEW executable-intent write with NEITHER a selector NOR a
//       nonMechanicalReason is REFUSED via BOTH entry points (no silent grandfather).
//       (This block replaces the old case-8 that WRONGLY asserted a fresh executable
//        intent was grandfathered-covered with no execution.) ─────────────────────────
{
  const env = makeEnv([{ ref: 'INT-H', type: 'logic' }]);
  try {
    await expectRejection(
      env.handlers.verification_evidence_add({
        storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-H', kind: 'logic_test',
        command: 'npm test', result: 'pass', note: 'no-selector no-reason fabricated pass (single)',
      }),
      /executable_intent_requires_selector_or_reason/, 'F-006 no-selector-no-reason single-add',
    );
    await expectRejection(
      env.handlers.verification_evidence_batch_add({
        storyId: env.storyId,
        evidences: [{ itemId: 'CHK-001', intentRef: 'INT-H', kind: 'logic_test', command: 'npm test', result: 'pass', note: 'no-selector no-reason fabricated pass (batch)' }],
      }),
      /executable_intent_requires_selector_or_reason/, 'F-006 no-selector-no-reason batch-add',
    );
    // Nothing was persisted, and the executable intent stays uncovered (missingRequired=1).
    const cl = env.store.readChecklist(env.storyId);
    assert.equal(cl.items[0].verificationEvidence?.some(e => e.intentRef === 'INT-H') ?? false, false, 'refused fabricated pass is not persisted');
    assert.equal(buildVerificationCoverage(cl).missingRequired, 1, 'a fresh executable intent with no valid evidence is NOT covered');
  } finally { cleanup(env); }
}

// ── 9. F-003: result is DERIVED from the receipt, not echoed from the caller. ───────
{
  const env = makeEnv([{ ref: 'INT-OMIT', type: 'cli' }, { ref: 'INT-UNDER', type: 'cli' }]);
  try {
    // 9a: caller OMITS result entirely; exit 0 && selector present → derived 'pass'.
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-OMIT', kind: 'integration_test',
      command: PASS_CMD, selector: SELECTOR, note: 'result omitted — must be derived from the receipt',
    });
    const omit = env.store.readChecklist(env.storyId).items[0].verificationEvidence?.find(e => e.intentRef === 'INT-OMIT');
    assert.equal(omit?.result, 'pass', 'omitted result is derived as pass from exit 0 + selector match');
    assert.equal(omit?.mechanical, true, 'derived-result write is still a mechanical receipt');

    // 9b: caller UNDER-claims result:'fail' but exit 0 && selector present → the receipt
    //     OVERRIDES the caller to 'pass'. Kills the "echo the caller" mutation.
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-UNDER', kind: 'integration_test',
      command: PASS_CMD, selector: SELECTOR, result: 'fail', note: 'caller under-claims fail; receipt says pass',
    });
    const under = env.store.readChecklist(env.storyId).items[0].verificationEvidence?.find(e => e.intentRef === 'INT-UNDER');
    assert.equal(under?.result, 'pass', 'caller-claimed fail is OVERRIDDEN by the receipt-derived pass');
  } finally { cleanup(env); }
}

// ── 10. F-004: a GENUINELY manual|docs-typed intent goes through the handler and is
//        stored as a non-mechanical attestation with NO execution attempted. ─────────
{
  const env = makeEnv([{ ref: 'INT-MAN', type: 'manual' }, { ref: 'INT-DOC', type: 'docs' }]);
  try {
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-MAN', kind: 'manual_transcript',
      result: 'pass', note: 'genuinely manual intent — attestation only, no command run',
    });
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-DOC', kind: 'docs_check',
      result: 'pass', note: 'genuinely docs intent — attestation only, no command run',
    });
    const cl = env.store.readChecklist(env.storyId);
    const man = cl.items[0].verificationEvidence?.find(e => e.intentRef === 'INT-MAN');
    const doc = cl.items[0].verificationEvidence?.find(e => e.intentRef === 'INT-DOC');
    assert.equal(man?.mechanical, false, 'manual-typed intent stored as explicit non-mechanical attestation');
    assert.equal(man?.receipt, undefined, 'manual-typed intent attempts no execution → no receipt');
    assert.equal(doc?.mechanical, false, 'docs-typed intent stored as explicit non-mechanical attestation');
    assert.equal(doc?.receipt, undefined, 'docs-typed intent attempts no execution → no receipt');
    const cov = buildVerificationCoverage(cl);
    assert.equal(cov.missingRequired, 0, 'manual|docs attestations cover their own (non-executable) intents');
  } finally { cleanup(env); }
}

// ── 11. F-005: a sub-30-char nonMechanicalReason is refused by the HANDLER re-validation
//        even though it reaches the internal fn call directly (bypassing Zod). ─────────
{
  const env = makeEnv([{ ref: 'INT-SHORT', type: 'cli' }]);
  try {
    await expectRejection(
      env.handlers.verification_evidence_add({
        storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-SHORT', kind: 'manual_transcript',
        result: 'pass', note: 'short escape reason must be refused', nonMechanicalReason: 'too short',
      }),
      /non_mechanical_reason_too_short/, 'F-005 sub-30 nonMechanicalReason via internal fn path',
    );
    const cl = env.store.readChecklist(env.storyId);
    assert.equal(cl.items[0].verificationEvidence?.some(e => e.intentRef === 'INT-SHORT') ?? false, false, 'refused short-reason escape is not persisted');
  } finally { cleanup(env); }
}

// ── 12. F-007 + F-008: checklist_update's bulk verificationEvidence setter. Caller-supplied
//        receipt fields are UNTRUSTED (stripped); a receipt survives a re-persist ONLY by
//        being carried forward from REAL on-disk evidence recorded via the enforced path.
//        This exercises the CLI-REACHABLE behavior (the CLI schema .strip()s the provenance
//        fields, and carryForwardOnDiskProvenance drops them on the internal fn path too),
//        NOT a caller-trusted receipt that no real `proof-or-stop checklist_update` caller can send. ──
{
  const env = makeEnv([{ ref: 'INT-EXEC', type: 'logic' }, { ref: 'INT-MAN2', type: 'manual' }]);
  try {
    // 12a: a raw fabricated executable pass (no receipt) via checklist_update is REFUSED.
    assert.throws(
      () => env.handlers.checklist_update({
        storyId: env.storyId, itemId: 'CHK-001',
        verificationEvidence: [{ intentRef: 'INT-EXEC', kind: 'logic_test', command: 'this-command-does-not-exist --lies', result: 'pass', note: 'trust me — never executed' }],
      }),
      /checklist_update_executable_evidence_unenforced/,
      'F-007 fabricated executable pass via checklist_update is refused',
    );
    assert.equal(env.store.readChecklist(env.storyId).items[0].verificationEvidence ?? undefined, undefined, 'refused checklist_update write persisted nothing');

    // 12b: a caller-supplied FABRICATED mechanical receipt is UNTRUSTED (F-008). With no real
    //      on-disk receipt for INT-EXEC, the caller's receipt/mechanical are stripped to
    //      undefined and the executable row is REFUSED — caller receipt injection cannot
    //      launder coverage. (Breaking carryForwardOnDiskProvenance so it TRUSTS the caller
    //      receipt makes this write succeed instead of throwing → the assert.throws fails →
    //      the injection regression is mutation-killed.)
    const fabricated: VerificationExecutionReceipt = {
      exitCode: 0, outputDigest: sha256Hex('LIE\n'), outputTail: 'LIE\n', selectorMatched: true, executedAt: new Date().toISOString(),
    };
    assert.throws(
      () => env.handlers.checklist_update({
        storyId: env.storyId, itemId: 'CHK-001',
        verificationEvidence: [{ intentRef: 'INT-EXEC', kind: 'logic_test', command: 'never-run --lies', result: 'pass', note: 'fake caller receipt', mechanical: true, receipt: fabricated }],
      }),
      /checklist_update_executable_evidence_unenforced/,
      'F-008 caller-supplied fabricated receipt is stripped/untrusted and refused',
    );
    assert.equal(env.store.readChecklist(env.storyId).items[0].verificationEvidence ?? undefined, undefined, 'fabricated-receipt checklist_update persisted nothing');

    // Seed a GENUINE on-disk receipt for INT-EXEC through the ENFORCED path (runs PASS_CMD).
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-EXEC', kind: 'logic_test',
      command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'real tool-executed receipt',
    });
    const seeded = env.store.readChecklist(env.storyId).items[0].verificationEvidence?.find(e => e.intentRef === 'INT-EXEC');
    assert.equal(seeded?.mechanical, true, 'seed: genuine receipt recorded as mechanical:true');
    assert.ok(seeded?.receipt, 'seed: genuine receipt present on disk');
    const seededDigest = seeded.receipt.outputDigest;

    // 12c: a LEGITIMATE re-persist (metadata edit only — SAME on-disk command+result, caller
    //      supplies NO receipt) preserves the REAL on-disk receipt (carried forward from disk,
    //      not from the caller) and stays covered. INT-MAN2 is a manual (attestation-only)
    //      intent, covered by a plain manual_transcript row. (Breaking carryForwardOnDiskProvenance
    //      so it DROPS the on-disk receipt makes this row a raw executable pass → the guard
    //      throws checklist_update_executable_evidence_unenforced → the smoke fails: the
    //      receipt-preserve logic is mutation-killed.)
    env.handlers.checklist_update({
      storyId: env.storyId, itemId: 'CHK-001',
      verificationEvidence: [
        { intentRef: 'INT-MAN2', kind: 'manual_transcript', result: 'pass', note: 'manual attestation for an attestation-only intent' },
        { intentRef: 'INT-EXEC', kind: seeded.kind, command: seeded.command, result: seeded.result, note: 'legitimate re-persist: metadata edit only, no receipt supplied' },
      ],
    });
    const cl = env.store.readChecklist(env.storyId);
    const exec = cl.items[0].verificationEvidence?.find(e => e.intentRef === 'INT-EXEC');
    assert.equal(exec?.mechanical, true, 'on-disk receipt is carried forward as mechanical:true on re-persist');
    assert.ok(exec?.receipt, 'on-disk receipt survives the re-persist (not stripped)');
    assert.equal(exec.receipt.outputDigest, seededDigest, 'carried-forward receipt is the REAL on-disk one (same digest), not a caller fabrication');
    assert.equal(exec.note, 'legitimate re-persist: metadata edit only, no receipt supplied', 're-persist applied the metadata edit');
    const cov = buildVerificationCoverage(cl);
    assert.equal(cov.missingRequired, 0, 'a re-persisted intent with its preserved real receipt + manual attestation cover both intents');
  } finally { cleanup(env); }
}

// ══════════════════════════════════════════════════════════════════════════════════
// B-cdf6 (B-META F-012): distinct receipt-timeout refusal + bounded audited timeout
// override.
//
// THE BUG: a verification intent whose proof IS "the root DONE-blocking suite passes"
// could not be witnessed by a tool-executed receipt. Every production call site omitted
// `options.timeoutMs`, so the pinned command always ran under the 270s
// DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS while the suite takes 21-24 min. The run was KILLED
// mid-flight, never printed a verdict line, and the refusal named ONLY the absent
// selector — so three separate attempts were refused at ~270.3s with
// [receipt_selector_absent], misdiagnosed first as a stdout capture problem and then as a
// clean-tree assertion, before anyone read the executor and found the constant.
//
// These cases use a SHORT override (a few hundred ms) against a deliberately-slow pinned
// command so the timeout path is exercised in ~1s instead of 270s. That is the same code
// path: `runSingleAllowlistedCommand` arms the ceiling, `runValidationCommand` kills the
// child and reports timedOut + exit 124, and enforceAndStampEvidence refuses.
// ══════════════════════════════════════════════════════════════════════════════════

// Sleeps well past any override used below, THEN prints the selector. Under a short
// ceiling it is killed before the selector is ever emitted — exactly the F-012 shape
// (killed mid-run ⟹ selector trivially absent).
const SLOW_THEN_SELECTOR_CMD = `node -e "setTimeout(()=>console.log('MARKER_OK'), 60000)"`;

// ── 13. F-012 (1): a pinned command KILLED at its ceiling yields the DISTINCT
//        [receipt_command_timeout], NOT [receipt_selector_absent]. ────────────────────
{
  const env = makeEnv([{ ref: 'INT-TIMEOUT', type: 'cli' }, { ref: 'INT-TIMEOUT-B', type: 'cli' }]);
  try {
    // Single-add path.
    let singleMsg = '';
    try {
      await env.handlers.verification_evidence_add({
        storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-TIMEOUT', kind: 'integration_test',
        command: SLOW_THEN_SELECTOR_CMD, selector: SELECTOR, result: 'pass',
        note: 'F-012: killed at the ceiling before the selector is printed',
        commandTimeoutMs: 700,
        commandTimeoutReason: 'short ceiling used by the smoke to exercise the timeout refusal path in ~1s',
      });
      assert.fail('F-012: a killed pinned command must be REFUSED, not recorded');
    } catch (e) {
      singleMsg = e instanceof Error ? e.message : String(e);
    }
    assert.match(singleMsg, /receipt_command_timeout/, 'F-012: a killed run is refused with the DISTINCT timeout marker');
    // The whole point of the fix: it must NOT masquerade as a selector problem.
    assert.ok(
      !/receipt_selector_absent/.test(singleMsg),
      `F-012: the timeout refusal must NOT report receipt_selector_absent (that is the misdiagnosis this fixes); got: ${singleMsg}`,
    );
    // It must NAME the budget so the diagnosis is one line, not a guessing game.
    assert.match(singleMsg, /700ms wall-clock ceiling/, 'F-012: the refusal names the ARMED budget');
    assert.match(singleMsg, /KILLED/, 'F-012: the refusal says the command was killed');
    // Nothing was persisted — a killed run can never mint a receipt.
    let cl = env.store.readChecklist(env.storyId);
    assert.equal(
      cl.items[0].verificationEvidence?.some(e => e.intentRef === 'INT-TIMEOUT') ?? false, false,
      'F-012: a timed-out run persists NO evidence row',
    );
    assert.equal(buildVerificationCoverage(cl).missingRequired, 2, 'F-012: both intents stay uncovered after the timeout');

    // Batch path parity: the same distinct marker, so neither write path is left
    // reporting the misleading selector-absent refusal.
    await expectRejection(
      env.handlers.verification_evidence_batch_add({
        storyId: env.storyId,
        evidences: [{
          itemId: 'CHK-001', intentRef: 'INT-TIMEOUT-B', kind: 'integration_test',
          command: SLOW_THEN_SELECTOR_CMD, selector: SELECTOR, result: 'pass',
          note: 'F-012 batch: killed at the ceiling',
          commandTimeoutMs: 700,
          commandTimeoutReason: 'short ceiling used by the smoke to exercise the batch timeout refusal path',
        }],
      }),
      /receipt_command_timeout/, 'F-012 timeout refusal via batch-add',
    );
    cl = env.store.readChecklist(env.storyId);
    assert.equal(
      cl.items[0].verificationEvidence?.some(e => e.intentRef === 'INT-TIMEOUT-B') ?? false, false,
      'F-012: the batch timeout persists NO evidence row',
    );
  } finally { cleanup(env); }
}

// ── 13b. F-012: a genuinely-absent selector on a command that RAN TO COMPLETION still
//         reports [receipt_selector_absent]. Proves the new timeout branch did not
//         swallow the pre-existing selector diagnosis (no over-broad reclassification). ─
{
  const env = makeEnv([{ ref: 'INT-STILL-ABSENT', type: 'cli' }]);
  try {
    let msg = '';
    try {
      await env.handlers.verification_evidence_add({
        storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-STILL-ABSENT', kind: 'integration_test',
        command: NO_SELECTOR_CMD, selector: SELECTOR, result: 'pass',
        note: 'exits 0 fast but never prints the selector',
        commandTimeoutMs: 60_000,
        commandTimeoutReason: 'generous ceiling so the command completes; only the selector is genuinely missing here',
      });
      assert.fail('a genuinely absent selector must still be refused');
    } catch (e) { msg = e instanceof Error ? e.message : String(e); }
    assert.match(msg, /receipt_selector_absent/, 'a completed run with a missing selector still reports selector_absent');
    assert.ok(!/receipt_command_timeout/.test(msg), 'a completed run is NOT reported as a timeout');
  } finally { cleanup(env); }
}

// ── 14. F-012 (2): the override within the cap is HONOURED and gate-visible. ─────────
{
  const env = makeEnv([{ ref: 'INT-OVERRIDE', type: 'cli' }]);
  try {
    // A command that takes ~1.2s: it would be killed by a sub-second ceiling but passes
    // comfortably under the raised one. Proves the override actually ARMS the executor
    // (a no-op override would leave the 270s default and this would pass either way, so
    // case 14b below pins the causality with the mirror-image failure).
    const SLOWISH_PASS_CMD = `node -e "setTimeout(()=>console.log('MARKER_OK'), 1200)"`;
    const out = await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-OVERRIDE', kind: 'integration_test',
      command: SLOWISH_PASS_CMD, selector: SELECTOR, result: 'pass',
      note: 'override within the cap earns a REAL receipt',
      commandTimeoutMs: 30_000,
      commandTimeoutReason: 'this witness legitimately needs more than the default ceiling to print its verdict line',
    });
    const cl = env.store.readChecklist(env.storyId);
    const ev = cl.items[0].verificationEvidence?.find(e => e.intentRef === 'INT-OVERRIDE');
    assert.ok(ev?.receipt, 'F-012: an override within the cap earns a real tool-executed receipt');
    assert.equal(ev.mechanical, true, 'F-012: the raised-budget receipt is mechanical:true');
    assert.equal(ev.result, 'pass', 'F-012: result is still DERIVED from the actual exit + selector match');
    assert.equal(ev.receipt.exitCode, 0);
    assert.equal(ev.receipt.selectorMatched, true);
    // GATE-VISIBLE: the armed budget + the attributable reason are stamped on the
    // TOOL-OWNED receipt, so a reviewer can see this pass was earned under a raised budget.
    assert.equal(ev.receipt.timeoutMs, 30_000, 'F-012: the armed ceiling is recorded on the receipt');
    assert.ok(ev.receipt.timeoutOverride, 'F-012: a raised budget stamps an audited override block');
    assert.equal(ev.receipt.timeoutOverride.timeoutMs, 30_000, 'F-012: override records the raised ceiling');
    assert.equal(ev.receipt.timeoutOverride.defaultTimeoutMs, 270_000, 'F-012: override records the default it was raised above');
    assert.match(ev.receipt.timeoutOverride.reason, /legitimately needs more than the default/, 'F-012: the reason is persisted verbatim');
    // Visible in the command's own stdout too, not only inside the persisted JSON.
    assert.match(out, /timeoutOverride=30000ms/, 'F-012: the raised budget is surfaced in the handler output');
    // The receipt still covers the executable intent (the override does not weaken coverage).
    assert.equal(buildVerificationCoverage(cl).missingRequired, 0, 'F-012: a raised-budget receipt covers its intent');
  } finally { cleanup(env); }
}

// ── 14b. F-012: CAUSALITY — the SAME command that passes under a raised ceiling in 14 is
//         KILLED under a sub-second one. If commandTimeoutMs were ignored (a no-op that
//         always used the 270s default), this case would PASS instead of refusing, so the
//         "override actually arms the executor" claim is mutation-killed. ───────────────
{
  const env = makeEnv([{ ref: 'INT-CAUSAL', type: 'cli' }]);
  try {
    const SLOWISH_PASS_CMD = `node -e "setTimeout(()=>console.log('MARKER_OK'), 1200)"`;
    await expectRejection(
      env.handlers.verification_evidence_add({
        storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-CAUSAL', kind: 'integration_test',
        command: SLOWISH_PASS_CMD, selector: SELECTOR, result: 'pass',
        note: 'same command, sub-second ceiling → killed',
        commandTimeoutMs: 300,
        commandTimeoutReason: 'deliberately tiny ceiling proving the override value really arms the executor',
      }),
      /receipt_command_timeout/, 'F-012 causality: a tiny override really shortens the ceiling',
    );
  } finally { cleanup(env); }
}

// ── 15. F-012 (2): an override ABOVE the cap is REFUSED (not clamped), and an override
//        with NO reason / a too-short reason is REFUSED — on BOTH write paths, and via
//        the internal fn path that BYPASSES Zod (CLAUDE.md Handler coding convention:
//        every Zod constraint is re-validated at the handler entry AND at the consuming
//        enforcement boundary, so an old-JSON / internal-call payload cannot slip past).
{
  const CAP = 7_200_000;
  const env = makeEnv([{ ref: 'INT-CAP', type: 'cli' }]);
  try {
    // 15a: above the cap → REFUSED, explicitly not clamped.
    await expectRejection(
      env.handlers.verification_evidence_add({
        storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-CAP', kind: 'integration_test',
        command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'above-cap override must be refused',
        commandTimeoutMs: CAP + 1,
        commandTimeoutReason: 'a reason long enough to satisfy the thirty character floor for the override',
      }),
      /command_timeout_above_cap/, 'F-012 above-cap override single-add',
    );
    await expectRejection(
      env.handlers.verification_evidence_batch_add({
        storyId: env.storyId,
        evidences: [{
          itemId: 'CHK-001', intentRef: 'INT-CAP', kind: 'integration_test',
          command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'above-cap override must be refused (batch)',
          commandTimeoutMs: CAP + 1,
          commandTimeoutReason: 'a reason long enough to satisfy the thirty character floor for the override',
        }],
      }),
      /command_timeout_above_cap/, 'F-012 above-cap override batch-add',
    );
    // Nothing persisted, and the intent was NOT pinned by a refused write.
    let cl = env.store.readChecklist(env.storyId);
    assert.equal(cl.items[0].verificationEvidence?.some(e => e.intentRef === 'INT-CAP') ?? false, false, 'F-012: above-cap refusal persists nothing');
    assert.equal(cl.items[0].verificationIntent?.happy[0].verification, undefined, 'F-012: above-cap refusal does not pin the intent');

    // 15b: exactly AT the cap is ACCEPTED (the boundary is inclusive — an off-by-one that
    //      rejected the cap itself would break the very `npm test` budget this cap encodes).
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-CAP', kind: 'integration_test',
      command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'exactly at the cap is allowed',
      commandTimeoutMs: CAP,
      commandTimeoutReason: 'exactly the cap: the same budget the DONE-required root suite already uses in config',
    });
    cl = env.store.readChecklist(env.storyId);
    const atCap = cl.items[0].verificationEvidence?.find(e => e.intentRef === 'INT-CAP');
    assert.equal(atCap?.receipt?.timeoutOverride?.timeoutMs, CAP, 'F-012: an override exactly at the cap is honoured');

    // 15c: MISSING reason → REFUSED (a raised budget must explain itself).
    await expectRejection(
      env.handlers.verification_evidence_add({
        storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-CAP', kind: 'integration_test',
        command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'override with no reason must be refused',
        commandTimeoutMs: 600_000,
      }),
      /command_timeout_reason_too_short/, 'F-012 override with no reason single-add',
    );
    // 15d: SUB-30-char reason via the internal fn path (bypasses the Zod .min(30)) is
    //      still REFUSED by the handler-entry re-validation.
    await expectRejection(
      env.handlers.verification_evidence_add({
        storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-CAP', kind: 'integration_test',
        command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'short override reason must be refused',
        commandTimeoutMs: 600_000, commandTimeoutReason: 'too short',
      }),
      /command_timeout_reason_too_short/, 'F-012 sub-30 override reason via internal fn path',
    );
    await expectRejection(
      env.handlers.verification_evidence_batch_add({
        storyId: env.storyId,
        evidences: [{
          itemId: 'CHK-001', intentRef: 'INT-CAP', kind: 'integration_test',
          command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'short override reason must be refused (batch)',
          commandTimeoutMs: 600_000, commandTimeoutReason: 'too short',
        }],
      }),
      /command_timeout_reason_too_short/, 'F-012 sub-30 override reason batch-add',
    );
    // 15e: a whitespace-only reason must not satisfy the floor (trim, not length-of-blanks).
    await expectRejection(
      env.handlers.verification_evidence_add({
        storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-CAP', kind: 'integration_test',
        command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'whitespace reason must be refused',
        commandTimeoutMs: 600_000, commandTimeoutReason: ' '.repeat(60),
      }),
      /command_timeout_reason_too_short/, 'F-012 whitespace-only override reason',
    );
    // 15f: non-integer / zero / negative / NaN budgets are refused (Zod .int().positive()
    //      re-validated at runtime for the internal-call path).
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expectRejection(
        env.handlers.verification_evidence_add({
          storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-CAP', kind: 'integration_test',
          command: PASS_CMD, selector: SELECTOR, result: 'pass', note: `invalid budget ${String(bad)} must be refused`,
          commandTimeoutMs: bad,
          commandTimeoutReason: 'a reason long enough to satisfy the thirty character floor for the override',
        }),
        /command_timeout_invalid|command_timeout_above_cap/, `F-012 invalid budget ${String(bad)}`,
      );
    }
    // 15g: a reason with NO raised budget is refused — it would record an audit trail for
    //      an override that never happened.
    await expectRejection(
      env.handlers.verification_evidence_add({
        storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-CAP', kind: 'integration_test',
        command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'reason without a budget must be refused',
        commandTimeoutReason: 'a reason long enough to satisfy the thirty character floor for the override',
      }),
      /command_timeout_reason_without_override/, 'F-012 reason without commandTimeoutMs',
    );
  } finally { cleanup(env); }
}

// ── 16. F-012 REGRESSION: with NO timeout supplied the default path is UNCHANGED —
//        a receipt is earned, NO timeoutOverride block is stamped, and the recorded
//        ceiling is exactly DEFAULT_VALIDATE_COMMAND_TIMEOUT_MS (270_000). This is the
//        additive-only guarantee for every pre-B-cdf6 caller. ───────────────────────────
{
  const env = makeEnv([{ ref: 'INT-DEFAULT', type: 'cli' }, { ref: 'INT-DEFAULT-B', type: 'cli' }]);
  try {
    const out = await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-DEFAULT', kind: 'integration_test',
      command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'no timeout supplied — default path must be unchanged',
    });
    const cl = env.store.readChecklist(env.storyId);
    const ev = cl.items[0].verificationEvidence?.find(e => e.intentRef === 'INT-DEFAULT');
    assert.ok(ev?.receipt, 'regression: the default path still earns a receipt');
    assert.equal(ev.mechanical, true, 'regression: still mechanical:true');
    assert.equal(ev.result, 'pass', 'regression: result still derived from the receipt');
    assert.equal(ev.receipt.timeoutOverride, undefined, 'regression: no override block when no timeout is supplied');
    assert.equal(ev.receipt.timeoutMs, 270_000, 'regression: the default 270s ceiling is what gets armed');
    assert.ok(!/timeoutOverride/.test(out), 'regression: no override note in the default-path output');

    // Batch parity for the default path.
    await env.handlers.verification_evidence_batch_add({
      storyId: env.storyId,
      evidences: [{
        itemId: 'CHK-001', intentRef: 'INT-DEFAULT-B', kind: 'integration_test',
        command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'batch default path must be unchanged too',
      }],
    });
    const evB = env.store.readChecklist(env.storyId).items[0].verificationEvidence?.find(e => e.intentRef === 'INT-DEFAULT-B');
    assert.ok(evB?.receipt, 'regression: the batch default path still earns a receipt');
    assert.equal(evB.receipt.timeoutOverride, undefined, 'regression: batch default path stamps no override block');
    assert.equal(evB.receipt.timeoutMs, 270_000, 'regression: batch default path arms the 270s default');
  } finally { cleanup(env); }
}

// ── 17. F-012: verification_run deliberately exposes NO override (its whole point is that
//        the caller authors nothing, and the pin carries no budget), so it keeps the
//        executor default — byte-identical to pre-B-cdf6. ────────────────────────────────
{
  const env = makeEnv([{ ref: 'INT-RUN-TO', type: 'cli' }]);
  try {
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-RUN-TO', kind: 'integration_test',
      command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'pin a fast passing verifier for verification_run',
    });
    const out = await env.handlers.verification_run({ storyId: env.storyId, intentRef: 'INT-RUN-TO' });
    assert.match(out, /ran pinned command/, 'verification_run still re-runs the pinned verifier');
    const ev = env.store.readChecklist(env.storyId).items[0].verificationEvidence?.find(e => e.intentRef === 'INT-RUN-TO');
    assert.ok(ev?.receipt, 'verification_run stamps a receipt');
    assert.equal(ev.receipt.timeoutOverride, undefined, 'verification_run exposes no override → no override block');
    assert.equal(ev.receipt.timeoutMs, 270_000, 'verification_run keeps the executor default ceiling');
  } finally { cleanup(env); }
}

// ── 18. F-012: the audited override is CARRIED FORWARD by
//        verification_evidence_refresh_stale, so a receipt legitimately earned under a
//        raised ceiling is re-earned (not silently demoted) on refresh. Without the
//        carry-forward the stale row would be re-run at the 270s default, get KILLED, and
//        decay to a non-mechanical attestation on the very next refresh — turning the
//        override into a one-shot. Uses a fast pinned command with a raised budget: the
//        assertion is that the RE-EARNED receipt still carries the override block. ───────
{
  const env = makeEnv([{ ref: 'INT-REFRESH', type: 'cli' }]);
  try {
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-REFRESH', kind: 'integration_test',
      command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'seed a raised-budget receipt to be refreshed',
      commandTimeoutMs: 45_000,
      commandTimeoutReason: 'seeded raised budget that must survive a stale-evidence refresh without decaying',
    });
    // Make the seeded row STALE by moving HEAD (a new commit changes headHash/materialHash).
    write(env.root, 'packages/main/src/drift.ts', 'export const drift = 1;\n');
    git(env.root, ['add', '.']);
    git(env.root, ['commit', '-m', 'drift so the seeded evidence goes stale']);

    const refreshOut = await env.handlers.verification_evidence_refresh_stale({ storyId: env.storyId });
    const ev = env.store.readChecklist(env.storyId).items[0].verificationEvidence?.find(e => e.intentRef === 'INT-REFRESH');
    assert.ok(ev, `refresh kept the evidence row (output: ${refreshOut})`);
    // The row was re-executed and re-earned: still a mechanical receipt, NOT demoted.
    assert.equal(ev.mechanical, true, 'F-012: the refreshed row is still a mechanical receipt (not demoted)');
    assert.ok(ev.receipt, 'F-012: the refreshed row still carries a receipt');
    assert.ok(
      ev.receipt.timeoutOverride,
      'F-012: the refreshed receipt CARRIES FORWARD the audited override (else the raise decays to a one-shot)',
    );
    assert.equal(ev.receipt.timeoutOverride.timeoutMs, 45_000, 'F-012: the carried-forward ceiling is the original raised one');
    assert.match(
      ev.receipt.timeoutOverride.reason, /must survive a stale-evidence refresh/,
      'F-012: the carried-forward reason comes from the prior TOOL-OWNED receipt, staying attributable',
    );
  } finally { cleanup(env); }
}

console.log('tool-executed-evidence-receipt-smoke: PASS');
console.log('tool-executed evidence receipt smoke passed');
