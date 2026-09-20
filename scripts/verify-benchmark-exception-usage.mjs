// Actual checkout source; only the final paid-provider transport is intercepted.
import './lab-source-loader.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
registerHooks({ load(url, context, next) {
  if (url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
    source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText };
  return next(url, context);
} });
const {runHostRun,HOST_RUN_RETAINED_LINE_CAP}=await import('../packages/main/src/core/host-run.ts');
const {resolveLedgerPath,verifyLedgerChain}=await import('../packages/main/src/core/usage-ledger/writer.ts');
const measurements={};
async function check(name,chunks,host='codex'){
 const root=mkdtempSync(join(tmpdir(),'exception-usage-'));
 try{
  await assert.rejects(runHostRun({root,cwd:root,host,storyId:null,agentType:'lab',promptText:'bounded',env:{},recordedAt:new Date().toISOString(),projectRootHash:'sha256:lab'},
   {runner:async plan=>{for(const chunk of chunks)plan.onChunk?.(chunk);throw Error('transport failed after output');}}),/transport failed after output/);
  const rows=verifyLedgerChain(resolveLedgerPath(root));const last=rows.at(-1);
  measurements[name]={rows:rows.length,source:last.usage.source,input:last.usage.inputTokens,cache:last.usage.cacheReadInputTokens,output:last.usage.outputTokens};
 }finally{rmSync(root,{recursive:true,force:true});}
}
const line=JSON.stringify({type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:4,output_tokens:2}})+'\n';
await check('reportedBeforeThrow',[{stream:'stdout',text:line.slice(0,25)},{stream:'stdout',text:line.slice(25)}]);
await check('noUsage',[]);
await check('stderrIsNotUsage',[{stream:'stderr',text:line}]);
await check('laterTruncation',[{stream:'stdout',text:line},{stream:'stdout',text:'x'.repeat(HOST_RUN_RETAINED_LINE_CAP+1)+'\n'}]);
await check('claudeReported',[{stream:'stdout',text:JSON.stringify({type:'result',usage:{input_tokens:7,cache_read_input_tokens:3,output_tokens:2}})+'\n'}],'claude');
console.log('EXCEPTION_USAGE_MEASUREMENTS '+JSON.stringify(measurements));
assert.equal(measurements.reportedBeforeThrow.source,'provider-reported','REPORTED_USAGE_LOST: preserve real usage received before an exception');
assert.equal(measurements.reportedBeforeThrow.input,6);assert.equal(measurements.reportedBeforeThrow.cache,4);assert.equal(measurements.reportedBeforeThrow.output,2);
assert.equal(measurements.claudeReported.source,'provider-reported');assert.equal(measurements.claudeReported.input,7);
for(const name of ['noUsage','stderrIsNotUsage','laterTruncation']){assert.equal(measurements[name].source,'unavailable');assert.equal(measurements[name].input,null);}
console.log('EXCEPTION_USAGE_GREEN real host entry; no paid model calls');
