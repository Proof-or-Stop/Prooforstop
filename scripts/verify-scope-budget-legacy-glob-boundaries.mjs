// Exercise compiled legacy migration with real temporary filesystem boundaries.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,unlinkSync,symlinkSync,realpathSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';
const repo=resolve(process.argv[2]||process.cwd());
const {StoryStore}=await import(join(repo,'packages/main/dist/core/store.js'));
const {readScopeBudgetLegacySnapshot,matchesLegacyScopeBudgetSubject,scopeBudgetSubjectProjection,legacyScopePathExpansion}=await import(join(repo,'packages/main/dist/core/story-scope-budget-legacy.js'));
const {readStoryScopeBudget}=await import(join(repo,'packages/main/dist/core/story-scope-budget.js'));
const {canonicalDigest}=await import(join(repo,'packages/main/dist/core/authority-signing.js'));
const {resetConfigCache}=await import(join(repo,'packages/main/dist/core/config.js'));
const root=realpathSync(mkdtempSync(join(tmpdir(),'u06-glob-'))),outer=realpathSync(mkdtempSync(join(tmpdir(),'u06-outside-')));
const storyId='B-1734-test',createdAt='2026-08-01T00:00:00Z';
try{
 mkdirSync(join(root,'packages/main/tests/red'),{recursive:true});writeFileSync(join(root,'packages/main/tests/red/a.mjs'),'initial');
 const cfg={scanRoot:'packages/main',rootDir:'src',storyDir:'.proof-or-stop/story/actives',storyScopeBudget:{schemaVersion:'story-scope-budget.v1',mode:'enforce',limits:{responsibilityDomains:1,hostAdapters:1,processFacts:1,publicCommands:1,acceptanceTopology:1,devScopeDelta:1,validationGroups:1},responsibilities:[{id:'test-fixture',paths:['packages/main/tests/red/**'],hostAdapters:[],validationGroups:[]}]}};
 const save=()=>{writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify(cfg));resetConfigCache();};save();
 const store=new StoryStore(root);store.writeStory(storyId,{storyId,createdAt,phase:'DEV'});
 store.writeScopeContract(storyId,{storyId,allowedModify:[],allowedCreate:[],allowedTest:['packages/main/tests/red/**']});store.writeChecklist(storyId,{items:[]});
 const snapshot=readScopeBudgetLegacySnapshot(store,storyId);assert.equal(snapshot.schemaVersion,'story-scope-budget-subject.v2');assert.equal(snapshot.projection.pathSet.status,'valid');const manifest={schemaVersion:'story-scope-budget-legacy.v1',activationSourceCommit:'1'.repeat(40),entries:[{storyId,createdAt,capturedPhase:'DEV',subjectDigest:snapshot.subjectDigest}]};
 cfg.storyScopeBudget.legacySubjects=manifest;save();
 const match=()=>matchesLegacyScopeBudgetSubject(store,root,storyId,manifest);
 assert.equal(match(),true);
 const oldDigest=canonicalDigest({schemaVersion:'story-scope-budget-subject.v1',value:snapshot.projection.value});
 assert.notEqual(oldDigest,snapshot.subjectDigest);manifest.entries[0].subjectDigest=oldDigest;assert.equal(match(),false,'old v1 digest cannot auto-migrate');manifest.entries[0].subjectDigest=snapshot.subjectDigest;
 assert.equal(readStoryScopeBudget(store,root,storyId).status,'legacy_subject_preserved');
 writeFileSync(join(root,'packages/main/tests/red/a.mjs'),'changed bytes');assert.equal(match(),true,'content changes do not alter historical scope membership');
 writeFileSync(join(root,'packages/main/tests/red/new.mjs'),'new');assert.equal(match(),false,'new matched file invalidates exact capture');unlinkSync(join(root,'packages/main/tests/red/new.mjs'));assert.equal(match(),true);
 unlinkSync(join(root,'packages/main/tests/red/a.mjs'));assert.equal(match(),false,'removed matched file invalidates capture');writeFileSync(join(root,'packages/main/tests/red/a.mjs'),'restored');assert.equal(match(),true);
 mkdirSync(join(root,'elsewhere'));writeFileSync(join(root,'elsewhere/unrelated.txt'),'unrelated');assert.equal(match(),true,'unrelated subtree is not traversed or bound');
 for(const target of [join(root,'elsewhere'),outer]){symlinkSync(target,join(root,'packages/main/tests/red/alias'));assert.equal(match(),false,'all symlinks in bounded subtree rejected');unlinkSync(join(root,'packages/main/tests/red/alias'));}
 const subject={storyId,scope:store.readScopeContract(storyId),checklist:store.readChecklist(storyId),proofStory:store.readProofStoryContract(storyId)};
 const modified={...subject,scope:{...subject.scope,allowedTest:['packages/main/tests/red/**','elsewhere/unrelated.txt']}};
 assert.equal(matchesLegacyScopeBudgetSubject(store,root,storyId,manifest,modified,subject),false,'proposed subject cannot borrow current/base exception');
 assert.equal(matchesLegacyScopeBudgetSubject(store,root,storyId,manifest,subject,modified),false,'changed base cannot borrow current exception');
 for(const glob of ['**','../red/**','/tmp/red/**','packages/**/red','packages/main/tests/red/*','packages/main/tests/red/[a]','packages/main/tests/red/{a,b}','packages//red/**','packages/./red/**'])assert.throws(()=>legacyScopePathExpansion({...subject,scope:{...subject.scope,allowedTest:[glob]}},root));
 const alias=root+'-alias';symlinkSync(root,alias);try{
  const aliasStore=new StoryStore(alias);
  assert.deepEqual(scopeBudgetSubjectProjection(subject,createdAt,alias),scopeBudgetSubjectProjection(subject,createdAt,root),'lexical root aliases produce identical physical membership');
  assert.equal(readScopeBudgetLegacySnapshot(aliasStore,storyId).subjectDigest,snapshot.subjectDigest);
  assert.equal(matchesLegacyScopeBudgetSubject(aliasStore,alias,storyId,manifest),true,'legitimate root alias retains migration result');
  assert.equal(matchesLegacyScopeBudgetSubject(store,alias,storyId,manifest),true,'canonical Store and lexical caller root share identity');
  const originalRead=fs.readdirSync;let switched=false;
  try{
   fs.readdirSync=function(path,...args){const names=originalRead.call(this,path,...args);if(!switched){switched=true;unlinkSync(alias);symlinkSync(outer,alias);}return names;};syncBuiltinESMExports();
   assert.throws(()=>legacyScopePathExpansion(subject,alias),/input root changed/,'input alias retarget during expansion is refused');
   assert.equal(switched,true);
  }finally{fs.readdirSync=originalRead;syncBuiltinESMExports();unlinkSync(alias);symlinkSync(root,alias);}
  assert.equal(matchesLegacyScopeBudgetSubject(aliasStore,alias,storyId,manifest),true);
  let replaced=false;const backup=root+'-original';
  try{
   fs.readdirSync=function(path,...args){const names=originalRead.call(this,path,...args);if(!replaced){replaced=true;fs.renameSync(root,backup);fs.cpSync(backup,root,{recursive:true});}return names;};syncBuiltinESMExports();
   assert.throws(()=>legacyScopePathExpansion(subject,root),/changed during expansion/,'same physical path with replaced root inode is refused');
   assert.equal(replaced,true);
  }finally{fs.readdirSync=originalRead;syncBuiltinESMExports();if(replaced){rmSync(root,{recursive:true,force:true});fs.renameSync(backup,root);}}
  assert.equal(matchesLegacyScopeBudgetSubject(aliasStore,alias,storyId,manifest),true);
 }finally{unlinkSync(alias);}
 const unsafe={...subject,scope:{...subject.scope,allowedTest:['../unsafe/**']}};
 const invalid=scopeBudgetSubjectProjection(unsafe,createdAt,root);assert.equal(invalid.pathSet.status,'invalid');
 assert.equal(matchesLegacyScopeBudgetSubject(store,root,storyId,manifest,unsafe,subject),false);
 const prefix=join(root,'packages/main/tests/red');rmSync(prefix,{recursive:true});symlinkSync(outer,prefix);assert.equal(match(),false,'symlink literal prefix refused');
 console.log('PASS bounded historical glob membership, exact proposed/base bindings, content independence and path safety');
}finally{rmSync(root,{recursive:true,force:true});rmSync(outer,{recursive:true,force:true});resetConfigCache();}
