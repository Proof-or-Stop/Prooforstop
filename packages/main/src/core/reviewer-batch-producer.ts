import { REVIEWER_BATCH_PRODUCER_RUNTIME_POLICY as policy } from './runtime-fact-registry.js';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, openSync, closeSync, readSync, fstatSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import type { StoryStore } from './store.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { REVIEWER_BATCH_ADMISSION_ARTIFACT as artifact, resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';
import { withMkdirLock } from './mkdir-lock.js';
import { signValidationArtifact, verifyValidationArtifact } from './validation-artifact-signing.js';
import { withReviewInventoryMutationLock } from './review-inventory-epoch.js';
import { deriveReviewerBatchSubject, validateReviewerBatchAssignments, assertReviewerBatchAssignmentMatch } from './reviewer-batch-subject.js';
import { createReviewerBatchAdmissionController, revokeReviewerBatchAdmission, withReviewerBatchLaunchLock, reviewerBatchInputIdentity, type ReviewerBatchAssignment, type ReviewerBatchInputs, type ReviewerBatchProbeObservation } from './reviewer-batch-admission.js';
import { loadManagedExecutionIdentityKey, readManagedExecutionIdentityKey, managedExecutionKeyedDigest } from './managed-execution-identity-key.js';
import { identifyManagedExecutionInputs, identifyManagedExecutionRuntimeInputs } from './managed-execution-input-identity.js';
import { captureManagedProviderState, materializeManagedProviderState, managedProviderStateEnvironment, persistCapturedManagedProviderSeed, readCapturedManagedProviderSeed, fingerprintCapturedManagedProviderState, type ManagedProviderStateSnapshot } from './managed-review-provider-state.js';
import { canonicalReviewHostLauncherSpec, probeHostExecutionReadiness, classifyHostExecutionFailure } from './host-execution-readiness.js';
import { runSupervisedProviderProcess } from '../providers/supervised-process.js';

