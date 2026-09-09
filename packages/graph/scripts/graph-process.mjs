/** Private verifier process ownership: use the child's announced OS-bound port. */
import {spawn} from 'node:child_process';

export function launchGraph(repo,args,timeoutMs=90000,env=process.env){
 const child=spawn(process.execPath,['bin/proof-or-stop.js','graph',...args],{cwd:repo,env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
 let log='',closed=false;
 child.stdout.on('data',chunk=>{log+=String(chunk);});child.stderr.on('data',chunk=>{log+=String(chunk);});
 const completion=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{closed=true;resolve({code,signal,log});});});
 void completion.catch(()=>{});
 const signal=value=>{try{process.platform==='win32'?child.kill(value):process.kill(-child.pid,value);}catch(error){if(error.code!=='ESRCH')throw error;}};
 const stop=async()=>{
  if(closed)return;
  signal('SIGTERM');const timer=setTimeout(()=>signal('SIGKILL'),3000);
  try{await completion;}finally{clearTimeout(timer);}
 };
 const ready=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Graph readiness timed out: '+log)),timeoutMs);
  const inspect=()=>{
   const match=log.match(/graph serving (http:\/\/localhost:(\d+)\/)/);
   if(match){clearTimeout(timer);if(Number(match[2])<=0)reject(new Error('Graph announced an unusable port: '+match[1]));else resolve(match[1]);}
  };
  child.stdout.on('data',inspect);child.stderr.on('data',inspect);
  completion.then(result=>{clearTimeout(timer);reject(new Error('Graph exited before readiness: '+JSON.stringify(result)));},error=>{clearTimeout(timer);reject(error);});
 });
 void ready.catch(()=>{});
 return {child,ready,completion,stop,log:()=>log};
}

export async function startGraph(repo,{port=Number(process.env.GRAPH_VERIFY_PORT??0),timeoutMs=90000}={}){
 const launched=launchGraph(repo,['--no-open','--port='+port],timeoutMs);
 try{return {...launched,url:await launched.ready};}catch(error){await launched.stop();throw error;}
}

export async function fetchGraph(url,path=''){
 const response=await fetch(new URL(path,url),{signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new Error('Graph request failed: '+response.status+' '+path);
 return response;
}
