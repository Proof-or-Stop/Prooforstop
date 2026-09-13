import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'../../..');
assert.equal(process.argv[2],'4','Only the currently calibrated suite may run');
const scratch=mkdtempSync(path.join(tmpdir(),'top5-profile-'));
try {
  const protectedFiles=['core/managed-review-evidence.js','core/review-run.js','core/proof-or-stop-dispatch.js','core/managed-host-run.js','core/evidence/admissibility/index.js'];
  const hashes=()=>protectedFiles.map(file=>createHash('sha256').update(readFileSync(path.join(root,'packages/main/dist',file))).digest('hex'));
  const before=hashes();
  const profileFile=path.join(scratch,'profile.json');
  const started=performance.now();
  const child=spawnSync(process.execPath,['--import',path.join(import.meta.dirname,'lab-top5-profile.mjs'),
    'packages/main/dist/tasks/proof-admissibility-registry-smoke.js'],{cwd:root,encoding:'utf8',timeout:900000,maxBuffer:32*1024*1024,
    env:{...process.env,PROOF_OR_STOP_LAB_PROFILE_OUTPUT:profileFile}});
  const wallMs=performance.now()-started;
  process.stdout.write(child.stdout??'');process.stderr.write(child.stderr??'');
  const profile=JSON.parse(readFileSync(profileFile,'utf8'));
  console.log('TOP5_PROFILE '+JSON.stringify({suite:4,...profile,wallMs,nativeExitCode:child.status,nativeSignal:child.signal,formalStoryEvidence:false}));
  assert.equal(child.status,0,'Full native suite must pass before asserting performance selection');
  assert.match(child.stdout,/proof-admissibility-registry-smoke PASS/);
  assert.deepEqual(hashes(),before,'Mutations cannot escape their copied dist snapshots');
  const targets=['story','agent','lane','reviewRun','provider','head','material','storyFiles','prompt','envelope','managedPrompt'];
  for(const target of targets) assert.ok(profile.children.some(x=>x.binding===target&&x.code!==0&&x.code!==null),target+' mutation must execute and be killed');
  assert.equal(profile.activeBindingsAtExit,0,'Every observed child must finish');
  assert.ok(profile.peakBindings>=2,'TOP5_4_RED: independent binding mutants still execute serially');
  assert.ok(profile.peakBindings<=2,'Keep mutation fanout bounded at two');
  console.log('TOP5_4_GREEN');
} finally {rmSync(scratch,{recursive:true,force:true});}
