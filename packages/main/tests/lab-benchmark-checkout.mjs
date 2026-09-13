// Disposable, independent Git + dependency trees keep native protected-root
// observers enabled without observing unrelated work in the shared repository.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {cpSync,existsSync,mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {verifyBuildBinding,verifyUtilsBuildBinding} from '../../../scripts/full-suite-build-binding.mjs';
export async function prepareBenchmarkCheckout(sourceRoot) {
  const started=performance.now();
  const git=(cwd,args)=>{const r=spawnSync('git',args,{cwd,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  const head=git(sourceRoot,['rev-parse','HEAD']),branch=git(sourceRoot,['branch','--show-current']);assert.ok(branch);
  const sourceMain=verifyBuildBinding(sourceRoot),sourceUtils=verifyUtilsBuildBinding(sourceRoot);
  const parent=mkdtempSync(path.join(tmpdir(),'top5-checkout-')),root=path.join(parent,'repo');
  console.log('TOP5_CHECKOUT_PREPARING '+JSON.stringify({root,head}));
  git(sourceRoot,['clone','--no-local','--single-branch','--branch',branch,sourceRoot,root]);
  assert.equal(git(root,['rev-parse','HEAD']),head,'benchmark checkout must match the committed Lab candidate');
  const prefixes=['.','packages/main','packages/utils','packages/graph'];
  const results=await Promise.allSettled(prefixes.map(prefix=>new Promise((resolve,reject)=>{
    const child=spawn('npm',['--prefix',path.join(root,prefix),'ci','--ignore-scripts','--no-audit','--no-fund'],{cwd:root,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    const timer=setTimeout(()=>child.kill('SIGKILL'),180000);child.once('error',reject);
    child.once('close',(code,signal)=>{clearTimeout(timer);writeFileSync(path.join(parent,prefix.replaceAll('/','-')+'-install.log'),output);if(code===0&&!signal)resolve();else reject(new Error('benchmark dependency install failed: '+prefix+' '+code+' '+signal));});
  })));
  for(const result of results)if(result.status==='rejected')throw result.reason;
  for(const packageName of ['main','utils','graph']) {
    const from=path.join(sourceRoot,'packages',packageName,'dist');
    if(existsSync(from))cpSync(from,path.join(root,'packages',packageName,'dist'),{recursive:true});
  }
  assert.deepEqual(verifyBuildBinding(root),sourceMain,'main compiled bytes must match the candidate');
  assert.deepEqual(verifyUtilsBuildBinding(root),sourceUtils,'utils compiled bytes must match the candidate');
  assert.equal(git(sourceRoot,['rev-parse','HEAD']),head,'source candidate cannot change during preparation');
  console.log('TOP5_CHECKOUT_READY '+JSON.stringify({root,head,setupMs:performance.now()-started,independentDependencies:true,independentDist:true}));
  return root;
}
