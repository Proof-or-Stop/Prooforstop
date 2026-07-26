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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { StoryStore } from '../core/store.js';
import { createChecklistHandlers } from '../handlers/checklist.js';
import { buildVerificationCoverage } from '../core/verification.js';
import { resetConfigCache } from '../core/config.js';
import type { ChecklistData, StoryInfo, VerificationIntentType } from '../core/types.js';

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

// ── 8. Legacy-shaped handler write (executable intent, no selector, no pin) is
//       grandfathered: stored without execution, mechanical undefined, still covers. ─
{
  const env = makeEnv([{ ref: 'INT-H', type: 'logic' }]);
  try {
    await env.handlers.verification_evidence_add({
      storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-H', kind: 'logic_test',
      command: 'npm test', result: 'pass', note: 'legacy-shaped write with no selector',
    });
    const cl = env.store.readChecklist(env.storyId);
    const ev = cl.items[0].verificationEvidence?.find(e => e.intentRef === 'INT-H');
    assert.ok(ev, 'legacy-shaped write is accepted (no hard break)');
    assert.equal(ev.mechanical, undefined, 'legacy-shaped write leaves mechanical undefined (grandfathered)');
    assert.equal(ev.receipt, undefined, 'no execution → no receipt');
    assert.equal(cl.items[0].verificationIntent?.happy[0].verification, undefined, 'no selector → no pin');
    assert.equal(buildVerificationCoverage(cl).entries[0].status, 'covered', 'grandfathered legacy-shaped evidence covers');
  } finally { cleanup(env); }
}

console.log('tool-executed-evidence-receipt-smoke: PASS');
