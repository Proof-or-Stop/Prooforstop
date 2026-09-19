#!/usr/bin/env node
// Ordering proof observes the actual positive subprocesses without replacing execution.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
const root=process.cwd();
const verifier=join(root,'scripts/verify-process-fact-contract.mjs');
const source=readFileSync(verifier,'utf8');
const ast=ts.createSourceFile(verifier,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const statements=ast.statements;
const calls=statements.filter(n=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&n.expression.expression.getText(ast)==='assertStoryWriterRuntimeAdmissionContract');
assert.equal(calls.length,1,'exactly one actual admission oracle invocation');
const proofLoops=statements.filter(n=>ts.isForOfStatement(n)&&n.getText(ast).includes('PUBLICATION_LIFECYCLE_GREEN'));
assert.equal(proofLoops.length,1,'all three existing proof commands remain in one loop');
const oracleIndex=statements.indexOf(calls[0]);
const loopIndex=statements.indexOf(proofLoops[0]);
const fixturePaths=[
 'packages/main/tests/codex-review-jsonl.test.mjs',
 'packages/main/tests/review-history-buffer.test.mjs',
 'packages/main/dist/tasks/managed-review-evidence-smoke.js',
 'packages/main/tests/certification-recovery-lineage.test.mjs',
 'packages/main/tests/managed-delivery-dispatch.test.mjs',
];
for(const file of fixturePaths){
 const launches=statements.filter(n=>ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)
  &&n.expression.expression.getText(ast)==='execFileSync'
  &&n.expression.arguments[0]?.getText(ast)==='process.execPath'
  &&ts.isArrayLiteralExpression(n.expression.arguments[1])
  &&n.expression.arguments[1].elements.some(e=>ts.isStringLiteral(e)&&e.text===file));
 assert.equal(launches.length,1,`exactly one retained real fixture launch: ${file}`);
 const index=statements.indexOf(launches[0]);
 assert(index>oracleIndex&&index<loopIndex,`PROCESS_REFUSAL_ORDER_RED: ${file} must execute after admission and before positive coverage proofs`);
 const barrier=statements.slice(oracleIndex+1,index).find(n=>ts.isIfStatement(n)&&n.expression.getText(ast)==='failures.length');
 assert(barrier&&barrier.getText(ast).includes('process.exit(1)'),`actual refusal barrier must precede ${file}`);
}
const dependencies=['root','failures','commandPolicyPath','storyRuntimeAdmissionPath','ALL_PHASES','builtCommandPolicyModule','_sourceFileCache','cachedCommandPolicyEntries'];
for(const name of dependencies){
 const index=statements.findIndex(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>ts.isIdentifier(d.name)&&d.name.text===name));
 assert(index>=0&&index<oracleIndex,`${name} must initialize before actual oracle`);
}
const scratch=mkdtempSync(join(tmpdir(),'process-admission-order-'));
try {
 const preload=join(scratch,'observer.cjs');
 writeFileSync(preload,`const cp=require('node:child_process');const {syncBuiltinESMExports}=require('node:module');const {join,resolve}=require('node:path');const original=cp.execFileSync;const proofs=new Set([...${JSON.stringify(fixturePaths)}.map(file=>resolve(file)),...['regression.mjs','publication-snapshot.mjs','publication-lifecycle.mjs'].map(file=>join(process.cwd(),'experiments/acceptance-closure',file))]);cp.execFileSync=function(file,args,...rest){if(file===process.execPath&&Array.isArray(args)&&args.some(arg=>typeof arg==='string'&&proofs.has(resolve(arg)))){process.stderr.write('ORDER_OBSERVED_POSITIVE\\n');}return Reflect.apply(original,this,[file,args,...rest]);};syncBuiltinESMExports();\n`);
 const result=spawnSync(process.execPath,['--require',preload,verifier,'--quiet'],{
  cwd:root,encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024,
  env:{...process.env,PROOF_OR_STOP_PROCESS_FACT_CONTRACT_MUTATION:'synthetic-story-writer-partial-runtime-admission'},
 });
 assert(!result.error&&result.signal===null,'actual refusal execution must be available within its diagnostic budget');
 assert.notEqual(result.status,0,'actual mutated admission must refuse');
 assert.match(result.stderr,/actual Story-write capability|Story runtime admission|coverage must derive from the effective ownership registry/i,'actual oracle must supply relevant refusal');
 const launches=(result.stderr.match(/ORDER_OBSERVED_POSITIVE/g)||[]).length;
 console.log(`ORDER_ACTUAL_MUTATION_REFUSED positiveProofLaunches=${launches}`);
 assert.equal(launches,0,'known actual admission refusal must precede positive proof launches');
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
