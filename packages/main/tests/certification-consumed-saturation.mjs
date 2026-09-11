// Synthetic signed inventory structure: bounded admission projection, not a formal review.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSaturatedReviewInventoryForPrecert, loadReviewInventoryAdmitApis } from '../dist/core/certification-window.js';
import { signReviewInventoryEpoch, signReviewInventoryReceipt } from '../dist/core/review-inventory-epoch.js';
const old=process.cwd(), root=mkdtempSync(join(tmpdir(),'pos-consumed-saturation-'));
process.chdir(root);
try {
 const storyId='B-saturation',windowId=storyId+':CW-1',at='2026-09-11T00:00:00.000Z';
 const cutoff={headHash:'a'.repeat(40),materialHash:'b'.repeat(64),storyFilesHash:'c'.repeat(64)};
 const lanes=['proof-or-stop-review-quality'];
 const epoch={schemaVersion:'proof-or-stop.review_inventory_epoch.v1',epochId:'E-1',storyId,reviewRound:'round',state:'FINALIZED',begunAt:at,updatedAt:at,cutoff,scopeDigest:'scope',requiredLanes:lanes,maxWaves:3,receiptId:'R-1',waves:[{wave:1,startedAt:at,completedAt:at,lanes:lanes.map(lane=>({lane,terminal:'pass',evidenceIds:['P-1'],coverageDigest:'coverage'})),verifiedFindingFamilies:[],verifiedFindingSetDigest:'findings',newVerifiedFindingCount:0,criticDigest:'critic',saturated:true}]};
 const receipt={schemaVersion:'proof-or-stop.review_inventory_receipt.v1',receiptId:'R-1',epochId:'E-1',storyId,reviewRound:'round',cutoff,scopeDigest:'scope',requiredLanes:lanes,waveCount:1,findingSetDigest:'findings',coverageDigest:'coverage',saturationResult:'ZERO_NEW_VERIFIED_FINDINGS',authority:'inventory-completeness-only',authorizesTest:false,issuedAt:at};
 const signed=(e,r)=>({epoch:{...e,_hash:signReviewInventoryEpoch(e)},receipt:{...r,_hash:signReviewInventoryReceipt(r)}});
 const apis=loadReviewInventoryAdmitApis(); assert(apis);
 assert.equal(isSaturatedReviewInventoryForPrecert(apis,signed(epoch,receipt),storyId),true);
 const consumed={consumedAt:'2026-09-11T00:01:00.000Z',consumedByCertificationWindowId:windowId};
 const pair=signed({...epoch,...consumed},{...receipt,...consumed});
 assert.equal(isSaturatedReviewInventoryForPrecert(apis,pair,storyId),false,'ordinary admission never reconsumes');
 assert.equal(isSaturatedReviewInventoryForPrecert(apis,pair,storyId,windowId),true,'OWNED_CONSUMED_SATURATION_MUST_SUPPORT_RECOVERY');
 for(const bad of [signed({...epoch,...consumed},{...receipt,...consumed,consumedByCertificationWindowId:'other'}),signed({...epoch,...consumed},receipt),signed({...epoch,...consumed},{...receipt,...consumed,consumedAt:at}),signed({...epoch,...consumed,waves:[]},{...receipt,...consumed}),{...pair,receipt:{...pair.receipt,coverageDigest:'tampered'}}]) {
  assert.equal(isSaturatedReviewInventoryForPrecert(apis,bad,storyId,windowId),false);
 }
 assert.equal(isSaturatedReviewInventoryForPrecert(apis,pair,storyId,'other'),false);
 console.log('CONSUMED_SATURATION_GREEN ordinary-refusal owned-recovery foreign-partial-tampered-refusal');
} finally {process.chdir(old);rmSync(root,{recursive:true,force:true});}
