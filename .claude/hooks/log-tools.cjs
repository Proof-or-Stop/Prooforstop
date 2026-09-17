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
    const spool = spoolDir(root);
    if (spool && workspaceValidationActive(root)) {
      // A validation of this worktree may guard it against mutation: keep the host's
      // own bookkeeping outside the repository until that run ends.
      publishSpoolRecord(spool, { target, line });
    } else if (spool && pendingSpoolRecords(spool)) {
      // Older deferred records are still pending: queue behind them so the repository
      // receives every line in its original order, then deliver what can be delivered.
      publishSpoolRecord(spool, { target, line });
      flushSpool(spool, root);
    } else {
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

/** Per-worktree spool directory outside the repository: <home>/.proof-or-stop/activity-spool/<sha256(worktree)>/ */
function spoolDir(root) {
  const top = workspaceTop(root);
  if (!top) return null;
  const key = crypto.createHash('sha256').update(top).digest('hex');
  return path.join(os.homedir(), '.proof-or-stop', 'activity-spool', key);
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
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

/**
 * Publish one record as its own file, written under a private name and renamed into
 * place. Producers never share a file, so a concurrent flush can never rotate a file
 * out from under a half-written record.
 */
function publishSpoolRecord(spool, record) {
  fs.mkdirSync(spool, { recursive: true, mode: 0o700 });
  const name = `${String(Date.now()).padStart(14, '0')}-${String(process.pid).padStart(7, '0')}-${crypto.randomBytes(6).toString('hex')}`;
  const tmp = path.join(spool, `.${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, path.join(spool, `${name}.json`));
}

function spoolRecordNames(spool) {
  try { return fs.readdirSync(spool).filter(name => name.endsWith('.json')).sort(); } catch { return []; }
}

function pendingSpoolRecords(spool) {
  try { return fs.readdirSync(spool).some(name => name.endsWith('.json') || name.includes('.delivering-')); } catch { return false; }
}

/** A record claimed by a flusher that died is returned to the queue under its own name. */
function recoverAbandonedRecords(spool) {
  let names;
  try { names = fs.readdirSync(spool); } catch { return; }
  for (const name of names) {
    const match = /^(.*)\.delivering-(\d+)$/.exec(name);
    if (!match || pidAlive(Number(match[2]))) continue;
    try { fs.renameSync(path.join(spool, name), path.join(spool, match[1])); } catch { /* another hook won */ }
  }
}

/**
 * Deliver deferred records in their original order. One flusher at a time; the
 * validation state is re-checked before every record, so a validation that starts
 * mid-flush leaves the remaining records outside the repository. A record is removed
 * only after its line reached the target, so nothing is lost on a crash or a write
 * failure - delivery is therefore at-least-once: a crash between the append and the
 * removal can repeat one line.
 */
function flushSpool(spool, root) {
  const lock = path.join(spool, '.flush.lock');
  if (!acquireFlushLock(lock)) return;
  try {
    recoverAbandonedRecords(spool);
    for (const name of spoolRecordNames(spool)) {
      if (workspaceValidationActive(root)) return; // a validation started: stop delivering
      barrierWait();
      const claimed = path.join(spool, `${name}.delivering-${process.pid}`);
      try { fs.renameSync(path.join(spool, name), claimed); } catch { continue; } // another flusher won
      let record = null;
      try { record = JSON.parse(fs.readFileSync(claimed, 'utf8')); } catch { record = null; }
      if (!record || typeof record.target !== 'string' || typeof record.line !== 'string') {
        try { fs.unlinkSync(claimed); } catch { /* already gone */ }
        continue;
      }
      try {
        fs.mkdirSync(path.dirname(record.target), { recursive: true });
        fs.appendFileSync(record.target, record.line);
      } catch {
        // The target could not be written: return the record to the queue and stop, so
        // a later hook retries it in its original position.
        try { fs.renameSync(claimed, path.join(spool, name)); } catch { /* recovered later */ }
        return;
      }
      try { fs.unlinkSync(claimed); } catch { /* recovered later */ }
    }
  } finally {
    releaseFlushLock(lock);
  }
}

/** Test seam: pause before each delivery while the named file exists (bounded). */
function barrierWait() {
  const barrier = process.env.PROOF_OR_STOP_ACTIVITY_SPOOL_BARRIER;
  if (!barrier) return;
  const deadline = Date.now() + 20000;
  while (fs.existsSync(barrier) && Date.now() < deadline) {
    try { execSync('sleep 0.05'); } catch { break; }
  }
}

/**
 * Exclusive flush lock. A lock left by a dead owner is reclaimed by RENAMING it away:
 * the rename is atomic, so only one reclaimer can succeed and a live replacement lock
 * can never be removed by a second observer acting on a stale reading.
 */
function acquireFlushLock(lock) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'owner'), String(process.pid), { mode: 0o600 });
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') return false;
    }
    let owner = null;
    try { owner = Number(fs.readFileSync(path.join(lock, 'owner'), 'utf8')); } catch { owner = null; }
    if (owner !== null && pidAlive(owner)) return false;
    let age = 0;
    try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { continue; }
    if (owner === null && age < 10000) return false; // the owner record is not written yet
    const graveyard = `${lock}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try { fs.renameSync(lock, graveyard); } catch { continue; } // another reclaimer won
    try { fs.rmSync(graveyard, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return false;
}

function releaseFlushLock(lock) {
  let owner = null;
  try { owner = Number(fs.readFileSync(path.join(lock, 'owner'), 'utf8')); } catch { owner = null; }
  if (owner !== process.pid) return; // never remove a lock this process does not own
  try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* best effort */ }
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
