import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import childProcess, {execFileSync} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
// Observe entry count without changing arguments, callbacks, admission or result.
let entries=0;let inject=()=>{};let childStarts=0;const actualSpawn=childProcess.spawn;
childProcess.spawn=function(...args){childStarts++;return actualSpawn.apply(this,args)};syncBuiltinESMExports();
globalThis.__labStageEntry=()=>{entries++;};
globalThis.__labAfterAcquisition=()=>inject();
const hook=registerHooks({load(url,context,next){
 const result=next(url,context);
 if(url.endsWith('/core/validation-executor.js')){
  const source=String(result.source);
  const original="import { withValidationPlanStages, withValidationCommandStage } from './validation-execution-lock.js';";
  assert(source.includes(original),'Instrumentation must match exactly once');
  return {...result,source:source.replace(original,"import { withValidationPlanStages, withValidationCommandStage as stageEntry } from './validation-execution-lock.js';\nconst withValidationCommandStage=(...args)=>{globalThis.__labStageEntry();const original=args[1];args[1]=()=>{globalThis.__labAfterAcquisition();return original();};return stageEntry(...args);};")};
 }
 return result;
}});
const {runValidationCommand,runSingleAllowlistedCommand}=await import('../dist/core/validation-executor.js');
const {withOfficialValidationExecution,withValidationCommandStage}=await import('../dist/core/validation-execution-lock.js');
const root=mkdtempSync(join(tmpdir(),'pos-stage-entry-'));
try{
 execFileSync('git',['init','-q'],{cwd:root});
 const command={label:'entry-count',command:process.execPath,args:['-e','console.log("REAL_CHILD_PASS")'],resources:[{class:'fixed-path',key:root,access:'shared'}]};
 if(process.env.LAB_SAFETY_MODE){
  const mode=process.env.LAB_SAFETY_MODE;const ac=new AbortController();const options={abortSignal:ac.signal};const failure=new Error('AFTER_ADMISSION_'+mode);
  inject=()=>{if(mode==='abort')ac.abort(failure);else {options.deadlineAt=Date.now()-1;options.deadlineError=()=>failure;}};
  let caught;
  try{await withOfficialValidationExecution({root,workspaceRoot:root,command:'entry-count',commandStages:true},()=>runValidationCommand(command,root,5000,options));}catch(e){caught=e;}
  console.log('PRESPAWN_LEDGER='+JSON.stringify({mode,childStarts,error:caught?.message}));
  assert.equal(childStarts,0,'CANCELLED_OR_EXPIRED_COMMAND_MUST_NOT_SPAWN');assert.equal(caught,failure);
  console.log('PRESPAWN_GREEN');
 }else{
 const start=performance.now();
 const result=await withOfficialValidationExecution({root,workspaceRoot:root,command:'entry-count',commandStages:true},()=>runValidationCommand(command,root));
 assert.equal(result.code,0);assert.match(result.output,/REAL_CHILD_PASS/);
 console.log('STAGE_ENTRY_LEDGER='+JSON.stringify({entries,seconds:(performance.now()-start)/1000,code:result.code}));
 assert.equal(entries,1,'FRESH_COMMAND_MUST_ENTER_ITS_STAGE_ONCE');
 entries=0;
 const opted=await withOfficialValidationExecution({root,workspaceRoot:root,command:'entry-count',commandStages:true},()=>runValidationCommand({...command,executionReuse:'exact-inputs',executionInputs:[]},root));
 assert.equal(opted.code,0);assert.equal(entries,2,'REUSE_DECLARATIONS_RETAIN_LATE_STAGE_RECHECK');
 entries=0;
 const single=await runSingleAllowlistedCommand('node -e "console.log(123)"',root);
 assert.equal(single.code,0);assert.equal(entries,1,'INDEPENDENT_CAPTURE_CALLER_KEEPS_ITS_STAGE');
 const beforeConflict=childStarts;
 await assert.rejects(withOfficialValidationExecution({root,workspaceRoot:root,command:'containment',commandStages:true},()=>withValidationCommandStage({label:'narrow',resources:[{class:'fixed-path',key:join(root,'only-a'),access:'exclusive'}]},()=>runValidationCommand(command,root))),/expand held capacity resources/);
 assert.equal(childStarts,beforeConflict,'A nested claim expansion cannot start a child');
 console.log('STAGE_ENTRY_GREEN');
 }
}finally{hook.deregister();delete globalThis.__labStageEntry;delete globalThis.__labAfterAcquisition;childProcess.spawn=actualSpawn;syncBuiltinESMExports();rmSync(root,{recursive:true,force:true});}
