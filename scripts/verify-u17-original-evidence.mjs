import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
const repo = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
const root = join(repo, 'docs/lab-evidence/u17-original-target-raw');
const read = name => JSON.parse(readFileSync(join(root, name), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = read('manifest.json');
for (const [name, expected] of Object.entries(manifest.files)) {
  assert.ok(!name.includes('/') && !name.includes('..'));
  const bytes = readFileSync(join(root, name));
  assert.equal(bytes.length, expected.bytes);
  assert.equal(digest(bytes), expected.sha256, name);
  if (expected.uncompressedSha256) assert.equal(digest(gunzipSync(bytes)), expected.uncompressedSha256, name);
}
for (const [name, expected] of Object.entries(manifest.harness)) {
  assert.ok(name.startsWith('scripts/lab/u17-original/') && !name.includes('..'));
  const bytes = readFileSync(join(repo, name));
  assert.equal(digest(bytes), expected.sha256, name);
}
const terminal = read('terminal.json');
assert.equal(terminal.terminal.code, 0);
assert.equal(terminal.timedOut, false);
assert.deepEqual(terminal.before, terminal.after);
assert.equal(terminal.before.head, manifest.measuredCommit);
const results = read('target-results.json');
assert.deepEqual(results.rounds.map(row => row.mode), ['on', 'off', 'off', 'on']);
for (const row of results.rounds) {
  const raw = JSON.parse(gunzipSync(readFileSync(join(root, `attempts-${row.index}.json.gz`))));
  assert.deepEqual(raw.counts, row.counts);
  assert.equal(raw.attempts.filter(attempt => attempt.kind === 'git').length, row.counts.gitTotal);
  assert.equal(raw.attempts.filter(attempt => attempt.kind === 'node').length, row.counts.nodeLaunches);
  assert.equal(raw.attempts.filter(attempt => attempt.helper?.type === 'fs-only-lock-heartbeat').length, 9);
  assert.equal(raw.attempts.filter(attempt => attempt.helper?.type?.startsWith('readonly-process-')).length, 36);
  assert.ok(raw.attempts.every(attempt => attempt.completed));
  assert.equal(row.attemptSummary.requiredJsReceipts, 0);
  assert.deepEqual(raw.childMetrics, []);
  assert.equal(row.assertions, 'original-target-body-passed');
  assert.equal(row.emittedCount, 6);
  assert.equal(row.hostVerdicts, 6);
  assert.equal(row.verdictFiles, 6);
  assert.deepEqual(row.runIds, results.rounds[0].runIds);
  assert.equal(row.baselineHead, results.rounds[0].baselineHead);
  assert.deepEqual(row.baselineModules, results.rounds[0].baselineModules);
  assert.ok(row.durationMs > 0 && Number.isFinite(row.durationMs));
}
const mean = (mode, value) => results.rounds.filter(row => row.mode === mode).reduce((sum, row) => sum + value(row), 0) / 2;
const on = mean('on', row => row.durationMs), off = mean('off', row => row.durationMs);
console.log('PASS recorded U17 original-target evidence integrity', JSON.stringify({onMeanMs:on, offMeanMs:off, wallReductionPercent:100*(off-on)/off}));
