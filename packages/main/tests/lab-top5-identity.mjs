import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {prepareVerificationExecutionIdentity}=await import(pathToFileURL(path.resolve('packages/main/dist/core/verification-execution-evidence.js')));
const scratch=fs.mkdtempSync(path.join(tmpdir(),'top5-identity-'));
const nodePath=fs.realpathSync(process.execPath),originalRead=fs.readFileSync,originalPath=process.env.PATH;
let nodeReads=0;
try {
  fs.writeFileSync(path.join(scratch,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'src',rootDir:'.'}));
  fs.mkdirSync(path.join(scratch,'src'));fs.writeFileSync(path.join(scratch,'src/a.js'),'export const a=1;\n');
  for(const args of [['init','-b','main'],['config','user.email','smoke@example.test'],['config','user.name','Performance Smoke'],['add','.'],['commit','-m','seed']]) {
    const result=spawnSync('git',args,{cwd:scratch,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  }
  fs.readFileSync=(file,...args)=>{if(typeof file==='string'&&file===nodePath)nodeReads++;return originalRead(file,...args);};syncBuiltinESMExports();
  const input={command:'node --version',cwd:scratch,effectiveTimeoutMs:2000};
  const started=performance.now();const first=prepareVerificationExecutionIdentity(input);const firstReads=nodeReads;
  nodeReads=0;const second=prepareVerificationExecutionIdentity(input);const secondReads=nodeReads;
  assert.equal(first.toolchainDigest,second.toolchainDigest,'unchanged observation preserves identity');
  assert.ok(firstReads>0&&secondReads>0,'separate observations must physically reread Node');
  const fake=path.join(scratch,'fake');fs.mkdirSync(fake);const fakeNode=path.join(fake,'node');
  fs.writeFileSync(fakeNode,'#!/bin/sh\necho one\n',{mode:0o755});process.env.PATH=fake+path.delimiter+originalPath;
  const before=prepareVerificationExecutionIdentity(input),stat=fs.statSync(fakeNode);
  fs.writeFileSync(fakeNode,'#!/bin/sh\necho two\n');fs.utimesSync(fakeNode,stat.atime,stat.mtime);
  const after=prepareVerificationExecutionIdentity(input);
  assert.notEqual(before.toolchainDigest,after.toolchainDigest,'same-size restored-mtime executable changes are reread');
  console.log('TOP5_IDENTITY_PROFILE '+JSON.stringify({firstReads,secondReads,durationMs:performance.now()-started,freshByteDrift:true}));
  assert.equal(firstReads,1,'TOP5_1_RED: one identity observation rereads the same Node binary');
  assert.equal(secondReads,1,'every separate identity observation rereads exactly once');
  const {withExecutableDigestObservation,readObservedExecutableDigest}=await import(pathToFileURL(path.resolve('packages/main/dist/core/executable-digest-observation.js')));
  let captured;
  assert.throws(()=>withExecutableDigestObservation(()=>{captured=readObservedExecutableDigest(fakeNode);throw new Error('abort-observation');}),/abort-observation/);
  fs.writeFileSync(fakeNode,'#!/bin/sh\necho tri\n');
  assert.notEqual(readObservedExecutableDigest(fakeNode),captured,'throwing observations release their bytes');
  await withExecutableDigestObservation(async()=>{
    const old=readObservedExecutableDigest(fakeNode);
    await Promise.resolve();
    fs.writeFileSync(fakeNode,'#!/bin/sh\necho end\n');
    assert.notEqual(readObservedExecutableDigest(fakeNode),old,'no observation survives an await');
  });
  console.log('TOP5_1_IDENTITY_GREEN');
} finally {
  fs.readFileSync=originalRead;syncBuiltinESMExports();
  if(originalPath===undefined)delete process.env.PATH;else process.env.PATH=originalPath;
  fs.rmSync(scratch,{recursive:true,force:true});
}
