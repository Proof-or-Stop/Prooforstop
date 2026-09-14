import { VALIDATION_RESERVATION_DELEGATION_RUNTIME_POLICY as policy } from './runtime-fact-registry.js';
import { VALIDATION_RESERVATION_DELEGATION_ARTIFACT as artifacts } from './runtime-artifact-registry.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync, type StdioOptions } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { generateEd25519KeyPair, signCanonical, verifyCanonical } from './authority-signing.js';
import { canonicalizeEntries, claimsConflict, type ResourceClaim } from './keyed-scheduler.js';
import { inspectMachineReservationOwner } from './validation-execution-lock.js';

// The descriptor is a locator, never an environment credential. Its object must
// also be held by the independently verified live machine reservation owner.
const FD = policy.descriptor, ENV = policy.descriptorEnvironment, LIMIT = policy.maxMessageBytes, CLEANUP_MS = policy.cleanupMs;
export const VALIDATION_DELEGATION_RESIDUAL_FILE = artifacts.residualFile;
type ProcessIdentity = { pid: number; start: number; pgid: number };
export interface MachineReservationOwner { ticket: string; lockId: string; pid: number; start: number; deadlineAt: number; resources: ResourceClaim[] | null }
type Bootstrap = MachineReservationOwner & { schema: 'validation-reservation-delegation.v1'; rootFd: number; publicKey: string; socket: string };
type Request = { operation: 'grant' | 'register' | 'confirm' | 'prepare' | 'cancel' | 'attempt' | 'spawned'; pid: number; start: number; nonce: string; deadlineAt: number; resources?: ResourceClaim[] | null; targetPid?: number; spawnedPid?: number; parentGrantId?: string; pendingToken?: string; cleanupCapability?: string };
type Grant = { reservation: string; subject: ProcessIdentity; nonce: string; operation: Request['operation']; resources: ResourceClaim[] | null; deadlineAt: number; heldPorts?: string[]; grantId: string; pendingToken?: string; cleanupCapability?: string };
export interface ValidationReservationHandshakeOptions { deadlineAt?: number; signal?: AbortSignal }
type Frame = { heldPorts?: string[]; grantId?: string; deadlineAt?: number; active: boolean; resources: ResourceClaim[] | null; fd: number; bootstrap: Bootstrap; abort: AbortController; register?: (pid: number, pendingToken?: string) => void; prepare?: () => string; cancel?: (token: string) => void; attempt?: (token: string) => void; spawned?: (token: string, pid: number) => void };
const frames = new AsyncLocalStorage<Frame>();
// Private per-invocation cleanup material. It is never an environment value or
// residual-file field and cannot grant execution resources.
const cleanupCapabilities = new Map<string,{reservation:string;capability:string}>();
export class ValidationDelegationError extends Error {
  constructor(reason: string) { super('VALIDATION_DELEGATION_REFUSED: ' + reason); this.name = 'ValidationDelegationError'; }
}
/** Classification only; neither message text nor caller-authored fields grant authority. */
export function isValidationDelegationError(error: unknown): boolean {
  try {
    for (let depth = 0; error && typeof error === 'object' && depth < 8; depth++) {
      if (error instanceof ValidationDelegationError) return true;
      const cause = Object.getOwnPropertyDescriptor(error, 'cause');
      error = cause && 'value' in cause ? cause.value : undefined;
    }
  } catch { /* A hostile diagnostic object is not a typed infrastructure fact. */ }
  return false;
}
function failure(reason: string): Error { return new ValidationDelegationError(reason); }
function table(): Map<number, ProcessIdentity & { ppid: number }> {
  // A process-table observation failure is a typed refusal like every other kernel
  // observation; retrying paths observe it through observeWithRetry.
  let rows: string;
  try { rows = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: policy.kernelObservationMs, maxBuffer: 8 * 1024 * 1024 }); }
  catch { throw failure('process table unavailable'); }
  const result = new Map<number, ProcessIdentity & { ppid: number }>();
  for (const row of rows.trim().split('\n')) { const [pid, ppid, pgid] = row.trim().split(/\s+/).map(Number); if (pid > 1 && Number.isSafeInteger(ppid) && pgid > 1) result.set(pid, { pid, ppid, pgid, start: 0 }); }
  return result;
}
function identity(pid: number): ProcessIdentity {
  if(!Number.isSafeInteger(pid)||pid<=1)throw failure('process identity unavailable');
  let raw: string;
  try { raw=execFileSync('ps',['-p',String(pid),'-o','pid=,pgid=,lstart='],{encoding:'utf8',timeout:policy.kernelObservationMs,maxBuffer:8*1024*1024}); }
  catch { throw failure('process identity unavailable'); }
  const rows=raw.trim().split('\n');
  const match=rows.length===1 && rows[0].trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
  const observedPid=match?Number(match[1]):NaN, pgid=match?Number(match[2]):NaN, start=match?Date.parse(match[3]):NaN;
  if(observedPid!==pid||!Number.isSafeInteger(pgid)||pgid<=1||!Number.isFinite(start))throw failure('process identity unavailable');
  return {pid,start,pgid};
}
function ancestors(pid: number, rows: ReturnType<typeof table> = table()): number[] {
  const seen = new Set<number>(); let next = rows.get(pid)?.ppid;
  while (next && next > 1 && !seen.has(next)) { seen.add(next); next = rows.get(next)?.ppid; }
  return [...seen];
}
function sameProcess(value: ProcessIdentity): boolean {
  try {const current=identity(value.pid);return current.start===value.start&&current.pgid===value.pgid;}catch{return false;}
}
/** Read-only observations for the cooperating isolation helper, never enrollment authority. */
export function observeValidationReservationChild(pid:number): ProcessIdentity {return identity(pid);}
export function validationReservationChildIdentityMatches(value:ProcessIdentity):boolean{return sameProcess(value);}
export function validationReservationGroupIsAbsent(pgid:number):boolean{return groupGone(pgid);}
/** Read-only signal-target observation for the cooperating isolation helper: exactly the rule the controller teardown applies to its own enrollments. Never a release authority. */
export function validationReservationOwnedGroupSignalTarget(value:ProcessIdentity):boolean{return ownedGroupSignalTarget(value);}
/** An unregistered child is provably gone only when its PID and its whole group are both absent; a live or unobservable child never is. Read-only: never a release authority by itself. */
export function unregisteredValidationReservationChildGone(pid:number):boolean{if(!Number.isSafeInteger(pid)||pid<=1)return false;try{process.kill(pid,0);return false;}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')return false;}return groupGone(pid);}
function groupGone(pgid: number): boolean {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return false;
  try { process.kill(-pgid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
/** A recorded group leader's PID is absent (ESRCH) while its recorded group persists. The kernel allocates no PID that any live or zombie process still carries as its process-group or session id, so a persisting group whose leader PID is absent is the recorded group; a live process observed at that PID with a different start is a recycled PID and never a signal target. */
function leaderAbsent(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
/** The one signal-target rule for a previously observed owned group leader, shared by the controller teardown and the isolated fixture: the leader still observed with its recorded identity, or absent while its recorded group persists. Never a non-leader, a gone group, or a PID observed with a different start. */
function ownedGroupSignalTarget(value: ProcessIdentity): boolean {
  if (value.pid !== value.pgid || groupGone(value.pgid)) return false;
  return sameProcess(value) || leaderAbsent(value.pid);
}
/** Resolve an unobserved target only when neither its PID nor group exists. */
// Transient kernel observation failures (ps spawn or timeout) are retried a bounded
// number of times before a registration is refused; absence still resolves only
// through registrationTargetGone, never through the retry itself.
function observeWithRetry<T>(observe: () => T): T {
  let last: unknown;
  for (let attempt = 0; attempt < policy.observationRetries; attempt++) {
    try { return observe(); } catch (error) {
      last = error;
      if (attempt + 1 < policy.observationRetries) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, policy.observationBackoffMs);
    }
  }
  throw last;
}
/** A pending row's owner is provably gone when its PID is absent or observed with a different start; an unobservable owner keeps the row. */
function pendingOwnerGone(pid: number, start: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  try { return identity(pid).start !== start; } catch { return false; }
}
/** A pending row resolves through its observed target's absence, or, when no spawn was ever attempted under it, through its owner's proven absence. An attempted row without a target is terminal. */
function pendingRowResolved(row: { pid?: unknown; start?: unknown; target?: { pid?: number; pgid?: number; start?: number }; spawnAttempted?: unknown; spawnedPid?: unknown }): boolean {
  const target = row.target;
  if (target) return target.pid === target.pgid && Number.isFinite(target.start) && registrationTargetGone(target.pid as number);
  const ownerGone = Number.isSafeInteger(row.pid) && Number.isFinite(row.start) && pendingOwnerGone(row.pid as number, row.start as number);
  if (row.spawnAttempted !== true) return ownerGone;
  // A marked fence resolves only through its noted spawned PID: once the owner is provably gone and
  // that PID and its whole group are absent, nothing spawned under the fence can remain.
  return ownerGone && Number.isSafeInteger(row.spawnedPid) && registrationTargetGone(row.spawnedPid as number);
}
function registrationTargetGone(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
  }
  return groupGone(pid);
}
function descriptor(pid: number, fd: number): { dev: bigint; ino: bigint } {
  if (process.platform !== policy.platform) throw failure('kernel descriptor observation unsupported');
  // The descriptor observation is retried with the registered policy and refused as a typed
  // delegation failure; a transient lsof failure never escapes as a raw error.
  const raw = observeWithRetry(() => {
    try { return execFileSync('/usr/sbin/lsof', ['-n', '-P', '-a', '-p', String(pid), '-d', String(fd), '-F', 'paftDi'], { encoding: 'utf8', timeout: policy.kernelObservationMs, maxBuffer: LIMIT }); }
    catch { throw failure('kernel descriptor observation unavailable'); }
  });
  const rows = raw.trim().split('\n');
  if (rows.filter(x => x.startsWith('p')).join() !== 'p' + pid || rows.filter(x => x.startsWith('f')).join() !== 'f' + fd || !rows.includes('tREG') || !rows.includes('ar')) throw failure('kernel descriptor identity ambiguous');
  const dev = rows.filter(x => x.startsWith('D')), ino = rows.filter(x => x.startsWith('i'));
  if (dev.length !== 1 || ino.length !== 1) throw failure('kernel descriptor fields unavailable');
  return { dev: BigInt(dev[0].slice(1)), ino: BigInt(ino[0].slice(1)) };
}
// On Darwin every Node-spawned child receives only its explicitly listed stdio
// descriptors (posix_spawn closes the rest), so a plain wrapper such as npm drops
// the reserved descriptor while the locator environment survives. That loss is
// classified as a dropped transport: the process runs without a borrowed
// reservation, exactly as before delegation existed, and forwards no locator.
// Child output stays byte-identical by default; the registered diagnostics
// environment opts into one stderr line per process. Nothing is repaired from the
// environment, and a regular file at the reserved slot is never downgraded: a
// copied bootstrap stays refused.
let droppedTransportDiagnosed = false;
function droppedTransport(reason: string): undefined {
  if (!droppedTransportDiagnosed && process.env[policy.diagnosticsEnvironment] === '1') {
    droppedTransportDiagnosed = true;
    process.stderr.write(`VALIDATION_DELEGATION_UNAVAILABLE: ${reason}; an intermediate wrapper dropped the reserved descriptor, so this process runs without a borrowed machine reservation and forwards no locator\n`);
  }
  return undefined;
}
// One spawn verifies its inherited bootstrap twice (environment and stdio helpers) within the same
// synchronous turn; the second read reuses the first verification and the memo dies with the turn,
// so no verification is ever older than the code that asked for it.
let turnBootstrap: { fd: number; cleanupOnly: boolean; value: Bootstrap | undefined } | undefined;
function readBootstrap(fd: number = FD, cleanupOnly = false): Bootstrap | undefined {
  if (turnBootstrap && turnBootstrap.fd === fd && turnBootstrap.cleanupOnly === cleanupOnly) return turnBootstrap.value;
  const value = readBootstrapFresh(fd, cleanupOnly);
  turnBootstrap = { fd, cleanupOnly, value }; queueMicrotask(() => { turnBootstrap = undefined; });
  return value;
}
function readBootstrapFresh(fd: number, cleanupOnly: boolean): Bootstrap | undefined {
  const inherited = !frames.getStore();
  if (inherited && process.env[ENV] === undefined) return undefined;
  if (inherited && process.env[ENV] !== String(FD)) throw failure('invalid descriptor locator');
  let stat; try { stat = fstatSync(fd, { bigint: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error;
    if (inherited) return droppedTransport('missing inherited descriptor');
    throw failure('missing inherited descriptor');
  }
  if (inherited && !stat.isFile()) return droppedTransport('reserved descriptor is not a regular file');
  // A dropped transport leaves the reserved number free, so an ordinary linked file that a
  // descendant later opened there is unrelated to delegation and degrades like the drop.
  if (inherited && stat.nlink !== 0n) return droppedTransport('reserved descriptor is an unrelated linked file');
  // A foreign unlinked regular file at the reserved slot is not silently treated as no delegation.
  if (!stat.isFile() || stat.nlink !== 0n || stat.size <= 0n || stat.size > BigInt(LIMIT)) throw failure('bootstrap is not a bounded unlinked regular descriptor');
  const buffer = Buffer.alloc(Number(stat.size)); if (readSync(fd, buffer, 0, buffer.length, 0) !== buffer.length) throw failure('bootstrap incomplete');
  // A foreign unlinked descriptor with non-JSON bytes is a typed refusal, never a raw parse error.
  let value: Bootstrap; try { value = JSON.parse(buffer.toString('utf8')) as Bootstrap; } catch { throw failure('bootstrap is not a bounded JSON envelope'); }
  if (value.schema !== 'validation-reservation-delegation.v1' || !Number.isSafeInteger(value.rootFd) || value.rootFd < 3 || !Number.isFinite(value.deadlineAt)) throw failure('bootstrap shape');
  const actual = inspectMachineReservationOwner(value.ticket, value.lockId);
  if (!actual || actual.pid !== value.pid || actual.start !== value.start || JSON.stringify(actual.resources)!==JSON.stringify(value.resources)) throw failure('reservation not live/admitted');
  const own = descriptor(process.pid, fd), root = descriptor(actual.pid, value.rootFd);
  if (own.dev !== stat.dev || own.ino !== stat.ino || root.dev !== stat.dev || root.ino !== stat.ino) throw failure('bootstrap not held by reservation owner');
  const after = inspectMachineReservationOwner(value.ticket, value.lockId);
  if (!after || after.pid !== actual.pid || after.start !== actual.start || JSON.stringify(after.resources)!==JSON.stringify(value.resources) || !cleanupOnly && Date.now() >= value.deadlineAt) throw failure('reservation changed during bootstrap');
  return value;
}
/** Explicit cooperating spawn boundary; native broker fd3 remains untouched. */
export function validationReservationChildStdio(base: StdioOptions = ['ignore', 'pipe', 'pipe']): StdioOptions {
  const frame = frames.getStore(); if(frame && !frame.active)throw failure('invocation no longer active'); const bootstrap = frame?.bootstrap ?? readBootstrap();
  if (!bootstrap) return base;
  const result = typeof base === 'string' ? [base, base, base] : [...base];
  while (result.length <= FD) result.push('ignore');
  if (result[FD] !== 'ignore' && result[FD] !== undefined) throw failure('reserved descriptor collision');
  result[FD] = frame?.fd ?? FD;
  return result as StdioOptions;
}
export function validationReservationChildEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const frame=frames.getStore();if(frame && !frame.active)throw failure('invocation no longer active');
  const bootstrap = frame?.bootstrap ?? readBootstrap();
  if (bootstrap) return { ...base, [ENV]: String(FD) };
  if (base[ENV] === undefined) return base;
  // A dangling locator inherited through a dropping wrapper is never forwarded.
  const stripped = { ...base }; delete stripped[ENV]; return stripped;
}
export function currentValidationReservationAbortSignal(): AbortSignal | undefined { return frames.getStore()?.abort.signal; }
/** A grant binds exactly the requested claims; an unclassified grant request accepts only claims within the owner's declaration, which the server resolves from the tightest enclosing grant. Every other operation grants no claims. */
function grantClaimsBound(grant: Grant, input: { operation: Request['operation']; resources?: ResourceClaim[] | null }, bootstrap: Bootstrap): boolean {
  if (input.operation !== 'grant') return grant.resources === null;
  if (input.resources !== undefined && input.resources !== null) return JSON.stringify(grant.resources) === JSON.stringify(input.resources);
  return subset(grant.resources, bootstrap.resources);
}
function subset(requested: ResourceClaim[] | null, held: ResourceClaim[] | null): boolean {
  return held === null || requested !== null && requested.every(row => held.some(prior => prior.class === row.class && prior.key === row.key && (prior.access === 'exclusive' || prior.access === row.access)));
}
function conflict(a: ResourceClaim[] | null, b: ResourceClaim[] | null): boolean { return a === null || b === null || claimsConflict({ name: 'a', resources: a }, { name: 'b', resources: b }); }
async function request(bootstrap: Bootstrap, input: Omit<Request, 'pid' | 'start' | 'nonce'>, signal?: AbortSignal): Promise<{ socket: Socket; grant: Grant; revocation: AbortSignal }> {
  const self = identity(process.pid), nonce = randomUUID(), revocation = new AbortController();
  return await new Promise((resolve, reject) => {
    const socket = createConnection(bootstrap.socket); let bytes = '', settled = false, accepted: Grant | undefined;
    const fail = (error: Error) => {
      if (settled) { revocation.abort(error); return; }
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort',cancel); socket.destroy(); reject(error);
    };
    const cancel=()=>fail(signal?.reason instanceof Error ? signal.reason : failure('request aborted'));
    const timer = setTimeout(() => fail(failure('handshake deadline')), Math.max(1, input.deadlineAt - Date.now()));
    signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted){cancel();return;}
    socket.once('error', fail); socket.once('end', () => fail(failure('issuer closed'))); socket.once('close', () => fail(failure('issuer closed')));
    socket.once('connect', () => socket.write(JSON.stringify({ ...input, pid: self.pid, start: self.start, nonce }) + '\n'));
    // One parser owns both handshake and live frames. Processing all complete
    // lines before returning to the event loop preserves coalesced revocations.
    socket.on('data', chunk => {
      bytes += chunk.toString(); if (Buffer.byteLength(bytes) > LIMIT) return fail(failure('response overflow'));
      while (bytes.includes('\n')) {
        const line = bytes.slice(0, bytes.indexOf('\n')); bytes = bytes.slice(bytes.indexOf('\n') + 1);
        try {
          const response = JSON.parse(line);
          if (accepted) {
            if (!verifyCanonical(response.revocation, response.signature, bootstrap.publicKey) || response.revocation.reservation !== bootstrap.lockId || response.revocation.grantId !== accepted.grantId) throw failure('invalid live revocation');
            revocation.abort(failure('live reservation revoked')); continue;
          }
          if (settled) return;
          if (response.error) throw failure(response.error);
          const grant = response.grant as Grant;
          if (!verifyCanonical(grant, response.signature, bootstrap.publicKey) || grant.reservation !== bootstrap.lockId || grant.subject.pid !== self.pid || grant.subject.start !== self.start || grant.nonce !== nonce || grant.operation !== input.operation || !grantClaimsBound(grant, input, bootstrap) || grant.deadlineAt > (input.operation === 'cancel' ? input.deadlineAt : Math.min(bootstrap.deadlineAt, input.deadlineAt)) || Date.now() >= grant.deadlineAt) throw failure('grant subject/binding/signature');
          const fresh = readBootstrapFresh(frames.getStore()?.fd ?? FD, input.operation === 'cancel'); if (!fresh || fresh.publicKey !== bootstrap.publicKey || !sameProcess(self)) throw failure('grant owner changed');
          accepted = grant; settled = true; clearTimeout(timer); signal?.removeEventListener('abort',cancel); resolve({ socket, grant, revocation: revocation.signal });
        } catch (error) { fail(error instanceof Error ? error : failure('invalid response')); }
      }
    });
  });
}
function handshake(bootstrap: Bootstrap, options: ValidationReservationHandshakeOptions = {}): {deadlineAt: number; signal?: AbortSignal} {
  const frame = frames.getStore();
  const signals = [options.signal, frame?.abort.signal].filter((value): value is AbortSignal => value !== undefined);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  const deadlineAt = Math.min(bootstrap.deadlineAt, options.deadlineAt ?? Infinity, Date.now() + policy.workerRegistrationMs);
  if (signal?.aborted || !Number.isFinite(deadlineAt) || Date.now() >= deadlineAt || frame && !frame.active) throw failure('handshake invocation expired/revoked');
  return {deadlineAt, signal};
}
export async function registerValidationReservationChild(pid: number, pendingToken?: string, options: ValidationReservationHandshakeOptions = {}): Promise<void> {
  const local = frames.getStore(); if(local && !local.active)throw failure('invocation no longer active'); if (local?.register) { handshake(local.bootstrap,options); local.register(pid, pendingToken); return; }
  const bootstrap = local?.bootstrap ?? readBootstrap(); if (!bootstrap) return;
  const cleanup=pendingToken && cleanupCapabilities.get(pendingToken);if(!cleanup || cleanup.reservation!==bootstrap.lockId)throw failure('pending mutation capability unavailable');
  const bounded = handshake(bootstrap, options); const response = await request(bootstrap, { operation: 'register', targetPid: pid, pendingToken, cleanupCapability:cleanup.capability, parentGrantId: local?.grantId, deadlineAt: bounded.deadlineAt }, bounded.signal); response.socket.end();if(pendingToken)cleanupCapabilities.delete(pendingToken);
}
export async function withInheritedMachineReservation<T>(resources: ResourceClaim[] | null, deadlineAt: number, signal: AbortSignal | undefined, fn: () => Promise<T> | T): Promise<{ inherited: false } | { inherited: true; value: T }> {
  const current = frames.getStore();
  if (current?.register) {if(!current.active)throw failure('invocation no longer active');return { inherited: false };}
  if (current && (!current.active || !subset(resources,current.resources) || current.abort.signal.aborted)) throw failure('nested reservation expansion/revocation');
  const bootstrap = current?.bootstrap ?? readBootstrap(); if (!bootstrap) return { inherited: false };
  if (current) signal = signal ? AbortSignal.any([signal,current.abort.signal]) : current.abort.signal;
  if (signal?.aborted) throw signal.reason;
  const response = await request(bootstrap, { operation: 'grant', resources, parentGrantId: current?.grantId, deadlineAt: Math.min(deadlineAt, bootstrap.deadlineAt) }, signal);
  const abort = new AbortController(), revoke = () => abort.abort(failure('live reservation revoked'));
  response.revocation.addEventListener('abort', revoke, {once:true}); if(response.revocation.aborted)revoke();
  response.socket.once('close', revoke); const timer = setTimeout(revoke, Math.max(1, response.grant.deadlineAt - Date.now()));
  const forward = () => abort.abort(signal?.reason); signal?.addEventListener('abort', forward, { once: true });
  const frame: Frame = { active: true, heldPorts: response.grant.heldPorts ?? [], grantId: response.grant.grantId, deadlineAt: response.grant.deadlineAt, resources: response.grant.resources ?? resources, fd: FD, bootstrap, abort };
  try { if (signal?.aborted || abort.signal.aborted || response.socket.destroyed || Date.now() >= response.grant.deadlineAt) throw failure('grant revoked before entry'); return { inherited: true, value: await frames.run(frame, fn) }; }
  finally { frame.active = false; clearTimeout(timer); signal?.removeEventListener('abort', forward); response.socket.removeListener('close', revoke); response.revocation.removeEventListener('abort', revoke); response.socket.end(JSON.stringify({release:response.grant.grantId})+'\n'); }
}
/** Machine-only stale fence. Unknown records retain capacity; no foreign process is signaled. */
export function machineReservationResidualsPresent(ticket: string): boolean {
  const path = join(ticket, VALIDATION_DELEGATION_RESIDUAL_FILE); if (!existsSync(path)) return false;
  try { const rows = JSON.parse(readFileSync(path, 'utf8')); if (!Array.isArray(rows)) return true; return rows.some(row => {
    if (row.pending !== undefined) return !pendingRowResolved(row);
    return !Number.isSafeInteger(row.pgid) || !groupGone(row.pgid);
  }); } catch { return true; }
}
/** Read-only classification of one ticket's residual rows with the exact release predicates; a doctor projection that never releases or signals anything. */
export function classifyMachineReservationResiduals(ticket: string): { present: boolean; malformed: boolean; registeredLive: number; registeredResolved: number; pendingTargetLive: number; pendingTargetResolved: number; pendingTargetless: number; pendingUnattemptedResolved: number; pendingSpawnedLive: number; pendingSpawnedResolved: number; deadOwners: number } {
  const result = { present: false, malformed: false, registeredLive: 0, registeredResolved: 0, pendingTargetLive: 0, pendingTargetResolved: 0, pendingTargetless: 0, pendingUnattemptedResolved: 0, pendingSpawnedLive: 0, pendingSpawnedResolved: 0, deadOwners: 0 };
  const path = join(ticket, VALIDATION_DELEGATION_RESIDUAL_FILE); if (!existsSync(path)) return result;
  result.present = true;
  let rows: unknown; try { rows = JSON.parse(readFileSync(path, 'utf8')); } catch { result.malformed = true; return result; }
  if (!Array.isArray(rows)) { result.malformed = true; return result; }
  for (const row of rows as Array<Record<string, unknown>>) {
    if (!row || typeof row !== 'object') { result.malformed = true; continue; }
    if (row.pending !== undefined) {
      const target = row.target as { pid?: number; pgid?: number; start?: number } | undefined;
      if (!target || target.pid !== target.pgid || !Number.isFinite(target.start)) {
        if (pendingRowResolved(row)) { if (row.spawnAttempted === true) result.pendingSpawnedResolved++; else result.pendingUnattemptedResolved++; continue; }
        // A marked fence with a noted spawned PID resolves on its own once its owner is gone and that PID and group are absent.
        if (row.spawnAttempted === true && Number.isSafeInteger(row.spawnedPid)) { result.pendingSpawnedLive++; continue; }
        result.pendingTargetless++;
        const ownerPid = row.pid;
        if (Number.isSafeInteger(ownerPid) && (ownerPid as number) > 1) { try { process.kill(ownerPid as number, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') result.deadOwners++; } }
      } else if (registrationTargetGone(target.pid as number)) result.pendingTargetResolved++; else result.pendingTargetLive++;
    } else if (!Number.isSafeInteger(row.pgid) || !groupGone(row.pgid as number)) result.registeredLive++; else result.registeredResolved++;
  }
  return result;
}
/** Failure-only diagnostics; these observations never release or authorize work. */
function machineCleanupFailure(owner: MachineReservationOwner, registered: Iterable<ProcessIdentity>, pending: Iterable<{pid:number;start:number}>, callbackStarted:boolean, callbackThrew:boolean, callbackError:unknown, callbackResult:unknown): Error {
  let truncated=false, remaining=Math.floor(LIMIT/8);
  const text=(value:string):string=>{const max=Math.min(value.length,remaining,Math.floor(LIMIT/32)),part=value.slice(0,max);remaining-=max;if(part.length!==value.length)truncated=true;return part;};
  const own=(value:unknown,key:string):unknown=>{try {if(value===null||typeof value!=='object')return undefined;const descriptor=Object.getOwnPropertyDescriptor(value,key);return descriptor&&'value' in descriptor?descriptor.value:undefined;}catch{return undefined;}};
  const callback: {state:string;error?:string;result?:Record<string,unknown>}={state:!callbackStarted?'not_entered':callbackThrew?'threw':'returned'};
  if(callbackThrew){const message=own(callbackError,'message');callback.error=text(typeof message==='string'?message:typeof callbackError==='string'?callbackError:'callback threw a non-message value');}
  else if(callbackStarted) {
    const snapshot=(value:unknown):Record<string,unknown>=>{const result:Record<string,unknown>={};for(const key of ['code','exitCode','signal','timedOut','durationMs','timeoutMs','output','stdout','stderr']){const field=own(value,key);if(typeof field==='string')result[key]=text(field);else if(field===null||typeof field==='boolean'||typeof field==='number'&&Number.isFinite(field))result[key]=field;}return result;};
    callback.result=snapshot(callbackResult);
    // The production executor returns this one wrapper, not the flat public
    // runSingle result. Read only its own data fields; never recurse generally.
    const completeOutput=own(callbackResult,'completeOutput'), result=own(callbackResult,'result');
    if(typeof completeOutput==='string' && result!==null && typeof result==='object'){callback.result.completeOutput=text(completeOutput);callback.result.result=snapshot(result);}
  }
  const residuals: Array<Record<string,unknown>>=[];let residualCount=0;
  for(const row of registered){residualCount++;if(residuals.length>=16){truncated=true;continue;}let reason='group present',code:string|undefined;try{process.kill(-row.pgid,0);}catch(error){const observed=own(error,'code');code=typeof observed==='string'?observed:undefined;reason=code==='ESRCH'?'group absent':'group observation unavailable';}residuals.push({kind:'registered',pid:row.pid,start:row.start,pgid:row.pgid,reason,...(code?{code}:{}),identityBasis:'recorded enrollment; no new start-time observation'});}
  for(const row of pending){residualCount++;if(residuals.length>=16){truncated=true;continue;}residuals.push({kind:'pending',pid:row.pid,start:row.start,reason:'unresolved pre-spawn fence'});}
  const diagnostics={schema:'validation-reservation-cleanup.v1',owner:{pid:owner.pid,start:owner.start,deadlineAt:owner.deadlineAt},callback,residuals,residualCount,truncated};
  // Strings share a small budget; enforce the serialized bound even for escaped
  // or multi-byte text. This fallback never drops the original Error cause.
  if(Buffer.byteLength(JSON.stringify(diagnostics))>LIMIT){diagnostics.truncated=true;if(callback.error)callback.error=callback.error.slice(0,256);if(callback.result)for(const key of Object.keys(callback.result))if(typeof callback.result[key]==='string')callback.result[key]=(callback.result[key] as string).slice(0,256);}
  const error=new Error('VALIDATION_DELEGATION_REFUSED: owned group cleanup unproven; VALIDATION_RESERVATION_CLEANUP_DIAGNOSTICS '+JSON.stringify(diagnostics),{cause:callbackThrew?callbackError:undefined});
  Object.defineProperty(error,'cleanupDiagnostics',{value:diagnostics,enumerable:true});return error;
}
export async function withMachineReservationController<T>(owner: MachineReservationOwner, isLive: () => boolean, fn: () => Promise<T> | T): Promise<T> {
  if (process.platform !== policy.platform) return await fn();
  // The owner's own admission is a ticket and kernel observation like every other one in this
  // module: retried with the registered observation policy, and when it stays unavailable the
  // command runs without a controller exactly as on an unsupported platform (no delegation is
  // offered, nothing is weakened). An owner observed with a different identity or declaration is
  // still refused.
  let admitted: NonNullable<ReturnType<typeof inspectMachineReservationOwner>>;
  try { admitted = observeWithRetry(() => { const observed = inspectMachineReservationOwner(owner.ticket, owner.lockId); if (!observed) throw failure('controller owner observation unavailable'); return observed; }); }
  catch { if (!isLive()) throw failure('controller owner/declaration mismatch'); return await fn(); }
  if(!isLive()||admitted.pid!==process.pid||admitted.start!==owner.start||JSON.stringify(admitted.resources)!==JSON.stringify(owner.resources))throw failure('controller owner/declaration mismatch');
  // A unix socket path is capped at 104 bytes on Darwin; a deep scratch TMPDIR falls back to /tmp.
  const temporaryRoot = Buffer.byteLength(join(tmpdir(), artifacts.temporaryPrefix)) + 6 + 1 + artifacts.socketFile.length + 1 <= 100 ? tmpdir() : '/tmp';
  const keys = generateEd25519KeyPair(), directory = mkdtempSync(join(temporaryRoot, artifacts.temporaryPrefix)), socketPath = join(directory, artifacts.socketFile);
  const bootstrapPath = join(directory, artifacts.bootstrapFile);
  const pendingChildren = new Map<string,{pid:number;start:number;parents:string[];target?:ProcessIdentity;cleanupCapability:string;spawnAttempted?:boolean;spawnedPid?:number}>();
  // Tokens already turned into enrollments, keyed to their cleanup capability; an entry outlives its
  // pruned enrollment for one bounded cleanup window so a withdrawal racing the applied registration
  // stays idempotent, then expires.
  const consumedPending = new Map<string,{capability:string;expiresAt?:number}>();
  const registeredTokens = new Map<number,string>();
  const registered = new Map<number, ProcessIdentity & { parents: string[] }>(), active = new Map<Socket, { subject: ProcessIdentity; resources: ResourceClaim[] | null; grantId: string; parents: string[]; deadlineAt: number; revoked?: boolean; terminal?: boolean; disconnected?: boolean }>();
  const grantTimers = new Map<Socket, NodeJS.Timeout>();
  const sockets = new Set<Socket>(), pending: Array<{ socket: Socket; input: Request }> = [];
  let alive = true, fd = -1; let frame: Frame | undefined;
  let callbackStarted=false, callbackThrew=false, callbackError:unknown, callbackResult:unknown;
  const abort = new AbortController();
  const live = () => alive && isLive() && Date.now() < owner.deadlineAt;
  // One retirement tick observes the process table and each identity at most once.
  const tick = { rows: undefined as ReturnType<typeof table> | undefined, identities: new Map<number, ProcessIdentity | null>() };
  const resetTick = (): void => { tick.rows = undefined; tick.identities.clear(); };
  const rowsNow = (): ReturnType<typeof table> => tick.rows ??= observeWithRetry(() => table());
  const identityNow = (pid: number): ProcessIdentity | null => { if (!tick.identities.has(pid)) { try { tick.identities.set(pid, observeWithRetry(() => identity(pid))); } catch { tick.identities.set(pid, null); } } return tick.identities.get(pid) ?? null; };
  const sameNow = (value: ProcessIdentity): boolean => { const current = identityNow(value.pid); return current !== null && current.start === value.start && current.pgid === value.pgid; };
  const publish = () => { const path = join(owner.ticket, VALIDATION_DELEGATION_RESIDUAL_FILE); writeFileSync(path + '.pending', JSON.stringify([...registered.values(),...[...pendingChildren].map(([pending,subject])=>({pending,pid:subject.pid,start:subject.start,parents:subject.parents,...(subject.spawnAttempted?{spawnAttempted:true}:{}),...(subject.spawnedPid!==undefined?{spawnedPid:subject.spawnedPid}:{}),...(subject.target?{target:subject.target}:{})}))]), { mode: 0o600 }); renameSync(path + '.pending', path); };
  const enrollment = (subject: ProcessIdentity, rows: ReturnType<typeof table> = table(), same: (value: ProcessIdentity) => boolean = sameProcess): string[] => {
    if (!same(subject)) throw failure('request process changed');
    for (const pid of [subject.pid,...ancestors(subject.pid, rows)]) { const known=registered.get(pid); if (!known || !same(known)) continue;
      if (known.parents.some(id=>![...active.values()].some(grant=>grant.grantId===id && !grant.revoked && Date.now()<grant.deadlineAt))) throw failure('parent invocation released');
      return [...known.parents];
    }
    throw failure('unenrolled request subject');
  };
  // The local frame observes its own subject with the same bounded retry as every socket request.
  const prepare = (subject=observeWithRetry(() => identity(process.pid)),parents:string[]=[]):string => {if(!live())throw failure('reservation closed before spawn');const token=randomUUID();pendingChildren.set(token,{pid:subject.pid,start:subject.start,parents,cleanupCapability:randomUUID()});publish();return token;};
  const cancel=(token:string,subject=observeWithRetry(() => identity(process.pid))):void=>{const pending=pendingChildren.get(token);if(!pending||pending.pid!==subject.pid||pending.start!==subject.start)throw failure('pending spawn not owned');pendingChildren.delete(token);publish();};
  // Marked immediately before the spawn call, so an unmarked row proves that no child was ever spawned under it.
  const attempt=(token:string,subject=observeWithRetry(() => identity(process.pid))):void=>{const pending=pendingChildren.get(token);if(!pending||pending.pid!==subject.pid||pending.start!==subject.start)throw failure('pending spawn not owned');if(!pending.spawnAttempted){pending.spawnAttempted=true;publish();}};
  // Noted immediately after the spawn call returns: a marked fence whose owner then dies before the
  // registration handshake resolves once the noted PID and its whole group are proven absent, so only
  // the window between the mark and the return of the spawn call is terminal.
  const spawned=(token:string,pid:number,subject=observeWithRetry(() => identity(process.pid))):void=>{const pending=pendingChildren.get(token);if(!pending||pending.pid!==subject.pid||pending.start!==subject.start)throw failure('pending spawn not owned');if(pending.spawnAttempted!==true)throw failure('spawn note requires a marked fence');if(!Number.isSafeInteger(pid)||pid<=1)throw failure('spawn note requires a child pid');if(pending.spawnedPid!==undefined&&pending.spawnedPid!==pid)throw failure('spawn note is immutable');if(pending.spawnedPid!==pid){pending.spawnedPid=pid;publish();}};
  const register = (pid: number, parent = process.pid, parents: string[] = [], pendingToken?: string, parentStart?: number) => {
    if (!live()) throw failure('registration after release');
    const pending=pendingToken && pendingChildren.get(pendingToken);if(!pending||pending.pid!==parent)throw failure('registration has no owned pre-spawn fence');
    // The owner's start identity comes from the same observer that recorded the
    // pending row, never from a second independent parser. A socket caller that has
    // already observed its subject supplies it; the local frame observes itself with
    // the same bounded retry and the same absence fallback as the target observations.
    let ownerStart=parentStart;
    if(ownerStart===undefined){try{ownerStart=observeWithRetry(()=>identity(parent)).start;}catch(error){if(!registrationTargetGone(pid))throw error;pendingChildren.delete(pendingToken!);publish();return;}}
    if(pending.start!==ownerStart)throw failure('registration has no owned pre-spawn fence');
    const inheritedParents=[...new Set([...pending.parents,...parents])];
    if(inheritedParents.some(id=>![...active.values()].some(grant=>grant.grantId===id&&!grant.revoked&&Date.now()<grant.deadlineAt)))throw failure('pending parent invocation released');
    if(pending.target && pending.target.pid!==pid)throw failure('pending target is immutable');
    if(registrationTargetGone(pid)){pendingChildren.delete(pendingToken!);publish();return;}
    if(registered.has(pid))throw failure('child enrollment is immutable');
    let target: ProcessIdentity;
    try { target = observeWithRetry(() => identity(pid)); } catch (error) {
      // Pending ownership, parent invocation and immutable enrollment were
      // checked above. Only fresh absence resolves this one owned fence.
      if (!registrationTargetGone(pid)) throw error;
      pendingChildren.delete(pendingToken!); publish(); return;
    }
    // A live non-leader may have no group at its PID; never treat that as its
    // work being absent, including when ancestry observations fail afterward.
    if(target.pgid!==target.pid)throw failure('registered child must own its detached group');
    if(pending.target && (pending.target.start!==target.start || pending.target.pgid!==target.pgid))throw failure('pending target identity changed');
    try {
      if (!observeWithRetry(() => ancestors(pid)).includes(parent)) throw failure('registration requires observed pre-orphan ancestry');
    } catch (error) {
      if (!registrationTargetGone(pid)) throw error;
      pendingChildren.delete(pendingToken!); publish(); return;
    }
    // Identity and real pre-orphan ancestry are proven before persisting an
    // owned target. An earlier unavailable observation leaves the fence unknown.
    pending.target=target;publish();
    registered.set(pid, { ...target, parents:inheritedParents });registeredTokens.set(pid, pendingToken!);consumedPending.set(pendingToken!, {capability: pending.cleanupCapability});pendingChildren.delete(pendingToken!); publish();
  };
  const revokeGrant = (grantId: string) => {
    for (const [socket, grant] of active) if ((grant.grantId === grantId || grant.parents.includes(grantId)) && !grant.revoked) {
      grant.revoked = true;
      const revocation = {reservation: owner.lockId, grantId: grant.grantId};
      socket.write(JSON.stringify({revocation, signature: signCanonical(revocation, keys.privateKey)}) + '\n');
    }
  };
  const subjectGroupWorkPresent = (subject: ProcessIdentity, terminal: boolean): boolean => {
    // A live caller may complete sequential callbacks without exiting. Only its
    // observed ancestor chain is excluded; other same-group work retains claims.
    if(!terminal || !sameNow(subject))return !groupGone(subject.pgid);
    try {
      const rows=rowsNow(), ancestors=new Set<number>();let next=rows.get(subject.pid)?.ppid;
      if(!rows.has(subject.pid))return true;
      while(next&&next>1&&!ancestors.has(next)){ancestors.add(next);next=rows.get(next)?.ppid;}
      return [...rows.values()].some(row=>row.pgid===subject.pgid&&row.pid!==subject.pid&&!ancestors.has(row.pid));
    }catch{return true;}
  };
  // A resolved enrollment leaves the residual record once its PID and whole group are proven
  // absent, so the record stays bounded across a run and a PID the kernel later recycles can be
  // enrolled again; a live or half-observed row stays. The pruned row's consumed capability is
  // kept for one bounded cleanup window, then dropped.
  const pruneResolvedEnrollments = (): boolean => {
    let pruned = false;
    for (const [pid, row] of registered) {
      if (!registrationTargetGone(pid) || !groupGone(row.pgid)) continue;
      registered.delete(pid); pruned = true;
      const token = registeredTokens.get(pid); registeredTokens.delete(pid);
      const consumed = token === undefined ? undefined : consumedPending.get(token);
      if (consumed && consumed.expiresAt === undefined) consumed.expiresAt = Date.now() + 2 * CLEANUP_MS;
    }
    for (const [token, consumed] of consumedPending) if (consumed.expiresAt !== undefined && Date.now() >= consumed.expiresAt) consumedPending.delete(token);
    return pruned;
  };
  // A queued request is removed only where it still sits: a request already dequeued must never
  // remove a neighbour, which splice(-1, 1) would silently do.
  const dequeue = (item: { socket: Socket; input: Request }): void => { const index = pending.indexOf(item); if (index >= 0) pending.splice(index, 1); };
  const retireReleasedGrants = () => {
    let retired = 0;
    for (const [socket, grant] of [...active].reverse()) {
      if (!grant.disconnected) continue;
      const pendingWork=[...pendingChildren.values()].some(row=>row.parents.includes(grant.grantId));
      const descendantGrants=[...active.values()].some(row=>row!==grant&&row.parents.includes(grant.grantId));
      const descendantsRemain = [...registered.values()].some(row=>row.parents.includes(grant.grantId) && !groupGone(row.pgid));
      if(pendingWork||descendantGrants||descendantsRemain||subjectGroupWorkPresent(grant.subject,grant.terminal===true))continue;
      active.delete(socket); clearTimeout(grantTimers.get(socket)); grantTimers.delete(socket); retired++;
    }
    return retired;
  };
  // Returns whether this tick changed anything, so idle polling can back off.
  const drain = () => {
    resetTick();
    let resolved=pruneResolvedEnrollments();for(const [token,row]of pendingChildren)if(pendingRowResolved(row)){pendingChildren.delete(token);resolved=true;}
    // The residual record may be unwritable under a live controller (operator cleanup of the ticket
    // directory); the on-disk record then stays at its more conservative fenced state rather than
    // crashing the owner from the retirement timer or a socket close handler.
    if(resolved){try{publish();}catch{ /* fenced on disk until the next successful publish */ }}
    let changed = resolved || retireReleasedGrants() > 0;
    const waiting = pending.length;
    for (const item of [...pending]) {
      const { socket, input } = item; if (socket.destroyed) { dequeue(item); continue; }
      try {
        if (!live() || Date.now() >= input.deadlineAt) throw failure('reservation/request expired');
        // A transient kernel observation failure leaves the request queued for the next tick; only
        // its own deadline or a genuine policy refusal removes it.
        const subject = identityNow(input.pid); if (!subject) continue;
        if (subject.start !== input.start) throw failure('request subject changed');
        let rows: ReturnType<typeof table>; try { rows = rowsNow(); } catch { continue; }
        const parents=enrollment(subject, rows, sameNow);
        const parent = input.parentGrantId ? [...active.values()].find(row=>row.grantId===input.parentGrantId&&!row.revoked&&Date.now()<row.deadlineAt&&row.subject.pid===subject.pid&&row.subject.start===subject.start) : undefined;
        if (input.parentGrantId && !parent) throw failure('parent grant/claim mismatch');
        const requested = input.resources ?? null;
        if(requested!==null && (!Array.isArray(requested)||JSON.stringify(canonicalizeEntries([{name:'delegated-machine-claims',resources:requested}],'/')[0].resources)!==JSON.stringify(requested)))throw failure('machine claims must be canonical');
        // An unclassified request from an enrolled descendant resolves to the tightest
        // enclosing declaration (its parent grant, else the owner); it never widens it.
        const resources = requested ?? (parent ? parent.resources : owner.resources);
        if (!subset(resources, owner.resources)) throw failure('resource expansion');
        if (parent) { if (!subset(resources, parent.resources)) throw failure('parent grant/claim mismatch'); parents.push(...parent.parents, parent.grantId); }
        if ([...active.values()].some(prior => conflict(prior.resources, resources) && !(parents.includes(prior.grantId) && subset(resources, prior.resources)))) continue;
        dequeue(item);
        const grant: Grant = { reservation: owner.lockId, subject, nonce: input.nonce, operation: input.operation, resources, deadlineAt: Math.min(owner.deadlineAt, input.deadlineAt, ...[...active.values()].filter(prior=>parents.includes(prior.grantId)).map(prior=>prior.deadlineAt)), grantId: randomUUID() };
        grant.heldPorts=(resources??[]).filter(row=>row.class==='fixed-port'&&row.access==='exclusive'&&[owner.resources,...[...active.values()].filter(prior=>parents.includes(prior.grantId)).map(prior=>prior.resources)].some(rows=>rows?.some(prior=>prior.class==='fixed-port'&&prior.access==='exclusive'&&prior.key===row.key))).map(row=>row.key);
        active.set(socket, { subject, resources, parents, grantId: grant.grantId, deadlineAt: grant.deadlineAt });
        grantTimers.set(socket,setTimeout(()=>{revokeGrant(grant.grantId);drainNow();},Math.max(1,grant.deadlineAt-Date.now())));
        socket.write(JSON.stringify({ grant, signature: signCanonical(grant, keys.privateKey) }) + '\n');
        changed = true;
      } catch (error) { dequeue(item); socket.end(JSON.stringify({ error: String(error) }) + '\n'); }
    }
    return changed || pending.length !== waiting;
  };
  const server = createServer(socket => {
    sockets.add(socket); let bytes = '', received = false;
    socket.on('error', () => undefined); socket.once('close', () => {
      sockets.delete(socket); const released = active.get(socket);
      if (released) { released.disconnected=true; revokeGrant(released.grantId); }
      drainNow();
    });
    socket.on('data', chunk => {
      bytes += chunk.toString(); if (Buffer.byteLength(bytes) > LIMIT) { socket.destroy(); return; } if (!bytes.includes('\n')) return;
      if(received) {
        try { const release=JSON.parse(bytes.slice(0,bytes.indexOf('\n'))); const grant=active.get(socket);
          if(!grant || release.release!==grant.grantId || Object.keys(release).length!==1 || bytes.slice(bytes.indexOf('\n')+1).length!==0)throw failure('invalid terminal release');
          grant.terminal=true;revokeGrant(grant.grantId);socket.end();
        } catch {socket.destroy();}
        return;
      }
      received = true;
      try {
        const input = JSON.parse(bytes.slice(0, bytes.indexOf('\n'))) as Request;
        if(bytes.slice(bytes.indexOf('\n')+1).length!==0)throw failure('unexpected request frames'); bytes='';
        if (!(input.operation === 'cancel' ? alive && isLive() : live()) || !Number.isSafeInteger(input.pid) || typeof input.nonce !== 'string' || !/^[0-9a-f-]{36}$/.test(input.nonce) || !Number.isFinite(input.deadlineAt)) throw failure('invalid request');
        // A grant request is observed only inside the retirement tick, where a transient failure
        // requeues it; immediate operations retry their single observation before refusing.
        if (input.operation === 'grant') { pending.push({ socket, input }); drainNow(); return; }
        const subject = observeWithRetry(() => identity(input.pid)); if (subject.start !== input.start) throw failure('request subject changed');
        // Cleanup only removes this exact subject's pending token. It neither
        // obtains a grant nor inherits admission from revoked parents.
        if (input.operation === 'cancel') {
          if (Date.now() >= input.deadlineAt || input.deadlineAt > Date.now() + CLEANUP_MS) throw failure('cleanup deadline');
          const ownedPending=input.pendingToken && pendingChildren.get(input.pendingToken);
          if(!ownedPending){
            // A withdrawal that races an already-applied registration finds no pending row; with the
            // matching capability that is an idempotent success because the fence it would remove is gone.
            const consumed=input.pendingToken && consumedPending.get(input.pendingToken);
            if(!consumed || typeof input.cleanupCapability!=='string' || input.cleanupCapability!==consumed.capability)throw failure('cleanup capability not owned');
          } else {
            if(typeof input.cleanupCapability!=='string' || input.cleanupCapability!==ownedPending.cleanupCapability)throw failure('cleanup capability not owned');
            cancel(input.pendingToken!, subject);
          }
          const grant: Grant = {reservation:owner.lockId,subject,nonce:input.nonce,operation:'cancel',resources:null,deadlineAt:input.deadlineAt,grantId:randomUUID()};
          socket.write(JSON.stringify({grant,signature:signCanonical(grant,keys.privateKey)})+'\n');return;
        }
        const parents=enrollment(subject, observeWithRetry(() => table()));
        if (input.operation === 'attempt') {
          const ownedPending=input.pendingToken && pendingChildren.get(input.pendingToken);
          if(!ownedPending || typeof input.cleanupCapability!=='string' || input.cleanupCapability!==ownedPending.cleanupCapability)throw failure('pending mutation capability not owned');
          attempt(input.pendingToken!, subject);
          const grant: Grant={reservation:owner.lockId,subject,nonce:input.nonce,operation:'attempt',resources:null,deadlineAt:Math.min(owner.deadlineAt,input.deadlineAt),grantId:randomUUID()};
          socket.write(JSON.stringify({grant,signature:signCanonical(grant,keys.privateKey)})+'\n');return;
        }
        if (input.operation === 'spawned') {
          const ownedPending=input.pendingToken && pendingChildren.get(input.pendingToken);
          if(!ownedPending || typeof input.cleanupCapability!=='string' || input.cleanupCapability!==ownedPending.cleanupCapability)throw failure('pending mutation capability not owned');
          spawned(input.pendingToken!, input.spawnedPid as number, subject);
          const grant: Grant={reservation:owner.lockId,subject,nonce:input.nonce,operation:'spawned',resources:null,deadlineAt:Math.min(owner.deadlineAt,input.deadlineAt),grantId:randomUUID()};
          socket.write(JSON.stringify({grant,signature:signCanonical(grant,keys.privateKey)})+'\n');return;
        }
        if (input.operation === 'register') {
          const ownedPending=input.pendingToken && pendingChildren.get(input.pendingToken);
          if(!ownedPending || typeof input.cleanupCapability!=='string' || input.cleanupCapability!==ownedPending.cleanupCapability)throw failure('pending mutation capability not owned');
          if (input.parentGrantId) { const parent=[...active.values()].find(row=>row.grantId===input.parentGrantId && !row.revoked && Date.now()<row.deadlineAt && row.subject.pid===subject.pid && row.subject.start===subject.start); if(!parent)throw failure('parent invocation not owned'); parents.push(...parent.parents,parent.grantId); }
          register(input.targetPid!, subject.pid, [...new Set(parents)],input.pendingToken,subject.start);
          const grant: Grant = { reservation: owner.lockId, subject, nonce: input.nonce, operation: input.operation, resources: null, deadlineAt: Math.min(owner.deadlineAt, input.deadlineAt), grantId: randomUUID() };
          socket.write(JSON.stringify({ grant, signature: signCanonical(grant, keys.privateKey) }) + '\n');
        } else if (input.operation === 'prepare') {
          if(input.parentGrantId){const parent=[...active.values()].find(row=>row.grantId===input.parentGrantId&&!row.revoked&&Date.now()<row.deadlineAt&&row.subject.pid===subject.pid&&row.subject.start===subject.start);if(!parent)throw failure('pending parent invocation not owned');parents.push(...parent.parents,parent.grantId);}
          const pendingToken=prepare(subject,[...new Set(parents)]);
          const grant: Grant={reservation:owner.lockId,subject,nonce:input.nonce,operation:input.operation,resources:null,deadlineAt:Math.min(owner.deadlineAt,input.deadlineAt),grantId:randomUUID(),...(pendingToken?{pendingToken,cleanupCapability:pendingChildren.get(pendingToken)!.cleanupCapability}:{})};socket.write(JSON.stringify({grant,signature:signCanonical(grant,keys.privateKey)})+'\n');
        } else if (input.operation === 'confirm') {
          const grant: Grant={reservation:owner.lockId,subject,nonce:input.nonce,operation:input.operation,resources:null,deadlineAt:Math.min(owner.deadlineAt,input.deadlineAt),grantId:randomUUID()};socket.write(JSON.stringify({grant,signature:signCanonical(grant,keys.privateKey)})+'\n');
        } else throw failure('unknown operation');
      } catch (error) { socket.end(JSON.stringify({ error: String(error) }) + '\n'); }
    });
  });
  // Transport setup failures are named delegation refusals and leave no scratch state behind.
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); }); }
  catch (error) { try { server.close(); } catch { /* never listened */ } rmSync(directory, { recursive: true, force: true }); throw failure('controller transport unavailable: ' + ((error as NodeJS.ErrnoException).code ?? String(error))); }
  // Idle retirement polling backs off exponentially; any event resets it to the minimum.
  let retirementTimer: NodeJS.Timeout | undefined, retirementDelay: number = policy.retirementPollMs;
  const scheduleRetirement = (delay: number): void => {
    if (!alive) return; if (retirementTimer) clearTimeout(retirementTimer); retirementDelay = delay;
    retirementTimer = setTimeout(() => { retirementTimer = undefined; let changed = false; try { changed = drain(); } finally { scheduleRetirement(changed ? policy.retirementPollMs : Math.min(retirementDelay * 2, policy.retirementPollMaxMs)); } }, delay);
    retirementTimer.unref();
  };
  const drainNow = (): void => { drain(); scheduleRetirement(policy.retirementPollMs); };
  scheduleRetirement(policy.retirementPollMs);
  try {
    // Reserve the descriptor number before writing the self-describing envelope;
    // only the separately reopened read-only descriptor is ever inherited.
    writeFileSync(bootstrapPath, '', { mode: 0o600 }); fd = openSync(bootstrapPath, constants.O_RDONLY);
    const bootstrap: Bootstrap = { ...owner, schema: 'validation-reservation-delegation.v1', rootFd: fd, publicKey: keys.publicKey, socket: socketPath };
    writeFileSync(bootstrapPath, JSON.stringify(bootstrap)); unlinkSync(bootstrapPath);
    frame={active:true,resources:owner.resources,fd,bootstrap,abort,register:(pid,token)=>register(pid,process.pid,[],token),prepare:()=>prepare(),cancel:token=>cancel(token),attempt:token=>attempt(token),spawned:(token,pid)=>spawned(token,pid)};
    try {callbackStarted=true;const result=await frames.run(frame, fn);callbackResult=result;return result;}catch(error){callbackThrew=true;callbackError=error;throw error;}
  } finally {
    alive = false; if (retirementTimer) clearTimeout(retirementTimer); for(const timer of grantTimers.values())clearTimeout(timer); if(frame)frame.active=false; abort.abort(failure('reservation ended')); for (const socket of sockets) socket.destroy();
    for (const group of registered.values()) {
      // Only previously observed owned group leaders are signal targets: still observed with the
      // recorded identity, or absent while the recorded group persists, which is the common shape
      // once the direct child has exited and a same-group descendant lingers.
      if (!ownedGroupSignalTarget(group)) continue;
      try { process.kill(-group.pgid, 'SIGTERM'); } catch { /* Absence verified below. */ }
    }
    const deadline = Date.now() + CLEANUP_MS;
    while ([...registered.values()].some(row => !groupGone(row.pgid)) && Date.now() < deadline) {
      if (Date.now() >= deadline - CLEANUP_MS / 2) for (const row of registered.values()) if (ownedGroupSignalTarget(row)) { try { process.kill(-row.pgid, 'SIGKILL'); } catch { /* Observation remains decisive. */ } }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await new Promise<void>(resolve => server.close(() => resolve())); if (fd >= 0) closeSync(fd); rmSync(directory, { recursive: true, force: true });
    if (machineReservationResidualsPresent(owner.ticket)) throw machineCleanupFailure(owner,registered.values(),pendingChildren.values(),callbackStarted,callbackThrew,callbackError,callbackResult);
    rmSync(join(owner.ticket, VALIDATION_DELEGATION_RESIDUAL_FILE), { force: true });
  }
}

/** A worker must receive its real launcher ACK AND confirm live enrollment before importing test code. */
export async function confirmValidationReservationRegistration(options: ValidationReservationHandshakeOptions = {}): Promise<void> {
  const bootstrap=readBootstrap(); if(!bootstrap)return;
  const bounded=handshake(bootstrap,options);const result=await request(bootstrap,{operation:'confirm',deadlineAt:bounded.deadlineAt},bounded.signal);result.socket.end();
}

/** Publish an owned unknown-child fence before the actual spawn; never an admission grant. */
export async function prepareValidationReservationChild(options: ValidationReservationHandshakeOptions = {}): Promise<string | undefined> {
 const frame=frames.getStore();if(frame&&!frame.active)throw failure('inactive spawn invocation');if(frame?.prepare){handshake(frame.bootstrap,options);return frame.prepare();}const bootstrap=frame?.bootstrap??readBootstrap();if(!bootstrap)return undefined;
 const bounded=handshake(bootstrap,options);const result=await request(bootstrap,{operation:'prepare',parentGrantId:frame?.grantId,deadlineAt:bounded.deadlineAt},bounded.signal);result.socket.end();if(!result.grant.pendingToken || typeof result.grant.cleanupCapability!=='string')throw failure('pending spawn cleanup material absent');cleanupCapabilities.set(result.grant.pendingToken,{reservation:bootstrap.lockId,capability:result.grant.cleanupCapability});return result.grant.pendingToken;
}
/** Marks an owned pending fence as spawn-attempted immediately before the spawn call. An unmarked fence of a provably gone owner is the only targetless fence that ever resolves. */
export async function attemptValidationReservationSpawn(token: string | undefined, options: ValidationReservationHandshakeOptions = {}): Promise<void> {
 if(!token)return;const frame=frames.getStore();if(frame&&!frame.active)throw failure('inactive spawn invocation');
 if(frame?.attempt){frame.attempt(token);return;}
 const bootstrap=frame?.bootstrap??readBootstrap();if(!bootstrap)return;
 const cleanup=cleanupCapabilities.get(token);if(!cleanup || cleanup.reservation!==bootstrap.lockId)throw failure('pending mutation capability unavailable');
 const bounded=handshake(bootstrap,options);const result=await request(bootstrap,{operation:'attempt',pendingToken:token,cleanupCapability:cleanup.capability,deadlineAt:bounded.deadlineAt},bounded.signal);result.socket.end();
}
/** Notes the spawned PID on an owned, marked fence immediately after the spawn call returns; a fence whose owner then dies before registering resolves once that PID and its whole group are proven absent. */
export async function noteValidationReservationSpawn(token: string | undefined, pid: number, options: ValidationReservationHandshakeOptions = {}): Promise<void> {
 if(!token)return;const frame=frames.getStore();if(frame&&!frame.active)throw failure('inactive spawn invocation');
 if(frame?.spawned){frame.spawned(token,pid);return;}
 const bootstrap=frame?.bootstrap??readBootstrap();if(!bootstrap)return;
 const cleanup=cleanupCapabilities.get(token);if(!cleanup || cleanup.reservation!==bootstrap.lockId)throw failure('pending mutation capability unavailable');
 const bounded=handshake(bootstrap,options);const result=await request(bootstrap,{operation:'spawned',pendingToken:token,cleanupCapability:cleanup.capability,spawnedPid:pid,deadlineAt:bounded.deadlineAt},bounded.signal);result.socket.end();
}
/** Only the caller that proved no child was spawned may cancel its own pending fence. */
export async function cancelValidationReservationChild(token:string | undefined, options: ValidationReservationHandshakeOptions = {}): Promise<void> {
 if(!token)return;const frame=frames.getStore();
 const deadlineAt=Math.min(options.deadlineAt??Infinity,Date.now()+CLEANUP_MS);
 if(options.signal?.aborted||Date.now()>=deadlineAt||frame&&!frame.active)throw failure('cleanup invocation expired/revoked');
 if(frame?.cancel){frame.cancel(token);return;}
 const bootstrap=frame?.bootstrap??readBootstrap(FD,true);if(!bootstrap)throw failure('pending spawn owner missing');
 const cleanup=cleanupCapabilities.get(token);if(!cleanup || cleanup.reservation!==bootstrap.lockId)throw failure('cleanup capability unavailable');
 // The capability is released whether the withdrawal was applied or refused; a refused registration keeps it only until this withdrawal.
 try{const result=await request(bootstrap,{operation:'cancel',pendingToken:token,cleanupCapability:cleanup.capability,deadlineAt},options.signal);result.socket.end();}finally{cleanupCapabilities.delete(token);}
}

export function inheritedValidationReservationPortAlreadyHeld(key:string): boolean { const frame=frames.getStore();return frame?.active===true&&!frame.abort.signal.aborted&&frame.heldPorts?.includes(key)===true; }
/** The deadline of the live grant an inherited invocation runs under: the ceiling at which its revocation kills the command. Undefined for a controller's own command and outside delegation. */
export function currentValidationReservationDeadline(): number | undefined { const frame=frames.getStore();return frame?.active===true&&!frame.abort.signal.aborted&&frame.deadlineAt!==undefined?frame.deadlineAt:undefined; }
