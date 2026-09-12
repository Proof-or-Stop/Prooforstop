import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createStaticSourceEvidence} from './static-source-evidence.mjs';

const files=['package.json','package-lock.json','packages/main/package.json','packages/main/package-lock.json',
 'packages/main/src/core/proof-or-stop-brand.ts','packages/lab/package-lock.json','packages/utils/package-lock.json'];
const manifestFile='scripts/lab/u18-static-edges/exceptions.json';
const hash=text=>createHash('sha256').update(text).digest('hex');
const read=(root,file)=>fs.readFileSync(path.join(root,file),'utf8');

function assertVersionOnly(file,before,after,from,to) {
 if(file.endsWith('.ts')) {
  const declaration=`export const PROOF_OR_STOP_CLI_VERSION = '${from}'`;
  assert.equal(before.split(declaration).length,2,'version declaration must be unique');
  assert.equal(after,before.replace(declaration,`export const PROOF_OR_STOP_CLI_VERSION = '${to}'`),'only the CLI version declaration may change');
  return;
 }
 const oldLines=before.split('\n'),newLines=after.split('\n');
 assert.equal(newLines.length,oldLines.length,'version refresh refuses source line movement');
 assert(newLines.every((line,i)=>line===oldLines[i]||line===oldLines[i].replaceAll(JSON.stringify(from),JSON.stringify(to))),
  'version refresh refuses source formatting changes');
 const old=JSON.parse(before),next=JSON.parse(after);
 for(const key of ['version','packages']) {
  if(key==='version' && old.version!==next.version) {
   assert.equal(old.version,from);assert.equal(next.version,to);old.version=to;
  }
  if(key==='packages')for(const name of ['', '../main']) {
   if(old.packages?.[name]?.version!==next.packages?.[name]?.version) {
    assert.equal(old.packages?.[name]?.version,from);assert.equal(next.packages?.[name]?.version,to);
    old.packages[name].version=to;
   }
  }
 }
 assert.deepEqual(next,old,'version evidence refresh refuses non-version package changes');
}

/** Lab-only version transaction: refresh already-valid evidence, never its rationale. */
export function withLabVersionSourceEvidence(root,bump) {
 const before=new Map(files.filter(file=>fs.existsSync(path.join(root,file))).map(file=>[file,read(root,file)]));
 const manifestBefore=fs.existsSync(path.join(root,manifestFile))?read(root,manifestFile):null;
 try {
  const result=bump();
  assert(typeof result.from==='string'&&typeof result.to==='string'&&/^\d+\.\d+\.\d+$/.test(result.from)&&/^\d+\.\d+\.\d+$/.test(result.to),'malformed patch version');
  const from=result.from.split('.').map(Number),to=result.to.split('.').map(Number);
  assert(from.length===3&&to.length===3&&from.every(Number.isSafeInteger)&&to.every(Number.isSafeInteger)
   &&from[0]===to[0]&&from[1]===to[1]&&to[2]===from[2]+1,'only an official patch bump can refresh source evidence');
  assert(Array.isArray(result.files)&&result.files.every(file=>files.includes(file)),'unexpected version output path');
  const changed=new Map();
  for(const [file,text] of before) {
   const after=read(root,file);
   if(after===text)continue;
   assert(result.files.includes(file),'undeclared version output');
   assertVersionOnly(file,text,after,result.from,result.to);
   changed.set(file,{before:text,after,oldHash:hash(text),newHash:hash(after)});
  }
  if(manifestBefore===null)return result;
  assert.equal(read(root,manifestFile),manifestBefore,'version producer cannot modify source evidence');
  const manifest=JSON.parse(manifestBefore);
  assert.equal(manifest.schema,'u18-static-exceptions.v1');assert(Array.isArray(manifest.entries));
  let refreshed=false;
  for(const entry of manifest.entries) {
   const source=changed.get(entry.key?.match(/^(.*):\d+:[^:]+$/)?.[1]);
   if(source && entry.sourceDigest!==undefined) {
    assert.equal(entry.sourceDigest,source.oldHash,'stale exception source requires review before version bump');
    entry.sourceDigest=source.newHash;refreshed=true;
   }
   for(const evidence of entry.requiredEvidence??[]) {
    if(evidence&&typeof evidence==='object'&&Object.hasOwn(evidence,'historical'))assert(typeof evidence.historical==='boolean','source evidence historical flag malformed');
    if(!evidence||typeof evidence!=='object'||evidence.historical===true)continue;
    const source=changed.get(evidence.file);if(!source)continue;
    assert.equal(evidence.sourceDigest,source.oldHash,'stale source evidence requires review before version bump');
    const lines=source.before.split('\n');
    assert(Number.isSafeInteger(evidence.startLine)&&Number.isSafeInteger(evidence.endLine)
      &&evidence.startLine>=1&&evidence.endLine>=evidence.startLine&&evidence.endLine<=lines.length,'invalid source evidence range');
    assert.equal(evidence.excerpt,lines.slice(evidence.startLine-1,evidence.endLine).join('\n'),'stale excerpt requires review before version bump');
    Object.assign(evidence,createStaticSourceEvidence(root,evidence.file,evidence.startLine,evidence.endLine));
    refreshed=true;
   }
   for(const [file,source] of changed)if(Object.hasOwn(entry.dependencyDigests??{},file)) {
    assert.equal(entry.dependencyDigests[file],source.oldHash,'stale dependency requires review before version bump');
    entry.dependencyDigests[file]=source.newHash;refreshed=true;
   }
  }
  if(!refreshed)return result;
  // Preserve the existing ASCII JSON encoding, including surrogate pairs in excerpts.
  const content=JSON.stringify(manifest,null,2).replace(/[\u007f-\uffff]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'))+'\n';
  fs.writeFileSync(path.join(root,manifestFile),content);
  return {...result,files:[...result.files,manifestFile]};
 } catch(error) {
  for(const [file,text] of before)fs.writeFileSync(path.join(root,file),text);
  if(manifestBefore!==null)fs.writeFileSync(path.join(root,manifestFile),manifestBefore);
  throw error;
 }
}
