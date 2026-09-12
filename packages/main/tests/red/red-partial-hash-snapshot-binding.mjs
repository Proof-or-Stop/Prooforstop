#!/usr/bin/env node
/**
 * RED (repro-first) for draft `partial-hash-snapshot-treated-as-binding`.
 *
 * core/evidence-freshness.ts captureEvidenceHashSnapshot NEVER throws on a git or
 * hash failure: headHash / materialHash / storyFilesHash are each OPTIONAL and are
 * simply OMITTED. tryCaptureEvidenceHashSnapshot only turns a *thrown* error into
 * undefined. So an unborn repository (`git init`, zero commits) yields a
 * RETURNED snapshot that binds nothing, and every consumer that only
 * distinguishes thrown-vs-returned proceeds as if it held a binding.
 *
 * This script asserts the DESIRED property at each lifecycle-gate consumer:
 * a partial snapshot must FAIL CLOSED or be DISCLOSED, never silently pass.
 * Pre-fix it FAILS (RED); after the story's fix it must PASS (GREEN).
 *
 * Consumers driven (all against hermetic temp git fixtures, cleaned up):
 *   C1 reader contract   captureEvidenceHashSnapshot on an unborn repo RETURNS a
 *                        snapshot with all three digests absent (documents the
 *                        contract; this case is expected to hold before and after).
 *   C2 evidence-freshness checkEvidenceFreshnessForGit (the active TEST->DONE
 *                        freshness predicate used by done-oracle row 1b) with a
 *                        stored evidence headHash+materialHash but an UNREADABLE
 *                        current HEAD must NOT report fresh=true.
 *   C3 done-oracle       buildDoneChecklist on the unborn repo with PASS test
 *                        evidence bound to digests that cannot be re-read must
 *                        fail the evidence-freshness row (fail closed).
 *   C4 phase-gates       runDoneOracleGate on the same fixture must throw AND the
 *                        thrown text must disclose the unreadable digest.
 *   C5 lifecycle-readiness buildStoryReadinessReport(target=DONE) on the unborn
 *                        repo must make head_hash_unavailable /
 *                        material_hash_unavailable BLOCKING for DONE.
 *   C6 legacy partial    current no-main semantics produce the explicit empty
 *                        Story-files digest. A legacy completed snapshot with
 *                        materialHash but NO storyFilesHash must still be
 *                        disclosed by buildDoneChecklist as advisory.
 *   C7 dangling HEAD     (B-83aa:F-001) a `story/*` ref pointing at a sha absent
 *                        from the object db: HEAD resolves but `git ls-tree`
 *                        fails; checkEvidenceFreshnessForGit with an evidence
 *                        materialHash must fail closed naming materialHash and
 *                        must NOT fall through to the head comparison.
 *
 * Not driven here (recorded for the audit checklist): handlers/verifier.ts
 * evaluateStoryRoutineReuse (exported; driven with a captured ctx.log by
 * tasks/evidence-hash-snapshot-classifier-smoke.ts) and handlers/session.ts
 * DONE pre-check (wrapped in a catch-all that swallows the whole block).
 *
 * Run from the repository root:
 *   node packages/main/tests/red/red-partial-hash-snapshot-binding.mjs
 * Optional: RED_DIST_ROOT=<alt packages/main/dist> to run against a patched dist.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let repoRoot = process.env.RED_REPO_ROOT ?? here;
while (!existsSync(join(repoRoot, 'proof-or-stop.config.json')) && repoRoot !== dirname(repoRoot)) repoRoot = dirname(repoRoot);
assert.ok(existsSync(join(repoRoot, 'proof-or-stop.config.json')), 'could not locate repo root (proof-or-stop.config.json)');

const distRoot = process.env.RED_DIST_ROOT ?? join(repoRoot, 'packages/main/dist');
const imp = (rel) => import(pathToFileURL(join(distRoot, rel)).href);
const freshness = await imp('core/evidence-freshness.js');
const { buildDoneChecklist } = await imp('core/done-oracle.js');
const { buildStoryReadinessReport } = await imp('core/lifecycle-readiness.js');
const { runDoneOracleGate } = await imp('handlers/phase-gates.js');
const { StoryStore } = await imp('core/store.js');
const { resetConfigCache } = await imp('core/config.js');

const NOW = '2026-09-02T00:00:00.000Z';
const FAKE_HEAD = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const FAKE_MATERIAL = 'c0ffee'.repeat(10) + 'c0ff';
const FAKE_STORY_FILES = 'ab'.repeat(32);

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'red', GIT_AUTHOR_EMAIL: 'red@example.invalid', GIT_COMMITTER_NAME: 'red', GIT_COMMITTER_EMAIL: 'red@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}
function writeConfig(root) {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements', worktreeDir: '.worktrees', workflow: { profile: 'light' },
  }, null, 2) + '\n');
  resetConfigCache();
}
function writeTestStory(store, storyId) {
  store.writeStory(storyId, {
    storyId, name: 'partial-hash-fixture', title: 'Partial hash snapshot fixture story',
    description: 'Drive lifecycle gate consumers over a partial evidence hash snapshot.',
    type: 'chore', phase: 'TEST', priority: 'medium', createdAt: NOW, startedAt: NOW, endedAt: null,
  });
  store.writeChecklist(storyId, { items: [{ id: 'CHK-001', title: 'Synthetic item', context: 'Synthetic context', status: 'done', startTime: null, endTime: null }] });
  store.writeTestEvidence(storyId, {
    command: 'proof-or-stop validate', output: JSON.stringify({ allPassed: true }), result: 'PASS', timestamp: NOW,
    headHash: FAKE_HEAD, materialHash: FAKE_MATERIAL, storyFilesHash: FAKE_STORY_FILES,
  });
}
function unbornRepo() {
  const root = mkdtempSync(join(tmpdir(), 'red-partial-hash-unborn-'));
  writeConfig(root);
  git(root, ['init', '-b', 'main']); // zero commits: HEAD is unborn
  return root;
}
function noMainRepo() {
  const root = mkdtempSync(join(tmpdir(), 'red-partial-hash-nomain-'));
  writeConfig(root);
  git(root, ['init', '-b', 'trunk']);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base on trunk']);
  return root; // HEAD exists; `main` and `origin/main` do not
}
function danglingHeadRepo() {
  const root = mkdtempSync(join(tmpdir(), 'red-partial-hash-dangling-'));
  writeConfig(root);
  writeFileSync(join(root, 'README.md'), '# dangling\n');
  git(root, ['init', '-b', 'story/B-redhash']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base']);
  // Loose branch ref rewritten to a sha absent from the object db: `git rev-parse HEAD`
  // resolves, `git ls-tree HEAD` fails -> materialHash cannot be derived.
  writeFileSync(join(root, '.git', 'refs', 'heads', 'story', 'B-redhash'), `${FAKE_HEAD}\n`);
  assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), FAKE_HEAD);
  return root;
}
const observations = [];
function observe(site, text) { observations.push(`${site}: ${text}`); console.log(`OBSERVED ${site}: ${text}`); }
const failures = [];
function expect(label, fn) {
  try { fn(); console.log(`GREEN ${label}`); }
  catch (err) { failures.push(`${label}\n    ${String(err.message).split('\n').join('\n    ')}`); console.log(`RED   ${label}\n    ${err.message}`); }
}

const STORY_ID = 'B-redhash';
const unborn = unbornRepo();
const nomain = noMainRepo();
try {
  // C1 reader contract
  const snap = freshness.captureEvidenceHashSnapshot({ gitCwd: unborn, metadataRoot: unborn, ref: 'HEAD' });
  observe('C1 captureEvidenceHashSnapshot(unborn)', `returned (no throw); headHash=${snap.headHash ?? '<absent>'} materialHash=${snap.materialHash ?? '<absent>'} storyFilesHash=${snap.storyFilesHash ?? '<absent>'}`);
  assert.equal(snap.headHash, undefined); assert.equal(snap.materialHash, undefined); assert.equal(snap.storyFilesHash, undefined);
  const tried = freshness.tryCaptureEvidenceHashSnapshot({ gitCwd: unborn, metadataRoot: unborn, ref: 'HEAD' });
  observe('C1 tryCaptureEvidenceHashSnapshot(unborn)', `${tried === undefined ? 'undefined' : 'RETURNED a snapshot'} (thrown-vs-returned is the only distinction it offers)`);

  // C2 checkEvidenceFreshnessForGit with unreadable HEAD
  const fr = freshness.checkEvidenceFreshnessForGit(unborn, FAKE_HEAD, FAKE_MATERIAL, unborn, FAKE_STORY_FILES);
  observe('C2 checkEvidenceFreshnessForGit(unborn, evidence bound to fake digests)', `fresh=${fr.fresh} reason=${JSON.stringify(fr.reason)}`);
  expect('C2 evidence bound to digests that cannot be re-read must NOT be reported fresh', () => {
    assert.equal(fr.fresh, false, `fresh=true with reason ${JSON.stringify(fr.reason)}: an unreadable HEAD is treated as a passing binding`);
  });

  // C3 done-oracle row 1b on the unborn repo
  resetConfigCache();
  const store = new StoryStore(unborn);
  writeTestStory(store, STORY_ID);
  const rows = buildDoneChecklist(STORY_ID, store, unborn, { auditWriter: null });
  const fresh = rows.find((r) => r.id === 'evidence-freshness');
  observe('C3 buildDoneChecklist(unborn).evidence-freshness', fresh ? `status=${fresh.status} blocking=${fresh.blocking} detail=${JSON.stringify(fresh.detail)}` : 'row absent');
  expect('C3 done-oracle evidence-freshness row must fail closed when HEAD/materialHash cannot be read', () => {
    assert.ok(fresh, 'evidence-freshness row missing');
    assert.equal(fresh.status, 'fail', `evidence-freshness passed on an unborn repo: ${JSON.stringify(fresh.detail)}`);
  });

  // C4 phase-gates runDoneOracleGate must disclose the unreadable digest
  let gateText = null;
  try { gateText = runDoneOracleGate(STORY_ID, store, unborn, { stop() {} }, unborn); observe('C4 runDoneOracleGate(unborn)', 'RETURNED (did not throw)'); }
  catch (err) { gateText = String(err.message); observe('C4 runDoneOracleGate(unborn)', `threw; message mentions headHash/materialHash unreadable: ${/(headHash|materialHash|material hash|git HEAD)[^\n]*(unavailable|unreadable|could not|cannot|missing)/i.test(gateText)}`); }
  expect('C4 runDoneOracleGate must disclose that the current digest binding could not be read', () => {
    assert.ok(/(headHash|materialHash|material hash|git HEAD)[^\n]*(unavailable|unreadable|could not|cannot|missing)/i.test(gateText ?? ''), `no row discloses the unreadable digest. Rendered gate text:\n${gateText}`);
  });

  // C5 lifecycle-readiness target=DONE
  const report = buildStoryReadinessReport({ storyId: STORY_ID, target: 'DONE', store, root: unborn, gitCwd: unborn });
  const hashRows = report.readiness.filter((r) => ['head_hash_unavailable', 'material_hash_unavailable', 'story_files_hash_unavailable'].includes(r.code));
  observe('C5 buildStoryReadinessReport(target=DONE, unborn)', `headHash=${report.headHash} materialHash=${report.materialHash} storyFilesHash=${report.storyFilesHash}; hash rows: ${hashRows.map((r) => `${r.code}[status=${r.status} blocking=${r.blocking}]`).join(', ') || '<none>'}`);
  expect('C5 readiness for DONE must treat an unreadable head/material digest as BLOCKING, not advisory', () => {
    const head = hashRows.find((r) => r.code === 'head_hash_unavailable');
    const material = hashRows.find((r) => r.code === 'material_hash_unavailable');
    assert.ok(head && material, 'expected head_hash_unavailable and material_hash_unavailable rows');
    assert.equal(head.blocking, true, `head_hash_unavailable is blocking=${head.blocking} for target DONE`);
    assert.equal(material.blocking, true, `material_hash_unavailable is blocking=${material.blocking} for target DONE`);
  });

  // C6 legacy partial snapshot: current no-main capture is complete and uses
  // the explicit empty Story-files digest. A historical completed snapshot may
  // still predate that field and must be disclosed, without blocking because
  // its materialHash remains the strict fallback.
  resetConfigCache();
  const snap2 = freshness.captureEvidenceHashSnapshot({ gitCwd: nomain, metadataRoot: nomain, ref: 'HEAD' });
  observe('C6 captureEvidenceHashSnapshot(no-main)', `headHash=${snap2.headHash ? 'present' : '<absent>'} materialHash=${snap2.materialHash ? 'present' : '<absent>'} storyFilesHash=${snap2.storyFilesHash ?? '<absent>'}`);
  assert.equal(snap2.storyFilesHash, freshness.EMPTY_STORY_FILES_HASH, 'current no-main capture must use the explicit empty Story-files digest');
  const store2 = new StoryStore(nomain);
  writeTestStory(store2, STORY_ID);
  const doneStory = store2.readStory(STORY_ID);
  store2.writeStory(STORY_ID, { ...doneStory, phase: 'DONE', endedAt: NOW });
  store2.writeTestEvidence(STORY_ID, {
    command: 'proof-or-stop validate', output: JSON.stringify({ allPassed: true }), result: 'PASS', timestamp: NOW,
    headHash: snap2.headHash, materialHash: snap2.materialHash, storyFilesHash: FAKE_STORY_FILES,
  });
  const rows2 = buildDoneChecklist(STORY_ID, store2, nomain, {
    auditWriter: null,
    completedSnapshot: { materialHash: snap2.materialHash, storyFilesHash: null },
  });
  const disclosed = rows2.filter((r) => /storyFilesHash|story files hash|story-files hash/i.test(`${r.detail ?? ''} ${r.hint ?? ''}`));
  observe('C6 buildDoneChecklist(legacy partial completed snapshot)', `rows mentioning storyFilesHash: ${disclosed.length}; snapshot-row=${JSON.stringify(rows2.find((r) => r.id === 'evidence-hash-snapshot')?.detail)}`);
  expect('C6 a snapshot with materialHash but no storyFilesHash must be disclosed by at least one DONE row', () => {
    assert.ok(disclosed.length > 0, 'no DONE row discloses that the legacy completed snapshot has no storyFilesHash');
    const snapshotRow = rows2.find((r) => r.id === 'evidence-hash-snapshot');
    assert.equal(snapshotRow?.status, 'warn');
    assert.equal(snapshotRow?.blocking, false);
    assert.equal(
      snapshotRow?.detail,
      'Historical DONE projection: the completed snapshot did not bind storyFilesHash; DONE consumers fall back to strict materialHash',
    );
    assert.equal(snapshotRow?.hint, 'the historical snapshot predates storyFilesHash binding; retain strict materialHash interpretation');
    assert.doesNotMatch(snapshotRow?.detail ?? '', /could not be derived from the current git state|no main|merge-base/);
  });

  // C7 checkEvidenceFreshnessForGit with readable HEAD but underivable materialHash (B-83aa:F-001)
  const dangling = danglingHeadRepo();
  try {
    const fr7 = freshness.checkEvidenceFreshnessForGit(dangling, FAKE_HEAD, FAKE_MATERIAL, dangling);
    observe('C7 checkEvidenceFreshnessForGit(dangling HEAD, evidence bound to materialHash)', `fresh=${fr7.fresh} currentHead=${fr7.currentHead ?? '<absent>'} currentMaterialHash=${fr7.currentMaterialHash ?? '<absent>'} reason=${JSON.stringify(fr7.reason)}`);
    expect('C7 evidence bound to a materialHash that cannot be re-derived must fail closed naming materialHash, not fall through to head comparison', () => {
      assert.equal(fr7.fresh, false, `fresh=true with reason ${JSON.stringify(fr7.reason)}: an underivable materialHash fell through to the head comparison`);
      assert.match(fr7.reason, /materialHash/, `reason does not name materialHash: ${fr7.reason}`);
      assert.equal(fr7.currentMaterialHash, undefined);
      assert.notEqual(fr7.reason, 'evidence corresponds to current HEAD');
      assert.doesNotMatch(fr7.reason, /metadata-only changes/);
    });
  } finally {
    rmSync(dangling, { recursive: true, force: true });
  }
} finally {
  rmSync(unborn, { recursive: true, force: true });
  rmSync(nomain, { recursive: true, force: true });
}

console.log('\n# Observations');
for (const line of observations) console.log(`- ${line}`);
if (failures.length > 0) {
  console.error(`\nRED red-partial-hash-snapshot-binding: ${failures.length} desired propert${failures.length === 1 ? 'y' : 'ies'} not met (pre-fix defect present):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('\nGREEN red-partial-hash-snapshot-binding: every lifecycle-gate consumer fails closed or discloses a partial hash snapshot');
