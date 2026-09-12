import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import {execFileSync,spawnSync} from 'node:child_process';
const mutation=process.argv.find(x=>x.startsWith('--mutate='))?.slice(9);
const mutations={review:["handlers/story-review.ts","if (ownerFailure) issues.push({type:'plan_owner_coverage_invalid',severity:'blocker',message:ownerFailure});",''],guard:['core/machine.ts','if (planOwnerCoverageFailure(context.store, context.projectRoot, context.storyId)) return false;',''],save:['handlers/scope-check.ts',"const ownerCoverage = signPlanOwnerCoverage(store, root, args.storyId, args.ownerDispositions, authority.source === 'dispatched-env' ? authority.entry?.canonicalName : undefined);",'const ownerCoverage = undefined;']};
function sourceFor(url){let source=process.argv.includes('--baseline') ? execFileSync('git',['show','ed03c8cd62:'+fileURLToPath(url).slice(fileURLToPath(new URL('../',import.meta.url)).length)],{encoding:'utf8',stdio:['ignore','pipe','pipe']}) : readFileSync(fileURLToPath(url),'utf8');const m=mutations[mutation];if(m&&url.endsWith(m[0])){assert.equal(source.split(m[1]).length,2,'unique actual production mutation');source=source.replace(m[1],m[2]);}return source;}
registerHooks({resolve(s,c,n){if(c.parentURL?.endsWith('.ts')&&s.startsWith('.')&&s.endsWith('.js')){const u=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(existsSync(u))return n(u.href,c);}return n(s,c);},load(u,c,n){if(u.endsWith('.ts'))return {format:'module',shortCircuit:true,source:ts.transpileModule(sourceFor(u),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText};return n(u,c);}});
const {resetConfigCache}=await import('../packages/main/src/core/config.ts');
const {StoryStore}=await import('../packages/main/src/core/store.ts');
const {createScopeCheckHandlers}=await import('../packages/main/src/handlers/scope-check.ts');
const {createStoryReviewHandlers}=await import('../packages/main/src/handlers/story-review.ts');
// Disposable setup adapted from story-review-ergonomics-smoke; product modules load unchanged above.
function write(root, path, content) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
}
function initStore(options = {}) {
    const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-story-review-ergonomics-'));
    write(root, 'proof-or-stop.config.json', JSON.stringify({
        scanRoot: 'packages/main',
        rootDir: 'src',
        storyDir: '.proof-or-stop/story/actives',
        requirementsDir: 'docs/requirements',
        workflow: { profile: 'balanced' },
    }, null, 2));
    resetConfigCache();
    const store = new StoryStore(root);
    const storyId = 'B-review';
    const now = '2026-05-08T10:00:00.000Z';
    const story = {
        storyId,
        name: 'story-review-ergonomics',
        title: 'Story review ergonomics',
        description: 'Synthetic story for story_review ergonomics.',
        type: 'chore',
        phase: 'PLAN',
        priority: 'medium',
        createdAt: now,
        startedAt: now,
        endedAt: null,
        events: [{ phase: 'PLAN', action: 'advance', timestamp: now }],
    };
    const checklist = {
        items: [{
                id: 'CHK-001',
                title: 'Normalize touchpoint coverage',
                context: 'Touchpoint strings can include human explanation.',
                userSees: '`story_review` accepts described touchpoints.',
                files: {
                    modify: ['packages/main/src/foo.ts'],
                    create: [],
                    test: ['packages/main/src/tasks/story-review-ergonomics-smoke.ts'],
                },
                status: 'pending',
                startTime: null,
                endTime: null,
            }],
    };
    store.writeStory(storyId, story);
    store.writeChecklist(storyId, checklist);
    store.writeUnderstanding(storyId, {
        task: 'Normalize story review touchpoints',
        outcome: 'Touchpoints with descriptions match checklist files',
        facts: ['Touchpoint strings may contain explanatory parentheses.'],
        constraints: [],
        unknowns: [],
        touchpoints: ['packages/main/src/foo.ts (pass result.summary to report)'],
        timestamp: now,
    });
    if (options.saveScopeCheck !== false) {
        createScopeCheckHandlers({ store, root, scanRoot: join(root, 'packages/main') }).scope_check_save({
            storyId,
            features: [{
                    feature: 'Codex adapter verification',
                    covered_by: null,
                    status: 'excluded',
                    excluded_by: 'No adapter files touched',
                    source: 'scope-smoke',
                }],
            summary: { total: 1, covered: 0, excluded: 1, gaps: 0 },
            readManifest: { filesReadFully: [], filesTriagedByName: [], scanEscalationReason: null },
            openQuestions: [],
        });
    }
    return { root, store, storyId };
}
const f=initStore();
f.root=realpathSync(f.root);
try {
 const review=()=>createStoryReviewHandlers({store:f.store,root:f.root,scanRoot:join(f.root,'packages/main')}).story_review({storyId:f.storyId});
 assert.equal(review().summary.blockerCount,0); console.log('PLAN_OWNER legacy passing setup PASS');
 const u=f.store.readUnderstanding(f.storyId);u.touchpoints.push('packages/main/src/core/process-fact-registry.ts');f.store.writeUnderstanding(f.storyId,u);
 assert.ok(review().issues.some(x=>x.type==='touchpoint_uncovered'));console.log('PLAN_OWNER declared uncovered control PASS');
 u.touchpoints.pop();f.store.writeUnderstanding(f.storyId,u);
 f.store.writeProofStoryContract(f.storyId,{schemaVersion:'proofstory.contract.v1',storyId:f.storyId,acceptanceBindings:[{id:'AB-owner',checklistRefs:['CHK-001'],verificationIntentRefs:[],milestoneIds:[],verificationTopology:{schemaVersion:'proofstory.acceptance_topology.v1',positiveAssertionRefs:[],mutationCaseRefs:[],transcriptAssertionRefs:[],commandRefs:[],producerRefs:[{id:'P',sourceRef:{refKind:'existing',canonicalSourceRef:'process-fact:runtime:dynamic_finding_applicability_gate'}}],consumerRefs:[{id:'C',producerRefs:['P'],sourceRef:{refKind:'existing',canonicalSourceRef:'process-fact:runtime:dynamic_finding_applicability_gate'}}]}}]});
 const result=review();
 assert.ok(result.issues.some(x=>x.type==='plan_owner_coverage_invalid'&&x.severity==='blocker'),'PLAN_OWNER_SIMULTANEOUS_OMISSION: actual story_review must block selected owner omitted from both declarations');
 console.log('PLAN_OWNER simultaneous omission PASS');
 const git=(...args)=>execFileSync('git',args,{cwd:f.root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git('init','-b','main');git('config','user.name','Lab Fixture');git('config','user.email','fixture@example.invalid');
 const {projectProcessFactRegistry}=await import('../packages/main/src/core/process-fact-registry.ts');
 const paths=projectProcessFactRegistry().find(x=>x.factId==='runtime:dynamic_finding_applicability_gate').paths;
 assert.ok(paths.includes('packages/main/src/handlers/transition-orchestrator.ts'));
 assert.ok(paths.includes('packages/main/src/handlers/finding-material-reattestation.ts'));
 const {PLAN_OWNER_REGISTRY_INPUTS}=await import('../packages/main/src/core/plan-touchpoint-coverage.ts');
 for(const path of [...new Set([...paths,...PLAN_OWNER_REGISTRY_INPUTS])]){mkdirSync(dirname(join(f.root,path)),{recursive:true});writeFileSync(join(f.root,path),readFileSync(new URL('../'+path,import.meta.url)));}
 git('add','.');git('commit','-m','fixture baseline');
 const {planOwnerCoverageFailure}=await import('../packages/main/src/core/plan-touchpoint-coverage.ts');
 const {canStartDevGuard}=await import('../packages/main/src/core/machine.ts');
 const scope=createScopeCheckHandlers({store:f.store,root:f.root,scanRoot:join(f.root,'packages/main')});
 const saved=f.store.readScopeCheck(f.storyId);
 const input={storyId:f.storyId,features:saved.features,summary:saved.summary,readManifest:saved.readManifest,openQuestions:[]};
 assert.throws(()=>scope.scope_check_save(input),/registered scope reviewer/);console.log('PLAN_OWNER host cannot issue owner disposition PASS');
 const oldAgent=process.env.PROOF_OR_STOP_AGENT;
 process.env.PROOF_OR_STOP_AGENT='proof-or-stop-review-scope-plan';
 try {
   assert.throws(()=>scope.scope_check_save(input),/every selected owner/);
   const ownerDispositions=paths.map(path=>({path,disposition:'unchanged',reason:'Read the complete implementation; this selected owner preserves its current behavior and needs no modification for this bounded fixture.'}));
   scope.scope_check_save({...input,ownerDispositions});
   assert.equal(planOwnerCoverageFailure(f.store,f.root,f.storyId),null);
   assert.equal(review().issues.some(x=>x.type==='plan_owner_coverage_invalid'),false);
   console.log('PLAN_OWNER native signed unchanged control PASS');
   const valid=structuredClone(f.store.readScopeCheck(f.storyId));
   const validReview=structuredClone(f.store.readReview(f.storyId));
   const guardContext={store:f.store,projectRoot:f.root,storyId:f.storyId};
   f.store.writeDevMemoryPreflightAck(f.storyId,{schemaVersion:'proof-or-stop.dev_memory_preflight_ack.v1',storyId:f.storyId,topHitIds:[],acknowledgedAt:new Date().toISOString(),acknowledgedBy:'fixture operator'});
   assert.equal(canStartDevGuard(guardContext),true,'valid native guard setup');
   for(const [name,change] of [
     ['signature',r=>r.ownerCoverage.signature+='x'],
     ['story',r=>r.ownerCoverage.storyId='B-other'],
     ['reason',r=>r.ownerCoverage.dispositions[0].reason='forged'],
     ['missing',r=>delete r.ownerCoverage],
     ['role',r=>r.ownerCoverage.actor='main']]) {
      const altered=structuredClone(valid);change(altered);f.store.writeScopeCheck(f.storyId,altered);
      f.store.writeReview(f.storyId,validReview);
      assert.equal(canStartDevGuard(guardContext),false,name+' direct guard');
      assert.ok(review().issues.some(x=>x.type==='plan_owner_coverage_invalid'),name+' review');
      f.store.writeScopeCheck(f.storyId,valid);
   }
   assert.throws(()=>scope.scope_check_save({...input,ownerDispositions:[...ownerDispositions,ownerDispositions[0]]}),/every selected owner/);
   assert.throws(()=>scope.scope_check_save({...input,ownerDispositions:ownerDispositions.map((r,i)=>i? r:{...r,disposition:'modify'})}),/absent/);
   const source=readFileSync(join(f.root,paths[0]));writeFileSync(join(f.root,paths[0]),'// changed owner\n'+source);
   assert.ok(planOwnerCoverageFailure(f.store,f.root,f.storyId));writeFileSync(join(f.root,paths[0]),source);
   assert.equal(planOwnerCoverageFailure(f.store,f.root,f.storyId),null);
   console.log('PLAN_OWNER identity, signature, declaration and source mutations PASS');
   const contract=structuredClone(f.store.readProofStoryContract(f.storyId));
   for(const badRef of [{refKind:'planned'},{refKind:'existing',canonicalSourceRef:'unknown:missing'},{refKind:'existing',canonicalSourceRef:'process-fact:missing'}]) {
     const bad=structuredClone(contract);bad.acceptanceBindings[0].verificationTopology.producerRefs[0].sourceRef=badRef;
     const noCoverage=structuredClone(valid);delete noCoverage.ownerCoverage;f.store.writeScopeCheck(f.storyId,noCoverage);f.store.writeProofStoryContract(f.storyId,bad);
     assert.ok(planOwnerCoverageFailure(f.store,f.root,f.storyId),'malformed selection cannot fall back without prior coverage');
     f.store.writeProofStoryContract(f.storyId,contract);f.store.writeScopeCheck(f.storyId,valid);
   }

   for (const changed of [{...contract,acceptanceBindings:[{...contract.acceptanceBindings[0],claim:'changed acceptance meaning'}]}, {...contract,acceptanceBindings:null},{...contract,acceptanceBindings:[]}]) {
     f.store.writeProofStoryContract(f.storyId,changed);assert.ok(planOwnerCoverageFailure(f.store,f.root,f.storyId));f.store.writeProofStoryContract(f.storyId,contract);
   }
   writeFileSync(join(f.root,'unrelated.txt'),'unrelated main change');git('add','unrelated.txt');git('commit','-m','unrelated main change');
   assert.equal(planOwnerCoverageFailure(f.store,f.root,f.storyId),null,'unrelated main preserves relevant binding');
   writeFileSync(join(f.root,paths[0]),'// main owner drift\n'+source);git('add',paths[0]);git('commit','-m','relevant main owner change');writeFileSync(join(f.root,paths[0]),source);
   assert.ok(planOwnerCoverageFailure(f.store,f.root,f.storyId),'relevant main drift invalidates even restored working source');
   scope.scope_check_save({...input,ownerDispositions});
   assert.equal(planOwnerCoverageFailure(f.store,f.root,f.storyId),null);
   const registryPath=PLAN_OWNER_REGISTRY_INPUTS[0];const registryBytes=readFileSync(join(f.root,registryPath));
   writeFileSync(join(f.root,registryPath),'// main registry-only drift\n'+registryBytes);git('add',registryPath);git('commit','-m','registry-only main change');writeFileSync(join(f.root,registryPath),registryBytes);
   assert.ok(planOwnerCoverageFailure(f.store,f.root,f.storyId),'main registry drift independent of owner source changes');
   const cl=f.store.readChecklist(f.storyId);cl.items[0].files.modify.push(paths[0]);cl.items[0].files.test.push(paths[1]);f.store.writeChecklist(f.storyId,cl);
   scope.scope_check_save({...input,ownerDispositions:ownerDispositions.map((r,i)=>({...r,disposition:i===0?'modify':i===1?'test':'unchanged'}))});
   assert.equal(planOwnerCoverageFailure(f.store,f.root,f.storyId),null,'native declared modify and test dispositions');
   console.log('PLAN_OWNER topology, semantics, relevant/unrelated main and native modify/test PASS');
   if(!mutation) {
     const {createStoryAdvanceHandlers}=await import('../packages/main/src/handlers/story-advance.ts');
     const advance=createStoryAdvanceHandlers({store:f.store,root:f.root,scanRoot:join(f.root,'packages/main')});
     review();
     const currentRecord=structuredClone(f.store.readScopeCheck(f.storyId));
     const invalidRecord=structuredClone(currentRecord);invalidRecord.ownerCoverage.signature+='x';f.store.writeScopeCheck(f.storyId,invalidRecord);
     process.env.PROOF_OR_STOP_AGENT='main';
     await assert.rejects(()=>advance.story_advance({storyId:f.storyId,phase:'DEV'}),/plan_owner_coverage_invalid/);
     assert.equal(f.store.readStory(f.storyId).phase,'PLAN','rejected transition cannot persist DEV');
     f.store.writeScopeCheck(f.storyId,currentRecord);review();
     await advance.story_advance({storyId:f.storyId,phase:'DEV'});
     assert.equal(f.store.readStory(f.storyId).phase,'DEV','native transition persists DEV after current signed coverage');
     console.log('PLAN_OWNER native PLAN to DEV reject/no-write and successful persisted transition PASS');
   }


 } finally {if(oldAgent===undefined)delete process.env.PROOF_OR_STOP_AGENT;else process.env.PROOF_OR_STOP_AGENT=oldAgent;}

} finally {rmSync(f.root,{recursive:true,force:true});}

if(!mutation) for(const [name,marker] of [['review','PLAN_OWNER_SIMULTANEOUS_OMISSION'],['guard','signature direct guard'],['save','Missing expected exception']]) {
 const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--mutate='+name],{encoding:'utf8'});
 assert.equal(child.status,1,'mutated '+name+' must fail unchanged test');
 assert.ok((child.stdout+child.stderr).includes(marker),child.stdout+child.stderr);
 console.log('PLAN_OWNER actual '+name+' consumer mutation detected PASS');
}
