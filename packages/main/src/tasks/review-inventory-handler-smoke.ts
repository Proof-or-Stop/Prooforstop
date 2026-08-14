#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import { reviewInventoryDigest, consumeReviewInventoryReceipt, finalizedUnconsumedReviewInventory } from '../core/review-inventory-epoch.js';
import { hashReviewPrompt, signReviewRun } from '../core/review-run.js';
import { resolvePromptRoleBody } from '../core/prompt-role-contract-registry.js';
import { signReviewPass } from '../core/finding-verify.js';
import type { ReviewPass, ReviewRun, StoryInfo } from '../core/types.js';
import { createReviewInventoryHandlers } from '../handlers/review-inventory.js';

const storyId = 'B-inventory-handler';
const reviewRound = '2020-01-01T00:00:00.000Z';
const cliPath = fileURLToPath(new URL('../../../../bin/lattice.js', import.meta.url));

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function cli(root: string, command: string, payload: Record<string, unknown>, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(process.execPath, [cliPath, '--root', root, command, JSON.stringify(payload)], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  }).trim();
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'review-inventory-handler-'));
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', storyDir: '.lattice/story/actives', requirementsDir: 'docs/requirements',
  }));
  writeFileSync(join(root, 'packages/main/src/subject.ts'), 'export const subject = 1;\n');
  git(root, ['init']);
  git(root, ['checkout', '-b', 'main']);
  git(root, ['config', 'user.name', 'Inventory Handler Smoke']);
  git(root, ['config', 'user.email', 'inventory-handler@example.invalid']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initial']);
  resetConfigCache();
  const store = new StoryStore(root);
  const story: StoryInfo = {
    storyId, name: 'inventory-handler-smoke', title: 'Inventory handler smoke',
    description: 'Exercise real review inventory handler persistence and fail-closed paths.',
    type: 'chore', phase: 'REVIEW', priority: 'high', createdAt: reviewRound,
    startedAt: reviewRound, endedAt: null, currentReviewRound: reviewRound,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: reviewRound }],
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, { items: [
    { id: 'CHK-001', title: 'Synthetic handler coverage', context: 'real handler smoke', status: 'done', files: ['packages/main/src/subject.ts'] },
  ] } as never);
  return { root, store, handlers: createReviewInventoryHandlers({ root, scanRoot: join(root, 'packages/main'), store }) };
}

function signedRun(epoch: ReturnType<StoryStore['readReviewInventoryEpochs']>['epochs'][number], lane: string, index: number): ReviewRun {
  const startedAt = new Date().toISOString();
  const promptHash = hashReviewPrompt(resolvePromptRoleBody(lane, undefined).body);
  const row: ReviewRun = {
    reviewRunId: `${storyId}:RR-${String(index).padStart(3, '0')}`, storyId, agent: lane, lane,
    reviewRound, startedAt, ...epoch.cutoff, promptHash,
  };
  row._hash = signReviewRun(storyId, row.reviewRunId, lane, lane, reviewRound, startedAt,
    row.headHash, row.materialHash, promptHash, undefined, undefined, row.storyFilesHash);
  return row;
}

function signedPass(run: ReviewRun, index: number): ReviewPass {
  const createdAt = new Date().toISOString();
  const readManifest = { filesReadFully: ['packages/main/src/subject.ts'], filesTriagedByName: [], scanEscalationReason: null };
  const readLog = {
    filesReadFully: ['packages/main/src/subject.ts'], filesTriagedByName: [], summary: { readCount: 1, tokenCount: 8 },
    digest: reviewInventoryDigest({ run: run.reviewRunId, read: 'subject.ts' }),
  };
  const row: ReviewPass = {
    id: `${storyId}:RP-${String(index).padStart(3, '0')}`, agent: run.agent,
    note: 'real handler smoke terminal review evidence', createdAt, reviewRound,
    reviewRunId: run.reviewRunId, readManifest, readLog,
  };
  row._hash = signReviewPass(storyId, row.id, row.agent, row.note, createdAt, reviewRound,
    row.reviewRunId, readManifest, readLog);
  return row;
}

function waitForClockAfter(timestamp: string): void {
  const boundary = Date.parse(timestamp);
  while (Date.now() <= boundary) {
    // Evidence ordering is millisecond-based; advance the real clock rather than
    // manufacturing future terminal timestamps that a receipt could predate.
  }
}

