import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
function body(path,name){const text=fs.readFileSync(path,'utf8');const ast=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true);const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert(fn,name);return ts.transpileModule(fn.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/^export /gm,'');}
const batch=body(root+'/packages/main/src/core/playbook-runtime-memory.ts','buildMemoryFreshnessPacksWithRuntimeIndex');
const runner=body(root+'/packages/main/src/core/playbook-runtime-baseline.ts','runRuntimePackQueries');
let tick=0,query=0,seen=[];
const box={performance:{now:()=>tick},readRuntimeMemorySourceDigests:()=>{tick+=5;return{};},sameRuntimeMemoryIndexSourceDigests:()=>true,buildMemoryFreshnessPackInternal:()=>{tick+=[11,17][query++];return {value:query};},buildMemoryFreshnessPack:()=>{tick+=[11,17][query++];return {value:query};},packOptionsForGoldQuery:()=>({projectRoot:'fixture'}),roundedElapsed:t=>Math.round(tick-t),memoryPackResultDigest:packs=>{seen=Array.from(packs);return seen.map(p=>p.queryId+':'+p.pack.value).join('|');},semanticGuardForPacks:()=>({pass:true})};vm.createContext(box);vm.runInContext(batch+'\n'+runner+'\nglobalThis.run=runRuntimePackQueries;',box);
for(const indexed of [false,true]){tick=0;query=0;const report=box.run('fixture',{queries:[{id:'one'},{id:'two'}]},0,indexed?{runtimeIndex:{manifest:{sourceDigests:{}}}}:{});console.log('MEMORY_QUERY_TIMING '+JSON.stringify({indexed,...report}));assert.deepEqual(Array.from(report.queryElapsedMs),[11,17],'MEMORY_QUERY_TIMING_EXCLUDES_BUILD: actual pack construction must be inside each query timer');assert.equal(report.elapsedMs,indexed?33:28,'Batch overhead remains in batch elapsed');assert.equal(report.resultDigest,'one:1|two:2','MEMORY_QUERY_PACK_ALIGNMENT: preserve each query identity and pack');assert.deepEqual(Array.from(seen,p=>p.queryId),['one','two']);assert.deepEqual(Array.from(seen,p=>p.pack.value),[1,2]);}
console.log('MEMORY_QUERY_TIMING_GREEN actual construction included; batch setup separately retained');
