#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync,existsSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const output=process.env.FIVE_ITEM_PROOF_OUTPUT||join(tmpdir(),'five-identity-'+Date.now());mkdirSync(output,{recursive:true});
const fixture=mkdtempSync(join(tmpdir(),'five-identity-copy-')),rows=[];
const baseEnv={...process.env};delete baseEnv.PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN;delete baseEnv.PROOF_OR_STOP_EXPECTED_IMPLEMENTATION_DIGEST;
function run(entry,args,env={}){const start=performance.now();const r=spawnSync(process.execPath,[entry,...args],{cwd:fixture,encoding:'utf8',env:{...baseEnv,...env},timeout:30000});return {status:r.status,output:r.stdout+r.stderr,elapsedMs:performance.now()-start};}
const check=(name,fn)=>{const result=fn();rows.push({name,...result});console.log('PASS '+name);};
const required=digest=>({PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN:'1',PROOF_OR_STOP_EXPECTED_IMPLEMENTATION_DIGEST:digest});
try{
 // Copy only runtime/package inputs, never real Story state or signing keys.
 for(const name of ['main','utils','lab']){const dest=join(fixture,'packages',name);mkdirSync(dest,{recursive:true});if(existsSync(join(root,'packages',name,'dist')))cpSync(join(root,'packages',name,'dist'),join(dest,'dist'),{recursive:true,verbatimSymlinks:true});cpSync(join(root,'packages',name,'package.json'),join(dest,'package.json'));}
 cpSync(join(root,'packages/main/templates'),join(fixture,'packages/main/templates'),{recursive:true,verbatimSymlinks:true});
 cpSync(join(root,'node_modules'),join(fixture,'node_modules'),{recursive:true,verbatimSymlinks:true});
 const entry=join(fixture,'packages/main/dist/cli.js');
 const identity=run(entry,['--implementation-identity']);assert.equal(identity.status,0,identity.output);const initial=JSON.parse(identity.output);writeFileSync(join(output,'identity-before.json'),JSON.stringify(initial,null,2));
 check('same actual entry and bytes accept the required pin',()=>{const r=run(entry,['--version'],required(initial.digest));assert.equal(r.status,0,r.output);return r;});
 check('required missing pin is refused',()=>{const r=run(entry,['--version'],{PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN:'1'});assert.notEqual(r.status,0);assert.match(r.output,/IMPLEMENTATION_PIN_MISSING_OR_INVALID/);return r;});
 check('same displayed version with changed helper bytes is refused',()=>{const path=join(fixture,'packages/main/dist/core/material-code-policy.js');assert.ok(realpathSync(path).startsWith(realpathSync(fixture)+'/'),'tampering must remain in the runtime copy');const before=readFileSync(path);try{writeFileSync(path,Buffer.concat([before,Buffer.from('\n// same-version implementation drift fixture\n')]));const r=run(entry,['--version'],required(initial.digest));assert.notEqual(r.status,0);assert.match(r.output,/IMPLEMENTATION_PIN_MISMATCH/);const unpinned=run(entry,['--version']);assert.equal(unpinned.status,0);assert.match(unpinned.output,/0\.3\.284/);return {...r,unpinnedVersion:unpinned.output.trim()};}finally{writeFileSync(path,before);}});
 check('same dependency version with changed dependency bytes is refused',()=>{const path=join(fixture,'node_modules/proper-lockfile/index.js');assert.ok(realpathSync(path).startsWith(realpathSync(fixture)+'/'),'tampering must remain in the runtime copy');const before=readFileSync(path);try{writeFileSync(path,Buffer.concat([before,Buffer.from('\n// dependency drift fixture\n')]));const r=run(entry,['--version'],required(initial.digest));assert.notEqual(r.status,0);assert.match(r.output,/IMPLEMENTATION_PIN_MISMATCH/);return r;}finally{writeFileSync(path,before);}});
 check('changed entrypoint bytes are refused',()=>{const before=readFileSync(entry);try{writeFileSync(entry,Buffer.concat([before,Buffer.from('\n// entry drift fixture\n')]));const r=run(entry,['--version'],required(initial.digest));assert.notEqual(r.status,0);assert.match(r.output,/IMPLEMENTATION_PIN_MISMATCH/);return r;}finally{writeFileSync(entry,before);}});
 check('restored bytes recover the original identity',()=>{const r=run(entry,['--implementation-identity']);assert.equal(r.status,0);assert.equal(JSON.parse(r.output).digest,initial.digest);return {status:r.status,digest:initial.digest};});
 const timings=[];for(let pair=1;pair<=5;pair++)for(const mode of pair%2?['unpinned','pinned']:['pinned','unpinned']){const r=run(entry,['--version'],mode==='pinned'?required(initial.digest):{});assert.equal(r.status,0,r.output);timings.push({pair,mode,elapsedMs:r.elapsedMs});}
 writeFileSync(join(output,'identity-results.json'),JSON.stringify({rows,timings,packageVersion:initial.packageVersion,limitations:['opt-in host transport guard; no assertion that existing owners or reviewers received this pin','entrypoint, runtime files, declared transitive dependencies and Node/options are bound; not a hostile-host sandbox','pin adds verification work; it is an accuracy and early-refusal repair, not a hash speedup','same-version runtime-copy tampering tests do not touch the Lab or main runtime']},null,2));
}finally{rmSync(fixture,{recursive:true,force:true});}
console.log('IMPLEMENTATION_IDENTITY_GREEN');
