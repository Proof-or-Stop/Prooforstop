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
    const targetRelative = path.join(path.relative(root, logDir), 'activity.jsonl');
    const line = JSON.stringify(entry) + '\n';
    const discovered = discoverWorkspace(root);
    // One queue per cwd, whatever discovery says: publication, ordering and delivery all
    // read the same queue, so a record published while discovery was failing can never be
    // overtaken by a later one. Discovery decides only whether delivery may run now.
    const identity = queueIdentity(root);
    // The record is bound to the canonical directory it belongs to and stores its target
    // RELATIVE to it. A symlink retargeted between publication and delivery can therefore
    // never redirect the line into another repository.
    rememberUnresolvedSource(identity);
    publishSpoolRecord(identity.dir, { root: identity.canonicalRoot, targetRelative, line });
    if (identity.canonical && discovered === 'non-repository') {
      // Positively outside a repository: nothing can be validating, so deliver directly.
      deliverQueue(identity, null);
    } else if (identity.canonical && discovered !== 'uncertain') {
      // Inside a worktree: every write is guarded by a workspace capacity ticket.
      deliverQueue(identity, discovered);
    }
    // 'uncertain': the repository may be validating, so the record simply waits.
  } catch {}
  process.exit(0);
});

function git(root, args) {
  // Inherited repository-selection variables are dropped: discovery must describe the
  // directory this record belongs to, never a repository some parent process selected.
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES']) delete env[key];
  // stderr is captured, never printed: classifying "not a git repository" needs it.
  return execSync(`git ${args}`, { cwd: root, env, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
    // ONLY git's "searched every parent and found nothing" wording proves absence. A
    // diagnostic naming a path ("not a git repository: /work/.git") means the metadata is
    // broken or an inherited GIT_DIR is wrong - the worktree may exist and be validating.
    return /not a git repository \(or any of the parent directories\)/i.test(detail) ? 'non-repository' : 'uncertain';
  }
}

/** Per-worktree spool directory outside the repository, keyed by the discovered top. */
/**
 * The queue directories for one cwd: a primary and an alternative. The alternative exists
 * only so a record is still retained when the primary cannot be written; delivery reads
 * both as one queue, ordered by the records' own time-ordered names.
 */
/**
 * The queue identity for one hook invocation, computed ONCE and passed everywhere: the
 * canonical directory identity when it is available, so '/work', '/work/' and a symlink
 * alias share one queue. When canonicalization is unavailable the lexical identity is
 * used, the invocation delivers nothing, and a later canonical run adopts those records.
 */
function queueIdentity(root) {
  const spoolRoot = path.join(os.homedir(), '.proof-or-stop', 'activity-spool');
  const dirFor = (value) => path.join(spoolRoot, crypto.createHash('sha256').update(value).digest('hex'));
  const lexical = path.resolve(root);
  try {
    const canonical = fs.realpathSync(root);
    return { dir: dirFor(canonical), canonicalRoot: canonical, canonical: true, spoolRoot };
  } catch {
    // Unresolved: the queue records the spelling that was used, so a later invocation
    // through ANY spelling that canonicalizes to the same directory can find and adopt it.
    return { dir: path.join(spoolRoot, `unresolved-${crypto.createHash('sha256').update(lexical).digest('hex')}`), lexical, canonicalRoot: null, canonical: false, spoolRoot };
  }
}

/**
 * Move records published while canonicalization was unavailable into the canonical queue.
 * Anything unresolved blocks delivery, so a newer record can never pass an older one.
 */
function adoptUnresolvedRecords(identity) {
  if (!identity.canonical) return true;
  let queues;
  try { queues = fs.readdirSync(identity.spoolRoot).filter(name => name.startsWith('unresolved-')); } catch (error) {
    return error.code === 'ENOENT';
  }
  for (const queue of queues) {
    const dir = path.join(identity.spoolRoot, queue);
    let records;
    try { records = fs.readdirSync(dir).filter(name => RECORD_NAME.test(name)); } catch (error) {
      if (error.code === 'ENOENT') continue;
      return false;
    }
    let source;
    try { source = JSON.parse(fs.readFileSync(path.join(dir, 'source.json'), 'utf8')); } catch (error) {
      // The association cannot be read. An empty queue is harmless; one holding records
      // may be older than anything here, so delivery waits rather than passing it.
      if (error.code === 'ENOENT' && records.length === 0) continue;
      return records.length === 0;
    }
    let resolved;
    // The spelling is retried now: only a queue whose recorded path canonicalizes to THIS
    // directory is adopted, whatever spelling either invocation used.
    try { resolved = fs.realpathSync(source.path); } catch (error) {
      // A spelling that does not exist cannot be this directory; anything else is unknown.
      if (error.code === 'ENOENT' || records.length === 0) continue;
      return false;
    }
    if (resolved !== identity.canonicalRoot) continue;
    const names = records;
    if (names.length === 0) continue;
    try { fs.mkdirSync(identity.dir, { recursive: true, mode: 0o700 }); } catch { return false; }
    for (const name of names) {
      try { fs.renameSync(path.join(dir, name), path.join(identity.dir, name)); } catch {
        try { fs.statSync(path.join(dir, name)); return false; } catch (error) {
          if (error.code !== 'ENOENT') return false;
        }
      }
    }
  }
  return true;
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
function workspaceValidationActive(top) {
  try {
    if (!top) return true; // unknown workspace: assume a validation may be running
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
function rememberUnresolvedSource(identity) {
  if (identity.canonical) return;
  try {
    fs.mkdirSync(identity.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(identity.dir, 'source.json'), `${JSON.stringify({ path: identity.lexical })}\n`, { mode: 0o600 });
  } catch { /* the record itself still carries the work */ }
}

function publishSpoolRecord(spool, record) {
  const name = `${String(Date.now()).padStart(14, '0')}-${String(process.pid).padStart(7, '0')}-${crypto.randomBytes(6).toString('hex')}`;
  const tmp = path.join(spool, `.${name}.tmp`);
  let lastError;
  // Retried once: the queue is this user's own directory, so a directory that vanished or
  // lost its permissions is recreated or repaired rather than costing the record.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(spool, { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
      fs.renameSync(tmp, path.join(spool, `${name}.json`));
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 1) break;
      try { fs.chmodSync(spool, 0o700); } catch { /* recreated by the next mkdir */ }
    }
  }
  throw lastError;
}

// A record file's own name shape; `source.json` is queue metadata, never a record.
const RECORD_NAME = /^\d{14}-\d{7}-[0-9a-f]{12}\.json$/;
const RECORD_CLAIM = /^(\d{14}-\d{7}-[0-9a-f]{12}\.json)\.delivering-(\d+)$/;

/**
 * One coherent view of the queue: every record, queued or in flight, ordered by its own
 * name. Selecting from this view can never skip a record another hook already claimed,
 * which a "list the unclaimed records" view could.
 */
/**
 * The queue's records, queued or in flight, ordered by their own time-ordered names. One
 * directory, one listing: the view is always coherent. An enumeration failure other than
 * a confirmed absence returns null - unknown contents, so nothing may be delivered.
 */
function queueView(spool) {
  let names;
  try { names = fs.readdirSync(spool); } catch (error) { return error.code === 'ENOENT' ? [] : null; }
  const entries = [];
  for (const name of names) {
    if (RECORD_NAME.test(name)) { entries.push({ name, base: name, claimedBy: null }); continue; }
    const match = RECORD_CLAIM.exec(name);
    if (match) entries.push({ name, base: match[1], claimedBy: Number(match[2]) });
  }
  return entries.sort((left, right) => (left.base < right.base ? -1 : left.base > right.base ? 1 : 0));
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
function deliverQueue(identity, top) {
  if (!adoptUnresolvedRecords(identity)) return; // older records unresolved: deliver nothing
  const spool = identity.dir;
  for (let delivered = 0; delivered < 10000; delivered++) {
    const view = queueView(spool);
    if (view === null) return; // unknown queue contents: deliver nothing
    const [oldest] = view;
    // A queue directory is never removed: removing it would race a producer that has
    // created it and is about to publish into it. An empty directory is harmless.
    if (!oldest) return;
    if (oldest.claimedBy !== null) {
      // The oldest record is in flight. A live owner is still making progress, so stand
      // down; a dead owner's claim returns to the queue and is retried here.
      if (pidAlive(oldest.claimedBy)) return;
      try { fs.renameSync(path.join(spool, oldest.name), path.join(spool, oldest.base)); } catch { return; }
      continue;
    }
    barrierWait();
    // Outside any repository (top === null) nothing can be validating, so no capacity
    // ticket is involved; inside one, every write is ticket-guarded below.
    if (top !== null && workspaceValidationActive(top)) return; // a validation started
    const claimed = path.join(spool, `${oldest.base}.delivering-${process.pid}`);
    try { fs.renameSync(path.join(spool, oldest.base), claimed); } catch { return; } // another hook won it
    // A record that cannot be READ may be perfectly valid (a transient EACCES, EIO or
    // descriptor exhaustion), so it goes back to the queue untouched. Only a record that
    // reads fine and is genuinely malformed is discarded.
    let raw;
    try { raw = fs.readFileSync(claimed, 'utf8'); } catch {
      try { fs.renameSync(claimed, path.join(spool, oldest.base)); } catch { /* recovered later */ }
      return;
    }
    let record = null;
    try { record = JSON.parse(raw); } catch { record = null; }
    if (!record || typeof record.line !== 'string' || typeof record.targetRelative !== 'string'
      || (record.root !== null && typeof record.root !== 'string')) {
      try { fs.unlinkSync(claimed); } catch { /* already gone */ }
      continue;
    }
    // The destination is re-derived from the workspace the record was bound to, and only
    // ever inside the workspace this delivery holds a ticket for.
    const recordRoot = record.root ?? identity.canonicalRoot;
    let liveRoot = null;
    try { liveRoot = fs.realpathSync(recordRoot); } catch (error) {
      if (error.code !== 'ENOENT') {
        // The workspace cannot be resolved right now (a transient failure): keep the
        // record and stop, rather than treating uncertainty as removal.
        try { fs.renameSync(claimed, path.join(spool, oldest.base)); } catch { /* recovered later */ }
        return;
      }
    }
    if (liveRoot === null) {
      // Confirmed absent: the directory this record belonged to is gone, so its log cannot
      // exist either and the record can never be delivered.
      try { fs.unlinkSync(claimed); } catch { /* already gone */ }
      continue;
    }
    if (liveRoot !== identity.canonicalRoot || (top !== null && !(liveRoot === top || liveRoot.startsWith(`${top}${path.sep}`)))) {
      // It belongs to another workspace than the one this ticket protects: leave it.
      try { fs.renameSync(claimed, path.join(spool, oldest.base)); } catch { /* recovered later */ }
      return;
    }
    const target = path.join(liveRoot, record.targetRelative);
    const append = () => {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.appendFileSync(target, record.line);
    };
    let written;
    if (top === null) {
      try { append(); written = true; } catch { written = false; }
    } else {
      written = withWorkspaceWriteTicket(top, append);
    }
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
function workspaceCapacityDir(top) {
  try {
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
function withWorkspaceWriteTicket(top, write) {
  const dir = workspaceCapacityDir(top);
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
