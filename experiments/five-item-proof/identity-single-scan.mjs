import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
const root=resolve(import.meta.dirname,'../..');
const output=process.env.FIVE_ITEM_PROOF_OUTPUT;
if(output)mkdirSync(output,{recursive:true});
const dir=mkdtempSync(join(tmpdir(),'identity-single-scan-'));
const log=join(dir,'reads.json');
writeFileSync(join(dir,'probe.mjs'),`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const read=fs.readFileSync;let reads=0;fs.readFileSync=function(path,...args){if(String(path)===fs.realpathSync(process.execPath))reads++;return read.call(this,path,...args);};syncBuiltinESMExports();process.on('exit',()=>fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({nodeExecutableReads:reads})));`);
const env={...process.env};delete env.PROOF_OR_STOP_EXPECTED_IMPLEMENTATION_DIGEST;delete env.PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN;
const args=['--import',join(dir,'probe.mjs'),join(root,'bin/proof-or-stop.js'),'--implementation-identity'];
const run=extra=>{const start=performance.now();const p=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024,env:{...env,...extra}});assert.equal(p.status,0,p.stdout+p.stderr);return {identity:JSON.parse(p.stdout),elapsedMs:performance.now()-start,...JSON.parse(readFileSync(log))};};
try{
 const first=run({});const pinned=run({PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN:'1',PROOF_OR_STOP_EXPECTED_IMPLEMENTATION_DIGEST:first.identity.digest});
 assert.deepEqual(pinned.identity,first.identity,'No identity field or file may be omitted to reduce cost');
 const result={fileCount:first.identity.fileCount,unpinnedReads:first.nodeExecutableReads,pinnedReads:pinned.nodeExecutableReads,unpinnedMs:first.elapsedMs,pinnedMs:pinned.elapsedMs};
 if(output)writeFileSync(join(output,'single-scan.json'),JSON.stringify(result,null,2));
 assert.equal(first.nodeExecutableReads,1);
 assert.equal(pinned.nodeExecutableReads,1,'DUPLICATE_PIN_IDENTITY_SCAN: strict identity output must return the just-enforced content identity without rescanning');
 console.log('SINGLE_PIN_IDENTITY_SCAN_GREEN '+JSON.stringify(result));
}finally{rmSync(dir,{recursive:true,force:true});}
