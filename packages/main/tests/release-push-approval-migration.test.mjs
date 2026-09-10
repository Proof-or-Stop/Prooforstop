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
assert.equal(approval.LEGACY_RELEASE_PUSH_APPROVAL_SCHEMA, undefined);
assert.equal(approval.releasePushApprovalPath(repoRoot), join(repoRoot, '.proof-or-stop/tmp/remote-push-approval.json'));

function runHook(root, input, remote = 'origin') {
  try {
    return { code: 0, output: execFileSync('bash', [join(root, '.githooks/pre-push'), remote], {
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
  const pushLine = 'refs/heads/main abc123 refs/heads/main 0000000000000000000000000000000000000000\n';
  for (const schema of [approval.RELEASE_PUSH_APPROVAL_SCHEMA]) {
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

  const approvalPath = join(approvalDir, 'remote-push-approval.json');
  function assertRejectedWithoutMutation(change, message, input = pushLine, remote = 'origin') {
    const candidate = { ...approval.createReleasePushApproval({
      root: hookRoot, sha: 'abc123', remote: 'origin', ttlSeconds: 60,
      now: new Date(Date.now() - 1000),
    }), ...change };
    const bytes = `${JSON.stringify(candidate)}\n`;
    writeFileSync(approvalPath, bytes);
    const result = runHook(hookRoot, input, remote);
    assert.notEqual(result.code, 0, `approval must reject: ${JSON.stringify(change)}`);
    assert.match(result.output, message);
    assert.equal(readFileSync(approvalPath, 'utf8'), bytes, 'rejection preserves approval bytes and does not consume authority');
  }
  for (const schema of ['lattice.remote-push-approval.v1', 'proofbound.remote-push-approval.v1', 'unknown.remote-push-approval.v1']) {
    assertRejectedWithoutMutation({ schema }, /approval schema is missing or invalid/);
  }
  assertRejectedWithoutMutation({ sha: 'def456' }, /approval sha mismatch/);
  assertRejectedWithoutMutation({}, /approval remote mismatch/, pushLine, 'other');
  assertRejectedWithoutMutation({ branch: 'refs/heads/story' }, /only valid for refs\/heads\/main/);
  assertRejectedWithoutMutation({}, /refusing to push remote branch/, pushLine.replace('refs/heads/main 0000', 'refs/heads/story 0000'));
  assertRejectedWithoutMutation({ expiresAt: 'invalid' }, /expiresAt is missing or invalid/);

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
  assert.equal(readFileSync(approvalPath, 'utf8'), `${JSON.stringify(stale)}\n`, 'expired approval bytes remain unchanged');
} finally {
  rmSync(hookRoot, { recursive: true, force: true });
}

console.log('release-push-approval migration test passed');
