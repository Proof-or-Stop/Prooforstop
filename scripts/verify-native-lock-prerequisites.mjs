import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
for (const [command,args] of [
 ['npm',['--prefix','packages/main','run','build']],
 [process.execPath,['packages/main/dist/tasks/validate-execution-lock-smoke.js','--native-prerequisites-only']],
]) {
 const started=performance.now();
 const result=spawnSync(command,args,{stdio:'inherit',timeout:600000});
 console.log('NATIVE_LOCK_STEP_TIMING '+JSON.stringify({command,args,elapsedMs:performance.now()-started,status:result.status}));
 assert.equal(result.error,undefined,String(result.error));
 assert.equal(result.signal,null,'native test must finish without signals');
 assert.equal(result.status,0,command+' native prerequisites verification failed');
}
