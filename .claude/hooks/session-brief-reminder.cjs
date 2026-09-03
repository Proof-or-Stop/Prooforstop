#!/usr/bin/env node
/**
 * Claude Code UserPromptSubmit hook: softly remind the agent to recover state
 * with `proof-or-stop session_brief` when no recent heartbeat is visible.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_FRESH_MINUTES = 60;
const REMINDER = 'Suggest running proof-or-stop session_brief first to restore context';
const PROOF_OR_STOP_STATE_DIR = '.proof-or-stop';
const PROOF_OR_STOP_CONFIG_FILENAME = 'proof-or-stop.config.json';
// Legacy names are read-only compatibility fallbacks. New state is written by
// the CLI under the canonical Proof-or-Stop names above.
const LEGACY_STATE_DIR = '.lattice';
const LEGACY_CONFIG_FILENAME = 'lattice.config.json';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  try {
    const payload = parseHookInput(input);
    if (!payload) process.exit(0);

    const root = findRepoRoot(payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
    if (!hasFreshSessionBrief(root, freshnessThresholdMs())) {
      process.stderr.write(`${REMINDER}\n`);
    }
  } catch {
    // PROBE: prompt hooks must never block the user on malformed state.
  }
  process.exit(0);
});

function parseHookInput(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // PROBE: Claude hook payloads can be absent or malformed during local tests.
    return null;
  }
}

function freshnessThresholdMs() {
  const configured = Number(
    process.env.PROOF_OR_STOP_SESSION_BRIEF_FRESH_MINUTES
      || process.env.PROOF_OR_STOP_SESSION_BRIEF_REMINDER_MINUTES
      || process.env.PROOF_OR_STOP_SESSION_BRIEF_FRESH_MINUTES
      || process.env.PROOF_OR_STOP_SESSION_BRIEF_REMINDER_MINUTES
      || DEFAULT_FRESH_MINUTES,
  );
  const minutes = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_FRESH_MINUTES;
  return minutes * 60 * 1000;
}

function findRepoRoot(start) {
  let dir = path.resolve(String(start || process.cwd()));
  while (true) {
    if (
      fs.existsSync(path.join(dir, '.proof-or-stop'))
      || fs.existsSync(path.join(dir, 'proof-or-stop.config.json'))
      || fs.existsSync(path.join(dir, '.koala'))
      || fs.existsSync(path.join(dir, '.git'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(String(start || process.cwd()));
    dir = parent;
  }
}

function hasFreshSessionBrief(root, thresholdMs) {
  const now = Date.now();
  for (const file of activityFiles(root)) {
    const fresh = readFreshSessionBrief(file, now, thresholdMs);
    if (fresh) return true;
  }
  return false;
}

function activityFiles(root) {
  return [
    path.join(root, '.proof-or-stop', 'activity.jsonl'),
    path.join(root, '.koala', 'activity.jsonl'),
    path.join(root, 'docs', 'story', 'activity.jsonl'),
    ...storyActivityFiles(root, path.join('docs', 'story', 'actives')),
  ];
}

function storyActivityFiles(root, activesDir) {
  const absoluteActivesDir = path.isAbsolute(activesDir)
    ? activesDir
    : path.join(root, activesDir);
  try {
    return fs.readdirSync(absoluteActivesDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(absoluteActivesDir, entry.name, 'activity.jsonl'));
  } catch {
    // PROBE: older repos may not have story-scoped Claude activity logs.
    return [];
  }
}

function readFreshSessionBrief(file, now, thresholdMs) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // PROBE: missing activity files simply mean there is no fresh heartbeat.
    return false;
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // PROBE: a single bad activity line should not break prompt submission.
      continue;
    }
    if (!isSessionBrief(entry)) continue;
    const time = Date.parse(entry.endTime || entry.startTime || entry.time || entry.timestamp || '');
    if (Number.isNaN(time)) continue;
    if (now - time <= thresholdMs) return true;
  }
  return false;
}

function isSessionBrief(entry) {
  if (!entry) return false;
  return entry.tool === 'session_brief'
    || entry.command === 'session_brief'
    || entry.detail === 'session_brief'
    || containsSessionBriefCommand(entry.detail)
    || containsSessionBriefCommand(entry.args && entry.args.command);
}

function containsSessionBriefCommand(value) {
  if (typeof value !== 'string') return false;
  const command = value.replace(/["']/g, '').trim();
  const boundary = '(?:^|[\\s;&|()])';
  const end = '(?:$|[\\s;&|()])';
  const envPrefix = '(?:[\\w.-]+=\\S+\\s+)*';

  // Canonical command forms are checked first. This includes the local
  // canonical wrappers and the built CLI used by repository-local hooks.
  if (
    new RegExp(`${boundary}${envPrefix}proof-or-stop\\s+session_brief${end}`).test(command)
    || new RegExp(`${boundary}node\\s+(?:\\.\\/)?(?:.*\\/)?bin\\/proof-or-stop(?:-codex)?\\.js\\s+session_brief${end}`).test(command)
    || new RegExp(`${boundary}node\\s+(?:\\.\\/)?(?:.*\\/)?packages\\/main\\/dist\\/cli\\.js\\s+session_brief${end}`).test(command)
  ) {
    return true;
  }

  // Explicit legacy read-only fallback for pre-migration command records.
  return new RegExp(`${boundary}${envPrefix}lattice\\s+session_brief${end}`).test(command)
    || new RegExp(`${boundary}node\\s+(?:\\.\\/)?(?:.*\\/)?bin\\/lattice\\.js\\s+session_brief${end}`).test(command);
}
