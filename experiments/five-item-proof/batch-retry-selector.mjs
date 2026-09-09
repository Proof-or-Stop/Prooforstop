import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeCausalEvidence,preflightCausalEvidence,DEFAULT_CAUSAL_SELECTOR_POLICY,computeCausalReceiptHash,verifyCausalEvidenceReceipt,CAUSAL_AUTHORITY_KEY_FILE,createCausalEvidenceBatch} from '../../packages/main/dist/core/causal-evidence.js';
import {createHash} from 'node:crypto';
import {signCanonical} from '../../packages/main/dist/core/authority-signing.js';
const root=mkdtempSync(join(tmpdir(),'selector-contract-'));
try {
 const identity={storyId:'B-selector-contract',cwd:root,command:{executable:process.execPath,args:['-e','opaque test witness']},inputs:{materialHash:'test-material'},storyFilesHash:'test-story',effectiveEnvironment:{TEST_SECRET_TOKEN:'private-value-123'},runtimeVersion:process.version,toolVersion:'test',selectorPolicy:DEFAULT_CAUSAL_SELECTOR_POLICY,computeCausalReceiptHash,verifyCausalEvidenceReceipt,CAUSAL_AUTHORITY_KEY_FILE,createCausalEvidenceBatch};
 const facts={cli:{available:true,path:process.execPath},worktree:{expected:root,actual:root},gitIndex:{readable:true,path:join(root,'index'),contentDigest:'index'},gitMaterial:{available:true,headHash:'head',materialHash:'test-material',storyFilesHash:'test-story'},writerLease:{available:true,valid:true},providerCapability:{required:['bounded-output'],available:['bounded-output']},resources:{required:{slots:1},available:{slots:1}},evidenceTarget:{writable:true,path:root},sideChannel:{available:true,maxOutputChars:12000,maxProgressEvents:1}};
 const preflight=preflightCausalEvidence(facts,()=>true,identity);
 const memory=()=>{const data=new Map();return {readCausalEvidenceReceipt:(_s,k)=>data.get(k)??null,writeCausalEvidenceReceipt:(_s,r)=>data.set(r.executionKey,structuredClone(r))};};
 const run=(store,output,selector)=>executeCausalEvidence({identity,preflight,revalidateBeforeRun:()=>true,receiptStore:store,selector,run:async()=>({code:0,output})});
 const failures=[];
 const check=async(name,fn)=>{try{await fn();console.log(name+' PASS');}catch(e){failures.push(name+': '+e.message);console.log(name+' FAIL: '+e.message);}};
 const pause=ms=>new Promise(r=>setTimeout(r,ms));
 await check('distinct selectors retain truthful fallback witnesses',async()=>{
  const batch=createCausalEvidenceBatch();let calls=0;
  const invoke=selector=>executeCausalEvidence({identity,preflight,batch,revalidateBeforeRun:()=>true,selector,run:async()=>{calls++;await pause(5);return {code:0,output:'FIRST_MARK SECOND_MARK THIRD_MARK'+'x'.repeat(20000)};}});
  const values=await Promise.all(['FIRST_MARK','SECOND_MARK','THIRD_MARK'].map(invoke));
  assert.ok(values.every(x=>x.verdict.result==='pass'),'All three selectors were printed by the actual runner');
  for(let i=0;i<values.length;i++)assert.equal(values[i].receipt.selectorWitness.selectorDigest,createHash('sha256').update(['FIRST_MARK','SECOND_MARK','THIRD_MARK'][i]).digest('hex'),'Each fallback receipt must prove its own selector');
  console.log(JSON.stringify({fallbackCalls:calls}));
 });
 await check('late caller joins the in-flight retry',async()=>{
  const batch=createCausalEvidenceBatch();let calls=0,releaseFirst,releaseRetry,enteredRetry;
  const firstGate=new Promise(r=>releaseFirst=r),retryGate=new Promise(r=>releaseRetry=r),retryStarted=new Promise(r=>enteredRetry=r);
  const invoke=()=>executeCausalEvidence({identity,preflight,batch,revalidateBeforeRun:()=>true,selector:'OK',run:async()=>{const n=++calls;if(n===1){await firstGate;return {code:1,output:'failed'};}if(n===2){enteredRetry();await retryGate;}return {code:0,output:'OK'};}});
  const a=invoke(),b=invoke();releaseFirst();await retryStarted;const c=invoke();await pause(10);releaseRetry();const result=await Promise.all([a,b,c]);
  assert.equal(result[0].verdict.result,'fail');assert.ok(result.slice(1).every(x=>x.verdict.result==='pass'));assert.equal(calls,2,'Late retry subscriber must not launch a third identical command');
 });
 await check('completed output publication retries without another child',async()=>{
  let calls=0,writes=0;const outputs=new Map();const store={...memory(),readCausalSelectorOutput:(_s,k)=>outputs.get(k),writeCausalSelectorOutput:(_s,k,out)=>{writes++;if(writes===1)throw new Error('TRANSIENT_OUTPUT_WRITE_FAILURE');outputs.set(k,out);}};
  const result=await executeCausalEvidence({identity,preflight,revalidateBeforeRun:()=>true,receiptStore:store,selector:'OK',run:async()=>{calls++;return {code:0,output:'OK'+'x'.repeat(20000)};}});
  assert.equal(result.verdict.result,'pass');assert.equal(calls,1);assert.equal(writes,2);assert.ok(verifyCausalEvidenceReceipt(result.receipt));
  let permanentCalls=0,permanentWrites=0;const broken={...memory(),readCausalSelectorOutput:()=>undefined,writeCausalSelectorOutput:()=>{permanentWrites++;throw new Error('PERMANENT_OUTPUT_WRITE_FAILURE');}};
  await assert.rejects(()=>executeCausalEvidence({identity,preflight,revalidateBeforeRun:()=>true,receiptStore:broken,selector:'OK',run:async()=>{permanentCalls++;return {code:0,output:'OK'+'x'.repeat(20000)};}}),/PERMANENT_OUTPUT_WRITE_FAILURE/);
  assert.equal(permanentCalls,1);assert.equal(permanentWrites,2);
 });
 await check('completed receipt publication retries without another child',async()=>{
  let calls=0,writes=0;const backing=memory(),store={readCausalEvidenceReceipt:backing.readCausalEvidenceReceipt,writeCausalEvidenceReceipt:(story,receipt)=>{writes++;if(writes===1)throw new Error('TRANSIENT_RECEIPT_WRITE_FAILURE');backing.writeCausalEvidenceReceipt(story,receipt);}};
  const result=await executeCausalEvidence({identity,preflight,revalidateBeforeRun:()=>true,receiptStore:store,selector:'OK',run:async()=>{calls++;return {code:0,output:'OK'};}});
  assert.equal(result.verdict.result,'pass');assert.equal(calls,1);assert.equal(writes,2);assert.equal(store.readCausalEvidenceReceipt(identity.storyId,result.key.key).receiptHash,result.receipt.receiptHash);
  let permanentCalls=0,permanentWrites=0;const broken={...memory(),writeCausalEvidenceReceipt:()=>{permanentWrites++;throw new Error('PERMANENT_RECEIPT_WRITE_FAILURE');}};
  await assert.rejects(()=>executeCausalEvidence({identity,preflight,revalidateBeforeRun:()=>true,receiptStore:broken,selector:'OK',run:async()=>{permanentCalls++;return {code:0,output:'OK'};}}),/PERMANENT_RECEIPT_WRITE_FAILURE/);
  assert.equal(permanentCalls,1);assert.equal(permanentWrites,2);
 });
 assert.deepEqual(failures,[],'BATCH_RETRY_SELECTOR_CONTRACT');console.log('BATCH_RETRY_SELECTOR_GREEN');

} finally {rmSync(root,{recursive:true,force:true});}
