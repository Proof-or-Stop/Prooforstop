import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,realpathSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';
const repo=resolve(process.argv[2]||process.cwd());
const {StoryStore}=await import(join(repo,'packages/main/dist/core/store.js'));
const {resetConfigCache}=await import(join(repo,'packages/main/dist/core/config.js'));
const root=realpathSync(mkdtempSync(join(tmpdir(),'u06-public-glob-'))),storyId='B-1734-fixture',createdAt='2026-08-01T00:00:00Z';
try{
 mkdirSync(join(root,'packages/main/tests/red'),{recursive:true});writeFileSync(join(root,'packages/main/tests/red/fixture.mjs'),'export {};');
 const cfg={scanRoot:'packages/main',rootDir:'src',storyDir:'.proof-or-stop/story/actives',storyScopeBudget:{schemaVersion:'story-scope-budget.v1',mode:'enforce',limits:{responsibilityDomains:1,hostAdapters:1,processFacts:1,publicCommands:1,acceptanceTopology:1,devScopeDelta:1,validationGroups:1},responsibilities:[{id:'test-fixture',paths:['packages/main/tests/red/**'],hostAdapters:[],validationGroups:[]}]}};
 const save=()=>{writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify(cfg));resetConfigCache();};save();
 const store=new StoryStore(root);store.writeStory(storyId,{storyId,createdAt,phase:'DEV'});store.writeChecklist(storyId,{items:[]});store.writeScopeContract(storyId,{storyId,allowedModify:[],allowedCreate:[],allowedTest:['packages/main/tests/red/**']});
 const inspect=()=>JSON.parse(execFileSync(process.execPath,[...process.execArgv,join(repo,'packages/main/dist/cli.js'),'scope_budget_check','--storyId='+storyId,'--json'],{cwd:root,encoding:'utf8',timeout:30000,env:process.env}));
 const before=inspect();assert.equal(before.readOnly,true);assert.equal(before.authority,'diagnostic_only');const snapshot=before.legacySnapshot;assert.ok(snapshot?.subjectDigest,'compiled CLI must export actual legacy snapshot');
 const manifest={schemaVersion:'story-scope-budget-legacy.v1',activationSourceCommit:'1'.repeat(40),entries:[{storyId,createdAt,capturedPhase:'DEV',subjectDigest:snapshot.subjectDigest}]};cfg.storyScopeBudget.legacySubjects=manifest;save();
 const after=inspect();const actual={status:after.status,readOnly:after.readOnly,authority:after.authority};console.log('U06_LEGACY_GLOB_CLI_OBSERVED '+JSON.stringify(actual));
 assert.equal(after.status,'legacy_subject_preserved','U06_LEGACY_GLOB_CLI_REQUIRED: exact captured legacy allowedTest recursive membership must migrate');
 assert.equal(after.readOnly,true);assert.equal(after.authority,'diagnostic_only');console.log('U06_LEGACY_GLOB_CLI_PASS');
}finally{rmSync(root,{recursive:true,force:true});resetConfigCache();}
