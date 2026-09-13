// Disposable synthetic provider; actual CLI, signed worker receipt and importer.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {StoryStore} from '../packages/main/dist/core/store.js';
import {resetConfigCache} from '../packages/main/dist/core/config.js';
import {readOwnerLease,releaseOwnerLease} from '../packages/main/dist/core/story-owner-lease.js';
import {adapterSessionEnv,adapterSessionId} from '../packages/main/dist/tasks/adapter-session-env.js';
import {nativeReviewFixtureBrokers,runBrokeredNativeReviewCli} from '../packages/main/dist/tasks/native-review-fixture.js';
import {createHostRunHandlers} from '../packages/main/dist/handlers/host-run.js';
import {createManagedReviewEvidenceHandlers} from '../packages/main/dist/handlers/managed-review-evidence.js';
import {getManagedHostRunStatus,managedHostRunReceipt} from '../packages/main/dist/core/managed-host-run.js';
const storyId = 'B-inventory-handler';
const reviewRound = '2020-01-01T00:00:00.000Z';
const cliPath = fileURLToPath(new URL('../bin/proof-or-stop.js', import.meta.url));
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

const {runIsolatedFindingFixture}=await import('../packages/main/dist/tasks/isolated-finding-fixture.js');
if(await runIsolatedFindingFixture(import.meta.url)) process.exit(0);
const scenario=process.argv.find(a=>a.startsWith('--case='))?.slice(7) ?? 'findings';
assert(['findings','pass','crash','wrong-wave','drift','committed-drift','missing-disposition','duplicate','not-verified','own-id','existing-id','index-ambiguity','cancel-before-import','native','resolved-collision'].includes(scenario));
const fixture=setup();
const primary=fixture.root;
const worktree=join(primary,'.worktrees',storyId);
fixture.store.writeStory(storyId,{...fixture.store.readStory(storyId),worktree:{path:worktree,branch:'story/'+storyId,createdAt:reviewRound}});
fixture.store.writeChecklist(storyId,{items:[]});
git(primary,['add','.']);git(primary,['commit','-m','record disposable story']);
git(primary,['worktree','add','-b','story/'+storyId,worktree]);
fixture.root=worktree;fixture.store=new StoryStore(worktree);isolatedFixtureRoots.add(worktree);
const oldCwd=process.cwd();
try {
cli(worktree,'candidate_spec_route',{storyId,hosts:false});
cli(worktree,'review_inventory_begin',{storyId});
const epoch=fixture.store.readReviewInventoryEpochs(storyId).epochs.at(-1);
const artifact=fixture.store.readCandidateSpecSet(storyId);
const files=[...new Set(['packages/main/src/subject.ts',...artifact.candidateSpecSet])];
const readManifest={filesReadFully:files,filesTriagedByName:[],scanEscalationReason:artifact.scanEscalationReason,candidateSpecSetDigest:artifact.artifactDigest,corpusDigest:artifact.corpusDigest};
const readEvents=files.map(path=>({path,mode:'full',action:'Read',tokenCount:null}));
for(const lane of epoch.requiredLanes){
 const env={PROOF_OR_STOP_AGENT:lane,PROOF_OR_STOP_SESSION_ID:'fixture-'+lane};
 cli(worktree,'dispatch',{storyId,agentType:lane},env);
 const out=cli(worktree,'review_run_start',{storyId,agent:lane},env);
 const reviewRunId=out.match(/Review run (\S+) started/)[1];
 if(scenario==='existing-id'&&lane===epoch.requiredLanes[0]) {
  await runBrokeredNativeReviewCli({root:worktree,store:fixture.store,storyId,agent:lane,reviewRunId,command:'finding_add',payload:{storyId,agent:lane,reviewRunId,desc:'The baseline reviewer identifies a bounded verified observation for existing-ID transport.',severity:'medium',category:'missing',files:['packages/main/src/subject.ts'],evidenceState:'verified',readManifest,readEvents}});
 } else {
 await runBrokeredNativeReviewCli({root:worktree,store:fixture.store,storyId,agent:lane,reviewRunId,command:'review_pass_set',payload:{storyId,agent:lane,reviewRunId,note:'Disposable native lane fully read the bounded candidate set.',readManifest,readEvents}});
 }
}
const lane='proof-or-stop-review-topology-critic';
const purpose={reviewPurpose:'inventory-completeness',inventoryEpochId:epoch.epochId};
const env={PROOF_OR_STOP_AGENT:lane,PROOF_OR_STOP_SESSION_ID:'fixture-critic'};
cli(worktree,'dispatch',{storyId,agentType:lane,...purpose},env);
const out=cli(worktree,'review_run_start',{storyId,agent:lane,...purpose},env);
const reviewRunId=out.match(/Review run (\S+) started/)[1];
const {buildManagedReviewerPrompt}=await import('../packages/main/dist/core/managed-review-evidence.js');
const signedRun=fixture.store.readReviewRuns(storyId).runs.find(r=>r.reviewRunId===reviewRunId);
const renderedPrompt=buildManagedReviewerPrompt(worktree,signedRun);
assert(renderedPrompt.includes('copy these exact values: '+JSON.stringify({epochId:epoch.epochId,wave:epoch.waves.length+1})), 'Rendered managed critic prompt must state exact current epoch and wave');
if(scenario==='native') {
 await runBrokeredNativeReviewCli({root:worktree,store:fixture.store,storyId,agent:lane,reviewRunId,command:'finding_add',payload:{storyId,agent:lane,reviewRunId,desc:'Native critic observes a bounded fixture issue for signed disposition replay tests.',severity:'medium',category:'missing',files:['packages/main/src/subject.ts'],evidenceState:'verified',readManifest,readEvents}});
 const findingId=fixture.store.readFindings(storyId).findings.at(-1).id;
 const valid={findingId,disposition:'verified_family',familyKey:'native-fixture',reason:'Native critic classifies the bounded fixture finding.'};
 const submit=row=>cli(worktree,'review_inventory_critic_set',{storyId,epochId:epoch.epochId,reviewRunId,agent:lane,findingDispositions:[row]},env);
 for(const invalid of [{...valid,reason:'   123456789   '},{...valid,familyKey:'   '},{...valid,canonicalFindingId:'   '}]) {
  assert.throws(()=>submit(invalid),/REVIEW_INVENTORY_DISPOSITION_FIELD_INVALID/);
  assert.equal(fixture.store.readReviewInventoryEpochs(storyId).criticReceipts.length,0,'Native invalid fields cannot write a receipt');
 }
 const first=submit(valid);assert.match(first,/Completeness critic: complete/);
 const receiptFile=fixture.store.storyFilePath(storyId,'review-inventory-epochs.json');
 const before=readFileSync(receiptFile,'utf8');
 const receiptId=fixture.store.readReviewInventoryEpochs(storyId).criticReceipts[0].criticReceiptId;
 assert(submit(valid).includes(receiptId),'Identical native replay returns same receipt ID');
 assert.equal(readFileSync(receiptFile,'utf8'),before,'Identical native replay preserves exact stored bytes');
 assert.throws(()=>submit({...valid,reason:'A changed native disposition must conflict with the existing signed receipt.'}),/conflicting receipt/);
 assert.equal(readFileSync(receiptFile,'utf8'),before,'Conflicting native replay preserves original bytes');
 console.log('NATIVE_CRITIC_FIELDS_AND_REPLAY_GREEN');
} else {
process.chdir(worktree);
const ctx={root:worktree,store:fixture.store,scanRoot:join(worktree,'packages/main')};
const baselineFindings=fixture.store.readFindings(storyId).findings;
const baseFinding={desc:'A disposable verified observation tests own-index mapping without guessing its allocated ID.',severity:'medium',category:'missing',files:['packages/main/src/subject.ts'],evidenceState:'verified'};
const proposalFindings=['duplicate','resolved-collision'].includes(scenario)?[baseFinding,{...baseFinding,desc:'A second disposable observation duplicates the first bounded family.'}]:[baseFinding];
const dispositions=[{finding:{proposalFindingIndex:0},disposition:'verified_family',familyKey:'fixture-family',reason:'Independent synthetic provider classifies its own observation.'}];
if(['duplicate','resolved-collision'].includes(scenario)) dispositions.push({finding:{proposalFindingIndex:1},disposition:'duplicate',familyKey:'fixture-family',canonicalFinding:{proposalFindingIndex:0},reason:'Both observations identify the same bounded family.'});
if(scenario==='not-verified') {dispositions[0]={finding:{proposalFindingIndex:0},disposition:'not_verified',reason:'The critic does not classify this observation as a verified family; original Finding evidence remains unchanged.'};}
if(scenario==='own-id') dispositions[0].finding={findingId:storyId+':F-001'};
if(scenario==='existing-id') {assert.equal(baselineFindings.length,1);dispositions.push({finding:{findingId:baselineFindings[0].id},disposition:'verified_family',familyKey:'existing-family',reason:'This signed finding predates the managed receipt.'});}
const host=createHostRunHandlers(ctx,{runner:async(plan)=>{
 if(scenario==='pass') {
  const {writeManagedReviewEvidenceProposal,managedHostRunDirectory}=await import('../packages/main/dist/core/managed-host-run.js');
  const callbackRun=plan.env.LATTICE_MANAGED_HOST_RUN_ID;
  assert.throws(()=>writeManagedReviewEvidenceProposal({root:worktree,runId:callbackRun,environment:plan.env,proposal:{storyId,providerAgent:lane,lane,reviewRunId,conclusion:'pass',note:'This invalid block must not be persisted.',readManifest,readLog:{filesReadFully:files,filesTriagedByName:[],summary:{readCount:files.length,tokenCount:null},digest:'a'.repeat(64)},inventoryCritic:{epochId:epoch.epochId,wave:0,findingDispositions:[]}}}),/invalid inventory critic transport/);
  assert(!existsSync(join(managedHostRunDirectory(worktree,callbackRun),'evidence-proposal.json')));
 }
 for(const path of files) readFileSync(join(worktree,path));
 return {stdout:'',stderr:'',exitCode:0,timedOut:false,terminalReason:'completed',finalAssistantResultCount:1,finalAssistantResultTruncated:false,
 finalAssistantResult:JSON.stringify({schemaVersion:'lattice.managed_review_final_proposal.v1',storyId,providerAgent:lane,lane,reviewRunId,conclusion:scenario==='pass'?'pass':'findings',
 ...(scenario==='pass'?{note:'The independent fixture critic confirms complete bounded coverage.'}:{findings:proposalFindings}),
 inventoryCritic:{epochId:epoch.epochId,wave:scenario==='wrong-wave'?2:1,findingDispositions:['pass','missing-disposition'].includes(scenario)?[]:dispositions},
 readManifest,readLog:{filesReadFully:files,filesTriagedByName:[],summary:{readCount:files.length,tokenCount:null},digest:'a'.repeat(64)}})};
}});
const launched=await host.host_run({host:'codex',storyId,agentType:lane,reviewRunId,lane,managedReview:true,detach:true,deadlineMs:60000,json:true});
let status;const deadline=Date.now()+60000;
do {status=await getManagedHostRunStatus({root:worktree,runId:launched.run.runId});if(['completed','failed','timed_out','cancelled'].includes(status.run.state))break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);
assert.equal(status.run.state,'completed',JSON.stringify(status));
const receipt=managedHostRunReceipt(worktree,launched.run.runId);
const importer=createManagedReviewEvidenceHandlers(ctx);
assert.throws(()=>importer.managed_review_evidence_import({runId:launched.run.runId,receiptId:'sha256:'+'0'.repeat(64)}));
assert.equal(fixture.store.readFindings(storyId).findings.length,baselineFindings.length,'Bad receipt cannot import evidence');
if(scenario==='drift'||scenario==='committed-drift') writeFileSync(join(worktree,'packages/main/src/subject.ts'),'export const subject = 99;\n');
if(scenario==='committed-drift') {git(worktree,['add','packages/main/src/subject.ts']);git(worktree,['commit','-m','fixture: change reviewed material']);}
if(scenario==='cancel-before-import') {
 cli(worktree,'review_inventory_cancel',{storyId,reason:'Disposable cancellation before provider evidence import.'});
 const before=JSON.stringify({findings:fixture.store.readFindings(storyId),events:fixture.store.readProcessEvents(storyId),inventory:fixture.store.readReviewInventoryEpochs(storyId)});
 assert.throws(()=>importer.managed_review_evidence_import({runId:launched.run.runId,receiptId:receipt.receiptId}),/same current OPEN epoch/);
 assert.equal(JSON.stringify({findings:fixture.store.readFindings(storyId),events:fixture.store.readProcessEvents(storyId),inventory:fixture.store.readReviewInventoryEpochs(storyId)}),before);
 assert.deepEqual(managedHostRunReceipt(worktree,launched.run.runId),receipt,'Cancelled late import retains original provider receipt');
 console.log('MANAGED_INVENTORY_CANCELLED_LATE_IMPORT_PRESERVED_GREEN');
} else if(scenario==='resolved-collision') {
 const crashing=createManagedReviewEvidenceHandlers(ctx,{afterManagedHostRunEvidenceBindingWrite:()=>{throw new Error('FIXTURE_TERMINAL_READY');}});
 assert.throws(()=>crashing.managed_review_evidence_import({runId:launched.run.runId,receiptId:receipt.receiptId}),/FIXTURE_TERMINAL_READY/);
 const {importManagedInventoryCritic}=await import('../packages/main/dist/handlers/review-inventory.js');
 const {signFinding}=await import('../packages/main/dist/core/finding-verify.js');
 const originalRead=fixture.store.readFindings.bind(fixture.store);
 const before=JSON.stringify(originalRead(storyId));
 // In-memory corrupted-ledger fixture only: preserve two signed index bindings but collide IDs.
 // No test record is written, and these private fixture keys grant no real Story authority.
 fixture.store.readFindings=(id)=>{const current=originalRead(id);const first=current.findings[0];return {...current,findings:current.findings.map((f,i)=>{
  if(i!==1)return f;
  const v={...f,id:first.id};v._hash=signFinding(id,v.id,v.desc,v.severity,v.createdAt,v.reviewRound,v.reviewRunId,v.readManifest,v.readLog,v.readDiagnostics,v.gapLogBinding,v.managedEvidenceBinding);return v;
 })};};
 try {assert.throws(()=>importManagedInventoryCritic(ctx,{runId:launched.run.runId,receiptId:receipt.receiptId}),/duplicate resolved finding identity/);}
 finally {fixture.store.readFindings=originalRead;}
 assert.equal(fixture.store.readReviewInventoryEpochs(storyId).criticReceipts.length,0,'Collision cannot write a critic receipt');
 assert.equal(JSON.stringify(originalRead(storyId)),before,'Collision probe leaves persisted findings unchanged');
 assert.match(importer.managed_review_evidence_import({runId:launched.run.runId,receiptId:receipt.receiptId}),/Completeness critic: complete/);
 console.log('MANAGED_INVENTORY_RESOLVED_COLLISION_GREEN');
} else if(scenario==='index-ambiguity') {
 const crashing=createManagedReviewEvidenceHandlers(ctx,{afterManagedHostRunEvidenceBindingWrite:()=>{throw new Error('FIXTURE_TERMINAL_READY');}});
 assert.throws(()=>crashing.managed_review_evidence_import({runId:launched.run.runId,receiptId:receipt.receiptId}),/FIXTURE_TERMINAL_READY/);
 const {importManagedInventoryCritic}=await import('../packages/main/dist/handlers/review-inventory.js');
 const originalRead=fixture.store.readFindings.bind(fixture.store);
 fixture.store.readFindings=(id)=>{const current=originalRead(id);return {...current,findings:[...current.findings,...current.findings]};};
 try {assert.throws(()=>importManagedInventoryCritic(ctx,{runId:launched.run.runId,receiptId:receipt.receiptId}),/own finding index not uniquely imported/);}
 finally {fixture.store.readFindings=originalRead;}
 assert.equal(fixture.store.readReviewInventoryEpochs(storyId).criticReceipts.length,0);
 assert.match(importer.managed_review_evidence_import({runId:launched.run.runId,receiptId:receipt.receiptId}),/Completeness critic: complete/);
 console.log('MANAGED_INVENTORY_CRITIC_INDEX_AMBIGUITY_GREEN');
} else if(['missing-disposition','own-id'].includes(scenario)) {
 for(let retry=0;retry<2;retry++) {
  assert.throws(()=>importer.managed_review_evidence_import({runId:launched.run.runId,receiptId:receipt.receiptId}),scenario==='own-id'?/own findings require proposalFindingIndex/:/DISPOSITION_INCOMPLETE/);
  assert.equal(fixture.store.readFindings(storyId).findings.length,1);
  assert.equal(fixture.store.readReviewInventoryEpochs(storyId).criticReceipts.length,0);
  assert.equal(fixture.store.readProcessEvents(storyId).filter(event=>event.command==='managed_review_evidence_import'&&event.managedReceiptId===receipt.receiptId).length,1,'Deterministic critic refusal preserves exactly one terminal event');
 }
 console.log('MANAGED_INVENTORY_CRITIC_TERMINAL_BOOKKEEPING_GREEN '+scenario);
} else if(scenario==='wrong-wave'||scenario==='drift'||scenario==='committed-drift') {
 assert.throws(()=>importer.managed_review_evidence_import({runId:launched.run.runId,receiptId:receipt.receiptId}),scenario==='wrong-wave'?/purpose or wave/:/moved|changed|drift|stale|live/);
 assert.equal(fixture.store.readFindings(storyId).findings.length,0);
 assert.equal(fixture.store.readReviewInventoryEpochs(storyId).criticReceipts.length,0);
 console.log('MANAGED_INVENTORY_CRITIC_REFUSAL_GREEN '+scenario);
} else {
if(scenario==='crash') {
 const crashing=createManagedReviewEvidenceHandlers(ctx,{afterManagedHostRunEvidenceBindingWrite:()=>{throw new Error('FIXTURE_CRASH_AFTER_TERMINAL');}});
 assert.throws(()=>crashing.managed_review_evidence_import({runId:launched.run.runId,receiptId:receipt.receiptId}),/FIXTURE_CRASH_AFTER_TERMINAL/);
 assert.equal(fixture.store.readFindings(storyId).findings.length,1);
 assert.equal(fixture.store.readReviewInventoryEpochs(storyId).criticReceipts.length,0);
 const subjectPath=join(worktree,'packages/main/src/subject.ts');
 const originalSubject=readFileSync(subjectPath);
 writeFileSync(subjectPath,'export const subject = 101;\n');
 assert.throws(()=>importer.managed_review_evidence_import({runId:launched.run.runId,receiptId:receipt.receiptId}),/material drift/);
 assert.equal(fixture.store.readFindings(storyId).findings.length,1,'Drift retry preserves existing terminal evidence');
 assert.equal(fixture.store.readReviewInventoryEpochs(storyId).criticReceipts.length,0,'Drift retry cannot publish critic receipt');
 writeFileSync(subjectPath,originalSubject);
}
if(scenario==='pass') {
 assert.match(git(worktree,['status','--porcelain','--untracked-files=all']),/review-inventory-epochs.json/,'Positive import retains legitimate pending inventory metadata');
 const childProcess=(await import('node:child_process')).default;
 const {syncBuiltinESMExports}=await import('node:module');
 const originalExec=childProcess.execFileSync;
 childProcess.execFileSync=(command,args,...rest)=>{if(command==='git'&&args[0]==='status')throw new Error('FIXTURE_GIT_STATUS_UNAVAILABLE');return originalExec(command,args,...rest);};
 syncBuiltinESMExports();
 try {assert.throws(()=>importer.managed_review_evidence_import({runId:launched.run.runId,receiptId:receipt.receiptId}),/material status-unavailable: FIXTURE_GIT_STATUS_UNAVAILABLE/);}
 finally {childProcess.execFileSync=originalExec;syncBuiltinESMExports();}
 assert.equal(fixture.store.readReviewInventoryEpochs(storyId).criticReceipts.length,0);
}
const result=importer.managed_review_evidence_import({runId:launched.run.runId,receiptId:receipt.receiptId});
assert.match(result,/Completeness critic: complete/);
const records=fixture.store.readReviewInventoryEpochs(storyId);
assert.equal(records.criticReceipts.length,1);
const finding=fixture.store.readFindings(storyId).findings.find(row=>row.reviewRunId===reviewRunId);
if(scenario==='pass') assert.equal(records.criticReceipts[0].findingDispositions.length,0);
else {assert(finding);assert(records.criticReceipts[0].findingDispositions.some(row=>row.findingId===finding.id));}
if(scenario==='existing-id') {
 const {verifyManagedReviewEvidence}=await import('../packages/main/dist/core/managed-review-evidence.js');
 const {managedHostRunDirectory}=await import('../packages/main/dist/core/managed-host-run.js');
 const binding=finding.managedEvidenceBinding;
 const verify=()=>verifyManagedReviewEvidence({root:worktree,storyId,agent:lane,lane,reviewRunId,binding,expected:binding});
 assert.equal(verify().valid,true);
 const proposalPath=join(managedHostRunDirectory(worktree,launched.run.runId),'evidence-proposal.json');
 const original=readFileSync(proposalPath);
 const altered=JSON.parse(original.toString());altered.inventoryCritic.wave=0;
 try {writeFileSync(proposalPath,JSON.stringify(altered));assert.equal(verify().valid,false);}
 finally {writeFileSync(proposalPath,original);}
 assert.equal(verify().valid,true,'Byte-exact restore recovers original admissibility; no resealing forged evidence');
}
const bytes=JSON.stringify(records.criticReceipts[0]);
assert.match(importer.managed_review_evidence_import({runId:launched.run.runId,receiptId:receipt.receiptId}),/already imported/);
assert.equal(JSON.stringify(fixture.store.readReviewInventoryEpochs(storyId).criticReceipts[0]),bytes,'Retry preserves exact authenticated critic receipt');
assert.equal(fixture.store.readFindings(storyId).findings.length,baselineFindings.length+(scenario==='pass'?0:proposalFindings.length));
if(scenario==='duplicate') {
 const own=fixture.store.readFindings(storyId).findings;
 const canonical=own.find(f=>f.managedEvidenceBinding?.proposalFindingIndex===0);
 const duplicate=own.find(f=>f.managedEvidenceBinding?.proposalFindingIndex===1);
 assert.equal(records.criticReceipts[0].findingDispositions.find(row=>row.findingId===duplicate.id).canonicalFindingId,canonical.id);
}
if(scenario==='existing-id') assert(records.criticReceipts[0].findingDispositions.some(row=>row.findingId===baselineFindings[0].id));
if(scenario==='not-verified') assert.equal(records.criticReceipts[0].findingDispositions[0].disposition,'not_verified');
if(scenario==='findings') {
 cli(worktree,'review_inventory_wave_advance',{storyId});
 const before=JSON.stringify({findings:fixture.store.readFindings(storyId),events:fixture.store.readProcessEvents(storyId),inventory:fixture.store.readReviewInventoryEpochs(storyId)});
 assert.throws(()=>importer.managed_review_evidence_import({runId:launched.run.runId,receiptId:receipt.receiptId}),/same current OPEN epoch/);
 assert.equal(JSON.stringify({findings:fixture.store.readFindings(storyId),events:fixture.store.readProcessEvents(storyId),inventory:fixture.store.readReviewInventoryEpochs(storyId)}),before,'Old-wave replay cannot change historical evidence');
 assert.deepEqual(managedHostRunReceipt(worktree,launched.run.runId),receipt);
}
console.log('MANAGED_INVENTORY_CRITIC_AUTHENTICATED_IMPORT_GREEN '+scenario);
}
}
} finally {process.chdir(oldCwd);rmSync(primary,{recursive:true,force:true});}
