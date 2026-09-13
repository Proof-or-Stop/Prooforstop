import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StoryStore } from '../../packages/main/dist/core/store.js';
import { boundPersistedValidationEvidence, VALIDATION_EVIDENCE_BOUND_BYTES as limit } from '../../packages/main/dist/core/validation-executor.js';
import { buildVerificationCoverage, getBlockingVerificationEvidenceIssues } from '../../packages/main/dist/core/verification.js';
const rows = [], failures = [];
const check = (name, fn) => { try { rows.push({name, ...fn(), passed:true}); } catch(e) { failures.push(name); rows.push({name, passed:false, error:e.message}); } };
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-closure-'));
try {
 const store = new StoryStore(temp), id = 'B-lab-writer', file = path.join(store.storyDirPath(id), 'test-evidence.json');
 const initial = { command:'lab control', output:'small', result:'PASS', timestamp:'2026-09-13T00:00:00.000Z' };
 store.writeTestEvidence(id, initial);
 const original = fs.readFileSync(file);
 check('post-measure mutation cannot overwrite evidence', () => {
  const bound = boundPersistedValidationEvidence({result:{allPass:true,status:'PASS',commands:[]},buildRecord:output=>({...initial,output})});
  assert.ok(bound.withinBound);
  bound.record.output += 'x'.repeat(60*1024*1024);
  let error; try {store.writeTestEvidence(id,bound.record);} catch(e) {error=e;}
  const actual = fs.statSync(file).size;
  console.log(JSON.stringify({case:'post-measure mutation',measuredBytes:bound.fileBytes,attemptedBytes:Buffer.byteLength(JSON.stringify(bound.record,null,2)+'\n'),actualBytes:actual,limit,rejected:!!error}));
  assert.match(error?.message ?? '', /VALIDATION_EVIDENCE_WRITE_BOUND_EXCEEDED/);
  assert.deepEqual(fs.readFileSync(file), original);
  return {measuredBytes:bound.fileBytes,actualBytes:actual,limit};
 });
 check('exact bound admitted; one UTF-8 byte over rejected atomically', () => {
  const base={...initial,output:''}, overhead=Buffer.byteLength(JSON.stringify(base,null,2)+'\n');
  const exact={...base,output:'x'.repeat(limit-overhead)};
  store.writeTestEvidence(id,exact);assert.equal(fs.statSync(file).size,limit);
  assert.throws(()=>store.writeTestEvidence(id,{...exact,output:exact.output+'x'}),/VALIDATION_EVIDENCE_WRITE_BOUND_EXCEEDED/);
  assert.equal(fs.statSync(file).size,limit);
  assert.throws(()=>store.writeTestEvidence(id,{...base,output:'界'.repeat(Math.ceil(limit/3))}),/VALIDATION_EVIDENCE_WRITE_BOUND_EXCEEDED/);
  assert.ok(fs.readdirSync(path.dirname(file)).every(p=>!p.includes('.tmp-')));
  return {exactBytes:limit,oneByteOverRejected:true,utf8Rejected:true};
 });
 check('writer serializes once and measures those exact bytes', () => {
  let calls=0; const record={toJSON(){ calls++; return {...initial,output:calls===1?'small':'x'.repeat(60*1024*1024)}; }};
  store.writeTestEvidence(id,record);assert.equal(calls,1);assert.equal(JSON.parse(fs.readFileSync(file)).output,'small');
  return {serializationCalls:calls};
 });
 const covered={id:'CHK-001',status:'done',verificationIntent:{happy:[{id:'COVERED',desc:'Control receipt',type:'docs',priority:'must'}]},verificationEvidence:[{intentRef:'COVERED',result:'pass',type:'manual',timestamp:'2026-09-13T00:00:00.000Z'}]};
 check('a completely unbound checklist item cannot disappear from coverage',()=>{
  const cl={items:[covered,{id:'CHK-006',status:'done'}]};
  const report=buildVerificationCoverage(cl);
  console.log(JSON.stringify({case:'unbound checklist item',total:report.total,covered:report.covered,missingRequired:report.missingRequired,issues:getBlockingVerificationEvidenceIssues(cl)}));
  assert.equal(report.missingRequired,1);
  assert.ok(getBlockingVerificationEvidenceIssues(cl).some(x=>x.includes('CHK-006')&&x.includes('verificationIntent')));
  return {missingRequired:report.missingRequired};
 });
 check('withdrawn items excluded and historical all-empty compatibility preserved',()=>{
  assert.equal(buildVerificationCoverage({items:[covered,{id:'CHK-X',status:'withdrawn'}]}).missingRequired,0);
  assert.equal(buildVerificationCoverage({items:[{id:'CHK-X',status:'done'}]}).total,0);
  assert.equal(buildVerificationCoverage({items:[covered]}).missingRequired,0);
  return {withdrawnExcluded:true,allEmptyPolicyUnchanged:true};
 });
} finally {fs.rmSync(temp,{recursive:true,force:true});}
console.log(JSON.stringify({rows,failed:failures.length},null,2));
if(failures.length){console.error('ACCEPTANCE_CLOSURE_REGRESSION: '+failures.join('; '));process.exitCode=1;}
else console.log('ACCEPTANCE_CLOSURE_GREEN');
