import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,symlinkSync,rmSync,realpathSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const legacyArg=process.argv.find(x=>x.startsWith('--legacy-root='));assert.ok(legacyArg);
const oldEntry=join(realpathSync(resolve(legacyArg.slice('--legacy-root='.length))),'packages/main/dist/cli.js');
const root=mkdtempSync(join(tmpdir(),'proof-entry-adversarial-')),manifest=join(root,'epoch.json'),launcher=join(repo,'scripts/implementation-session.mjs');
const env={...process.env};for(const key of ['PROOF_OR_STOP_IMPLEMENTATION_MANIFEST','PROOF_OR_STOP_EXPECTED_IMPLEMENTATION_DIGEST','PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN'])delete env[key];
const invoke=(args,extra={})=>spawnSync(process.execPath,[launcher,...args],{cwd:root,env:{...env,...extra},encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
try {
 const capture=invoke(['capture',manifest]);assert.equal(capture.status,0,capture.stderr);const bytes=readFileSync(manifest),epoch=JSON.parse(bytes);
 const alias=join(root,'unrelated-name.js');symlinkSync(oldEntry,alias);
 const aliasRun=invoke(['exec',manifest,'--',process.execPath,alias,'--version']);assert.notEqual(aliasRun.status,0);assert.match(aliasRun.stderr,/IMPLEMENTATION_SESSION_ENTRY_REFUSED/);assert.equal(aliasRun.stdout,'');console.log('PASS renamed symlink cannot hide a recognized old CLI');
 const host=join(root,'tamper-host.cjs');
 writeFileSync(host,`const fs=require('node:fs'),cp=require('node:child_process');const p=process.env.PROOF_OR_STOP_IMPLEMENTATION_MANIFEST;const m=JSON.parse(fs.readFileSync(p));m.entrypoints.push({entrypoint:${JSON.stringify(oldEntry)},digest:'0'.repeat(64)});fs.writeFileSync(p,JSON.stringify(m));const r=cp.spawnSync(process.execPath,[${JSON.stringify(oldEntry)},'--version'],{stdio:'inherit',env:process.env});process.exit(r.status??1);`);
 const injected=invoke(['exec',manifest,'--',process.execPath,host]);assert.notEqual(injected.status,0);assert.match(injected.stderr,/IMPLEMENTATION_SESSION_ENTRY_REFUSED/);assert.equal(injected.stdout,'');console.log('PASS post-admission manifest injection cannot enroll unaware CLI');writeFileSync(manifest,bytes);
 const wrong={...epoch,entrypoints:epoch.entrypoints.map(row=>({...row,digest:'0'.repeat(64)})),digest:'0'.repeat(64)};writeFileSync(manifest,JSON.stringify(wrong));
 const stale=invoke(['exec',manifest,'--','proof-or-stop','--version']);assert.notEqual(stale.status,0);assert.match(stale.stderr,/IMPLEMENTATION_PIN_MISMATCH/);assert.equal(stale.stdout,'');console.log('PASS approved path still requires correct implementation bytes');writeFileSync(manifest,bytes);
 const changed=invoke(['exec',manifest,'--',process.execPath,'-e','console.log("SHOULD_NOT_RUN")'],{NODE_OPTIONS:[env.NODE_OPTIONS,'--stack-trace-limit=99'].filter(Boolean).join(' ')});
 assert.notEqual(changed.status,0);assert.match(changed.stderr,/session transport changed/);assert.equal(changed.stdout,'');console.log('PASS changed Node transport refuses before host execution');
 const ordinary=join(root,'ordinary-tool');mkdirSync(join(ordinary,'dist'),{recursive:true});writeFileSync(join(ordinary,'package.json'),JSON.stringify({name:'ordinary-unrelated-cli'}));writeFileSync(join(ordinary,'dist/cli.js'),'console.log("ordinary-cli-ok")');
 const allowed=invoke(['exec',manifest,'--',process.execPath,join(ordinary,'dist/cli.js')]);assert.equal(allowed.status,0,allowed.stderr);assert.match(allowed.stdout,/ordinary-cli-ok/);console.log('PASS unrelated Node CLI remains available');
 console.log('SESSION_ENTRY_ADVERSARIAL_GREEN');
} finally {rmSync(root,{recursive:true,force:true});}
