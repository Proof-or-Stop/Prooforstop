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
 * Default output remains concise. Receipt and narrowing selector evaluation use
 * complete authenticated output; the bounded compatibility tail is display-only.
 *
 * Structure: cases are grouped per checklist item (`CHK001_CASES` below), and
 * the groups are concatenated into `CASES`. CHK-002 and CHK-003 append their
 * own groups the same way; nothing else needs to change.
 */

import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';
import * as checklistHandlerModule from '../handlers/checklist.js';
import { createChecklistHandlers } from '../handlers/checklist.js';
import { buildVerificationCoverage, collectRecordedPinnedReceipts, SELECTOR_NARROWING_REFUSAL_CODES } from '../core/verification.js';
import { createVerificationEvidenceGateEvaluator } from '../core/proof-admissibility.js';
import {
  createCurrentVerificationAssertionReceipt,
  createVerificationAssertionReceipt,
  captureVerificationFreshness,
  createVerificationExecutionReceipt,
  validateVerificationReceipt,
} from '../core/verification-execution-evidence.js';
import { runSingleAllowlistedCommand } from '../core/validation-executor.js';
import { computeCanonicalDigest } from '../core/evidence/artifact-store.js';
import { computeEvidencePinVerdict } from '../core/evidence-pin-guard.js';
import { renderCodexEvidencePretoolHookScript } from '../init-assets.js';
import { MAIN_TOOLS } from '../cli/command-catalog.js';
import {
  getProcessFactRegistryEntry,
  PROCESS_FACT_KIND_BY_COMMAND,
  PROCESS_FACT_REQUIRED_SEMANTICS,
} from '../core/process-fact-registry.js';
import { resetConfigCache } from '../core/config.js';
import { acquireOwnerLease } from '../core/story-owner-lease.js';
import type {
  ChecklistData,
  StoryInfo,
  VerificationEvidence,
  VerificationExecutionReceipt,
  VerificationReceiptBundleV5,
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
  // origin/main merge: give the fixture a `main` ref. currentStoryFilesHash short-circuits
  // to undefined unless resolveStoryMergeBase (core/story-aware-validation.ts:153) can
  // merge-base HEAD against `main` or `origin/main`, and this repo is initialised on
  // `work` alone -- which is why B-5a15's causal preflight refused with
  // gitMaterial:git_material_or_story_files_hash_unavailable before any narrowing check ran.
  git(root, ['branch', 'main']);
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
  // origin/main merge: this fixture drives the checklist handlers directly, so it never
  // passes through the CLI ownership gate and its temp repo has no story-scoped lease.
  // B-5a15's causal preflight (core/causal-evidence.ts) fails closed on that, refusing
  // with writerLease:writer_unavailable + gitMaterial:git_material_or_story_files_hash_unavailable
  // BEFORE the narrowing checks this suite exists to exercise.
  //
  // Injecting synthetic facts through the HandlerContext.causalPreflightFacts seam was
  // tried and REJECTED: it clears the preflight, but the
  // commit path calls revalidateCached(), which re-derives the real snapshot and refuses
  // fabricated hashes with causal_commit_snapshot_invalid. So the fixture supplies REAL
  // material instead -- commit the story metadata so headHash/materialHash/storyFilesHash
  // all resolve -- and seeds the same lease a real story-scoped command would acquire.
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed story metadata']);
  acquireOwnerLease(store.storyDirPath(storyId), { command: 'checklist_update', cwd: root });
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


// ── CHK-002: narrowing-only re-pin proved from current signed V5 receipts ─────

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
type CorpusShape = 'normal' | 'pass-before-tail' | 'fail-before-tail';

function renderCommand(modePath: string, shape: CorpusShape = 'normal'): string {
  const passPadding = shape === 'pass-before-tail' ? ";console.log('x'.repeat(5000))" : '';
  const failingRender = shape === 'fail-before-tail'
    ? `console.log('${NEW_SELECTOR}');console.log('x'.repeat(5000));process.exit(1)`
    : 'process.exit(1)';
  return `node -e "const fs=require('fs');console.log('${OLD_SELECTOR}');` +
    `if(fs.readFileSync('${modePath}','utf8').includes('plan')){console.log('${NEW_SELECTOR}');` +
    `console.log('${PLAN_ONLY_EXTRA}')${passPadding}}else{${failingRender}}"`;
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
  /** Judged selector; current V5 seeds default to the pin, while legacy seeds may omit it. */
  selector?: string;
  selectorMatched?: boolean;
  executedAt?: string;
  materialHash?: string;
}

/** Seed a current signed V5 corpus for evaluator-focused narrowing cases. */
async function seedRecordedReceipts(env: Env, _command: string, pinSelector: string, rows: SeedRow[]): Promise<void> {
  const seedRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-narrowing-observation-'));
  const observationPath = join(seedRoot, 'observation.json');
  const command = `node -e "const r=JSON.parse(require('fs').readFileSync('${observationPath}','utf8'));process.stdout.write(r.output);process.exitCode=r.code"`;
  const cl = env.store.readChecklist(env.storyId);
  const item = cl.items[0];
  for (const intent of item.verificationIntent?.happy ?? []) {
    intent.verification = { command, selector: pinSelector };
  }
  item.verificationEvidence = [];
  let materialLabel: string | undefined;
  try {
  for (const row of rows) {
    if (materialLabel !== undefined && row.materialHash !== materialLabel) {
      write(env.root, 'packages/main/src/narrowing-material.ts', `export const label = ${JSON.stringify(row.materialHash)};\n`);
      git(env.root, ['add', 'packages/main/src/narrowing-material.ts']);
      git(env.root, ['commit', '-m', 'real narrowing corpus material drift']);
    }
    materialLabel = row.materialHash;
    writeFileSync(observationPath, JSON.stringify({ output: row.tail, code: row.exitCode }));
    const freshness = captureVerificationFreshness(env.root, env.root);
    const run = await runSingleAllowlistedCommand(command, env.root, { cwd: env.root, timeoutMs: 270_000 });
    assert.equal(run.output, row.tail, 'seed output comes from the actual command');
    assert.equal(run.code, row.exitCode, 'seed exit code comes from the actual command');
    const selector = row.selector ?? pinSelector;
    const executionReceipt = createVerificationExecutionReceipt({
      projectRoot: env.root,
      storyId: env.storyId,
      command,
      cwd: env.root,
      run,
      executedAt: row.executedAt ?? '2026-09-01T00:00:00.000Z',
    });
    const receipt = createCurrentVerificationAssertionReceipt({
      freshness,
      projectRoot: env.root,
      storyId: env.storyId,
      executionReceipt,
      intentRef: row.intentRef,
      selector,
    });
    if (row.selectorMatched !== undefined) {
      assert.equal(receipt.selectorMatched, row.selectorMatched,
        `seed ${row.intentRef} selectorMatched expectation agrees with its signed output`);
    }
    item.verificationEvidence.push({
      intentRef: row.intentRef,
      kind: 'integration_test',
      command,
      result: row.exitCode === 0 ? 'pass' : 'fail',
      note: 'seeded current signed V5 recorded receipt',
      mechanical: true,
      ...freshness,
      receipt,
    });
  }
  } finally { rmSync(seedRoot, { recursive: true, force: true }); }
  env.store.writeChecklist(env.storyId, cl);
}

/** Seed unsigned combined receipts solely to prove their read-only compatibility boundary. */
function seedLegacyRecordedReceipts(env: Env, command: string, pinSelector: string, rows: SeedRow[]): void {
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
    note: 'seeded legacy read-only receipt',
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

/** Build internally consistent read-only V2/V3 fixtures from a current signed V5 receipt. */
function downgradeV4Receipt(
  receipt: VerificationReceiptBundleV5,
  version: 'v2' | 'v3',
): VerificationEvidence['receipt'] {
  const executionV3 = receipt.executionReceipt;
  let executionReceipt: any = executionV3;
  if (version === 'v2') {
    const {
      schemaVersion: _schemaVersion,
      executionReceiptDigest: _executionReceiptDigest,
      dependencyManifest: _dependencyManifest,
      platform: _platform,
      architecture: _architecture,
      nodeVersion: _nodeVersion,
      executionIdentityDigest: _executionIdentityDigest,
      reuseDeniedReason: _reuseDeniedReason,
      authenticity: _authenticity,
      ...executionV2Fields
    } = executionV3;
    const executionV2Subject = {
      ...executionV2Fields,
      schemaVersion: 'proof-or-stop.verification-execution-receipt.v2',
    };
    executionReceipt = {
      ...executionV2Subject,
      executionReceiptDigest: computeCanonicalDigest(executionV2Subject),
    };
  }
  const assertionSubject = {
    schemaVersion: 'proof-or-stop.verification-assertion-receipt.v1',
    intentRef: receipt.assertionReceipt.intentRef,
    selectorDigest: receipt.assertionReceipt.selectorDigest,
    matcherVersion: receipt.assertionReceipt.matcherVersion,
    executionReceiptDigest: executionReceipt.executionReceiptDigest,
    outputDigest: receipt.assertionReceipt.outputDigest,
    matched: receipt.assertionReceipt.matched,
  };
  return {
    schemaVersion: version === 'v2'
      ? 'proof-or-stop.verification-receipt-bundle.v2'
      : 'proof-or-stop.verification-receipt-bundle.v3',
    executionReceipt,
    assertionReceipt: {
      ...assertionSubject,
      assertionReceiptDigest: computeCanonicalDigest(assertionSubject),
    },
    compatibility: { projection: 'legacy-verification-receipt.v1', reusable: false, promotable: false },
    exitCode: receipt.exitCode,
    outputDigest: receipt.outputDigest,
    outputTail: receipt.outputTail,
    selectorMatched: receipt.selectorMatched,
    selector: receipt.selector,
    executedAt: receipt.executedAt,
    timeoutMs: receipt.timeoutMs,
    ...(receipt.timeoutOverride ? { timeoutOverride: { ...receipt.timeoutOverride } } : {}),
  } as VerificationEvidence['receipt'];
}

const PASS_TAIL = `${OLD_SELECTOR}\n${NEW_SELECTOR}\n${PLAN_ONLY_EXTRA}\n`;
const FAIL_TAIL = `${OLD_SELECTOR}\n`;

/**
 * Commit the story metadata written by the preceding evidence call.
 *
 * B-5a15's causal execution key dedups on cwd + command + inputs + environment +
 * storyFilesHash. Two renders of one pinned command must therefore differ in one of
 * those or the second is refused as a duplicate of the first. The render-mode file
 * cannot be the differentiator: it is material, and B-1482's narrowing proof requires
 * both sides to share ONE recorded material binding (a narrowing is only proven by two
 * verdicts of the same repo state). `storyFilesHash` is the remaining seam -- it is
 * story metadata, excluded from materialHash by material-path-policy.ts, and it genuinely
 * moves between the two calls because the first call records its own evidence. Committing
 * that metadata makes the movement visible to the key without touching the material
 * binding, so both receipts stay on one material state and the selector assertions here
 * are unchanged.
 */
function commitStoryMetadata(root: string, label: string): void {
  // Stage ONLY the story-metadata tree. `git add .` would also stage render-mode.txt,
  // which is material -- moving the material binding and tripping B-1482's requirement
  // that both sides of the proof share one recorded material state.
  git(root, ['add', '.proof-or-stop']);
  git(root, ['commit', '-m', `story metadata: ${label}`, '--allow-empty']);
}

/** Drive the real write path to the exact B-a745 corpus: one passing render, one failing render. */
async function recordA745Corpus(shape: CorpusShape = 'normal'): Promise<{ env: Env; command: string; modePath: string }> {
  const env = makeEnv([{ ref: 'INT-PASS', type: 'cli' }, { ref: 'INT-A745', type: 'cli' }]);
  const modePath = join(env.root, 'render-mode.txt');
  const command = renderCommand(modePath, shape);
  writeFileSync(modePath, 'plan\n');
  await env.handlers.verification_evidence_add({
    storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-PASS', kind: 'integration_test',
    command, selector: OLD_SELECTOR, result: 'pass', note: 'recorded PASSING render of the pinned command',
  });
  commitStoryMetadata(env.root, 'after the passing render');
  writeFileSync(modePath, 'stop\n');
  await env.handlers.verification_evidence_add({
    storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-A745', kind: 'integration_test',
    command, selector: OLD_SELECTOR, result: 'fail', note: 'the B-a745 shape: the pinned selector matched a FAILING run',
  });
  return { env, command, modePath };
}

/**
 * The three refusals CHK-002:edge:0 names ALONGSIDE the second-narrowing bound. B-1482
 * F-011: that sentence is pinned to B6, whose own assertions only ever covered the
 * bound, so a reader following the pinned selector landed on a case that does not test
 * three of the four behaviours the sentence claims. Each refusal is performed here and
 * called by BOTH the sibling case that owns it and by B6, the way F-007 shared the
 * documentation grep. The siblings are unchanged in what they prove.
 */
async function assertLooseningRefused(): Promise<void> {
      const env = makeEnv([{ ref: 'INT-PASS', type: 'cli' }, { ref: 'INT-FAIL', type: 'cli' }]);
      try {
        await seedRecordedReceipts(env, PASS_CMD, NEW_SELECTOR, [
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
}

/** B4's refusal, shared with B6 — see {@link assertLooseningRefused}. */
async function assertMissingProofSideRefused(): Promise<void> {
      const env = makeEnv([{ ref: 'INT-PASS', type: 'cli' }, { ref: 'INT-OTHER', type: 'cli' }]);
      try {
        await seedRecordedReceipts(env, PASS_CMD, OLD_SELECTOR, [
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
        await seedRecordedReceipts(env, PASS_CMD, OLD_SELECTOR, [
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
}

/** B5's refusal, shared with B6 — see {@link assertLooseningRefused}. */
async function assertAbsentFromPassingReceiptRefused(): Promise<void> {
      const env = makeEnv([
        { ref: 'INT-PASS', type: 'cli' }, { ref: 'INT-PASS2', type: 'cli' }, { ref: 'INT-FAIL', type: 'cli' },
      ]);
      try {
        await seedRecordedReceipts(env, PASS_CMD, OLD_SELECTOR, [
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
}

/**
 * The B-a745 CHK-005:happy:0 shape replayed end to end from recorded receipts: a banner
 * printed on every branch, re-pinned to the status discriminator, accepted only on the
 * tool's own receipts and with both pins, both receipts, the reason and the cited receipt
 * ids left visible. B-1482 F-012: CHK-002:adversarial:0 names this replay as one of its
 * two clauses but is pinned to B8, which only ever tested the transcript refusal, so the
 * replay is performed by BOTH cases rather than by B1 alone.
 */
async function assertA745ShapeReplayedEndToEnd(): Promise<void> {
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
        assert.match(message, /complete authenticated output artifacts/, 'the acceptance identifies full-output proof');
        assert.match(message, /outputTail is a bounded display-only projection/, 'the acceptance gives tails no proof authority');

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
}

const CHK002_CASES: SmokeCase[] = [
  {
    id: 'CHK-002/B1',
    desc: 'B-a745 shape end to end: re-pin to the status discriminator accepted on recorded receipts',
    run: async () => {
      await assertA745ShapeReplayedEndToEnd();
    },
  },
  {
    id: 'CHK-002/B2',
    desc: 'a loosening re-pin is refused naming the recorded receipt that proves it is broader',
    run: async () => {
      await assertLooseningRefused();
    },
  },
  {
    id: 'CHK-002/B3',
    desc: 'a selector present in the recorded FAILING render too is refused as not discriminating',
    run: async () => {
      const env = makeEnv([{ ref: 'INT-PASS', type: 'cli' }, { ref: 'INT-FAIL', type: 'cli' }]);
      try {
        // The stop render prints the candidate selector as well: narrowing to it proves nothing.
        await seedRecordedReceipts(env, PASS_CMD, OLD_SELECTOR, [
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
      await assertMissingProofSideRefused();
    },
  },
  {
    id: 'CHK-002/B5',
    desc: 'a candidate absent from a recorded PASSING receipt is refused naming that receipt',
    run: async () => {
      await assertAbsentFromPassingReceiptRefused();
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

        // B-1482 F-011: this case's own intent sentence names three MORE refusals than the
        // bound above. They are performed here, in the case that sentence is pinned to, so
        // a silent weakening of B2/B4/B5 that still left those siblings passing can no
        // longer leave this evidence reading verified with three of its four named
        // behaviours untested by anything the pin actually checks.
        await assertLooseningRefused();
        await assertMissingProofSideRefused();
        await assertAbsentFromPassingReceiptRefused();
      } finally { cleanup(env); }
    },
  },
  {
    id: 'CHK-002/B7',
    desc: 'a selector-less legacy receipt remains readable but cannot serve as narrowing proof',
    run: async () => {
      const env = makeEnv([{ ref: 'INT-PASS', type: 'cli' }, { ref: 'INT-LEGACY', type: 'cli' }]);
      try {
        seedLegacyRecordedReceipts(env, PASS_CMD, OLD_SELECTOR, [
          { intentRef: 'INT-PASS', exitCode: 0, tail: PASS_TAIL, selector: OLD_SELECTOR },
          // Pre-B-1482 receipt: absent selector means UNKNOWN, not re-derivable from the pin.
          { intentRef: 'INT-LEGACY', exitCode: 1, tail: FAIL_TAIL },
        ]);
        const legacy = readEvidence(env, 'INT-LEGACY');
        assert.ok(legacy?.receipt, 'the historical combined receipt remains present');
        const legacyRead = validateVerificationReceipt(env.root, legacy.receipt, {
          intentRef: 'INT-LEGACY', selector: '', storyId: env.storyId,
        });
        assert.equal(legacyRead.ok, true, 'legacy combined evidence remains readable for audit');
        assert.equal(legacyRead.kind, 'legacy-readable-only', 'readability is explicitly non-authoritative compatibility');
        await expectRejection(
          narrow(env, {
            storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-LEGACY',
            selector: NEW_SELECTOR, reason: NARROW_REASON,
          }),
          /narrowing_recorded_receipt_not_authoritative/,
          'B7 selector-less receipt',
        );
        assert.equal(readPin(env, 1)?.selector, OLD_SELECTOR, 'the pin is unchanged after the refusal');
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
        await seedRecordedReceipts(env, PASS_CMD, OLD_SELECTOR, [
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

      // B-1482 F-012: the second clause of this case's own intent sentence. It is
      // performed here, in the case that sentence is pinned to, so a weakening of B1 that
      // still left B1 passing can no longer leave this evidence reading verified while the
      // replay it claims goes unexercised by anything the pin actually checks.
      await assertA745ShapeReplayedEndToEnd();
    },
  },
  {
    id: 'CHK-002/B9',
    desc: 'a failing receipt recorded on different story material cannot prove the narrowing',
    run: async () => {
      const env = makeEnv([{ ref: 'INT-PASS', type: 'cli' }, { ref: 'INT-FAIL', type: 'cli' }]);
      try {
        await seedRecordedReceipts(env, PASS_CMD, OLD_SELECTOR, [
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

        // Same corpus, one recorded material: now the proof completes, and the acceptance
        // must identify complete authenticated output rather than bounded display tails.
        await seedRecordedReceipts(env, PASS_CMD, OLD_SELECTOR, [
          { intentRef: 'INT-PASS', exitCode: 0, tail: PASS_TAIL, selector: OLD_SELECTOR, materialHash: 'MATERIAL-1' },
          { intentRef: 'INT-FAIL', exitCode: 1, tail: FAIL_TAIL, selector: OLD_SELECTOR, materialHash: 'MATERIAL-1' },
        ]);
        const message = await narrow(env, {
          storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-FAIL',
          selector: NEW_SELECTOR, reason: NARROW_REASON,
        });
        assert.match(message, /complete authenticated output artifacts/, 'the acceptance names the complete proof source');
        assert.match(message, /outputTail is a bounded display-only projection/, 'the acceptance states the diagnostic-only tail boundary');
        assert.equal(readPin(env, 1)?.selector, NEW_SELECTOR, 'the proved narrowing was applied');
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
        await seedRecordedReceipts(env, PASS_CMD, OLD_SELECTOR, [
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
        await seedRecordedReceipts(env, PASS_CMD, OLD_SELECTOR, [
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
        assert.equal(readPin(env, 1)?.selector, OLD_SELECTOR, 'the pin is unchanged after the refusal');
      } finally { cleanup(env); }
    },
  },
  {
    id: 'CHK-002/B13',
    desc: 'a persisted V5 top-level selector tamper is rejected before narrowing can consume it',
    run: async () => {
      const { env } = await recordA745Corpus();
      try {
        const checklist = env.store.readChecklist(env.storyId);
        const row = checklist.items[0].verificationEvidence?.find(evidence => evidence.intentRef === 'INT-A745');
        assert.ok(row?.receipt, 'the production handler persisted the failing V5 witness receipt');
        assert.equal((row.receipt as { schemaVersion?: string }).schemaVersion, 'proof-or-stop.verification-receipt-bundle.v5',
          'the tamper targets the current lifecycle-admissible V5 bundle');
        row.receipt.selector = 'FORGED_SELECTOR_NEVER_EXECUTED';
        env.store.writeChecklist(env.storyId, checklist);

        const persisted = readEvidence(env, 'INT-A745');
        assert.ok(persisted?.receipt, 'the selector-only tamper was persisted before validation');
        const validation = validateVerificationReceipt(env.root, persisted.receipt, {
          intentRef: 'INT-A745', selector: OLD_SELECTOR, storyId: env.storyId,
        });
        assert.equal(validation.ok, false, 'authoritative validation rejects the stored selector projection tamper');
        assert.ok(validation.errors.includes('receipt selector compatibility digest mismatch'),
          'the refusal names the signed assertion selector-digest boundary');

        await expectRejection(
          narrow(env, {
            storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-A745',
            selector: NEW_SELECTOR, reason: NARROW_REASON,
          }),
          /narrowing_recorded_receipt_invalid/,
          'B13 persisted V5 selector projection tamper',
        );
        assert.equal(readPin(env, 1)?.selector, OLD_SELECTOR, 'the tampered witness cannot change the pin');
        assert.equal(readNarrowings(env, 1).length, 0, 'no narrowing record is minted from the tampered witness');
      } finally { cleanup(env); }
    },
  },
  {
    id: 'CHK-002/B14',
    desc: 'injecting plausible selectors into persisted legacy PASS/FAIL receipts cannot authorize narrowing',
    run: async () => {
      const env = makeEnv([{ ref: 'INT-PASS', type: 'cli' }, { ref: 'INT-LEGACY-FAIL', type: 'cli' }]);
      try {
        seedLegacyRecordedReceipts(env, PASS_CMD, OLD_SELECTOR, [
          { intentRef: 'INT-PASS', exitCode: 0, tail: PASS_TAIL },
          { intentRef: 'INT-LEGACY-FAIL', exitCode: 1, tail: FAIL_TAIL },
        ]);
        const checklist = env.store.readChecklist(env.storyId);
        for (const row of checklist.items[0].verificationEvidence ?? []) {
          assert.ok(row.receipt, `legacy row ${row.intentRef} has a persisted receipt`);
          assert.equal('selector' in row.receipt, false, `legacy row ${row.intentRef} starts selector-less`);
          row.receipt.selector = OLD_SELECTOR;
          row.receipt.selectorMatched = true;
        }
        env.store.writeChecklist(env.storyId, checklist);

        const injected = env.store.readChecklist(env.storyId).items[0].verificationEvidence ?? [];
        assert.equal(injected.length, 2, 'the persisted attack corpus contains one PASS and one FAIL receipt');
        for (const row of injected) {
          assert.equal(row.receipt?.selector, OLD_SELECTOR, `legacy row ${row.intentRef} carries the injected plausible selector`);
          const readable = validateVerificationReceipt(env.root, row.receipt!, {
            intentRef: row.intentRef, selector: OLD_SELECTOR, storyId: env.storyId,
          });
          assert.equal(readable.ok, true, `legacy row ${row.intentRef} remains readable after injection`);
          assert.equal(readable.kind, 'legacy-readable-only', `legacy row ${row.intentRef} gains no authority from readability`);
        }

        await expectRejection(
          narrow(env, {
            storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-LEGACY-FAIL',
            selector: NEW_SELECTOR, reason: NARROW_REASON,
          }),
          /narrowing_recorded_receipt_not_authoritative/,
          'B14 injected legacy selector corpus',
        );
        assert.equal(readPin(env, 1)?.selector, OLD_SELECTOR, 'the injected legacy corpus leaves the pin unchanged');
        assert.equal(readNarrowings(env, 1).length, 0, 'the injected legacy corpus mints no narrowing ledger entry');
      } finally { cleanup(env); }
    },
  },
  {
    id: 'CHK-002/B15',
    desc: 'internally consistent legacy Bundle V2/V3/V4 remain readable but cannot authorize narrowing',
    run: async () => {
      for (const version of ['v2', 'v3', 'v4'] as const) {
        const env = makeEnv([{ ref: 'INT-PASS', type: 'cli' }, { ref: 'INT-FAIL', type: 'cli' }]);
        try {
          await seedRecordedReceipts(env, PASS_CMD, OLD_SELECTOR, [
            { intentRef: 'INT-PASS', exitCode: 0, tail: PASS_TAIL, selector: OLD_SELECTOR },
            { intentRef: 'INT-FAIL', exitCode: 1, tail: FAIL_TAIL, selector: OLD_SELECTOR },
          ]);
          const checklist = env.store.readChecklist(env.storyId);
          for (const row of checklist.items[0].verificationEvidence ?? []) {
            const current = row.receipt as VerificationReceiptBundleV5;
            row.receipt = version === 'v4' ? createVerificationAssertionReceipt({
              projectRoot: env.root, storyId: env.storyId,
              executionReceipt: current.executionReceipt,
              intentRef: row.intentRef, selector: OLD_SELECTOR,
            }) : downgradeV4Receipt(current, version);
          }
          env.store.writeChecklist(env.storyId, checklist);
          for (const row of env.store.readChecklist(env.storyId).items[0].verificationEvidence ?? []) {
            const validation = validateVerificationReceipt(env.root, row.receipt!, {
              intentRef: row.intentRef, selector: OLD_SELECTOR, storyId: env.storyId,
            });
            assert.equal(validation.ok, true, `legacy Bundle ${version} remains structurally readable`);
            assert.equal(validation.output, row.intentRef === 'INT-PASS' ? PASS_TAIL : FAIL_TAIL,
              `legacy Bundle ${version} retains complete authenticated historical output`);
            assert.equal(validation.kind, `split-${version}`, `legacy Bundle ${version} keeps its explicit read-only kind`);
          }
          await expectRejection(
            narrow(env, {
              storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-FAIL',
              selector: NEW_SELECTOR, reason: NARROW_REASON,
            }),
            /narrowing_recorded_receipt_not_authoritative/,
            `B15 legacy Bundle ${version}`,
          );
          assert.equal(readPin(env, 1)?.selector, OLD_SELECTOR, `legacy Bundle ${version} leaves the pin unchanged`);
          assert.equal(readNarrowings(env, 1).length, 0, `legacy Bundle ${version} mints no narrowing ledger entry`);
        } finally { cleanup(env); }
      }
    },
  },
];

// B-aa5f F-048: independent cases keep all three RED outcomes observable.
CHK002_CASES.push(
  {
    id: 'CHK-002/B16',
    desc: 'a stored V5 outputTail mismatch is refused without changing the pin or ledger',
    run: async () => {
      const { env } = await recordA745Corpus();
      try {
        const checklist = env.store.readChecklist(env.storyId);
        const row = checklist.items[0].verificationEvidence!.find(e => e.intentRef === 'INT-A745')!;
        const original = structuredClone(row.receipt!);
        const expected = { intentRef: row.intentRef, selector: OLD_SELECTOR, storyId: env.storyId };
        assert.equal(validateVerificationReceipt(env.root, original, expected).ok, true,
          'B16: the real baseline receipt is valid before changing only its display summary');
        row.receipt!.outputTail += 'UNRECORDED_DISPLAY_SUMMARY\n';
        env.store.writeChecklist(env.storyId, checklist);
        const persisted = readEvidence(env, row.intentRef)!.receipt!;
        const validation = validateVerificationReceipt(env.root, persisted, expected);
        assert.equal(validation.ok, false, 'B16: authoritative validation rejects the stored outputTail mismatch');
        assert.ok(validation.errors.includes('receipt outputTail compatibility mismatch'),
          'B16: refusal identifies the complete-output-derived display projection');
        await expectRejection(narrow(env, {
          storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-A745',
          selector: NEW_SELECTOR, reason: NARROW_REASON,
        }), /narrowing_recorded_receipt_invalid/, 'B16 stored outputTail mismatch');
        assert.deepEqual(env.store.readChecklist(env.storyId), checklist,
          'B16: rejected evidence leaves every pin, receipt, and narrowing ledger unchanged');
      } finally { cleanup(env); }
    },
  },
  {
    id: 'CHK-002/B17',
    desc: 'a passing selector before the retained tail is found in complete authenticated output',
    run: async () => {
      const { env } = await recordA745Corpus('pass-before-tail');
      try {
        const before = env.store.readChecklist(env.storyId);
        const passing = readEvidence(env, 'INT-PASS')!.receipt!;
        const validated = validateVerificationReceipt(env.root, passing, {
          intentRef: 'INT-PASS', selector: OLD_SELECTOR, storyId: env.storyId,
        });
        assert.equal(validated.ok, true, `B17: the long-output receipt is valid: ${validated.errors.join('; ')}`);
        assert.ok(validated.output!.includes(NEW_SELECTOR), 'B17: complete output contains the candidate');
        assert.equal(passing.outputTail.length, 4000, 'B17: the compatibility tail is bounded');
        assert.equal(passing.outputTail.includes(NEW_SELECTOR), false, 'B17: the candidate is outside the tail');
        await narrow(env, {
          storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-A745',
          selector: NEW_SELECTOR, reason: NARROW_REASON,
        });
        assert.equal(readPin(env, 1)?.selector, NEW_SELECTOR, 'B17: full-output proof permits the valid narrowing');
        assert.equal(readNarrowings(env, 1).length, 1, 'B17: exactly one narrowing is recorded');
        assert.deepEqual(env.store.readChecklist(env.storyId).items[0].verificationEvidence,
          before.items[0].verificationEvidence, 'B17: original signed receipts remain unchanged');
      } finally { cleanup(env); }
    },
  },
  {
    id: 'CHK-002/B18',
    desc: 'a failing discriminator before the retained tail cannot be treated as absent',
    run: async () => {
      const { env } = await recordA745Corpus('fail-before-tail');
      try {
        const before = env.store.readChecklist(env.storyId);
        const failing = readEvidence(env, 'INT-A745')!.receipt!;
        const validated = validateVerificationReceipt(env.root, failing, {
          intentRef: 'INT-A745', selector: OLD_SELECTOR, storyId: env.storyId,
        });
        assert.equal(validated.ok, true, `B18: the long failing receipt is valid: ${validated.errors.join('; ')}`);
        assert.notEqual(failing.exitCode, 0, 'B18: the recorded command failed');
        assert.equal(failing.selectorMatched, true, 'B18: the old pin matched the complete failing output');
        assert.ok(validated.output!.includes(NEW_SELECTOR), 'B18: complete failing output contains the candidate');
        assert.equal(failing.outputTail.length, 4000, 'B18: the compatibility tail is bounded');
        assert.equal(failing.outputTail.includes(NEW_SELECTOR), false, 'B18: tail absence is not full-output absence');
        await expectRejection(narrow(env, {
          storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-A745',
          selector: NEW_SELECTOR, reason: NARROW_REASON,
        }), /narrowing_selector_not_discriminating/, 'B18 complete failing output already contains the candidate');
        assert.deepEqual(env.store.readChecklist(env.storyId), before,
          'B18: a nondiscriminating candidate changes no pin, receipt, or ledger');
      } finally { cleanup(env); }
    },
  },
);

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
  'narrowing_recorded_receipt_invalid',
  'narrowing_recorded_receipt_not_authoritative',
] as const;

const ALL_NARROWING_REFUSAL_CODES: readonly string[] = [
  ...HANDLER_NARROWING_REFUSAL_CODES,
  ...SELECTOR_NARROWING_REFUSAL_CODES,
];

/** The phrase no documentation may use about the engineered-failing-run case. */
const OVERCLAIM = 'mechanically excluded';

interface CliResult { code: number; stdout: string; stderr: string }

/** Run the REAL compiled CLI against a temp project root. */
/**
 * One session id for the whole suite.
 *
 * The owner lease seeded in makeEnv() is written under this process's session id, but
 * runCli spawns the REAL CLI as a separate process whose ppid-derived id differs -- so
 * the owner gate refused every CLI-path case as a non-owner ("verification_pin_narrow is
 * an owner-gated storyScopedMutating command"). Pinning the id in this process and
 * inheriting it into the subprocess makes both sides the same owner, which is what a real
 * operator session is. It does not relax the gate: a lease is still required, and a
 * different id is still refused.
 */
const SMOKE_SESSION_ID = 'b1482-narrowing-repin-smoke';
process.env.PROOF_OR_STOP_SESSION_ID = SMOKE_SESSION_ID;

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

/** Run the REAL compiled CLI with a raw argv, exactly as an operator would type it. */
function runCliArgv(root: string, argv: readonly string[]): CliResult {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...argv], {
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

/**
 * Every argument the REGISTERED schema requires, read from the catalog at RUNTIME.
 * B-1482 F-008: the refusal taught a command form that omitted a required flag, so a
 * reader who pasted it got a schema error instead of a re-pin. Reading the requirement
 * from the same catalog the CLI validates against means a newly required argument fails
 * this suite rather than a reader's terminal.
 */
function requiredNarrowArgs(): string[] {
  const tool = MAIN_TOOLS.find(t => t.name === NARROW_COMMAND);
  assert.ok(tool, `${NARROW_COMMAND} is registered in the command catalog`);
  return Object.entries(tool.schema)
    .filter(([, schema]) => !schema.safeParse(undefined).success)
    .map(([key]) => key);
}

/** The `<placeholder>` values a taught command form is allowed to leave for the reader. */
const TAUGHT_FORM_PLACEHOLDERS: Record<string, string> = {
  '<stricter>': NEW_SELECTOR,
  '<why>': NARROW_REASON,
};

/**
 * Pull the taught `proof-or-stop verification_pin_narrow ...` command form OUT of a
 * caller-facing message and parse its flags. Extracting from the message text (rather
 * than re-stating the expected form here) is the point: a drift in what the tool teaches
 * fails this suite instead of a reader's terminal.
 */
function extractTaughtNarrowCommand(message: string): { form: string; args: Record<string, string> } {
  const match = new RegExp(`proof-or-stop ${NARROW_COMMAND}(?:\\s+--[^\\s\`]+)+`).exec(message);
  assert.ok(match, `the message prints a runnable ${NARROW_COMMAND} command form`);
  const form = match[0];
  const args: Record<string, string> = {};
  for (const token of form.split(/\s+/).slice(2)) {
    const eq = token.indexOf('=');
    assert.notEqual(eq, -1, `the taught flag ${token} carries a value`);
    args[token.slice(2, eq)] = token.slice(eq + 1);
  }
  return { form, args };
}

function readRepoFile(path: string): string {
  return readFileSync(path, 'utf-8');
}

/**
 * The documentation overclaim grep. Performed by BOTH cases whose pinned intent
 * sentence names it, so a reader who follows either selector lands on the assertion
 * that sentence describes rather than on a neighbouring case.
 */
function assertDocumentationDoesNotOverclaim(): void {
  for (const [label, path] of [['decision doc', DECISION_DOC], ['CLAUDE.md', CLAUDE_MD]] as const) {
    const text = readRepoFile(path);
    assert.equal(
      text.toLowerCase().includes(OVERCLAIM), false,
      `${label} must NOT claim the engineered-failing-run case is "${OVERCLAIM}"`,
    );
    assert.ok(text.includes('accepted limitation'), `${label} records the gap as an accepted limitation`);
  }
}

type DocLabel = 'decision doc' | 'CLAUDE.md';

/** Whitespace-normalised, so a claim the document wraps across lines is still one string. */
function squashWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/**
 * The literal sentence or invocation each document carries one of the claims C4 checks
 * in, quoted from the document itself. Most are claims of CHK-003:happy:0; the runnable
 * command form is one C4 checks beyond that sentence (B-1482 F-022). They are the mutation corpus: C4 re-runs its whole documentation
 * check set against a copy of the document with one of these deleted, and that run MUST
 * fail. Quoting the sentence independently of the checks is what makes the mutation a
 * proof rather than a restatement of whatever the checks happen to grep for (B-1482
 * F-020: `includes('narrowing')` survives the deletion of the narrowing-ONLY rule, and
 * nothing at all read the recorded-receipts-only rule).
 */
const DOCUMENTED_CLAIM_SENTENCES: ReadonlyArray<{ claim: string; sentences: Record<DocLabel, string> }> = [
  {
    claim: 'the narrowing-only rule',
    sentences: {
      'decision doc': 'Loosening stays refused everywhere.',
      'CLAUDE.md': 'loosening it stays refused everywhere',
    },
  },
  {
    claim: 'that the proof reads only current signed V5 receipts',
    sentences: {
      'decision doc': 'Its only proof witnesses are current signed V5 receipts',
      'CLAUDE.md': 'The proof reads current signed V5 receipts only.',
    },
  },
  {
    // B-1482 F-021: CHK-003:happy:0 names the one-narrowing bound as something BOTH
    // documents state, so both are held to it under the same deletion mutation.
    claim: 'the one-narrowing bound',
    sentences: {
      'decision doc': 'A set of recorded receipts admits AT MOST ONE narrowing.',
      'CLAUDE.md': 'a recorded-receipt set admits at most one narrowing.',
    },
  },
  {
    // B-1482 F-022: the runnable form itself, as each document prints it. The bare
    // command NAME survives its deletion -- both documents also name the command in the
    // prose sentence stating the one allowed movement -- so the form has to be quoted
    // here for the mutation to reach it at all.
    claim: 'the runnable command form',
    sentences: {
      'decision doc':
        `proof-or-stop verification_pin_narrow '{ "storyId":"B-xxxx", "itemId":"CHK-001", ` +
        `"intentRef":"CHK-001:happy:0", "selector":"status: plan", "reason":"the pinned selector ` +
        `is printed on every branch, so it matched a failing run; re-pin to the status ` +
        `discriminator" }'`,
      'CLAUDE.md':
        `proof-or-stop verification_pin_narrow '{"storyId":"B-xxxx","itemId":"CHK-001",` +
        `"intentRef":"CHK-001:happy:0","selector":"status: plan","reason":"the pinned selector ` +
        `is printed on every branch, so it matched a failing run; re-pin to the status ` +
        `discriminator"}'`,
    },
  },
];

/**
 * Every documentation claim C4 checks, for ONE document. Extracted so the same check set
 * can be run against a MUTATED copy of the document: a claim whose check survives the
 * deletion of the sentence that states it is not being checked at all.
 *
 * SCOPE: every clause below is asserted against BOTH documents -- the decision record and
 * CLAUDE.md -- so the label in each failure message names which copy failed, not which
 * document the clause is limited to. No clause is document-specific any more; the last
 * one that was (the command form, checked against CLAUDE.md alone) became a both-document
 * clause in B-1482 F-022, because the decision record teaches the form as well.
 */
function assertDocumentationClaims(label: DocLabel, text: string): void {
  assert.equal(
    text.toLowerCase().includes(OVERCLAIM), false,
    `${label} must NOT claim the engineered-failing-run case is "${OVERCLAIM}"`,
  );
  assert.ok(text.includes('accepted limitation'), `${label} records the gap as an accepted limitation`);
  assert.ok(
    text.includes('no receipt records why a run failed'),
    `${label} states WHY the gap is not bounded`,
  );
  // Clause (1) of CHK-003:happy:0. Not `includes('narrowing')`: a document about
  // narrowing satisfies that whether or not the RULE is stated. Both halves of the rule
  // are required -- that loosening stays refused, and that the one movement allowed is a
  // stricter selector on the same pinned command -- so deleting either sentence fails.
  assert.match(
    text, /loosening[^.]{0,20}stays refused everywhere/i,
    `${label} states that loosening stays refused everywhere`,
  );
  assert.match(
    text, /movement is allowed[^.]*re-pin to a STRICTER selector on the SAME/i,
    `${label} states the one allowed movement is a stricter selector on the same pinned command`,
  );
  // Clause (2). The refusal-code list below already carries
  // narrowing_caller_output_not_admissible, so the code alone proves nothing about the
  // prose: the rule itself must be stated, and the absence of a transcript/output/receipt
  // parameter with it.
  assert.match(
    text, /(the proof reads current signed V5 receipts only|its only proof witnesses are current signed V5 receipts)/i,
    `${label} states the proof reads only current signed V5 receipts`,
  );
  assert.match(
    text, /there is no transcript[^.]*parameter/i,
    `${label} states there is no transcript, output or receipt parameter`,
  );
  // Both documents present their tables as COMPLETE, so completeness is asserted
  // against the codes the implementation can actually emit, not against a
  // hand-copied subset that drifts the moment a branch is added.
  for (const code of ALL_NARROWING_REFUSAL_CODES) {
    assert.ok(text.includes(code), `${label} lists the refusal code ${code}`);
  }
  // Clause (3), the one-narrowing bound. CHK-003:happy:0 names it for BOTH documents,
  // so both are checked (B-1482 F-021). Not `includes('at most one')`: the decision doc
  // states the bound a second time in its PM-1 pre-mortem row, so that grep survives the
  // deletion of the rule's own sentence. Asserted as the sentence form instead -- the set
  // admits at most one narrowing, full stop -- plus the ordering half both documents
  // state, which the PM-1 row does not carry.
  assert.match(
    text, /admits AT MOST ONE narrowing\./i,
    `${label} states that a recorded-receipt set admits at most one narrowing`,
  );
  assert.match(
    text, /re-checked FIRST[^.]*before the proof/i,
    `${label} states the digest is re-checked FIRST, before the proof`,
  );
  // The runnable command form. Not `includes(NARROW_COMMAND)`: both documents also name
  // the command in the prose sentence stating the one allowed movement, so that grep
  // survives the deletion of the invocation and would still pass on a document that
  // taught the name and nothing else (B-1482 F-022, the same grep-survives-deletion
  // shape as F-020 and F-021). Asserted as a pasteable invocation instead, and against
  // BOTH documents, because the decision document prints one too -- it is not a
  // CLAUDE.md-only claim.
  assert.match(
    text, new RegExp(`proof-or-stop ${NARROW_COMMAND} '\\{.*?\\}'`),
    `${label} prints a runnable ${NARROW_COMMAND} invocation, not only the command name`,
  );
}

/**
 * The pre-mortem table read. Performed by BOTH cases whose pinned intent sentence names
 * it (B-1482 F-013): CHK-003:happy:0 claims a case asserts the decision carries at least
 * four pre-mortems but is pinned to C4, which never read the table, so a reader following
 * that selector landed on a case that does not check the claim. Same shape as
 * {@link assertDocumentationDoesNotOverclaim}, which F-007 shared for the same reason.
 */
function assertDecisionCarriesPreMortems(): void {
      // The decision was required to carry pre-mortems because it moves a
      // security-adjacent invariant. Nothing verified that it did.
      const decision = readRepoFile(DECISION_DOC);
      const preMortems = [...decision.matchAll(/^\| PM-\d+ \|/gm)];
      assert.ok(
        preMortems.length >= 4,
        `the decision record carries at least four pre-mortems (found ${preMortems.length})`,
      );
      // Discriminating: a pre-mortem that names no mitigation is a worry, not a
      // pre-mortem, so each row must carry all four columns with content.
      for (const row of decision.split('\n').filter(line => /^\| PM-\d+ \|/.test(line))) {
        const columns = row.split('|').slice(1, -1).map(cell => cell.trim());
        assert.equal(columns.length, 5, `pre-mortem row has id, scenario, trigger, consequence and mitigation: ${row.slice(0, 60)}`);
        for (const cell of columns) {
          assert.ok(cell.length > 0, `no empty cell in pre-mortem row: ${row.slice(0, 60)}`);
        }
      }
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
        assert.match(res.stdout, /complete authenticated output artifacts/, 'the CLI output states the complete proof source');

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

        // The same case greps the documentation for the overclaiming phrasing, which is
        // the second half of the sentence this case is pinned to.
        assertDocumentationDoesNotOverclaim();
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
      const documents: ReadonlyArray<[DocLabel, string]> = [
        ['decision doc', squashWhitespace(readRepoFile(DECISION_DOC))],
        ['CLAUDE.md', squashWhitespace(readRepoFile(CLAUDE_MD))],
      ];
      // Every claim, against the documents as they stand. The check set is the SAME for
      // both documents: every clause in assertDocumentationClaims is asserted against the
      // decision record and against CLAUDE.md, including the runnable command form, which
      // both of them print (B-1482 F-022). A reader does not have to open the corpus to
      // learn the scope of a clause -- there is one scope, and it is both documents.
      for (const [label, text] of documents) {
        assertDocumentationClaims(label, text);
      }
      // B-1482 F-020: and the same check set against a copy of the document with ONE
      // quoted sentence deleted, which must fail. A claim whose check survives that
      // deletion is not being checked -- the defect this case carried for the
      // narrowing-ONLY rule (a document about narrowing satisfies includes('narrowing')
      // whether or not the rule is stated) and for the recorded-receipts-only rule
      // (nothing read it at all).
      for (const [label, text] of documents) {
        for (const { claim, sentences } of DOCUMENTED_CLAIM_SENTENCES) {
          const sentence = sentences[label];
          assert.ok(text.includes(sentence), `${label} carries the sentence stating ${claim}: "${sentence}"`);
          assert.throws(
            () => assertDocumentationClaims(label, text.replace(sentence, '')),
            `${label}: the checks must FAIL once the sentence stating ${claim} is deleted`,
          );
        }
      }
      // The last clause of this case's own intent sentence: the decision itself carries
      // at least four pre-mortems. Asserted here, in the case that sentence is pinned to,
      // so a weakening of C7 that still left it passing can no longer leave this evidence
      // reading verified with its pre-mortem claim unchecked by the pinned case.
      assertDecisionCarriesPreMortems();
    },
  },
  {
    id: 'CHK-003/C5',
    desc: 'the evidence-pin refusal teaches the narrowing command and no longer claims immutability without exception',
    run: async () => {
      // The exact situation this story exists for: a caller trying a DIFFERENT selector
      // against a pin that is not discriminating. This is the message they are handed.
      const verdict = computeEvidencePinVerdict(
        {
          kind: 'verification_evidence_add',
          storyId: 'B-1482', intentRef: 'CHK-001:happy:0',
          callerSelector: NEW_SELECTOR,
        },
        { command: PASS_CMD, selector: OLD_SELECTOR },
      );
      assert.equal(verdict.verdict, 'deny', 'a mismatching selector is still denied');
      const message = verdict.reasons.join('\n');
      assert.ok(message.includes(NARROW_COMMAND), `the refusal names ${NARROW_COMMAND} as the third option`);
      // Naming the command is not enough: it must state the precondition, or the reader
      // is sent to a command that will refuse them for a reason they were not told.
      assert.match(message, /recorded FAILING receipt/, 'the refusal states the recorded-failing-receipt precondition');
      assert.match(message, /the current selector matched/, 'the precondition names WHICH selector must have matched it');
      assert.match(message, /same pinned command/, 'the precondition names the pinned command as unchanged');
      assert.match(message, /STRICTER/, 'the refusal states the narrowing is one-directional');
      assert.match(message, /(LOOSER|loosening)/, 'the refusal still states that loosening is refused');
      // The categorical sentence is now false: exactly one movement exists.
      assert.equal(
        /immutable once set/.test(message), false,
        'the refusal no longer claims the pin is immutable once set, without exception',
      );

      // B-1482 F-019: the joined message is not what every consumer reads. reasons is an
      // array, so a JSON caller keys off reasons[0]; a truncated log, a wrapped terminal
      // or a human skimming stops at the first line too. That line is therefore asserted
      // IN ISOLATION: read alone it must not make the categorical claim a later line
      // silently corrects.
      const opening = verdict.reasons[0] ?? '';
      assert.ok(opening.length > 0, 'the refusal opens with a reason line');
      assert.ok(
        !/immutab/i.test(opening) || /(exception|narrowing)/i.test(opening),
        `the opening line must not claim immutability without qualifying it in the same line: ${opening}`,
      );
      // Not repairable by deleting information: the opening must still name the refused
      // write and the intent it is refused for.
      assert.match(opening, /would be refused/, 'the opening line still states the write is refused');
      assert.ok(opening.includes('CHK-001:happy:0'), 'the opening line still names the intent it refuses');

      // B-1482 F-021: the refusal message is not the only place a reader learns this
      // rule. The registered description of the command that produces the refusal is
      // printed by `verification_pin_guard_check --help`, so a reader who never triggers
      // a denial learns the rule ONLY from it. It is held to the same isolation rule.
      const guard = MAIN_TOOLS.find(t => t.name === 'verification_pin_guard_check');
      assert.ok(guard, 'verification_pin_guard_check is registered in the command catalog');
      const registered = guard.description;
      assert.ok(
        !/immutab/i.test(registered) || /(exception|narrowing)/i.test(registered),
        `the registered description must not claim immutability without qualifying it in the same text: ${registered}`,
      );
      // Not repairable by deleting information: it must still state what the command
      // does and what it is judged against.
      assert.match(registered, /denies/, 'the registered description still states the command denies');
      assert.match(registered, /pin/, 'the registered description still names the pin it judges against');

      // The generated shell-tool hook must not carry a SECOND copy of this copy: it
      // renders whatever the shared verdict returns, so it cannot go stale on its own.
      const hook = renderCodexEvidencePretoolHookScript();
      assert.ok(hook.includes('verification_pin_guard_check'), 'the generated hook asks the CLI for the verdict');
      assert.ok(hook.includes('verdict.reasons'), 'the generated hook prints the shared verdict reasons verbatim');
      assert.equal(/immutable once set/.test(hook), false, 'the generated hook carries no stale copy of the message');
    },
  },
  {
    id: 'CHK-003/C6',
    desc: 'the command carries explicit process-fact kind and semantics rows, not the generic fallback',
    run: async () => {
      // The sibling that writes and re-stamps the receipts this command re-judges.
      const sibling = 'verification_run';
      const kinds = PROCESS_FACT_KIND_BY_COMMAND as Record<string, string>;
      const semantics = PROCESS_FACT_REQUIRED_SEMANTICS as unknown as Record<string, readonly string[]>;
      assert.ok(
        Object.prototype.hasOwnProperty.call(kinds, NARROW_COMMAND),
        'PROCESS_FACT_KIND_BY_COMMAND carries an explicit row for the command',
      );
      assert.ok(
        Object.prototype.hasOwnProperty.call(semantics, NARROW_COMMAND),
        'PROCESS_FACT_REQUIRED_SEMANTICS carries an explicit row for the command',
      );
      assert.equal(kinds[NARROW_COMMAND], kinds[sibling], `the kind matches ${sibling}`);
      assert.deepEqual(semantics[NARROW_COMMAND], semantics[sibling], `the semantics match ${sibling}`);

      // Discriminating: an absent row would resolve to the L4 fallback, which is exactly
      // the understatement the rows exist to remove. Assert the RESOLVED entry, so a row
      // that is present but not consumed still fails.
      const entry = getProcessFactRegistryEntry(NARROW_COMMAND);
      assert.ok(entry, 'the command resolves to a process-fact registry entry');
      assert.equal(entry.level, 'L4', 'the command is still declared L4');
      assert.notEqual(entry.kind, 'gate-evidence', 'the resolved kind is not the generic L4 fallback');
      assert.equal(entry.kind, 'execution-status', 'the resolved kind is the sibling execution-status');
      const resolved: readonly string[] = entry.semantics;
      for (const semantic of ['execution-evidence', 'verification-evidence', 'gate-evidence']) {
        assert.ok(resolved.includes(semantic), `the resolved semantics include ${semantic}`);
      }
    },
  },
  {
    id: 'CHK-003/C7',
    desc: 'the decision record carries at least four pre-mortems',
    run: async () => {
      assertDecisionCarriesPreMortems();
    },
  },
  {
    id: 'CHK-003/C8',
    desc: 'the taught narrowing command form carries every required argument and runs as printed',
    run: async () => {
      const { env } = await recordA745Corpus();
      try {
        // The refusal an operator actually meets, produced by the REAL CLI against a real
        // store — not a hand-built verdict — so the taught form is read from the same path
        // the shell-tool hook prints verbatim.
        const guard = runCli(env.root, 'verification_pin_guard_check', {
          commandString:
            `node cli.js verification_evidence_add --storyId=${env.storyId} --intentRef=INT-A745 ` +
            `--command="${PASS_CMD}" --selector="${NEW_SELECTOR}"`,
          json: true,
        });
        assert.equal(guard.code, 0, `the guard answered (stderr: ${guard.stderr.slice(0, 200)})`);
        const verdict = JSON.parse(guard.stdout) as { verdict: string; reasons: string[] };
        assert.equal(verdict.verdict, 'deny', 'the mismatching selector is refused');

        const { form, args } = extractTaughtNarrowCommand(verdict.reasons.join('\n'));
        // Every argument the registered schema requires must be present, or the reader who
        // pastes this exact form is handed an argument-validation error instead of a re-pin.
        for (const required of requiredNarrowArgs()) {
          assert.ok(required in args, `the taught form passes --${required}, which the schema requires: ${form}`);
        }
        // The values it fills in must be the caller's real ones, not placeholders for data
        // the tool already resolved.
        assert.equal(args.storyId, env.storyId, 'the taught form carries the real story id');
        assert.equal(args.intentRef, 'INT-A745', 'the taught form carries the refused intent ref');
        assert.equal(args.itemId, 'CHK-001', 'the taught form carries the item that OWNS the intent');

        // And it RUNS as printed: only the documented <placeholder> values are supplied.
        const argv = Object.entries(args).map(([key, value]) => `--${key}=${TAUGHT_FORM_PLACEHOLDERS[value] ?? value}`);
        const res = runCliArgv(env.root, [NARROW_COMMAND, ...argv]);
        const output = `${res.stdout}${res.stderr}`;
        assert.equal(
          /Argument validation failed/i.test(output), false,
          `the taught form is not refused by the schema it teaches: ${output.slice(0, 240)}`,
        );
        assert.equal(res.code, 0, `the taught form ran as printed (stderr: ${res.stderr.slice(0, 240)})`);
        assert.equal(readPin(env, 1)?.selector, NEW_SELECTOR, 'running the taught form actually moved the pin');
      } finally { cleanup(env); }
    },
  },
  {
    id: 'CHK-003/C9',
    desc: 'the enforcement floor, not only the seatbelt, teaches the narrowing command',
    run: async () => {
      const { env, command } = await recordA745Corpus();
      try {
        // The floor is what a caller reaches by invoking the command directly, with no
        // PreToolUse hook installed or firing: the seatbelt is advisory, this refusal is
        // the mechanical one. Both mismatch shapes are exercised, since a caller can get
        // the command wrong as easily as the selector.
        for (const [label, write] of [
          ['selector', { command, selector: NEW_SELECTOR }],
          ['command', { command: PASS_CMD, selector: OLD_SELECTOR }],
        ] as const) {
          let message = '';
          try {
            await env.handlers.verification_evidence_add({
              storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-A745', kind: 'integration_test',
              result: 'pass', note: `direct caller with a mismatching ${label}`, ...write,
            });
          } catch (e) {
            message = e instanceof Error ? e.message : String(e);
          }
          assert.ok(message.length > 0, `the ${label} mismatch was refused by the floor`);
          assert.ok(
            message.includes(NARROW_COMMAND),
            `the ${label} floor refusal names ${NARROW_COMMAND}: ${message}`,
          );
          // Naming the command is not enough: the same precondition the seatbelt states
          // must travel with it, or the reader is sent to a command that will refuse them.
          assert.match(message, /recorded FAILING receipt/, `the ${label} floor refusal states the precondition`);
          assert.match(message, /(LOOSER|loosening)/, `the ${label} floor refusal keeps loosening refused`);
          // Unqualified immutability is the exact claim this story falsified.
          assert.equal(
            /the verification pin is immutable\)/.test(message), false,
            `the ${label} floor refusal no longer claims immutability without exception: ${message}`,
          );
          // The taught form is the shared runnable one, with the real intent filled in.
          const { args } = extractTaughtNarrowCommand(message);
          for (const required of requiredNarrowArgs()) {
            assert.ok(required in args, `the ${label} floor refusal passes --${required}`);
          }
          assert.equal(args.itemId, 'CHK-001', 'the floor refusal names the owning checklist item');
          assert.equal(args.intentRef, 'INT-A745', 'the floor refusal names the refused intent');
        }
        assert.equal(readPin(env, 1)?.selector, OLD_SELECTOR, 'the pin is unchanged after the refusals');
      } finally { cleanup(env); }
    },
  },
  {
    id: 'CHK-003/C10',
    desc: 'the concurrent pin-write refusal teaches the same route rather than bare immutability',
    run: async () => {
      const env = makeEnv([{ ref: 'INT-RACE', type: 'cli' }]);
      try {
        // The pin-application refusal fires when another writer pinned the intent between
        // the pre-lock read and the locked write. In one process the only honest way to
        // reach it is to let the PINNED COMMAND ITSELF do the racing write while it runs.
        const checklistPath = env.store.storyFilePath(env.storyId, 'checklist.json');
        const racing =
          `node -e "const fs=require('fs');const p='${checklistPath}';` +
          `const c=JSON.parse(fs.readFileSync(p,'utf8'));` +
          `c.items[0].verificationIntent.happy[0].verification={command:'a concurrent writer pinned this',selector:'${SELECTOR}'};` +
          `fs.writeFileSync(p,JSON.stringify(c));console.log('${SELECTOR}')"`;
        let message = '';
        try {
          await env.handlers.verification_evidence_add({
            storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-RACE', kind: 'integration_test',
            command: racing, selector: SELECTOR, result: 'pass', note: 'a first write racing a concurrent pin',
          });
        } catch (e) {
          message = e instanceof Error ? e.message : String(e);
        }
        assert.match(message, /receipt_command_mismatch/, `the concurrent pin write was refused: ${message}`);
        assert.ok(
          message.includes(NARROW_COMMAND),
          `the concurrent-pin refusal names ${NARROW_COMMAND}: ${message}`,
        );
        assert.match(message, /recorded FAILING receipt/, 'the concurrent-pin refusal states the precondition');
        assert.match(message, /(LOOSER|loosening)/, 'the concurrent-pin refusal keeps loosening refused');
        assert.equal(
          /the verification pin is immutable\)/.test(message), false,
          `the concurrent-pin refusal no longer claims immutability without exception: ${message}`,
        );

        // Every refusal on this path comes from the shared renderer, so the direct-caller
        // floor cannot keep a second, stale copy of the categorical claim anywhere.
        const floor = readRepoFile(join(MAIN_SRC, 'handlers', 'checklist.ts'));
        assert.ok(floor.includes('receipt_selector_mismatch'), 'the enforcement floor source was located');
        assert.deepEqual(
          floor.split('\n').filter(line => line.includes('the verification pin is immutable')), [],
          'no refusal in the enforcement floor still claims the pin is immutable without exception',
        );
      } finally { cleanup(env); }
    },
  },
  {
    id: 'CHK-003/C11',
    desc: 'the real CLI help teaches the signed V5-only witness boundary and legacy remediation',
    run: async () => {
      const help = runCliArgv(REPO_ROOT, [NARROW_COMMAND, '--help']);
      const output = squashWhitespace(`${help.stdout}${help.stderr}`);
      assert.equal(help.code, 0, `the real ${NARROW_COMMAND} --help command succeeds: ${output.slice(0, 240)}`);
      assert.match(
        output,
        /Only current signed authoritative VerificationReceiptBundleV5 receipts recorded by this tool[^.]*may be proof witnesses/,
        'help states the hard current signed authoritative V5-only witness precondition',
      );
      assert.match(
        output,
        /legacy combined and Bundle V2\/V3\/V4 receipts remain audit-readable but are rejected with narrowing_recorded_receipt_not_authoritative/,
        'help states that readable legacy combined and Bundle V2/V3/V4 evidence has no narrowing authority',
      );
      assert.match(output, /record current signed V5 evidence first/i, 'help gives stable remediation');
      assert.equal(
        /proof is drawn ONLY from receipts this tool recorded/i.test(output),
        false,
        'help does not retain the over-broad tool-recorded-receipts-only promise',
      );
      assert.match(
        output,
        /--selector[^*]*Accepted only when current signed authoritative VerificationReceiptBundleV5 witnesses prove it stricter/,
        'selector argument help repeats the authoritative witness precondition at the decision field',
      );
    },
  },
];

const CURRENT_AUTHORITY_LABEL_CASES: SmokeCase[] = [{
  id: 'B-aa5f/F077',
  desc: 'successful narrowing accurately names its authentic current V5 authority',
  run: async () => {
    const { env } = await recordA745Corpus();
    try {
      const receipt = readEvidence(env, 'INT-A745')?.receipt;
      assert.ok(receipt && 'schemaVersion' in receipt, 'F077 current witness has a versioned receipt');
      assert.equal(receipt.schemaVersion, 'proof-or-stop.verification-receipt-bundle.v5',
        'F077 positive control uses an actual current V5 witness');
      assert.equal(validateVerificationReceipt(env.root, receipt!, {
        storyId: env.storyId, intentRef: 'INT-A745', selector: OLD_SELECTOR,
      }).ok, true, 'F077 recorded witness is authentic before successful narrowing');
      const message = await narrow(env, {
        storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-A745',
        selector: NEW_SELECTOR, reason: NARROW_REASON,
      });
      assert.equal(readPin(env, 1)?.selector, NEW_SELECTOR, 'F077 genuine narrowing positive control succeeds');
      assert.match(message, /current signed authoritative V5 receipts/,
        'F077 successful current narrowing must name V5, not audit-only V4 authority');
      assert.doesNotMatch(message, /current signed authoritative V4 receipts/);
    } finally { cleanup(env); }
  },
}];

const CHK007_CASES: SmokeCase[] = [{
  id: 'CHK-007/F062',
  desc: 'authenticated command witnesses reject unsigned relabeling without mutating pins or history',
  run: async () => {
    const control = await recordA745Corpus();
    try {
      const wanted = control.command;
      const readOutput = ({ intentRef, receipt }: Parameters<typeof collectRecordedPinnedReceipts>[2] extends (input: infer I) => unknown ? I : never) => {
        const expected = { storyId: control.env.storyId, intentRef, selector: OLD_SELECTOR, command: wanted };
        const validated = validateVerificationReceipt(control.env.root, receipt, expected);
        assert.equal(validated.ok, true, validated.errors.join('; '));
        assert.equal(typeof validated.output, 'string');
        return validated.output!;
      };
      assert.equal(collectRecordedPinnedReceipts(control.env.store.readChecklist(control.env.storyId), wanted, readOutput).length, 2,
        'F062: genuine same-command passing and failing outputs are accepted by the collector');
      await narrow(control.env, { storyId: control.env.storyId, itemId: 'CHK-001', intentRef: 'INT-A745', selector: NEW_SELECTOR, reason: NARROW_REASON });
      assert.equal(readPin(control.env, 1)?.selector, NEW_SELECTOR, 'F062: genuine current output preserves supported narrowing');
      console.log('F062 normal-control realPassAndFail=true collectorAccepted=true narrowingAccepted=true');
    } finally { cleanup(control.env); }

    const { env, command } = await recordA745Corpus();
    try {
      const original = env.store.readChecklist(env.storyId);
      const passing = original.items[0].verificationEvidence!.find(row => row.intentRef === 'INT-PASS')!;
      // The corpus contains two historical observations; for the gate's normal
      // control use the passing row's own recorded Git state, not invented hashes.
      const expectedCommand = `node never-executed-command-witness.js`;
      const attacked = structuredClone(original);
      attacked.items[0].verificationEvidence!.find(row => row.intentRef === 'INT-PASS')!.command = expectedCommand;
      assert.deepEqual(attacked.items[0].verificationEvidence!.map(row => row.receipt), original.items[0].verificationEvidence!.map(row => row.receipt),
        'F062: the attack changes no original signed receipt/output bytes');
      const failures: string[] = [];
      const check = async (label: string, fn: () => unknown | Promise<unknown>) => {
        try { await fn(); } catch (error) {
          const detail = `${label}: ${error instanceof Error ? error.message : String(error)}`;
          failures.push(detail);
          console.log(`[F062 assertion FAIL] ${detail}`);
        }
      };
      await check('F062 collector rejects unsigned row.command relabeling', () => {
        assert.throws(() => collectRecordedPinnedReceipts(attacked, expectedCommand, ({ intentRef, receipt }) => {
          const expected = { storyId: env.storyId, intentRef, selector: OLD_SELECTOR, command: expectedCommand };
          const validated = validateVerificationReceipt(env.root, receipt, expected);
          if (!validated.ok) throw new Error(validated.errors.join('; '));
          assert.equal(typeof validated.output, 'string');
          return validated.output!;
        }), /command/i, 'an authentic output executed by another command cannot become a requested-command witness');
      });
      // Test the lifecycle command comparison on an actual current passing row
      // from a separate one-run fixture, so stale corpus history cannot mask it.
      const live = makeEnv([{ ref: 'LIVE-COMMAND', type: 'cli' }]);
      try {
        await live.handlers.verification_evidence_add({ storyId: live.storyId, itemId: 'CHK-001', intentRef: 'LIVE-COMMAND',
          kind: 'integration_test', command: PASS_CMD, selector: SELECTOR, result: 'pass', note: 'F062 actual current gate control' });
        const liveChecklist = live.store.readChecklist(live.storyId);
        const options = { receiptAdmissibility: createVerificationEvidenceGateEvaluator(live.root, live.storyId) };
        assert.equal(buildVerificationCoverage(liveChecklist, undefined, undefined, options).entries[0].status, 'covered',
          'F062 current same-command lifecycle control is covered');
        liveChecklist.items[0].verificationEvidence![0].command = expectedCommand;
        await check('F062 lifecycle rejects unsigned command relabeling', () => {
          const entry = buildVerificationCoverage(liveChecklist, undefined, undefined, options).entries[0];
          assert.notEqual(entry.status, 'covered');
          assert.match(entry.evidence?.nonMechanicalReason ?? '', /command/i, 'refusal is the command boundary, not blanket legacy rejection');
        });
      } finally { cleanup(live); }
      env.store.writeChecklist(env.storyId, attacked);
      const beforeRefusal = env.store.readChecklist(env.storyId);
      await check('F062 real narrowing rejects the mismatched command witness', async () => {
        await expectRejection(narrow(env, { storyId: env.storyId, itemId: 'CHK-001', intentRef: 'INT-A745', selector: NEW_SELECTOR, reason: NARROW_REASON }),
          /command/i, 'F062 command mismatch');
      });
      assert.deepEqual(env.store.readChecklist(env.storyId), beforeRefusal,
        'F062 refusal preserves attacked row, original receipts, immutable pins, narrowing history and spent-set ledger');
      assert.equal(readPin(env, 1)?.command, command);
      assert.deepEqual(passing.receipt, original.items[0].verificationEvidence!.find(row => row.intentRef === 'INT-PASS')!.receipt);
      assert.equal(failures.length, 0, failures.join('\n'));
      console.log('B-aa5f F062 authenticated-command-binding PASS');
    } finally { cleanup(env); }
  },
}];

// ── runner ────────────────────────────────────────────────────────────────────

const CASES: SmokeCase[] = [
  ...CURRENT_AUTHORITY_LABEL_CASES,
  ...CHK007_CASES,
  ...CHK001_CASES,
  ...CHK002_CASES,
  ...CHK003_CASES,
];

const NARROWING_WORKER_COUNT = 4;
const SHARD_RESULT_PREFIX = 'NARROWING_SHARD_RESULT ';

function runCaseShard(shardIndex: number, shardCount: number): Promise<{ status: number | null; output: string; caseIds: string[] }> {
  return new Promise(resolveShard => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), `--case-shard=${shardIndex}/${shardCount}`], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let spawnError = '';
    const collect = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 4 * 1024 * 1024) chunks.push(chunk);
      else child.kill('SIGKILL');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', error => { spawnError = String(error); });
    child.once('close', status => {
      const output = Buffer.concat(chunks).toString('utf8');
      const marker = output.split('\n').find(line => line.startsWith(SHARD_RESULT_PREFIX));
      let caseIds: string[] = [];
      try { caseIds = marker ? JSON.parse(marker.slice(SHARD_RESULT_PREFIX.length)) : []; } catch { /* fail closed below */ }
      resolveShard({ status: spawnError || bytes > 4 * 1024 * 1024 ? null : status, output, caseIds });
    });
  });
}

/** Keep a failure line short so a failing run cannot blow the output budget. */
function briefly(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const firstLine = msg.split('\n')[0] ?? '';
  return firstLine.length > 240 ? `${firstLine.slice(0, 240)}...` : firstLine;
}

const shardArg = process.argv.slice(2).find(arg => arg.startsWith('--case-shard='));
if (process.argv.length > 2 && (process.argv.length !== 3 || !shardArg)) {
  throw new Error('narrowing-repin-smoke accepts only one internal --case-shard=<index>/<count> argument');
}
if (shardArg) {
  const match = shardArg.match(/^--case-shard=(\d+)\/(\d+)$/);
  if (!match) throw new Error('invalid narrowing case shard');
  const shardIndex = Number(match[1]), shardCount = Number(match[2]);
  if (shardCount !== NARROWING_WORKER_COUNT || shardIndex < 0 || shardIndex >= shardCount) throw new Error('unsupported narrowing case shard');
  let failures = 0;
  const completedCaseIds: string[] = [];
  for (const [index, testCase] of CASES.entries()) {
    if (index % shardCount !== shardIndex) continue;
    try {
      await testCase.run();
      completedCaseIds.push(testCase.id);
      console.log(`[PASS] ${testCase.id} ${testCase.desc}`);
    } catch (e) {
      failures += 1;
      console.log(`[FAIL] ${testCase.id} ${testCase.desc} -- ${briefly(e)}`);
    }
  }
  console.log(`${SHARD_RESULT_PREFIX}${JSON.stringify(completedCaseIds)}`);
  if (failures > 0) process.exitCode = 1;
} else {
  const results = await Promise.all(Array.from({ length: NARROWING_WORKER_COUNT }, (_, index) => runCaseShard(index, NARROWING_WORKER_COUNT)));
  for (const result of results) process.stdout.write(`${result.output.split('\n').filter(line => !line.startsWith(SHARD_RESULT_PREFIX)).join('\n')}\n`);
  const completedCaseIds = results.flatMap(result => result.caseIds);
  const completed = new Set(completedCaseIds);
  const complete = results.every(result => result.status === 0)
    && completed.size === CASES.length
    && completedCaseIds.length === CASES.length
    && CASES.every(testCase => completed.has(testCase.id));
  console.log(`narrowing-repin-smoke: ${complete ? 'PASS' : 'FAIL'}`);
  if (!complete) process.exitCode = 1;
}