const profile = policy.ordinaryProfile;
const pathPlan = policy.generatedPathPlan;
export interface ExecutionBatchRequest { root: string; subjectIdentity: string; assignments: ReviewerBatchAssignment[]; deriveSubjectIdentity(): string; effectiveBaseEnvironment?: NodeJS.ProcessEnv; retryFromGeneration?: number; profile: string; }
export interface ExecutionBatchBinding { schema: 'managed-execution-batch-binding.v1'; root: string; baseEnvironmentDigest: string; subjectIdentity: string; identity: string; generation: number; lane: string; host: 'codex' | 'claude'; profile: string; }
interface Roster { schema: 'execution-batch-roster.v1'; subjectIdentity: string; assignments: ReviewerBatchAssignment[]; profile: string; }
function directories(root: string, subjectIdentity: string) {
  const project = realpathSync(resolveCanonicalRuntimeProjectRoot(root));
  return { project, directory: join(project, PROOF_OR_STOP_DIR, 'runtime', artifact.directoryName, reviewerBatchInputIdentity(subjectIdentity)) };
}
function privateDirectory(directory: string, create = false) {
  if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || realpathSync(directory) !== resolve(directory)) throw new Error('batch directory identity unavailable');
}
function readRecord(file: string): any {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > policy.maxRecordBytes || before.nlink !== 1 || (before.mode & 0o077) !== 0 || before.uid !== process.getuid?.()) throw new Error('invalid batch record');
    const bytes = Buffer.alloc(policy.maxRecordBytes + 1); let length = 0;
    while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count; }
    const after = fstatSync(fd);
    if (length !== before.size || length > policy.maxRecordBytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode || before.nlink !== after.nlink) throw new Error('batch record changed during read');
    return JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } finally { closeSync(fd); }
}
/** Exact OS child environment normalization, also used before sealing the worker base table. */
export function normalizeExecutionBatchEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.keys(env).sort().filter(name => env[name] !== undefined).map(name => [name, env[name]!]));
}
function readRoster(root: string, directory: string): Roster {
  const { signature, ...body } = readRecord(join(directory, artifact.rosterFile));
  if (body.schema !== 'execution-batch-roster.v1' || !verifyValidationArtifact(body, signature, root)) throw new Error('batch roster integrity mismatch');
  validateReviewerBatchAssignments(body.assignments.map((row: ReviewerBatchAssignment) => row.lane), body.assignments);
  return body as Roster;
}
function freezeRoster(args: ExecutionBatchRequest): Roster {
  if (!args.subjectIdentity || !args.profile.trim() || args.deriveSubjectIdentity() !== args.subjectIdentity) throw new Error('batch subject changed before roster freeze');
  const assignments = validateReviewerBatchAssignments(args.assignments.map(row => row.lane), args.assignments);
  const body: Roster = { schema: 'execution-batch-roster.v1', subjectIdentity: args.subjectIdentity, profile: args.profile, assignments };
  const { directory } = directories(args.root, args.subjectIdentity); privateDirectory(directory, true);
  return withMkdirLock(join(directory, artifact.rosterLockDirectory), () => {
    const file = join(directory, artifact.rosterFile);
    if (existsSync(file)) { const existing = readRoster(args.root, directory); if (reviewerBatchInputIdentity(existing) !== reviewerBatchInputIdentity(body)) throw new Error('batch assignment is already frozen differently'); return existing; }
    writeFileSync(file, JSON.stringify({ ...body, signature: signValidationArtifact(body, args.root) }), { flag: 'wx', mode: 0o600 });
    return body;
  }, { label: 'reviewer batch roster' });
}
function executable(host: string, cwd: string, env: NodeJS.ProcessEnv): string {
  for (const directory of (env.PATH ?? '').split(delimiter)) { const candidate = resolve(cwd, directory || '.', host); try { accessSync(candidate, constants.X_OK); if (lstatSync(realpathSync(candidate)).isFile()) return realpathSync(candidate); } catch { /* continue explicit PATH order */ } }
  throw new Error('batch provider executable unavailable');
}
function environmentDigest(key: ReturnType<typeof readManagedExecutionIdentityKey>, env: NodeJS.ProcessEnv): string { return managedExecutionKeyedDigest(key, 'batch-base-environment.v1', [Buffer.from(JSON.stringify(Object.entries(normalizeExecutionBatchEnvironment(env))))]); }
function captureInputs(args: Omit<ExecutionBatchRequest, 'assignments'>, roster: Roster, key: ReturnType<typeof readManagedExecutionIdentityKey>) {
  if (args.deriveSubjectIdentity() !== args.subjectIdentity || roster.subjectIdentity !== args.subjectIdentity || roster.profile !== args.profile) throw new Error('batch subject/profile drift');
  const cwd = realpathSync(args.root), env = normalizeExecutionBatchEnvironment(args.effectiveBaseEnvironment ?? process.env);
  const hosts = [...new Set(roster.assignments.filter(row => row.kind === 'managed').map(row => row.host))].sort();
  const captured = new Map<string, { state: ManagedProviderStateSnapshot; binary: string }>();
  const hostInputs: Record<string, string> = {}, hostRuntimeIdentities: Record<string, string> = {};
  for (const host of hosts) {
    if (host !== 'codex' && host !== 'claude') throw new Error('managed batch provider unsupported');
    const state = captureManagedProviderState(host, env), binary = executable(host, cwd, env);
    captured.set(host, { state, binary });
    // Full base env including original provider-home paths is keyed unchanged.
    // Generated replacements are an explicit bound plan, never silently filtered keys.
    const identity = identifyManagedExecutionInputs({ key, host, providerState: state, executablePath: binary, cwd, environment: env, reviewProfile: args.profile, reviewArgv: canonicalReviewHostLauncherSpec(host).launcherArgv });
    hostInputs[host] = identity.digest; hostRuntimeIdentities[host] = identity.runtimeDigest;
  }
  const inputs: ReviewerBatchInputs = { subjectIdentity: args.subjectIdentity, assignments: roster.assignments, executionIdentity: { schema: 'execution-batch-plan.v1', profile: args.profile, baseEnvironmentDigest: environmentDigest(key, env), hostInputs, hostRuntimeIdentities, generatedPathPlan: pathPlan } };
  return { inputs, captured, env, cwd };
}

