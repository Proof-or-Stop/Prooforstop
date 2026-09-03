#!/usr/bin/env node
/**
 * B-3b88 CHK-002 smoke: verification_evidence_refresh_stale must NOT silently
 * re-certify a stale command-backed result:pass onto current material (laundering),
 * while still refreshing command-less attestation rows. Covers all CHK-002
 * happy/edge/adversarial verification intents. Per-row classification is independent.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import type { ChecklistData, StoryInfo, VerificationEvidence } from '../core/types.js';
import { createMainRegistry } from '../registry.js';
import type { HandlerContext } from '../handlers/context.js';

const STORY_ID = 'B-refresh-honesty';
const NOW = '2026-07-25T00:00:00.000Z';
const STALE_HEAD = '0000000000000000000000000000000000000000';
const STALE_MATERIAL = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'refresh-honesty-smoke', GIT_AUTHOR_EMAIL: 'x@example.com',
      GIT_COMMITTER_NAME: 'refresh-honesty-smoke', GIT_COMMITTER_EMAIL: 'x@example.com',
    },
  }).trim();
}

function writeConfig(root: string): void {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements', workflow: { profile: 'balanced' },
  }, null, 2) + '\n', 'utf8');
  resetConfigCache();
}

function baseStory(): StoryInfo {
  return {
    storyId: STORY_ID, name: 'refresh-honesty-smoke', title: 'refresh_stale honesty fixture',
    description: 'Fixture for the refresh_stale command-backed-pass honesty guard.',
    type: 'bug', phase: 'DEV', priority: 'medium', createdAt: NOW, startedAt: NOW, endedAt: null,
  };
}

// 4 happy + 4 edge + 4 adversarial intent slots so any ref CHK-001:<lane>:<0..3> resolves.
function seed(rows: VerificationEvidence[]): ChecklistData {
  const lane = () => Array.from({ length: 4 }, () => ({ desc: 'x', type: 'logic' as const, priority: 'must' as const }));
  return {
    items: [{
      id: 'CHK-001', title: 'refresh honesty item', context: 'command-backed pass must not be laundered',
      status: 'done', startTime: null, endTime: null,
      verificationIntent: { happy: lane(), edge: lane(), adversarial: lane() },
      verificationEvidence: rows,
    }],
  };
}

function createFixture(rows: VerificationEvidence[]): { store: StoryStore; ctx: HandlerContext } {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-refresh-honesty-'));
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeConfig(root);
  writeFileSync(join(root, 'README.md'), '# smoke\n', 'utf8');
  writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const value = 1;\n', 'utf8');
  git(root, ['init']); git(root, ['checkout', '-b', 'main']);
  git(root, ['add', 'README.md', 'proof-or-stop.config.json', 'packages/main/src/index.ts']);
  git(root, ['commit', '-m', 'base']);
  const store = new StoryStore(root);
  store.writeStory(STORY_ID, baseStory());
  store.writeChecklist(STORY_ID, seed(rows));
  return { store, ctx: { store, root, scanRoot: join(root, 'packages/main') } };
}

function cmdRow(ref: string, over: Partial<VerificationEvidence> = {}): VerificationEvidence {
  return { intentRef: ref, kind: 'logic_test', command: 'node packages/main/dist/tasks/x.js', result: 'pass', note: 'command-backed', headHash: STALE_HEAD, materialHash: STALE_MATERIAL, ...over };
}
function attRow(ref: string, over: Partial<VerificationEvidence> = {}): VerificationEvidence {
  return { intentRef: ref, kind: 'manual_transcript', result: 'pass', note: 'attestation, no command', headHash: STALE_HEAD, materialHash: STALE_MATERIAL, ...over };
}

// B-1507 made verification_evidence_refresh_stale async (it re-executes pinned
// commands outside the checklist lock), so callers must await it.
async function run(rows: VerificationEvidence[], dryRun = false): Promise<{ output: string; store: StoryStore; ctx: HandlerContext }> {
  const { store, ctx } = createFixture(rows);
  const refresh = createMainRegistry(ctx).get('verification_evidence_refresh_stale')!;
  const output = String(await refresh({ storyId: STORY_ID, ...(dryRun ? { dryRun: true } : {}) }));
  return { output, store, ctx };
}
function headOf(store: StoryStore, ref: string): string | undefined {
  const item = store.readChecklist(STORY_ID).items.find(i => i.id === 'CHK-001')!;
  return (item.verificationEvidence || []).find(e => e.intentRef === ref)?.headHash;
}

/**
 * B-1507 (main) strengthened refresh: a stale command-backed row is never
 * laundered. Refresh RE-EXECUTES the pinned command; on a genuine pass the row is
 * re-stamped WITH a fresh receipt (mechanical:true), and on any failure/absence it
 * is demoted to a non-mechanical attestation (which the coverage gate refuses).
 * The invariant this story guards: a refreshed command-backed pass must never end
 * up fresh-and-mechanical without a real execution receipt.
 */
function noLaunderingHolds(store: StoryStore, ref: string): boolean {
  const item = store.readChecklist(STORY_ID).items.find(i => i.id === 'CHK-001')!;
  const ev = (item.verificationEvidence || []).find(e => e.intentRef === ref);
  if (!ev) return true;
  const isFresh = !!ev.headHash && ev.headHash !== STALE_HEAD;
  if (!isFresh) return true;                        // left stale -> not laundered
  // Fresh: the row MUST have visibly changed state. Either a real re-execution
  // receipt (mechanical:true + receipt), or an explicit demotion (mechanical:false).
  // `mechanical === undefined` on a fresh command-backed row means it passed straight
  // through untouched — that IS laundering (the reviewer-found regression).
  if (ev.mechanical === true) return !!ev.receipt;
  if (ev.mechanical === false) return true;         // explicitly demoted
  const commandBacked = typeof ev.command === 'string' && ev.command.length > 0 && ev.result === 'pass';
  return !commandBacked;                            // untouched command-backed pass = laundered
}

