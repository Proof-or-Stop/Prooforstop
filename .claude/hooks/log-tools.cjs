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
    const identity = queueIdentity(root, discovered);
    if (identity.spoolRoot === null) {
      // Every candidate queue location lies inside the worktree this record belongs to.
      // Writing there during a validation is exactly what this hook prevents, so the line
      // is written only when nothing is validating, and otherwise dropped.
      const worktree = typeof discovered === 'string' && discovered !== 'non-repository' && discovered !== 'uncertain' ? discovered : null;
      if (discovered !== 'uncertain' && !workspaceValidationActive(worktree)) {
        const destination = bindDestination(worktree, path.join(root, targetRelative));
        if (destination !== null) {
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.appendFileSync(destination, line);
        }
      }
      process.exit(0);
    }
    // The record is bound to the canonical directory it belongs to and stores its target
    // RELATIVE to it. A symlink retargeted between publication and delivery can therefore
    // never redirect the line into another repository.
    // An unresolved record carries its own routing: the spelling it was published through.
    publishSpoolRecord(identity.dir, { root: identity.canonicalRoot, source: identity.canonical ? null : identity.lexical, targetRelative, line });
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
/**
 * Canonicalize as far as the filesystem allows without creating anything: the deepest
 * existing ancestor is resolved and the remaining segments appended, so a symlinked HOME
 * is judged by where it really points even before its subdirectories exist.
 */
function resolveThroughExistingAncestor(target) {
  const absolute = path.resolve(target);
  const remainder = [];
  let current = absolute;
  for (let depth = 0; depth < 64; depth++) {
    try { return path.join(fs.realpathSync(current), ...remainder); } catch { /* try the parent */ }
    const parent = path.dirname(current);
    if (parent === current) return absolute;
    remainder.unshift(path.basename(current));
    current = parent;
  }
  return absolute;
}