/** Trusted internal service; arbitrary subjects are not registered CLI parameters. */
export async function admitExecutionBatch(args: ExecutionBatchRequest) {
  const roster = freezeRoster(args), { directory } = directories(args.root, args.subjectIdentity);
  const key = loadManagedExecutionIdentityKey(directory);
  let captured = captureInputs(args, roster, key);
  const controller = createReviewerBatchAdmissionController({ gitCwd: args.root,
    deriveInputs: () => { captured = captureInputs(args, readRoster(args.root, directory), key); return captured.inputs; },
    probeHost: async (host, inputs, signal, context) => {
      if (!context || context.identity !== reviewerBatchInputIdentity(inputs) || signal?.aborted || (host !== 'codex' && host !== 'claude')) throw new Error('batch probe context unavailable');
      const saved = captured.captured.get(host); if (!saved) throw new Error('batch provider input unavailable');
      const seedDirectory = join(directory, artifact.seedDirectoryName); privateDirectory(seedDirectory, true);
      const plan = { schema: 'execution-batch-plan-record.v1', root: captured.cwd, subjectIdentity: args.subjectIdentity, generation: context.generation, identity: context.identity, inputs };
      const planFile = join(seedDirectory, `${artifact.inputPlanPrefix}${context.generation}${artifact.inputPlanSuffix}`);
      if (!existsSync(planFile)) writeFileSync(planFile, JSON.stringify({ ...plan, signature: signValidationArtifact(plan, args.root) }), { flag: 'wx', mode: 0o600 });
      else { const { signature, ...existing } = readRecord(planFile); if (!verifyValidationArtifact(existing, signature, args.root) || reviewerBatchInputIdentity(existing) !== reviewerBatchInputIdentity(plan)) throw new Error('batch execution plan collision'); }
      const cache = join(seedDirectory, artifact.probeWorkDirectoryName, String(context.generation), host); privateDirectory(cache, true);
      const temporary = join(cache, artifact.probeTemporaryDirectoryName); privateDirectory(temporary, true);
      const state = materializeManagedProviderState(cache, saved.state);
      const env = { ...captured.env, ...managedProviderStateEnvironment(state), TMPDIR: temporary, TMP: temporary, TEMP: temporary };
      const version = runSupervisedProviderProcess(saved.binary, ['--version'], { cwd: captured.cwd, env, timeoutMs: policy.versionTimeoutMs });
      if (version.status !== 0 || version.replacementSafe !== true || !version.stdout.trim()) { const failure = classifyHostExecutionFailure({ ...version, signal: version.signal ?? null }); return { host, inputIdentity: context.identity, status: 'BLOCKED' as const, failureKind: failure === 'auth' ? 'auth' as const : failure === 'timeout' ? 'timeout' as const : failure === 'interactive' ? 'interactive' as const : 'executable' as const }; }
      const result = probeHostExecutionReadiness({ host, executablePath: saved.binary, versionOk: version.status === 0 && version.replacementSafe === true && Boolean(version.stdout.trim()), cwd: captured.cwd, env, timeoutMs: policy.readinessTimeoutMs });
      if (result.reviewReady) persistCapturedManagedProviderSeed(seedDirectory, captureManagedProviderState(host, env), key, { subjectIdentity: args.subjectIdentity, generation: context.generation, host });
      const failureKind: ReviewerBatchProbeObservation['failureKind'] = result.failureKind === 'auth' ? 'auth' : result.failureKind === 'timeout' ? 'timeout' : result.failureKind === 'interactive' ? 'interactive' : 'unknown';
      return { host, inputIdentity: context.identity, status: result.reviewReady ? 'READY' as const : 'BLOCKED' as const, failureKind };
    },
  });
  return controller.admit({retryFromGeneration:args.retryFromGeneration});
}
export async function admitReviewerBatch(args: { store: StoryStore; root: string; storyId: string; epochId: string; wave: number; assignments: ReviewerBatchAssignment[]; retryFromGeneration?: number }) {
  const derive = () => deriveReviewerBatchSubject(args.store, args.root, args);
  const prepared = withReviewInventoryMutationLock(args.store, args.storyId, () => {
    const subject = derive(), assignments = validateReviewerBatchAssignments(subject.requiredLanes, args.assignments);
    const request: ExecutionBatchRequest = { root: subject.subject.worktreeRoot, subjectIdentity: subject.subjectIdentity, assignments, deriveSubjectIdentity: () => derive().subjectIdentity, profile, retryFromGeneration:args.retryFromGeneration };
    freezeRoster(request); return request;
  });
  return admitExecutionBatch(prepared);
}
export function verifyExecutionBatchBinding(args: { root: string; binding: ExecutionBatchBinding; effectiveBaseEnvironment?: NodeJS.ProcessEnv; providerStateSnapshot?: ManagedProviderStateSnapshot; actualProviderEnvironment?: NodeJS.ProcessEnv; actualProviderCwd?: string; launchReservation?: ExecutionBatchLaunchReservation }) {
  const { binding } = args, { directory } = directories(args.root, binding.subjectIdentity); privateDirectory(directory);
  const roster = readRoster(args.root, directory);
  const key = readManagedExecutionIdentityKey(directory);
  const { signature: planSignature, ...plan } = readRecord(join(directory, artifact.seedDirectoryName, `${artifact.inputPlanPrefix}${binding.generation}${artifact.inputPlanSuffix}`));
  if (!verifyValidationArtifact(plan, planSignature, args.root) || plan.schema !== 'execution-batch-plan-record.v1' || plan.root !== binding.root || realpathSync(args.root) !== binding.root || plan.subjectIdentity !== binding.subjectIdentity || plan.generation !== binding.generation || plan.identity !== binding.identity || reviewerBatchInputIdentity(plan.inputs) !== binding.identity || plan.inputs?.executionIdentity?.baseEnvironmentDigest !== binding.baseEnvironmentDigest || (args.effectiveBaseEnvironment && environmentDigest(key, args.effectiveBaseEnvironment) !== binding.baseEnvironmentDigest)) throw new Error('batch execution plan/base environment mismatch');
  if (binding.schema !== 'managed-execution-batch-binding.v1' || roster.subjectIdentity !== binding.subjectIdentity || roster.profile !== binding.profile) throw new Error('batch binding subject/profile mismatch');
  assertReviewerBatchAssignmentMatch(roster.assignments, { lane: binding.lane, kind: 'managed', host: binding.host });
  // A durable revocation wins even if active.json publication was interrupted.
  // Launch reservations never restore an already revoked generation.
  if (existsSync(join(directory, `generation-${binding.generation}-revocation.json`))) {
    throw new Error('batch admission revoked or revocation requires recovery');
  }
  const { signature, ...record } = readRecord(join(directory, 'active.json'));
  if (!verifyValidationArtifact(record, signature, args.root) || record.schema !== 'reviewer-batch-admission.v1' || !Array.isArray(record.hosts) || !Array.isArray(record.observations) || record.hosts.length !== record.observations.length || new Set(record.hosts).size !== record.hosts.length || record.hosts.some((host: string) => record.observations.filter((row: any) => row.host === host && row.status === 'READY').length !== 1) || record.state !== 'ADMITTED' || record.identity !== binding.identity || record.generation !== binding.generation || record.subject !== reviewerBatchInputIdentity(binding.subjectIdentity) || !Number.isFinite(record.expiresAt)) throw new Error('batch admission missing/stale/not admitted');
  if (args.launchReservation) verifyLaunchReservation(args.root,directory,binding,args.launchReservation,record.expiresAt);
  else if (Date.now() >= record.expiresAt) throw new Error('batch admission expired before launch consumption');
  // Never reread original credentials here: probes can refresh the admitted seed.
  const baseEnvironment = args.effectiveBaseEnvironment ?? process.env;
  if (environmentDigest(key, baseEnvironment) !== binding.baseEnvironmentDigest) throw new Error('batch worker base environment changed');
  const binary = executable(binding.host, binding.root, baseEnvironment);
  const runtimeIdentity = identifyManagedExecutionRuntimeInputs({key,host:binding.host,executablePath:binary,cwd:binding.root,environment:normalizeExecutionBatchEnvironment(baseEnvironment),reviewProfile:binding.profile,reviewArgv:canonicalReviewHostLauncherSpec(binding.host).launcherArgv}).digest;
  if (runtimeIdentity !== plan.inputs?.executionIdentity?.hostRuntimeIdentities?.[binding.host]) throw new Error('batch worker executable/runtime identity changed');
  if ((args.actualProviderEnvironment === undefined) !== (args.actualProviderCwd === undefined)) throw new Error('batch actual provider resolution incomplete');
  if (args.actualProviderEnvironment && args.actualProviderCwd && executable(binding.host,args.actualProviderCwd,args.actualProviderEnvironment) !== binary) throw new Error('batch actual provider executable shadowed');
  const providerState = readCapturedManagedProviderSeed(join(directory, artifact.seedDirectoryName), readManagedExecutionIdentityKey(directory), { subjectIdentity: binding.subjectIdentity, generation: binding.generation, host: binding.host });
  if (args.providerStateSnapshot && fingerprintCapturedManagedProviderState(args.providerStateSnapshot, key, binding.host) !== fingerprintCapturedManagedProviderState(providerState, key, binding.host)) throw new Error('batch admitted seed differs from materialized provider cache');
  return { binding, providerState, admissionExpiresAt: record.expiresAt as number };
}
async function consumeExecutionBatchInternal(args: Omit<ExecutionBatchRequest, 'assignments'> & { lane: string; host: 'codex' | 'claude' }) {
  const { directory } = directories(args.root, args.subjectIdentity); privateDirectory(directory);
  const roster = readRoster(args.root, directory), key = readManagedExecutionIdentityKey(directory);
  const controller = createReviewerBatchAdmissionController({ gitCwd: args.root, deriveInputs: () => captureInputs(args, roster, key).inputs, probeHost: async () => { throw new Error('readonly batch consumer cannot probe'); } });
  const record = await controller.read(); if (record.state !== 'ADMITTED') throw new Error('batch admission required before managed launch');
  return verifyExecutionBatchBinding({ root: args.root, effectiveBaseEnvironment: args.effectiveBaseEnvironment ?? process.env, binding: { schema: 'managed-execution-batch-binding.v1', root: realpathSync(args.root), baseEnvironmentDigest: environmentDigest(key, args.effectiveBaseEnvironment ?? process.env), subjectIdentity: args.subjectIdentity, identity: record.identity, generation: record.generation, lane: args.lane, host: args.host, profile: args.profile } });
}
export async function consumeExecutionBatch(args: Omit<ExecutionBatchRequest, 'assignments'> & { lane: string; host: 'codex' | 'claude' }) {
  try { return await consumeExecutionBatchInternal(args); }
  catch { throw new Error('BATCH_ADMISSION_REQUIRED: request capability admission for the verified complete batch before managed launch; missing, stale, changed or invalid admission cannot be reused'); }
}
export async function consumeReviewerBatchAdmission(args: { store: StoryStore; root: string; storyId: string; lane: string; host: 'codex' | 'claude'; profile: string; effectiveBaseEnvironment: NodeJS.ProcessEnv }) {
  if (args.profile !== profile) throw new Error('ordinary reviewer batch profile mismatch');
  const derive = () => deriveReviewerBatchSubject(args.store, args.root, { storyId: args.storyId });
  const subject = derive();
  try { return await consumeExecutionBatch({ ...args, root: subject.subject.worktreeRoot, subjectIdentity: subject.subjectIdentity, deriveSubjectIdentity: () => derive().subjectIdentity }); } catch { throw new Error(`BATCH_ADMISSION_REQUIRED: run proof-or-stop reviewer_batch_admit --storyId=${args.storyId} with the complete explicit assignments`); }
}

