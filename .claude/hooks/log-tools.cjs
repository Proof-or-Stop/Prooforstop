#!/usr/bin/env node
/**
 * Claude Code hook: 记录所有工具调用到 activity.jsonl
 * 和 CLI 日志合并在同一个文件，用 source 字段区分
 */
const fs = require('fs');
const { constants: fsConstants } = require('fs');
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
    const line = JSON.stringify(entry) + '\n';
    // Where the bytes would REALLY land, following the whole symlink chain. Everything
    // below is decided about that destination, never about the spelling that produced it.
    const destination = resolveDestination(path.join(logDir, 'activity.jsonl'));
    if (destination === null) process.exit(0); // unknown, or not a plain log file
    const anchor = nearestExistingAncestor(path.dirname(destination));
    if (anchor === null) process.exit(0); // nothing of the destination's path exists to ask about
    const owner = discoverWorkspace(anchor);
    if (owner === 'uncertain') process.exit(0); // that repository may be validating
    const top = owner === 'non-repository' ? null : owner;
    if (top !== null && !insideDirectory(top, destination)) process.exit(0);
    const append = () => appendVerified(destination, top, line);
    // A destination outside every repository cannot be validating. One inside a worktree
    // is written only while this hook holds that worktree's own validation capacity
    // ticket, so a validation can never overlap the write. When capacity cannot be held,
    // the line is DROPPED: host bookkeeping must never delay or disturb a validation.
    if (top === null) append();
    else withWorkspaceWriteTicket(top, append);
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
 * Where this path lives: the worktree top, 'non-repository' when Git positively searched
 * every parent and found none, or 'uncertain' for anything else (a timeout, broken
 * metadata, a missing git). Uncertainty must never read as "no repository": that would
 * write into a repository that may be validating right now.
 */
function discoverWorkspace(root) {
  try { return fs.realpathSync(git(root, 'rev-parse --show-toplevel')); } catch (error) {
    const detail = `${error && error.stderr ? error.stderr : ''}${error && error.message ? error.message : ''}`;
    return /not a git repository \(or any of the parent directories\)/i.test(detail) ? 'non-repository' : 'uncertain';
  }
}

