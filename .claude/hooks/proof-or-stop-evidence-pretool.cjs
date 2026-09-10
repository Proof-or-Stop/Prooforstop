#!/usr/bin/env node
/**
 * Claude Code PreToolUse(Bash) hook: evidence-pin seatbelt
 *
 * B-1507 CHK-003. Intercepts Bash commands BEFORE they run. When the command is
 * a `proof-or-stop verification_evidence_add` (or `verification_run`) invocation whose
 * caller `--command`/`--selector` would NOT match the intent's immutable pinned
 * verification (B-ec67), it blocks the write early with a teaching message.
 *
 * Exit 0  → pass (tool proceeds)
 * Exit 2  → block (evidence write denied; teaching reason written to stderr)
 *
 * FAIL-OPEN SEATBELT: any error inside the hook (CLI not found, parse failure,
 * timeout, non-shell tool, no active story) causes a silent pass-through (exit 0)
 * so the agent is never unexpectedly stuck by a hook bug. The real enforcement
 * floor is enforceAndStampEvidence in the CLI handler, not this hook.
 *
 * Proof-or-Stop evidence-pin seatbelt. Hook registration uses the canonical
 * filename; the product spelling in this comment is not an ownership token.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Claude Code emits the shell tool as `Bash`; only inspect that tool.
const WRITE_TOOLS = new Set(['Bash']);
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

    const command = String((payload.tool_input && payload.tool_input.command) || '');
    if (!command.trim()) { process.exit(0); return; }

    const cwd = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const root = findRepoRoot(cwd);
    const cliPath = resolveCliPath(root);
    if (!cliPath) { process.exit(0); return; }

    const checkArgs = JSON.stringify({
      provider: 'claude-code',
      toolName,
      commandString: command,
      cwd,
      json: true,
    });

    const result = spawnSync(process.execPath, [cliPath, 'verification_pin_guard_check', checkArgs], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (result.status === 0 && !result.signal) {
      const verdict = parseGuardVerdict(result.stdout);
      if (verdict && verdict.verdict === 'deny') {
        const reason = Array.isArray(verdict.reasons)
          ? verdict.reasons.join('\n')
          : 'PreToolUse evidence-pin seatbelt denied this evidence write.';
        process.stderr.write(reason + '\n');
        process.exit(2);
      }
    }
  } catch {
    // PROBE: hook errors must never block the agent unexpectedly (fail-open).
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
      fs.existsSync(path.join(dir, 'proof-or-stop.config.json')) ||
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
    path.join(root, 'node_modules', '@proofOrStop', 'core', 'dist', 'cli.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
