#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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
import {
  computeCanonicalDependencyClosure,
  postRemediationReviewSelection,
  verifyCurrentPostRemediationReviewSelection,
  verifyPostRemediationReviewSelection,
} from '../core/review-incremental-context.js';
import { computeFinalReviewRoster, renderFinalReviewRoster, type ActiveReviewer } from '../handlers/reviewer-list.js';

const storyId = 'B-inventory-handler';
const reviewRound = '2020-01-01T00:00:00.000Z';
const cliPath = fileURLToPath(new URL('../../../../bin/lattice.js', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

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
  mkdirSync(join(root, 'packages/main/tests'), { recursive: true });
  writeFileSync(join(root, 'lattice.config.json'), JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', storyDir: '.lattice/story/actives', requirementsDir: 'docs/requirements',
  }));
  writeFileSync(join(root, 'packages/main/src/subject.ts'), 'export const subject = 1;\n');
  writeFileSync(join(root, 'packages/main/src/consumer-a.ts'), "export { subject } from './subject.js';\n");
  writeFileSync(join(root, 'packages/main/src/consumer-b.ts'), "export { subject } from './consumer-a.js';\n");
  writeFileSync(join(root, 'packages/main/tests/isolated.test.ts'), 'export const isolatedTest = 1;\n');
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
    { id: 'CHK-001', title: 'Synthetic handler coverage', context: 'real handler smoke', status: 'done', files: [
      'packages/main/src/subject.ts',
      'packages/main/src/consumer-a.ts',
      'packages/main/src/consumer-b.ts',
      'packages/main/src/opaque.ts',
      'packages/main/tests/isolated.test.ts',
    ] },
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

const postRemediationStory = reloaded.readStory(storyId);
postRemediationStory.currentReviewRound = '2020-01-02T00:00:00.000Z';
reloaded.writeStory(storyId, postRemediationStory);
writeFileSync(join(first.root, 'packages/main/tests/isolated.test.ts'), 'export const isolatedTest = 2;\n');
git(first.root, ['add', 'packages/main/tests/isolated.test.ts']);
git(first.root, ['commit', '-m', 'narrow post-remediation repair']);
const activeReviewers: ActiveReviewer[] = [
  { name: 'concept', reason: 'baseline' },
  { name: 'quality', reason: 'baseline' },
  { name: 'test-coverage', reason: 'baseline' },
  { name: 'behavior', reason: 'riskSignal: gate' },
  { name: 'docs', reason: 'touchpoints .md' },
];
const narrowClosure = computeCanonicalDependencyClosure(first.root, ['packages/main/tests/isolated.test.ts']);
assert.equal(narrowClosure.complete, true, JSON.stringify(narrowClosure));
const narrowSelection = postRemediationReviewSelection(reloaded, first.root, storyId, activeReviewers);
assert.equal(narrowSelection.selection, 'dependency-closure', JSON.stringify(narrowSelection));
assert.deepEqual(narrowSelection.selectedLanes, [
  'lattice-review-quality',
  'lattice-review-test-coverage',
]);
assert.equal(narrowSelection.requiredHostAssurance, 'unchanged');
assert.equal(verifyPostRemediationReviewSelection(narrowSelection), true);
assert.equal(verifyCurrentPostRemediationReviewSelection(reloaded, first.root, storyId, narrowSelection, activeReviewers), true);
for (const forged of [
  { ...narrowSelection, _hash: '' },
  { ...narrowSelection, storyId: 'B-cross-story' },
  { ...narrowSelection, reviewRound: 'cross-round' },
  { ...narrowSelection, headHash: '0'.repeat(40) },
  { ...narrowSelection, materialHash: '0'.repeat(64) },
  { ...narrowSelection, storyFilesHash: '0'.repeat(64) },
]) {
  assert.equal(verifyPostRemediationReviewSelection(forged), false, 'unsigned, cross-boundary, or forged lineage cannot narrow final review');
}
const roster = computeFinalReviewRoster(reloaded, first.root, storyId, activeReviewers);
assert.deepEqual(roster.requiredReviewers.map(row => row.name), ['quality', 'test-coverage']);
const rosterStatus = renderFinalReviewRoster(roster, storyId);
assert.match(rosterStatus, /^Final-review lanes: lattice-review-quality, lattice-review-test-coverage$/m);
assert.match(rosterStatus, /^Selection: dependency-closure \(PROVEN_CANONICAL_DEPENDENCY_CLOSURE: 1 changed file\(s\) close over 1 tracked dependency file\(s\)\)$/m);
assert.equal((rosterStatus.match(/^Next:/gm) ?? []).length, 1);
assert.deepEqual(
  computeCanonicalDependencyClosure(first.root, ['packages/main/src/subject.ts', 'packages/main/src/subject.ts']),
  computeCanonicalDependencyClosure(first.root, ['packages/main/src/subject.ts']),
  'dependency closure canonicalizes ordering and duplicate inputs',
);

