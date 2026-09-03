// §1.1.3 target-binding store for the trusted RED-evidence subsystem
// (W2b / B-e10d).
//
// Spec: docs/requirements/decisions/red-evidence-subsystem-spec.md §1.1.3
// (lines 209-238) and §3.3. This leaf owns ONLY the storage + identity + digest
// + committed-tree lookup contract. It deliberately does NOT implement:
//   - the binding-FREEZE rule (chain EMPTY / quarantine-head / frozen-once-run)
//     — that needs chain-head semantics = W2c.
//   - run-time adapterId / testCaseRef validation — that belongs to the runner.
//   - any chain append/read or gate rewiring.
//
// Storage: .proof-or-stop/story/actives/<id>/red-target-bindings.json, schema
//   `proofstory.red_target_bindings.v1`:
//     { schemaVersion, storyId,
//       bindings: [ { acceptanceTargetRef, adapterId, testCaseRef, createdAt } ],
//       createdAt, updatedAt }
//   Exactly ONE binding per acceptanceTargetRef; a duplicate-target write is
//   rejected (not an overwrite).
//
// Digest scope (THE TRAP): `targetBindingDigest` is CANON (W2a canon.ts) over the
//   3-field identity subobject { acceptanceTargetRef, adapterId, testCaseRef }
//   ONLY. Stored entries carry `createdAt`; every validator MUST strip
//   `createdAt` (and any other storage metadata) before canonicalizing. This is
//   an ALLOWLIST of the three identity fields, not a blocklist of `createdAt`.
//
// Assurance scope (§0.6 practical tier): reproducible digests + committed-tree
// lookup detect accidental substitution / casual drift and close the
// swap-after-review reuse path through the registered surfaces. They do not
// resist a hostile local agent that rewrites the store and recomputes every
// digest offline — that is the separate Tier-C program.

import { spawnSync } from 'node:child_process';
import { canonDigest } from './canon.js';

export const RED_TARGET_BINDINGS_SCHEMA_VERSION = 'proofstory.red_target_bindings.v1' as const;
export const RED_TARGET_BINDINGS_FILENAME = 'red-target-bindings.json' as const;

/** The three identity fields the digest is computed over (createdAt EXCLUDED). */
export interface RedTargetBindingIdentity {
  acceptanceTargetRef: string;
  adapterId: string;
  testCaseRef: string;
}

/** A stored binding entry: the three identity fields plus a storage timestamp. */
export interface RedTargetBindingEntry extends RedTargetBindingIdentity {
  createdAt: string;
}

/** The `proofstory.red_target_bindings.v1` file shape. */
export interface RedTargetBindingsFile {
  schemaVersion: typeof RED_TARGET_BINDINGS_SCHEMA_VERSION;
  storyId: string;
  bindings: RedTargetBindingEntry[];
  createdAt: string;
  updatedAt: string;
}

/** Thrown when a second binding is written for an acceptanceTargetRef that already has one. */
export class RedTargetBindingDuplicateError extends Error {
  constructor(public readonly acceptanceTargetRef: string) {
    super(
      `red_target_bindings: duplicate target binding for acceptanceTargetRef "${acceptanceTargetRef}" — exactly one binding is allowed per target (§1.1.3); retire the assertion first, do not overwrite`,
    );
    this.name = 'RedTargetBindingDuplicateError';
  }
}

function requireNonBlank(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`red_target_bindings: ${field} must be a non-blank string`);
  }
  return value;
}

/**
 * Return exactly the three identity fields of a binding-shaped object, dropping
 * `createdAt` and any other storage metadata. ALLOWLIST-based: only the three
 * named fields survive, so a future extra field can never leak into the digest.
 */
export function strippedBindingIdentity(binding: RedTargetBindingIdentity): RedTargetBindingIdentity {
  return {
    acceptanceTargetRef: binding.acceptanceTargetRef,
    adapterId: binding.adapterId,
    testCaseRef: binding.testCaseRef,
  };
}

/**
 * `targetBindingDigest` = CANON (W2a) over the createdAt-STRIPPED three-field
 * identity subobject ONLY. Accepts either a bare identity or a full stored entry
 * (with createdAt / extra metadata) — both canonicalize to the same three-field
 * subobject and therefore the same digest.
 */
