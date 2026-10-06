#!/usr/bin/env node

/**
 * B-2296 F-003 (REVIEW cluster CL-001): integration smoke for the REAL production
 * snapshot hook `captureUserSeesSnapshot`, wired into checklist_update's status→done
 * transition (handlers/checklist.ts). Prior tests only exercised the pure
 * detectDrift/buildDriftReport Fns on fixtures; the actual hook that pins a
 * userSeesSnapshot on disk had ZERO automated coverage. This drives the hook through
 * the SHIPPING CLI handler path against a throwaway temp git repo + story.
 *
 * Deterministic + offline: a local temp git repo, no network, no `claude -p`.
 *
 * Asserts:
 *   1. Marking an item with a non-empty `userSees` done PINS a userSeesSnapshot
 *      (normalizedClaimDigest === claimDigest(userSees); non-empty storyFilesHash + headHash).
 *   2. Immutable-once: a second status write (done → in_progress → done, even with the
 *      hook re-invoked) does NOT overwrite the snapshot — it is byte-identical (attestedAt
 *      unchanged proves it was never re-taken).
 *   3. An item with absent/empty `userSees` gets NO snapshot.
 *   4. (F-002 integration) the real read-only `frozen_claim_drift_check` handler reports a
 *      CLEAN report (0 drifted, 0 legacy-unbound) for the resulting clean story.
 *
 * Exits non-zero on any failed assertion; prints a final `PASS` line on success.
 */

import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimDigest } from '../core/frozen-claim-drift.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function run(root: string, command: string, args: Record<string, unknown>): string {
  const res = spawnSync(process.execPath, [cliPath, '--root', root, command, JSON.stringify(args)], {
    cwd: root,
    encoding: 'utf8',
  });
  if ((res.status ?? -1) !== 0) {
    throw new Error(`${command} failed (status=${res.status}): ${res.stdout}\n${res.stderr}`);
  }
  return res.stdout ?? '';
}

const background = [
  '## Trigger Event',
  '2026-07-26 B-0000 smoke needs trigger detail to satisfy background validation for the snapshot-hook path.',
  '## Key Insights',
  'The userSees claim must be pinned once at the status-done attestation and never re-taken thereafter.',
  '## Trade-offs',
  'Pinning immutably (once) mirrors the B-ec67 receipt model so a later re-persist cannot silently move the attested claim.',
  '## Conversation Texture',
  'A maintainer marks an item done and sees a frozen userSeesSnapshot appear on disk exactly once.',
].join('\n\n');

// Pin a stable session so every child CLI shares one session (owner-lease gate stability).
const origSessionId = process.env.PROOF_OR_STOP_SESSION_ID;
process.env.PROOF_OR_STOP_SESSION_ID = 'smoke-snapshot-hook';

