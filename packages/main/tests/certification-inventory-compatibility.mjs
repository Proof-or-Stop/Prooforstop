import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {StoryStore} from '../dist/core/store.js';
import {persistFinalizedReviewInventory,consumeReviewInventoryCompletenessReceipt,consumeReviewInventoryCompletenessReceiptUnlocked,withReviewInventoryMutationLock,signReviewInventoryEpoch,signReviewInventoryReceipt,verifyReviewInventoryEpoch,verifyReviewInventoryReceipt} from '../dist/core/review-inventory-epoch.js';
const root=mkdtempSync(join(tmpdir(),'pos-inventory-compat-'));
try {
 for(const mode of ['legacy-locked','owned-unlocked']) {
  const store=new StoryStore(root),storyId='B-'+mode,now=new Date().toISOString();
  store.writeStory(storyId,{storyId,name:storyId,title:'Disposable compatibility fixture',description:'Not formal review authority',phase:'DEV',type:'chore',priority:'medium',createdAt:now,startedAt:null,endedAt:null});store.writeChecklist(storyId,{items:[]});
  const cutoff={headHash:'fixture-head',materialHash:'fixture-material',storyFilesHash:'fixture-story'};
  const pair=persistFinalizedReviewInventory({store,storyId,reviewRound:'round',cutoff});const before=structuredClone(store.readReviewInventoryEpochs(storyId));
  const owner=mode==='owned-unlocked'?storyId+':CW-1':undefined;
  const run=()=>consumeReviewInventoryCompletenessReceiptUnlocked(store,storyId,'round',cutoff,undefined,owner);
  const consumed=owner?withReviewInventoryMutationLock(store,storyId,run):consumeReviewInventoryCompletenessReceipt(store,storyId,'round',cutoff);
  assert.equal(consumed,pair.receipt.receiptId);const after=store.readReviewInventoryEpochs(storyId),timestamp=after.receipts.at(-1).consumedAt;
  const expected=structuredClone(before);
  expected.epochs=expected.epochs.map(row=>{const {_hash,...unsigned}=row;const value={...unsigned,consumedAt:timestamp,...(owner?{consumedByCertificationWindowId:owner}:{}),consumedByReviewRound:'round',updatedAt:timestamp};return {...value,_hash:signReviewInventoryEpoch(value)};});
  expected.receipts=expected.receipts.map(row=>{const {_hash,...unsigned}=row;const value={...unsigned,consumedAt:timestamp,...(owner?{consumedByCertificationWindowId:owner}:{})};return {...value,_hash:signReviewInventoryReceipt(value)};});
  assert.equal(JSON.stringify(after),JSON.stringify(expected),'Exact prior serialized shape/signature retained when no owner supplied');
  assert.ok(after.epochs.every(verifyReviewInventoryEpoch));assert.ok(after.receipts.every(verifyReviewInventoryReceipt));
  if(!owner){assert.equal(Object.hasOwn(after.receipts[0],'consumedByCertificationWindowId'),false);assert.equal(Object.hasOwn(after.epochs[0],'consumedByCertificationWindowId'),false);}
  assert.throws(()=>consumeReviewInventoryCompletenessReceipt(store,storyId,'round',cutoff),/ALREADY_CONSUMED/);
  console.log('INVENTORY_CONSUMPTION_COMPATIBILITY_GREEN '+mode);
 }
} finally {rmSync(root,{recursive:true,force:true});}
