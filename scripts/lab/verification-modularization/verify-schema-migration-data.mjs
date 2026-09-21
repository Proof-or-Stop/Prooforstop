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
assert.deepEqual(after,expected);assert.deepEqual(CURRENT_COMPATIBLE_SCHEMA_ROWS,after);
console.log('SCHEMA_MIGRATION_DATA_GREEN: 12 source rows -> 19 module rows; all occurrence totals retained');
const {execFileSync}=await import('node:child_process');
const oldArchive=JSON.parse(execFileSync('git',['show',excerpt.base+':'+excerpt.before.path],{encoding:'utf8',maxBuffer:32*1024*1024}));
const currentArchive=JSON.parse(fs.readFileSync(excerpt.after.path));
for(const proof of excerpt.excerptProof){assert.equal(currentArchive.entries.find(row=>row.id===proof.id).requiredEvidence[proof.evidenceIndex].excerpt,oldArchive.entries.find(row=>row.id===proof.id).requiredEvidence[proof.evidenceIndex].excerpt,'archived excerpt decoded bytes are unchanged');}
console.log('SCHEMA_ARCHIVE_SERIALIZATION_GREEN: identical decoded excerpts retain the same count');
