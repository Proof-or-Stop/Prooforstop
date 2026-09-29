import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {modularIdentityChildClosure,modularChildProcessBindings} from '../../identity-modular-child-closure.mjs';
const contract=JSON.parse(fs.readFileSync('scripts/identity-child-contract.json'));
const closures=JSON.parse(fs.readFileSync('scripts/verification-module-closures.json'));
const canonical='packages/main/tests/canonical-new-story-artifacts.test.mjs',verifier='scripts/verify-proof-or-stop-identity-cutover.mjs';
const inputs=new Map(Object.values(contract.modular.families).flat().map(file=>{const text=fs.readFileSync(file,'utf8');return[file,{ts,file,text,ast:ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),contract,root:process.cwd()}];}));
const parsed=new Map(),parse=(file,text)=>{const key=file+'\0'+text;if(!parsed.has(key))parsed.set(key,ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true));return parsed.get(key);};
const bindings=(file,families=closures,root=process.cwd())=>modularChildProcessBindings(ts,file,families,root,parse);
const familyEntry=file=>Object.entries(contract.modular.families).find(([,files])=>files.includes(file))[0];
// Each file is planned under its own registered family entry; foreign entries scan fully (null plan).
const run=(file,argv,overrides={})=>modularIdentityChildClosure({...inputs.get(file),entry:familyEntry(file),argv,...overrides});
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
 assert.equal(run(file,argv,{entry:familyEntry(file)===canonical?verifier:canonical}),null,'foreign entry must not reuse the family plan');
}
function childCalls(entry,argv){
 const calls=[];
 for(const file of contract.modular.families[entry]){
  const input=inputs.get(file),plan=run(file,argv,{entry});assert.deepEqual(plan.errors,[]);
  const names=bindings(file).names;
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
const aliases=bindings('packages/main/tests/milestone-status/cli-behavior.mjs').names;assert.equal(aliases.get('execFileSync'),'execFileSync');assert.equal(aliases.get('spawnSync'),'spawnSync');
// Every export form that can carry a child_process binding is followed or reported unresolved.
const formsRoot=fs.mkdtempSync(path.join((await import('node:os')).tmpdir(),'modular-cp-forms-'));
try {
 const sources={
  'entry.mjs':"import {a,b,c,d,e,f,g} from './sub/named.mjs';import {spawn as s2} from './sub/star.mjs';import {chained} from './sub/chain.mjs';import * as whole from './sub/named.mjs';import def from './sub/default.mjs';\n",
  'sub/named.mjs':"import * as cp from 'node:child_process';import proc from 'child_process';import {execFileSync} from 'node:child_process';\nexport {execFileSync as a} from 'node:child_process';\nexport {cp as b,proc as c};\nexport const d=execFileSync,e=cp.spawnSync,f=cp['fork'],g=cp[execFileSync.name];\nexport const plain=1;\n",
  'sub/star.mjs':"export * from 'node:child_process';\n",
  'sub/chain.mjs':"export * from './named.mjs';export {a as chained} from './named.mjs';\n",
  'sub/default.mjs':"import {spawn} from 'node:child_process';export default spawn;\n",
 };
 for(const[name,text]of Object.entries(sources)){fs.mkdirSync(path.dirname(path.join(formsRoot,name)),{recursive:true});fs.writeFileSync(path.join(formsRoot,name),text);}
 const family={'entry.mjs':Object.keys(sources)},result=bindings('entry.mjs',family,formsRoot);
 assert.equal(result.names.get('a'),'execFileSync','direct named re-export');
 assert.ok(result.namespaces.has('b')&&result.namespaces.has('c'),'re-exported namespace and default imports');
 assert.equal(result.names.get('d'),'execFileSync','export const alias');
 assert.equal(result.names.get('e'),'spawnSync','export const namespace member');
 assert.equal(result.names.get('f'),'fork','export const literal element access');
 assert.equal(result.names.get('s2'),'spawn','star re-export from child_process');
 assert.equal(result.names.get('chained'),'execFileSync','relative re-export chain');
 assert.equal(result.names.get('def'),'spawn','default export alias');
 assert.ok(result.unresolved.includes('g'),'computed namespace member fails closed');
 assert.ok(result.unresolved.includes('whole'),'namespace import of a child_process-exporting module fails closed');
 assert.equal(result.names.has('plain')||result.unresolved.includes('plain'),false);
 const before=bindings('entry.mjs',family,formsRoot);assert.deepEqual([...before.names],[...result.names],'repeated lookup is stable');
 fs.writeFileSync(path.join(formsRoot,'sub/star.mjs'),"export const spawn=1;\n");
 assert.equal(bindings('entry.mjs',family,formsRoot).names.has('s2'),false,'changed family source is re-read, not served from cache');
 assert.throws(()=>modularChildProcessBindings(ts,'entry.mjs',family,formsRoot),/caller parser/);
} finally {fs.rmSync(formsRoot,{recursive:true,force:true});}
console.log('MODULAR_STATIC_CLOSURE_GREEN '+JSON.stringify({families:Object.keys(closures).length,sourceMutations:mutations,cacheChildren:cacheCalls.length,identityCalls:identityCalls.length,boundaryCalls:boundary.length,fullCalls:full.length}));
