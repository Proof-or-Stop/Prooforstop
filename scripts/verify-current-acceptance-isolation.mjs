import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const scratch = mkdtempSync(join(tmpdir(), 'current-acceptance-isolation-'));
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
    '--test', '--test-name-pattern=F-247:', 'packages/main/tests/causal-evidence.test.mjs'],
  { encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.equal(result.status, 0, `U03 acceptance must pass without ambient historical Story reads\n${output}`);
  for (const id of ['CHK-004:happy:2', 'CHK-004:happy:3'])
    assert.ok(output.includes(`B-5a15|${id}|PASS|`), `current strict positive must emit ${id}`);
  console.log('PASS U03 current isolated topology and pre-review acceptance, without historical Story reads');
} finally { rmSync(scratch, { recursive: true, force: true }); }
