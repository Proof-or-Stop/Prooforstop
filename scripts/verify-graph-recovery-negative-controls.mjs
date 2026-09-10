import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

// Fault injection into the REAL verifier copied byte-for-byte. The fake CLI is
// deliberately not production Graph; these controls verify the verifier only.
const repo = path.resolve(process.argv[2] ?? process.cwd());
const source = fs.readFileSync(path.join(repo, 'packages/graph/scripts/verify-missing-assets-fail.mjs'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-verifier-negatives-'));
const original = Buffer.from('original asset bytes must survive every failure\n');
async function freePort() {
  return await new Promise((res, rej) => { const s=net.createServer();s.once('error',rej);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?rej(e):res(p));}); });
}
const stub = String.raw`
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
const root=process.cwd(), asset=path.join(root,'packages/graph/assets/app.html');
const mode=process.env.CONTROL_MODE;
const port=Number(process.argv.find(x=>x.startsWith('--port=')).slice(7));
fs.appendFileSync(path.join(root,'pids'),process.pid+'\n');
const valid='<!doctype html><body><div>openStoryDossier</div><script>'+ 'x'.repeat(110000)+'</script></body>';
if(mode==='early-exit') {console.error('CONTROL_EARLY_EXIT');process.exit(23);}
if(mode==='valid-no-serve') {fs.writeFileSync(asset,valid);fs.writeFileSync(path.join(path.dirname(asset),'d3.min.js'),'d3');console.error('building browser client');process.exit(0);}
if(mode==='corrupt-listen') fs.writeFileSync(asset,'corrupt');
if(mode==='missing-listen') console.error('app.html missing; run npm --prefix packages/graph run build');
if(mode==='valid') {fs.writeFileSync(asset,valid);fs.writeFileSync(path.join(path.dirname(asset),'d3.min.js'),'d3');}
const descendant=spawn(process.execPath,['-e',"require('fs').appendFileSync('pids',process.pid+'\\n');setInterval(()=>{},1000)"],{stdio:'ignore'});
if(mode.startsWith('signal-')) {setInterval(()=>{},1000);await new Promise(()=>{});}
const server=http.createServer((req,res)=>{res.writeHead(200);res.end(mode==='valid'?valid:'blank');});
server.listen(port,'127.0.0.1',()=>console.error('graph serving http://localhost:'+port+'/'));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`;
const cases=['valid','missing-listen','corrupt-listen','valid-no-serve','early-exit','spawn-error','signal-int','signal-term','external-listener'];
for (const mode of cases) {
  const dir=path.join(root,mode), assets=path.join(dir,'packages/graph/assets');
  fs.mkdirSync(assets,{recursive:true});fs.mkdirSync(path.join(dir,'packages/graph/scripts'));fs.mkdirSync(path.join(dir,'bin'));
  fs.writeFileSync(path.join(dir,'package.json'),'{"type":"module"}');
  fs.writeFileSync(path.join(dir,'packages/graph/scripts/verify-missing-assets-fail.mjs'),source);
  fs.writeFileSync(path.join(assets,'app.html'),original);
  fs.writeFileSync(path.join(dir,'bin/proof-or-stop.js'),stub);
  const port=await freePort();
  let unrelated=null;
  if(mode==='external-listener'){unrelated=net.createServer(s=>s.end('unrelated'));await new Promise((res,rej)=>{unrelated.once('error',rej);unrelated.listen(port,'127.0.0.1',res);});}
  // Inject spawn failure at the actual child_process boundary. The verifier stays
  // unchanged and receives a real asynchronous ENOENT event from spawn.
  const preload=path.join(dir,'spawn-failure.mjs');
  fs.writeFileSync(preload,`import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';const orig=cp.spawn;cp.spawn=(command,args,opts)=>orig('/definitely-absent-graph-control-binary',args,opts);syncBuiltinESMExports();`);
  const argv=[...(mode==='spawn-error'?['--import',preload]:[]),'packages/graph/scripts/verify-missing-assets-fail.mjs'];
  const child=spawn(process.execPath,argv,{cwd:dir,detached:true,env:{...process.env,CONTROL_MODE:mode,GRAPH_VERIFY_PORT:String(port)},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  let signalTimer=null;
  if(mode.startsWith('signal-')) signalTimer=setInterval(()=>{if(fs.existsSync(path.join(dir,'pids')) && fs.readFileSync(path.join(dir,'pids'),'utf8').trim().split(/\s+/).length>=2){clearInterval(signalTimer);child.kill(mode==='signal-int'?'SIGINT':'SIGTERM');}},25);
  let timedOut=false;const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGKILL');}catch{}},150000);
  const result=await new Promise(resolve=>{child.on('error',e=>resolve({error:String(e)}));child.on('close',(code,signal)=>resolve({code,signal}));});clearTimeout(timer);if(signalTimer)clearInterval(signalTimer);
  const unrelatedAlive=unrelated ? unrelated.listening : null;
  if(unrelated)await new Promise(res=>unrelated.close(res));
  fs.writeFileSync(path.join(dir,'output.log'),stdout+'\n'+stderr);
  const pids=fs.existsSync(path.join(dir,'pids'))?fs.readFileSync(path.join(dir,'pids'),'utf8').trim().split(/\s+/).filter(Boolean).map(Number):[];
  // Permit close/SIGCHLD delivery, but never treat a fixed sleep as proof of exit.
  const deadline=Date.now()+2000;let alive=[];
  do {alive=pids.filter(pid=>{try{process.kill(pid,0);return true;}catch{return false;}});if(!alive.length)break;await new Promise(r=>setTimeout(r,25));} while(Date.now()<deadline);
  const facts={unrelatedAlive,mode,...result,timedOut,restored:fs.readFileSync(path.join(assets,'app.html')).equals(original),alive,port};
  fs.writeFileSync(path.join(dir,'facts.json'),JSON.stringify(facts,null,2));
  // Cleanup only PIDs created and recorded by our own fake CLI; persist diagnostics first.
  for(const pid of alive)try{process.kill(pid,'SIGKILL');}catch{}
  console.log(JSON.stringify(facts));
  if(mode==='external-listener')assert.equal(unrelatedAlive,true,'killed unrelated listener');
  assert.equal(timedOut,false,mode+' verifier exceeded outer diagnostic deadline');
  assert.equal(facts.restored,true,mode+' did not restore original bytes');
  assert.deepEqual(alive,[],mode+' leaked owned child/descendant');
  if(mode==='missing-listen') assert.match(stderr,/a listener was left .* despite the missing client/);
  if(mode==='valid'){assert.equal(result.code,0);assert.match(stdout,/^MISSING_ASSETS_HANDLED_OK$/m);}
  else {assert.notEqual(result.code,0,mode+' false PASS');assert.doesNotMatch(stdout,/^MISSING_ASSETS_HANDLED_OK$/m);}
}
console.log('GRAPH_RECOVERY_VERIFIER_NEGATIVE_CONTROLS_PASS '+root);
