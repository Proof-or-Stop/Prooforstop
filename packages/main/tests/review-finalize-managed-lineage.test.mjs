/** Real Git regression for a finalized inventory after managed REVIEW imports. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StoryStore} from '../dist/core/store.js';
import {currentMaterialHash,currentStoryFilesHash} from '../dist/core/evidence-freshness.js';
import {verifyManagedReviewLiveBinding} from '../dist/core/managed-review-evidence.js';
import {isVerifiedReviewMaintenanceCommit} from '../dist/core/review-maintenance-lineage.js';
import {emptyReviewInventoryEpochData,signReviewInventoryEpoch,signReviewInventoryReceipt,verifyReviewInventoryEpoch,verifyReviewInventoryReceipt} from '../dist/core/review-inventory-epoch.js';

const root=mkdtempSync(join(tmpdir(),'review-finalize-managed-lineage-'));
const storyId='B-finalize-lineage';
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
try {
  git('init','-q','-b','main');git('config','user.name','Lineage fixture');git('config','user.email','lineage@example.invalid');
  mkdirSync(join(root,'src'));
  writeFileSync(join(root,'src','subject.ts'),'export const subject = 1;\n');
  const store=new StoryStore(root);
  store.writeStory(storyId,{storyId,name:'lineage-fixture',phase:'REVIEW',type:'bug',priority:'medium',description:'Managed review lineage fixture',events:[]});
  git('add','.');git('commit','-qm','reviewed source');
  const reviewedHeadHash=git('rev-parse','HEAD');
  const materialHash=currentMaterialHash(root,'HEAD',root);
  const storyFilesHash=currentStoryFilesHash(root,'HEAD',root);
  assert.ok(materialHash && storyFilesHash);

  // A real importer-shaped commit advances HEAD after a reviewer starts. The
  // finalizer freezes the later HEAD, then publishes only signed epoch metadata.
  writeFileSync(store.storyFilePath(storyId,'review-passes.json'),'{"passes":[]}\n');
  git('add','.');git('commit','-qm',`proof-or-stop: record ${storyId} managed_review_evidence_import metadata`);
  const cutoff={headHash:git('rev-parse','HEAD'),materialHash,storyFilesHash};
  assert.notEqual(cutoff.headHash,reviewedHeadHash);
  const at=new Date().toISOString();
  const epoch={schemaVersion:'proof-or-stop.review_inventory_epoch.v1',epochId:'RIE-001',storyId,
    reviewRound:at,state:'FINALIZED',begunAt:at,updatedAt:at,cutoff,scopeDigest:'c'.repeat(64),
    requiredLanes:['proof-or-stop-review-concept'],initialRunSequenceBoundary:0,maxWaves:2,waves:[],receiptId:'RCP-001'};
  epoch._hash=signReviewInventoryEpoch(epoch);
  const receipt={schemaVersion:'proof-or-stop.review_inventory_receipt.v1',receiptId:epoch.receiptId,epochId:epoch.epochId,
    storyId,reviewRound:at,cutoff,scopeDigest:epoch.scopeDigest,requiredLanes:epoch.requiredLanes,
    waveCount:1,findingSetDigest:'d'.repeat(64),coverageDigest:'e'.repeat(64),
    saturationResult:'ZERO_NEW_VERIFIED_FINDINGS',authority:'inventory-completeness-only',authorizesTest:false,issuedAt:at};
  receipt._hash=signReviewInventoryReceipt(receipt);
  assert.equal(verifyReviewInventoryEpoch(epoch),true);
  assert.equal(verifyReviewInventoryReceipt(receipt),true);
  store.writeReviewInventoryEpochs(storyId,{...emptyReviewInventoryEpochData(),epochs:[epoch],receipts:[receipt]});
  git('add','.');git('commit','-qm',`proof-or-stop: record ${storyId} review epoch metadata`);
  const maintenance={gitCwd:root,metadataRoot:root,storyId,commit:git('rev-parse','HEAD'),reviewedHeadHash};
  assert.equal(isVerifiedReviewMaintenanceCommit({...maintenance,reviewedMaterialHash:materialHash,
    reviewedStoryFilesHash:storyFilesHash}),true,'REVIEW_FINALIZE_EPOCH_LINEAGE_RED');
  for (const hashes of [
    {},{reviewedMaterialHash:materialHash},{reviewedStoryFilesHash:storyFilesHash},
    {reviewedMaterialHash:'f'.repeat(64),reviewedStoryFilesHash:storyFilesHash},
    {reviewedMaterialHash:materialHash,reviewedStoryFilesHash:'f'.repeat(64)},
  ]) assert.equal(isVerifiedReviewMaintenanceCommit({...maintenance,...hashes}),false,
    'DIRECT_FINALIZE_REQUIRES_MATCHING_BOTH_REVIEWED_HASHES');
  const result=verifyManagedReviewLiveBinding({gitCwd:root,metadataRoot:root,storyId,
    expected:{headHash:reviewedHeadHash,materialHash,storyFilesHash}});
  assert.equal(result.valid,true,`REVIEW_FINALIZE_MANAGED_LINEAGE_RED: ${result.reason}`);

  // The existing OPEN-epoch sequence has the opposite, also valid order:
  // cutoff first, reviewer run later. Preserve that path while admitting the
  // direct-finalize sequence above.
  git('reset','--hard',reviewedHeadHash);
  const openCutoff={headHash:reviewedHeadHash,materialHash,storyFilesHash};
  const open={...epoch,state:'OPEN',cutoff:openCutoff};
  delete open.receiptId;
  delete open._hash;
  open._hash=signReviewInventoryEpoch(open);
  store.writeReviewInventoryEpochs(storyId,{...emptyReviewInventoryEpochData(),epochs:[open]});
  git('add','.');git('commit','-qm','fixture open review inventory');
  const reviewedAfterCutoff=git('rev-parse','HEAD');
  writeFileSync(store.storyFilePath(storyId,'review-passes.json'),'{"passes":[]}\n');
  git('add','.');git('commit','-qm',`proof-or-stop: record ${storyId} managed_review_evidence_import metadata`);
  const beforeFinalization=git('rev-parse','HEAD');
  const completed={...open,state:'FINALIZED',receiptId:receipt.receiptId};
  delete completed._hash;
  completed._hash=signReviewInventoryEpoch(completed);
  const openReceipt={...receipt,cutoff:openCutoff};
  delete openReceipt._hash;
  openReceipt._hash=signReviewInventoryReceipt(openReceipt);
  store.writeReviewInventoryEpochs(storyId,{...emptyReviewInventoryEpochData(),epochs:[completed],receipts:[openReceipt]});
  git('add','.');git('commit','-qm',`proof-or-stop: record ${storyId} review epoch metadata`);
  const openBinding={gitCwd:root,metadataRoot:root,storyId,expected:{headHash:reviewedAfterCutoff,materialHash,storyFilesHash}};
  assert.equal(verifyManagedReviewLiveBinding(openBinding).valid,true,'OPEN_EPOCH_REVIEWED_AFTER_CUTOFF_GREEN');

  // A signed but divergent cutoff cannot borrow this publication's authority.
  const siblingCutoff=git('commit-tree',`${beforeFinalization}^{tree}`,'-p',reviewedAfterCutoff,'-m','divergent cutoff');
  git('reset','--hard',beforeFinalization);
  const forgedCutoff={...openCutoff,headHash:siblingCutoff};
  const forgedEpoch={...completed,cutoff:forgedCutoff};
  delete forgedEpoch._hash;
  forgedEpoch._hash=signReviewInventoryEpoch(forgedEpoch);
  const forgedReceipt={...openReceipt,cutoff:forgedCutoff};
  delete forgedReceipt._hash;
  forgedReceipt._hash=signReviewInventoryReceipt(forgedReceipt);
  store.writeReviewInventoryEpochs(storyId,{...emptyReviewInventoryEpochData(),epochs:[forgedEpoch],receipts:[forgedReceipt]});
  git('add','.');git('commit','-qm',`proof-or-stop: record ${storyId} review epoch metadata`);
  assert.equal(isVerifiedReviewMaintenanceCommit({gitCwd:root,metadataRoot:root,storyId,
    commit:git('rev-parse','HEAD'),reviewedHeadHash:reviewedAfterCutoff,
    reviewedMaterialHash:materialHash,reviewedStoryFilesHash:storyFilesHash}),false,
    'DIVERGENT_SIGNED_CUTOFF_STILL_REJECTED');
  assert.equal(verifyManagedReviewLiveBinding(openBinding).valid,false,'DIVERGENT_CUTOFF_STILL_REJECTED');
  console.log('REVIEW_FINALIZE_MANAGED_LINEAGE_GREEN');
} finally {rmSync(root,{recursive:true,force:true});}
