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
  const root = mkdtempSync(join(tmpdir(), 'lattice-ec67-'));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', storyDir: '.lattice/story/actives', requirementsDir: 'docs/requirements',
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

// ── 12. F-007: checklist_update's bulk verificationEvidence setter refuses a fabricated
//        executable pass, but re-persists a valid receipt / manual attestation. ────────
{
  const env = makeEnv([{ ref: 'INT-EXEC', type: 'logic' }, { ref: 'INT-MAN2', type: 'manual' }]);
  try {
    // 12a: a raw fabricated executable pass (mechanical undefined) is REFUSED.
    assert.throws(
      () => env.handlers.checklist_update({
        storyId: env.storyId, itemId: 'CHK-001',
        verificationEvidence: [{ intentRef: 'INT-EXEC', kind: 'logic_test', command: 'this-command-does-not-exist --lies', result: 'pass', note: 'trust me — never executed' }],
      }),
      /checklist_update_executable_evidence_unenforced/,
      'F-007 fabricated executable pass via checklist_update is refused',
    );
    assert.equal(env.store.readChecklist(env.storyId).items[0].verificationEvidence ?? undefined, undefined, 'refused checklist_update write persisted nothing');

    // 12b: a VALID mechanical receipt + a manual attestation are re-persisted verbatim
    //      (proves the guard does not over-restrict legitimate re-persist).
    const receipt: VerificationExecutionReceipt = {
      exitCode: 0, outputDigest: sha256Hex('MARKER_OK\n'), outputTail: 'MARKER_OK\n', selectorMatched: true, executedAt: new Date().toISOString(),
    };
    env.handlers.checklist_update({
      storyId: env.storyId, itemId: 'CHK-001',
      verificationEvidence: [
        { intentRef: 'INT-EXEC', kind: 'logic_test', command: PASS_CMD, result: 'pass', note: 're-persist an already-earned receipt', mechanical: true, receipt },
        { intentRef: 'INT-MAN2', kind: 'manual_transcript', result: 'pass', note: 're-persist a manual attestation', mechanical: false },
      ],
    });
    const cl = env.store.readChecklist(env.storyId);
    const exec = cl.items[0].verificationEvidence?.find(e => e.intentRef === 'INT-EXEC');
    assert.equal(exec?.mechanical, true, 'valid receipt survives re-persist as mechanical:true');
    assert.ok(exec?.receipt, 'receipt is carried forward, not dropped, by normalizeEvidence');
    assert.equal(exec.receipt.exitCode, 0, 'carried-forward receipt keeps its exit code');
    const cov = buildVerificationCoverage(cl);
    assert.equal(cov.missingRequired, 0, 'a re-persisted valid receipt + manual attestation cover both intents');
  } finally { cleanup(env); }
}

console.log('tool-executed-evidence-receipt-smoke: PASS');
