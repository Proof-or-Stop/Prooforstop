/** Disposable synthetic inventory; real handler, Git publication and lineage consumer. */
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {StoryStore} from '../dist/core/store.js';
import {acquireOwnerLease} from '../dist/core/story-owner-lease.js';
import {currentGitHead,currentMaterialHash,currentStoryFilesHash} from '../dist/core/evidence-freshness.js';
import {createCertificationWindowHandlers} from '../dist/handlers/certification-window.js';
import {currentPrecertFastIdentity} from '../dist/handlers/validation-identity.js';
import {isVerifiedReviewMaintenanceCommit} from '../dist/core/review-maintenance-lineage.js';
import {setReviewInventoryAdmitApisForTest,persistPrecertCheapCheckReceipt,windowAuthorizesHeavyCertification,signCertificationWindow,withSignedPrecertCheapCheckReceipt,PRECERT_RECEIPT_SCHEMA} from '../dist/core/certification-window.js';
import {autoCommitStoryMetadata} from '../dist/core/auto-commit-metadata.js';
const root=mkdtempSync(join(tmpdir(),'certification-recovery-'));
const storyId='B-recovery-fixture';
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
try {
  git('init','-q','-b','main');git('config','user.name','Recovery fixture');git('config','user.email','recovery@example.invalid');
  writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({storyDir:'.proof-or-stop/story/actives',storyPrefix:'B',validate:{commands:[{label:'fast-fixture',command:'node',args:['--version'],focus:['fast'],timeoutMs:15000}]}}));
  writeFileSync(join(root,'README.md'),'Recovery fixture\n');
  const store=new StoryStore(root);
  store.writeStory(storyId,{storyId,name:'recovery-fixture',phase:'REVIEW',type:'feature',priority:'high',description:'Synthetic recovery fixture',createdAt:new Date().toISOString(),startedAt:null,endedAt:null,events:[]});
  store.writeChecklist(storyId,{items:[]});
  acquireOwnerLease(store.storyDirPath(storyId),{command:'fixture-owner',cwd:root});
  git('add','.');git('commit','-qm','fixture cutoff');
  const identity=()=>({headHash:currentGitHead(root),materialHash:currentMaterialHash(root,'HEAD',root),storyFilesHash:currentStoryFilesHash(root,'HEAD',root)});
  const cutoff=identity();
  git('checkout','-qb',`story/${storyId}`);
  const requiredLanes=['proof-or-stop-review-concept','proof-or-stop-review-quality'];
  const pair={epoch:{epochId:'epoch-fixture',storyId,reviewRound:'round-fixture',state:'FINALIZED',receiptId:'INV-fixture',cutoff,requiredLanes,waves:[{lanes:requiredLanes.map(lane=>({lane,terminal:'pass',evidenceIds:[lane+':PASS-fixture'],coverageDigest:'fixture'})),newVerifiedFindingCount:0,criticDigest:'fixture',saturated:true}]},receipt:{receiptId:'INV-fixture',epochId:'epoch-fixture',storyId,reviewRound:'round-fixture',authority:'inventory-completeness-only',authorizesTest:false,cutoff,requiredLanes,waveCount:1,saturationResult:'ZERO_NEW_VERIFIED_FINDINGS',scopeDigest:'fixture',findingSetDigest:'fixture',coverageDigest:'fixture'}};
  let consumed=0;
  // Only inventory discovery is synthetic; never rebind its cutoff after refusal.
  setReviewInventoryAdmitApisForTest({finalizedUnconsumedReviewInventory:()=>pair,verifyReviewInventoryEpoch:()=>true,verifyReviewInventoryReceipt:()=>true,isInventoryCompletenessOnlyReceipt:()=>false,consumeReviewInventoryCompletenessReceipt:(_store,_id,_round,_cutoff,validate)=>{validate?.();consumed++;return 'INV-fixture';}});
  const ctx={store,root,scanRoot:root};
  const handlers=createCertificationWindowHandlers(ctx);
  assert.throws(()=>handlers.certification_window_begin({storyId}),/pre_cert_cheap_check_required/);
  assert.equal(consumed,0);
  const blockedCommit=git('rev-parse','HEAD');
  assert.notEqual(blockedCommit,cutoff.headHash,'The real refused handler must publish metadata');
  const blocked=store.readCertificationWindows(storyId);
  assert.equal(windowAuthorizesHeavyCertification(blocked.windows.at(-1)),false);
  const current=identity();
  const routineValidationIdentity=currentPrecertFastIdentity(ctx,storyId);
  persistPrecertCheapCheckReceipt({store,storyId,routineValidationIdentity,commandExecution:{schema:'proofOrStop.routine-validation-command-execution',version:1,status:'PASS',complete:true,commandCount:routineValidationIdentity.commands.length,requiredFailureCount:0,optionalFailureCount:0},...current});
  const unpublishedCheap=store.readCertificationWindows(storyId);
  // No new validate-subject inventory bridge is granted: fast receipts bind HEAD.
  autoCommitStoryMetadata(root,storyId,'validate');
  assert.throws(()=>handlers.certification_window_begin({storyId}),/Inventory receipt is not on the current headHash lineage/);
  assert.equal(consumed,0);
  git('reset','--hard',blockedCommit);
  store.writeCertificationWindows(storyId,unpublishedCheap);
  let admitted;
  try {admitted=handlers.certification_window_begin({storyId});}
  catch(error){assert.fail('CERTIFICATION_RECOVERY_LINEAGE: unchanged finalized inventory must survive official BLOCKED publication: '+error.message);}
  assert.match(admitted,/State: ADMITTED/);
  assert.equal(consumed,1);
  handlers.certification_window_begin({storyId});
  assert.equal(consumed,1,'An admitted retry must not consume twice');
  const accepted=store.readCertificationWindows(storyId);
  assert.equal(windowAuthorizesHeavyCertification(accepted.windows.at(-1),accepted.receipts.find(row=>row.receiptId===accepted.windows.at(-1).receiptId)),true);
  const binding={gitCwd:root,metadataRoot:root,storyId,reviewedHeadHash:cutoff.headHash};
  assert.equal(isVerifiedReviewMaintenanceCommit({...binding,commit:blockedCommit}),true,'Diagnostic publication retains review only');
  // All resets below affect only this disposable fixture, never a real Story.
  const publish=(data,subject=`proof-or-stop: record ${storyId} certification_window_begin metadata`,extra)=>{
    git('reset','--hard',cutoff.headHash);store.writeCertificationWindows(storyId,data);extra?.();git('add','.');git('commit','-qm',subject);return isVerifiedReviewMaintenanceCommit({...binding,commit:git('rev-parse','HEAD')});
  };
  const withCheap=structuredClone(blocked);
  // Resolve the producer's explicit schema rather than assuming authority spelling.
  withCheap.receipts=[accepted.receipts.find(row=>row.schemaVersion!==PRECERT_RECEIPT_SCHEMA)];
  assert.ok(withCheap.receipts[0]);
  assert.equal(publish(withCheap),true,'BLOCKED publication may carry a signed cheap receipt');
  const invalidCheap=structuredClone(withCheap);invalidCheap.receipts[0]._hash='tampered';
  assert.equal(publish(invalidCheap),false,'Invalid cheap receipt signature');
  const extraWindow=structuredClone(blocked);extraWindow.windows.push(blocked.windows[0]);
  assert.equal(publish(extraWindow),false,'Diagnostic publisher cannot append multiple windows');
  const badSignature=structuredClone(blocked);badSignature.windows[0]._hash='tampered';
  assert.equal(publish(badSignature),false,'Invalid diagnostic signature');
  const mixed=structuredClone(blocked);mixed.receipts.push(accepted.receipts.find(row=>row.schemaVersion===PRECERT_RECEIPT_SCHEMA));
  assert.equal(publish(mixed),false,'Diagnostic publication cannot smuggle heavy authority');
  const privilege=structuredClone(blocked);privilege.windows[0].receiptId='forged';{const {_hash,...unsigned}=privilege.windows[0];privilege.windows[0]._hash=signCertificationWindow(unsigned);}
  assert.equal(publish(privilege),false,'Even signed BLOCKED data cannot carry receipt authority fields');
  assert.equal(publish(blocked,undefined,()=>writeFileSync(join(root,'README.md'),'changed source')),false,'Source drift');
  assert.equal(publish(blocked,`proof-or-stop: record B-foreign certification_window_begin metadata`),false,'Foreign writer');
  assert.equal(publish(blocked,undefined,()=>store.writeReviewInventoryEpochs(storyId,{schemaVersion:'fixture',epochs:[],receipts:[]})),false,'Diagnostic append cannot consume or mutate inventory');
  git('reset','--hard',blockedCommit);
  const priorMutation=structuredClone(blocked);priorMutation.windows[0].blockerDetail='rewritten';
  const {_hash,...unsigned}=priorMutation.windows[0];priorMutation.windows[0]._hash=signCertificationWindow(unsigned);
  const appendedWindow={...blocked.windows[0],windowId:storyId+':CW-002'};
  {const {_hash,...unsigned}=appendedWindow;appendedWindow._hash=signCertificationWindow(unsigned);}
  priorMutation.windows.push(appendedWindow);
  store.writeCertificationWindows(storyId,priorMutation);git('add','.');git('commit','-qm',`proof-or-stop: record ${storyId} certification_window_begin metadata`);
  assert.equal(isVerifiedReviewMaintenanceCommit({...binding,commit:git('rev-parse','HEAD')}),false,'Prior signed diagnostics cannot be rewritten');
  assert.equal(publish(blocked),true,'Restored exact diagnostic remains accepted');
  store.writeCertificationWindows(storyId,withCheap);git('add','.');git('commit','-qm',`proof-or-stop: record ${storyId} validate metadata`);
  assert.equal(isVerifiedReviewMaintenanceCommit({...binding,commit:git('rev-parse','HEAD')}),true,'Separate signed cheap-check publication preserves review');
  const rewrittenReceipt=structuredClone(withCheap);
  const {_hash:oldHash,...oldCheap}=rewrittenReceipt.receipts[0];
  rewrittenReceipt.receipts[0]=withSignedPrecertCheapCheckReceipt({...oldCheap,receiptId:storyId+':CHEAP-REPLACEMENT'});
  rewrittenReceipt.receipts.push(withSignedPrecertCheapCheckReceipt({...oldCheap,receiptId:storyId+':CHEAP-APPENDED'}));
  store.writeCertificationWindows(storyId,rewrittenReceipt);git('add','.');git('commit','-qm',`proof-or-stop: record ${storyId} validate metadata`);
  assert.equal(isVerifiedReviewMaintenanceCommit({...binding,commit:git('rev-parse','HEAD')}),false,'Prior receipt history cannot be replaced');
  console.log('CERTIFICATION_RECOVERY_LINEAGE_GREEN');
} finally {setReviewInventoryAdmitApisForTest(undefined);rmSync(root,{recursive:true,force:true});}

