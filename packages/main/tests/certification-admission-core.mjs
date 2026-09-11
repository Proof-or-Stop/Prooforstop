// Disposable core contract controls, not formal reviewer or inventory authority.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {StoryStore} from '../dist/core/store.js';
import * as c from '../dist/core/certification-window.js';
const root=mkdtempSync(join(tmpdir(),'pos-admission-core-')),storyId='B-core';
try {
 const store=new StoryStore(root);
 const frozen={headHash:'fixture-head',materialHash:'fixture-material',storyFilesHash:'fixture-story',expectedMainSha:'fixture-main',verifierIdentity:c.PRECERT_VERIFIER_IDENTITY,testIdentity:c.PRECERT_TEST_IDENTITY};
 const inventory={epochId:'fixture-epoch',receiptId:'fixture-receipt',authority:'inventory-completeness-only',authorizesTest:false};
 const pending=c.persistAdmittingCertificationWindow({store,storyId,frozen,inventory});
 assert.equal(c.verifyCertificationWindow(pending),true);assert.equal(pending.receiptId,undefined);assert.equal(store.readCertificationWindows(storyId).receipts.length,0);
 assert.throws(()=>c.persistAdmittingCertificationWindow({store,storyId,frozen,inventory}),/ADMISSION_PENDING/);
 const forged=c.withSignedPrecertReceipt({schemaVersion:c.PRECERT_RECEIPT_SCHEMA,receiptId:'fake',windowId:pending.windowId,storyId,authority:c.PRECERT_AUTHORITY,authorizesHeavyCertification:true,frozen,createdAt:pending.createdAt});
 assert.equal(c.windowAuthorizesHeavyCertification(c.withSignedCertificationWindow({...pending,receiptId:'fake'}),forged),false,'Even a matching signed test receipt cannot authorize ADMITTING');
 const text=c.renderCertificationWindowStatus(c.projectCertificationWindowStatus(storyId,pending,null));
 assert.equal(text.split('\n').filter(l=>l.startsWith('State:')).length,1);assert.equal(text.split('\n').filter(l=>l.startsWith('Next:')).length,1);assert.doesNotMatch(text,/^(?:headHash|expectedMainSha|storyFilesHash):/m);
 const before=JSON.stringify(store.readCertificationWindows(storyId));
 c.inspectCertificationWindowLineage({store,storyId,current:frozen});assert.equal(JSON.stringify(store.readCertificationWindows(storyId)),before);
 assert.throws(()=>c.refuseHeavyCertificationUnlessAdmitted({store,storyId,current:frozen}),/pre_cert_window_required/);assert.equal(store.readCertificationWindows(storyId).windows.at(-1).state,'ADMITTING');
 assert.throws(()=>c.persistRunningCertificationWindow({store,storyId}),/pre_cert_window_required.*ADMITTING/);
 const unknown=c.withSignedCertificationWindow({...pending,state:'UNRECOGNIZED'});assert.equal(c.verifyCertificationWindow(unknown),false);
 store.writeCertificationWindows(storyId,{...store.readCertificationWindows(storyId),windows:[unknown]});assert.throws(()=>c.loadVerifiedCertificationWindow(store,storyId));store.writeCertificationWindows(storyId,JSON.parse(before));
 for(const mutation of [{frozen:{...frozen,headHash:'other'}},{inventory:{...inventory,receiptId:'other'}},{expectedPendingWindowId:'other'}]){
  assert.throws(()=>c.persistAdmittedCertificationWindow({store,storyId,frozen,inventory,expectedPendingWindowId:pending.windowId,...mutation}),/ADMISSION_PENDING/);
  assert.equal(JSON.stringify(store.readCertificationWindows(storyId)),before);
 }
 assert.throws(()=>c.persistAdmittedCertificationWindow({store,storyId,frozen,inventory}),/explicit pending/);
 const admitted=c.persistAdmittedCertificationWindow({store,storyId,frozen,inventory,expectedPendingWindowId:pending.windowId});
 assert.equal(admitted.window.windowId,pending.windowId);assert.equal(admitted.window.createdAt,pending.createdAt);assert.equal(store.readCertificationWindows(storyId).windows.length,1);assert.equal(store.readCertificationWindows(storyId).receipts.length,1);
 assert.equal(c.isCertificationRunningOnlyAdvance(JSON.parse(before),store.readCertificationWindows(storyId),storyId),false);
 const running={...store.readCertificationWindows(storyId),windows:[c.withSignedCertificationWindow({...admitted.window,state:'RUNNING'})]};assert.equal(c.isCertificationRunningOnlyAdvance(JSON.parse(before),running,storyId),false);
 store.writeCertificationWindows(storyId,JSON.parse(before));c.persistCancelledCertificationWindow({store,storyId,reason:'Explicit test cancellation'});assert.equal(store.readCertificationWindows(storyId).windows.at(-1).state,'CANCELLED');
 assert.throws(()=>c.persistAdmittedCertificationWindow({store,storyId,frozen,inventory,expectedPendingWindowId:pending.windowId}),/expected attempt/);
 console.log('ADMISSION_CORE_CONTRACT_GREEN');
} finally {rmSync(root,{recursive:true,force:true});}
