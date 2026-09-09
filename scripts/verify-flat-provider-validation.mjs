import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'flat-provider-validation-'));
try {
  const commands = JSON.parse(readFileSync(join(root, 'proof-or-stop.config.json'))).validate.commands;
  const registered = commands.flatMap(command => command.args.filter(arg => /\.(?:mjs|js)$/.test(arg)).map(arg => resolve(root, arg)));
  const roots = ['provider-process-registry-smoke.js', 'managed-host-run-smoke.js'];
  const trace = join(scratch, 'trace.mjs');
  const log = join(scratch, 'nested.jsonl');
  writeFileSync(trace, `
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
const registered = new Set(${JSON.stringify(registered)});
// These exact modes run fixture workers, not the command's suite entrypoint.
const fixtureModes = {
  'provider-process-registry-smoke.js': ['--child'],
  'managed-host-run-smoke.js': ['--granted-no-identity-worker', '--timer-error-worker',
    '--fifo-worker', '--post-claim-intake-worker', '--fifo-writer', '--terminal-lock-holder'],
};
for (const name of ['execFileSync', 'spawnSync', 'spawn']) {
  const original = cp[name];
  cp[name] = function(command, args, ...rest) {
    if (Array.isArray(args) && args[0] && registered.has(resolve(args[0]))
      && !fixtureModes[basename(args[0])]?.includes(args[1])) {
      appendFileSync(${JSON.stringify(log)}, JSON.stringify({command,args})+'\\n');
      throw new Error('Nested canonical command observed before launch');
    }
    return original.call(this,command,args,...rest);
  };
}
syncBuiltinESMExports();
`);
  for (const filename of roots) {
  const entry = commands.find(command => command.args.includes(`packages/main/dist/tasks/${filename}`));
  assert.ok(entry, `${filename} contract remains in the canonical suite`);
  const child = spawnSync(process.execPath, entry.args, { cwd: root, timeout: 120000,
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${trace}` }, encoding: 'utf8' });
  const nested = existsSync(log) ? readFileSync(log, 'utf8') : '';
  assert.equal(nested, '', 'U18: canonical provider validation must not launch another registered command');
  assert.equal(child.status, 0, `${child.error ?? ''}\n${child.stdout}\n${child.stderr}`);
  }
  for (const filename of ['provider-process-registry-smoke.js', 'managed-host-run-smoke.js',
    'host-run-usage-smoke.js', 'dispatch-run-smoke.js', 'provider-claude-smoke.js',
    'managed-host-run-e2e-smoke.js', 'managed-host-run-process-smoke.js']) {
    assert.ok(registered.includes(resolve(root, 'packages/main/dist/tasks', filename)),
      `canonical coverage union must retain ${filename}`);
  }
  console.log('PASS U18 flat-provider-validation');
} finally { rmSync(scratch, { recursive: true, force: true }); }
