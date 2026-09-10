import { SUPERVISED_PROVIDER_RUNTIME_POLICY } from '../core/runtime-fact-registry.js';
import { StringDecoder } from 'node:string_decoder';
/** Private synchronous-provider bridge. Provider children never inherit fd 3. */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { transferProviderProcessAdmissionToProvider, type ProviderProcessAdmission } from '../core/provider-process-admission.js';
import type { SupervisedProcessOptions, SupervisedProcessOutcome } from './supervised-process.js';

const request = JSON.parse(readFileSync(0, 'utf8')) as {
  nonce: string; binary: string; argv: string[]; options: SupervisedProcessOptions; admission: ProviderProcessAdmission;
};
const fingerprint = (): string => execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', timeout: 1000 }).trim();
const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8', timeout: 1000 }).trim());
const startFingerprint = fingerprint();
if (process.platform === 'win32' || pgid !== process.pid || !startFingerprint) throw new Error('provider bridge requires an observed isolated process group');
const identity = { pid: process.pid, pgid, startFingerprint, spawnedAt: new Date().toISOString(), processGroupIsolated: true };
try {
  if (!transferProviderProcessAdmissionToProvider(request.admission, identity)) throw new Error('provider bridge failed dual slot transfer');
} catch (error) {
  // No provider was launched. A partial transfer must not strand the other
  // reservation on the still-live caller; the parent also verifies group exit.
  writeFileSync(3, JSON.stringify({ nonce: request.nonce, pid: process.pid, outcome: {
    status: null, stdout: '', stderr: '', replacementSafe: true,
    error: { message: error instanceof Error ? error.message : String(error), code: 'EADMISSION' },
  } }));
  process.exit(0);
}

// The leader survives TERM so it can report; KILL ends the whole owned group.
process.on('SIGTERM', () => {});
const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
let stdout = '', stderr = '', bytes = 0, timedOut = false, overflow = false;
let timer: NodeJS.Timeout | undefined;
const outcome: SupervisedProcessOutcome = { status: null, stdout: '', stderr: '', replacementSafe: false };
const sameIdentity = (): boolean => { try { return fingerprint() === startFingerprint; } catch { return false; } };
const otherMembers = (): boolean => {
  const probe = spawnSync('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024 });
  if (probe.status !== 0 || probe.error || !probe.stdout.trim()) throw new Error('process inventory unavailable');
  const rows = probe.stdout.trim().split('\n');
  for (const row of rows) {
    const fields = row.trim().split(/\s+/); if (fields.length !== 2 || fields.some(v => !/^\d+$/.test(v))) throw new Error('unreadable process group inventory');
    if (Number(fields[1]) === pgid && Number(fields[0]) !== process.pid && Number(fields[0]) !== probe.pid) return true;
  }
  return false;
};
const terminate = (): void => {
  if (!sameIdentity()) return;
  process.kill(-pgid, 'SIGTERM');
  setTimeout(() => { if (sameIdentity()) { try { if (otherMembers()) process.kill(-pgid, 'SIGKILL'); } catch { /* Parent timeout retains unknown capacity. */ } } }, SUPERVISED_PROVIDER_RUNTIME_POLICY.termGraceMs).unref();
};
const child = spawn(request.binary, request.argv, { cwd: request.options.cwd, env: request.options.env, stdio: ['pipe', 'pipe', 'pipe'], detached: false });
const append = (kind: 'stdout' | 'stderr', chunk: Buffer): void => {
  bytes += chunk.length;
  if (bytes > SUPERVISED_PROVIDER_RUNTIME_POLICY.maxOutputBytes) { overflow = true; terminate(); return; }
  if (kind === 'stdout') stdout += stdoutDecoder.write(chunk); else stderr += stderrDecoder.write(chunk);
};
child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
child.stdin.on('error', () => {}); child.stdin.end(request.options.stdin ?? '');
child.on('error', (error: NodeJS.ErrnoException) => { outcome.error = { message: error.message, code: error.code } as NodeJS.ErrnoException; });
timer = setTimeout(() => { timedOut = true; terminate(); }, Math.max(1, request.options.timeoutMs));
child.on('close', async (code, signal) => {
  if (timer) clearTimeout(timer);
  outcome.timedOut = timedOut;
  outcome.status = code; outcome.signal = timedOut ? 'SIGTERM' : signal;
  outcome.stdout = stdout + stdoutDecoder.end(); outcome.stderr = stderr + stderrDecoder.end();
  if (overflow) outcome.error = { message: 'provider output exceeded limit', code: 'ENOBUFS' } as NodeJS.ErrnoException;
  try {
    // A normal leader exit is insufficient: clean its ordinary group descendants.
    if (otherMembers()) { terminate(); await new Promise(resolve => setTimeout(resolve, SUPERVISED_PROVIDER_RUNTIME_POLICY.closeWaitMs)); }
    outcome.replacementSafe = !otherMembers();
  } catch { outcome.replacementSafe = false; }
  writeFileSync(3, JSON.stringify({ nonce: request.nonce, pid: process.pid, outcome }));
});
