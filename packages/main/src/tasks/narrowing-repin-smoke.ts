#!/usr/bin/env node
/**
 * B-1482 — RED-first smoke for the narrowing-only evidence re-pin.
 *
 * The story's single smoke. It prints ONE line per case and ends with
 * `narrowing-repin-smoke: PASS` (exit 0) or `narrowing-repin-smoke: FAIL`
 * (exit 1). A `[PASS] <id>` line is printed ONLY after that case's assertions
 * all held, so no case line can appear on a failing run — the exact defect
 * (a selector that prints unconditionally) this story exists to fix.
 *
 * Default output stays well under 11000 characters because the verification
 * executor truncates a command's captured output at 12000 characters BEFORE
 * matching a pinned selector; a smoke whose own verdict line falls off the end
 * of the tail cannot be pinned as evidence.
 *
 * Structure: cases are grouped per checklist item (`CHK001_CASES` below), and
 * the groups are concatenated into `CASES`. CHK-002 and CHK-003 append their
 * own groups the same way; nothing else needs to change.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';
import * as checklistHandlerModule from '../handlers/checklist.js';
import { createChecklistHandlers } from '../handlers/checklist.js';
import { buildVerificationCoverage, SELECTOR_NARROWING_REFUSAL_CODES } from '../core/verification.js';
import { resetConfigCache } from '../core/config.js';
import type {
  ChecklistData,
  StoryInfo,
  VerificationEvidence,
  VerificationExecutionReceipt,
  VerificationIntentPin,
  VerificationIntentType,
} from '../core/types.js';

// ── harness ────────────────────────────────────────────────────────────────────

interface SmokeCase {
  /** Stable id; becomes part of the printed line, so it is pin-able. */
  id: string;
  /** Stable one-line description; must describe the PASSING outcome only. */
  desc: string;
  run: () => Promise<void>;
}

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

interface Env {
  root: string;
  store: StoryStore;
  ctx: { store: StoryStore; root: string; scanRoot: string };
  handlers: ReturnType<typeof createChecklistHandlers>;
  storyId: string;
}

/** Isolated temp git repo + story whose single checklist item carries `intents`. */
function makeEnv(intents: Array<{ ref: string; type: VerificationIntentType }>): Env {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-b1482-'));
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
  }, null, 2));
  write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
  git(root, ['init', '-b', 'work']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'B1482 Smoke']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed']);
  resetConfigCache();
  const store = new StoryStore(root);
  const storyId = 'B-1482s';
  const at = '2026-09-03T00:00:00.000Z';
  const story: StoryInfo = {
    storyId, name: 'narrowing-repin-smoke', title: 'narrowing re-pin smoke',
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
  const ctx = { store, root, scanRoot: join(root, 'packages/main') };
  const handlers = createChecklistHandlers(ctx);
  return { root, store, ctx, handlers, storyId };
}

function cleanup(env: Env): void {
  rmSync(env.root, { recursive: true, force: true });
}

/**
 * Read the recorded selector text off a receipt WITHOUT assuming the field is
 * declared. This is deliberate: the same accessor has to compile against the
 * pre-change receipt shape (the RED commit) and against a pre-change receipt
 * loaded from disk, where the field is genuinely absent.
 */
function recordedSelector(receipt: VerificationExecutionReceipt): string | undefined {
  return (receipt as { selector?: string }).selector;
}

