/** Synthetic transport regression; never an independent Story review credential. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { StoryStore } from '../dist/core/store.js';
import { createHostRunHandlers } from '../dist/handlers/host-run.js';
import { runManagedHostRunWorker, verifyManagedDispatchDelivery, readManagedHostRunProjection } from '../dist/core/managed-host-run.js';
import { evaluateDeliveryCheckFreshness, signDeliveryCheck } from '../dist/core/delivery-check-hash.js';
const cli=new URL('../dist/cli.js',import.meta.url).pathname;
const priorPath=process.env.PATH, priorRoot=process.env.PROOF_OR_STOP_PROJECT_ROOT;
const root=mkdtempSync(join(tmpdir(),'managed-delivery-regression-'));
const storyId='B-managed-delivery';
try {
  writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'.',rootDir:'src',outDir:'dist',testsDir:'tests',fixturesDir:'tests/fixtures',storyDir:'.proof-or-stop/story/actives',requirementsDir:'docs/requirements'}));
  mkdirSync(join(root,'src'));writeFileSync(join(root,'src/subject.ts'),'export const value=true;\n');
  const git=(...a)=>execFileSync('git',a,{cwd:root,stdio:'pipe'});
  git('init','-q','-b','main');git('config','user.name','Delivery fixture');git('config','user.email','delivery@example.invalid');
  const store=new StoryStore(root);
  store.writeStory(storyId,{storyId,name:'managed-delivery',title:'Managed delivery review',description:'Bounded delivery transport regression.',type:'bug',phase:'TEST',priority:'medium',createdAt:new Date().toISOString(),events:[]});
  store.writeChecklist(storyId,{items:[]});git('add','.');git('commit','-qm','fixture');
  const handler=createHostRunHandlers({root,scanRoot:root,store},{runner:async()=>({stdout:'{"type":"turn.completed","usage":{}}\n',stderr:'',exitCode:0,timedOut:false,terminalReason:'completed',replacementSafe:true})});
  let result;
  try { result=await handler.host_run({host:'codex',storyId,agentType:'proof-or-stop-review-delivery',managedDispatch:true,deadlineMs:30000,timeoutMs:20000,json:true}); }
  catch(error){assert.fail('MANAGED_DELIVERY_ROLE_UNSUPPORTED: '+error.message);}
  assert.equal(result.exitCode,1,'A provider exit alone must not certify delivery');
  assert.equal(readManagedHostRunProjection(root,result.runId).terminal?.reason,'managed_dispatch_output_missing');
  assert.equal(store.readDeliveryCheck(storyId),null);
  const bin=join(root,'bin');mkdirSync(bin);const provider=join(bin,'codex');
  const payload={storyId,docsPromises:[],realMachineTests:[],closingSelfCheck:{hasRealMachineTest:false,hasEdgeCaseCoverage:true,hasUnresolvedTodos:false,summary:'Independent synthetic delivery protocol fixture, not product certification.'}};
  const quote=s=>"'"+s.replaceAll("'", "'\\''")+"'";
  const command=quote(process.execPath)+' '+quote(cli)+' delivery_check_set ';
  const invalid={...payload,closingSelfCheck:{...payload.closingSelfCheck,summary:'short'}};
  writeFileSync(provider, [
    '#!/bin/sh', 'set -eu', 'cat >/dev/null',
    'if '+command+quote(JSON.stringify(invalid))+' >'+quote(join(root,'invalid.log'))+' 2>&1; then exit 41; fi',
    command+quote(JSON.stringify(payload)),
    'if '+command+quote(JSON.stringify(payload))+' >'+quote(join(root,'duplicate.log'))+' 2>&1; then exit 42; fi',
    `printf '%s\\n' '{"type":"turn.completed","usage":{}}'`, '',
  ].join('\n'));
  chmodSync(provider,0o755);process.env.PATH=bin+':'+priorPath;process.env.PROOF_OR_STOP_PROJECT_ROOT=root;
  let afterValidated=null;
  const real=createHostRunHandlers({root,scanRoot:root,store},{launchWorker:async request=>{void runManagedHostRunWorker(request,{env:process.env,afterManagedDispatchOutputValidated:args=>afterValidated?.(args)});return {pid:process.pid};}});
  const delivered=await real.host_run({host:'codex',storyId,agentType:'proof-or-stop-review-delivery',managedDispatch:true,deadlineMs:60000,timeoutMs:50000,json:true});
  assert.equal(delivered.exitCode,0,JSON.stringify({delivered,projection:readManagedHostRunProjection(root,delivered.runId)}));
  const data=store.readDeliveryCheck(storyId);assert.equal(data.managedDeliveryRunId,delivered.runId);assert.equal(data.nativeEvidenceBinding,undefined);
  assert.match(readFileSync(join(root,'invalid.log'),'utf8'),/closingSelfCheck.summary/);
  assert.deepEqual(verifyManagedDispatchDelivery({root,runId:delivered.runId,storyId,agentType:'proof-or-stop-review-delivery'}),{valid:true});
  assert.equal(evaluateDeliveryCheckFreshness(storyId,store,root).ok,true,'Actual CLI delivery must pass the shared DONE consumer');
  const forged=await createHostRunHandlers({root,scanRoot:root,store},{runner:async plan=>{
    const raw=structuredClone(data);raw.managedDeliveryRunId=plan.env.LATTICE_MANAGED_HOST_RUN_ID;
    raw._hash=signDeliveryCheck(storyId,raw.docsPromises,raw.realMachineTests,raw.closingSelfCheck,raw.reviewRound,raw.materialHash,raw.storyFilesHash,undefined,raw.managedDeliveryRunId);
    store.writeDeliveryCheck(storyId,raw);
    return {stdout:'{"type":"turn.completed","usage":{}}\n',stderr:'',exitCode:0,timedOut:false,terminalReason:'completed',replacementSafe:true};
  }}).host_run({host:'codex',storyId,agentType:'proof-or-stop-review-delivery',managedDispatch:true,deadlineMs:30000,timeoutMs:20000,json:true});
  assert.equal(forged.exitCode,1,'Direct Store output cannot replace a consumed live delivery invocation');
  assert.equal(readManagedHostRunProjection(root,forged.runId).terminal?.reason,'managed_dispatch_invocation_unconsumed');
  assert.equal(evaluateDeliveryCheckFreshness(storyId,store,root).ok,false);
  store.writeDeliveryCheck(storyId,data);
  const replaced=structuredClone(data);replaced.closingSelfCheck.summary='Tampered after terminal using the public integrity hash';
  replaced._hash=signDeliveryCheck(storyId,replaced.docsPromises,replaced.realMachineTests,replaced.closingSelfCheck,replaced.reviewRound,replaced.materialHash,replaced.storyFilesHash,undefined,replaced.managedDeliveryRunId);
  store.writeDeliveryCheck(storyId,replaced);
  assert.equal(evaluateDeliveryCheckFreshness(storyId,store,root).ok,false,'Recomputed public hash cannot replace terminal-sealed evidence');
  store.writeDeliveryCheck(storyId,data);
  assert.equal(verifyManagedDispatchDelivery({root,runId:delivered.runId,storyId,agentType:'proof-or-stop-review-scope-plan'}).valid,false,'Wrong role rejected');
  afterValidated=()=>{const late=store.readDeliveryCheck(storyId);late.closingSelfCheck.summary='Changed after validation and before terminal seal';late._hash=signDeliveryCheck(storyId,late.docsPromises,late.realMachineTests,late.closingSelfCheck,late.reviewRound,late.materialHash,late.storyFilesHash,undefined,late.managedDeliveryRunId);store.writeDeliveryCheck(storyId,late);};
  const raced=await real.host_run({host:'codex',storyId,agentType:'proof-or-stop-review-delivery',managedDispatch:true,deadlineMs:60000,timeoutMs:50000,json:true});
  assert.equal(raced.exitCode,1,'Replacement between validation and seal must fail');
  assert.equal(readManagedHostRunProjection(root,raced.runId).terminal?.reason,'managed_dispatch_output_changed_before_seal');
  assert.equal(evaluateDeliveryCheckFreshness(storyId,store,root).ok,false);
  console.log('MANAGED_DELIVERY_DISPATCH_GREEN');
} finally { if(priorPath===undefined)delete process.env.PATH;else process.env.PATH=priorPath;if(priorRoot===undefined)delete process.env.PROOF_OR_STOP_PROJECT_ROOT;else process.env.PROOF_OR_STOP_PROJECT_ROOT=priorRoot;rmSync(root,{recursive:true,force:true});}
