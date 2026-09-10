import { resolveValidationSigningRoot } from './validation-signing-context.js';
/**
 * Trust boundary for story-aware validation artifacts.
 *
 * Validation receipts, closure certificates, selection manifests, shard
 * receipts, and revocation ledgers live beneath writable runtime directories.
 * A digest only detects accidental drift: an artifact writer can change its
 * payload and calculate a new digest. This module keeps the Ed25519 private
 * key in the repository's shared Git metadata directory instead.
 *
 * The key is shared by linked worktrees through git-common-dir, so an artifact
 * produced in a Story worktree remains verifiable from the repository root.
 * `verifyValidationArtifact` never creates a key; missing, malformed,
 * wrong-key, or legacy digest signatures fail closed.
 */
import { execFileSync } from 'node:child_process';
import { createPublicKey, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  exportPublicKeyRaw,
  importPrivateKeyRaw,
  signCanonical,
  verifyCanonical,
} from './authority-signing.js';

export const VALIDATION_ARTIFACT_SIGNING_KEY_ID = 'validation-artifact-v1' as const;
const SIGNATURE_PREFIX = `ed25519:${VALIDATION_ARTIFACT_SIGNING_KEY_ID}:`;
const KEY_FILENAME = 'proof-story-aware-validation-artifact-v1.key';

function gitCommonDir(gitCwd: string): string {
  const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: gitCwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!raw) throw new Error('validation artifact signer requires a Git common directory');
  return isAbsolute(raw) ? raw : resolve(gitCwd, raw);
}

function keyPath(gitCwd = resolveValidationSigningRoot()): string {
  return join(gitCommonDir(gitCwd), KEY_FILENAME);
}

function publicKeyForPrivate(privateKey: string): string {
  return exportPublicKeyRaw(createPublicKey(importPrivateKeyRaw(privateKey)));
}

function readPrivateKeyForSigning(gitCwd = resolveValidationSigningRoot()): string {
  const path = keyPath(gitCwd);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    // Publish complete bytes without replacing a competing initializer's key.
    // Creating the canonical file with wx exposes both EEXIST races and a
    // partially written key. A hard link is an atomic no-replace publication.
    const temporary = `${path}.${randomUUID()}.tmp`;
    let descriptor: number | undefined = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(descriptor, randomBytes(32).toString('base64'), 'utf8');
      closeSync(descriptor);
      descriptor = undefined;
      try { linkSync(temporary, path); }
      catch (error: any) { if (error?.code !== 'EEXIST') throw error; }
    } finally {
      try { if (descriptor !== undefined) closeSync(descriptor); }
      finally {
        try { unlinkSync(temporary); }
        catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
      }
    }
  }
  const privateKey = readFileSync(path, 'utf8').trim();
  // Validate the stored secret before signing rather than emitting a receipt
  // whose key cannot later be resolved by a verifier.
  publicKeyForPrivate(privateKey);
  return privateKey;
}

function readTrustedPublicKey(gitCwd = resolveValidationSigningRoot()): string | undefined {
  try {
    const path = keyPath(gitCwd);
    if (!existsSync(path)) return undefined;
    return publicKeyForPrivate(readFileSync(path, 'utf8').trim());
  } catch {
    return undefined;
  }
}

/** Sign a canonical validation artifact with the repository-local Ed25519 key. */
export function signValidationArtifact(value: unknown, gitCwd = resolveValidationSigningRoot()): string {
  return SIGNATURE_PREFIX + signCanonical(value, readPrivateKeyForSigning(gitCwd));
}

/**
 * Verify a validation artifact against the trusted key in Git metadata.
 * No compatibility path accepts the old `sha256:<digest>` spelling.
 */
export function verifyValidationArtifact(value: unknown, signature: unknown, gitCwd = resolveValidationSigningRoot()): boolean {
  if (typeof signature !== 'string' || !signature.startsWith(SIGNATURE_PREFIX)) return false;
  const encoded = signature.slice(SIGNATURE_PREFIX.length);
  if (!encoded || encoded.includes(':')) return false;
  const publicKey = readTrustedPublicKey(gitCwd);
  return Boolean(publicKey && verifyCanonical(value, encoded, publicKey));
}

/** Exposed for focused diagnostics; never returns private material. */
export function validationArtifactSigningPublicKey(gitCwd = resolveValidationSigningRoot()): string | undefined {
  return readTrustedPublicKey(gitCwd);
}

/** Verify every envelope against a freshly resolved repository key. The key is
 * re-read after the synchronous batch, so replacement/deletion during traversal
 * invalidates the entire result. No memo survives a call or accepts a caller key. */
export function verifyValidationArtifacts(entries:ReadonlyArray<{value:unknown;signature:unknown}>,gitCwd= resolveValidationSigningRoot()):boolean[] {
  if(entries.length<=1)return entries.map(entry=>verifyValidationArtifact(entry.value,entry.signature,gitCwd));
  const key=readTrustedPublicKey(gitCwd);
  if(!key)return entries.map(()=>false);
  const results=entries.map(({value,signature})=>{
    if(typeof signature!=='string'||!signature.startsWith(SIGNATURE_PREFIX))return false;
    const encoded=signature.slice(SIGNATURE_PREFIX.length);
    return Boolean(encoded&&!encoded.includes(':')&&verifyCanonical(value,encoded,key));
  });
  return readTrustedPublicKey(gitCwd)===key?results:entries.map(()=>false);
}
