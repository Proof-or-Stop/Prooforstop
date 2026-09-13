import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const original=cp.spawnSync, oldExit=process.exitCode, oldLog=console.log, oldError=console.error;
const lines=[];
try {
 cp.spawnSync=()=>({status:null,signal:'SIGTERM',error:Object.assign(new Error('fixture deadline exhausted'),{code:'ETIMEDOUT'})});syncBuiltinESMExports();
 console.log=(...v)=>lines.push(v.join(' '));console.error=console.log;
 await import('./lab/verify-intake-round-four.mjs?timeout-control');
 assert.equal(process.exitCode,124,'INTAKE_TIMEOUT_MISCLASSIFIED: a deadline must propagate as timeout, not ordinary RED');
 assert(lines.some(x=>x.includes('INTAKE_VERIFICATION_TIMEOUT')));
 assert(!lines.some(x=>/INTAKE_ROUND_FOUR_(RED|GREEN)/.test(x)));
} finally {cp.spawnSync=original;syncBuiltinESMExports();console.log=oldLog;console.error=oldError;process.exitCode=oldExit;}
console.log('INTAKE_TIMEOUT_CLASSIFICATION_GREEN real wrapper reports timeout without RED/GREEN');
