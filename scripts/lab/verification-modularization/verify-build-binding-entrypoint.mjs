import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const path = 'scripts/verify-validation-build-artifact-binding.mjs';
const source = fs.readFileSync(path, 'utf8');
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
assert.ok(source.split('\n').length <= 40 && ast.statements.every(n => ts.isImportDeclaration(n) || ts.isExpressionStatement(n)), 'BUILD_BINDING_ENTRYPOINT_NOT_THIN: isolate routine, DONE, cache, executor and handler checks');
console.log('BUILD_BINDING_ENTRYPOINT_STRUCTURE_GREEN');
const { execFileSync, spawnSync } = await import('node:child_process');
const base = ts.createSourceFile(path, execFileSync('git', ['show', '317918539b:' + path], { encoding: 'utf8' }), ts.ScriptTarget.Latest, true);
const folder = 'scripts/validation-build-binding';
const observed = new Map();
for (const name of fs.readdirSync(folder).filter(name => name.endsWith('.mjs'))) {
 const text = fs.readFileSync(folder + '/' + name, 'utf8');
 assert.ok(text.split('\n').length <= 2000, 'BUILD_BINDING_MODULE_EXCEEDS_2000: ' + name);
 const parsed = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
 const statements = name === 'support.mjs' ? parsed.statements.filter(n => !ts.isImportDeclaration(n) && !(ts.isFunctionDeclaration(n) && n.name?.text === 'setHostEnforced'))
  : name === 'cli.mjs' ? [] : parsed.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text.startsWith('run')).body.statements;
 observed.set(name.replace('.mjs', ''), [...statements].map(n => n.getText(parsed).replace(/^export /, '')));
}
function relocate(n) {
 let text = n.getText(base); const edits = [];
 const visit = child => { if(ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(child.arguments[0]) && child.arguments[0].text.startsWith('.')) { const arg = child.arguments[0]; edits.push([arg.getStart(base)-n.getStart(base), arg.end-n.getStart(base), JSON.stringify('../'+arg.text)]); } ts.forEachChild(child, visit); }; visit(n);
 for(const [start,end,value] of edits.reverse()) text=text.slice(0,start)+value+text.slice(end);
 if(text.startsWith('const repoRoot =')) text="const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');";
 return text.replace('hostEnforced = resolved.enforced === true;', 'setHostEnforced(resolved.enforced === true);');
}
const groups = new Map();
for(const node of base.statements) {
 if(ts.isImportDeclaration(node)) continue;
 const line=base.getLineAndCharacterOfPosition(node.getStart(base)).line+1;
 const group=line<110?'support':line<716?'routine':line<1453?'done-required':line<1710?'shared-cache':line<3113?'executor':line<3324?'handler':null;
 if(group) {if(!groups.has(group))groups.set(group,[]);groups.get(group).push(relocate(node));}
}
for(const [group,statements] of groups)assert.deepEqual(observed.get(group),statements,'original statements/order retained: '+group);
const invoke=args=>spawnSync(process.execPath,[path,...args],{encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
const list=invoke(['--list-capabilities']);assert.equal(list.status,0,list.stderr);assert.deepEqual(JSON.parse(list.stdout).map(row=>row.id),['routine','done-required','shared-cache','executor','handler']);
for(const args of [['--capability='],['--capability=unknown'],['--all','--capability=routine']]){const result=invoke(args);assert.equal(result.status,1);assert.match(result.stderr,/Unknown build binding verification argument/);assert.doesNotMatch(result.stdout,/checks passed|BUILD_BINDING_PARTIAL_PASS/);}
const partial=invoke(['--capability=routine','--capability=routine']);assert.equal(partial.status,0,partial.stderr);assert.match(partial.stdout,/BUILD_BINDING_PARTIAL_PASS/);assert.doesNotMatch(partial.stdout,/verify-validation-build-artifact-binding: \d+ checks passed/);
const { createFixtureMachineEnvironment } = await import('../../../packages/main/dist/tasks/helpers/fixture-machine-environment.js');
const { VALIDATION_RESERVATION_DELEGATION_RUNTIME_POLICY: policy } = await import('../../../packages/main/dist/core/runtime-fact-registry.js');
const fixture=createFixtureMachineEnvironment(), env={...fixture.env};delete env[policy.descriptorEnvironment];
const { spawn } = await import('node:child_process');
const started=performance.now();let stdout='',stderr='',timedOut=false,killTimer;
const child=spawn(process.execPath,[path],{env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
const stop=signal=>{try{if(process.platform==='win32')child.kill(signal);else process.kill(-child.pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}};
const abort=()=>{stop('SIGTERM');killTimer??=setTimeout(()=>stop('SIGKILL'),2000);};
child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>16*1024*1024)abort();});child.stderr.on('data',chunk=>{stderr+=chunk;if(stderr.length>16*1024*1024)abort();});
const timer=setTimeout(()=>{timedOut=true;abort();},180000);
const result=await new Promise(resolve=>{let error;child.once('error',e=>{error=e.message;});child.once('close',(code,signal)=>resolve({code,signal,error}));});clearTimeout(timer);clearTimeout(killTimer);
console.log('BUILD_BINDING_FULL_RESULT '+JSON.stringify({...result,timedOut,elapsedMs:performance.now()-started}));console.log(stdout);console.error(stderr);
assert.equal(timedOut,false);assert.equal(result.code,0,'full build binding verification must pass');assert.match(stdout,/verify-validation-build-artifact-binding: \d+ checks passed/);assert.doesNotMatch(stdout,/BUILD_BINDING_PARTIAL_PASS/);fixture.cleanup();
console.log('BUILD_BINDING_MODULAR_GREEN');
