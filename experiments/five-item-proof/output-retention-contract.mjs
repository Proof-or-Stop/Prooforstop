import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeCausalEvidence,preflightCausalEvidence,DEFAULT_CAUSAL_SELECTOR_POLICY} from '../../packages/main/dist/core/causal-evidence.js';
const root=mkdtempSync(join(tmpdir(),'selector-contract-'));
try {
 const identity={storyId:'B-selector-contract',cwd:root,command:{executable:process.execPath,args:['-e','opaque test witness']},inputs:{materialHash:'test-material'},storyFilesHash:'test-story',effectiveEnvironment:{TEST_SECRET_TOKEN:'private-value-123'},runtimeVersion:process.version,toolVersion:'test',selectorPolicy:DEFAULT_CAUSAL_SELECTOR_POLICY};
 const facts={cli:{available:true,path:process.execPath},worktree:{expected:root,actual:root},gitIndex:{readable:true,path:join(root,'index'),contentDigest:'index'},gitMaterial:{available:true,headHash:'head',materialHash:'test-material',storyFilesHash:'test-story'},writerLease:{available:true,valid:true},providerCapability:{required:['bounded-output'],available:['bounded-output']},resources:{required:{slots:1},available:{slots:1}},evidenceTarget:{writable:true,path:root},sideChannel:{available:true,maxOutputChars:12000,maxProgressEvents:1}};
 const preflight=preflightCausalEvidence(facts,()=>true,identity);
 const memory=()=>{const data=new Map();return {readCausalEvidenceReceipt:(_s,k)=>data.get(k)??null,writeCausalEvidenceReceipt:(_s,r)=>data.set(r.executionKey,structuredClone(r))};};
 const run=(store,output,selector)=>executeCausalEvidence({identity,preflight,revalidateBeforeRun:()=>true,receiptStore:store,selector,run:async()=>({code:0,output})});
 const oldStore=memory();await run(oldStore,'SELECTOR_OK'+ 'x'.repeat(20000),'SELECTOR_OK');
 try {assert.equal((await run(oldStore,'SELECTOR_OK'+ 'x'.repeat(20000),'SELECTOR_OK')).verdict.result,'pass');}
 catch(error){assert.fail('OPTIONAL_STORE_BROKE_SELECTOR: '+error);}
 let writtenBytes=0;const outputs=new Map();const capable={...memory(),writeCausalSelectorOutput:(_s,k,out)=>{writtenBytes+=Buffer.byteLength(JSON.stringify({output:out}));outputs.set(k,out);},readCausalSelectorOutput:(_s,k)=>outputs.get(k)};
 const large=await run(capable,'x'.repeat(2*1024*1024)+'REAL_END','REAL_END');
 assert.equal(large.verdict.result,'pass');assert.ok(writtenBytes<=1024*1024,'OUTPUT_RETENTION_UNBOUNDED');
 const secret=await run(memory(),'private-value-123','<redacted>');assert.equal(secret.verdict.result,'fail','SYNTHETIC_REDACTION_BECAME_PROOF');
 let outputReads=0;const exitStore={...memory(),writeCausalSelectorOutput:()=>{},readCausalSelectorOutput:()=>{outputReads++;throw new Error('must not read output for exit-only proof');}};
 assert.equal((await run(exitStore,'z'.repeat(20000),'')).verdict.result,'pass');
 assert.equal((await run(exitStore,'z'.repeat(20000),'')).verdict.result,'pass');assert.equal(outputReads,0,'EXIT_ONLY_READ_SELECTOR_BYTES');
 console.log('OUTPUT_RETENTION_COMPATIBILITY_BOUND_AND_SYNTHETIC_MARKER_GREEN');
} finally {rmSync(root,{recursive:true,force:true});}
