import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const path = 'packages/main/src/tasks/managed-review-evidence-smoke.ts';
const source = fs.readFileSync(path, 'utf8');
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
assert.ok(source.split('\n').length <= 40 && ast.statements.every(node => ts.isImportDeclaration(node) || ts.isExpressionStatement(node)), 'MANAGED_ENTRYPOINT_NOT_THIN: separate transport, evidence, tamper and worker capabilities');
console.log('MANAGED_ENTRYPOINT_STRUCTURE_GREEN');
const {execFileSync, spawnSync} = await import('node:child_process');
const originalText = execFileSync('git',['show','6f6d88948f:'+path],{encoding:'utf8'});
const options = {target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext};
const host=ts.createCompilerHost(options), getSource=host.getSourceFile.bind(host);
host.getSourceFile=(name,...args)=>name===path||name.endsWith('/'+path)?ts.createSourceFile(name,originalText,args[0],true):getSource(name,...args);
const program=ts.createProgram([path],options,host), before=program.getSourceFile(path), checker=program.getTypeChecker();
const directory='packages/main/src/tasks/managed-review-evidence';
const modules=new Map(), functions=new Map();
for(const name of fs.readdirSync(directory).filter(name=>name.endsWith('.ts'))){const text=fs.readFileSync(directory+'/'+name,'utf8');assert.ok(text.split('\n').length<=2000,'MANAGED_MODULE_EXCEEDS_2000: '+name);const ast=ts.createSourceFile(name,text,ts.ScriptTarget.Latest,true);assert.equal(ast.parseDiagnostics.length,0,name);modules.set(name,ast);for(const node of ast.statements)if(ts.isFunctionDeclaration(node)&&node.name.text!=='runPhase')functions.set(node.name.text,node.body.getText(ast));}
const relocations=[];
const relocationVisit=node=>{if((ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword)||(ts.isNewExpression(node)&&node.expression.getText(before)==='URL'&&node.arguments?.[1]?.getText(before)==='import.meta.url')){const arg=node.arguments?.[0];if(arg&&ts.isStringLiteral(arg)&&arg.text.startsWith('.'))relocations.push({start:arg.getStart(),end:arg.end,text:JSON.stringify('../'+arg.text)});}if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument)&&ts.isStringLiteral(node.argument.literal)&&node.argument.literal.text.startsWith('.')){const arg=node.argument.literal;relocations.push({start:arg.getStart(),end:arg.end,text:JSON.stringify('../'+arg.text)});}ts.forEachChild(node,relocationVisit);};relocationVisit(before);
const render=(node,extras=[])=>{let text=node.getText(before),start=node.getStart();for(const edit of [...relocations,...extras].filter(e=>e.start>=start&&e.end<=node.end).sort((a,b)=>b.start-a.start))text=text.slice(0,edit.start-start)+edit.text+text.slice(edit.end-start);return text;};
const phaseBoundaryRepair=JSON.parse(fs.readFileSync('scripts/lab/verification-modularization/managed-phase-boundary-repair.json','utf8'));
assert.equal(functions.get(phaseBoundaryRepair.helper.name),phaseBoundaryRepair.helper.body,'shared imported-pass checks retain their exact reviewed body');
let preserved=0;for(const node of before.statements)if(ts.isFunctionDeclaration(node)&&node.name.text!=='main'){assert.equal(functions.get(node.name.text),render(node.body),'managed helper body retained: '+node.name.text);preserved++;}
const main=before.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name.text==='main');
const trial=main.body.statements.find(ts.isTryStatement);
const names=['codex-transport','claude-transport','evidence-binding','native-attestation','sealed-receipts'];
const counts=[100,24,79,68,148];
const grouped=[];let offset=0;for(const count of counts){grouped.push([...trial.tryBlock.statements].slice(offset,offset+count));offset+=count;}assert.equal(offset,trial.tryBlock.statements.length);
const ids=node=>ts.isIdentifier(node)?[node]:(ts.isObjectBindingPattern(node)||ts.isArrayBindingPattern(node))?node.elements.flatMap(e=>ts.isBindingElement(e)?ids(e.name):[]):[];
const locals=new Map();
for(const node of main.body.statements.filter(ts.isVariableStatement))for(const id of node.declarationList.declarations.flatMap(d=>ids(d.name)))if(['root','evaluatorMutationBoundary','bindingMutationTarget'].includes(id.text))locals.set(checker.getSymbolAtLocation(id),{name:id.text,phase:-1});
for(let phase=0;phase<grouped.length;phase++)for(const node of grouped[phase].filter(ts.isVariableStatement))for(const id of node.declarationList.declarations.flatMap(d=>ids(d.name)))locals.set(checker.getSymbolAtLocation(id),{name:id.text,phase});
for(let phase=0;phase<names.length;phase++){
 const module=modules.get(names[phase]+'.ts');const fn=module.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name.text==='runPhase');
 const expected=grouped[phase].map(node=>{const edits=[];const visit=part=>{if(ts.isIdentifier(part)){const symbol=ts.isShorthandPropertyAssignment(part.parent)?checker.getShorthandAssignmentValueSymbol(part.parent):checker.getSymbolAtLocation(part);const info=locals.get(symbol);if(info&&info.phase!==phase){assert.ok(info.phase<phase,'no future lexical capture can be lost');edits.push({start:part.getStart(),end:part.end,text:(ts.isShorthandPropertyAssignment(part.parent)?info.name+': ':'')+'context.'+info.name});}}ts.forEachChild(part,visit);};visit(node);let text=render(node,edits);if(phase===0)text=text.replace("process.argv[2] === '--descriptor-proposal-transport'","process.argv[2] === '--descriptor-proposal-transport' || context.descriptorOnly");if(text==="console.log('managed-review-evidence-smoke PASS');")text='if (context.fullRun) '+text;const temp=ts.createSourceFile('phase.ts',text,ts.ScriptTarget.Latest,true);const wraps=[];const wrap=node=>{if(ts.isCallExpression(node)&&node.expression.getText(temp)==='submitManagedHostRun'){const first=node.arguments[0];wraps.push({pos:first.getStart(temp),text:'withManagedFixturePrompt('},{pos:first.end,text:')'});}ts.forEachChild(node,wrap);};wrap(temp);for(const edit of wraps.sort((a,b)=>b.pos-a.pos))text=text.slice(0,edit.pos)+edit.text+text.slice(edit.pos);if(phase===1)for(const repair of JSON.parse(fs.readFileSync('scripts/lab/verification-modularization/managed-model-binding-repair.json','utf8')).changes){if(text.includes(repair.before)){assert.equal(text.split(repair.before).length,2);text=text.replace(repair.before,repair.after);}}return text;});
 for(const repair of phaseBoundaryRepair.changes.filter(row=>row.phase===phase)){
  assert.ok(repair.before.length>0,'every repair has an exact original anchor');
  const matches=[];
  for(let index=0;index<=expected.length-repair.before.length;index++)if(repair.before.every((text,offset)=>expected[index+offset]===text))matches.push(index);
  assert.equal(matches.length,1,'phase repair must match exactly once: '+names[phase]);
  expected.splice(matches[0],repair.before.length,...repair.after);
 }
 assert.deepEqual(fn.body.statements.slice(0,-1).map(node=>node.getText(module)),expected,'original phase statements plus exact boundary repair: '+names[phase]);
 assert.equal(fn.body.statements.length,expected.length+1,'only the typed shared-context handoff is appended');
 assert.match(fn.body.statements.at(-1).getText(module),/^return Object\.defineProperties\(context,/,'return the same shared context without copying closure cells');
}
const suite=modules.get('suite.ts'), current=suite.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name.text==='main');const currentTry=current.body.statements.find(ts.isTryStatement);
assert.deepEqual(current.body.statements.filter(node=>node!==currentTry).map(node=>node.getText(suite)),main.body.statements.filter(node=>node!==trial).map(node=>render(node)),'original main setup retained');
assert.equal(currentTry.finallyBlock.getText(suite),render(trial.finallyBlock),'original cleanup always retained');
for(let i=0;i<5;i++){assert.ok(currentTry.tryBlock.getText(suite).includes(`await phase${i}(`));assert.ok(currentTry.tryBlock.getText(suite).includes(`if (!result${i}) return -1;`));}
console.log('MANAGED_PRESERVATION_GREEN '+JSON.stringify({helperFunctions:preserved,orderedMainStatements:offset,phases:5}));
const entry='packages/main/dist/tasks/managed-review-evidence-smoke.js';
const run=args=>spawnSync(process.execPath,[entry,...args],{encoding:'utf8',timeout:120000,maxBuffer:12*1024*1024});
const list=run(['--list-capabilities']);assert.equal(list.status,0,list.stderr);const capabilities=JSON.parse(list.stdout);assert.equal(capabilities.length,7);assert.equal(capabilities.find(row=>row.id==='sealed-receipts').prerequisites.length,4);
for(const args of [['--capability='],['--capability=unknown'],['--all','--capability=supersession']]){const result=run(args);assert.equal(result.status,1);assert.match(result.stderr,/Unknown managed review verification argument/);assert.doesNotMatch(result.stdout,/managed-review-evidence-smoke PASS|MANAGED_REVIEW_PARTIAL_PASS/);}
await import('./verify-managed-prompt-fixture.mjs');
if(!process.argv.includes('--structure-only'))await import('./verify-managed-complete.mjs');
