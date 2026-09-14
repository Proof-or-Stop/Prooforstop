// Parent-only observation for the Lab; never substitutes a child result.
import fs from 'node:fs';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const output=process.env.PROOF_OR_STOP_LAB_PROFILE_OUTPUT;
if(!output) throw new Error('Lab profile output is required');
const start=performance.now(); const copies=[]; const children=[]; let activeBindings=0,peakBindings=0;
const binding=options=>options?.env?.LATTICE_BINDING_MUTATION_NAME;
const begin=(command,args,options)=>{
  const row={command,args,startedMs:performance.now()-start,binding:binding(options),boundary:options?.env?.LATTICE_VALID_TRUE_MUTATION_BOUNDARY};
  children.push(row); if(row.binding){activeBindings++;peakBindings=Math.max(peakBindings,activeBindings);}return row;
};
const finish=(row,code,signal)=>{row.endedMs=performance.now()-start;row.durationMs=row.endedMs-row.startedMs;row.code=code;row.signal=signal;if(row.binding)activeBindings--;};
const originalCopy=fs.cpSync;
fs.cpSync=(from,to,options)=>{const began=performance.now();try{return originalCopy(from,to,options);}finally{copies.push({from:String(from),to:String(to),durationMs:performance.now()-began,mode:options?.mode??0});}};
const originalSync=cp.spawnSync;
cp.spawnSync=(command,args,options)=>{const row=begin(command,args,options);const result=originalSync(command,args,options);finish(row,result.status,result.signal);return result;};
const originalSpawn=cp.spawn;
cp.spawn=(command,args,options)=>{const row=begin(command,args,options);const child=originalSpawn(command,args,options);child.once('close',(code,signal)=>finish(row,code,signal));return child;};
syncBuiltinESMExports();
process.once('exit',()=>fs.writeFileSync(output,JSON.stringify({wallMs:performance.now()-start,copies,children,peakBindings,activeBindingsAtExit:activeBindings},null,2)+'\n'));
