import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const path='packages/main/src/tasks/retired-authority-vocabulary-guard-smoke.ts';
const text=fs.readFileSync(path,'utf8'),ast=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true);
assert.ok(text.split('\n').length<=40&&ast.statements.every(n=>ts.isImportDeclaration(n)||ts.isExpressionStatement(n)),'RETIRED_ENTRYPOINT_NOT_THIN: separate rule data, loader analysis, graph analysis and controls');
console.log('RETIRED_ENTRYPOINT_STRUCTURE_GREEN');
const {execFileSync,spawnSync}=await import('node:child_process');
const original=ts.createSourceFile(path,execFileSync('git',['show','4a6d510ac0:'+path],{encoding:'utf8'}),ts.ScriptTarget.Latest,true);
const functions=new Map();
for(const name of fs.readdirSync('packages/main/src/tasks/retired-authority').filter(n=>n.endsWith('.ts'))){const source=fs.readFileSync('packages/main/src/tasks/retired-authority/'+name,'utf8');assert.ok(source.split('\n').length<=2000,'RETIRED_MODULE_EXCEEDS_2000: '+name);const parsed=ts.createSourceFile(name,source,ts.ScriptTarget.Latest,true);for(const node of parsed.statements)if(ts.isFunctionDeclaration(node)&&node.body)functions.set(node.name.text,node.body.getText(parsed));}
let count=0;for(const node of original.statements)if(ts.isFunctionDeclaration(node)){let expected=node.body.getText(original);for(const repair of JSON.parse(fs.readFileSync('scripts/lab/verification-modularization/retired-source-repairs.json','utf8')))if(repair.name===node.name.text){assert.ok(expected.includes(repair.before));expected=expected.replace(repair.before,repair.after);}assert.equal(functions.get(node.name.text),expected,'retained guard function '+node.name.text);count++;}
console.log('RETIRED_ORIGINAL_FUNCTIONS_PRESERVED '+count);
const printer = ts.createPrinter({ removeComments: true });
const normalize = (node, source) => printer.printNode(ts.EmitHint.Unspecified, node, source);
const driverPath = 'packages/main/src/tasks/retired-authority/driver.ts';
const driver = ts.createSourceFile(driverPath, fs.readFileSync(driverPath, 'utf8'), ts.ScriptTarget.Latest, true);
const body = driver.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'runRetiredComplete').body;
const start = original.statements.findIndex(node => ts.isIfStatement(node) && node.getText(original).startsWith("if (process.argv.includes('--lab-graph-loader-proof'))"));
assert.ok(start > 0);
assert.deepEqual(body.statements.map(node => normalize(node, driver)), original.statements.slice(start).map(node => normalize(node, original)), 'full driver retains every original statement in order');
console.log('RETIRED_COMPLETE_DRIVER_ORDER_PRESERVED');
const rulePath = 'packages/main/src/tasks/retired-authority/rule-data.ts';
const rules = ts.createSourceFile(rulePath, fs.readFileSync(rulePath, 'utf8'), ts.ScriptTarget.Latest, true);
const quarantine = ast => ast.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(ast) === 'legacyQuarantineFiles').initializer.arguments[0].elements.map(node => node.getText(ast));
assert.deepEqual(quarantine(rules).sort(), [...quarantine(original).filter(value => value !== "'packages/main/src/tasks/retired-authority-vocabulary-guard-smoke.ts'"), ...['compatibility-controls', 'file-scan', 'positive-controls', 'public-contract', 'rule-data'].map(name => "'packages/main/src/tasks/retired-authority/" + name + ".ts'")].sort(), 'only five explicitly relocated existing quarantine sources are added');


const entry='packages/main/dist/tasks/retired-authority-vocabulary-guard-smoke.js',run=args=>spawnSync(process.execPath,[entry,...args],{encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
const list=run(['--list-capabilities']);assert.equal(list.status,0,list.stderr);assert.equal(JSON.parse(list.stdout).length,6);
for(const args of [['--capability='],['--capability=unknown'],['--all','--capability=vocabulary-controls']]){const result=run(args);assert.equal(result.status,1);assert.match(result.stderr,/Unknown retired vocabulary verification argument/);assert.doesNotMatch(result.stdout,/retired authority vocabulary guard PASS|RETIRED_VOCABULARY_PARTIAL_PASS/);}
const partial=run(['--capability=vocabulary-controls','--capability=vocabulary-controls']);assert.equal(partial.status,0,partial.stderr);assert.match(partial.stdout,/RETIRED_VOCABULARY_PARTIAL_PASS/);assert.doesNotMatch(partial.stdout,/retired authority vocabulary guard PASS/);
await import('./verify-evidence-plan-import.mjs');
if(!process.argv.includes('--structure-only'))await import('./verify-retired-complete.mjs');
