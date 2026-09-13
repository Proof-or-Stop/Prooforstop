import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const root=process.cwd(),suite=Number(process.argv[2]);
const commands={
  2:['scripts/run-validation-fixture-suite.mjs','packages/main/dist/tasks/quorum-submit-smoke.js','--jobs=2'],
  3:['packages/main/dist/tasks/finding-identity-lineage-smoke.js','--section=delivery'],
  5:['scripts/run-validation-fixture-suite.mjs','packages/main/dist/tasks/validate-progress-heartbeat-smoke.js'],
};
const markers={2:/quorum_submit smoke passed \(73 checks\)/,3:/FINDING_IDENTITY_DELIVERY PASS 93 passing 0 failed/,5:/validate-progress-heartbeat smoke passed/};
assert.ok(commands[suite]);
const start=performance.now(),native=spawnSync(process.execPath,commands[suite],{cwd:root,encoding:'utf8',timeout:1200000,maxBuffer:96*1024*1024});
process.stdout.write(native.stdout??'');process.stderr.write(native.stderr??'');
console.log('TOP5_PROFILE '+JSON.stringify({suite,command:['node',...commands[suite]],wallMs:performance.now()-start,nativeExitCode:native.status,nativeSignal:native.signal,formalStoryEvidence:false}));
assert.equal(native.status,0,'Full native suite must pass before asserting performance');assert.match(native.stdout,markers[suite]);
if(suite===2) {
 const reports=native.stdout.split('\n').filter(line=>line.startsWith('QUORUM_SMOKE_RUN_JSON ')).map(line=>JSON.parse(line.slice('QUORUM_SMOKE_RUN_JSON '.length)));
 const report=reports.find(row=>row.coordinator==='default-parent'&&row.results?.length===73);assert.ok(report,'complete parent report required');
 assert.equal(report.ok,true);assert.equal(report.processTreeReaped,true);assert.deepEqual(report.residue,{temp:0,process:0,ticket:0,quarantine:0});
 assert.equal(new Set(report.results.map(row=>row.caseId??row.id)).size,73);
}
const line=native.stdout.split('\n').find(line=>line.startsWith('FIXTURE_COMPILE_CACHE '));assert.ok(line,'cache observation must exist');
const cache=JSON.parse(line.slice('FIXTURE_COMPILE_CACHE '.length));
assert.ok(cache.files>0&&cache.bytes>0,`TOP5_${suite}_RED: repeated native children have no disposable compilation cache`);
console.log(`TOP5_${suite}_GREEN`);
