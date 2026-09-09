import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {QUORUM_CASES} from '../../packages/main/dist/tasks/quorum-case-registry.js';
import {makeQuorumPlan,validateQuorumPlan,validateQuorumSelection,verifyQuorumResults} from '../../packages/main/dist/tasks/quorum-case-plan.js';
import {runParallelQuorum} from '../../packages/main/dist/tasks/quorum-case-parallel.js';
const plan=makeQuorumPlan(4);
const manifest=QUORUM_CASES.map(c=>({...c,bodyDigest:'fixture-body-'+c.id}));
const results=plan.map(ids=>({schema:'quorum-case-run.v1',manifest,cases:ids.map(id=>({id,bodyDigest:'fixture-body-'+id,elapsedMs:1}))}));
verifyQuorumResults(plan,results,manifest);
assert.throws(()=>validateQuorumSelection([]),/EMPTY/);
assert.throws(()=>validateQuorumSelection(['UNKNOWN']),/UNKNOWN/);
assert.throws(()=>validateQuorumSelection([plan[1][0],plan[1][0]]),/DUPLICATE/);
assert.throws(()=>validateQuorumSelection(['Q024']),/DEPENDENCY_SPLIT/);
const missing=structuredClone(plan);missing[1].pop();assert.throws(()=>validateQuorumPlan(missing),/MISSING/);
const duplicate=structuredClone(plan);duplicate[1].push(plan[2][0]);assert.throws(()=>validateQuorumPlan(duplicate),/DUPLICATE/);
const dropped=structuredClone(results);dropped[2].cases.pop();assert.throws(()=>verifyQuorumResults(plan,dropped,manifest),/COVERAGE/);
const renamed=structuredClone(results);renamed[2].manifest[0].name+=' changed';assert.throws(()=>verifyQuorumResults(plan,renamed,manifest),/DRIFT/);
const changed=structuredClone(results);changed[2].cases[0].bodyDigest='wrong';assert.throws(()=>verifyQuorumResults(plan,changed,manifest),/BODY_DRIFT/);
// Controlled protocol child: this tests parent failure propagation, not execution
// of the real quorum assertions. The full 73-case timing run supplies that proof.
const dir=mkdtempSync(join(tmpdir(),'quorum-parent-negative-'));
try{
 const script=join(dir,'child.mjs'),failedId=plan[1][0];
 writeFileSync(script,`import fs from 'node:fs';const manifest=${JSON.stringify(manifest)};if(process.argv.includes('--list-cases')){console.log('QUORUM_CASE_MANIFEST:'+JSON.stringify(manifest));}else{const ids=process.argv.find(x=>x.startsWith('--case-ids=')).slice(11).split(',');if(ids.includes(${JSON.stringify(failedId)}))process.exit(42);const output=process.argv.find(x=>x.startsWith('--result-file=')).slice(14);fs.writeFileSync(output,JSON.stringify({schema:'quorum-case-run.v1',manifest,cases:ids.map(id=>({id,bodyDigest:'fixture-body-'+id,elapsedMs:1}))}));}`);
 await assert.rejects(()=>runParallelQuorum(script,4),/QUORUM_SHARD_FAILED 1/);
}finally{rmSync(dir,{recursive:true,force:true});}
console.log('QUORUM_PLAN_CONTROLS_GREEN: complete and exactly once, atomic dependencies, source/name drift and non-first child failure');
