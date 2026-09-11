#!/usr/bin/env node
import './lab-source-loader.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LAB_MAINTENANCE_RUNTIME_REQUIREMENTS as labPolicy } from '../packages/main/src/core/runtime-fact-registry.ts';
import { shouldBumpLabVersionForChangedPaths, shouldBuildDoneMainPackageForChangedPaths } from '../packages/main/src/core/runtime-version-policy.ts';
import { repairContentDigest, auditInput, auditIsFresh, developerHost, executeLabAudit } from './lab-audit.mjs';
import { auditProviders, selectAuditor } from './lab-audit-providers.mjs';

const help = `Local Lab maintenance (Node 24+; no Story lifecycle, no remote push)
  node scripts/lab-worktree.mjs create NAME [--developer PROVIDER]
  node scripts/lab-worktree.mjs sync NAME
  node scripts/lab-worktree.mjs status NAME
  node scripts/lab-worktree.mjs reopen NAME --confirm
  node scripts/lab-worktree.mjs red NAME --expect TEXT [--timeout-ms MS] -- EXECUTABLE ARG...
  node scripts/lab-worktree.mjs carry NAME --story B-xxxx --source PATH --confirm
  node scripts/lab-worktree.mjs baseline NAME --expect TEXT --confirm -- EXECUTABLE ARG...
  node scripts/lab-worktree.mjs audit NAME [--developer PROVIDER]
  node scripts/lab-worktree.mjs green NAME
  node scripts/lab-worktree.mjs finish NAME --notes FILE --confirm [--bump patch] [--developer PROVIDER]

Commit the repair before green. Green replays the exact RED command.
Finish requires fresh GREEN, synchronizes main, records notes/version, builds
when the executing Lab tool's policy requires it, reruns the check, fast-forwards clean local main,
rebuilds/rechecks main, then removes the clean worktree and merged branch.
Failures retain the workspace. Retry finish after correcting the reported issue.
Notes describe the problem, fix, verification and measured optimization, if any.
Run from any checkout of this repository. See docs/lab-maintenance.md.`;
const fail = (message) => { throw new Error(message); };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
const sha = (cwd, ref = 'HEAD') => git(cwd, 'rev-parse', '--verify', ref);
const hash = (s) => createHash('sha256').update(s).digest('hex');
const read = (p) => readFileSync(p, 'utf8');
const atomic = (p, value) => { const tmp = `${p}.${process.pid}.tmp`; writeFileSync(tmp, value, { mode: 0o600 }); renameSync(tmp, p); };
function worktrees(cwd) {
  return git(cwd, 'worktree', 'list', '--porcelain', '-z').split('\0\0').filter(Boolean).map(block =>
    Object.fromEntries(block.split('\0').filter(Boolean).map(line => {
      const i = line.indexOf(' '); return i < 0 ? [line, true] : [line.slice(0, i), line.slice(i + 1)];
    })));
}
function assertClean(cwd, override) {
  const paths = git(cwd, 'status', '--porcelain=v1', '-uall', '-z').split('\0').filter(Boolean);
  if (paths.some(line => !(line === '?? AGENTS.override.md' && override && hash(read(join(cwd, 'AGENTS.override.md'))) === override))) {
    fail(`Uncommitted or untracked work in ${cwd}; preserve/commit it before continuing.`);
  }
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    if (existsSync(resolve(cwd, git(cwd, 'rev-parse', '--git-path', marker)))) fail(`Unfinished Git operation: ${marker}`);
  }
}
function dirtySnapshot(cwd) {
  const readList = args => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(Boolean);
  const paths = [...new Set([
    ...readList(['diff', '--name-only', '-z']),
    ...readList(['diff', '--cached', '--name-only', '-z']),
    ...readList(['ls-files', '--others', '--exclude-standard', '-z']),
  ])].sort();
  const tracked = new Set(readList(['ls-files', '-z']));
  const digest = createHash('sha256');
  digest.update(execFileSync('git', ['diff', '--binary'], { cwd, maxBuffer: 32 * 1024 * 1024 }));
  digest.update(execFileSync('git', ['diff', '--cached', '--binary'], { cwd, maxBuffer: 32 * 1024 * 1024 }));
  for (const path of paths.filter(candidate => !tracked.has(candidate))) {
    const full = join(cwd, path);
    const stat = lstatSync(full);
    digest.update(`\0${path}\0${stat.mode}\0`);
    digest.update(stat.isSymbolicLink() ? readlinkSync(full) : readFileSync(full));
  }
  return { paths, fingerprint: digest.digest('hex') };
}
function assertAncestor(cwd, ancestor, child) {
  try { git(cwd, 'merge-base', '--is-ancestor', ancestor, child); } catch { fail(`${ancestor} is not integrated into ${child}.`); }
}
function run(cwd, command, timeoutMs = 900000) {
  const start = Date.now();
  const r = spawnSync(command[0], command.slice(1), { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, shell: false });
  const output = (r.stdout || '') + (r.stderr || '');
  if (output) process.stdout.write(output);
  return { command, timeoutMs, head: sha(cwd), status: r.status, signal: r.signal, error: r.error?.message, elapsedMs: Date.now() - start, output, at: new Date().toISOString() };
}
function runCaptured(cwd, command) {
  const start = Date.now();
  const r = spawnSync(command[0], command.slice(1), { cwd, encoding: 'utf8', timeout: 900000, maxBuffer: 32 * 1024 * 1024, shell: false });
  return { command, head: sha(cwd), status: r.status, signal: r.signal, error: r.error?.message, elapsedMs: Date.now() - start, output: (r.stdout || '') + (r.stderr || ''), at: new Date().toISOString() };
}
function passed(result) { return result.status === 0 && !result.signal && !result.error; }
function parseJson(path, label) {
  try { return JSON.parse(read(path)); }
  catch { fail(`${label} is missing or invalid JSON.`); }
}
function parseJsonText(value, label) {
  try { return JSON.parse(value); }
  catch { fail(`${label} is invalid JSON.`); }
}
function outputTail(value, limit = 4000) {
  const text = typeof value === 'string' ? value : '';
  return text.length <= limit ? text : text.slice(-limit);
}
function failureIdentity(value, roots = []) {
  let text = typeof value === 'string' ? value : '';
  for (const root of [...new Set(roots.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    text = text.split(root).join('<ROOT>');
    try { text = text.split(realpathSync(root)).join('<ROOT>'); } catch { /* absent path */ }
  }
  const normalized = text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\b[a-f0-9]{40,64}\b/gi, '<HASH>')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, '<TIME>')
    .replace(/:\d+:\d+/g, ':<LINE>:<COL>')
    .replace(/\b\d+(?:\.\d+)?\s*ms\b/gi, '<DURATION>')
    .split(/\r?\n/)
    .map(line => line.trim().replace(/\s+/g, ' '))
    .filter(line => line && /fail|error|assert|refus|missing|mismatch|invalid|unclassified|expected|actual/i.test(line));
  return hash((normalized.length ? [...new Set(normalized)].sort() : [text.trim()]).join('\n'));
}
function repositoryTraceProfile(row, sourcePath) {
  const trace = row?.runtimeTrace;
  const inputs = new Set();
  const add = candidate => {
    if (typeof candidate !== 'string' || !candidate) return;
    const absolute = isAbsolute(candidate) ? candidate : resolve(sourcePath, candidate);
    const rel = relative(sourcePath, absolute).replace(/\\/g, '/');
    if (rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)) inputs.add(rel);
  };
  add(row?.command);
  for (const arg of Array.isArray(row?.args) ? row.args : []) {
    if (typeof arg === 'string' && !arg.startsWith('-')) add(arg);
  }
  for (const field of ['readPaths', 'loadedPaths', 'spawnedPaths']) {
    for (const candidate of Array.isArray(trace?.[field]) ? trace[field] : []) add(candidate);
  }
  const repositoryInputs = [...inputs].sort();
  const traceComplete = Boolean(trace)
    && Array.isArray(trace.unknownRuntimeInputs)
    && trace.unknownRuntimeInputs.length === 0
    && repositoryInputs.length > 0
    && repositoryInputs.length <= 2000;
  return { repositoryInputs: repositoryInputs.slice(0, 2000), traceComplete };
}
function changedPathsBetween(cwd, from, to = 'HEAD') {
  return git(cwd, 'diff', '--name-only', from, to).split('\n').filter(Boolean).sort();
}
function impactedProfile(profile, changedPaths) {
  if (!profile.traceComplete) return { impacted: true, reasons: ['trace_incomplete'] };
  const inputs = new Set(profile.repositoryInputs || []);
  const direct = changedPaths.filter(path => inputs.has(path));
  const sibling = changedPaths.filter(path => [...inputs].some(input => {
    const inputDir = input.includes('/') ? input.slice(0, input.lastIndexOf('/')) : '';
    const changedDir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    return inputDir === changedDir;
  }));
  const reasons = [...new Set([...direct, ...sibling])].sort();
  return { impacted: reasons.length > 0, reasons };
}
function instructions(name) {
  return `# Temporary Lab maintenance: ${name}\n\n` +
    `The user authorized this local Lab repair channel outside the formal Story lifecycle.\n` +
    `Use it only for bounded performance or system-bug repairs. Start with git status\n` +
    `and merge latest local main using the Lab sync command before each new repair.\n` +
    `Reproduce the specific failure with lab-worktree red, make a minimal repair,\n` +
    `commit the fix and regression tests, then use lab-worktree green. Select a\n` +
    `meaningful test and RED marker; missing dependencies are not the target RED.\n` +
    `Do not require Story creation, session_brief, aux_doc_list, reviewer lanes or\n` +
    `DONE transitions here. Preserve engineering rules: separate data/logic/rendering,\n` +
    `update prompt AND mechanical enforcement for process changes, keep tests strong,\n` +
    `and never mutate real Story/fixture JSON or invent formal lifecycle evidence.\n` +
    `Lab command records are local maintenance provenance, not Story PASS credentials.\n` +
    `The carry action may import one clean REVIEW/TEST Story only after complete\n` +
    `mechanical intent coverage and bounded failures reproduced on current main.\n` +
    `It excludes Story metadata and never changes or claims the source Story phase.\n` +
    `Use isolated test data and this checkout's implementation. Keep hooks enabled.\n` +
    `Do not share writable dist or change global installations incidentally.\n` +
    `Before finish, an independent different-vendor CLI auditor must approve the exact candidate. At least one auditor from a vendor different from the declared developer must pass; configured adapters may include other vendors. Never substitute prose or caller-authored approval for the tool-owned audit record.\n` +
    `Only an explicit user request triggers finish: notes/version/build/checks,\n` +
    `local main integration, then worktree and merged-branch cleanup on success.\n` +
    `Preserve the workspace on any failure. Never push automatically.\n` +
    `Keep this generated file untracked and unchanged; stage repair files explicitly.\n`;
}

