import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const scratch = mkdtempSync(join(tmpdir(), 'current-rollout-isolation-'));
try {
  const preload = join(scratch, 'deny-ambient-story.mjs');
  writeFileSync(preload, `import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const original=childProcess.execFileSync;
childProcess.execFileSync=function(file,args,options){
  if(Array.isArray(args)&&args.some(value=>typeof value==='string'&&value.includes('proof-or-stop.js'))
    &&args.some(value=>{try{return JSON.parse(value).storyId==='B-5a15';}catch{return false;}}))
    throw new Error('ambient historical B-5a15 Story reads are forbidden in isolated acceptance');
  return original.call(this,file,args,options);
};
syncBuiltinESMExports();
`);
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href,
    '--test', '--test-name-pattern=F-249/', 'packages/main/tests/causal-evidence.test.mjs'],
  { env: { ...process.env, ...(process.argv[2] === '--cohort' && process.argv[3] ? { PROOF_OR_STOP_ROLLOUT_COHORT_INPUT_PATH: process.argv[3] } : {}) }, encoding: 'utf8', timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.equal(result.status, 0, `U03 rollout acceptance must pass without ambient historical Story reads\n${output}`);
  assert.ok(output.includes('PASS F249-F264 current rollout positive and all original negative mutations'));
  console.log('PASS U03 current isolated rollout acceptance without historical Story reads');
} finally { rmSync(scratch, { recursive: true, force: true }); }
