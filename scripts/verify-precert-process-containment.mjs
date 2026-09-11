import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runEntry, createFullSuiteRunState, killProcessTree } from '../packages/main/dist/tasks/full-suite-runner.js';

const fixture = mkdtempSync(join(tmpdir(),'precert-cancel-'));
const helper = pathToFileURL(resolve('scripts/verify-managed-supervisor-terminal-cleanup.mjs')).href;
const marker = join(fixture,'provider.pid');
const heartbeat = join(fixture,'heartbeat');
const worker = join(fixture,'worker.pid');
const observed = [];
let pending;
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
function identity(pid) {
  const row = execFileSync('ps',['-o','pid=,pgid=,lstart=','-p',String(pid)],{encoding:'utf8'}).trim();
  const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(row);
  assert.ok(match, 'fixture process must have a live kernel identity');
  return {pid,pgid:Number(match[2]),startFingerprint:match[3],spawnedAt:new Date().toISOString(),processGroupIsolated:Number(match[2])===pid};
}
try {
  // Only the fixture provider is prolonged. The helper's real launch options and
  // the production runEntry timeout/group cleanup remain unmodified.
  const shell = `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));
setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'tick\\n'),50);
`;
  const loader = join(fixture,'loader.mjs');
  writeFileSync(loader,`import {readFileSync} from 'node:fs';
export async function load(url,context,next) {
  if(url !== ${JSON.stringify(helper)}) return next(url,context);
  let source=readFileSync(new URL(url),'utf8');
  const shell=${JSON.stringify("'#!/bin/sh\\nexit 7\\n'")};
  const launch='return {pid:child.pid};';
  if(source.split(shell).length!==2 || source.split(launch).length!==2) throw new Error('containment fixture anchors changed');
  source=source.replace(shell,()=>${JSON.stringify(JSON.stringify(shell))})
    .replace(launch,'writeFileSync('+${JSON.stringify(JSON.stringify(worker))}+', String(child.pid)); '+launch);
  return {format:'module',source,shortCircuit:true};
}`);
  const register=join(fixture,'register.mjs');
  writeFileSync(register,`import {register} from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)},import.meta.url);`);
  writeFileSync(join(fixture,'package.json'),JSON.stringify({scripts:{'containment':
    `${JSON.stringify(process.execPath)} --import ${JSON.stringify(register)} ${JSON.stringify(new URL(helper).pathname)}`}}));
  const state=createFullSuiteRunState();
  pending=runEntry({name:'containment',resources:[],timeoutMs:4000,tempOwnership:'runner-owned-unique'},fixture,'npm',undefined,state);
  const deadline=Date.now()+3500;
  while ((!existsSync(marker)||!existsSync(worker)||!existsSync(heartbeat)||readFileSync(heartbeat,'utf8').length<10)&&Date.now()<deadline) await sleep(20);
  assert.ok(existsSync(marker)&&existsSync(worker)&&existsSync(heartbeat)&&readFileSync(heartbeat,'utf8').length>=10,'the real worker and long-lived provider must start before cancellation: '+JSON.stringify({marker:existsSync(marker),worker:existsSync(worker),heartbeat:existsSync(heartbeat),output:(!existsSync(marker)||!existsSync(heartbeat))?(await pending).output:undefined}));
  for(const path of [marker,worker]) {
    const value=readFileSync(path,'utf8').trim();
    assert.match(value,/^\d+$/, `invalid PID marker ${path}: ${JSON.stringify(value)}`);
    observed.push(identity(Number(value)));
  }
  const result=await pending;
  assert.equal(result.status,'TIMEOUT',result.output);
  assert.doesNotMatch(result.output,/^PASS U02|^PRE_CERT_CONTRACT/m);
  const before=readFileSync(heartbeat,'utf8'); await sleep(250);
  assert.equal(readFileSync(heartbeat,'utf8'),before,'U07 cancelled cleanup witness must leave no live detached provider heartbeat');
  for(const processIdentity of observed) {
    let row=''; try { row=execFileSync('ps',['-o','stat=','-p',String(processIdentity.pid)],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); } catch {}
    assert.ok(!row||row.startsWith('Z'),'cancelled witness worker/provider must no longer execute');
  }
  console.log('PASS U07 cancelled cleanup witness contains its real worker and provider');
} finally {
  if(pending) await pending;
  for(const value of observed) killProcessTree(value.pid,process.kill,process.platform,undefined,value);
  rmSync(fixture,{recursive:true,force:true});
}
