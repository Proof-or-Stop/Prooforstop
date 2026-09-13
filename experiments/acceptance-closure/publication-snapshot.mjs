import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {StoryStore} from '../../packages/main/dist/core/store.js';
import {boundPersistedValidationEvidence,VALIDATION_EVIDENCE_BOUND_BYTES as limit} from '../../packages/main/dist/core/validation-executor.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'lab-publication-snapshot-'));
const hash=s=>createHash('sha256').update(s).digest('hex');
const rows=[], failures=[];
const test=(name,run)=>{try{rows.push({name,...run(),pass:true});}catch(e){rows.push({name,pass:false,error:e.message});failures.push(name);}};
try {
 const store=new StoryStore(root), id='B-lab-snapshot';
 const record={command:'lab',result:'PASS',timestamp:'2026-09-13T00:00:00.000Z',output:'verified result'};
 const target=path.join(store.storyDirPath(id),'test-evidence.json');
 const prepare=data=>store.prepareTestEvidence(id,data);
 const publish=token=>store.writePreparedTestEvidence(id,token);
 test('post-check mutation cannot cause late size refusal or change published proof',()=>{
  store.writeTestEvidence(id,{...record,output:'old result'});
  const data={...record},token=prepare(data);
  data.output='x'.repeat(60*1024*1024);
  let failure;try{publish(token);}catch(e){failure=e.message;}
  const actual=fs.readFileSync(target,'utf8');
  console.log(JSON.stringify({failure:failure??null,expectedBytes:token.bytes,actualBytes:Buffer.byteLength(actual),sameDigest:hash(actual)===token.sha256}));
  assert.equal(failure,undefined,'LATE_SIZE_REFUSAL_AFTER_CHECK');
  assert.equal(hash(actual),token.sha256);assert.equal(JSON.parse(actual).output,'verified result');
  return {bytes:token.bytes,sameDigest:true};
 });
 test('small post-check mutation cannot desynchronize commit digest from written bytes',()=>{
  const data={...record},token=prepare(data);data.output='a different result';publish(token);
  assert.equal(hash(fs.readFileSync(target)),token.sha256,'PUBLICATION_DIGEST_DRIFT');
  return {digestMatches:true};
 });
 test('oversized preparation preserves previous proof; valid retry succeeds',()=>{
  store.writeTestEvidence(id,record);const old=fs.readFileSync(target);
  assert.throws(()=>{const token=prepare({...record,output:'x'.repeat(limit)});publish(token);},/VALIDATION_EVIDENCE_WRITE_BOUND_EXCEEDED/);
  assert.deepEqual(fs.readFileSync(target),old);
  publish(prepare({...record,output:'retry result'}));assert.equal(JSON.parse(fs.readFileSync(target)).output,'retry result');
  return {oldPreserved:true,retry:true};
 });
 test('normal large output is reduced before final publication',()=>{
  const result={allPass:true,status:'PASS',commands:Array.from({length:400},(_,i)=>({label:'command-'+i,command:'node',args:[],code:0,stdout:'"'.repeat(40000),stderr:''}))};
  const reduced=boundPersistedValidationEvidence({result,buildRecord:output=>({...record,output})});
  assert.equal(reduced.withinBound,true);assert.ok(reduced.record);const token=prepare(reduced.record);publish(token);
  const size=fs.statSync(target).size;assert.ok(size<=limit);assert.equal(size,token.bytes);
  return {commands:400,bytes:size,limit};
 });
}finally{fs.rmSync(root,{recursive:true,force:true});}
console.log(JSON.stringify({rows,failed:failures.length},null,2));
if(failures.length){console.error('PUBLICATION_SNAPSHOT_RED '+failures.join('; '));process.exitCode=1;}else console.log('PUBLICATION_SNAPSHOT_GREEN');
