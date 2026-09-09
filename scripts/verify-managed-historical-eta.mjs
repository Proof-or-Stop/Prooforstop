import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
  for(let i=0;i<5;i++) await completed(90000,{agentType:'unrelated-agent'});
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
    const status=await getManagedHostRunStatus({root,runId:current.runId,afterGeneration:current.generation,waitMs:100});
    assert.equal(status.changed,false,'heartbeats and elapsed ETA do not create fake provider progress');
    assert.equal(status.run.lastProviderProgressAt,null);
    assert.deepEqual(status.run.durationEstimate,current.durationEstimate,'history is sampled once, not rescanned on every status read');
  } finally {release();await workers.at(-1);}
  console.log('PASS U13 historical ETA is scoped, sampled once and separate from deadlines and progress');
} finally {await Promise.allSettled(workers);rmSync(root,{recursive:true,force:true});}
