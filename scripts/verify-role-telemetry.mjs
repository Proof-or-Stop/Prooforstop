#!/usr/bin/env node
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const root = dirname(dirname(__filename));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(args, opts = {}) {
  return execFileSync('node', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
}

run(['bin/koala-codex.js', 'session_brief'], { env: { ...process.env, KOALA_ACTIVITY_ROLE: 'reviewer' } });
run(['bin/koala-codex.js', 'session_brief'], { env: { ...process.env, KOALA_ACTIVITY_ROLE: 'intent' } });

const brief = run(['bin/koala-codex.js', 'session_brief']);
assert(brief.includes('[codex/reviewer/ok]'), 'session_brief missing reviewer role in recent activity');
assert(brief.includes('[codex/intent/ok]'), 'session_brief missing intent role in recent activity');

const { createToolStatusHandlers } = await import(new URL('../packages/utils/dist/handlers/tool-status.js', import.meta.url));
const stats = createToolStatusHandlers({ root }).tool_status({
  source: 'codex',
  role: 'reviewer',
  days: 1,
  format: 'json',
});

assert(stats.summary.role === 'reviewer', 'tool_status summary role filter mismatch');
assert((stats.summary.byRole?.reviewer || 0) >= 1, 'tool_status missing reviewer role aggregate');
assert((stats.top || []).length >= 1, 'tool_status role filter returned no tool rows');

console.log('role telemetry verified');
