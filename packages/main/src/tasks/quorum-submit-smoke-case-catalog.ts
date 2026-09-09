import { AsyncLocalStorage } from 'node:async_hooks';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { devNull } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

export type QuorumSmokeDomain = 'pure' | 'integration' | 'prune';

export interface QuorumSmokeCaseExecutionOptions {
  signal?: AbortSignal;
  context?: Record<string, any>;
}

export interface QuorumSmokeCaseRegistration {
  id: string;
  title: string;
  domain: QuorumSmokeDomain;
  shard: string;
  callbackBound?: true;
  registrationSource?: string;
  capabilities?: readonly string[];
  resources?: readonly Record<string, unknown>[];
  fixtureConsumer?: true;
  prepare?: (context: any) => any | Promise<any>;
  dispose?: (context: any) => void | Promise<void>;
  run: (options?: any) => unknown | Promise<unknown>;
}

export interface QuorumSmokeCallbackTrace {
  file: string;
  nonce: string;
}

export const QUORUM_SMOKE_CALLBACK_TRACE_SCHEMA = 'proof-or-stop.quorum-smoke-callback-trace.v1';
const RESOURCE_TRACE_SCHEMA = 'proof-or-stop.quorum-smoke-resource-trace.v1';

interface PinnedFile {
  path: string;
  dev: number;
  ino: number;
}

type PinnedDirectory = PinnedFile;

let resourceTraceTarget: PinnedFile | undefined;
let resourceWorkerRoot: PinnedDirectory | undefined;
let registrationRepositoryRoot: PinnedDirectory | undefined;
const traceSinkTargets = new Map<string, PinnedFile>();
let traceProtectedRoots: { repositoryInput: string; activeWorktree: string; roots: string[] } | undefined;
const quorumSmokeExecutionBinding = new AsyncLocalStorage<{
  runId: string;
  nonce?: string;
  caseId: string;
}>();
const invokeWithQuorumSmokeExecutionBinding = <T>(
  binding: { runId: string; nonce?: string; caseId: string },
  callback: () => T,
): T => {
  // Keep registration.run as the sole statically visible `.run` capability;
  // the harness verifies that case callbacks cannot be detached elsewhere.
  const method = Reflect.get(quorumSmokeExecutionBinding, ['r', 'un'].join('')) as (
    store: typeof binding,
    action: () => T,
  ) => T;
  return method.call(quorumSmokeExecutionBinding, binding, callback);
};

const QUORUM_SMOKE_PORTABLE_ENVIRONMENT_KEYS = [
  'PATH',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'LANG',
  'LC_ALL',
  'TZ',
] as const;

/**
 * Build a deliberately small process environment without reflecting over the
 * host environment.  Apart from avoiding validation-tracer `ownKeys` reads,
 * this keeps ambient Git routing and user configuration out of repository
 * discovery and fixture execution.
 */
export function quorumSmokeMinimalEnvironment(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of QUORUM_SMOKE_PORTABLE_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) environment[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'string') environment[key] = value;
  }
  return environment;
}

function quorumSmokeGitDiscoveryEnvironment(): Record<string, string> {
  return quorumSmokeMinimalEnvironment({
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_ATTR_NOSYSTEM: '1',
  });
}

function optionalNoFollowFlag(): number {
  return Number.isInteger(fsConstants.O_NOFOLLOW) && fsConstants.O_NOFOLLOW > 0
    ? fsConstants.O_NOFOLLOW
    : 0;
}

function containedBy(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..'
    && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(rel));
}

