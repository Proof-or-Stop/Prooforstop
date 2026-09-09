#!/usr/bin/env node
/**
 * global-agents-init-smoke — real-machine integration verification of the
 * host-neutral thin-shim init path (B-097f CHK-006).
 *
 * SAFETY: every init runs with HOME=<temp dir> so the user's real
 * `~/.claude/agents` is NEVER touched. Each temp HOME + temp project is cleaned
 * up in a finally block.
 *
 * Covers:
 *   (a) fresh claude-marker project: project has 0 `.claude/agents/*.md`;
 *       global `$HOME/.claude/agents` has one regular file per managed role
 *       (currently 17; the smoke derives the count, never hardcodes it). The six migrated
 *       reviewer definitions keep modular bodies; five active REVIEW lanes
 *       contain only the canonical review_run_start bootstrap, while topology-critic
 *       and the other roles retain the agent_prompt thin shim. No shim contains a
 *       migrated reviewer role body.
 *   (b) `proof-or-stop agent_prompt --role=<name>` returns the same actual Claude
 *       registry render: bootstrap for the five active REVIEW lanes among the
 *       six migrated reviewer definitions, package body for ordinary roles
 *       including topology-critic.
 *   (c) `--upgrade` migration: all managed removed, user file kept, normal init
 *       only warns (no delete).
 *   (d) idempotency: re-running init reports synced=0 (all shims already ok).
 *
 * Pure-fs idempotency / replacement of old copy / old symlink / broken link is
 * covered in the injectable-fs unit smoke (global-agents-unit-smoke).
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isActiveModularReviewerRoleId,
  readPromptRegistry,
  renderPromptEntryForHost,
} from '../core/prompt-registry.js';
import { listManagedAgentBasenames, resolveAgentTemplateDir } from '../core/global-agents.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliPath = join(packageRoot, 'dist', 'cli.js');
const templateDir = resolveAgentTemplateDir();
const managedBasenames = listManagedAgentBasenames(templateDir);

function makeDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `proof-or-stop-${name}-`));
}

function runInit(home: string, root: string, extraArgs: string[]): string {
  return execFileSync(process.execPath, [cliPath, '--root', root, 'init', '--yes', ...extraArgs], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function listGlobalShims(home: string): string[] {
  const dir = join(home, '.claude', 'agents');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.md')).sort((a, b) => a.localeCompare(b));
}

function listProjectAgentMd(root: string): string[] {
  const dir = join(root, '.claude', 'agents');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.md'));
}

// ─── Test (a): fresh claude init → 0 project agent files, N global thin-shims ──
{
  const home = makeDir('ga-home-fresh');
  const proj = makeDir('ga-proj-fresh');
  try {
    const out = runInit(home, proj, ['--profile=claude']);
    assert.match(out, /no per-project files/, '[5/6] should advertise no per-project agent files');
    assert.match(out, /thin-shims/, '[5/6] should advertise thin-shims');

    // Project has zero agent .md files.
    assert.equal(listProjectAgentMd(proj).length, 0, 'fresh project must have 0 .claude/agents/*.md');

    // Global has exactly the managed basenames as REGULAR FILES (not symlinks).
    const shims = listGlobalShims(home);
    assert.equal(shims.length, managedBasenames.length, `global must have ${managedBasenames.length} thin-shims`);
    // B-cdf6:F-037 — a hardcoded `16` used to sit here, one line below the dynamic
    // check above, against a registry that now has 17 roles. The literal was both
    // redundant (the line above already pins the count to the registry) and wrong, so
    // it failed on this branch AND on pristine main. Third instance of this
    // stale-count class in this story after verify-entrypoints.mjs:526 and :1010;
    // deriving the count is the only spelling that cannot rot when a role is added.

    for (const basename of shims) {
      const shimPath = join(home, '.claude', 'agents', basename);
      assert.equal(lstatSync(shimPath).isSymbolicLink(), false, `${basename} must be a regular file, not a symlink`);
      const content = readFileSync(shimPath, 'utf8');
      // tools sandbox preserved
      assert.match(content, /^tools:/m, `${basename} shim must keep tools: frontmatter`);
      const role = basename.replace(/\.md$/, '');
      // Require the supported CLI and independently reject the retired command.
      if (isActiveModularReviewerRoleId(role)) {
        assert.match(content, /proof-or-stop review_run_start/, `${basename} must use the canonical reviewer bootstrap`);
        assert.doesNotMatch(content, /lattice review_run_start/, `${basename} must not teach the deprecated bin`);
        assert.doesNotMatch(content, /agent_prompt --role=/, `${basename} must not preload a role body through agent_prompt`);
      } else {
        assert.match(content, /proof-or-stop agent_prompt --role=/, `${basename} shim body must reference proof-or-stop agent_prompt`);
        assert.doesNotMatch(content, /lattice agent_prompt --role=/, `${basename} shim body must not teach the deprecated bin`);
        assert.match(content, /thin pointer/, `${basename} shim body must declare it is a thin pointer`);
      }
      // No role body content (load-bearing slice / role-specific prose) leaked
      assert.doesNotMatch(content, /<!-- proof-or-stop:start -->/, `${basename} shim must NOT contain the role body slice`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
}

// ─── Test (b): agent_prompt byte-equal to registry body (same source as Codex) ──
{
  const snapshot = readPromptRegistry();
  // B-cdf6:F-037 — derived, not hardcoded: a literal role count rots the moment a
  // role is added, which is how this file came to assert 16 against a 17-role registry.
  assert.equal(snapshot.agents.length, managedBasenames.length, `registry must expose ${managedBasenames.length} roles`);
  for (const entry of snapshot.agents) {
    const expected = renderPromptEntryForHost(entry, 'claude');
    const cliOut = execFileSync(process.execPath, [cliPath, 'agent_prompt', `--role=${entry.agentId}`], {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // The CLI print layer appends exactly one trailing newline to a string
    // result; strip a single trailing newline before the byte-equality check.
    const normalized = cliOut.endsWith('\n') ? cliOut.slice(0, -1) : cliOut;
    assert.equal(normalized, expected, `agent_prompt --role=${entry.agentId} must equal the actual Claude registry render`);
  }
}

// ─── Test (c): --upgrade migration (managed removed, user file kept, normal warns) ──
{
  const home = makeDir('ga-home-upgrade');
  const proj = makeDir('ga-proj-upgrade');
  try {
    // Pre-seed project-local .claude/agents with the managed copies + 1 user file.
    const agentsDir = join(proj, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    for (const basename of managedBasenames) {
      cpSync(join(templateDir, basename), join(agentsDir, basename));
    }
    const userFile = join(agentsDir, 'my-custom.md');
    const userContent = '# user authored agent\nkeep me\n';
    writeFileSync(userFile, userContent);
    // B-cdf6:F-037 — derived: this said 17 meaning '16 managed + 1 user', which is
    // wrong now that the managed set is 17. Bare numeric literals like this escaped
    // the earlier sweep because they carry no role/agent keyword to grep for.
    assert.equal(
      listProjectAgentMd(proj).length,
      managedBasenames.length + 1,
      `pre-seed must be ${managedBasenames.length} managed + 1 user`,
    );

    // Normal init: WARN only, delete nothing.
    const warnOut = runInit(home, proj, ['--profile=claude']);
    assert.match(warnOut, /managed agent files found in \.claude\/agents/, 'normal init must warn about managed files');
    assert.match(warnOut, /run proof-or-stop init --upgrade/, 'normal init must point at --upgrade');
    assert.equal(
      listProjectAgentMd(proj).length,
      managedBasenames.length + 1,
      'normal init must NOT delete any project file',
    );

    // --upgrade: remove exactly the managed set, preserve the user file.
    const upgradeOut = runInit(home, proj, ['--profile=claude', '--upgrade']);
    assert.match(
      upgradeOut,
      new RegExp(`migrated ${managedBasenames.length} managed agent file\\(s\\) to global`),
      `--upgrade must migrate ${managedBasenames.length} managed files`,
    );
    const remaining = listProjectAgentMd(proj);
    assert.deepEqual(remaining, ['my-custom.md'], 'only the user file must remain');
    assert.equal(readFileSync(userFile, 'utf8'), userContent, 'user file content must be preserved byte-for-byte');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
}

// ─── Test (d): idempotency — second init reports all shims already ok ──────────
{
  const home = makeDir('ga-home-idem');
  const proj = makeDir('ga-proj-idem');
  try {
    runInit(home, proj, ['--profile=claude']);
    const out2 = runInit(home, proj, ['--profile=claude']);
    assert.match(
      out2,
      new RegExp(`synced=0,\\s*ok=${managedBasenames.length},\\s*replaced=0`),
      `second init must be idempotent (synced=0, ok=${managedBasenames.length})`,
    );
    assert.equal(
      listGlobalShims(home).length,
      managedBasenames.length,
      `global shim count stays ${managedBasenames.length} after idempotent re-run`,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
}

console.log('PASS global-agents-init-smoke (fresh reviewer bootstraps + ordinary shims / registry agent_prompt / --upgrade migration / idempotent)');
