import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const repo=resolve(process.argv[2]||process.cwd());
const {probeHostExecutionReadiness}=await import(pathToFileURL(join(repo,'packages/main/dist/core/host-execution-readiness.js')));
const root=mkdtempSync(join(tmpdir(),'u08-supervised-readiness-'));
const shim=join(root,'provider.cjs'),pidFile=join(root,'pid'),beat=join(root,'beat');let pid;
const alive=()=>{if(!pid)return false;try{process.kill(pid,0);return true;}catch{return false;}};
try{
 writeFileSync(shim,`#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');const mode=process.env.U08_PROBE_MODE;if(mode==='auth'){console.error('authentication required');process.exit(1);}if(mode==='timeout'){setInterval(()=>{},1000);}else if(mode==='orphan'){const child=cp.spawn(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>require('node:fs').appendFileSync(process.argv[2],'.'),20)",process.env.U08_PID,process.env.U08_BEAT],{stdio:'ignore'});fs.writeFileSync(process.env.U08_PID,String(child.pid));child.unref();console.log('READY');}else{console.log('READY');}\n`,{mode:0o700});
 const run=mode=>probeHostExecutionReadiness({host:'codex',executablePath:shim,versionOk:true,cwd:root,env:{...process.env,U08_PROBE_MODE:mode,U08_PID:pidFile,U08_BEAT:beat},timeoutMs:mode==='timeout'?200:3000});
 const ready=run('ready');console.log(JSON.stringify(ready));assert.equal(ready.executionReady,true,'healthy actual provider must remain ready');
 assert.equal(run('auth').failureKind,'auth','actual auth diagnostic retains classification');
 const timed=run('timeout');assert.equal(timed.failureKind,'timeout');assert.equal(timed.executionReady,false);
 const result=run('orphan');
 for(let i=0;i<50&&!existsSync(pidFile);i++)await new Promise(r=>setTimeout(r,20));
 if(existsSync(pidFile))pid=Number(readFileSync(pidFile,'utf8'));
 assert.ok(Number.isSafeInteger(pid)&&pid>1,'actual shim records its spawned child PID');
 const before=existsSync(beat)?readFileSync(beat,'utf8').length:0;await new Promise(r=>setTimeout(r,100));
 const after=existsSync(beat)?readFileSync(beat,'utf8').length:0;
 console.log(JSON.stringify({result,ownedChildPid:pid,alive:alive(),heartbeatBefore:before,heartbeatAfter:after}));
 assert.equal(alive(),false,'readiness probe must reap its live descendant before returning');
 assert.equal(after,before,'returned probe cannot leave heartbeat producer running');
 console.log('PASS U08 supervised readiness healthy/auth/timeout and descendant cleanup');
}finally{
 if(pid&&alive()){
  const cmd=execFileSync('/bin/ps',['-p',String(pid),'-o','command='],{encoding:'utf8'});
  if(cmd.includes(pidFile)&&cmd.includes(beat))process.kill(pid,'SIGKILL');
 }
 rmSync(root,{recursive:true,force:true});
}
