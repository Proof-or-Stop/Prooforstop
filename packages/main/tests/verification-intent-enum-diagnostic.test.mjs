import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
execFileSync(process.execPath, ['scripts/ensure-dist.mjs'], {
  cwd: root, stdio: 'inherit', timeout: 180_000,
});
const { verificationIntentTypeSchema } = await import(pathToFileURL(
  join(root, 'packages/main/dist/cli/command-schemas.js'),
));
for (const value of ['logic', 'cli', 'browser', 'manual', 'docs']) {
  assert.equal(verificationIntentTypeSchema.parse(value), value);
}
assert.equal(verificationIntentTypeSchema.parse('cli_blackbox'), 'cli');
assert.equal(verificationIntentTypeSchema.parse('browser_blackbox'), 'browser');

const scratch = mkdtempSync(join(tmpdir(), 'verification-enum-diagnostic-'));
const env = { ...process.env };
delete env.PROOF_OR_STOP_PROJECT_ROOT;
try {
  for (const value of ['integration_test', 'logic_test', 'browser_test', 'docs_check', 'manual_transcript', 'waiver']) {
    const result = spawnSync(process.execPath, [
      join(root, 'packages/main/dist/cli.js'), 'checklist_update',
      JSON.stringify({ storyId: 'B-smoke', itemId: 'CHK-001',
        verificationIntent: { happy: [{ desc: 'bad enum', type: value, priority: 'must' }] } }),
    ], { cwd: scratch, env, encoding: 'utf8', timeout: 15_000 });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, 'invalid nested verificationIntent enum should fail');
    assert.match(result.stderr, /Argument validation failed/);
    assert.match(result.stderr, /verificationIntent\.happy\.0\.type/);
    assert.ok(result.stderr.includes(value), `VERIFICATION_ENUM_INVALID_VALUE_VISIBLE: ${value}\n${result.stderr}`);
    assert.match(result.stderr, /logic[\s\S]*cli[\s\S]*browser[\s\S]*manual[\s\S]*docs/);
    assert.equal(existsSync(join(scratch, '.proof-or-stop')), false, 'schema failure must precede metadata mutation');
  }
  for (const input of [undefined, null, 42, {}, [], true]) {
    assert.equal(verificationIntentTypeSchema.safeParse(input).success, false, 'non-string verification types stay invalid');
  }
  const escaped = verificationIntentTypeSchema.safeParse('bad\n"type');
  assert.equal(escaped.success, false);
  assert.ok(escaped.error.issues[0].message.includes('bad\\n\\"type'), 'invalid string is JSON-escaped');
  assert.ok(!escaped.error.issues[0].message.includes('\n'), 'input must not inject diagnostic lines');
  const oversized = verificationIntentTypeSchema.safeParse('x'.repeat(10_000));
  assert.equal(oversized.success, false);
  assert.ok(oversized.error.issues[0].message.length < 512, 'invalid string diagnostic stays bounded');
  console.log('VERIFICATION_ENUM_DIAGNOSTIC PASS: actual CLI rejection, received value, legal types, aliases, bounded output, and no metadata mutation');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
