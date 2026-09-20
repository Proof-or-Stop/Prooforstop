import './lab-source-loader.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import ts from 'typescript';
registerHooks({load(url,ctx,next){if(url.endsWith('.ts'))return{format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText};return next(url,ctx);}});
const {SHARED_PROVIDER_QUOTA_RUNTIME_POLICY:policy}=await import('../packages/main/src/core/runtime-fact-registry.ts');
const {PROVIDER_EXECUTION_SURFACES:inventory}=await import('../packages/main/src/core/provider-process-registry.ts');
const {assertProviderExecutionInventoryContract}=await import('../packages/main/src/tasks/provider-execution-inventory-contract.ts');
assertProviderExecutionInventoryContract(fileURLToPath(new URL('../packages/main/src',import.meta.url)));
const paths=inventory.filter(row=>['managed','admission_only'].includes(row.status)).map(row=>row.path);
function requireCoverage(paths){for(const path of paths)assert.ok(policy.coverage[path],'UNREGISTERED_SHARED_QUOTA_OWNER: '+path);}
requireCoverage(paths);
assert.throws(()=>requireCoverage([...paths,'core/new-provider-launch.ts']),/UNREGISTERED_SHARED_QUOTA_OWNER/);
function checkCalls(source,names,path){
 const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);const found=new Set();
 function walk(n){if(ts.isCallExpression(n)&&ts.isIdentifier(n.expression)){found.add(n.expression.text);if(n.expression.text==='runSupervisedProviderProcess'){const options=n.arguments[2];assert.ok(options&&ts.isObjectLiteralExpression(options),'QUOTA_CONTEXT_MISSING: '+path);const keys=new Set(options.properties.map(p=>p.name?.getText(ast)));for(const key of ['budgetRoot','budgetEnv'])assert.ok(keys.has(key),'QUOTA_CONTEXT_MISSING: '+path+':'+key);}}ts.forEachChild(n,walk);}walk(ast);
 for(const name of names)assert.ok(found.has(name),`QUOTA_OWNER_CALL_MISSING: ${path}:${name}`);
}
for(const [path,names] of Object.entries(policy.coverage)){
 const source=readFileSync(new URL('../packages/main/src/'+path,import.meta.url),'utf8');checkCalls(source,names,path);
 if(names.includes('runSupervisedProviderProcess'))for(const key of ['budgetRoot','budgetEnv'])assert.throws(()=>checkCalls(source.replaceAll(key+':',key+'_removed:'),names,path),/QUOTA_CONTEXT_MISSING/);
 for(const name of names){
  const mutated=source.replaceAll(name+'(',name+'_removed(');
  assert.throws(()=>checkCalls(mutated,names,path),/QUOTA_OWNER_CALL_MISSING/);
 }
}
checkCalls(readFileSync(new URL('./lab-audit.mjs',import.meta.url),'utf8'),['runWithProviderCallBudgetAsync'],'scripts/lab-audit.mjs');
const worker=readFileSync(new URL('../packages/main/src/core/managed-host-run.ts',import.meta.url),'utf8');
assert.match(worker,/sharedCallQuota,[\s\S]*?durationEstimate:/,'quota context must be serialized with the spec');
assert.match(worker,/usageEnv: quotaEnvironment/,'worker must consume restored context');
const behavior=readFileSync(new URL('./verify-benchmark-behavior.mjs',import.meta.url),'utf8');
assert.ok(behavior.includes("'scripts/verify-shared-provider-quota.mjs'"),'routine verifier must own the regression');
console.log('SHARED_QUOTA_COVERAGE_GREEN registered execution inventory, AST call sites, missing-owner and removed-call mutations');
