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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { StoryStore } from '../core/store.js';
import { createChecklistHandlers } from '../handlers/checklist.js';
import { buildVerificationCoverage } from '../core/verification.js';
import { resetConfigCache } from '../core/config.js';
import type {
  ChecklistData,
  StoryInfo,
  VerificationExecutionReceipt,
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
  const handlers = createChecklistHandlers({ store, root, scanRoot: join(root, 'packages/main') });
  return { root, store, handlers, storyId };
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

// ── runner ────────────────────────────────────────────────────────────────────

const CASES: SmokeCase[] = [
  ...CHK001_CASES,
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
