import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';import {spawnSync} from 'node:child_process';
const repo=fs.realpathSync(process.argv[2]??process.cwd()),graph=path.join(repo,'packages/graph'),pkg=JSON.parse(fs.readFileSync(path.join(graph,'package.json'),'utf8'));
// Exact existing downstream property checks. Recovery builds inside these remain legitimate.
const required=['npm run anchor-check','npm run verify-assets-ignored','npm run verify-clean-tree','npm run verify-no-project-writes','npm run verify-docs','npm run verify-json-no-listener','npm run verify-missing-assets-fail','npm run verify-engines-floor','npm run verify-serves','node dist/tasks/audit.js','node dist/tasks/bench.js'];
const pipeline=pkg.scripts.check.split('&&').map(s=>s.trim());assert.equal(pipeline[0],'npm run build');
const firstGuard=pipeline.indexOf(required[0]);assert.ok(firstGuard>0);assert.deepEqual(pipeline.slice(firstGuard),required,'all existing downstream check commands and order must remain');
const expand=s=>s.split('&&').flatMap(part=>{part=part.trim();const match=/^npm run (build|typecheck)$/.exec(part);return match?expand(pkg.scripts[match[1]]):[part];});
const initial=expand(pipeline.slice(0,firstGuard).join(' && '));
assert.ok(initial.includes('node scripts/build-web.mjs'),'real web assets build must remain');
assert.ok(initial.includes('node scripts/ok.mjs GRAPH_TSC_CLEAN'),'check retains successful compiler selector');
assert.equal(pkg.scripts.typecheck,'tsc --noEmit && node scripts/ok.mjs GRAPH_TSC_CLEAN','standalone typecheck retains real noEmit compiler');
const compilerSteps=initial.filter(step=>/^tsc(?:\s|$)/.test(step));assert.ok(compilerSteps.every(step=>step==='tsc'||step==='tsc --noEmit'),'no unreviewed compiler options');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'graph-compile-proof-'));const req=createRequire(path.join(graph,'package.json'));const tsc=req.resolve('typescript/bin/tsc');const rows=[];
try{
 fs.cpSync(path.join(graph,'src'),path.join(temp,'src'),{recursive:true});fs.copyFileSync(path.join(graph,'tsconfig.json'),path.join(temp,'tsconfig.json'));fs.copyFileSync(path.join(graph,'package.json'),path.join(temp,'package.json'));
 fs.symlinkSync(path.join(graph,'node_modules'),path.join(temp,'node_modules'),'dir');
 const run=(args,label)=>{const start=performance.now();const r=spawnSync(process.execPath,[tsc,...args],{cwd:temp,encoding:'utf8',timeout:30000});rows.push({label,args,code:r.status,ms:performance.now()-start});assert.ok(!r.error,String(r.error));return r;};
 // Execute exactly the discovered initial compiler stages on a single source copy.
 for(const [i,step]of compilerSteps.entries()){const r=run(step==='tsc'?[]:['--noEmit'],'initial-'+i);assert.equal(r.status,0,r.stdout+r.stderr);}
 const outputs=fs.readdirSync(path.join(temp,'dist'),{recursive:true});assert.ok(outputs.some(p=>p.endsWith('.js')));assert.ok(outputs.some(p=>p.endsWith('.d.ts')));assert.ok(outputs.some(p=>p.endsWith('.js.map')));
 fs.rmSync(path.join(temp,'dist'),{recursive:true});const standalone=run(['--noEmit'],'standalone-noEmit');assert.equal(standalone.status,0,standalone.stdout+standalone.stderr);assert.equal(fs.existsSync(path.join(temp,'dist')),false,'standalone noEmit must not create dist');
 fs.writeFileSync(path.join(temp,'src','single-compile-negative.ts'),"export const mustBeNumber: number = 'real-type-error';\n");
 for(const args of [[],['--noEmit']]){const r=run(args,'type-error-'+(args.length?'noEmit':'build'));assert.notEqual(r.status,0);assert.match(r.stdout+r.stderr,/TS2322/);}
 console.log(JSON.stringify({initial,compilerInvocations:compilerSteps.length,realCompiler:path.basename(tsc),rows}));
 assert.equal(compilerSteps.length,1,'GRAPH_CHECK_REDUNDANT_INITIAL_TYPECHECK: same tsconfig must compile once before downstream property guards');
 console.log('GRAPH_SINGLE_INITIAL_COMPILE_REAL_TYPE_ERROR_AND_NOEMIT_PASS');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
