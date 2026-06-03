#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook: scope pre-write guard
 *
 * Intercepts Edit / Write / MultiEdit / NotebookEdit before they execute.
 * When an active guard session + scope contract is present for the current
 * story, blocks out-of-scope writes before they land.
 *
 * Exit 0  → pass (tool proceeds)
 * Exit 2  → block (out-of-scope write denied; reason written to stdout as JSON)
 *
 * Graceful degradation: any error inside the hook (CLI not found, parse
 * failure, timeout) causes silent pass-through so the agent is never
 * unexpectedly stuck by a hook bug.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const BLOCKED_MARKER = 'prewrite_guard_check: BLOCKED';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  try {
    const payload = parseHookInput(input);
    if (!payload) { process.exit(0); return; }

    const toolName = (payload.tool_name || '').trim();
    if (!WRITE_TOOLS.has(toolName)) { process.exit(0); return; }

    const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const root = findRepoRoot(cwd);
    const cliPath = resolveCliPath(root);
    if (!cliPath) { process.exit(0); return; }

    const checkArgs = JSON.stringify({
      provider: 'claude-code',
      toolName,
      toolInputJson: JSON.stringify(payload.tool_input || {}),
    });

    const result = spawnSync(process.execPath, [cliPath, 'prewrite_guard_check', checkArgs], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (result.status !== 0 || result.signal) {
      const output = ((result.stderr || '') + (result.stdout || '')).trim();
      // Only block on an explicit scope violation; treat other errors as pass-through
      // (e.g. CLI not built yet, command not registered, internal error).
      if (output.includes(BLOCKED_MARKER)) {
        process.stdout.write(JSON.stringify({ decision: 'block', reason: output }) + '\n');
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

function findRepoRoot(start) {
  let dir = path.resolve(String(start || process.cwd()));
  for (let i = 0; i < 20; i++) {
    if (
      fs.existsSync(path.join(dir, '.koala')) ||
      fs.existsSync(path.join(dir, 'koala.config.json')) ||
      fs.existsSync(path.join(dir, 'lattice.config.json')) ||
      fs.existsSync(path.join(dir, '.git'))
    ) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(String(start || process.cwd()));
    dir = parent;
  }
  return path.resolve(String(start || process.cwd()));
}

function resolveCliPath(root) {
  const candidates = [
    path.join(root, 'packages', 'main', 'dist', 'cli.js'),
    path.join(root, 'node_modules', '@koala-agent', 'core', 'dist', 'cli.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
