import fs from 'node:fs';import {fileURLToPath} from 'node:url';import path from 'node:path';import vm from 'node:vm';import assert from 'node:assert/strict';import ts from 'typescript';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');const file=path.join(root,'scripts/verify-validation-static-edges.mjs'),source=fs.readFileSync(file,'utf8'),parsed=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
const helper=parsed.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='parseStaticSource');assert(helper);
const box={ts};vm.createContext(box);vm.runInContext('const parsedSourceCache=new Map();'+helper.getText(parsed)+';globalThis.parse=parseStaticSource;globalThis.size=()=>parsedSourceCache.size;',box);
const a=box.parse('same.ts','const oldName=1;');assert.equal(box.parse('same.ts','const oldName=1;'),a);
const b=box.parse('same.ts','const newName=2;');assert.notEqual(b,a);assert.equal(b.statements[0].declarationList.declarations[0].name.text,'newName');assert.equal(box.size(),1,'One cached revision per path');
const c=box.parse('other.ts','const newName=2;');assert.notEqual(c,b);assert.equal(c.fileName,'other.ts');
const broken=box.parse('same.ts','const =');assert(broken.parseDiagnostics.length>0,'Changed invalid syntax must not inherit a valid AST');
assert.equal(box.parse('same.ts','const repaired=3;').parseDiagnostics.length,0);assert.equal(box.size(),2);
console.log('STATIC_AST_REUSE_HELPER_GREEN same-content hit; changed-content/path miss; invalid syntax preserved; recovery; one revision per path');

// Real scanner, one parsed source used by two distinct configured invocations.
import os from 'node:os';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'static-ast-invocations-'));
let completed=false;
try {
 fs.writeFileSync(path.join(fixture,'package.json'),'{}');
 fs.mkdirSync(path.join(fixture,'node_modules'));
 fs.symlinkSync(path.dirname(createRequire(path.join(root,'package.json')).resolve('typescript/package.json')),path.join(fixture,'node_modules/typescript'),'dir');
 const scan=(commands,label)=>{
  fs.writeFileSync(path.join(fixture,'proof-or-stop.config.json'),JSON.stringify({validate:{commands}}));
  const manifest=path.join(fixture,'exceptions.json'),report=path.join(fixture,label+'.json');
  fs.writeFileSync(manifest,JSON.stringify({entries:[],configDigest:crypto.createHash('sha256').update(JSON.stringify(commands)).digest('hex')}));
  const child=spawnSync(process.execPath,[file,fixture,manifest],{encoding:'utf8',timeout:30000,env:{...process.env,U18_STATIC_REPORT_PATH:report}});
  assert.equal(child.signal,null);assert.equal(child.status,1,'Isolated negative witness must refuse: '+child.stdout+child.stderr);
  return JSON.parse(fs.readFileSync(report,'utf8'));
 };
 fs.writeFileSync(path.join(fixture,'a.mjs'),"import {spawn} from 'node:child_process';if(!process.argv.includes('--canonical-core'))spawn(process.execPath,['b.mjs']);");
 fs.writeFileSync(path.join(fixture,'b.mjs'),'');
 const argvReport=scan([{command:'node',args:['a.mjs','--canonical-core']},{command:'node',args:['a.mjs']},{command:'node',args:['b.mjs']}],'argv');
 assert(argvReport.rows.some(r=>r.file==='a.mjs'&&r.index===0&&r.state==='CONFIG_BRANCH_SKIPPED'));
 assert(argvReport.rows.some(r=>r.file==='a.mjs'&&r.index===1&&r.state==='NESTED_REGISTERED'));
 const narrowing='packages/main/src/tasks/narrowing-repin-smoke.ts';
 fs.mkdirSync(path.dirname(path.join(fixture,narrowing)),{recursive:true});fs.copyFileSync(path.join(root,narrowing),path.join(fixture,narrowing));
 const runtime='packages/main/dist/tasks/narrowing-repin-smoke.js';
 const identity=scan([{command:'node',args:[runtime,'--case-shard=0/4']},{command:'node',args:[runtime,'--bad']}],'identity');
 assert(!identity.coverage.some(r=>r.index===0&&r.reason?.includes('Unreviewed narrowing shard argv')));
 assert(identity.coverage.some(r=>r.index===1&&r.reason?.includes('Unreviewed narrowing shard argv')));
 console.log('STATIC_AST_REUSE_BOUNDARIES_GREEN source freshness, argv isolation and identity child mode isolation');
 completed=true;
} catch(error){console.error('STATIC_AST_BOUNDARY_FAILURE_ARTIFACTS '+fixture);throw error;} finally {if(completed)fs.rmSync(fixture,{recursive:true,force:true});}
