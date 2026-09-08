#!/usr/bin/env node
// Production regressions; fixtures are isolated and never modify real Story state.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, ['scripts/ensure-dist.mjs'], { cwd: root, stdio: 'inherit' });
const locks = await import('../packages/main/dist/core/validation-execution-lock.js');
const owner = await import('../packages/main/dist/core/story-owner-lease.js');
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
      resources: [{ class: 'fixture-dir', key, access: 'write' }], maxConcurrent: 2,
    }, async () => { active++; maximum=Math.max(maximum,active); await delay(120); active--; })));
    assert.equal(maximum, 2, 'independent resources were unnecessarily serialized');
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
} finally { rmSync(dir,{recursive:true,force:true}); }
if(failures.length){console.error(failures.join('\n'));process.exitCode=1;}
else console.log('Performance production regressions passed');
