import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {spawnSync,execFileSync} from 'node:child_process';
const fifoWorker=process.argv[2]==='--fifo-worker';
const repo=resolve(process.argv[fifoWorker?3:2]||process.cwd());
if(fifoWorker){
 const scratch=fs.realpathSync(process.argv[4]),auth=join(scratch,'auth.json'),original=fs.lstatSync;let swapped=false;
 fs.lstatSync=function(file,...args){const stat=original(file,...args);if(file===auth&&!swapped){swapped=true;fs.rmSync(auth);execFileSync('/usr/bin/mkfifo',[auth]);}return stat;};syncBuiltinESMExports();
 const api=await import(pathToFileURL(join(repo,'packages/main/dist/core/managed-review-provider-state.js')));
 assert.throws(()=>api.captureManagedProviderState('codex',{CODEX_HOME:scratch}),/regular/);console.log('U08_FIFO_REPLACEMENT_REFUSED');process.exit(0);
}
const api=await import(pathToFileURL(join(repo,'packages/main/dist/core/managed-review-provider-state.js')));
const root=mkdtempSync(join(tmpdir(),'u08-private-state-'));const source=join(root,'source');mkdirSync(source);
const a=JSON.stringify({OPENAI_API_KEY:'fixture-before'}),b=JSON.stringify({OPENAI_API_KEY:'fixture-after'});const auth=join(source,'auth.json');writeFileSync(auth,a);const env={CODEX_HOME:source};
const lane=name=>{const p=join(root,name);mkdirSync(p);return p;};
try{
 // Old API sequence is the actual preflight->later-create seam to be replaced.
 const snapshot=api.captureManagedProviderState?api.captureManagedProviderState('codex',env):(api.preflightManagedProviderState('codex',env),null);
 writeFileSync(auth,b);
 const state=snapshot?api.materializeManagedProviderState(lane('lane-a'),snapshot):api.createManagedProviderState(lane('lane-a'),'codex',env);
 assert.ok(readFileSync(join(state.directory,'auth.json'),'utf8')===a,'capture must prevent source credential drift from changing later materialization');
 assert.equal(JSON.stringify(snapshot),'{}','opaque token serializes no bytes');
 const second=api.materializeManagedProviderState(lane('lane-b'),snapshot);
 assert.notEqual(state.directory,second.directory);writeFileSync(join(state.directory,'auth.json'),b);
 assert.equal(readFileSync(join(second.directory,'auth.json'),'utf8'),a,'one lane refresh cannot modify another lane');
 assert.throws(()=>api.materializeManagedProviderState(lane('forged'),JSON.parse(JSON.stringify(snapshot))),/capability/);
 writeFileSync(auth,'malformed');assert.throws(()=>api.captureManagedProviderState('codex',env),/syntax/);
 rmSync(auth);symlinkSync(join(root,'missing'),auth);assert.throws(()=>api.captureManagedProviderState('codex',env),/regular/);
 rmSync(auth);const target=join(root,'external-auth');writeFileSync(target,a);symlinkSync(target,auth);assert.throws(()=>api.captureManagedProviderState('codex',env),/regular/);
 rmSync(auth);writeFileSync(auth,a);const direct=api.createManagedProviderState(lane('compat'),'codex',env);assert.equal(readFileSync(join(direct.directory,'auth.json'),'utf8'),a);
 const fifo=lane('fifo-source');writeFileSync(join(fifo,'auth.json'),a);
 const probe=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--fifo-worker',repo,fifo],{encoding:'utf8',timeout:1500});
 assert.equal(probe.status,0,'provider file replacement must refuse without blocking on FIFO '+String(probe.error??probe.stderr));assert.match(probe.stdout,/U08_FIFO_REPLACEMENT_REFUSED/);
 console.log('PASS U08 opaque captured state drift/malformed/symlink/lane isolation/create compatibility');
}finally{rmSync(root,{recursive:true,force:true});}
