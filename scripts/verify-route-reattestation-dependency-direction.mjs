import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const root=process.cwd(),require=createRequire(resolve(root,'package.json')),ts=require('typescript');
const contract=readFileSync(resolve(root,'scripts/verify-process-fact-contract.mjs'),'utf8');
const source=readFileSync(resolve(root,'packages/main/src/handlers/finding-route.ts'),'utf8');
const parsed=ts.createSourceFile('contract.mjs',contract,ts.ScriptTarget.Latest,true);
const existing=parsed.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='story2DependencyIssues');assert(existing,'SETUP original actual dependency checker unavailable');
const oldCheck=new Function('ts',existing.getText(parsed)+';return story2DependencyIssues;')(ts);
const imports=[];function visit(n){const s=(ts.isImportDeclaration(n)||ts.isExportDeclaration(n))?n.moduleSpecifier:ts.isCallExpression(n)&&n.expression.kind===ts.SyntaxKind.ImportKeyword?n.arguments[0]:undefined;if(s&&ts.isStringLiteral(s)&&s.text.includes('finding-material-reattestation'))imports.push(s.text);ts.forEachChild(n,visit);}visit(ts.createSourceFile('route.ts',source,ts.ScriptTarget.Latest,true));
console.log('ROUTE_DIRECTION_ACTUAL_OBSERVATION '+JSON.stringify({actualReverseImports:imports,existingCheckerIssues:oldCheck(source)}));
assert.deepEqual(imports,[],'ROUTE_DIRECTION_REQUIRED Story2 route must not import Story1 material re-attestation');
const dag=parsed.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='findingDagDependencyIssues');assert(dag,'ROUTE_DIRECTION_REQUIRED actual contract needs canonical owner-aware DAG guard');
const check=new Function('ts',dag.getText(parsed)+';return findingDagDependencyIssues;')(ts);
assert.deepEqual(check(source,'Story2'),[]);
for(const injection of ["import {x} from './finding-material-reattestation.js';","export {x} from './finding-material-reattestation.js';","await import('./finding-material-reattestation.js');"]){
 const expected='FINDING_DAG_FORBIDDEN: Story2->Story1: ./finding-material-reattestation.js';
 assert(check(source+'\n'+injection,'Story2').includes(expected),'ROUTE_DIRECTION_REQUIRED exact real checker must reject reverse import');
}
console.log('ROUTE_DIRECTION_GREEN actual source clean and canonical reverse-edge mutations rejected');

const {execFileSync}=await import('node:child_process');
for (const flags of [[], ['--head-continuity']]) {
 const output=execFileSync(process.execPath,['packages/main/dist/tasks/finding-material-reattestation-smoke.js','--route-restoration-port',...flags], {cwd:root,encoding:'utf8',stdio:'pipe',timeout:120000});
 process.stdout.write(output);
 assert(output.includes('ROUTE_RESTORATION_PORT PASS'), 'ROUTE_DIRECTION_REQUIRED native restoration port controls executed');
}
console.log('ROUTE_DIRECTION_NATIVE_GREEN signed material and head-only restoration preserved');
