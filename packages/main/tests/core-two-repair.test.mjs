import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createPrivateMutationObserver } from './support/private-mutation-observer.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const temporary = fs.mkdtempSync(join(tmpdir(), 'proof-or-stop-core-two-'));
const failures = [];
async function check(name, fn) {
  try { await fn(); console.log('PASS ' + name); }
  catch (error) { failures.push(name); console.error('CORE_TWO_RED ' + name + ': ' + error.message); }
}
// Exercise the exact production test snapshot, not a reduced imitation.
const source = fs.readFileSync(join(repo, 'packages/main/tests/canonical-new-story-artifacts.test.mjs'), 'utf8');
const ast = ts.createSourceFile('test.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = ['git', 'snapshotTree', 'snapshotGitMaterial', 'snapshotPublicOperationState'];
const functions = names.map(name => {
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(fn, name); return fn.getText(ast);
}).join('\n');
const imports = { ...fs, execFileSync, join, createHash };
const snapshot = new Function(...Object.keys(imports), functions + '\nreturn snapshotPublicOperationState;')(...Object.values(imports));
const root = join(temporary, 'private'); fs.mkdirSync(root);
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
git(['init', '-b', 'main']); git(['config','user.name','Lab fixture']); git(['config','user.email','lab@example.invalid']);
fs.writeFileSync(join(root,'.gitignore'), 'packages/main/dist/\n');
fs.writeFileSync(join(root,'material.txt'), 'must remain observable');
git(['add','.']); git(['commit','-m','fixture baseline']);
fs.mkdirSync(join(root,'packages/main/dist'),{recursive:true});
const injection = join(root,'packages/main/dist/consumer.js');
fs.writeFileSync(injection,'canonical');
const observer = () => createPrivateMutationObserver({root,snapshot:()=>snapshot(root,[])});
try {
  await check('SNAPSHOT_REPEAT: four ignored injections need at most five complete snapshots', () => {
    const o = observer();
    for(let i=0;i<4;i++) {
      fs.writeFileSync(injection,'invalid-'+i);
      const before=o.before(injection); o.after(before,'no-op changed state');
      fs.writeFileSync(injection,'canonical');
    }
    console.log('OBSERVER_COUNT '+JSON.stringify(o.stats));
    assert.equal(o.stats.operations,4);
    assert.ok(o.stats.snapshots<=5,`expected <=5; actual ${o.stats.snapshots}`);
  });
  await check('each operation still detects same-size material changes with restored mtime', () => {
    const o=observer(),path=join(root,'material.txt'),bytes=fs.readFileSync(path),stat=fs.statSync(path);
    const before=o.before(injection);
    fs.writeFileSync(path,Buffer.alloc(bytes.length,88)); fs.utimesSync(path,stat.atime,stat.mtime);
    assert.throws(()=>o.after(before,'mutation escaped'));
    fs.writeFileSync(path,bytes);
  });
  await check('tracked injected paths still take fresh before and after snapshots', () => {
    const o=observer(),path=join(root,'material.txt'),bytes=fs.readFileSync(path);
    for(let i=0;i<2;i++) { fs.writeFileSync(path,'intended-'+i); const before=o.before(path);o.after(before,'unchanged');fs.writeFileSync(path,bytes); }
    assert.equal(o.stats.snapshots,4);
  });
  for(const kind of ['file','symlink','index','ref','runtime']) await check('detect '+kind+' mutation after ignored injection',()=>{
    const o=observer(),before=o.before(injection),created=join(root,'new-'+kind);
    try {
      if(kind==='file') fs.writeFileSync(created,'');
      if(kind==='symlink') fs.symlinkSync('material.txt',created);
      if(kind==='index') {fs.writeFileSync(created,'new');git(['add',created]);}
      if(kind==='ref') git(['branch','intruder']);
      if(kind==='runtime') {fs.mkdirSync(join(root,'.proof-or-stop/runtime'),{recursive:true});fs.writeFileSync(join(root,'.proof-or-stop/runtime/changed'),'changed');}
      assert.throws(()=>o.after(before,'mutation escaped'));
    } finally {
      if(kind==='index') git(['reset','--',created]);
      if(kind==='ref') git(['branch','-D','intruder']);
      fs.rmSync(created,{force:true});fs.rmSync(join(root,'.proof-or-stop'),{recursive:true,force:true});
    }
  });
  const entry=join(repo,'bin/proof-or-stop.js');
  const env={...process.env};
  for(const name of ['PROOF_OR_STOP_IMPLEMENTATION_MANIFEST','PROOF_OR_STOP_EXPECTED_IMPLEMENTATION_DIGEST','PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN']) delete env[name];
  const run=(args,extra={})=>spawnSync(process.execPath,[entry,...args],{cwd:repo,env:{...env,...extra},encoding:'utf8',maxBuffer:4*1024*1024});
  const observed=run(['--implementation-identity']);assert.equal(observed.status,0,observed.stderr);
  const identity=JSON.parse(observed.stdout);
  const manifest=join(temporary,'implementation.json');
  fs.writeFileSync(manifest,JSON.stringify({schema:'execution-session.v1',entrypoint:entry,digest:identity.digest}));
  await check('matching session manifest admits the actual owner command',()=>{
    const result=run(['--version'],{PROOF_OR_STOP_IMPLEMENTATION_MANIFEST:manifest});
    assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/0\.3\./);
  });
  await check('SESSION_BINDING: wrong manifest must refuse without separately supplied pin variables',()=>{
    fs.writeFileSync(manifest,JSON.stringify({schema:'execution-session.v1',entrypoint:entry,digest:'0'.repeat(64)}));
    const result=run(['--version'],{PROOF_OR_STOP_IMPLEMENTATION_MANIFEST:manifest});
    assert.notEqual(result.status,0,'wrong session manifest was silently ignored');
    assert.match(result.stderr,/IMPLEMENTATION_PIN_MISMATCH/);
  });
  await check('missing session manifest refuses',()=>{
    const result=run(['--version'],{PROOF_OR_STOP_IMPLEMENTATION_MANIFEST:manifest+'.missing'});
    assert.notEqual(result.status,0,'missing session manifest was silently ignored');
    assert.match(result.stderr,/IMPLEMENTATION_MANIFEST/);
  });
  await check('existing explicit wrong pin still refuses',()=>{
    const result=run(['--version'],{PROOF_OR_STOP_EXPECTED_IMPLEMENTATION_DIGEST:'0'.repeat(64),PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN:'1'});
    assert.notEqual(result.status,0);assert.match(result.stderr,/IMPLEMENTATION_PIN_MISMATCH/);
  });
} finally {fs.rmSync(temporary,{recursive:true,force:true});}
if(failures.length) process.exitCode=1;
else console.log('CORE_TWO_GREEN');
