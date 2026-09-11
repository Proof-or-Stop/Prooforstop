import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync,execFileSync} from 'node:child_process';
const repo=process.cwd();let count=0;
for(const mode of ['none','unborn','committed'])for(const fails of [false,true])for(const json of [true,false]){
 const root=mkdtempSync(join(tmpdir(),'pos-nongit-matrix-'));
 try{
 const git=args=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
 writeFileSync(join(root,'package.json'),'{}');writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'.',rootDir:'src',validate:{dynamic:{mode:'off'},commands:[{command:process.execPath,args:['-e',`console.log('ACTUAL_CHILD');process.exitCode=${fails?7:0}`]}]}}));
 if(mode!=='none'){git(['init','-q']);git(['config','user.email','lab@example.invalid']);git(['config','user.name','Lab']);if(mode==='committed'){git(['add','.']);git(['commit','-qm','Temporary baseline fixture']);}}
 const started=performance.now();const result=spawnSync(process.execPath,[join(repo,'bin/proof-or-stop.js'),'--root',root,'validate',JSON.stringify({json,noSync:true})],{cwd:root,encoding:'utf8',timeout:60000});
 const baseline=join(root,'.proof-or-stop/runtime/dynamic-validation/canonical-baseline.json');
 console.log(JSON.stringify({mode,fails,json,exit:result.status,seconds:(performance.now()-started)/1000,baseline:existsSync(baseline),stdout:result.stdout,stderr:result.stderr}));
 if(mode!=='committed'&&!fails)assert.match(result.stderr,/canonical full baseline not produced: no resolvable HEAD/);
 assert.equal(result.status,fails?1:0);assert.match(result.stdout,/ACTUAL_CHILD/);
 assert.equal(existsSync(baseline),mode==='committed'&&!fails);
 if(existsSync(baseline)){const b=JSON.parse(readFileSync(baseline));assert.equal(b.sourceHead,git(['rev-parse','HEAD']).toString().trim());assert.ok(b.closureCertificates&&Object.keys(b.closureCertificates).length);}
 count++;
 }finally{rmSync(root,{recursive:true,force:true});}
}
console.log('NON_GIT_VALIDATION_GREEN '+count);
