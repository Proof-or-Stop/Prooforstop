import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { commandObservationEffects } from '../packages/main/dist/cli/activity-policy.js';
import { resolveEffectiveOwnershipClass } from '../packages/main/dist/cli/ownership-gate.js';
import { withValidationExecutionLock, validationExecutionLockPath, observeValidationExecutionLock } from '../packages/main/dist/core/validation-execution-lock.js';

const cases = [
  ['reviewer_list', {}, true], ['reviewer_list', {forceReviewer:'behavior'}, false],
  ['usage_sweep', {}, true], ['usage_sweep', {out:'reports/sweep.json'}, false],
  ['review_inventory_status', {}, true], ['review_inventory_status', {refresh:true}, false],
  ['check', {}, true], ['check', {apply:true}, false],
  ['verification_evidence_refresh_stale', {dryRun:true}, true], ['verification_evidence_refresh_stale', {dryRun:false}, false],
];
for (const [command,args,readOnly] of cases) {
  const ownership = resolveEffectiveOwnershipClass(command,args,'B-observation');
  assert.equal(ownership === 'readOnly',readOnly);
  for(const optIn of [false,true]) {
    const effects = commandObservationEffects(ownership,optIn);
    assert.equal(effects.runHooks,!readOnly);assert.equal(effects.recordStoryEvent,!readOnly);
    assert.equal(effects.recordActivity,!readOnly||optIn);
  }
}
assert.deepEqual(commandObservationEffects(null,true),{readOnly:false,runHooks:false,recordStoryEvent:false,recordActivity:false});
const root=mkdtempSync(join(tmpdir(),'observation-controls-'));
const storyId='B-lockobservation';
const options={root,storyId,command:'observation-controls'};
try {
  execFileSync('git',['init','-q'],{cwd:root});
  assert.equal(observeValidationExecutionLock(root,storyId),'free');
  let release;
  const running=withValidationExecutionLock(options,async()=>{
    assert.equal(observeValidationExecutionLock(root,storyId),'self-reentry');
    await new Promise(resolve=>release=resolve);
  });
  // This await is outside the lock's AsyncLocalStorage context, even in the same PID.
  while(!release) await new Promise(resolve=>setImmediate(resolve));
  try { assert.equal(observeValidationExecutionLock(root,storyId),'active'); } finally {release();await running;}
  let wake, oldContext;
  await withValidationExecutionLock(options,()=>{
    oldContext=new Promise(resolve=>wake=resolve).then(()=>observeValidationExecutionLock(root,storyId));
  });
  await withValidationExecutionLock(options,async()=>{
    wake();assert.equal(await oldContext,'active','released generation cannot impersonate its successor');
    assert.equal(observeValidationExecutionLock(root,storyId),'self-reentry');
    const file=join(validationExecutionLockPath(root,storyId),'holder.json');
    const original=readFileSync(file,'utf8');
    try {
      writeFileSync(file,JSON.stringify({...JSON.parse(original),lockId:'different-generation'}));
      assert.notEqual(observeValidationExecutionLock(root,storyId),'self-reentry','disk generation mismatch must reject reentry');
    } finally {writeFileSync(file,original);}
  });
  const path=validationExecutionLockPath(root,storyId);mkdirSync(path);
  assert.equal(observeValidationExecutionLock(root,storyId),'unknown','missing metadata is not an owned or free lock');
  writeFileSync(join(path,'holder.json'),'broken');
  assert.equal(observeValidationExecutionLock(root,storyId),'unknown');
  assert.equal(readFileSync(join(path,'holder.json'),'utf8'),'broken','observation never repairs metadata');
  rmSync(path,{recursive:true});
  assert.equal(observeValidationExecutionLock(root,storyId),'free');
  console.log(JSON.stringify({parameterCases:cases.length,telemetryModes:2,controls:['unclassified-no-effects','free','live-self','same-pid-foreign-context','released-context-successor','holder-generation-mismatch','missing-holder','corrupt-holder-unchanged']},null,2));
  console.log('COMMAND_OBSERVATION_CONTROLS_GREEN');
} finally {rmSync(root,{recursive:true,force:true});}
