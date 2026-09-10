import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(process.argv[2] ?? process.cwd());
const directory = mkdtempSync(join(tmpdir(), 'u17-original-quorum-'));
const logfile = join(directory, 'prefix.log');
const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const before = head();
const fd = openSync(logfile, 'wx');
const started = performance.now();
const child = spawn(process.execPath, [
  '--import', fileURLToPath(new URL('./lab/u17-quorum-original-prefix-loader.mjs', import.meta.url)),
  join(repo, 'packages/main/dist/tasks/quorum-submit-smoke.js'),
], { cwd: repo, stdio: ['ignore', fd, fd], detached: process.platform !== 'win32' });
closeSync(fd);
console.log(`U17 original-target prefix only: ${logfile}`);
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  if (child.exitCode === null && child.signalCode === null && child.pid) {
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch (error) {
      if (error.code !== 'ESRCH') console.error(error);
    }
  }
}, 1_200_000);
const terminal = await new Promise(resolveTerminal => {
  child.once('error', error => resolveTerminal({ code: null, signal: null, error: error.message }));
  child.once('close', (code, signal) => resolveTerminal({ code, signal }));
});
clearTimeout(timer);
const output = readFileSync(logfile, 'utf8');
const result = { ...terminal, timedOut, headBefore: before, headAfter: head(), durationMs: performance.now() - started,
  targetReached: output.split(/\r?\n/).includes('U17_ORIGINAL_TARGET_PASS'), logfile };
writeFileSync(join(directory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
assert.equal(terminal.code, 0, `original quorum target must complete through the unchanged prerequisite checks\n${output.slice(-8000)}`);
assert.equal(timedOut, false);
assert.equal(result.headAfter, before, 'quorum acceptance must use one fixed repository HEAD');
assert.equal(result.targetReached, true, 'original quorum target completion marker is required');
console.log('PASS original expensive quorum target and every preceding check');
