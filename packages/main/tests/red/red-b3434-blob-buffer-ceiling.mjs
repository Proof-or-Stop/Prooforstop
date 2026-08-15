#!/usr/bin/env node
/**
 * RED (repro-first) for B-3434 — the isolated metadata commit path must survive a staged blob
 * larger than Node's default `execFileSync` maxBuffer (1,048,576 bytes).
 *
 * Baseline (pre-fix tree): FAILS. `isolatedBlobHash` / `treeBlobHash` in
 * core/done-prepare-generated-metadata.ts call `execFileSync('git', ['show', ...])` with no
 * `maxBuffer`, so a larger staged blob throws ENOBUFS, the bare `catch { return null }` converts
 * that infrastructure failure into `null`, and `commitImmutableMetadataTree` compares `null`
 * against the expected digest and reports "verified metadata changed after manifest verification".
 * That message names concurrent modification, which is not the cause — the buffer ceiling is.
 *
 * After the fix: PASSES. Every blob/tree read carries an explicit generous maxBuffer, and a read
 * that genuinely cannot complete is reported as an unreadable-blob infrastructure failure that is
 * textually distinct both from a genuinely absent blob and from a genuine digest change.
 *
 * Fixture sizes are deliberate: 1,400,000 bytes matches the measured test-evidence.json on story
 * B-9ff1, and 1,048,577 bytes is exactly one byte past the old Node default — the smallest input
 * that triggers the defect. A fixture below 1,048,576 bytes passes on the UNFIXED tree and proves
 * nothing, which is precisely how this defect survived.
 *
 * Runs standalone: node packages/main/tests/red/red-b3434-blob-buffer-ceiling.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Hermetic git: no user/system config can inject filters, hooksPath, signing or autocrlf into the
// fixture repositories (the module under test spawns git with `{ ...process.env }`).
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';

import * as metadata from '../../dist/core/done-prepare-generated-metadata.js';

const here = dirname(fileURLToPath(import.meta.url));
let repoRoot = here;
while (!existsSync(join(repoRoot, 'lattice.config.json')) && repoRoot !== dirname(repoRoot)) {
  repoRoot = dirname(repoRoot);
}
assert.ok(existsSync(join(repoRoot, 'lattice.config.json')), 'could not locate repo root (lattice.config.json)');

const NODE_DEFAULT_MAX_BUFFER = 1024 * 1024; // 1,048,576 — the ceiling that caused the defect
const READ_BUFFER = 256 * 1024 * 1024; // this test's own reads must never be the thing that fails
const temporaryRoots = [];

function git(cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: READ_BUFFER,
    ...options,
  });
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Deterministic xorshift32 bytes. Two properties matter: the sequence is reproducible from the
 * seed (so a failure is re-runnable), and it is high-entropy, so no gitattributes filter, zlib
 * object compression, delta packing or encoding normalisation anywhere in the pipeline can shrink
 * what `git show` hands back below the 1,048,576-byte ceiling under test.
 */
function deterministicBytes(size, seed) {
  const buffer = Buffer.allocUnsafe(size);
  let state = seed >>> 0;
  for (let index = 0; index < size; index += 1) {
    state ^= (state << 13) >>> 0;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= (state << 5) >>> 0;
    state >>>= 0;
    buffer[index] = state & 0xff;
  }
  return buffer;
}

function makeRepo(label) {
  const root = mkdtempSync(join(tmpdir(), `b3434-${label}-`));
  temporaryRoots.push(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'red-b3434@noreply.local']);
  git(root, ['config', 'user.name', 'red-b3434']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['config', 'core.autocrlf', 'false']);
  const emptyHooks = join(root, 'no-hooks');
  mkdirSync(emptyHooks, { recursive: true });
  git(root, ['config', 'core.hooksPath', emptyHooks]);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  git(root, ['add', 'base.txt']);
  git(root, ['commit', '-q', '--no-verify', '-m', 'base']);
  return root;
}

function stageOversizedBlob(root, name, size, seed) {
  const content = deterministicBytes(size, seed);
  writeFileSync(join(root, name), content);
  git(root, ['add', '--', name]);
  return { content, digest: sha256(content) };
}

function cleanup() {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
}

