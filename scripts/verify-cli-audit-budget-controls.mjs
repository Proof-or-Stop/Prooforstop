import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBuildBinding, writeUtilsBuildBinding, BUILD_MANIFEST } from './full-suite-build-binding.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const api=await import('./verification-subprocess-budget.mjs');
api.prepareVerification(repo);
// Replay the existing production call order when testing the RED implementation:
// one real verificationSpawner handles ensure-dist and all subsequent children.
const prepare=api.prepareVerification??((root,options)=>{
  const run=api.verificationSpawner(options.bodyBudgetMs);
  const built=run(process.execPath,[join(root,'scripts/ensure-dist.mjs')],{cwd:root,encoding:'utf8',timeout:options.buildTimeoutMs});
  assert.equal(built.status,0);return run;
});
const temp=mkdtempSync(join(tmpdir(),'audit-budget-control-')),groups=[];
const check=async(id,fn)=>{try{await fn();groups.push({id,pass:true});}catch(error){groups.push({id,pass:false,error:error.message});}};
try{
  const fixture=join(temp,'build');mkdirSync(join(fixture,'scripts'),{recursive:true});
  await check('prerequisite-does-not-consume-body-budget',()=>{
    writeFileSync(join(fixture,'scripts/ensure-dist.mjs'),'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1500);\n');
    const run=prepare(fixture,{buildTimeoutMs:5000,bodyBudgetMs:1000});
    const result=run(process.execPath,['-e',"process.stdout.write('BODY_EXECUTED')"],{encoding:'utf8',timeout:1000});
    assert.equal(result.status,0);assert.equal(result.stdout,'BODY_EXECUTED');
  });
  await check('build-timeout-is-prerequisite-unavailable',()=>{
    writeFileSync(join(fixture,'scripts/ensure-dist.mjs'),'setInterval(()=>{},1000);\n');
    assert.throws(()=>prepare(fixture,{buildTimeoutMs:60,bodyBudgetMs:1000}),/SETUP_BUILD_TIMEOUT/);
  });
  await check('shared-prerequisite-rejects-every-stale-build-surface',()=>{
    const shared=join(temp,'shared');
    for(const pkg of ['main','utils']) {
      for(const dir of ['src','dist']) {mkdirSync(join(shared,'packages',pkg,dir),{recursive:true});writeFileSync(join(shared,'packages',pkg,dir,'index.js'),'export const value=1;');}
      for(const file of ['package.json','tsconfig.json'])writeFileSync(join(shared,'packages',pkg,file),'{}');
    }
    mkdirSync(join(shared,'scripts'));writeFileSync(join(shared,'scripts/ensure-dist.mjs'),'// controlled successful prerequisite\n');
    writeBuildBinding(shared);writeUtilsBuildBinding(shared);
    const key='PROOF_OR_STOP_VERIFICATION_DIST_READY',previous=process.env[key];delete process.env[key];
    try {
      prepare(shared,{shareBuild:true});
      for(const rel of ['packages/main/src/index.js','packages/main/dist/index.js','packages/utils/src/index.js','packages/utils/dist/index.js',BUILD_MANIFEST]) {
        const path=join(shared,rel),bytes=readFileSync(path);writeFileSync(path,'changed');
        try {assert.throws(()=>prepare(shared),/SETUP_BUILD_STALE/,rel);}
        finally {writeFileSync(path,bytes);}
      }
      assert.equal(api.verificationFailureMessage('stale control',new Error('SETUP_BUILD_STALE: fixture')).startsWith('PROOF_UNAVAILABLE:'),true);
      prepare(shared); // exact restored bindings pass again
      const other=join(temp,'other');mkdirSync(join(other,'scripts'),{recursive:true});
      const marker=join(other,'ran');writeFileSync(join(other,'scripts/ensure-dist.mjs'),`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'own prerequisite');`);
      prepare(other);assert.equal(readFileSync(marker,'utf8'),'own prerequisite','another root cannot consume the sharing request');
    } finally {if(previous===undefined)delete process.env[key];else process.env[key]=previous;}
  });
  await check('missing-boundary-has-explicit-refusal',()=>{
    const install=join(temp,'install');mkdirSync(join(install,'packages/main'),{recursive:true});
    cpSync(join(repo,'packages/main/dist'),join(install,'packages/main/dist'),{recursive:true});
    cpSync(join(repo,'packages/main/package.json'),join(install,'packages/main/package.json'));
    symlinkSync(join(repo,'node_modules'),join(install,'node_modules'));
    const file=join(install,'packages/main/dist/core/runtime-environment-checks.js'),original=readFileSync(file,'utf8');
    const changed=original.replace("id: 'maintenance-command-mode',","id: 'removed-maintenance-command-mode',");assert.notEqual(changed,original);writeFileSync(file,changed);
    const result=spawnSync(process.execPath,['--input-type=module','-e',`import {assertCanonicalActiveIdentityArgumentDelegates} from ${JSON.stringify(file)};assertCanonicalActiveIdentityArgumentDelegates({command:'help',projectRoot:${JSON.stringify(temp)}});`],{encoding:'utf8',timeout:30000});
    assert.notEqual(result.status,0);assert.match(result.stderr,/unregistered active identity operation boundary: maintenance-command-mode/);assert.doesNotMatch(result.stderr,/TypeError/);
  });
  await check('version-diagnostic-survives-preceding-warning',()=>{
    // Actual guard/adapter integration is owned by the companion fixture suite.
    const result=spawnSync(process.execPath,[join(repo,'scripts/verify-cli-audit-final-controls.mjs')],{cwd:repo,encoding:'utf8',timeout:450000});
    assert.equal(result.status,0,`warning-prefix fixture failed: ${result.stdout} ${result.stderr}`);assert.match(result.stdout,/CLI_AUDIT_FINAL_GREEN/);
  });
  console.log(JSON.stringify({groups,boundary:'Controlled prerequisite delay uses the actual budget helper; it does not claim a real slow monorepo build benchmark. Boundary removal is a deliberate isolated mutation.'},null,2));
  if(groups.some(g=>!g.pass)){console.error('CLI_AUDIT_BUDGET_RED');process.exitCode=1;}else console.log('CLI_AUDIT_BUDGET_GREEN');
}finally{rmSync(temp,{recursive:true,force:true});}
