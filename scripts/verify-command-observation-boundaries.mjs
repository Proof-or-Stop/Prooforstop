import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { fork } from 'node:child_process';
import { prepareVerification } from './verification-subprocess-budget.mjs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const file = fileURLToPath(import.meta.url);
const repo = resolve(dirname(file), '..');
if (process.argv[2] === '--hold-lock') {
  const { withValidationExecutionLock } = await import(join(repo, 'packages/main/dist/core/validation-execution-lock.js'));
  await withValidationExecutionLock({ root: process.argv[3], storyId: process.argv[4], command: 'observation-fixture' }, async () => {
    process.send({ ready: true });
    await new Promise(resolve => process.once('message', resolve));
  });
  process.exit(0);
}
const spawnSync = prepareVerification(repo);
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^PROOF_OR_STOP_(?:OWNER_SESSION_ADAPTER_|ACTIVITY_|SESSION_ID$|AGENT$)/.test(key)
    || ['NODE_OPTIONS','PROOF_OR_STOP_REVIEWER_READONLY','PROOF_OR_STOP_OWNER_SESSION_ID','PROOF_OR_STOP_HOST_SESSION_TOKEN',
      'CLAUDE_CODE_SESSION_ID','CLAUDE_SESSION_ID','CODEX_THREAD_ID','CODEX_SESSION_ID','OPENAI_SESSION_ID','TERM_SESSION_ID',
      'ANTIGRAVITY_SESSION_ID','AGY_SESSION_ID','PROOF_OR_STOP_IMPLEMENTATION_MANIFEST','PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN',
      'PROOF_OR_STOP_EXPECTED_IMPLEMENTATION_DIGEST'].includes(key)) delete env[key];
}
env.CODEX_THREAD_ID = `command-observation-${process.pid}`;
for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
Object.assign(process.env, env);
const { StoryStore } = await import(join(repo, 'packages/main/dist/core/store.js'));
const { acquireOwnerLease, getSessionId, resetSessionIdForTest } = await import(join(repo, 'packages/main/dist/core/story-owner-lease.js'));
const { projectRuntimeClosure } = await import(join(repo, 'packages/main/dist/core/lifecycle-control/runtime/index.js'));
const { projectQueueGovernance } = await import(join(repo, 'packages/main/dist/core/lifecycle-control/queue/index.js'));
const { withValidationExecutionLock } = await import(join(repo, 'packages/main/dist/core/validation-execution-lock.js'));
const root = mkdtempSync(join(tmpdir(), 'command-observation-'));
const oldCwd = process.cwd();
const sid = 'B-observation';
const groups = [], observations = [];
const group = async (name, fn) => {
  const start = performance.now();
  try { await fn(); groups.push({ name, pass: true, ms: performance.now() - start }); }
  catch (error) { groups.push({ name, pass: false, error: error.message, ms: performance.now() - start }); }
};
const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' }); assert.equal(r.status, 0, `SETUP_GIT: ${r.stderr}`); return r.stdout.trim();
};
const contents = path => existsSync(path) ? readFileSync(path, 'utf8') : '';
const jsonLines = path => contents(path).trim().split('\n').filter(Boolean).map(JSON.parse);
let child;
try {
  process.chdir(root); resetSessionIdForTest();
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/subject.ts'), 'export const subject = true;\n');
  writeFileSync(join(root, '.gitignore'), '.proof-or-stop/\n.worktrees/\nhook-events.jsonl\n');
  writeFileSync(join(root, 'hook.cjs'), "require('fs').appendFileSync('hook-events.jsonl', JSON.stringify({stage:process.argv[2]})+'\\n');\n");
  const config = { ...JSON.parse(readFileSync(join(repo,'proof-or-stop.config.json'))), scanRoot: '.', rootDir: 'src', outDir: 'dist',
    testsDir: 'tests', fixturesDir: 'tests/fixtures', storyDir: '.proof-or-stop/story/actives',
    hooks: { preCommand: { reviewer_list: ['node hook.cjs pre'] }, postCommand: { reviewer_list: ['node hook.cjs post'] } } };
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify(config));
  git(root,'init','-q','-b','main');git(root,'config','user.name','Observation fixture');git(root,'config','user.email','observation@example.invalid');
  git(root,'add','.');git(root,'commit','-qm','seed observation fixture');
  const store = new StoryStore(root);
  const now = new Date().toISOString();
  const story = { storyId:sid,name:'observation',title:'Observe command boundaries',description:'Isolated observation regression',type:'chore',
    phase:'REVIEW',priority:'medium',createdAt:now,currentReviewRound:now,events:[] };
  store.writeStory(sid, story);store.writeChecklist(sid,{items:[]});
  acquireOwnerLease(store.storyDirPath(sid),{command:'fixture',cwd:root});
  const invoke = (args, readOnly = false) => {
    const start=performance.now(); const r=spawnSync(process.execPath,[join(repo,'bin/proof-or-stop.js'),'reviewer_list',`--storyId=${sid}`,'--json',...args],{
      cwd:root,env:{...env,PROOF_OR_STOP_ACTIVITY_SOURCE:'codex',...(readOnly?{PROOF_OR_STOP_REVIEWER_READONLY:'1'}:{})},encoding:'utf8',timeout:30000});
    assert.equal(r.error,undefined);assert.equal(r.signal,null);
    observations.push({kind:'cli',args,readOnly,exitCode:r.status,ms:performance.now()-start,stdout:r.stdout,stderr:r.stderr});return r;
  };
  await group('argument-aware-writer-observation',async()=>{
    const eventsPath=join(store.storyDirPath(sid),'process-events.jsonl');
    const before=contents(eventsPath);const plain=invoke([]);assert.equal(plain.status,0,plain.stderr);
    assert.equal(contents(join(root,'hook-events.jsonl')),'');assert.equal(contents(eventsPath),before);
    const written=invoke(['--forceReviewer=behavior']);assert.equal(written.status,0,written.stderr);
    const forced=store.readStory(sid).events.filter(e=>e.action==='reviewer_forced').length;
    const hooks=jsonLines(join(root,'hook-events.jsonl'));
    const processRows=jsonLines(eventsPath).filter(e=>e.type==='codex_cli'&&e.command==='reviewer_list');
    observations.push({kind:'write-observation',forced,hooks,processEventCount:processRows.length});
    assert.equal(forced,1,'positive control: handler must actually write its event');
    assert.deepEqual(hooks.map(x=>x.stage),['pre','post'],'writer must not inherit the static reader hook exemption');
    assert.equal(processRows.length,1,'writer must emit its command event once');
    assert.ok(jsonLines(join(root,'.proof-or-stop/activity.jsonl')).some(e=>e.tool==='reviewer_list'),'writer must record activity');
  });
  await group('reader-and-protected-writer-controls',async()=>{
    const hooks=contents(join(root,'hook-events.jsonl'));const events=contents(join(store.storyDirPath(sid),'process-events.jsonl'));
    const index=contents(join(store.storyDirPath(sid),'index.json'));
    const read=invoke([],true);assert.equal(read.status,0,read.stderr);
    const denied=invoke(['--forceReviewer=docs'],true);assert.notEqual(denied.status,0);assert.match(denied.stderr,/not allowed in read-only reviewer mode/);
    assert.equal(contents(join(root,'hook-events.jsonl')),hooks);assert.equal(contents(join(store.storyDirPath(sid),'process-events.jsonl')),events);
    assert.equal(contents(join(store.storyDirPath(sid),'index.json')),index);
  });
  const wt=join(root,'.worktrees',sid);git(root,'worktree','add','-q','-b',`story/${sid}`,wt);
  const metadata={...store.readStory(sid),worktree:{path:`.worktrees/${sid}`,branch:`story/${sid}`},events:[{phase:'DEV',action:'advance',timestamp:now}]};
  store.writeStory(sid,{...metadata,phase:'INIT_CHECK'});
  const local=new StoryStore(wt);local.writeStory(sid,{...metadata,phase:'DEV'});local.writeChecklist(sid,{items:[]});
  const lease=acquireOwnerLease(local.storyDirPath(sid),{command:'fixture-worktree',cwd:wt});assert.equal(lease.sessionId,getSessionId());
  // Leave the main mirror with a different, valid legacy owner by using the lease API under another explicit identity.
  const originalId=process.env.CODEX_THREAD_ID;process.env.CODEX_THREAD_ID='observation-mirror-other';resetSessionIdForTest();
  rmSync(join(store.storyDirPath(sid),'owner-lease.json'),{force:true});
  acquireOwnerLease(store.storyDirPath(sid),{command:'fixture-mirror',cwd:root});
  process.env.CODEX_THREAD_ID=originalId;resetSessionIdForTest();
  const runtime=options=>projectRuntimeClosure(store,root,{storyId:sid,...options}).stories.find(r=>r.storyId===sid);
  await group('authoritative-worktree-owner',async()=>{
    const before=contents(join(local.storyDirPath(sid),'owner-lease.json'));const start=performance.now();const row=runtime();
    observations.push({kind:'owner',ms:performance.now()-start,locks:row.locks});
    assert.equal(row.locks.ownerLease,'owned','query must read the authoritative worktree lease, not the main mirror');
    assert.equal(contents(join(local.storyDirPath(sid),'owner-lease.json')),before,'query must not refresh the lease');
  });
  await group('worktree-progress-not-directory-mtime',async()=>{
    const old=new Date(Date.now()-14*86400000);utimesSync(wt,old,old);
    const start=performance.now();const row=projectQueueGovernance(store,root).rows.find(r=>r.storyId===sid);
    observations.push({kind:'queue',ms:performance.now()-start,row});
    assert.equal(row.classification,'active-worktree','recent authoritative phase progress must not be stale because a directory is old');
    local.writeStory(sid,{...metadata,phase:'DEV',createdAt:old.toISOString(),events:[{phase:'DEV',action:'advance',timestamp:old.toISOString()}]});
    utimesSync(wt,new Date(),new Date());
    const stale=projectQueueGovernance(store,root).rows.find(r=>r.storyId===sid);
    assert.equal(stale.classification,'stale-worktree','touching a directory must not invent Story progress');
    local.writeStory(sid,{...metadata,phase:'DEV'});
  });
  await group('validation-lock-identity',async()=>{
    child=fork(file,['--hold-lock',root,sid],{cwd:root,env,stdio:['ignore','pipe','pipe','ipc']});let stderr='';child.stderr.on('data',x=>stderr+=x);
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('SETUP_CHILD_READY_TIMEOUT '+stderr)),15000);
      child.once('message',()=>{clearTimeout(timer);resolve();});child.once('exit',code=>{clearTimeout(timer);reject(new Error('SETUP_CHILD_EXIT '+code+' '+stderr));});});
    try {
      const start=performance.now();const row=runtime({currentValidationStoryId:sid});observations.push({kind:'foreign-lock',ms:performance.now()-start,locks:row.locks});
      assert.equal(row.locks.validationLock,'active','a matching Story id is not proof of validation lock ownership');
    } finally {child.send({release:true});await new Promise(resolve=>child.once('exit',resolve));child=undefined;}
    await withValidationExecutionLock({root,storyId:sid,command:'self-control'},()=>{
      const row=runtime();assert.equal(row.locks.validationLock,'self-reentry','actual lock context must remain reentrant');
    });
    assert.equal(runtime().locks.validationLock,'free');
  });
  console.log(JSON.stringify({groups,observations,boundary:'Isolated real CLI, real linked worktree and validation lock process. Timings are fixture command/observation latency, not real Story delivery time.'},null,2));
  if(groups.some(g=>!g.pass)){console.error('COMMAND_OBSERVATION_RED');process.exitCode=1;}
  else console.log('COMMAND_OBSERVATION_GREEN');
} finally {
  if(child){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}
  process.chdir(oldCwd);rmSync(root,{recursive:true,force:true});
}
