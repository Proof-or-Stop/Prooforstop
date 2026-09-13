import './lab-source-loader.mjs';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerHooks} from 'node:module';
import ts from 'typescript';
registerHooks({load(url,context,next){if(url.endsWith('.ts'))return {format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText};return next(url,context);}});
const {runSingleAllowlistedCommand}=await import('../packages/main/src/core/validation-executor.ts');
const started=performance.now();
const scratch=mkdtempSync(join(tmpdir(),'nested-verification-owner-'));
const loader=join(scratch,'source-loader.mjs');
writeFileSync(loader,`import ${JSON.stringify(new URL('./lab-source-loader.mjs',import.meta.url).href)};import {registerHooks} from 'node:module';import {readFileSync} from 'node:fs';import ts from ${JSON.stringify(import.meta.resolve('typescript'))};registerHooks({load(url,context,next){if(url.endsWith('.ts'))return {format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText};return next(url,context);}});`);
const executor=new URL('../packages/main/src/core/validation-executor.ts',import.meta.url).href;
const isolation=new URL('../packages/main/src/tasks/isolated-finding-fixture.ts',import.meta.url).href;
try {
  writeFileSync(join(scratch,'package.json'),JSON.stringify({type:'module'}));
  writeFileSync(join(scratch,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'.',rootDir:'.'}));
  const direct=await runSingleAllowlistedCommand('node -e "console.log(12345)"',scratch,{timeoutMs:1500});
  assert.equal(direct.code,0,'DIRECT_EXECUTOR_POSITIVE_REQUIRED');
  assert.match(direct.output,/12345/);
  const entry=join(scratch,'finding-material-reattestation-smoke.js');
  writeFileSync(entry,`import ${JSON.stringify(loader)};\nimport assert from 'node:assert/strict';\nconst {runIsolatedFindingFixture}=await import(${JSON.stringify(isolation)});\nconst {runSingleAllowlistedCommand}=await import(${JSON.stringify(executor)});\nif(await runIsolatedFindingFixture(import.meta.url))process.exit(0);\nconst result=await runSingleAllowlistedCommand('node -e "console.log(12345)"',${JSON.stringify(scratch)},{timeoutMs:1500});\nconsole.log('NESTED_NATIVE_EXECUTOR_RESULT '+JSON.stringify(result));\nassert.equal(result.code,0,'NESTED_VERIFICATION_MACHINE_OWNER_REQUIRED');\n`);
  const result=await runSingleAllowlistedCommand('node '+JSON.stringify(entry),scratch,{timeoutMs:15000});
  console.log(result.output);
  assert.match(result.output,/NESTED_NATIVE_EXECUTOR_RESULT/,'NESTED_FIXTURE_STARTED_REQUIRED');
  assert.equal(result.code,0,'NESTED_VERIFICATION_MACHINE_OWNER_REQUIRED');
  console.log('NESTED_VERIFICATION_MACHINE_OWNER PASS '+JSON.stringify({seconds:(performance.now()-started)/1000}));
}finally{rmSync(scratch,{recursive:true,force:true});console.log('NESTED_VERIFICATION_DIAGNOSTIC_SECONDS '+((performance.now()-started)/1000));}
