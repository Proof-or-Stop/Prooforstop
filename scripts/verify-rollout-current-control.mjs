import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runEntry, createFullSuiteRunState } from '../packages/main/dist/tasks/full-suite-runner.js';

const root = resolve('.');
const fixture = mkdtempSync(join(tmpdir(), 'rollout-current-control-'));
try {
  const target = pathToFileURL(join(root, 'packages/main/dist/tasks/proofstory-pre-review-check-smoke.js')).href;
  const sanitizer = pathToFileURL(join(root, 'packages/main/dist/tasks/fixture-environment.js')).href;
  const caseFile = join(fixture, 'case.jsonl');
  writeFileSync(join(fixture, 'launch.mjs'), `import {sanitizedFixtureChildEnvironment} from ${JSON.stringify(sanitizer)};
import {appendFileSync} from 'node:fs';
const log=console.log;
console.log=(...args)=>{
 if(args.length===1&&typeof args[0]==='string'&&args[0].startsWith('PROOFSTORY_ROLLOUT_CASE=')){
  appendFileSync(${JSON.stringify(caseFile)},args[0].slice('PROOFSTORY_ROLLOUT_CASE='.length)+'\\n');
  log('ROLLOUT_CONTROL_CAPTURED');
 } else log(...args);
};
const clean=sanitizedFixtureChildEnvironment(process.env);
for(const key of Object.keys(process.env)) if(!(key in clean)) delete process.env[key];
Object.assign(process.env,{PROOF_OR_STOP_ROLLOUT_COHORT_STORY_ID:'B-current-rollout-control',PROOF_OR_STOP_ROLLOUT_COHORT_ARM:'candidate',PROOF_OR_STOP_ROLLOUT_COHORT_SCENARIO:'control'});
process.chdir(${JSON.stringify(root)}); process.argv.push('--rollout-cohort-case');
await import(${JSON.stringify(target)});
`);
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({scripts:{control:'node launch.mjs'}}));
  const result = await runEntry({name:'control',resources:[],timeoutMs:180_000,tempOwnership:'runner-owned-unique'},
    fixture, 'npm', undefined, createFullSuiteRunState());
  assert.equal(result.status, 'PASS', `U03 current rollout control must reach production quorum\n${result.output}`);
  assert.ok(result.output.includes('ROLLOUT_CONTROL_CAPTURED'), 'production case output was captured before bounded log truncation');
  const lines = readFileSync(caseFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, 'exactly one completed production case');
  const control = JSON.parse(lines[0]);
  assert.equal(control.topologyReport.status, 'pass');
  assert.equal(control.preReviewReport.ok, true);
  assert.equal(control.restoredPreReviewReport.ok, true);
  assert.equal(control.hostVerdicts.length, 6, 'actual three rounds across two host providers');
  assert.deepEqual([...new Set(control.hostVerdicts.map(row=>row.provider))].sort(), ['claude','codex']);
  console.log('PASS U03 current production rollout control with actual 3x2 quorum');
} finally { rmSync(fixture, {recursive:true,force:true}); }
