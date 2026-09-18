import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const root=fileURLToPath(new URL('../../../',import.meta.url));
assert.equal(spawnSync(process.execPath,['scripts/ensure-dist.mjs'],{cwd:root,stdio:'inherit'}).status,0);
const moduleUrl=name=>pathToFileURL(resolve(root,'packages/main/dist/core',name+'.js')).href;
const failures=[];
for(const entry of ['dirty-worktree','dirty-gate-policy']){
 const code=`
  import assert from 'node:assert/strict';
  await import(${JSON.stringify(moduleUrl(entry))});
  const classifier=await import(${JSON.stringify(moduleUrl('dirty-worktree'))});
  const policy=await import(${JSON.stringify(moduleUrl('dirty-gate-policy'))});
  assert.deepEqual(Object.keys(policy.DIRTY_GATE_POLICY).sort(),[...classifier.DIRTY_WORKTREE_CATEGORIES].sort());
  policy.assertPolicyCovers();
  const key='unexpected_dirty_files',original=policy.DIRTY_GATE_POLICY[key];
  delete policy.DIRTY_GATE_POLICY[key];
  assert.throws(()=>policy.assertPolicyCovers(),/category "unexpected_dirty_files" missing/);
  policy.DIRTY_GATE_POLICY[key]=original;
  policy.assertPolicyCovers();
  console.log('DIRTY_CATEGORY_ENTRY_GREEN '+${JSON.stringify(entry)});
 `;
 const result=spawnSync(process.execPath,['--input-type=module','--eval',code],{cwd:root,encoding:'utf8',timeout:15000});
 process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
 if(result.status!==0||result.signal||result.error)failures.push({entry,status:result.status,signal:result.signal,error:result.error?.message});
}
assert.deepEqual(failures,[],'DIRTY_CATEGORY_MODULE_RED: both public import orders must initialize the existing exhaustive policy');
console.log('DIRTY_CATEGORY_MODULE_GREEN both import orders and missing-category refusal passed');
