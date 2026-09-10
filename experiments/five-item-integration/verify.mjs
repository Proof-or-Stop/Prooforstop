import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname, resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const checks=JSON.parse(readFileSync(new URL('./checks.json', import.meta.url)));
const output=process.env.FIVE_ITEM_INTEGRATION_OUTPUT || mkdtempSync(join(tmpdir(),'pos-five-item-integration-'));
mkdirSync(output,{recursive:true});
const results=[];
for (const [index, file] of checks.entries()) {
 const dest=join(output,String(index).padStart(2,'0'));mkdirSync(dest,{recursive:true});
 const start=performance.now();
 const r=spawnSync(process.execPath,[file],{cwd:root,encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024,env:{...process.env,FIVE_ITEM_PROOF_OUTPUT:dest,CHECKPOINT_TEST_RUNTIME:root}});
 writeFileSync(join(dest,'stdout.log'),r.stdout??'');writeFileSync(join(dest,'stderr.log'),r.stderr??'');
 results.push({file,exitCode:r.status,signal:r.signal,error:r.error?.message,seconds:(performance.now()-start)/1000});
 writeFileSync(join(output,'results.json'),JSON.stringify(results,null,2)+'\n');
 console.log(JSON.stringify(results.at(-1)));
 if(r.status!==0){process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');}
 assert.equal(r.status,0,'FIVE_ITEM_INTEGRATION_REGRESSION: '+file);
}
console.log('FIVE_ITEM_INTEGRATION_GREEN '+JSON.stringify({checks:results.length,output}));
