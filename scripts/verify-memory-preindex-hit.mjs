import assert from 'node:assert/strict';import fs from 'node:fs';import {tmpdir} from 'node:os';import {dirname,join} from 'node:path';import {registerHooks} from 'node:module';
import ts from 'typescript';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
let builds=0;globalThis.__intakeIndexBuilt=()=>builds++;
registerHooks({load(url,ctx,next){const r=next(url,ctx);if(!url.endsWith('/core/playbook-runtime-memory-index.js'))return r;let s=typeof r.source==='string'?r.source:new TextDecoder().decode(r.source);const needle='export function buildRuntimeMemoryIndex(';assert.equal(s.split(needle).length-1,1);const ast=ts.createSourceFile(url,s,ts.ScriptTarget.Latest,true);const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='buildRuntimeMemoryIndex');assert(fn?.body);const pos=fn.body.getStart(ast)+1;s=s.slice(0,pos)+' globalThis.__intakeIndexBuilt();'+s.slice(pos);assert(s.includes('globalThis.__intakeIndexBuilt();'));return {...r,source:s};}});
const durable=process.argv[2]==='--durable';const root=durable?process.argv[3]:fs.mkdtempSync(join(tmpdir(),'preindex-hit-'));const prev=process.env.PROOF_OR_STOP_GLOBAL_MEMORY_DIR;process.env.PROOF_OR_STOP_GLOBAL_MEMORY_DIR=join(root,'global');
const {resolveProjectMemoryPath}=await import('../packages/main/dist/core/dev-memory.js');
const {buildMemoryFreshnessPack}=await import('../packages/main/dist/core/playbook-runtime-memory.js');
const {clearRuntimeMemoryPackCache,getRuntimeMemoryPackCacheStats}=await import('../packages/main/dist/core/playbook-runtime-memory-cache.js');
try {
 if(durable){const pack=buildMemoryFreshnessPack({projectRoot:root,query:'intake',generatedAt:'2026-09-01T00:00:00.000Z'});console.log(JSON.stringify({builds,pack,stats:getRuntimeMemoryPackCacheStats()}));}
 else {
 const file=resolveProjectMemoryPath(root);fs.mkdirSync(dirname(file),{recursive:true});
 const entries=Array.from({length:2000},(_,i)=>({id:'entry-'+i,createdAt:'2026-09-01T00:00:00.000Z',sourceAgent:'fixture',category:'workflow',scope:'project',summary:'intake lesson '+i,trigger:'intake',lesson:'intake measured lesson '+i,reusePrompt:'intake',tags:[],evidenceRefs:[],gateEvidence:false,authority:'non_authoritative'}));
 const write=()=>fs.writeFileSync(file,entries.map(x=>JSON.stringify(x)).join('\n')+'\n');write();clearRuntimeMemoryPackCache();
 const options={projectRoot:root,query:'intake',generatedAt:'2026-09-01T00:00:00.000Z'};
 const cold=buildMemoryFreshnessPack(options);const count=builds;const start=performance.now();const warm=buildMemoryFreshnessPack(options);const ms=performance.now()-start;const warmBuilds=builds-count;
 assert.deepEqual(warm,JSON.parse(JSON.stringify(cold)));assert.equal(getRuntimeMemoryPackCacheStats().hits,1);
 console.log('MEMORY_PREINDEX_MEASURE '+JSON.stringify({records:entries.length,coldBuilds:count,warmBuilds,warmMs:ms,packDigest:warm.packDigest}));
 const child=JSON.parse(execFileSync(process.execPath,[fileURLToPath(import.meta.url),'--durable',root],{encoding:'utf8',env:process.env}));assert.deepEqual(child.pack,warm);assert.equal(child.stats.durableHits,1);assert.equal(child.builds,0,'durable hit must skip ephemeral index');
 entries[0].lesson+=' changed';write();const beforeChange=builds;buildMemoryFreshnessPack(options);assert(builds>beforeChange,'source change must still resolve index');
 const beforeDisabled=builds;buildMemoryFreshnessPack({...options,useCache:false});assert(builds>beforeDisabled,'cache-disabled keeps authoritative construction');
 assert.equal(warmBuilds,0,'MEMORY_PREINDEX_RED: cache hit must not build an index');
 const {buildRuntimeMemoryIndex,resolveRuntimeMemoryIndexPath}=await import('../packages/main/dist/core/playbook-runtime-memory-index.js');
 const explicit=buildRuntimeMemoryIndex(root);buildMemoryFreshnessPack({...options,query:'explicit',runtimeIndex:explicit});const beforeExplicit=builds;buildMemoryFreshnessPack({...options,query:'explicit'});assert(builds>beforeExplicit,'explicit-index cache cannot authorize early source-only reuse');
 const indexPath=resolveRuntimeMemoryIndexPath(root);fs.mkdirSync(dirname(indexPath),{recursive:true});fs.writeFileSync(indexPath,'{}');const beforeCorrupt=builds;buildMemoryFreshnessPack(options);assert(builds>beforeCorrupt,'stored corrupt index still follows validation and rebuilding');
 console.log('MEMORY_PREINDEX_GREEN parity durable source-invalidation disabled-cache explicit-index corrupt-index');
 }
} finally {if(prev===undefined)delete process.env.PROOF_OR_STOP_GLOBAL_MEMORY_DIR;else process.env.PROOF_OR_STOP_GLOBAL_MEMORY_DIR=prev;if(!durable)fs.rmSync(root,{recursive:true,force:true});delete globalThis.__intakeIndexBuilt;}
