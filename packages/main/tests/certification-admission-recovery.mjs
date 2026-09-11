import {withMkdirLock} from '../dist/core/mkdir-lock.js';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,chmodSync,symlinkSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync,spawnSync} from 'node:child_process';
import {StoryStore} from '../dist/core/store.js';
import {currentGitHead,currentMaterialHash,currentStoryFilesHash} from '../dist/core/evidence-freshness.js';
import {persistFinalizedReviewInventory,signReviewInventoryReceipt,signReviewInventoryEpoch} from '../dist/core/review-inventory-epoch.js';
import {createCertificationWindowHandlers} from '../dist/handlers/certification-window.js';
import {windowAuthorizesHeavyCertification,withSignedCertificationWindow,setReviewInventoryAdmitApisForTest,loadReviewInventoryAdmitApis,persistAdmittedCertificationWindow} from '../dist/core/certification-window.js';
const consumeWriteFailure=process.argv.includes('--consume-write-failure'),commitFailure=process.argv.includes('--commit-failure');
const admittedAfterWrite=process.argv.includes('--admitted-after-write');
const beforeConsume=process.argv.includes('--before-consume');
const observe=process.argv.includes('--observe'),crash=process.argv.includes('--crash'),negative=process.argv.find(x=>x.startsWith('--negative='))?.split('=')[1];
const rootBacking=mkdtempSync(join(tmpdir(),'pos-admission-v3-')),root=process.argv.includes('--symlink-root')?rootBacking+'-alias':rootBacking,storyId='B-admission',now=new Date().toISOString();
if(root!==rootBacking)symlinkSync(rootBacking,root,'dir');
const cancelBeforeRetry=process.argv.includes('--cancel-before-retry');
const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
try{
 git(['init','-q','-b','main']);git(['config','user.name','Lab Proof']);git(['config','user.email','lab@example.invalid']);
 writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({storyDir:'.proof-or-stop/story/actives',storyPrefix:'B'}));writeFileSync(join(root,'README.md'),'real inventory fixture');git(['add','.']);git(['commit','-qm','baseline']);
 const store=new StoryStore(root);store.writeStory(storyId,{storyId,name:'admission-proof',title:'Admission proof',description:'Disposable engineering fixture; not a formal Story review.',type:'feature',phase:'DEV',priority:'high',createdAt:now,startedAt:null,endedAt:null});store.writeChecklist(storyId,{items:[]});
 const finalized=persistFinalizedReviewInventory({store,storyId,reviewRound:'round-1',cutoff:{headHash:currentGitHead(root),materialHash:currentMaterialHash(root,'HEAD',root),storyFilesHash:currentStoryFilesHash(root,'HEAD',root)}});
 if(commitFailure){git(['checkout','-qb','story/B-admission']);git(['add','-f',...['index.json','checklist.json','review-inventory-epochs.json'].map(name=>store.storyFilePath(storyId,name))]);git(['commit','-qm','commit fixture prerequisites']);const hook=join(root,'.git/hooks/pre-commit');writeFileSync(hook,'#!/bin/sh\nexit 7\n');chmodSync(hook,0o755);}
 const apis=loadReviewInventoryAdmitApis();assert.equal(apis.consumeReviewInventoryCompletenessReceiptUnlocked.name,'consumeReviewInventoryCompletenessReceiptUnlocked');let unlockedCalls=0;
 if(process.argv.includes('--locked-trap'))setReviewInventoryAdmitApisForTest({...apis,consumeReviewInventoryCompletenessReceipt:(...args)=>withMkdirLock(store.runtimeLockDirPath(storyId,'review-inventory','epochs'),()=>apis.consumeReviewInventoryCompletenessReceiptUnlocked(...args),{deadlineMs:30,label:'TEST_LOCKED_CONSUMER_REENTRY'}),consumeReviewInventoryCompletenessReceiptUnlocked:(...args)=>{unlockedCalls++;return apis.consumeReviewInventoryCompletenessReceiptUnlocked(...args);}});
 const handlers=createCertificationWindowHandlers({root,scanRoot:root,store});const original=store.writeCertificationWindows.bind(store);
 const oldInventoryWrite=store.writeReviewInventoryEpochs.bind(store);
 const start=performance.now();
 if(crash){
   const code=`import {StoryStore} from ${JSON.stringify(new URL('../dist/core/store.js',import.meta.url).href)};import {createCertificationWindowHandlers} from ${JSON.stringify(new URL('../dist/handlers/certification-window.js',import.meta.url).href)};const root=${JSON.stringify(root)},storyId=${JSON.stringify(storyId)},store=new StoryStore(root);const old=store.writeReviewInventoryEpochs.bind(store);store.writeReviewInventoryEpochs=(id,data)=>{old(id,data);if(data.receipts.some(r=>r.consumedAt))process.kill(process.pid,'SIGKILL');};createCertificationWindowHandlers({root,scanRoot:root,store}).certification_window_begin({storyId});`;
   const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:45000});assert.equal(child.signal,'SIGKILL',child.stdout+child.stderr);
 }else{
   if(consumeWriteFailure)store.writeReviewInventoryEpochs=(id,data)=>{oldInventoryWrite(id,data);if(data.receipts.some(row=>row.consumedAt))throw new Error('INJECTED_AFTER_REAL_CONSUME');};
   else if(!commitFailure)store.writeCertificationWindows=(id,data)=>{if(beforeConsume){original(id,data);if(data.windows.at(-1)?.state==='ADMITTING')throw new Error('INJECTED_AFTER_REAL_CONSUME');return;}if(data.windows.at(-1)?.state==='ADMITTED'){if(admittedAfterWrite)original(id,data);throw new Error('INJECTED_AFTER_REAL_CONSUME');}return original(id,data);};
   assert.throws(()=>handlers.certification_window_begin({storyId}),commitFailure?/DECLARED_METADATA_PUBLICATION_REFUSED/:/INJECTED_AFTER_REAL_CONSUME/);
 }
 const firstMs=performance.now()-start;store.writeReviewInventoryEpochs=oldInventoryWrite;
 if(commitFailure)rmSync(join(root,'.git/hooks/pre-commit'));
 const pending=store.readCertificationWindows(storyId).windows.at(-1);const consumed=store.readReviewInventoryEpochs(storyId).receipts.find(r=>r.receiptId===finalized.receipt.receiptId);
 if(beforeConsume)assert.equal(consumed.consumedAt,undefined,'Prepared attempt must precede consumption');else assert.ok(consumed.consumedAt,'must actually consume real inventory before the injected failure');
 if(negative==='backdated'){const windows=store.readCertificationWindows(storyId);const last=windows.windows.at(-1);windows.windows[windows.windows.length-1]=withSignedCertificationWindow({...last,createdAt:'2000-01-01T00:00:00.000Z'});original(storyId,windows);}
 if(negative==='identity'||negative==='test-identity'){const windows=store.readCertificationWindows(storyId),last=windows.windows.at(-1);windows.windows[windows.windows.length-1]=withSignedCertificationWindow({...last,frozen:{...last.frozen,[negative==='identity'?'verifierIdentity':'testIdentity']:'foreign-identity'}});original(storyId,windows);}
 if(['legacy-owner','partial-epoch','partial-receipt','invalid-time','old-consumption'].includes(negative)){
  const data=store.readReviewInventoryEpochs(storyId);
  for(const [kind,rows,sign] of [['epoch',data.epochs,signReviewInventoryEpoch],['receipt',data.receipts,signReviewInventoryReceipt]]){
   for(const row of rows){
    if(negative==='legacy-owner')delete row.consumedByCertificationWindowId;
    if(negative==='partial-'+kind){delete row.consumedAt;delete row.consumedByCertificationWindowId;}
    if(negative==='invalid-time')row.consumedAt='not-a-date';
    if(negative==='old-consumption')row.consumedAt='2000-01-01T00:00:00.000Z';
    const {_hash,...unsigned}=row;row._hash=sign(unsigned);
   }
  }
  store.writeReviewInventoryEpochs(storyId,data);
 }
 if(negative==='expected-main'){const data=store.readCertificationWindows(storyId);const last=data.windows.at(-1);data.windows[data.windows.length-1]=withSignedCertificationWindow({...last,frozen:{...last.frozen,expectedMainSha:'f'.repeat(40)}});original(storyId,data);}
 if(negative==='source')writeFileSync(join(root,'README.md'),'foreign source change');
 if(negative==='attribution'||negative==='receipt-tamper'){
  const data=store.readReviewInventoryEpochs(storyId),row=data.receipts.find(r=>r.receiptId===finalized.receipt.receiptId);
  if(negative==='attribution'){row.consumedByCertificationWindowId='B-other:CW-999';const {_hash,...unsigned}=row;row._hash=signReviewInventoryReceipt(unsigned);}else row._hash='0'.repeat(64);
  store.writeReviewInventoryEpochs(storyId,data);
 }
 if(negative==='api-absent')setReviewInventoryAdmitApisForTest(null);
 store.writeCertificationWindows=original;
 if(cancelBeforeRetry)handlers.certification_window_cancel({storyId,reason:'Explicit cancellation after interruption'});
 let raceInjected=false;
 if(process.argv.includes('--concurrent-completion')){const originalRead=store.readCertificationWindows.bind(store);store.readCertificationWindows=id=>{const snapshot=originalRead(id);if(!raceInjected){raceInjected=true;persistAdmittedCertificationWindow({store,storyId,frozen:pending.frozen,inventory:pending.inventory,expectedPendingWindowId:pending.windowId});}return snapshot;};}
 let recovered=null,recoveryError=null;const retryStart=performance.now();try{recovered=handlers.certification_window_begin({storyId});}catch(error){recoveryError=String(error.message);}
 const retryMs=performance.now()-retryStart;
 const after=store.readCertificationWindows(storyId);const afterConsumed=store.readReviewInventoryEpochs(storyId).receipts.find(r=>r.receiptId===finalized.receipt.receiptId);
 const summary={scenario:'certification-admission',crash,consumeWriteFailure,commitFailure,negative:negative??null,firstMs,retryMs,totalMs:firstMs+retryMs,pendingState:pending?.state??null,recovered:Boolean(recovered?.includes('State: ADMITTED')),recoveryError,windowCount:after.windows.length,receiptCount:after.receipts.length,consumedBefore:consumed.consumedAt,consumedAfter:afterConsumed.consumedAt,head:git(['rev-parse','HEAD'])};
 console.log(JSON.stringify(summary));
 if(observe)process.exitCode=0;
 else if(cancelBeforeRetry){assert.equal(summary.recovered,false);assert.equal(afterConsumed.consumedAt,consumed.consumedAt);assert.equal(after.windows.find(row=>row.windowId===pending.windowId).state,'CANCELLED');assert.match(recoveryError,/pre_cert_inventory_not_finalized/);}
 else if(negative){assert.equal(summary.recovered,false,'NEGATIVE_RECOVERY_MUST_NOT_ADMIT');assert.match(recoveryError,/PRE_CERT_ADMISSION_PENDING/);assert.equal(after.windows.at(-1)?.state,'ADMITTING');}
 else{
  assert.equal(pending?.state,admittedAfterWrite?'ADMITTED':'ADMITTING','CONSUMED_INVENTORY_MUST_HAVE_RECOVERABLE_WINDOW');assert.equal(windowAuthorizesHeavyCertification(pending,null),false);
  assert.equal(summary.recovered,true,recoveryError??'recovery must admit');if(beforeConsume)assert.ok(afterConsumed.consumedAt);else assert.equal(afterConsumed.consumedAt,consumed.consumedAt,'recovery must never unconsume/reconsume');assert.equal(after.windows.length,1);assert.equal(after.receipts.length,1);assert.equal(afterConsumed.consumedByCertificationWindowId,after.windows[0].windowId);const stable=JSON.stringify(after);assert.match(handlers.certification_window_begin({storyId}),/State: ADMITTED/);assert.equal(JSON.stringify(store.readCertificationWindows(storyId)),stable,'Idempotent retry must not mint another window or receipt');
 }
 if(!observe)console.log('CERTIFICATION_ADMISSION_V3_GREEN '+(negative??(crash?'crash':consumeWriteFailure?'consume-write-failure':commitFailure?'commit-failure':'exception')));
}finally{rmSync(root,{recursive:true,force:true});if(root!==rootBacking)rmSync(rootBacking,{recursive:true,force:true});}
