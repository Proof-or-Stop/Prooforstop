import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {modularIdentityChildClosure,modularChildProcessBindings} from '../../identity-modular-child-closure.mjs';
const contract=JSON.parse(fs.readFileSync('scripts/identity-child-contract.json'));
const closures=JSON.parse(fs.readFileSync('scripts/verification-module-closures.json'));
const canonical='packages/main/tests/canonical-new-story-artifacts.test.mjs',verifier='scripts/verify-proof-or-stop-identity-cutover.mjs';
const inputs=new Map(Object.values(contract.modular.families).flat().map(file=>{const text=fs.readFileSync(file,'utf8');return[file,{ts,file,text,ast:ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),contract,root:process.cwd()}];}));
const run=(file,argv,overrides={})=>modularIdentityChildClosure({...inputs.get(file),entry:canonical,argv,...overrides});
for(const[entry,files]of Object.entries(closures)){
 assert.equal(files[0],entry);assert.equal(new Set(files).size,files.length);
 const folder=path.dirname(files[1]);assert.deepEqual(files.slice(1),fs.readdirSync(folder).filter(n=>/\.(?:mjs|ts)$/.test(n)).sort().map(n=>folder+'/'+n));
}
let mutations=0;
for(const[file,input]of inputs){
 const argv=file.startsWith('scripts/')?['--boundary-only']:['--group=identity-cache'];
 const plan=run(file,argv);assert.deepEqual(plan.errors,[],file);
 for(const changed of [input.text+'\n// changed source\n','// shifted source positions\n'+input.text]){
  const ast=ts.createSourceFile(file,changed,99,true),bad=run(file,argv,{text:changed,ast});assert.ok(bad.errors.some(e=>e.includes('AST input changed')),file);assert.equal(bad.shouldSkip(ast.statements[0]),false);mutations++;
 }
 const unknown=run(file,['--capability=not-registered']);assert.ok(unknown.errors.length);mutations++;
}
function childCalls(entry,argv){
 const calls=[];
 for(const file of contract.modular.families[entry]){
  const input=inputs.get(file),plan=run(file,argv,{entry});assert.deepEqual(plan.errors,[]);
  const names=modularChildProcessBindings(ts,file,closures);
  const visit=node=>{if(plan.shouldSkip(node))return;if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&names.has(node.expression.text)){const launch=plan.launchFor(node);calls.push({file,text:node.getText(input.ast),targets:launch?.targets??[]});}ts.forEachChild(node,visit);};visit(input.ast);assert.deepEqual(plan.errors,[]);
 }
 return calls;
}
const cacheCalls=childCalls(canonical,['--group=identity-cache']);assert.ok(cacheCalls.every(row=>row.text.startsWith("execFileSync('git',")&&row.targets.length===0),'cache-only selector may read Git metadata but must not activate child suites');
const identityCalls=childCalls(canonical,['--group=identity-cutover']);assert.ok(identityCalls.some(r=>r.text.includes('validation-runtime-tracer-transparency-smoke.js')));
assert.deepEqual(childCalls(canonical,['--capability=identity-cutover']),identityCalls,'capability and legacy group select the same children');
const boundary=childCalls(verifier,['--boundary-only']),full=childCalls(verifier,[]);
assert.equal(boundary.flatMap(r=>r.targets).filter(t=>t.file===canonical).length,1);
assert.ok(!boundary.some(r=>r.targets.some(t=>t.argv.includes('--group=runtime'))));
assert.ok(full.some(r=>r.targets.some(t=>t.argv.includes('--group=runtime'))));
const aliases=modularChildProcessBindings(ts,'packages/main/tests/milestone-status/cli-behavior.mjs',closures);assert.equal(aliases.get('execFileSync'),'execFileSync');assert.equal(aliases.get('spawnSync'),'spawnSync');
console.log('MODULAR_STATIC_CLOSURE_GREEN '+JSON.stringify({families:Object.keys(closures).length,sourceMutations:mutations,cacheChildren:cacheCalls.length,identityCalls:identityCalls.length,boundaryCalls:boundary.length,fullCalls:full.length}));
