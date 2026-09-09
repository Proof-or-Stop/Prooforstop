import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {makeQuorumPlan,verifyQuorumResults,type QuorumRunResult} from './quorum-case-plan.js';

/** Internal process fan-out while the one outer command retains its entire
 * existing capacity ticket. Children use independent temporary Git fixtures. */
export async function runParallelQuorum(entry:string,jobs:number):Promise<void> {
  const plan=makeQuorumPlan(jobs),dir=mkdtempSync(join(tmpdir(),'quorum-internal-shards-'));
  const started=performance.now();const runs:Array<{index:number;startMs:number;endMs:number;code:number}>=[];
  const child=(args:string[],index:number)=>new Promise<{code:number;output:string}>((resolve,reject)=>{
    const startMs=performance.now()-started;
    const proc=spawn(process.execPath,[entry,...args],{cwd:process.cwd(),env:{...process.env,PROOF_OR_STOP_QUORUM_JOBS:'1',PROOF_OR_STOP_QUORUM_REPORT:''},stdio:['ignore','pipe','pipe']});
    let output='';const collect=(b:Buffer)=>{output+=b.toString();if(output.length>16*1024*1024)proc.kill('SIGTERM');};
    proc.stdout.on('data',collect);proc.stderr.on('data',collect);proc.on('error',reject);
    proc.on('close',(code,signal)=>{const actual=code??128;runs.push({index,startMs,endMs:performance.now()-started,code:actual});writeFileSync(join(dir,index+'.log'),output);resolve({code:actual,output:signal?'signal='+signal+'\n'+output:output});});
  });
  let succeeded=false;
  try{
    const listing=await child(['--list-cases'],-1);assert.equal(listing.code,0,listing.output);
    const marker=listing.output.split('\n').find(line=>line.startsWith('QUORUM_CASE_MANIFEST:'));
    assert.ok(marker,'MISSING_QUORUM_LIVE_MANIFEST');const manifest=JSON.parse(marker.slice('QUORUM_CASE_MANIFEST:'.length)) as QuorumRunResult['manifest'];
    const outcomes=await Promise.all(plan.map((ids,index)=>child(['--case-ids='+ids.join(','),'--result-file='+join(dir,index+'.json')],index)));
    for(let index=0;index<outcomes.length;index++)assert.equal(outcomes[index].code,0,'QUORUM_SHARD_FAILED '+index+'\n'+outcomes[index].output);
    const results=plan.map((_,index)=>JSON.parse(readFileSync(join(dir,index+'.json'),'utf8')) as QuorumRunResult);
    verifyQuorumResults(plan,results,manifest);
    const result={schema:'quorum-parallel-run.v1',jobs,elapsedMs:performance.now()-started,plan,runs,results};
    if(process.env.PROOF_OR_STOP_QUORUM_REPORT)writeFileSync(process.env.PROOF_OR_STOP_QUORUM_REPORT,JSON.stringify(result,null,2)+'\n');
    console.log('QUORUM_EXACT_COVERAGE '+JSON.stringify({cases:manifest.length,jobs,elapsedMs:result.elapsedMs}));
    console.log(`\n✓ quorum_submit smoke passed (${manifest.length} checks)`);succeeded=true;
  }finally{if(succeeded)rmSync(dir,{recursive:true,force:true});else console.error('Quorum failure artifacts retained: '+dir);}
}
