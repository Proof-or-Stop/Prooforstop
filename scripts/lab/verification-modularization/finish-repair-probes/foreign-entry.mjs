import fs from 'node:fs';import {join,dirname,resolve} from 'node:path';import {tmpdir} from 'node:os';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';import assert from 'node:assert/strict';
import ts from 'typescript';
const {modularIdentityChildClosure}=await import(pathToFileURL(resolve(process.argv[2])).href);
const root=fs.mkdtempSync(join(tmpdir(),'foreign-identity-closure-'));
const file='packages/main/tests/canonical-new-story-artifacts/runner.mjs',entry='packages/main/tests/canonical-new-story-artifacts.test.mjs';
const text='export function dormantChild(){ return 1; }\n';
try{
 fs.mkdirSync(dirname(join(root,file)),{recursive:true});fs.writeFileSync(join(root,file),text);
 const ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
 const contract={modular:{families:{[entry]:[file]},sourceDigests:{[file]:createHash('sha256').update(text).digest('hex')}},groups:[],launches:[]};
 const args={ts,file,text,ast,argv:[],contract,root};
 const owned=modularIdentityChildClosure({...args,entry});assert.equal(owned.errors.length,0);assert.equal(owned.shouldSkip(ast.statements[0]),true,'known entry retains its closed reachability optimization');
 const foreign=modularIdentityChildClosure({...args,entry:'scripts/foreign-entry.mjs'});
 assert.equal(foreign?.shouldSkip(ast.statements[0])??false,false,'FOREIGN_ENTRY_MUST_NOT_PRUNE_IDENTITY_FUNCTIONS');
 console.log('FOREIGN_ENTRY_CLOSURE_PASS knownEntryPruning=true foreignEntryFullTraversal=true');
}finally{fs.rmSync(root,{recursive:true,force:true});}
