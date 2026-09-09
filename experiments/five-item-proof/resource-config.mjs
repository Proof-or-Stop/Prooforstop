#!/usr/bin/env node
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {canonicalizeEntries,runScheduled,claimsConflict} from '../../packages/main/dist/core/keyed-scheduler.js';
import {resolveValidationCommandResourceClaims,runValidationCommand} from '../../packages/main/dist/core/validation-executor.js';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../..');
const config=JSON.parse(readFileSync(join(root,'proof-or-stop.config.json'),'utf8'));
const audit=JSON.parse(readFileSync(join(here,'resource-audit.json'),'utf8'));
const {verifyResourceAudit}=await import('./resource-audit-policy.mjs');
const auditSummary=verifyResourceAudit(config,audit);
assert.deepEqual(auditSummary,{auditedReaders:21,effectivelySharedReaders:14,supersededReaders:7});
const hasBarrier=command=>resolveValidationCommandResourceClaims(command,'writer').claims.some(r=>r.class==='fixed-path'&&r.key==='.proof-or-stop/runtime/validate-plan-barrier'&&r.access==='exclusive');
for(const index of [1,3,6,40,79,80,81,82,83,105,125])assert.ok(hasBarrier(config.validate.commands[index]),'WRITER_BARRIER_REMOVED');
for(const command of config.doneRequiredCommands)assert.ok(hasBarrier(command),'DONE_WRITER_BARRIER_REMOVED');
const allEntries=canonicalizeEntries(config.validate.commands.map((command,index)=>({name:String(index),resources:resolveValidationCommandResourceClaims(command,String(index)).claims})),root);
assert.ok(allEntries.slice(1).every(entry=>claimsConflict(allEntries[0],entry)),'BUILD_PRECHECK_ORDER_BARRIER_REMOVED');
assert.ok(allEntries.every((entry,index)=>index===1||claimsConflict(allEntries[1],entry)),'BUILD_ORDER_BARRIER_REMOVED');
if(process.argv.includes('--audit-only')){console.log('RESOURCE_AUDIT_AND_BUILD_ORDER_GREEN',JSON.stringify(auditSummary));process.exit(0);}
const output=process.env.FIVE_ITEM_PROOF_OUTPUT||join('/tmp','five-resource-'+Date.now());mkdirSync(output,{recursive:true});
const indices=[117,118,119,120]; // Real deterministic independent assertion suites, no artificial delay.
const commands=indices.map(index=>({...config.validate.commands[index],label:String(index)}));
const sourceHashes=commands.map(command=>({argv:[command.command,...command.args],sha256:createHash('sha256').update(readFileSync(join(root,command.args[0]))).digest('hex')}));
const rows=[];
for(let pair=1;pair<=3;pair++)for(const mode of pair%2?['RED','GREEN']:['GREEN','RED']){
 const entries=canonicalizeEntries(commands.map(command=>({name:command.label,command,resources:resolveValidationCommandResourceClaims(mode==='RED'?{...command,resources:undefined}:command,command.label).claims})),root);
 const writer=canonicalizeEntries([{name:'build',resources:resolveValidationCommandResourceClaims(config.validate.commands[1],'build').claims}],root)[0];
 assert.ok(entries.every(entry=>claimsConflict(entry,writer)),'DECLARED_READERS_MUST_CONFLICT_WITH_WRITER');
 const events=[];let active=0,peak=0;const begin=performance.now();
 const results=await runScheduled(entries,4,async entry=>{
  active++;peak=Math.max(peak,active);const start=performance.now();
  try{const result=await runValidationCommand(entry.command,root,30000);writeFileSync(join(output,`${pair}-${mode}-${entry.name}.log`),result.output);assert.equal(result.code,0,result.output);events.push({name:entry.name,startMs:start-begin,endMs:performance.now()-begin,code:result.code,outputSha256:createHash('sha256').update(result.output).digest('hex')});return {name:entry.name,status:'PASS'};}
  finally{active--;}
 },{cancellation:'run-all'});
 assert.equal(results.length,commands.length);assert.equal(peak,mode==='RED'?1:4,'EXPECTED_ACTUAL_COMMAND_OVERLAP');
 rows.push({pair,mode,elapsedMs:performance.now()-begin,peak,events,completeCommands:results.length});
 console.log(`${mode} pair=${pair} completed=${results.length} peak=${peak} elapsedMs=${rows.at(-1).elapsedMs.toFixed(2)}`);
}
const median=xs=>xs.toSorted((a,b)=>a-b)[Math.floor(xs.length/2)];
const red=median(rows.filter(x=>x.mode==='RED').map(x=>x.elapsedMs)),green=median(rows.filter(x=>x.mode==='GREEN').map(x=>x.elapsedMs));
writeFileSync(join(output,'results.json'),JSON.stringify({sourceHashes,rows,redMedianMs:red,greenMedianMs:green,wallTimeReductionPercent:100*(1-green/red),...auditSummary,remainingRoutineWriterBarriers:11,limitations:['Four actual assertion suites measured through production scheduler/executor; not all 134 commands or whole Story elapsed time.','RED removes only the new resource declarations; executable, argv, source and assertions remain identical.','No speed threshold: actual overlap and correctness are required; measured overhead or slowdown is retained.','Twenty-one historical source reviews are retained; seven were superseded by explicit local barriers, leaving fourteen effectively shared readers. Only four have this live timing comparison.']},null,2));
console.log('AUDITED_RESOURCE_CONFIG_GREEN');
