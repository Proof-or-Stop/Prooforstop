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
  const entry = commands.find(command => command.args.includes('packages/main/dist/tasks/provider-process-registry-smoke.js'));
  assert.ok(entry, 'the original provider registry contract remains in the canonical suite');
  const trace = join(scratch, 'trace.mjs');
  const log = join(scratch, 'nested.jsonl');
  writeFileSync(trace, `
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
const registered = new Set(${JSON.stringify(registered)});
for (const name of ['execFileSync', 'spawnSync', 'spawn']) {
  const original = cp[name];
  cp[name] = function(command, args, ...rest) {
    if (Array.isArray(args) && args[0] && registered.has(resolve(args[0])) && !args.includes('--child')) {
      appendFileSync(${JSON.stringify(log)}, JSON.stringify({command,args})+'\\n');
      throw new Error('Nested canonical command observed before launch');
    }
    return original.call(this,command,args,...rest);
  };
}
syncBuiltinESMExports();
`);
  const child = spawnSync(process.execPath, entry.args, { cwd: root, timeout: 120000,
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${trace}` }, encoding: 'utf8' });
  const nested = existsSync(log) ? readFileSync(log, 'utf8') : '';
  assert.equal(nested, '', 'U18: canonical provider validation must not launch another registered command');
  assert.equal(child.status, 0, `${child.error ?? ''}\n${child.stdout}\n${child.stderr}`);
  console.log('PASS U18 flat-provider-validation');
} finally { rmSync(scratch, { recursive: true, force: true }); }
