import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const build=spawnSync(process.execPath,['scripts/ensure-dist.mjs'],{cwd:root,stdio:'inherit'});
assert.equal(build.status,0,'current implementation must build before companion checks');
const cases=[
 ['validation-input-contract.mjs',[]],
 ['validation-shared-input-tree.mjs',[]],
 ['validation-shared-input-tree.mjs',['--delete']],
 ['validation-shared-input-tree.mjs',['--fifo']],
 ['validation-shared-singleflight.mjs',[]],
 ['validation-shared-output.mjs',[]],
 ['validation-shared-implementation.mjs',[]],
];
const failures=[];
for(const [file,args] of cases){
 const started=performance.now();
 const result=spawnSync(process.execPath,[resolve(root,'packages/main/tests',file),...args],{
  cwd:root,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,
 });
 process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
 console.log('COMPANION_TIMING '+JSON.stringify({file,args,seconds:(performance.now()-started)/1000,status:result.status,signal:result.signal}));
 if(result.status!==0||result.signal||result.error)failures.push({file,args,status:result.status,signal:result.signal,error:result.error?.message});
}
assert.deepEqual(failures,[],'COMPANION_CURRENT_CONTRACT_RED: every existing companion must match the current API and output contract');
console.log('COMPANION_CURRENT_CONTRACT_GREEN all seven original companion invocations passed');
