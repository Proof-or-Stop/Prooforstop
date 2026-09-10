import { REVIEWER_BATCH_ADMISSION_RUNTIME_POLICY as policy } from './runtime-fact-registry.js';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { acquireMkdirLock, type AcquiredMkdirLock } from './mkdir-lock.js';
import { signValidationArtifact, verifyValidationArtifact } from './validation-artifact-signing.js';
import { REVIEWER_BATCH_ADMISSION_ARTIFACT, resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';

export type ReviewerBatchAssignment = { lane: string; kind: 'managed'; host: string } | { lane: string; kind: 'native'; host?: never };
export interface ReviewerBatchInputs {
  /** Derived verified subject, not a caller batch ID. Include physical worktree identity. */
  subjectIdentity: string;
  assignments: ReviewerBatchAssignment[];
  /** Only keyed/redacted input identities; never secret bytes or transcripts. */
  executionIdentity: Record<string, unknown>;
}
export interface ReviewerBatchProbeObservation {
  host: string;
  inputIdentity: string;
  status: 'READY' | 'BLOCKED' | 'UNKNOWN';
  failureKind?: 'auth' | 'executable' | 'timeout' | 'interactive' | 'unknown';
}
interface StoredObservation { host: string; status: ReviewerBatchProbeObservation['status']; failureKind: string | null; }
export interface ReviewerBatchAdmissionRecord {
  schema: 'reviewer-batch-admission.v1';
  subject: string;
  identity: string;
  generation: number;
  state: 'CHECKING' | 'ADMITTED' | 'BLOCKED';
  startedAt: number;
  ownerPid: number;
  hosts: string[];
  observations: StoredObservation[];
  reason?: string;
  revokedHost?: string;
  completedAt?: number;
  expiresAt?: number;
}
export type ReviewerBatchAdmissionResult = ReviewerBatchAdmissionRecord | { state: 'UNKNOWN'; reason: string };
export interface ReviewerBatchAdmissionDependencies {
  gitCwd: string;
  /** Trusted producer dependency: verifies subject and complete required roster. */
  deriveInputs(): ReviewerBatchInputs | Promise<ReviewerBatchInputs>;
  /** Trusted canonical supervised probe producer, not a CLI-supplied READY fact. */
  probeHost(host: string, inputs: ReviewerBatchInputs, signal: AbortSignal | undefined, context: { generation: number; subject: string; identity: string }): Promise<ReviewerBatchProbeObservation>;
  maxWaitMs?: number;
  readyTtlMs?: number;
}
interface InputSnapshot { value: ReviewerBatchInputs; identity: string; subject: string; }
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
}
export function reviewerBatchInputIdentity(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted) finish();
  });
}
const unknown = (reason: string): ReviewerBatchAdmissionResult => ({ state: 'UNKNOWN', reason });

