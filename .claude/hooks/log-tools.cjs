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
    if (!spool) { fs.mkdirSync(logDir, { recursive: true }); fs.appendFileSync(target, line); }
    else {
      // Every repository write happens inside the product's own workspace validation
      // capacity ticket, so a validation starting concurrently queues behind this
      // millisecond-long write instead of racing it. If the ticket cannot be held (a
      // validation holds capacity, or one is arriving), the record stays outside the
      // repository and a later hook delivers it in order.
      publishSpoolRecord(spool, { target, line });
      flushSpool(spool, root);
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

/** Is another live hook currently delivering a record? */
function liveClaimPresent(spool) {
  let names;
  try { names = fs.readdirSync(spool); } catch { return false; }
  return names.some(name => {
    const match = /\.delivering-(\d+)$/.exec(name);
    return match !== null && pidAlive(Number(match[1]));
  });
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
 * Deliver deferred records in their original order, oldest first. Only the OLDEST
 * record is ever claimed, so two hooks can never deliver out of order: the claim is an
 * atomic rename, and whichever hook loses it simply leaves delivery to the winner. No
 * global lock is involved, so there is no lock to leak, reclaim or steal.
 *
 * Each record's repository write happens while this process holds a workspace
 * validation capacity ticket, which is the product's own exclusion: a validation that
 * starts meanwhile queues behind the write, and a validation that already holds
 * capacity keeps this hook out. A record is removed only after its line reached the
 * target, so nothing is lost on a crash or a write failure - delivery is therefore
 * at-least-once: a crash between the append and the removal can repeat one line.
 */
function flushSpool(spool, root) {
  recoverAbandonedRecords(spool);
  for (let delivered = 0; delivered < 10000; delivered++) {
    // Another hook is delivering an older record: stand down entirely, or this hook
    // would pass it. Its claim is live, so it is still making progress.
    if (liveClaimPresent(spool)) return;
    const [name] = spoolRecordNames(spool);
    if (!name) return;
    barrierWait();
    if (workspaceValidationActive(root)) return; // a validation started: stop delivering
    const claimed = path.join(spool, `${name}.delivering-${process.pid}`);
    try { fs.renameSync(path.join(spool, name), claimed); } catch { return; } // another hook is delivering
    let record = null;
    try { record = JSON.parse(fs.readFileSync(claimed, 'utf8')); } catch { record = null; }
    if (!record || typeof record.target !== 'string' || typeof record.line !== 'string') {
      try { fs.unlinkSync(claimed); } catch { /* already gone */ }
      continue;
    }
    const written = withWorkspaceWriteTicket(root, () => {
      fs.mkdirSync(path.dirname(record.target), { recursive: true });
      fs.appendFileSync(record.target, record.line);
    });
    if (!written) {
      // Not admitted, or the target could not be written: return the record to its place
      // so a later hook retries it in order, and stop.
      try { fs.renameSync(claimed, path.join(spool, name)); } catch { /* recovered later */ }
      return;
    }
    try { fs.unlinkSync(claimed); } catch { /* recovered later */ }
  }
}

/** The workspace validation capacity directory this worktree's validations queue in. */
function workspaceCapacityDir(root) {
  try {
    const top = workspaceTop(root);
    if (!top) return null;
    const commonRaw = git(top, 'rev-parse --git-common-dir');
    const common = fs.realpathSync(path.isAbsolute(commonRaw) ? commonRaw : path.resolve(top, commonRaw));
    const sharedRoot = path.basename(common) === '.git' ? path.dirname(common) : common;
    const key = crypto.createHash('sha256').update(top).digest('hex');
    return path.join(sharedRoot, '.proof-or-stop', 'locks', 'validation-capacity.lock', 'workspaces', key);
  } catch { return null; }
}

function capacityHolderAlive(ticketPath) {
  try { return pidAlive(JSON.parse(fs.readFileSync(path.join(ticketPath, 'holder.json'), 'utf8')).pid); } catch { return false; }
}

/**
 * Run `write` while holding an admitted workspace validation capacity ticket, using the
 * same ticket protocol the product's validations use: a private directory published by
 * an atomic rename, admitted only when it is the oldest live ticket and nobody is
 * arriving. The ticket carries this process's pid, so it is classified stale the moment
 * this hook exits or dies. Returns false when the ticket was not admitted or the write
 * failed; the caller then leaves the record queued.
 */
function withWorkspaceWriteTicket(root, write) {
  const dir = workspaceCapacityDir(root);
  if (!dir) return false;
  let ticket = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const lockId = crypto.randomUUID();
    const numbers = fs.readdirSync(dir).filter(name => name.endsWith('.ticket'))
      .map(name => Number(name.slice(0, name.indexOf('-')))).filter(Number.isFinite);
    const number = (numbers.length > 0 ? Math.max(...numbers) : 0) + 1;
    ticket = path.join(dir, `${String(number).padStart(16, '0')}-${lockId}.ticket`);
    const preparing = `${ticket}.${process.pid}-${lockId}.preparing`;
    fs.mkdirSync(preparing);
    fs.writeFileSync(path.join(preparing, 'holder.json'), `${JSON.stringify({
      lockId, pid: process.pid, hostname: os.hostname(), command: 'host activity log delivery',
      acquiredAt: new Date().toISOString(), processStartTimeMs: Math.round(Date.now() - process.uptime() * 1000),
    }, null, 2)}\n`);
    fs.renameSync(preparing, ticket); // publication is atomic: a half-written ticket is never queue-visible
    const entries = fs.readdirSync(dir);
    if (entries.some(name => name.endsWith('.choosing'))) return false; // someone is arriving
    const live = entries.filter(name => name.endsWith('.ticket') && capacityHolderAlive(path.join(dir, name))).sort();
    if (live.length === 0 || path.join(dir, live[0]) !== ticket) return false; // not the oldest: retreat
    write();
    return true;
  } catch {
    return false;
  } finally {
    if (ticket) { try { fs.rmSync(ticket, { recursive: true, force: true }); } catch { /* stale by pid */ } }
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