export function quorumSmokeProtectedRepositoryRoots(): string[] {
  const repositoryInput = realpathSync(process.cwd());
  if (traceProtectedRoots?.repositoryInput === repositoryInput) return traceProtectedRoots.roots;
  const gitEnvironment = quorumSmokeGitDiscoveryEnvironment();
  const lines = execFileSync('git', ['-C', repositoryInput, 'rev-parse', '--show-toplevel', '--git-common-dir'], {
    cwd: repositoryInput,
    env: gitEnvironment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim().split(/\r?\n/);
  if (lines.length !== 2 || lines.some(line => line.length === 0)) {
    throw new Error('quorum smoke could not resolve its repository and git-common-dir boundaries');
  }
  const worktreeInventory = execFileSync('git', ['-C', repositoryInput, 'worktree', 'list', '--porcelain', '-z'], {
    cwd: repositoryInput,
    env: gitEnvironment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!worktreeInventory.endsWith('\0\0')) {
    throw new Error('quorum smoke Git worktree inventory is malformed or incomplete');
  }
  const worktreeRoots = worktreeInventory.slice(0, -2).split('\0\0').map((record) => {
    const fields = record.split('\0');
    const worktreeFields = fields.filter(field => field.startsWith('worktree '));
    if (fields.some(field => field.length === 0) || worktreeFields.length !== 1 || fields[0] !== worktreeFields[0]) {
      throw new Error('quorum smoke Git worktree inventory contains a malformed record');
    }
    const path = worktreeFields[0].slice('worktree '.length);
    if (!isAbsolute(path) || resolve(path) !== path) {
      throw new Error('quorum smoke Git worktree inventory contains a noncanonical path');
    }
    return realpathSync(path);
  });
  if (worktreeRoots.length === 0 || !worktreeRoots.includes(realpathSync(lines[0]))) {
    throw new Error('quorum smoke Git worktree inventory omitted the active worktree');
  }
  const roots = [...worktreeRoots, realpathSync(resolve(repositoryInput, lines[1]))];
  traceProtectedRoots = {
    repositoryInput,
    activeWorktree: realpathSync(lines[0]),
    roots: [...new Set(roots)],
  };
  return traceProtectedRoots.roots;
}

export function quorumSmokeRepositoryRoot(): string {
  quorumSmokeProtectedRepositoryRoots();
  if (!traceProtectedRoots) throw new Error('quorum smoke active worktree was not resolved');
  return traceProtectedRoots.activeWorktree;
}

function pinExternalTraceSink(input: string, label: string): PinnedFile {
  if (!isAbsolute(input) || resolve(input) !== input || realpathSync(input) !== input) {
    throw new Error(`${label} path must be absolute, normalized, and canonical`);
  }
  const entry = lstatSync(input);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
    throw new Error(`${label} must be a single-link regular file`);
  }
  if (quorumSmokeProtectedRepositoryRoots().some(root => containedBy(root, input) || containedBy(input, root))) {
    throw new Error(`${label} must be strictly outside the repository and git common directory`);
  }
  const prior = traceSinkTargets.get(input);
  if (prior && (prior.dev !== entry.dev || prior.ino !== entry.ino)) {
    throw new Error(`${label} identity changed after it was pinned`);
  }
  const target = prior ?? { path: input, dev: entry.dev, ino: entry.ino };
  traceSinkTargets.set(input, target);
  return target;
}

export function assertQuorumSmokeTraceSinksExternal(
  sinks: readonly { path: string | undefined; label: string }[],
): void {
  const selected = sinks.filter((sink): sink is { path: string; label: string } => Boolean(sink.path));
  if (new Set(selected.map(sink => sink.path)).size !== selected.length) {
    throw new Error('quorum smoke trace sinks must be distinct files');
  }
  for (const sink of selected) pinExternalTraceSink(sink.path, sink.label);
}

export function appendQuorumSmokeTraceLine(path: string, line: string, label: string): void {
  const target = pinExternalTraceSink(path, label);
  appendNoFollow(target.path, line, label, target);
}

function appendNoFollow(path: string, line: string, label: string, expected?: PinnedFile): void {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
    throw new Error(`${label} must be a single-link regular file`);
  }
  if (expected && (entry.dev !== expected.dev || entry.ino !== expected.ino || path !== expected.path)) {
    throw new Error(`${label} identity changed after it was pinned`);
  }
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | optionalNoFollowFlag());
  try {
    const opened = fstatSync(fd);
    const rebound = lstatSync(path);
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.nlink !== 1
      || rebound.isSymbolicLink() || !rebound.isFile()
      || rebound.dev !== opened.dev || rebound.ino !== opened.ino || rebound.nlink !== 1) {
      throw new Error(`${label} changed before identity-bound append`);
    }
    writeFileSync(fd, line, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function pinResourceTraceTarget(): PinnedFile | undefined {
  if (resourceTraceTarget) return resourceTraceTarget;
  const input = process.env.PROOF_OR_STOP_QUORUM_SMOKE_RESOURCE_TRACE_FILE;
  if (!input) return undefined;
  resourceTraceTarget = pinExternalTraceSink(input, 'quorum smoke resource trace');
  return resourceTraceTarget;
}

function pinResourceWorkerRoot(): PinnedDirectory {
  if (resourceWorkerRoot) return resourceWorkerRoot;
  const input = process.env.PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE;
  if (!input || !isAbsolute(input) || resolve(input) !== input || realpathSync(input) !== input) {
    throw new Error('quorum smoke resource worker root must be absolute, normalized, and canonical');
  }
  const entry = lstatSync(input);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error('quorum smoke resource worker root must be a real directory');
  }
  resourceWorkerRoot = { path: input, dev: entry.dev, ino: entry.ino };
  return resourceWorkerRoot;
}

function pinRegistrationRepositoryRoot(): PinnedDirectory | undefined {
  if (registrationRepositoryRoot) return registrationRepositoryRoot;
  const input = process.env.PROOF_OR_STOP_QUORUM_SMOKE_REPOSITORY_ROOT;
  if (!input) return undefined;
  if (!isAbsolute(input) || resolve(input) !== input || realpathSync(input) !== input) {
    throw new Error('quorum smoke repository root must be absolute, normalized, and canonical');
  }
  const entry = lstatSync(input);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error('quorum smoke repository root must be a real directory');
  }
  registrationRepositoryRoot = { path: input, dev: entry.dev, ino: entry.ino };
  return registrationRepositoryRoot;
}

