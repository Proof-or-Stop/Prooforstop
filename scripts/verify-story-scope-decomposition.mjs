import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StoryStore} from '../packages/main/dist/core/store.js';
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
function roadmap(rows,children){
 const ledger=buildMilestoneLedger({storyId:parent,milestones:rows});store.writeMilestoneLedger(parent,ledger);
 const slices=buildSlicePlan({storyId:parent,ledger,slices:rows.map(r=>({id:`slice-${r.id}`,milestoneIds:[r.id],reason:'One responsibility per child',assignedStory:r.assignedStory}))});store.writeProofStorySlicePlan(parent,slices);
 store.writeProofStoryParentLedgerRollup(parent,buildParentLedgerRollup({storyId:parent,ledger,slicePlan:slices,children}));
}
try {
 subject(parent,'roadmap');
 assert.equal(readStoryScopeBudget(store,root,parent).blocking,false,'within-budget parent positive control');
 roadmap([row('M1','B-alpha'),row('M2','B-beta')],[{storyId:'B-alpha',milestoneIds:['M1'],status:'planned',evidenceRefs:[]},{storyId:'B-beta',milestoneIds:['M2'],status:'planned',evidenceRefs:[]}]);
 const report=readStoryScopeBudget(store,root,parent);
 assert.equal(report.blocking,true,'U06 declared decomposition must reject nonexistent child Stories');
 console.log('PASS U06 decomposition refuses phantom child coverage');
} finally {rmSync(root,{recursive:true,force:true});}
