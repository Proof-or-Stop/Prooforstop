#!/usr/bin/env node
/**
 * Codex PreToolUse hook: scope pre-write guard
 *
 * Intercepts Codex file edits surfaced as apply_patch before they execute.
 * Codex hook input reports tool_name="apply_patch" and stores the patch command
 * in tool_input.command. The hook delegates policy to lattice prewrite_guard_check.
 *
 * Exit 0  -> pass (tool proceeds)
 * Exit 2  -> block (Codex rejects the supported tool call; reason on stderr)
 *
 * Graceful degradation: if this hook cannot find or run the Lattice CLI, it
 * passes through rather than trapping the host in a broken local hook.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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
      fs.existsSync(path.join(dir, '.koala')) ||
      fs.existsSync(path.join(dir, '.Lattice')) ||
      fs.existsSync(path.join(dir, '.lattice-codex')) ||
      fs.existsSync(path.join(dir, '.codex')) ||
      fs.existsSync(path.join(dir, 'lattice.config.json')) ||
      fs.existsSync(path.join(dir, '.git'))
    ) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(String(start || process.cwd()));
    dir = parent;
  }
  return path.resolve(String(start || process.cwd()));
}

function resolveCli(root) {
  const jsCandidates = [
    path.join(root, 'packages', 'main', 'dist', 'cli.js'),
    path.join(root, 'node_modules', '@lattice-agent', 'core', 'dist', 'cli.js'),
    path.join(root, 'bin', 'lattice.js'),
  ];
  for (const candidate of jsCandidates) {
    if (fs.existsSync(candidate)) return { command: process.execPath, args: [candidate] };
  }

  const found = spawnSync('sh', ['-lc', 'command -v lattice'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 2000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const command = String(found.stdout || '').split(/\r?\n/).find(Boolean);
  return command ? { command, args: [] } : null;
}
