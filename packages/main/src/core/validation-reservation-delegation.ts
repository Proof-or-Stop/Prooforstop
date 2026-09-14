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
import { observedProcessStartTimeMs } from './mkdir-lock.js';
import { canonicalizeEntries, claimsConflict, type ResourceClaim } from './keyed-scheduler.js';
import { inspectMachineReservationOwner } from './validation-execution-lock.js';

// The descriptor is a locator, never an environment credential. Its object must
// also be held by the independently verified live machine reservation owner.
const FD = policy.descriptor, ENV = policy.descriptorEnvironment, LIMIT = policy.maxMessageBytes, CLEANUP_MS = policy.cleanupMs;
export const VALIDATION_DELEGATION_RESIDUAL_FILE = artifacts.residualFile;
type ProcessIdentity = { pid: number; start: number; pgid: number };
export interface MachineReservationOwner { ticket: string; lockId: string; pid: number; start: number; deadlineAt: number; resources: ResourceClaim[] | null }
type Bootstrap = MachineReservationOwner & { schema: 'validation-reservation-delegation.v1'; rootFd: number; publicKey: string; socket: string };
type Request = { operation: 'grant' | 'register' | 'confirm' | 'prepare' | 'cancel'; pid: number; start: number; nonce: string; deadlineAt: number; resources?: ResourceClaim[] | null; targetPid?: number; parentGrantId?: string; pendingToken?: string; cleanupCapability?: string };
type Grant = { reservation: string; subject: ProcessIdentity; nonce: string; operation: Request['operation']; resources: ResourceClaim[] | null; deadlineAt: number; heldPorts?: string[]; grantId: string; pendingToken?: string; cleanupCapability?: string };
export interface ValidationReservationHandshakeOptions { deadlineAt?: number; signal?: AbortSignal }
type Frame = { heldPorts?: string[]; grantId?: string; active: boolean; resources: ResourceClaim[] | null; fd: number; bootstrap: Bootstrap; abort: AbortController; register?: (pid: number, pendingToken?: string) => void; prepare?: () => string; cancel?: (token: string) => void };
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
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: policy.kernelObservationMs, maxBuffer: 8 * 1024 * 1024 });
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
function ancestors(pid: number): number[] {
  const rows = table(), seen = new Set<number>(); let next = rows.get(pid)?.ppid;
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
function groupGone(pgid: number): boolean {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return false;
  try { process.kill(-pgid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
/** Resolve an unobserved target only when neither its PID nor group exists. */
function registrationTargetGone(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
  }
  return groupGone(pid);
}
function descriptor(pid: number, fd: number): { dev: bigint; ino: bigint } {
  if (process.platform !== policy.platform) throw failure('kernel descriptor observation unsupported');
  const raw = execFileSync('/usr/sbin/lsof', ['-n', '-P', '-a', '-p', String(pid), '-d', String(fd), '-F', 'paftDi'], { encoding: 'utf8', timeout: policy.kernelObservationMs, maxBuffer: LIMIT });
  const rows = raw.trim().split('\n');
  if (rows.filter(x => x.startsWith('p')).join() !== 'p' + pid || rows.filter(x => x.startsWith('f')).join() !== 'f' + fd || !rows.includes('tREG') || !rows.includes('ar')) throw failure('kernel descriptor identity ambiguous');
  const dev = rows.filter(x => x.startsWith('D')), ino = rows.filter(x => x.startsWith('i'));
  if (dev.length !== 1 || ino.length !== 1) throw failure('kernel descriptor fields unavailable');
  return { dev: BigInt(dev[0].slice(1)), ino: BigInt(ino[0].slice(1)) };
}
function readBootstrap(fd: number = FD, cleanupOnly = false): Bootstrap | undefined {
  if (!frames.getStore() && process.env[ENV] === undefined) return undefined;
  if (!frames.getStore() && process.env[ENV] !== String(FD)) throw failure('invalid descriptor locator');
  let stat; try { stat = fstatSync(fd, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EBADF') throw failure('missing inherited descriptor'); throw error; }
  // A foreign fd at the reserved slot is not silently treated as no delegation.
  if (!stat.isFile() || stat.nlink !== 0n || stat.size <= 0n || stat.size > BigInt(LIMIT)) throw failure('bootstrap is not a bounded unlinked regular descriptor');
  const buffer = Buffer.alloc(Number(stat.size)); if (readSync(fd, buffer, 0, buffer.length, 0) !== buffer.length) throw failure('bootstrap incomplete');
  const value = JSON.parse(buffer.toString('utf8')) as Bootstrap;
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
  return bootstrap ? { ...base, [ENV]: String(FD) } : base;
}
export function currentValidationReservationAbortSignal(): AbortSignal | undefined { return frames.getStore()?.abort.signal; }
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
          if (!verifyCanonical(grant, response.signature, bootstrap.publicKey) || grant.reservation !== bootstrap.lockId || grant.subject.pid !== self.pid || grant.subject.start !== self.start || grant.nonce !== nonce || grant.operation !== input.operation || JSON.stringify(grant.resources) !== JSON.stringify(input.resources ?? null) || grant.deadlineAt > (input.operation === 'cancel' ? input.deadlineAt : Math.min(bootstrap.deadlineAt, input.deadlineAt)) || Date.now() >= grant.deadlineAt) throw failure('grant subject/binding/signature');
          const fresh = readBootstrap(frames.getStore()?.fd ?? FD, input.operation === 'cancel'); if (!fresh || fresh.publicKey !== bootstrap.publicKey || !sameProcess(self)) throw failure('grant owner changed');
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
  const frame: Frame = { active: true, heldPorts: response.grant.heldPorts ?? [], grantId: response.grant.grantId, resources, fd: FD, bootstrap, abort };
  try { if (signal?.aborted || abort.signal.aborted || response.socket.destroyed || Date.now() >= response.grant.deadlineAt) throw failure('grant revoked before entry'); return { inherited: true, value: await frames.run(frame, fn) }; }
  finally { frame.active = false; clearTimeout(timer); signal?.removeEventListener('abort', forward); response.socket.removeListener('close', revoke); response.revocation.removeEventListener('abort', revoke); response.socket.end(JSON.stringify({release:response.grant.grantId})+'\n'); }
}
/** Machine-only stale fence. Unknown records retain capacity; no foreign process is signaled. */
export function machineReservationResidualsPresent(ticket: string): boolean {
  const path = join(ticket, VALIDATION_DELEGATION_RESIDUAL_FILE); if (!existsSync(path)) return false;
  try { const rows = JSON.parse(readFileSync(path, 'utf8')); if (!Array.isArray(rows)) return true; return rows.some(row => {
    if (row.pending !== undefined) { const target=row.target;return !target || target.pid!==target.pgid || !Number.isFinite(target.start) || !registrationTargetGone(target.pid); }
    return !Number.isSafeInteger(row.pgid) || !groupGone(row.pgid);
  }); } catch { return true; }
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
  const admitted=inspectMachineReservationOwner(owner.ticket,owner.lockId);
  if(!isLive()||!admitted||admitted.pid!==process.pid||admitted.start!==owner.start||JSON.stringify(admitted.resources)!==JSON.stringify(owner.resources))throw failure('controller owner/declaration mismatch');
  const keys = generateEd25519KeyPair(), directory = mkdtempSync(join(tmpdir(), artifacts.temporaryPrefix)), socketPath = join(directory, artifacts.socketFile);
  const bootstrapPath = join(directory, artifacts.bootstrapFile);
  const pendingChildren = new Map<string,{pid:number;start:number;parents:string[];target?:ProcessIdentity;cleanupCapability:string}>();
  const registered = new Map<number, ProcessIdentity & { parents: string[] }>(), active = new Map<Socket, { subject: ProcessIdentity; resources: ResourceClaim[] | null; grantId: string; parents: string[]; deadlineAt: number; revoked?: boolean; terminal?: boolean; disconnected?: boolean }>();
  const grantTimers = new Map<Socket, NodeJS.Timeout>();
  const sockets = new Set<Socket>(), pending: Array<{ socket: Socket; input: Request }> = [];
  let alive = true, fd = -1; let frame: Frame | undefined;
  let callbackStarted=false, callbackThrew=false, callbackError:unknown, callbackResult:unknown;
  const abort = new AbortController();
  const live = () => alive && isLive() && Date.now() < owner.deadlineAt;
  const publish = () => { const path = join(owner.ticket, VALIDATION_DELEGATION_RESIDUAL_FILE); writeFileSync(path + '.pending', JSON.stringify([...registered.values(),...[...pendingChildren].map(([pending,subject])=>({pending,pid:subject.pid,start:subject.start,parents:subject.parents,...(subject.target?{target:subject.target}:{})}))]), { mode: 0o600 }); renameSync(path + '.pending', path); };
  const enrollment = (subject: ProcessIdentity): string[] => {
    if (!sameProcess(subject)) throw failure('request process changed');
    for (const pid of [subject.pid,...ancestors(subject.pid)]) { const known=registered.get(pid); if (!known || !sameProcess(known)) continue;
      if (known.parents.some(id=>![...active.values()].some(grant=>grant.grantId===id && !grant.revoked && Date.now()<grant.deadlineAt))) throw failure('parent invocation released');
      return [...known.parents];
    }
    throw failure('unenrolled request subject');
  };
  const prepare = (subject=identity(process.pid),parents:string[]=[]):string => {if(!live())throw failure('reservation closed before spawn');const token=randomUUID();pendingChildren.set(token,{pid:subject.pid,start:subject.start,parents,cleanupCapability:randomUUID()});publish();return token;};
  const cancel=(token:string,subject=identity(process.pid)):void=>{const pending=pendingChildren.get(token);if(!pending||pending.pid!==subject.pid||pending.start!==subject.start)throw failure('pending spawn not owned');pendingChildren.delete(token);publish();};
  const register = (pid: number, parent = process.pid, parents: string[] = [], pendingToken?: string) => {
    if (!live()) throw failure('registration after release');
    const pending=pendingToken && pendingChildren.get(pendingToken);if(!pending||pending.pid!==parent||pending.start!==observedProcessStartTimeMs(parent))throw failure('registration has no owned pre-spawn fence');
    const inheritedParents=[...new Set([...pending.parents,...parents])];
    if(inheritedParents.some(id=>![...active.values()].some(grant=>grant.grantId===id&&!grant.revoked&&Date.now()<grant.deadlineAt)))throw failure('pending parent invocation released');
    if(pending.target && pending.target.pid!==pid)throw failure('pending target is immutable');
    if(registrationTargetGone(pid)){pendingChildren.delete(pendingToken!);publish();return;}
    if(registered.has(pid))throw failure('child enrollment is immutable');
    let target: ProcessIdentity;
    try { target = identity(pid); } catch (error) {
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
      if (!ancestors(pid).includes(parent)) throw failure('registration requires observed pre-orphan ancestry');
    } catch (error) {
      if (!registrationTargetGone(pid)) throw error;
      pendingChildren.delete(pendingToken!); publish(); return;
    }
    // Identity and real pre-orphan ancestry are proven before persisting an
    // owned target. An earlier unavailable observation leaves the fence unknown.
    pending.target=target;publish();
    registered.set(pid, { ...target, parents:inheritedParents });pendingChildren.delete(pendingToken!); publish();
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
    if(!terminal || !sameProcess(subject))return !groupGone(subject.pgid);
    try {
      const rows=table(), ancestors=new Set<number>();let next=rows.get(subject.pid)?.ppid;
      if(!rows.has(subject.pid))return true;
      while(next&&next>1&&!ancestors.has(next)){ancestors.add(next);next=rows.get(next)?.ppid;}
      return [...rows.values()].some(row=>row.pgid===subject.pgid&&row.pid!==subject.pid&&!ancestors.has(row.pid));
    }catch{return true;}
  };
  const retireReleasedGrants = () => {
    for (const [socket, grant] of [...active].reverse()) {
      if (!grant.disconnected) continue;
      const pendingWork=[...pendingChildren.values()].some(row=>row.parents.includes(grant.grantId));
      const descendantGrants=[...active.values()].some(row=>row!==grant&&row.parents.includes(grant.grantId));
      const descendantsRemain = [...registered.values()].some(row=>row.parents.includes(grant.grantId) && !groupGone(row.pgid));
      if(pendingWork||descendantGrants||descendantsRemain||subjectGroupWorkPresent(grant.subject,grant.terminal===true))continue;
      active.delete(socket); clearTimeout(grantTimers.get(socket)); grantTimers.delete(socket);
    }
  };
  const drain = () => {
    let resolved=false;for(const [token,row]of pendingChildren)if(row.target && registrationTargetGone(row.target.pid)){pendingChildren.delete(token);resolved=true;}
    if(resolved)publish();
    retireReleasedGrants();
    for (const item of [...pending]) {
      const { socket, input } = item; if (socket.destroyed) { pending.splice(pending.indexOf(item), 1); continue; }
      try {
        if (!live() || Date.now() >= input.deadlineAt) throw failure('reservation/request expired');
        const subject = identity(input.pid); if (subject.start !== input.start) throw failure('request subject changed'); const parents=enrollment(subject);
        const resources = input.resources ?? null;
        if(resources!==null && (!Array.isArray(resources)||JSON.stringify(canonicalizeEntries([{name:'delegated-machine-claims',resources}],'/')[0].resources)!==JSON.stringify(resources)))throw failure('machine claims must be canonical');
        if (!subset(resources, owner.resources)) throw failure('resource expansion');
        if(input.parentGrantId){const parent=[...active.values()].find(row=>row.grantId===input.parentGrantId&&!row.revoked&&Date.now()<row.deadlineAt&&row.subject.pid===subject.pid&&row.subject.start===subject.start);if(!parent||!subset(resources,parent.resources))throw failure('parent grant/claim mismatch');parents.push(...parent.parents,parent.grantId);}
        if ([...active.values()].some(prior => conflict(prior.resources, resources) && !(parents.includes(prior.grantId) && subset(resources, prior.resources)))) continue;
        pending.splice(pending.indexOf(item), 1);
        const grant: Grant = { reservation: owner.lockId, subject, nonce: input.nonce, operation: input.operation, resources, deadlineAt: Math.min(owner.deadlineAt, input.deadlineAt, ...[...active.values()].filter(prior=>parents.includes(prior.grantId)).map(prior=>prior.deadlineAt)), grantId: randomUUID() };
        grant.heldPorts=(resources??[]).filter(row=>row.class==='fixed-port'&&row.access==='exclusive'&&[owner.resources,...[...active.values()].filter(prior=>parents.includes(prior.grantId)).map(prior=>prior.resources)].some(rows=>rows?.some(prior=>prior.class==='fixed-port'&&prior.access==='exclusive'&&prior.key===row.key))).map(row=>row.key);
        active.set(socket, { subject, resources, parents, grantId: grant.grantId, deadlineAt: grant.deadlineAt });
        grantTimers.set(socket,setTimeout(()=>{revokeGrant(grant.grantId);drain();},Math.max(1,grant.deadlineAt-Date.now())));
        socket.write(JSON.stringify({ grant, signature: signCanonical(grant, keys.privateKey) }) + '\n');
      } catch (error) { pending.splice(pending.indexOf(item), 1); socket.end(JSON.stringify({ error: String(error) }) + '\n'); }
    }
  };
  const server = createServer(socket => {
    sockets.add(socket); let bytes = '', received = false;
    socket.on('error', () => undefined); socket.once('close', () => {
      sockets.delete(socket); const released = active.get(socket);
      if (released) { released.disconnected=true; revokeGrant(released.grantId); }
      drain();
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
        const subject = identity(input.pid); if (subject.start !== input.start) throw failure('request subject changed');
        // Cleanup only removes this exact subject's pending token. It neither
        // obtains a grant nor inherits admission from revoked parents.
        if (input.operation === 'cancel') {
          if (Date.now() >= input.deadlineAt || input.deadlineAt > Date.now() + CLEANUP_MS) throw failure('cleanup deadline');
          const ownedPending=input.pendingToken && pendingChildren.get(input.pendingToken);
          if(!ownedPending || typeof input.cleanupCapability!=='string' || input.cleanupCapability!==ownedPending.cleanupCapability)throw failure('cleanup capability not owned');
          cancel(input.pendingToken!, subject);
          const grant: Grant = {reservation:owner.lockId,subject,nonce:input.nonce,operation:'cancel',resources:null,deadlineAt:input.deadlineAt,grantId:randomUUID()};
          socket.write(JSON.stringify({grant,signature:signCanonical(grant,keys.privateKey)})+'\n');return;
        }
        const parents=enrollment(subject);
        if (input.operation === 'register') {
          const ownedPending=input.pendingToken && pendingChildren.get(input.pendingToken);
          if(!ownedPending || typeof input.cleanupCapability!=='string' || input.cleanupCapability!==ownedPending.cleanupCapability)throw failure('pending mutation capability not owned');
          if (input.parentGrantId) { const parent=[...active.values()].find(row=>row.grantId===input.parentGrantId && !row.revoked && Date.now()<row.deadlineAt && row.subject.pid===subject.pid && row.subject.start===subject.start); if(!parent)throw failure('parent invocation not owned'); parents.push(...parent.parents,parent.grantId); }
          register(input.targetPid!, subject.pid, [...new Set(parents)],input.pendingToken);
          const grant: Grant = { reservation: owner.lockId, subject, nonce: input.nonce, operation: input.operation, resources: null, deadlineAt: Math.min(owner.deadlineAt, input.deadlineAt), grantId: randomUUID() };
          socket.write(JSON.stringify({ grant, signature: signCanonical(grant, keys.privateKey) }) + '\n');
        } else if (input.operation === 'prepare') {
          if(input.parentGrantId){const parent=[...active.values()].find(row=>row.grantId===input.parentGrantId&&!row.revoked&&Date.now()<row.deadlineAt&&row.subject.pid===subject.pid&&row.subject.start===subject.start);if(!parent)throw failure('pending parent invocation not owned');parents.push(...parent.parents,parent.grantId);}
          const pendingToken=prepare(subject,[...new Set(parents)]);
          const grant: Grant={reservation:owner.lockId,subject,nonce:input.nonce,operation:input.operation,resources:null,deadlineAt:Math.min(owner.deadlineAt,input.deadlineAt),grantId:randomUUID(),...(pendingToken?{pendingToken,cleanupCapability:pendingChildren.get(pendingToken)!.cleanupCapability}:{})};socket.write(JSON.stringify({grant,signature:signCanonical(grant,keys.privateKey)})+'\n');
        } else if (input.operation === 'confirm') {
          const grant: Grant={reservation:owner.lockId,subject,nonce:input.nonce,operation:input.operation,resources:null,deadlineAt:Math.min(owner.deadlineAt,input.deadlineAt),grantId:randomUUID()};socket.write(JSON.stringify({grant,signature:signCanonical(grant,keys.privateKey)})+'\n');
        } else if (input.operation === 'grant') { pending.push({ socket, input }); drain(); } else throw failure('unknown operation');
      } catch (error) { socket.end(JSON.stringify({ error: String(error) }) + '\n'); }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  const retirementTimer=setInterval(drain,20);retirementTimer.unref();
  try {
    // Reserve the descriptor number before writing the self-describing envelope;
    // only the separately reopened read-only descriptor is ever inherited.
    writeFileSync(bootstrapPath, '', { mode: 0o600 }); fd = openSync(bootstrapPath, constants.O_RDONLY);
    const bootstrap: Bootstrap = { ...owner, schema: 'validation-reservation-delegation.v1', rootFd: fd, publicKey: keys.publicKey, socket: socketPath };
    writeFileSync(bootstrapPath, JSON.stringify(bootstrap)); unlinkSync(bootstrapPath);
    frame={active:true,resources:owner.resources,fd,bootstrap,abort,register:(pid,token)=>register(pid,process.pid,[],token),prepare:()=>prepare(),cancel:token=>cancel(token)};
    try {callbackStarted=true;const result=await frames.run(frame, fn);callbackResult=result;return result;}catch(error){callbackThrew=true;callbackError=error;throw error;}
  } finally {
    alive = false; clearInterval(retirementTimer); for(const timer of grantTimers.values())clearTimeout(timer); if(frame)frame.active=false; abort.abort(failure('reservation ended')); for (const socket of sockets) socket.destroy();
    for (const group of registered.values()) {
      if (groupGone(group.pgid)) continue;
      // Only previously observed owned group leaders are signal targets.
      if (group.pid !== group.pgid || !sameProcess(group)) continue;
      try { process.kill(-group.pgid, 'SIGTERM'); } catch { /* Absence verified below. */ }
    }
    const deadline = Date.now() + CLEANUP_MS;
    while ([...registered.values()].some(row => !groupGone(row.pgid)) && Date.now() < deadline) {
      if (Date.now() >= deadline - CLEANUP_MS / 2) for (const row of registered.values()) if (row.pid === row.pgid && sameProcess(row) && !groupGone(row.pgid)) { try { process.kill(-row.pgid, 'SIGKILL'); } catch { /* Observation remains decisive. */ } }
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
/** Only the caller that proved no child was spawned may cancel its own pending fence. */
export async function cancelValidationReservationChild(token:string | undefined, options: ValidationReservationHandshakeOptions = {}): Promise<void> {
 if(!token)return;const frame=frames.getStore();
 const deadlineAt=Math.min(options.deadlineAt??Infinity,Date.now()+CLEANUP_MS);
 if(options.signal?.aborted||Date.now()>=deadlineAt||frame&&!frame.active)throw failure('cleanup invocation expired/revoked');
 if(frame?.cancel){frame.cancel(token);return;}
 const bootstrap=frame?.bootstrap??readBootstrap(FD,true);if(!bootstrap)throw failure('pending spawn owner missing');
 const cleanup=cleanupCapabilities.get(token);if(!cleanup || cleanup.reservation!==bootstrap.lockId)throw failure('cleanup capability unavailable');
 const result=await request(bootstrap,{operation:'cancel',pendingToken:token,cleanupCapability:cleanup.capability,deadlineAt},options.signal);result.socket.end();cleanupCapabilities.delete(token);
}

export function inheritedValidationReservationPortAlreadyHeld(key:string): boolean { const frame=frames.getStore();return frame?.active===true&&!frame.abort.signal.aborted&&frame.heldPorts?.includes(key)===true; }
