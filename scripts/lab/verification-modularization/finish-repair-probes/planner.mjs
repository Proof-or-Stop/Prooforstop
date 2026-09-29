import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
const source=fs.readFileSync(process.argv[2],'utf8');
const parsed=ts.createSourceFile('support.ts',source,ts.ScriptTarget.Latest,true);
const fn=parsed.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='declaredChecklistItems');
assert(fn);
const js=ts.transpileModule(fn.getText(parsed).replace('export ',''),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const root=fs.mkdtempSync(join(tmpdir(),'planner-source-coverage-'));
try{
 const dir=join(root,'packages/main/src/tasks/validation-tier-planner');fs.mkdirSync(dir,{recursive:true});
 for(const name of ['command-identity','historical-pins','change-inputs','selection-widening','cli-integration','hash-completeness','acceptance-guards'])fs.writeFileSync(join(dir,name+'.ts'),"beginSection('CHK-001');\n");
 fs.writeFileSync(join(dir,'new-capability.ts'),"beginSection('CHK-999');\n");
 const call=vm.runInNewContext(js+';declaredChecklistItems',{...fs,join});
 assert.deepEqual(Array.from(call(root)),['CHK-001','CHK-999'],'PLANNER_NEW_CAPABILITY_MUST_RETAIN_RED_GREEN_COVERAGE');
 console.log('PLANNER_NEW_CAPABILITY_COVERAGE_PASS');
}finally{fs.rmSync(root,{recursive:true,force:true});}
