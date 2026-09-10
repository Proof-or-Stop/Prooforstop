import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  appendQuorumSmokeTraceLine,
  currentQuorumSmokeExecutionBinding,
  traceQuorumSmokeResourceAccess,
} from './quorum-submit-smoke-case-catalog.js';

export const QUORUM_SMOKE_FIXTURE_TEMPLATE_MANIFEST = '.quorum-smoke-template.json';

const TEMPLATE_SCHEMA = 'proof-or-stop.quorum-smoke-fixture-template.v1';
const FIXTURE_TRACE_SCHEMA = 'proof-or-stop.quorum-smoke-fixture-trace.v1';

export interface QuorumSmokeFixtureProfile {
  id: string;
  inputs: Record<string, unknown>;
}

interface FixtureTraceEvent {
  type: 'template-build' | 'fixture-clone' | 'fixture-cleanup' | 'template-cleanup';
  profileId: string;
  templateRoot: string;
  cloneRoot?: string;
  caseId?: string;
}

function optionalNoFollowFlag(): number {
  return Number.isInteger(fsConstants.O_NOFOLLOW) && fsConstants.O_NOFOLLOW > 0
    ? fsConstants.O_NOFOLLOW
    : 0;
}

interface FixturePoolOptions {
  cacheRoot: string;
  buildTemplate: (request: {
    profile: QuorumSmokeFixtureProfile;
    targetRoot: string;
  }) => unknown | Promise<unknown>;
  trace?: (event: FixtureTraceEvent) => void;
}

interface GeneratedRoot {
  path: string;
  dev: number;
  ino: number;
  removed: boolean;
}

interface TemplateRecord extends GeneratedRoot {
  profileId: string;
  profileDigest: string;
  contentDigest: string;
}

interface CloneRecord extends GeneratedRoot {
  caseId?: string;
  profileId: string;
  templateRoot: string;
}

export interface QuorumSmokeFixtureLease {
  root: string;
  cloneRoot: string;
  templateRoot: string;
  dispose(): void;
}

export interface QuorumSmokeFixtureTemplatePool {
  clone(
    profile: QuorumSmokeFixtureProfile,
    metadata?: { caseId?: string },
  ): Promise<QuorumSmokeFixtureLease>;
  stats(): { profiles: number; builds: number; clones: number };
  dispose(): Promise<void>;
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('fixture profile contains a non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new Error(`fixture profile contains unsupported ${typeof value}`);
  }
  if (ancestors.has(value)) throw new Error('fixture profile contains a cycle');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function strictChild(owner: string, candidate: string, label: string): string {
  const normalized = resolve(candidate);
  const rel = relative(owner, normalized);
  if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error(`${label} must be a strict child of the fixture cache root`);
  }
  return normalized;
}

function checkedDirectory(path: string, label: string): { path: string; dev: number; ino: number } {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`${label} must be a real directory, not a symlink`);
  const canonical = realpathSync(path);
  return { path: canonical, dev: entry.dev, ino: entry.ino };
}

function inspectTree(root: string, manifestName: string): Array<{ relativePath: string; kind: 'dir' | 'file'; mode: number; bytes?: Buffer; dev?: number; ino?: number }> {
  const rows: Array<{ relativePath: string; kind: 'dir' | 'file'; mode: number; bytes?: Buffer; dev?: number; ino?: number }> = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const rel = relative(root, path);
      if (rel === manifestName) continue;
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) throw new Error(`fixture template contains symlink: ${rel}`);
      if (entry.isDirectory()) {
        rows.push({ relativePath: rel, kind: 'dir', mode: entry.mode & 0o777 });
        visit(path);
      } else if (entry.isFile()) {
        const flags = fsConstants.O_RDONLY | optionalNoFollowFlag();
        const fd = openSync(path, flags);
        try {
          const opened = fstatSync(fd);
          const rebound = lstatSync(path);
          if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.nlink !== 1
            || rebound.isSymbolicLink() || !rebound.isFile()
            || rebound.dev !== opened.dev || rebound.ino !== opened.ino || rebound.nlink !== 1) {
            throw new Error(`fixture template file changed during identity-bound read: ${rel}`);
          }
          rows.push({
            relativePath: rel,
            kind: 'file',
            mode: entry.mode & 0o777,
            bytes: readFileSync(fd),
            dev: entry.dev,
            ino: entry.ino,
          });
        } finally {
          closeSync(fd);
        }
      } else {
        throw new Error(`fixture template contains unsupported entry: ${rel}`);
      }
    }
  };
  visit(root);
  return rows;
}

