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
delete imports.default;
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
  await check('baseline reuse detects between-operation drift instead of blessing it',()=>{
    const o=observer(),first=o.before(injection);o.after(first,'unchanged');
    const path=join(root,'material.txt'),bytes=fs.readFileSync(path);
    try {
      fs.writeFileSync(path,'unexpected between-case write');
      const second=o.before(injection);assert.throws(()=>o.after(second,'drift escaped'));
    } finally {fs.writeFileSync(path,bytes);}
  });
  for(const target of ['../../../material.txt','missing-target']) await check('ignored compiled symlink falls back: '+target,()=>{
    fs.rmSync(injection);fs.symlinkSync(target,injection);
    try {
      const o=observer();for(let i=0;i<2;i++){const before=o.before(injection);o.after(before,'unchanged');}
      assert.equal(o.stats.snapshots,4);
    } finally {fs.rmSync(injection);fs.writeFileSync(injection,'canonical');}
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
    const witness=JSON.parse(result.stderr.split('\n').find(s=>s.startsWith('IMPLEMENTATION_SESSION_WITNESS ')).slice('IMPLEMENTATION_SESSION_WITNESS '.length));
    assert.equal(witness.digest,identity.digest);assert.equal(witness.entrypoint,entry);
    assert.equal(witness.argvDigest,createHash('sha256').update(JSON.stringify(['--version'])).digest('hex'));
    assert.equal(witness.pid,result.pid);
  });
  await check('inherited session wrapper binds a nested owner process',()=>{
    const result=spawnSync(process.execPath,[join(repo,'scripts/implementation-session.mjs'),'exec',manifest,'--','proof-or-stop','--version'],{cwd:root,env,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);assert.match(result.stderr,/IMPLEMENTATION_SESSION_WITNESS/);
    assert.match(result.stdout,/0\.3\./);
  });
  await check('direct alternative entry and conflicting pins refuse',()=>{
    const direct=spawnSync(process.execPath,[join(repo,'packages/main/dist/cli.js'),'--version'],{cwd:repo,env:{...env,PROOF_OR_STOP_IMPLEMENTATION_MANIFEST:manifest},encoding:'utf8'});
    assert.notEqual(direct.status,0);assert.match(direct.stderr,/IMPLEMENTATION_MANIFEST_ENTRYPOINT_MISMATCH/);
    const conflict=run(['--version'],{PROOF_OR_STOP_IMPLEMENTATION_MANIFEST:manifest,PROOF_OR_STOP_EXPECTED_IMPLEMENTATION_DIGEST:'0'.repeat(64)});
    assert.notEqual(conflict.status,0);assert.match(conflict.stderr,/IMPLEMENTATION_MANIFEST_PIN_CONFLICT/);
  });
  await check('capture admits both canonical host entries and never overwrites an epoch',()=>{
    const path=join(temporary,'cohort.json'),script=join(repo,'scripts/implementation-session.mjs');
    const capture=()=>spawnSync(process.execPath,[script,'capture',path],{cwd:repo,env,encoding:'utf8'});
    const first=capture();assert.equal(first.status,0,first.stderr);
    const bytes=fs.readFileSync(path),cohort=JSON.parse(bytes);
    assert.equal(cohort.entrypoints.length,2);
    const codex=spawnSync(process.execPath,[script,'exec',path,'--','proof-or-stop-codex','--version'],{cwd:root,env,encoding:'utf8'});
    assert.equal(codex.status,0,codex.stderr);
    const witness=JSON.parse(codex.stderr.split('\n').find(s=>s.startsWith('IMPLEMENTATION_SESSION_WITNESS ')).slice('IMPLEMENTATION_SESSION_WITNESS '.length));
    assert.equal(witness.entrypoint,join(repo,'bin/proof-or-stop-codex.js'));
    assert.equal(witness.digest,cohort.entrypoints.find(e=>e.entrypoint===witness.entrypoint).digest);
    const second=capture();assert.notEqual(second.status,0);assert.deepEqual(fs.readFileSync(path),bytes);
  });
  await check('malformed and ambiguous manifest entries refuse',()=>{
    for(const entrypoints of [[],[null],[{entrypoint:entry,digest:identity.digest},{entrypoint:entry,digest:identity.digest}],[{entrypoint:entry,digest:'wrong'}]]) {
      fs.writeFileSync(manifest,JSON.stringify({schema:'execution-session.v1',entrypoint:entry,digest:identity.digest,entrypoints}));
      const result=run(['--version'],{PROOF_OR_STOP_IMPLEMENTATION_MANIFEST:manifest});
      assert.notEqual(result.status,0);assert.match(result.stderr,/IMPLEMENTATION_MANIFEST_INVALID/);
    }
  });
  await check('same-version helper change invalidates an actual private runtime manifest',()=>{
    const copy=join(temporary,'runtime');fs.mkdirSync(copy);
    const paths=['package.json','bin','scripts/build-lock.mjs','scripts/build-lock-target.mjs',
      ...['main','utils','lab'].flatMap(name=>['dist','package.json','templates'].map(part=>'packages/'+name+'/'+part))];
    for(const path of paths) if(fs.existsSync(join(repo,path))) {fs.mkdirSync(dirname(join(copy,path)),{recursive:true});fs.cpSync(join(repo,path),join(copy,path),{recursive:true});}
    fs.symlinkSync(join(repo,'node_modules'),join(copy,'node_modules'),'dir');
    fs.symlinkSync(join(repo,'packages/main/node_modules'),join(copy,'packages/main/node_modules'),'dir');
    const entry=join(copy,'bin/proof-or-stop.js');
    const invoke=(args,extra={})=>spawnSync(process.execPath,[entry,...args],{cwd:copy,env:{...env,...extra},encoding:'utf8',maxBuffer:4*1024*1024});
    const first=invoke(['--implementation-identity']);assert.equal(first.status,0,first.stderr);
    const identity=JSON.parse(first.stdout),path=join(copy,'manifest.json');
    fs.writeFileSync(path,JSON.stringify({schema:'execution-session.v1',entrypoint:identity.entrypoint,digest:identity.digest}));
    const clean=invoke(['--version'],{PROOF_OR_STOP_IMPLEMENTATION_MANIFEST:path});assert.equal(clean.status,0,clean.stderr);
    const helper=join(copy,'scripts/build-lock-target.mjs');fs.appendFileSync(helper,'\n// private same-version drift control\n');
    const changed=invoke(['--version'],{PROOF_OR_STOP_IMPLEMENTATION_MANIFEST:path});
    assert.notEqual(changed.status,0);assert.match(changed.stderr,/IMPLEMENTATION_PIN_MISMATCH/);
    const next=invoke(['--implementation-identity']);assert.equal(next.status,0,next.stderr);
    assert.equal(JSON.parse(next.stdout).packageVersion,identity.packageVersion);
    assert.notEqual(JSON.parse(next.stdout).digest,identity.digest);
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