function refreshed(store: StoryStore, ref: string): boolean {
  const h = headOf(store, ref);
  return !!h && h !== STALE_HEAD;
}

// happy:0 — command-backed pass is left stale.
{
  const { store } = await run([cmdRow('CHK-001:happy:0')]);
  assert.equal(noLaunderingHolds(store, 'CHK-001:happy:0'), true, 'happy:0 command-backed pass is never laundered (stale, demoted, or re-earned with a receipt)');
}
// happy:1 — command-less attestation row IS refreshed.
{
  const { store } = await run([attRow('CHK-001:happy:1')]);
  assert.equal(refreshed(store, 'CHK-001:happy:1'), true, 'happy:1 attestation refreshed');
}
// happy:2 — output distinguishes refused (command-backed) from refreshed (attestation).
{
  const { output, store } = await run([cmdRow('CHK-001:happy:0'), attRow('CHK-001:happy:1')]);
  assert.ok(output.length > 0, 'happy:2 refresh reports per-row classification');
  assert.equal(noLaunderingHolds(store, 'CHK-001:happy:0'), true, 'happy:2 command-backed row is never laundered');
  assert.equal(refreshed(store, 'CHK-001:happy:1'), true, 'happy:2 attestation refreshed');
}
// edge:0 — dryRun on a mix reports classification with NO mutation.
{
  const { output, store } = await run([cmdRow('CHK-001:happy:0'), attRow('CHK-001:happy:1')], true);
  assert.match(output, /DRY-RUN/, 'edge:0 dryRun labeled');
  assert.equal(refreshed(store, 'CHK-001:happy:0'), false, 'edge:0 dryRun mutates nothing (cmd row untouched)');
  assert.equal(refreshed(store, 'CHK-001:happy:1'), false, 'edge:0 dryRun mutates nothing (att)');
}
// edge:1 — command + result=fail is not a pass, so not the laundering channel (untouched by the guard/candidate set).
{
  const { store } = await run([cmdRow('CHK-001:happy:0', { result: 'fail' })]);
  assert.equal(noLaunderingHolds(store, 'CHK-001:happy:0'), true, 'edge:1 failed command row is never laundered');
}
// edge:2 — all attestation rows refresh normally.
{
  const { store } = await run([attRow('CHK-001:happy:0'), attRow('CHK-001:happy:1')]);
  assert.equal(refreshed(store, 'CHK-001:happy:0'), true, 'edge:2 att0 refreshed');
  assert.equal(refreshed(store, 'CHK-001:happy:1'), true, 'edge:2 att1 refreshed');
}
// edge:3 — zero stale rows: no crash, reports nothing stale.
{
  const { output } = await run([]);
  assert.match(output, /No stale/i, 'edge:3 zero-stale message');
}
// adversarial:0 — all command-backed passes: zero refreshed, all flagged.
{
  const { output, store } = await run([cmdRow('CHK-001:happy:0'), cmdRow('CHK-001:happy:1')]);
  assert.equal(noLaunderingHolds(store, 'CHK-001:happy:0'), true, 'adversarial:0 cmd0 never laundered');
  assert.equal(noLaunderingHolds(store, 'CHK-001:happy:1'), true, 'adversarial:0 cmd1 never laundered');
  assert.ok(output.length > 0, 'adversarial:0 refresh reports its classification');
}
// adversarial:1 — whitespace-only command is command-backed (must not slip through).
{
  const { store } = await run([cmdRow('CHK-001:happy:0', { command: ' ' })]);
  assert.equal(noLaunderingHolds(store, 'CHK-001:happy:0'), true, 'adversarial:1 whitespace command counts as command-backed and is never laundered');
}
// adversarial:2 — after refusal, a genuine re-verification via verification_evidence_add is accepted.
{
  const { store, ctx } = await run([cmdRow('CHK-001:happy:0')]);
  assert.equal(noLaunderingHolds(store, 'CHK-001:happy:0'), true, 'adversarial:2 not laundered before re-verification');
  const add = createMainRegistry(ctx).get('verification_evidence_add')!;
  // B-ec67 made verification_evidence_add async — await it before asserting the row.
  await assert.doesNotReject(async () => add({ storyId: STORY_ID, itemId: 'CHK-001', intentRef: 'CHK-001:happy:0', kind: 'logic_test', result: 'pass', command: 'node packages/main/dist/tasks/x.js', note: 'genuine re-run after refusal', nonMechanicalReason: 'synthetic re-verification row for the refresh-honesty unit smoke' }), 'adversarial:2 re-verification accepted');
  assert.equal(refreshed(store, 'CHK-001:happy:0'), true, 'adversarial:2 re-verify freshens the row');
}
// adversarial:3 — per-row independence: same item, only the attestation row refreshes.
{
  const { store } = await run([cmdRow('CHK-001:happy:0'), attRow('CHK-001:happy:1')]);
  assert.equal(noLaunderingHolds(store, 'CHK-001:happy:0'), true, 'adversarial:3 command-backed row never laundered');
  assert.equal(refreshed(store, 'CHK-001:happy:1'), true, 'adversarial:3 attestation row refreshes');
}

console.log('refresh-stale-honesty-smoke: PASS');
