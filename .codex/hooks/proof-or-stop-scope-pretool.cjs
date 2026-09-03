#!/usr/bin/env node
/**
 * Codex PreToolUse hook: scope pre-write guard
 *
 * Intercepts Codex file edits surfaced as apply_patch before they execute.
 * Codex hook input reports tool_name="apply_patch" and stores the patch command
 * in tool_input.command. The hook delegates policy to proof-or-stop prewrite_guard_check.
 *
 * Exit 0  -> pass (tool proceeds)
 * Exit 2  -> block (Codex rejects the supported tool call; reason on stderr)
 *
 * Graceful degradation: if this hook cannot find or run the Proof-or-Stop CLI, it
 * passes through rather than trapping the host in a broken local hook.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// B-cc10 CHK-002: repo-root markers are INTERPOLATED from the single read-both
// resolver (core/brand-paths.ts) at generation time. This generated hook is plain
// JS and cannot import the resolver, so hardcoding the names here would leave a
// second copy that silently stops recognizing the repo root after the rename --
// the hook would then resolve the WRONG root rather than reporting an error.
const ROOT_MARKERS = [".proof-or-stop",".proof-or-stop",".proof-or-stop-codex",".proof-or-stop-codex","proof-or-stop.config.json","proof-or-stop.config.json"];

const GUARD_TIMEOUT_MS = 25000;
const WRITE_TOOLS = new Set(['apply_patch', 'Edit', 'Write']);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  try {
    const payload = parseHookInput(input);
    if (!payload) { process.exit(0); return; }

    const toolName = String(payload.tool_name || '').trim();
    if (!WRITE_TOOLS.has(toolName)) { process.exit(0); return; }

    const cwd = payload.cwd || process.cwd();
    const root = findRepoRoot(cwd);
    const cli = resolveCli(root);
    if (!cli) { process.exit(0); return; }

    const checkArgs = JSON.stringify({
      provider: 'codex',
      toolName,
      toolInputJson: JSON.stringify(payload.tool_input || {}),
      cwd,
      json: true,
    });

    const result = spawnSync(cli.command, [...cli.args, 'prewrite_guard_check', checkArgs], {
      cwd: root,
      encoding: 'utf8',
      timeout: GUARD_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (result.signal || result.error) {
      process.stderr.write('Codex PreToolUse scope guard timed out or failed after CLI resolution. Blocking fail-closed.\n');
      process.exit(2);
    }

    if (result.status === 0 && !result.signal) {
      const verdict = parseGuardVerdict(result.stdout);
      if (verdict && verdict.verdict === 'deny') {
        const reason = Array.isArray(verdict.reasons)
          ? verdict.reasons.join('\n')
          : 'Codex PreToolUse scope guard denied this write.';
        process.stderr.write(reason + '\n');
        process.exit(2);
      }
    }
  } catch {
    // PROBE: hook errors must never block the agent unexpectedly.
  }
  process.exit(0);
});

function parseHookInput(raw) {
  if (!raw || !raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

function parseGuardVerdict(raw) {
  if (!raw || !raw.trim()) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function findRepoRoot(start) {
  let dir = path.resolve(String(start || process.cwd()));
  for (let i = 0; i < 20; i++) {
    if (
      ROOT_MARKERS.some((marker) => fs.existsSync(path.join(dir, marker))) ||
      fs.existsSync(path.join(dir, '.codex')) ||
      fs.existsSync(path.join(dir, '.git'))
    ) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(String(start || process.cwd()));
    dir = parent;
  }
  return path.resolve(String(start || process.cwd()));
}

function resolveCli(root) {
  // Canonical entrypoints first, deprecated aliases as fallback (B-cdf6): a project
  // generated before the rename only has bin/proofOrStop.js, and a globally installed
  // package built before the rename only exposes the `proof-or-stop` bin.
  const jsCandidates = [
    path.join(root, 'packages', 'main', 'dist', 'cli.js'),
    path.join(root, 'node_modules', '@proofOrStop', 'core', 'dist', 'cli.js'),
    path.join(root, 'bin', 'proof-or-stop.js'),
    path.join(root, 'bin', 'proofOrStop.js'),
  ];
  for (const candidate of jsCandidates) {
    if (fs.existsSync(candidate)) return { command: process.execPath, args: [candidate] };
  }

  for (const bin of ['proof-or-stop', 'proof-or-stop']) {
    const found = spawnSync('sh', ['-lc', 'command -v ' + bin], {
      cwd: root,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const command = String(found.stdout || '').split(/\r?\n/).find(Boolean);
    if (command) return { command, args: [] };
  }
  return null;
}
