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
const root = mkdtempSync(join(tmpdir(), 'progress-evidence-')), originalCwd = process.cwd();
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
  console.log('PASS verification key location invocation reuse');
}finally{process.chdir(originalCwd);rmSync(root,{recursive:true,force:true});}