/** Operational admission only; it cannot create ReviewRun/pass or promote a native lane to managed. */
export function createReviewerBatchAdmissionController(deps: ReviewerBatchAdmissionDependencies): {
  admit(options?: { signal?: AbortSignal; retryFromGeneration?: number }): Promise<ReviewerBatchAdmissionResult>;
  read(): Promise<ReviewerBatchAdmissionResult>;
} {
  const gitCwd = realpathSync(deps.gitCwd);
  const runtimeDirectory = join(resolveCanonicalRuntimeProjectRoot(gitCwd), PROOF_OR_STOP_DIR, 'runtime', REVIEWER_BATCH_ADMISSION_ARTIFACT.directoryName);
  const maxWaitMs = deps.maxWaitMs ?? policy.maxWaitMs, readyTtlMs = deps.readyTtlMs ?? policy.readyTtlMs;
  if (!Number.isFinite(maxWaitMs) || maxWaitMs < 0 || !Number.isFinite(readyTtlMs) || readyTtlMs <= 0) throw new Error('invalid batch admission timing');
  const input = async (): Promise<InputSnapshot> => {
    const value = await deps.deriveInputs();
    if (!value || typeof value.subjectIdentity !== 'string' || !value.subjectIdentity || !Array.isArray(value.assignments)
      || !value.assignments.length || !value.executionIdentity || typeof value.executionIdentity !== 'object') throw new Error('batch inputs unavailable');
    const lanes = new Set<string>();
    for (const row of value.assignments) {
      if (!row || typeof row.lane !== 'string' || !row.lane || lanes.has(row.lane) || !['managed', 'native'].includes(row.kind)
        || (row.kind === 'managed' && (typeof row.host !== 'string' || !row.host)) || (row.kind === 'native' && row.host !== undefined)) throw new Error('invalid batch assignment');
      lanes.add(row.lane);
    }
    const frozen = JSON.parse(canonical({ ...value, assignments: [...value.assignments].sort((a, b) => a.lane.localeCompare(b.lane)) })) as ReviewerBatchInputs;
    return { value: frozen, identity: reviewerBatchInputIdentity(frozen), subject: reviewerBatchInputIdentity(value.subjectIdentity) };
  };
  const readSigned = (file: string): ReviewerBatchAdmissionRecord | undefined => {
    try {
      const { signature, ...body } = JSON.parse(readFileSync(file, 'utf8'));
      if (body.schema !== 'reviewer-batch-admission.v1' || !['CHECKING', 'ADMITTED', 'BLOCKED'].includes(body.state)
        || !Number.isSafeInteger(body.generation) || body.generation < 1 || !Array.isArray(body.hosts) || !Array.isArray(body.observations)
        || (body.state === 'ADMITTED' && (!Number.isFinite(body.expiresAt) || body.observations.length !== body.hosts.length
          || !body.hosts.every((host: string) => body.observations.some((row: StoredObservation) => row.host === host && row.status === 'READY'))))
        || !verifyValidationArtifact(body, signature, gitCwd)) return undefined;
      return body as ReviewerBatchAdmissionRecord;
    } catch { return undefined; }
  };
  const sign = (body: ReviewerBatchAdmissionRecord) => ({ ...body, signature: signValidationArtifact(body, gitCwd) });
  const writeAtomic = (file: string, body: ReviewerBatchAdmissionRecord) => {
    const temporary = file + '.' + randomUUID();
    writeFileSync(temporary, JSON.stringify(sign(body)), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  };
  const location = (snapshot: InputSnapshot) => join(runtimeDirectory, snapshot.subject);
  const verdict = (record: ReviewerBatchAdmissionRecord | undefined, snapshot: InputSnapshot): ReviewerBatchAdmissionResult => {
    if (!record || record.identity !== snapshot.identity || record.subject !== snapshot.subject) return unknown('missing-or-invalid-current-admission');
    const revocationFile = join(location(snapshot), `generation-${record.generation}-revocation.json`);
    if (existsSync(revocationFile)) {
      const revoked = readSigned(revocationFile);
      if (!revoked || revoked.identity !== record.identity || revoked.generation !== record.generation
        || revoked.subject !== record.subject || revoked.state !== 'BLOCKED'
        || revoked.reason !== 'provider-auth-revoked') return unknown('invalid-current-revocation');
      return revoked;
    }
    if (record.state === 'ADMITTED' && Date.now() >= record.expiresAt!) return { ...record, state: 'BLOCKED', reason: 'admission-expired' };
    return record;
  };
  const read = async (): Promise<ReviewerBatchAdmissionResult> => {
    const snapshot = await input();
    return verdict(readSigned(join(location(snapshot), 'active.json')), snapshot);
  };
  const admit = async ({ signal, retryFromGeneration }: { signal?: AbortSignal; retryFromGeneration?: number } = {}): Promise<ReviewerBatchAdmissionResult> => {
    if (retryFromGeneration !== undefined && (!Number.isSafeInteger(retryFromGeneration) || retryFromGeneration < 1)) throw new Error('invalid explicit retry generation');
    if (signal?.aborted) return unknown('admission-cancelled');
    const snapshot = await input(), dir = location(snapshot);
    if (signal?.aborted) return unknown('admission-cancelled');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lockDir = join(dir, 'controller.lock'), until = Date.now() + maxWaitMs;
    let lock: AcquiredMkdirLock | undefined;
    while (!lock) {
      if (signal?.aborted) return unknown('admission-cancelled');
      try {
        lock = acquireMkdirLock(lockDir, {
          failFastIfHeld: true, heldMessage: 'BATCH_CONTROLLER_BUSY', staleMs: policy.lockStaleMs, deadlineMs: policy.lockDeadlineMs, pollMs: policy.lockPollMs, requireHolderToken: true,
          holderInfo: { pid: process.pid, hostname: hostname(), command: 'reviewer batch admission', acquiredAt: new Date().toISOString(), lockId: randomUUID() },
        });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('BATCH_CONTROLLER_BUSY')) throw error;
        if (Date.now() >= until) return unknown('controller-busy');
        await wait(policy.waitPollMs, signal);
      }
    }
    try {
      if (signal?.aborted) return unknown('admission-cancelled');
      const current = await input();
      if (current.identity !== snapshot.identity) return unknown('inputs-changed-before-lock');
      if (signal?.aborted) return unknown('admission-cancelled');
      const file = join(dir, 'active.json');
      let previous = readSigned(file);
      if (existsSync(file) && !previous) return unknown('invalid-persisted-admission');
      const terminal = (body: ReviewerBatchAdmissionRecord): ReviewerBatchAdmissionRecord => {
        writeFileSync(join(dir, `generation-${body.generation}.json`), JSON.stringify(sign(body)), { flag: 'wx', mode: 0o600 });
        writeAtomic(file, body); return body;
      };
      // A checking/terminal record is durable before active.json is renamed.
      // Reconcile that publication window under the same lock, without probing
      // again or deleting an unverified record. Historical files remain intact.
      type GenerationFiles = { checking?: ReviewerBatchAdmissionRecord; terminal?: ReviewerBatchAdmissionRecord; recovery?: ReviewerBatchAdmissionRecord; revocation?: ReviewerBatchAdmissionRecord };
      const generations = new Map<number, GenerationFiles>();
      for (const name of readdirSync(dir)) {
        if (!name.startsWith('generation-')) continue;
        const match = /^generation-([1-9][0-9]*)(-checking|-recovery|-revocation)?\.json$/.exec(name);
        if (!match) return unknown('invalid-generation-filename');
        const generationNumber = Number(match[1]);
        const record = readSigned(join(dir, name));
        if (!Number.isSafeInteger(generationNumber) || !record || record.generation !== generationNumber || record.subject !== snapshot.subject) return unknown('invalid-generation-record');
        const kind = match[2] === '-checking' ? 'checking' : match[2] === '-recovery' ? 'recovery' : match[2] === '-revocation' ? 'revocation' : 'terminal';
        if ((kind === 'revocation' && (record.state !== 'BLOCKED' || record.reason !== 'provider-auth-revoked' || !record.revokedHost || !record.hosts.includes(record.revokedHost))) || (kind === 'checking' && record.state !== 'CHECKING') || (kind === 'terminal' && record.state === 'CHECKING')
          || (kind === 'recovery' && (record.state !== 'BLOCKED' || !['controller-publication-interrupted', 'controller-interrupted'].includes(record.reason ?? '')))) return unknown('invalid-generation-state');
        const group: GenerationFiles = generations.get(generationNumber) ?? {};
        group[kind] = record;
        generations.set(generationNumber, group);
      }
      const ordered = [...generations.keys()].sort((a, b) => a - b);
      for (const [offset, generationNumber] of ordered.entries()) {
        const group = generations.get(generationNumber)!;
        if (generationNumber !== offset + 1 || !group.checking) return unknown('incomplete-generation-history');
        for (const record of [group.terminal, group.recovery, group.revocation]) {
          if (record && (record.identity !== group.checking.identity || record.startedAt !== group.checking.startedAt
            || canonical(record.hosts) !== canonical(group.checking.hosts))) return unknown('generation-binding-mismatch');
        }
      }
      if (previous && (previous.subject !== snapshot.subject || !generations.get(previous.generation)?.checking
        || generations.get(previous.generation)!.checking!.identity !== previous.identity)) return unknown('active-generation-binding-mismatch');
      const latestNumber = ordered.at(-1);
      if (previous && latestNumber !== undefined && previous.generation > latestNumber) return unknown('active-generation-unavailable');
      if (latestNumber !== undefined && (!previous || latestNumber > previous.generation || previous.state === 'CHECKING')) {
        const group = generations.get(latestNumber)!;
        let recovered = group.recovery;
        if (!recovered) {
          recovered = { ...(group.terminal ?? group.checking!), state: 'BLOCKED', reason: previous?.generation === latestNumber && previous.state === 'CHECKING' && !group.terminal ? 'controller-interrupted' : 'controller-publication-interrupted', completedAt: Date.now() };
          writeFileSync(join(dir, `generation-${latestNumber}-recovery.json`), JSON.stringify(sign(recovered)), { flag: 'wx', mode: 0o600 });
        }
        writeAtomic(file, recovered);
        previous = recovered;
        // Even changed current inputs must observe the recovered nonREADY
        // generation once; the next explicit attempt can derive a new one.
        return recovered;
      }
      const revocation = latestNumber !== undefined ? generations.get(latestNumber)?.revocation : undefined;
      if (revocation && previous?.generation === latestNumber) { writeAtomic(file, revocation); previous = revocation; }
      if (retryFromGeneration !== undefined) {
        if (!previous || previous.generation < retryFromGeneration) return unknown('retry-generation-unavailable');
        if (previous.generation > retryFromGeneration) return previous.identity === snapshot.identity
          ? verdict(previous, snapshot) : unknown('retry-already-consumed-with-different-inputs');
        // A still-valid successful admission needs no replacement probe.
        if (previous.identity === snapshot.identity && verdict(previous, snapshot).state === 'ADMITTED') return verdict(previous, snapshot);
      } else if (previous?.identity === snapshot.identity) return verdict(previous, snapshot);
      const generation = (previous?.generation ?? 0) + 1;
      const checking: ReviewerBatchAdmissionRecord = {
        schema: 'reviewer-batch-admission.v1', subject: snapshot.subject, identity: snapshot.identity, generation, state: 'CHECKING', startedAt: Date.now(), ownerPid: process.pid,
        hosts: [...new Set(snapshot.value.assignments.filter((row): row is Extract<ReviewerBatchAssignment, { kind: 'managed' }> => row.kind === 'managed').map(row => row.host))].sort(), observations: [],
      };
      writeFileSync(join(dir, `generation-${generation}-checking.json`), JSON.stringify(sign(checking)), { flag: 'wx', mode: 0o600 });
      writeAtomic(file, checking);
      const observations: StoredObservation[] = await Promise.all(checking.hosts.map(async host => {
        if (signal?.aborted) return { host, status: 'UNKNOWN' as const, failureKind: 'admission-cancelled' };
        try {
          const result = await deps.probeHost(host, snapshot.value, signal, { generation, subject: snapshot.subject, identity: snapshot.identity });
          if (!result || result.host !== host || result.inputIdentity !== snapshot.identity || !['READY', 'BLOCKED', 'UNKNOWN'].includes(result.status)) return { host, status: 'UNKNOWN' as const, failureKind: 'invalid-probe-observation' };
          return { host, status: result.status, failureKind: result.status === 'READY' ? null : ['auth', 'executable', 'timeout', 'interactive', 'unknown'].includes(result.failureKind ?? '') ? result.failureKind! : 'unknown' };
        } catch { return { host, status: 'UNKNOWN' as const, failureKind: 'probe-threw' }; }
      }));
      const after = await input();
      const ready = !signal?.aborted && after.identity === snapshot.identity && observations.every(row => row.status === 'READY');
      return terminal({ ...checking, state: ready ? 'ADMITTED' : 'BLOCKED', reason: signal?.aborted ? 'admission-cancelled' : after.identity !== snapshot.identity ? 'inputs-changed-during-probe' : ready ? 'all-hosts-ready' : 'host-readiness-blocked', completedAt: Date.now(), expiresAt: Date.now() + readyTtlMs, observations });
    } finally { lock.release(); }
  };
  return Object.freeze({ admit, read });
}

