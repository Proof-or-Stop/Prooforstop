import assert from 'node:assert/strict';
import fs from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {registerHooks} from 'node:module';
const target=pathToFileURL(resolve('packages/main/dist/tasks/validate-execution-lock-smoke.js')).href;
if(process.argv.length===2)process.argv.push('--selected-workspace-wait');
const hook=registerHooks({load(url,context,next){const result=next(url,context);if(url!==target)return result;
 let source=String(result.source);const at=source.indexOf('void (async () => {');assert(at>0);source=source.slice(0,at);
 source+="\ntry {await assertWorkspaceWaitAndRun();console.log('WORKSPACE_WAIT_STARTUP_GREEN');} finally {cleanupNativeLockRoots();}\n";
 return{...result,source};}});
const previous=process.env.NODE_OPTIONS, scratch=fs.mkdtempSync(join(tmpdir(),'workspace-cli-delay-')), preload=join(scratch,'delay.mjs');
fs.writeFileSync(preload,"if(process.env.PROOF_OR_STOP_VALIDATE_LOCK_SMOKE_LABEL==='second') await new Promise(resolve=>setTimeout(resolve,2300));\n");
process.env.NODE_OPTIONS=[previous,'--import',pathToFileURL(preload).href].filter(Boolean).join(' ');
try{await import(target);}finally{hook.deregister();if(previous===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=previous;fs.rmSync(scratch,{recursive:true,force:true});}
