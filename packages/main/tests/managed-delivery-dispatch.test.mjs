/** Synthetic transport regression; never an independent Story review credential. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { StoryStore } from '../dist/core/store.js';
import { createHostRunHandlers } from '../dist/handlers/host-run.js';
import { createDeliveryCheckHandlers } from '../dist/handlers/delivery-check.js';
import { runManagedHostRunWorker, verifyManagedDispatchDelivery, readManagedHostRunProjection, managedHostRunReceipt, managedDispatchOutputValidation } from '../dist/core/managed-host-run.js';
import { evaluateDeliveryCheckFreshness, signDeliveryCheck } from '../dist/core/delivery-check-hash.js';
import { isValidationTransportEnvKey } from '../dist/core/validation-command-environment.js';
import { resetSessionIdForTest } from '../dist/core/owner-session.js';
const cli=new URL('../dist/cli.js',import.meta.url).pathname;
const priorPath=process.env.PATH, priorRoot=process.env.PROOF_OR_STOP_PROJECT_ROOT;
const root=mkdtempSync(join(tmpdir(),'managed-delivery-regression-'));
const storyId='B-managed-delivery';
// The fixture must work in the same host-neutral environment as official validation.
const transportKeys = new Set([...Object.keys(process.env).filter(key => isValidationTransportEnvKey(key)),
  'PROOF_OR_STOP_SESSION_ID', 'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER']);
const priorTransport = new Map([...transportKeys].map(key => [key, process.env[key]]));
try {
  for (const key of transportKeys) delete process.env[key];
  // Synthetic owner for this temporary project and fake provider only.
  process.env.PROOF_OR_STOP_SESSION_ID = `managed-delivery-fixture-${process.pid}`;
  process.env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER = 'codex';
  resetSessionIdForTest();

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
  const originalStory=store.readStory(storyId);
  store.writeStory(storyId,{...originalStory,phase:'DEV'});
  await assert.rejects(()=>handler.host_run({host:'codex',storyId,agentType:'proof-or-stop-review-delivery',managedDispatch:true}),/TEST/);
  assert.equal(store.readDeliveryCheck(storyId),null);
  store.writeStory(storyId,originalStory);
  const bin=join(root,'bin');mkdirSync(bin);const provider=join(bin,'codex');
  const payload={storyId,docsPromises:[],realMachineTests:[],closingSelfCheck:{hasRealMachineTest:false,hasEdgeCaseCoverage:true,hasUnresolvedTodos:false,summary:'Independent synthetic delivery protocol fixture, not product certification.'}};
  // These isolated negative inputs cannot mint credentials: they must refuse
  // before dispatch verification, invocation consumption or any artifact write.
  const envKeys=['PROOF_OR_STOP_AGENT','LATTICE_MANAGED_INIT_INVOCATION'];
  const savedEnv=envKeys.map(key=>process.env[key]);
  try {
    const writer=createDeliveryCheckHandlers({root,scanRoot:root,store});
    process.env.LATTICE_MANAGED_INIT_INVOCATION='invalid-synthetic-negative-input';
    process.env.PROOF_OR_STOP_AGENT='proof-or-stop-review-delivery';
    store.writeStory(storyId,{...originalStory,phase:'DEV'});
    assert.throws(()=>writer.delivery_check_set(payload),/independent delivery role in TEST/);
    store.writeStory(storyId,originalStory);
    process.env.PROOF_OR_STOP_AGENT='proof-or-stop-review-scope-plan';
    assert.throws(()=>writer.delivery_check_set(payload),/not allowed|cannot|refused/);
    assert.equal(store.readDeliveryCheck(storyId),null);
  } finally {
    envKeys.forEach((key,i)=>{if(savedEnv[i]===undefined)delete process.env[key];else process.env[key]=savedEnv[i];});
    store.writeStory(storyId,originalStory);
  }
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
  const sealedBytes=readFileSync(store.storyFilePath(storyId,'delivery-check.json'));
  assert.throws(()=>createDeliveryCheckHandlers({root,scanRoot:root,store}).delivery_waiver_add({storyId,promiseId:'synthetic',waiverReason:'A long synthetic waiver must not mutate terminal-sealed evidence.'}),/terminal-sealed.*fresh host_run/);
  assert.deepEqual(readFileSync(store.storyFilePath(storyId,'delivery-check.json')),sealedBytes);
  assert.equal(evaluateDeliveryCheckFreshness(storyId,store,root).ok,true);
  const receiptBefore=managedHostRunReceipt(root,delivered.runId);
  const mixed=structuredClone(data);mixed.nativeEvidenceBinding={syntheticNegative:true};
  mixed._hash=signDeliveryCheck(storyId,mixed.docsPromises,mixed.realMachineTests,mixed.closingSelfCheck,mixed.reviewRound,mixed.materialHash,mixed.storyFilesHash,mixed.nativeEvidenceBinding,mixed.managedDeliveryRunId);
  store.writeDeliveryCheck(storyId,mixed);
  assert.equal(evaluateDeliveryCheckFreshness(storyId,store,root).ok,false,'Mixed native and managed provenance is rejected');
  assert.equal(managedDispatchOutputValidation({root,storyId,agentType:'proof-or-stop-review-delivery',runId:delivered.runId}).failureReason,'managed_dispatch_output_invalid');
  assert.deepEqual(managedHostRunReceipt(root,delivered.runId),receiptBefore,'Live file replacement does not corrupt historical run receipts');
  store.writeDeliveryCheck(storyId,data);
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
  assert.deepEqual(managedHostRunReceipt(root,delivered.runId),receiptBefore);
  store.writeDeliveryCheck(storyId,data);
  assert.equal(verifyManagedDispatchDelivery({root,runId:delivered.runId,storyId,agentType:'proof-or-stop-review-scope-plan'}).valid,false,'Wrong role rejected');
  const fresh=await real.host_run({host:'codex',storyId,agentType:'proof-or-stop-review-delivery',managedDispatch:true,deadlineMs:60000,timeoutMs:50000,json:true});
  assert.equal(fresh.exitCode,0);
  assert.equal(evaluateDeliveryCheckFreshness(storyId,store,root).ok,true);
  assert.deepEqual(managedHostRunReceipt(root,delivered.runId),receiptBefore,'A real later review preserves the old receipt');
  assert.equal(verifyManagedDispatchDelivery({root,runId:delivered.runId,storyId,agentType:'proof-or-stop-review-delivery'}).valid,false,'Old receipt cannot authorize the new report');
  afterValidated=()=>{const late=store.readDeliveryCheck(storyId);late.closingSelfCheck.summary='Changed after validation and before terminal seal';late._hash=signDeliveryCheck(storyId,late.docsPromises,late.realMachineTests,late.closingSelfCheck,late.reviewRound,late.materialHash,late.storyFilesHash,undefined,late.managedDeliveryRunId);store.writeDeliveryCheck(storyId,late);};
  const raced=await real.host_run({host:'codex',storyId,agentType:'proof-or-stop-review-delivery',managedDispatch:true,deadlineMs:60000,timeoutMs:50000,json:true});
  assert.equal(raced.exitCode,1,'Replacement between validation and seal must fail');
  assert.equal(readManagedHostRunProjection(root,raced.runId).terminal?.reason,'managed_dispatch_output_changed_before_seal');
  assert.equal(evaluateDeliveryCheckFreshness(storyId,store,root).ok,false);
  console.log('MANAGED_DELIVERY_DISPATCH_GREEN');
} finally {
  try {
    if(priorPath===undefined)delete process.env.PATH;else process.env.PATH=priorPath;
    if(priorRoot===undefined)delete process.env.PROOF_OR_STOP_PROJECT_ROOT;else process.env.PROOF_OR_STOP_PROJECT_ROOT=priorRoot;
    rmSync(root,{recursive:true,force:true});
  } finally {
    for(const [key,value] of priorTransport){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    resetSessionIdForTest();
  }
}
