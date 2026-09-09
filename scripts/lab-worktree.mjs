#!/usr/bin/env node
import './lab-source-loader.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync, renameSync, unlinkSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const help = `Local Lab maintenance (Node 24+; no Story lifecycle, no remote push)
  node scripts/lab-worktree.mjs create NAME
  node scripts/lab-worktree.mjs sync NAME
  node scripts/lab-worktree.mjs status NAME
  node scripts/lab-worktree.mjs reopen NAME --confirm
  node scripts/lab-worktree.mjs red NAME --expect TEXT -- EXECUTABLE ARG...
  node scripts/lab-worktree.mjs carry NAME --story B-xxxx --source PATH --confirm
  node scripts/lab-worktree.mjs baseline NAME --expect TEXT --confirm -- EXECUTABLE ARG...
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
function run(cwd, command) {
  const start = Date.now();
  const r = spawnSync(command[0], command.slice(1), { cwd, encoding: 'utf8', timeout: 900000, maxBuffer: 32 * 1024 * 1024, shell: false });
  const output = (r.stdout || '') + (r.stderr || '');
  if (output) process.stdout.write(output);
  return { command, head: sha(cwd), status: r.status, signal: r.signal, error: r.error?.message, elapsedMs: Date.now() - start, output, at: new Date().toISOString() };
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
    `Only an explicit user request triggers finish: notes/version/build/checks,\n` +
    `local main integration, then worktree and merged-branch cleanup on success.\n` +
    `Preserve the workspace on any failure. Never push automatically.\n` +
    `Keep this generated file untracked and unchanged; stage repair files explicitly.\n`;
}