const failures = [];
function section(title, body) {
  try {
    body();
    console.log(`✓ ${title}`);
  } catch (error) {
    failures.push(`${title}: ${error?.message ?? error}`);
    console.log(`✗ ${title}\n    ${String(error?.message ?? error).split('\n').join('\n    ')}`);
  }
}

// ── 1. The fixture really is above the ceiling, end to end. ─────────────────────────────────────
section('fixture blob survives the git pipeline above 1,048,576 bytes', () => {
  const root = makeRepo('fixture');
  const size = 1_400_000;
  const staged = stageOversizedBlob(root, 'evidence.json', size, 0x3434_0001);
  assert.ok(size > NODE_DEFAULT_MAX_BUFFER, 'fixture size must exceed the old Node maxBuffer default');
  assert.equal(
    Number(git(root, ['cat-file', '-s', ':evidence.json']).trim()),
    size,
    'the staged blob keeps its full byte length in the index (no filter shrank it)',
  );
  const shown = execFileSync('git', ['show', ':evidence.json'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: READ_BUFFER,
  });
  assert.equal(shown.length, size, 'git show hands back the full byte length, so a reader must buffer more than 1 MiB');
  assert.equal(sha256(shown), staged.digest, 'round-tripped bytes are identical to what was staged');
});

// ── 2. CHK-001 happy: 1,400,000 bytes through the real commit path. ─────────────────────────────
section('commitImmutableMetadataTree commits a 1,400,000-byte staged blob', () => {
  const root = makeRepo('happy');
  const staged = stageOversizedBlob(root, 'evidence.json', 1_400_000, 0x3434_0002);
  const result = metadata.commitImmutableMetadataTree({
    root,
    gitCwd: root,
    paths: ['evidence.json'],
    verifiedHashes: new Map([['evidence.json', staged.digest]]),
    message: 'red-b3434: oversized generated metadata',
  });
  assert.equal(
    result.ok,
    true,
    `RED: a 1,400,000-byte staged blob must commit, got ok=false reason="${result.reason}". `
      + 'Pre-fix this is "verified metadata changed after manifest verification" — a message naming '
      + 'concurrent modification for what is actually the 1,048,576-byte execFileSync buffer ceiling.',
  );
  assert.match(String(result.commitSha), /^[0-9a-f]{40}$/, 'a successful commit reports a real commit sha');
  assert.equal(
    Number(git(root, ['cat-file', '-s', 'HEAD:evidence.json']).trim()),
    1_400_000,
    'the committed blob carries the full oversized content',
  );
  assert.equal(
    sha256(execFileSync('git', ['show', 'HEAD:evidence.json'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: READ_BUFFER })),
    staged.digest,
    'the committed content is byte-identical to the verified content',
  );
});

// ── 3. CHK-001 edge: exactly one byte past the old default. ─────────────────────────────────────
section('commitImmutableMetadataTree commits a 1,048,577-byte staged blob (one byte past the old default)', () => {
  const root = makeRepo('edge');
  const size = NODE_DEFAULT_MAX_BUFFER + 1;
  const staged = stageOversizedBlob(root, 'evidence.json', size, 0x3434_0003);
  const result = metadata.commitImmutableMetadataTree({
    root,
    gitCwd: root,
    paths: ['evidence.json'],
    verifiedHashes: new Map([['evidence.json', staged.digest]]),
    message: 'red-b3434: boundary generated metadata',
  });
  assert.equal(
    result.ok,
    true,
    `RED: the smallest blob past the old ceiling (${size} bytes) must commit, got ok=false reason="${result.reason}"`,
  );
  assert.match(String(result.commitSha), /^[0-9a-f]{40}$/, 'a successful boundary commit reports a real commit sha');
});

