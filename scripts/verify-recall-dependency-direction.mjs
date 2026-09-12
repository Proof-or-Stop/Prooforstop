import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import ts from 'typescript';
const file='packages/main/src/handlers/finding-history.ts';
const source=readFileSync(file,'utf8');
function imports(text){const tree=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);const out=[];function visit(n){if((ts.isImportDeclaration(n)||ts.isExportDeclaration(n))&&n.moduleSpecifier&&ts.isStringLiteral(n.moduleSpecifier))out.push(n.moduleSpecifier.text);if(ts.isCallExpression(n)&&n.expression.kind===ts.SyntaxKind.ImportKeyword&&n.arguments[0]&&ts.isStringLiteral(n.arguments[0]))out.push(n.arguments[0].text);ts.forEachChild(n,visit);}visit(tree);return out;}
const forbidden=s=>imports(s).filter(p=>/finding-applicability|finding-deferral|finding-rollout|finding-mandatory-repair/.test(p));
assert.equal(forbidden("import {x} from './finding-applicability-projection.js';").length,1);
assert.equal(forbidden("export {x} from './finding-applicability.js';").length,1);
assert.equal(forbidden("await import('./finding-applicability.js');").length,1);
assert.equal(forbidden("import {x} from './finding-route.js';").length,0);
console.log('RECALL_DEPENDENCY_SETUP PASS known forbidden and allowed import controls');
console.log('RECALL_DEPENDENCY_OBSERVED '+JSON.stringify({file,imports:forbidden(source)}));
assert.deepEqual(forbidden(source),[], 'RECALL_REVERSE_DEPENDENCY: Story2 history must not import Story1 applicability');
const v=readFileSync('scripts/verify-process-fact-contract.mjs','utf8');const ast=ts.createSourceFile('v.js',v,ts.ScriptTarget.Latest,true);const node=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='story2DependencyIssues');assert.ok(node);
const verify=new Function('ts',node.getText(ast)+';return story2DependencyIssues;')(ts);
for(const mutation of ["import {x} from './finding-applicability-projection.js';","export {x} from './finding-applicability.js';","await import('./finding-applicability.js');"]){assert.ok(verify(source+'\n'+mutation).length,'actual verifier must reject '+mutation);}
assert.equal(verify(source).length,0);
const run=spawnSync(process.execPath,['packages/main/dist/tasks/finding-identity-lineage-smoke.js','--section=routes'],{encoding:'utf8',timeout:360000,maxBuffer:24*1024*1024});
process.stdout.write(run.stdout??'');process.stderr.write(run.stderr??'');
assert.equal(run.signal,null,'native recall behavior must finish without timeout');assert.equal(run.status,0,'native recall routes regression');
assert.match(run.stdout,/FINDING_IDENTITY_ROUTES PASS/);
console.log('RECALL_DEPENDENCY_DIRECTION GREEN');
