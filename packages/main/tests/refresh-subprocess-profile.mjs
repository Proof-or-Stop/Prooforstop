import './scan-attribution-profile.mjs';
import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const output=process.env.SCAN_ATTRIBUTION_DIR+'/'+process.pid+'.jsonl',append=fs.appendFileSync;
const emit=r=>append(output,JSON.stringify({pid:process.pid,...r})+'\n');
let active;
for(const name of ['execSync','execFileSync','spawnSync']){const original=cp[name];cp[name]=function(...args){const started=performance.now();try{return original.apply(this,args);}finally{if(active){const command=(String(args[0])+' '+(Array.isArray(args[1])?args[1].slice(0,3).join(' '):'')).slice(0,120);active.calls++;active.ms+=performance.now()-started;active.commands[command]=(active.commands[command]??0)+1;}}};}
syncBuiltinESMExports();
// Attribute every child process to the synchronous refresh scope that owns it.
const refresh=globalThis[Symbol.for('scan-attribution-refresh')];
globalThis[Symbol.for('scan-attribution-refresh')]=(label,rows,fn)=>{const parent=active;const current={kind:'refreshSubprocess',label,rows,calls:0,ms:0,commands:{}};active=current;try{return refresh(label,rows,fn);}finally{active=parent;emit(current);}};
