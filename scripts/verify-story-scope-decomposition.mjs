import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StoryStore} from '../packages/main/dist/core/store.js';
import {resetConfigCache} from '../packages/main/dist/core/config.js';
import {createStoryScopeBudgetHandlers} from '../packages/main/dist/handlers/story-scope-budget.js';
import {canStartDevGuard} from '../packages/main/dist/core/machine.js';
import {readStoryScopeBudget} from '../packages/main/dist/core/story-scope-budget.js';
import {buildMilestoneLedger,buildSlicePlan,buildParentLedgerRollup} from '../packages/main/dist/core/proofstory.js';
const root=mkdtempSync(join(tmpdir(),'scope-decomposition-')), parent='B-parent', at=new Date().toISOString();
const policy={schemaVersion:'story-scope-budget.v1',mode:'enforce',limits:{responsibilityDomains:1,hostAdapters:100,processFacts:100,publicCommands:100,acceptanceTopology:100,devScopeDelta:100,validationGroups:100},responsibilities:['roadmap','alpha','beta'].map(id=>({id,paths:[`src/${id}/**`],hostAdapters:[],validationGroups:[]}))};
writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'packages/main',rootDir:'src',storyDir:'.proof-or-stop/story/actives',storyScopeBudget:policy}));
const store=new StoryStore(root);
function subject(id,domain){
 store.writeStory(id,{storyId:id,name:id,title:'Decomposition fixture',description:'Isolated scope decomposition',type:'feature',priority:'medium',phase:'PLAN',createdAt:at,startedAt:at,endedAt:null,parallelSafe:'no'});
 store.writeChecklist(id,{items:[{id:'CHK-1',title:'Deliver assigned milestone',context:'Decomposition fixture',status:'pending',startTime:null,endTime:null,verificationIntent:{happy:[{desc:'Assigned outcome is observable',type:'cli_blackbox'}]}}]});
 store.writeScopeContract(id,{storyId:id,mode:'enforce',allowedModify:[`src/${domain}/task.ts`],allowedCreate:[],allowedTest:[],protectedFiles:[],explicitExcludes:[],acknowledgements:[],createdAt:at,updatedAt:at});
 store.writeProofStoryContract(id,{schemaVersion:'proofstory.contract.v1',storyId:id,diagnosticOnly:false,hardeningLevel:'high_assurance',triggerReasons:[],acceptanceBindings:[],diagnosticGaps:[],createdAt:at,updatedAt:at});
}
function row(id,assignedStory){return{id,sourceRequirementId:`REQ-${id}`,claim:`Deliver ${id}`,doneMeans:`Observable ${id}`,requiredEvidence:['cli_blackbox'],checklistRefs:['CHK-1'],verificationIntentRefs:['CHK-1:happy:0'],assignedStory,status:'planned'};}
function roadmap(rows,children,owner=parent){
 const ledger=buildMilestoneLedger({storyId:owner,milestones:rows});store.writeMilestoneLedger(owner,ledger);
 const slices=buildSlicePlan({storyId:owner,ledger,slices:rows.map(r=>({id:`slice-${r.id}`,milestoneIds:[r.id],reason:'One responsibility per child',assignedStory:r.assignedStory}))});store.writeProofStorySlicePlan(owner,slices);
 store.writeProofStoryParentLedgerRollup(owner,buildParentLedgerRollup({storyId:owner,ledger,slicePlan:slices,children}));
}
function child(id,domain,parentRow){
 subject(id,domain);
 const milestone={...parentRow,id:`C-${parentRow.id}`,parentLedgerId:parentRow.id,assignedStory:undefined};
 store.writeMilestoneLedger(id,buildMilestoneLedger({storyId:id,milestones:[milestone]}));
 const ref={refKind:'existing',canonicalSourceRef:'intent:CHK-1:happy:0'};
 const topology={schemaVersion:'proofstory.acceptance_topology.v1',producerRefs:[{id:'P',sourceRef:ref}],consumerRefs:[{id:'C',sourceRef:ref,producerRefs:['P']}],positiveAssertionRefs:[{id:'A',sourceRef:ref,producerRefs:['P'],consumerRefs:['C']}],mutationCaseRefs:[{id:'M',sourceRef:ref,producerRefs:['P'],consumerRefs:['C']}],transcriptAssertionRefs:[],commandRefs:[ref]};
 store.writeProofStoryContract(id,{...store.readProofStoryContract(id),acceptanceBindings:[{id:'AB-1',checklistRefs:['CHK-1'],verificationIntentRefs:['CHK-1:happy:0'],milestoneIds:[milestone.id],verificationTopology:topology}]});
}
const get=()=>readStoryScopeBudget(store,root,parent);
function rejected(label,mutate,restore){mutate();try{assert.equal(get().blocking,true,label);}finally{restore();}}
try {
 subject(parent,'roadmap');
 assert.equal(readStoryScopeBudget(store,root,parent).blocking,false,'within-budget parent positive control');
 roadmap([row('M1','B-alpha'),row('M2','B-beta')],[{storyId:'B-alpha',milestoneIds:['M1'],status:'planned',evidenceRefs:[]},{storyId:'B-beta',milestoneIds:['M2'],status:'planned',evidenceRefs:[]}]);
 const report=readStoryScopeBudget(store,root,parent);
 assert.equal(report.blocking,true,'U06 declared decomposition must reject nonexistent child Stories');
 assert.match(report.diagnostics.join(' '),/nonexistent child/);
 assert.equal(canStartDevGuard({storyId:parent,store,projectRoot:root}),false,'actual DEV guard refuses phantom decomposition');
 child('B-alpha','alpha',row('M1','B-alpha'));child('B-beta','beta',row('M2','B-beta'));
 const ready=get();assert.equal(ready.blocking,false,JSON.stringify(ready));assert.equal(ready.decomposition.status,'ready');assert.equal(ready.decomposition.authority,'planning_only');
 const rollup=structuredClone(store.readProofStoryParentLedgerRollup(parent));
 const refreshRollup=children=>{const ledger=store.readMilestoneLedger(parent),slicePlan=store.readProofStorySlicePlan(parent);store.writeProofStoryParentLedgerRollup(parent,buildParentLedgerRollup({storyId:parent,ledger,slicePlan,children}));};
 for(const [label,children] of [
  ['self child',[{...rollup.children[0],storyId:parent},rollup.children[1]]],
  ['duplicate milestone',[rollup.children[0],{...rollup.children[1],milestoneIds:['M1']}]],
  ['missing milestone',[rollup.children[0],{...rollup.children[1],milestoneIds:[]}]],
  ['wrong assignment',[{...rollup.children[0],milestoneIds:['M2']},{...rollup.children[1],milestoneIds:['M1']}]],
 ]) rejected(label,()=>refreshRollup(children),()=>store.writeProofStoryParentLedgerRollup(parent,rollup));
 const alphaScope=structuredClone(store.readScopeContract('B-alpha'));
 rejected('over-budget child',()=>store.writeScopeContract('B-alpha',{...alphaScope,allowedModify:['src/alpha/task.ts','src/beta/extra.ts']}),()=>store.writeScopeContract('B-alpha',alphaScope));
 rejected('parent child scope overlap',()=>store.writeScopeContract('B-alpha',{...alphaScope,allowedModify:['src/roadmap/task.ts']}),()=>store.writeScopeContract('B-alpha',alphaScope));
 rejected('sibling scope overlap',()=>store.writeScopeContract('B-alpha',{...alphaScope,allowedModify:['src/beta/task.ts']}),()=>store.writeScopeContract('B-alpha',alphaScope));
 const alphaProof=structuredClone(store.readProofStoryContract('B-alpha'));
 rejected('missing acceptance',()=>store.writeProofStoryContract('B-alpha',{...alphaProof,acceptanceBindings:[]}),()=>store.writeProofStoryContract('B-alpha',alphaProof));
 const alphaChecklist=structuredClone(store.readChecklist('B-alpha'));
 rejected('stale child intent',()=>store.writeChecklist('B-alpha',{items:[]}),()=>store.writeChecklist('B-alpha',alphaChecklist));
 const alphaLedger=structuredClone(store.readMilestoneLedger('B-alpha'));
 rejected('weakened child claim',()=>store.writeMilestoneLedger('B-alpha',buildMilestoneLedger({storyId:'B-alpha',milestones:alphaLedger.milestones.map(r=>({...r,doneMeans:'Weaker outcome'}))})),()=>store.writeMilestoneLedger('B-alpha',alphaLedger));
 store.writeScopeContract('B-alpha',{...alphaScope,allowedModify:['src/alpha/other.ts']});
 const changed=get();assert.equal(changed.blocking,false);assert.notEqual(changed.bindingDigest,ready.bindingDigest,'current child scope must change parent binding');store.writeScopeContract('B-alpha',alphaScope);
 const parentScope=store.readScopeContract(parent);
 rejected('ready decomposition cannot waive parent budget',()=>store.writeScopeContract(parent,{...parentScope,allowedModify:['src/roadmap/task.ts','src/alpha/extra.ts']}),()=>store.writeScopeContract(parent,parentScope));
 assert.equal(get().decomposition.status,'ready');
 function nest(owner,prefix,domain){
  const existing=store.readMilestoneLedger(owner).milestones[0];
  const rows=[{...existing,assignedStory:`B-${prefix}-1`},row(`${prefix}-extra`,`B-${prefix}-2`)];
  roadmap(rows,rows.map(r=>({storyId:r.assignedStory,milestoneIds:[r.id],status:'planned',evidenceRefs:[]})),owner);
  const proof=store.readProofStoryContract(owner);
  proof.acceptanceBindings[0].milestoneIds=rows.map(r=>r.id);store.writeProofStoryContract(owner,proof);
  rows.forEach((r,i)=>{child(r.assignedStory,domain,r);const scope=store.readScopeContract(r.assignedStory);store.writeScopeContract(r.assignedStory,{...scope,allowedModify:[`src/${domain}/${prefix}-${i}.ts`]});});
 }
 nest('B-alpha','a','alpha');nest('B-beta','b','beta');
 const nested=get();assert.equal(nested.blocking,false,JSON.stringify(nested));assert.equal(nested.decomposition.status,'ready');
 const leafScope=store.readScopeContract('B-a-1');
 rejected('ancestor descendant overlap',()=>store.writeScopeContract('B-a-1',{...leafScope,allowedModify:['src/roadmap/task.ts']}),()=>store.writeScopeContract('B-a-1',leafScope));
 rejected('cross sibling subtree overlap',()=>store.writeScopeContract('B-a-1',{...leafScope,allowedModify:['src/beta/b-0.ts']}),()=>store.writeScopeContract('B-a-1',leafScope));
 assert.equal(get().blocking,false,'restored nested positive');
 const before=JSON.stringify([store.readStory(parent),store.readChecklist(parent),store.readScopeContract(parent),store.readProofStoryParentLedgerRollup(parent)]);
 const projection=JSON.parse(createStoryScopeBudgetHandlers({store,root}).scope_budget_check({storyId:parent,json:true}));
 assert.equal(projection.decomposition.authority,'planning_only');assert.equal(projection.readOnly,true);
 assert.equal(JSON.stringify([store.readStory(parent),store.readChecklist(parent),store.readScopeContract(parent),store.readProofStoryParentLedgerRollup(parent)]),before);
 // Existing projects without semantic budgets do not acquire a new partial-plan gate.
 store.writeProofStoryParentLedgerRollup(parent,{...rollup,rollupHash:'tampered'});
 assert.equal(get().blocking,true,'tampered existing rollup refuses');
 writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'packages/main',rootDir:'src',storyDir:'.proof-or-stop/story/actives'}));resetConfigCache();
 assert.equal(get().status,'disabled');assert.equal(get().blocking,false);
 console.log('PASS U06 live child coverage, nested scope, independent budgets, acceptance, freshness and legacy compatibility');
} finally {rmSync(root,{recursive:true,force:true});}
