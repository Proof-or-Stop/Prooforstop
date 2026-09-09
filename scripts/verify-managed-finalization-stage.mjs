import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultHostRunRunner } from '../packages/main/dist/core/host-run.js';
import { getManagedHostRunStatus, runManagedHostRunSupervisor, runManagedHostRunWorker,
  submitManagedHostRun, waitManagedHostRuns } from '../packages/main/dist/core/managed-host-run.js';

const root=mkdtempSync(join(tmpdir(),'managed-finalization-stage-'));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let release, worker, supervisor;
try {
  const gate=new Promise(resolve=>{release=resolve;});
  const run=await submitManagedHostRun({root,cwd:root,host:'codex',phase:'DEV',agentType:'finalization-witness',
    promptText:'A closed child may still be finalizing its result.',timeoutMs:60000,deadlineMs:60000}, {
    launchWorker:async request=>{
      supervisor=runManagedHostRunSupervisor(request);
      worker=runManagedHostRunWorker(request,{heartbeatMs:100,
        runner:async plan=>{
          const result=await defaultHostRunRunner({...plan,command:process.execPath,
            argv:['-e','setTimeout(()=>process.exit(0),200)'],stdinText:''});
          await gate;
          return result;
        }});
      return {pid:process.pid};
    },
  });
  const until=Date.now()+5000;
  let closed;
  do {
    closed=await getManagedHostRunStatus({root,runId:run.runId});
    if(closed.run.stage.name==='finalizing_result') break;
    await delay(25);
  } while(Date.now()<until);
  assert.deepEqual(closed.run.stage,{number:4,total:5,name:'finalizing_result'});
  assert.ok(Number.isFinite(Date.parse(closed.run.providerClosedAt)));
  assert.equal(closed.run.lastProviderProgressAt,null,'a real silent close is not provider output');
  const early=await waitManagedHostRuns({root,targets:[{runId:run.runId,afterGeneration:closed.run.generation}],waitMs:6500});
  assert.equal(early.changed,false,'heartbeats and known provider close must not create missing-provider wakeups');
  assert.equal(early.runs[0].run.supervisionDiagnostic,null);
  const stalled=await waitManagedHostRuns({root,targets:[{runId:run.runId,afterGeneration:closed.run.generation}],waitMs:30000});
  assert.equal(stalled.changed,true,'stalled real result finalization must wake without fabricated progress');
  assert.equal(stalled.runs[0].run.supervisionDiagnostic.code,'result_finalization_stalled');
  assert.equal(stalled.runs[0].run.stage.name,'finalizing_result');
  assert.equal(stalled.runs[0].run.lastProviderProgressAt,null);
  release(); await worker; await supervisor;
  const terminal=await getManagedHostRunStatus({root,runId:run.runId,afterGeneration:stalled.runs[0].run.generation});
  assert.equal(terminal.run.state,'completed');
  assert.equal(terminal.run.stage.name,'terminal');
  assert.equal(terminal.run.supervisionDiagnostic,null);
  console.log('PASS U02/U13 real silent close, heartbeat isolation, bounded finalization diagnostic and terminal wakeup');
} finally {
  release?.();
  await worker;
  await supervisor;
  rmSync(root,{recursive:true,force:true});
}
