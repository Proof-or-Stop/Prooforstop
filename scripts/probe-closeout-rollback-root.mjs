import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {rollbackValidationPublication} from '../packages/main/dist/core/auto-commit-metadata.js';
const root=mkdtempSync(join(tmpdir(),'pos-rollback-root-')),metadata=join(root,'metadata'),workspace=join(root,'workspace');
try{mkdirSync(metadata);mkdirSync(workspace);writeFileSync(join(metadata,'output.json'),'owned');writeFileSync(join(workspace,'output.json'),'OTHER_WORKTREE');
const transaction={paths:['output.json'],states:[{path:'output.json',worktreeContent:Buffer.from('baseline'),indexEntries:[]}]};
const expectedHashes=new Map([['output.json',createHash('sha256').update('owned').digest('hex')]]);
let result=rollbackValidationPublication({root:metadata,gitCwd:workspace,transaction,expectedHashes},'refused');assert.deepEqual(result.rollbackConflicts,[]);assert.equal(readFileSync(join(metadata,'output.json'),'utf8'),'baseline');assert.equal(readFileSync(join(workspace,'output.json'),'utf8'),'OTHER_WORKTREE');
writeFileSync(join(metadata,'output.json'),'FOREIGN');result=rollbackValidationPublication({root:metadata,gitCwd:workspace,transaction,expectedHashes},'refused');assert.equal(result.rollbackConflicts.length,1);assert.equal(readFileSync(join(metadata,'output.json'),'utf8'),'FOREIGN');
console.log('CLOSEOUT_ROLLBACK_EXPLICIT_ROOT_GREEN');
}finally{rmSync(root,{recursive:true,force:true});}