async function main() {
  const [action, name, ...rest] = process.argv.slice(2);
  if (!action || action === '--help') { console.log(help); return; }
  if (!['create', 'sync', 'status', 'red', 'carry', 'baseline', 'green', 'finish', 'reopen'].includes(action)) fail('Unknown command. Use --help.');
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(name || '')) fail('NAME must be 1-48 lowercase letters, digits or hyphens.');
  let notesPath, expected, command, storyId, sourcePath;
  if (action === 'red') {
    if (rest[0] !== '--expect' || !rest[1]?.trim() || rest[2] !== '--' || !rest[3]) fail('red requires --expect TEXT -- EXECUTABLE ARG...');
    expected = rest[1]; command = rest.slice(3);
  } else if (action === 'baseline') {
    if (rest[0] !== '--expect' || !rest[1]?.trim() || rest[2] !== '--confirm' || rest[3] !== '--' || !rest[4]) {
      fail('baseline requires --expect TEXT --confirm -- EXECUTABLE ARG...');
    }
    expected = rest[1]; command = rest.slice(4);
  } else if (action === 'finish') {
    if (rest.length !== 3 || rest[0] !== '--notes' || !rest[1] || rest[2] !== '--confirm') fail('finish requires --notes FILE --confirm (explicit local integration request).');
    notesPath = resolve(rest[1]);
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
      if (testEvidence.disposition !== 'executed' || !/^[a-f0-9]{64}$/.test(testEvidence.storyFilesHash || '')) {
        fail('Story test evidence must be an executed, storyFilesHash-bound validation result.');
      }
      const rendered = typeof testEvidence.output === 'string' ? parseJsonText(testEvidence.output, 'Story test output') : testEvidence.output;
      const commands = Array.isArray(rendered?.commands) ? rendered.commands : [];
      if (!commands.length || rendered.commandExecutions !== commands.length) fail('Story validation must record every planned command execution.');
      const coverage = rendered.verificationCoverage;
      if (!coverage || coverage.required < 1 || coverage.covered !== coverage.required || coverage.missingRequired !== 0) {
        fail('Story validation must carry complete required verification coverage.');
      }
      const covered = Array.isArray(coverage.entries) ? coverage.entries : [];
      if (covered.length < coverage.required || covered.some(row => row.status !== 'covered'
        || row.evidence?.result !== 'pass' || row.evidence?.mechanical !== true
        || row.evidence?.storyFilesHash !== testEvidence.storyFilesHash
        || row.evidence?.receipt?.exitCode !== 0 || row.evidence?.receipt?.selectorMatched !== true)) {
        fail('Every required intent needs current mechanical PASS evidence bound to the same storyFilesHash.');
      }
      if (!testEvidence.headHash || !/^[a-f0-9]{40}$/.test(testEvidence.headHash)) fail('Story test evidence headHash is missing.');
      assertAncestor(sourcePath, testEvidence.headHash, sourceHead);
      const afterEvidence = git(sourcePath, 'diff', '--name-only', testEvidence.headHash, sourceHead).split('\n').filter(Boolean);
      if (afterEvidence.some(path => !path.startsWith(`.proof-or-stop/story/actives/${storyId}/`))) {
        fail('Story source has product changes after its recorded validation head.');
      }
      const failures = commands.filter(row => Number(row?.code ?? row?.exitCode ?? 0) !== 0);
      if (rendered.status === 'pass' ? failures.length !== 0 : failures.length < 1) fail('Story validation status and command failures disagree.');
      if (failures.length > 5) fail('Story carry-forward refuses more than five baseline failures.');
      const mainBefore = git(mainRoot, 'status', '--porcelain=v1', '-uall', '-z');
      const mainHead = sha(mainRoot);
      const baselineWitnesses = failures.map(row => {
        if (typeof row.command !== 'string' || !row.command || !Array.isArray(row.args) || row.args.some(arg => typeof arg !== 'string')) {
          fail('Each failing validation row must carry an executable plus argv.');
        }
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
        storyFilesHash: testEvidence.storyFilesHash, verificationIntentCount: coverage.required,
        fullCommandCount: commands.length, sourceValidationResult: testEvidence.result,
        baselineWitnesses, importedPaths, patchHash: hash(patch), capturedAt: new Date().toISOString(),
      };
      s.green = null;
      s.history.push({ kind: 'story-carry', ...s.storyCarry });
      save(s);
      console.log(`Story evidence captured and patch applied: ${storyId}; ${coverage.required} intents, ${commands.length} commands, ${failures.length} reproduced baseline failures, ${importedPaths.length} imported paths.`);
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
      const before = sha(s.path), r = run(s.path, s.red.command);
      assertClean(s.path, s.override);
      if (!passed(r) || sha(s.path) !== before) fail('GREEN failed or command changed HEAD.');
      s.green = r; s.history.push({ kind: 'green', ...r }); save(s); console.log('GREEN recorded for current committed HEAD.'); return;
    }
    const notes = read(notesPath).trim();
    if (notes.length < 40 || notes.length > 100000) fail('Provide substantive English release notes (40-100000 characters).');
    const mainDirty = dirtySnapshot(mainRoot);
    let preservedMainDirty = null;
    if (mainDirty.paths.length > 0) {
      if (!s.storyCarry) fail(`Uncommitted or untracked work in ${mainRoot}; preserve/commit it before continuing.`);
      const candidatePaths = git(s.path, 'diff', '--name-only', 'main...HEAD').split('\n').filter(Boolean);
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
      const finishBaselineWitnesses = s.storyCarry.baselineWitnesses.map(previous => {
        const witness = runCaptured(mainRoot, previous.command);
        if (witness.status === null || witness.signal || witness.error) fail(`Story baseline command could not run on latest main: ${previous.command.join(' ')}`);
        return {
          command: previous.command,
          sourceExitCode: previous.sourceExitCode,
          mainExitCode: witness.status,
          mainOutputDigest: hash(witness.output),
          mainOutputTail: outputTail(witness.output),
          mainElapsedMs: witness.elapsedMs,
          observedAt: witness.at,
        };
      });
      assertMainStable();
      s.storyCarry.finishBaselineWitnesses = finishBaselineWitnesses;
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
        return {
          command: expected.command,
          expectedExitCode: expected.mainExitCode,
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
    const versions = await core('version-bump');
    const { shouldBuildDoneMainPackageForChangedPaths } = await core('runtime-version-policy');
    const check = (root, kind) => {
      const before = sha(root), r = run(root, s.red.command);
      s.history.push({ kind, ...r }); save(s);
      if (root === mainRoot) assertMainStable();
      else assertClean(root, s.override);
      if (!passed(r) || sha(root) !== before) fail(`${kind} failed or modified the checkout; workspace retained.`);
    };
    const build = root => {
      if (s.bump) {
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
      const paths = git(s.path, 'diff', '--name-only', 'main...HEAD').split('\n');
      if (paths.some(p => p === 'AGENTS.override.md' || /^\.proof-or-stop\/story\//.test(p))) fail('Lab override or real Story state cannot be released through Lab.');
      s.bump = shouldBuildDoneMainPackageForChangedPaths(paths);
      const currentVersion = versions.readSyncedVersion(mainRoot);
      if (versions.readSyncedVersion(s.path) !== currentVersion) fail('Version drift: leave version changes to finish, based on latest main.');
      s.version = s.bump ? versions.applyPatchBump(s.path).to : currentVersion;
      s.notesHash = hash(notes);
      const changelog = join(s.path, 'CHANGELOG.md');
      const old = read(changelog);
      const storyCarryNote = s.storyCarry
        ? `\nStory carry-forward provenance (not Story DONE): ${s.storyCarry.storyId} at ${s.storyCarry.sourceHead}; storyFilesHash ${s.storyCarry.storyFilesHash}; ${s.storyCarry.verificationIntentCount} mechanical intents; ${s.storyCarry.fullCommandCount} validation commands; ${s.storyCarry.baselineWitnesses.length} failures reproduced on main.\n`
        : '';
      const release = `## Lab ${name} - v${s.version} - ${new Date().toISOString().slice(0, 10)}\n\n${notes}\n\nMaintenance provenance: ${s.branch}, repair ${sha(s.path)}.${storyCarryNote}\nVerification command (replayed before integration and on main): \`${JSON.stringify(s.red.command).replace(/`/g, '')}\`.\nThis entry does not assert formal Story DONE or signed product-release credentials.\n\n`;
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
        build(s.path); checkStoryBaselineParity(s.path, 'candidate-story-baseline'); check(s.path, 'candidate-green');
        assertMainStable(); assertClean(s.path, s.override);
        if (sha(mainRoot) !== s.releaseBase || sha(s.path) !== s.candidate) fail('HEAD changed during verification; refusing merge.');
        if (git(mainRoot, 'branch', '--show-current') !== 'main') fail('The main checkout changed branches.');
        git(mainRoot, 'merge', '--ff-only', s.candidate);
        s.phase = 'integrated'; save(s);
      }
    }
    if (s.phase === 'integrated') {
      if (sha(mainRoot) !== s.candidate) fail('main moved before post-merge verification; workspace retained for recovery.');
      build(mainRoot); checkStoryBaselineParity(mainRoot, 'main-story-baseline'); check(mainRoot, 'main-green');
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
