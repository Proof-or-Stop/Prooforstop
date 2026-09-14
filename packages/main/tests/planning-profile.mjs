import fs from 'node:fs';
import {registerHooks,syncBuiltinESMExports} from 'node:module';
const report=process.env.PLANNING_PROFILE_DIR;
if(!report)throw Error('PLANNING_PROFILE_DIR required');
const file=report+'/'+process.pid+'.jsonl',append=fs.appendFileSync;
const emit=row=>append(file,JSON.stringify({pid:process.pid,...row})+'\n');
let scan,planning;
const read=fs.readFileSync;
fs.readFileSync=function(...args){const value=read.apply(this,args);if(scan){scan.readCalls++;scan.bytes+=Buffer.isBuffer(value)?value.length:Buffer.byteLength(value);}return value;};syncBuiltinESMExports();
globalThis[Symbol.for('measure-planning')]=fn=>{const parent=planning;const row={kind:'planning',calls:0,scanMs:0,bytes:0};planning=row;const start=performance.now();try{return fn();}finally{planning=parent;emit({...row,wallMs:performance.now()-start});}};
globalThis[Symbol.for('measure-implementation')]=fn=>{const parent=scan;const row={kind:'scan',readCalls:0,bytes:0};scan=row;const start=performance.now();try{return fn();}finally{scan=parent;const ms=performance.now()-start;if(planning){planning.calls++;planning.scanMs+=ms;planning.bytes+=row.bytes;}emit({...row,elapsedMs:ms,inPlanning:!!planning});}};
registerHooks({load(url,context,next){const r=next(url,context);if(url.endsWith('/core/execution-implementation.js')){const source=String(r.source),anchor='export function executionImplementationIdentity() {';if(!source.includes(anchor))throw Error('missing implementation profiling anchor');return {...r,source:source.replace(anchor,'function originalExecutionImplementationIdentity() {')+'\nexport function executionImplementationIdentity(){return globalThis[Symbol.for("measure-implementation")](originalExecutionImplementationIdentity);}\n'};}
if(url.endsWith('/handlers/checklist.js')){const source=String(r.source),anchor='const initialPlans = ',start=source.indexOf(anchor),end=source.indexOf(';\n',start);if(start<0||end<0)throw Error('missing initial planning profiling anchor');
// The assignment contains a map callback with internal semicolons. Locate its
// following declaration instead of treating a callback statement as the end.
const nextDeclaration=source.indexOf('const commandOrdinals =',start);const expressionEnd=source.lastIndexOf(';',nextDeclaration);if(nextDeclaration<0||expressionEnd<start)throw Error('missing planning end');
return {...r,source:source.slice(0,start)+anchor+'globalThis[Symbol.for("measure-planning")](() => '+source.slice(start+anchor.length,expressionEnd)+')'+source.slice(expressionEnd)};
}return r;}});
