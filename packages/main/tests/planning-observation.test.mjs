import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {syncBuiltinESMExports} from 'node:module';
import {prepareVerificationExecutionIdentity,withVerificationPlanningObservation} from '../dist/core/verification-execution-evidence.js';
const original=fs.readFileSync,anchor=path.resolve('packages/main/dist/core/execution-implementation.js');let scans=0,revision=0;
fs.readFileSync=function(file,...rest){let value=original.call(this,file,...rest);if(String(file)===anchor){scans++;if(revision)value=Buffer.isBuffer(value)?Buffer.concat([value,Buffer.from('\n// observed revision '+revision)]):value+'\n// observed revision '+revision;}return value;};syncBuiltinESMExports();
const input={command:'node --version',cwd:process.cwd(),effectiveTimeoutMs:2000};
const observe=()=>prepareVerificationExecutionIdentity(input);
try {
 const first=observe();scans=0;
 const grouped=withVerificationPlanningObservation(()=>[observe(),observe(),observe()]);assert.equal(scans,1,'three planning rows share one implementation scan');
 assert.ok(grouped.every(row=>row.executionIdentityDigest===first.executionIdentityDigest),'grouping preserves command identity');
 scans=0;observe();observe();assert.equal(scans,2,'independent observations rescan');
 let before;assert.throws(()=>withVerificationPlanningObservation(()=>{before=observe();throw Error('abort');}),/abort/);revision++;
 assert.notEqual(observe().toolchainDigest,before.toolchainDigest,'throw releases observation');
 await withVerificationPlanningObservation(async()=>{const before=observe();await Promise.resolve();revision++;assert.notEqual(observe().toolchainDigest,before.toolchainDigest,'no cached implementation crosses await');});
 scans=0;withVerificationPlanningObservation(()=>{observe();withVerificationPlanningObservation(()=>observe());observe();});assert.equal(scans,2,'nested planning observations are independent and restore outer scope');
 console.log('PLANNING_OBSERVATION_BOUNDARIES PASS reuse, fresh calls, throwing scope, await, nested scope');
}finally{fs.readFileSync=original;syncBuiltinESMExports();}
