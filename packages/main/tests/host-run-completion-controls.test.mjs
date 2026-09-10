import {defaultHostRunRunner} from '../dist/core/host-run.js';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,chmodSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import assert from 'node:assert/strict';
const root=mkdtempSync(join(tmpdir(),'proof-completion-controls-'));const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');const helper=join(repo,'packages/main/dist/core/host-run-group-anchor.js');let anchor;
try{
 const direct=spawnSync(process.execPath,[helper,process.execPath,'-e','console.log("SHOULD_NOT_START")'],{encoding:'utf8'});assert.notEqual(direct.status,0);assert.equal(direct.stdout,'');assert.match(direct.stderr,/HOST_GROUP_ANCHOR_REQUIRES_IPC/);console.log('PASS private anchor requires IPC before provider spawn');
 const ready=join(root,'ready.json'),provider=join(root,'provider.cjs');writeFileSync(provider,`const fs=require('node:fs'),net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,port:s.address().port})));`);
 anchor=spawn(process.execPath,[helper,process.execPath,provider],{cwd:root,env:process.env,detached:true,stdio:['pipe','pipe','pipe','ipc']});anchor.stdin.end();anchor.stdout.resume();anchor.stderr.resume();
 const until=Date.now()+3000;while(!existsSync(ready)&&Date.now()<until)await new Promise(r=>setTimeout(r,10));assert.ok(existsSync(ready));const target=JSON.parse(readFileSync(ready));
 const closed=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('anchor did not exit after disconnect')),3000);anchor.once('exit',()=>{clearTimeout(timer);resolve();});});anchor.disconnect();await closed;
 const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(target.port,'127.0.0.1',resolve);});await new Promise(r=>server.close(r));console.log('PASS controller disconnect kills owned group and releases TCP resource');
 const counter=join(root,'counter'),ps=join(root,'ps'),old=process.env.PATH;
 writeFileSync(ps,`#!/bin/sh\nif [ -f '${counter}' ]; then echo changed-identity; else touch '${counter}'; echo original-identity; fi\n`);chmodSync(ps,0o700);process.env.PATH=root+':/usr/bin:/bin';
 try{const r=await defaultHostRunRunner({command:process.execPath,argv:['-e','process.exit(0)'],cwd:root,env:process.env,timeoutMs:2000});assert.equal(r.exitCode,1);assert.equal(r.terminalReason,'child_error');assert.match(r.stderr,/HOST_GROUP_CLEANUP_UNVERIFIED/);console.log('PASS mismatched group fingerprint refuses success');}finally{if(old===undefined)delete process.env.PATH;else process.env.PATH=old;}
 console.log('HOST_COMPLETION_CONTROLS_GREEN');
}finally{if(anchor?.pid)try{process.kill(-anchor.pid,'SIGKILL');}catch{}rmSync(root,{recursive:true,force:true});}
