/**
 * Real Git regression for run 11 (2026-09-30): after an all-pass managed
 * round the owner finalized directly (zero-wave completeness-only receipt),
 * certification refused it, the owner cancelled it and finalized a fresh
 * saturated epoch. story_advance TEST then refused every managed pass with
 * managed_review_live_head_lineage_invalid because the cancel publication (and,
 * retroactively, the cancelled finalize publication) failed authentication.
 * Positive: both publications keep the passes live. Negative controls: a cancel
 * that rewrites other signed fields, an epoch publication that appends another
 * writer's review pass, a bookkeeping subject that changes review evidence and
 * an importer commit that rewrites an earlier pass stay refused, and the
 * refusal names the exact commit and rule.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StoryStore} from '../dist/core/store.js';
import {currentMaterialHash,currentStoryFilesHash} from '../dist/core/evidence-freshness.js';
import {verifyManagedReviewLiveBinding} from '../dist/core/managed-review-evidence.js';
import {isVerifiedReviewMaintenanceCommit} from '../dist/core/review-maintenance-lineage.js';
import {emptyReviewInventoryEpochData,signReviewInventoryEpoch,signReviewInventoryReceipt} from '../dist/core/review-inventory-epoch.js';

const root=mkdtempSync(join(tmpdir(),'review-epoch-cancel-lineage-'));
const storyId='B-cancel-lineage';
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const sign=(row,signer)=>{const {_hash,...unsigned}=row;return {...unsigned,_hash:signer(unsigned)};};
try {
  git('init','-q','-b','main');git('config','user.name','Lineage fixture');git('config','user.email','lineage@example.invalid');
  mkdirSync(join(root,'src'));
  writeFileSync(join(root,'src','subject.ts'),'export const subject = 1;\n');
  const store=new StoryStore(root);
  store.writeStory(storyId,{storyId,name:'cancel-lineage-fixture',phase:'REVIEW',type:'bug',priority:'medium',description:'Cancel lineage fixture',events:[]});
  git('add','.');git('commit','-qm','reviewed source');
  const reviewedHeadHash=git('rev-parse','HEAD');
  const materialHash=currentMaterialHash(root,'HEAD',root);
  const storyFilesHash=currentStoryFilesHash(root,'HEAD',root);
  const expected={headHash:reviewedHeadHash,materialHash,storyFilesHash};
  const live=()=>verifyManagedReviewLiveBinding({gitCwd:root,metadataRoot:root,storyId,expected});
  const commitAll=message=>{git('add','.');git('commit','-qm',message);return git('rev-parse','HEAD');};
  const maintenance=commit=>{const rules=[];const ok=isVerifiedReviewMaintenanceCommit({gitCwd:root,metadataRoot:root,storyId,commit,
    reviewedHeadHash,reviewedMaterialHash:materialHash,reviewedStoryFilesHash:storyFilesHash,onRefusal:rule=>rules.push(rule)});return {ok,rules};};

  // Importer commit: one managed receipt's pass.
  const pass={id:`${storyId}:RP-001`,agent:'proof-or-stop-review-concept',reviewRound:'r2',reviewRunId:`${storyId}:RR-001`,
    managedEvidenceBinding:{receiptId:'sha256:'+'a'.repeat(64)}};
  writeFileSync(store.storyFilePath(storyId,'review-passes.json'),JSON.stringify({passes:[pass]})+'\n');
  commitAll(`proof-or-stop: record ${storyId} managed_review_evidence_import metadata`);
  assert.equal(live().valid,true,'IMPORTER_COMMIT_ACCEPTED');

  // Direct finalize: zero-wave completeness-only epoch + receipt.
  const at=new Date().toISOString();
  const cutoff={headHash:git('rev-parse','HEAD'),materialHash,storyFilesHash};
  const epoch=sign({schemaVersion:'proof-or-stop.review_inventory_epoch.v1',epochId:`${storyId}:RIE-001`,storyId,reviewRound:'r2',
    state:'FINALIZED',begunAt:at,updatedAt:at,cutoff,scopeDigest:'c'.repeat(64),requiredLanes:[],maxWaves:1,waves:[],receiptId:`${storyId}:RIE-001:RCP-001`},signReviewInventoryEpoch);
  const receipt=sign({schemaVersion:'proof-or-stop.review_inventory_receipt.v1',receiptId:epoch.receiptId,epochId:epoch.epochId,storyId,
    reviewRound:'r2',cutoff,scopeDigest:epoch.scopeDigest,requiredLanes:[],waveCount:0,findingSetDigest:'d'.repeat(64),coverageDigest:'d'.repeat(64),
    saturationResult:'ZERO_NEW_VERIFIED_FINDINGS',authority:'inventory-completeness-only',authorizesTest:false,issuedAt:at},signReviewInventoryReceipt);
  store.writeReviewInventoryEpochs(storyId,{...emptyReviewInventoryEpochData(),epochs:[epoch],receipts:[receipt]});
  const finalizeCommit=commitAll(`proof-or-stop: record ${storyId} review epoch metadata`);
  assert.equal(live().valid,true,'DIRECT_FINALIZE_ACCEPTED');

  // Cancel of that receipt (review_inventory_cancel's exact write).
  const cancelledAt=new Date(Date.now()+1000).toISOString();
  const reason='completeness-only receipt refused by certification';
  const cancelled=sign({...epoch,state:'CANCELLED',updatedAt:cancelledAt,cancelledAt,cancelReason:reason,terminalRunSequenceBoundary:1},signReviewInventoryEpoch);
  const invalidated=sign({...receipt,invalidatedAt:cancelledAt,invalidationReason:reason},signReviewInventoryReceipt);
  store.writeReviewInventoryEpochs(storyId,{...emptyReviewInventoryEpochData(),epochs:[cancelled],receipts:[invalidated]});
  const cancelCommit=commitAll(`proof-or-stop: record ${storyId} review epoch metadata`);
  assert.deepEqual(maintenance(cancelCommit),{ok:true,rules:[]},'CANCEL_PUBLICATION_AUTHENTICATED');
  // The earlier finalize stays authentic after its epoch was later cancelled.
  assert.equal(maintenance(finalizeCommit).ok,true,'CANCELLED_FINALIZE_STAYS_AUTHENTIC');
  const afterCancel=live();
  assert.equal(afterCancel.valid,true,`REVIEW_EPOCH_CANCEL_LINEAGE_RED: ${afterCancel.reason} ${JSON.stringify(afterCancel.lineageRefusal)}`);
  const good=git('rev-parse','HEAD');

  // Negative: a "cancel" that also rewrites another signed field.
  const forged=sign({...cancelled,scopeDigest:'e'.repeat(64)},signReviewInventoryEpoch);
  store.writeReviewInventoryEpochs(storyId,{...emptyReviewInventoryEpochData(),epochs:[forged],receipts:[invalidated]});
  // Undo the cancel commit so the forged row is a cancellation of the FINALIZED epoch.
  git('reset','-q','--soft',finalizeCommit);
  const forgedCommit=commitAll(`proof-or-stop: record ${storyId} review epoch metadata`);
  const forgedVerdict=maintenance(forgedCommit);
  assert.equal(forgedVerdict.ok,false,'CANCEL_REWRITING_SIGNED_FIELDS_REFUSED');
  assert.match(forgedVerdict.rules.join('; '),/rewrites signed epoch fields beyond the cancellation/);
  const refused=live();
  assert.equal(refused.valid,false,'FORGED_CANCEL_INVALIDATES_LINEAGE');
  assert.equal(refused.lineageRefusal?.commit,forgedCommit,'DIAGNOSTIC_NAMES_THE_REFUSED_COMMIT');
  assert.match(refused.lineageRefusal?.rule??'',/rewrites signed epoch fields/,'DIAGNOSTIC_NAMES_THE_RULE');
  assert.match(refused.reason,/^managed_review_live_head_lineage_invalid:reviewed=[a-f0-9]{40}:live=[a-f0-9]{40}$/,'REASON_STAYS_MACHINE_EXACT');
  git('reset','-q','--hard',good);

  // Negative: an epoch publication appending a pass that is not its own deferred result.
  const foreignPass={id:`${storyId}:RP-002`,agent:'proof-or-stop-review-quality',reviewRound:'r2',reviewRunId:`${storyId}:RR-999`};
  writeFileSync(store.storyFilePath(storyId,'review-passes.json'),JSON.stringify({passes:[pass,foreignPass]})+'\n');
  writeFileSync(store.storyFilePath(storyId,'review-runs.json'),JSON.stringify({runs:[]})+'\n');
  store.writeReviewInventoryEpochs(storyId,{...emptyReviewInventoryEpochData(),epochs:[cancelled],receipts:[invalidated]});
  git('reset','-q','--soft',finalizeCommit);
  const riding=maintenance(commitAll(`proof-or-stop: record ${storyId} review epoch metadata`));
  assert.equal(riding.ok,false,'FOREIGN_PASS_ON_EPOCH_PUBLICATION_REFUSED');
  assert.match(riding.rules.join('; '),/appends review-passes\.json row .*RP-002 that is not a deferred result/);
  git('reset','-q','--hard',good);

  // Negative: a bookkeeping subject that changes review evidence.
  writeFileSync(store.storyFilePath(storyId,'review-passes.json'),JSON.stringify({passes:[pass,foreignPass]})+'\n');
  commitAll(`proof-or-stop: record ${storyId} validate metadata`);
  const bookkeeping=live();
  assert.equal(bookkeeping.valid,false,'BOOKKEEPING_SUBJECT_CANNOT_CHANGE_REVIEW_PASSES');
  assert.match(bookkeeping.lineageRefusal?.rule??'',/review evidence .*review-passes\.json/);
  git('reset','-q','--hard',good);

  // Negative: an importer commit that rewrites an earlier pass row.
  writeFileSync(store.storyFilePath(storyId,'review-passes.json'),JSON.stringify({passes:[{...pass,agent:'proof-or-stop-review-quality'}]})+'\n');
  commitAll(`proof-or-stop: record ${storyId} managed_review_evidence_import metadata`);
  const rewrite=live();
  assert.equal(rewrite.valid,false,'IMPORTER_REWRITING_EARLIER_PASS_REFUSED');
  assert.match(rewrite.lineageRefusal?.rule??'',/rewrites earlier review-passes\.json rows/);
  git('reset','-q','--hard',good);

  // Negative: an importer commit appending a pass with no managed binding.
  writeFileSync(store.storyFilePath(storyId,'review-passes.json'),JSON.stringify({passes:[pass,foreignPass]})+'\n');
  commitAll(`proof-or-stop: record ${storyId} managed_review_evidence_import metadata`);
  assert.equal(live().valid,false,'IMPORTER_APPENDING_UNBOUND_PASS_REFUSED');
  git('reset','-q','--hard',good);
  assert.equal(live().valid,true,'FIXTURE_RESTORED');
  console.log('REVIEW_EPOCH_CANCEL_LINEAGE_GREEN');
} finally {rmSync(root,{recursive:true,force:true});}
