import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
const repo=resolve(process.argv[2]??process.cwd());
const {executeValidationPlan}=await import(repo+'/packages/main/dist/core/validation-executor.js');
const {runtimeTraceForResult}=await import(repo+'/packages/main/dist/handlers/story-aware-validation.js');
const parent=realpathSync(mkdtempSync(join(tmpdir(),'u09-trace-boundary-'))),root=join(parent,'repo'),sibling=join(parent,'repo-sibling');
const old=process.cwd(),results=[];
try{
 for(const p of [root,sibling,join(root,'tests/fixtures'),join(root,'packages/main/src/core'),join(root,'packages/main/dist')])mkdirSync(p,{recursive:true});
 for(const [p,text] of [[join(root,'tests/fixtures/cases.json'),'{}'],[join(root,'proof-or-stop.config.json'),'{}'],[join(root,'packages/main/dist/example.js'),'export const value=1'],[join(sibling,'outside.json'),'{}']])writeFileSync(p,text);
 writeFileSync(join(root,'packages/main/src/core/validation-runtime-tracer.cjs'),readFileSync(repo+'/packages/main/dist/core/validation-runtime-tracer.cjs'));
 symlinkSync(join(root,'tests/fixtures'),join(root,'inside-link'));
 symlinkSync(sibling,join(root,'outside-link'));
 execFileSync('git',['init','-q'],{cwd:root});process.chdir(root);
 const cases=[
  ['json',join(root,'tests/fixtures/cases.json'),'tests/fixtures/cases.json'],
  ['config',join(root,'proof-or-stop.config.json'),'proof-or-stop.config.json'],
  ['generated-js',join(root,'packages/main/dist/example.js'),'packages/main/src/example.ts'],
  ['relative-json','tests/fixtures/cases.json','tests/fixtures/cases.json'],
  ['inside-symlink',join(root,'inside-link/cases.json'),'tests/fixtures/cases.json'],
  ['outside-symlink',join(root,'outside-link/outside.json'),'__external__/'],
  ['prefix-sibling',join(sibling,'outside.json'),'__external__/'],
  ['parent-escape','../repo-sibling/outside.json','__external__/'],
 ];
 for(const [name,path,expected]of cases){
  const result=await executeValidationPlan({provider:'u09-real-trace',commands:[{label:name,command:process.execPath,args:['-e',`require('node:fs').readFileSync(${JSON.stringify(path)},'utf8');console.log('READ_OK')`]}],warnings:[]},root,'HEAD','B-temp-only');
  assert.equal(result.allPass,true);
  const trace=runtimeTraceForResult(result.commands[0],root);
  const observed=trace.readPaths;
  const pass=expected==='__external__/'?observed.some(p=>p.startsWith(expected)):observed.includes(expected);
  results.push({name,expected,observed,pass});
 }
 console.log(JSON.stringify({results},null,2));
 assert.ok(results.every(x=>x.pass),'actual tracer paths must normalize inside root and refuse all external paths');
}finally{process.chdir(old);rmSync(parent,{recursive:true,force:true});}