/** Read the stored evidence row for `intentRef` through the REAL checklist_get handler. */
function readEvidence(env: Env, intentRef: string) {
  const got = env.handlers.checklist_get({ storyId: env.storyId }) as ChecklistData;
  return got.items[0].verificationEvidence?.find(e => e.intentRef === intentRef);
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

// A pinned command fully under this smoke's control; its selector must appear in stdout.
const PASS_CMD = `node -e "console.log('MARKER_OK')"`;
const SELECTOR = 'MARKER_OK';

// ── CHK-001: the selector text is persisted on every tool-owned receipt ────────

const CHK001_CASES: SmokeCase[] = [
  {
    id: 'CHK-001/A1',
    desc: 'receipt records the executed selector text and checklist_get exposes it',
    run: async () => {
      const env = makeEnv([{ ref: 'INT-SEL', type: 'cli' }]);
      try {
        await env.handlers.verification_evidence_add({
          storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-SEL', kind: 'integration_test',
          command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'tool-executed receipt through the real path',
        });
        const ev = readEvidence(env, 'INT-SEL');
        assert.ok(ev?.receipt, 'checklist_get exposes the stamped receipt');
        assert.equal(ev.receipt.selectorMatched, true, 'the run matched its selector');
        assert.equal(
          recordedSelector(ev.receipt), SELECTOR,
          'the receipt answers WHICH selector it was judged against, without consulting the pin',
        );
        // Discriminating: the recorded selector must be the string the recorded output
        // was actually judged by, not merely some string that happens to be stored.
        assert.ok(
          ev.receipt.outputTail.includes(recordedSelector(ev.receipt) ?? '\u0000'),
          'the recorded selector is present in the recorded output of the same run',
        );
        const pin = (env.handlers.checklist_get({ storyId: env.storyId }) as ChecklistData)
          .items[0].verificationIntent?.happy[0].verification;
        assert.equal(recordedSelector(ev.receipt), pin?.selector, 'the recorded selector is the pinned one');
      } finally { cleanup(env); }
    },
  },
  {
    id: 'CHK-001/A2',
    desc: 'a pre-change receipt without the field still loads, renders and covers alongside a new one',
    run: async () => {
      const env = makeEnv([{ ref: 'INT-LEGACY', type: 'logic' }, { ref: 'INT-FRESH', type: 'logic' }]);
      try {
        // A receipt in the exact shape written BEFORE this change: no selector key at all.
        const legacyReceipt: VerificationExecutionReceipt = {
          exitCode: 0,
          outputDigest: sha256Hex('LEGACY_OK\n'),
          outputTail: 'LEGACY_OK\n',
          selectorMatched: true,
          executedAt: '2026-01-01T00:00:00.000Z',
        };
        const seed = env.store.readChecklist(env.storyId);
        seed.items[0].verificationEvidence = [{
          intentRef: 'INT-LEGACY', kind: 'logic_test', command: PASS_CMD, result: 'pass',
          note: 'receipt written before B-1482', mechanical: true, receipt: legacyReceipt,
        }];
        env.store.writeChecklist(env.storyId, seed);

        const legacy = readEvidence(env, 'INT-LEGACY');
        assert.ok(legacy?.receipt, 'the pre-change receipt still loads through checklist_get');
        assert.equal('selector' in legacy.receipt, false, 'the pre-change receipt genuinely predates the field');
        // Renders through both projections without assuming the field exists.
        const slim = env.handlers.checklist_get({ storyId: env.storyId, slim: true });
        assert.ok(JSON.stringify(slim).length > 0, 'the slim projection renders');
        const covLegacy = buildVerificationCoverage(env.store.readChecklist(env.storyId));
        assert.equal(
          covLegacy.entries.find(e => e.intentRef === 'INT-LEGACY')?.status, 'covered',
          'the pre-change receipt still covers its executable intent',
        );

        // Mixed shapes coexist: a NEW row in the same checklist carries the field while
        // the pre-change row is left byte-identical.
        await env.handlers.verification_evidence_add({
          storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-FRESH', kind: 'logic_test',
          command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'new receipt beside a pre-change one',
        });
        const fresh = readEvidence(env, 'INT-FRESH');
        assert.ok(fresh?.receipt, 'the new receipt was stamped');
        assert.equal(recordedSelector(fresh.receipt), SELECTOR, 'the new receipt carries the selector text');
        assert.deepEqual(
          readEvidence(env, 'INT-LEGACY')?.receipt, legacyReceipt,
          'the pre-change receipt is not back-filled or rewritten',
        );
        const cov = buildVerificationCoverage(env.store.readChecklist(env.storyId));
        assert.equal(cov.missingRequired, 0, 'both receipt shapes cover their intents');
      } finally { cleanup(env); }
    },
  },
  {
    id: 'CHK-001/A3',
    desc: 'a caller-forged receipt selector is ignored; the stored selector is the executed one',
    run: async () => {
      const env = makeEnv([{ ref: 'INT-FORGE', type: 'cli' }]);
      try {
        const forgedSelector = 'FORGED_SELECTOR_NEVER_EXECUTED';
        const forgedDigest = sha256Hex('FORGED\n');
        const forged = {
          exitCode: 0,
          outputDigest: forgedDigest,
          outputTail: 'FORGED\n',
          selectorMatched: true,
          executedAt: '2026-01-01T00:00:00.000Z',
          selector: forgedSelector,
        } as unknown as VerificationExecutionReceipt;
        // The internal fn path bypasses Zod, so this is the MOST hostile caller shape:
        // a fully-formed receipt handed straight to the handler.
        await env.handlers.verification_evidence_add({
          storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-FORGE', kind: 'integration_test',
          command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'caller supplies a forged receipt',
          mechanical: true, receipt: forged,
        } as unknown as Parameters<typeof env.handlers.verification_evidence_add>[0]);

        const ev = readEvidence(env, 'INT-FORGE');
        assert.ok(ev?.receipt, 'a receipt was stamped');
        assert.equal(
          recordedSelector(ev.receipt), SELECTOR,
          'the stored selector is the one the command was actually judged against',
        );
        assert.notEqual(recordedSelector(ev.receipt), forgedSelector, 'the forged selector was not stored');
        assert.notEqual(ev.receipt.outputDigest, forgedDigest, 'the forged output digest was not stored');
        assert.ok(ev.receipt.outputTail.includes(SELECTOR), 'the stored tail is the real captured output');

        // And the pin stays immutable: a later write cannot re-point the receipt's
        // selector at a different string.
        await expectRejection(
          env.handlers.verification_evidence_add({
            storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-FORGE', kind: 'integration_test',
            command: PASS_CMD, selector: 'SOMETHING_ELSE', result: 'pass', note: 'attempted re-pin',
          }),
          /receipt_selector_mismatch/,
          'A3 re-pin attempt',
        );
        const after = readEvidence(env, 'INT-FORGE');
        assert.ok(after?.receipt, 'the receipt survived the refused re-pin');
        assert.equal(recordedSelector(after.receipt), SELECTOR, 'the stored selector is unchanged');
      } finally { cleanup(env); }
    },
  },
];


// ── CHK-002: narrowing-only re-pin proved from tool-recorded receipts ─────────

/**
 * The re-pin entry point, resolved DYNAMICALLY off the handler module rather than
 * statically imported. Same reason CHK-001 read the receipt selector through a cast:
 * the RED commit must COMPILE and RUN with every case failing, which is impossible if
 * the smoke statically imports a symbol that does not exist yet. It stays dynamic
 * afterwards so this file keeps proving the export exists rather than assuming it.
 */
interface NarrowRequest {
  storyId: string;
  itemId: string;
  intentRef: string;
  /** The NEW, stricter selector being requested. */
  selector: string;
  reason: string;
}
type NarrowFn = (ctx: unknown, args: NarrowRequest) => string | Promise<string>;

function narrowEntryPoint(): NarrowFn | undefined {
  const mod = checklistHandlerModule as unknown as Record<string, unknown>;
  const fn = mod.narrowVerificationPin;
  return typeof fn === 'function' ? (fn as NarrowFn) : undefined;
}

/** Request a re-pin. `args` is deliberately loose so a case can offer an inadmissible field. */
async function narrow(env: Env, args: NarrowRequest & Record<string, unknown>): Promise<string> {
  const fn = narrowEntryPoint();
  if (!fn) {
    throw new Error('narrowVerificationPin is not exported from handlers/checklist.ts [narrowing_entry_point_missing]');
  }
  return await fn(env.ctx, args as NarrowRequest);
}

/** The B-a745 CHK-005:happy:0 shape: a banner printed on EVERY branch, plus a status discriminator. */
const OLD_SELECTOR = 'finalAuthority: no';
const NEW_SELECTOR = 'status: plan';
const PLAN_ONLY_EXTRA = 'verdict: ok';
const NARROW_REASON =
  'the pinned selector is printed on every branch, so it matched a failing run; re-pin to the status discriminator';

/** A real, allowlisted command whose render depends on a scratch file — one command, two renders. */
function renderCommand(modePath: string): string {
  return `node -e "const fs=require('fs');console.log('${OLD_SELECTOR}');` +
    `if(fs.readFileSync('${modePath}','utf8').includes('plan')){console.log('${NEW_SELECTOR}');` +
    `console.log('${PLAN_ONLY_EXTRA}')}else{process.exit(1)}"`;
}

function readPin(env: Env, index = 0): VerificationIntentPin | undefined {
  const cl = env.handlers.checklist_get({ storyId: env.storyId }) as ChecklistData;
  return cl.items[0].verificationIntent?.happy[index]?.verification;
}

/** Retained narrowing records, read WITHOUT assuming the field is declared (RED must compile). */
function readNarrowings(env: Env, index = 0): Array<Record<string, unknown>> {
  const pin = readPin(env, index) as { narrowings?: Array<Record<string, unknown>> } | undefined;
  return pin?.narrowings ?? [];
}

interface SeedRow {
  intentRef: string;
  exitCode: number;
  tail: string;
  /** Omitted = a pre-B-1482 receipt whose judged selector is unknown and NOT re-derivable. */
  selector?: string;
  selectorMatched?: boolean;
  executedAt?: string;
  materialHash?: string;
}

/**
 * Seed a corpus of recorded receipts for ONE pinned command. Used by the refusal cases,
 * several of which describe corpora the real write path cannot mint (a pre-B-1482 receipt,
 * a receipt recorded against different story material).
 */
function seedRecordedReceipts(env: Env, command: string, pinSelector: string, rows: SeedRow[]): void {
  const cl = env.store.readChecklist(env.storyId);
  const item = cl.items[0];
  for (const intent of item.verificationIntent?.happy ?? []) {
    intent.verification = { command, selector: pinSelector };
  }
  item.verificationEvidence = rows.map(row => ({
    intentRef: row.intentRef,
    kind: 'integration_test',
    command,
    result: row.exitCode === 0 ? 'pass' : 'fail',
    note: 'seeded recorded receipt',
    mechanical: true,
    materialHash: row.materialHash ?? 'MATERIAL-1',
    receipt: {
      exitCode: row.exitCode,
      outputDigest: sha256Hex(row.tail),
      outputTail: row.tail,
      selectorMatched: row.selectorMatched ?? true,
      executedAt: row.executedAt ?? '2026-09-01T00:00:00.000Z',
      ...(row.selector !== undefined ? { selector: row.selector } : {}),
    },
  })) as VerificationEvidence[];
  env.store.writeChecklist(env.storyId, cl);
}

const PASS_TAIL = `${OLD_SELECTOR}\n${NEW_SELECTOR}\n${PLAN_ONLY_EXTRA}\n`;
const FAIL_TAIL = `${OLD_SELECTOR}\n`;

/** Drive the real write path to the exact B-a745 corpus: one passing render, one failing render. */
async function recordA745Corpus(): Promise<{ env: Env; command: string; modePath: string }> {
  const env = makeEnv([{ ref: 'INT-PASS', type: 'cli' }, { ref: 'INT-A745', type: 'cli' }]);
  const modePath = join(env.root, 'render-mode.txt');
  const command = renderCommand(modePath);
  writeFileSync(modePath, 'plan\n');
  await env.handlers.verification_evidence_add({
    storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-PASS', kind: 'integration_test',
    command, selector: OLD_SELECTOR, result: 'pass', note: 'recorded PASSING render of the pinned command',
  });
  writeFileSync(modePath, 'stop\n');
  await env.handlers.verification_evidence_add({
    storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-A745', kind: 'integration_test',
    command, selector: OLD_SELECTOR, result: 'fail', note: 'the B-a745 shape: the pinned selector matched a FAILING run',
  });
  return { env, command, modePath };
}

const CHK002_CASES: SmokeCase[] = [
  {
    id: 'CHK-002/B1',
    desc: 'B-a745 shape end to end: re-pin to the status discriminator accepted on recorded receipts',
    run: async () => {
      const { env, command } = await recordA745Corpus();
      try {
        const failing = readEvidence(env, 'INT-A745');
        assert.ok(failing?.receipt, 'the failing render was recorded as a receipt');
        assert.notEqual(failing.receipt.exitCode, 0, 'the recorded render genuinely FAILED');
        assert.equal(failing.receipt.selectorMatched, true, 'the old selector matched that failing run');
        assert.equal(recordedSelector(failing.receipt), OLD_SELECTOR, 'the receipt records WHICH selector matched');
        assert.equal(failing.receipt.outputTail.includes(NEW_SELECTOR), false, 'the failing tail lacks the discriminator');

        const message = await narrow(env, {
          storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-A745',
          selector: NEW_SELECTOR, reason: NARROW_REASON,
        });
        assert.ok(message.includes(OLD_SELECTOR), 'the acceptance names the OLD pin');
        assert.ok(message.includes(NEW_SELECTOR), 'the acceptance names the NEW pin');
        assert.ok(message.includes(NARROW_REASON), 'the acceptance carries the caller-supplied reason');
        assert.match(message, /outputTail/, 'the acceptance states absence was asserted in the retained tail');
        assert.match(message, /bounded/, 'the acceptance states the tail is BOUNDED, not the whole run');

        const pin = readPin(env, 1);
        assert.equal(pin?.selector, NEW_SELECTOR, 'the pin now carries the narrowed selector');
        assert.equal(pin?.command, command, 'the pinned command is unchanged');
        const records = readNarrowings(env, 1);
        assert.equal(records.length, 1, 'exactly one narrowing was retained');
        const record = records[0];
        assert.equal(record.previousSelector, OLD_SELECTOR, 'the OLD pin is retained');
        assert.equal(record.selector, NEW_SELECTOR, 'the NEW pin is retained');
        assert.equal(record.reason, NARROW_REASON, 'the reason is retained');
        const failingIds = record.failingReceiptIds as string[];
        const passingIds = record.passingReceiptIds as string[];
        assert.equal(failingIds.length >= 1 && passingIds.length >= 1, true, 'receipts on BOTH sides are cited');
        assert.ok(failingIds.every(id => message.includes(id)), 'the cited failing receipt ids are printed');
        assert.ok(passingIds.every(id => message.includes(id)), 'the cited passing receipt ids are printed');
        assert.ok(failingIds.some(id => id.includes('INT-A745')), 'the failing witness is the recorded stop render');
        assert.ok(passingIds.some(id => id.includes('INT-PASS')), 'the passing side is the recorded plan render');
        assert.ok(typeof record.receiptSetDigest === 'string' && (record.receiptSetDigest as string).length > 0,
          'the recorded-receipt set the proof used is identified');

        const after = readEvidence(env, 'INT-A745');
        assert.equal(recordedSelector(after?.receipt as VerificationExecutionReceipt), OLD_SELECTOR,
          'the receipt is NOT back-filled with the new selector');
        assert.equal(after?.receipt?.outputTail, failing.receipt.outputTail, 'the receipts on both sides survive intact');
      } finally { cleanup(env); }
    },
  },
  {
    id: 'CHK-002/B2',
    desc: 'a loosening re-pin is refused naming the recorded receipt that proves it is broader',
    run: async () => {
      const env = makeEnv([{ ref: 'INT-PASS', type: 'cli' }, { ref: 'INT-FAIL', type: 'cli' }]);
      try {
        seedRecordedReceipts(env, PASS_CMD, NEW_SELECTOR, [
          { intentRef: 'INT-PASS', exitCode: 0, tail: PASS_TAIL, selector: NEW_SELECTOR },
          { intentRef: 'INT-FAIL', exitCode: 1, tail: FAIL_TAIL, selector: NEW_SELECTOR, selectorMatched: false },
        ]);
        await expectRejection(
          narrow(env, {
            storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-FAIL',
            selector: OLD_SELECTOR, reason: NARROW_REASON,
          }),
          /narrowing_selector_loosens/,
          'B2 loosening',
        );
        assert.equal(readPin(env, 1)?.selector, NEW_SELECTOR, 'the pin is unchanged after the refusal');
        assert.equal(readNarrowings(env, 1).length, 0, 'no narrowing was retained');
      } finally { cleanup(env); }
    },
  },
  {
    id: 'CHK-002/B3',
    desc: 'a selector present in the recorded FAILING render too is refused as not discriminating',
    run: async () => {
      const env = makeEnv([{ ref: 'INT-PASS', type: 'cli' }, { ref: 'INT-FAIL', type: 'cli' }]);
      try {
        // The stop render prints the candidate selector as well: narrowing to it proves nothing.
        seedRecordedReceipts(env, PASS_CMD, OLD_SELECTOR, [
          { intentRef: 'INT-PASS', exitCode: 0, tail: PASS_TAIL, selector: OLD_SELECTOR },
          { intentRef: 'INT-FAIL', exitCode: 1, tail: `${OLD_SELECTOR}\n${NEW_SELECTOR}\n`, selector: OLD_SELECTOR },
        ]);
        await expectRejection(
          narrow(env, {
            storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-FAIL',
            selector: NEW_SELECTOR, reason: NARROW_REASON,
          }),
          /narrowing_selector_not_discriminating/,
          'B3 vacuous',
        );
        assert.equal(readPin(env, 1)?.selector, OLD_SELECTOR, 'the pin is unchanged after the refusal');
      } finally { cleanup(env); }
    },
  },
  {
    id: 'CHK-002/B4',
    desc: 'a corpus missing either side of the proof is refused naming the missing side',
    run: async () => {
      const env = makeEnv([{ ref: 'INT-PASS', type: 'cli' }, { ref: 'INT-OTHER', type: 'cli' }]);
      try {
        seedRecordedReceipts(env, PASS_CMD, OLD_SELECTOR, [
          { intentRef: 'INT-PASS', exitCode: 0, tail: PASS_TAIL, selector: OLD_SELECTOR },
          { intentRef: 'INT-OTHER', exitCode: 0, tail: PASS_TAIL, selector: OLD_SELECTOR },
        ]);
        await expectRejection(
          narrow(env, {
            storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-PASS',
            selector: NEW_SELECTOR, reason: NARROW_REASON,
          }),
          /narrowing_no_recorded_failing_render/,
          'B4 no failing render',
        );
        // The mirror image: a failing render with no recorded PASSING receipt is refused too,
        // so "matches every passing receipt" can never hold vacuously.
        seedRecordedReceipts(env, PASS_CMD, OLD_SELECTOR, [
          { intentRef: 'INT-PASS', exitCode: 1, tail: FAIL_TAIL, selector: OLD_SELECTOR },
        ]);
        await expectRejection(
          narrow(env, {
            storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-PASS',
            selector: NEW_SELECTOR, reason: NARROW_REASON,
          }),
          /narrowing_no_recorded_passing_receipt/,
          'B4 no passing receipt',
        );
        assert.equal(readPin(env, 0)?.selector, OLD_SELECTOR, 'the pin is unchanged after both refusals');
      } finally { cleanup(env); }
    },
  },
  {
    id: 'CHK-002/B5',
    desc: 'a candidate absent from a recorded PASSING receipt is refused naming that receipt',
    run: async () => {
      const env = makeEnv([
        { ref: 'INT-PASS', type: 'cli' }, { ref: 'INT-PASS2', type: 'cli' }, { ref: 'INT-FAIL', type: 'cli' },
      ]);
      try {
        seedRecordedReceipts(env, PASS_CMD, OLD_SELECTOR, [
          { intentRef: 'INT-PASS', exitCode: 0, tail: PASS_TAIL, selector: OLD_SELECTOR },
          // A second known-good run that never printed the candidate: narrowing to it would
          // start failing a run that genuinely passed.
          { intentRef: 'INT-PASS2', exitCode: 0, tail: `${OLD_SELECTOR}\n${PLAN_ONLY_EXTRA}\n`, selector: OLD_SELECTOR },
          { intentRef: 'INT-FAIL', exitCode: 1, tail: FAIL_TAIL, selector: OLD_SELECTOR },
        ]);
        await expectRejection(
          narrow(env, {
            storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-FAIL',
            selector: NEW_SELECTOR, reason: NARROW_REASON,
          }),
          /narrowing_selector_absent_from_passing_receipt/,
          'B5 absent from a passing receipt',
        );
        assert.equal(readPin(env, 2)?.selector, OLD_SELECTOR, 'the pin is unchanged after the refusal');
      } finally { cleanup(env); }
    },
  },
  {
    id: 'CHK-002/B6',
    desc: 'a second narrowing against an unchanged recorded-receipt set is refused naming the bound',
    run: async () => {
      const { env, modePath, command } = await recordA745Corpus();
      try {
        await narrow(env, {
          storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-A745',
          selector: NEW_SELECTOR, reason: NARROW_REASON,
        });
        // The recorded receipts have not changed, so this set has spent its one narrowing —
        // even though the candidate WOULD be provable against exactly these receipts.
        await expectRejection(
          narrow(env, {
            storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-A745',
            selector: PLAN_ONLY_EXTRA, reason: NARROW_REASON,
          }),
          /narrowing_receipt_set_unchanged/,
          'B6 second narrowing',
        );
        assert.equal(readPin(env, 1)?.selector, NEW_SELECTOR, 'the pin still carries the FIRST narrowing');
        assert.equal(readNarrowings(env, 1).length, 1, 'exactly one narrowing is retained');

        // And the set cannot be trivially grown to unlock a second one: under the narrowed
        // pin the stop render no longer earns a receipt at all.
        writeFileSync(modePath, 'stop\n');
        await expectRejection(
          env.handlers.verification_evidence_add({
            storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-A745', kind: 'integration_test',
            command, selector: NEW_SELECTOR, result: 'fail', note: 'attempt to grow the corpus under the narrowed pin',
          }),
          /receipt_selector_absent/,
          'B6 corpus growth',
        );
      } finally { cleanup(env); }
    },
  },
  {
    id: 'CHK-002/B7',
    desc: 'a receipt with no recorded selector cannot serve as the failing proof',
    run: async () => {
      const env = makeEnv([{ ref: 'INT-PASS', type: 'cli' }, { ref: 'INT-LEGACY', type: 'cli' }]);
      try {
        seedRecordedReceipts(env, PASS_CMD, OLD_SELECTOR, [
          { intentRef: 'INT-PASS', exitCode: 0, tail: PASS_TAIL, selector: OLD_SELECTOR },
          // Pre-B-1482 receipt: absent selector means UNKNOWN, not re-derivable from the pin.
          { intentRef: 'INT-LEGACY', exitCode: 1, tail: FAIL_TAIL },
        ]);
        await expectRejection(
          narrow(env, {
            storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-LEGACY',
            selector: NEW_SELECTOR, reason: NARROW_REASON,
          }),
          /narrowing_receipt_selector_unknown/,
          'B7 selector-less receipt',
        );
        assert.equal(readPin(env, 1)?.selector, OLD_SELECTOR, 'the pin is unchanged after the refusal');
        const legacy = readEvidence(env, 'INT-LEGACY');
        assert.equal('selector' in (legacy?.receipt ?? {}), false, 'the pre-B-1482 receipt was not back-filled');
      } finally { cleanup(env); }
    },
  },
  {
    id: 'CHK-002/B8',
    desc: 'a caller-supplied transcript is refused outright rather than considered as proof',
    run: async () => {
      const env = makeEnv([{ ref: 'INT-PASS', type: 'cli' }, { ref: 'INT-OTHER', type: 'cli' }]);
      try {
        // A corpus with no failing render: the transcript below is the ONLY thing that could
        // make this re-pin provable, so considering it at all would show up as an acceptance.
        seedRecordedReceipts(env, PASS_CMD, OLD_SELECTOR, [
          { intentRef: 'INT-PASS', exitCode: 0, tail: PASS_TAIL, selector: OLD_SELECTOR },
          { intentRef: 'INT-OTHER', exitCode: 0, tail: PASS_TAIL, selector: OLD_SELECTOR },
        ]);
        await expectRejection(
          narrow(env, {
            storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-PASS',
            selector: NEW_SELECTOR, reason: NARROW_REASON,
            transcript: `${OLD_SELECTOR}\nexit 1\n`,
          }),
          /narrowing_caller_output_not_admissible/,
          'B8 caller transcript',
        );
        assert.equal(readPin(env, 0)?.selector, OLD_SELECTOR, 'the pin is unchanged after the refusal');
        assert.equal(readNarrowings(env, 0).length, 0, 'no narrowing was retained');
      } finally { cleanup(env); }
    },
  },
  {
    id: 'CHK-002/B9',
    desc: 'a failing receipt recorded on different story material cannot prove the narrowing',
    run: async () => {
      const env = makeEnv([{ ref: 'INT-PASS', type: 'cli' }, { ref: 'INT-FAIL', type: 'cli' }]);
      try {
        seedRecordedReceipts(env, PASS_CMD, OLD_SELECTOR, [
          { intentRef: 'INT-PASS', exitCode: 0, tail: PASS_TAIL, selector: OLD_SELECTOR, materialHash: 'MATERIAL-1' },
          // An engineered failing run recorded against OTHER material is not comparable with
          // the passing receipts it is being weighed against.
          { intentRef: 'INT-FAIL', exitCode: 1, tail: FAIL_TAIL, selector: OLD_SELECTOR, materialHash: 'MATERIAL-2' },
        ]);
        await expectRejection(
          narrow(env, {
            storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-FAIL',
            selector: NEW_SELECTOR, reason: NARROW_REASON,
          }),
          /narrowing_receipt_material_mismatch/,
          'B9 material mismatch',
        );
        assert.equal(readPin(env, 1)?.selector, OLD_SELECTOR, 'the pin is unchanged after the refusal');
      } finally { cleanup(env); }
    },
  },
  {
    id: 'CHK-002/B10',
    desc: 'a re-pin to the selector already pinned is refused as unchanged',
    run: async () => {
      const env = makeEnv([{ ref: 'INT-PASS', type: 'cli' }, { ref: 'INT-FAIL', type: 'cli' }]);
      try {
        // A provable corpus: only the requested selector is the problem, so a refusal
        // here cannot be a missing-proof refusal wearing the wrong code.
        seedRecordedReceipts(env, PASS_CMD, OLD_SELECTOR, [
          { intentRef: 'INT-PASS', exitCode: 0, tail: PASS_TAIL, selector: OLD_SELECTOR },
          { intentRef: 'INT-FAIL', exitCode: 1, tail: FAIL_TAIL, selector: OLD_SELECTOR },
        ]);
        await expectRejection(
          narrow(env, {
            storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-FAIL',
            selector: OLD_SELECTOR, reason: NARROW_REASON,
          }),
          /narrowing_selector_unchanged/,
          'B10 unchanged selector',
        );
        assert.equal(readNarrowings(env, 1).length, 0, 'no narrowing was retained');
      } finally { cleanup(env); }
    },
  },
  {
    id: 'CHK-002/B11',
    desc: 'a pinned command with no recorded receipt has nothing to prove a narrowing against',
    run: async () => {
      const env = makeEnv([{ ref: 'INT-PIN', type: 'cli' }]);
      try {
        // Pinned, but not one receipt recorded for that command yet.
        const cl = env.store.readChecklist(env.storyId);
        for (const intent of cl.items[0].verificationIntent?.happy ?? []) {
          intent.verification = { command: PASS_CMD, selector: OLD_SELECTOR };
        }
        cl.items[0].verificationEvidence = [];
        env.store.writeChecklist(env.storyId, cl);
        await expectRejection(
          narrow(env, {
            storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-PIN',
            selector: NEW_SELECTOR, reason: NARROW_REASON,
          }),
          /narrowing_no_recorded_receipts/,
          'B11 empty recorded corpus',
        );
        assert.equal(readPin(env, 0)?.selector, OLD_SELECTOR, 'the pin is unchanged after the refusal');
      } finally { cleanup(env); }
    },
  },
  {
    id: 'CHK-002/B12',
    desc: 'receipts that do not predate the request cannot prove the narrowing',
    run: async () => {
      const env = makeEnv([{ ref: 'INT-PASS', type: 'cli' }, { ref: 'INT-FAIL', type: 'cli' }]);
      try {
        // Otherwise provable, but both sides claim to have run AFTER this request.
        seedRecordedReceipts(env, PASS_CMD, OLD_SELECTOR, [
          { intentRef: 'INT-PASS', exitCode: 0, tail: PASS_TAIL, selector: OLD_SELECTOR, executedAt: '2099-01-01T00:00:00.000Z' },
          { intentRef: 'INT-FAIL', exitCode: 1, tail: FAIL_TAIL, selector: OLD_SELECTOR, executedAt: '2099-01-01T00:00:00.000Z' },
        ]);
        await expectRejection(
          narrow(env, {
            storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-FAIL',
            selector: NEW_SELECTOR, reason: NARROW_REASON,
          }),
          /narrowing_receipt_not_predating_request/,
          'B12 receipts postdating the request',
        );
        // The other half of the same branch: an unusable execution time is UNKNOWN, and
        // unknown never counts as "recorded before the request".
        seedRecordedReceipts(env, PASS_CMD, OLD_SELECTOR, [
          { intentRef: 'INT-PASS', exitCode: 0, tail: PASS_TAIL, selector: OLD_SELECTOR },
          { intentRef: 'INT-FAIL', exitCode: 1, tail: FAIL_TAIL, selector: OLD_SELECTOR, executedAt: 'not-a-time' },
        ]);
        await expectRejection(
          narrow(env, {
            storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-FAIL',
            selector: NEW_SELECTOR, reason: NARROW_REASON,
          }),
          /narrowing_receipt_not_predating_request/,
          'B12 unusable execution time',
        );
        assert.equal(readPin(env, 1)?.selector, OLD_SELECTOR, 'the pin is unchanged after both refusals');
      } finally { cleanup(env); }
    },
  },
];

// ── CHK-003: reachable as a proof-or-stop command, documented, and registered ──

/**
 * Repo paths, resolved the way the sibling suites do: this file runs compiled from
 * `packages/main/dist/tasks/`, so `../../src` is the package source root and three
 * levels above that is the repository root. The registration case reads the REAL
 * files (root package.json, the full-suite runner source, proof-or-stop.config.json)
 * rather than an in-memory copy, because the whole point is that a suite absent from
 * any one of those three inventories is not actually wired in.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN_SRC = resolve(HERE, '..', '..', 'src');
const REPO_ROOT = resolve(MAIN_SRC, '..', '..', '..');
const CLI_PATH = resolve(HERE, '..', 'cli.js');
const DECISION_DOC = join(REPO_ROOT, 'docs/requirements/decisions/narrowing-only-evidence-repin.md');
const CLAUDE_MD = join(REPO_ROOT, 'CLAUDE.md');

/** The command name the narrowing must be reachable under. */
const NARROW_COMMAND = 'verification_pin_narrow';

/**
 * Refusal codes raised by `narrowVerificationPin` itself, BEFORE the recorded-receipt
 * proof is attempted. They live in the handler rather than in the pure evaluator, so
 * they cannot be derived from `SELECTOR_NARROWING_REFUSAL_CODES` and are listed here;
 * together the two lists are every code a caller of the command can be handed.
 */
const HANDLER_NARROWING_REFUSAL_CODES = [
  'narrowing_caller_output_not_admissible',
  'narrowing_unknown_input_field',
  'narrowing_selector_empty',
  'narrowing_reason_too_short',
  'intent_ref_unresolved',
  'narrowing_intent_not_executable',
  'narrowing_intent_not_pinned',
  'narrowing_receipt_set_unchanged',
] as const;

const ALL_NARROWING_REFUSAL_CODES: readonly string[] = [
  ...HANDLER_NARROWING_REFUSAL_CODES,
  ...SELECTOR_NARROWING_REFUSAL_CODES,
];

/** The phrase no documentation may use about the engineered-failing-run case. */
const OVERCLAIM = 'mechanically excluded';

interface CliResult { code: number; stdout: string; stderr: string }

/** Run the REAL compiled CLI against a temp project root. */
function runCli(root: string, command: string, args: Record<string, unknown>): CliResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, command, JSON.stringify(args)], {
      cwd: root,
      env: { ...process.env, PROOF_OR_STOP_PROJECT_ROOT: root },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: unknown; stderr?: unknown; message?: string };
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : String(err.message ?? e),
    };
  }
}