const first = setup();
const begin = cli(first.root, 'review_inventory_begin', { storyId, maxWaves: 2 });
assert.match(begin, /State: OPEN/);
assert.match(first.handlers.review_inventory_status({ storyId }), /REVIEW_INVENTORY_LANES_INCOMPLETE/);
assert.match(cli(first.root, 'review_inventory_status', { storyId }), /REVIEW_INVENTORY_LANES_INCOMPLETE/);
const reloaded = new StoryStore(first.root);
assert.equal(reloaded.readReviewInventoryEpochs(storyId).epochs.length, 1, 'begin persists across store reload');
const epoch = reloaded.readReviewInventoryEpochs(storyId).epochs[0];
const lanes = epoch.requiredLanes.map((lane, index) => signedRun(epoch, lane, index + 1));
const passes = lanes.map((run, index) => signedPass(run, index + 1));
waitForClockAfter(passes.map(row => row.createdAt).sort().at(-1)!);
const criticRun = signedRun(epoch, 'lattice-review-topology-critic', 10);
const criticPass = signedPass(criticRun, 10);
waitForClockAfter(criticPass.createdAt);
reloaded.writeReviewRuns(storyId, { runs: [...lanes, criticRun] });
reloaded.writeReviewPasses(storyId, { passes: [...passes, criticPass] });
const critic = cli(first.root, 'review_inventory_critic_set', {
  storyId, epochId: epoch.epochId, reviewRunId: criticRun.reviewRunId,
  agent: 'lattice-review-topology-critic', findingDispositions: [],
}, { LATTICE_AGENT: 'lattice-review-topology-critic' });
assert.match(critic, /Completeness critic: complete/);
const finalized = cli(first.root, 'review_inventory_finalize', { storyId });
assert.match(finalized, /State: FINALIZED/);
assert.ok(finalizedUnconsumedReviewInventory(reloaded, storyId), 'finalized signed receipt is visible to the begin barrier');
assert.throws(() => cli(first.root, 'review_inventory_begin', { storyId }), /REVIEW_INVENTORY_RECEIPT_UNCONSUMED/);
const finalizedData = reloaded.readReviewInventoryEpochs(storyId);
const receipt = finalizedData.receipts[0];
consumeReviewInventoryReceipt(reloaded, storyId, reviewRound, epoch.cutoff);
assert.throws(() => consumeReviewInventoryReceipt(reloaded, storyId, reviewRound, epoch.cutoff), /REVIEW_INVENTORY_REMEDIATION_BLOCKED/);
assert.equal(reloaded.readReviewInventoryEpochs(storyId).receipts[0].receiptId, receipt.receiptId);

const cancelled = setup();
cli(cancelled.root, 'review_inventory_begin', { storyId });
assert.match(cli(cancelled.root, 'review_inventory_cancel', { storyId, reason: 'operator cancels this real handler smoke epoch' }), /State: CANCELLED/);
assert.match(cli(cancelled.root, 'review_inventory_begin', { storyId }), /State: OPEN/, 'cancelled epoch permits a fresh persisted epoch');

const drifted = setup();
drifted.handlers.review_inventory_begin({ storyId });
writeFileSync(join(drifted.root, 'packages/main/src/subject.ts'), 'export const subject = 2;\n');
git(drifted.root, ['add', 'packages/main/src/subject.ts']);
git(drifted.root, ['commit', '-m', 'mutate frozen review material']);
assert.match(drifted.handlers.review_inventory_status({ storyId }), /State: INVALIDATED/);
assert.throws(() => drifted.handlers.review_inventory_finalize({ storyId }), /no OPEN epoch/);

const unsupported = setup();
const unsupportedBegin = unsupported.handlers.review_inventory_begin({ storyId });
const unsupportedEpoch = unsupported.store.readReviewInventoryEpochs(storyId).epochs[0];
const before = JSON.stringify(unsupported.store.readReviewInventoryEpochs(storyId));
assert.throws(() => unsupported.handlers.review_inventory_critic_set({
  storyId, epochId: unsupportedEpoch.epochId, reviewRunId: 'unsupported-run',
  agent: 'lattice-review-topology-critic', findingDispositions: [],
}), /only lattice-review-topology-critic|agent_dispatch_mutation_denied|LANES_INCOMPLETE/);
assert.equal(JSON.stringify(unsupported.store.readReviewInventoryEpochs(storyId)), before, 'rejected critic mutation is side-effect free');
assert.match(unsupportedBegin, /Next: lattice review_inventory_status/);

console.log('review inventory real handler smoke: PASS');
