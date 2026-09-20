import './lab-source-loader.mjs';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
registerHooks({load(url,ctx,next){if(url.endsWith('.ts'))return{format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText};return next(url,ctx);}});
const { runHostRun } = await import('../packages/main/src/core/host-run.ts');
const { isMaterialExcludedRuntimeArtifactPath } = await import('../packages/main/src/core/runtime-artifact-registry.ts');
assert.equal(isMaterialExcludedRuntimeArtifactPath('.proof-or-stop/runtime/host-run-budgets/example.json'), true);
const env = {PROOF_OR_STOP_RUN_BUDGET_ID:'adversarial',PROOF_OR_STOP_RUN_BUDGET_MAX_CALLS:'1',PROOF_OR_STOP_USAGE_LEDGER:'0'};
async function run(root,extra={}, crash=false) {
 let launches=0;let error=null;
 try {await runHostRun({root,cwd:root,host:'codex',storyId:null,agentType:'lab',promptText:'critical task',recordedAt:new Date().toISOString(),projectRootHash:'sha256:lab',env:{...env,...extra}},
 {runner:async()=>{launches++;if(crash)process.exit(17);return{stdout:'',stderr:'',exitCode:0,timedOut:false};}});}catch(e){error=e.message;}
 return{launches,error};
}
if(process.argv[2]==='--crash') {await run(process.argv[3],{},true);} else {
 const root=mkdtempSync(join(tmpdir(),'budget-adversarial-'));
 const measurements={};
 try {
  const crash=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--crash',root],{encoding:'utf8',timeout:10000});assert.equal(crash.status,17);
  const retry=await run(root);assert.equal(retry.launches,0);assert.match(retry.error,/reservations exhausted/);
  measurements.crashedReservationRestartCalls=retry.launches;
  const dir=join(root,'.proof-or-stop/runtime/host-run-budgets');
  const file=join(dir,readdirSync(dir).find(n=>n.endsWith('.json')));
  const rows=JSON.parse(readFileSync(file,'utf8')).rows;assert.equal(rows[0].state,'reserved');assert.equal(rows[0].input,null);
  writeFileSync(file,'corrupt');assert.equal((await run(root)).launches,0);measurements.corruptStateCalls=0;
  const other=join(root,'project');
  execFileSync('git',['init','-q',other]);
  execFileSync('git',['-C',other,'-c','user.name=Lab Fixture','-c','user.email=lab@example.invalid','commit','--allow-empty','-qm','test fixture']);
  const linked=join(root,'linked');execFileSync('git',['-C',other,'worktree','add','--detach',linked],{stdio:'pipe'});
  const first=await run(other);const second=await run(linked);
  assert.equal(first.launches,1);assert.equal(second.launches,0);measurements.crossWorktreeCalls=first.launches+second.launches;
  const fresh={PROOF_OR_STOP_RUN_BUDGET_ID:'ledger-disabled'};
  assert.equal((await run(other,fresh)).launches,1);assert.equal((await run(other,fresh)).launches,0);measurements.ledgerDisabledCalls=1;
  const malformed=await run(other,{PROOF_OR_STOP_RUN_BUDGET_ID:'malformed',PROOF_OR_STOP_RUN_BUDGET_MAX_CALLS:'NaN'});assert.equal(malformed.launches,0);measurements.invalidPolicyCalls=0;
  console.log('ADVERSARIAL_MEASUREMENTS '+JSON.stringify(measurements));
 }finally{rmSync(root,{recursive:true,force:true});}
}
