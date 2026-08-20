import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const approval = await import(join(repoRoot, 'packages/main/dist/core/release-push-approval.js'));

const created = approval.createReleasePushApproval({
  root: repoRoot,
  sha: 'abc123',
  remote: 'origin',
  ttlSeconds: 30,
  approvedBy: 'migration-test',
  now: new Date('2026-01-01T00:00:00.000Z'),
});
assert.equal(created.schema, 'proof-or-stop.remote-push-approval.v1');
assert.equal(created.branch, 'refs/heads/main');
assert.equal(created.expiresAt, '2026-01-01T00:00:30.000Z');
assert.equal(approval.LEGACY_RELEASE_PUSH_APPROVAL_SCHEMA, 'lattice.remote-push-approval.v1');
assert.equal(approval.releasePushApprovalPath(repoRoot), join(repoRoot, '.proof-or-stop/tmp/remote-push-approval.json'));

const source = readFileSync(join(repoRoot, 'packages/main/src/core/release-push-approval.ts'), 'utf8');
const hook = readFileSync(join(repoRoot, '.githooks/pre-push'), 'utf8');
for (const schema of [approval.RELEASE_PUSH_APPROVAL_SCHEMA, approval.LEGACY_RELEASE_PUSH_APPROVAL_SCHEMA]) {
  assert.ok(source.includes(schema) || hook.includes(schema), `${schema} remains readable`);
}
assert.match(hook, /acceptedApprovalSchemas/);

function runHook(root, input) {
  try {
    return { code: 0, output: execFileSync('bash', [join(root, '.githooks/pre-push')], {
      cwd: root,
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }) };
  } catch (error) {
    return {
      code: error.status ?? 1,
      output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
    };
  }
}

const hookRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-release-hook-'));
try {
  execFileSync('git', ['init', '-q'], { cwd: hookRoot });
  const hookSource = readFileSync(join(repoRoot, '.githooks/pre-push'), 'utf8');
  mkdirSync(join(hookRoot, '.githooks'), { recursive: true });
  writeFileSync(join(hookRoot, '.githooks/pre-push'), hookSource);
  const approvalDir = join(hookRoot, '.proof-or-stop/tmp');
  const pushLine = '0000000000000000000000000000000000000000 abc123 refs/heads/main 0000000000000000000000000000000000000000\n';
  for (const schema of [approval.RELEASE_PUSH_APPROVAL_SCHEMA, approval.LEGACY_RELEASE_PUSH_APPROVAL_SCHEMA]) {
    const valid = approval.createReleasePushApproval({
      root: hookRoot,
      sha: 'abc123',
      remote: 'origin',
      ttlSeconds: 60,
      approvedBy: 'migration-hook-test',
      now: new Date(Date.now() - 1000),
    });
    valid.schema = schema;
    mkdirSync(approvalDir, { recursive: true });
    writeFileSync(join(approvalDir, 'remote-push-approval.json'), `${JSON.stringify(valid)}\n`);
    const accepted = runHook(hookRoot, pushLine);
    assert.equal(accepted.code, 0, `${schema} should be accepted by the hook: ${accepted.output}`);
    assert.equal(existsSync(join(approvalDir, 'remote-push-approval.json')), false, `${schema} should be consumed once`);

    const secondConsume = runHook(hookRoot, pushLine);
    assert.notEqual(secondConsume.code, 0, `${schema} must reject a second consume`);
    assert.match(secondConsume.output, /missing one-shot approval file/);
  }

  const invalid = approval.createReleasePushApproval({ root: hookRoot, sha: 'abc123', now: new Date(Date.now() - 1000) });
  invalid.schema = 'unknown.remote-push-approval.v1';
  mkdirSync(approvalDir, { recursive: true });
  writeFileSync(join(approvalDir, 'remote-push-approval.json'), `${JSON.stringify(invalid)}\n`);
  const invalidResult = runHook(hookRoot, pushLine);
  assert.notEqual(invalidResult.code, 0, 'invalid schema must be rejected');
  assert.match(invalidResult.output, /approval schema is missing or invalid/);

  const stale = approval.createReleasePushApproval({
    root: hookRoot,
    sha: 'abc123',
    ttlSeconds: 1,
    now: new Date(Date.now() - 10_000),
  });
  mkdirSync(approvalDir, { recursive: true });
  writeFileSync(join(approvalDir, 'remote-push-approval.json'), `${JSON.stringify(stale)}\n`);
  const staleResult = runHook(hookRoot, pushLine);
  assert.notEqual(staleResult.code, 0, 'expired approval must be rejected');
  assert.match(staleResult.output, /approval expired/);
} finally {
  rmSync(hookRoot, { recursive: true, force: true });
}

console.log('release-push-approval migration test passed');