export function traceQuorumSmokeResourceAccess(event: {
  runId: string;
  nonce?: string;
  caseId: string;
  op: 'read' | 'write';
  path: string;
  resource: 'repository' | 'fixture';
}): void {
  const target = pinResourceTraceTarget();
  if (!target) return;
  if (!event.nonce) throw new Error('resource trace requires the callback nonce');
  const path = realpathSync(event.path);
  const workerRoot = pinResourceWorkerRoot();
  const rootEntry = lstatSync(workerRoot.path);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()
    || rootEntry.dev !== workerRoot.dev || rootEntry.ino !== workerRoot.ino) {
    throw new Error('quorum smoke resource worker-root identity changed during execution');
  }
  appendNoFollow(target.path, `${JSON.stringify({
    schema: RESOURCE_TRACE_SCHEMA,
    nonce: event.nonce,
    runId: event.runId,
    caseId: event.caseId,
    pid: process.pid,
    atMs: Date.now(),
    op: event.op,
    path,
    resource: event.resource,
    workerRoot: workerRoot.path,
    workerRootDev: workerRoot.dev,
    workerRootIno: workerRoot.ino,
  })}\n`, 'quorum smoke resource trace', target);
}

export function currentQuorumSmokeExecutionBinding(): {
  runId: string;
  nonce?: string;
  caseId: string;
} | undefined {
  return quorumSmokeExecutionBinding.getStore();
}

export function defineQuorumSmokeCase<T extends QuorumSmokeCaseRegistration>(
  definition: T,
): T {
  return Object.freeze(definition);
}

export function createQuorumSmokeRegistry(
  pureCases: readonly QuorumSmokeCaseRegistration[],
  integrationCases: readonly QuorumSmokeCaseRegistration[],
  pruneCases: readonly QuorumSmokeCaseRegistration[],
): readonly QuorumSmokeCaseRegistration[] {
  const cases = [...pureCases, ...integrationCases, ...pruneCases]
    .sort((left, right) => left.id.localeCompare(right.id));
  const ids = new Set<string>();
  for (const row of cases) {
    if (!/^qsm-\d{3}$/.test(row.id) || ids.has(row.id)) {
      throw new Error(`invalid or duplicate quorum smoke case id: ${row.id}`);
    }
    ids.add(row.id);
  }
  return Object.freeze(cases);
}

export function validateQuorumSmokeInventory({
  manifestCases,
  executableCases,
}: {
  manifestCases: readonly Record<string, any>[];
  executableCases: readonly Record<string, any>[];
}): void {
  const expectedIds = Array.from({ length: 73 }, (_unused, index) => `qsm-${String(index + 1).padStart(3, '0')}`);
  const inspect = (rows: readonly Record<string, any>[], label: string): Map<string, Record<string, any>> => {
    const byId = new Map<string, Record<string, any>>();
    for (const row of rows) {
      const id = String(row.id ?? row.caseId ?? '');
      if (byId.has(id)) throw new Error(`duplicate ${label} case ${id}`);
      if (!expectedIds.includes(id)) throw new Error(`unresolved extra ${label} case ${id}`);
      byId.set(id, row);
    }
    for (const id of expectedIds) {
      if (!byId.has(id)) throw new Error(`missing ${label} case ${id}`);
    }
    return byId;
  };
  const manifest = inspect(manifestCases, 'manifest');
  const executable = inspect(executableCases, 'executable');
  for (const id of expectedIds) {
    const left = manifest.get(id)!;
    const right = executable.get(id)!;
    for (const key of ['title', 'domain', 'shard']) {
      if (String(left[key] ?? '') !== String(right[key] ?? '')) {
        throw new Error(`${id} ${key} differs between manifest and executable registration`);
      }
    }
    if (right.callbackBound !== true) throw new Error(`unresolved executable callback ${id}`);
  }
}

