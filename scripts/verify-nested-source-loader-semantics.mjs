// Supplemental semantic control; the five-pair startup benchmark is external.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import vm from 'node:vm';
const repo=process.cwd(),dir=mkdtempSync(join(tmpdir(),'nested-loader-semantics-'));
const compilerURL=import.meta.resolve('typescript');
const compiler=fileURLToPath(compilerURL);
const driverURL=pathToFileURL(join(repo,'scripts/verify-nested-verification-machine-owner.mjs')).href;
const source=readFileSync(new URL(driverURL),'utf8');
const template=source.match(/writeFileSync\(loader,(`[^\n]+`)\);/);
assert.ok(template,'actual generated loader template required');
const actual=vm.runInNewContext(template[1].replace("new URL('./lab-source-loader.mjs',import.meta.url)","new URL('./lab-source-loader.mjs',driverURL)").replaceAll("import.meta.resolve('typescript')",'compilerURL'),{JSON,URL,driverURL,compilerURL});
// Exact eager preimage semantics: same resolver, compiler file, bytes/options.
const eager=`import ${JSON.stringify(new URL('./lab-source-loader.mjs',driverURL).href)};import {registerHooks} from 'node:module';import {readFileSync} from 'node:fs';import ts from ${JSON.stringify(compilerURL)};registerHooks({load(url,context,next){if(url.endsWith('.ts'))return {format:'module',shortCircuit:true,source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText};return next(url,context);}});`;
function run(name,code,timeout=1500){const result=spawnSync(process.execPath,['-e',code],{cwd:repo,env:{...process.env,NODE_OPTIONS:(process.env.NODE_OPTIONS??'')+' --import='+JSON.stringify(join(dir,name+'.mjs'))},encoding:'utf8',timeout,maxBuffer:32*1024*1024});assert.equal(result.status,0,JSON.stringify({name,status:result.status,signal:result.signal,error:result.error?.code,stdout:result.stdout,stderr:result.stderr}));return result.stdout;}
try {
 writeFileSync(join(dir,'actual.mjs'),actual);writeFileSync(join(dir,'eager.mjs'),eager);
 for(const [name,expected] of [['actual',false],['eager',true]])assert.equal(run(name,`const assert=require('node:assert/strict');assert.equal(!!require.cache[${JSON.stringify(compiler)}],${expected},'PLAIN_LEAF_COMPILER_LOAD_BOUNDARY');console.log(12345);`),'12345\n');
 const observed=[];
 for(const [name,loader] of [['actual',actual],['eager',eager]]){
  // Observe emitted bytes only in this separate equivalence control.
  const prefix=loader.includes('ts().transpileModule')?'ts().transpileModule':'ts.transpileModule';
  assert.equal(loader.split('source:'+prefix).length,2);
  let instrumented="import {createHash} from 'node:crypto';globalThis.__loaderTrace=[];const record=(url,output)=>{globalThis.__loaderTrace.push([url,createHash('sha256').update(output).digest('hex')]);return output;};"+loader;
  instrumented=instrumented.replace('source:'+prefix,'source:record(url,'+prefix).replace('.outputText};','.outputText)};');
  writeFileSync(join(dir,name+'-control.mjs'),instrumented);
  const isolation=pathToFileURL(join(repo,'packages/main/src/tasks/isolated-finding-fixture.ts')).href;
  const code=`(async()=>{const value=await import(${JSON.stringify(isolation)});console.log(JSON.stringify({exports:Object.keys(value).sort(),budget:value.reviewEpochFixtureBudgetMs({},0),trace:globalThis.__loaderTrace.sort((a,b)=>a[0].localeCompare(b[0]))}));})().catch(e=>{console.error(e);process.exitCode=1;});`;
  observed.push(JSON.parse(run(name+'-control',code,10000)));
 }
 assert.ok(observed[0].trace.length>0,'actual TS graph must be exercised');
 assert.deepEqual(observed[0],observed[1]);
 console.log('NESTED_SOURCE_LOADER_SEMANTICS PASS '+JSON.stringify({emittedModules:observed[0].trace.length}));
}finally{rmSync(dir,{recursive:true,force:true});}
