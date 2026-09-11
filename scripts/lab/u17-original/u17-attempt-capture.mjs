import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const hookPath=fileURLToPath(new URL('./u17-original-abba-hook.mjs',import.meta.url));
let heartbeatBinding;
export function sourceHeartbeatBinding(repo=process.env.U17_REPO){
 if(heartbeatBinding)return heartbeatBinding;
 if(!repo)throw Error('heartbeat classification requires source repository');
 const ts=createRequire(repo+'/package.json')('typescript');
 const path=repo+'/packages/main/src/core/mkdir-lock.ts', source=readFileSync(path,'utf8');
 const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);const matches=[];
 function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='heartbeatScript')matches.push(n.initializer);ts.forEachChild(n,visit);}visit(ast);
 if(matches.length!==1)throw Error('heartbeat source binding changed');
 const init=matches[0];if(!ts.isCallExpression(init)||init.expression.name?.text!=='join'||init.arguments.length!==1||init.arguments[0].text!==''||!ts.isArrayLiteralExpression(init.expression.expression)||!init.expression.expression.elements.every(ts.isStringLiteral))throw Error('heartbeat source shape changed');
 const script=init.expression.expression.elements.map(e=>e.text).join('');
 const expected="const fs=require('fs');const [path,lockId,parentPidText,intervalText]=process.argv.slice(1);const parentPid=Number(parentPidText), interval=Number(intervalText);const beat=()=>{try{process.kill(parentPid,0);const row=JSON.parse(fs.readFileSync(path,'utf8'));if(row.lockId!==lockId)process.exit(0);const now=new Date();fs.utimesSync(path,now,now);}catch{process.exit(0)}};beat();setInterval(beat,interval);";
 if(script!==expected)throw Error('unreviewed heartbeat source bytes');
 return heartbeatBinding={script,sourceDigest:createHash('sha256').update(source).digest('hex'),scriptDigest:createHash('sha256').update(script).digest('hex')};
}
export function classifyKnownHelper(row,repo){
 const a=row.argv;
 if(row.api==='execFileSync'&&basename(row.command)==='ps'&&Array.isArray(a)&&/^[1-9][0-9]*$/.test(a.at(-1))){
  if(JSON.stringify(a.slice(0,-1))===JSON.stringify(['-o','lstart=','-p']))return{type:'readonly-process-start'};
  if(JSON.stringify(a.slice(0,-1))===JSON.stringify(['-o','ppid=','-o','comm=','-o','command=','-p']))return{type:'readonly-process-ancestry'};
 }
 if(row.api==='spawn'&&row.command===process.execPath&&a?.length===6&&a[0]==='-e'&&typeof a[2]==='string'&&a[2].startsWith('/')&&a[2].endsWith('/holder.json')&&/^[a-f0-9-]{36}$/.test(a[3])&&/^[1-9][0-9]*$/.test(a[4])&&Number.isFinite(Number(a[5]))&&Number(a[5])>0){const b=sourceHeartbeatBinding(repo);if(a[1]===b.script)return{type:'fs-only-lock-heartbeat',sourceDigest:b.sourceDigest,scriptDigest:b.scriptDigest};}
 return undefined;
}
export async function drainAttemptClosures(attempts,timeoutMs=5000){
 const start=performance.now();while(attempts.some(r=>!r.completed)){if(performance.now()-start>=timeoutMs)throw Error('child close drainage timed out');await new Promise(resolve=>setTimeout(resolve,10));}return performance.now()-start;
}
import {basename} from 'node:path';
import {promisify} from 'node:util';
export function instrumentChildProcesses(cp,state){
 let callDepth=0;
 const text=v=>Buffer.isBuffer(v)?v.toString('utf8'):typeof v==='string'?v:undefined;
 const classify=(api,command,args,options)=>{
  const shell=api==='exec'||api==='execSync';
  const words=shell&&typeof command==='string'?command.trim().split(/\s+/):undefined;
  const executable=api==='fork'?(options?.execPath||process.execPath):shell?words?.[0]?.replace(/^['"]|['"]$/g,''):command;
  const argv=api==='fork'?[command,...(Array.isArray(args)?args:[])]:shell?words?.slice(1):Array.isArray(args)?args:[];
  const kind=typeof executable==='string'&&basename(executable)==='git'?'git':typeof executable==='string'&&/^(?:node|bun)(?:\.exe)?$/.test(basename(executable))?'node':'unknown';
  return{executable,argv,kind};
 };
 function begin(api,command,args,rest){
  const options=(Array.isArray(args)?rest: [args,...rest]).find(v=>v&&typeof v==='object'&&!Array.isArray(v))||{};
  const identity=classify(api,command,args,options),env=options.env||process.env;
  const row={api,command:identity.executable,argv:identity.argv,kind:identity.kind,pidIsRuntime:!options.shell&&api!=='exec'&&api!=='execSync',completed:false,instrumentation:{mode:env.U17_MEMO_MODE??null,metricsPrefix:env.U17_AB_CHILD_METRICS??null,hasHook:typeof env.NODE_OPTIONS==='string'&&env.NODE_OPTIONS.includes('u17-original-abba-hook.mjs')}};
  row.helper=classifyKnownHelper(row);state.attempts.push(row);
  if(identity.kind==='git')state.countGit(identity.argv);else if(identity.kind==='node')state.counts.nodeLaunches++;else state.counts.otherLaunches++;
  return row;
 }
 function complete(row,result,error,sync){
  row.completed=true;row.synchronous=sync;
  if(error){row.errorCode=error.code??null;row.exitCode=typeof error.status==='number'?error.status:null;row.signal=error.signal??null;row.spawnError=Boolean(error.code&&typeof error.code==='string');}
  else if(result&&typeof result==='object'&&'status'in result){row.pid=result.pid??null;row.exitCode=result.status;row.signal=result.signal??null;row.errorCode=result.error?.code??null;row.spawnError=Boolean(result.error);}
  else{row.exitCode=0;row.signal=null;row.spawnError=false;}
  // Retain only exact version output; never log arbitrary command output/environment.
  if(sync&&row.kind==='node'&&row.argv.length===1&&['--version','-v'].includes(row.argv[0])){
   const stdout=text(result?.stdout??result);if(stdout&&/^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\s*$/.test(stdout))row.versionStdout=stdout.trim();
  }
 }
 for(const api of ['execFileSync','execSync','spawnSync','spawn','execFile','exec','fork']){
  const original=cp[api];
  const wrapped=function(command,args,...rest){
   if(callDepth)return original.call(this,command,args,...rest);
   const row=begin(api,command,args,rest);
   if(row.helper?.type==='fs-only-lock-heartbeat'){
    const options=rest[0]??{},env={...(options.env??process.env)};
    // Remove only this harness import; retain all unrelated Node options.
    const token=' --import='+JSON.stringify(hookPath);
    env.NODE_OPTIONS=(env.NODE_OPTIONS??'').split(token).join('');
    if(env.NODE_OPTIONS.includes('u17-original-abba-hook.mjs'))throw Error('unrecognized heartbeat hook token');
    rest=[{...options,env},...rest.slice(1)];row.instrumentation.hasHook=false;row.instrumentation.excludedReason='source-bound fs-only heartbeat';
   }
   callDepth++;
   try{
    const result=original.call(this,command,args,...rest);
    if(api.endsWith('Sync'))complete(row,result,null,true);
    else{row.pid=result.pid??null;result.once('error',error=>{row.errorCode=error.code??null;row.spawnError=true;});result.once('close',(code,signal)=>{row.completed=true;row.exitCode=code;row.signal=signal;row.synchronous=false;});}
    return result;
   }catch(error){complete(row,null,error,api.endsWith('Sync'));throw error;}finally{callDepth--;}
  };
  for(const key of Reflect.ownKeys(original))if(key!==promisify.custom&&!['name','length','prototype'].includes(key)){const descriptor=Object.getOwnPropertyDescriptor(original,key);if(descriptor)Object.defineProperty(wrapped,key,descriptor);}
  if(typeof original[promisify.custom]==='function')Object.defineProperty(wrapped,promisify.custom,{configurable:true,value:function(command,args,...rest){if(callDepth)return original[promisify.custom].call(this,command,args,...rest);const row=begin(api,command,args,rest);let promise;callDepth++;try{promise=original[promisify.custom].call(this,command,args,...rest);}catch(e){complete(row,null,e,false);throw e;}finally{callDepth--;}row.pid=promise.child?.pid??null;promise.then(result=>complete(row,result,null,false),error=>complete(row,null,error,false));return promise;}});
  cp[api]=wrapped;
 }
}
export function validateAttemptReceipts(attempts,children){
 const unknown=attempts.filter(r=>r.kind==='unknown'&&!r.helper);if(unknown.length)throw Error('unclassified launch requires instrumentation review: '+JSON.stringify(unknown));
 const nodes=attempts.filter(r=>r.kind==='node');
 const needs=[];let versionOnly=0,spawnFailures=0,heartbeatHelpers=0;
 for(const row of nodes){
  if(!row.completed)throw Error('Node launch incomplete at target boundary');
  if(row.helper?.type==='fs-only-lock-heartbeat'){if(row.instrumentation.hasHook)throw Error('heartbeat accidentally receives historical hook');if(!row.spawnError&&row.exitCode!==0&&row.signal!=='SIGTERM')throw Error('unexpected heartbeat terminal');heartbeatHelpers++;continue;}
  if(row.synchronous&&row.exitCode===0&&!row.spawnError&&row.argv.length===1&&['--version','-v'].includes(row.argv[0])&&row.versionStdout){versionOnly++;continue;}
  if(row.spawnError&&!row.pid){spawnFailures++;continue;}
  if(!row.instrumentation.hasHook||!row.instrumentation.metricsPrefix)throw Error('actual JS launch lacks hook environment');
  needs.push(row);
 }
 const byPid=new Set(children.map(c=>c.pid));
 for(const row of needs)if(row.pidIsRuntime&&row.pid&&!byPid.has(row.pid))throw Error('actual JS child missing PID receipt: '+row.pid);
 if(children.length<needs.length)throw Error('actual JS children missing instrumentation receipts');
 return{nodeAttempts:nodes.length,requiredJsReceipts:needs.length,versionOnly,spawnFailures,heartbeatHelpers,readonlyProcessProbes:attempts.filter(r=>r.helper?.type?.startsWith('readonly-process-')).length};
}
