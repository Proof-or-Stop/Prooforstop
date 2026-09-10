// Test-only fixture launcher. It never changes production host observations.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, openSync, closeSync, readFileSync, writeFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const self = fileURLToPath(import.meta.url);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export function inspectFixtureProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const text = execFileSync('ps', ['-p', String(pid), '-o', 'pid=,pgid=,lstart=,command='], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const match = text.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match ? { pid: Number(match[1]), pgid: Number(match[2]), fingerprint: match[3] } : null;
  } catch { return null; }
}
function sameIdentity(a, b) { return !!a && !!b && a.pid === b.pid && a.pgid === b.pgid && a.fingerprint === b.fingerprint; }
function groupMembers(pgid) {
  try {
    const text = execFileSync('ps', ['-Ao', 'pid=,pgid='], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] });
    return text.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)).filter(([pid, group]) => pid > 1 && group === pgid).map(([pid]) => pid);
  } catch { return null; }
}
async function waitOwnedExit(owner) {
  for (let n = 0; n < 50; n++) {
    const members = groupMembers(owner.pgid);
    if (inspectFixtureProcess(owner.pid) === null && members !== null && members.length === 0) return true;
    await pause(100);
  }
  return false;
}
export async function terminateOwnedFixture(owner) {
  if (!sameIdentity(owner, inspectFixtureProcess(owner.pid))) return false;
  process.kill(-owner.pgid, 'SIGTERM');
  for (let n = 0; n < 50 && sameIdentity(owner, inspectFixtureProcess(owner.pid)); n++) await pause(100);
  if (sameIdentity(owner, inspectFixtureProcess(owner.pid))) process.kill(-owner.pgid, 'SIGKILL');
  return waitOwnedExit(owner);
}
export async function runProviderNeutralFixture(entry, args, env, options = {}) {
  const timeoutMs = options.timeoutMs ?? 1_200_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_200_000) throw new Error('invalid fixture timeout');
  // On Windows the production observer explicitly has no process ancestry.
  if (process.platform === 'win32') return spawnSync(process.execPath, [entry, ...args], { env, stdio: 'inherit' });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'proof-or-stop-neutral-fixture-')));
  let interrupted = null;
  const onTerm = () => { interrupted = 'SIGTERM'; };
  const onInt = () => { interrupted = 'SIGINT'; };
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
  let owner = null; let completed = false;
  try {
    const bootstrap = spawnSync(process.execPath, [self, '--bootstrap', root, entry, ...args], { env, stdio: 'inherit', timeout: 10000 });
    if (bootstrap.status !== 0) throw new Error('provider-neutral fixture bootstrap failed');
    owner = JSON.parse(readFileSync(join(root, 'owner.json'), 'utf8'));
    if (owner.pid !== owner.pgid || !owner.fingerprint.includes(root)) throw new Error('provider-neutral fixture owner identity invalid');
    if (!sameIdentity(owner, inspectFixtureProcess(owner.pid))) throw new Error('provider-neutral fixture owner changed before grant');
    writeFileSync(join(root, 'launch-granted'), '', { flag: 'wx', mode: 0o600 });
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(join(root, 'result.json')) && !interrupted && Date.now() < deadline) await pause(100);
    if (interrupted || !existsSync(join(root, 'result.json'))) throw new Error(`provider-neutral fixture interrupted or deadline exceeded: ${interrupted ?? 'timeout'}`);
    const result = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'));
    if (result.pid !== owner.pid || result.parentPid !== 1) throw new Error('provider-neutral fixture result identity invalid');
    process.stdout.write(readFileSync(join(root, 'output.log'), 'utf8'));
    if (!await waitOwnedExit(owner)) throw new Error('provider-neutral fixture completed but worker/group exit could not be proved');
    completed = true;
    if (result.status === 0) rmSync(root, { recursive: true, force: true });
    else console.error(`provider-neutral fixture retained: ${root}`);
    return { status: result.status, signal: result.signal };
  } finally {
    process.removeListener('SIGTERM', onTerm); process.removeListener('SIGINT', onInt);
    if (!completed && owner) { await terminateOwnedFixture(owner); console.error(`provider-neutral fixture interrupted; evidence retained: ${root}`); }
  }
}
const [mode, root, entry, ...args] = process.argv.slice(2);
if (process.argv[1] && realpathSync(process.argv[1]) === self && mode === '--bootstrap') {
  const fd = openSync(join(root, 'output.log'), 'wx', 0o600);
  const child = spawn(process.execPath, [self, '--worker', root, entry, ...args], { detached: true, env: process.env, stdio: ['ignore', fd, fd] });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  // The unique root remains in the actual worker command and is part of its identity.
  // On macOS the child can emit `spawn` before setsid has made the detached
  // process-group identity observable through ps. Authenticate the settled
  // identity instead of treating that short publication window as failure.
  let owner = null;
  for (let n = 0; n < 50; n++) {
    owner = inspectFixtureProcess(child.pid);
    if (owner && owner.pgid === owner.pid) break;
    await pause(20);
  }
  if (!owner || owner.pgid !== owner.pid) throw new Error('provider-neutral fixture could not authenticate worker');
  writeFileSync(join(root, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  closeSync(fd); child.unref();
} else if (process.argv[1] && realpathSync(process.argv[1]) === self && mode === '--worker') {
  const deadline = Date.now() + 10000;
  while ((process.ppid !== 1 || !existsSync(join(root, 'launch-granted'))) && Date.now() < deadline) await pause(10);
  if (process.ppid !== 1 || !existsSync(join(root, 'launch-granted'))) throw new Error('provider-neutral fixture was not adopted; no suite launched');
  const result = spawnSync(process.execPath, [entry, ...args], { env: process.env, stdio: 'inherit', timeout: 1_190_000 });
  writeFileSync(join(root, 'result.json'), JSON.stringify({ pid: process.pid, parentPid: process.ppid, status: result.status, signal: result.signal }), { flag: 'wx', mode: 0o600 });
}