writeFileSync(join(first.root, 'packages/main/tests/isolated.test.ts'), 'export const isolatedTest = 3;\n');
const dirtySelection = postRemediationReviewSelection(reloaded, first.root, storyId, activeReviewers);
assert.equal(dirtySelection.selection, 'full-set');
assert.equal(dirtySelection.reason, 'DIRTY_MATERIAL');
assert.equal(verifyCurrentPostRemediationReviewSelection(reloaded, first.root, storyId, narrowSelection, activeReviewers), false, 'dirty material invalidates a prior narrow selection even though HEAD is unchanged');
writeFileSync(join(first.root, 'packages/main/tests/isolated.test.ts'), 'export const isolatedTest = 2;\n');

writeFileSync(join(first.root, '.git/info/exclude'), 'packages/main/src/ignored.ts\n');
writeFileSync(join(first.root, 'packages/main/src/ignored.ts'), 'export const ignored = true;\n');
const ignoredSelection = postRemediationReviewSelection(reloaded, first.root, storyId, activeReviewers);
assert.equal(ignoredSelection.selection, 'full-set');
assert.equal(ignoredSelection.reason, 'UNTRACKED_OR_IGNORED_MATERIAL');
unlinkSync(join(first.root, 'packages/main/src/ignored.ts'));

git(first.root, ['mv', 'packages/main/src/subject.ts', 'packages/main/src/renamed-subject.ts']);
git(first.root, ['commit', '-m', 'inject unsupported rename']);
const renameSelection = postRemediationReviewSelection(reloaded, first.root, storyId, activeReviewers);
assert.equal(renameSelection.selection, 'full-set');
assert.equal(renameSelection.reason, 'UNSUPPORTED_RENAME_OR_DELETE');
git(first.root, ['mv', 'packages/main/src/renamed-subject.ts', 'packages/main/src/subject.ts']);
git(first.root, ['commit', '-m', 'restore canonical subject path']);

writeFileSync(join(first.root, 'packages/main/src/consumer-a.ts'), "export { subject } from './subject.js'; export const a = 2;\n");
writeFileSync(join(first.root, 'packages/main/src/consumer-b.ts'), "export { subject } from './consumer-a.js'; export const b = 2;\n");
git(first.root, ['add', 'packages/main/src/consumer-a.ts', 'packages/main/src/consumer-b.ts']);
git(first.root, ['commit', '-m', 'add transitive shared dependants']);
const expandedClosure = computeCanonicalDependencyClosure(first.root, ['packages/main/src/subject.ts']);
assert.equal(expandedClosure.complete, true, JSON.stringify(expandedClosure));
assert.deepEqual(expandedClosure.files, [
  'packages/main/src/consumer-a.ts',
  'packages/main/src/consumer-b.ts',
  'packages/main/src/subject.ts',
]);
assert.equal(verifyCurrentPostRemediationReviewSelection(reloaded, first.root, storyId, narrowSelection, activeReviewers), false, 'new dependency invalidates the prior narrow selection binding');
const recomputedSelection = postRemediationReviewSelection(reloaded, first.root, storyId, activeReviewers);
assert.notEqual(recomputedSelection._hash, narrowSelection._hash);
assert.ok(recomputedSelection.closureFiles.includes('packages/main/src/consumer-b.ts'), 'current-material recomputation follows transitive dependants');

writeFileSync(join(first.root, 'packages/main/src/untracked.ts'), 'export const hidden = true;\n');
const untrackedSelection = postRemediationReviewSelection(reloaded, first.root, storyId, activeReviewers);
assert.equal(untrackedSelection.selection, 'full-set');
assert.equal(untrackedSelection.reason, 'UNTRACKED_OR_IGNORED_MATERIAL');
unlinkSync(join(first.root, 'packages/main/src/untracked.ts'));

