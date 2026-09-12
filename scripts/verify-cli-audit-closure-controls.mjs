import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepareVerification } from './verification-subprocess-budget.mjs';
import { writeBuildBinding, writeUtilsBuildBinding } from './full-suite-build-binding.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
prepareVerification(repo);
const root = fs.mkdtempSync(join(tmpdir(), 'audit-closure-'));
const groups = [], measurements = {};
const group = async (id, fn) => {
  try { await fn(); groups.push({id, pass:true}); }
  catch (e) { groups.push({id, pass:false, error:e.message}); }
};
const git = (cwd, ...args) => execFileSync('git', args, {cwd,encoding:'utf8',stdio:'pipe'}).trim();
try {
  await group('queue-selection-and-render-use-one-phase', async () => {
    const { StoryStore } = await import(join(repo,'packages/main/dist/core/store.js'));
    const { projectQueueGovernance } = await import(join(repo,'packages/main/dist/core/lifecycle-control/queue/index.js'));
    const main=join(root,'main'), work=join(root,'work'); fs.mkdirSync(main);
    fs.writeFileSync(join(main,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'.',rootDir:'src',storyDir:'.proof-or-stop/story/actives',outDir:'dist',testsDir:'tests',fixturesDir:'tests/fixtures'}));
    git(main,'init','-q','-b','main');git(main,'config','user.name','Audit fixture');git(main,'config','user.email','fixture@example.invalid');git(main,'add','.');git(main,'commit','-qm','seed');
    git(main,'worktree','add','-qb','story/B-phase-observation',work,'main');
    const store=new StoryStore(main),local=new StoryStore(work),sid='B-phase-observation';
    const story={storyId:sid,name:sid,title:'Queue mirror phase observation',description:'Isolated control',phase:'DEV',priority:'medium',type:'chore',createdAt:new Date().toISOString(),events:[],worktree:{path:work,branch:'story/'+sid}};
    store.writeStory(sid,story);store.writeChecklist(sid,{items:[]});local.writeChecklist(sid,{items:[]});
    const observed=[];
    for(const phase of ['DONE','DISCARDED']) {
      local.writeStory(sid,{...story,phase});
      const row=projectQueueGovernance(store,main).rows.find(r=>r.storyId===sid);
      observed.push(row?.phase); assert.ok(row,'nonterminal mirror remains selected');
    }
    measurements.renderedPhases=observed;
    assert.deepEqual(observed,['DEV','DEV'],'mirror selection and displayed queue phase must agree');
  });
  await group('check-invalid-modes-refuse-at-ownership', async () => {
    const { resolveEffectiveOwnershipClass } = await import(join(repo,'packages/main/dist/cli/ownership-gate.js'));
    const values=[{apply:'yes'},{upgrade:1},{apply:{}},{apply:true,upgrade:'yes'}];
    const refused=values.map(args=>{try{resolveEffectiveOwnershipClass('check',args);return false;}catch(e){return /must be a boolean/.test(e.message);}});
    measurements.invalidCheckModeRefusals=refused.filter(Boolean).length;assert.deepEqual(refused,[true,true,true,true]);
    for(const args of [{},{apply:false},{upgrade:'false'}]) assert.equal(resolveEffectiveOwnershipClass('check',args),'readOnly');
    for(const args of [{apply:true},{upgrade:'true'}]) assert.equal(resolveEffectiveOwnershipClass('check',args),'mainSharedMutating');
  });
  await group('compatibility-observation-reexports', async () => {
    const engine=await import(join(repo,'packages/main/dist/cli-engine.js'));
    const policy=await import(join(repo,'packages/main/dist/cli/activity-policy.js'));
    const names=['READ_ONLY_COMMANDS','isReadOnlyCommand','shouldWriteActivityLog'];
    measurements.compatibilityExportCount=names.filter(n=>n in engine).length;
    for(const name of names) {assert.ok(name in engine,name);assert.equal(engine[name],policy[name]);}
  });
  await group('maintenance-delegate-checked-once-before-consumption', async () => {
    const runtime=await import(join(repo,'packages/main/dist/core/runtime-environment-checks.js'));
    const original=fs.readFileSync;let reads=0;
    fs.readFileSync=function(path,...args){if(String(path).endsWith('/dist/core/maintenance-command-mode.js'))reads++;return original.call(this,path,...args);};syncBuiltinESMExports();
    try {
      for(const command of ['story_reconcile','quorum_prune','capability_release_backfill','verification_evidence_refresh_stale']) {
        runtime.assertCanonicalActiveIdentityArgumentDelegates({command,projectRoot:root});
        runtime.assertCanonicalActiveIdentityCommandConsumers({command,projectRoot:root});
      }
    } finally {fs.readFileSync=original;syncBuiltinESMExports();}
    measurements.maintenanceDelegateReads=reads;assert.equal(reads,4,'each of four delegates is authenticated once');
  });
  await group('nested-preparation-reuses-only-current-bound-build', () => {
    const fixture=join(root,'build');
    for(const pkg of ['main','utils']) {
      for(const dir of ['src','dist'])fs.mkdirSync(join(fixture,'packages',pkg,dir),{recursive:true});
      fs.writeFileSync(join(fixture,'packages',pkg,'package.json'),'{}');fs.writeFileSync(join(fixture,'packages',pkg,'tsconfig.json'),'{}');
      fs.writeFileSync(join(fixture,'packages',pkg,'src/index.ts'),'export const value=1;');fs.writeFileSync(join(fixture,'packages',pkg,'dist/index.js'),'export const value=1;');
    }
    fs.mkdirSync(join(fixture,'scripts'));const counter=join(fixture,'setup-count');
    fs.writeFileSync(join(fixture,'scripts/ensure-dist.mjs'),`import{appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(counter)},'setup\\n');`);
    writeBuildBinding(fixture);writeUtilsBuildBinding(fixture);
    const key='PROOF_OR_STOP_VERIFICATION_DIST_READY',previous=process.env[key];delete process.env[key];
    const invoke=()=>execFileSync(process.execPath,['--input-type=module','-e',`import{prepareVerification}from ${JSON.stringify(join(repo,'scripts/verification-subprocess-budget.mjs'))};prepareVerification(${JSON.stringify(fixture)});console.log('BODY_READY');`],{encoding:'utf8',stdio:'pipe',timeout:20000});
    try {
      prepareVerification(fixture,{shareBuild:true});assert.match(invoke(),/BODY_READY/);
      const calls=fs.readFileSync(counter,'utf8').trim().split('\n').length;measurements.nestedEnsureDistSpawns=calls;assert.equal(calls,1);
      fs.writeFileSync(join(fixture,'packages/main/src/index.ts'),'export const value=2;');
      assert.throws(invoke,/SETUP_BUILD_STALE/,'sentinel cannot approve changed source');
      delete process.env[key];prepareVerification(fixture); // Without a sharing request the ordinary prerequisite still runs.
      assert.equal(fs.readFileSync(counter,'utf8').trim().split('\n').length,2);
    } finally {if(previous===undefined)delete process.env[key];else process.env[key]=previous;}
  });
  await group('inventory-concurrent-observation-contract', () => {
    const help=fs.readFileSync(join(repo,'packages/main/src/cli/command-catalog.ts'),'utf8');
    const docs=fs.readFileSync(join(repo,'docs/reviewer-read-boundaries.md'),'utf8');
    assert.match(help,/Concurrent producer writes may cause a transient read failure; retry/);
    assert.match(docs,/concurrent producer/);assert.match(docs,/retry/);
  });
} finally {fs.rmSync(root,{recursive:true,force:true});}
console.log(JSON.stringify({groups,measurements,boundary:'Isolated production handlers, modules and build-prerequisite controls; actual contract wall time is measured separately.'},null,2));
const ok=groups.every(g=>g.pass);console.log(ok?'CLI_AUDIT_CLOSURE_GREEN':'CLI_AUDIT_CLOSURE_RED');process.exitCode=ok?0:1;