export function targetBindingDigest(binding: RedTargetBindingIdentity): string {
  return canonDigest(strippedBindingIdentity(binding));
}

/** A fresh, empty `proofstory.red_target_bindings.v1` file for a story. */
export function emptyRedTargetBindingsFile(storyId: string, now: string = new Date().toISOString()): RedTargetBindingsFile {
  return {
    schemaVersion: RED_TARGET_BINDINGS_SCHEMA_VERSION,
    storyId: requireNonBlank(storyId, 'storyId'),
    bindings: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Locate the stored binding for a target, or undefined. Case-sensitive. */
export function findTargetBinding(file: RedTargetBindingsFile, acceptanceTargetRef: string): RedTargetBindingEntry | undefined {
  return file.bindings.find((entry) => entry.acceptanceTargetRef === acceptanceTargetRef);
}

/**
 * Append a NEW binding for `identity`. Enforces exactly one binding per
 * acceptanceTargetRef: a second write for the same ref throws
 * {@link RedTargetBindingDuplicateError} (never an overwrite). Pure — returns a
 * new file object and does not mutate the input.
 */
export function appendTargetBinding(
  file: RedTargetBindingsFile,
  identity: RedTargetBindingIdentity,
  now: string = new Date().toISOString(),
): RedTargetBindingsFile {
  const acceptanceTargetRef = requireNonBlank(identity.acceptanceTargetRef, 'acceptanceTargetRef');
  const adapterId = requireNonBlank(identity.adapterId, 'adapterId');
  const testCaseRef = requireNonBlank(identity.testCaseRef, 'testCaseRef');
  if (findTargetBinding(file, acceptanceTargetRef)) {
    throw new RedTargetBindingDuplicateError(acceptanceTargetRef);
  }
  const entry: RedTargetBindingEntry = { acceptanceTargetRef, adapterId, testCaseRef, createdAt: now };
  return {
    ...file,
    bindings: [...file.bindings, entry],
    updatedAt: now,
  };
}

function runGit(gitCwd: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('git', [...args], { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export interface ReadCommittedTargetBindingsArgs {
  /** Repo working directory the git commands run in. */
  gitCwd: string;
  /** Committed ref (commit sha / branch / tag) whose tree the binding is read from. */
  ref: string;
  /** Repo-relative path, e.g. `.proof-or-stop/story/actives/<id>/red-target-bindings.json`. */
  relPath: string;
}

/**
 * §1.1.3 anti-swap lookup: resolve the binding file from the COMMITTED tree
 * `<ref>:<relPath>` via `git show`, NEVER the live story directory. An
 * uncommitted or post-review edit is therefore invisible to the run.
 *
 * Fail-closed semantics:
 *   - an invalid / nonexistent `ref` THROWS (never a silent fall back to the
 *     live directory);
 *   - a valid ref that simply lacks the file returns `null` (no crash);
 *   - a present-but-unparseable blob THROWS (corrupt committed evidence).
 */
export function readCommittedTargetBindings(args: ReadCommittedTargetBindingsArgs): RedTargetBindingsFile | null {
  const { gitCwd, ref, relPath } = args;
  requireNonBlank(ref, 'ref');
  requireNonBlank(relPath, 'relPath');

  // 1) Validate the ref resolves to a real object. A bad ref fails closed here,
  //    BEFORE any read — so a nonexistent ref can never degrade into a live read.
  const verify = runGit(gitCwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (verify.status !== 0 || verify.stdout.trim().length === 0) {
    throw new Error(
      `red_target_bindings: committed-tree reader refused — ref "${ref}" does not resolve to a commit in ${gitCwd} (fail-closed; never falls back to the live directory)`,
    );
  }

  // 2) Read the blob at the committed path. A missing file at a valid ref => null.
  const show = runGit(gitCwd, ['show', `${ref}:${relPath}`]);
  if (show.status !== 0) return null;

  try {
    return JSON.parse(show.stdout) as RedTargetBindingsFile;
  } catch (e) {
    throw new Error(
      `red_target_bindings: committed binding at ${ref}:${relPath} is not valid JSON — ${(e as Error).message}`,
    );
  }
}