writeFileSync(join(first.root, 'packages/main/src/opaque.ts'), "declare const target: string; export const load = () => import(target);\n");
git(first.root, ['add', 'packages/main/src/opaque.ts']);
git(first.root, ['commit', '-m', 'inject opaque dependency']);
const opaqueSelection = postRemediationReviewSelection(reloaded, first.root, storyId, activeReviewers);
assert.equal(opaqueSelection.selection, 'full-set');
assert.equal(opaqueSelection.reason, 'DEPENDENCY_CLOSURE_INCOMPLETE');
assert.match(opaqueSelection.reasonDetail, /opaque dynamic dependency/);
assert.deepEqual(opaqueSelection.selectedLanes, opaqueSelection.activeLanes);
const opaqueStatus = renderFinalReviewRoster(computeFinalReviewRoster(reloaded, first.root, storyId, activeReviewers), storyId);
assert.match(opaqueStatus, /^Selection: full-set \(DEPENDENCY_CLOSURE_INCOMPLETE: opaque dynamic dependency:/m);
assert.equal((opaqueStatus.match(/^Next:/gm) ?? []).length, 1);
assert.equal(computeCanonicalDependencyClosure(first.root, ['../subject.ts']).complete, false, 'path traversal cannot enter the canonical source inventory');

const expandedChecklist = reloaded.readChecklist(storyId);
expandedChecklist.items[0].files = { modify: ['packages/main/src/subject.ts', 'packages/main/src/expanded.ts'], create: [], test: [] };
reloaded.writeChecklist(storyId, expandedChecklist);
const expandedScopeSelection = postRemediationReviewSelection(reloaded, first.root, storyId, activeReviewers);
assert.equal(expandedScopeSelection.selection, 'full-set');
assert.equal(expandedScopeSelection.reason, 'SCOPE_OR_POLICY_CHANGED');
assert.deepEqual(expandedScopeSelection.selectedLanes, narrowSelection.activeLanes, 'scope expansion restores every active lane');

const provenance = [
  ['8e9f72fc5424f499cb396ad92bc13558d88fb712', 'B-cdf6:RR-043'],
  ['57bbc87d5faba0610cca88e088af1b54a327c0ef', 'B-cdf6:RR-044'],
  ['8e9f72fc5424f499cb396ad92bc13558d88fb712', 'B-cdf6:RR-045'],
  ['8e9f72fc5424f499cb396ad92bc13558d88fb712', 'B-cdf6:RR-046'],
  ['26a30e6cd7f00672e2b399d5d8e7473a4cbb1360', 'B-cdf6:F-036'],
] as const;
for (const [commit, identifier] of provenance) {
  git(repositoryRoot, ['cat-file', '-e', `${commit}^{commit}`]);
  git(repositoryRoot, ['grep', '-q', '-F', identifier, commit, '--', '.lattice/story/actives/B-cdf6']);
}
git(repositoryRoot, ['cat-file', '-e', '155e787d0c92612f16e9c2dd011531b0caa18ee6^{commit}']);
const decisionText = readFileSync(join(repositoryRoot, 'docs/requirements/decisions/review-inventory-epoch-and-saturation-gate.md'), 'utf8');
for (const [, identifier] of provenance) assert.ok(decisionText.includes(identifier), `decision provenance must cite ${identifier}`);
assert.ok(decisionText.includes('155e787d0c92612f16e9c2dd011531b0caa18ee6'), 'decision provenance must cite the exact material-fix commit');
assert.ok(!decisionText.includes('claude-session-b-cdf6-review-convergence-analysis-and-optimization.md'), 'decision provenance cannot depend on the excluded analysis document');

const symlinkCase = setup();
symlinkSync('subject.ts', join(symlinkCase.root, 'packages/main/src/subject-alias.ts'));
git(symlinkCase.root, ['add', 'packages/main/src/subject-alias.ts']);
git(symlinkCase.root, ['commit', '-m', 'inject source alias']);
const symlinkClosure = computeCanonicalDependencyClosure(symlinkCase.root, ['packages/main/src/subject-alias.ts']);
assert.equal(symlinkClosure.complete, false);
assert.match(symlinkClosure.reason ?? '', /symlink/);

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
