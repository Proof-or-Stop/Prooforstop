import fs from 'node:fs';
import {registerHooks, syncBuiltinESMExports} from 'node:module';
import {createHook, executionAsyncId} from 'node:async_hooks';
import {fileURLToPath} from 'node:url';
const directory=process.env.SCAN_ATTRIBUTION_DIR;
if(!directory) throw Error('SCAN_ATTRIBUTION_DIR required');
const append=fs.appendFileSync, read=fs.readFileSync;
const output=directory+'/'+process.pid+'.jsonl';
const emit=row=>append(output,JSON.stringify({pid:process.pid,...row})+'\n');
let epoch=0,sequence=0,scan,planningDepth=0;
createHook({before(){epoch++;}}).enable();
const executable=fs.realpathSync(process.execPath);
const aggregate=new Map();
fs.readFileSync=function(file,...args){
  const start=performance.now();const value=read.call(this,file,...args);
  if(scan){
    const readMs=performance.now()-start;
    const name=file instanceof URL?fileURLToPath(file):String(file);
    const bytes=Buffer.isBuffer(value)?value.length:Buffer.byteLength(value);
    scan.readCalls++;scan.bytes+=bytes;scan.readMs+=readMs;
    if(name===executable)scan.executableBytes+=bytes;
    const prev=scan.files.get(name)??{file:name,calls:0,bytes:0};prev.calls++;prev.bytes+=bytes;scan.files.set(name,prev);
    const total=aggregate.get(name)??{file:name,calls:0,bytes:0,readMs:0};total.calls++;total.bytes+=bytes;total.readMs+=readMs;aggregate.set(name,total);
  }
  return value;
};syncBuiltinESMExports();
globalThis[Symbol.for('scan-attribution-planning')]=fn=>{
  const before=sequence,start=performance.now();planningDepth++;
  try{return fn();}finally{planningDepth--;emit({kind:'planning',calls:sequence-before,wallMs:performance.now()-start,epoch});}
};
globalThis[Symbol.for('scan-attribution')]=fn=>{
  const previous=scan;
  const previousLimit=Error.stackTraceLimit;let stack;
  try{Error.stackTraceLimit=24;stack=new Error().stack.split('\n').slice(1).filter(x=>!x.includes('scan-attribution-profile.mjs')).slice(0,22);}
  finally{Error.stackTraceLimit=previousLimit;}
  const current={kind:'scan',sequence:++sequence,epoch,asyncId:executionAsyncId(),inPlanning:planningDepth>0,stack,readCalls:0,bytes:0,readMs:0,executableBytes:0,files:new Map()};scan=current;
  const start=performance.now();let result,error;
  try{result=fn();return result;}catch(e){error=e?.name??'Error';throw e;}
  finally{
    const elapsedMs=performance.now()-start;scan=previous;
    const {files,...fields}=current;
    emit({...fields,elapsedMs,digest:result?.digest,implementationRoot:result?.implementationRoot,fileCount:result?.fileCount,error,topReads:[...files.values()].sort((a,b)=>b.bytes-a.bytes).slice(0,5)});
  }
};
process.on('exit',()=>emit({kind:'fileTotals',files:[...aggregate.values()].sort((a,b)=>b.bytes-a.bytes)}));
registerHooks({load(url,context,next){
  const r=next(url,context);const source=String(r.source);
  if(url.endsWith('/core/execution-implementation.js')){
    const anchor='export function executionImplementationIdentity() {';
    if(source.split(anchor).length!==2)throw Error('attribution implementation anchor mismatch');
    return {...r,source:source.replace(anchor,'function originalExecutionImplementationIdentity() {')+'\nexport function executionImplementationIdentity(){return globalThis[Symbol.for("scan-attribution")](originalExecutionImplementationIdentity);}\n'};
  }
  if(url.endsWith('/handlers/checklist.js')){
    const anchor='const initialPlans = ',start=source.indexOf(anchor),nextDeclaration=source.indexOf('const commandOrdinals =',start),end=source.lastIndexOf(';',nextDeclaration);
    if(start<0||nextDeclaration<0||end<start)throw Error('attribution planning anchor mismatch');
    return {...r,source:source.slice(0,start)+anchor+'globalThis[Symbol.for("scan-attribution-planning")](() => '+source.slice(start+anchor.length,end)+')'+source.slice(end)};
  }
  return r;
}});
