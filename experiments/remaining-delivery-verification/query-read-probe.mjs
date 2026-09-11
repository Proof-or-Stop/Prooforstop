#!/usr/bin/env node
// Read-only production handler probe. Output contains counts/digests, not Story bodies.
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const [distArg,rootArg,mode='active',instrument='yes']=process.argv.slice(2);
if(!distArg||!rootArg||!['active','review','full'].includes(mode))throw new Error('dist root active|review|full [yes|no] required');
const dist=resolve(distArg),root=fs.realpathSync(rootArg);
const {StoryStore}=await import(pathToFileURL(join(dist,'core/store.js')).href);
const {createStoryQueryHandlers}=await import(pathToFileURL(join(dist,'handlers/story-query.js')).href);
const inputs=new Map(),reads=[];const read=fs.readFileSync;
const hash=x=>createHash('sha256').update(x).digest('hex');
if(instrument==='yes'){
 fs.readFileSync=function(path,...args){const out=read.call(this,path,...args);if(typeof path==='string'&&!path.includes('/node_modules/')&&!path.includes('/dist/'))inputs.set(resolve(path),hash(out));return out;};syncBuiltinESMExports();
 for(const method of ['readChecklist','readBugs','readTestEvidence','readProcessMetrics']){const original=StoryStore.prototype[method];StoryStore.prototype[method]=function(id,...rest){reads.push({method,id,root:this.projectRoot});return original.call(this,id,...rest);};}
}
const args=mode==='active'?{active:true,json:true}:mode==='review'?{phase:'REVIEW',json:true}:{json:true};
const started=performance.now();let result,error;
try{result=createStoryQueryHandlers({store:new StoryStore(root),root,scanRoot:root}).story_list(args);}catch(e){error={name:e.name,message:e.message};}
const elapsedMs=performance.now()-started;
fs.readFileSync=read;syncBuiltinESMExports();
const changedDuringProbe=[...inputs].filter(([p,d])=>{try{return hash(read(p))!==d;}catch{return true;}}).map(([p])=>p);
const rows=Array.isArray(result)?result:result?.stories||[];
console.log(JSON.stringify({schema:'lab.query-probe.v1',dist,root,args,instrumented:instrument==='yes',elapsedMs,error:error||null,rows:rows.map(r=>({id:r.storyId,phase:r.phase})),resultSha256:result?hash(JSON.stringify(result)):null,detailCalls:reads.length,detailIds:[...new Set(reads.map(r=>r.id))].sort(),inputs:Object.fromEntries(inputs),changedDuringProbe,scope:'handler query only; excludes process startup/build and is not Story lead time'}));
if(error||changedDuringProbe.length)process.exitCode=1;
