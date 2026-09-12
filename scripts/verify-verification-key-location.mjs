import assert from 'node:assert/strict';
import fs from 'node:fs';
import child from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {StoryStore} from '../packages/main/dist/core/store.js';
import {createChecklistHandlers} from '../packages/main/dist/handlers/checklist.js';
import {acquireOwnerLease} from '../packages/main/dist/core/story-owner-lease.js';
import {validateVerificationReceipt} from '../packages/main/dist/core/verification-execution-evidence.js';
import {verifyBuildBinding} from './full-suite-build-binding.mjs';
const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const binding=verifyBuildBinding(repository);assert(binding.sourceDigest&&binding.distDigest);
console.log('VERIFICATION_KEY_LOCAL_BUILD '+JSON.stringify(binding));
const root = mkdtempSync(join(tmpdir(), 'verification-key-\npath-')), originalCwd = process.cwd();
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
try {
  process.chdir(root);
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Progress fixture'); git('config', 'user.email', 'progress@example.invalid');
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', storyDir: '.proof-or-stop/story/actives' }));
  writeFileSync(join(root, '.gitignore'), '.proof-or-stop/keys/\n**/*.lock/\n**/owner-lease.json\n.lattice/\n');
  writeFileSync(join(root, 'subject.cjs'), 'module.exports=1;\n');
  writeFileSync(join(root, 'verify.cjs'), "require('node:assert/strict').equal(require('./subject.cjs'),1); console.log('subject exports one');\n");
  git('add', '.'); git('commit', '-qm', 'fixture');
  const storyId = 'B-progress-evidence'; git('switch', '-qc', `story/${storyId}`);
  const store = new StoryStore(root), now = new Date().toISOString();
  store.writeStory(storyId, { storyId, name: 'progress-evidence', title: 'Verify actual progress', phase: 'DEV', priority: 'medium', createdAt: now, events: [] });
  acquireOwnerLease(store.storyDirPath(storyId), { command: 'progress-fixture', cwd: root });
  const checklist = { items: [{ id: 'CHK-001', title: 'The subject exports one', status: 'in_progress', verificationIntent: { happy: [{ desc: 'The subject exports one', type: 'cli', priority: 'must' }], edge: [], adversarial: [] } }] };
  store.writeChecklist(storyId, checklist); git('add', '.'); git('commit', '-qm', 'acceptance');
  await createChecklistHandlers({ root, scanRoot: root, store, log() {} }).verification_evidence_add({ storyId, itemId: 'CHK-001', intentRef: 'CHK-001:happy:0', kind: 'integration_test', command: 'node verify.cjs', selector: 'subject exports one', note: 'The real child asserts the exact exported value before emitting its contract selector.' });
  const evidence=store.readChecklist(storyId).items[0].verificationEvidence[0];
  const receipt=evidence.receipt;
  const expected={storyId,intentRef:'CHK-001:happy:0',selector:'subject exports one',command:'node verify.cjs',freshness:receipt.publicationBinding.freshness};
  assert.equal(receipt.schemaVersion,'proof-or-stop.verification-receipt-bundle.v5');
  const ordinary=validateVerificationReceipt(root,receipt,expected);
  assert.equal(ordinary.ok,true,JSON.stringify(ordinary));
  const original=child.execFileSync;let probes=[];
  child.execFileSync=function(file,args,options){
    if(file==='git'&&args.includes('--git-common-dir'))probes.push([...args]);
    return Reflect.apply(original,this,[file,args,options]);
  };syncBuiltinESMExports();
  let observed;
  try{observed=validateVerificationReceipt(root,receipt,expected);}
  finally{child.execFileSync=original;syncBuiltinESMExports();}
  assert.deepEqual(observed,ordinary,'All validation fields remain identical');
  console.log('ACTUAL_V5_LOCATION_PROBES '+JSON.stringify(probes));
  assert.equal(probes.length,2,'VERIFICATION_KEY_LOCATION_REPEATED_PROBES: valid V5 must use initial plus final location discovery');
  const keyPath=join(root,'.git','proof-or-stop-verification-receipt-signer-v1.key');
  const key=readFileSync(keyPath);
  const originalRead=fs.readFileSync;
  function duringKeyRead(mutate){
    let reads=0;
    fs.readFileSync=function(path,...args){
      const value=Reflect.apply(originalRead,this,[path,...args]);
      if(String(path).endsWith('/proof-or-stop-verification-receipt-signer-v1.key')){
        reads++;if(reads===1)mutate();
      }
      return value;
    };syncBuiltinESMExports();
    try{return {result:validateVerificationReceipt(root,receipt,expected),reads};}
    finally{fs.readFileSync=originalRead;syncBuiltinESMExports();}
  }
  for(const [name,mutate] of [
    ['rotation',()=>writeFileSync(keyPath,Buffer.alloc(32,73).toString('base64'))],
    ['deletion',()=>rmSync(keyPath)],
    ['malformed key',()=>writeFileSync(keyPath,'not a private key')],
  ]){
    try{
      const changed=duringKeyRead(mutate);
      assert.equal(changed.result.ok,false,name+' between signature stages must refuse');
      assert(changed.result.errors.some(error=>error.includes('assertion receipt trusted signature mismatch')),JSON.stringify(changed));
      assert.equal(validateVerificationReceipt(root,receipt,expected).ok,false,name+' must be seen on next invocation');
    }finally{writeFileSync(keyPath,key);}
    assert.deepEqual(validateVerificationReceipt(root,receipt,expected),ordinary,name+' restoration recovers next invocation');
  }
  const alt=mkdtempSync(join(tmpdir(),'verification-other-trust-'));
  const held=join(alt,'held-original-git');
  try{
    original('git',['init','-q','-b','main'],{cwd:alt});
    // An independent repository receives a different actual key, never a forged receipt.
    writeFileSync(join(alt,'.git','proof-or-stop-verification-receipt-signer-v1.key'),Buffer.alloc(32,29).toString('base64'));
    const transplanted=structuredClone(receipt);transplanted.executionReceipt.cwd=alt;
    const rejected=validateVerificationReceipt(root,transplanted,expected);
    assert.equal(rejected.ok,false);assert(rejected.errors.includes('execution receipt trusted signature mismatch'));
    const savedCwd=receipt.executionReceipt.cwd;
    try{
      const changed=duringKeyRead(()=>{receipt.executionReceipt.cwd=alt;});
      assert.equal(changed.result.ok,false,'changing requested signer cwd between signature checks refuses');
      assert(changed.result.errors.includes('assertion receipt trusted signature mismatch'));
      assert(changed.result.errors.includes('verification signer location changed during validation'));
    }finally{receipt.executionReceipt.cwd=savedCwd;}
    // Same key deliberately copied by the test isolates topology continuity from key mismatch.
    writeFileSync(join(alt,'.git','proof-or-stop-verification-receipt-signer-v1.key'),key);
    try{
      const changed=duringKeyRead(()=>{fs.renameSync(join(root,'.git'),held);fs.symlinkSync(join(alt,'.git'),join(root,'.git'),'dir');});
      assert.equal(changed.result.ok,false,'final location comparison refuses real Git-directory redirection');
      assert(changed.result.errors.includes('verification signer location changed during validation'),JSON.stringify(changed));
      assert.equal(changed.reads,3,'all actual signature reads still execute');
      // New calls discover the new stable topology, rather than using a stale operation cache.
      assert.equal(validateVerificationReceipt(root,receipt,expected).ok,true);
      writeFileSync(join(alt,'.git','proof-or-stop-verification-receipt-signer-v1.key'),Buffer.alloc(32,29).toString('base64'));
      assert.equal(validateVerificationReceipt(root,receipt,expected).ok,false);
    }finally{rmSync(join(root,'.git'),{force:true});fs.renameSync(held,join(root,'.git'));}
    assert.deepEqual(validateVerificationReceipt(root,receipt,expected),ordinary);
    // Real separate-git-dir pointer, preserving the original signed cwd and key.
    fs.renameSync(join(root,'.git'),held);writeFileSync(join(root,'.git'),'gitdir: '+held+'\n');
    try{assert.deepEqual(validateVerificationReceipt(root,receipt,expected),ordinary);}
    finally{rmSync(join(root,'.git'));fs.renameSync(held,join(root,'.git'));}
  }finally{rmSync(alt,{recursive:true,force:true});}
  const artifact=join(root,'.proof-or-stop/evidence/objects/sha256',receipt.executionReceipt.outputArtifact.artifactDigest+'.json');
  const artifactBytes=readFileSync(artifact);rmSync(artifact);
  try{assert.equal(validateVerificationReceipt(root,receipt,expected).ok,false,'actual output deletion refuses');}
  finally{writeFileSync(artifact,artifactBytes);}
  for(const mutate of [
    r=>{r.publicationBinding.authenticity.signature='invalid';},
    r=>{r.assertionReceipt.authenticity.signature='invalid';},
    r=>{r.executionReceipt.authenticity.signature='invalid';},
  ]){const damaged=structuredClone(receipt);mutate(damaged);assert.equal(validateVerificationReceipt(root,damaged,expected).ok,false);}
  assert.deepEqual(validateVerificationReceipt(root,receipt,expected),ordinary);
  git('config','core.bare','true');
  try{assert.deepEqual(validateVerificationReceipt(root,receipt,expected),ordinary,'existing bare Git discovery remains readable');}
  finally{git('config','core.bare','false');}
  const linked=mkdtempSync(join(tmpdir(),'verification-linked-'));
  try{
    git('worktree','add','--detach',linked,'HEAD');
    process.chdir(linked);
    const linkedStore=new StoryStore(linked);
    acquireOwnerLease(linkedStore.storyDirPath(storyId),{command:'linked-verification-fixture',cwd:linked});
    await createChecklistHandlers({root:linked,scanRoot:linked,store:linkedStore,log(){}}).verification_evidence_add({storyId,itemId:'CHK-001',intentRef:'CHK-001:happy:0',kind:'integration_test',command:'node verify.cjs',selector:'subject exports one',note:'An actual linked-worktree child asserts the same contract under its shared repository signer.'});
    const linkedReceipt=linkedStore.readChecklist(storyId).items[0].verificationEvidence[0].receipt;
    assert.equal(fs.realpathSync(linkedReceipt.executionReceipt.cwd),fs.realpathSync(linked));
    const checked=validateVerificationReceipt(linked,linkedReceipt,{...expected,freshness:linkedReceipt.publicationBinding.freshness});
    assert.equal(checked.ok,true,JSON.stringify(checked));
    assert.equal(linkedReceipt.executionReceipt.authenticity.keyId,receipt.executionReceipt.authenticity.keyId,'actual linked execution shares the canonical common-directory signer');
  }finally{process.chdir(root);git('worktree','remove','--force',linked);rmSync(linked,{recursive:true,force:true});}
  console.log('PASS live key rotation deletion tamper topology next-call cross-root output and signature controls');
  console.log('PASS verification key location invocation reuse');
}finally{process.chdir(originalCwd);rmSync(root,{recursive:true,force:true});}
