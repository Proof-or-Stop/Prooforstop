#!/usr/bin/env node

/**
 * B-9e4a CHK-001 smoke (F-003): worktree creation must warn when the fresh
 * worktree lacks node_modules, since git worktree does not inherit the main
 * repo's (gitignored) dependencies and tsc / koala validate would then fail.
 *
 * Covers the verificationIntent for CHK-001:
 *  - happy: missing node_modules → warning text with remediation (npm install)
 *  - edge: node_modules present as a real dir → no warning
 *  - edge: node_modules present as a symlink → no warning
 *  - adversarial: worktree path with spaces / special chars must not crash,
 *    at worst it produces the warning.
 *
 * Tests the pure detection function directly (no git spawn, fast & deterministic).
 */

import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectMissingNodeModulesWarning } from '../handlers/worktree.js';

const base = mkdtempSync(join(tmpdir(), 'koala-nm-smoke-'));

function freshWorktree(name: string): string {
  const wt = join(base, name);
  mkdirSync(wt, { recursive: true });
  return wt;
}

try {
  // ── happy: missing node_modules → warning with remediation ──────────────────
  {
    const wt = freshWorktree('missing');
    const warning = detectMissingNodeModulesWarning(wt);
    assert.ok(warning, 'missing node_modules must produce a warning');
    assert.match(warning!, /⚠ worktree 缺 node_modules/, 'warning must carry the marker');
    assert.match(warning!, /worktree 根/, 'warning must name the worktree root');
    assert.match(warning!, /npm install/, 'warning must offer npm install as primary remediation');
    assert.match(warning!, /symlink/, 'warning must mention symlink as advanced option');
    // CHK-002: npm install is presented as the recommended/primary path,
    // symlink only as advanced/optional — never as the default.
    assert.match(warning!, /补救（推荐）：[^\n]*npm install/, 'npm install must be marked the recommended remediation');
    assert.match(warning!, /高级可选：[^\n]*symlink/, 'symlink must be marked advanced/optional, not default');
  }

  // ── happy: missing node_modules in key subpackage packages/main ─────────────
  {
    const wt = freshWorktree('missing-subpkg');
    mkdirSync(join(wt, 'node_modules'), { recursive: true }); // root present
    mkdirSync(join(wt, 'packages', 'main'), { recursive: true }); // subpkg dir, no node_modules
    const warning = detectMissingNodeModulesWarning(wt);
    assert.ok(warning, 'missing packages/main node_modules must produce a warning');
    assert.match(warning!, /packages\/main\/node_modules/, 'warning must name the missing subpackage');
    assert.ok(!/worktree 根/.test(warning!), 'present root must not be flagged');
  }

  // ── edge: node_modules present as a real dir → no warning ────────────────────
  {
    const wt = freshWorktree('present-dir');
    mkdirSync(join(wt, 'node_modules'), { recursive: true });
    const warning = detectMissingNodeModulesWarning(wt);
    assert.equal(warning, null, 'real node_modules dir must not warn');
  }

  // ── edge: node_modules present as a symlink → no warning ─────────────────────
  {
    const wt = freshWorktree('present-symlink');
    const target = join(base, 'shared-node-modules');
    mkdirSync(target, { recursive: true });
    symlinkSync(target, join(wt, 'node_modules'), 'dir');
    const warning = detectMissingNodeModulesWarning(wt);
    assert.equal(warning, null, 'symlinked node_modules must not warn');
  }

  // ── edge: monorepo with both root + subpackage node_modules present ──────────
  {
    const wt = freshWorktree('present-monorepo');
    mkdirSync(join(wt, 'node_modules'), { recursive: true });
    mkdirSync(join(wt, 'packages', 'main', 'node_modules'), { recursive: true });
    const warning = detectMissingNodeModulesWarning(wt);
    assert.equal(warning, null, 'fully installed monorepo worktree must not warn');
  }

  // ── adversarial: path with spaces / special chars must not crash ────────────
  {
    const wt = freshWorktree('weird path (v2) #1 & co');
    const warning = detectMissingNodeModulesWarning(wt);
    assert.ok(warning, 'special-char path with missing deps still warns (no crash)');
    assert.match(warning!, /npm install/, 'remediation still present for special-char path');
    // present case for special-char path → no warning, still no crash
    mkdirSync(join(wt, 'node_modules'), { recursive: true });
    const warning2 = detectMissingNodeModulesWarning(wt);
    assert.equal(warning2, null, 'special-char path with deps present must not warn');
  }

  // ── adversarial: non-existent worktree path must not throw ───────────────────
  {
    const ghost = join(base, 'does-not-exist-at-all');
    let threw = false;
    let warning: string | null = null;
    try {
      warning = detectMissingNodeModulesWarning(ghost);
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'non-existent path must not throw');
    assert.ok(warning, 'non-existent path (missing deps) degrades to a warning');
  }

  // ── non-monorepo: no packages/main dir → only root checked, no spurious flag ─
  {
    const wt = freshWorktree('plain-project');
    mkdirSync(join(wt, 'node_modules'), { recursive: true });
    writeFileSync(join(wt, 'package.json'), '{}');
    const warning = detectMissingNodeModulesWarning(wt);
    assert.equal(warning, null, 'plain project with root node_modules must not warn about packages/main');
  }
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log('✓ worktree node_modules smoke passed');