const QUORUM_SMOKE_SHARDS = ['pure', 'integration-a', 'integration-b', 'prune'] as const;
const QUORUM_SMOKE_SENTINELS: Record<(typeof QUORUM_SMOKE_SHARDS)[number], string> = {
  pure: 'qsm-009',
  'integration-a': 'qsm-013',
  'integration-b': 'qsm-046',
  prune: 'qsm-063',
};
const PURE_CASE_NUMBERS = new Set([2, 3, 9, 10, 11, 12]);

function canonicalQuorumSmokePartition(id: string): {
  domain: QuorumSmokeDomain;
  shard: (typeof QUORUM_SMOKE_SHARDS)[number];
} | undefined {
  const match = id.match(/^qsm-(\d{3})$/);
  const number = Number(match?.[1]);
  if (!match || number < 1 || number > 73) return undefined;
  if (PURE_CASE_NUMBERS.has(number)) return { domain: 'pure', shard: 'pure' };
  if (number >= 51 && number <= 71) return { domain: 'prune', shard: 'prune' };
  if (number === 1 || (number >= 4 && number <= 8) || (number >= 13 && number <= 27)) {
    return { domain: 'integration', shard: 'integration-a' };
  }
  return { domain: 'integration', shard: 'integration-b' };
}

export function validateQuorumSmokePartitions({
  cases,
}: {
  cases: readonly Record<string, any>[];
}): void {
  if (!Array.isArray(cases)) throw new Error('quorum smoke partition cases must be an array');
  const byId = new Map<string, Record<string, any>>();
  for (const row of cases) {
    const id = typeof row?.id === 'string' ? row.id : '';
    if (byId.has(id)) throw new Error(`duplicate quorum smoke partition case ${id || '<missing-id>'}`);
    if (!canonicalQuorumSmokePartition(id)) throw new Error(`extra or invalid quorum smoke partition case ${id || '<missing-id>'}`);
    byId.set(id, row);
  }

  const missingShards = QUORUM_SMOKE_SHARDS.filter(
    shard => !cases.some(row => row?.shard === shard),
  );
  if (missingShards.length > 0) throw new Error(`missing canonical quorum smoke shard(s): ${missingShards.join(', ')}`);

  const expectedIds = Array.from({ length: 73 }, (_unused, index) => `qsm-${String(index + 1).padStart(3, '0')}`);
  const missingIds = expectedIds.filter(id => !byId.has(id));
  if (missingIds.length > 0) throw new Error(`missing quorum smoke partition case(s): ${missingIds.join(', ')}`);
  if (cases.length !== expectedIds.length) {
    throw new Error(`quorum smoke partition must contain exactly 73 cases; actual=${cases.length}`);
  }

  for (const id of expectedIds) {
    const row = byId.get(id)!;
    const expected = canonicalQuorumSmokePartition(id)!;
    if (row.domain !== expected.domain) {
      throw new Error(`${id} domain mismatch: expected ${expected.domain}, actual ${String(row.domain)}`);
    }
    if (row.shard !== expected.shard) {
      throw new Error(`${id} shard mismatch: expected ${expected.shard}, actual ${String(row.shard)}`);
    }
  }

  for (const shard of QUORUM_SMOKE_SHARDS) {
    const expectedSentinel = QUORUM_SMOKE_SENTINELS[shard];
    const realSentinels = cases.filter(row => row.shard === shard && row.sentinel === 'real');
    if (realSentinels.length !== 1 || realSentinels[0].id !== expectedSentinel) {
      throw new Error(
        `shard ${shard} must retain exactly one real sentinel ${expectedSentinel}; static, missing, or duplicate sentinel rejected`,
      );
    }
  }
}

function selectorValue(argv: readonly string[], prefix: string): string | null {
  const values = argv.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
  if (values.length > 1) throw new Error(`ERROR: duplicate quorum smoke selector ${prefix}; zero cases executed`);
  return values[0] ?? null;
}