/** Is `candidate` the same directory as `root`, or inside it? */
function insideDirectory(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/**
 * The queue must never live inside a worktree it is protecting - HOME itself can be the
 * validated worktree - so the home location is used only when it is provably outside, and
 * a per-user location under the system temporary directory is the fallback.
 */
function spoolRootCandidates() {
  return [
    path.join(os.homedir(), '.proof-or-stop', 'activity-spool'),
    path.join(os.tmpdir(), `proof-or-stop-activity-spool-${typeof os.userInfo === 'function' ? os.userInfo().uid : 'user'}`),
  ].map(resolveThroughExistingAncestor);
}

function spoolRootOutside(protectedRoots) {
  const candidates = spoolRootCandidates();
  // Judged WITHOUT creating anything: creating a directory to test it would already be a
  // write inside the worktree we are protecting.
  for (const resolved of candidates) {
    if (!protectedRoots.some(root => root !== null && (insideDirectory(root, resolved) || insideDirectory(resolved, root)))) return resolved;
  }
  return null; // nowhere provably outside: never fall back to a location inside the worktree
}

/**
 * The directories this invocation must not write into, computed the same way whatever Git
 * says: the canonical cwd, the discovered worktree when there is one, and the nearest
 * ancestor holding a `.git` entry (found without Git, so a failed lookup cannot silently
 * drop the boundary and move the queue somewhere inside the repository).
 */
function protectedRootsFor(canonicalRoot, discovered) {
  const roots = new Set();
  if (canonicalRoot !== null) {
    roots.add(canonicalRoot);
    let current = canonicalRoot;
    for (let depth = 0; depth < 64; depth++) {
      try { if (fs.existsSync(path.join(current, '.git'))) { roots.add(current); break; } } catch { /* unreadable: keep walking */ }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  if (typeof discovered === 'string' && discovered !== 'non-repository' && discovered !== 'uncertain') roots.add(discovered);
  return [...roots];
}

/**
 * The destination this line may actually be appended to: the target resolved through
 * every existing symlink, including the log file itself, and required to stay inside the
 * worktree whose capacity ticket this delivery holds. Returns null when it escapes.
 */
function bindDestination(top, target) {
  const resolved = resolveThroughExistingAncestor(target);
  if (top === null) return resolved;
  return insideDirectory(top, resolved) ? resolved : null;
}

function queueIdentity(root, discovered) {
  const lexical = path.resolve(root);
  let canonical = null;
  try { canonical = fs.realpathSync(root); } catch { canonical = null; }
  const spoolRoot = spoolRootOutside(protectedRootsFor(canonical, discovered));
  if (spoolRoot === null) return { dir: null, canonicalRoot: canonical, canonical: canonical !== null, spoolRoot: null };
  const dirFor = (value) => path.join(spoolRoot, crypto.createHash('sha256').update(value).digest('hex'));
  if (canonical !== null) return { dir: dirFor(canonical), canonicalRoot: canonical, canonical: true, spoolRoot };
  // Unresolved: each record carries the spelling that was used, so a later invocation
  // through ANY spelling that canonicalizes to the same directory can adopt it.
  return { dir: path.join(spoolRoot, `unresolved-${crypto.createHash('sha256').update(lexical).digest('hex')}`), lexical, canonicalRoot: null, canonical: false, spoolRoot };
}

/**
 * Move records published while canonicalization was unavailable into the canonical queue.
 * Anything unresolved blocks delivery, so a newer record can never pass an older one.
 */
function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

/**
 * The product's own "this worktree is validating" signal: a live workspace validation
 * capacity ticket under the shared root's validation-capacity lock.
 */
function workspaceValidationActive(top) {
  try {
    if (!top) return true; // unknown workspace: assume a validation may be running
    const dir = workspaceCapacityDir(top);
    if (!dir) return true;
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
 * place. Producers never share a file, so a concurrent flush can never rotate a file out
 * from under a half-written record.
 */
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

// A record file's own name shape; nothing else in a queue directory is a record.
const RECORD_NAME = /^\d{14}-\d{7}-[0-9a-f]{12}\.json$/;
const RECORD_CLAIM = /^(\d{14}-\d{7}-[0-9a-f]{12}\.json)\.delivering-(\d+)$/;

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

function adoptUnresolvedRecords(identity) {
  if (!identity.canonical) return true;
  // Which queue location is outside the worktree depends on where HOME and the temporary
  // directory sit, so an earlier run may legitimately have used the other candidate: every
  // candidate location is reconciled before anything newer is delivered.
  const canonicalKey = crypto.createHash('sha256').update(identity.canonicalRoot).digest('hex');
  const queues = [];
  for (const root of spoolRootCandidates()) {
    let names;
    try { names = fs.readdirSync(root); } catch (error) {
      if (error.code === 'ENOENT') continue;
      return false;
    }
    for (const name of names) {
      if (!name.startsWith('unresolved-') && !(name === canonicalKey && path.join(root, name) !== identity.dir)) continue;
      if (path.join(root, name) === identity.dir) continue;
      queues.push(path.join(root, name));
    }
  }
  for (const dir of queues) {
    let names;
    try { names = fs.readdirSync(dir).filter(name => RECORD_NAME.test(name)); } catch (error) {
      if (error.code === 'ENOENT') continue; // a queue that vanished holds nothing
      return false; // its contents are unknown and may be older than anything here
    }
    for (const name of names) {
      // Each record carries the spelling it was published through, so routing never
      // depends on separate metadata that could fail to be written or be lost.
      let record;
      try { record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch (error) {
        if (error.code === 'ENOENT') continue; // adopted by another hook
        return false; // unreadable: it may belong here and be older
      }
      const isUnresolvedQueue = path.basename(dir).startsWith('unresolved-');
      if (!isUnresolvedQueue) {
        // A canonical queue in another candidate location belongs to this directory by its
        // key alone; its records move as they are.
        try { fs.mkdirSync(identity.dir, { recursive: true, mode: 0o700 }); } catch { return false; }
        try { fs.renameSync(path.join(dir, name), path.join(identity.dir, name)); } catch {
          try { fs.statSync(path.join(dir, name)); return false; } catch (error) {
            if (error.code !== 'ENOENT') return false;
          }
        }
        continue;
      }
      if (typeof record?.source !== 'string') {
        // Unroutable: it can never be associated with a directory, so it is discarded
        // rather than blocking every workspace that shares this queue root.
        try { fs.unlinkSync(path.join(dir, name)); } catch { /* already gone */ }
        continue;
      }
      let resolved;
      try { resolved = fs.realpathSync(record.source); } catch (error) {
        if (error.code === 'ENOENT') continue; // that spelling does not exist: not ours
        return false;
      }
      if (resolved !== identity.canonicalRoot) continue;
      try { fs.mkdirSync(identity.dir, { recursive: true, mode: 0o700 }); } catch { return false; }
      try { fs.renameSync(path.join(dir, name), path.join(identity.dir, name)); } catch {
        try { fs.statSync(path.join(dir, name)); return false; } catch (error) {
          if (error.code !== 'ENOENT') return false;
        }
      }
    }
  }
  return true;
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
    // The destination is resolved through every existing symlink and must stay inside the
    // worktree this ticket protects: a symlinked docs/ or activity.jsonl must not redirect
    // the line into another repository.
    const destination = bindDestination(top, path.join(liveRoot, record.targetRelative));
    if (destination === null) {
      try { fs.renameSync(claimed, path.join(spool, oldest.base)); } catch { /* recovered later */ }
      return;
    }
    const append = () => {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.appendFileSync(destination, record.line);
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