// ── 4. CHK-001 adversarial: every blob/tree read in the module carries an explicit maxBuffer. ────
section('isolatedBlobHash, isolatedGit and treeBlobHash each pass maxBuffer to execFileSync', () => {
  const sourcePath = join(repoRoot, 'packages/main/src/core/done-prepare-generated-metadata.ts');
  const source = readFileSync(sourcePath, 'utf8');
  for (const name of ['isolatedGit', 'isolatedBlobHash', 'treeBlobHash']) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} must still exist in done-prepare-generated-metadata.ts`);
    const open = source.indexOf('{', start);
    let depth = 0;
    let end = open;
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      if (source[index] === '}') {
        depth -= 1;
        if (depth === 0) { end = index; break; }
      }
    }
    const body = source.slice(start, end + 1);
    assert.ok(
      body.includes('execFileSync'),
      `${name} is expected to read through execFileSync`,
    );
    assert.ok(
      body.includes('maxBuffer'),
      `RED: ${name} calls execFileSync without an explicit maxBuffer, so Node's 1,048,576-byte default `
        + 'applies and a larger blob or tree read throws ENOBUFS. Patching only the helper the incident '
        + 'transcript named leaves the identical latent limit on its siblings.',
    );
  }
  assert.ok(
    typeof metadata.METADATA_BLOB_READ_MAX_BUFFER_BYTES === 'number',
    'the module must export the explicit ceiling it applies',
  );
  assert.ok(
    metadata.METADATA_BLOB_READ_MAX_BUFFER_BYTES >= 10 * 1024 * 1024,
    `RED: the ceiling must be at least an order of magnitude above the 1 MiB default (got `
      + `${metadata.METADATA_BLOB_READ_MAX_BUFFER_BYTES}); the artifact grows with the number of configured `
      + 'validate commands, so a ceiling barely above 1 MiB just recreates the cliff at a higher count.',
  );
});

// ── 5. CHK-002: a readable blob still hashes correctly. ─────────────────────────────────────────
section('isolatedBlobHash and treeBlobHash return the correct sha256 for a readable blob', () => {
  assert.equal(typeof metadata.isolatedBlobHash, 'function', 'isolatedBlobHash must be exported for direct verification');
  assert.equal(typeof metadata.treeBlobHash, 'function', 'treeBlobHash must be exported for direct verification');
  const root = makeRepo('readable');
  const staged = stageOversizedBlob(root, 'evidence.json', 1_200_000, 0x3434_0004);
  const indexFile = join(root, '.git', 'index');
  const indexRead = metadata.isolatedBlobHash(root, indexFile, 'evidence.json');
  assert.equal(indexRead.ok, true, `RED: a readable oversized staged blob must read, got ${JSON.stringify(indexRead)}`);
  assert.equal(indexRead.hash, staged.digest, 'the staged blob hashes to its sha256');
  const tree = git(root, ['write-tree']).trim();
  const treeRead = metadata.treeBlobHash(root, tree, 'evidence.json');
  assert.equal(treeRead.ok, true, `RED: a readable oversized tree blob must read, got ${JSON.stringify(treeRead)}`);
  assert.equal(treeRead.hash, staged.digest, 'the tree blob hashes to its sha256');
});

// ── 6. CHK-002: absent and unreadable stay distinguishable, and both fail closed. ────────────────
section('an absent blob and an unreadable blob are distinct, diagnostic, and never compare equal', () => {
  const root = makeRepo('diagnosable');
  const staged = stageOversizedBlob(root, 'evidence.json', 1_100_000, 0x3434_0005);
  const indexFile = join(root, '.git', 'index');

  const absent = metadata.isolatedBlobHash(root, indexFile, 'not-staged.json');
  assert.equal(absent.ok, false, 'a path that is not in the index cannot be read');
  assert.equal(
    absent.kind,
    'absent',
    `RED: a blob that is genuinely missing from the index must classify as absent, got ${JSON.stringify(absent)}`,
  );
  assert.ok(String(absent.error).length > 0, 'the absent classification still carries the underlying git message');

  // An infrastructure failure that is not "the path is missing": git cannot operate here at all.
  const notARepo = mkdtempSync(join(tmpdir(), 'b3434-notrepo-'));
  temporaryRoots.push(notARepo);
  const unreadable = metadata.isolatedBlobHash(notARepo, join(notARepo, 'index'), 'evidence.json');
  assert.equal(unreadable.ok, false, 'a read that cannot complete is not a successful read');
  assert.equal(
    unreadable.kind,
    'unreadable',
    `RED: an infrastructure failure must classify as unreadable, not as a missing blob and not as a `
      + `digest change, got ${JSON.stringify(unreadable)}`,
  );
  assert.ok(
    String(unreadable.error).length > 0,
    'RED: the underlying error must survive; the pre-fix `catch { return null }` discarded it entirely',
  );

  // Fail-closed: an unreadable or absent read can never be reported as a match, for ANY expectation,
  // including the digest of the real content and the digest a caller might supply by accident.
  assert.equal(typeof metadata.classifyMetadataBlobDigestComparison, 'function', 'the comparison classifier must be exported');
  for (const expected of [staged.digest, sha256(''), 'not-a-hash', undefined]) {
    assert.equal(
      metadata.classifyMetadataBlobDigestComparison(unreadable, expected),
      'unreadable',
      `RED: an unreadable blob must never compare equal (expected=${String(expected)})`,
    );
    assert.equal(
      metadata.classifyMetadataBlobDigestComparison(absent, expected),
      'absent',
      `RED: an absent blob must never compare equal (expected=${String(expected)})`,
    );
  }
  const readable = metadata.isolatedBlobHash(root, indexFile, 'evidence.json');
  assert.equal(metadata.classifyMetadataBlobDigestComparison(readable, staged.digest), 'match', 'a matching readable blob is a match');
  assert.equal(metadata.classifyMetadataBlobDigestComparison(readable, sha256('other')), 'changed', 'a differing readable blob is a genuine change');
});