function readRepoFile(path: string): string {
  return readFileSync(path, 'utf-8');
}

const CHK003_CASES: SmokeCase[] = [
  {
    id: 'CHK-003/C1',
    desc: 'the B-a745 shape is accepted end to end through the real CLI, not only the function',
    run: async () => {
      const { env } = await recordA745Corpus();
      try {
        const res = runCli(env.root, NARROW_COMMAND, {
          storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-A745',
          selector: NEW_SELECTOR, reason: NARROW_REASON,
        });
        assert.equal(res.code, 0, `the CLI accepted the narrowing (stderr: ${res.stderr.slice(0, 200)})`);
        assert.ok(res.stdout.includes(OLD_SELECTOR), 'the CLI output names the OLD pin');
        assert.ok(res.stdout.includes(NEW_SELECTOR), 'the CLI output names the NEW pin');
        assert.ok(res.stdout.includes(NARROW_REASON), 'the CLI output carries the caller-supplied reason');
        assert.match(res.stdout, /outputTail/, 'the CLI output states absence was asserted in the retained tail');

        // The pin actually moved on disk — the CLI ran the real writer, not a preview.
        const pin = readPin(env, 1);
        assert.equal(pin?.selector, NEW_SELECTOR, 'the stored pin carries the narrowed selector');
        const records = readNarrowings(env, 1);
        assert.equal(records.length, 1, 'exactly one narrowing was retained by the CLI path');
        assert.equal(records[0].reason, NARROW_REASON, 'the CLI path retained the reason');

        // Reachability is not name-shaped: the phase gate intersects the policy ceiling
        // with DEFAULT_PHASE_TOOLS, so an unregistered command is refused in EVERY phase.
        const unknown = runCli(env.root, `${NARROW_COMMAND}_not_registered`, { storyId: env.storyId });
        assert.notEqual(unknown.code, 0, 'an unregistered command name is still refused');
      } finally { cleanup(env); }
    },
  },
  {
    id: 'CHK-003/C2',
    desc: 'a too-short reason is refused at the CLI schema AND on the schema-bypassing call',
    run: async () => {
      const { env } = await recordA745Corpus();
      try {
        const shortReason = 'too short';
        const res = runCli(env.root, NARROW_COMMAND, {
          storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-A745',
          selector: NEW_SELECTOR, reason: shortReason,
        });
        assert.notEqual(res.code, 0, 'the CLI refused the short reason');
        // Discriminating: it must be REFUSED FOR THE REASON LENGTH, not merely
        // non-zero — an unregistered command also exits non-zero.
        const refusal = `${res.stdout}${res.stderr}`;
        assert.match(refusal, /reason/i, 'the CLI refusal names the reason field');
        assert.match(refusal, /30/, 'the CLI refusal names the 30-character floor');
        // The internal fn path never sees the schema, so the handler must re-check.
        await expectRejection(
          narrow(env, {
            storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-A745',
            selector: NEW_SELECTOR, reason: shortReason,
          }),
          /narrowing_reason_too_short/,
          'C2 schema-bypassing short reason',
        );
        // Whitespace does not buy the length either, on either path.
        await expectRejection(
          narrow(env, {
            storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-A745',
            selector: NEW_SELECTOR, reason: `  ${' '.repeat(60)}  `,
          }),
          /narrowing_reason_too_short/,
          'C2 whitespace reason',
        );
        assert.equal(readPin(env, 1)?.selector, OLD_SELECTOR, 'the pin is unchanged after both refusals');
        assert.equal(readNarrowings(env, 1).length, 0, 'no narrowing was retained');
      } finally { cleanup(env); }
    },
  },
  {
    id: 'CHK-003/C3',
    desc: 'the suite is registered in all three real inventories: npm scripts, RESOURCE_POLICY, validate.commands',
    run: async () => {
      const pkg = JSON.parse(readRepoFile(join(REPO_ROOT, 'package.json'))) as { scripts: Record<string, string> };
      const script = pkg.scripts['test:narrowing-repin'];
      assert.ok(script, 'root package.json declares test:narrowing-repin');
      assert.ok(script.includes('narrowing-repin-smoke.js'), 'the script runs THIS compiled suite');
      assert.ok(
        (pkg.scripts['test:serial-reference'] ?? '').includes('npm run test:narrowing-repin'),
        'test:serial-reference (the membership authority) chains the suite',
      );

      // RESOURCE_POLICY is a SEPARATE authority: a serial-reference member with no
      // policy row fails the whole suite closed as unknownPolicy.
      const runner = readRepoFile(join(REPO_ROOT, 'packages/main/src/tasks/full-suite-runner.ts'));
      const policyBlock = runner.slice(runner.indexOf('const RESOURCE_POLICY'), runner.indexOf('export let FULL_SUITE_ENTRIES'));
      assert.ok(policyBlock.length > 0, 'the RESOURCE_POLICY block was located');
      assert.ok(policyBlock.includes("'test:narrowing-repin'"), 'RESOURCE_POLICY carries a row for the suite');

      // validate.commands is the planner's command universe: a suite absent from it
      // makes every evidence pin naming it resolve to pinned_command_missing.
      const config = JSON.parse(readRepoFile(join(REPO_ROOT, 'proof-or-stop.config.json'))) as {
        validate: { commands: Array<{ command?: string; args?: string[] }> };
      };
      const entry = config.validate.commands.find(c => (c.args ?? []).some(a => a.includes('narrowing-repin-smoke.js')));
      assert.ok(entry, 'proof-or-stop.config.json validate.commands registers the suite');
      assert.equal(entry.command, 'node', 'the registered entry runs it the way its siblings are run');
    },
  },
  {
    id: 'CHK-003/C4',
    desc: 'the documentation states the engineered-failing-run gap as an accepted limitation, never as excluded',
    run: async () => {
      const decision = readRepoFile(DECISION_DOC);
      const claudeMd = readRepoFile(CLAUDE_MD);
      for (const [label, text] of [['decision doc', decision], ['CLAUDE.md', claudeMd]] as const) {
        assert.equal(
          text.toLowerCase().includes(OVERCLAIM), false,
          `${label} must NOT claim the engineered-failing-run case is "${OVERCLAIM}"`,
        );
        assert.ok(text.includes('accepted limitation'), `${label} records the gap as an accepted limitation`);
        assert.ok(
          text.includes('no receipt records why a run failed'),
          `${label} states WHY the gap is not bounded`,
        );
      }
      // The decision doc must also carry the invariant, the bound and every refusal code,
      // so it is the record the PLAN scope review found missing rather than a summary.
      assert.ok(decision.includes('narrowing'), 'the decision doc states the narrowing-only exception');
      // Both documents present their tables as COMPLETE, so completeness is asserted
      // against the codes the implementation can actually emit, not against a
      // hand-copied subset that drifts the moment a branch is added.
      for (const code of ALL_NARROWING_REFUSAL_CODES) {
        assert.ok(decision.includes(code), `the decision doc lists the refusal code ${code}`);
        assert.ok(claudeMd.includes(code), `CLAUDE.md lists the refusal code ${code}`);
      }
      assert.ok(claudeMd.includes(NARROW_COMMAND), 'CLAUDE.md documents the command form');
      assert.ok(
        claudeMd.includes('at most one') || claudeMd.includes('at most ONE'),
        'CLAUDE.md states the one-narrowing-per-recorded-receipt-set bound',
      );
    },
  },
];

// ── runner ────────────────────────────────────────────────────────────────────

const CASES: SmokeCase[] = [
  ...CHK001_CASES,
  ...CHK002_CASES,
  ...CHK003_CASES,
];

/** Keep a failure line short so a failing run cannot blow the output budget. */
function briefly(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const firstLine = msg.split('\n')[0] ?? '';
  return firstLine.length > 240 ? `${firstLine.slice(0, 240)}...` : firstLine;
}

let failures = 0;
for (const testCase of CASES) {
  try {
    await testCase.run();
    console.log(`[PASS] ${testCase.id} ${testCase.desc}`);
  } catch (e) {
    failures += 1;
    console.log(`[FAIL] ${testCase.id} ${testCase.desc} -- ${briefly(e)}`);
  }
}
console.log(`narrowing-repin-smoke: ${failures === 0 ? 'PASS' : 'FAIL'}`);
if (failures > 0) process.exit(1);