/** Trusted producer only; deterministic provider auth result is classified by worker. */
export async function revokeReviewerBatchAdmission(args: {
  gitCwd: string;
  subjectIdentity: string;
  identity: string;
  generation: number;
  host: string;
}): Promise<ReviewerBatchAdmissionResult> {
  const root = realpathSync(args.gitCwd), subject = reviewerBatchInputIdentity(args.subjectIdentity);
  const dir = join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', REVIEWER_BATCH_ADMISSION_ARTIFACT.directoryName, subject);
  const until = Date.now() + policy.maxWaitMs;
  let lock: AcquiredMkdirLock | undefined;
  while (!lock) {
    try {
      lock = acquireMkdirLock(join(dir, 'controller.lock'), {
        failFastIfHeld: true, heldMessage: 'BATCH_CONTROLLER_BUSY',
        staleMs: policy.lockStaleMs, deadlineMs: policy.lockDeadlineMs,
        pollMs: policy.lockPollMs, requireHolderToken: true,
        holderInfo: {
          pid: process.pid, hostname: hostname(), command: 'reviewer batch auth revocation',
          acquiredAt: new Date().toISOString(), lockId: randomUUID(),
        },
      });
    }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes('BATCH_CONTROLLER_BUSY'))
        throw error;
      if (Date.now() >= until)
        return unknown('controller-busy');
      await wait(policy.waitPollMs);
    }
  }
  try {
    const read = (file: string): ReviewerBatchAdmissionRecord => {
      const { signature, ...body } = JSON.parse(readFileSync(file, 'utf8'));
      if (!verifyValidationArtifact(body, signature, root) || body.schema !== 'reviewer-batch-admission.v1') {
        throw new Error('invalid revocation input');
      }
      return body;
    };
    const active = join(dir, 'active.json'), current = read(active);
    if (current.subject !== subject || current.generation !== args.generation || current.identity !== args.identity)
      return unknown('revocation-generation-not-current');
    if (!Array.isArray(current.hosts) || !current.hosts.includes(args.host))
      throw new Error('revocation host not admitted');
    const target = join(dir, `generation-${args.generation}-revocation.json`);
    let revoked: ReviewerBatchAdmissionRecord;
    if (existsSync(target)) {
      revoked = read(target);
      if (revoked.subject !== subject || revoked.identity !== args.identity
        || revoked.generation !== args.generation || revoked.state !== 'BLOCKED'
        || revoked.reason !== 'provider-auth-revoked' || !revoked.revokedHost
        || !current.hosts.includes(revoked.revokedHost)
        || canonical(revoked.hosts) !== canonical(current.hosts)
        || revoked.startedAt !== current.startedAt)
        throw new Error('invalid existing revocation');
    }
    else {
      if (current.state !== 'ADMITTED')
        return unknown('revocation-not-admitted');
      revoked = { ...current, state: 'BLOCKED', reason: 'provider-auth-revoked', revokedHost: args.host, completedAt: Date.now() };
      writeFileSync(target, JSON.stringify({ ...revoked, signature: signValidationArtifact(revoked, root) }), { flag: 'wx', mode: 0o600 });
    }
    const temporary = active + '.' + randomUUID();
    writeFileSync(temporary, JSON.stringify({ ...revoked, signature: signValidationArtifact(revoked, root) }), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, active);
    return revoked;
  }
  finally {
    lock.release();
  }
}