// ── 7. CHK-002: the commit path names the real cause instead of the misleading message. ──────────
section('an unreadable blob during the commit path never reports "verified metadata changed"', () => {
  const root = makeRepo('unreadable-commit');
  const staged = stageOversizedBlob(root, 'evidence.json', 1_150_000, 0x3434_0006);
  const objectsDir = join(root, '.git', 'objects');
  const blobSha = git(root, ['rev-parse', ':evidence.json']).trim();
  const result = metadata.commitImmutableMetadataTree({
    root,
    gitCwd: root,
    paths: ['evidence.json'],
    verifiedHashes: new Map([['evidence.json', staged.digest]]),
    message: 'red-b3434: unreadable object',
    testHooks: {
      afterAddBeforeCommit: () => {
        // Destroy the object the staged entry points at: the index entry still exists, so this is
        // an unreadable blob, not an absent one.
        const loose = join(objectsDir, blobSha.slice(0, 2), blobSha.slice(2));
        if (existsSync(loose)) unlinkSync(loose);
        for (const name of existsSync(join(objectsDir, 'pack')) ? readdirSync(join(objectsDir, 'pack')) : []) {
          unlinkSync(join(objectsDir, 'pack', name));
        }
      },
    },
  });
  assert.equal(result.ok, false, 'a destroyed object must fail closed');
  assert.notEqual(
    result.reason,
    'verified metadata changed after manifest verification',
    'RED: an infrastructure read failure must not be reported as concurrent modification',
  );
  assert.ok(
    /unable to read|not a valid object|missing|unreadable|could not be read|bad file|ENOBUFS/i.test(String(result.reason)),
    `RED: the surfaced reason must name the underlying failure, got "${result.reason}"`,
  );
});

// ── 8. CHK-002: a GENUINE change is still reported as a change (no regression, distinct text). ───
section('a genuine post-verification change still reports "verified metadata changed"', () => {
  const root = makeRepo('changed');
  const staged = stageOversizedBlob(root, 'evidence.json', 1_120_000, 0x3434_0007);
  const result = metadata.commitImmutableMetadataTree({
    root,
    gitCwd: root,
    paths: ['evidence.json'],
    verifiedHashes: new Map([['evidence.json', sha256(Buffer.concat([staged.content, Buffer.from('x')]))]]),
    message: 'red-b3434: genuine change',
  });
  assert.equal(result.ok, false, 'a digest that does not match the verified manifest must fail closed');
  assert.equal(
    result.reason,
    'verified metadata changed after manifest verification',
    `RED: a genuine digest change must keep its own distinct message, got "${result.reason}"`,
  );
});

cleanup();

if (failures.length > 0) {
  console.error(`\nred-b3434-blob-buffer-ceiling: FAIL (${failures.length} section(s))`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\nred-b3434-blob-buffer-ceiling: PASS');
