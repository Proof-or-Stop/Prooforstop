import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {spawnSync,execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const root=mkdtempSync(join(tmpdir(),'pos-activity-identity-'));
const env={...process.env};for(const key of ['PROOF_OR_STOP_IMPLEMENTATION_MANIFEST','PROOF_OR_STOP_EXPECTED_IMPLEMENTATION_DIGEST','PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN','PROOF_OR_STOP_ACTIVITY_RECORD_READONLY'])delete env[key];
const run=(entry,args,extra={})=>spawnSync(process.execPath,[entry,...args],{cwd:root,env:{...env,...extra},encoding:'utf8',maxBuffer:8*1024*1024});
const log=join(root,'.proof-or-stop/activity.jsonl');let failures=0;
try {
 execFileSync('git',['init','-q','-b','main'],{cwd:root});
 writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'.',rootDir:'src',storyDir:'.proof-or-stop/story/actives'}));
 writeFileSync(join(root,'README.md'),'# Private identity observation\n');
 const entry=join(repo,'bin/proof-or-stop.js');
 const query=['--root',root,'aux_doc_list'];
 let result=run(entry,query,{PROOF_OR_STOP_ACTIVITY_RECORD_READONLY:'0'});assert.equal(result.status,0,result.stderr);assert.equal(existsSync(log),false,'read-only query must not gain a new write');console.log('PASS read-only policy remains unchanged');
 const initial=run(entry,query,{PROOF_OR_STOP_ACTIVITY_RECORD_READONLY:'1'});assert.equal(initial.status,0,initial.stderr);
 const baseline=JSON.parse(readFileSync(log,'utf8').trim().split('\n').at(-1));
 try {assert.deepEqual(baseline.implementation,{status:'unverified'});console.log('PASS unbound invocation is explicitly unverified');}catch(e){failures++;console.error('ACTIVITY_IDENTITY_RED unverified '+e.message);}
 for(const name of ['proof-or-stop.js','proof-or-stop-codex.js']) {
  const actualEntry=join(repo,'bin',name);const observation=run(actualEntry,['--implementation-identity']);assert.equal(observation.status,0,observation.stderr);const id=JSON.parse(observation.stdout);
  const manifest=join(root,name+'.manifest.json');writeFileSync(manifest,JSON.stringify({schema:'execution-session.v1',entrypoint:actualEntry,digest:id.digest}));
  result=run(actualEntry,query,{PROOF_OR_STOP_ACTIVITY_RECORD_READONLY:'1',PROOF_OR_STOP_IMPLEMENTATION_MANIFEST:manifest});assert.equal(result.status,0,result.stderr);
  const record=JSON.parse(readFileSync(log,'utf8').trim().split('\n').at(-1));
  const witness=JSON.parse(result.stderr.split('\n').find(x=>x.startsWith('IMPLEMENTATION_SESSION_WITNESS ')).slice('IMPLEMENTATION_SESSION_WITNESS '.length));
  const expected={status:'verified-at-entry',schema:id.schema,digest:id.digest,entrypoint:actualEntry,pid:result.pid};
  console.log('ACTIVITY_OBSERVATION '+JSON.stringify({entry:name,expected,recorded:record.implementation??null,stderrWitness:witness}));
  try {assert.deepEqual(record.implementation,expected);console.log('PASS durable actual implementation '+name);}catch(e){failures++;console.error('ACTIVITY_IDENTITY_RED '+name+' '+e.message);}
  const bytes=readFileSync(log);writeFileSync(manifest,JSON.stringify({schema:'execution-session.v1',entrypoint:actualEntry,digest:'0'.repeat(64)}));
  const rejected=run(actualEntry,query,{PROOF_OR_STOP_ACTIVITY_RECORD_READONLY:'1',PROOF_OR_STOP_IMPLEMENTATION_MANIFEST:manifest});assert.notEqual(rejected.status,0);assert.match(rejected.stderr,/IMPLEMENTATION_PIN_MISMATCH/);assert.deepEqual(readFileSync(log),bytes);console.log('PASS wrong pin produces no success record '+name);
 }
}finally{rmSync(root,{recursive:true,force:true});}
if(failures)process.exitCode=1;else console.log('ACTIVITY_IDENTITY_GREEN');
