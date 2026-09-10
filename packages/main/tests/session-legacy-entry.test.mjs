import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync,realpathSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const legacyArg=process.argv.find(x=>x.startsWith('--legacy-root='));
assert.ok(legacyArg,'Pass a privately copied historical runtime with --legacy-root=PATH');
const legacy=realpathSync(resolve(legacyArg.slice('--legacy-root='.length))),oldEntry=join(legacy,'packages/main/dist/cli.js');
const root=mkdtempSync(join(tmpdir(),'proof-session-legacy-')),manifest=join(root,'epoch.json'),launcher=join(repo,'scripts/implementation-session.mjs');
const env={...process.env};for(const key of ['PROOF_OR_STOP_IMPLEMENTATION_MANIFEST','PROOF_OR_STOP_EXPECTED_IMPLEMENTATION_DIGEST','PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN'])delete env[key];
const invoke=args=>{const began=performance.now();const r=spawnSync(process.execPath,[launcher,...args],{cwd:root,env,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});return{...r,elapsedMs:performance.now()-began};};
try {
 const capture=invoke(['capture',manifest]);assert.equal(capture.status,0,capture.stderr);const epoch=JSON.parse(readFileSync(manifest,'utf8'));
 for(const name of ['proof-or-stop','proof-or-stop-codex']) {
  const good=invoke(['exec',manifest,'--',name,'--version']);assert.equal(good.status,0,good.stderr);
  const witnesses=good.stderr.split('\n').filter(x=>x.startsWith('IMPLEMENTATION_SESSION_WITNESS ')).map(x=>JSON.parse(x.slice('IMPLEMENTATION_SESSION_WITNESS '.length)));
  assert.ok(witnesses.some(x=>x.entrypoint.endsWith('/'+name+'.js')&&x.argvDigest===createHash('sha256').update(JSON.stringify(['--version'])).digest('hex')));
  console.log('PASS approved actual entry '+name);
 }
 const generic=invoke(['exec',manifest,'--',process.execPath,'-e','console.log("ordinary-node-ok")']);assert.equal(generic.status,0,generic.stderr);assert.match(generic.stdout,/ordinary-node-ok/);
 const unbound=spawnSync(process.execPath,[oldEntry,'--version'],{cwd:legacy,env,encoding:'utf8',timeout:20000});assert.equal(unbound.status,0,unbound.stderr);assert.match(unbound.stdout,/0\.3\.275/,'actual historical CLI is required');
 const bad=invoke(['exec',manifest,'--',process.execPath,oldEntry,'--version']);
 console.log('LEGACY_RESULT '+JSON.stringify({elapsedMs:bad.elapsedMs,exitCode:bad.status,stdout:bad.stdout,stderr:bad.stderr}));
 assert.notEqual(bad.status,0,'LEGACY_IDENTITY_ESCAPE_RED: unapproved historical CLI ignored inherited session pin');
 assert.equal(bad.stdout,'');assert.match(bad.stderr,/IMPLEMENTATION_SESSION_ENTRY_REFUSED/);
 const nested=invoke(['exec',manifest,'--','/bin/sh','-c','exec "$1" "$2" --version','guard',process.execPath,oldEntry]);
 assert.notEqual(nested.status,0);assert.equal(nested.stdout,'');assert.match(nested.stderr,/IMPLEMENTATION_SESSION_ENTRY_REFUSED/);
 const malformed=join(root,'bad.json');writeFileSync(malformed,JSON.stringify({...epoch,digest:'0'.repeat(64)}));
 const reject=invoke(['exec',malformed,'--','proof-or-stop','--version']);assert.notEqual(reject.status,0);assert.equal(reject.stdout,'');
 console.log('SESSION_LEGACY_ENTRY_GREEN');
} finally {rmSync(root,{recursive:true,force:true});}
