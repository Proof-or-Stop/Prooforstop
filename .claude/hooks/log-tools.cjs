#!/usr/bin/env node
/**
 * Claude Code hook: 记录所有工具调用到 activity.jsonl
 * 和 CLI 日志合并在同一个文件，用 source 字段区分
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const root = data.cwd || process.cwd();
    const tool = data.tool_name || 'unknown';
    const inp = data.tool_input || {};
    const isFail = data.hook_event_name !== 'PostToolUse';
    const storyId = detectStory(root);

    const entry = {
      source: 'claude',
      startTime: data.tool_start_time || null,
      endTime: new Date().toISOString(),
      tool,
      detail: toolDetail(tool, inp),
      args: inp,
      status: isFail ? 'fail' : 'ok',
      result: isFail ? null : summarize(data.tool_output, 500),
      error: isFail ? summarize(data.tool_error || data.tool_output, 500) : null,
      storyId: storyId || null,
      session: data.session_id || '',
    };

    const logDir = storyId
      ? path.join(root, 'docs', 'story', 'actives', storyId)
      : path.join(root, 'docs', 'story');
    const target = path.join(logDir, 'activity.jsonl');
    const line = JSON.stringify(entry) + '\n';
    const spool = spoolPath(root);
    if (spool && workspaceValidationActive(root)) {
      // A validation of this worktree may guard it against mutation: keep the
      // host's own bookkeeping outside the repository until the run ends.
      fs.mkdirSync(path.dirname(spool), { recursive: true, mode: 0o700 });
      fs.appendFileSync(spool, JSON.stringify({ target, line }) + '\n', { mode: 0o600 });
    } else {
      if (spool) flushSpool(spool);
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(target, line);
    }
  } catch {}
  process.exit(0);
});

function git(root, args) {
  return execSync(`git ${args}`, { cwd: root, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function workspaceTop(root) {
  try { return fs.realpathSync(git(root, 'rev-parse --show-toplevel')); } catch { return null; }
}

/** Per-worktree spool outside the repository: <home>/.proof-or-stop/activity-spool/<sha256(worktree)>.jsonl */
function spoolPath(root) {
  const top = workspaceTop(root);
  if (!top) return null;
  const key = crypto.createHash('sha256').update(top).digest('hex');
  return path.join(os.homedir(), '.proof-or-stop', 'activity-spool', `${key}.jsonl`);
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/**
 * The product's own "this worktree is validating" signal: a live workspace
 * validation capacity ticket at
 * <shared root>/.proof-or-stop/locks/validation-capacity.lock/workspaces/<sha256(worktree)>/*.ticket.
 */
function workspaceValidationActive(root) {
  try {
    const top = workspaceTop(root);
    if (!top) return false;
    const commonRaw = git(top, 'rev-parse --git-common-dir');
    const common = fs.realpathSync(path.isAbsolute(commonRaw) ? commonRaw : path.resolve(top, commonRaw));
    const sharedRoot = path.basename(common) === '.git' ? path.dirname(common) : common;
    const key = crypto.createHash('sha256').update(top).digest('hex');
    const dir = path.join(sharedRoot, '.proof-or-stop', 'locks', 'validation-capacity.lock', 'workspaces', key);
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.ticket') && !name.endsWith('.choosing')) continue;
      try {
        const holder = JSON.parse(fs.readFileSync(path.join(dir, name, 'holder.json'), 'utf8'));
        if (pidAlive(holder.pid)) return true;
      } catch {}
    }
  } catch {}
  return false;
}

/** Deliver deferred lines in their original order, then drop the spool. */
function flushSpool(spool) {
  const claimed = `${spool}.flushing-${process.pid}`;
  try { fs.renameSync(spool, claimed); } catch { return; }
  try {
    for (const record of fs.readFileSync(claimed, 'utf8').split('\n')) {
      if (!record) continue;
      try {
        const { target, line } = JSON.parse(record);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.appendFileSync(target, line);
      } catch {}
    }
  } finally {
    try { fs.unlinkSync(claimed); } catch {}
  }
}

function detectStory(root) {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: root, encoding: 'utf8', timeout: 2000 }).trim();
    const m = branch.match(/^story\/([\w-]+)$/);
    if (m) return m[1];
  } catch {}
  return null;
}

function toolDetail(tool, inp) {
  switch (tool) {
    case 'Read': return inp.file_path || '?';
    case 'Edit': return `${inp.file_path || '?'} (${(inp.old_string || '').length}→${(inp.new_string || '').length} chars)`;
    case 'Write': return inp.file_path || '?';
    case 'Bash': return (inp.command || '').slice(0, 200);
    case 'Grep': return `${inp.pattern || '?'} in ${inp.path || 'cwd'}`;
    case 'Glob': return inp.pattern || '?';
    case 'Agent': return (inp.description || inp.prompt || '').slice(0, 100);
    default: return summarize(inp, 200);
  }
}

function summarize(val, maxLen = 500) {
  if (val === undefined || val === null) return null;
  if (typeof val === 'string') return val.length > maxLen ? val.slice(0, maxLen) + '...' : val;
  try { const s = JSON.stringify(val); return s.length > maxLen ? s.slice(0, maxLen) + '...' : s; }
  catch { return String(val).slice(0, maxLen); }
}
