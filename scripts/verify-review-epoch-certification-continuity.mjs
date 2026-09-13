#!/usr/bin/env node
import { nativeReviewFixtureBrokers, runBrokeredNativeReviewCli } from "../packages/main/dist/tasks/native-review-fixture.js";
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {computeProcessMetrics} from '../packages/main/dist/core/process-metrics.js';
import {buildMilestoneLedger} from '../packages/main/dist/core/proofstory.js';
import {SCOPE_PATH_CANONICALIZER_VERSION} from '../packages/main/dist/core/scope-path-classifier.js';
import {createHostRunHandlers} from '../packages/main/dist/handlers/host-run.js';
import {createManagedReviewEvidenceHandlers} from '../packages/main/dist/handlers/managed-review-evidence.js';
import {getManagedHostRunStatus, managedHostRunReceipt, managedHostRunDirectory} from '../packages/main/dist/core/managed-host-run.js';
import {collectReviewerEvidenceState, evaluateReviewRunMetadataRetention, currentScopeContextForStory} from '../packages/main/dist/core/review-run.js';
import {verifyManagedReviewLiveBinding, managedInventorySubjectState, isSealedManagedPromptDigestCurrent} from '../packages/main/dist/core/managed-review-evidence.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StoryStore } from "../packages/main/dist/core/store.js";
import { resetConfigCache } from "../packages/main/dist/core/config.js";
import { evaluateReviewInventoryWave, finalizedUnconsumedReviewInventory, verifyReviewInventoryEpoch, verifyReviewInventoryReceipt, signReviewInventoryEpoch } from "../packages/main/dist/core/review-inventory-epoch.js";
import { isPromptBodyArtifactPath } from "../packages/main/dist/core/prompt-body-store.js";
import { domainSeparatedDigest } from "../packages/main/dist/core/prompt-contracts.js";
import { readOwnerLease, releaseOwnerLease } from "../packages/main/dist/core/story-owner-lease.js";
import { adapterSessionEnv, adapterSessionId } from "../packages/main/dist/tasks/adapter-session-env.js";
import {isVerifiedReviewMaintenanceCommit} from '../packages/main/dist/core/review-maintenance-lineage.js';
import {getHealthPath} from '../packages/main/dist/core/health.js';
import {isMissingReviewSnapshotError} from '../packages/main/dist/core/review-metadata-surface.js';
import {recordConvergenceProgress} from '../packages/main/dist/core/convergence-progress-journal.js';
assert(isMissingReviewSnapshotError({stderr:"fatal: path 'x' exists on disk, but not in 'head'"}));
assert(isMissingReviewSnapshotError({stderr:"fatal: path 'x' does not exist in 'head'"}));
assert.equal(isMissingReviewSnapshotError({stderr:'fatal: bad object head'}),false);
function assertNoReaderHealth(action, expectedAnomaly=false) {
 const scratch=mkdtempSync(join(tmpdir(),'review-reader-health-'));
 const old=process.env.PROOF_OR_STOP_HEALTH_PATH, path=join(scratch,'health.jsonl');
 process.env.PROOF_OR_STOP_HEALTH_PATH=path;
 try {assert.equal(getHealthPath(),path);action();const rows=existsSync(path)?readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];assert.equal(rows.length,typeof expectedAnomaly==='number'?expectedAnomaly:expectedAnomaly?1:0,'designed refusals stay quiet; unexpected reader errors stay observable');for(const row of rows)assert.equal(row.category,'review-maintenance-lineage');}
 finally {if(old===undefined)delete process.env.PROOF_OR_STOP_HEALTH_PATH;else process.env.PROOF_OR_STOP_HEALTH_PATH=old;rmSync(scratch,{recursive:true,force:true});}
}

import {evaluatePersistedReviewToTestIndexTransition} from '../packages/main/dist/core/review-run.js';
import {closeoutArtifactPolicyFor, evaluateMetadataOnlyReviewRetention, isCanonicalCloseoutEvidenceWrite, assertCanonicalCloseoutWrite, computeCloseoutWriteReceiptIntegrity} from '../packages/main/dist/core/closeout-trust.js';
assert.equal(isCanonicalCloseoutEvidenceWrite('checklist.json','verification_evidence_add'),false);
assert.throws(()=>assertCanonicalCloseoutWrite('checklist.json','verification_evidence_add'),/non-canonical writer/);
import {reviewRefreshStoryPrefix, isOwnerLeaseHeartbeatOnly, createReviewRefreshReadCache, reviewRefreshReadCacheStats, isCurrentVerifiedEvidenceRefreshArtifact} from '../packages/main/dist/core/review-evidence-refresh.js';
const leaseControl={sessionId:'fixture-owner',pid:1,heartbeatAt:'2026-01-01T00:00:00.000Z'};
assert(isOwnerLeaseHeartbeatOnly(leaseControl,{...leaseControl,pid:2,heartbeatAt:'2026-01-01T00:00:01.000Z'}));
assert.equal(isOwnerLeaseHeartbeatOnly(leaseControl,{...leaseControl,sessionId:'foreign-owner'}),false);
assert.equal(isOwnerLeaseHeartbeatOnly(leaseControl,{...leaseControl,storyId:'foreign-story'}),false);
assert.equal(isOwnerLeaseHeartbeatOnly(leaseControl,{...leaseControl,futureField:'unreviewed'}),false);
assert.equal(evaluateMetadataOnlyReviewRetention({materialUnchanged:true,storyFilesUnchanged:true,stableEvaluationHead:true,storedCompositeScopeDigest:'scope',currentCompositeScopeDigest:'scope',storedReviewRound:'round',currentReviewRound:'round',changedArtifacts:[{path:'checklist.json',writer:'verification_evidence_add',valid:true,strictEvidenceRefresh:true}]}).ok,false,'caller booleans cannot grant non-canonical receipt authority');
import {hasMechanicalExecutionAuthority} from '../packages/main/dist/core/verification-receipt-authority.js';
import {executeCausalEvidence,preflightCausalEvidence,DEFAULT_CAUSAL_SELECTOR_POLICY,verifyCausalEvidenceReceipt} from '../packages/main/dist/core/causal-evidence.js';
import {currentMaterialHash,currentStoryFilesHash} from '../packages/main/dist/core/evidence-freshness.js';
import {PROOF_OR_STOP_CLI_VERSION} from '../packages/main/dist/core/proof-or-stop-brand.js';
const receiptCorpusSize=200;
const digest='sha256:'+'a'.repeat(64);
assert(isSealedManagedPromptDigestCurrent(digest,digest,digest));
assert.equal(isSealedManagedPromptDigestCurrent(undefined,digest,digest),false,'missing launch digest seal must never compare caller values to themselves');
assert.equal(isSealedManagedPromptDigestCurrent('bad',digest,digest),false);
assert.equal(isSealedManagedPromptDigestCurrent(digest,'sha256:'+'b'.repeat(64),digest),false);
const storyId = 'B-inventory-handler';
const reviewRound = '2020-01-01T00:00:00.000Z';
const cliPath = fileURLToPath(new URL('../../../../bin/proof-or-stop.js', new URL("../packages/main/dist/tasks/review-inventory-handler-smoke.js", import.meta.url)));
const isolatedFixtureRoots = new Set();
function releaseCompletedFixtureOwner(root, expectedSessionId) {
    assert.ok(isolatedFixtureRoots.has(root), 'lease handoffs are isolated test fixtures only');
    const storyDir = new StoryStore(root).storyDirPath(storyId);
    const lease = readOwnerLease(storyDir);
    if (lease?.sessionId === expectedSessionId) {
        assert.equal(releaseOwnerLease(storyDir), true, 'completed matching fixture owner releases its lease');
        assert.equal(readOwnerLease(storyDir), null);
    }
}
function git(root, args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function cli(root, command, payload, env = {}) {
    const actor = env.PROOF_OR_STOP_AGENT ?? 'main';
    const task = env.PROOF_OR_STOP_SESSION_ID ?? 'review-inventory-owner';
    // Fixture child calls release their lease for role handoffs. Restore only
    // this same logical session's genuine committed lease before its next call,
    // so continuity tests exercise heartbeat updates rather than new owners.
    assert(isolatedFixtureRoots.has(root));
    const ownerPath=new StoryStore(root).storyFilePath(storyId,'owner-lease.json');
    const ownerGitPath=`.proof-or-stop/story/actives/${storyId}/owner-lease.json`;
    if(!existsSync(ownerPath) && git(root,['ls-tree','--name-only','HEAD','--',ownerGitPath])) {
      const bytes=execFileSync('git',['show','HEAD:'+ownerGitPath],{cwd:root,encoding:'utf8'});
      const previous=JSON.parse(bytes);
      if(previous.sessionId===adapterSessionId(root.split('/.worktrees/')[0],task,actor)) writeFileSync(ownerPath,bytes);
    }

    try {
        return execFileSync(process.execPath, [cliPath, '--root', root, command, JSON.stringify(payload)], {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                ...env,
                PROOF_OR_STOP_AGENT: actor,
                ...adapterSessionEnv(task, actor),
            },
        }).trim();
    }
    finally {
        // The child has completed. Release only its own verified fixture lease.
        releaseCompletedFixtureOwner(root, adapterSessionId(root.split('/.worktrees/')[0], task, actor));
    }
}
function setup(author = { name: 'proof-or-stop-implementer', email: 'proof-or-stop-implementer@noreply.local' }) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-inventory-handler-')));
    isolatedFixtureRoots.add(root);
    mkdirSync(join(root, 'packages/main/src'), { recursive: true });
    mkdirSync(join(root, 'packages/main/tests'), { recursive: true });
    mkdirSync(join(root, 'docs/requirements/decisions'), { recursive: true });
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
        nativeReviewInvocation: { brokers: nativeReviewFixtureBrokers() },
 validate:{commands:[{label:"native-fast",command:process.execPath,args:["--version"],focus:["fast"],timeoutMs:15000}]},
        scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
    }));
    writeFileSync(join(root, 'packages/main/src/subject.ts'), '// Fixture contract: subject must equal zero.\nexport const subject = 1;\n');
    writeFileSync(join(root, 'packages/main/src/consumer-a.ts'), "export { subject } from './subject.js';\n");
    writeFileSync(join(root, 'packages/main/src/consumer-b.ts'), "export { subject } from './consumer-a.js';\n");
    writeFileSync(join(root, 'packages/main/tests/isolated.test.ts'), 'export const isolatedTest = 1;\n');
    writeFileSync(join(root, 'docs/requirements/decisions/inventory.md'), '# Review inventory\n');
    writeFileSync(join(root, 'docs/requirements/decisions/inventory-secondary.md'), '# Review inventory supplementary\n');
    for (const name of ['almanac', 'beacon', 'compass', 'dossier', 'ledger', 'notebook']) {
        writeFileSync(join(root, `docs/requirements/decisions/${name}.md`), `# ${name}\nUnrelated fixture material.\n`);
    }
    git(root, ['init']);
    git(root, ['checkout', '-b', 'main']);
    git(root, ['config', 'user.name', author.name]);
    git(root, ['config', 'user.email', author.email]);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'initial']);
    resetConfigCache();
    const store = new StoryStore(root);
    const story = {
        storyId, name: 'inventory-handler-smoke', title: 'Inventory handler smoke',
        description: 'Exercise real review inventory handler persistence and fail-closed paths.',
        type: 'chore', phase: 'REVIEW', priority: 'high', createdAt: reviewRound,
        startedAt: reviewRound, endedAt: null, currentReviewRound: reviewRound,
        events: [{ phase: 'REVIEW', action: 'advance', timestamp: reviewRound }],
    };
    store.writeStory(storyId, story);
    return { root, store };
}
// Real native required lanes and the completeness critic supply inventory authority.
// Fixture broker host labels are disposable test identities, not cross-host assurance.