const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-snapshot-hook-'));
try {
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'Proof-or-Stop Smoke']);
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  write(root, 'README.md', 'smoke\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);

  const CLAIM = 'the file hello.txt was created';
  const created = run(root, 'story_create', {
    name: 'snapshot-hook',
    title: 'Snapshot hook story',
    description: 'Verify the userSees snapshot is pinned once at the done attestation.',
    type: 'chore',
    priority: 'medium',
    background,
    checklist: [
      { title: 'Item with a delivered claim', context: 'ctx-claim', userSees: CLAIM, verificationIntent: { happy: [{ desc: 'Done transition captures the delivered claim exactly once', type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story' }] } },
      { title: 'Item with no delivered claim', context: 'ctx-none', verificationIntent: { happy: [{ desc: 'An item without a delivered claim does not acquire a snapshot', type: 'logic', priority: 'must', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story' }] } }, // no userSees
    ],
  });
  const storyId = created.match(/B-[a-f0-9]+/)?.[0];
  assert.ok(storyId, 'story_create should return a story id');

  const checklistPath = join(root, '.proof-or-stop/story/actives', storyId!, 'checklist.json');
  const readItem = (id: string): any => {
    const cl = JSON.parse(readFileSync(checklistPath, 'utf8'));
    return cl.items.find((i: any) => i.id === id);
  };

  // Preconditions: neither item has a snapshot before any done transition.
  assert.equal(readItem('CHK-001').userSeesSnapshot, undefined, 'CHK-001 has no snapshot before done');
  assert.equal(readItem('CHK-002').userSeesSnapshot, undefined, 'CHK-002 has no snapshot before done');

  // ── Assertion 1: marking a non-empty-userSees item done PINS a snapshot. ────────
  run(root, 'checklist_update', { storyId, itemId: 'CHK-001', status: 'done' });
  const snap1 = readItem('CHK-001').userSeesSnapshot;
  assert.ok(snap1, 'CHK-001 gained a userSeesSnapshot on the status→done transition (REAL hook fired)');
  assert.equal(
    snap1.normalizedClaimDigest,
    claimDigest(CLAIM),
    'snapshot pins the normalized claim digest of the item userSees',
  );
  assert.match(snap1.storyFilesHash, /^[0-9a-f]{64}$/, 'snapshot pins a concrete story-owned material hash (storyFilesHash)');
  assert.match(snap1.headHash, /^[0-9a-f]{7,40}$/, 'snapshot pins the git HEAD hash');
  assert.ok(typeof snap1.attestedAt === 'string' && snap1.attestedAt.length > 0, 'snapshot records an attestedAt timestamp');
  console.log('✓ [hook] status→done pins a userSeesSnapshot (digest + storyFilesHash + headHash) via the REAL handler');

  // ── Assertion 2: immutable-once. A second status write does NOT overwrite it. ───
  // Reopen (done → in_progress) then re-attest (→ done). The hook is invoked again on
  // this second done transition, but the immutable-once guard returns without re-taking
  // the snapshot: it must be byte-identical (attestedAt unchanged proves no re-pin).
  run(root, 'checklist_update', { storyId, itemId: 'CHK-001', status: 'in_progress', reason: 'reopen to prove immutable-once snapshot' });
  run(root, 'checklist_update', { storyId, itemId: 'CHK-001', status: 'done', reason: 're-attest to prove immutable-once snapshot' });
  const snap2 = readItem('CHK-001').userSeesSnapshot;
  assert.ok(snap2, 'CHK-001 still carries a snapshot after re-attestation');
  assert.deepEqual(snap2, snap1, 'immutable-once: the snapshot is byte-identical after a second status write (never re-taken)');
  assert.equal(snap2.attestedAt, snap1.attestedAt, 'attestedAt is unchanged — the snapshot was pinned exactly once');
  console.log('✓ [immutable-once] a second done write does NOT overwrite the snapshot (byte-identical, attestedAt unchanged)');

  // ── Assertion 3: an item with absent/empty userSees gets NO snapshot. ───────────
  run(root, 'checklist_update', { storyId, itemId: 'CHK-002', status: 'done' });
  const item2 = readItem('CHK-002');
  assert.equal(item2.status, 'done', 'CHK-002 is marked done');
  assert.equal(item2.userSeesSnapshot, undefined, 'an item with no userSees gets NO snapshot (nothing to freeze)');
  console.log('✓ [no-claim] a done item with absent/empty userSees gets NO snapshot');

  // ── Assertion 4 (F-002 integration): the clean story reports a CLEAN drift report. ─
  // Both items are now done: CHK-001 is snapshot-bound + un-drifted; CHK-002 has no claim.
  // The real read-only frozen_claim_drift_check handler must report ZERO drift, non-blocking.
  const driftJson = JSON.parse(run(root, 'frozen_claim_drift_check', { storyId, json: true }));
  assert.equal(driftJson.summary.total, 0, 'clean story → 0 advisories from the real frozen_claim_drift_check handler');
  assert.equal(driftJson.summary.drifted, 0, 'clean story → 0 drifted');
  assert.equal(driftJson.summary.legacyUnbound, 0, 'clean story → 0 legacy-unbound (CHK-001 is snapshot-bound)');
  assert.equal(driftJson.blocking, false, 'the advisory is non-blocking (Phase 1 invariant)');
  console.log('✓ [clean-report] real frozen_claim_drift_check handler reports a CLEAN report for the snapshot-bound story');
} finally {
  rmSync(root, { recursive: true, force: true });
  if (origSessionId === undefined) {
    delete process.env.PROOF_OR_STOP_SESSION_ID;
  } else {
    process.env.PROOF_OR_STOP_SESSION_ID = origSessionId;
  }
}

console.log('frozen-claim-snapshot-hook-smoke: PASS');
