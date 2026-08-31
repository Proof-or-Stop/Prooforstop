#!/usr/bin/env node
/**
 * B-cc10 CHK-006 — the deprecated bin aliases are REMOVED, and their removal is ANNOUNCED.
 *
 * WHY THIS EXISTS
 * ---------------
 * B-cdf6 kept both retired bin wrappers as deprecated aliases and
 * documented that they "keep working". B-cc10 CHK-006 deletes them on an explicit operator
 * instruction. Deleting a file is trivially reversible by accident (a stray `git checkout`,
 * a bad merge resolution, a downstream template that regenerates it), and the ANNOUNCEMENT
 * half is even easier to lose — so both halves are pinned mechanically here:
 *
 *   1. Invoking either removed alias FAILS LOUDLY (non-zero + MODULE_NOT_FOUND), rather
 *      than silently resolving to something else. A silent resolve is the dangerous
 *      outcome: it would mean the alias came back without anyone noticing.
 *   2. The canonical replacements still work.
 *   3. CHANGELOG.md names BOTH removed aliases AND both replacements. plan.md made the
 *      changelog the acceptance floor precisely because immediate removal (rather than a
 *      warn-then-remove cycle) was chosen, so the changelog IS the only migration signal a
 *      teammate gets. An unannounced break is the failure mode this guards.
 *
 * Prints a positive selector line for each proven property so the result is verifiable from
 * stdout rather than only from the exit code.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const RETIRED_BIN_NAME = ['lat', 'tice'].join('');
const REMOVED_ALIASES = [`bin/${RETIRED_BIN_NAME}.js`, `bin/${RETIRED_BIN_NAME}-codex.js`];
const REPLACEMENTS = ['bin/proof-or-stop.js', 'bin/proof-or-stop-codex.js'];

// ─── 1. Removed aliases are absent AND fail loudly when invoked ──────────────
for (const rel of REMOVED_ALIASES) {
  assert.equal(existsSync(join(repoRoot, rel)), false, `${rel} must not exist (B-cc10 CHK-006 removed it)`);

  const result = spawnSync(process.execPath, [rel, '--version'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = result.stderr || '';

  // A ZERO exit here would mean the alias silently resolved again — the exact regression
  // this guards. Assert the failure is the module-not-found shape, not any old error.
  assert.notEqual(result.status, 0, `node ${rel} must exit non-zero, got ${result.status}`);
  assert.match(stderr, /Cannot find module/, `node ${rel} must fail with Cannot find module, got: ${stderr.slice(0, 200)}`);
  console.log(`REMOVED_ALIAS_FAILS_LOUDLY ${rel} exit=${result.status}`);
}

// ─── 2. Canonical replacements still resolve ─────────────────────────────────
for (const rel of REPLACEMENTS) {
  assert.equal(existsSync(join(repoRoot, rel)), true, `${rel} must exist as the replacement entrypoint`);
}
const version = spawnSync(process.execPath, ['bin/proof-or-stop.js', '--version'], {
  cwd: repoRoot,
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
});
assert.equal(version.status, 0, `bin/proof-or-stop.js --version must succeed, got ${version.status}`);
assert.match(version.stdout || '', /Proof-or-Stop \d+\.\d+\.\d+/, 'canonical wrapper must print a version banner');
console.log(`CANONICAL_REPLACEMENT_WORKS ${(version.stdout || '').trim()}`);
const codexVersion = spawnSync(process.execPath, ['bin/proof-or-stop-codex.js', '--version'], {
  cwd: repoRoot,
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
});
assert.equal(codexVersion.status, 0, `bin/proof-or-stop-codex.js --version must succeed, got ${codexVersion.status}`);
assert.match(codexVersion.stdout || '', /Proof-or-Stop \d+\.\d+\.\d+/, 'canonical Codex wrapper must print a version banner');
console.log(`CANONICAL_CODEX_REPLACEMENT_WORKS ${(codexVersion.stdout || '').trim()}`);

// ─── 3. The removal is ANNOUNCED in the changelog ────────────────────────────
// plan.md's acceptance: the entry must name BOTH removed aliases and their replacements.
const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
for (const rel of [...REMOVED_ALIASES, ...REPLACEMENTS]) {
  assert.ok(
    changelog.includes(rel),
    `CHANGELOG.md must name ${rel} so the break is announced rather than discovered at runtime`,
  );
}
console.log('CHANGELOG_ANNOUNCES_REMOVAL both aliases and both replacements named');

console.log('PASS red-cc10-chk006-removed-bin-aliases');
