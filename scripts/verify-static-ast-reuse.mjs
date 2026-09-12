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
function replaceRequired(source,needle,value){assert(source.includes(needle),'STATIC_AST_REFERENCE_PATCH_NOT_APPLIED: '+needle);return source.replace(needle,value);}
try {
 for(const arm of ['reference','candidate']) {
  const counts=path.join(tmp,arm+'.counts'),report=path.join(tmp,arm+'.report');
  let source=original;
  // Execute current scanner source with unchanged helper imports and manifest
  // location; only the parser observer and reference cache bypass differ.
  for(const helper of ['static-source-evidence.mjs','identity-child-closure.mjs'])source=replaceRequired(source,"'./"+helper+"'",JSON.stringify(pathToFileURL(path.join(root,'scripts',helper)).href));
  source=replaceRequired(source,'here=path.dirname(fileURLToPath(import.meta.url))','here='+JSON.stringify(path.join(root,'scripts')));
  if(arm==='reference' && source.includes('function parseStaticSource'))source=replaceRequired(source,'const cached = parsedSourceCache.get(file);','const cached = undefined;');
  const occurrences=source.split('ts.createSourceFile(').length-1;
  assert.equal(occurrences,1,'STATIC_AST_PARSER_OBSERVER_SOURCE_DRIFT');
  source=source.replace('ts.createSourceFile(','observedCreateSourceFile(');
  source='let observedCalls=0; const observedInputs=new Set();\nfunction observedCreateSourceFile(...args){observedCalls++;observedInputs.add(crypto.createHash("sha256").update(String(args[0])+"\\0"+String(args[1])+"\\0"+JSON.stringify(args.slice(2))).digest("hex"));return ts.createSourceFile(...args);}\n'+source+'\nfs.writeFileSync('+JSON.stringify(counts)+',JSON.stringify({calls:observedCalls,unique:observedInputs.size,maxRSSKiB:process.resourceUsage().maxRSS}));\n';
  const script=path.join(tmp,arm+'.mjs');fs.writeFileSync(script,source);
  const started=performance.now();
  const child=spawnSync(process.execPath,[script,root],{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024,env:{...process.env,U18_STATIC_REPORT_PATH:report}});
  assert.equal(child.signal,null);assert.equal(child.status,0,child.stdout+child.stderr);
  runs.push({arm,exitCode:child.status,elapsedMs:performance.now()-started,...JSON.parse(fs.readFileSync(counts,'utf8')),report:fs.readFileSync(report,'utf8')});
 }
 assert.equal(runs[0].exitCode,runs[1].exitCode);
 assert.equal(runs[0].report,runs[1].report,'Complete scanner report must remain byte-identical');
 console.log('STATIC_AST_COMPARISON '+JSON.stringify(runs.map(({report,...r})=>r)));
 assert(runs[0].calls>runs[0].unique,'Witness must contain duplicate parser requests');
 assert.equal(runs[1].calls,runs[1].unique,'STATIC_AST_REPEATED_IDENTICAL_INPUT: parse each exact source once within the command');
 console.log('STATIC_AST_REUSE_GREEN complete report parity and bounded parser calls');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
