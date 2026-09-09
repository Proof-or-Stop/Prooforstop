/** --json must complete without the long-running serve path or a listener. */
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {launchGraph} from './graph-process.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
// Observe every Node listen call, including subprocesses and unref'ed servers;
// delegate to the original method unchanged. The observer exists only in this verifier.
const scratch=fs.mkdtempSync(path.join(tmpdir(),'graph-json-listen-'));
const listenLog=path.join(scratch,'listen.jsonl');
const observer=path.join(scratch,'observer.mjs');
fs.writeFileSync(observer,`import net from 'node:net';import fs from 'node:fs';const original=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){fs.appendFileSync(${JSON.stringify(listenLog)},JSON.stringify({pid:process.pid})+'\\n');return Reflect.apply(original,this,args);};`);
const env={...process.env,NODE_OPTIONS:[process.env.NODE_OPTIONS??'','--import='+JSON.stringify(pathToFileURL(observer).href)].join(' ')};
const graph=launchGraph(repo,['--json','--port='+Number(process.env.GRAPH_VERIFY_PORT??0)],30000,env);
let timer;
try {
 const result=await Promise.race([graph.completion,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('JSON command did not exit without a listener')),30000);})]);
 assert.equal(result.code,0,result.log);assert.ok(!fs.existsSync(listenLog),'JSON mode must make zero net.Server.listen calls');assert.ok(!/graph serving http:/.test(result.log),'JSON mode must not enter serving');
 const start=result.log.indexOf('{'),end=result.log.lastIndexOf('}');assert.ok(start>=0&&end>start);
 const status=JSON.parse(result.log.slice(start,end+1));assert.equal(typeof status.stories,'number');
 console.log('--json returned '+status.stories+' stories and exited without serving');console.log('JSON_NO_LISTENER_OK');
} finally {clearTimeout(timer);await graph.stop();fs.rmSync(scratch,{recursive:true,force:true});}
