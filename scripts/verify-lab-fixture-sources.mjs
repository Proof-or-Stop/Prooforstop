import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {copyLabFixtureSources} from './lab-fixture-sources.mjs';
const dir=mkdtempSync(join(tmpdir(),'lab-source-closure-'));
try {
  const root=join(dir,'root'), target=join(dir,'target');
  mkdirSync(join(root,'packages/main/src/core'),{recursive:true});mkdirSync(join(target,'.git/info'),{recursive:true});
  const file=name=>join(root,'packages/main/src/core',name+'.ts');
  writeFileSync(file('entry'),`import './side.js'; export const load=()=>import('./dynamic.js');`);
  writeFileSync(file('side'),'export const side=true;');writeFileSync(file('dynamic'),'export const dynamic=true;');
  copyLabFixtureSources(root,target,['entry']);
  assert.ok(existsSync(join(target,'packages/main/src/core/dynamic.ts')));
  assert.ok(existsSync(join(target,'packages/main/src/core/side.ts')));
  writeFileSync(file('entry'),`import './missing.js';`);
  assert.throws(()=>copyLabFixtureSources(root,target,['entry']),/Unresolved/);
  writeFileSync(join(dir,'outside.ts'),'export const outside=true;');
  writeFileSync(file('entry'),`import '../../../../../outside.js';`);
  assert.throws(()=>copyLabFixtureSources(root,target,['entry']),/escapes/);
  console.log('LAB_FIXTURE_CLOSURE PASS dynamic, side-effect, unresolved and escaping imports');
} finally {rmSync(dir,{recursive:true,force:true});}
