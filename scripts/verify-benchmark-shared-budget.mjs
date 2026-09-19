// Actual checkout source; only the final paid-provider transport is intercepted.
import './lab-source-loader.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
registerHooks({ load(url, context, next) {
  if (url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
    source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText };
  return next(url, context);
} });
const { runHostRun } = await import('../packages/main/src/core/host-run.ts');
const { resolveLedgerPath, verifyLedgerChain } = await import('../packages/main/src/core/usage-ledger/writer.ts');
const { spawn } = await import('node:child_process');
const { fileURLToPath } = await import('node:url');
const prefix = 'PROOF_OR_STOP_RUN_BUDGET_';
const envFor = (id, cap, extra = {}) => ({ [prefix+'ID']: id, [prefix+'MAX_CALLS']: String(cap), ...extra });
async function call(root, env, prompt = 'bounded prompt', fail = false) {
  let launches = 0, promptBytes = 0;
  try {
    const result = await runHostRun({root, cwd: root, host:'codex', storyId:null, agentType:'lab-budget',
      promptText:prompt, recordedAt:new Date().toISOString(), projectRootHash:'sha256:lab', env}, {
      runner:async plan => { launches++; promptBytes=Buffer.byteLength(plan.stdinText ?? prompt);
        if(fail) throw new Error('fixture transport failure');
        return {stdout:JSON.stringify({type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:4,output_tokens:2}})+'\n',stderr:'',exitCode:0,timedOut:false,durationMs:1}; }
    });
    return { launches, promptBytes, blocked:result.blocked, error:null };
  } catch(error) { return { launches, promptBytes, blocked:true, error:error.message }; }
}
if(process.argv[2]==='--child') {
  console.log(JSON.stringify(await call(process.argv[3],envFor('concurrent',2))));
} else {
 const root=mkdtempSync(join(tmpdir(),'benchmark-shared-budget-'));
 const measurements={};
 try {
  const seq=[];for(let i=0;i<5;i++)seq.push(await call(root,envFor('sequential',2)));
  measurements.sequentialCalls=seq.reduce((n,r)=>n+r.launches,0);
  const runChild=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--child',root],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(stdout)):reject(Error(stderr)));});
  const children=await Promise.all(Array.from({length:4},runChild));
  measurements.concurrentProcessCalls=children.reduce((n,r)=>n+r.launches,0);
  measurements.restartExtraCalls=(await runChild()).launches;
  const partition=[];for(const category of ['repair','repair','product','product','product'])partition.push(await call(root,envFor('partition',4,{[prefix+'MAX_REPAIR_CALLS']:'1',[prefix+'CATEGORY']:category})));
  measurements.partitionCalls=partition.map(r=>r.launches);
  measurements.policyChangeExtraCalls=(await call(root,envFor('sequential',20))).launches;
  const small=await call(root,envFor('context',3,{[prefix+'MAX_PROMPT_BYTES']:'100'}),'critical task data');
  const large=await call(root,envFor('context',3,{[prefix+'MAX_PROMPT_BYTES']:'100'}),'history '.repeat(1000));
  measurements.prompt={smallCalls:small.launches,smallBytes:small.promptBytes,oversizeCalls:large.launches};
  const failed=await call(root,envFor('failure',1),'bounded prompt',true);
  measurements.failedAttempt={calls:failed.launches,retryCalls:(await call(root,envFor('failure',1))).launches};
  const failureRoot=mkdtempSync(join(tmpdir(),'benchmark-failure-ledger-'));
  try{await call(failureRoot,{},'bounded prompt',true);const rows=verifyLedgerChain(resolveLedgerPath(failureRoot));
    measurements.exceptionLedger={rows:rows.length,unavailable:rows.filter(r=>r.usage.source==='unavailable').length};
  }finally{rmSync(failureRoot,{recursive:true,force:true});}
  console.log('SHARED_MEASUREMENTS '+JSON.stringify(measurements));
  assert.equal(measurements.sequentialCalls,2,'SHARED_BUDGET_RED: separate host requests must share a durable ceiling');
  assert.equal(measurements.concurrentProcessCalls,2);assert.equal(measurements.restartExtraCalls,0);
  assert.deepEqual(measurements.partitionCalls,[1,0,1,1,1]);assert.equal(measurements.policyChangeExtraCalls,0);
  assert.equal(measurements.prompt.smallCalls,1);assert.equal(measurements.prompt.oversizeCalls,0);
  assert.equal(measurements.failedAttempt.calls,1);assert.equal(measurements.failedAttempt.retryCalls,0);
  assert.equal(measurements.exceptionLedger.rows,2);assert.equal(measurements.exceptionLedger.unavailable,1);
  console.log('SHARED_BUDGET_GREEN actual host entry; paid model calls=0');
 }finally{rmSync(root,{recursive:true,force:true});}
}
