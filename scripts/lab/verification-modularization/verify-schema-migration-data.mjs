import assert from 'node:assert/strict';
import fs from 'node:fs';
import {CURRENT_COMPATIBLE_SCHEMA_ROWS} from '../../identity-cutover/schema-data.mjs';
const repairs=JSON.parse(fs.readFileSync('scripts/lab/verification-modularization/identity-context-repairs.json'));
const repair=repairs.find(r=>r.file==='scripts/identity-cutover/schema-data.mjs');
const parse=text=>JSON.parse(text.slice(text.indexOf('=')+1,text.lastIndexOf(';')));
const before=parse(repair.before),after=parse(repair.after);
const ledger=JSON.parse(fs.readFileSync('scripts/lab/verification-modularization/schema-binding-migration.json'));
assert.equal(before.length,103);assert.equal(after.length,110);assert.equal(ledger.moves.length,12);
const expected=before.flatMap(row=>{
 const moved=ledger.moves.find(m=>m.before.path===row.path&&m.before.token===row.token);
 if(!moved)return [{...row}];
 assert.deepEqual(moved.before,row);assert.equal(moved.delta,0);
 assert.equal(moved.destinations.reduce((sum,next)=>sum+next.count,0),row.count);
 for(const next of moved.destinations)assert.equal(next.token,row.token);
 return moved.destinations;
});
const excerpt=ledger.excerptSerialization;
const index=expected.findIndex(row=>row.path===excerpt.before.path&&row.token===excerpt.before.token);
assert.deepEqual(expected[index],excerpt.before);
assert.deepEqual({...excerpt.after,contextSha256:excerpt.before.contextSha256},excerpt.before);
expected[index]=excerpt.after;
assert.deepEqual(after,expected);
const copies=JSON.parse(fs.readFileSync('scripts/lab/verification-modularization/schema-audit-copy-migration.json'));
const copiedIndex=after.findIndex(row=>row.path===copies.before.path&&row.token===copies.before.token);
assert.deepEqual(after[copiedIndex],copies.before);
const final=after.map((row,index)=>index===copiedIndex?copies.after:row);
final[index] = excerpt.before; // Lab finish requires the original canonical ASCII serialization.
assert.deepEqual(CURRENT_COMPATIBLE_SCHEMA_ROWS,final);
assert.equal(copies.after.count-copies.before.count,copies.copies.length);
console.log('SCHEMA_MIGRATION_DATA_GREEN: 12 source rows -> 19 module rows; all occurrence totals retained');
const {execFileSync}=await import('node:child_process');
const oldArchive=JSON.parse(execFileSync('git',['show',excerpt.base+':'+excerpt.before.path],{encoding:'utf8',maxBuffer:32*1024*1024}));
const currentArchive=JSON.parse(fs.readFileSync(excerpt.after.path));
for(const proof of excerpt.excerptProof){assert.equal(currentArchive.entries.find(row=>row.id===proof.id).requiredEvidence[proof.evidenceIndex].excerpt,oldArchive.entries.find(row=>row.id===proof.id).requiredEvidence[proof.evidenceIndex].excerpt,'archived excerpt decoded bytes are unchanged');}
console.log('SCHEMA_ARCHIVE_SERIALIZATION_GREEN: restored canonical ASCII bytes; identical decoded excerpts and counts');

const baseCopies=JSON.parse(execFileSync('git',['show',copies.baseline+':'+copies.before.path],{encoding:'utf8',maxBuffer:32*1024*1024}));
const tokenCount=text=>text.split(copies.before.token).length-1;
assert.equal(tokenCount(JSON.stringify(currentArchive))-tokenCount(JSON.stringify(baseCopies)),2);
for(const proof of copies.copies){
 const row=currentArchive.entries.find(row=>row.id===proof.id),original=baseCopies.entries.find(row=>row.id===proof.id);
 for(let i=0;i<original.requiredEvidence.length;i++)if(typeof original.requiredEvidence[i]==='object')assert.equal(row.requiredEvidence[i].excerpt,original.requiredEvidence[i].excerpt);
 const evidence=row.requiredEvidence[proof.evidenceIndex];assert.notEqual(evidence.historical,true);assert.equal(tokenCount(evidence.excerpt),1);
 assert.equal(evidence.excerpt,fs.readFileSync(evidence.file,'utf8').split('\n').slice(evidence.startLine-1,evidence.endLine).join('\n'));
}
console.log('SCHEMA_AUDIT_COPY_GREEN: two exact current-source copies; original historical excerpts unchanged');
