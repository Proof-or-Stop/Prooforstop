import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { verificationSpawner } from './verification-subprocess-budget.mjs';
const spawnSync = verificationSpawner();
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = spawnSync(process.execPath, [join(repo, 'scripts/ensure-dist.mjs')], { cwd: repo, encoding: 'utf8', timeout: 180000 });
assert.equal(build.status, 0, `SETUP_BUILD_FAILED: ${build.stdout} ${build.stderr}`);
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^PROOF_OR_STOP_(?:OWNER_SESSION_ADAPTER_|ACTIVITY_|SESSION_ID$|AGENT$)/.test(key)
  || ['NODE_OPTIONS','PROOF_OR_STOP_REVIEWER_READONLY','PROOF_OR_STOP_IMPLEMENTATION_MANIFEST','PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN',
    'PROOF_OR_STOP_EXPECTED_IMPLEMENTATION_DIGEST','PROOF_OR_STOP_OWNER_SESSION_ID','PROOF_OR_STOP_HOST_SESSION_TOKEN',
    'CLAUDE_CODE_SESSION_ID','CLAUDE_SESSION_ID','CODEX_THREAD_ID','CODEX_SESSION_ID','OPENAI_SESSION_ID','TERM_SESSION_ID','ANTIGRAVITY_SESSION_ID','AGY_SESSION_ID'].includes(key)) delete env[key];
