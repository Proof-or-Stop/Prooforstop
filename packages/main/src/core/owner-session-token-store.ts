import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';

export const OWNER_SESSION_TOKEN_DIR = `${PROOF_OR_STOP_DIR}/runtime/owner-session-tokens`;
export const OWNER_SESSION_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const OWNER_SESSION_TOKEN_LOCK_STALE_MS = 30_000;
const OWNER_SESSION_TOKEN_LOCK_WAIT_MS = 2_000;

interface StoredOwnerSessionToken {
  schemaVersion: 'proof-or-stop.owner_session_token.v2';
  provider: string;
  taskHash: string;
  agentOrRoleHash: string;
  boundaryHash: string;
  token: string;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt: string;
}

export interface OwnerSessionTokenStoreHealth {
  total: number;
  healthy: number;
  expired: number;
  corrupt: number;
  orphanLocks: number;
  orphanTemps: number;
  needsRepair: boolean;
}

export interface OwnerSessionTokenStoreRepair {
  removedExpired: number;
  removedCorrupt: number;
  removedLocks: number;
  removedTemps: number;
  health: OwnerSessionTokenStoreHealth;
}

function hashSegment(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function tokenFilePath(
  projectRoot: string,
  provider: string,
  taskIdentity: string,
  agentOrRoleIdentity: string,
  boundary: string,
): string {
  const providerSegment = hashSegment(provider.trim().toLowerCase() || 'unknown');
  const scopeHash = hashSegment([
    'proof-or-stop.owner-session-token.v2',
    projectRoot,
    provider,
    taskIdentity,
    agentOrRoleIdentity,
    boundary,
  ].join('\0'));
  return join(projectRoot, OWNER_SESSION_TOKEN_DIR, providerSegment, `${scopeHash}.json`);
}

function tokenExpiryMs(record: Partial<StoredOwnerSessionToken>): number {
  const explicit = Date.parse(String(record.expiresAt ?? ''));
  if (Number.isFinite(explicit)) return explicit;
  const created = Date.parse(String(record.createdAt ?? ''));
  return Number.isFinite(created) ? created + OWNER_SESSION_TOKEN_TTL_MS : Number.NaN;
}

function parseStoredToken(path: string): Partial<StoredOwnerSessionToken> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredOwnerSessionToken>;
  } catch {
    return {};
  }
}

function isStructurallyValid(record: Partial<StoredOwnerSessionToken>): boolean {
  return record.schemaVersion === 'proof-or-stop.owner_session_token.v2'
    && typeof record.provider === 'string'
    && typeof record.taskHash === 'string'
    && typeof record.agentOrRoleHash === 'string'
    && typeof record.boundaryHash === 'string'
    && typeof record.token === 'string'
    && record.token.trim().length > 0
    && Number.isFinite(Date.parse(String(record.createdAt ?? '')))
    && Number.isFinite(tokenExpiryMs(record));
}

function readStoredToken(
  path: string,
  provider: string,
  taskIdentity: string,
  agentOrRoleIdentity: string,
  boundary: string,
  nowMs: number,
): StoredOwnerSessionToken | null {
  const parsed = parseStoredToken(path);
  if (
    parsed !== null
    && isStructurallyValid(parsed)
    && parsed.provider === provider
    && parsed.taskHash === hashSegment(taskIdentity)
    && parsed.agentOrRoleHash === hashSegment(agentOrRoleIdentity)
    && parsed.boundaryHash === hashSegment(boundary)
    && tokenExpiryMs(parsed) > nowMs
  ) {
    return parsed as StoredOwnerSessionToken;
  }
  return null;
}

