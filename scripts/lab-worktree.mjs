#!/usr/bin/env node
import './lab-source-loader.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const help = `Local Lab maintenance (Node 24+; no Story lifecycle, no remote push)
  node scripts/lab-worktree.mjs create NAME
  node scripts/lab-worktree.mjs sync NAME
  node scripts/lab-worktree.mjs status NAME
  node scripts/lab-worktree.mjs reopen NAME --confirm
  node scripts/lab-worktree.mjs red NAME --expect TEXT -- EXECUTABLE ARG...
  node scripts/lab-worktree.mjs green NAME
  node scripts/lab-worktree.mjs finish NAME --notes FILE --confirm

Commit the repair before green. Green replays the exact RED command.
Finish requires fresh GREEN, synchronizes main, records notes/version, builds
when main's policy requires it, reruns the check, fast-forwards clean local main,
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
function assertAncestor(cwd, ancestor, child) {
  try { git(cwd, 'merge-base', '--is-ancestor', ancestor, child); } catch { fail(`${ancestor} is not integrated into ${child}.`); }
}
function run(cwd, command) {
  const start = Date.now();
  const r = spawnSync(command[0], command.slice(1), { cwd, encoding: 'utf8', timeout: 900000, maxBuffer: 32 * 1024 * 1024, shell: false });
  const output = (r.stdout || '') + (r.stderr || '');
  if (output) process.stdout.write(output);
  return { command, head: sha(cwd), status: r.status, signal: r.signal, error: r.error?.message, elapsedMs: Date.now() - start, output, at: new Date().toISOString() };
}
function passed(result) { return result.status === 0 && !result.signal && !result.error; }
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
    `Use isolated test data and this checkout's implementation. Keep hooks enabled.\n` +
    `Do not share writable dist or change global installations incidentally.\n` +
    `Only an explicit user request triggers finish: notes/version/build/checks,\n` +
    `local main integration, then worktree and merged-branch cleanup on success.\n` +
    `Preserve the workspace on any failure. Never push automatically.\n` +
    `Keep this generated file untracked and unchanged; stage repair files explicitly.\n`;
}