env.CODEX_THREAD_ID = `audit-repair-${process.pid}`;
const temp = mkdtempSync(join(tmpdir(), 'cli-audit-repair-'));
const project = join(temp, 'project');
const groups = [], commands = [];
const group = async (id, fn) => {
  const start = performance.now();
  try { await fn(); groups.push({ id, pass: true, ms: performance.now() - start }); }
  catch (error) { groups.push({ id, pass: false, ms: performance.now() - start, error: error.message }); }
};
const cli = (argv, entry = join(repo, 'bin/proof-or-stop.js')) => {
  const start = performance.now();
  const r = spawnSync(process.execPath, [entry, ...argv], { cwd: project, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.error, undefined); assert.equal(r.signal, null);
  const row = { argv, status: r.status, stdout: r.stdout, stderr: r.stderr, ms: performance.now() - start };
  commands.push(row); return row;
};
const git = (cwd, ...argv) => {
  const r = spawnSync('git', argv, { cwd, env, encoding: 'utf8', timeout: 15000 });
  assert.equal(r.status, 0, `SETUP_GIT: ${r.stderr}`); return r.stdout.trim();
};
try {
  mkdirSync(join(project, 'src'), { recursive: true });
  const config = { ...JSON.parse(readFileSync(join(repo, 'proof-or-stop.config.json'))), scanRoot: '.', rootDir: 'src', outDir: 'dist',
    testsDir: 'tests', fixturesDir: 'tests/fixtures', storyDir: '.proof-or-stop/story/actives' };
  writeFileSync(join(project, 'proof-or-stop.config.json'), JSON.stringify(config));
  writeFileSync(join(project, 'src/subject.ts'), 'export const value = 1;\n');
  writeFileSync(join(project, '.gitignore'), '.proof-or-stop/\n.worktrees/\n');
  git(project,'init','-q','-b','main');git(project,'config','user.name','Audit fixture');git(project,'config','user.email','audit@example.invalid');
  git(project,'add','.');git(project,'commit','-qm','seed audit fixture');
  await group('invalid-mode-is-not-bootstrap-failure', () => {
    const rows = [cli(['quorum_prune','--storyId=B-audit','--apply','--dryRun']),cli(['story_reconcile','--dryRun=maybe'])];
    for (const r of rows) { assert.notEqual(r.status, 0); assert.match(r.stderr, /boolean|either apply/); }
    assert.ok(rows.every(r => !r.stderr.includes('local bootstrap is not ready')), 'AUDIT_REPAIR_RED: argument errors must not advertise rebuilding the CLI');
  });
  await group('compiled-delegate-refused-before-classification', () => {
    const install = join(temp, 'installation'); const pkg = join(install, 'packages/main');mkdirSync(pkg,{recursive:true});
    for (const rel of ['packages/main/dist','packages/main/templates','packages/utils/dist','bin','scripts']) cpSync(join(repo,rel),join(install,rel),{recursive:true});
    for (const rel of ['package.json','packages/main/package.json']) cpSync(join(repo,rel),join(install,rel));
    symlinkSync(join(repo,'node_modules'),join(install,'node_modules'));
    const entry=join(install,'bin/proof-or-stop.js');
    const helper=join(pkg,'dist/core/maintenance-command-mode.js');const original=readFileSync(helper,'utf8');
    const marker='export function maintenanceCommandWrites(command, args, rawAdmission = false) {';
    assert.ok(original.includes(marker),'SETUP: locate actual delegate body');
    const args=[['story_reconcile','--dryRun'],['quorum_prune','--storyId=B-audit','--dryRun'],
      ['capability_release_backfill','--dryRun'],['verification_evidence_refresh_stale','--storyId=B-audit','--dryRun']];
    for(const argv of args) assert.equal(cli([argv[0],'--help'],entry).status,0,'canonical delegate admits help');
    writeFileSync(helper,original.replace(marker,marker+"\nprocess.stdout.write('TAMPERED_DELEGATE_EXECUTED\\n');"));
    const rows=args.map(argv=>cli(argv,entry));
    writeFileSync(helper,original);
    for(const argv of args) assert.equal(cli([argv[0],'--help'],entry).status,0,'restored delegate recovers');
    assert.ok(rows.every(r=>r.status!==0 && /maintenance-command-mode.*consumer rejected/.test(r.stderr)
      && !r.stdout.includes('TAMPERED_DELEGATE_EXECUTED')), 'AUDIT_REPAIR_RED: every maintenance command must reject changed delegate before invoking it');
  });
  const { StoryStore } = await import(join(repo,'packages/main/dist/core/store.js'));
  const { projectQueueGovernance } = await import(join(repo,'packages/main/dist/core/lifecycle-control/queue/index.js'));
  const { projectRuntimeClosure } = await import(join(repo,'packages/main/dist/core/lifecycle-control/runtime/index.js'));
  const { resolveStoryWorkspace } = await import(join(repo,'packages/main/dist/core/story-workspace.js'));
  const sid='B-audit';const wt=join(project,'.worktrees',sid);mkdirSync(dirname(wt),{recursive:true});
  git(project,'worktree','add','-qb',`story/${sid}`,wt,'main');
  const store=new StoryStore(project),local=new StoryStore(wt);
  const old=new Date(Date.now()-14*86400000).toISOString();
  const story={storyId:sid,name:'audit',title:'Audit ongoing work',description:'Isolated regression',phase:'DEV',type:'chore',priority:'medium',createdAt:old,
    events:[{phase:'DEV',action:'advance',timestamp:old}],worktree:{path:wt,branch:`story/${sid}`}};
  store.writeStory(sid,story);store.writeChecklist(sid,{items:[]});local.writeStory(sid,story);local.writeChecklist(sid,{items:[]});
  const queue=()=>projectQueueGovernance(store,project).rows.find(r=>r.storyId===sid);
  await group('recorded-work-without-phase-advance',()=>{
    assert.equal(queue().classification,'stale-worktree','new inherited main commit is not Story activity');
    local.writeStory(sid,{...story,events:[...story.events,{phase:'DEV',action:'update',timestamp:new Date().toISOString(),detail:'Checklist progress'}]});
    try {assert.equal(queue().classification,'active-worktree','AUDIT_REPAIR_RED: recent recorded work must count without phase advance');}
    finally {local.writeStory(sid,story);}
  });
  await group('story-exclusive-commit-without-phase-advance',()=>{
    writeFileSync(join(wt,'src/subject.ts'),'export const value = 2;\n');git(wt,'add','src/subject.ts');git(wt,'commit','-qm','ongoing Story implementation');
    assert.equal(queue().classification,'active-worktree','AUDIT_REPAIR_RED: a recent Story-exclusive commit must count as work');
  });
  await group('deprecated-lock-hint-is-observable',()=>{
    const r=cli(['runtime_closure_status',`--storyId=${sid}`,`--currentValidationStoryId=${sid}`,'--json']);
    assert.equal(r.status,0,r.stderr);
    assert.match(r.stderr,/currentValidationStoryId.*deprecated/i,'AUDIT_REPAIR_RED: ignored legacy hint needs a visible deprecation');
  });
  await group('wrapper-metadata-root-counterexamples',()=>{
    const outer=join(temp,'wrapper');const code=join(outer,'code');mkdirSync(code,{recursive:true});
    writeFileSync(join(outer,'proof-or-stop.config.json'),JSON.stringify({...config,gitRoot:'code'}));
    git(code,'init','-q','-b','main');git(code,'config','user.name','Wrapper fixture');git(code,'config','user.email','audit@example.invalid');
    writeFileSync(join(code,'subject'),'seed');git(code,'add','.');git(code,'commit','-qm','wrapper seed');
    const linked=join(outer,'linked');git(code,'worktree','add','-qb',`story/${sid}`,linked,'main');
    const wrapperStore=new StoryStore(outer);wrapperStore.writeStory(sid,{...story,worktree:{path:linked,branch:`story/${sid}`}});wrapperStore.writeChecklist(sid,{items:[]});
    const fallback=resolveStoryWorkspace({store:wrapperStore,root:outer},sid,{terminalPhaseGuard:true});
    assert.equal(fallback.readFromStoryWorktree,false);assert.equal(fallback.store.projectRoot,outer);
    assert.equal(projectRuntimeClosure(wrapperStore,outer,{storyId:sid}).stories.length,1);
    writeFileSync(join(linked,'proof-or-stop.config.json'),JSON.stringify(config));
    const bound=new StoryStore(linked);bound.writeStory(sid,story);bound.writeChecklist(sid,{items:[]});
    const resolved=resolveStoryWorkspace({store:wrapperStore,root:outer},sid,{terminalPhaseGuard:true});
    assert.equal(resolved.readFromStoryWorktree,true);assert.equal(resolved.gitCwd,resolved.store.projectRoot);
    const fromWrapper=projectRuntimeClosure(wrapperStore,outer,{storyId:sid}).stories[0];
    const fromBound=projectRuntimeClosure(bound,linked,{storyId:sid}).stories[0];
    const readiness=r=>[...r.blockingItems,...r.advisoryItems].filter(i=>!['phaseCoherence','ownerLease','mainWriteLock','validationLock'].includes(i.check));
    assert.deepEqual(readiness(fromWrapper),readiness(fromBound),'wrapper and bound Store must use identical readiness metadata');
  });
  await group('standalone-version-test-build-prerequisite',()=>{
    const setup=join(temp,'unbuilt');mkdirSync(join(setup,'scripts'),{recursive:true});
    cpSync(join(repo,'scripts/verify-cli-runtime-version.mjs'),join(setup,'scripts/verify-cli-runtime-version.mjs'));
    cpSync(join(repo,'scripts/verification-subprocess-budget.mjs'),join(setup,'scripts/verification-subprocess-budget.mjs'));
    writeFileSync(join(setup,'scripts/ensure-dist.mjs'),"import{writeFileSync}from'node:fs';writeFileSync('builder-invoked','yes');process.exit(17);\n");
    const r=spawnSync(process.execPath,['scripts/verify-cli-runtime-version.mjs'],{cwd:setup,env,encoding:'utf8',timeout:15000});
    assert.notEqual(r.status,0);
    assert.ok(existsSync(join(setup,'builder-invoked')) && r.stderr.includes('SETUP_BUILD_FAILED'),
      'AUDIT_REPAIR_RED: standalone test must invoke and clearly report the failed prerequisite before copying dist');
  });
  await group('exact-doctor-alias-control',()=>{const r=cli(['codex','doctor']);assert.equal(r.status,0,r.stderr);});
  console.log(JSON.stringify({groups,commands,boundary:'Isolated real CLI and linked-worktree evidence; wrapper/alias cases are counterevidence controls, not claimed baseline bugs.'},null,2));
  if(groups.some(g=>!g.pass)){console.error('AUDIT_REPAIR_RED');process.exitCode=1;}else console.log('CLI_LAB_AUDIT_REPAIRS_GREEN');
} finally {rmSync(temp,{recursive:true,force:true});}
