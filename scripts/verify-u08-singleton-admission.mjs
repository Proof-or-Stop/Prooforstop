import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {withSignedReviewerBatchFixture} from './lab/u08-batch-admission/subject-fixture.mjs';
import {base,delta} from './verify-acceptance-amendment-delta.mjs';
const repo=fs.realpathSync(process.argv[2]||process.cwd()),temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'u08-singleton-admission-')));
const load=name=>import(pathToFileURL(path.join(repo,'packages/main/dist',name)));
const {createAcceptanceAmendmentController}=await load('core/acceptance-amendment-journal.js');
const {createCrossHostReviewHandlers}=await load('handlers/cross-host-review.js');
const {resetConfigCache}=await load('core/config.js');
const originalEnvironment={...process.env};
const binary=path.join(temp,'codex');execFileSync('cc',[fileURLToPath(new URL('./lab/u08-batch-admission/provider-fixture.c',import.meta.url)),'-o',binary]);
const gitPath=execFileSync('/usr/bin/which',['git'],{encoding:'utf8'}).trim();
const scratchLog=path.join(temp,'scratch.log'),probeLog=path.join(temp,'probe.log'),auth=path.join(temp,'auth');fs.mkdirSync(auth);fs.writeFileSync(path.join(auth,'auth.json'),JSON.stringify({OPENAI_API_KEY:'fixture-only'}));
fs.writeFileSync(path.join(temp,'git'),'#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = add ]; then echo scratch >> "$U08_FIXTURE_SCRATCH_LOG"; fi\nexec '+JSON.stringify(gitPath)+' "$@"\n',{mode:0o700});
async function configure(root,git){const cfg=JSON.parse(fs.readFileSync(path.join(root,'proof-or-stop.config.json')));Object.assign(cfg,{outDir:'packages/main/dist',managedReviewIsolation:{mode:'readonly-build',adapter:'prooforstop-main-v1'}});fs.writeFileSync(path.join(root,'proof-or-stop.config.json'),JSON.stringify(cfg));fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'proof-or-stop'}));fs.writeFileSync(path.join(root,'packages/main/package.json'),JSON.stringify({name:'@proof-or-stop/core'}));git('add','proof-or-stop.config.json','package.json','packages/main/package.json');git('commit','-qm','readonly adapter');resetConfigCache();}
const count=file=>fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean):[];
try {
 Object.assign(process.env,{PATH:temp+path.delimiter+originalEnvironment.PATH,CODEX_HOME:auth,U08_FIXTURE_MODE:'auth',U08_FIXTURE_PROBE_LOG:probeLog,U08_FIXTURE_SCRATCH_LOG:scratchLog});
 await withSignedReviewerBatchFixture(repo,async({root,store,storyId,git})=>{
  await configure(root,git);store.writeStory(storyId,{...store.readStory(storyId),phase:'DEV'});store.writeChecklist(storyId,base.checklist);store.writeScopeContract(storyId,{...base.scope,storyId});store.writeProofStoryContract(storyId,{...base.proofStory,storyId});git('add','.proof-or-stop/story');git('commit','-qm','acceptance fixture');
  const controller=createAcceptanceAmendmentController(store,root);controller.propose({storyId,amendmentId:'AM-auth',delta,submitterSessionId:'fixture-owner'});
  let scratchCalls=0,workers=0;for(let attempt=0;attempt<2;attempt++){await assert.rejects(controller.startReview({storyId,amendmentId:'AM-auth',host:'codex'},{managedReviewScratchParentFactory:()=>{scratchCalls++;throw Error('unexpected scratch');},launchWorker:()=>{workers++;throw Error('unexpected worker');}}),/admission|scratch/i);}
  assert.equal(scratchCalls,0,'U08_ACCEPTANCE_AUTH_FAILURE_BEFORE_SCRATCH');assert.equal(workers,0);assert.equal(count(probeLog).filter(x=>x==='probe').length,1,'same failed acceptance batch must probe once');assert.equal(store.readAcceptanceAmendments(storyId).entries[0].state,'PROPOSED');assert.equal(store.readAcceptanceAmendments(storyId).entries[0].review,undefined,'no reviewer key pinned on failed admission');
 });
 fs.rmSync(probeLog,{force:true});fs.rmSync(scratchLog,{force:true});
 await withSignedReviewerBatchFixture(repo,async({root,store,storyId,git})=>{
  await configure(root,git);git('add','.proof-or-stop/story');git('commit','-qm','crosshost fixture');
  const policy={schemaVersion:'lattice.dispatch_policy.v1',policy:'fixture-review-only',allowedHosts:['codex'],allowedPaths:['packages/main/src/'],deniedPaths:[],maxParallel:1,maxRuntimeMinutes:1,maxBudgetUSD:1,network:'none',envAllowlist:[],envDenylist:[],commandAllowlist:['codex exec -s read-only'],retryLimit:0,requireReceipt:true,requireReview:true,allowRealHostSubprocess:false,allowReviewOnlyRealHostSubprocess:true,allowAutoMerge:false,allowProductionDone:false,createdAt:'2026-09-10T00:00:00.000Z'};
  let workers=0;const handler=createCrossHostReviewHandlers({root,store,scanRoot:path.join(root,'packages/main')},{launchWorker:()=>{workers++;throw Error('unexpected worker');}});
  for(let attempt=0;attempt<2;attempt++)await assert.rejects(handler.cross_host_review({storyId,policy,json:true}),/admission/i);
  assert.equal(count(scratchLog).length,0,'U08_CROSSHOST_AUTH_FAILURE_BEFORE_SNAPSHOT');assert.equal(workers,0);assert.equal(count(probeLog).filter(x=>x==='probe').length,1,'same failed crosshost batch must probe once');
 });
 console.log('U08_SINGLETON_AUTH_BLOCKED_ONE_PROBE_ZERO_SCRATCH_ZERO_WORKER_NO_KEY_PIN_PASS');
} finally {for(const key of Object.keys(process.env))if(!(key in originalEnvironment))delete process.env[key];Object.assign(process.env,originalEnvironment);fs.rmSync(temp,{recursive:true,force:true});}