function treeDigest(root: string): string {
  const hash = createHash('sha256');
  for (const row of inspectTree(root, QUORUM_SMOKE_FIXTURE_TEMPLATE_MANIFEST)) {
    hash.update(row.kind).update('\0').update(row.relativePath).update('\0').update(String(row.mode)).update('\0');
    if (row.bytes) hash.update(row.bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function noFollowReadJson(path: string): Record<string, unknown> {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error('fixture template manifest must be a regular file');
  const fd = openSync(path, fsConstants.O_RDONLY | optionalNoFollowFlag());
  try {
    const opened = fstatSync(fd);
    const rebound = lstatSync(path);
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.nlink !== 1
      || rebound.isSymbolicLink() || !rebound.isFile()
      || rebound.dev !== opened.dev || rebound.ino !== opened.ino || rebound.nlink !== 1) {
      throw new Error('fixture template manifest changed during identity-bound read');
    }
    return JSON.parse(readFileSync(fd, 'utf8')) as Record<string, unknown>;
  } finally {
    closeSync(fd);
  }
}

function writeManifest(root: string, record: Record<string, unknown>): void {
  const path = join(root, QUORUM_SMOKE_FIXTURE_TEMPLATE_MANIFEST);
  const fd = openSync(
    path,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | optionalNoFollowFlag(),
    0o600,
  );
  try {
    writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function ignoreManifestInGit(root: string): void {
  const gitRoot = join(root, '.git');
  if (!existsSync(gitRoot)) return;
  const gitEntry = lstatSync(gitRoot);
  if (gitEntry.isSymbolicLink() || !gitEntry.isDirectory()) {
    throw new Error('fixture template .git metadata must be a local directory');
  }
  const infoRoot = join(gitRoot, 'info');
  if (!existsSync(infoRoot)) mkdirSync(infoRoot);
  const infoEntry = lstatSync(infoRoot);
  if (infoEntry.isSymbolicLink() || !infoEntry.isDirectory()) {
    throw new Error('fixture template .git/info must be a local directory');
  }
  const excludePath = join(infoRoot, 'exclude');
  if (existsSync(excludePath)) {
    const excludeEntry = lstatSync(excludePath);
    if (excludeEntry.isSymbolicLink() || !excludeEntry.isFile()) {
      throw new Error('fixture template git exclude must be a regular file');
    }
  }
  appendFileSync(excludePath, `\n/${QUORUM_SMOKE_FIXTURE_TEMPLATE_MANIFEST}\n`, 'utf8');
}

let runtimeDirectFixtureCount = 0;
let runtimeDirectFixtureCleanupCount = 0;
const runtimeDirectFixtureRoots = new Map<string, GeneratedRoot & { counted: boolean }>();

/** Allocate legacy/direct fixture roots beneath the parent-owned worker root. */
export function createQuorumSmokeOwnedFixtureRoot(prefix: string): string {
  if (!/^[a-z0-9][a-z0-9-]*-$/i.test(prefix)) {
    throw new Error('quorum smoke fixture prefix must be a bounded mkdtemp prefix');
  }
  const inheritedRoot = process.env.PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE;
  const binding = currentQuorumSmokeExecutionBinding();
  if (process.env.PROOF_OR_STOP_QUORUM_SMOKE_RESOURCE_TRACE_FILE && (!inheritedRoot || !binding)) {
    throw new Error('resource-traced quorum fixture allocation requires a bound worker root and callback');
  }
  const root = inheritedRoot
    ? strictChild(
        checkedDirectory(inheritedRoot, 'fixture worker-owned root').path,
        mkdtempSync(join(inheritedRoot, prefix)),
        'direct fixture root',
      )
    : checkedDirectory(mkdtempSync(join(tmpdir(), prefix)), 'standalone direct fixture root').path;
  const identity = checkedDirectory(root, 'direct fixture root');
  runtimeDirectFixtureRoots.set(root, { ...identity, removed: false, counted: Boolean(inheritedRoot && binding) });
  if (inheritedRoot && binding) {
    runtimeDirectFixtureCount += 1;
    traceQuorumSmokeResourceAccess({
      runId: binding.runId,
      nonce: binding.nonce,
      caseId: binding.caseId,
      op: 'write',
      path: root,
      resource: 'fixture',
    });
  }
  return root;
}

export function removeQuorumSmokeOwnedFixtureRoot(root: string): void {
  const record = runtimeDirectFixtureRoots.get(root);
  if (!record) {
    throw new Error(`refusing cleanup of an unregistered direct fixture root: ${root}`);
  }
  if (record.removed) return;
  const current = findGeneratedRoot(dirname(record.path), record);
  if (!current || current !== record.path) {
    throw new Error(`direct fixture root identity changed before cleanup: ${record.path}`);
  }
  removeTreeNoFollow(current);
  record.removed = true;
  if (record.counted) runtimeDirectFixtureCleanupCount += 1;
}

function removeTreeNoFollow(path: string): void {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    unlinkSync(path);
    return;
  }
  for (const name of readdirSync(path)) removeTreeNoFollow(join(path, name));
  rmdirSync(path);
}

function findGeneratedRoot(cacheRoot: string, record: GeneratedRoot): string | undefined {
  if (existsSync(record.path)) {
    const entry = lstatSync(record.path);
    if (!entry.isSymbolicLink() && entry.isDirectory() && entry.dev === record.dev && entry.ino === record.ino) {
      return record.path;
    }
    throw new Error(`fixture-owned path identity changed: ${record.path}`);
  }
  for (const name of readdirSync(cacheRoot)) {
    const candidate = strictChild(cacheRoot, join(cacheRoot, name), 'fixture-owned recovery path');
    const entry = lstatSync(candidate);
    if (!entry.isSymbolicLink() && entry.isDirectory() && entry.dev === record.dev && entry.ino === record.ino) {
      return candidate;
    }
  }
  return undefined;
}

function removeGeneratedRoot(cacheRoot: string, record: GeneratedRoot): void {
  if (record.removed) return;
  const current = findGeneratedRoot(cacheRoot, record);
  if (current) {
    strictChild(cacheRoot, current, 'fixture-owned cleanup root');
    removeTreeNoFollow(current);
  }
  record.removed = true;
}

function verifyTemplate(cacheRoot: string, template: TemplateRecord): boolean {
  try {
    const current = findGeneratedRoot(cacheRoot, template);
    if (!current || current !== template.path) return false;
    checkedDirectory(current, 'fixture template');
    const manifest = noFollowReadJson(join(current, QUORUM_SMOKE_FIXTURE_TEMPLATE_MANIFEST));
    return manifest.schema === TEMPLATE_SCHEMA
      && manifest.profileId === template.profileId
      && manifest.profileDigest === template.profileDigest
      && manifest.contentDigest === template.contentDigest
      && treeDigest(current) === template.contentDigest;
  } catch {
    return false;
  }
}

function assertCloneHasNoHardlinks(templateRoot: string, cloneRoot: string): void {
  const templateFiles = new Map(
    inspectTree(templateRoot, QUORUM_SMOKE_FIXTURE_TEMPLATE_MANIFEST)
      .filter((row) => row.kind === 'file')
      .map((row) => [row.relativePath, row]),
  );
  for (const clone of inspectTree(cloneRoot, QUORUM_SMOKE_FIXTURE_TEMPLATE_MANIFEST)) {
    if (clone.kind !== 'file') continue;
    const template = templateFiles.get(clone.relativePath);
    if (template && template.dev === clone.dev && template.ino === clone.ino) {
      throw new Error(`fixture clone retained a hardlink to immutable template: ${clone.relativePath}`);
    }
  }
}

export function createQuorumSmokeFixtureTemplatePool({
  cacheRoot,
  buildTemplate,
  trace,
}: FixturePoolOptions): QuorumSmokeFixtureTemplatePool {
  const cache = checkedDirectory(cacheRoot, 'fixture cacheRoot');
  const templates = new Map<string, TemplateRecord>();
  const generated: GeneratedRoot[] = [];
  const clones: CloneRecord[] = [];
  const profileKeys = new Set<string>();
  let buildCount = 0;
  let cloneCount = 0;
  let disposed = false;

  const createTemplate = async (
    profile: QuorumSmokeFixtureProfile,
    profileDigest: string,
    caseId?: string,
  ): Promise<TemplateRecord> => {
    const targetRoot = strictChild(cache.path, mkdtempSync(join(cache.path, 'template-')), 'fixture template root');
    const identity = checkedDirectory(targetRoot, 'fixture template root');
    const record: TemplateRecord = {
      ...identity,
      profileId: profile.id,
      profileDigest,
      contentDigest: '',
      removed: false,
    };
    generated.push(record);
    try {
      await buildTemplate({ profile, targetRoot });
      checkedDirectory(targetRoot, 'built fixture template');
      inspectTree(targetRoot, QUORUM_SMOKE_FIXTURE_TEMPLATE_MANIFEST);
      ignoreManifestInGit(targetRoot);
      record.contentDigest = treeDigest(targetRoot);
      writeManifest(targetRoot, {
        schema: TEMPLATE_SCHEMA,
        profileId: profile.id,
        profileDigest,
        contentDigest: record.contentDigest,
      });
      buildCount += 1;
      trace?.({
        type: 'template-build', profileId: profile.id, templateRoot: targetRoot,
        ...(caseId ? { caseId } : {}),
      });
      return record;
    } catch (error) {
      removeGeneratedRoot(cache.path, record);
      throw error;
    }
  };

  const clone = async (
    profile: QuorumSmokeFixtureProfile,
    metadata: { caseId?: string } = {},
  ): Promise<QuorumSmokeFixtureLease> => {
    if (disposed) throw new Error('fixture template pool is disposed');
    if (!profile || typeof profile.id !== 'string' || profile.id.length === 0 || !profile.inputs) {
      throw new Error('fixture profile requires a non-empty id and inputs');
    }
    const profileDigest = sha256(canonicalJson({ id: profile.id, inputs: profile.inputs }));
    profileKeys.add(profileDigest);
    let template = templates.get(profileDigest);
    if (template && !verifyTemplate(cache.path, template)) {
      removeGeneratedRoot(cache.path, template);
      trace?.({ type: 'template-cleanup', profileId: template.profileId, templateRoot: template.path });
      templates.delete(profileDigest);
      throw new Error(`fixture template ${template.profileId} is missing, corrupt, symlinked, or profile-mismatched`);
    }
    if (!template) {
      template = await createTemplate(profile, profileDigest, metadata.caseId);
      templates.set(profileDigest, template);
    }

    const cloneRoot = strictChild(cache.path, mkdtempSync(join(cache.path, 'clone-')), 'fixture clone root');
    const identity = checkedDirectory(cloneRoot, 'fixture clone root');
    const cloneRecord: CloneRecord = {
      ...identity,
      caseId: metadata.caseId,
      profileId: profile.id,
      templateRoot: template.path,
      removed: false,
    };
    generated.push(cloneRecord);
    clones.push(cloneRecord);
    try {
      cpSync(template.path, cloneRoot, { recursive: true, force: false, errorOnExist: true, dereference: false });
      checkedDirectory(cloneRoot, 'copied fixture clone');
      inspectTree(cloneRoot, QUORUM_SMOKE_FIXTURE_TEMPLATE_MANIFEST);
      assertCloneHasNoHardlinks(template.path, cloneRoot);
      cloneCount += 1;
      trace?.({
        type: 'fixture-clone',
        profileId: profile.id,
        templateRoot: template.path,
        cloneRoot,
        ...(metadata.caseId ? { caseId: metadata.caseId } : {}),
      });
    } catch (error) {
      removeGeneratedRoot(cache.path, cloneRecord);
      throw error;
    }

    let leaseDisposed = false;
    return {
      root: cloneRoot,
      cloneRoot,
      templateRoot: template.path,
      dispose(): void {
        if (leaseDisposed) return;
        removeGeneratedRoot(cache.path, cloneRecord);
        leaseDisposed = true;
        trace?.({
          type: 'fixture-cleanup',
          profileId: profile.id,
          templateRoot: template!.path,
          cloneRoot,
          ...(metadata.caseId ? { caseId: metadata.caseId } : {}),
        });
      },
    };
  };

  return {
    clone,
    stats: () => ({ profiles: profileKeys.size, builds: buildCount, clones: cloneCount }),
    async dispose(): Promise<void> {
      if (disposed) return;
      for (const cloneRecord of clones) {
        if (cloneRecord.removed) continue;
        removeGeneratedRoot(cache.path, cloneRecord);
        trace?.({
          type: 'fixture-cleanup',
          profileId: cloneRecord.profileId,
          templateRoot: cloneRecord.templateRoot,
          cloneRoot: cloneRecord.path,
          ...(cloneRecord.caseId ? { caseId: cloneRecord.caseId } : {}),
        });
      }
      for (const template of templates.values()) {
        removeGeneratedRoot(cache.path, template);
        trace?.({ type: 'template-cleanup', profileId: template.profileId, templateRoot: template.path });
      }
      for (const record of generated) removeGeneratedRoot(cache.path, record);
      disposed = true;
    },
  };
}

interface RuntimePoolState {
  cacheRoot: string;
  ownsCacheRoot: boolean;
  runId: string;
  nonce?: string;
  pool: QuorumSmokeFixtureTemplatePool;
}

let runtimePool: RuntimePoolState | undefined;

export function acquireQuorumSmokeFixtureRuntimePool({
  runId,
  callbackNonce,
  buildTemplate,
}: {
  runId: string;
  callbackNonce?: string;
  buildTemplate: FixturePoolOptions['buildTemplate'];
}): QuorumSmokeFixtureTemplatePool {
  if (runtimePool) {
    if (runtimePool.runId !== runId || runtimePool.nonce !== callbackNonce) {
      throw new Error('fixture runtime pool cannot cross callback run/nonce boundaries');
    }
    return runtimePool.pool;
  }
  const inheritedRoot = process.env.PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE;
  const ownsCacheRoot = !inheritedRoot;
  const cacheRoot = inheritedRoot
    ? checkedDirectory(inheritedRoot, 'fixture owned temp base').path
    : checkedDirectory(mkdtempSync(join(tmpdir(), 'proof-or-stop-quorum-fixtures-')), 'fixture owned temp base').path;
  const traceFile = process.env.PROOF_OR_STOP_QUORUM_SMOKE_FIXTURE_TRACE_FILE;
  const resourceTraceFile = process.env.PROOF_OR_STOP_QUORUM_SMOKE_RESOURCE_TRACE_FILE;
  const pool = createQuorumSmokeFixtureTemplatePool({
    cacheRoot,
    buildTemplate,
    trace: callbackNonce && (traceFile || resourceTraceFile) ? (event) => {
      if (traceFile) {
        appendQuorumSmokeTraceLine(traceFile, `${JSON.stringify({
          schema: FIXTURE_TRACE_SCHEMA,
          nonce: callbackNonce,
          runId,
          atMs: Date.now(),
          pid: process.pid,
          ...event,
        })}\n`, 'quorum smoke fixture trace');
      }
      if ((event.type === 'template-build' || event.type === 'fixture-clone') && event.caseId) {
        traceQuorumSmokeResourceAccess({
          runId,
          nonce: callbackNonce,
          caseId: event.caseId,
          op: 'write',
          path: event.type === 'fixture-clone' ? event.cloneRoot! : event.templateRoot,
          resource: 'fixture',
        });
      }
    } : undefined,
  });
  runtimePool = { cacheRoot, ownsCacheRoot, runId, nonce: callbackNonce, pool };
  return pool;
}

export async function disposeQuorumSmokeFixtureRuntimePool(): Promise<{
  profiles: number;
  builds: number;
  clones: number;
  directFixtures: number;
  directFixtureCleanups: number;
  ownedTempBase?: string;
}> {
  const active = runtimePool;
  const directFixtures = runtimeDirectFixtureCount;
  const directFixtureCleanups = runtimeDirectFixtureCleanupCount;
  const leakedDirectRoots = [...runtimeDirectFixtureRoots.values()]
    .filter(record => !record.removed)
    .map(record => record.path);
  let stats = { profiles: 0, builds: 0, clones: 0 };
  let poolError: unknown;
  try {
    if (active) {
      stats = active.pool.stats();
      await active.pool.dispose();
      if (active.ownsCacheRoot) {
        const entry = checkedDirectory(active.cacheRoot, 'fixture runtime-owned cacheRoot cleanup');
        if (readdirSync(entry.path).length !== 0) {
          throw new Error('fixture runtime-owned cacheRoot was not emptied');
        }
        rmdirSync(entry.path);
      }
    }
  } catch (error) {
    poolError = error;
  } finally {
    runtimePool = undefined;
    runtimeDirectFixtureCount = 0;
    runtimeDirectFixtureCleanupCount = 0;
    runtimeDirectFixtureRoots.clear();
  }
  const directError = leakedDirectRoots.length > 0 || directFixtureCleanups !== directFixtures
    ? new Error(
        `direct quorum fixtures did not close allocation/cleanup bijection: allocated=${directFixtures} `
        + `cleaned=${directFixtureCleanups} leaked=${leakedDirectRoots.join(',') || 'none'}`,
      )
    : undefined;
  if (poolError && directError) {
    throw new AggregateError([poolError, directError], 'quorum fixture cleanup failed');
  }
  if (poolError) throw poolError;
  if (directError) throw directError;
  return {
    ...stats,
    directFixtures,
    directFixtureCleanups,
    ...(active ? { ownedTempBase: active.cacheRoot } : {}),
  };
}
