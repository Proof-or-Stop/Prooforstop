import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=mkdtempSync(join(tmpdir(),'pos-certification-mutator-'));
try {
 cpSync(resolve('packages/main/dist'),join(root,'dist'),{recursive:true});
 cpSync(resolve('packages/main/templates'),join(root,'templates'),{recursive:true});
 writeFileSync(join(root,'package.json'),'{"type":"module"}');
 symlinkSync(createRequire(import.meta.url).resolve('smol-toml').split('/smol-toml/')[0],join(root,'node_modules'),'dir');
 const target=join(root,'dist/core/review-inventory-epoch.js');
 const before=readFileSync(target,'utf8');
 const run=(command)=>spawnSync(process.execPath,['--input-type=module','--eval',`
 import {createCertificationWindowHandlers} from ${JSON.stringify(pathToFileURL(join(root,'dist/handlers/certification-window.js')).href)};
 let touches=0; const store=new Proxy({}, {get(){touches++;throw new Error('STORE_TOUCHED');}});
 try { createCertificationWindowHandlers({root:${JSON.stringify(root)},store})[${JSON.stringify(command)}]({storyId:'B-pin-proof',reason:'test'}); } catch(e) {console.log(JSON.stringify({message:e.message,touches}));}
 `],{encoding:'utf8'});
 for(const command of ['certification_window_begin','certification_window_cancel']) {
  writeFileSync(target,before+'\nexport const labMutation = true;\n');
  const r=run(command);assert.equal(r.status,0,r.stderr);
  const result=JSON.parse(r.stdout.trim());
  assert.match(result.message,/review-inventory-epoch.ts consumer rejected active identity bytes/,'MUTATOR_MUST_CHECK_PIN_BEFORE_STORE');
  assert.equal(result.touches,0,'MUTATOR_MUST_NOT_TOUCH_STORE_ON_PIN_REFUSAL');
  writeFileSync(target,before);
  const restored=run(command);assert.equal(restored.status,0,restored.stderr);
  const ok=JSON.parse(restored.stdout.trim());assert.match(ok.message,/STORE_TOUCHED/);assert(ok.touches>0,'restored implementation must reach normal store path');
 }
 console.log('CERTIFICATION_MUTATOR_PIN_GREEN begin-cancel reject-before-store restored-control');
}finally {rmSync(root,{recursive:true,force:true});}
