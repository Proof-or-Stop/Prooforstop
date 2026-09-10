import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {HISTORICAL_IMPLEMENTATION,verifyHistoricalImplementationBytes,assertHistoricalImplementationSource} from '../../packages/main/dist/tasks/historical-implementation-fixture.js';

const root=resolve(import.meta.dirname,'../..');
const bytes=execFileSync('git',['cat-file','commit',HISTORICAL_IMPLEMENTATION],{cwd:root});
verifyHistoricalImplementationBytes(bytes);
assert.equal(assertHistoricalImplementationSource(root),HISTORICAL_IMPLEMENTATION);
for(const changed of [Buffer.concat([bytes,Buffer.from('\n')]),Buffer.from(bytes.toString().replace('author proof-or-stop-implementer','author unknown')),Buffer.from(bytes.toString().replace(/^tree [a-f0-9]{40}/,'tree '+'0'.repeat(40)))])
  assert.throws(()=>verifyHistoricalImplementationBytes(changed),/HISTORICAL_FIXTURE_OBJECT_CHANGED/);
const empty=mkdtempSync(join(tmpdir(),'pos-empty-history-'));
try{
  execFileSync('git',['init','--bare',empty],{stdio:'ignore'});
  assert.throws(()=>assertHistoricalImplementationSource(empty),/HISTORICAL_FIXTURE_OBJECT_MISSING/);
}finally{rmSync(empty,{recursive:true,force:true});}
const ancestry=spawnSync('git',['merge-base','--is-ancestor',HISTORICAL_IMPLEMENTATION,'main'],{cwd:root}).status;
console.log('HISTORICAL_FIXTURE_CONTROLS_GREEN '+JSON.stringify({exactCommit:HISTORICAL_IMPLEMENTATION,mainAncestor:ancestry===0,negativeControls:4,sourceAndTargetHistoryUnmodified:true}));
