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
 *       global `$HOME/.claude/agents` has 16 THIN-SHIM regular files, each with
 *       `tools:` frontmatter + a body containing `lattice agent_prompt` and NO
 *       role body.
 *   (b) `lattice agent_prompt --role=<name>` output is byte-equal to the
 *       registry body for that role (asserted against readPromptRegistry, the
 *       same source the Codex manifest resolves) — the CLI process only appends
 *       the generic print-time trailing newline.
 *   (c) `--upgrade` migration: 16 managed removed, user file kept, normal init
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
import { readPromptRegistry, readPromptTemplate } from '../core/prompt-registry.js';
import { listManagedAgentBasenames, resolveAgentTemplateDir } from '../core/global-agents.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliPath = join(packageRoot, 'dist', 'cli.js');
const templateDir = resolveAgentTemplateDir();
const managedBasenames = listManagedAgentBasenames(templateDir);

function makeDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `lattice-${name}-`));
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

// ─── Test (a): fresh claude init → 0 project agent files, 16 global thin-shims ──
{
  const home = makeDir('ga-home-fresh');
  const proj = makeDir('ga-proj-fresh');
  try {
    const out = runInit(home, proj, ['--profile=claude']);
    assert.match(out, /no per-project files/, '[5/6] should advertise no per-project agent files');
    assert.match(out, /thin-shims/, '[5/6] should advertise thin-shims');

    // Project has zero agent .md files.
    assert.equal(listProjectAgentMd(proj).length, 0, 'fresh project must have 0 .claude/agents/*.md');

    // Global has exactly the 16 managed basenames as REGULAR FILES (not symlinks).
    const shims = listGlobalShims(home);
    assert.equal(shims.length, managedBasenames.length, `global must have ${managedBasenames.length} thin-shims`);
    assert.equal(shims.length, 16, 'expected 16 managed agent roles');

    for (const basename of shims) {
      const shimPath = join(home, '.claude', 'agents', basename);
      assert.equal(lstatSync(shimPath).isSymbolicLink(), false, `${basename} must be a regular file, not a symlink`);
      const content = readFileSync(shimPath, 'utf8');
      // tools sandbox preserved
      assert.match(content, /^tools:/m, `${basename} shim must keep tools: frontmatter`);
      // CLI-fetch body present
      assert.match(content, /lattice agent_prompt --role=/, `${basename} shim body must reference lattice agent_prompt`);
      assert.match(content, /thin pointer/, `${basename} shim body must declare it is a thin pointer`);
      // No role body content (load-bearing slice / role-specific prose) leaked
      assert.doesNotMatch(content, /<!-- lattice:start -->/, `${basename} shim must NOT contain the role body slice`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
}

// ─── Test (b): agent_prompt byte-equal to registry body (same source as Codex) ──
{
  const snapshot = readPromptRegistry();
  assert.equal(snapshot.agents.length, 16, 'registry must expose 16 roles');
  for (const entry of snapshot.agents) {
    const body = readPromptTemplate(entry);
    const cliOut = execFileSync(process.execPath, [cliPath, 'agent_prompt', `--role=${entry.agentId}`], {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // The CLI print layer appends exactly one trailing newline to a string
    // result; strip a single trailing newline before the byte-equality check.
    const normalized = cliOut.endsWith('\n') ? cliOut.slice(0, -1) : cliOut;
    assert.equal(normalized, body, `agent_prompt --role=${entry.agentId} must be byte-equal to the registry body`);
  }
}

// ─── Test (c): --upgrade migration (16 managed removed, user file kept, normal warns) ──
{
  const home = makeDir('ga-home-upgrade');
  const proj = makeDir('ga-proj-upgrade');
  try {
    // Pre-seed project-local .claude/agents with the 16 managed copies + 1 user file.
    const agentsDir = join(proj, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    for (const basename of managedBasenames) {
      cpSync(join(templateDir, basename), join(agentsDir, basename));
    }
    const userFile = join(agentsDir, 'my-custom.md');
    const userContent = '# user authored agent\nkeep me\n';
    writeFileSync(userFile, userContent);
    assert.equal(listProjectAgentMd(proj).length, 17, 'pre-seed must be 16 managed + 1 user');

    // Normal init: WARN only, delete nothing.
    const warnOut = runInit(home, proj, ['--profile=claude']);
    assert.match(warnOut, /managed agent files found in \.claude\/agents/, 'normal init must warn about managed files');
    assert.match(warnOut, /run lattice init --upgrade/, 'normal init must point at --upgrade');
    assert.equal(listProjectAgentMd(proj).length, 17, 'normal init must NOT delete any project file');

    // --upgrade: remove exactly the 16 managed, preserve the user file.
    const upgradeOut = runInit(home, proj, ['--profile=claude', '--upgrade']);
    assert.match(upgradeOut, /migrated 16 managed agent file\(s\) to global/, '--upgrade must migrate 16 managed files');
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
    assert.match(out2, /synced=0,\s*ok=16,\s*replaced=0/, 'second init must be idempotent (synced=0, ok=16)');
    assert.equal(listGlobalShims(home).length, 16, 'global shim count stays 16 after idempotent re-run');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
}

console.log('PASS global-agents-init-smoke (fresh thin-shims / byte-equal agent_prompt / --upgrade migration / idempotent)');
