#!/usr/bin/env node
// Experimental reporting integrity only; never a product/performance verdict.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const dir=dirname(fileURLToPath(import.meta.url));
const sha=x=>createHash('sha256').update(x).digest('hex');
const text=p=>readFileSync(resolve(dir,p));
const ledger=JSON.parse(text('acceptance.json'));
const statuses=new Set(['NOT_RUN','SETUP_BLOCKED','BASELINE_OBSERVED','TARGET_RED','MECHANISM_GREEN','BOUNDED_PERFORMANCE_PASS','EXPECTED_REFUSAL_PASS','INCONCLUSIVE','FAILED','COHORT_INCOMPLETE']);
const required=['id','claimScope','status','redEvidence','greenEvidence','before','after','unit','coverage','completionCounts','cost','uncertainty','limitations','remainingPrerequisites','evidence'];
function aggregate(children){
 const s=children.map(x=>x.status);
 if(s.includes('FAILED'))return 'FAILED';
 if(s.every(x=>x==='NOT_RUN'))return 'NOT_RUN';
 if(s.includes('SETUP_BLOCKED'))return 'SETUP_BLOCKED';
 if(s.includes('NOT_RUN')||s.includes('COHORT_INCOMPLETE'))return 'COHORT_INCOMPLETE';
 if(s.includes('INCONCLUSIVE'))return 'INCONCLUSIVE';
 if(s.includes('BASELINE_OBSERVED'))return 'BASELINE_OBSERVED';
 if(s.includes('TARGET_RED'))return 'TARGET_RED';
 if(s.every(x=>x==='BOUNDED_PERFORMANCE_PASS'))return 'BOUNDED_PERFORMANCE_PASS';
 if(s.every(x=>x==='EXPECTED_REFUSAL_PASS'))return 'EXPECTED_REFUSAL_PASS';
 return 'MECHANISM_GREEN';
}
function checkRow(row){
 for(const field of required)assert.ok(Object.hasOwn(row,field),`${row.id}: missing ${field}`);
 assert.ok(typeof row.claimScope==='string'&&row.claimScope.trim(),`${row.id}: empty claimScope`);
 assert.ok(Array.isArray(row.limitations)&&row.limitations.length,`${row.id}: missing limitations`);
 assert.ok(statuses.has(row.status),`${row.id}: unknown status`);
 assert.ok(Array.isArray(row.evidence),`${row.id}: evidence must be an array`);
 if(!['NOT_RUN','SETUP_BLOCKED'].includes(row.status))assert.ok(row.evidence.length,`${row.id}: progress without evidence`);
 if(row.status==='NOT_RUN')for(const key of ['redEvidence','greenEvidence','before','after','coverage','completionCounts','cost'])assert.equal(row[key],null,`${row.id}: NOT_RUN has claimed ${key}`);
}
function verify(value){
 assert.equal(value.schema,'lab.remaining-delivery.verification-plan.v1');
 assert.equal(value.gateEvidence,false);
 assert.equal(value.planSha256,sha(text('PLAN.md')),'plan bytes changed without a new ledger digest');
 assert.equal(value.items.length,6);assert.deepEqual(value.items.map(x=>x.id),['V1','V2','V3','V4','V5','V6']);
 assert.ok(Array.isArray(value.amendments)&&value.amendments.length>0,'missing amendment provenance');
 let previous=[];
 for(const row of value.amendments){
  assert.ok(row.reason?.length>=20,'amendment needs a substantive reason');
  assert.equal(row.previousPlanSha256,sha(text(row.previousPlanPath)),'previous plan digest mismatch');
  assert.equal(row.previousLedgerSha256,sha(text(row.previousLedgerPath)),'previous ledger digest mismatch');
  const old=JSON.parse(text(row.previousLedgerPath));
  assert.equal(old.planSha256,row.previousPlanSha256,'previous ledger did not bind its plan');
  assert.deepEqual(old.amendments||[],previous,'amendment chain discontinuity');
  previous=[...previous,row];
 }
 for(const row of value.items){
  checkRow(row);assert.ok(Array.isArray(row.subclaims)&&row.subclaims.length,`${row.id}: missing subclaims`);
  row.subclaims.forEach(checkRow);
  assert.equal(row.status,aggregate(row.subclaims),`${row.id}: parent overstates or hides subclaim status`);
 }
}
verify(ledger);
const controls=[];
if(process.argv.includes('--self-test')){
 const reject=(name,mutate)=>{const copy=structuredClone(ledger);mutate(copy);assert.throws(()=>verify(copy),undefined,name+' must be refused');controls.push({name,rejected:true});};
 reject('missing-parent-scope',x=>delete x.items[0].claimScope);
 reject('missing-child-scope',x=>delete x.items[0].subclaims[0].claimScope);
 reject('unrun-child-promoted-to-parent-pass',x=>{x.items[0].status='BOUNDED_PERFORMANCE_PASS';x.items[0].evidence=['nonempty-but-not-a-claim-waiver'];});
 reject('child-progress-without-evidence',x=>x.items[0].subclaims[0].status='MECHANISM_GREEN');
 reject('unrun-row-with-timing',x=>x.items[0].before=0);
 reject('missing-limitations',x=>x.items[0].limitations=[]);
 reject('unknown-status',x=>x.items[0].status='DONE');
 reject('stale-plan-digest',x=>x.planSha256='0'.repeat(64));
 reject('deleted-amendment-history',x=>x.amendments=[]);
 reject('tampered-previous-plan-digest',x=>x.amendments[0].previousPlanSha256='0'.repeat(64));
 for(const [input,expected] of [
  [['NOT_RUN','NOT_RUN'],'NOT_RUN'],[['MECHANISM_GREEN','NOT_RUN'],'COHORT_INCOMPLETE'],
  [['BOUNDED_PERFORMANCE_PASS','SETUP_BLOCKED'],'SETUP_BLOCKED'],[['FAILED','NOT_RUN'],'FAILED'],
  [['BOUNDED_PERFORMANCE_PASS','MECHANISM_GREEN'],'MECHANISM_GREEN'],
  [['BOUNDED_PERFORMANCE_PASS','BOUNDED_PERFORMANCE_PASS'],'BOUNDED_PERFORMANCE_PASS'],
  [['EXPECTED_REFUSAL_PASS','MECHANISM_GREEN'],'MECHANISM_GREEN'],[['INCONCLUSIVE','MECHANISM_GREEN'],'INCONCLUSIVE']
 ])assert.equal(aggregate(input.map(status=>({status}))),expected);
}
console.log(JSON.stringify({schema:'lab.plan-integrity-check.v1',pass:true,gateEvidence:false,planSha256:ledger.planSha256,itemCount:ledger.items.length,statuses:ledger.items.map(x=>({id:x.id,status:x.status})),negativeControls:controls,scope:'Plan ledger shape, conservative aggregation and revision provenance only. Does not validate future execution receipts or prove a product or performance GREEN.'},null,2));
