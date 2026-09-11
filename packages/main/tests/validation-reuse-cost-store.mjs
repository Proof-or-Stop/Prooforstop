import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {execFileSync} from 'node:child_process';
const {readValidationReuseCost:read,saveValidationReuseCost:save}=await import(resolve('packages/main/dist/core/validation-reuse-costs.js'));
const base=mkdtempSync(join(tmpdir(),'cost-store-')),root=join(base,'repo'),outside=join(base,'outside');mkdirSync(root);mkdirSync(outside);
const git=args=>execFileSync('git',args,{cwd:root,stdio:'pipe'});git(['init','-q']);writeFileSync(join(root,'.gitignore'),'.proof-or-stop/runtime/\n');
const state=join(root,'.proof-or-stop'),runtime=join(state,'runtime'),file=join(runtime,'validation-reuse-costs.json');
try {
 save(root,'secret argv never written',120);assert.equal(read(root,'secret argv never written'),120);assert.ok(!readFileSync(file,'utf8').includes('secret'));const good=readFileSync(file,'utf8');
 for(const text of ['{bad','[]','x'.repeat(65537)]){writeFileSync(file,text);assert.equal(read(root,'secret argv never written'),undefined);}
 let value=JSON.parse(good);Object.values(value.entries)[0].observedAt=Date.now()-7*3600000;writeFileSync(file,JSON.stringify(value));assert.equal(read(root,'secret argv never written'),undefined);
 value=JSON.parse(good);Object.values(value.entries)[0].costMs=-1;writeFileSync(file,JSON.stringify(value));assert.equal(read(root,'secret argv never written'),undefined);
 writeFileSync(file,good);save(root,'secret argv never written',undefined);assert.equal(read(root,'secret argv never written'),undefined);
 for(let i=0;i<132;i++)save(root,'row'+i,100);assert.equal(Object.keys(JSON.parse(readFileSync(file,'utf8')).entries).length,128);
 const trackedBytes=readFileSync(file,'utf8');git(['add','-f',file]);save(root,'tracked-must-not-write',200);assert.equal(readFileSync(file,'utf8'),trackedBytes,'TRACKED_COST_FILE_MUST_NOT_BE_OVERWRITTEN');git(['rm','--cached','-f',file]);
 rmSync(file);const external=join(outside,'sentinel');writeFileSync(external,'KEEP');symlinkSync(external,file);assert.equal(read(root,'row1'),undefined);save(root,'row1',100);assert.equal(readFileSync(external,'utf8'),'KEEP');rmSync(file);
 rmSync(runtime,{recursive:true});symlinkSync(outside,runtime);save(root,'row1',100);assert.ok(!existsSync(join(outside,'validation-reuse-costs.json')));assert.equal(read(root,'row1'),undefined);rmSync(runtime);
 writeFileSync(join(root,'.gitignore'),'');save(root,'row1',100);assert.ok(!existsSync(runtime),'Unignored runtime must not be created');
 console.log('COST_STORE_GREEN bounded corrupt expired deleted secretFree symlinkRefusal ignoreRequired');
}finally{rmSync(base,{recursive:true,force:true});}
