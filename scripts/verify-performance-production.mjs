#!/usr/bin/env node
// Production regressions; fixtures are isolated and never modify real Story state.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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
  if (process.send) await new Promise(resolve => { process.once('message',resolve); process.send('ready'); });
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
  const repository=join(dir,'cross-worktree-repo');mkdirSync(repository);
  const git=argv=>execFileSync('git',argv,{cwd:repository,stdio:['ignore','pipe','pipe']});
  git(['init']);git(['config','user.name','Lab fixture']);git(['config','user.email','lab@example.invalid']);
  writeFileSync(join(repository,'subject.txt'),'fixture\n');git(['add','.']);git(['commit','-m','fixture']);
  const worktrees=[join(dir,'worktree-a'),join(dir,'worktree-b')];
  for (const [i,path] of worktrees.entries()) git(['worktree','add','-b','fixture-'+i,path]);
  for (const isolated of [false,true]) for (const same of [false,true]) await check('cross-process '+(isolated?'isolated worktrees ':'')+(same?'serialize conflicts':'admit independent resources'), async () => {
    const children=[];let ready=0;
    const run = (key,index) => new Promise((resolve,reject) => {
      const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--capacity-child',JSON.stringify({
        root:isolated?worktrees[index]:dir,workspaceRoot:isolated?worktrees[index]:dir,command:'child',pollMs:10,maxConcurrent:2,
        resources:[{class:same?'fixed-port':'fixed-path',key:same?'65431':key,access:'exclusive'}],
      })],{stdio:['ignore','pipe','pipe','ipc']});
      const deadline=setTimeout(()=>child.kill('SIGKILL'),30000);child.once('exit',()=>clearTimeout(deadline));
      children.push(child);child.on('message',()=>{if(++ready===2)children.forEach(c=>c.send('start'));});
      let output='',error='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>error+=x);
      child.on('error',reject);child.on('exit',code=>code===0?resolve(output.trim().split('\n').map(JSON.parse)):reject(new Error(error)));
    });
    const [a,b]=await Promise.all([run('first',0),run(same?'first':'second',1)]);
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
  await check('real validation consumers share only permitted unchanged PASS executions', async () => {
    const workspace=join(dir,'reuse-repo');mkdirSync(workspace);
    const git=argv=>execFileSync('git',argv,{cwd:workspace,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    git(['init']);git(['config','user.name','Lab fixture']);git(['config','user.email','lab@example.invalid']);
    writeFileSync(join(workspace,'.gitignore'),'.proof-or-stop/\n');
    writeFileSync(join(workspace,'package.json'),JSON.stringify({name:'lab-reuse-fixture',version:'1.0.0'}));
    writeFileSync(join(workspace,'witness.mjs'),"import {randomUUID} from 'node:crypto';console.log('WITNESS '+randomUUID());\n");
    git(['add','.']);git(['commit','-m','fixture']);
    const receipts=new Map();
    const store={readCausalEvidenceReceipt:(_id,key)=>receipts.get(key)??null,
      writeCausalEvidenceReceipt:(_id,receipt)=>{receipts.set(receipt.executionKey,structuredClone(receipt));}};
    const digest=x=>createHash('sha256').update(x).digest('hex');
    const probe=()=>({
      cli:{available:true,path:process.execPath},worktree:{expected:workspace,actual:workspace},
      gitIndex:{readable:true,path:join(workspace,'.git/index'),contentDigest:digest(readFileSync(join(workspace,'.git/index')))},
      gitMaterial:{available:true,headHash:git(['rev-parse','HEAD']),materialHash:git(['rev-parse','HEAD^{tree}']),storyFilesHash:git(['rev-parse','HEAD^{tree}'])},
      writerLease:{available:true,valid:true},providerCapability:{required:['validation-plan'],available:['validation-plan']},
      resources:{required:{slots:1},available:{slots:1}},evidenceTarget:{writable:true,path:workspace},
      sideChannel:{available:true,maxOutputChars:12000,maxProgressEvents:1},
    });
    const sharedExecution={storyId:'B-lab-reuse-fixture',receiptStore:store,probe};
    const {runValidationCommand}=await import('../packages/main/dist/core/validation-executor.js');
    const spec={label:'validate',command:process.execPath,args:['witness.mjs'],executionReuse:'exact-inputs',executionInputs:[]};
    const run=extra=>runValidationCommand({...spec,...extra},workspace,10000,{sharedExecution});
    const a=await run({}),b=await run({label:'done-required'});
    assert.equal(a.code,0);assert.equal(b.code,0);assert.equal(a.output,b.output,'identical consumers launched the witness twice');
    assert.equal(a.executionReceipt?.disposition,'executed');assert.equal(b.executionReceipt?.disposition,'reused');
    const forbiddenA=await run({fullBaselineReusePolicy:'forbidden'}),forbiddenB=await run({fullBaselineReusePolicy:'forbidden'});
    assert.notEqual(forbiddenA.output,forbiddenB.output,'forbidden policy must execute both consumers');
    const undeclaredA=await run({executionInputs:undefined}),undeclaredB=await run({executionInputs:undefined});
    assert.notEqual(undeclaredA.output,undeclaredB.output,'absent input declaration must not reuse');
    const abort=new AbortController();abort.abort(new Error('fixture abort'));
    await assert.rejects(runValidationCommand(spec,workspace,10000,{sharedExecution,abortSignal:abort.signal}),/fixture abort/);
    await assert.rejects(runValidationCommand(spec,workspace,10000,{sharedExecution,deadlineAt:Date.now()-1}),/deadline/);
    const invalidLease={...sharedExecution,probe:()=>({...probe(),writerLease:{available:true,valid:false}})};
    await assert.rejects(runValidationCommand(spec,workspace,10000,{sharedExecution:invalidLease}),/preflight refused/);
    const buildA=await run({providesBuildProof:'packages-main-build'}),buildB=await run({providesBuildProof:'packages-main-build'});
    assert.notEqual(buildA.output,buildB.output,'build proof cannot be skipped through shared execution');
    const beforeFailure=receipts.size;
    const failureSpec={args:['-e',"console.log('FAIL '+Math.random());process.exitCode=1"]};
    const failedA=await run(failureSpec),failedB=await run(failureSpec);
    assert.equal(failedA.code,1);assert.equal(failedB.code,1);assert.notEqual(failedA.output,failedB.output);
    assert.equal(receipts.size,beforeFailure,'failure results never populate shared PASS storage');
    const externalInput=join(dir,'external-input.txt');writeFileSync(externalInput,'first');
    const externalA=await run({executionInputs:[externalInput]});
    writeFileSync(externalInput,'second');
    const externalB=await run({executionInputs:[externalInput]});
    assert.notEqual(externalA.output,externalB.output,'declared external input drift requires a new execution');
    const changed=await run({env:{LAB_WITNESS_INPUT:'changed'}});
    assert.notEqual(changed.output,a.output,'environment drift needs a new execution');
    const first=receipts.get(a.executionReceipt.executionKey);
    receipts.set(first.executionKey,{...first,outputProbe:'tampered'});
    await assert.rejects(run({}),/tampered/);
    receipts.set(first.executionKey,first);
    writeFileSync(join(workspace,'witness.mjs'),"console.log('CHANGED');\n");
    const dirty=await run({});assert.equal(dirty.output.trim(),'CHANGED');
    assert.equal(dirty.executionReceipt,undefined,'dirty workspaces cannot reuse or publish shared receipts');
  });
  await check('complete signed review wave enables repair without certification authority', async () => {
    execFileSync(process.execPath,['packages/main/dist/tasks/review-inventory-epoch-smoke.js'],{cwd:root,stdio:'pipe'});
  });
  for (const test of ['validation-stage-entry-count.mjs', 'validation-wait-ledger.mjs']) {
    execFileSync(process.execPath, ['packages/main/tests/' + test], {cwd: root, stdio: 'inherit'});
  }
  for (const mode of ['abort', 'deadline']) {
    execFileSync(process.execPath, ['packages/main/tests/validation-stage-entry-count.mjs'], {cwd: root, stdio: 'inherit', env: {...process.env, LAB_SAFETY_MODE: mode}});
  }
} finally { rmSync(dir,{recursive:true,force:true}); }
if(failures.length){console.error(failures.join('\n'));process.exitCode=1;}
else {
execFileSync(process.execPath, ['packages/main/tests/validation-reuse-economics.mjs'], {cwd: root, stdio:'inherit', timeout:120000});

execFileSync(process.execPath, ['packages/main/tests/validation-reuse-cost-process.mjs'], {cwd:root,stdio:'inherit',timeout:120000});
execFileSync(process.execPath, ['packages/main/tests/validation-reuse-cost-store.mjs'], {cwd:root,stdio:'inherit',timeout:120000});
execFileSync(process.execPath, ['packages/main/tests/validation-reuse-cost-close.mjs'], {cwd:root,stdio:'inherit',timeout:30000});
console.log('Performance production regressions passed');
}
