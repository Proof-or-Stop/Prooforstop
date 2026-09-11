import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { managedHostRunDirectory } from '../packages/main/dist/core/managed-host-run.js';

const repository = fileURLToPath(new URL('..', import.meta.url));
for (const mode of ['early-exit', 'timeout']) {
  const root = mkdtempSync(join(tmpdir(), 'managed-supervisor-readiness-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const providerMarker = join(root, 'provider-started');
    const supervisorMarker = join(root, 'supervisor-pid');
    writeFileSync(join(bin, 'codex'), `#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(providerMarker)}, 'unexpected provider launch');
`, {mode:0o700});
    const preload = join(root, 'readiness-fault.mjs');
    writeFileSync(preload, `import { writeFileSync } from 'node:fs';
if (process.argv[1]?.endsWith('/cli/managed-host-run-supervisor.js')) {
  writeFileSync(${JSON.stringify(supervisorMarker)}, String(process.pid));
  ${mode === 'early-exit' ? 'process.exit(23);' : 'setInterval(() => {}, 1000); await new Promise(() => {});'}
}
`);
    const child = spawnSync(process.execPath, [join(repository, 'packages/main/dist/cli.js'),
      '--root', root, 'host_run', JSON.stringify({host:'codex', agentType:'supervisor-readiness-witness',
        phase:'DEV', prompt:'A failed readiness probe must prevent worker launch.', detach:true, json:true,
        deadlineMs:30000})], {cwd:root, timeout:15000, encoding:'utf8',
      env:{PATH:`${bin}:${process.env.PATH}`, NODE_OPTIONS:`--import=${preload}`, PROOF_OR_STOP_USAGE_LEDGER:'0'}});
    assert.equal(child.status, 0, `submit must return its durable failure: ${child.stdout}\n${child.stderr}`);
    const run = JSON.parse(child.stdout).run;
    assert.equal(run.state, 'failed');
    assert.match(run.terminal.reason, /supervisor.*(?:readiness timeout|exited before readiness)/);
    assert.ok(!existsSync(providerMarker), 'failed supervisor readiness must launch zero providers');
    assert.ok(!existsSync(join(managedHostRunDirectory(root, run.runId), 'claim.json')),
      'failed supervisor readiness must launch zero workers');
    assert.ok(existsSync(supervisorMarker), 'the real detached supervisor must reach the fault');
    const pid = Number(readFileSync(supervisorMarker, 'utf8'));
    assert.throws(() => process.kill(pid, 0), /ESRCH/, 'failed readiness child must be reaped');
  } finally { rmSync(root, {recursive:true, force:true}); }
}
console.log('PASS U02 supervisor early-exit/timeout refuse before worker launch and reap readiness child');
