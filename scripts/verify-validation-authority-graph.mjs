import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
const repo=resolve(process.argv[2]||process.cwd());
const {buildDualRevisionImpactGraph}=await import(pathToFileURL(join(repo,'packages/main/dist/core/story-aware-validation.js')));
const root=mkdtempSync(join(tmpdir(),'u09-authority-graph-'));
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const write=(p,s)=>{mkdirSync(dirname(join(root,p)),{recursive:true});writeFileSync(join(root,p),s);};
const gate='packages/main/src/core/scope-inventory-budget.ts', helper='packages/main/src/core/limit-helper.ts';
try{
 git('init','-q','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
 write(gate,"import {limit} from './limit-helper.js';export const accepted=limit;\n");write(helper,'export const limit=4096;');write('packages/main/src/local.ts','export const local=1;');
 git('add','.');git('commit','-qm','authority baseline');const base=git('rev-parse','HEAD');
 write(helper,'export const limit=1;');git('add','.');git('commit','-qm','helper defect');let head=git('rev-parse','HEAD');
 let graph=buildDualRevisionImpactGraph({gitCwd:root,baseHead:base,head});
 assert.equal(typeof graph.authorityReasons,'function','authority source query is required');
 assert.ok(graph.authorityReasons({path:helper,status:'M'}).includes('authority-source-changed:'+helper));
 assert.deepEqual(graph.authorityReasons({path:'packages/main/src/local.ts',status:'M'}),[]);
 write(gate,'export const accepted=4096;');git('add','.');git('commit','-qm','remove gate import');head=git('rev-parse','HEAD');
 graph=buildDualRevisionImpactGraph({gitCwd:root,baseHead:base,head});
 assert.ok(graph.authorityReasons({path:helper,status:'M'}).includes('authority-source-changed:'+helper),'base dependency must survive head edge removal');
 write(gate,"const name='./limit-helper.js';export const result=import(name);\n");git('add','.');git('commit','-qm','opaque authority import');head=git('rev-parse','HEAD');
 graph=buildDualRevisionImpactGraph({gitCwd:root,baseHead:base,head});
 assert.ok(graph.authorityReasons({path:'packages/main/src/local.ts',status:'M'}).some(x=>x.startsWith('authority-import-opaque:')));
 console.log('PASS authority helper/base-edge/opaque and unrelated controls');
}finally{rmSync(root,{recursive:true,force:true});}
