import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const repo=new URL('../',import.meta.url).pathname;
const {StoryStore}=await import(repo+'/packages/main/dist/core/store.js');
const {resetConfigCache}=await import(repo+'/packages/main/dist/core/config.js');
const {readStoryScopeBudget}=await import(repo+'/packages/main/dist/core/story-scope-budget.js');
const {buildValidationCommandInventory}=await import(repo+'/packages/main/dist/core/validation-command-identity.js');
const root=mkdtempSync(join(tmpdir(),'u06-command-identity-')); const storyId='B-u06-identity';
const commands=[{command:'node',args:['alpha.mjs']},{command:'node',args:['beta.mjs']}];
const identities=buildValidationCommandInventory({commands:commands.map(c=>({...c,label:c.command}))});
assert.notEqual(identities.entries[0].id,identities.entries[1].id);
const config={scanRoot:'packages/main',rootDir:'src',storyDir:'.proof-or-stop/story/actives',validate:{commands},storyScopeBudget:{schemaVersion:'story-scope-budget.v1',mode:'enforce',limits:{responsibilityDomains:1,hostAdapters:0,processFacts:0,publicCommands:0,acceptanceTopology:0,devScopeDelta:0,validationGroups:2},responsibilities:[{id:'alpha',paths:['alpha.ts'],hostAdapters:[],validationGroups:['alpha-tests','beta-tests']}],validationGroups:[{id:'alpha-tests',commandLabels:['node']},{id:'beta-tests',commandLabels:['node']}]}};
const save=()=>{writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify(config));resetConfigCache();};
try{
 save();const store=new StoryStore(root);
 store.writeChecklist(storyId,{items:[]});store.writeScopeContract(storyId,{storyId,mode:'enforce',allowedModify:['alpha.ts'],allowedCreate:[],allowedTest:[],protectedFiles:[],explicitExcludes:[],acknowledgements:[]});
 store.writeProofStoryContract(storyId,{schemaVersion:'proofstory.contract.v1',storyId,diagnosticOnly:true,hardeningLevel:'standard',triggerReasons:[],acceptanceBindings:[],diagnosticGaps:[]});
 const report=()=>readStoryScopeBudget(store,root,storyId);
 const ambiguous=report();console.log('ambiguous',JSON.stringify({status:ambiguous.status,blocking:ambiguous.blocking,groups:ambiguous.facts.validationGroups,diagnostics:ambiguous.diagnostics}));
 config.validate.commands=[commands[0]];save();const removed=report();console.log('beta-command-removed',JSON.stringify({status:removed.status,groups:removed.facts.validationGroups}));
 config.validate.commands=commands.map((c,i)=>({...c,label:['alpha','beta'][i]})); config.storyScopeBudget.validationGroups.forEach((g,i)=>g.commandLabels=[['alpha','beta'][i]]);save();assert.equal(report().status,'within_budget');
 config.validate.commands.pop();save();assert.equal(report().status,'unknown');console.log('PASS unique-label missing-command control');
 console.log('canonical ids',identities.entries.map(e=>e.id));
 assert.equal(ambiguous.status,'unknown','U06 ambiguous executable-only group references must fail closed');
}finally{rmSync(root,{recursive:true,force:true});resetConfigCache();}
