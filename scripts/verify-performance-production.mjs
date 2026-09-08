#!/usr/bin/env node
// Production regressions; fixtures are isolated and never modify real Story state.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[2] !== '--capacity-child') execFileSync(process.execPath, ['scripts/ensure-dist.mjs'], { cwd: root, stdio: 'inherit' });
const locks = await import('../packages/main/dist/core/validation-execution-lock.js');
const owner = await import('../packages/main/dist/core/story-owner-lease.js');
if (process.argv[2] === '--capacity-child') {
  const opts = JSON.parse(process.argv[3]);
  await locks.withWorkspaceValidationCapacity(opts, async () => {
    console.log(JSON.stringify({ event: 'enter', at: Date.now() }));
    await new Promise(resolve => setTimeout(resolve, 180));
    console.log(JSON.stringify({ event: 'exit', at: Date.now() }));
  });
  process.exit(0);
}
const dir = mkdtempSync(join(tmpdir(), 'pos-performance-production-'));
const failures = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function check(name, run) {
  try { await run(); console.log('PASS '+name); }
  catch (error) { failures.push(name+': '+error.message); console.error('PERFORMANCE_PRODUCTION_RED '+name+': '+error.message); }
}
try {
  await check('independent explicitly declared resources use separate capacity slots', async () => {
    let active = 0, maximum = 0;
    await Promise.all(['a', 'b'].map(key => locks.withWorkspaceValidationCapacity({
      root: dir, workspaceRoot: dir, command: 'production-resource-regression', pollMs: 10,
      resources: [{ class: 'fixed-path', key, access: 'exclusive' }], maxConcurrent: 2,
    }, async () => { active++; maximum=Math.max(maximum,active); await delay(120); active--; })));
    assert.equal(maximum, 2, 'independent resources were unnecessarily serialized');
  });
  for (const scenario of [
    { name: 'conflicting resources remain serialized', keys: ['same', 'same'], expected: 1 },
    { name: 'unknown declarations remain serialized', keys: [null, 'other'], expected: 1 },
  ]) await check(scenario.name, async () => {
    let active=0, maximum=0;
    await Promise.all(scenario.keys.map(key => locks.withWorkspaceValidationCapacity({
      root: dir, workspaceRoot: dir, command: scenario.name, pollMs: 10, maxConcurrent: 2,
      resources: key === null ? undefined : [{class:'fixed-path',key,access:'exclusive'}],
    }, async () => { active++; maximum=Math.max(maximum,active); await delay(60); active--; })));
    assert.equal(maximum,scenario.expected);
  });
  await check('malformed resource declarations fail before callback', async () => {
    let called=false;
    await assert.rejects(locks.withWorkspaceValidationCapacity({root:dir,workspaceRoot:dir,command:'invalid',
      resources:[{class:'invalid',key:'x',access:'exclusive'}],maxConcurrent:2},()=>{called=true;}));
    assert.equal(called,false);
  });
  for (const same of [false,true]) await check('cross-process capacity '+(same?'serializes conflicts':'admits independent resources'), async () => {
    const run = key => new Promise((resolve,reject) => {
      const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--capacity-child',JSON.stringify({
        root:dir,workspaceRoot:dir,command:'child',pollMs:10,maxConcurrent:2,
        resources:[{class:'fixed-path',key,access:'exclusive'}],
      })],{stdio:['ignore','pipe','pipe']});
      let output='',error='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>error+=x);
      child.on('error',reject);child.on('exit',code=>code===0?resolve(output.trim().split('\n').map(JSON.parse)):reject(new Error(error)));
    });
    const [a,b]=await Promise.all([run('first'),run(same?'first':'second')]);
    const overlap=Math.min(a[1].at,b[1].at)-Math.max(a[0].at,b[0].at);
    assert.equal(overlap>0,!same,JSON.stringify({a,b,overlap}));
  });
  await check('missing lease is never acquired by heartbeat', async () => {
    const missing=join(dir,'missing-lease');mkdirSync(missing);
    let called=false;
    await assert.rejects(owner.withOwnerLeaseHeartbeat(missing,{command:'test',cwd:dir},()=>{called=true;}),/lease lost/);
    assert.equal(called,false);assert.equal(owner.readOwnerLease(missing),null);
  });
  await check('released lease is never resurrected by heartbeat', async () => {
    const released=join(dir,'released-lease');mkdirSync(released);
    owner.acquireOwnerLease(released,{command:'test',cwd:dir});
    await assert.rejects(owner.withOwnerLeaseHeartbeat(released,{command:'test',cwd:dir,intervalMs:10},async()=>{
      owner.releaseOwnerLease(released);await delay(30);
    }),/lease lost/);
    assert.equal(owner.readOwnerLease(released),null);
  });
  await check('reacquired generation fences a late heartbeat', async () => {
    const reacquired=join(dir,'reacquired-lease');mkdirSync(reacquired);
    const initial=owner.acquireOwnerLease(reacquired,{command:'test',cwd:dir});
    let successor;
    await assert.rejects(owner.withOwnerLeaseHeartbeat(reacquired,{command:'test',cwd:dir,intervalMs:10},async()=>{
      successor=owner.acquireOwnerLease(reacquired,{command:'successor',cwd:dir});await delay(30);
    }),/lease lost/);
    assert.notEqual(successor.leaseId,initial.leaseId);
    assert.deepEqual(owner.readOwnerLease(reacquired),successor);
  });
  await check('long official validation renews the same owner until publication', async () => {
    process.env.PROOF_OR_STOP_SESSION_ID='lab-performance-owner'; owner.resetSessionIdForTest();
    const storyDir=join(dir,'lease-fixture'); mkdirSync(storyDir);
    const start=Date.now(), base=Date.parse('2026-09-08T00:00:00Z');
    const now=()=>new Date(base+(Date.now()-start)*10000).toISOString();
    owner.acquireOwnerLease(storyDir,{command:'validation',cwd:dir,now});
    await locks.withOfficialValidationExecution({root:dir,workspaceRoot:dir,command:'validation',
      ownerLeaseDir:storyDir, ownerLeaseHeartbeat:{intervalMs:20,now}},async()=>{
      await delay(250);
      assert.equal(owner.isLeaseStale(owner.readOwnerLease(storyDir),Date.parse(now())),false,
        'completed validation cannot publish because its owner lease expired');
    });
  });
  await check('complete signed review wave enables repair without certification authority', async () => {
    execFileSync(process.execPath,['packages/main/dist/tasks/review-inventory-epoch-smoke.js'],{cwd:root,stdio:'pipe'});
  });
} finally { rmSync(dir,{recursive:true,force:true}); }
if(failures.length){console.error(failures.join('\n'));process.exitCode=1;}
else console.log('Performance production regressions passed');
