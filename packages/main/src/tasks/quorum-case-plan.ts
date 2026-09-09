import assert from 'node:assert/strict';
import {QUORUM_CASES} from './quorum-case-registry.js';

export interface QuorumCaseResult {id:string;bodyDigest:string;elapsedMs:number}
export interface QuorumRunResult {schema:'quorum-case-run.v1';cases:QuorumCaseResult[];manifest:Array<{id:string;name:string;group:string;bodyDigest:string}>}
const ids=QUORUM_CASES.map(c=>c.id);
assert.equal(ids.length,73,'Quorum inventory additions need explicit coverage review');
assert.equal(new Set(ids).size,ids.length,'DUPLICATE_QUORUM_REGISTRATION');
assert.equal(new Set(QUORUM_CASES.map(c=>c.name)).size,ids.length,'DUPLICATE_QUORUM_CASE_NAME');

export function validateQuorumSelection(selected:readonly string[]):void {
  assert.ok(selected.length>0,'EMPTY_QUORUM_SELECTION');
  assert.equal(new Set(selected).size,selected.length,'DUPLICATE_QUORUM_SELECTION');
  for(const id of selected)assert.ok(ids.includes(id),'UNKNOWN_QUORUM_CASE '+id);
  for(const group of new Set(QUORUM_CASES.map(c=>c.group))){
    const members=QUORUM_CASES.filter(c=>c.group===group).map(c=>c.id);
    const count=members.filter(id=>selected.includes(id)).length;
    assert.ok(count===0||count===members.length,'QUORUM_DEPENDENCY_SPLIT '+group);
  }
}
export function validateQuorumPlan(plan:readonly (readonly string[])[]):void {
  assert.ok(plan.length>0,'EMPTY_QUORUM_PLAN');
  for(const selected of plan)validateQuorumSelection(selected);
  const actual=plan.flat();assert.equal(new Set(actual).size,actual.length,'DUPLICATE_QUORUM_PLAN_CASE');
  assert.deepEqual([...actual].sort(),[...ids].sort(),'MISSING_QUORUM_PLAN_CASE');
}
export function makeQuorumPlan(jobs:number):string[][] {
  assert.ok(Number.isInteger(jobs)&&jobs>=1&&jobs<=4,'QUORUM_JOBS_OUT_OF_RANGE');
  const groups=[...new Set(QUORUM_CASES.map(c=>c.group))].map(group=>QUORUM_CASES.filter(c=>c.group===group).map(c=>c.id));
  groups.sort((a,b)=>b.length-a.length||a[0].localeCompare(b[0]));
  const plan=Array.from({length:jobs},()=>[] as string[]);
  for(const group of groups){const smallest=plan.reduce((a,b)=>b.length<a.length?b:a);smallest.push(...group);}
  for(const selected of plan)selected.sort((a,b)=>ids.indexOf(a)-ids.indexOf(b));
  validateQuorumPlan(plan);return plan;
}
export function verifyQuorumResults(plan:readonly (readonly string[])[],results:readonly QuorumRunResult[],manifest:QuorumRunResult['manifest']):void {
  validateQuorumPlan(plan);assert.equal(results.length,plan.length,'MISSING_QUORUM_SHARD_RESULT');
  for(let index=0;index<plan.length;index++){
    const result=results[index];assert.equal(result.schema,'quorum-case-run.v1','INVALID_QUORUM_SHARD_SCHEMA');
    assert.deepEqual(result.manifest,manifest,'QUORUM_SOURCE_OR_MANIFEST_DRIFT');
    assert.deepEqual(result.cases.map(c=>c.id),plan[index],'QUORUM_SHARD_COVERAGE_MISMATCH');
    for(const entry of result.cases)assert.equal(entry.bodyDigest,manifest.find(c=>c.id===entry.id)?.bodyDigest,'QUORUM_CASE_BODY_DRIFT');
  }
}
