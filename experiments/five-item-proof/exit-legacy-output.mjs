import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeCausalEvidence,preflightCausalEvidence,DEFAULT_CAUSAL_SELECTOR_POLICY,computeCausalReceiptHash,verifyCausalEvidenceReceipt,CAUSAL_AUTHORITY_KEY_FILE} from '../../packages/main/dist/core/causal-evidence.js';
import {signCanonical} from '../../packages/main/dist/core/authority-signing.js';
const root=mkdtempSync(join(tmpdir(),'selector-contract-'));
try {
 const identity={storyId:'B-selector-contract',cwd:root,command:{executable:process.execPath,args:['-e','opaque test witness']},inputs:{materialHash:'test-material'},storyFilesHash:'test-story',effectiveEnvironment:{TEST_SECRET_TOKEN:'private-value-123'},runtimeVersion:process.version,toolVersion:'test',selectorPolicy:DEFAULT_CAUSAL_SELECTOR_POLICY,computeCausalReceiptHash,verifyCausalEvidenceReceipt,CAUSAL_AUTHORITY_KEY_FILE};
 const facts={cli:{available:true,path:process.execPath},worktree:{expected:root,actual:root},gitIndex:{readable:true,path:join(root,'index'),contentDigest:'index'},gitMaterial:{available:true,headHash:'head',materialHash:'test-material',storyFilesHash:'test-story'},writerLease:{available:true,valid:true},providerCapability:{required:['bounded-output'],available:['bounded-output']},resources:{required:{slots:1},available:{slots:1}},evidenceTarget:{writable:true,path:root},sideChannel:{available:true,maxOutputChars:12000,maxProgressEvents:1}};
 const preflight=preflightCausalEvidence(facts,()=>true,identity);
 const memory=()=>{const data=new Map();return {readCausalEvidenceReceipt:(_s,k)=>data.get(k)??null,writeCausalEvidenceReceipt:(_s,r)=>data.set(r.executionKey,structuredClone(r))};};
 const run=(store,output,selector)=>executeCausalEvidence({identity,preflight,revalidateBeforeRun:()=>true,receiptStore:store,selector,run:async()=>({code:0,output})});
 const failures=[];
 const check=async(name,fn)=>{try{await fn();console.log(name+' PASS');}catch(e){failures.push(name+': '+e.message);console.log(name+' FAIL: '+e.message);}};
 await check('exit-only long output reuses with zero output reads',async()=>{
  let calls=0,reads=0;const output='x'.repeat(20000),store={...memory(),writeCausalSelectorOutput:()=>{},readCausalSelectorOutput:()=>{reads++;throw new Error('Unexpected output read');}};
  const invoke=()=>executeCausalEvidence({identity,preflight,revalidateBeforeRun:()=>true,receiptStore:store,selector:'',run:async()=>{calls++;return {code:0,output};}});
  assert.equal((await invoke()).verdict.result,'pass');assert.equal((await invoke()).verdict.result,'pass');assert.equal(calls,1);assert.equal(reads,0);
 });
 for(const [name,text] of [['redaction','<redacted>'],['gap','<causal-output-gap>']])await check('legacy '+name+' cannot prove synthetic display text',async()=>{
  const store=memory(),fresh=await run(store,'genuine-output','genuine-output');
  // Reconstruct the historical v1 producer shape under this private fixture's own
  // signing key. This is a valid legacy credential, not an unsigned corruption test.
  const legacy=structuredClone(fresh.receipt);delete legacy.selectorProbe;legacy.outputProbe=text;legacy.outputTail=text;legacy.outputLength=name==='gap'?30000:16;
  const {receiptHash,signature,signerPublicKey,...payload}=legacy;
  legacy.signature=signCanonical(payload,readFileSync(join(root,'.proof-or-stop/runtime',CAUSAL_AUTHORITY_KEY_FILE),'utf8').trim());legacy.receiptHash=computeCausalReceiptHash(legacy);
  assert.ok(verifyCausalEvidenceReceipt(legacy),'The historical credential must verify before selector consumption');store.writeCausalEvidenceReceipt(identity.storyId,legacy);
  await assert.rejects(()=>run(store,'must not rerun',text),/causal_legacy_selector_output_unproven/);
 });
 assert.deepEqual(failures,[],'EXIT_OR_LEGACY_SELECTOR_CONTRACT');
 console.log('EXIT_ONLY_REUSE_AND_LEGACY_SYNTHETIC_REFUSAL_GREEN');

} finally {rmSync(root,{recursive:true,force:true});}
