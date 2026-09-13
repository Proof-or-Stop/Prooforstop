import assert from 'node:assert/strict';
import ts from 'typescript';
import fs from 'node:fs';import path from 'node:path';import {syncBuiltinESMExports} from 'node:module';
import {prepareVerificationExecutionIdentity,withVerificationPlanningObservation,withVerificationRefreshObservation} from '../dist/core/verification-execution-evidence.js';
const original=fs.readFileSync,anchor=path.resolve('packages/main/dist/core/execution-implementation.js');let scans=0,revision=0;
fs.readFileSync=function(file,...rest){let value=original.call(this,file,...rest);if(String(file)===anchor){scans++;if(revision)value=Buffer.isBuffer(value)?Buffer.concat([value,Buffer.from('\n// observed revision '+revision)]):value+'\n// observed revision '+revision;}return value;};syncBuiltinESMExports();
const input={command:'node --version',cwd:process.cwd(),effectiveTimeoutMs:2000};
const observe=()=>prepareVerificationExecutionIdentity(input);
try {
 for (const scope of [withVerificationPlanningObservation, withVerificationRefreshObservation]) {
 const first=observe();scans=0;
 const grouped=scope(()=>[observe(),observe(),observe()]);assert.equal(scans,1,'three planning rows share one implementation scan');
 assert.ok(grouped.every(row=>row.executionIdentityDigest===first.executionIdentityDigest),'grouping preserves command identity');
 scans=0;const varied=scope(()=>[observe(),prepareVerificationExecutionIdentity({...input,effectiveTimeoutMs:3000})]);assert.equal(scans,1);assert.notEqual(varied[0].executionIdentityDigest,varied[1].executionIdentityDigest,'per-row timeout remains independent');
 scans=0;observe();observe();assert.equal(scans,2,'independent observations rescan');
 let before;assert.throws(()=>scope(()=>{before=observe();throw Error('abort');}),/abort/);revision++;
 assert.notEqual(observe().toolchainDigest,before.toolchainDigest,'throw releases observation');
 await scope(async()=>{const before=observe();await Promise.resolve();revision++;assert.notEqual(observe().toolchainDigest,before.toolchainDigest,'no cached implementation crosses await');});
 scans=0;scope(()=>{observe();scope(()=>observe());observe();});assert.equal(scans,2,'nested planning observations are independent and restore outer scope');
 }
 console.log('PLANNING_OBSERVATION_BOUNDARIES PASS reuse, fresh calls, throwing scope, await, nested scope');
}finally{fs.readFileSync=original;syncBuiltinESMExports();}

// Guard the actual refresh call sites against broadening across async/commit boundaries.
const source=fs.readFileSync('packages/main/src/handlers/checklist.ts','utf8');
const ast=ts.createSourceFile('checklist.ts',source,ts.ScriptTarget.Latest,true);
const scopes=[];
function walk(n){if(ts.isCallExpression(n)&&n.expression.getText(ast)==='withVerificationRefreshObservation')scopes.push(n);ts.forEachChild(n,walk);}walk(ast);
assert.equal(scopes.length,3,'exactly three bounded refresh observations');
for(const call of scopes){const callback=call.arguments[0];assert.ok(ts.isArrowFunction(callback));assert.ok(!callback.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword));
 const check=n=>{assert.notEqual(n.kind,ts.SyntaxKind.AwaitExpression,'refresh scope cannot contain await');if(ts.isCallExpression(n))assert.ok(!/commitCanonicalCausalEvidence|withVerificationExecutionLocks|enforceAndStampEvidence/.test(n.expression.getText(ast)),'execution, lock acquisition and publication must remain outside observation');ts.forEachChild(n,check);};check(callback.body);
}
assert.equal(scopes.filter(n=>n.getText(ast).includes('buildVerificationCoverage(')).length,1);
assert.equal(scopes.filter(n=>n.getText(ast).includes('for (const entry of stale)')).length,1);
assert.equal(scopes.filter(n=>n.getText(ast).includes('for (const entry of computed.stale)')).length,1);
console.log('REFRESH_OBSERVATION_BOUNDARIES PASS three synchronous scopes, independent timeout, no execution or publication inside');
