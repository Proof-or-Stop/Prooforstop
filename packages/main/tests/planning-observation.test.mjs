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

// Execute the actual compiled recovery closure with controlled collaborators.
// These are orchestration boundary tests, not native execution receipts.
const compiled=fs.readFileSync('packages/main/dist/handlers/checklist.js','utf8');
const compiledAst=ts.createSourceFile('checklist.js',compiled,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
let recoveryExpression;
function findRecovery(n){if(ts.isVariableDeclaration(n)&&n.name.getText(compiledAst)==='enforceWithPublicationRecovery')recoveryExpression=n.initializer.getText(compiledAst);ts.forEachChild(n,findRecovery);}findRecovery(compiledAst);
assert.ok(recoveryExpression);
const recoveryDependencies=['verificationProducerPlan','enforceAndStampEvidence','captureVerificationFreshness','causalDigest','store','readOwnerLease','root','executionImplementationIdentity','isSplitVerificationReceipt','executionMatchesPlan','validateVerificationReceipt','createCausalPublicationRecovery'];
let implementation='implementation-A',plan,request,executionReads=[],pending,failPlan=false,drift=false,directReads=0;
const recovery=new Function(...recoveryDependencies,'return ('+recoveryExpression+');')(
 ()=>{plan=failPlan?undefined:{executionKey:'execution-'+implementation,preparedIdentity:{implementationDigest:implementation}};return plan;},
 async(_item,_input,deps)=>{executionReads.push({implementation,shared:deps.sharedExecutionReceipt});await Promise.resolve();return {evidencePatch:{result:'fail'}};},
 ()=>{if(drift)implementation='implementation-B';return {};},
 value=>{request=value;return JSON.stringify(value);},
 {readChecklist:()=>({items:[]}),storyDirPath:()=>'.',readPendingPublication:()=>pending},
 ()=>({leaseId:'lease'}),process.cwd(),()=>{directReads++;return {digest:implementation};},
 ()=>false,()=>false,()=>({ok:false}),()=>{throw Error('failure must not create recovery authority');}
);
const recoveryArgs=[{id:'item'},{intentRef:'intent'},{cwd:process.cwd(),storyId:'story'}];
await recovery(...recoveryArgs);assert.equal(request.implementationDigest,plan.preparedIdentity.implementationDigest);assert.equal(directReads,0,'request key consumes its plan observation');
drift=true;await recovery(...recoveryArgs);assert.equal(request.implementationDigest,'implementation-A','request binds the same snapshot as executionKey');assert.equal(executionReads.at(-1).implementation,'implementation-B','execution independently observes intervening mutation');
drift=false;await recovery(...recoveryArgs);assert.equal(request.implementationDigest,'implementation-B','next recovery call obtains a fresh plan');
pending={publication:{receipt:{}}};const count=executionReads.length;await assert.rejects(recovery(...recoveryArgs),/publication_recovery_invalid/);assert.equal(executionReads.length,count,'invalid pending receipt cannot reach execution');
pending=undefined;failPlan=true;await recovery(...recoveryArgs);assert.equal(executionReads.length,count+1,'no-plan fallback still delegates');
console.log('RECOVERY_REQUEST_OBSERVATION_BOUNDARIES PASS snapshot coherence, intervening drift reaches execution, fresh next call, invalid pending refusal, fallback');
let sharedGuard;
function findSharedGuard(n){if(ts.isIfStatement(n)&&n.thenStatement.getText(compiledAst).includes('[verification_shared_execution_identity_mismatch]'))sharedGuard=n.getText(compiledAst);ts.forEachChild(n,findSharedGuard);}findSharedGuard(compiledAst);
assert.ok(sharedGuard);
const checkShared=new Function('sharedExecution','pinCommand','deps','effectiveTimeoutMs','sharedIdentity',sharedGuard);
const currentReceipt={command:'node --version',cwd:process.cwd(),effectiveTimeoutMs:2000,executionIdentityDigest:'current'};
const checkReceipt=receipt=>checkShared(receipt,'node --version',{cwd:process.cwd()},2000,{executionIdentityDigest:'current'});
assert.doesNotThrow(()=>checkReceipt(currentReceipt));
for(const patch of [{executionIdentityDigest:'old'},{command:'node different.js'},{cwd:'/different'},{effectiveTimeoutMs:1000}])assert.throws(()=>checkReceipt({...currentReceipt,...patch}),/verification_shared_execution_identity_mismatch/);
console.log('RECOVERY_SHARED_RECEIPT_GUARD PASS actual compiled guard rejects stale identity, command, cwd and unauthorized timeout');