/** Launch serialization uses the same controller lock as admission and revocation.
 * The trusted caller performs verification and a short run-grant mutation only.
 * It must release this lock before executing the provider process.
 */
export async function withReviewerBatchLaunchLock<T>(args: {
  gitCwd: string;
  subjectIdentity: string;
}, grant: () => T | Promise<T>): Promise<T> {
  const root = realpathSync(args.gitCwd);
  const subject = reviewerBatchInputIdentity(args.subjectIdentity);
  const directory = join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR,
    'runtime', REVIEWER_BATCH_ADMISSION_ARTIFACT.directoryName, subject);
  const until = Date.now() + policy.maxWaitMs;
  let lock: AcquiredMkdirLock | undefined;
  while (!lock) {
    try {
      lock = acquireMkdirLock(join(directory, 'controller.lock'), {
        failFastIfHeld: true, heldMessage: 'BATCH_CONTROLLER_BUSY',
        staleMs: policy.lockStaleMs, deadlineMs: policy.lockDeadlineMs,
        pollMs: policy.lockPollMs, requireHolderToken: true,
        holderInfo: {
          pid: process.pid, hostname: hostname(), command: 'reviewer batch launch grant',
          acquiredAt: new Date().toISOString(), lockId: randomUUID(),
        },
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('BATCH_CONTROLLER_BUSY')) throw error;
      if (Date.now() >= until) throw new Error('batch launch controller busy');
      await wait(policy.waitPollMs);
    }
  }
  try { return await grant(); }
  finally { lock.release(); }
}
