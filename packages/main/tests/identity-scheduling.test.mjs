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
const {modularRegistrations, dispatcher, parse, registrations} = await import('./identity-modular-dispatch-fixture.mjs');
const cases=modularRegistrations();
const baseline=read(execFileSync('git',['show','7e866ee7f9:'+file],{encoding:'utf8',maxBuffer:4*1024*1024}));
const expected=baseline.filter(r=>r.name.startsWith('F-060 ')&&r.groups.includes('identity-sites')&&r.groups.includes('identity-cutover'));
assert.equal(expected.length,7);
const module='packages/main/tests/canonical-new-story-artifacts/identity-sites.mjs';
const preserved=registrations(parse(module,execFileSync('git',['show','535ed1190f:'+module],{encoding:'utf8'})));
for(const before of expected){const current=cases.filter(r=>r.name===before.name);assert.equal(current.length,1);const old=preserved.find(r=>r.name===before.name);assert.ok(old);assert.equal(current[0].callback.getText(current[0].ast),old.callback.getText(old.ast),'scheduling repair must preserve current assertion/mutation body');assert.ok(current[0].groups.includes('identity-sites'));}
async function schedule(rows){const counts=new Map();for(const group of ['identity-cutover','identity-sites']){const ctx=dispatcher(group);for(const row of rows.filter(r=>expected.some(e=>e.name===r.name)))await ctx.check(row.groups,row.name,async()=>{counts.set(row.name,(counts.get(row.name)||0)+1)});}return counts;}
const counts=await schedule(cases);
const assertOnce=counts=>{assert.equal(counts.size,7);for(const [name,count]of counts)assert.equal(count,1,'IDENTITY_DUPLICATE_SCHEDULE: '+name);};
const duplicate=cases.map(row=>row.name===expected[0].name?{...row,groups:[...row.groups,'identity-cutover']}:row);
const awaitedDuplicate=await schedule(duplicate);
assert.throws(()=>assertOnce(awaitedDuplicate),/IDENTITY_DUPLICATE_SCHEDULE/);
console.log('IDENTITY_SCHEDULE_COUNTS '+JSON.stringify([...counts]));
for(const [name,count] of counts)assert.equal(count,1,'IDENTITY_DUPLICATE_SCHEDULE: '+name);
console.log('IDENTITY_SCHEDULING_GREEN: seven unchanged bodies scheduled once across outer and nested groups; standalone retained');
