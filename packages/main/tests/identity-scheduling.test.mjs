import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const ts = (await import(pathToFileURL(resolve('node_modules/typescript/lib/typescript.js')))).default;
const file='packages/main/tests/canonical-new-story-artifacts.test.mjs';
const read=text=>{const ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);return ast.statements.flatMap(s=>{
 if(!ts.isExpressionStatement(s)||!ts.isAwaitExpression(s.expression))return [];
 const call=s.expression.expression;if(!ts.isCallExpression(call)||call.expression.getText(ast)!=='check')return [];
 const [groups,name,fn]=call.arguments;if(!ts.isStringLiteral(name))return [];
 return [{name:name.text,groups:vm.runInNewContext(groups.getText(ast)),body:createHash('sha256').update(fn.getText(ast)).digest('hex')}];});};
const source=fs.readFileSync(file,'utf8'), cases=read(source);
const baseline=read(execFileSync('git',['show','7e866ee7f9:'+file],{encoding:'utf8',maxBuffer:4*1024*1024}));
const expected=baseline.filter(r=>r.name.startsWith('F-060 ')&&r.groups.includes('identity-sites')&&r.groups.includes('identity-cutover'));
assert.equal(expected.length,7);
for(const before of expected){const current=cases.filter(r=>r.name===before.name);assert.equal(current.length,1);assert.equal(current[0].body,before.body,'dedup must preserve exact assertion/mutation body');assert.ok(current[0].groups.includes('identity-sites'),'standalone source witness must remain');}
const dispatch=source.slice(source.indexOf('async function check(groups, name, fn) {'),source.indexOf('\nconst NOW ='));
const counts=new Map();
for(const selectedGroup of ['identity-cutover','identity-sites']){
 const ctx=vm.createContext({selectedGroup,failures:[],process:{pid:process.pid,hrtime:process.hrtime,stdout:{write(){}},stderr:{write(){}}}});vm.runInContext(dispatch,ctx);
 for(const row of cases.filter(r=>expected.some(e=>e.name===r.name))) await ctx.check(row.groups,row.name,async()=>{counts.set(row.name,(counts.get(row.name)||0)+1)});
}
console.log('IDENTITY_SCHEDULE_COUNTS '+JSON.stringify([...counts]));
for(const [name,count] of counts)assert.equal(count,1,'IDENTITY_DUPLICATE_SCHEDULE: '+name);
console.log('IDENTITY_SCHEDULING_GREEN: seven unchanged bodies scheduled once across outer and nested groups; standalone retained');
