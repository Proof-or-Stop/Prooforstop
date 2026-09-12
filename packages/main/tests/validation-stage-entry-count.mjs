import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import childProcess, {execFileSync} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const STAGE_MODE_TIMEOUT_MS = 30000;
function assertStageModeResult(mode, result) {
  if (result.error?.code === 'ETIMEDOUT') throw new Error(`STAGE_MODE_${mode}_BUDGET_${STAGE_MODE_TIMEOUT_MS}MS_EXCEEDED`);
  assert.equal(result.error, undefined, 'Stage contract child must execute');
  assert.equal(result.signal, null, 'Stage contract child must finish without a signal');
  assert.equal(result.status, 0, mode === 'abort' ? 'PRESPAWN_ABORT_ORACLE_MUST_MATCH_COMMAND_RESULT' : `STAGE_MODE_${mode}_MUST_PASS`);
  const lines = (result.stdout ?? '').split('\n');
  if (mode === 'normal') {
    assert.equal(lines.filter(line => line === 'STAGE_ENTRY_GREEN').length, 1, 'normal branch marker required');
    assert(!lines.includes('PRESPAWN_GREEN'), 'normal branch must not execute cancellation mode');
  } else {
    assert.equal(lines.filter(line => line === 'PRESPAWN_GREEN').length, 1, 'cancellation branch marker required');
    assert(!lines.includes('STAGE_ENTRY_GREEN'), 'cancellation branch must not execute normal mode');
    const rows = lines.filter(line => line.startsWith('PRESPAWN_LEDGER='));
    assert.equal(rows.length, 1, 'one cancellation branch ledger required');
    const row = JSON.parse(rows[0].slice('PRESPAWN_LEDGER='.length));
    assert.equal(row.mode, mode, 'cancellation branch mode mismatch');
    assert.equal(row.childStarts, 0, 'cancellation branch started a child');
  }
}
// Bounded Lab replay includes all original mode contracts in one pinned command.
if (process.argv.includes('--contract-suite')) {
  const wrongMode = { status: 0, signal: null, stdout: 'STAGE_ENTRY_GREEN\n' };
  assert.throws(() => assertStageModeResult('abort', wrongMode), /branch/, 'PRESPAWN_ABORT_ORACLE_MUST_MATCH_COMMAND_RESULT');
  assert.throws(() => assertStageModeResult('deadline', wrongMode), /branch/);
  assert.throws(() => assertStageModeResult('normal', { ...wrongMode, stdout: 'PRESPAWN_GREEN\n' }), /branch/);
  assert.throws(() => assertStageModeResult('deadline', { ...wrongMode,
    stdout: 'PRESPAWN_LEDGER={"mode":"abort","childStarts":0}\nPRESPAWN_GREEN\n' }), /branch mode mismatch/);
  assert.throws(() => assertStageModeResult('abort', { error: { code: 'ETIMEDOUT' } }), /STAGE_MODE_abort_BUDGET_30000MS_EXCEEDED/);
  for (const mode of ['normal', 'abort', 'deadline']) {
    const env = { ...process.env };
    if (mode === 'normal') delete env.LAB_SAFETY_MODE;
    else env.LAB_SAFETY_MODE = mode;
    const result = childProcess.spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env, encoding: 'utf8', timeout: STAGE_MODE_TIMEOUT_MS, killSignal: 'SIGKILL' });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    assertStageModeResult(mode, result);
  }
  console.log('STAGE_CONTRACT_SUITE_GREEN');
  process.exit(0);
}
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
  let caught, result;
  try{result=await withOfficialValidationExecution({root,workspaceRoot:root,command:'entry-count',commandStages:true},()=>runValidationCommand(command,root,5000,options));}catch(e){caught=e;}
  console.log('PRESPAWN_LEDGER='+JSON.stringify({mode,childStarts,error:caught?.message,result}));
  assert.equal(childStarts,0,'CANCELLED_OR_EXPIRED_COMMAND_MUST_NOT_SPAWN');
  if(mode==='abort'){
   // Cancellation before capture uses the public command-result API; the
   // supplied deadline-error callback remains an exception in the other arm.
   assert.equal(caught,undefined);
   assert.equal(result.code,124);
   assert.equal(result.timedOut,true);
   assert.equal(result.failureKind,'infra_failure');
   assert.equal(result.effectiveTimeoutMs,0);
   assert.equal(result.output,'aborted before child launch');
  }else{
   assert.equal(result,undefined);
   assert.equal(caught,failure);
  }
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
