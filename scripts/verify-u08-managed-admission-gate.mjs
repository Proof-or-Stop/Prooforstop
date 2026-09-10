import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {withSignedReviewerBatchFixture} from './lab/u08-batch-admission/subject-fixture.mjs';
const repo=fs.realpathSync(process.argv[2]||process.cwd());
const load=name=>import(pathToFileURL(path.join(repo,'packages/main/dist',name)));
const {submitManagedHostRun}=await load('core/managed-host-run.js');
const {captureReviewRunSnapshot}=await load('core/review-run.js');
const {resetConfigCache}=await load('core/config.js');
await withSignedReviewerBatchFixture(repo,async({root,store,storyId,begin,git})=>{
 const cfg=JSON.parse(fs.readFileSync(path.join(root,'proof-or-stop.config.json')));
 Object.assign(cfg,{outDir:'packages/main/dist',managedReviewIsolation:{mode:'readonly-build',adapter:'prooforstop-main-v1'}});
 fs.writeFileSync(path.join(root,'proof-or-stop.config.json'),JSON.stringify(cfg));
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'proof-or-stop'}));
 fs.writeFileSync(path.join(root,'packages/main/package.json'),JSON.stringify({name:'@proof-or-stop/core'}));
 git('add','proof-or-stop.config.json','package.json','packages/main/package.json');git('commit','-qm','registered readonly adapter');resetConfigCache();begin();
 const bin=path.join(root,'private-bin'),auth=path.join(root,'private-auth');fs.mkdirSync(bin);fs.mkdirSync(auth);
 fs.symlinkSync('/bin/echo',path.join(bin,'codex'));fs.writeFileSync(path.join(auth,'auth.json'),JSON.stringify({OPENAI_API_KEY:'fixture-only'}));
 const story=store.readStory(storyId),snapshot=captureReviewRunSnapshot(root,{storyId,storyPhase:story.phase,currentReviewRound:story.currentReviewRound},root);
 const lane='proof-or-stop-review-quality';let scratches=0,workers=0,refusal;
 try{await submitManagedHostRun({root,cwd:root,host:'codex',storyId,phase:'REVIEW',agentType:lane,lane,reviewRunId:storyId+':missing-admission',promptText:'Review exact fixture',projectRootHash:'fixture',profile:'managed_reviewer',isolateManagedReview:true,
 environment:{...process.env,PATH:bin+path.delimiter+process.env.PATH,CODEX_HOME:auth},
 reviewBinding:{headHash:git('rev-parse','HEAD').toString().trim(),materialHash:snapshot.materialHash,storyFilesHash:snapshot.storyFilesHash,promptHash:'fixture',managedPromptDigest:'sha256:'+'a'.repeat(64),envelopeId:null}},
 {managedReviewScratchParentFactory:()=>{scratches++;throw new Error('heavy scratch requested before admission');},launchWorker:()=>{workers++;throw new Error('worker requested before admission');}});}catch(error){refusal=error;}
 assert.equal(scratches,0,'U08_MANAGED_ADMISSION_REQUIRED_BEFORE_SCRATCH');assert.equal(workers,0);assert.match(String(refusal),/admission|reviewer_batch_admit/i);
 console.log('U08_MANAGED_MISSING_ADMISSION_ZERO_SCRATCH_ZERO_WORKER_PASS');
});
await import('./verify-u08-singleton-admission.mjs');
await import('./verify-u08-batch-producer.mjs');
await import('./verify-u08-batch-retry.mjs');
await import('./verify-u08-batch-auth-revocation.mjs');
await import('./verify-u08-batch-launch-race.mjs');
await import('./verify-u08-batch-cli.mjs');
await import('./verify-u08-admitted-worker.mjs');
