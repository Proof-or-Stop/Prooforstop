import './refresh-subprocess-profile.mjs';
import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {createHook} from 'node:async_hooks';
const output=process.env.SCAN_ATTRIBUTION_DIR+'/'+process.pid+'.jsonl',append=fs.appendFileSync;
// Attribute every git child process to its synchronous segment (async callback epoch), full argv and cwd.
let epoch=0;createHook({before(){epoch++;}}).enable();
const rows=[];
for(const name of ['execSync','execFileSync','spawnSync']){const original=cp[name];cp[name]=function(...args){const started=performance.now();try{return original.apply(this,args);}finally{
 const file=String(args[0]);const isGit=/(^|\/)git$/.test(file)||/^git\s/.test(file);
 if(isGit){const argv=Array.isArray(args[1])?args[1].join(' '):file.replace(/^git\s+/,'');const options=Array.isArray(args[1])?args[2]:args[1];const cwd=options&&typeof options==='object'&&options.cwd?String(options.cwd):process.cwd();
  let owner='';try{const l=Error.stackTraceLimit;Error.stackTraceLimit=30;owner=new Error().stack.split('\n').slice(2).filter(s=>!/profile\.mjs|node:internal|git-tree-observation|evidence-freshness|git-baseline|story-git-bytes|verification-execution-evidence\.js:\d+/.test(s)).slice(0,2).map(s=>s.replace(/^\s*at\s+/,'').replace(/\s*\(file:.*?([a-z-]+\.js):(\d+):\d+\)/,'@$1:$2').replace(/\s*\(.*\)$/,'')).join(' < ');Error.stackTraceLimit=l;}catch{}
  rows.push({kind:'gitProbe',pid:process.pid,epoch,argv:argv.slice(0,160),cwd,ms:performance.now()-started,owner});}}};}
syncBuiltinESMExports();
process.on('exit',()=>{if(rows.length)append(output,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');});
