import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LATTICE_DIR } from './lattice-paths.js';

export const OWNER_SESSION_TOKEN_DIR = `${LATTICE_DIR}/runtime/owner-session-tokens`;

interface StoredOwnerSessionToken {
  schemaVersion: 'lattice.owner_session_token.v1';
  provider: string;
  boundaryHash: string;
  token: string;
  createdAt: string;
}

function hashSegment(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function tokenFilePath(projectRoot: string, provider: string, boundary: string): string {
  const providerSegment = hashSegment(provider.trim().toLowerCase() || 'unknown');
  const boundaryHash = hashSegment(boundary);
  return join(projectRoot, OWNER_SESSION_TOKEN_DIR, providerSegment, `${boundaryHash}.json`);
}

function readStoredToken(path: string, provider: string, boundary: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredOwnerSessionToken>;
    if (
      parsed.schemaVersion === 'lattice.owner_session_token.v1' &&
      parsed.provider === provider &&
      parsed.boundaryHash === hashSegment(boundary) &&
      typeof parsed.token === 'string' &&
      parsed.token.trim().length > 0
    ) {
      return parsed.token.trim();
    }
  } catch {
    return null;
  }
  return null;
}

export function readOrCreateOwnerSessionToken(
  projectRoot: string,
  provider: string,
  boundary: string,
  now: () => string = () => new Date().toISOString(),
): string {
  const normalizedProvider = provider.trim().toLowerCase() || 'unknown';
  const trimmedBoundary = boundary.trim();
  if (!projectRoot.trim()) {
    throw new Error('readOrCreateOwnerSessionToken: projectRoot is required');
  }
  if (!trimmedBoundary) {
    throw new Error('readOrCreateOwnerSessionToken: boundary is required');
  }

  const path = tokenFilePath(projectRoot, normalizedProvider, trimmedBoundary);
  const existing = readStoredToken(path, normalizedProvider, trimmedBoundary);
  if (existing !== null) return existing;

  const token = `sess-${randomBytes(16).toString('hex')}`;
  const record: StoredOwnerSessionToken = {
    schemaVersion: 'lattice.owner_session_token.v1',
    provider: normalizedProvider,
    boundaryHash: hashSegment(trimmedBoundary),
    token,
    createdAt: now(),
  };
  mkdirSync(join(projectRoot, OWNER_SESSION_TOKEN_DIR, hashSegment(normalizedProvider)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return token;
}

