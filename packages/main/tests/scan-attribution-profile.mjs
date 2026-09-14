import fs from 'node:fs';
import {registerHooks, syncBuiltinESMExports} from 'node:module';
import {createHook, executionAsyncId} from 'node:async_hooks';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
const directory=process.env.SCAN_ATTRIBUTION_DIR;
if(!directory) throw Error('SCAN_ATTRIBUTION_DIR required');
const append=fs.appendFileSync, read=fs.readFileSync;
const output=directory+'/'+process.pid+'.jsonl';
const emit=row=>append(output,JSON.stringify({pid:process.pid,...row})+'\n');
let epoch=0,sequence=0,scan,planningDepth=0,refresh;
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
globalThis[Symbol.for('scan-attribution-refresh')]=(label,rows,fn)=>{
  const parent=refresh,start=performance.now();const observation={kind:'refresh',label,rows,calls:0,scanMs:0,bytes:0,epoch};refresh=observation;
  try{return fn();}finally{refresh=parent;emit({...observation,wallMs:performance.now()-start});}
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
    if(refresh){refresh.calls++;refresh.scanMs+=elapsedMs;refresh.bytes+=current.bytes;}
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
    let transformed=source.slice(0,start)+anchor+'globalThis[Symbol.for("scan-attribution-planning")](() => '+source.slice(start+anchor.length,end)+')'+source.slice(end);
    const ast=ts.createSourceFile('checklist.js',transformed,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),edits=[];const counts={coverage:0,groups:0,write:0};
    const inside=(n,name)=>{for(let p=n.parent;p;p=p.parent)if(ts.isFunctionDeclaration(p)&&p.name?.text===name)return true;return false;};
    function visit(n){
      if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='coverage'&&n.initializer&&inside(n,'collectStaleRefreshContext')){
        counts.coverage++;edits.push({start:n.initializer.getStart(ast),end:n.initializer.end,text:'globalThis[Symbol.for("scan-attribution-refresh")]("coverage", cl.items.reduce((sum,item)=>sum+(item.verificationEvidence?.length??0),0), () => '+n.initializer.getText(ast)+')'});
      }
      if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='buildGroups'&&n.initializer&&ts.isArrowFunction(n.initializer)&&ts.isBlock(n.initializer.body)){
        counts.groups++;const b=n.initializer.body;edits.push({start:b.getStart(ast),end:b.end,text:'{ return globalThis[Symbol.for("scan-attribution-refresh")]("groups", computed.stale.length, () => '+b.getText(ast)+'); }'});
      }
      if(ts.isForOfStatement(n)&&n.expression.getText(ast)==='stale'&&inside(n,'writeStaleRefresh')){
        counts.write++;edits.push({start:n.getStart(ast),end:n.end,text:'globalThis[Symbol.for("scan-attribution-refresh")]("write", stale.length, () => { '+n.getText(ast)+' });'});
      }
      ts.forEachChild(n,visit);
    }
    visit(ast);if(Object.values(counts).some(n=>n!==1))throw Error('refresh profiling anchors mismatch '+JSON.stringify(counts));
    for(const edit of edits.sort((a,b)=>b.start-a.start))transformed=transformed.slice(0,edit.start)+edit.text+transformed.slice(edit.end);
    return {...r,source:transformed};
  }
  return r;
}});
