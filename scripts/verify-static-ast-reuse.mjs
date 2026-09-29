import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'static-ast-compare-'));
const scanner=path.join(root,'scripts/verify-validation-static-edges.mjs');
const original=fs.readFileSync(scanner,'utf8');
const runs=[];
let completed=false;
function replaceRequired(source,needle,value){assert(source.includes(needle),'STATIC_AST_REFERENCE_PATCH_NOT_APPLIED: '+needle);return source.replace(needle,value);}
try {
 for(const arm of ['reference','candidate','helper-bypass']) {
  const counts=path.join(tmp,arm+'.counts'),report=path.join(tmp,arm+'.report');
  let source=original;
  for(const helper of ['static-source-evidence.mjs','identity-child-closure.mjs','identity-modular-child-closure.mjs']) {
   let target=path.join(root,'scripts',helper);
   if(arm==='helper-bypass' && helper==='identity-modular-child-closure.mjs') {
    // Negative control: a helper that parses on its own must be observed.
    let bypass=fs.readFileSync(target,'utf8');
    bypass=replaceRequired(bypass,'parse(name,texts[index])','ts.createSourceFile(name,texts[index],ts.ScriptTarget.Latest,true)');
    bypass=replaceRequired(bypass,'let modules=familyBindingCache.get(key);','let modules=undefined;');
    target=path.join(tmp,helper);fs.writeFileSync(target,bypass);
   }
   source=replaceRequired(source,"'./"+helper+"'",JSON.stringify(pathToFileURL(target).href));
  }
  source=replaceRequired(source,'here=path.dirname(fileURLToPath(import.meta.url))','here='+JSON.stringify(path.join(root,'scripts')));
  if(arm==='reference' && source.includes('function parseStaticSource'))source=replaceRequired(source,'const cached = parsedSourceCache.get(file);','const cached = undefined;');
  // TypeScript exports are getters, so the scanner's shared module object is
  // replaced by a proxy; helpers receive that object and cannot parse unseen.
  source=replaceRequired(source,"ts=req('typescript')","ts=new Proxy(req('typescript'),{get(target,key){return key==='createSourceFile'?observedCreateSourceFile:Reflect.get(target,key);}})");
  source='let observedCalls=0; const observedInputs=new Set(); let observedParse;\nfunction observedCreateSourceFile(...args){observedCalls++;observedInputs.add(crypto.createHash("sha256").update(String(args[0])+"\\0"+String(args[1])+"\\0"+JSON.stringify(args.slice(2))).digest("hex"));return (observedParse??=req("typescript").createSourceFile)(...args);}\n'+source+'\nfs.writeFileSync('+JSON.stringify(counts)+',JSON.stringify({calls:observedCalls,unique:observedInputs.size,maxRSSKiB:process.resourceUsage().maxRSS}));\n';
  const script=path.join(tmp,arm+'.mjs');fs.writeFileSync(script,source);
  const started=performance.now();
  const child=spawnSync(process.execPath,[script,root],{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024,env:{...process.env,U18_STATIC_REPORT_PATH:report}});
  assert.equal(child.signal,null);assert.equal(child.status,0,child.stdout+child.stderr);
  runs.push({arm,exitCode:child.status,elapsedMs:performance.now()-started,...JSON.parse(fs.readFileSync(counts,'utf8')),report:fs.readFileSync(report,'utf8')});
 }
 assert.equal(runs[0].exitCode,runs[1].exitCode);
 if(runs[0].report!==runs[1].report){
  const before=JSON.parse(runs[0].report),after=JSON.parse(runs[1].report);
  const row=before.rows.find((r,i)=>JSON.stringify(r)!==JSON.stringify(after.rows[i]));
  const field=Object.keys(before).find(key=>JSON.stringify(before[key])!==JSON.stringify(after[key]));
  assert.fail('Complete scanner report differs: '+(row?.key??field??'serialization')+'; retained reports: '+tmp);
 }
 console.log('STATIC_AST_COMPARISON '+JSON.stringify(runs.map(({report,...r})=>r)));
 assert.equal(runs[2].report,runs[1].report,'Helper-bypass control must change only parser reuse');
 assert(runs[2].calls>runs[2].unique,'STATIC_AST_HELPER_PARSE_UNOBSERVED: helper-owned parses must be counted');
 assert(runs[0].calls>runs[0].unique,'Witness must contain duplicate parser requests');
 assert.equal(runs[1].calls,runs[1].unique,'STATIC_AST_REPEATED_IDENTICAL_INPUT: parse each exact source once within the command');
 console.log('STATIC_AST_REUSE_GREEN complete report parity and bounded parser calls');
 completed=true;
}catch(error){console.error('STATIC_AST_FAILURE_ARTIFACTS '+tmp);throw error;}finally{if(completed)fs.rmSync(tmp,{recursive:true,force:true});}