/** Is `candidate` the same directory as `root`, or inside it? */
function insideDirectory(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/**
 * Canonicalize as far as the filesystem allows without creating anything: the deepest
 * existing ancestor is resolved and the remaining segments appended.
 */
function resolveThroughExistingAncestor(target) {
  const absolute = path.resolve(target);
  const remainder = [];
  let current = absolute;
  for (let depth = 0; depth < 64; depth++) {
    try { return path.join(fs.realpathSync(current), ...remainder); } catch (error) {
      if (error.code !== 'ENOENT') return null; // unreadable: the location is unknown
    }
    const parent = path.dirname(current);
    if (parent === current) return absolute;
    remainder.unshift(path.basename(current));
    current = parent;
  }
  return null;
}

/**
 * The plain log path this line may be appended to: its directory chain resolved, and the
 * log entry itself required to be a plain file. A symlinked log is REFUSED outright - the
 * hook never follows one - so no link chain, `..` traversal or retarget can move the write
 * somewhere else. The write itself is then done through a verified descriptor.
 */
function resolveDestination(target) {
  const parent = resolveThroughExistingAncestor(path.dirname(target));
  if (parent === null) return null;
  const destination = path.join(parent, path.basename(target));
  try {
    const info = fs.lstatSync(destination);
    if (!info.isFile()) return null; // a symlink, FIFO or device is not a log this hook writes
  } catch (error) { if (error.code !== 'ENOENT') return null; }
  return destination;
}

/**
 * Append through a descriptor opened without following a final symlink and then verified:
 * a plain file, not hard-linked elsewhere, and still the intended path inside the
 * protected worktree. Anything else - including a destination swapped between the
 * inspection and the write - drops the line instead of writing it.
 */
/**
 * Accepted limitation, stated so it is never mistaken for a guarantee: Node exposes no
 * openat/mkdirat, so every step below names a path. A local process that renames an
 * ancestor at exactly the right instant can still move where a create or an append lands.
 * The window is narrowed to the smallest it can be without those syscalls - each directory
 * component is created without following links, the final open refuses a symlink, the
 * descriptor is checked against the path it should be, and ownership is established before
 * anything is created and again immediately before the write - and it is not closed. The
 * threat this Lab addresses is the operator's own tools, not an adversary racing the hook.
 */
function appendVerified(destination, top, line) {
  if (top !== null && !insideDirectory(top, destination)) return;
  const parent = path.dirname(destination);
  // Nothing is created before the destination's OWNER is established: an ancestor replaced
  // by a link to another repository must not gain directories or an empty log file.
  if (!ownerMatches(parent, top)) return;
  appendBarrierWait();
  if (!ownerMatches(parent, top)) return; // the queue moved while we waited
  let before;
  let fd;
  try {
    if (!createDirectoryChain(parent)) return;
    // The parent's identity is captured before the open and re-checked after it, so a
    // directory replaced by a link during admission is caught.
    before = fs.lstatSync(parent);
    if (!before.isDirectory()) return;
    fd = fs.openSync(destination, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK, 0o644);
  } catch { return; }
  try {
    const opened = fs.fstatSync(fd);
    // A FIFO or device would block; a hard link would change another repository's file.
    if (!opened.isFile() || opened.nlink !== 1) return;
    const after = fs.lstatSync(parent);
    if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) return;
    const named = fs.lstatSync(destination);
    // The descriptor must still be exactly the file this path names.
    if (!named.isFile() || named.dev !== opened.dev || named.ino !== opened.ino) return;
    // And the owner is established once more, now that the file exists: ownership decides
    // which capacity ticket protects this write, and it must not have moved.
    if (!ownerMatches(parent, top)) return;
    fs.writeSync(fd, line);
  } catch {
    /* the line is dropped */
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * Create every missing component of `directory` WITHOUT following links: a component that
 * already exists must be a real directory, so an ancestor replaced by a symlink refuses
 * the creation instead of silently creating inside the link's target.
 */
function createDirectoryChain(directory) {
  const parts = path.resolve(directory).split(path.sep).filter(Boolean);
  let current = path.sep;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      fs.mkdirSync(current);
    } catch (error) {
      if (error.code !== 'EEXIST') return false;
      let info;
      try { info = fs.lstatSync(current); } catch { return false; }
      if (!info.isDirectory()) return false; // a symlink or file stands where a directory must be
    }
  }
  return true;
}

/** Test seam: pause immediately before the append, after ownership was established. */
function appendBarrierWait() {
  const barrier = process.env.PROOF_OR_STOP_ACTIVITY_APPEND_BARRIER;
  if (!barrier) return;
  try { fs.writeFileSync(`${barrier}.reached`, String(process.pid)); } catch { /* the wait still holds */ }
  const deadline = Date.now() + 20000;
  while (fs.existsSync(barrier) && Date.now() < deadline) {
    try { execSync('sleep 0.05'); } catch { break; }
  }
}

/**
 * Does `directory` still belong to the worktree this hook holds a ticket for (or to no
 * repository at all when it holds none)? Canonical containment alone is not enough: a
 * nested repository inside the same tree has its own capacity, and a destination that
 * became part of a repository after discovery must not be written without its ticket.
 */
function ownerMatches(directory, top) {
  const anchor = nearestExistingAncestor(directory);
  if (anchor === null) return false;
  let canonical;
  try { canonical = fs.realpathSync(anchor); } catch { return false; }
  if (top !== null && !insideDirectory(top, canonical)) return false;
  const owner = discoverWorkspace(canonical);
  if (owner === 'uncertain') return false;
  return top === null ? owner === 'non-repository' : owner === top;
}

/** The deepest ancestor of `target` that exists, so Git can be asked about it. */
function nearestExistingAncestor(target) {
  let current = path.resolve(target);
  for (let depth = 0; depth < 64; depth++) {
    try { if (fs.existsSync(current)) return current; } catch { return null; }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * Read a queue holder record without following symlinks and without ever blocking: a FIFO
 * named holder.json would otherwise hang the hook while it holds its own ticket.
 */
function readHolderRecord(file) {
  let fd;
  try { fd = fs.openSync(file, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW); } catch { return null; }
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > 64 * 1024) return null;
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
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
  const holder = readHolderRecord(path.join(entryPath, 'holder.json'));
  if (holder === null) return 'uncertain';
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
