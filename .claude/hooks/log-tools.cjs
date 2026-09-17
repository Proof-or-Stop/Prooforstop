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
    const discovered = discoverWorkspace(root);
    if (discovered === 'non-repository') {
      // Positively outside a repository: no validation can be running here.
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(target, line);
    } else if (discovered === 'uncertain') {
      // Discovery failed (timeout, missing git, unreadable path). The repository may be
      // validating right now, so the record waits in a discovery-pending queue keyed by
      // this path; a later hook that can discover the worktree adopts it.
      publishSpoolRecord(pendingSpoolDir(root), { target, line });
    } else {
      const spool = spoolDir(root);
      adoptPendingRecords(root, spool);
      // Every repository write happens inside the product's own workspace validation
      // capacity ticket, so a validation starting concurrently queues behind this
      // millisecond-long write instead of racing it.
      publishSpoolRecord(spool, { target, line });
      flushSpool(spool, root);
    }
  } catch {}
  process.exit(0);
});

function git(root, args) {
  return execSync(`git ${args}`, { cwd: root, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/**
 * Where this path lives: the worktree top, 'non-repository' when Git positively says so,
 * or 'uncertain' for anything else (a timeout, a missing git, a realpath failure). An
 * uncertain answer must never be treated as "no repository": that would write into a
 * repository that may be validating right now.
 */
function discoverWorkspace(root) {
  try { return fs.realpathSync(git(root, 'rev-parse --show-toplevel')); } catch (error) {
    const detail = `${error && error.stderr ? error.stderr : ''}${error && error.message ? error.message : ''}`;
    return /not a git repository|no such file or directory.*\.git/i.test(detail) ? 'non-repository' : 'uncertain';
  }
}

function workspaceTop(root) {
  const discovered = discoverWorkspace(root);
  return typeof discovered === 'string' && discovered !== 'non-repository' ? discovered : null;
}

/** Per-worktree spool directory outside the repository: <home>/.proof-or-stop/activity-spool/<sha256(worktree)>/ */
function spoolDir(root) {
  const top = workspaceTop(root);
  if (!top) return null;
  const key = crypto.createHash('sha256').update(top).digest('hex');
  return path.join(os.homedir(), '.proof-or-stop', 'activity-spool', key);
}

/** Queue for records published while the worktree could not be discovered. */
function pendingSpoolDir(root) {
  const key = crypto.createHash('sha256').update(`pending:${root}`).digest('hex');
  return path.join(os.homedir(), '.proof-or-stop', 'activity-spool', `pending-${key}`);
}

/** Move records published during failed discovery into this worktree's real queue. */
function adoptPendingRecords(root, spool) {
  const pending = pendingSpoolDir(root);
  let names;
  try { names = fs.readdirSync(pending).filter(name => name.endsWith('.json')); } catch { return; }
  if (names.length === 0) return;
  try { fs.mkdirSync(spool, { recursive: true, mode: 0o700 }); } catch { return; }
  for (const name of names) {
    try { fs.renameSync(path.join(pending, name), path.join(spool, name)); } catch { /* another hook adopted it */ }
  }
  try { fs.rmdirSync(pending); } catch { /* not empty yet */ }
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

function pendingSpoolRecords(spool) {
  try { return fs.readdirSync(spool).some(name => name.endsWith('.json') || name.includes('.delivering-')); } catch { return false; }
}

const RECORD_CLAIM = /^(.*\.json)\.delivering-(\d+)$/;

/**
 * One coherent view of the queue: every record, queued or in flight, ordered by its own
 * name. Selecting from this view can never skip a record another hook already claimed,
 * which a "list the unclaimed records" view could.
 */
function queueView(spool) {
  let names;
  try { names = fs.readdirSync(spool); } catch { return []; }
  return names
    .map(name => {
      if (name.endsWith('.json')) return { name, base: name, claimedBy: null };
      const match = RECORD_CLAIM.exec(name);
      return match ? { name, base: match[1], claimedBy: Number(match[2]) } : null;
    })
    .filter(Boolean)
    .sort((left, right) => (left.base < right.base ? -1 : left.base > right.base ? 1 : 0));
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
  for (let delivered = 0; delivered < 10000; delivered++) {
    const [oldest] = queueView(spool);
    if (!oldest) return;
    if (oldest.claimedBy !== null) {
      // The oldest record is in flight. A live owner is still making progress, so stand
      // down; a dead owner's claim returns to the queue and is retried here.
      if (pidAlive(oldest.claimedBy)) return;
      try { fs.renameSync(path.join(spool, oldest.name), path.join(spool, oldest.base)); } catch { return; }
      continue;
    }
    barrierWait();
    if (workspaceValidationActive(root)) return; // a validation started: stop delivering
    const claimed = path.join(spool, `${oldest.base}.delivering-${process.pid}`);
    try { fs.renameSync(path.join(spool, oldest.base), claimed); } catch { return; } // another hook won it
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
      try { fs.renameSync(claimed, path.join(spool, oldest.base)); } catch { /* recovered later */ }
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

/**
 * Liveness of a queue entry's holder. A vanished or unreadable entry is 'uncertain', not
 * dead: a `.choosing` marker that disappears mid-scan has just become a ticket, and
 * treating that as absent would let this hook admit itself past a validation that is
 * already admitted. Only a readable record with a dead pid is 'dead'.
 */
function capacityHolderState(entryPath) {
  let holder;
  try { holder = JSON.parse(fs.readFileSync(path.join(entryPath, 'holder.json'), 'utf8')); } catch { return 'uncertain'; }
  if (!Number.isSafeInteger(holder?.pid)) return 'uncertain';
  return pidAlive(holder.pid) ? 'alive' : 'dead';
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
  let published = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const lockId = crypto.randomUUID();
    const holder = `${JSON.stringify({
      lockId, pid: process.pid, hostname: os.hostname(), command: 'host activity log delivery',
      acquiredAt: new Date().toISOString(), processStartTimeMs: Math.round(Date.now() - process.uptime() * 1000),
    }, null, 2)}\n`;
    // Announce the arrival BEFORE reading ticket numbers, exactly as the product's
    // allocator does: the `.choosing` marker makes this selection visible, so a validation
    // cannot publish a ticket between the reading and the publication and go unnoticed.
    const choosing = path.join(dir, `${lockId}.choosing`);
    const preparing = `${choosing}.${process.pid}-${lockId}.preparing`;
    fs.mkdirSync(preparing);
    fs.writeFileSync(path.join(preparing, 'holder.json'), holder);
    fs.renameSync(preparing, choosing); // publication is atomic
    published = choosing;
    ticketBarrierWait();
    const numbers = fs.readdirSync(dir).filter(name => name.endsWith('.ticket'))
      .map(name => Number(name.slice(0, name.indexOf('-')))).filter(Number.isFinite);
    const ticket = path.join(dir, `${String((numbers.length > 0 ? Math.max(...numbers) : 0) + 1).padStart(16, '0')}-${lockId}.ticket`);
    fs.renameSync(choosing, ticket);
    published = ticket;
    const entries = fs.readdirSync(dir);
    admissionBarrierWait();
    // A choosing marker blocks while its owner lives; one left by a crashed process must
    // never stall host bookkeeping. Anything uncertain - an entry that vanished or cannot
    // be read while this scan runs - means the queue moved under us, so retreat.
    for (const name of entries.filter(name => name.endsWith('.choosing'))) {
      if (capacityHolderState(path.join(dir, name)) !== 'dead') return false;
    }
    const live = [];
    for (const name of entries.filter(name => name.endsWith('.ticket'))) {
      const state = path.join(dir, name) === ticket ? 'alive' : capacityHolderState(path.join(dir, name));
      if (state === 'uncertain') return false;
      if (state === 'alive') live.push(name);
    }
    live.sort();
    if (live.length === 0 || path.join(dir, live[0]) !== ticket) return false; // not the oldest: retreat
    write();
    return true;
  } catch {
    return false;
  } finally {
    if (published) { try { fs.rmSync(published, { recursive: true, force: true }); } catch { /* stale by pid */ } }
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

/** Test seam: pause between listing the queue and inspecting its holders. */
function admissionBarrierWait() {
  const barrier = process.env.PROOF_OR_STOP_ACTIVITY_ADMISSION_BARRIER;
  if (!barrier) return;
  const deadline = Date.now() + 20000;
  while (fs.existsSync(barrier) && Date.now() < deadline) {
    try { execSync('sleep 0.05'); } catch { break; }
  }
}

/** Test seam: pause between announcing the arrival and publishing the ticket. */
function ticketBarrierWait() {
  const barrier = process.env.PROOF_OR_STOP_ACTIVITY_TICKET_BARRIER;
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
