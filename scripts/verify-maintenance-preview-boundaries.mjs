import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { prepareVerification } from './verification-subprocess-budget.mjs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spawnSync = prepareVerification(repo);
const groups = [];
const rows = [];
const check = async (id, run) => { try { await run(); groups.push({ id, pass: true }); } catch (e) { groups.push({ id, pass: false, error: e.message }); } };
const root = mkdtempSync(join(tmpdir(), 'preview-cli-followup-'));
const prior = process.cwd();
const sid = 'B-preview-followup';
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^PROOF_OR_STOP_(?:OWNER_SESSION_ADAPTER_|ACTIVITY_|SESSION_ID$|AGENT$)/.test(key)
    || ['NODE_OPTIONS', 'PROOF_OR_STOP_REVIEWER_READONLY', 'PROOF_OR_STOP_OWNER_SESSION_ID', 'PROOF_OR_STOP_HOST_SESSION_TOKEN',
      'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'OPENAI_SESSION_ID',
      'TERM_SESSION_ID', 'ANTIGRAVITY_SESSION_ID', 'AGY_SESSION_ID', 'PROOF_OR_STOP_IMPLEMENTATION_MANIFEST',
      'PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN', 'PROOF_OR_STOP_EXPECTED_IMPLEMENTATION_DIGEST'].includes(key)) delete env[key];
}
env.CODEX_THREAD_ID = `preview-owner-${process.pid}`;
const git = (...args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
};
const projectSnapshot = () => {
  const rows=[];
  const walk=(path,relative='')=>{
    for(const entry of readdirSync(path,{withFileTypes:true})) {
      const key=relative ? relative+'/'+entry.name : entry.name;
      if(['.git','.proof-or-stop/story','.proof-or-stop/activity.jsonl'].includes(key)) continue;
      const file=join(path,entry.name);
      if(entry.isDirectory()){rows.push([key,'directory']);walk(file,key);}
      else rows.push([key,createHash('sha256').update(readFileSync(file)).digest('hex')]);
    }
  };
  walk(root);return rows.sort();
};
const storySnapshot = () => {
  const rows = [];
  const walk = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const name = join(path, entry.name);
      if (entry.isDirectory()) walk(name);
      else rows.push([name.slice(root.length), createHash('sha256').update(readFileSync(name)).digest('hex')]);
    }
  };
  walk(join(root, '.proof-or-stop/story')); return rows.sort();
};
try {
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env); process.chdir(root);
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/subject.ts'), 'export const subject = 1;\n');
  writeFileSync(join(root, '.gitignore'), '.proof-or-stop/\n');
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(repo, 'proof-or-stop.config.json'))),
    scanRoot: '.', rootDir: 'src', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures', storyDir: '.proof-or-stop/story/actives' }));
  git('init', '-q', '-b', 'work'); git('config', 'user.name', 'Preview probe'); git('config', 'user.email', 'preview@example.invalid');
  git('add', '.'); git('commit', '-qm', 'seed preview probe'); git('branch', 'main');
  const { StoryStore } = await import(join(repo, 'packages/main/dist/core/store.js'));
  const { acquireOwnerLease, getSessionId } = await import(join(repo, 'packages/main/dist/core/story-owner-lease.js'));
  const store = new StoryStore(root);
  store.writeStory(sid, { storyId: sid, name: 'preview-followup', title: 'Inspect maintenance preview', phase: 'REVIEW', type: 'chore',
    priority: 'medium', createdAt: new Date().toISOString(), currentReviewRound: new Date().toISOString() });
  store.writeChecklist(sid, { items: [] });
  const lease = acquireOwnerLease(store.storyDirPath(sid), { command: 'preview-control', cwd: root });
  assert.equal(lease.sessionId, getSessionId());
  // These old receipt-less rows are diagnostic input, never fabricated gate PASS.
  // They force the nonempty stale preview and expose any accidental re-execution.
  store.writeChecklist(sid, { items: [{ id: 'CHK-001', title: 'Preview old evidence', status: 'pending',
    verificationIntent: { happy: [{ id: 'old-proof', desc: 'Observe stale evidence without running it', type: 'logic', priority: 'must' }] },
    verificationEvidence: [{ intentRef: 'old-proof', kind: 'logic', result: 'pass', mechanical: true,
      headHash: '0'.repeat(40), materialHash: '0'.repeat(64), storyFilesHash: '0'.repeat(64),
      command: 'node should-not-run.cjs', note: 'Legacy diagnostic sample; not authoritative evidence.' }] }] });
  writeFileSync(join(root, 'should-not-run.cjs'), "require('fs').writeFileSync('unexpected-execution', 'ran');\n");
  const invoke = (command, args, kind = 'readonly') => {
    const before = storySnapshot(), projectBefore = projectSnapshot(); const headBefore = git('rev-parse', 'HEAD');
    const actualLaunches=[], originalSpawn=childProcess.spawnSync;let r;
    childProcess.spawnSync=function(executable,argv,...rest){actualLaunches.push({executable,argv:[...argv]});return originalSpawn.call(this,executable,argv,...rest);};syncBuiltinESMExports();
    try { r = spawnSync(process.execPath, [join(repo, 'bin/proof-or-stop.js'), command, ...args], {
      cwd: root, env: { ...env, CODEX_THREAD_ID: kind === 'owner' ? env.CODEX_THREAD_ID : `preview-reader-${process.pid}`,
        ...(kind === 'readonly' ? { PROOF_OR_STOP_REVIEWER_READONLY: '1' } : {}) }, encoding: 'utf8', timeout: 30000,
    });
    } finally {childProcess.spawnSync=originalSpawn;syncBuiltinESMExports();}
    assert.equal(actualLaunches.length,1,'observe the actual CLI OS launch');
    assert.equal(actualLaunches[0].executable,process.execPath);
    assert.equal(actualLaunches[0].argv[0],join(repo,'bin/proof-or-stop.js'));
    assert.equal(r.error, undefined); assert.equal(r.signal, null, 'timeout is not target RED');
    const after = storySnapshot();
    const oldFiles = new Map(before), newFiles = new Map(after);
    const changedStoryFiles = [...new Set([...oldFiles.keys(), ...newFiles.keys()])].filter(k => oldFiles.get(k) !== newFiles.get(k));
    const row = { command:actualLaunches[0].argv[1], args:actualLaunches[0].argv.slice(2), kind, exitCode: r.status, stdout: r.stdout, stderr: r.stderr, changedStoryFiles,
      projectUnchanged: JSON.stringify(projectBefore) === JSON.stringify(projectSnapshot()),
      headUnchanged: headBefore === git('rev-parse', 'HEAD') };
    rows.push(row); return row;
  };
  const cases = [
    ['quorum_prune', [`--storyId=${sid}`, '--dryRun', '--json'], /"dryRun": true/],
    ['verification_evidence_refresh_stale', [`--storyId=${sid}`, '--dryRun'], /\[DRY-RUN\] Stale verification evidence/],
    ['story_reconcile', ['--dryRun'], /dry run result|No zombie stories/],
    ['capability_release_backfill', ['--dryRun', '--json'], /"applied": false/],
  ];
  for (const [command, args, marker] of cases) {
    const control = invoke(command, args, 'owner');
    assert.equal(control.exitCode, 0, `SETUP_CONTROL_FAILED: ${command} ${control.stderr}`);
    assert.match(control.stdout, marker, `SETUP_CONTROL_OUTPUT: ${command}`);
  }
  for (const [command, args, marker] of cases) await check(command, async () => {
    for (const kind of ['readonly', 'foreign', 'owner']) {
      const row = invoke(command, args, kind);
      assert.equal(row.exitCode, 0, `${command} preview refused: ${row.stderr}`);
      assert.match(row.stdout, marker); assert.deepEqual(row.changedStoryFiles, [], 'preview must not refresh owner lease or evidence');
      assert.equal(row.headUnchanged, true); assert.equal(row.projectUnchanged,true,'preview must preserve capability releases, learning, worktrees and project files');
    }
  });
  const { resolveEffectiveOwnershipClass, reviewerReadRecoveryHint } = await import(join(repo, 'packages/main/dist/cli/ownership-gate.js'));
  await check('parameter-matrix-and-protected-writes', async () => {
    for (const [cmd, args, expected] of [
      ['story_reconcile', {}, 'readOnly'], ['story_reconcile', {dryRun:false}, 'mainSharedMutating'],
      ['story_reconcile', {dryRun:'false'}, 'mainSharedMutating'],
      ['quorum_prune', {}, 'readOnly'], ['quorum_prune', {apply:true}, 'storyScopedMutating'],
      ['quorum_prune', {dryRun:false}, 'storyScopedMutating'], ['quorum_prune', {dryRun:'false'}, 'storyScopedMutating'],
      ['capability_release_backfill', {}, 'readOnly'], ['capability_release_backfill', {dryRun:false}, 'readOnly'],
      ['capability_release_backfill', {apply:'true'}, 'mainSharedMutating'],
      ['verification_evidence_refresh_stale', {}, 'storyScopedMutating'],
      ['verification_evidence_refresh_stale', {dryRun:false}, 'storyScopedMutating'],
      ['verification_evidence_refresh_stale', {dryRun:'true'}, 'readOnly'],
    ]) assert.equal(resolveEffectiveOwnershipClass(cmd, args, sid), expected, cmd + JSON.stringify(args));
    for (const cmd of cases.map(x => x[0])) for (const value of [1, null, {}, 'yes'])
      assert.throws(() => resolveEffectiveOwnershipClass(cmd, {dryRun:value}, sid), /boolean/, cmd);
    for (const args of [{apply:true,dryRun:true}, {apply:false,dryRun:false}])
      assert.throws(() => resolveEffectiveOwnershipClass('quorum_prune', args, sid), /contradict|not both/);
    assert.throws(() => resolveEffectiveOwnershipClass('capability_release_backfill', {apply:true,dryRun:true}, sid), /not both/);
    for (const [cmd, flags] of [
      ['story_reconcile', ['--dryRun=false']], ['quorum_prune', [`--storyId=${sid}`, '--apply']],
      ['quorum_prune', [`--storyId=${sid}`, '--dryRun=false']],
      ['capability_release_backfill', ['--apply']], ['verification_evidence_refresh_stale', [`--storyId=${sid}`]],
    ]) {
      const row = invoke(cmd, flags); assert.notEqual(row.exitCode, 0); assert.match(row.stderr, /not allowed in read-only reviewer mode/);
      assert.deepEqual(row.changedStoryFiles, []); assert.equal(row.headUnchanged, true);
    }
    // A foreign normal participant must not run either Story writer, even without advisory mode.
    for (const cmd of ['quorum_prune','verification_evidence_refresh_stale']) {
      const row = invoke(cmd, [`--storyId=${sid}`, ...(cmd === 'quorum_prune' ? ['--apply'] : [])], 'foreign');
      assert.notEqual(row.exitCode, 0); assert.match(row.stderr, /is owned by/); assert.deepEqual(row.changedStoryFiles, []);
    }
  });
  await check('actionable-read-guidance', async () => {
    for (const [writer, reader, flags] of [
      ['scope_freeze_check', 'init_preflight', [`--storyId=${sid}`]],
      ['verify_codex', 'codex_doctor', []],
      ['acceptance_rollout_report', 'acceptance_rollout_report_read', [`--storyId=${sid}`, '--json']],
    ]) {
      const hint = reviewerReadRecoveryHint(writer, {storyId:sid}, sid);
      assert.ok(hint.includes(reader === 'codex_doctor' ? 'codex doctor' : reader), writer + ' lacks reader hint');
      const refused = invoke(writer, flags); assert.deepEqual(refused.args, flags, 'every declared writer argument form must run'); assert.notEqual(refused.exitCode, 0); assert.ok(refused.stderr.includes(hint.trim()));
      const emitted = refused.stderr.split('\n').find(line => line.includes(hint.trim()));
      const exact = emitted.match(/: proof-or-stop (.*?) \(does not /)?.[1];
      assert.ok(exact, 'refusal must contain an executable reader command');
      const [command, ...args] = exact.split(' ');
      const row = invoke(command, args); assert.equal(row.exitCode, 0, row.stderr); assert.deepEqual(row.changedStoryFiles, []);
    }
    const text = readFileSync(join(repo, 'packages/main/src/handlers/session.ts'), 'utf8');
    assert.ok(!text.includes('guard_session_check for detail.'), 'brief must not direct a reader to a writer');
    assert.ok(text.includes('guard_session_status --storyId=${storyId}'), 'brief must offer a bound read command');
    const status = invoke('guard_session_status', [`--storyId=${sid}`, '--json']);
    assert.equal(status.exitCode, 0); assert.deepEqual(status.changedStoryFiles, []);
  });
  const { existsSync } = await import('node:fs'); assert.equal(existsSync(join(root, 'unexpected-execution')), false);
  console.log(JSON.stringify({ groups, invocations:rows, baseline:git('rev-parse', 'HEAD'),
    boundary:'Isolated real CLI preview admission and non-mutation; legacy evidence is diagnostic only; not Story completion or speedup.' }, null, 2));
  if (groups.some(g => !g.pass)) { console.error('MAINTENANCE_PREVIEW_RED'); process.exitCode = 1; }
  else console.log('MAINTENANCE_PREVIEW_GREEN');

} finally { process.chdir(prior); rmSync(root, { recursive: true, force: true }); }
