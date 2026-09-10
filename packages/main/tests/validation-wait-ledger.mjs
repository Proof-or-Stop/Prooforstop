import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {executeValidationPlan} from '../dist/core/validation-executor.js';
const root=mkdtempSync(join(tmpdir(),'pos-wait-ledger-'));
try{
 execFileSync('git',['init','-q'],{cwd:root});
 const commands=['first','second'].map(label=>({label,command:process.execPath,args:['-e','setTimeout(()=>console.log("CONTROLLED_PASS"),120)'],resources:[{class:'fixed-path',key:'conflict',access:'exclusive'}]}));
 const result=await executeValidationPlan({commands,warnings:[]},root,undefined,undefined,{jobs:2});
 assert.equal(result.allPass,true);
 console.log('WAIT_LEDGER='+JSON.stringify(result.commands.map(x=>({label:x.label,durationMs:x.durationMs,schedulerWaitMs:x.schedulerWaitMs}))));
 assert.equal(result.commands[0].schedulerWaitMs,0,'UNBLOCKED_COMMAND_REPORTS_ZERO_WAIT');
 assert(result.commands[1].schedulerWaitMs>0,'CONTENDED_COMMAND_MUST_NOT_DISCARD_SCHEDULER_WAIT');
 assert.equal(result.commands.length,2);
 console.log('WAIT_LEDGER_GREEN (controlled contention diagnostic, not full throughput)');
}finally{rmSync(root,{recursive:true,force:true});}
