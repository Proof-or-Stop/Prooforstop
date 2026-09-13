// Disposable, independent Git + dependency trees keep native protected-root
// observers enabled without observing unrelated work in the shared repository.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readdirSync,readlinkSync,symlinkSync,unlinkSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {verifyBuildBinding,verifyUtilsBuildBinding} from '../../../scripts/full-suite-build-binding.mjs';
export async function prepareBenchmarkCheckout(sourceRoot) {
  const started=performance.now();
  const git=(cwd,args)=>{const r=spawnSync('git',args,{cwd,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  const head=git(sourceRoot,['rev-parse','HEAD']),branch=git(sourceRoot,['branch','--show-current']);assert.ok(branch);
  const sourceMain=verifyBuildBinding(sourceRoot),sourceUtils=verifyUtilsBuildBinding(sourceRoot);
  const checkoutBase=path.join(homedir(),'Documents','top5-benchmark-checkouts');
  mkdirSync(checkoutBase,{recursive:true});
  const parent=mkdtempSync(path.join(checkoutBase,'top5-checkout-')),root=path.join(parent,'repo');
  console.log('TOP5_CHECKOUT_PREPARING '+JSON.stringify({root,head}));
  git(sourceRoot,['clone','--no-local','--single-branch','--branch',branch,sourceRoot,root]);
  assert.equal(git(root,['rev-parse','HEAD']),head,'benchmark checkout must match the committed Lab candidate');
  const inside=(base,file)=>{const relative=path.relative(base,file);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
  const copyIndependentTree=(from,to)=>{
    cpSync(from,to,{recursive:true,verbatimSymlinks:true});
    const visit=(directory,originalDirectory)=>{
      for(const entry of readdirSync(directory,{withFileTypes:true})) {
        const target=path.join(directory,entry.name),original=path.join(originalDirectory,entry.name);
        if(entry.isDirectory())visit(target,original);
        else if(entry.isSymbolicLink()) {
          const link=readlinkSync(original),resolved=path.resolve(path.dirname(original),link);
          assert.ok(inside(sourceRoot,resolved),'dependency links must belong to the source checkout: '+original);
          const copiedTarget=path.join(root,path.relative(sourceRoot,resolved));
          // Rebase absolute local links too; no dependency points back at the Lab.
          unlinkSync(target);symlinkSync(path.relative(path.dirname(target),copiedTarget),target);
        } else if(entry.isFile()) assert.notEqual(lstatSync(target).ino,lstatSync(original).ino,'dependency bytes must be independent copies');
      }
    };
    visit(to,from);
  };
  for(const prefix of ['.','packages/main','packages/utils','packages/graph','packages/lab']) {
    const from=path.join(sourceRoot,prefix,'node_modules');
    if(existsSync(from))copyIndependentTree(from,path.join(root,prefix,'node_modules'));
  }
  for(const packageName of ['main','utils','graph','lab']) {
    const from=path.join(sourceRoot,'packages',packageName,'dist');
    if(existsSync(from))cpSync(from,path.join(root,'packages',packageName,'dist'),{recursive:true});
  }
  assert.deepEqual(verifyBuildBinding(root),sourceMain,'main compiled bytes must match the candidate');
  assert.deepEqual(verifyUtilsBuildBinding(root),sourceUtils,'utils compiled bytes must match the candidate');
  assert.equal(git(sourceRoot,['rev-parse','HEAD']),head,'source candidate cannot change during preparation');
  console.log('TOP5_CHECKOUT_READY '+JSON.stringify({root,head,setupMs:performance.now()-started,independentDependencies:true,independentDist:true}));
  return root;
}
