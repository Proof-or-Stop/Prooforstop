import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { execFileSync, spawnSync } from 'node:child_process';
const path='packages/main/src/tasks/host-run-usage-smoke.ts';
const text=fs.readFileSync(path,'utf8'),ast=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true);
assert.ok(text.split('\n').length<=40&&ast.statements.every(n=>ts.isImportDeclaration(n)||ts.isExpressionStatement(n)),'HOST_USAGE_ENTRYPOINT_NOT_THIN: isolate provider parsing, binding, streaming, admission and supervision');
const original=ts.createSourceFile(path,execFileSync('git',['show','317918539b:'+path],{encoding:'utf8'}),ts.ScriptTarget.Latest,true);
const main=original.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text==='main');
const bodies=new Map(),cases=new Map();
for(const name of fs.readdirSync('packages/main/src/tasks/host-run-usage').filter(n=>n.endsWith('.ts'))){const source=fs.readFileSync('packages/main/src/tasks/host-run-usage/'+name,'utf8');assert.ok(source.split('\n').length<=2000,'HOST_USAGE_MODULE_EXCEEDS_2000: '+name);const parsed=ts.createSourceFile(name,source,ts.ScriptTarget.Latest,true);for(const n of parsed.statements)if(ts.isFunctionDeclaration(n)&&n.body){bodies.set(n.name.text,n.body.getText(parsed));if(/^case\d+$/.test(n.name.text))cases.set(Number(n.name.text.slice(4)),n.body.statements.map(s=>s.getText(parsed)));}}
for(const n of original.statements)if(ts.isFunctionDeclaration(n)&&n!==main)assert.equal(bodies.get(n.name.text),n.body.getText(original),'retained helper '+n.name.text);
assert.equal(cases.size,91);
for(const [index,node]of main.body.statements.entries()) {
 let expected=node.getText(original).replaceAll("new URL('../","new URL('../../").replace("await import('../handlers/host-run.js')", "await import('../../handlers/host-run.js')");
 if(index===88){
  const repair=JSON.parse(fs.readFileSync('scripts/lab/verification-modularization/host-capability-isolation-repair.json','utf8'));
  assert.equal(repair.case,88);assert.equal(expected,repair.before);expected=repair.after;
 }
 assert.deepEqual(cases.get(index),[expected],'retained original case '+index);
}
const cli=fs.readFileSync('packages/main/src/tasks/host-run-usage/cli.ts','utf8');const order=[...cli.matchAll(/name: 'case(\d+)'/g)].map(m=>Number(m[1]));assert.deepEqual(order,Array.from({length:91},(_,i)=>i));
console.log('HOST_USAGE_ORIGINAL_CASES_PRESERVED 91');
const entry='packages/main/dist/tasks/host-run-usage-smoke.js';
const invoke=args=>spawnSync(process.execPath,[entry,...args],{encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
const list=invoke(['--list-capabilities']);assert.equal(list.status,0,list.stderr);const catalog=JSON.parse(list.stdout);assert.equal(catalog.length,12);assert.equal(catalog.flatMap(row=>row.checks).length,91);
for(const args of [['--capability='],['--capability=unknown'],['--all','--capability=usage-parsing'],['--canonical-core','--capability=usage-parsing']]){const result=invoke(args);assert.equal(result.status,1);assert.match(result.stderr,/Unknown host usage verification argument/);assert.doesNotMatch(result.stdout,/HOST_USAGE_PARTIAL_PASS|host-run usage smoke passed/);}
const partial=invoke(['--capability=story-binding','--capability=story-binding']);assert.equal(partial.status,0,partial.stderr);assert.match(partial.stdout,/HOST_USAGE_PARTIAL_PASS/);assert.doesNotMatch(partial.stdout,/host-run usage smoke passed/);
if (!process.argv.includes('--structure-only')) await import('./verify-host-usage-complete.mjs');
