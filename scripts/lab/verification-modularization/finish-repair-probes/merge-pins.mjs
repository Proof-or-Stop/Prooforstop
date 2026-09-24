// A main-side dependency pin survives a merge while the same exception (id and call text) remains.
import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import fs from 'node:fs';
const manifest='scripts/lab/u18-static-edges/exceptions.json';
const base=process.argv[2]??execFileSync('git',['merge-base','HEAD','main'],{encoding:'utf8'}).trim();
const before=JSON.parse(execFileSync('git',['show',base+':'+manifest],{encoding:'utf8',maxBuffer:64*1024*1024}));
const current=JSON.parse(fs.readFileSync(manifest,'utf8'));
const byKey=new Map(current.entries.map(entry=>[entry.id+'\0'+entry.callDigest,entry]));
const lost=[];let compared=0;
for(const entry of before.entries){
 const now=byKey.get(entry.id+'\0'+entry.callDigest);if(!now)continue;compared++;
 for(const file of Object.keys(entry.dependencyDigests??{}))if(!(file in (now.dependencyDigests??{})))lost.push(entry.id+' '+file);
}
assert(compared>0,'no comparable entries between base and candidate');
assert.deepEqual(lost,[],'MERGE_DROPPED_DEPENDENCY_PIN');
console.log('MERGE_PINS_PRESERVED '+JSON.stringify({base,compared}));
