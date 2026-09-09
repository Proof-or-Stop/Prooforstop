import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {makeQuorumPlan,verifyQuorumResults,type QuorumRunResult} from './quorum-case-plan.js';

/** Internal process fan-out while the one outer command retains its entire
 * existing capacity ticket. Children use independent temporary Git fixtures. */
export async function runParallelQuorum(entry:string,jobs:number):Promise<void> {
  assert.notEqual(process.platform,'win32','QUORUM_PARALLEL_REQUIRES_POSIX_PROCESS_GROUPS');
  const plan=makeQuorumPlan(jobs),dir=mkdtempSync(join(tmpdir(),'quorum-internal-shards-'));
  const started=performance.now();const runs:Array<{index:number;startMs:number;endMs:number;code:number}>=[];
  const active=new Set<ChildProcess>();
  let failure:{index:number;detail:string}|undefined,interrupted:NodeJS.Signals|undefined;
  const terminate=(proc:ChildProcess)=>{
    if(!proc.pid)return;
    try{
      process.kill(-proc.pid,'SIGKILL');
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
  };
  const cancel=(index:number,detail:string)=>{
    failure??={index,detail};
    for(const proc of active)try{terminate(proc);}catch(error){failure.detail+='; process cleanup: '+String(error);}
  };
  const onSignal=(signal:NodeJS.Signals)=>{interrupted=signal;cancel(-1,'QUORUM_INTERRUPTED '+signal);};
  const onTerm=()=>onSignal('SIGTERM'),onInt=()=>onSignal('SIGINT');
  process.on('SIGTERM',onTerm);process.on('SIGINT',onInt);
  const child=(args:string[],index:number)=>new Promise<{code:number;output:string}>(resolve=>{
    const startMs=performance.now()-started;
    if(failure){resolve({code:128,output:'QUORUM_CANCELLED_BEFORE_SPAWN'});return;}
    let proc:ChildProcess;
    try{proc=spawn(process.execPath,[entry,...args],{cwd:process.cwd(),detached:true,env:{...process.env,PROOF_OR_STOP_QUORUM_JOBS:'1',PROOF_OR_STOP_QUORUM_REPORT:''},stdio:['ignore','pipe','pipe']});}
    catch(error){cancel(index,'QUORUM_SPAWN_FAILED '+String(error));resolve({code:1,output:String(error)});return;}
    active.add(proc);
    let output='',overflow=false,spawnError:Error|undefined,cleanupError:unknown;
    const collect=(b:Buffer)=>{
      if(overflow)return;output+=b.toString();
      if(output.length>16*1024*1024){output=output.slice(0,16*1024*1024);overflow=true;cancel(index,'QUORUM_OUTPUT_LIMIT');}
    };
    proc.stdout!.on('data',collect);proc.stderr!.on('data',collect);
    proc.on('error',error=>{spawnError=error;cancel(index,'QUORUM_SPAWN_FAILED '+String(error));});
    proc.on('exit',(code,signal)=>{
      if(code!==0)cancel(index,signal?'signal='+signal:'exit='+code);
      // The direct child has exited; reap any descendant retaining its pipe or
      // private fixture before accepting completion, including successful exits.
      try{terminate(proc);}catch(error){cleanupError=error;cancel(index,'QUORUM_CLEANUP_FAILED '+String(error));}
    });
    proc.on('close',(code,signal)=>{
      active.delete(proc);let actual=spawnError||cleanupError||overflow?(code||1):(code??128);
      if(spawnError)output+='\n'+String(spawnError);
      try{writeFileSync(join(dir,index+'.log'),output);}catch(error){actual=1;output+='\n'+String(error);cancel(index,'QUORUM_LOG_WRITE_FAILED');}
      runs.push({index,startMs,endMs:performance.now()-started,code:actual});
      resolve({code:actual,output:signal?'signal='+signal+'\n'+output:output});
    });
  });
  let succeeded=false;
  try{
    const listing=await child(['--list-cases'],-1);assert.equal(listing.code,0,listing.output);
    const marker=listing.output.split('\n').find(line=>line.startsWith('QUORUM_CASE_MANIFEST:'));
    assert.ok(marker,'MISSING_QUORUM_LIVE_MANIFEST');const manifest=JSON.parse(marker.slice('QUORUM_CASE_MANIFEST:'.length)) as QuorumRunResult['manifest'];
    assert.ok(!failure,'QUORUM_LISTING_FAILED');
    // Every promise settles only after close; cancellation still reaps all peers.
    const outcomes=await Promise.all(plan.map((ids,index)=>child(['--case-ids='+ids.join(','),'--result-file='+join(dir,index+'.json')],index)));
    if(interrupted)throw new Error('QUORUM_INTERRUPTED '+interrupted);
    const cause=failure as {index:number;detail:string}|undefined;
    if(cause)throw new Error('QUORUM_SHARD_FAILED '+cause.index+'\n'+cause.detail);
    for(let index=0;index<outcomes.length;index++)assert.equal(outcomes[index].code,0,'QUORUM_SHARD_FAILED '+index+'\n'+outcomes[index].output);
    const results=plan.map((_,index)=>JSON.parse(readFileSync(join(dir,index+'.json'),'utf8')) as QuorumRunResult);
    verifyQuorumResults(plan,results,manifest);
    const result={schema:'quorum-parallel-run.v1',jobs,elapsedMs:performance.now()-started,plan,runs,results};
    if(process.env.PROOF_OR_STOP_QUORUM_REPORT)writeFileSync(process.env.PROOF_OR_STOP_QUORUM_REPORT,JSON.stringify(result,null,2)+'\n');
    console.log('QUORUM_EXACT_COVERAGE '+JSON.stringify({cases:manifest.length,jobs,elapsedMs:result.elapsedMs}));
    console.log(`\n✓ quorum_submit smoke passed (${manifest.length} checks)`);succeeded=true;
  }finally{
    process.removeListener('SIGTERM',onTerm);process.removeListener('SIGINT',onInt);
    if(succeeded)rmSync(dir,{recursive:true,force:true});else console.error('Quorum failure artifacts retained: '+dir);
  }
}
