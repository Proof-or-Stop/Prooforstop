import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
const repo=process.cwd(),{scanTrackedRuntimeArtifacts}=await import(pathToFileURL(join(repo,'packages/main/dist/handlers/doctor.js')));
const root=mkdtempSync(join(tmpdir(),'runtime-scan-proof-')),bin=join(root,'shim'),project=join(root,'project');
const realGit=execFileSync('which',['git'],{encoding:'utf8'}).trim();
try {
 const failure=(code,stderr)=>()=>{throw Object.assign(new Error(String(code)),{code,stderr});};
 assert.equal(scanTrackedRuntimeArtifacts(root,root,failure('ENOENT','')).state,'not-evaluated');
 assert.equal(scanTrackedRuntimeArtifacts(root,root,failure(128,'fatal: not a git repository')).state,'not-evaluated');
 for(const code of ['ENOBUFS','EACCES'])assert.equal(scanTrackedRuntimeArtifacts(root,root,failure(code,'')).state,'failed');
 let n=0;assert.equal(scanTrackedRuntimeArtifacts(root,root,()=>n++===0?'true\n':'truncated').state,'failed');
 assert.equal(scanTrackedRuntimeArtifacts(root).state,'not-evaluated');
 mkdirSync(bin);mkdirSync(project);execFileSync(realGit,['init','-q','-b','main'],{cwd:project});
 const log=join(root,'calls.jsonl');
 writeFileSync(join(bin,'git'),`#!${process.execPath}\nconst {appendFileSync}=require('node:fs');const{spawnSync}=require('node:child_process');const a=process.argv.slice(2);appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');if(a[0]==='ls-files'){process.stderr.write('INJECTED_GIT_INDEX_FAILURE');process.exit(2);}const r=spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});process.exit(r.status??1);\n`,{mode:0o755});
 const env={...process.env,PATH:bin+':'+process.env.PATH,PROOF_OR_STOP_BURN_ALERT_RECENT_HOURS:'0'};
 const run=repair=>spawnSync(process.execPath,[join(repo,'bin/proof-or-stop.js'),'--root',project,'doctor',JSON.stringify({format:'json',...(repair?{repair:true}:{})})],{cwd:project,env,encoding:'utf8',timeout:60000,maxBuffer:4e6});
 const a=run(false);assert.equal(a.status,0,a.stderr);const j=JSON.parse(a.stdout);assert.equal(j.runtimeArtifacts.scanState,'failed');assert.equal(j.runtimeArtifacts.tracked,null);assert.equal(j.runtimeArtifacts.needsRepair,null);
 writeFileSync(log,'');const b=run(true);assert.notEqual(b.status,0);assert.match(b.stderr,/TRACKED_RUNTIME_SCAN_UNAVAILABLE/);
 const calls=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.ok(calls.every(x=>!['rm','prune','branch'].includes(x[0])&&!(x[0]==='worktree'&&x[1]!=='list')));
 console.log('DOCTOR_REAL_FAILED_SCAN_NULL_AND_REPAIR_REFUSAL_GREEN');
}finally{rmSync(root,{recursive:true,force:true});}
