import fs from 'node:fs';import vm from 'node:vm';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import assert from 'node:assert/strict';import ts from 'typescript';
const source=fs.readFileSync(process.argv[2],'utf8'),ast=ts.createSourceFile('archive.mjs',source,ts.ScriptTarget.Latest,true);let statement;
const visit=n=>{if(ts.isIfStatement(n)&&n.expression.getText(ast)==="identityCase.mutationKind === 'historical-retired'")statement=n.thenStatement;ts.forEachChild(n,visit)};visit(ast);assert(statement);
const {ACTIVE_IDENTITY_OPERATION_BOUNDARIES}=await import(pathToFileURL(resolve('packages/main/tests/canonical-new-story-artifacts/data.mjs')).href);
const cases=ACTIVE_IDENTITY_OPERATION_BOUNDARIES.flatMap(boundary=>boundary.retiredIdentityCases).filter(site=>site.mutationKind==='historical-retired');assert(cases.length>0);
let checked=0,rejections=0;
for(const identityCase of cases){
 const check=site=>vm.runInNewContext(statement.getText(ast),{assert,identityCase:site});check(identityCase);checked++;
 assert.throws(()=>check({...identityCase,retiredProvenance:{...identityCase.retiredProvenance,sourcePath:'scripts/unregistered.mjs'}}),/historical counterpart/);rejections++;
}
console.log('ARCHIVE_PROVENANCE_TABLE_PASS '+JSON.stringify({historicalCases:checked,wrongSourceRejected:rejections,fullMigrationCampaignRun:false}));