export interface ExecutionBatchLaunchReservation { runId: string; deadlineAt: number; }
function launchReservationFile(directory: string, runId: string): string {
  if (!runId.trim()) throw new Error('batch launch reservation requires run identity');
  return join(directory, artifact.seedDirectoryName, artifact.launchReservationDirectoryName, reviewerBatchInputIdentity(runId) + artifact.launchReservationFileSuffix);
}
function verifyLaunchReservation(root: string, directory: string, binding: ExecutionBatchBinding, request: ExecutionBatchLaunchReservation, expiresAt: number): void {
  const {signature,...record}=readRecord(launchReservationFile(directory,request.runId));
  if (!verifyValidationArtifact(record,signature,root) || record.schema !== 'execution-batch-launch-reservation.v1' || record.root !== binding.root || reviewerBatchInputIdentity(record.binding) !== reviewerBatchInputIdentity(binding) || record.runId !== request.runId || record.deadlineAt !== request.deadlineAt || !Number.isSafeInteger(record.consumedAt) || !Number.isSafeInteger(record.deadlineAt) || record.consumedAt < 0 || record.expiresAt !== expiresAt || record.consumedAt >= record.expiresAt || record.deadlineAt <= record.consumedAt || Date.now() >= record.deadlineAt) throw new Error('batch launch reservation invalid/expired/mismatched');
}
/** Only managed submission calls this after its bounded run deadline and run identity are fixed. */
export function reserveExecutionBatchLaunch(args: {root:string;binding:ExecutionBatchBinding;runId:string;deadlineAt:number;effectiveBaseEnvironment:NodeJS.ProcessEnv}): void {
  if (!Number.isSafeInteger(args.deadlineAt) || args.deadlineAt <= Date.now()) throw new Error('batch launch reservation deadline expired/invalid');
  const {directory}=directories(args.root,args.binding.subjectIdentity),file=launchReservationFile(directory,args.runId);
  const reservationDirectory=join(directory,artifact.seedDirectoryName,artifact.launchReservationDirectoryName);
  privateDirectory(reservationDirectory,true);
  withMkdirLock(file+artifact.launchReservationLockSuffix,()=>{
    if (existsSync(file)) { verifyExecutionBatchBinding({...args,launchReservation:{runId:args.runId,deadlineAt:args.deadlineAt}}); return; }
    const checked=verifyExecutionBatchBinding(args),consumedAt=Date.now();
    if (consumedAt >= checked.admissionExpiresAt || consumedAt >= args.deadlineAt) throw new Error('batch admission expired before reservation');
    const record={schema:'execution-batch-launch-reservation.v1',root:args.binding.root,binding:args.binding,runId:args.runId,deadlineAt:args.deadlineAt,consumedAt,expiresAt:checked.admissionExpiresAt};
    writeFileSync(file,JSON.stringify({...record,signature:signValidationArtifact(record,args.root)}),{flag:'wx',mode:0o600});
  },{label:'managed batch launch reservation'});
}