async function main() {
  const [action, name, ...rest] = process.argv.slice(2);
  if (!action || action === '--help') { console.log(help); return; }
  if (!['create', 'sync', 'status', 'red', 'green', 'finish', 'reopen'].includes(action)) fail('Unknown command. Use --help.');
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(name || '')) fail('NAME must be 1-48 lowercase letters, digits or hyphens.');
  let notesPath, expected, command;
  if (action === 'red') {
    if (rest[0] !== '--expect' || !rest[1]?.trim() || rest[2] !== '--' || !rest[3]) fail('red requires --expect TEXT -- EXECUTABLE ARG...');
    expected = rest[1]; command = rest.slice(3);
  } else if (action === 'finish') {
    if (rest.length !== 3 || rest[0] !== '--notes' || !rest[1] || rest[2] !== '--confirm') fail('finish requires --notes FILE --confirm (explicit local integration request).');
    notesPath = resolve(rest[1]);
  } else if (action === 'reopen') {
    if (rest.length !== 1 || rest[0] !== '--confirm') fail('reopen requires --confirm.');
  } else if (rest.length) fail('Unexpected arguments. Use --help.');
  const cwd = git(process.cwd(), 'rev-parse', '--show-toplevel');
  const entries = worktrees(cwd);
  const mainRoot = entries.find(w => w.branch === 'refs/heads/main')?.worktree;
  if (!mainRoot) fail('A local main checkout is required.');
  const core = rel => import(pathToFileURL(join(mainRoot, 'packages/main/src/core', rel + '.ts')).href);
  const { acquireMainWriteLock } = await core('main-write-lock');
  const { LAB_MAINTENANCE_GIT_DIR } = await core('runtime-artifact-registry');
  const common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const dir = join(common, LAB_MAINTENANCE_GIT_DIR);
  const statePath = join(dir, name + '.json');
  const lock = acquireMainWriteLock(mainRoot, { label: `lab ${action} ${name}` });
  try {
    if (git(mainRoot, 'branch', '--show-current') !== 'main') fail('The main checkout changed branches.');
    mkdirSync(dir, { recursive: true });
    const keyPath = join(dir, 'local.key');
    if (!existsSync(keyPath)) {
      if (existsSync(statePath)) fail('Local Lab signing key is missing; preserve records for recovery.');
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    }
    const key = readFileSync(keyPath);
    const mac = payload => createHmac('sha256', key).update(JSON.stringify(payload)).digest('hex');
    const save = state => atomic(statePath, JSON.stringify({ payload: state, hmac: mac(state) }, null, 2) + '\n');
    if (action === 'create') {
      if (existsSync(statePath)) fail('This Lab name already has a record; use a new name or inspect status.');
      const path = join(mainRoot, '.worktrees', `Lab-${name}`), branch = `codex/lab-${name}`;
      if (existsSync(path)) fail('Lab path already exists; refusing to adopt or overwrite it.');
      const body = instructions(name);
      git(mainRoot, 'worktree', 'add', '-b', branch, path, 'main');
      // No force, reset or fallback adoption: a partially created directory stays recoverable.
      if (existsSync(join(path, 'AGENTS.override.md'))) fail('Tracked override exists; workspace retained for inspection.');
      writeFileSync(join(path, 'AGENTS.override.md'), body, { flag: 'wx' });
      save({ schema: 1, name, path, branch, mainRoot, base: sha(mainRoot), override: hash(body), phase: 'active', history: [] });
      console.log(`Created ${path}\nBranch: ${branch}\nNext: reproduce RED; commit repair; green; manually finish.`); return;
    }
    if (!existsSync(statePath)) fail('Unknown Lab. Use create NAME first; legacy/manual worktrees are not automatically adopted.');
    const envelope = JSON.parse(read(statePath)), s = envelope.payload;
    if (envelope.hmac !== mac(s) || s.schema !== 1 || s.name !== name || s.mainRoot !== mainRoot) fail('Invalid Lab record; refusing mutation.');
    if (action === 'status') { console.log(JSON.stringify(s, null, 2)); return; }
    if (s.phase === 'closed') fail('Lab is already integrated and cleaned up.');
    const entry = worktrees(mainRoot).find(w => w.worktree === s.path);
    // A crash after worktree removal can still be recovered by finish.
    if (!entry && !(action === 'finish' && s.phase === 'verified')) fail('Recorded Lab worktree is missing.');
    if (entry && (entry.branch !== `refs/heads/${s.branch}` || entry.locked)) fail('Lab branch changed or worktree is locked; preserve it for inspection.');
    if (entry) assertClean(s.path, s.override);
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
      const before = sha(s.path), r = run(s.path, command);
      if (passed(r) || r.status === null || r.signal || r.error || !r.output.includes(expected)) fail('Expected target RED was not observed; no RED recorded.');
      assertClean(s.path, s.override);
      if (sha(s.path) !== before) fail('RED command changed HEAD.');
      s.red = { ...r, expected }; s.green = null; s.history.push({ kind: 'red', ...s.red }); save(s); console.log('Target RED recorded locally.'); return;
    }
    if (action === 'green') {
      if (s.phase !== 'active' || !s.red) fail('An active Lab with a recorded RED is required.');
      assertAncestor(s.path, s.red.head, 'HEAD');
      if (sha(s.path) === s.red.head) fail('Commit a repair after RED before recording GREEN.');
      const before = sha(s.path), r = run(s.path, s.red.command);
      assertClean(s.path, s.override);
      if (!passed(r) || sha(s.path) !== before) fail('GREEN failed or command changed HEAD.');
      s.green = r; s.history.push({ kind: 'green', ...r }); save(s); console.log('GREEN recorded for current committed HEAD.'); return;
    }
    const notes = read(notesPath).trim();
    if (notes.length < 40 || notes.length > 100000) fail('Provide substantive English release notes (40-100000 characters).');
    assertClean(mainRoot);
    const versions = await core('version-bump');
    const { shouldBuildDoneMainPackageForChangedPaths } = await core('runtime-version-policy');
    const check = (root, kind) => {
      const before = sha(root), r = run(root, s.red.command);
      s.history.push({ kind, ...r }); save(s);
      assertClean(root, root === s.path ? s.override : undefined);
      if (!passed(r) || sha(root) !== before) fail(`${kind} failed or modified the checkout; workspace retained.`);
    };
    const build = root => {
      if (s.bump) {
        const r = run(root, ['npm', '--prefix', 'packages/main', 'run', 'build']);
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
      const paths = git(s.path, 'diff', '--name-only', 'main...HEAD').split('\n');
      if (paths.some(p => p === 'AGENTS.override.md' || /^\.proof-or-stop\/story\//.test(p))) fail('Lab override or real Story state cannot be released through Lab.');
      s.bump = shouldBuildDoneMainPackageForChangedPaths(paths);
      const currentVersion = versions.readSyncedVersion(mainRoot);
      if (versions.readSyncedVersion(s.path) !== currentVersion) fail('Version drift: leave version changes to finish, based on latest main.');
      s.version = s.bump ? versions.applyPatchBump(s.path).to : currentVersion;
      s.notesHash = hash(notes);
      const changelog = join(s.path, 'CHANGELOG.md');
      const old = read(changelog);
      const release = `## Lab ${name} - v${s.version} - ${new Date().toISOString().slice(0, 10)}\n\n${notes}\n\nMaintenance provenance: ${s.branch}, repair ${sha(s.path)}.\nVerification command (replayed before integration and on main): \`${JSON.stringify(s.red.command).replace(/`/g, '')}\`.\nThis entry does not assert formal Story DONE or signed product-release credentials.\n\n`;
      writeFileSync(changelog, old.startsWith('# Changelog\n') ? '# Changelog\n\n' + release + old.slice('# Changelog\n'.length).trimStart() : release + old);
      git(s.path, 'add', 'CHANGELOG.md', ...(s.bump ? versions.VERSION_SYNC_PATHS : []));
      git(s.path, 'commit', '-m', `chore: record Lab ${name} maintenance at ${s.version}`);
      s.candidate = sha(s.path); s.phase = 'prepared'; save(s);
    }
    if (s.phase === 'prepared') {
      if (hash(notes) !== s.notesHash || sha(s.path) !== s.candidate) fail('Prepared candidate/notes changed; preserve state for explicit recovery.');
      // Detect a crash between fast-forward and the durable integrated marker.
      if (sha(mainRoot) === s.candidate) { s.phase = 'integrated'; save(s); }
      else {
        if (sha(mainRoot) !== s.releaseBase) fail('main moved after preparation; preserve candidate for explicit re-preparation.');
        build(s.path); check(s.path, 'candidate-green');
        assertClean(mainRoot); assertClean(s.path, s.override);
        if (sha(mainRoot) !== s.releaseBase || sha(s.path) !== s.candidate) fail('HEAD changed during verification; refusing merge.');
        if (git(mainRoot, 'branch', '--show-current') !== 'main') fail('The main checkout changed branches.');
        git(mainRoot, 'merge', '--ff-only', s.candidate);
        s.phase = 'integrated'; save(s);
      }
    }
    if (s.phase === 'integrated') {
      if (sha(mainRoot) !== s.candidate) fail('main moved before post-merge verification; workspace retained for recovery.');
      build(mainRoot); check(mainRoot, 'main-green');
      if (versions.readSyncedVersion(mainRoot) !== s.version) fail('main version drift after integration.');
      s.phase = 'verified'; save(s);
    }
    if (s.phase === 'verified') {
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
  } finally { lock.release(); }
}
main().catch(error => { console.error(`Lab stopped: ${error.message}`); process.exitCode = 1; });
