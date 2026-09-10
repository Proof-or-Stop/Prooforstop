import assert from 'node:assert/strict';
import {cpSync,existsSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {spawnSync,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
const lab=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const output=process.env.FIVE_ITEM_PROOF_OUTPUT||mkdtempSync(join(tmpdir(),'pos-bootstrap-proof-'));mkdirSync(output,{recursive:true});
const copy=mkdtempSync(join(tmpdir(),'pos-bootstrap-identity-audit-'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const env={...process.env};delete env.PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN;delete env.PROOF_OR_STOP_EXPECTED_IMPLEMENTATION_DIGEST;
const run=(args,extra={})=>spawnSync(process.execPath,[join(copy,'bin/proof-or-stop.js'),...args],{cwd:copy,encoding:'utf8',timeout:30000,env:{...env,...extra}});
try{
 for(const name of ['main','utils','lab']){
  const dest=join(copy,'packages',name);mkdirSync(dest,{recursive:true});
  if(existsSync(join(lab,'packages',name,'dist')))cpSync(join(lab,'packages',name,'dist'),join(dest,'dist'),{recursive:true,verbatimSymlinks:true});
  cpSync(join(lab,'packages',name,'package.json'),join(dest,'package.json'));
 }
 for(const path of ['packages/main/templates','node_modules','bin','scripts'])cpSync(join(lab,path),join(copy,path),{recursive:true,verbatimSymlinks:true});
 cpSync(join(lab,'package.json'),join(copy,'package.json'));
 writeFileSync(join(copy,'.gitignore'),'node_modules/\npackages/*/dist/\n');
 const git=args=>execFileSync('git',args,{cwd:copy,stdio:'pipe'});
 git(['init','-q','-b','main']);git(['config','user.email','audit@example.test']);git(['config','user.name','Isolated audit fixture']);
 git(['add','package.json','.gitignore','bin','scripts','packages/main/package.json','packages/main/templates','packages/utils/package.json','packages/lab/package.json']);git(['commit','-qm','bootstrap audit fixture']);
 const first=run(['--implementation-identity']);assert.equal(first.status,0,first.stdout+first.stderr);const before=JSON.parse(first.stdout);
 const pin={PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN:'1',PROOF_OR_STOP_EXPECTED_IMPLEMENTATION_DIGEST:before.digest};
 const valid=run(['--version'],pin);assert.equal(valid.status,0,valid.stdout+valid.stderr);
 const helper=join(copy,'bin/bootstrap-runner.js'),oldBytes=readFileSync(helper);
 writeFileSync(helper,Buffer.concat([oldBytes,Buffer.from('\nprocess.stderr.write("AUDIT_BOOTSTRAP_CHANGED_EXECUTED\\n");\n')]));
 const afterRun=run(['--implementation-identity']);assert.equal(afterRun.status,0,afterRun.stdout+afterRun.stderr);const after=JSON.parse(afterRun.stdout);
 const changed=run(['--version'],pin);
 const result={method:'actual local wrapper in a private runtime copy; only its imported bootstrap helper gains a benign execution marker',entrypoint:'bin/proof-or-stop.js',changedHelper:'bin/bootstrap-runner.js',helperBeforeSha256:hash(oldBytes),helperAfterSha256:hash(readFileSync(helper)),pinBefore:before.digest,pinAfter:after.digest,requiredPinVersionExit:changed.status,versionStdout:changed.stdout,stderr:changed.stderr,changedHelperExecuted:changed.stderr.includes('AUDIT_BOOTSTRAP_CHANGED_EXECUTED'),expectedClosure:'changed actually executed bootstrap implementation must change identity or be refused',gapReproduced:before.digest===after.digest&&changed.status===0&&changed.stderr.includes('AUDIT_BOOTSTRAP_CHANGED_EXECUTED')};
 writeFileSync(join(output,'bootstrap-identity-gap.json'),JSON.stringify(result,null,2));
 assert.notEqual(before.digest,after.digest,'BOOTSTRAP_IDENTITY_UNBOUND: executed helper must change implementation identity');
 assert.notEqual(changed.status,0,'BOOTSTRAP_PIN_ACCEPTED_CHANGED_HELPER');
 assert.match(changed.stderr,/IMPLEMENTATION_PIN_MISMATCH/);
 console.log('BOOTSTRAP_IDENTITY_GREEN');
 console.log(JSON.stringify(result,null,2));
}finally{rmSync(copy,{recursive:true,force:true});}