async function main() {
  const [action, name, ...rest] = process.argv.slice(2);
  if (!action || action === '--help') { console.log(help); return; }
  if (!['create', 'sync', 'status', 'red', 'carry', 'baseline', 'green', 'audit', 'finish', 'reopen'].includes(action)) fail('Unknown command. Use --help.');
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(name || '')) fail('NAME must be 1-48 lowercase letters, digits or hyphens.');
  let notesPath, expected, command, storyId, sourcePath, requestedBump, declaredDeveloper, timeoutMs = 900000;
  if (action === 'red') {
    if (rest[0] !== '--expect' || !rest[1]?.trim()) fail('red requires --expect TEXT [--timeout-ms MS] -- EXECUTABLE ARG...');
    let separator = 2;
    if (rest[separator] === '--timeout-ms') {
      const value = rest[separator + 1];
      if (!/^[1-9]\d*$/.test(value ?? '') || !Number.isSafeInteger(Number(value)) || Number(value) > 3600000) fail('--timeout-ms must be an integer from 1 to 3600000');
      timeoutMs = Number(value); separator += 2;
    }
    if (rest[separator] !== '--' || !rest[separator + 1]) fail('red requires --expect TEXT [--timeout-ms MS] -- EXECUTABLE ARG...');
    expected = rest[1]; command = rest.slice(separator + 1);
  } else if (action === 'baseline') {
    if (rest[0] !== '--expect' || !rest[1]?.trim() || rest[2] !== '--confirm' || rest[3] !== '--' || !rest[4]) {
      fail('baseline requires --expect TEXT --confirm -- EXECUTABLE ARG...');
    }
    expected = rest[1]; command = rest.slice(4);
  } else if (action === 'finish') {
    if (rest.length < 3 || rest[0] !== '--notes' || !rest[1] || rest[2] !== '--confirm') fail('finish requires --notes FILE --confirm [--bump patch] [--developer PROVIDER].');
    for (let i = 3; i < rest.length; i += 2) {
      if (rest[i] === '--bump' && rest[i+1] === 'patch' && !requestedBump) requestedBump = 'patch';
      else if (rest[i] === '--developer' && /^[a-z][a-z0-9-]*$/.test(rest[i+1] ?? '') && !declaredDeveloper) declaredDeveloper = rest[i+1];
      else fail('finish requires --notes FILE --confirm [--bump patch] [--developer PROVIDER]; unsupported or duplicate option.');
    }
    notesPath = resolve(rest[1]);
  } else if (action === 'audit' || action === 'create') {
    if (rest.length && (rest.length !== 2 || rest[0] !== '--developer' || !/^[a-z][a-z0-9-]*$/.test(rest[1]))) fail('Use --developer PROVIDER.');
    declaredDeveloper = rest[1];
  } else if (action === 'reopen') {
    if (rest.length !== 1 || rest[0] !== '--confirm') fail('reopen requires --confirm.');
  } else if (action === 'carry') {
    if (rest.length !== 5 || rest[0] !== '--story' || rest[2] !== '--source' || rest[4] !== '--confirm') {
      fail('carry requires --story B-xxxx --source PATH --confirm.');
    }
    storyId = rest[1];
    if (!/^B-[A-Za-z0-9]+$/.test(storyId)) fail('carry requires a canonical B-xxxx Story id.');
    sourcePath = realpathSync(resolve(rest[3]));
  } else if (rest.length) fail('Unexpected arguments. Use --help.');
  const creatingDeveloper = action === 'create' ? developerHost(declaredDeveloper) : undefined;
  const cwd = git(process.cwd(), 'rev-parse', '--show-toplevel');
  const entries = worktrees(cwd);
  const mainRoot = entries.find(w => w.branch === 'refs/heads/main')?.worktree;
  if (!mainRoot) fail('A local main checkout is required.');
  const core = rel => import(pathToFileURL(join(mainRoot, 'packages/main/src/core', rel + '.ts')).href);
  const { acquireMainWriteLock } = await core('main-write-lock');
  const { acquireMkdirLock } = await core('mkdir-lock');
  const { LAB_MAINTENANCE_GIT_DIR } = await core('runtime-artifact-registry');
  const common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const dir = join(common, LAB_MAINTENANCE_GIT_DIR);
  const statePath = join(dir, name + '.json');
  const keyPath = join(dir, 'local.key');
  const mac = (payload, key) => createHmac('sha256', key).update(JSON.stringify(payload)).digest('hex');
  const readState = key => {
    if (!existsSync(statePath)) fail('Unknown Lab. Use create NAME first; legacy/manual worktrees are not automatically adopted.');
    const envelope = JSON.parse(read(statePath)), state = envelope.payload;
    if (envelope.hmac !== mac(state, key) || !labPolicy.readableRecordSchemas.includes(state.schema) || state.name !== name || state.mainRoot !== mainRoot) fail('Invalid Lab record; refusing mutation.');
    return state;
  };
  // Atomic record replacement lets a reader observe the previous or next signed
  // state without participating in either write lock. Never initialize trust or
  // directories on status, including the unknown-Lab path.
  if (action === 'status') {
    if (!existsSync(statePath)) fail('Unknown Lab. Use create NAME first.');
    if (!existsSync(keyPath)) fail('Local Lab signing key is missing; preserve records for recovery.');
    console.log(JSON.stringify(readState(readFileSync(keyPath)), null, 2)); return;
  }
  if (action !== 'create' && !existsSync(keyPath)) fail('Local Lab signing key is missing; preserve records for recovery.');
  let labLock, mainLock;
  try {
    // All mutators acquire in this order. A long RED/GREEN owns only its Lab;
    // finish/sync cannot touch that worktree or record until it has completed.
    labLock = acquireMkdirLock(join(dir, 'locks', name + '.lock'), {
      label: `Lab ${name} operation`, failFastIfHeld: true, requireHolderToken: true,
      heartbeatMs: labPolicy.operationHeartbeatMs,
      staleMs: labPolicy.operationStaleMs,
    });
    if (!labPolicy.worktreeOnlyActions.includes(action)) {
      mainLock = acquireMainWriteLock(mainRoot, { label: `lab ${action} ${name}` });
    }
    if (git(mainRoot, 'branch', '--show-current') !== 'main') fail('The main checkout changed branches.');
    if (!existsSync(keyPath)) {
      if (action !== 'create' || existsSync(statePath)) fail('Local Lab signing key is missing; preserve records for recovery.');
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    }
    const key = readFileSync(keyPath);
    const save = state => {
      if (!labLock.isCurrent() || !readFileSync(keyPath).equals(key)) fail('Lab operation ownership or signing key changed; no result recorded.');
      atomic(statePath, JSON.stringify({ payload: state, hmac: mac(state, key) }, null, 2) + '\n');
    };
    if (action === 'create') {
      if (existsSync(statePath)) fail('This Lab name already has a record; use a new name or inspect status.');
      const configPath = 'lab-audit.config.json';
      const config = git(mainRoot, 'ls-tree', '--name-only', 'HEAD', '--', configPath) ? JSON.parse(git(mainRoot, 'show', `HEAD:${configPath}`)) : {};
      if (!auditProviders(config).some(provider => provider.id === creatingDeveloper)) fail('Unknown Lab developer provider; register its vendor first.');
      const path = join(mainRoot, '.worktrees', `Lab-${name}`), branch = `codex/lab-${name}`;
      if (existsSync(path)) fail('Lab path already exists; refusing to adopt or overwrite it.');
      const body = instructions(name);
      git(mainRoot, 'worktree', 'add', '-b', branch, path, 'main');
      // No force, reset or fallback adoption: a partially created directory stays recoverable.
      if (existsSync(join(path, 'AGENTS.override.md'))) fail('Tracked override exists; workspace retained for inspection.');
      writeFileSync(join(path, 'AGENTS.override.md'), body, { flag: 'wx' });
      save({ schema: labPolicy.recordSchema, name, path, branch, mainRoot, base: sha(mainRoot), override: hash(body), developerHost: creatingDeveloper, phase: 'active', history: [] });
      console.log(`Created ${path}\nBranch: ${branch}\nNext: reproduce RED; commit repair; green; manually finish.`); return;
    }
    let s = readState(key);
    if (s.phase === 'closed') fail('Lab is already integrated and cleaned up.');
    if (s.schema !== labPolicy.recordSchema) {
      // Older CLI versions hold only the main lock and accept only schema 1.
      // Join that lock once before upgrading, so no old in-flight writer can
      // later overwrite the new record. Once upgraded, old scripts fail closed.
      const alreadyMainLocked = Boolean(mainLock);
      if (!mainLock) mainLock = acquireMainWriteLock(mainRoot, { label: `lab record upgrade ${name}` });
      try {
        s = readState(key);
        if (s.phase === 'closed') fail('Lab is already integrated and cleaned up.');
        if (s.schema !== labPolicy.recordSchema) {
          const from = s.schema; s.schema = labPolicy.recordSchema;
          s.history.push({ kind: 'operation-lock-upgrade', from, to: s.schema, at: new Date().toISOString() });
          save(s);
        }
      } finally {
        if (!alreadyMainLocked) { mainLock.release(); mainLock = undefined; }
      }
    }
    const entry = worktrees(mainRoot).find(w => w.worktree === s.path);
    // A crash after worktree removal can still be recovered by finish.
    if (!entry && !(action === 'finish' && s.phase === 'verified')) fail('Recorded Lab worktree is missing.');
    if (entry && (entry.branch !== `refs/heads/${s.branch}` || entry.locked)) fail('Lab branch changed or worktree is locked; preserve it for inspection.');
    if (entry) assertClean(s.path, s.override);
    const expectedAudit = (root, base, head, host) => {
      const configPath = 'lab-audit.config.json';
      const config = git(root, 'ls-tree', '--name-only', base, '--', configPath) ? JSON.parse(git(root, 'show', `${base}:${configPath}`)) : {};
      const configDigest = hash(JSON.stringify(config));
      const providers = auditProviders(config);
      const dev = providers.find(provider => provider.id === host);
      const cached = s.audit?.base === base && s.audit?.head === head && s.audit?.configDigest === configDigest
        ? providers.find(provider => provider.id === s.audit.auditorHost && provider.vendor !== dev?.vendor && (!config.preferredAuditor || provider.id === config.preferredAuditor)) : undefined;
      const selected = cached && dev ? { developer: dev, auditor: cached } : selectAuditor(host, config);
      return { config, selected, expected: { labName: name, developerHost: host, developerVendor: selected.developer.vendor, auditorHost: selected.auditor.id, auditorVendor: selected.auditor.vendor, configDigest, base, head, inputDigest: auditInput(root, base, head).inputDigest } };
    };
    const ensureAudit = async (base, head, auditRoot = s.path) => {
      assertAncestor(auditRoot, base, head);
      // Recovery operators do not become the implementation's developer.
      const host = s.developerHost ?? declaredDeveloper;
      if (!host) fail('This Lab has no pinned developer; rerun with --developer PROVIDER naming the provider that implemented the repair.');
      if (declaredDeveloper && declaredDeveloper !== host) fail('Declared developer conflicts with the pinned Lab developer.');
      const { config, selected, expected } = expectedAudit(auditRoot, base, head, host);
      if (!s.developerHost) { s.developerHost = host; save(s); }
      if (auditIsFresh(s.audit, expected)) return;
      const repairHead = s.phase !== 'active' && s.candidate === head ? git(auditRoot, 'rev-parse', `${head}^`) : head;
      const contentDigest = repairContentDigest(auditRoot, base, repairHead);
      if (s.history.some(row => row.kind === 'cross-host-audit' && row.decision === 'fail' && row.repairContentDigest === contentDigest)) fail('Rejected Lab audit requires changed repair content before another audit.');
      if (s.audit?.decision === 'fail' && Object.entries(expected).every(([key, value]) => s.audit[key] === value)) fail('Rejected Lab audit requires a changed candidate before another audit.');
      console.log(`Running independent ${selected.auditor.id} (${selected.auditor.vendor}) CLI Lab audit for ${head}...`);
      const started = Date.now();
      let audit;
      const resumeMainHead = mainLock ? sha(mainRoot) : undefined;
      // The per-Lab lock remains held; independent main writers may work while the provider runs.
      if (mainLock) { mainLock.release(); mainLock = undefined; }
      try { audit = await executeLabAudit({ cwd: auditRoot, base, head, developer: host, labName: name, evidenceRoot: join(dir, name + '-audits'), config, selection: selected }); }
      catch (error) { s.history.push({ kind: 'cross-host-audit-error', head, base, developerHost: host, elapsedMs: Date.now() - started, error: error.message }); save(s); throw error; }
      if (auditRoot === s.path) {
        if (sha(s.path) !== head) fail('Lab changed during audit; result is stale.');
        assertClean(s.path, s.override);
      } else assertAncestor(mainRoot, head, 'main');
      audit.repairContentDigest = contentDigest;
      s.audit = audit; s.history.push({ kind: 'cross-host-audit', ...audit }); save(s);
      if (resumeMainHead) {
        mainLock = acquireMainWriteLock(mainRoot, { label: `lab ${action} ${name} after audit` });
        if (git(mainRoot, 'branch', '--show-current') !== 'main' || sha(mainRoot) !== resumeMainHead) fail('main changed while the audit ran; preserve candidate and reopen before integration.');
        assertMainStable();
      }
      if (!auditIsFresh(audit, expected)) fail(`Independent Lab audit rejected the candidate. Resolve findings and reopen if prepared. Evidence: ${audit.evidenceDir}`);
    };
    if (action === 'audit') {
      await ensureAudit(s.phase === 'active' ? sha(mainRoot) : s.releaseBase, sha(s.path));
      console.log('Independent different-vendor Lab audit passed for current committed HEAD.'); return;
    }
    if (action === 'reopen') {
      if (s.phase !== 'prepared') fail('Only an unintegrated prepared candidate can be reopened.');
      let integrated = false;
      try { git(mainRoot, 'merge-base', '--is-ancestor', s.candidate, 'main'); integrated = true; } catch { /* not integrated */ }
      if (integrated) fail('Candidate is already on main; retry finish instead.');
      assertAncestor(s.path, s.candidate, 'HEAD');
      // Revert only the tool-created release commit, preserving repair history.
      git(s.path, 'revert', '--no-edit', s.candidate);
      s.phase = 'active'; s.green = null;
      s.history.push({ kind: 'reopen', revertedRelease: s.candidate, head: sha(s.path) });
      save(s);
      console.log('Release preparation reverted; repair history retained. Sync main, repair if needed, then green and finish.'); return;
    }
    if (action === 'sync') {
      if (s.phase !== 'active') fail('Prepared/integrated Lab: finish it before starting another repair.');
      git(s.path, 'merge', '--no-edit', 'main');
      s.base = sha(mainRoot); s.green = null; save(s); console.log('Local main merged. Previous GREEN invalidated.'); return;
    }
    if (action === 'red') {
      if (s.phase !== 'active') fail('RED is only accepted for an active Lab.');
      assertAncestor(s.path, sha(mainRoot), 'HEAD');
      const before = sha(s.path), r = run(s.path, command, timeoutMs);
      if (passed(r) || r.status === null || r.signal || r.error || !r.output.includes(expected)) fail('Expected target RED was not observed; no RED recorded.');
      assertClean(s.path, s.override);
      if (sha(s.path) !== before) fail('RED command changed HEAD.');
      s.red = { ...r, expected }; s.green = null; s.history.push({ kind: 'red', ...s.red }); save(s); console.log('Target RED recorded locally.'); return;
    }
    if (action === 'carry') {
      if (s.phase !== 'active' || !s.red) fail('Story carry-forward requires an active Lab with recorded RED.');
      if (s.storyCarry) fail('This Lab already carries a Story; use a new Lab for another source Story.');
      const source = worktrees(mainRoot).find(w => realpathSync(w.worktree) === sourcePath);
      if (!source) fail('Story source must be a registered worktree in this repository.');
      if (source.branch !== `refs/heads/story/${storyId}`) fail(`Story source branch must be story/${storyId}.`);
      assertClean(sourcePath);
      const sourceHead = sha(sourcePath);
      const storyRoot = join(sourcePath, '.proof-or-stop', 'story', 'actives', storyId);
      const index = parseJson(join(storyRoot, 'index.json'), 'Story index');
      const checklist = parseJson(join(storyRoot, 'checklist.json'), 'Story checklist');
      const findingsRaw = parseJson(join(storyRoot, 'findings.json'), 'Story findings');
      const testEvidence = parseJson(join(storyRoot, 'test-evidence.json'), 'Story test evidence');
      if ((index.storyId || index.id) !== storyId || !['REVIEW', 'TEST'].includes(index.phase)) {
        fail('Story carry-forward accepts only the matching Story in REVIEW or TEST.');
      }
      const items = Array.isArray(checklist.items) ? checklist.items : [];
      if (!items.length || items.some(item => item.status !== 'done')) fail('Every Story checklist item must be done.');
      const findings = Array.isArray(findingsRaw) ? findingsRaw : (Array.isArray(findingsRaw.findings) ? findingsRaw.findings : []);
      if (findings.some(row => row && row.status === 'open')) fail('Story carry-forward refuses open Findings.');
      if (testEvidence.disposition !== 'executed' || !/^[a-f0-9]{40}$/.test(testEvidence.headHash || '')
        || !/^[a-f0-9]{64}$/.test(testEvidence.materialHash || '') || !/^[a-f0-9]{64}$/.test(testEvidence.storyFilesHash || '')) {
        fail('Story test evidence must be an executed, storyFilesHash-bound validation result.');
      }
      const [{ currentMaterialHash, currentStoryFilesHash, checkEvidenceFreshnessForGit }, verification, admissibility] = await Promise.all([
        core('evidence-freshness'),
        core('verification'),
        core('proof-admissibility'),
      ]);
      const computedMaterialHash = currentMaterialHash(sourcePath, sourceHead, sourcePath);
      const computedStoryFilesHash = currentStoryFilesHash(sourcePath, sourceHead, sourcePath);
      const freshness = checkEvidenceFreshnessForGit(
        sourcePath,
        testEvidence.headHash,
        testEvidence.materialHash,
        sourcePath,
        testEvidence.storyFilesHash,
      );
      const authoritativeCoverage = verification.buildVerificationCoverage(
        checklist,
        sourceHead,
        (headHash, evidence) => checkEvidenceFreshnessForGit(
          sourcePath,
          headHash,
          evidence?.materialHash,
          sourcePath,
          evidence?.storyFilesHash,
        ).fresh,
        {
          evidenceQualityProfile: 'strict',
          receiptAdmissibility: admissibility.createVerificationEvidenceGateEvaluator(sourcePath, storyId),
        },
      );
      if (!computedMaterialHash || computedMaterialHash !== testEvidence.materialHash
        || !computedStoryFilesHash || computedStoryFilesHash !== testEvidence.storyFilesHash
        || !freshness.fresh || authoritativeCoverage.required < 1
        || authoritativeCoverage.missingRequired !== 0
        || authoritativeCoverage.entries.some(row => row.priority === 'must' && row.status !== 'covered')) {
        fail('Story evidence authenticity or hash binding is invalid; renew it through the official Story verifier.');
      }
      const rendered = typeof testEvidence.output === 'string' ? parseJsonText(testEvidence.output, 'Story test output') : testEvidence.output;
      const commands = Array.isArray(rendered?.commands) ? rendered.commands : [];
      if (!commands.length || rendered.commandExecutions !== commands.length) fail('Story validation must record every planned command execution.');
      const reportedCoverage = rendered.verificationCoverage;
      if (!reportedCoverage || reportedCoverage.required !== authoritativeCoverage.required
        || reportedCoverage.covered !== authoritativeCoverage.covered || reportedCoverage.missingRequired !== 0) {
        fail('Story validation must carry complete required verification coverage.');
      }
      const covered = Array.isArray(authoritativeCoverage.entries) ? authoritativeCoverage.entries : [];
      if (covered.length < authoritativeCoverage.required || covered.some(row => row.priority === 'must' && (row.status !== 'covered'
        || row.evidence?.result !== 'pass' || row.evidence?.mechanical !== true
        || row.evidence?.storyFilesHash !== testEvidence.storyFilesHash
        || row.evidence?.receipt?.exitCode !== 0 || row.evidence?.receipt?.selectorMatched !== true))) {
        fail('Every required intent needs current mechanical PASS evidence bound to the same storyFilesHash.');
      }
      assertAncestor(sourcePath, testEvidence.headHash, sourceHead);
      const afterEvidence = git(sourcePath, 'diff', '--name-only', testEvidence.headHash, sourceHead).split('\n').filter(Boolean);
      if (afterEvidence.some(path => !path.startsWith(`.proof-or-stop/story/actives/${storyId}/`))) {
        fail('Story source has product changes after its recorded validation head.');
      }
      if (commands.some(row => typeof row?.command !== 'string' || !row.command
        || !Array.isArray(row.args) || row.args.some(arg => typeof arg !== 'string'))) {
        fail('Every validation row must carry an executable plus argv.');
      }
      const failures = commands.filter(row => Number(row?.code ?? row?.exitCode ?? 0) !== 0);
      if (rendered.status === 'pass' ? failures.length !== 0 : failures.length < 1) fail('Story validation status and command failures disagree.');
      if (failures.length > 5) fail('Story carry-forward refuses more than five baseline failures.');
      const passCommandProfiles = commands
        .filter(row => Number(row?.code ?? row?.exitCode ?? 0) === 0)
        .map(row => ({
          label: row.label,
          command: [row.command, ...row.args],
          sourceExitCode: 0,
          sourceOutputDigest: hash(row.output || ''),
          sourceOutputTail: outputTail(row.output),
          ...repositoryTraceProfile(row, sourcePath),
        }));
      const mainBefore = git(mainRoot, 'status', '--porcelain=v1', '-uall', '-z');
      const mainHead = sha(mainRoot);
      const mainBuild = runCaptured(mainRoot, ['node', 'scripts/ensure-dist.mjs']);
      if (!passed(mainBuild) || sha(mainRoot) !== mainHead
        || git(mainRoot, 'status', '--porcelain=v1', '-uall', '-z') !== mainBefore) {
        fail('Current main build is unavailable or changed tracked workspace state; baseline evidence was not captured.');
      }
      const baselineWitnesses = failures.map(row => {
        const witness = runCaptured(mainRoot, [row.command, ...row.args]);
        if (passed(witness) || witness.status !== Number(row.code ?? row.exitCode)) {
          fail(`Story-only validation failure is not reproducible on main: ${row.command} ${row.args.join(' ')}`);
        }
        return {
          label: row.label,
          command: [row.command, ...row.args],
          sourceExitCode: Number(row.code ?? row.exitCode),
          sourceOutputDigest: hash(row.output || ''),
          sourceOutputTail: outputTail(row.output),
          mainExitCode: witness.status,
          mainOutputDigest: hash(witness.output),
          mainOutputTail: outputTail(witness.output),
          mainElapsedMs: witness.elapsedMs,
          observedAt: witness.at,
        };
      });
      if (sha(mainRoot) !== mainHead || git(mainRoot, 'status', '--porcelain=v1', '-uall', '-z') !== mainBefore) {
        fail('Baseline reproduction changed main; refusing Story carry-forward.');
      }
      const base = git(sourcePath, 'merge-base', 'main', sourceHead);
      const changedPaths = git(sourcePath, 'diff', '--name-only', '-z', base, sourceHead).split('\0').filter(Boolean);
      const importedPaths = changedPaths.filter(path => !path.startsWith('.proof-or-stop/') && path !== 'AGENTS.override.md');
      if (!importedPaths.length) fail('Story has no non-metadata patch to carry.');
      if (importedPaths.some(path => path.startsWith('.git/') || path.startsWith('.worktrees/'))) fail('Story patch contains a forbidden repository-control path.');
      const patch = execFileSync('git', ['diff', '--binary', base, sourceHead, '--', ...importedPaths], { cwd: sourcePath, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      const apply = args => spawnSync('git', ['apply', '--index', ...args], { cwd: s.path, input: patch, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      const checkResult = apply(['--check']);
      if (checkResult.status !== 0) fail(`Story patch does not apply cleanly to Lab: ${checkResult.stderr || checkResult.stdout}`);
      const applyResult = apply([]);
      if (applyResult.status !== 0) fail(`Story patch application failed: ${applyResult.stderr || applyResult.stdout}`);
      s.storyCarry = {
        storyId, sourcePath, sourceBranch: `story/${storyId}`, sourceHead, sourceBase: base,
        evidenceHead: testEvidence.headHash, materialHash: testEvidence.materialHash,
        storyFilesHash: testEvidence.storyFilesHash, verificationIntentCount: authoritativeCoverage.required,
        fullCommandCount: commands.length, sourceValidationResult: testEvidence.result,
        baselineWitnesses, passCommandProfiles, importedPaths, patchHash: hash(patch),
        mainBuildAtCapture: { head: mainHead, outputDigest: hash(mainBuild.output), elapsedMs: mainBuild.elapsedMs },
        capturedAt: new Date().toISOString(),
      };
      s.green = null;
      s.history.push({ kind: 'story-carry', ...s.storyCarry });
      save(s);
      console.log(`Story evidence captured and patch applied: ${storyId}; ${authoritativeCoverage.required} intents, ${commands.length} commands, ${failures.length} reproduced baseline failures, ${importedPaths.length} imported paths.`);
      return;
    }
    if (action === 'baseline') {
      if (s.phase !== 'active' || !s.storyCarry) fail('Supplemental baseline evidence requires an active Story carry-forward Lab.');
      if (s.storyCarry.baselineWitnesses.some(row => JSON.stringify(row.command) === JSON.stringify(command))) fail('This baseline command is already recorded.');
      const storyRoot = join(s.storyCarry.sourcePath, '.proof-or-stop', 'story', 'actives', s.storyCarry.storyId);
      const testEvidence = parseJson(join(storyRoot, 'test-evidence.json'), 'Story test evidence');
      const rendered = typeof testEvidence.output === 'string' ? parseJsonText(testEvidence.output, 'Story test output') : testEvidence.output;
      const sourceRow = (Array.isArray(rendered?.commands) ? rendered.commands : []).find(row => row.command === command[0]
        && JSON.stringify(row.args || []) === JSON.stringify(command.slice(1)));
      if (!sourceRow || Number(sourceRow.code ?? sourceRow.exitCode ?? 0) !== 0) {
        fail('Supplemental baseline command must be an exact PASS command from the carried Story validation.');
      }
      const mainBefore = dirtySnapshot(mainRoot);
      const mainHead = sha(mainRoot);
      const mainBuild = runCaptured(mainRoot, ['node', 'scripts/ensure-dist.mjs']);
      if (!passed(mainBuild) || sha(mainRoot) !== mainHead) {
        fail('Current main build is unavailable; supplemental baseline evidence was not captured.');
      }
      const witness = runCaptured(mainRoot, command);
      if (passed(witness) || witness.status === null || witness.signal || witness.error || !witness.output.includes(expected)) {
        fail('Expected new main baseline failure was not observed; no supplemental witness recorded.');
      }
      const mainAfter = dirtySnapshot(mainRoot);
      if (sha(mainRoot) !== mainHead || mainAfter.fingerprint !== mainBefore.fingerprint || JSON.stringify(mainAfter.paths) !== JSON.stringify(mainBefore.paths)) {
        fail('Supplemental baseline reproduction changed main; refusing the witness.');
      }
      const row = {
        label: sourceRow.label,
        command,
        sourceExitCode: 0,
        sourceOutputDigest: hash(sourceRow.output || ''),
        sourceOutputTail: outputTail(sourceRow.output),
        mainExitCode: witness.status,
        mainOutputDigest: hash(witness.output),
        mainOutputTail: outputTail(witness.output),
        mainElapsedMs: witness.elapsedMs,
        observedAt: witness.at,
        supplemental: true,
        expected,
      };
      s.storyCarry.baselineWitnesses.push(row);
      s.history.push({ kind: 'story-baseline-supplement', ...row });
      s.green = null;
      save(s);
      console.log(`Supplemental main baseline witness recorded: ${command.join(' ')}`);
      return;
    }
    if (action === 'green') {
      if (s.phase !== 'active' || !s.red) fail('An active Lab with a recorded RED is required.');
      assertAncestor(s.path, s.red.head, 'HEAD');
      if (sha(s.path) === s.red.head) fail('Commit a repair after RED before recording GREEN.');
      const before = sha(s.path), r = run(s.path, s.red.command, s.red.timeoutMs);
      assertClean(s.path, s.override);
      if (!passed(r) || sha(s.path) !== before) fail('GREEN failed or command changed HEAD.');
      s.green = r; s.history.push({ kind: 'green', ...r }); save(s); console.log('GREEN recorded for current committed HEAD.'); return;
    }
    const notes = read(notesPath).trim();
    if (notes.length < 40 || notes.length > 100000) fail('Provide substantive English release notes (40-100000 characters).');
    const versions = await core('version-bump');
    if (requestedBump === 'patch' && s.phase !== 'active' && !s.bump) {
      fail('Prepared release did not upgrade: reopen an unintegrated candidate before requesting --bump patch.');
    }
    const mainDirty = dirtySnapshot(mainRoot);
    let preservedMainDirty = null;
    if (mainDirty.paths.length > 0) {
      if (!s.storyCarry) fail(`Uncommitted or untracked work in ${mainRoot}; preserve/commit it before continuing.`);
      const candidatePaths = [...new Set([
        ...git(s.path, 'diff', '--name-only', 'main...HEAD').split('\n').filter(Boolean),
        'CHANGELOG.md',
        ...(versions.VERSION_SYNC_PATHS || []),
      ])];
      const overlap = mainDirty.paths.filter(path => candidatePaths.includes(path));
      if (overlap.length) fail(`Story carry-forward candidate overlaps dirty main paths: ${overlap.join(', ')}`);
      if (s.storyCarry.preservedMainDirty && s.storyCarry.preservedMainDirty.fingerprint !== mainDirty.fingerprint) {
        fail('Dirty main changed after release preparation; preserve the candidate and inspect before retrying.');
      }
      preservedMainDirty = mainDirty;
      s.storyCarry.preservedMainDirty = { ...mainDirty, capturedAt: new Date().toISOString() };
      save(s);
    }
    const assertMainStable = () => {
      if (!preservedMainDirty) return assertClean(mainRoot);
      const current = dirtySnapshot(mainRoot);
      if (current.fingerprint !== preservedMainDirty.fingerprint || JSON.stringify(current.paths) !== JSON.stringify(preservedMainDirty.paths)) {
        fail('Dirty main changed during Story carry-forward integration; workspace retained.');
      }
    };
    assertMainStable();
    if (s.storyCarry && ['active', 'prepared'].includes(s.phase)) {
      const latestMainBuild = runCaptured(mainRoot, ['node', 'scripts/ensure-dist.mjs']);
      if (!passed(latestMainBuild)) fail('Latest main build failed before Story carry-forward witness replay.');
      assertMainStable();
      const finishBaselineWitnesses = s.storyCarry.baselineWitnesses.map(previous => {
        const witness = runCaptured(mainRoot, previous.command);
        if (witness.status === null || witness.signal || witness.error) fail(`Story baseline command could not run on latest main: ${previous.command.join(' ')}`);
        return {
          command: previous.command,
          sourceExitCode: previous.sourceExitCode,
          mainExitCode: witness.status,
          mainOutputDigest: hash(witness.output),
          mainOutputTail: outputTail(witness.output),
          failureIdentity: witness.status === 0 ? null : failureIdentity(witness.output, [mainRoot]),
          mainElapsedMs: witness.elapsedMs,
          observedAt: witness.at,
        };
      });
      assertMainStable();
      const latestMainChanges = changedPathsBetween(mainRoot, s.storyCarry.sourceBase, 'HEAD');
      const baselineCommandKeys = new Set(s.storyCarry.baselineWitnesses.map(row => JSON.stringify(row.command)));
      const integrationWitnesses = (s.storyCarry.passCommandProfiles || [])
        .filter(profile => !baselineCommandKeys.has(JSON.stringify(profile.command)))
        .map(profile => ({ profile, impact: impactedProfile(profile, latestMainChanges) }))
        .filter(row => row.impact.impacted)
        .map(row => ({
          label: row.profile.label,
          command: row.profile.command,
          sourceExitCode: 0,
          sourceOutputDigest: row.profile.sourceOutputDigest,
          traceComplete: row.profile.traceComplete,
          triggerPaths: row.impact.reasons,
        }));
      s.storyCarry.finishBaselineWitnesses = finishBaselineWitnesses;
      s.storyCarry.integrationWitnesses = integrationWitnesses;
      s.storyCarry.latestMainChangedPaths = latestMainChanges;
      s.storyCarry.latestMainBuild = { head: sha(mainRoot), outputDigest: hash(latestMainBuild.output), elapsedMs: latestMainBuild.elapsedMs };
      s.storyCarry.finishBaselineMainHead = sha(mainRoot);
      save(s);
    }
    const checkStoryBaselineParity = (root, kind) => {
      if (!s.storyCarry?.finishBaselineWitnesses) return;
      const rows = s.storyCarry.finishBaselineWitnesses.map(expected => {
        const observed = runCaptured(root, expected.command);
        if (observed.status === null || observed.signal || observed.error || observed.status !== expected.mainExitCode) {
          fail(`${kind} changed latest-main baseline outcome for: ${expected.command.join(' ')}`);
        }
        const observedFailureIdentity = observed.status === 0 ? null : failureIdentity(observed.output, [root, mainRoot, s.storyCarry.sourcePath]);
        if (expected.failureIdentity && observedFailureIdentity !== expected.failureIdentity) {
          fail(`${kind} changed latest-main baseline failure identity for: ${expected.command.join(' ')}`);
        }
        return {
          command: expected.command,
          expectedExitCode: expected.mainExitCode,
          observedExitCode: observed.status,
          outputDigest: hash(observed.output),
          outputTail: outputTail(observed.output),
          failureIdentity: observedFailureIdentity,
          elapsedMs: observed.elapsedMs,
          observedAt: observed.at,
        };
      });
      s.history.push({ kind, rows });
      save(s);
    };
    const checkStoryIntegrationWitnesses = (root, kind) => {
      if (!s.storyCarry?.integrationWitnesses) return;
      const rows = s.storyCarry.integrationWitnesses.map(expected => {
        const observed = runCaptured(root, expected.command);
        if (!passed(observed)) fail(`${kind} failed impacted Story PASS command: ${expected.command.join(' ')}`);
        return {
          command: expected.command,
          triggerPaths: expected.triggerPaths,
          observedExitCode: observed.status,
          outputDigest: hash(observed.output),
          outputTail: outputTail(observed.output),
          elapsedMs: observed.elapsedMs,
          observedAt: observed.at,
        };
      });
      s.history.push({ kind, rows });
      save(s);
    };
    const check = (root, kind) => {
      const before = sha(root), r = run(root, s.red.command, s.red.timeoutMs);
      s.history.push({ kind, ...r }); save(s);
      if (root === mainRoot) assertMainStable();
      else assertClean(root, s.override);
      if (!passed(r) || sha(root) !== before) fail(`${kind} failed or modified the checkout; workspace retained.`);
    };
    const build = root => {
      if (s.build ?? s.bump) {
        const r = run(root, ['node', 'scripts/ensure-dist.mjs']);
        s.history.push({ kind: 'build', cwd: root, ...r }); save(s);
        if (!passed(r)) fail(`Build failed in ${root}; workspace retained. Retry finish after repair.`);
        const reported = run(root, ['node', 'bin/proof-or-stop.js', '--version']);
        s.history.push({ kind: 'version', cwd: root, ...reported }); save(s);
        if (!passed(reported) || !reported.output.trim().endsWith(` ${s.version}`)) fail('Built CLI version does not match synchronized version.');
      }
    };
    if (s.phase === 'active') {
      if (!s.green || s.green.head !== sha(s.path)) fail('Fresh GREEN for the committed Lab HEAD is required.');
      git(s.path, 'merge', '--no-edit', 'main');
      assertClean(s.path, s.override);
      // Recheck after incorporating main, before writing any release content.
      check(s.path, 'synced-green');
      s.releaseBase = sha(mainRoot);
      const paths = git(s.path, 'diff', '--name-only', '-z', 'main...HEAD').split('\0').filter(Boolean);
      if (paths.some(p => p === 'AGENTS.override.md' || /^\.proof-or-stop\/story\//.test(p))) fail('Lab override or real Story state cannot be released through Lab.');
      s.requestedBump = requestedBump ?? 'auto';
      s.bump = requestedBump === 'patch' || shouldBumpLabVersionForChangedPaths(paths);
      // A version change also changes the runtime brand and must be built/checked.
      s.build = shouldBuildDoneMainPackageForChangedPaths(paths) || s.bump;
      const currentVersion = versions.readSyncedVersion(mainRoot);
      if (versions.readSyncedVersion(s.path) !== currentVersion) fail('Version drift: leave version changes to finish, based on latest main.');
      const versionBump = s.bump ? versions.applyPatchBump(s.path) : undefined;
      s.version = versionBump?.to ?? currentVersion;
      s.notesHash = hash(notes);
      const changelog = join(s.path, 'CHANGELOG.md');
      const old = read(changelog);
      const storyCarryNote = s.storyCarry
        ? `\nStory carry-forward provenance (not Story DONE): ${s.storyCarry.storyId} at ${s.storyCarry.sourceHead}; storyFilesHash ${s.storyCarry.storyFilesHash}; ${s.storyCarry.verificationIntentCount} mechanical intents; ${s.storyCarry.fullCommandCount} validation commands; ${s.storyCarry.baselineWitnesses.length} failures reproduced on main.\n`
        : '';
      const release = `## Lab ${name} - v${s.version} - ${new Date().toISOString().slice(0, 10)}\n\n${notes}\n\nMaintenance provenance: ${s.branch}, repair ${sha(s.path)}.${storyCarryNote}\nVerification command (replayed before integration and on main): \`${JSON.stringify(s.red.command).replace(/`/g, '')}\`.\nThis entry does not assert formal Story DONE or signed product-release credentials.\n\n`;
      writeFileSync(changelog, old.startsWith('# Changelog\n') ? '# Changelog\n\n' + release + old.slice('# Changelog\n'.length).trimStart() : release + old);
      git(s.path, 'add', 'CHANGELOG.md', ...(versionBump?.files ?? []));
      git(s.path, 'commit', '-m', `chore: record Lab ${name} maintenance at ${s.version}`);
      s.candidate = sha(s.path); s.phase = 'prepared'; save(s);
    }
    if (s.phase === 'prepared') {
      if (hash(notes) !== s.notesHash || sha(s.path) !== s.candidate) fail('Prepared candidate/notes changed; preserve state for explicit recovery.');
      // Detect a crash between fast-forward and the durable integrated marker.
      if (sha(mainRoot) === s.candidate) { s.phase = 'integrated'; save(s); }
      else {
        if (sha(mainRoot) !== s.releaseBase) fail('main moved after preparation; preserve candidate for explicit re-preparation.');
        build(s.path); checkStoryBaselineParity(s.path, 'candidate-story-baseline');
        checkStoryIntegrationWitnesses(s.path, 'candidate-story-integration'); check(s.path, 'candidate-green');
        await ensureAudit(s.releaseBase, s.candidate);
        assertMainStable(); assertClean(s.path, s.override);
        if (sha(mainRoot) !== s.releaseBase || sha(s.path) !== s.candidate) fail('HEAD changed during verification; refusing merge.');
        if (git(mainRoot, 'branch', '--show-current') !== 'main') fail('The main checkout changed branches.');
        git(mainRoot, 'merge', '--ff-only', s.candidate);
        s.phase = 'integrated'; save(s);
      }
    }
    if (s.phase === 'integrated') {
      if (sha(mainRoot) !== s.candidate) fail('main moved before post-merge verification; workspace retained for recovery.');
      // This exact immutable input already passed before --ff-only; the bounds cannot newly grow here.
      await ensureAudit(s.releaseBase, s.candidate);
      build(mainRoot); checkStoryBaselineParity(mainRoot, 'main-story-baseline');
      checkStoryIntegrationWitnesses(mainRoot, 'main-story-integration'); check(mainRoot, 'main-green');
      if (versions.readSyncedVersion(mainRoot) !== s.version) fail('main version drift after integration.');
      s.phase = 'verified'; save(s);
    }
    if (s.phase === 'verified') {
      await ensureAudit(s.releaseBase, s.candidate, entry ? s.path : mainRoot);
      assertMainStable();
      if (!auditIsFresh(s.audit, expectedAudit(mainRoot, s.releaseBase, s.candidate, s.developerHost).expected)) fail('Fresh independent Lab audit required before cleanup.');
      if (!entry && existsSync(s.path)) fail('Unregistered directory remains at Lab path; cleanup refused.');
      assertAncestor(mainRoot, s.candidate, 'main');
      if (entry) {
        if (sha(s.path) !== s.candidate) fail('Lab has additional work; cleanup refused.');
        const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 30000 }).trim();
        const packageName = JSON.parse(read(join(mainRoot, 'packages/main/package.json'))).name;
        if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(packageName)) fail('Invalid package identity for global-link check.');
        const installed = join(globalRoot, packageName);
        if (existsSync(installed)) {
          const rel = relative(realpathSync(s.path), realpathSync(installed));
          if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../')) {
            fail('Global package links into Lab; relink it to verified main, then retry finish.');
          }
        }

        assertClean(s.path, s.override);
        const override = join(s.path, 'AGENTS.override.md');
        if (existsSync(override)) {
          if (hash(read(override)) !== s.override) fail('Lab override changed; cleanup refused.');
          unlinkSync(override);
        }
        git(mainRoot, 'worktree', 'remove', s.path);
      }
      // Never force-delete; Git must also confirm branch reachability.
      if (git(mainRoot, 'branch', '--list', s.branch)) git(mainRoot, 'branch', '-d', s.branch);
      s.phase = 'closed'; save(s);
      console.log(`Integrated Lab ${name} locally at ${s.version}; checks passed; worktree and branch removed.\nAudit record: ${statePath}\nNo remote push performed.`);
    }
  } finally { mainLock?.release(); labLock?.release(); }
}
main().catch(error => { console.error(`Lab stopped: ${error.message}`); process.exitCode = 1; });