// In-memory module mutations in isolated child processes, never source/dist edits.
// Each must reach its named assertion; setup errors and unapplied mutations fail.
if (!process.argv.includes('--mutation-child')) {
  const cases=[
    {id:'blocked-bridge',file:'../dist/handlers/certification-window.js',before:"['verification_evidence_add', 'certification_window_begin']",after:"['verification_evidence_add']",assertion:'CERTIFICATION_RECOVERY_LINEAGE'},
    {id:'window-prefix',file:'../dist/core/review-maintenance-lineage.js',before:'digestCanonicalJson(after.windows.slice(0, before.windows.length)) !== digestCanonicalJson(before.windows)',after:'false',assertion:'Prior signed diagnostics cannot be rewritten'},
    {id:'receipt-prefix',file:'../dist/core/review-maintenance-lineage.js',before:'digestCanonicalJson(after.receipts.slice(0, before.receipts.length)) !== digestCanonicalJson(before.receipts)',after:'false',assertion:'Prior receipt history cannot be replaced'},
  ];
  for (const test of cases) {
    const hook=`import {registerHooks} from 'node:module';
      const target=${JSON.stringify(new URL(test.file,import.meta.url).href)};
      registerHooks({load(url,context,next){const result=next(url,context);if(url!==target)return result;
      const source=String(result.source), before=${JSON.stringify(test.before)};
      if(source.split(before).length!==2)throw new Error('Mutation target is not unique');
      process.stderr.write('MUTATION_APPLIED:${test.id}\\n');
      return {...result,source:source.replace(before,${JSON.stringify(test.after)})};}});`;
    const result=spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(hook),fileURLToPath(import.meta.url),'--mutation-child'],{encoding:'utf8',timeout:25000,maxBuffer:1024*1024});
    assert.equal(result.error,undefined,test.id+' must execute');
    assert.equal(result.signal,null,test.id+' must terminate normally');
    assert.equal(result.status,1,test.id+' must fail its acceptance assertion');
    assert.ok(result.stderr.includes('MUTATION_APPLIED:'+test.id),test.id+' mutation must be applied');
    assert.ok(result.stderr.includes(test.assertion),test.id+' must fail the intended consumer');
    console.log('CERTIFICATION_RECOVERY_MUTANT_REJECTED '+test.id);
  }
}
