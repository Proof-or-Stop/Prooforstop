import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import crypto from 'node:crypto';import {createRequire} from 'node:module';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('..',import.meta.url)),root=fs.mkdtempSync(path.join(os.tmpdir(),'u18-static-boundaries-'));
try{
 fs.writeFileSync(path.join(root,'package.json'),'{}');fs.mkdirSync(path.join(root,'node_modules'));fs.symlinkSync(path.dirname(createRequire(path.join(repo,'package.json')).resolve('typescript/package.json')),path.join(root,'node_modules/typescript'),'dir');
 const commands=[{command:'node',args:['a.mjs']},{command:'node',args:['b.mjs']}];fs.writeFileSync(path.join(root,'proof-or-stop.config.json'),JSON.stringify({validate:{commands}}));fs.writeFileSync(path.join(root,'b.mjs'),'');const manifest=path.join(root,'exceptions.json');fs.writeFileSync(manifest,JSON.stringify({entries:[],configDigest:crypto.createHash('sha256').update(JSON.stringify(commands)).digest('hex')}));
 const cases={alias:"import {spawn} from 'node:child_process';const launch=spawn;launch(process.execPath,['b.mjs']);",mutable:"import {spawn} from 'node:child_process';let target='ordinary.mjs';target='b.mjs';spawn(process.execPath,[target]);",arrayWrite:"import {spawn} from 'node:child_process';const args=['ordinary.mjs'];args[0]='b.mjs';spawn(process.execPath,args);",npm:"import {spawn} from 'node:child_process';spawn('npm',['run','registered']);"};
 for(const [name,source]of Object.entries(cases)){
  fs.writeFileSync(path.join(root,'a.mjs'),source);const result=spawnSync(process.execPath,[path.join(repo,'scripts/verify-validation-static-edges.mjs'),root,manifest],{encoding:'utf8'});
  assert.equal(result.status,1,'U18_STATIC_ALIAS_MUST_BE_REJECTED '+name+' '+result.stdout+result.stderr);assert.match(result.stdout,/U18_STATIC_NEEDS_REVIEW/);console.log('PASS static refusal '+name);
 }
 console.log('U18_STATIC_EDGE_BOUNDARIES_PASS');
}finally{fs.rmSync(root,{recursive:true,force:true});}
