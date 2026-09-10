import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {resolve,join,basename} from 'node:path';
import {tmpdir} from 'node:os';
const root=resolve(process.argv.find(arg=>arg.startsWith('--repo='))?.slice(7)||process.cwd());
const ts=createRequire(join(root,'package.json'))('typescript');
const oldMembers=['agent-dispatch-registry-smoke.js','review-pass-discard-smoke.js','flow-stability-smoke.js','init-check-required-agents-smoke.js','provider-codex-smoke.js','cross-host-review-smoke.js','repair-retry-loop-smoke.js'];
const source=readFileSync(join(root,'packages/main/src/tasks/agent-liveness-suite-smoke.ts'),'utf8');
const ast=ts.createSourceFile('liveness.ts',source,ts.ScriptTarget.Latest,true),arrays=[];
function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='childSmokes'){let value=n.initializer;if(ts.isAsExpression(value))value=value.expression;assert.ok(ts.isArrayLiteralExpression(value));assert.ok(value.elements.every(ts.isStringLiteral));arrays.push(value.elements.map(e=>e.text));}ts.forEachChild(n,visit);}visit(ast);
assert.deepEqual(arrays,[oldMembers],'historical seven-member source inventory must not silently change');
const commands=JSON.parse(readFileSync(join(root,'proof-or-stop.config.json'),'utf8')).validate.commands;
const selections=oldMembers.map(name=>({name,entries:commands.filter(c=>(c.args??[]).includes('packages/main/dist/tasks/'+name))}));
const missing=selections.filter(x=>x.entries.length!==1).map(x=>({name:x.name,count:x.entries.length}));
console.log('U18_LIVENESS_UNION_OBSERVED '+JSON.stringify({members:oldMembers,missing}));
assert.deepEqual(missing,[],'U18_LIVENESS_UNION_REQUIRED: all seven former members require exactly one independent configured entry');
if(!process.argv.includes('--trace')){console.log('U18_LIVENESS_UNION_INVENTORY_PASS; nested-execution acceptance requires --trace');}
else{
 const scratch=mkdtempSync(join(tmpdir(),'u18-union-')),log=join(scratch,'nested.jsonl'),preload=join(scratch,'trace.mjs');
 // Cross-host's exact self worker/submitter argv execute fixture roles, not its suite main.
 const registered=commands.flatMap(c=>(c.args??[]).filter(a=>/\.(?:mjs|js)$/.test(a)).map(a=>resolve(root,a)));
 writeFileSync(preload,`import cp from 'node:child_process';import{appendFileSync}from'node:fs';import{resolve,basename}from'node:path';import{syncBuiltinESMExports}from'node:module';
const registered=new Set(${JSON.stringify(registered)});let depth=0;
for(const api of ['execFileSync','execFile','spawnSync','spawn','fork','exec','execSync']){const old=cp[api];cp[api]=function(command,args,...rest){if(!depth){const shell=api==='exec'||api==='execSync';const argv=api==='fork'?[command,...(Array.isArray(args)?args:[])]:shell?String(command).split(/\\s+/).map(s=>s.replace(/^['"]|['"]$/g,'')):Array.isArray(args)?args:[];const node=api==='fork'||shell||/^(node|bun)(\\.exe)?$/.test(basename(command));for(const arg of node?argv:[]){if(typeof arg==='string'&&registered.has(resolve(arg))){const wrapper=basename(process.argv[1]??'')==='run-validation-fixture-suite.mjs'&&resolve(arg)===process.env.U18_INITIAL_MEMBER; const fixtureWorker=api==='spawn'&&resolve(process.argv[1]??'')===resolve(arg)&&basename(arg)==='cross-host-review-smoke.js'&&argv[0]===arg&&argv.length===6&&['--xhr-worker','--xhr-submitter'].includes(argv[1]); if(!wrapper&&!fixtureWorker){appendFileSync(${JSON.stringify(log)},JSON.stringify({api,parent:process.argv[1],entry:arg})+'\\n');throw Error('U18_NESTED_REGISTERED_MEMBER');}}}}depth++;try{return old.call(this,command,args,...rest);}finally{depth--;}};}syncBuiltinESMExports();`);
 // The observer must refuse ordinary preload and shell launches before execution.
 const negative=join(scratch,'negative.mjs'),noop=join(scratch,'noop.mjs');writeFileSync(noop,'');
 writeFileSync(negative,`import assert from 'node:assert/strict';import cp from 'node:child_process';
const target=${JSON.stringify(resolve(root,'packages/main/dist/tasks/cross-host-review-smoke.js'))};
for(const api of ['execFileSync','execFile','spawnSync','spawn','fork','exec','execSync']){
 const run=()=>api==='fork'?cp.fork(target):api==='exec'||api==='execSync'?cp[api](JSON.stringify(process.execPath)+' '+JSON.stringify(target)):cp[api](process.execPath,['--import',${JSON.stringify(noop)},target]);
 assert.throws(run,/U18_NESTED_REGISTERED_MEMBER/,api+' must reject a registered suite');
}`);
 const negativeResult=spawnSync(process.execPath,['--import',preload,negative],{cwd:root,encoding:'utf8'});
 assert.equal(negativeResult.status,0,negativeResult.stderr);assert.equal(readFileSync(log,'utf8').trim().split('\n').length,7);writeFileSync(log,'');
 const {runValidationCommand}=await import(join(root,'packages/main/dist/core/validation-executor.js'));
 const only=process.argv.find(arg=>arg.startsWith('--member='))?.slice(9);
 if(only)assert.ok(oldMembers.includes(only),'unknown member');
 try{for(const {name,entries:[entry]} of selections.filter(row=>!only||row.name===only)){
  const env={...(entry.env??{}),NODE_OPTIONS:`${process.env.NODE_OPTIONS??''} --import=${JSON.stringify(preload)}`,U18_INITIAL_MEMBER:resolve(root,'packages/main/dist/tasks/'+name)};
  const result=await runValidationCommand({...entry,env},root);console.log(JSON.stringify({name,code:result.code,elapsedMs:result.durationMs}));
  assert.equal(existsSync(log)?readFileSync(log,'utf8'):'','', 'U18 registered member nested another configured suite');assert.equal(result.code,0,result.output.slice(-24000));
  if(['flow-stability-smoke.js','provider-codex-smoke.js'].includes(name))assert.ok(result.output.split(/\r?\n/).includes(name.replace(/\.js$/,'')+': CANONICAL CORE PASS'),'distinct canonical core marker required');
  if(name==='provider-codex-smoke.js')assert.ok(result.output.includes('provider-codex F181 independent child CLI boundary PASS'),'F-181 unique proof retained');
 }console.log(only?'U18_MEMBER_FLAT_PASS '+only:'U18_LIVENESS_UNION_AND_FLAT_PASS');}finally{rmSync(scratch,{recursive:true,force:true});}
}
