/**
 * Real Git regression for the finding closure rule (2026-10-01): the owner
 * closes a verified finding in REVIEW with finding_resolve, whose metadata
 * commit lands after the reviewed head. isVerifiedReviewMaintenanceCommit
 * (core/review-maintenance-lineage.ts) authenticates that commit only when it
 * carries signed open->resolved lifecycle transitions and their exact
 * findings.json mirror. Positive: the real handler's commit keeps the managed
 * live binding valid. Negative controls, each under the same subject, must
 * invalidate the binding and name the commit and rule:
 *   (a) a non-resolve field of findings.json changes;
 *   (b) a finding is resolved in the mirror without its signed ledger row;
 *   (c) a foreign story artifact or material file is touched;
 *   (d) an existing ledger row is rewritten.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StoryStore} from '../dist/core/store.js';
import {currentMaterialHash,currentStoryFilesHash} from '../dist/core/evidence-freshness.js';
import {verifyManagedReviewLiveBinding} from '../dist/core/managed-review-evidence.js';
import {isVerifiedReviewMaintenanceCommit} from '../dist/core/review-maintenance-lineage.js';
import {createFindingHandlers} from '../dist/handlers/finding.js';
import {listRuntimeArtifactIgnorePatterns} from '../dist/core/runtime-artifact-registry.js';

const root=mkdtempSync(join(tmpdir(),'finding-resolve-lineage-'));
const storyId='B-resolve-lineage';
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const subject=`proof-or-stop: record ${storyId} finding_resolve metadata`;
const before=process.cwd();
try {
  git('init','-q','-b','main');git('config','user.name','Lineage fixture');git('config','user.email','lineage@example.invalid');
  mkdirSync(join(root,'src'));
  writeFileSync(join(root,'.gitignore'),listRuntimeArtifactIgnorePatterns().join('\n')+'\n');
  writeFileSync(join(root,'src','subject.ts'),'export const subject = 1;\n');
  const store=new StoryStore(root);
  store.writeStory(storyId,{storyId,name:'resolve-lineage-fixture',phase:'REVIEW',type:'bug',priority:'medium',description:'Resolve lineage fixture',events:[]});
  const finding=(n,desc)=>({id:`${storyId}:F-00${n}`,desc,severity:'medium',category:'edge',status:'open',evidenceState:'verified',
    agent:'proof-or-stop-review-test-coverage',createdAt:`2026-10-01T00:00:0${n}.000Z`,reviewRound:'r1'});
  store.writeFindings(storyId,{findings:[finding(1,'Reverse("") is untested.'),finding(2,'Upper("") is untested.')]});
  const pass={id:`${storyId}:RP-001`,agent:'proof-or-stop-review-concept',reviewRound:'r2',reviewRunId:`${storyId}:RR-001`,
    managedEvidenceBinding:{receiptId:'sha256:'+'a'.repeat(64)}};
  writeFileSync(store.storyFilePath(storyId,'review-passes.json'),JSON.stringify({passes:[pass]})+'\n');
  git('add','.');git('commit','-qm','reviewed source');
  const reviewedHeadHash=git('rev-parse','HEAD');
  const materialHash=currentMaterialHash(root,'HEAD',root);
  const storyFilesHash=currentStoryFilesHash(root,'HEAD',root);
  const live=()=>verifyManagedReviewLiveBinding({gitCwd:root,metadataRoot:root,storyId,expected:{headHash:reviewedHeadHash,materialHash,storyFilesHash}});
  const commitAll=message=>{git('add','-A');git('commit','-qm',message);return git('rev-parse','HEAD');};
  const maintenance=commit=>{const rules=[];const ok=isVerifiedReviewMaintenanceCommit({gitCwd:root,metadataRoot:root,storyId,commit,
    reviewedHeadHash,reviewedMaterialHash:materialHash,reviewedStoryFilesHash:storyFilesHash,onRefusal:rule=>rules.push(rule)});return {ok,rules};};
  const resolve=findingId=>{
    process.chdir(root);
    try { return createFindingHandlers({root,store,scanRoot:root}).finding_resolve({storyId,findingId,
      resolution:'Repair commit adds the empty-string test; the focused test passes.',resolutionType:'fixed',resolveEvidenceStrength:'strong'}); }
    finally { process.chdir(before); }
  };
  const findingsPath=store.storyFilePath(storyId,'findings.json');
  const ledgerPath=store.storyFilePath(storyId,'finding-ledger.json');
  const readJson=path=>JSON.parse(readFileSync(path,'utf8'));
  const writeJson=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n');
  /** The real handler publication; committed by the handler or here under the canonical subject. */
  const publishResolve=findingId=>{
    const head=git('rev-parse','HEAD');
    assert.match(resolve(findingId),/resolved/);
    if (git('rev-parse','HEAD')===head) commitAll(subject);
    assert.equal(git('show','-s','--format=%s','HEAD'),subject,'RESOLVE_COMMIT_SUBJECT');
    return git('rev-parse','HEAD');
  };
  const refusedWith=(label,commit,pattern)=>{
    const verdict=maintenance(commit);
    assert.equal(verdict.ok,false,`${label}_REFUSED`);
    assert.match(verdict.rules.join('; '),pattern,`${label}_RULE`);
    const binding=live();
    assert.equal(binding.valid,false,`${label}_INVALIDATES_LIVE_BINDING`);
    assert.equal(binding.lineageRefusal?.commit,commit,`${label}_NAMES_THE_COMMIT`);
    assert.match(binding.lineageRefusal?.rule??'',pattern,`${label}_NAMES_THE_RULE`);
    assert.match(binding.reason,/^managed_review_live_head_lineage_invalid:reviewed=[a-f0-9]{40}:live=[a-f0-9]{40}$/,`${label}_REASON_EXACT`);
  };

  // Positive: the real finding_resolve publication is authenticated bookkeeping.
  const first=publishResolve(`${storyId}:F-001`);
  assert.deepEqual(maintenance(first),{ok:true,rules:[]},'RESOLVE_PUBLICATION_AUTHENTICATED');
  assert.equal(live().valid,true,`RESOLVE_KEEPS_LIVE_BINDING: ${JSON.stringify(live().lineageRefusal)}`);
  const good=git('rev-parse','HEAD');

  // (a) The same publication also edits a non-resolve field (desc) of the resolved row.
  git('reset','-q','--soft',reviewedHeadHash);
  const edited=readJson(findingsPath);edited.findings[0].desc='rewritten description';writeJson(findingsPath,edited);
  refusedWith('NON_RESOLVE_FIELD',commitAll(subject),/finding_resolve publication: findings\.json row .*F-001 is not exactly the mirror/);
  git('reset','-q','--hard',good);

  // (b) F-002 flips to resolved in the mirror with no signed ledger row of its own.
  const unsigned=readJson(findingsPath);Object.assign(unsigned.findings[1],{status:'resolved',resolvedAt:new Date().toISOString(),resolvedReason:'no ledger row'});
  writeJson(findingsPath,unsigned);
  const ledgerAtGood=readJson(ledgerPath);
  // Keep the ledger file in the commit (unchanged content would drop it), so append nothing but touch formatting.
  writeFileSync(ledgerPath,JSON.stringify(ledgerAtGood)+'\n');
  refusedWith('RESOLVE_WITHOUT_LEDGER_ROW',commitAll(subject),/finding_resolve publication: (appends ledger records other than|findings\.json changes do not match the lifecycle transitions)/);
  git('reset','-q','--hard',good);
  //    ...and the same without touching the ledger at all.
  writeJson(findingsPath,unsigned);
  refusedWith('RESOLVE_WITHOUT_LEDGER_FILE',commitAll(subject),/finding_resolve publication: does not publish both findings\.json and finding-ledger\.json/);
  git('reset','-q','--hard',good);

  // (c) The resolve publication also touches a foreign story artifact, or material.
  const second=publishResolve(`${storyId}:F-002`);
  git('reset','-q','--soft',good);
  writeFileSync(store.storyFilePath(storyId,'review-passes.json'),JSON.stringify({passes:[pass,{...pass,id:`${storyId}:RP-002`}]})+'\n');
  refusedWith('FOREIGN_ARTIFACT',commitAll(subject),/finding_resolve publication: touches review-passes\.json/);
  git('reset','-q','--hard',second);git('reset','-q','--soft',good);
  writeFileSync(join(root,'src','subject.ts'),'export const subject = 2;\n');
  const materialCommit=commitAll(subject);
  const materialVerdict=maintenance(materialCommit);
  assert.equal(materialVerdict.ok,false,'MATERIAL_REFUSED');
  assert.match(materialVerdict.rules.join('; '),/outside this Story's metadata directory/,'MATERIAL_RULE');
  assert.equal(live().valid,false,'MATERIAL_INVALIDATES_LIVE_BINDING');
  git('reset','-q','--hard',second);

  // (d) The second publication rewrites a ledger row published by the first.
  git('reset','-q','--soft',good);
  const rewritten=readJson(ledgerPath);
  const transition=rewritten.records.find(row=>row.recordType==='finding_lifecycle_transition');
  transition.payload.reason='rewritten reason';
  writeJson(ledgerPath,rewritten);
  refusedWith('LEDGER_ROW_REWRITE',commitAll(subject),/finding_resolve publication: (finding-ledger\.json is invalid|rewrites earlier finding-ledger records)/);
  git('reset','-q','--hard',second);

  // (a2) A mirror-only ledgerCommitReceiptId backfill that names no binding receipt.
  git('reset','-q','--soft',good);
  const bogus=readJson(findingsPath);bogus.findings[0].ledgerCommitReceiptId='lrc_forged';writeJson(findingsPath,bogus);
  refusedWith('FORGED_RECEIPT_BACKFILL',commitAll(subject),/finding_resolve publication: findings\.json (changes do not match|row .*F-001 is not exactly the mirror)/);
  git('reset','-q','--hard',second);

  assert.deepEqual(maintenance(second),{ok:true,rules:[]},'SECOND_RESOLVE_AUTHENTICATED');
  assert.equal(live().valid,true,'FIXTURE_RESTORED');
  console.log('FINDING_RESOLVE_LINEAGE_GREEN');
} finally {process.chdir(before);rmSync(root,{recursive:true,force:true});}