const {runIsolatedFindingFixture,reviewEpochFixtureBudgetMs}=await import('../packages/main/dist/tasks/isolated-finding-fixture.js');
const budgetEnv=(timeoutMs,deadlineAt=timeoutMs+1000,entry='test:review-epoch-certification-continuity')=>({PROOF_OR_STOP_FULL_SUITE_ENTRY_BUDGET:JSON.stringify({entry,timeoutMs,deadlineAt})});
assert.equal(reviewEpochFixtureBudgetMs({},1000),420000);
assert.equal(reviewEpochFixtureBudgetMs(budgetEnv(450000),1000),420000);
assert.equal(reviewEpochFixtureBudgetMs(budgetEnv(675000),1000),540000);
assert.equal(reviewEpochFixtureBudgetMs(budgetEnv(200000),1000),170000);
assert.equal(reviewEpochFixtureBudgetMs(budgetEnv(675000,101000),1000),70000);
assert.equal(reviewEpochFixtureBudgetMs(budgetEnv(675001),1000),540000);
assert.equal(reviewEpochFixtureBudgetMs(budgetEnv(900000,101000),1000),70000,'over-cap clamp still honors the original remaining deadline');
for (const value of [0,-1,null,'675000']) assert.throws(()=>reviewEpochFixtureBudgetMs(budgetEnv(value),1000),/Invalid/);
assert.throws(()=>reviewEpochFixtureBudgetMs(budgetEnv(450000,1000),1000),/exhausted/);
assert.equal(reviewEpochFixtureBudgetMs(budgetEnv(450000,451000,'other'),1000),420000,'foreign ancestor envelope does not replace the standalone watchdog');
assert.throws(()=>reviewEpochFixtureBudgetMs({PROOF_OR_STOP_FULL_SUITE_ENTRY_BUDGET:'bad'},1000));
if(await runIsolatedFindingFixture(import.meta.url)) process.exit(0);
const modes=['clean','coverage-added','wrong-subject','wrong-story-path','missing-epochs','forged-publisher','forged-refresh','cancelled'];
{
const fixture=setup({name:'Harmonynet',email:'26995688+Harmonynet@users.noreply.github.com'});
const primaryRoot=fixture.root;const worktreePath=join(primaryRoot,'.worktrees',storyId);
fixture.store.writeStory(storyId,{...fixture.store.readStory(storyId),worktree:{path:worktreePath,branch:'story/'+storyId,createdAt:reviewRound}});
fixture.store.writeChecklist(storyId,{items:[]});
git(primaryRoot,['add','--',`.proof-or-stop/story/actives/${storyId}/index.json`,`.proof-or-stop/story/actives/${storyId}/checklist.json`]);
git(primaryRoot,['commit','-m','record initial native linked fixture']);
git(primaryRoot,['worktree','add','-b','story/'+storyId,worktreePath]);
fixture.root=worktreePath;fixture.store=new StoryStore(worktreePath);isolatedFixtureRoots.add(worktreePath);
console.log('SATURATED_FIXTURE_ROOT '+fixture.root);
assert.equal(reviewRefreshStoryPrefix(fixture.root,fixture.root),null,'Story root cannot equal Git root');
assert.equal(reviewRefreshStoryPrefix(fixture.root,primaryRoot),null,'Story root cannot escape linked worktree');
assert.equal(reviewRefreshStoryPrefix(fixture.root,fixture.store.storyDirPath(storyId)),`.proof-or-stop/story/actives/${storyId}/`);
console.log('REFRESH_STORY_PREFIX_CONTAINMENT_GREEN');

try {
const env=(agent,session)=>({PROOF_OR_STOP_AGENT:agent,PROOF_OR_STOP_SESSION_ID:session});
writeFileSync(join(fixture.root,'packages/main/src/subject.ts'),'export const subject = 2;\n');
git(fixture.root,['add','--','packages/main/src/subject.ts']);
git(fixture.root,['commit','-m','test: change the isolated implementation subject']);
fixture.store.writeChecklist(storyId,{items:[{id:'CHK-001',title:'Execute the bounded runtime witness',status:'done',relatedDocs:[],verificationIntent:{happy:[{desc:'The current node executable emits a complete bounded selector transcript',type:'cli'},{desc:'Optional runtime witness for coverage-addition refusal',type:'cli',priority:'should'}],edge:[],adversarial:[]}}]});
fixture.store.writeScopeContract(storyId,{storyId,mode:'enforce',pathCanonicalizerVersion:SCOPE_PATH_CANONICALIZER_VERSION,pathCanonicalizationMode:'enforce',allowedModify:['packages/main/src/subject.ts'],allowedCreate:[],allowedTest:[],protectedFiles:[],explicitExcludes:[],acknowledgements:[],createdAt:reviewRound,updatedAt:reviewRound});
fixture.store.writeMilestoneLedger(storyId,buildMilestoneLedger({storyId,state:'candidate',milestones:[{id:'M1',sourceRequirementId:'REQ-1',claim:'Preserve reviewed evidence coverage',doneMeans:'The bounded witness passes',requiredEvidence:['integration_test'],checklistRefs:['CHK-001'],verificationIntentRefs:['CHK-001:happy:0'],status:'planned'}]}));
git(fixture.root,['add','--',`.proof-or-stop/story/actives/${storyId}/scope-contract.json`,`.proof-or-stop/story/actives/${storyId}/milestone-ledger.json`]);
git(fixture.root,['add','--',`.proof-or-stop/story/actives/${storyId}/checklist.json`]);
git(fixture.root,['commit','-m','test: freeze disposable verification intent']);
const evidencePayload={storyId,itemId:'CHK-001',intentRef:'CHK-001:happy:0',kind:'integration_test',command:'node -e '+JSON.stringify("process.stdout.write('x'.repeat(13000)+'OUTPUT_END_')"),selector:'OUTPUT_END_',note:'Execute the unchanged bounded runtime witness for authenticated evidence refresh.'};
const unpinnedHead=git(fixture.root,['rev-parse','HEAD']);
cli(fixture.root,'verification_evidence_add',evidencePayload,env('main','saturation-owner'));
// Preserve the real tool-owned immutable pin in the disposable pre-review
// fixture, so the next publication tests evidence-only change, not first pinning.
cli(fixture.root,'verification_evidence_add',{...evidencePayload,intentRef:'CHK-001:happy:1'},env('main','saturation-owner'));
const pinnedChecklist=fixture.store.readChecklist(storyId);
const initialPairedEvidence=structuredClone(pinnedChecklist.items[0].verificationEvidence);
const pinnedOwnerPath=fixture.store.storyFilePath(storyId,'owner-lease.json');
const pinnedOwnerBytes=execFileSync('git',['show',`HEAD:.proof-or-stop/story/actives/${storyId}/owner-lease.json`],{cwd:fixture.root,encoding:'utf8'});
for(const item of pinnedChecklist.items) item.verificationEvidence=item.verificationEvidence.filter(row=>row.intentRef!=='CHK-001:happy:1');
// Retain the real earlier PASS as reviewed coverage; the next receipt refreshes it.
git(fixture.root,['reset','--hard',unpinnedHead]);
fixture.store.writeChecklist(storyId,pinnedChecklist);
if(pinnedOwnerBytes!==null) {writeFileSync(pinnedOwnerPath,pinnedOwnerBytes);git(fixture.root,['add','--',`.proof-or-stop/story/actives/${storyId}/owner-lease.json`]);}
git(fixture.root,['add','--',`.proof-or-stop/story/actives/${storyId}/checklist.json`]);
git(fixture.root,['commit','-m','test: preserve the actual immutable execution pin']);
const smallPinnedHead=git(fixture.root,['rev-parse','HEAD']);
// Populate a realistic signed receipt corpus through actual bounded Node
// executions. These receipts are not attached to any Story acceptance intent.
const corpusIndexPath=resolve(fixture.root,git(fixture.root,['rev-parse','--git-path','index']));
const corpusIndexBytes=readFileSync(corpusIndexPath);
const corpusHead=git(fixture.root,['rev-parse','HEAD']);
const corpusMaterial=currentMaterialHash(fixture.root,'HEAD',fixture.root);
const corpusStoryFiles=currentStoryFilesHash(fixture.root,'HEAD',fixture.root);
for(let ordinal=0;ordinal<receiptCorpusSize;ordinal++) {
 const marker='RECEIPT_CORPUS_'+ordinal;
 const command={executable:process.execPath,args:['-e',`process.stdout.write(${JSON.stringify(marker)})`]};
 const identity={storyId,cwd:fixture.root,command,bootstrap:null,inputs:{purpose:'bounded receipt corpus',ordinal},storyFilesHash:corpusStoryFiles,effectiveEnvironment:{},runtimeVersion:process.version,toolVersion:PROOF_OR_STOP_CLI_VERSION,selectorPolicy:DEFAULT_CAUSAL_SELECTOR_POLICY};
 const preflight=preflightCausalEvidence({
  cli:{available:true,path:process.execPath},worktree:{expected:fixture.root,actual:fixture.root},
  gitIndex:{readable:true,path:corpusIndexPath,expected:corpusHead,actual:corpusHead,contentDigest:createHash('sha256').update(corpusIndexBytes).digest('hex')},
  gitMaterial:{available:true,headHash:corpusHead,materialHash:corpusMaterial,storyFilesHash:corpusStoryFiles},
  writerLease:{available:true,valid:Boolean(readOwnerLease(fixture.store.storyDirPath(storyId)))},
  providerCapability:{required:['allowlisted-command','bounded-output'],available:['allowlisted-command','bounded-output']},
  resources:{required:{timeoutMs:5000},available:{timeoutMs:5000}},
  evidenceTarget:{writable:true,path:fixture.store.storyDirPath(storyId)},sideChannel:{available:true,maxOutputChars:12000,maxProgressEvents:10}
 },undefined,identity);
 const result=await executeCausalEvidence({identity,selector:marker,preflight,receiptStore:fixture.store,
  revalidateBeforeRun:()=>readFileSync(corpusIndexPath).equals(corpusIndexBytes),
  run:async()=>{const started=performance.now();const output=execFileSync(command.executable,command.args,{cwd:fixture.root,encoding:'utf8',timeout:5000});return {code:0,output,durationMs:performance.now()-started,timeoutMs:5000};}});
 assert.equal(result.disposition,'executed');assert.equal(result.verdict.result,'pass');
}
git(fixture.root,['add','--',`.proof-or-stop/story/actives/${storyId}/causal-evidence`]);
git(fixture.root,['commit','-m','test: populate a bounded receipt scale case']);
cli(fixture.root,'verification_evidence_add',evidencePayload,env('main','saturation-owner'));
{
 const refreshHead=git(fixture.root,['rev-parse','HEAD']);
 assert(isVerifiedReviewMaintenanceCommit({gitCwd:fixture.root,metadataRoot:fixture.root,storyId,commit:refreshHead,reviewedHeadHash:git(fixture.root,['rev-parse',refreshHead+'^'])}),'genuine durable output publication retains evidence-only lineage');
 const refreshPaths=git(fixture.root,['diff-tree','--no-commit-id','--name-only','-r',refreshHead]).split('\n').filter(Boolean);
 const cache=createReviewRefreshReadCache();
 const artifactNames=refreshPaths.map(path=>path.slice(`.proof-or-stop/story/actives/${storyId}/`.length)).filter(path=>path==='checklist.json'||path.startsWith('causal-evidence/'));
 const cacheArgs={gitCwd:fixture.root,metadataRoot:fixture.root,storyId,reviewedHeadHash:git(fixture.root,['rev-parse',refreshHead+'^']),snapshotHead:refreshHead,cache,isProtectedArtifact:closeoutArtifactPolicyFor};
 for(const artifactPath of artifactNames) assert(isCurrentVerifiedEvidenceRefreshArtifact({...cacheArgs,artifactPath}));
 const firstStats=reviewRefreshReadCacheStats(cache);
 assert.equal(firstStats.proofEvaluations,1,'all current artifacts share one complete commit proof');
 assert(firstStats.gitCommands<80,JSON.stringify(firstStats));
 for(let repeat=0;repeat<10;repeat++) for(const artifactPath of artifactNames) assert(isCurrentVerifiedEvidenceRefreshArtifact({...cacheArgs,artifactPath}));
 assert.deepEqual(reviewRefreshReadCacheStats(cache),firstStats,'repeated artifacts reuse immutable reads without repeated subprocesses');
 console.log('RECEIPT_CORPUS_CACHE_BOUND',JSON.stringify({receiptCorpusSize,...firstStats}));
 const outputPath=refreshPaths.find(path=>path.startsWith(`.proof-or-stop/story/actives/${storyId}/`+'causal-evidence/outputs/'));
 assert(outputPath,'genuine long-output evidence refresh must exercise durable output verification');
 for(const mode of ['tampered-output','unreferenced-output']) {
  git(fixture.root,['reset','--hard',refreshHead+'^']);
  for(const path of refreshPaths) {
   assert(path.startsWith(`.proof-or-stop/story/actives/${storyId}/`));mkdirSync(join(fixture.root,path,'..'),{recursive:true});
   writeFileSync(join(fixture.root,path),execFileSync('git',['show',refreshHead+':'+path],{cwd:fixture.root}));
  }
  const payload={output:'unreferenced output'};
  const badPath=mode==='tampered-output'?outputPath:`.proof-or-stop/story/actives/${storyId}/`+'causal-evidence/outputs/'+createHash('sha256').update(payload.output).digest('hex')+'.json';
  writeFileSync(join(fixture.root,badPath),JSON.stringify(payload)+'\n');
  git(fixture.root,['add','--',...refreshPaths,badPath]);
  git(fixture.root,['commit','-m',`proof-or-stop: record ${storyId} verification_evidence_add metadata`]);
  assert.equal(isVerifiedReviewMaintenanceCommit({gitCwd:fixture.root,metadataRoot:fixture.root,storyId,commit:git(fixture.root,['rev-parse','HEAD']),reviewedHeadHash:git(fixture.root,['rev-parse',refreshHead+'^'])}),false,mode);
  console.log('CAUSAL_OUTPUT_REFUSED '+mode);
 }
 git(fixture.root,['reset','--hard',refreshHead+'^']);
 for(const path of refreshPaths){mkdirSync(join(fixture.root,path,'..'),{recursive:true});writeFileSync(join(fixture.root,path),execFileSync('git',['show',refreshHead+':'+path],{cwd:fixture.root}));}
 const indexPath=`.proof-or-stop/story/actives/${storyId}/causal-evidence/index.json`;
 const priorIndex=JSON.parse(execFileSync('git',['show',refreshHead+'^:'+indexPath],{cwd:fixture.root,encoding:'utf8'}));
 const unused=Object.entries(priorIndex.receipts).find(([key,hash])=>{
  const receipt=JSON.parse(execFileSync('git',['show',refreshHead+'^:'+`.proof-or-stop/story/actives/${storyId}/causal-evidence/receipts/${hash}.json`],{cwd:fixture.root,encoding:'utf8'}));
  return receipt.identity.inputs?.purpose==='bounded receipt corpus' && verifyCausalEvidenceReceipt(receipt,key);
 });
 assert(unused,'choose an authentic corpus receipt unrelated to acceptance, not a required execution receipt');
 const index=JSON.parse(readFileSync(join(fixture.root,indexPath),'utf8'));assert.equal(index.receipts[unused[0]],unused[1]);delete index.receipts[unused[0]];
 writeFileSync(join(fixture.root,indexPath),JSON.stringify(index));
 // Both acceptance sides remain authenticated; only the historical index key disappears.
 for(const ref of [refreshHead+'^',refreshHead]) {
  const checklist=JSON.parse(execFileSync('git',['show',ref+':'+`.proof-or-stop/story/actives/${storyId}/checklist.json`],{cwd:fixture.root,encoding:'utf8'}));
  for(const item of checklist.items)for(const evidence of item.verificationEvidence??[])assert(hasMechanicalExecutionAuthority(fixture.store,storyId,item,evidence));
 }
 git(fixture.root,['add','--',...refreshPaths,indexPath]);git(fixture.root,['commit','-m',`proof-or-stop: record ${storyId} verification_evidence_add metadata`]);
 assert.equal(isVerifiedReviewMaintenanceCommit({gitCwd:fixture.root,metadataRoot:fixture.root,storyId,commit:git(fixture.root,['rev-parse','HEAD']),reviewedHeadHash:git(fixture.root,['rev-parse',refreshHead+'^'])}),false,'valid unreferenced receipt history cannot be removed from the causal index');
 console.log('CAUSAL_INDEX_PREFIX_ERASURE_REFUSED');
 git(fixture.root,['reset','--hard',refreshHead]);
}
// The lifecycle counterexamples use their original small witness. Repeating
// the 200-receipt scale corpus for every unrelated mutant adds no new proof.
assert(isolatedFixtureRoots.has(fixture.root));
git(fixture.root,['reset','--hard',smallPinnedHead]);
cli(fixture.root,'verification_evidence_add',evidencePayload,env('main','saturation-owner'));


const beginInventory=()=>{
 cli(fixture.root,'candidate_spec_route',{storyId,hosts:false,persist:true},env('main','saturation-owner'));
 cli(fixture.root,'review_inventory_begin',{storyId},env('main','saturation-owner'));
 return fixture.store.readReviewInventoryEpochs(storyId).epochs.at(-1);
};
let epoch=beginInventory();
cli(fixture.root,'verification_evidence_add',evidencePayload,env('main','saturation-owner'));
assert.equal(isVerifiedReviewMaintenanceCommit({gitCwd:fixture.root,metadataRoot:fixture.root,storyId,commit:git(fixture.root,['rev-parse','HEAD']),reviewedHeadHash:epoch.cutoff.headHash}),false,'mixing pending inventory initialization into an evidence writer is not pure evidence refresh');
assert(isolatedFixtureRoots.has(fixture.root));
git(fixture.root,['reset','--hard',epoch.cutoff.headHash]);
cli(fixture.root,'finding_add',{storyId,agent:'main',desc:'This isolated fixture deliberately has an optional should-priority witness without an evidence row so coverage-addition refusal can be tested.',severity:'low',category:'missing',evidenceState:'verified'},env('main','saturation-owner'));
const diagnosticFinding=fixture.store.readFindings(storyId).findings.at(-1).id;
epoch=beginInventory();
cli(fixture.root,'finding_resolve',{storyId,findingId:diagnosticFinding,resolutionType:'accepted_risk',resolveEvidenceStrength:'strong',resolution:'The optional witness is deliberately uncovered for this disposable negative-control fixture; required coverage is intact. Preserve this owner diagnostic without claiming a missing product requirement was repaired.'},env('main','saturation-owner'));
assert.notEqual(git(fixture.root,['rev-parse','HEAD']),epoch.cutoff.headHash,'the official non-deferred finding resolution advances the OPEN epoch before managed review');
const readManifest={filesReadFully:['packages/main/src/subject.ts'],filesTriagedByName:[],scanEscalationReason:null};
const readEvents=[{path:'packages/main/src/subject.ts',mode:'full',action:'Read',tokenCount:null}];
for(const lane of epoch.requiredLanes){
 if(lane===epoch.requiredLanes[0]) {
  const first=await recordManagedReviewer(epoch.epochId,'saturation-first-managed',lane);
  assert(fixture.store.readReviewPasses(storyId).passes.some(row=>row.reviewRunId===first.reviewRunId && row.managedEvidenceBinding),'required lane uses the actual managed importer');
  assert.notEqual(git(fixture.root,['rev-parse','HEAD']),epoch.cutoff.headHash,'managed required lane starts after the non-deferred metadata commit');
  console.log('SATURATION_MANAGED_LANE '+lane);continue;
 }

 const e=env(lane,'saturation-'+lane);cli(fixture.root,'dispatch',{storyId,agentType:lane},e);
 const out=cli(fixture.root,'review_run_start',{storyId,agent:lane},e);const reviewRunId=out.match(/Review run (\S+) started/)?.[1];assert(reviewRunId,out);
 await runBrokeredNativeReviewCli({root:fixture.root,store:fixture.store,storyId,agent:lane,reviewRunId,command:'review_pass_set',payload:{storyId,agent:lane,reviewRunId,note:'Disposable independent required lane inspected the exact current subject with no findings.',readManifest,readEvents}});
 console.log('SATURATION_LANE '+lane);
}
async function recordManagedReviewer(epochId,actor,lane='proof-or-stop-review-topology-critic') {
const critic=lane,ce=env(critic,actor);const purpose=lane==='proof-or-stop-review-topology-critic'?{reviewPurpose:'inventory-completeness',inventoryEpochId:epochId}:{};
cli(fixture.root,'dispatch',{storyId,agentType:critic,...purpose},ce);
const co=cli(fixture.root,'review_run_start',{storyId,agent:critic,...purpose},ce);let cr=co.match(/Review run (\S+) started/)?.[1];assert(cr,co);
// The transport is synthetic only in this disposable fixture. The actual
// managed worker, sealed receipt importer and REVIEW consumer remain in use.
let managedRunId;
const ownerCwd=process.cwd();process.chdir(fixture.root);
try {
 const ctx={root:fixture.root,store:fixture.store,scanRoot:join(fixture.root,'packages/main')};
 const host=createHostRunHandlers(ctx,{runner:async()=>{
  const artifact=fixture.store.readCandidateSpecSet(storyId);
  assert(artifact,'managed fixture requires a canonical candidate routing artifact');
  const files=[...new Set(['packages/main/src/subject.ts',...(artifact?.candidateSpecSet??[])])].sort();
  for(const file of files) readFileSync(join(fixture.root,file));
  return {stdout:'',stderr:'',exitCode:0,timedOut:false,terminalReason:'completed',finalAssistantResultCount:1,finalAssistantResultTruncated:false,
   finalAssistantResult:JSON.stringify({schemaVersion:'lattice.managed_review_final_proposal.v1',storyId,providerAgent:critic,lane:critic,reviewRunId:cr,conclusion:'pass',note:'Disposable managed reviewer inspected the current subject and exact bounded read inputs.',
    readManifest:{filesReadFully:files,filesTriagedByName:[],scanEscalationReason:artifact?.scanEscalationReason??null,candidateSpecSetDigest:artifact?.artifactDigest,corpusDigest:artifact?.corpusDigest},
    readLog:{filesReadFully:files,filesTriagedByName:[],summary:{readCount:files.length,tokenCount:null},digest:'a'.repeat(64)}})};
 }});
 const budget=(key,fallback,max)=>{const value=Number(process.env[key]??fallback);assert(Number.isSafeInteger(value)&&value>0&&value<=max,'invalid test-only wait budget '+key);return value;};
 const admissionDeadline=Date.now()+budget('PROOF_OR_STOP_TEST_REVIEW_ADMISSION_MS',120000,180000);
 const completionBudgetMs=budget('PROOF_OR_STOP_TEST_REVIEW_COMPLETION_MS',60000,120000);
 let status,launched,attempt=0;
 do {
  launched=await host.host_run({host:'codex',storyId,agentType:critic,reviewRunId:cr,lane:critic,managedReview:true,detach:true,deadlineMs:60000,json:true});
  const completionDeadline=Date.now()+completionBudgetMs;
  do {status=await getManagedHostRunStatus({root:fixture.root,runId:launched.run.runId});if(['completed','failed','timed_out','cancelled'].includes(status.run.state)) break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<completionDeadline);
  if(!['completed','failed','timed_out','cancelled'].includes(status.run.state)) {
   await host.host_run_cancel({runId:launched.run.runId,json:true});
   assert.fail('MANAGED_FIXTURE_COMPLETION_TIMEOUT: '+JSON.stringify(status));
  }
  if(status.run.terminal?.reason!=='concurrency_cap_exceeded') break;
  // Observe actual shared capacity; never disable admission or retry verdict failures.
  console.log('FIXTURE_CAPACITY_WAIT',++attempt);await new Promise(r=>setTimeout(r,2000));
  cli(fixture.root,'dispatch',{storyId,agentType:critic,...purpose},ce);
  const retryRun=cli(fixture.root,'review_run_start',{storyId,agent:critic,...purpose},ce);
  cr=retryRun.match(/Review run (\S+) started/)?.[1];assert(cr,retryRun);
 }while(Date.now()<admissionDeadline);
 if(status.run.terminal?.reason==='concurrency_cap_exceeded') throw new Error('MANAGED_FIXTURE_ADMISSION_RETRY_REQUIRED: shared capacity remained unavailable; rerun this required proof when capacity is free. No PASS or skip was issued.');
 assert.equal(status.run.state,'completed','MANAGED_FIXTURE_TERMINAL_FAILURE: '+JSON.stringify(status));
 managedRunId=launched.run.runId;
 const receipt=managedHostRunReceipt(fixture.root,launched.run.runId);
 assert.match(createManagedReviewEvidenceHandlers(ctx).managed_review_evidence_import({runId:launched.run.runId,receiptId:receipt.receiptId}),/Managed review evidence imported/);
} finally {process.chdir(ownerCwd);}



return {reviewRunId:cr,managedRunId};
}
const critic='proof-or-stop-review-topology-critic',ce=env(critic,'saturation-critic');
const {reviewRunId:cr,managedRunId}=await recordManagedReviewer(epoch.epochId,'saturation-critic');
console.log(cli(fixture.root,'review_inventory_critic_set',{storyId,epochId:epoch.epochId,reviewRunId:cr,agent:critic,findingDispositions:[]},ce));
console.log(cli(fixture.root,'review_inventory_finalize',{storyId},env('main','saturation-owner')));
const persistedCritic=fixture.store.readReviewRuns(storyId).runs.find(r=>r.reviewRunId===cr);
assert(persistedCritic.scopeBinding?.compositeScopeDigest,'actual managed run must exercise composite-scope retention');
assert(collectReviewerEvidenceState(fixture.store,storyId,fixture.root).valid.some(e=>e.reviewRunId===cr),'actual managed REVIEW consumer accepts the finalized critic without rebuilding its launch pack');
assert.equal(managedInventorySubjectState(fixture.store,persistedCritic),'current','authenticated finalized critic remains consumable without rebuilding its OPEN launch pack');
const specPath=join(managedHostRunDirectory(fixture.root,managedRunId),'spec.json');
const originalSpec=readFileSync(specPath,'utf8');
try {
 for(const seal of [undefined,'malformed']) {
  const spec=JSON.parse(originalSpec);assert(spec.reviewBinding.managedPromptDigest);
  if(seal===undefined) delete spec.reviewBinding.managedPromptDigest;
  else spec.reviewBinding.managedPromptDigest=seal;
  writeFileSync(specPath,JSON.stringify(spec));
  const collected=collectReviewerEvidenceState(fixture.store,storyId,fixture.root);
  assert(collected.invalid.some(row=>row.code==='managed_receipt_invalid'),JSON.stringify(collected));
  assert(!collected.valid.some(row=>row.reviewRunId===cr),'missing or malformed persisted launch seal cannot reach valid review');
 }
} finally {writeFileSync(specPath,originalSpec);}

assert.equal(managedInventorySubjectState(fixture.store,{...persistedCritic,inventoryBinding:{...persistedCritic.inventoryBinding,epochId:'B-other:RI-999'}}),'invalid','wrong epoch is rejected');
const savedEpochs=fixture.store.readReviewInventoryEpochs(storyId);
const epochPath=fixture.store.storyFilePath(storyId,'review-inventory-epochs.json');
const epochBytes=readFileSync(epochPath,'utf8');
try {
 writeFileSync(epochPath,'{malformed');
 let cause;
 assertNoReaderHealth(()=>assert.equal(managedInventorySubjectState(fixture.store,persistedCritic,reason=>{cause=reason;}),'invalid'),true);
 assert(cause,'unexpected read must preserve its concrete cause');
 assertNoReaderHealth(()=>{
  const state=collectReviewerEvidenceState(fixture.store,storyId,fixture.root);
  assert(state.invalid.some(row=>row.code==='managed_receipt_invalid' && row.message.includes(cause)),JSON.stringify(state));
 // One ordinary managed lane's lineage reader and the critic's subject reader
 // each observe the malformed store once; the direct-reader control above is one.
 },2);
} finally {writeFileSync(epochPath,epochBytes);}

const tampered=structuredClone(savedEpochs);tampered.epochs.at(-1).requiredLanes=[];
fixture.store.writeReviewInventoryEpochs(storyId,tampered);
assert.equal(managedInventorySubjectState(fixture.store,persistedCritic),'invalid','tampered signed epoch is rejected');
fixture.store.writeReviewInventoryEpochs(storyId,savedEpochs);
const foreign=structuredClone(savedEpochs);foreign.epochs.at(-1).storyId='B-foreign';
{const {_hash,...unsigned}=foreign.epochs.at(-1);foreign.epochs.at(-1)._hash=signReviewInventoryEpoch(unsigned);}
fixture.store.writeReviewInventoryEpochs(storyId,foreign);
assert.equal(managedInventorySubjectState(fixture.store,persistedCritic),'invalid','even a signed matching epoch id must belong to the current Story');
const multi=structuredClone(savedEpochs);multi.epochs.at(-1).waves.push({...multi.epochs.at(-1).waves[0],wave:2});
{const {_hash,...unsigned}=multi.epochs.at(-1);multi.epochs.at(-1)._hash=signReviewInventoryEpoch(unsigned);}
fixture.store.writeReviewInventoryEpochs(storyId,multi);
assertNoReaderHealth(()=>assert.equal(managedInventorySubjectState(fixture.store,persistedCritic),'superseded','signed prior wave is historical, not a malformed subject'));
fixture.store.writeReviewInventoryEpochs(storyId,savedEpochs);
const publication=git(fixture.root,['log','-1','--format=%s']);
assert.equal(publication,`proof-or-stop: record ${storyId} review epoch metadata`,'actual batch publisher must produce the canonical subject');
const cutoff=fixture.store.readReviewInventoryEpochs(storyId).receipts.at(-1).cutoff.headHash;
const expected={headHash:persistedCritic.headHash,materialHash:persistedCritic.materialHash,storyFilesHash:persistedCritic.storyFilesHash};
assert.notEqual(expected.headHash,cutoff,'actual managed run started strictly after cutoff');
assert.equal(verifyManagedReviewLiveBinding({gitCwd:fixture.root,metadataRoot:fixture.root,storyId,expected}).valid,true,'FINALIZED_MANAGED_REVIEW_CONTINUITY_REQUIRED: actual signed epoch publication preserves managed review lineage');
assert.notEqual(git(fixture.root,['rev-parse','HEAD']),cutoff,'actual publication must move beyond signed inventory cutoff');
const storyPrefix=`.proof-or-stop/story/actives/${storyId}/`;
const publishedPaths=git(fixture.root,['diff-tree','--no-commit-id','--name-only','-r','HEAD']).split('\n');
assert(publishedPaths.some(path=>path.startsWith(storyPrefix)&&isPromptBodyArtifactPath(path.slice(storyPrefix.length))), 'native publication must exercise the canonical prompt-body path branch');
const publishedHead=git(fixture.root,['rev-parse','HEAD']);

const originalFixture={root:fixture.root,store:fixture.store};
const twoFixture=setup({name:'Harmonynet',email:'26995688+Harmonynet@users.noreply.github.com'});
const twoPrimary=twoFixture.root,twoPath=join(twoPrimary,'.worktrees',storyId);
try {
 twoFixture.store.writeStory(storyId,{...twoFixture.store.readStory(storyId),worktree:{path:twoPath,branch:'story/'+storyId,createdAt:reviewRound}});
 twoFixture.store.writeChecklist(storyId,{items:[]});
 git(twoPrimary,['add','.']);git(twoPrimary,['commit','-m','test: initialize independent two-wave fixture']);
 git(twoPrimary,['worktree','add','-b','story/'+storyId,twoPath]);
 fixture.root=twoPath;fixture.store=new StoryStore(twoPath);isolatedFixtureRoots.add(twoPath);
 cli(fixture.root,'candidate_spec_route',{storyId,hosts:false,persist:true},env('main','saturation-owner'));
 cli(fixture.root,'review_inventory_begin',{storyId},env('main','saturation-owner'));
 const twoEpoch=fixture.store.readReviewInventoryEpochs(storyId).epochs.at(-1);
 const critics=[],nativeCritics=[],transports=[];let observedFinding;
 for(const wave of [1,2]) {
  for(const [index,lane] of twoEpoch.requiredLanes.entries()) {
   const actor=env(lane,`two-wave-${wave}-${lane}`);
   cli(fixture.root,'dispatch',{storyId,agentType:lane},actor);
   const text=cli(fixture.root,'review_run_start',{storyId,agent:lane},actor);
   const reviewRunId=text.match(/Review run (\S+) started/)?.[1];assert(reviewRunId,text);
   const common={root:fixture.root,store:fixture.store,storyId,agent:lane,reviewRunId};
   if(wave===1 && index===0) {
    const source=readFileSync(join(fixture.root,'packages/main/src/subject.ts'),'utf8');
    assert(source.includes('subject must equal zero') && source.includes('subject = 1'));
    await runBrokeredNativeReviewCli({...common,command:'finding_add',payload:{storyId,agent:lane,reviewRunId,
     desc:'The disposable source contract requires zero but exports one; retain this actual observation across both inventory waves.',severity:'low',category:'edge',evidenceState:'verified',files:['packages/main/src/subject.ts'],readManifest,readEvents}});
    observedFinding=fixture.store.readFindings(storyId).findings.at(-1).id;
    // This disposable scenario explicitly accepts its deliberate negative source
    // fixture; it does not claim a repair. Resolve before either managed launch,
    // so both critics review that same settled disposition and cutoff content.
    cli(fixture.root,'finding_resolve',{storyId,findingId:observedFinding,resolutionType:'accepted_risk',resolveEvidenceStrength:'strong',resolution:'The numeric mismatch is deliberately retained as the negative source fixture for this isolated inventory test. This accepted-risk disposition claims no repair; preserve the signed discovery and its family across both waves.'},env('main','saturation-owner'));
   } else await runBrokeredNativeReviewCli({...common,command:'review_pass_set',payload:{storyId,agent:lane,reviewRunId,note:'Inspected the exact source and retained the existing numeric export observation without a new family.',readManifest,readEvents}});
  }
  const actor=`two-wave-${wave}-critic`,result=await recordManagedReviewer(twoEpoch.epochId,actor);critics.push(result.reviewRunId);transports.push(result.managedRunId);
  const nativeActor=env(critic,`two-wave-${wave}-native-critic`);
  const purpose={reviewPurpose:'inventory-completeness',inventoryEpochId:twoEpoch.epochId};
  cli(fixture.root,'dispatch',{storyId,agentType:critic,...purpose},nativeActor);
  const nativeStart=cli(fixture.root,'review_run_start',{storyId,agent:critic,...purpose},nativeActor);
  const nativeRunId=nativeStart.match(/Review run (\S+) started/)?.[1];assert(nativeRunId,nativeStart);
  await runBrokeredNativeReviewCli({root:fixture.root,store:fixture.store,storyId,agent:critic,reviewRunId:nativeRunId,
   command:'review_pass_set',payload:{storyId,agent:critic,reviewRunId:nativeRunId,note:'Native critic inspected this inventory wave and retained its settled finding family.',readManifest,readEvents}});
  nativeCritics.push(nativeRunId);
  const currentEpoch=fixture.store.readReviewInventoryEpochs(storyId).epochs.at(-1);
  const evaluation=evaluateReviewInventoryWave({promptStore:fixture.store,epoch:currentEpoch,runs:fixture.store.readReviewRuns(storyId).runs,passes:fixture.store.readReviewPasses(storyId).passes,findings:fixture.store.readFindings(storyId).findings,findingDispositions:[]});
  const findingDispositions=evaluation.rawFindingIds.map(findingId=>({findingId,disposition:'verified_family',familyKey:'retained-numeric-export',reason:'Independent critic retains the actual numeric export family.'}));
  cli(fixture.root,'review_inventory_critic_set',{storyId,epochId:twoEpoch.epochId,reviewRunId:nativeRunId,agent:critic,findingDispositions},nativeActor);
  cli(fixture.root,wave===1?'review_inventory_wave_advance':'review_inventory_finalize',{storyId},env('main','saturation-owner'));
 }
 const collected=collectReviewerEvidenceState(fixture.store,storyId,fixture.root);
 assert.equal(collected.invalid.length,0,JSON.stringify(collected.invalid));
 assert(collected.valid.some(row=>row.reviewRunId===critics[1]),'terminal managed critic remains valid');
 assert(!collected.valid.some(row=>row.reviewRunId===critics[0]),'earlier critic is superseded, not current authority');
 assert(collected.valid.some(row=>row.reviewRunId===nativeCritics[1]),'terminal native critic remains valid');
 assert(!collected.valid.some(row=>row.reviewRunId===nativeCritics[0]),'earlier native critic is superseded too');
 const oldSpecPath=join(managedHostRunDirectory(fixture.root,transports[0]),'spec.json');
 const oldSpecBytes=readFileSync(oldSpecPath,'utf8');
 try {
  const bad=JSON.parse(oldSpecBytes);delete bad.reviewBinding.managedPromptDigest;writeFileSync(oldSpecPath,JSON.stringify(bad));
  assert(collectReviewerEvidenceState(fixture.store,storyId,fixture.root).invalid.some(row=>row.code==='managed_receipt_invalid'),'newer valid PASS never hides an unauthenticated earlier receipt');
 } finally {writeFileSync(oldSpecPath,oldSpecBytes);}
 const oldNative=fixture.store.readReviewPasses(storyId).passes.find(row=>row.reviewRunId===nativeCritics[0]);
 assert(oldNative?.nativeEvidenceBinding,'the old critic must carry actual broker authority');
 const {resolveCanonicalRuntimeProjectRoot}=await import('../packages/main/dist/core/runtime-artifact-registry.js');
 const nativeConsumptionPath=join(resolveCanonicalRuntimeProjectRoot(fixture.root),'.proof-or-stop','runtime','native-review-invocations',oldNative.nativeEvidenceBinding.brokerId,oldNative.nativeEvidenceBinding.invocationNonce+'.json');
 const nativeConsumptionBytes=readFileSync(nativeConsumptionPath);
 try {
  rmSync(nativeConsumptionPath);
  assert(collectReviewerEvidenceState(fixture.store,storyId,fixture.root).invalid.some(row=>row.code==='review_execution_authority_missing'&&row.reviewRunId===nativeCritics[0]),'a newer record cannot hide missing native invocation consumption');
 } finally {writeFileSync(nativeConsumptionPath,nativeConsumptionBytes);}
 assert.equal(collectReviewerEvidenceState(fixture.store,storyId,fixture.root).invalid.length,0,'restored native consumption must recover the positive control');
 const saved=fixture.store.readReviewPasses(storyId);
 fixture.store.writeReviewPasses(storyId,{...saved,passes:saved.passes.filter(row=>![critics[1],nativeCritics[1]].includes(row.reviewRunId))});
 assert(collectReviewerEvidenceState(fixture.store,storyId,fixture.root).invalid.some(row=>row.code==='superseded_inventory_wave'),'missing replacement never promotes the earlier wave');
 assert(collectReviewerEvidenceState(fixture.store,storyId,fixture.root).invalid.some(row=>row.code==='superseded_inventory_wave'&&row.reviewRunId===nativeCritics[0]),'native historical pass without replacement remains invalid');
 console.log('MANAGED_TWO_WAVE_COLLECTION_GREEN');
 console.log('NATIVE_TWO_WAVE_COLLECTION_GREEN');
} finally {fixture.root=originalFixture.root;fixture.store=originalFixture.store;rmSync(twoPrimary,{recursive:true,force:true});}

const publicationBinding={gitCwd:fixture.root,metadataRoot:fixture.root,storyId,commit:publishedHead,reviewedHeadHash:expected.headHash,reviewedMaterialHash:expected.materialHash,reviewedStoryFilesHash:expected.storyFilesHash};
assert(isVerifiedReviewMaintenanceCommit(publicationBinding),'actual late-start publication control passes');
assertNoReaderHealth(()=>assert.equal(isVerifiedReviewMaintenanceCommit({...publicationBinding,commit:'not-a-commit'}),false),true);
assert.equal(isVerifiedReviewMaintenanceCommit({...publicationBinding,reviewedMaterialHash:'0'.repeat(64)}),false,'wrong consumer material binding is refused');
assert.equal(isVerifiedReviewMaintenanceCommit({...publicationBinding,reviewedStoryFilesHash:'0'.repeat(64)}),false,'wrong consumer Story binding is refused');
assertNoReaderHealth(()=>assert.equal(isVerifiedReviewMaintenanceCommit({...publicationBinding,reviewedHeadHash:smallPinnedHead}),false,'a consumer before the epoch cutoff is refused'));
const publishPaths=git(fixture.root,['diff-tree','--no-commit-id','--name-only','-r',publishedHead]).split('\n').filter(Boolean);
// Immutable fixture commit bytes are read once; every reconstruction restores
// the same authenticated snapshot without spawning Git for each repeated case.
assert.match(publishedHead,/^[a-f0-9]{40}$/);
const publishedFiles=new Map(publishPaths.map(path=>[path,execFileSync('git',['show',publishedHead+':'+path],{cwd:fixture.root})]));
// Reconstruct a genuine publication INCLUDING its epochs file so the artifact
// allowlist, rather than the missing-epochs guard, decides each sibling case.
for(const mode of ['canonical-body','outside-artifact','near-miss-body','extra-epoch','extra-receipt']) {
 git(fixture.root,['reset','--hard',publishedHead+'^']);
 for(const path of publishPaths){mkdirSync(join(fixture.root,path,'..'),{recursive:true});writeFileSync(join(fixture.root,path),publishedFiles.get(path));}
 const epochsPath=storyPrefix+'review-inventory-epochs.json';
 const data=JSON.parse(readFileSync(join(fixture.root,epochsPath),'utf8'));
 const terminal=data.epochs.at(-1);assert(verifyReviewInventoryEpoch(terminal));
 assert(verifyReviewInventoryReceipt(data.receipts.find(row=>row.receiptId===terminal.receiptId)));
 let sibling;
 if(mode==='extra-epoch') {
  const genuinePrefix=structuredClone(data.epochs);
  data.epochs.push({epochId:'unsigned-extra',storyId,state:'OPEN'},structuredClone(terminal));
  assert.deepEqual(data.epochs.slice(0,genuinePrefix.length),genuinePrefix,'extra rows must preserve the genuine publication prefix');
  assert(verifyReviewInventoryEpoch(data.epochs.at(-1)),'terminal authentication must still pass before the count refusal');
 }
 else if(mode==='extra-receipt') data.receipts.push({receiptId:'unsigned-extra',storyId,epochId:'unsigned-extra'});
 else {
  const body='Bounded additional publication prompt body\n';
  const digest=domainSeparatedDigest('assembled-prompt.raw-utf8.v1',body);
  sibling=storyPrefix+(mode==='outside-artifact'?'not-a-review-artifact.txt':`prompt-bodies/${mode==='near-miss-body'?digest.slice(0,63):digest}.txt`);
  mkdirSync(join(fixture.root,sibling,'..'),{recursive:true});writeFileSync(join(fixture.root,sibling),body);
  assert.equal(isPromptBodyArtifactPath(sibling.slice(storyPrefix.length)),mode==='canonical-body');
 }
 writeFileSync(join(fixture.root,epochsPath),JSON.stringify(data));
 git(fixture.root,['add','--',...publishPaths,...(sibling?[sibling]:[])]);
 git(fixture.root,['commit','-m',`proof-or-stop: record ${storyId} review epoch metadata`]);
 const commit=git(fixture.root,['rev-parse','HEAD']);
 assert(git(fixture.root,['diff-tree','--no-commit-id','--name-only','-r',commit]).split('\n').includes(epochsPath),'the epochs prerequisite must be present in the tested commit');
 assert.equal(isVerifiedReviewMaintenanceCommit({...publicationBinding,commit}),mode==='canonical-body',mode);
 console.log((mode==='canonical-body'?'EPOCH_ARTIFACT_ALLOWLIST_CONTROL':mode.startsWith('extra-')?'EPOCH_EXTRA_HISTORY_REFUSED':'EPOCH_ARTIFACT_ALLOWLIST_REFUSED')+' '+mode);
}
git(fixture.root,['reset','--hard',publishedHead]);
const observedMetrics=computeProcessMetrics(storyId,fixture.store,fixture.root);
for(const validMetrics of [true,false]) {
 git(fixture.root,['reset','--hard',publishedHead+'^']);
 for(const path of publishPaths) {mkdirSync(join(fixture.root,path,'..'),{recursive:true});writeFileSync(join(fixture.root,path),publishedFiles.get(path));}
 const metrics={...observedMetrics,storyId:validMetrics?storyId:'B-foreign'};
 writeFileSync(join(fixture.root,storyPrefix+'process-metrics.json'),JSON.stringify(metrics));
 git(fixture.root,['add','--',...publishPaths,storyPrefix+'process-metrics.json']);git(fixture.root,['commit','-m',`proof-or-stop: record ${storyId} review epoch metadata`]);
 assert.equal(isVerifiedReviewMaintenanceCommit({...publicationBinding,commit:git(fixture.root,['rev-parse','HEAD'])}),validMetrics,'epoch metrics current-Story control/refusal');
}
git(fixture.root,['reset','--hard',publishedHead]);

// A first publication of a lease/checklist is a structural refusal, not an
// unreadable-repository anomaly. These writes are disposable Git witnesses only.
for(const missingParent of ['owner-lease.json','checklist.json']) {
 git(fixture.root,['reset','--hard',publishedHead]);
 const path=storyPrefix+missingParent;
 const original=missingParent==='owner-lease.json'?JSON.stringify(leaseControl):readFileSync(join(fixture.root,path),'utf8');
 rmSync(join(fixture.root,path),{force:true});git(fixture.root,['add','-A','--',storyPrefix]);
 git(fixture.root,['commit','--allow-empty','-m','test: absent parent snapshot']);
 writeFileSync(join(fixture.root,path),original);git(fixture.root,['add','--',path]);
 git(fixture.root,['commit','-m',`proof-or-stop: record ${storyId} verification_evidence_add metadata`]);
 assertNoReaderHealth(()=>assert.equal(isVerifiedReviewMaintenanceCommit({...publicationBinding,commit:git(fixture.root,['rev-parse','HEAD'])}),false,missingParent));
}
git(fixture.root,['reset','--hard',publishedHead]);
recordConvergenceProgress(fixture.store,storyId,fixture.root);
const realConvergence=JSON.parse(readFileSync(join(fixture.root,storyPrefix+'convergence-progress.json'),'utf8'));
assert(Array.isArray(realConvergence.completedEpochBindings)&&Array.isArray(realConvergence.revokedCompletedEpochIds),'official producer writes required arrays');
// Preserve authentic producer shape. Historical row sentinels below test prefix
// retention only; they do not claim to be valid completed-epoch authority.
for(const variant of ['preserved','optional-absent','completedEpochBindings','revokedCompletedEpochIds','humanDecisions','missing-required']) {
 git(fixture.root,['reset','--hard',publishedHead+'^']);
 const prior={...realConvergence,completedEpochBindings:[{epochId:'historical',claimDigest:'fixture-history'}],revokedCompletedEpochIds:['historical'],humanDecisions:[{reason:'retained historical fixture decision',completedEpochIds:['historical'],snapshotDigest:'fixture-history'}]};
 if(variant==='optional-absent')delete prior.humanDecisions;
 writeFileSync(join(fixture.root,storyPrefix+'convergence-progress.json'),JSON.stringify(prior));
 git(fixture.root,['add','--',storyPrefix+'convergence-progress.json']);git(fixture.root,['commit','-m','test: retain convergence prefix witnesses']);
 for(const path of publishPaths){mkdirSync(join(fixture.root,path,'..'),{recursive:true});writeFileSync(join(fixture.root,path),publishedFiles.get(path));}
 const next=structuredClone(prior);next.humanDecisions??=[];
 if(['completedEpochBindings','revokedCompletedEpochIds','humanDecisions'].includes(variant))next[variant]=[];
 else if(variant==='missing-required')delete next.completedEpochBindings;
 else next.humanDecisions.push({reason:'appended fixture decision',completedEpochIds:[],snapshotDigest:'next'});
 writeFileSync(join(fixture.root,storyPrefix+'convergence-progress.json'),JSON.stringify(next));
 git(fixture.root,['add','--',...publishPaths,storyPrefix+'convergence-progress.json']);git(fixture.root,['commit','-m',`proof-or-stop: record ${storyId} review epoch metadata`]);
 assert.equal(isVerifiedReviewMaintenanceCommit({...publicationBinding,commit:git(fixture.root,['rev-parse','HEAD'])}),['preserved','optional-absent'].includes(variant),variant);
}
git(fixture.root,['reset','--hard',publishedHead]);

// Reuse actual signed pass records and the real OPEN/FINALIZED epoch pair in
// this disposable Git history. The sole malicious change deletes a prior pass.
const signedPasses=fixture.store.readReviewPasses(storyId);
git(fixture.root,['reset','--hard',publishedHead+'^']);
fixture.store.writeReviewPasses(storyId,signedPasses);
fixture.store.writeReviewInventoryEpochs(storyId,{...savedEpochs,epochs:[epoch],receipts:[]});
git(fixture.root,['add','--',storyPrefix+'review-passes.json',storyPrefix+'review-inventory-epochs.json']);
git(fixture.root,['commit','-m','test: retain prior authentic review observations']);
fixture.store.writeReviewPasses(storyId,{...signedPasses,passes:signedPasses.passes.slice(1)});
fixture.store.writeReviewInventoryEpochs(storyId,savedEpochs);
git(fixture.root,['add','--',storyPrefix+'review-passes.json',storyPrefix+'review-inventory-epochs.json']);
git(fixture.root,['commit','-m',`proof-or-stop: record ${storyId} review epoch metadata`]);
assert.equal(isVerifiedReviewMaintenanceCommit({gitCwd:fixture.root,metadataRoot:fixture.root,storyId,commit:git(fixture.root,['rev-parse','HEAD']),reviewedHeadHash:expected.headHash,reviewedMaterialHash:expected.materialHash,reviewedStoryFilesHash:expected.storyFilesHash}),false,'finalization cannot remove a prior signed review record');
git(fixture.root,['reset','--hard',publishedHead]);

for(const erased of ['prior-epoch','prior-receipt','ledger-record','ledger-receipt','missing-required-ledger-receipts']) {
 git(fixture.root,['reset','--hard',publishedHead+'^']);
 const historicalEpoch={...structuredClone(savedEpochs.epochs.at(-1)),epochId:storyId+':RI-history'};
 const historicalReceipt={...structuredClone(savedEpochs.receipts.at(-1)),receiptId:storyId+':RCP-history',epochId:historicalEpoch.epochId};
 const beforeHistory={...savedEpochs,epochs:[historicalEpoch,epoch],receipts:[historicalReceipt]};
 const afterHistory={...savedEpochs,epochs:[historicalEpoch,...savedEpochs.epochs],receipts:[historicalReceipt,...savedEpochs.receipts]};
 fixture.store.writeReviewInventoryEpochs(storyId,beforeHistory);
 const ledgerPath=storyPrefix+'finding-ledger.json';
 const ledger={schemaVersion:'finding-ledger.v1',records:[{historical:'record'}],receipts:[{historical:'receipt'}]};
 writeFileSync(join(fixture.root,ledgerPath),JSON.stringify(ledger));
 git(fixture.root,['add','--',storyPrefix]);git(fixture.root,['commit','-m','test: establish prior history preservation boundary']);
 const priorHistoryHead=git(fixture.root,['rev-parse','HEAD']);
 fixture.store.writeReviewInventoryEpochs(storyId,afterHistory);
 git(fixture.root,['add','--',storyPrefix]);git(fixture.root,['commit','-m',`proof-or-stop: record ${storyId} review epoch metadata`]);
 assert.equal(isVerifiedReviewMaintenanceCommit({gitCwd:fixture.root,metadataRoot:fixture.root,storyId,commit:git(fixture.root,['rev-parse','HEAD']),reviewedHeadHash:expected.headHash,reviewedMaterialHash:expected.materialHash,reviewedStoryFilesHash:expected.storyFilesHash}),true,'control retains prior history before '+erased);
 git(fixture.root,['reset','--hard',priorHistoryHead]);
 const next=structuredClone(afterHistory);
 if(erased==='prior-epoch') next.epochs.shift();
 if(erased==='prior-receipt') next.receipts.shift();
 fixture.store.writeReviewInventoryEpochs(storyId,next);
 if(erased==='ledger-record') ledger.records=[];
 if(erased==='ledger-receipt') ledger.receipts=[];
 if(erased==='missing-required-ledger-receipts') delete ledger.receipts;
 writeFileSync(join(fixture.root,ledgerPath),JSON.stringify(ledger));
 git(fixture.root,['add','--',storyPrefix]);git(fixture.root,['commit','-m',`proof-or-stop: record ${storyId} review epoch metadata`]);
 assert.equal(isVerifiedReviewMaintenanceCommit({gitCwd:fixture.root,metadataRoot:fixture.root,storyId,commit:git(fixture.root,['rev-parse','HEAD']),reviewedHeadHash:expected.headHash,reviewedMaterialHash:expected.materialHash,reviewedStoryFilesHash:expected.storyFilesHash}),false,erased);
}
git(fixture.root,['reset','--hard',publishedHead]);
const trueCoverage=fixture.store.readChecklist(storyId);
const failedCoverage=structuredClone(trueCoverage);failedCoverage.items[0].verificationEvidence[0].result='fail';
fixture.store.writeChecklist(storyId,failedCoverage);
git(fixture.root,['add','--',storyPrefix+'checklist.json']);git(fixture.root,['commit','-m','test: construct recorded result-change boundary']);
fixture.store.writeChecklist(storyId,trueCoverage);
git(fixture.root,['add','--',storyPrefix+'checklist.json']);git(fixture.root,['commit','-m',`proof-or-stop: record ${storyId} verification_evidence_add metadata`]);
assert.equal(isVerifiedReviewMaintenanceCommit({gitCwd:fixture.root,metadataRoot:fixture.root,storyId,commit:git(fixture.root,['rev-parse','HEAD']),reviewedHeadHash:expected.headHash,reviewedMaterialHash:expected.materialHash,reviewedStoryFilesHash:expected.storyFilesHash}),false,'restoring a real PASS cannot retain a different previously recorded result');
assert.equal(verifyManagedReviewLiveBinding({gitCwd:fixture.root,metadataRoot:fixture.root,storyId,expected}).valid,false,'result-changing publication loses managed lineage');
git(fixture.root,['reset','--hard',publishedHead]);
// Duplicate references must not let one prior PASS conceal a FAIL upgrade.
const duplicateBefore=structuredClone(trueCoverage);
const duplicateFail={...structuredClone(duplicateBefore.items[0].verificationEvidence[0]),result:'fail'};
duplicateBefore.items[0].verificationEvidence.push(duplicateFail);
fixture.store.writeChecklist(storyId,duplicateBefore);
git(fixture.root,['add','--',storyPrefix+'checklist.json']);git(fixture.root,['commit','-m','test: construct duplicate-reference result boundary']);
const duplicateAfter=structuredClone(duplicateBefore);
duplicateAfter.items[0].verificationEvidence[1]={...structuredClone(duplicateAfter.items[0].verificationEvidence[0]),note:'Duplicate replacement must not reuse prior authority'};
fixture.store.writeChecklist(storyId,duplicateAfter);
git(fixture.root,['add','--',storyPrefix+'checklist.json']);git(fixture.root,['commit','-m',`proof-or-stop: record ${storyId} verification_evidence_add metadata`]);
assert.equal(isVerifiedReviewMaintenanceCommit({gitCwd:fixture.root,metadataRoot:fixture.root,storyId,commit:git(fixture.root,['rev-parse','HEAD']),reviewedHeadHash:expected.headHash,reviewedMaterialHash:expected.materialHash,reviewedStoryFilesHash:expected.storyFilesHash}),false,'duplicate-reference FAIL upgrade is refused');
assert.equal(verifyManagedReviewLiveBinding({gitCwd:fixture.root,metadataRoot:fixture.root,storyId,expected}).valid,false,'duplicate-reference result change invalidates live binding');
git(fixture.root,['reset','--hard',publishedHead]);

const unreviewedTitle=fixture.store.readChecklist(storyId);unreviewedTitle.items[0].title='Unreviewed requirement rewrite';
fixture.store.writeChecklist(storyId,unreviewedTitle);
git(fixture.root,['add','--',storyPrefix+'checklist.json']);git(fixture.root,['commit','-m','test: introduce an unreviewed title before a genuine refresh']);
cli(fixture.root,'verification_evidence_add',evidencePayload,env('main','saturation-owner'));
assert.equal(evaluateReviewRunMetadataRetention(fixture.store,fixture.store.readStory(storyId),persistedCritic,fixture.root,currentScopeContextForStory(fixture.store,storyId,fixture.root)).ok,false,'parent-relative refresh cannot conceal a change since the original reviewed snapshot');
git(fixture.root,['reset','--hard',publishedHead]);
for(const mode of modes) {
// Each counterexample starts from the same genuine signed publication. This
// reset is restricted to the freshly created disposable Git fixture above.
assert(isolatedFixtureRoots.has(fixture.root) && fixture.root.startsWith(primaryRoot+'/'));
git(fixture.root,['reset','--hard',publishedHead]);
for(const path of git(fixture.root,['ls-files','--others','--exclude-standard','--',storyPrefix]).split('\n').filter(Boolean)) {
 assert(path.startsWith(storyPrefix) && !path.includes('..'));
 rmSync(join(fixture.root,path),{force:true});
}
if(mode==='coverage-added') {
 cli(fixture.root,'verification_evidence_add',{...evidencePayload,intentRef:'CHK-001:happy:1'},env('main','saturation-owner'));
 assert.equal(isVerifiedReviewMaintenanceCommit({gitCwd:fixture.root,metadataRoot:fixture.root,storyId,commit:git(fixture.root,['rev-parse','HEAD']),reviewedHeadHash:expected.headHash,reviewedMaterialHash:expected.materialHash,reviewedStoryFilesHash:expected.storyFilesHash}),false,'new coverage requires independent review');
} else
if(mode==='cancelled') {
 console.log(cli(fixture.root,'review_inventory_cancel',{storyId,reason:'Native regression verifies cancelled inventory cannot authorize certification'},env('main','saturation-owner')));
 assert.equal(git(fixture.root,['log','-1','--format=%s']),`proof-or-stop: record ${storyId} review epoch metadata`);
 const cancelled=fixture.store.readReviewInventoryEpochs(storyId);
 assert.equal(cancelled.epochs.at(-1).state,'CANCELLED');
 assert(verifyReviewInventoryEpoch(cancelled.epochs.at(-1)));
 assert(cancelled.receipts.at(-1).invalidatedAt);
 assert(verifyReviewInventoryReceipt(cancelled.receipts.at(-1)));
 assert.equal(finalizedUnconsumedReviewInventory(fixture.store,storyId),null);
 assertNoReaderHealth(()=>assert.equal(managedInventorySubjectState(fixture.store,persistedCritic),'invalid','cancelled critic cannot be consumed'));
} else if(mode==='forged-refresh') {
 const checklist=fixture.store.readChecklist(storyId);
 checklist.items[0].title='Unreviewed acceptance alteration';
 fixture.store.writeChecklist(storyId,checklist);
 git(fixture.root,['add','--',storyPrefix+'checklist.json']);
 git(fixture.root,['commit','-m',`proof-or-stop: record ${storyId} verification_evidence_add metadata`]);
} else if(mode==='forged-publisher') {
 const {appendFileSync}=await import('node:fs');
 const path=storyPrefix+'review-inventory-epochs.json';
 appendFileSync(join(fixture.root,path),'\n');git(fixture.root,['add','--',path]);
 git(fixture.root,['commit','-m',`proof-or-stop: record ${storyId} review epoch metadata`]);
} else if(mode!=='clean') {
 const relative=mode==='wrong-story-path'?'.proof-or-stop/story/actives/B-other/note.txt':`.proof-or-stop/story/actives/${storyId}/process-events.jsonl`;
 mkdirSync(join(fixture.root,relative,'..'),{recursive:true});
 if(mode==='wrong-subject'||mode==='missing-epochs') {const {appendFileSync}=await import('node:fs');appendFileSync(join(fixture.root,relative),'\n');}
 else writeFileSync(join(fixture.root,relative),'unrelated path must not gain review continuity\n');
 git(fixture.root,['add','--',relative]);
 git(fixture.root,['commit','-m',mode==='wrong-subject'?'ordinary bookkeeping claim':`proof-or-stop: record ${storyId} review epoch metadata`]);
}
if(mode==='missing-epochs') {
 const changed=git(fixture.root,['diff-tree','--no-commit-id','--name-only','-r','HEAD']).split('\n').filter(Boolean);
 assert.deepEqual(changed,[storyPrefix+'process-events.jsonl'],'missing-epochs control changes only an allowed sibling');
 assert.equal(isVerifiedReviewMaintenanceCommit({...publicationBinding,commit:git(fixture.root,['rev-parse','HEAD'])}),false);
 console.log('EPOCH_PUBLICATION_MISSING_EPOCHS_REFUSED');
}
if(mode==='clean') {
 cli(fixture.root,'verification_evidence_add',evidencePayload,env('main','saturation-owner'));
 const refreshed=verifyManagedReviewLiveBinding({gitCwd:fixture.root,metadataRoot:fixture.root,storyId,expected});
 if(!refreshed.valid) {
  console.log('REFRESH_LINEAGE_DIAGNOSTIC',JSON.stringify({refreshed,history:git(fixture.root,['log','--format=%h %s',publishedHead+'..HEAD']),paths:git(fixture.root,['diff-tree','--no-commit-id','--name-only','-r','HEAD'])}));
  const {hasMechanicalExecutionAuthority}=await import('../packages/main/dist/core/verification-receipt-authority.js');
  for(const item of fixture.store.readChecklist(storyId).items) for(const evidence of item.verificationEvidence??[]) console.log('REFRESH_AUTHORITY',hasMechanicalExecutionAuthority(fixture.store,storyId,item,evidence));
 }
 assert(refreshed.valid,'authenticated evidence-only refresh preserves review lineage');
 assert.equal(evaluateReviewRunMetadataRetention(fixture.store,fixture.store.readStory(storyId),persistedCritic,fixture.root,currentScopeContextForStory(fixture.store,storyId,fixture.root)).ok,true,'production retention accepts byte-bound checklist and causal projections');
 const authorityHead=git(fixture.root,['rev-parse','HEAD']),authorityParent=git(fixture.root,['rev-parse','HEAD^']);
 const authorityPaths=git(fixture.root,['diff-tree','--no-commit-id','--name-only','-r',authorityHead]).split('\n').filter(Boolean);
 const checklistAt=ref=>JSON.parse(execFileSync('git',['show',ref+':'+storyPrefix+'checklist.json'],{cwd:fixture.root,encoding:'utf8'}));
 const semantic=data=>data.items.map(item=>({id:item.id,rows:(item.verificationEvidence??[]).map(e=>[e.intentRef,e.kind,e.result])}));
 const requirements=data=>data.items.map(({verificationEvidence,...item})=>item);
 for(const side of ['prior','replacement']) {
  git(fixture.root,['reset','--hard',authorityParent]);
  const prior=checklistAt(authorityParent),replacement=checklistAt(authorityHead);
  const broken=side==='prior'?prior:replacement;broken.items[0].verificationEvidence[0].receipt.selectorMatched=false;
  assert.deepEqual(semantic(prior),semantic(replacement));assert.deepEqual(requirements(prior),requirements(replacement));
  if(side==='prior') {
   fixture.store.writeChecklist(storyId,prior);git(fixture.root,['add','--',storyPrefix+'checklist.json']);git(fixture.root,['commit','-m','test: unauthenticated prior receipt with unchanged coverage']);
  }
  for(const path of authorityPaths){mkdirSync(join(fixture.root,path,'..'),{recursive:true});writeFileSync(join(fixture.root,path),execFileSync('git',['show',authorityHead+':'+path],{cwd:fixture.root}));}
  fixture.store.writeChecklist(storyId,replacement);
  assert.equal(hasMechanicalExecutionAuthority(fixture.store,storyId,prior.items[0],prior.items[0].verificationEvidence[0]),side!=='prior');
  assert.equal(hasMechanicalExecutionAuthority(fixture.store,storyId,replacement.items[0],replacement.items[0].verificationEvidence[0]),side!=='replacement');
  git(fixture.root,['add','--',...authorityPaths,storyPrefix+'checklist.json']);git(fixture.root,['commit','-m',`proof-or-stop: record ${storyId} verification_evidence_add metadata`]);
  assert.equal(isVerifiedReviewMaintenanceCommit({...publicationBinding,commit:git(fixture.root,['rev-parse','HEAD'])}),false,'unchanged coverage requires authenticated '+side+' execution');
  console.log('PAIRED_EXECUTION_AUTHORITY_REFUSED '+side);
 }
 git(fixture.root,['reset','--hard',authorityHead]);
 // Reuse actual independently issued executions; no invented receipt is valid.
 // The reviewed baseline has two distinct intents. A forged first commit alters
 // happy:1; the next genuine refresh changes happy:0 and preserves the bad row.
 for(const forged of [false,true]) {
  git(fixture.root,['reset','--hard',authorityHead]);
  const baseline=checklistAt(authorityParent);
  baseline.items[0].verificationEvidence=structuredClone(initialPairedEvidence);
  assert.equal(baseline.items[0].verificationEvidence.length,2);
  for(const evidence of baseline.items[0].verificationEvidence) assert(hasMechanicalExecutionAuthority(fixture.store,storyId,baseline.items[0],evidence));
  fixture.store.writeChecklist(storyId,baseline);
  git(fixture.root,['add','--',storyPrefix+'checklist.json']);git(fixture.root,['commit','-m','test: reviewed two-intent authenticated baseline']);
  const reviewedChainHead=git(fixture.root,['rev-parse','HEAD']);
  const first=structuredClone(baseline);
  first.items[0].verificationEvidence[0]=structuredClone(checklistAt(authorityParent).items[0].verificationEvidence[0]);
  if(forged) first.items[0].verificationEvidence[1].receipt.selectorMatched=false;
  fixture.store.writeChecklist(storyId,first);
  git(fixture.root,['add','--',storyPrefix+'checklist.json']);git(fixture.root,['commit','-m',`proof-or-stop: record ${storyId} verification_evidence_add metadata`]);
  const chainArgs={...publicationBinding,reviewedHeadHash:reviewedChainHead};
  assert.equal(isVerifiedReviewMaintenanceCommit({...chainArgs,commit:git(fixture.root,['rev-parse','HEAD'])}),!forged,'first chain commit authority');
  const next=structuredClone(first);
  next.items[0].verificationEvidence[0]=structuredClone(checklistAt(authorityHead).items[0].verificationEvidence[0]);
  assert(hasMechanicalExecutionAuthority(fixture.store,storyId,next.items[0],next.items[0].verificationEvidence[0]));
  fixture.store.writeChecklist(storyId,next);
  git(fixture.root,['add','--',storyPrefix+'checklist.json']);git(fixture.root,['commit','-m',`proof-or-stop: record ${storyId} verification_evidence_add metadata`]);
  const nextHead=git(fixture.root,['rev-parse','HEAD']);
  assert.equal(isVerifiedReviewMaintenanceCommit({...chainArgs,commit:nextHead}),!forged,'later refresh cannot grandfather a rejected row');
  assert.equal(isCurrentVerifiedEvidenceRefreshArtifact({...chainArgs,snapshotHead:nextHead,artifactPath:'checklist.json',isProtectedArtifact:closeoutArtifactPolicyFor}),!forged,'latest-artifact lookup preserves reviewed authority');
  console.log(forged?'GRANDFATHERED_UNAUTHENTICATED_ROW_REFUSED':'AUTHENTICATED_REFRESH_CHAIN_GREEN');
 }
 git(fixture.root,['reset','--hard',authorityHead]);
} else {
 assert.equal(verifyManagedReviewLiveBinding({gitCwd:fixture.root,metadataRoot:fixture.root,storyId,expected}).valid,false,'forged metadata and cancelled epochs never preserve managed authority');
}
const cheap=JSON.parse(cli(fixture.root,'validate',{storyId,focus:'fast',json:true},env('main','saturation-owner')));assert.equal(cheap.status,'pass');
let output='',error='';try{output=cli(fixture.root,'certification_window_begin',{storyId},env('main','saturation-owner'));}catch(e){error=String(e);}
console.log('REVIEW_EPOCH_CONTINUITY_OBSERVATION '+JSON.stringify({mode,output,error}));
if(mode==='clean') {
 if(error) for(const commit of git(fixture.root,['rev-list','--reverse',cutoff+'..HEAD']).split('\n').filter(Boolean)) {
  const subject=git(fixture.root,['show','-s','--format=%s',commit]);
  if(subject.includes('verification_evidence_add') || subject.includes('review epoch')) console.log('PRECERT_LINEAGE_DIAGNOSTIC',JSON.stringify({commit,subject,accepted:isVerifiedReviewMaintenanceCommit({gitCwd:fixture.root,metadataRoot:fixture.root,storyId,commit,reviewedHeadHash:cutoff}),paths:git(fixture.root,['diff-tree','--no-commit-id','--name-only','-r',commit])}));
 }
 assert.equal(error,'','REVIEW_EPOCH_NATIVE_CONTINUITY_REQUIRED: actual canonical batch publication must admit without material drift');
 assert.match(output,/State: ADMITTED/);
 const consumptionHead=git(fixture.root,['rev-parse','HEAD']),consumptionParent=git(fixture.root,['rev-parse','HEAD^']);
 const consumptionPaths=git(fixture.root,['diff-tree','--no-commit-id','--name-only','-r',consumptionHead]).split('\n').filter(Boolean);
 assert(consumptionPaths.includes(storyPrefix+'review-inventory-epochs.json'));
 for(const fault of [false,true]) {
  git(fixture.root,['reset','--hard',consumptionParent]);
  for(const path of consumptionPaths){mkdirSync(join(fixture.root,path,'..'),{recursive:true});writeFileSync(join(fixture.root,path),execFileSync('git',['show',consumptionHead+':'+path],{cwd:fixture.root}));}
  if(fault) {
   const data=fixture.store.readReviewInventoryEpochs(storyId);const consumed=data.epochs.find(row=>row.consumedAt);assert(consumed);
   // Keep every early consumption predicate and the window valid. Only the
   // signed updatedAt differs from the exact consumedAt-derived allowed delta.
   consumed.updatedAt=new Date(Date.parse(consumed.consumedAt)+1000).toISOString();
   const {_hash,...claims}=consumed;consumed._hash=signReviewInventoryEpoch(claims);assert(verifyReviewInventoryEpoch(consumed));
   for(const receipt of data.receipts)assert(verifyReviewInventoryReceipt(receipt));
   fixture.store.writeReviewInventoryEpochs(storyId,data);
  }
  assert.equal(readFileSync(join(fixture.root,storyPrefix+'certification-window.json'),'utf8'),execFileSync('git',['show',consumptionHead+':'+storyPrefix+'certification-window.json'],{cwd:fixture.root,encoding:'utf8'}));
  git(fixture.root,['add','--',...consumptionPaths]);git(fixture.root,['commit','-m',`proof-or-stop: record ${storyId} certification_window_begin metadata`]);
  assert.equal(isVerifiedReviewMaintenanceCommit({...publicationBinding,commit:git(fixture.root,['rev-parse','HEAD'])}),!fault,'signed inventory consumption exact delta');
 }
 console.log('SIGNED_CONSUMPTION_EXTRA_DELTA_REFUSED');
 git(fixture.root,['reset','--hard',consumptionHead]);

 const routine=JSON.parse(cli(fixture.root,'validate',{storyId,json:true},env('main','saturation-owner')));assert.equal(routine.status,'pass');
 console.log('POST_CERT_METADATA',git(fixture.root,['log','--format=%H %s','--name-only',publishedHead+'..HEAD']));
 console.log(cli(fixture.root,'story_advance',{storyId,phase:'TEST'},env('main','saturation-owner')));
 console.log('POST_TEST_METADATA',git(fixture.root,['log','-1','--format=%H %s','--name-only']));
 const afterTest=collectReviewerEvidenceState(fixture.store,storyId,fixture.root);
 assert(afterTest.valid.some(e=>e.reviewRunId===cr),'REVIEW_TO_TEST_MANAGED_CONTINUITY_REQUIRED: actual TEST publication preserves managed review authority: '+JSON.stringify(afterTest.invalid));
 const testHead=git(fixture.root,['rev-parse','HEAD']);
 const testParent=git(fixture.root,['rev-parse',testHead+'^']);
 const testIndex=JSON.parse(readFileSync(join(fixture.root,storyPrefix,'index.json'),'utf8'));
 // Reconstruct the genuine validate publication on its exact parent, then
 // perturb one receipt predicate while preserving the real artifact bytes.
 const validateHead=testParent;
 assert.match(git(fixture.root,['show','-s','--format=%s',validateHead]),/validate metadata$/);
 const validateParent=git(fixture.root,['rev-parse',validateHead+'^']);
 const validatePaths=git(fixture.root,['diff-tree','--no-commit-id','--name-only','-r',validateHead]).split('\n').filter(Boolean);
 const receiptPath=storyPrefix+'closeout-write-receipts.jsonl';
 const restoreValidate=()=>{
  git(fixture.root,['reset','--hard',validateParent]);
  for(const path of validatePaths) {
   mkdirSync(join(fixture.root,path,'..'),{recursive:true});
   writeFileSync(join(fixture.root,path),execFileSync('git',['show',validateHead+':'+path],{cwd:fixture.root}));
  }
 };
 for(const validMetrics of [true,false]) {
  restoreValidate();
  const metricsPath=storyPrefix+'process-metrics.json';
  writeFileSync(join(fixture.root,metricsPath),JSON.stringify({...observedMetrics,storyId:validMetrics?storyId:'B-foreign'}));
  git(fixture.root,['add','--',...new Set([...validatePaths,metricsPath])]);
  git(fixture.root,['commit','-m',`proof-or-stop: record ${storyId} validate metadata`]);
  assert.equal(isVerifiedReviewMaintenanceCommit({gitCwd:fixture.root,metadataRoot:fixture.root,storyId,commit:git(fixture.root,['rev-parse','HEAD']),reviewedHeadHash:expected.headHash,reviewedMaterialHash:expected.materialHash,reviewedStoryFilesHash:expected.storyFilesHash}),validMetrics,'validate metrics Story binding');
  console.log('VALIDATE_PROCESS_METRICS_STORY_BOUNDARY '+(validMetrics?'control':'foreign-refused'));
 }
 for(const fault of ['sequence','previous-integrity','head','duplicate-receipt','rewrite-prefix','mixed-telemetry']) {
  restoreValidate();
  const receipts=readFileSync(join(fixture.root,receiptPath),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const last=receipts.at(-1);
  if(fault==='sequence') last.sequence+=1;
  if(fault==='previous-integrity') last.previousIntegrityHash='f'.repeat(64);
  if(fault==='head') last.headHash=expected.headHash;
  if(['sequence','previous-integrity','head'].includes(fault)) last.integrityHash=computeCloseoutWriteReceiptIntegrity(last);
  if(fault==='duplicate-receipt') receipts.push(structuredClone(last));
  if(fault==='rewrite-prefix') {
   // Seed this disposable parent's history with the authentic receipt; the
   // candidate then rewrites that already persisted prefix instead of appending.
   git(fixture.root,['reset','--hard',validateParent]);
   writeFileSync(join(fixture.root,receiptPath),receipts.map(row=>JSON.stringify(row)).join('\n')+'\n');
   git(fixture.root,['add','--',receiptPath]);git(fixture.root,['commit','-m','test: establish authentic prior closeout receipt']);
   for(const path of validatePaths) writeFileSync(join(fixture.root,path),execFileSync('git',['show',validateHead+':'+path],{cwd:fixture.root}));
   receipts[0].timestamp='2099-01-01T00:00:00.000Z';receipts[0].integrityHash=computeCloseoutWriteReceiptIntegrity(receipts[0]);
  }
  writeFileSync(join(fixture.root,receiptPath),receipts.map(row=>JSON.stringify(row)).join('\n')+'\n');
  const extra=storyPrefix+'test-runs.json';
  if(fault==='mixed-telemetry') writeFileSync(join(fixture.root,extra),JSON.stringify({runs:[{forged:true}]}));
  git(fixture.root,['add','--',...validatePaths,...(fault==='mixed-telemetry'?[extra]:[])]);
  git(fixture.root,['commit','-m',`proof-or-stop: record ${storyId} validate metadata`]);
  assert.equal(isVerifiedReviewMaintenanceCommit({gitCwd:fixture.root,metadataRoot:fixture.root,storyId,commit:git(fixture.root,['rev-parse','HEAD']),reviewedHeadHash:expected.headHash,reviewedMaterialHash:expected.materialHash,reviewedStoryFilesHash:expected.storyFilesHash}),false,fault);
  console.log('VALIDATE_PUBLICATION_BOUNDARY '+fault);
 }
 git(fixture.root,['reset','--hard',testHead]);

 for(const [name,mutate,reason] of [
  ['stable-field',data=>({...data,title:'Forged requirement change'}),'index fields outside'],
  ['extra-event',data=>({...data,events:[...data.events,data.events.at(-1)]}),'events are not'],
  ['event-key',data=>({...data,events:[...data.events.slice(0,-1),{...data.events.at(-1),forged:true}]}),'transition event contains'],
  ['review-round',data=>({...data,currentReviewRound:'2099-01-01T00:00:00.000Z'}),'currentReviewRound changed'],
 ]) {
  const forged=mutate(structuredClone(testIndex));
  const verdict=evaluatePersistedReviewToTestIndexTransition(fixture.root,storyPrefix+'index.json',{storyId,headHash:testParent,reviewRound},forged);
  assert.equal(verdict.ok,false,name);assert(verdict.reason.includes(reason),JSON.stringify(verdict));
  git(fixture.root,['reset','--hard',testParent]);
  writeFileSync(join(fixture.root,storyPrefix,'index.json'),JSON.stringify(forged,null,2)+'\n');
  git(fixture.root,['add','--',storyPrefix+'index.json']);
  git(fixture.root,['commit','-m',`proof-or-stop: record ${storyId} test-transition metadata`]);
  assert.equal(isVerifiedReviewMaintenanceCommit({gitCwd:fixture.root,metadataRoot:fixture.root,storyId,commit:git(fixture.root,['rev-parse','HEAD']),reviewedHeadHash:expected.headHash,reviewedMaterialHash:expected.materialHash,reviewedStoryFilesHash:expected.storyFilesHash}),false,name);
  console.log('REVIEW_TO_TEST_EXACT_DELTA_REFUSED '+name);
 }
 git(fixture.root,['reset','--hard',testParent]);
 const foreignRound='2099-01-01T00:00:00.000Z';
 const foreignParent={...JSON.parse(readFileSync(join(fixture.root,storyPrefix,'index.json'),'utf8')),currentReviewRound:foreignRound};
 writeFileSync(join(fixture.root,storyPrefix,'index.json'),JSON.stringify(foreignParent,null,2)+'\n');
 git(fixture.root,['add','--',storyPrefix+'index.json']);git(fixture.root,['commit','-m','test: construct foreign-round transition parent']);
 const foreignParentHead=git(fixture.root,['rev-parse','HEAD']);
 const foreignTest={...testIndex,currentReviewRound:foreignRound};
 assert(evaluatePersistedReviewToTestIndexTransition(fixture.root,storyPrefix+'index.json',{storyId,headHash:foreignParentHead,reviewRound:foreignRound},foreignTest).ok,'control proves an unbound parent-only comparison would accept');
 writeFileSync(join(fixture.root,storyPrefix,'index.json'),JSON.stringify(foreignTest,null,2)+'\n');
 git(fixture.root,['add','--',storyPrefix+'index.json']);git(fixture.root,['commit','-m',`proof-or-stop: record ${storyId} test-transition metadata`]);
 assert.equal(isVerifiedReviewMaintenanceCommit({gitCwd:fixture.root,metadataRoot:fixture.root,storyId,commit:git(fixture.root,['rev-parse','HEAD']),reviewedHeadHash:expected.headHash,reviewedMaterialHash:expected.materialHash,reviewedStoryFilesHash:expected.storyFilesHash}),false,'transition round must bind original reviewed HEAD, not candidate or parent agreement');
 console.log('REVIEW_TO_TEST_ORIGINAL_ROUND_REFUSED');
 git(fixture.root,['reset','--hard',testHead]);
 for(const [path,writer,mutate] of [
  ['certification-window.json','certification_window_begin',data=>({...data,windows:data.windows.map(window=>({...window,state:'CANCELLED'}))})],
  ['test-evidence.json','validate',data=>({...data,forgedResult:'Caller-authored pass is not evidence'})],
 ]) {
  assert(isolatedFixtureRoots.has(fixture.root));
  git(fixture.root,['reset','--hard',testHead]);
  const target=join(fixture.root,storyPrefix,path);
  writeFileSync(target,JSON.stringify(mutate(JSON.parse(readFileSync(target,'utf8'))),null,2)+'\n');
  git(fixture.root,['add','--',storyPrefix+path]);
  git(fixture.root,['commit','-m',`proof-or-stop: record ${storyId} ${writer} metadata`]);
  assert.equal(verifyManagedReviewLiveBinding({gitCwd:fixture.root,metadataRoot:fixture.root,storyId,expected}).valid,false,'forged post-review '+path+' must not retain review');
  console.log('POST_REVIEW_FORGERY_REFUSED '+path);
 }
 git(fixture.root,['reset','--hard',testHead]);
 const telemetryPath=storyPrefix+'test-runs.json';
 writeFileSync(join(fixture.root,telemetryPath),JSON.stringify({runs:[{forged:true}]}));
 git(fixture.root,['add','--',telemetryPath]);
 git(fixture.root,['commit','-m',`proof-or-stop: record ${storyId} validate metadata`]);
 assert.equal(verifyManagedReviewLiveBinding({gitCwd:fixture.root,metadataRoot:fixture.root,storyId,expected}).valid,false,'telemetry alone is not a validate publication');
 git(fixture.root,['reset','--hard',testHead]);

 const data=fixture.store.readCertificationWindows(storyId);assert.equal(data.receipts.filter(r=>r.authority==='pre-cert').length,1);
 console.log('REVIEW_EPOCH_NATIVE_CONTINUITY GREEN');
} else {
 if(mode==='cancelled') assert.match(error,/pre_cert_inventory_not_finalized/,'signed cancelled receipt must fail the actual inventory admission gate');
 else {
  assert.match(error,/Inventory receipt is not on the current headHash lineage/,'negative must reach actual continuity verifier');
  if(mode==='coverage-added') assert.match(error,/pre_cert_inventory_not_finalized/,'coverage-changing publication is refused at PRE_CERT admission');
 }
 assert.equal(fixture.store.readCertificationWindows(storyId).receipts.filter(r=>r.authority==='pre-cert').length,0);
 console.log('REVIEW_EPOCH_CONTINUITY_REFUSED '+mode);
}
}
} finally {rmSync(primaryRoot,{recursive:true,force:true});}
}
