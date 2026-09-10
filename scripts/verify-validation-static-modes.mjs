import fs from'node:fs';import path from'node:path';import os from'node:os';import assert from'node:assert/strict';import{spawnSync}from'node:child_process';import{fileURLToPath}from'node:url';
import{CANONICAL,VERIFIER,NARROWING}from'./identity-child-closure.mjs';
const root=fs.realpathSync(process.argv[2]||process.cwd()),here=path.dirname(fileURLToPath(import.meta.url)),out=fs.mkdtempSync(path.join(os.tmpdir(),'u18-mode-scanner-'));
function run(name,file,from,to){const report=path.join(out,name+'.json'),env={...process.env,U18_STATIC_REPORT_PATH:report};if(file){const original=fs.readFileSync(path.join(root,file),'utf8');assert.ok(original.includes(from));const source=path.join(out,name+'.source');fs.writeFileSync(source,original.replace(from,to));env.U18_MUTATION_SOURCE=path.join(root,file);env.U18_MUTATION_BYTES=source;}const result=spawnSync(process.execPath,['--import',path.join(here,'validation-static-mode-test-overlay.mjs'),path.join(here,'verify-validation-static-edges.mjs'),root,path.join(root,'scripts/lab/u18-static-edges/exceptions.json')],{env,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});fs.writeFileSync(path.join(out,name+'.log'),result.stdout+result.stderr);assert.ok(fs.existsSync(report),result.stderr);return JSON.parse(fs.readFileSync(report));}
const baseline=run('control');assert.equal(baseline.coverage.filter(c=>c.state==='NEEDS_REVIEW').length,0);for(const argv of [[],['--boundary-only']])assert.ok(baseline.coverage.some(c=>c.file===VERIFIER&&JSON.stringify(c.argv)===JSON.stringify(argv)));for(const group of ['identity-sites','runtime','memory-identity'])assert.ok(baseline.coverage.some(c=>c.file===CANONICAL&&c.argv?.[0]==='--group='+group));for(let i=0;i<4;i++)assert.ok(baseline.coverage.some(c=>c.file===NARROWING&&c.argv?.[0]===`--case-shard=${i}/4`));console.log('PASS actual scanner covers distinct canonical/scanner/shard modes; unrelated unresolved edges remain fail closed');
for(const [name,file,from,to]of[
 ['entry',CANONICAL,"identityVerifierResult ??= spawnSync(process.execPath, [join(repoRoot, 'scripts/verify-proof-or-stop-identity-cutover.mjs')]","identityVerifierResult ??= spawnSync(process.execPath, [join(repoRoot, 'scripts/other.mjs')]"],
 ['recursive-group',VERIFIER,"'--group=identity-sites'","'--group=identity-cutover'"],
 ['callback',CANONICAL,'if (selectedGroup !== null && !groups.includes(selectedGroup)) return;','if (false) return;'],
 ['shard-argv',NARROWING,'`--case-shard=${shardIndex}/${shardCount}`','`--other-shard=${shardIndex}/${shardCount}`'],
 ['shard-partition',NARROWING,'if (index % shardCount !== shardIndex) continue;','if (false) continue;'],
 ['neutral-entry','scripts/helpers/provider-neutral-fixture.mjs',"[entry, ...args], { env: process.env","['other.mjs', ...args], { env: process.env"],
 ['neutral-mode','scripts/helpers/provider-neutral-fixture.mjs',"[self, '--worker', root, entry, ...args]","[self, '--other-worker', root, entry, ...args]"],
 ['shard-completeness',NARROWING,'&& CASES.every(testCase => completed.has(testCase.id))','&& true']]){
 const r=run(name,file,from,to);assert.ok(r.coverage.some(c=>c.file===file&&c.state==='NEEDS_REVIEW'&&/Identity|Narrowing|identity|Reviewed child mode/.test(c.reason)),name);console.log('PASS actual scanner refuses '+name);
}
console.log('ARTIFACTS '+out);
