import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,cpSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {StoryStore} from '../../packages/main/dist/core/store.js';
const lab=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const roots=[],children=[];
const output=process.env.FIVE_ITEM_PROOF_OUTPUT||join(tmpdir(),'graph-port-proof-'+Date.now());mkdirSync(output,{recursive:true});
async function stop(child){
 if(child.exitCode!==null||child.signalCode!==null)return;
 const done=new Promise(resolve=>child.once('close',resolve));
 const signal=s=>{try{process.platform==='win32'?child.kill(s):process.kill(-child.pid,s);}catch(e){if(e.code!=='ESRCH')throw e;}};
 signal('SIGTERM');const timer=setTimeout(()=>signal('SIGKILL'),3000);try{await done;}finally{clearTimeout(timer);}
}
try {
 for(let i=0;i<2;i++){
  const root=mkdtempSync(join(tmpdir(),'graph-port-fixture-'));roots.push(root);
  mkdirSync(join(root,'packages'),{recursive:true});cpSync(join(lab,'packages/graph'),join(root,'packages/graph'),{recursive:true});
  writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'.',rootDir:'src',storyDir:'.proof-or-stop/story/actives'}));
  const store=new StoryStore(root);store.writeStory('B-port'+i,{storyId:'B-port'+i,name:'Graph port fixture',title:'Isolated graph port witness',description:'Private runtime fixture',type:'chore',phase:'DEV',priority:'medium',createdAt:new Date().toISOString(),startedAt:null,endedAt:null});store.writeChecklist('B-port'+i,{items:[]});
  execFileSync('git',['init','-q'],{cwd:root});
 }
 const started=Date.now();
 const rows=await Promise.all(roots.map(async(root,index)=>{
  const child=spawn(process.execPath,[join(lab,'bin/proof-or-stop.js'),'graph','--no-open','--port=0','--root='+root],{cwd:root,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});children.push(child);
  let log='';const append=chunk=>{log+=String(chunk);writeFileSync(join(output,index+'.log'),log);};child.stdout.on('data',append);child.stderr.on('data',append);
  const url=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('Graph did not announce ready: '+log)),90000);
   const scan=()=>{const match=log.match(/graph serving (http:\/\/localhost:(\d+)\/)/);if(match){clearTimeout(timer);resolve(match[1]);}};
   child.stdout.on('data',scan);child.stderr.on('data',scan);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);reject(new Error('Graph exited '+code+': '+log));});
  });
  assert.notEqual(new URL(url).port,'0','EPHEMERAL_PORT_NOT_REPORTED');
  const status=await (await fetch(url+'api/status')).json();assert.equal(status.root,root);assert.equal(status.stories,1);
  const body=await (await fetch(url)).text();assert.ok(body.toLowerCase().startsWith('<!doctype html'));
  return {root,url,readyMs:Date.now()-started,stories:status.stories,childPid:child.pid};
 }));
 assert.notEqual(rows[0].url,rows[1].url,'Distinct live servers must receive distinct OS ports');
 writeFileSync(join(output,'results.json'),JSON.stringify({rows,elapsedMs:Date.now()-started},null,2));console.log('ACTUAL_CLI_EPHEMERAL_PORTS_GREEN');
} finally {
 await Promise.all(children.map(stop));
 for(const root of roots){rmSync(root,{recursive:true,force:true});const cache=join(homedir(),'.cache/proof-or-stop-graph',basename(root)+'-'+createHash('sha256').update(root).digest('hex').slice(0,12));rmSync(cache,{recursive:true,force:true});}
}