function writeStoredTokenAtomic(path: string, record: StoredOwnerSessionToken): void {
  const tempPath = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    renameSync(tempPath, path);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireTokenLock(lockPath: string): void {
  const deadline = Date.now() + OWNER_SESSION_TOKEN_LOCK_WAIT_MS;
  while (Date.now() <= deadline) {
    try {
      mkdirSync(lockPath);
      return;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs >= OWNER_SESSION_TOKEN_LOCK_STALE_MS) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      sleepSync(10);
    }
  }
  throw new Error('owner-session token store is busy; retry the command');
}

function releaseTokenLock(lockPath: string): void {
  rmSync(lockPath, { recursive: true, force: true });
}

function hasActiveTokenLock(lockPath: string, nowMs: number): boolean {
  if (!existsSync(lockPath)) return false;
  try {
    return nowMs - statSync(lockPath).mtimeMs < OWNER_SESSION_TOKEN_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function listTokenStoreFiles(projectRoot: string): string[] {
  const root = join(projectRoot, OWNER_SESSION_TOKEN_DIR);
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const providerEntry of readdirSync(root, { withFileTypes: true })) {
    const providerPath = join(root, providerEntry.name);
    if (!providerEntry.isDirectory()) {
      files.push(providerPath);
      continue;
    }
    for (const entry of readdirSync(providerPath, { withFileTypes: true })) {
      files.push(join(providerPath, entry.name));
    }
  }
  return files;
}

export function scanOwnerSessionTokenStore(
  projectRoot: string,
  nowMs: number = Date.now(),
): OwnerSessionTokenStoreHealth {
  const health: OwnerSessionTokenStoreHealth = {
    total: 0,
    healthy: 0,
    expired: 0,
    corrupt: 0,
    orphanLocks: 0,
    orphanTemps: 0,
    needsRepair: false,
  };
  for (const path of listTokenStoreFiles(projectRoot)) {
    if (path.endsWith('.lock')) {
      if (!hasActiveTokenLock(path, nowMs)) health.orphanLocks += 1;
      continue;
    }
    if (path.includes('.tmp-')) {
      const finalPath = path.slice(0, path.indexOf('.tmp-'));
      if (!hasActiveTokenLock(`${finalPath}.lock`, nowMs)) health.orphanTemps += 1;
      continue;
    }
    if (!path.endsWith('.json')) continue;
    health.total += 1;
    const parsed = parseStoredToken(path);
    if (parsed === null || !isStructurallyValid(parsed)) {
      health.corrupt += 1;
    } else if (tokenExpiryMs(parsed) <= nowMs) {
      health.expired += 1;
    } else {
      health.healthy += 1;
    }
  }
  health.needsRepair = health.expired > 0
    || health.corrupt > 0
    || health.orphanLocks > 0
    || health.orphanTemps > 0;
  return health;
}

export function repairOwnerSessionTokenStore(
  projectRoot: string,
  nowMs: number = Date.now(),
): OwnerSessionTokenStoreRepair {
  const removed = {
    removedExpired: 0,
    removedCorrupt: 0,
    removedLocks: 0,
    removedTemps: 0,
  };
  for (const path of listTokenStoreFiles(projectRoot)) {
    if (path.endsWith('.lock')) {
      try {
        if (nowMs - statSync(path).mtimeMs < OWNER_SESSION_TOKEN_LOCK_STALE_MS) continue;
      } catch { /* remove vanished/broken lock below */ }
      rmSync(path, { recursive: true, force: true });
      removed.removedLocks += 1;
      continue;
    }
    if (path.includes('.tmp-')) {
      const finalPath = path.slice(0, path.indexOf('.tmp-'));
      if (hasActiveTokenLock(`${finalPath}.lock`, nowMs)) continue;
      rmSync(path, { force: true });
      removed.removedTemps += 1;
      continue;
    }
    if (!path.endsWith('.json')) continue;
    if (hasActiveTokenLock(`${path}.lock`, nowMs)) continue;
    const parsed = parseStoredToken(path);
    if (parsed === null || !isStructurallyValid(parsed)) {
      rmSync(path, { force: true });
      removed.removedCorrupt += 1;
    } else if (tokenExpiryMs(parsed) <= nowMs) {
      rmSync(path, { force: true });
      removed.removedExpired += 1;
    }
  }
  return {
    ...removed,
    health: scanOwnerSessionTokenStore(projectRoot, nowMs),
  };
}

export function removeOwnerSessionTokenForScope(
  projectRoot: string,
  provider: string,
  taskIdentity: string,
  agentOrRoleIdentity: string,
  boundary: string,
): boolean {
  const path = tokenFilePath(
    projectRoot,
    provider.trim().toLowerCase() || 'unknown',
    taskIdentity.trim(),
    agentOrRoleIdentity.trim(),
    boundary.trim(),
  );
  if (!existsSync(path)) return false;
  const lockPath = `${path}.lock`;
  acquireTokenLock(lockPath);
  try {
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  } finally {
    releaseTokenLock(lockPath);
  }
}

export function readOrCreateOwnerSessionToken(
  projectRoot: string,
  provider: string,
  taskIdentity: string,
  agentOrRoleIdentity: string,
  boundary: string,
  now: () => string = () => new Date().toISOString(),
): string {
  const normalizedProvider = provider.trim().toLowerCase() || 'unknown';
  const trimmedTaskIdentity = taskIdentity.trim();
  const trimmedAgentOrRoleIdentity = agentOrRoleIdentity.trim();
  const trimmedBoundary = boundary.trim();
  if (!projectRoot.trim()) {
    throw new Error('readOrCreateOwnerSessionToken: projectRoot is required');
  }
  if (!trimmedTaskIdentity) {
    throw new Error('readOrCreateOwnerSessionToken: taskIdentity is required');
  }
  if (!trimmedAgentOrRoleIdentity) {
    throw new Error('readOrCreateOwnerSessionToken: agentOrRoleIdentity is required');
  }
  if (!trimmedBoundary) {
    throw new Error('readOrCreateOwnerSessionToken: boundary is required');
  }

  const path = tokenFilePath(
    projectRoot,
    normalizedProvider,
    trimmedTaskIdentity,
    trimmedAgentOrRoleIdentity,
    trimmedBoundary,
  );
  const nowIso = now();
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    throw new Error('readOrCreateOwnerSessionToken: now() must return a valid ISO timestamp');
  }
  const providerDir = join(projectRoot, OWNER_SESSION_TOKEN_DIR, hashSegment(normalizedProvider));
  mkdirSync(providerDir, { recursive: true });
  const lockPath = `${path}.lock`;
  acquireTokenLock(lockPath);
  try {
    const existing = readStoredToken(
      path,
      normalizedProvider,
      trimmedTaskIdentity,
      trimmedAgentOrRoleIdentity,
      trimmedBoundary,
      nowMs,
    );
    if (existing !== null) {
      writeStoredTokenAtomic(path, {
        ...existing,
        token: existing.token.trim(),
        lastUsedAt: nowIso,
        expiresAt: new Date(nowMs + OWNER_SESSION_TOKEN_TTL_MS).toISOString(),
      });
      return existing.token.trim();
    }
    if (existsSync(path)) rmSync(path, { force: true });
    const token = `sess-${randomBytes(16).toString('hex')}`;
    writeStoredTokenAtomic(path, {
      schemaVersion: 'proof-or-stop.owner_session_token.v2',
      provider: normalizedProvider,
      taskHash: hashSegment(trimmedTaskIdentity),
      agentOrRoleHash: hashSegment(trimmedAgentOrRoleIdentity),
      boundaryHash: hashSegment(trimmedBoundary),
      token,
      createdAt: nowIso,
      lastUsedAt: nowIso,
      expiresAt: new Date(nowMs + OWNER_SESSION_TOKEN_TTL_MS).toISOString(),
    });
    return token;
  } finally {
    releaseTokenLock(lockPath);
  }
}
