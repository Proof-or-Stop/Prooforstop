#!/usr/bin/env node
// Ordering proof observes the actual positive subprocesses without replacing execution.
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { verificationFailureMessage } from './verification-subprocess-budget.mjs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
const root=process.cwd();
const verifier=join(root,'scripts/verify-process-fact-contract.mjs');
const source=readFileSync(verifier,'utf8');
const ast=ts.createSourceFile(verifier,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const statements=ast.statements;
const allNodes=[];function collect(node){allNodes.push(node);ts.forEachChild(node,collect);}collect(ast);
const containingIndex=node=>statements.findIndex(statement=>statement.pos<=node.pos&&statement.end>=node.end);
const allLaunches=allNodes.filter(node=>ts.isCallExpression(node)&&node.expression.getText(ast)==='execFile');
const calls=statements.filter(n=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&n.expression.expression.getText(ast)==='assertStoryWriterRuntimeAdmissionContract');
assert.equal(calls.length,1,'exactly one actual admission oracle invocation');
const proofLoops=allNodes.filter(n=>ts.isForOfStatement(n)&&n.getText(ast).includes('PUBLICATION_LIFECYCLE_GREEN'));
assert.equal(proofLoops.length,1,'all three existing proof commands remain in one loop');
const oracleIndex=statements.indexOf(calls[0]);
const loopIndex=containingIndex(proofLoops[0]);
const fixturePaths=[
 'packages/main/tests/codex-review-jsonl.test.mjs',
 'packages/main/tests/review-history-buffer.test.mjs',
 'packages/main/dist/tasks/managed-review-evidence-smoke.js',
 'packages/main/tests/certification-recovery-lineage.test.mjs',
 'packages/main/tests/managed-delivery-dispatch.test.mjs',
];
for(const file of fixturePaths){
 const launches=allLaunches.filter(n=>n.arguments[0]?.getText(ast)==='process.execPath'
  &&ts.isArrayLiteralExpression(n.arguments[1])
  &&n.arguments[1].elements.some(e=>ts.isStringLiteral(e)&&e.text===file));
 assert.equal(launches.length,1,`exactly one retained real fixture launch: ${file}`);
 const index=containingIndex(launches[0]);
 assert(index>oracleIndex&&launches[0].getStart(ast)<proofLoops[0].getStart(ast),`PROCESS_REFUSAL_ORDER_RED: ${file} must execute after admission and before positive coverage proofs`);
 const expectedTimeout=file.endsWith('managed-delivery-dispatch.test.mjs')?180000:file.endsWith('codex-review-jsonl.test.mjs')||file.endsWith('review-history-buffer.test.mjs')?30000:120000;
 const timeout=launches[0].arguments[2].properties.find(property=>property.name?.getText(ast)==='timeout');
 assert.equal(Number(timeout?.initializer.getText(ast)),expectedTimeout,'positive fixture timeout remains unchanged');
 const barrier=statements.slice(oracleIndex+1,index).find(n=>ts.isIfStatement(n)&&n.expression.getText(ast)==='failures.length');
 assert(barrier&&barrier.getText(ast).includes('process.exit(1)'),`actual refusal barrier must precede ${file}`);
}
const inventoryFixture='scripts/verify-inventory-critic-metadata-head.mjs';
const inventoryLaunches=allLaunches.filter(n=>n.getText(ast).includes(`join(root, '${inventoryFixture}')`));
assert.equal(inventoryLaunches.length,1,'PROCESS_REFUSAL_ORDER_RED: inventory critic proof must be a retained top-level positive workload');
const inventoryIndex=containingIndex(inventoryLaunches[0]);
assert(inventoryIndex>oracleIndex&&inventoryIndex<loopIndex,'inventory critic proof must run after admission and before acceptance proofs');
assert(statements.slice(oracleIndex+1,inventoryIndex).some(n=>ts.isIfStatement(n)&&n.expression.getText(ast)==='failures.length'&&n.getText(ast).includes('process.exit(1)')),'inventory critic proof requires the actual refusal barrier');
assert(source.includes('await Promise.allSettled([inventoryCriticProof, remainingPositiveProofs])')&&source.includes("nodeAssert.equal(completedPositiveProofs, 9,"),'all nine actual completions and both bounded lanes must be observed');
// Focused boundary concurrency retains the two exact real commands and
// original budgets after admission. Every outcome must settle before continuing.
const boundaryFixtures = [
 ['scripts/verify-reviewer-read-boundaries.mjs', 'REVIEWER_READ_BOUNDARY_GREEN'],
 ['scripts/verify-maintenance-preview-boundaries.mjs', 'MAINTENANCE_PREVIEW_GREEN'],
];
const boundaryGroup = statements.find(node => ts.isVariableStatement(node)
 && node.declarationList.declarations.some(d => d.name.getText(ast) === 'boundaryProofResults'));
const boundaryInitializer=boundaryGroup?.declarationList.declarations[0].initializer;
assert(boundaryInitializer&&ts.isAwaitExpression(boundaryInitializer),'boundary group must actually await');
const boundaryAwaited=boundaryInitializer.expression;
assert(ts.isCallExpression(boundaryAwaited)&&boundaryAwaited.expression.getText(ast)==='Promise.allSettled'
 &&ts.isArrayLiteralExpression(boundaryAwaited.arguments[0])&&boundaryAwaited.arguments[0].elements.length===2,
 'both and only the two actual boundary outcomes must settle');
for (const [file, marker] of boundaryFixtures) {
 const launches=allLaunches.filter(node=>node.getText(ast).includes(`join(root, '${file}')`));
 assert.equal(launches.length,1,'one actual retained boundary child: '+file);
 const launch=launches[0];assert.equal(containingIndex(launch),statements.indexOf(boundaryGroup));
 assert.equal(launch.arguments[0].getText(ast),'process.execPath');
 assert.equal(Number(launch.arguments[2].properties.find(p=>p.name?.getText(ast)==='timeout')?.initializer.getText(ast)),450000);
 assert(launch.arguments[3].getText(ast).includes('boundaryProofCompletion(')&&launch.arguments[3].getText(ast).includes(marker));
 assert(containingIndex(launch)>oracleIndex,'admission refusal must precede focused boundary launches');
}
assert(source.includes("if (result.status === 'rejected') assert(false, String(result.reason))"), 'any failed boundary must reach the verifier failure gate');
const boundaryCompletion=statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='boundaryProofCompletion');
assert(boundaryCompletion,'actual boundary completion callback must exist');
const boundaryCallback=runInNewContext(boundaryCompletion.getText(ast)+';boundaryProofCompletion', {nodeAssert:assert,verificationFailureMessage});
for (const [script,marker,timeout,refusal] of [
 ["console.log('BOUNDARY_CONTROL_GREEN')",'BOUNDARY_CONTROL_GREEN',5000,null],
 ["console.log('BOUNDARY_CONTROL_GREEN');process.exit(7)",'BOUNDARY_CONTROL_GREEN',5000,/PROOF_ASSERTION_FAILED/],
 ["console.log('different suite')",'BOUNDARY_CONTROL_GREEN',5000,/requires its exact completion selector/],
 ["setInterval(()=>{},1000)",'BOUNDARY_CONTROL_GREEN',100,/PROOF_UNAVAILABLE/],
 ["console.log('BOUNDARY_CONTROL_GREEN')",'BOUNDARY_CONTROL_GREEN',5000,null],
]) {
 const execution=new Promise((resolve,reject)=>execFile(process.execPath,['-e',script],{encoding:'utf8',timeout},boundaryCallback(resolve,reject,'actual boundary control',marker)));
 if(refusal)await assert.rejects(execution,refusal);else await execution;
}
// Actual early failure must not prevent observing a slower successful peer.
let drained=false;
const drainage=await Promise.allSettled([
 new Promise((resolve,reject)=>execFile(process.execPath,['-e',"process.exit(7)"],{encoding:'utf8',timeout:5000},boundaryCallback(resolve,reject,'failed peer','BOUNDARY_CONTROL_GREEN'))),
 new Promise((resolve,reject)=>execFile(process.execPath,['-e',"setTimeout(()=>console.log('BOUNDARY_CONTROL_GREEN'),100)"],{encoding:'utf8',timeout:5000},boundaryCallback(resolve,reject,'slower peer','BOUNDARY_CONTROL_GREEN'))).then(()=>{drained=true;}),
]);
assert.equal(drainage[0].status,'rejected');assert.equal(drainage[1].status,'fulfilled');assert(drained);
console.log('PROCESS_BOUNDARY_CALLBACK_CONTROLS_PASS five real children and both peer outcomes');
const dependencies=['root','failures','commandPolicyPath','storyRuntimeAdmissionPath','ALL_PHASES','builtCommandPolicyModule','_sourceFileCache','cachedCommandPolicyEntries'];
for(const name of dependencies){
 const index=statements.findIndex(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>ts.isIdentifier(d.name)&&d.name.text===name));
 assert(index>=0&&index<oracleIndex,`${name} must initialize before actual oracle`);
}
// Exercise the actual completion callback with real successful, failed,
// selector-missing and timed-out children. No narrative completion can count.
const completion=statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='positiveProofCompletion');
assert(completion,'the actual positive child completion verifier must exist');
let controlOutput='';
const completionSubject=runInNewContext('let completedPositiveProofs=0;'+completion.getText(ast)+';({callback:positiveProofCompletion,count:()=>completedPositiveProofs})',{
 nodeAssert:assert,verificationFailureMessage,process:{stdout:{write:value=>{controlOutput+=value;}},stderr:{write:value=>{controlOutput+=value;}}},
});
for(const [script,marker,timeout,refusal] of [
 ["console.log('COMPLETION_CONTROL_GREEN')",'COMPLETION_CONTROL_GREEN',5000,null],
 ["console.log('COMPLETION_CONTROL_GREEN');process.exit(7)",'COMPLETION_CONTROL_GREEN',5000,/PROOF_ASSERTION_FAILED/],
 ["console.log('different suite')",'COMPLETION_CONTROL_GREEN',5000,/requires its exact completion selector/],
 ["setInterval(()=>{},1000)",'COMPLETION_CONTROL_GREEN',100,/PROOF_UNAVAILABLE/],
 ["console.log('COMPLETION_CONTROL_GREEN')",'COMPLETION_CONTROL_GREEN',5000,null],
]) {
 const before=completionSubject.count();
 const execution=new Promise((resolve,reject)=>execFile(process.execPath,['-e',script],{encoding:'utf8',timeout},completionSubject.callback(resolve,reject,'actual completion control',marker,true)));
 if(refusal){await assert.rejects(execution,refusal);assert.equal(completionSubject.count(),before,'failed or unavailable child cannot count as complete');}
 else {await execution;assert.equal(completionSubject.count(),before+1);}
}
assert.equal(completionSubject.count(),2);assert.equal((controlOutput.match(/COMPLETION_CONTROL_GREEN/g)||[]).length,2);
console.log('PROCESS_POSITIVE_CALLBACK_CONTROLS_PASS five actual children: success, exit failure, wrong selector, timeout, restored success');
const scratch=mkdtempSync(join(tmpdir(),'process-admission-order-'));
try {
 const preload=join(scratch,'observer.cjs');
 const control=join(scratch,'observed-control.mjs');writeFileSync(control,"console.log('ORDER_CONTROL_EXECUTED');\n");
 writeFileSync(preload,`const cp=require('node:child_process');const {syncBuiltinESMExports}=require('node:module');const {join,resolve}=require('node:path');const proofs=new Set([...${JSON.stringify([...fixturePaths, inventoryFixture, ...boundaryFixtures.map(([file]) => file)])}.map(file=>resolve(file)),${JSON.stringify(control)},...['regression.mjs','publication-snapshot.mjs','publication-lifecycle.mjs'].map(file=>join(process.cwd(),'experiments/acceptance-closure',file))]);for(const api of ['execFileSync','execFile']){const original=cp[api];cp[api]=function(file,args,...rest){if(file===process.execPath&&Array.isArray(args)&&args.some(arg=>typeof arg==='string'&&proofs.has(resolve(arg))))process.stderr.write('ORDER_OBSERVED_POSITIVE\\n');return Reflect.apply(original,this,[file,args,...rest]);};}syncBuiltinESMExports();\n`);
 const calibration=spawnSync(process.execPath,['--require',preload,'--input-type=module','-e',`import{execFileSync,execFile}from'node:child_process';const args=[${JSON.stringify(control)}];process.stdout.write(execFileSync(process.execPath,args,{encoding:'utf8'}));const output=await new Promise((resolve,reject)=>execFile(process.execPath,args,{encoding:'utf8'},(error,stdout)=>error?reject(error):resolve(stdout)));process.stdout.write(output);`],{cwd:root,encoding:'utf8',timeout:10000});
 assert(!calibration.error&&calibration.signal===null&&calibration.status===0,'real observer calibration children must complete');
 assert.equal((calibration.stderr.match(/ORDER_OBSERVED_POSITIVE/g)||[]).length,2,'both sync and async subprocess observations must be live');
 assert.equal((calibration.stdout.match(/ORDER_CONTROL_EXECUTED/g)||[]).length,2,'observer calibration must execute both actual control children');
 console.log('ORDER_OBSERVER_CALIBRATION_PASS sync and async real children');
 for (const mutation of ['synthetic-story-writer-partial-runtime-admission','drop-acceptance-basis-registry']) {
 const result=spawnSync(process.execPath,['--require',preload,verifier,'--quiet'],{
  cwd:root,encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024,
  env:{...process.env,PROOF_OR_STOP_PROCESS_FACT_CONTRACT_MUTATION:mutation},
 });
 assert(!result.error&&result.signal===null,'actual refusal execution must be available within its diagnostic budget');
 assert.notEqual(result.status,0,'actual mutated admission must refuse');
 assert.match(result.stderr,mutation==='drop-acceptance-basis-registry' ? /required process fact missing/ : /actual Story-write capability|Story runtime admission|coverage must derive from the effective ownership registry/i,'actual oracle must supply relevant refusal');
 const launches=(result.stderr.match(/ORDER_OBSERVED_POSITIVE/g)||[]).length;
 console.log(`ORDER_ACTUAL_MUTATION_REFUSED mutation=${mutation} positiveProofLaunches=${launches}`);
 assert.equal(launches,0,'known actual admission refusal must precede positive proof launches');
 }
 assert(oracleIndex<loopIndex,'actual admission oracle must precede positive workloads');
 const barrier=statements.slice(oracleIndex+1,loopIndex).find(n=>ts.isIfStatement(n)&&n.expression.getText(ast)==='failures.length');
 assert(barrier,'actual failure barrier must separate oracle and positive workloads');
 const barrierText=barrier.getText(ast);
 assert(barrierText.includes('process.exit(1)'),'actual barrier must terminate nonzero');
 assert(barrierText.includes('failures.sort()'),'actual barrier must retain all sorted diagnostics');
 assert(!barrierText.includes('PASS'),'refusal cannot emit PASS');
 const registrationIndex=statements.findIndex(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>ts.isIdentifier(d.name)&&d.name.text==='admissionOrderOutput'));
 assert(registrationIndex>loopIndex,'recursive ordering witness must be unreachable until after actual refusal barrier and positive proof loop');
 console.log('PASS process runtime admission order: actual refusal precedes positive proofs; dependencies and failure barrier retained');
} finally {rmSync(scratch,{recursive:true,force:true});}
