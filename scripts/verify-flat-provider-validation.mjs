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
  const roots = process.argv.includes('--usage-only') ? ['host-run-usage-smoke.js'] : ['provider-process-registry-smoke.js', 'managed-host-run-smoke.js',
    'red-evidence-target-binding-smoke.js', 'red-evidence-envelope-smoke.js',
    'red-w2b-wiring-contract.mjs'];
  const trace = join(scratch, 'trace.mjs');
  const log = join(scratch, 'nested.jsonl');
  writeFileSync(trace, `
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve, basename, dirname, join } from 'node:path';
const registered = new Set(${JSON.stringify(registered)});
// These exact modes run fixture workers, not the command's suite entrypoint.
const fixtureModes = {
  'provider-process-registry-smoke.js': ['--child'],
  'managed-host-run-smoke.js': ['--granted-no-identity-worker', '--timer-error-worker',
    '--fifo-worker', '--post-claim-intake-worker', '--fifo-writer', '--terminal-lock-holder'],
};
for (const name of ['execFileSync', 'execFile', 'spawnSync', 'spawn']) {
  const original = cp[name];
  cp[name] = function(command, args, ...rest) {
    const entryIndex = Array.isArray(args) ? args.findIndex(arg => typeof arg === 'string' && registered.has(resolve(arg))) : -1;
    const entry = entryIndex >= 0 ? args[entryIndex] : undefined;
    // W2B intentionally executes two registered contracts against one removed
    // registration. Require the exact parent, loader shape and mutated bytes.
    let mutationProbe = false;
    if (entry && basename(process.argv[1] ?? '') === 'red-w2b-wiring-contract.mjs'
      && ['lifecycle-registry-contract.js', 'command-ownership-contract.js'].includes(basename(entry))
      && entryIndex === 2 && args.length === 3 && args[0] === '--import'
      && basename(args[1]) === 'register-loader.mjs') {
      try {
        const patch = rest[0]?.env?.RED_W2B_PATCHED_POLICY;
        const originalPolicy = readFileSync(${JSON.stringify(join(root, 'packages/main/dist/core/command-policy.js'))}, 'utf8');
        const expected = originalPolicy.replace(/^[^\\n]*\\bred_evidence_binding_set:[^\\n]*\\n/m, '');
        mutationProbe = expected !== originalPolicy && patch === join(dirname(args[1]), 'command-policy.patched.js')
          && readFileSync(patch, 'utf8') === expected
          && readFileSync(args[1], 'utf8') === "import { register } from 'node:module';\\nregister('./patch-loader.mjs', import.meta.url);\\n"
          && readFileSync(join(dirname(args[1]), 'patch-loader.mjs'), 'utf8').includes('source: PATCHED, shortCircuit: true');
      } catch { mutationProbe = false; }
    }
    if (entry && !mutationProbe && !fixtureModes[basename(entry)]?.includes(args[entryIndex + 1])) {
      appendFileSync(${JSON.stringify(log)}, JSON.stringify({command,args})+'\\n');
      throw new Error('Nested canonical command observed before launch');
    }
    return original.call(this,command,args,...rest);
  };
}
syncBuiltinESMExports();
`);
  // Prove that ordinary Node preloads cannot hide a nested registered suite.
  const noop = join(scratch, 'noop.mjs');
  writeFileSync(noop, '');
  const probe = join(scratch, 'ordinary-preload-probe.mjs');
  writeFileSync(probe, `import { spawnSync } from 'node:child_process';
    spawnSync(process.execPath, ['--import', ${JSON.stringify(noop)},
      ${JSON.stringify(join(root, 'packages/main/dist/tasks/lifecycle-registry-contract.js'))}]);`);
  const rejected = spawnSync(process.execPath, ['--import', trace, probe], { cwd: root, encoding: 'utf8' });
  assert.notEqual(rejected.status, 0, 'ordinary --import must not bypass nested validation detection');
  assert.match(rejected.stderr, /Nested canonical command observed before launch/);
  assert.ok(existsSync(log), 'preload probe must record the intercepted launch');
  writeFileSync(log, '');
  for (const filename of roots) {
  const entry = commands.find(command => command.args.some(arg => arg.endsWith('/' + filename)));
  assert.ok(entry, `${filename} contract remains in the canonical suite`);
  const child = spawnSync(process.execPath, entry.args, { cwd: root, timeout: 180000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${trace}` }, encoding: 'utf8' });
  const nested = existsSync(log) ? readFileSync(log, 'utf8') : '';
  assert.equal(nested, '', 'U18: canonical validation must not launch another registered command');
  assert.equal(child.status, 0, `${child.error ?? ''}\n${child.stdout}\n${child.stderr}`);
  }
  for (const filename of ['provider-process-registry-smoke.js', 'managed-host-run-smoke.js',
    'host-run-usage-smoke.js', 'dispatch-run-smoke.js', 'provider-claude-smoke.js',
    'managed-host-run-e2e-smoke.js', 'managed-host-run-process-smoke.js',
    'lifecycle-registry-contract.js', 'command-ownership-contract.js',
    'managed-host-run-command-smoke.js']) {
    assert.ok(registered.includes(resolve(root, 'packages/main/dist/tasks', filename)),
      `canonical coverage union must retain ${filename}`);
  }
  console.log('PASS U18 flat-provider-validation');
} finally { rmSync(scratch, { recursive: true, force: true }); }
