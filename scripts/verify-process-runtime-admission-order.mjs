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
const dependencies=['root','failures','commandPolicyPath','storyRuntimeAdmissionPath','ALL_PHASES','builtCommandPolicyModule','_sourceFileCache','cachedCommandPolicyEntries'];
for(const name of dependencies){
 const index=statements.findIndex(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>ts.isIdentifier(d.name)&&d.name.text===name));
 assert(index>=0&&index<oracleIndex,`${name} must initialize before actual oracle`);
}
const scratch=mkdtempSync(join(tmpdir(),'process-admission-order-'));
try {
 const preload=join(scratch,'observer.cjs');
 writeFileSync(preload,`const cp=require('node:child_process');const {syncBuiltinESMExports}=require('node:module');const {join}=require('node:path');const original=cp.execFileSync;const proofs=new Map([['regression.mjs','ACCEPTANCE_CLOSURE_GREEN'],['publication-snapshot.mjs','PUBLICATION_SNAPSHOT_GREEN'],['publication-lifecycle.mjs','PUBLICATION_LIFECYCLE_GREEN']].map(([file,marker])=>[join(process.cwd(),'experiments/acceptance-closure',file),marker]));cp.execFileSync=function(file,args,...rest){if(file===process.execPath&&Array.isArray(args)&&args.length===1&&proofs.has(args[0])){process.stderr.write('ORDER_OBSERVED_POSITIVE\\n');}return Reflect.apply(original,this,[file,args,...rest]);};syncBuiltinESMExports();\n`);
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
 console.log('PASS process runtime admission order: actual refusal precedes positive proofs; dependencies and failure barrier retained');
} finally {rmSync(scratch,{recursive:true,force:true});}
