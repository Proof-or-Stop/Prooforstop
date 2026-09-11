#!/usr/bin/env node
// Real query handler and Git workspace resolver; in-memory StoryStore data only.
// No real or synthetic persisted Story/fixture JSON is written by this test.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
// Build/source binding preparation is not the target RED; setup failures lack its marker.
execFileSync(process.execPath,[join(repo,'scripts/ensure-dist.mjs')],{cwd:repo,stdio:'inherit'});
const {createStoryQueryHandlers}=await import('../dist/handlers/story-query.js');
const {StoryStore}=await import('../dist/core/store.js');
const {IntentAmendmentIntegrityError}=await import('../dist/core/verification-intent-amendment.js');
const root=realpathSync(mkdtempSync(join(tmpdir(),'proof-list-selection-')));
const git=(...args)=>execFileSync('git',args,{cwd:root,stdio:'pipe'}).toString().trim();
const phases=['IDEA','INIT','INIT_CHECK','PLAN','DEV','REVIEW','TEST','DONE','DISCARDED','TEST_CASE','TEST_CASE_REVIEW'];
const activePhases=['INIT','INIT_CHECK','PLAN','DEV','REVIEW','TEST','TEST_CASE','TEST_CASE_REVIEW'];
const make=(storyId,phase)=>({storyId,name:storyId,title:`${storyId} title`,description:'Memory-only query selection witness',phase,type:'chore',priority:'low',createdAt:'2026-09-01T00:00:00.000Z'});
const stories=new Map(phases.map(phase=>[`B-${phase}`,make(`B-${phase}`,phase)]));
for(let i=0;i<300;i++)stories.set(`B-history${i}`,make(`B-history${i}`,'DONE'));
const reads=[];let corruptId=null;const saved=new Map();const failures=[];const controls=[];
const check=(name,fn)=>{try{fn();controls.push({name,pass:true});}catch(e){failures.push({name,message:e.message});controls.push({name,pass:false});}};
try{
 writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({storyDir:'.proof-or-stop/story/actives'}));
 git('init','-b','main');git('config','user.name','Lab Query Test');git('config','user.email','lab-query@example.invalid');git('add','proof-or-stop.config.json');git('commit','-m','test: initialize private query workspace');
 const linked=join(root,'linked');git('worktree','add','-b','story/B-linked',linked);
 stories.set('B-linked',{...make('B-linked','INIT_CHECK'),worktree:{path:linked,branch:'story/B-linked'}});
 const projected=new Map(stories);projected.set('B-linked',{...stories.get('B-linked'),phase:'REVIEW'});
 const projectedByRoot=new Map([[realpathSync(linked),projected]]);
 const access=function(id){const collection=projectedByRoot.get(realpathSync(this.projectRoot))||stories;const row=collection.get(id);assert.ok(row,`unknown fixture id ${id}`);return structuredClone(row);};
 const replacements={
  readStory:access,listStoryIds(){return [...stories.keys()];},
  readChecklist(id){reads.push({method:'readChecklist',id});if(id===corruptId)throw new IntentAmendmentIntegrityError('AMENDMENT_CHECKLIST_UNREADABLE','deliberate selected-record integrity failure');return {items:[{id:'CHK-1',status:'done'},{id:'CHK-2',status:'withdrawn'}]};},
  readBugs(id){reads.push({method:'readBugs',id});return {bugs:[]};},
  readTestEvidence(id){reads.push({method:'readTestEvidence',id});return {result:'PASS'};},
  readProcessMetrics(id){reads.push({method:'readProcessMetrics',id});return null;},
  writeStory(){throw new Error('test forbids Story writes');},writeChecklist(){throw new Error('test forbids checklist writes');},
 };
 for(const [name,fn] of Object.entries(replacements)){saved.set(name,StoryStore.prototype[name]);StoryStore.prototype[name]=fn;}
 const handlers=createStoryQueryHandlers({store:new StoryStore(root),root,scanRoot:root});
 const expected=[...stories.values()].filter(s=>activePhases.includes(s.phase)).map(s=>s.storyId).sort();
 reads.length=0;const active=handlers.story_list({active:true,json:true});const activeReads=structuredClone(reads);
 check('active includes REVIEW and excludes terminal phases',()=>assert.deepEqual(active.map(r=>r.storyId).sort(),expected));
 check('linked worktree phase is selected before filtering',()=>{const row=active.find(r=>r.storyId==='B-linked');assert.equal(row?.phase,'REVIEW');assert.equal(row?.mainPhase,'INIT_CHECK');});
 check('active reads details only for selected Stories',()=>assert.deepEqual([...new Set(activeReads.map(r=>r.id))].sort(),expected));
 check('selected fields retain withdrawn count and evidence',()=>{const r=active.find(r=>r.storyId==='B-DEV');assert.equal(r.checklist,'1/2 +1w');assert.equal(r.tests,'pass');});
 reads.length=0;const review=handlers.story_list({phase:'REVIEW',json:true});const reviewReads=structuredClone(reads);
 check('phase filter uses projected phase',()=>assert.deepEqual(review.map(r=>r.storyId).sort(),['B-REVIEW','B-linked']));
 check('phase filter skips excluded detail hydration',()=>assert.deepEqual([...new Set(reviewReads.map(r=>r.id))].sort(),['B-REVIEW','B-linked']));
 check('conflicting filters remain refused',()=>assert.throws(()=>handlers.story_list({active:true,phase:'DEV'}),/mutually exclusive/));
 const full=handlers.story_list({json:true});const brief=handlers.story_list({brief:true});
 check('unfiltered full dashboard keeps every Story and phase',()=>{assert.equal(full.stories.length,stories.size);assert.equal(full._phases.DONE,301);assert.equal(full._phases.REVIEW,2);});
 check('brief dashboard retains full totals',()=>{assert.deepEqual(brief._phases,full._phases);assert.equal(brief._dashboard,full._dashboard);assert.equal(brief._bugSummary,full._bugSummary);assert.equal(brief._omittedTerminal,303);});
 corruptId='B-REVIEW';
 check('selected amendment integrity failures propagate',()=>assert.throws(()=>handlers.story_list({phase:'REVIEW'}),/AMENDMENT_CHECKLIST_UNREADABLE/));
 corruptId=null;
 const initialStoryCount=stories.size;
 // Audit additions preserve the original 312-row RED/GREEN sample above.
 stories.set('B-meta',make('B-meta','META'));
 check('META remains excluded from active selection',()=>assert.ok(!handlers.story_list({active:true}).some(r=>r.storyId==='B-meta')));
 const residual=join(root,'residual');git('worktree','add','-b','story/B-residual',residual);
 stories.set('B-residual',{...make('B-residual','DONE'),worktree:{path:residual,branch:'story/B-residual'}});
 projectedByRoot.set(realpathSync(residual),new Map([['B-residual',{...stories.get('B-residual'),phase:'DEV'}]]));
 reads.length=0;
 check('terminal root cannot be revived by residual DEV worktree',()=>{
  assert.ok(!handlers.story_list({active:true}).some(r=>r.storyId==='B-residual'));
  assert.ok(!reads.some(r=>r.id==='B-residual'));
 });
 corruptId='B-DONE';
 check('excluded amendment error does not abort filtered query',()=>assert.deepEqual(handlers.story_list({phase:'REVIEW'}).map(r=>r.storyId).sort(),['B-REVIEW','B-linked']));
 check('unfiltered query still reports excluded-record integrity failure',()=>assert.throws(()=>handlers.story_list({json:true}),/AMENDMENT_CHECKLIST_UNREADABLE/));
 corruptId=null;
 const result={scope:'query selection correctness and avoided detail calls; no Story delivery-time claim',stories:initialStoryCount,auditBoundaryAddedStories:stories.size-initialStoryCount,expectedActive:expected.length,observedActive:active.length,activeDetailCalls:activeReads.length,phaseReviewDetailCalls:reviewReads.length,controls,failures};
 console.log(JSON.stringify(result,null,2));
 if(failures.length){console.error('STORY_LIST_SELECTION_REGRESSION: active selection loses REVIEW or hydrates excluded details');process.exitCode=1;}
 else console.log('STORY_LIST_SELECTION_GREEN');
}finally{
 for(const [name,fn] of saved)StoryStore.prototype[name]=fn;
 rmSync(root,{recursive:true,force:true});
}
