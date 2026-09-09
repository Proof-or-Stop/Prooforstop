import assert from 'node:assert/strict';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const repo=process.argv[2]??process.cwd();
const {createFixtureMachineEnvironment}=await import(repo+'/packages/main/dist/tasks/helpers/fixture-machine-environment.js');
const home=os.userInfo().homedir,originalOptions=process.env.NODE_OPTIONS;
process.env.NODE_OPTIONS=[originalOptions,'--no-warnings'].filter(Boolean).join(' ');
const a=createFixtureMachineEnvironment(),b=createFixtureMachineEnvironment();
if(originalOptions===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=originalOptions;
try{
 assert.notEqual(a.root,b.root);assert.equal(os.userInfo().homedir,home);assert.ok(a.env.NODE_OPTIONS.includes('--no-warnings'));
 const script=`const os=require('node:os'),cp=require('node:child_process');const child=cp.spawnSync(process.execPath,['-e',"console.log(require('node:os').userInfo().homedir)"],{encoding:'utf8'});if(child.status!==0)throw Error(child.stderr);console.log(JSON.stringify({home:os.userInfo().homedir,child:child.stdout.trim(),homedir:os.homedir(),envHome:process.env.HOME}));`;
 const child=spawnSync(process.execPath,['-e',script],{env:a.env,encoding:'utf8'});assert.equal(child.status,0,child.stderr);const actual=JSON.parse(child.stdout);assert.equal(actual.home,join(a.root,'home'));assert.equal(actual.child,actual.home);assert.equal(actual.homedir,os.homedir());assert.equal(actual.envHome,process.env.HOME);
 console.log('PASS unique namespace, parent unchanged, descendants share namespace, NODE_OPTIONS retained, HOME unchanged');
 for(const suffix of ['ticket','choosing']){const ticket=join(a.root,'home','queue',`witness.${suffix}`);mkdirSync(ticket,{recursive:true});assert.throws(()=>a.cleanup(),/retained/);assert.ok(existsSync(ticket));rmSync(ticket,{recursive:true});}console.log('PASS ticket and choosing residue block cleanup');
 const slot=join(a.root,'home','provider-pool','slot-0.json');mkdirSync(join(a.root,'home','provider-pool'),{recursive:true});writeFileSync(slot,'{}');assert.throws(()=>a.cleanup(),/retained/);assert.ok(existsSync(slot));rmSync(slot);console.log('PASS provider slot residue blocks cleanup');
 a.cleanup();b.cleanup();assert.equal(existsSync(a.root),false);assert.equal(existsSync(b.root),false);console.log('PASS quiescent cleanup');
}finally{for(const x of[a,b])if(existsSync(x.root))rmSync(x.root,{recursive:true,force:true});}