/** A trusted worker reports its actual deterministic provider authentication failure. */
export async function revokeExecutionBatchBinding(args: {
  root: string;
  binding: ExecutionBatchBinding;
  effectiveBaseEnvironment: NodeJS.ProcessEnv;
}) {
  const { binding } = args;
  const { directory } = directories(args.root, binding.subjectIdentity);
  privateDirectory(directory);
  const roster = readRoster(args.root, directory);
  const key = readManagedExecutionIdentityKey(directory);
  const planFile = join(directory, artifact.seedDirectoryName,
    `${artifact.inputPlanPrefix}${binding.generation}${artifact.inputPlanSuffix}`);
  const { signature, ...plan } = readRecord(planFile);
  if (binding.schema !== 'managed-execution-batch-binding.v1'
    || !verifyValidationArtifact(plan, signature, args.root)
    || plan.schema !== 'execution-batch-plan-record.v1'
    || plan.root !== binding.root || realpathSync(args.root) !== binding.root
    || plan.subjectIdentity !== binding.subjectIdentity
    || plan.generation !== binding.generation || plan.identity !== binding.identity
    || reviewerBatchInputIdentity(plan.inputs) !== binding.identity
    || plan.inputs?.executionIdentity?.baseEnvironmentDigest !== binding.baseEnvironmentDigest
    || environmentDigest(key, args.effectiveBaseEnvironment) !== binding.baseEnvironmentDigest
    || roster.subjectIdentity !== binding.subjectIdentity || roster.profile !== binding.profile) {
    throw new Error('revocation execution plan mismatch');
  }
  assertReviewerBatchAssignmentMatch(roster.assignments, {
    lane: binding.lane, kind: 'managed', host: binding.host,
  });
  return revokeReviewerBatchAdmission({
    gitCwd: args.root, subjectIdentity: binding.subjectIdentity,
    identity: binding.identity, generation: binding.generation, host: binding.host,
  });
}

/** Only a verified current admission may enter the worker's terminal-locked grant.
 * Global order is controller -> per-run terminal; provider execution is outside both.
 */
export async function withVerifiedExecutionBatchLaunch<T>(
  args: Parameters<typeof verifyExecutionBatchBinding>[0],
  grant: () => T | Promise<T>,
): Promise<T> {
  return withReviewerBatchLaunchLock({
    gitCwd: args.root, subjectIdentity: args.binding.subjectIdentity,
  }, async () => {
    verifyExecutionBatchBinding(args);
    return await grant();
  });
}
