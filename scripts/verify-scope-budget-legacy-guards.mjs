// Exercise exact legacy migration through real DEV guards and the read-only handler.
// Fixture extraction reuses the existing restricted synthetic Story producer.
import {readFileSync,writeFileSync,mkdtempSync,rmSync}from'node:fs';
import{stripTypeScriptTypes}from'node:module';import{pathToFileURL}from'node:url';import{resolve,join}from'node:path';import{tmpdir}from'node:os';
const repo=resolve(process.argv[2]||process.cwd()),scratch=mkdtempSync(join(tmpdir(),'u06-legacy-guards-'));
const original=readFileSync(join(repo,'packages/main/src/tasks/parallel-decomposition-gate-integration-smoke.ts'),'utf8');
if(!original.includes('// ── 1. literal'))throw Error('fixture extraction anchor changed');
const prefix=stripTypeScriptTypes(original.split('// ── 1. literal')[0],{mode:'strip'}).replaceAll("'../core/", "'"+join(repo,'packages/main/dist/core/'));
const scenario=`
const {createStoryScopeBudgetHandlers}=await import(${JSON.stringify(pathToFileURL(join(repo,'packages/main/dist/handlers/story-scope-budget.js')).href)});
const {readStoryScopeBudget}=await import(${JSON.stringify(pathToFileURL(join(repo,'packages/main/dist/core/story-scope-budget.js')).href)});
const {createChecklistHandlers}=await import(${JSON.stringify(pathToFileURL(join(repo,'packages/main/dist/handlers/checklist.js')).href)});
const fixture=buildRepo({profile:'light',selfPhase:'DEV',selfParallelSafe:'no',peerParallelSafe:'no',selfModify:['src/a.ts','src/b.ts'],selfCreate:[],peerModify:[],peerCreate:[],review:cleanReview(SELF_ID)});
const cwd=process.cwd();
try{
 const{root,store,context}=fixture;process.chdir(root);write(root,'src/a.ts','export{}');write(root,'src/b.ts','export{}');
 const cfgPath=join(root,'proof-or-stop.config.json'),cfg=JSON.parse((await import('node:fs')).readFileSync(cfgPath,'utf8'));
 const readScopeBudgetLegacySnapshot=(targetStore,storyId)=>JSON.parse(createStoryScopeBudgetHandlers({store:targetStore,root,scanRoot:join(root,'packages/main')}).scope_budget_check({storyId})).legacySnapshot;
 const snapshot=readScopeBudgetLegacySnapshot(store,SELF_ID);check('read-only legacy snapshot export is required',Boolean(snapshot));check('actual DEV capture eligible',snapshot.eligibleForMigration);
 cfg.storyScopeBudget={schemaVersion:'story-scope-budget.v1',mode:'enforce',limits:{responsibilityDomains:1,hostAdapters:10,processFacts:1000,publicCommands:1000,acceptanceTopology:1000,devScopeDelta:1000,validationGroups:10},responsibilities:[{id:'a',paths:['src/a.ts'],hostAdapters:[],validationGroups:[]},{id:'b',paths:['src/b.ts'],hostAdapters:[],validationGroups:[]}],legacySubjects:{schemaVersion:'story-scope-budget-legacy.v1',activationSourceCommit:'1'.repeat(40),entries:[{storyId:SELF_ID,createdAt:snapshot.createdAt,capturedPhase:snapshot.phase,subjectDigest:snapshot.subjectDigest}]}};
 const save=()=>{writeFileSync(cfgPath,JSON.stringify(cfg));resetConfigCache()};save();
 for(const[phase,guard]of[['PLAN',canStartDevGuard],['INIT_CHECK',canSkipPlanGuard],['TEST',canReenterDevGuard]]){
  store.writeStory(SELF_ID,{...store.readStory(SELF_ID),phase});
  check(phase+' exact captured legacy preserves budget',readStoryScopeBudget(store,root,SELF_ID).status==='legacy_subject_preserved');
  check(phase+' actual DEV door passes existing fixture prerequisites',guard(context));
  const entries=cfg.storyScopeBudget.legacySubjects.entries;cfg.storyScopeBudget.legacySubjects.entries=[];save();check(phase+' unlisted same subject blocked',!guard(context));cfg.storyScopeBudget.legacySubjects.entries=entries;save();
 }
 store.writeStory(SELF_ID,{...store.readStory(SELF_ID),phase:'DEV'});
 const handlers=createChecklistHandlers({root,scanRoot:join(root,'packages/main'),store});
 handlers.checklist_update({storyId:SELF_ID,itemId:'CHK-001',status:'in_progress',reason:'Exercise actual progress update without changing requirements.'});
 check('real checklist_update progress preserves digest',readScopeBudgetLegacySnapshot(store,SELF_ID).subjectDigest===snapshot.subjectDigest);
 check('real checklist_update remains migration matched',readStoryScopeBudget(store,root,SELF_ID).status==='legacy_subject_preserved');
 const before=store.readStory(SELF_ID);store.writeStory(SELF_ID,{...before,createdAt:'2026-07-01T00:00:00.000Z'});check('same ID recreated identity blocked',readStoryScopeBudget(store,root,SELF_ID).blocking);store.writeStory(SELF_ID,before);
 const entry=cfg.storyScopeBudget.legacySubjects.entries[0];entry.capturedPhase='PLAN';save();check('pre-DEV capture invalid, not grandfathered',readStoryScopeBudget(store,root,SELF_ID).blocking);entry.capturedPhase=snapshot.phase;save();
 const scope=store.readScopeContract(SELF_ID);store.writeScopeContract(SELF_ID,{...scope,allowedModify:[...scope.allowedModify,'src/new.ts']});check('changed legacy path fails closed',readStoryScopeBudget(store,root,SELF_ID).blocking);store.writeScopeContract(SELF_ID,scope);
 const fsExtra=await import('node:fs');const external=mkdtempSync(join((await import('node:os')).tmpdir(),'u06-outside-'));try{
  fsExtra.writeFileSync(join(external,'owned.ts'),'export{}');fsExtra.symlinkSync(external,join(root,'external-link'));
  for(const unsafe of ['external-link/owned.ts','../outside.ts','src/**']){
   store.writeScopeContract(SELF_ID,{...scope,allowedModify:[unsafe]});
   const unsafeSnapshot=readScopeBudgetLegacySnapshot(store,SELF_ID);entry.subjectDigest=unsafeSnapshot.subjectDigest;save();
   check('exact captured missing-proof subject rejects unsafe path '+unsafe,readStoryScopeBudget(store,root,SELF_ID).blocking);
  }
 }finally{fsExtra.rmSync(external,{recursive:true,force:true});store.writeScopeContract(SELF_ID,scope);entry.subjectDigest=snapshot.subjectDigest;save()}
 const cl=store.readChecklist(SELF_ID);store.writeChecklist(SELF_ID,{...cl,items:cl.items.map(item=>({...item,title:item.title+' changed'}))});check('same ID requirement drift fails closed',readStoryScopeBudget(store,root,SELF_ID).blocking);store.writeChecklist(SELF_ID,cl);
 const subject={storyId:SELF_ID,scope,checklist:cl,proofStory:store.readProofStoryContract(SELF_ID)};
 const next={...subject,scope:{...scope,allowedModify:[...scope.allowedModify,'src/new.ts']}};
 check('amendment next cannot borrow unchanged base exception',readStoryScopeBudget(store,root,SELF_ID,next,subject).blocking);
 check('stale amendment base cannot borrow current exception',readStoryScopeBudget(store,root,SELF_ID,subject,next).blocking);
 cfg.storyScopeBudget.legacySubjects.entries.push({...entry});save();check('duplicate manifest entry fails closed',readStoryScopeBudget(store,root,SELF_ID).blocking);cfg.storyScopeBudget.legacySubjects.entries.pop();save();
 cfg.storyScopeBudget.legacySubjects.extra=true;save();check('unknown manifest field fails closed',readStoryScopeBudget(store,root,SELF_ID).blocking);delete cfg.storyScopeBudget.legacySubjects.extra;save();
 cfg.storyScopeBudget.validationGroups=[{id:'invalid',commandIds:['unknown-command-id']}];save();check('malformed legacy subject cannot hide invalid command policy',readStoryScopeBudget(store,root,SELF_ID).blocking);delete cfg.storyScopeBudget.validationGroups;save();
 for(const phase of ['DONE','DISCARDED','INIT']){store.writeStory(SELF_ID,{...store.readStory(SELF_ID),phase});check(phase+' cannot consume legacy exception',readStoryScopeBudget(store,root,SELF_ID).blocking)}
 store.writeStory(SELF_ID,{...store.readStory(SELF_ID),phase:'REVIEW'});check('migration does not waive real REVIEW inventory requirement',!canReenterDevGuard(context));
 console.log('PASS actual legacy DEV guards and checklist progress');
}finally{process.chdir(cwd);rmSync(fixture.root,{recursive:true,force:true});resetConfigCache()}
`;
try{const path=join(scratch,'generated.mjs');writeFileSync(path,prefix+scenario);await import(pathToFileURL(path).href)}finally{rmSync(scratch,{recursive:true,force:true})}
