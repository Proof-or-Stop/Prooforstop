import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LAB_VERSION_FIXTURE_CLI_TIMEOUT_MS,assertLabVersionFixtureTransport} from './lab-version-fixture-transport.mjs';
import {withLabVersionSourceEvidence as versionTransaction} from './lab-version-source-evidence.mjs';
const fixtureVersionPaths=['package.json','package-lock.json','packages/main/package.json','packages/main/package-lock.json','packages/main/src/core/proof-or-stop-brand.ts','packages/lab/package-lock.json','packages/utils/package-lock.json'];
const withLabVersionSourceEvidence=(root,bump)=>versionTransaction(root,bump,fixtureVersionPaths.slice(0,5));
assert.throws(()=>versionTransaction('.',()=>assert.fail('drift must refuse before mutation'),[...fixtureVersionPaths.slice(0,5),'new-version-output.json']),error=>error.message.split('\n')[0]==='version output allowlist drifted from VERSION_SYNC_PATHS');
import {copyLabFixtureSources} from './lab-fixture-sources.mjs';
import {installLabAuditFixtureProviders} from './lab-audit-fixture-provider.mjs';
const invalidVersionRoot=mkdtempSync(join(tmpdir(),'lab-invalid-version-utf8-'));
try {const bytes=Buffer.from([0xff]);writeFileSync(join(invalidVersionRoot,'package.json'),bytes);
 assert.throws(()=>withLabVersionSourceEvidence(invalidVersionRoot,()=>assert.fail('invalid bytes must refuse before producer')),error=>error.message.split('\n')[0]==='version source must be valid UTF-8');
 assert.deepEqual(readFileSync(join(invalidVersionRoot,'package.json')),bytes);
} finally {rmSync(invalidVersionRoot,{recursive:true,force:true});}
const timedOutChild=spawnSync(process.execPath,['-e','setTimeout(()=>{},10000)'],{timeout:20,encoding:'utf8'});
assert.equal(timedOutChild.error?.code,'ETIMEDOUT');
assert.throws(()=>assertLabVersionFixtureTransport(timedOutChild,'finish'),error=>error.message==='LAB_VERSION_FIXTURE_CLI_TIMEOUT: finish exceeded 60000ms (signal=SIGTERM)');
assert.throws(()=>assertLabVersionFixtureTransport({error:new Error('spawn unavailable'),signal:null},'create'),error=>error.message==='LAB_VERSION_FIXTURE_CLI_TRANSPORT: create: Error: spawn unavailable');
assert.throws(()=>assertLabVersionFixtureTransport({signal:'SIGTERM'},'green'),error=>error.message==='LAB_VERSION_FIXTURE_CLI_TRANSPORT: green: SIGTERM');
assert.equal(assertLabVersionFixtureTransport({status:1,signal:null},'finish').status,1,'ordinary contract refusal remains distinct');
// Each negative must reach its intended guard, not merely any refusal.
const EXPECTED={
 hash:'stale source evidence requires review before version bump',
 'entry-hash':'stale exception source requires review before version bump',
 excerpt:'stale excerpt requires review before version bump', dependency:'stale dependency requires review before version bump',
 range:'invalid source evidence range', semantic:'version refresh refuses source formatting changes',
 'nested-version':'version evidence refresh refuses non-version package changes',
 'producer-manifest':'version producer cannot modify source evidence',format:'version refresh refuses source line movement',
 historical:'source evidence historical flag malformed',minor:'only an official patch bump can refresh source evidence',
 major:'only an official patch bump can refresh source evidence',downgrade:'only an official patch bump can refresh source evidence',skip:'only an official patch bump can refresh source evidence',
 malformed:'malformed patch version','malformed-from':'malformed patch version',undeclared:'undeclared version output',unexpected:'version output allowlist drifted from producer outputs',
 'manifest-format':'version refresh refuses manifest reformatting',
 'created-output':'version producer created an absent output',
 'brand-extra':'only the CLI version declaration may change','brand-duplicate':'version declaration must be unique',
};
for (const scenario of Object.keys(EXPECTED)) {
 const root=mkdtempSync(join(tmpdir(),'lab-version-negative-'));
 try {
  const isBrand=scenario.startsWith('brand-');
  const file=isBrand?'packages/main/src/core/proof-or-stop-brand.ts':'package.json',manifest='scripts/lab/u18-static-edges/exceptions.json';
  const before=isBrand?("export const PROOF_OR_STOP_CLI_VERSION = '1.0.0';\n".repeat(scenario==='brand-duplicate'?2:1)+"export const marker = true;\n"):JSON.stringify({version:'1.0.0',scripts:{test:'node check.js'},packages:{'':{version:'1.0.0'},'packages/utils':{version:'1.0.0'}}},null,2)+'\n';
  const digest=createHash('sha256').update(before).digest('hex');
  const evidence={file,sourceDigest:digest,startLine:1,endLine:before.split('\n').length,excerpt:before};
  const entry={key:file+':1:fixture',sourceDigest:digest,requiredEvidence:[evidence],dependencyDigests:{[file]:digest}};
  if(scenario==='entry-hash')entry.sourceDigest='0'.repeat(64);
  if(scenario==='hash')evidence.sourceDigest='0'.repeat(64);
  if(scenario==='excerpt')evidence.excerpt='stale';
  if(scenario==='dependency')entry.dependencyDigests[file]='0'.repeat(64);
  if(scenario==='range')evidence.startLine=0;
  if(scenario==='format'){evidence.endLine=1;evidence.excerpt=before.split('\n')[0];}
  if(scenario==='historical')evidence.historical='true';
  mkdirSync(dirname(join(root,manifest)),{recursive:true});
  mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),before);
  const original=JSON.stringify({schema:'u18-static-exceptions.v1',entries:[entry]},null,scenario==='manifest-format'?undefined:2)+(scenario==='manifest-format'?'':'\n');
  writeFileSync(join(root,manifest),original);
  assert.throws(()=>withLabVersionSourceEvidence(root,()=>{
   let after=before.replace('1.0.0','1.0.1');
   if(scenario==='brand-extra')after=after.replace('marker = true','marker = false');
   if(scenario==='nested-version'){const data=JSON.parse(before);data.packages['packages/utils'].version='1.0.1';after=JSON.stringify(data,null,2)+'\n';}
   if(scenario==='created-output')writeFileSync(join(root,'package-lock.json'),'{}');
   if(scenario==='semantic')after=after.replace('node check.js','node bypass.js');
   if(scenario==='format')after=JSON.stringify(JSON.parse(after))+'\n';
   writeFileSync(join(root,file),after);
   if(scenario==='producer-manifest')writeFileSync(join(root,manifest),'{}');
   const to={minor:'1.1.0',major:'2.0.0',downgrade:'0.9.9',skip:'1.0.2',malformed:'1.x'}[scenario]??'1.0.1';
   return {from:scenario==='malformed-from'?'x.0.0':'1.0.0',to,files:scenario==='created-output'?[file,'package-lock.json']:scenario==='undeclared'?[]:scenario==='unexpected'?[file,'outside.txt']:[file]};
  }), error=>error.message.split('\n')[0]===EXPECTED[scenario], scenario);
  assert.equal(existsSync(join(root,'package-lock.json')),false,scenario+' absent output rollback');
  assert.equal(readFileSync(join(root,file),'utf8'),before,scenario+' version rollback');
  assert.equal(readFileSync(join(root,manifest),'utf8'),original,scenario+' evidence rollback');
 } finally {rmSync(root,{recursive:true,force:true});}
}
// No-manifest projects must retain the generic release producer's formatting.
{
 const root=mkdtempSync(join(tmpdir(),'lab-no-manifest-'));
 try {
  writeFileSync(join(root,'package.json'),'{{"version":"1.0.0"}}'.slice(1,-1));
  const result=withLabVersionSourceEvidence(root,()=>{writeFileSync(join(root,'package.json'),JSON.stringify({version:'1.0.1'},null,2)+'\n');return {from:'1.0.0',to:'1.0.1',files:['package.json']};});
  assert.equal(result.to,'1.0.1');assert.equal(JSON.parse(readFileSync(join(root,'package.json'))).version,'1.0.1');
 } finally {rmSync(root,{recursive:true,force:true});}
}
// A failed atomic manifest publication restores all prior bytes without debris.
{
 const root=mkdtempSync(join(tmpdir(),'lab-atomic-evidence-')),manifest='scripts/lab/u18-static-edges/exceptions.json';
 const before=JSON.stringify({version:'1.0.0'},null,2)+'\n',digest=createHash('sha256').update(before).digest('hex');
 const original=JSON.stringify({schema:'u18-static-exceptions.v1',entries:[{key:'package.json:1:fixture',sourceDigest:digest,requiredEvidence:[],dependencyDigests:{'package.json':digest}}]},null,2)+'\n';
 mkdirSync(dirname(join(root,manifest)),{recursive:true});writeFileSync(join(root,'package.json'),before);writeFileSync(join(root,manifest),original);
 const rename=fs.renameSync;let injected=false;
 try {
  fs.renameSync=(from,to)=>{if(to===join(root,manifest)&&!injected){injected=true;throw new Error('ATOMIC_MANIFEST_RENAME_FAULT');}return rename(from,to);};
  assert.throws(()=>withLabVersionSourceEvidence(root,()=>{writeFileSync(join(root,'package.json'),before.replace('1.0.0','1.0.1'));return {from:'1.0.0',to:'1.0.1',files:['package.json']};}),/ATOMIC_MANIFEST_RENAME_FAULT/);
  assert.equal(readFileSync(join(root,'package.json'),'utf8'),before);assert.equal(readFileSync(join(root,manifest),'utf8'),original);
  assert(fs.readdirSync(root,{recursive:true}).every(file=>!String(file).includes('.lab-version-')));
 } finally {fs.renameSync=rename;rmSync(root,{recursive:true,force:true});}
}
const source=fileURLToPath(new URL('..',import.meta.url));
const dir=mkdtempSync(join(tmpdir(),'lab-version-evidence-')),root=join(dir,'repo');
const write=(file,text)=>{mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),text);};
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const commit=(cwd,message)=>{git(cwd,'add','-A','--','.',':!AGENTS.override.md');git(cwd,'commit','-m',message);};
try {
 mkdirSync(root);git(root,'init','-b','main');git(root,'config','user.name','Version fixture');git(root,'config','user.email','fixture@example.test');
 const bin=installLabAuditFixtureProviders(dir);
 const env={...process.env,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.excludesFile',GIT_CONFIG_VALUE_0:'/dev/null',CODEX_THREAD_ID:'fixture-developer',CLAUDECODE:'',PATH:bin+':'+process.env.PATH,npm_config_prefix:join(dir,'global'),NPM_CONFIG_PREFIX:join(dir,'global')};
 // The synthetic provider transport fixture owns an isolated OS-user namespace.
 // Actual Lab audits still use the real machine admission pool.
 const launcher=join(dir,'fixture-launcher.mjs');
 writeFileSync(launcher,`import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';import {pathToFileURL} from 'node:url';const original=os.userInfo;os.userInfo=(...args)=>({...original(...args),homedir:${JSON.stringify(join(dir,'fixture-home'))}});syncBuiltinESMExports();process.argv=[process.execPath,${JSON.stringify(join(source,'scripts/lab-worktree.mjs'))},...process.argv.slice(2)];await import(pathToFileURL(process.argv[1]).href);`);
 const cli=args=>assertLabVersionFixtureTransport(spawnSync(process.execPath,[launcher,...args],{cwd:root,env,encoding:'utf8',timeout:LAB_VERSION_FIXTURE_CLI_TIMEOUT_MS}),args[0]);
 const ok=args=>{const r=cli(args);assert.equal(r.status,0,r.stdout+r.stderr);return r;};
 write('.gitignore','.worktrees/\n.proof-or-stop/\nbuilt-version\n');write('CHANGELOG.md','# Changelog\n');
 for(const file of ['package.json','packages/main/package.json'])write(file,JSON.stringify({name:'proof-or-stop',version:'1.0.0',scripts:{build:'node ../../build.cjs'}},null,2)+'\n');
 for(const file of ['package-lock.json','packages/main/package-lock.json'])write(file,JSON.stringify({name:'proof-or-stop',version:'1.0.0',lockfileVersion:3,packages:{'':{name:'proof-or-stop',version:'1.0.0'}}},null,2)+'\n');
 for(const file of ['packages/lab/package-lock.json','packages/utils/package-lock.json'])write(file,JSON.stringify({lockfileVersion:3,packages:{'../main':{name:'@proof-or-stop/core',version:'1.0.0'}}},null,2)+'\n');
 copyLabFixtureSources(source,root,['main-write-lock','mkdir-lock','brand-env','brand-paths','proof-or-stop-paths','runtime-artifact-registry','version-bump','runtime-version-policy']);
 write('packages/main/src/core/proof-or-stop-brand.ts',readFileSync(join(source,'packages/main/src/core/proof-or-stop-brand.ts'),'utf8').replace(/(PROOF_OR_STOP_CLI_VERSION\s*=\s*)'[^']+'/,"$1'1.0.0'"));
 write('scripts/ensure-dist.mjs',"import fs from 'node:fs';fs.writeFileSync('built-version',JSON.parse(fs.readFileSync('package.json')).version);\n");
 write('bin/proof-or-stop.js',"console.log('Proof-or-Stop '+require('fs').readFileSync('built-version','utf8'));\n");
 write('bug.txt','broken');
 const file='packages/main/package.json',text=readFileSync(join(root,file),'utf8'),digest=createHash('sha256').update(text).digest('hex');
 write('scripts/lab/u18-static-edges/exceptions.json',JSON.stringify({schema:'u18-static-exceptions.v1',entries:[{id:'version-evidence',key:file+':3:fixture',reason:'Disposable source binding regression',requiredEvidence:[{file,startLine:1,endLine:text.split('\n').length,sourceDigest:digest,excerpt:text}],dependencyDigests:{[file]:digest}}]},null,2)+'\n');
 write('check.cjs',`const fs=require('fs'),assert=require('assert/strict'),hash=s=>require('crypto').createHash('sha256').update(s).digest('hex');
assert.equal(fs.readFileSync('bug.txt','utf8'),'fixed','TARGET fixture regression');
const entry=JSON.parse(fs.readFileSync('scripts/lab/u18-static-edges/exceptions.json')).entries[0],e=entry.requiredEvidence[0],text=fs.readFileSync(e.file,'utf8');
assert.equal(e.sourceDigest,hash(text),'VERSION_SOURCE_EVIDENCE_STALE');assert.equal(e.excerpt,text);assert.equal(entry.dependencyDigests[e.file],hash(text));\n`);
 commit(root,'seed version source evidence fixture');
 ok(['create','version-source','--developer','codex']);const lab=join(root,'.worktrees/Lab-version-source');
 ok(['red','version-source','--expect','TARGET fixture regression','--',process.execPath,'check.cjs']);
 writeFileSync(join(lab,'bug.txt'),'fixed');commit(lab,'fix disposable target');ok(['green','version-source']);
 const notes=join(dir,'notes.md');writeFileSync(notes,'Repair the disposable target and preserve current source evidence during the official patch version transaction.');
 const finished=cli(['finish','version-source','--notes',notes,'--confirm','--bump','patch']);
 assert.equal(finished.status,0,'LAB_VERSION_MUST_REFRESH_CURRENT_SOURCE_EVIDENCE '+finished.stdout+finished.stderr);
 assert.equal(JSON.parse(readFileSync(join(root,'package.json'))).version,'1.0.1');
 console.log('LAB_VERSION_SOURCE_EVIDENCE_PASS: actual finish preserves evidence and upgrades built version');
} finally {rmSync(dir,{recursive:true,force:true});}
