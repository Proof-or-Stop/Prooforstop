import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { verificationSpawner } from './verification-subprocess-budget.mjs';
const spawnSync = verificationSpawner();
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = spawnSync(process.execPath, [join(repo, 'scripts/ensure-dist.mjs')], { cwd: repo, encoding: 'utf8', timeout: 180000 });
assert.equal(build.status, 0, `SETUP_BUILD_FAILED: ${build.stdout} ${build.stderr}`);
const temp = mkdtempSync(join(tmpdir(), 'cli-audit-hardening-'));
const groups = [], measurements = {};
const group = async (id, fn) => {
  const start = performance.now();
  try { await fn(); groups.push({ id, pass: true, ms: performance.now() - start }); }
  catch (error) { groups.push({ id, pass: false, ms: performance.now() - start, error: error.message }); }
};
const child = (code, cwd = temp) => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); return result;
};
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, `SETUP_GIT: ${result.stderr}`); return result.stdout.trim();
};
try {
  await group('version-recovery-dist-versus-source', () => {
    const install = join(temp, 'version'); const pkg = join(install, 'packages/main');
    mkdirSync(join(pkg, 'dist/core'), { recursive: true }); mkdirSync(join(pkg, 'src/core'), { recursive: true }); mkdirSync(join(install, 'scripts'));
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ type: 'module', version: '9.2.0' }));
    cpSync(join(repo, 'packages/main/dist/core/runtime-package-version.js'), join(pkg, 'dist/core/runtime-package-version.js'));
    writeFileSync(join(pkg, 'dist/core/proof-or-stop-brand.js'), "export const PROOF_OR_STOP_CLI_VERSION = '9.1.0';\n");
    writeFileSync(join(install, 'scripts/ensure-dist.mjs'), '// fixture: presence only; never executed\n');
    const invoke = () => child(`import {assertRuntimePackageVersion} from ${JSON.stringify(join(pkg,'dist/core/runtime-package-version.js'))}; assertRuntimePackageVersion();`);
    writeFileSync(join(pkg, 'src/core/proof-or-stop-brand.ts'), "export const PROOF_OR_STOP_CLI_VERSION = '9.2.0';\n");
    const stale = invoke(); assert.notEqual(stale.status, 0); assert.match(stale.stderr, /Rebuild this checkout/);
    writeFileSync(join(pkg, 'src/core/proof-or-stop-brand.ts'), "export const PROOF_OR_STOP_CLI_VERSION = '9.1.0';\n");
    const desync = invoke(); assert.notEqual(desync.status, 0); assert.match(desync.stderr, /CLI_RUNTIME_VERSION_MISMATCH/);
    assert.match(desync.stderr, /SOURCE_VERSION_DESYNC/); assert.doesNotMatch(desync.stderr, /Rebuild this checkout/);
  });
  const { assertCanonicalActiveIdentityBoundary } = await import(join(repo, 'packages/main/dist/core/runtime-environment-checks.js'));
  await group('missing-executable-has-boundary-refusal', () => {
    assert.throws(() => assertCanonicalActiveIdentityBoundary({ boundaryId: 'maintenance-command-mode', runtimePackageRoot: temp, projectRoot: temp }),
      /maintenance-command-mode.*consumer rejected.*missing/);
  });
  await group('removed-executable-pin-fails-closed', () => {
    const install = join(temp, 'pin'); mkdirSync(join(install, 'packages/main'), { recursive: true });
    cpSync(join(repo, 'packages/main/dist'), join(install, 'packages/main/dist'), { recursive: true });
    cpSync(join(repo, 'packages/main/package.json'), join(install, 'packages/main/package.json'));
    symlinkSync(join(repo, 'node_modules'), join(install, 'node_modules'));
    const modulePath = join(install, 'packages/main/dist/core/runtime-environment-checks.js');
    const original = readFileSync(modulePath, 'utf8');
    const removed = original.replace(/^.*'packages\/main\/src\/core\/maintenance-command-mode.ts': '[a-f0-9]{64}',\n/m, '');
    assert.notEqual(removed, original, 'fixture must remove exactly the actual reviewed pin'); writeFileSync(modulePath, removed);
    const result = child(`import {assertCanonicalActiveIdentityBoundary} from ${JSON.stringify(modulePath)}; assertCanonicalActiveIdentityBoundary({boundaryId:'maintenance-command-mode',runtimePackageRoot:${JSON.stringify(join(install,'packages/main'))}});`);
    assert.notEqual(result.status, 0, 'a missing expected pin must not turn authentication into a no-op'); assert.match(result.stderr, /executable.*binding|executable.*pin/);
  });
  await group('strict-handler-and-raw-mode-controls', async () => {
    const { maintenanceCommandWrites, MAINTENANCE_PREVIEW_COMMANDS } = await import(join(repo, 'packages/main/dist/core/maintenance-command-mode.js'));
    let count = 0;
    for (const command of MAINTENANCE_PREVIEW_COMMANDS) {
      for (const key of (['quorum_prune','capability_release_backfill'].includes(command) ? ['dryRun','apply'] : ['dryRun'])) {
        for (const value of [true,false]) {
          assert.equal(maintenanceCommandWrites(command,{[key]:String(value)},true),maintenanceCommandWrites(command,{[key]:value})); count++;
          assert.throws(()=>maintenanceCommandWrites(command,{[key]:String(value)}),/must be a boolean/); count++;
        }
        for (const value of [1,null,{},'yes']) for (const raw of [false,true]) {
          assert.throws(()=>maintenanceCommandWrites(command,{[key]:value},raw),/must be a boolean/); count++;
        }
      }
      if (['quorum_prune','capability_release_backfill'].includes(command)) for (const raw of [false,true]) {
        assert.throws(()=>maintenanceCommandWrites(command,{dryRun:true,apply:true},raw),/either apply/); count++;
      }
    }
    for (const raw of [false,true]) { assert.throws(()=>maintenanceCommandWrites('quorum_prune',{apply:false,dryRun:false},raw),/contradict/); count++; }
    const { createStoryQueryHandlers } = await import(join(repo,'packages/main/dist/handlers/story-query.js'));
    let accesses = 0; const store = new Proxy({}, { get() { accesses++; throw new Error('UNEXPECTED_STORE_ACCESS'); } });
    const handlers = createStoryQueryHandlers({ store, root: temp });
    assert.throws(()=>handlers.story_reconcile({dryRun:'false'}),/must be a boolean/); assert.equal(accesses,0);
    measurements.typedModeAssertions = count; measurements.invalidHandlerStoreAccesses = accesses;
  });
  await group('event-classifier-fault-does-not-replace-error', async () => {
    const require = createRequire(join(repo,'package.json')); const ts = require('typescript');
    const source = ts.createSourceFile('cli.js',readFileSync(join(repo,'packages/main/dist/cli-engine.js'),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    let node; const visit = n => { if(ts.isFunctionDeclaration(n) && n.name?.text==='writeCodexProcessEvent') node=n; ts.forEachChild(n,visit); }; visit(source);
    assert.ok(node,'actual emitted observation function must exist');
    const fn = vm.runInNewContext(`(${node.getText(source)})`, { isCodexActivitySource:()=>true,storyIdFromArgs:()=> 'B-fault',activeStory:null,root:temp,
      externalAdmission:{ownershipClasses:{}},config0:{},resolveEffectiveOwnershipClass:()=>{throw new Error('INJECTED_CLASSIFIER_FAULT');} });
    await assert.doesNotReject(async()=>fn({command:'quorum_prune',args:{dryRun:true,apply:true},success:false,error:'ORIGINAL_COMMAND_ERROR'}));
  });
  const { StoryStore } = await import(join(repo,'packages/main/dist/core/store.js'));
  const { projectQueueGovernance } = await import(join(repo,'packages/main/dist/core/lifecycle-control/queue/index.js'));
  const { resolveRepositoryBaseline } = await import(join(repo,'packages/main/dist/core/git-baseline.js'));
  const project = join(temp,'queue'); mkdirSync(project);
  writeFileSync(join(project,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'.',rootDir:'src',outDir:'dist',testsDir:'tests',fixturesDir:'tests/fixtures',storyDir:'.proof-or-stop/story/actives'}));
  git(project,'init','-q','-b','main'); git(project,'config','user.name','Audit control'); git(project,'config','user.email','audit@example.invalid');
  git(project,'add','.');git(project,'commit','-qm','seed');
  const store = new StoryStore(project); const old = new Date(Date.now()-14*86400000).toISOString();
  for (let i=0;i<6;i++) {
    const sid=`B-budget${i}`,wt=join(temp,`worktree${i}`);git(project,'worktree','add','-qb',`story/${sid}`,wt,'main');
    const story={storyId:sid,name:sid,title:`Unique progress control ${i}`,description:'Audit fixture',phase:'DEV',type:'chore',priority:'medium',createdAt:old,events:[],worktree:{path:wt,branch:`story/${sid}`}};
    store.writeStory(sid,story);store.writeChecklist(sid,{items:[]});const local=new StoryStore(wt);local.writeStory(sid,story);local.writeChecklist(sid,{items:[]});
  }
  await group('queue-probes-bounded-and-unmeasured-is-unknown', () => {
    const original=childProcess.execFileSync;let probes=0;
    childProcess.execFileSync=function(command,args,...rest){if(command==='git'&&args.includes('--no-merges'))probes++;return original.call(this,command,args,...rest);};syncBuiltinESMExports();
    try {
      const result=projectQueueGovernance(store,project,{gitProbeLimit:2,gitProbeBudgetMs:1000});
      measurements.commitProbesForSixOldStories=probes; measurements.queueClasses=result.rows.map(r=>r.classification);
      assert.ok(probes<=2,`commit probes ${probes} exceed requested bound 2`);
      assert.ok(result.rows.filter(r=>r.classification==='unknown-worktree').length>=4,'unprobed worktrees are unknown, not stale');
      probes=0;const disabled=projectQueueGovernance(store,project,{gitProbeLimit:0});assert.equal(probes,0);
      assert.ok(disabled.rows.every(r=>r.classification==='unknown-worktree'));
    } finally {childProcess.execFileSync=original;syncBuiltinESMExports();}
  });
  await group('expired-baseline-budget-starts-no-subprocess', () => {
    const original=childProcess.execFileSync;let calls=0;
    childProcess.execFileSync=function(...args){calls++;return original.apply(this,args);};syncBuiltinESMExports();
    try {const result=resolveRepositoryBaseline(project,'HEAD',{deadlineMs:performance.now()-1});measurements.expiredBudgetGitCalls=calls;
      assert.equal(calls,0);assert.equal(result,undefined);
    } finally {childProcess.execFileSync=original;syncBuiltinESMExports();}
  });
  await group('wrapper-fallback-is-unknown-not-stale', () => {
    const outer=join(temp,'wrapper'),code=join(outer,'code');mkdirSync(code,{recursive:true});
    const config=JSON.parse(readFileSync(join(project,'proof-or-stop.config.json')));writeFileSync(join(outer,'proof-or-stop.config.json'),JSON.stringify({...config,gitRoot:'code'}));
    git(code,'init','-q','-b','main');git(code,'config','user.name','Wrapper');git(code,'config','user.email','audit@example.invalid');writeFileSync(join(code,'file'),'seed');git(code,'add','.');git(code,'commit','-qm','seed');
    const wt=join(outer,'linked'),sid='B-wrapper';git(code,'worktree','add','-qb',`story/${sid}`,wt,'main');
    const story={storyId:sid,name:sid,title:'Wrapper control',description:'Fixture',phase:'DEV',type:'chore',priority:'medium',createdAt:new Date().toISOString(),events:[],worktree:{path:wt,branch:`story/${sid}`}};
    const wrapper=new StoryStore(outer);wrapper.writeStory(sid,story);wrapper.writeChecklist(sid,{items:[]});
    assert.equal(projectQueueGovernance(wrapper,outer).rows[0].classification,'unknown-worktree');
    writeFileSync(join(wt,'proof-or-stop.config.json'),JSON.stringify(config));const local=new StoryStore(wt);local.writeStory(sid,story);local.writeChecklist(sid,{items:[]});
    assert.equal(projectQueueGovernance(wrapper,outer).rows[0].classification,'active-worktree');
  });
  await group('shared-subprocess-budget-expires-before-spawn', () => {
    const exhausted = verificationSpawner(0);
    assert.throws(()=>exhausted(process.execPath,['-e',"throw new Error('MUST_NOT_RUN')"]),/VERIFICATION_BUDGET_EXHAUSTED/);
    const bounded = verificationSpawner(60);
    assert.throws(()=>bounded(process.execPath,['-e','setInterval(()=>{},1000)'],{timeout:30000}),/VERIFICATION_SUBPROCESS_TIMEOUT/);
  });
  await group('unknown-lock-does-not-authorize-writes', async () => {
    const { evaluateRuntimeEnforcement } = await import(join(repo,'packages/main/dist/core/lifecycle-control/runtime/index.js'));
    for(const operation of ['phase-advance','validation-write','main-mirror-read','shared-main-write']) {
      const decision=evaluateRuntimeEnforcement({mode:'enforce',operation,currentCwd:temp,authoritativeCwd:temp,authority:'main',validationLock:'unknown'});
      assert.equal(decision.blocked,true);assert.equal(decision.reason,'validation_lock_unknown');
    }
  });
  console.log(JSON.stringify({groups,measurements,boundary:'Isolated production modules/handlers and Git worktrees; event classifier failure is explicit fault injection, not a claim of ordinary argv reachability.'},null,2));
  if(groups.some(g=>!g.pass)){console.error('AUDIT_HARDENING_RED');process.exitCode=1;}else console.log('CLI_AUDIT_HARDENING_GREEN');
} finally {rmSync(temp,{recursive:true,force:true});}
