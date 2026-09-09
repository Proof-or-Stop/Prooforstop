import {createHostRunHandlers} from '../packages/main/dist/handlers/host-run.js';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { submitManagedHostRun, runManagedHostRunWorker, getManagedHostRunStatus } from '../packages/main/dist/core/managed-host-run.js';

const root=mkdtempSync(join(tmpdir(),'managed-historical-eta-'));
const workers=[];
const base={root,cwd:root,host:'codex',storyId:'B-eta',phase:'REVIEW',agentType:'lattice-review-quality',
  promptText:'Bounded historical duration fixture',deadlineMs:120000,projectRootHash:'sha256:eta-fixture'};
async function completed(duration, overrides={}) {
  let now=Date.now()-60000;
  const run=await submitManagedHostRun({...base,...overrides},{now:()=>now,
    launchWorker:request=>{
      const worker=runManagedHostRunWorker(request,{now:()=>now,env:{PROOF_OR_STOP_USAGE_LEDGER:'0'},
        runner:async()=>{now+=duration;return {stdout:'',stderr:'',exitCode:0,timedOut:false,terminalReason:'completed'};}});
      workers.push(worker); return {pid:process.pid};
    },claimTimeoutMs:1000,claimPollMs:5});
  await workers.at(-1); return run;
}
try {
  const first=await completed(1000);
  assert.equal(first.durationEstimate?.kind,'unavailable',
    'U13 must distinguish insufficient historical ETA from the hard deadline');
  for(const duration of [2000,3000,4000,5000]) await completed(duration);
  for(const overrides of [{agentType:'unrelated-agent'},{phase:'DEV'},{host:'claude'},
    {profile:'unrelated-profile'},{lane:'unrelated-lane'}]) await completed(8000,overrides);
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const current=await submitManagedHostRun(base,{launchWorker:request=>{
    workers.push(runManagedHostRunWorker(request,{heartbeatMs:10,env:{PROOF_OR_STOP_USAGE_LEDGER:'0'},
      runner:async()=>{await gate;return {stdout:'',stderr:'',exitCode:0,timedOut:false,terminalReason:'completed'};}}));
    return {pid:process.pid};
  },claimTimeoutMs:1000,claimPollMs:5});
  try {
    assert.equal(current.durationEstimate.kind,'historical_estimate');
    assert.equal(current.durationEstimate.sampleCount,5,'unrelated agent history cannot alter ETA');
    assert.equal(current.durationEstimate.medianDurationMs,3000);
    assert.equal(current.durationEstimate.p90DurationMs,5000);
    assert.equal(current.durationEstimate.source,'bounded-local-completed-runs');
    assert.notEqual(current.durationEstimate.estimatedTerminalAt,current.deadlineAt,'a deadline is not a historical estimate');
    const text=await createHostRunHandlers({root}).host_run_status({runId:current.runId,json:false});
    assert.match(text,/eta=historical_estimate:/,'text consumers see an explicitly labelled estimate');
    assert.match(text,/historicalP50Ms=3000/);
    assert.ok(text.includes(`deadlineAt=${current.deadlineAt}`));
    let historyReads=0; const originalOpen=fs.opendirSync;
    fs.opendirSync=(...args)=>{historyReads++;return originalOpen(...args);}; syncBuiltinESMExports();
    let status;
    try {status=await getManagedHostRunStatus({root,runId:current.runId,afterGeneration:current.generation,waitMs:100});}
    finally {fs.opendirSync=originalOpen;syncBuiltinESMExports();}
    assert.equal(historyReads,0,'status polling performs no directory history scan');
    assert.equal(status.changed,false,'heartbeats and elapsed ETA do not create fake provider progress');
    assert.equal(status.run.lastProviderProgressAt,null);
    assert.deepEqual(status.run.durationEstimate,current.durationEstimate,'history is sampled once, not rescanned on every status read');
  } finally {release();await workers.at(-1);}
  const sampleIds=current.durationEstimate.sampleRunIds;
  for(const runId of sampleIds.slice(0,2)) {
    const path=join(root,'.proof-or-stop/runtime/host-runs',runId,'result.json');
    // Only this isolated fixture is mutated; the sealed production reader must reject drift.
    writeFileSync(path,readFileSync(path,'utf8')+'tampered');
  }
  const afterTamper=await completed(2000);
  assert.equal(afterTamper.durationEstimate.kind,'unavailable','corrupt historical bindings cannot populate ETA');
  const originalOpen=fs.opendirSync;
  fs.opendirSync=(...args)=>{const directory=originalOpen(...args);const close=directory.closeSync.bind(directory);directory.closeSync=()=>{close();throw new Error('injected optional history close failure');};return directory;};
  syncBuiltinESMExports();
  try {await assert.doesNotReject(()=>completed(2000),'optional history close failure cannot reject run submission');}
  finally {fs.opendirSync=originalOpen;syncBuiltinESMExports();}
  console.log('PASS U13 historical ETA is scoped, sampled once and separate from deadlines and progress');
} finally {await Promise.allSettled(workers);rmSync(root,{recursive:true,force:true});}