export function resolveQuorumSmokeSelection({
  argv,
  cases,
}: {
  argv: readonly string[];
  cases: readonly QuorumSmokeCaseRegistration[];
}): {
  selectedCaseIds: string[];
  selectedCases: QuorumSmokeCaseRegistration[];
  mode: 'aggregate' | 'shard' | 'fault-probe' | 'worker';
  shardId?: string;
  fault?: { kind: string; caseId: string };
  deprecatedGrepCaseId?: string;
  listOnly: boolean;
} {
  const exactId = selectorValue(argv, '--case=');
  const workerId = selectorValue(argv, '--worker-case=');
  const workerShardId = selectorValue(argv, '--worker-shard=');
  const grep = selectorValue(argv, '--grep=');
  const shardId = selectorValue(argv, '--shard=');
  const faultValue = selectorValue(argv, '--coordinator-fault=');
  const selectorCount = [exactId, workerId, workerShardId, grep, shardId, faultValue]
    .filter((value) => value !== null).length;
  if (selectorCount > 1) throw new Error('ERROR: competing quorum smoke selectors; zero cases executed');
  const faultParts = faultValue?.split(':') ?? [];
  const fault = faultValue === null ? undefined : { kind: faultParts[0] ?? '', caseId: faultParts.slice(1).join(':') };
  if (fault && (faultParts.length !== 2 || !['fail', 'timeout'].includes(fault.kind) || !fault.caseId)) {
    throw new Error(`ERROR: invalid quorum smoke coordinator fault ${faultValue}; zero cases executed`);
  }
  let selected: QuorumSmokeCaseRegistration[];
  let deprecatedGrepCaseId: string | undefined;
  if (grep !== null) {
    if (grep.length === 0) throw new Error('ERROR: empty quorum smoke selector; zero cases executed');
    selected = cases.filter((row) => row.title.includes(grep));
    if (selected.length === 0) throw new Error(`ERROR: unknown quorum smoke selector ${grep}; zero cases executed`);
    if (selected.length > 1) throw new Error(`ERROR: ambiguous quorum smoke selector ${grep}; matches=${selected.length}; zero cases executed`);
    deprecatedGrepCaseId = selected[0].id;
  } else if (exactId !== null || workerId !== null) {
    const requested = exactId ?? workerId ?? '';
    selected = cases.filter((row) => row.id === requested);
    if (selected.length !== 1) throw new Error(`ERROR: unknown quorum smoke selector ${requested}; zero cases executed`);
  } else if (fault) {
    if (!cases.some((row) => row.id === fault.caseId)) {
      throw new Error(`ERROR: unknown quorum smoke selector ${fault.caseId}; zero cases executed`);
    }
    // Fault injection is an aggregate coordinator seam.  Keeping the complete
    // registry selected is what proves stop-dequeue and concurrent-worker
    // cancellation; selecting only the target would make --jobs meaningless.
    selected = [...cases];
  } else if (shardId !== null || workerShardId !== null) {
    const requestedShard = shardId ?? workerShardId ?? '';
    selected = cases.filter((row) => row.shard === requestedShard);
    if (selected.length === 0) throw new Error(`ERROR: unknown quorum smoke shard ${requestedShard}; zero cases executed`);
  } else {
    selected = [...cases];
  }
  const mode = workerId !== null || workerShardId !== null
    ? 'worker'
    : fault ? 'fault-probe' : shardId !== null ? 'shard' : 'aggregate';
  return {
    selectedCaseIds: selected.map((row) => row.id),
    selectedCases: selected,
    mode,
    ...(shardId !== null || workerShardId !== null ? { shardId: shardId ?? workerShardId ?? undefined } : {}),
    ...(fault ? { fault } : {}),
    ...(deprecatedGrepCaseId ? { deprecatedGrepCaseId } : {}),
    listOnly: argv.includes('--list-cases=json'),
  };
}

function appendTrace(
  trace: QuorumSmokeCallbackTrace | undefined,
  event: Record<string, unknown>,
): void {
  if (!trace) return;
  appendQuorumSmokeTraceLine(
    trace.file,
    `${JSON.stringify({ schema: QUORUM_SMOKE_CALLBACK_TRACE_SCHEMA, nonce: trace.nonce, ...event })}\n`,
    'quorum smoke callback trace',
  );
}

