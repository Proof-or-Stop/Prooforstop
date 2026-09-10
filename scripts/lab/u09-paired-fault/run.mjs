import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const repo=resolve(process.argv[2]||process.cwd()),parent=resolve(process.argv[3]||tmpdir());mkdirSync(parent,{recursive:true});
const output=mkdtempSync(join(parent,'u09-paired-'));
const cases=['DEP-01','POLICY-01','GATE-01','UNKNOWN-01','ENV-01','SELECTOR-01'];
const results=[];
for(const id of cases){
 const script=id==='ENV-01'?'env-pair.mjs':id==='SELECTOR-01'?'selector-pair.mjs':'module-pair.mjs';
 const r=spawnSync(process.execPath,[fileURLToPath(new URL(script,import.meta.url))],{cwd:repo,env:{...process.env,U09_REPO:repo,U09_CASE:id,U09_PROTECTED:'0'},encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
 writeFileSync(join(output,id+'.log'),(r.stdout||'')+(r.stderr||''));results.push({id,exitCode:r.status,signal:r.signal,error:r.error?.message});
}
writeFileSync(join(output,'summary.json'),JSON.stringify({cases,results,claim:'bounded deterministic witnesses, not population noninferiority'},null,2));
console.log(output);if(results.some(r=>r.exitCode!==0))process.exitCode=1;
