import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { assertCanonicalActiveIdentityBoundary } from '../dist/core/runtime-environment-checks.js';
const root=mkdtempSync(join(tmpdir(),'pos-tree-delegate-binding-'));
try {
 cpSync(resolve('packages/main/dist'),join(root,'dist'),{recursive:true});
 const check=()=>assertCanonicalActiveIdentityBoundary({boundaryId:'review-incremental-context',runtimePackageRoot:root});
 check();
 const delegate=join(root,'dist/core/git-tree-observation.js'),before=readFileSync(delegate,'utf8');
 assert(before.includes('observation = undefined'));
 writeFileSync(delegate,before.replace('observation = undefined','observation = new Map()'));
 assert.throws(check,/git-tree-observation.ts consumer rejected active identity bytes/,'DELEGATE_MUTATION_MUST_NOT_BYPASS_PINNED_FRESHNESS');
 writeFileSync(delegate,before);check();
 const executable=join(root,'dist/core/executable-digest-observation.js'),executableBefore=readFileSync(executable,'utf8');
 assert(executableBefore.includes('observation = previous'));
 writeFileSync(executable,executableBefore.replace('observation = previous','observation = new Map()'));
 assert.throws(check,/executable-digest-observation.ts consumer rejected active identity bytes/,'EXECUTABLE_OBSERVATION_MUST_NOT_RETAIN_BYTES');
 writeFileSync(executable,executableBefore);check();
 console.log('TREE_DELEGATE_BINDING_GREEN actual-delegate-mutation-refused restored-control');
} finally {rmSync(root,{recursive:true,force:true});}
