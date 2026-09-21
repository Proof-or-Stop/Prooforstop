import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const path='scripts/verify-proof-or-stop-identity-cutover.mjs';
const text=fs.readFileSync(path,'utf8');
const ast=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true);
assert.ok(text.split('\n').length<=40&&ast.statements.every(node=>ts.isImportDeclaration(node)||ts.isExportDeclaration(node)||ts.isExpressionStatement(node)), 'IDENTITY_ENTRYPOINT_NOT_THIN: separate rule data, provenance, source integrity, scanning and certification');
console.log('IDENTITY_ENTRYPOINT_STRUCTURE_GREEN');
const {execFileSync,spawnSync}=await import('node:child_process');
const original=execFileSync('git',['show','48ade8d295:'+path],{encoding:'utf8'});
const before=ts.createSourceFile(path,original,ts.ScriptTarget.Latest,true);
const directory='scripts/identity-cutover';
const candidates=[];
for(const name of fs.readdirSync(directory).filter(name=>name.endsWith('.mjs'))){
 const source=fs.readFileSync(directory+'/'+name,'utf8');
 assert.ok(source.split('\n').length<=2000,'IDENTITY_MODULE_EXCEEDS_2000: '+name);
 const parsed=ts.createSourceFile(name,source,ts.ScriptTarget.Latest,true);
 assert.equal(parsed.parseDiagnostics.length,0,name);
 for(const node of parsed.statements)if(!ts.isImportDeclaration(node))candidates.push(node.getText(parsed).replace(/^export /,''));
}
let preserved=0;
for(const node of before.statements){
 if(ts.isImportDeclaration(node)||ts.isIfStatement(node))continue;
 let expected=node.getText(before).replace(/^export /,'');
 if(expected.startsWith('const SCANNER_RETIRED_LINE_CONTEXTS ='))continue;
 const edits=[];
 const visit=part=>{if(ts.isNewExpression(part)&&part.expression.getText(before)==='URL'&&part.arguments?.[1]?.getText(before)==='import.meta.url'){const arg=part.arguments?.[0];if(arg&&ts.isStringLiteral(arg)&&arg.text.startsWith('.'))edits.push({start:arg.getStart(before)-node.getStart(before),end:arg.end-node.getStart(before),text:JSON.stringify('../'+arg.text)});}ts.forEachChild(part,visit);};visit(node);
 for(const edit of edits.sort((a,b)=>b.start-a.start))expected=expected.slice(0,edit.start)+edit.text+expected.slice(edit.end);
 if(ts.isFunctionDeclaration(node)&&node.name.text==='main')expected=expected.replace('function main() {\n  const flags = process.argv.slice(2);','function main(flags = process.argv.slice(2)) {').replaceAll('process.argv.includes(', 'flags.includes(');
 if(expected.startsWith('const scriptDir ='))expected="const scriptDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');";
 for(const repair of JSON.parse(fs.readFileSync('scripts/lab/verification-modularization/identity-self-context-repairs.json','utf8'))){const old=repair.before.replace(/^export /,''),replacement=repair.after.replace(/^export /,'');if(expected.includes(old))expected=expected.replace(old,replacement);}
 for(const repair of JSON.parse(fs.readFileSync('scripts/lab/verification-modularization/identity-context-repairs.json','utf8'))){const old=repair.before.replace(/^export /,''),replacement=repair.after.replace(/^export /,'');if(expected===old)expected=replacement;}
 const index=candidates.indexOf(expected);
 assert.ok(index>=0,'original identity statement preserved: '+(node.name?.text??expected.slice(0,100)));
 candidates.splice(index,1);preserved++;
}
console.log('IDENTITY_SOURCE_PRESERVATION_GREEN '+JSON.stringify({statements:preserved}));
const run=args=>spawnSync(process.execPath,[path,...args],{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});
const list=run(['--list-capabilities']);assert.equal(list.status,0,list.stderr);assert.equal(JSON.parse(list.stdout).length,5);
for(const args of [['--capability='],['--capability=unknown'],['--all','--capability=ordering']]){const result=run(args);assert.equal(result.status,1);assert.match(result.stderr,/Unknown identity verification argument/);assert.doesNotMatch(result.stdout,/IDENTITY_PARTIAL_PASS/);}
const api=await import('../../verify-proof-or-stop-identity-cutover.mjs');assert.equal(typeof api.identityCutoverReviewedContexts,'function');
console.log('IDENTITY_ROUTING_GREEN: explicit partial catalog, rejected unknown selectors, retained import API');

await import('./verify-identity-self-contexts.mjs');
