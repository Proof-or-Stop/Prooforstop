import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import net from 'node:net';
const root=process.cwd(), temp=fs.mkdtempSync(path.join(os.tmpdir(),'graph-no-browser-'));
const audit=path.join(temp,'launches.jsonl'),preload=path.join(temp,'block-browser.mjs');
// Exercise the real CLI and HTTP server. Only the OS browser-launch boundary is
// intercepted, so even RED cannot open the user's browser.
fs.writeFileSync(preload,`import cp from 'node:child_process';import fs from 'node:fs';import path from 'node:path';import{syncBuiltinESMExports}from'node:module';const original=cp.spawn;cp.spawn=(cmd,args=[],opts)=>{if(['open','xdg-open'].includes(path.basename(cmd))||(path.basename(cmd)==='cmd'&&args.includes('start'))){fs.appendFileSync(${JSON.stringify(audit)},JSON.stringify({cmd,args})+'\\n');return original(process.execPath,['-e',''],{stdio:'ignore'});}return original(cmd,args,opts);};syncBuiltinESMExports();`);
const env={...process.env,NODE_OPTIONS:`${process.env.NODE_OPTIONS||''} --import=${pathToFileURL(preload).href}`};
const launches=()=>fs.existsSync(audit)?fs.readFileSync(audit,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
async function runGraph(flags){
 const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const child=spawn(process.execPath,['bin/proof-or-stop.js','graph',...flags,`--port=${port}`],{cwd:root,env,detached:true,stdio:['ignore','pipe','pipe']});
 let output='',closed=false;child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);child.once('close',()=>closed=true);child.on('error',e=>output+=e.message);
 const pause=()=>new Promise(r=>setTimeout(r,25));
 try{const end=Date.now()+30000;while(!output.includes(`graph serving http://localhost:${port}/`)&&!closed&&Date.now()<end)await pause();assert.ok(output.includes(`graph serving http://localhost:${port}/`),output);const res=await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(3000)});assert.equal(res.status,200);assert.match(await res.text(),/openStoryDossier/);}
 finally{const signal=s=>{try{process.kill(-child.pid,s);}catch(e){if(e.code!=='ESRCH')throw e;}};signal('SIGTERM');const end=Date.now()+3000;while(!closed&&Date.now()<end)await pause();if(!closed)signal('SIGKILL');const last=Date.now()+3000;while(!closed&&Date.now()<last)await pause();assert.ok(closed,'owned graph child must exit');}
}
try{
 await runGraph(['--no-open']);
 assert.equal(launches().length,0,'GRAPH_NO_OPEN_MUST_NOT_LAUNCH_BROWSER');
 await runGraph(['--open=false']);assert.equal(launches().length,0);
 await runGraph([]);assert.equal(launches().length,1,'Default interactive launch remains observable at OS boundary');
 const {parseFlagsTest}=await import(pathToFileURL(path.join(root,'packages/main/dist/cli/flag-parser.js')));
 assert.deepEqual(parseFlagsTest(['--no-open'],{open:'boolean'}),{open:false});
 assert.deepEqual(parseFlagsTest(['--no-sync'],{noSync:'boolean',sync:'boolean'}),{noSync:true});
 assert.deepEqual(parseFlagsTest(['--no-open','--open'],{open:'boolean'}),{open:true});
 assert.deepEqual(parseFlagsTest(['--open','--no-open'],{open:'boolean'}),{open:false});
 assert.deepEqual(parseFlagsTest(['--no-count'],{count:'number'}),{'no-count':true});
 for(const args of [['--no-open=true'],['--no-open=false'],['--no-open','false']])assert.throws(()=>parseFlagsTest(args,{open:'boolean'}),/no value/);
 console.log('GRAPH_NO_BROWSER_HTTP_AND_BOOLEAN_FLAG_COMPATIBILITY_PASS');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
