import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
const source=resolve(import.meta.dirname,'../..'),runtime=process.env.CHECKPOINT_TEST_RUNTIME??source;
const {executeValidationPlan}=await import(runtime+'/packages/main/dist/core/validation-executor.js');
const cfg=JSON.parse(readFileSync(join(source,'proof-or-stop.config.json'),'utf8'));
assert.deepEqual(cfg.validate.commands.slice(0,3).map(c=>[c.command,...c.args]),[['node','scripts/verify-lab-worktree.mjs'],['npm','--prefix','packages/main','run','build'],['node','packages/main/tests/milestone-status.test.mjs']]);
const barrier=r=>r.class==='fixed-path'&&r.key==='.proof-or-stop/runtime/validate-plan-barrier'&&r.access==='exclusive';
const results=[];
for(const scenario of ['stale','missing','failed-build','removed-build-barrier'])for(const mode of ['RED','GREEN']){
 const fixture=mkdtempSync(join(tmpdir(),'pos-build-order-'));
 try{
  execFileSync('git',['init','-q'],{cwd:fixture});writeFileSync(join(fixture,'.gitignore'),'build.txt\n');if(scenario!=='missing')writeFileSync(join(fixture,'build.txt'),'stale');
  const scripts=[`setTimeout(()=>console.log('PRECHECK_DONE'),150)`,scenario==='failed-build'?`console.error('BUILD_REFUSED');process.exit(3)`:`setTimeout(()=>{require('fs').writeFileSync('build.txt','fresh');console.log('BUILD_DONE')},100)`,`require('assert').strictEqual(require('fs').readFileSync('build.txt','utf8'),'fresh','test must consume completed build');console.log('CURRENT_BUILD_TEST_PASS')`];
  const commands=cfg.validate.commands.slice(0,3).map((c,i)=>({label:'actual-resource-row-'+i,command:process.execPath,args:['-e',scripts[i]],timeoutMs:3000,resources:structuredClone(c.resources)}));
  if(mode==='RED')commands[0].resources=commands[0].resources.filter(r=>!barrier(r));
  if(scenario==='removed-build-barrier')commands[1].resources=commands[1].resources.filter(r=>!barrier(r));
  const events=[];const result=await executeValidationPlan({provider:'lab-build-order-control',commands},fixture,undefined,undefined,{jobs:4,progress:e=>events.push(e)});
  results.push({scenario,mode,allPass:result.allPass,commands:result.commands,events});console.log(scenario,mode,result.allPass,result.commands.map(c=>c.code));
 }finally{rmSync(fixture,{recursive:true,force:true});}
}
const out=process.env.FIVE_ITEM_PROOF_OUTPUT;if(out){mkdirSync(out,{recursive:true});writeFileSync(join(out,'build-order.json'),JSON.stringify(results,null,2)+'\n');}
for(const row of results){const expected=row.mode==='GREEN'&&['stale','missing'].includes(row.scenario);assert.equal(row.allPass,expected,'BUILD_ORDER_GUARD: same configured resources must prevent consumers overtaking the build');if(expected){const buildEnd=row.events.findIndex(e=>e.type==='command_end'&&e.commandIndex===2),readerStart=row.events.findIndex(e=>e.type==='command_start'&&e.commandIndex===3);assert.ok(buildEnd>=0&&readerStart>buildEnd,'reader starts only after successful build ends');}}
console.log('BUILD_ORDER_GREEN',results.length);