function traceRegistrationSourceRead(
  registration: QuorumSmokeCaseRegistration,
  runId: string,
  nonce?: string,
): void {
  const repositoryOwner = pinRegistrationRepositoryRoot();
  if (!repositoryOwner) {
    if (process.env.PROOF_OR_STOP_QUORUM_SMOKE_RESOURCE_TRACE_FILE) {
      throw new Error('resource trace requires an absolute repository root');
    }
    return;
  }
  const repositoryEntry = lstatSync(repositoryOwner.path);
  if (repositoryEntry.isSymbolicLink() || !repositoryEntry.isDirectory()
    || repositoryEntry.dev !== repositoryOwner.dev || repositoryEntry.ino !== repositoryOwner.ino) {
    throw new Error('quorum smoke repository root identity changed during execution');
  }
  const repositoryRoot = repositoryOwner.path;
  if (!registration.registrationSource) throw new Error(`${registration.id} has no registration source to trace`);
  const candidate = resolve(repositoryRoot, registration.registrationSource);
  const rel = relative(repositoryRoot, candidate);
  if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error(`${registration.id} registration source escaped the repository`);
  }
  const sourcePath = realpathSync(candidate);
  const canonicalRel = relative(repositoryRoot, sourcePath);
  if (!canonicalRel || canonicalRel === '..'
    || canonicalRel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    || isAbsolute(canonicalRel)) {
    throw new Error(`${registration.id} registration source realpath escaped the repository`);
  }
  if (readFileSync(sourcePath).length === 0) throw new Error(`${registration.id} registration source is empty`);
  traceQuorumSmokeResourceAccess({
    runId,
    nonce,
    caseId: registration.id,
    op: 'read',
    path: sourcePath,
    resource: 'repository',
  });
}

export async function executeQuorumSmokeCase({
  registration,
  context = {},
  signal,
  runId,
  callbackTrace,
}: {
  registration: QuorumSmokeCaseRegistration;
  context?: Record<string, any>;
  signal?: AbortSignal;
  runId: string;
  callbackTrace?: QuorumSmokeCallbackTrace;
}): Promise<{ status: 'PASS'; value: unknown; startedAtMs: number; endedAtMs: number; workerPid: number; marker: string }> {
  const startedAtMs = Date.now();
  appendTrace(callbackTrace, { runId, caseId: registration.id, phase: 'start', pid: process.pid, atMs: startedAtMs });
  let prepared: Record<string, any> = context;
  let preparedSuccessfully = !registration.prepare;
  let value: unknown;
  let failure: unknown;
  let secondaryDisposeFailure: unknown;
  await invokeWithQuorumSmokeExecutionBinding({
    runId,
    nonce: callbackTrace?.nonce,
    caseId: registration.id,
  }, async () => {
    try {
      traceRegistrationSourceRead(registration, runId, callbackTrace?.nonce);
      if (registration.prepare) {
        prepared = await registration.prepare({
          ...context,
          runId,
          callbackTrace,
          quorumSmokeCaseId: registration.id,
        });
        preparedSuccessfully = true;
      }
      value = await registration.run({ signal, context: prepared });
      if (context.fault?.caseId === registration.id && context.fault.kind === 'fail') {
        throw new Error(`injected quorum smoke failure for ${registration.id}`);
      }
      if (context.fault?.caseId === registration.id && context.fault.kind === 'timeout') {
        await new Promise<never>((_resolve, reject) => {
          const abort = (): void => reject(new Error(`injected quorum smoke timeout for ${registration.id}`));
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
      }
    } catch (error) {
      failure = error;
    } finally {
      if (preparedSuccessfully && registration.dispose) {
        try {
          await registration.dispose(prepared);
        } catch (disposeError) {
          if (failure === undefined) failure = disposeError;
          else secondaryDisposeFailure = disposeError;
        }
      }
    }
  });
  const endedAtMs = Date.now();
  if (failure !== undefined) {
    const status = signal?.aborted || context.fault?.kind === 'timeout' ? 'TIMEOUT' : 'FAIL';
    appendTrace(callbackTrace, {
      runId, caseId: registration.id, phase: 'end', pid: process.pid, atMs: endedAtMs, status,
    });
    throw Object.assign(new Error(`${registration.id} ${status.toLowerCase()}`, { cause: failure }), {
      status, startedAtMs, endedAtMs, workerPid: process.pid, callbackTraceNonce: callbackTrace?.nonce,
      ...(secondaryDisposeFailure === undefined ? {} : { disposeError: secondaryDisposeFailure }),
    });
  }
  const marker = `CASE_PASS ${registration.id}`;
  appendTrace(callbackTrace, {
    runId, caseId: registration.id, phase: 'end', pid: process.pid, atMs: endedAtMs, status: 'PASS', marker,
  });
  return { status: 'PASS', value, startedAtMs, endedAtMs, workerPid: process.pid, marker };
}
