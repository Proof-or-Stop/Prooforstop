import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {SCANNER_SOURCE_PATHS,SCANNER_RETIRED_LINE_CONTEXTS} from '../../identity-cutover/scanner-contexts.mjs';
import {verifyScannerRetiredContexts} from '../../identity-cutover/source-integrity.mjs';
import {TOKEN_PATTERN} from '../../identity-cutover/active-scan.mjs';
const entry='scripts/verify-proof-or-stop-identity-cutover.mjs',directory='scripts/identity-cutover';
assert.deepEqual(SCANNER_SOURCE_PATHS,[entry,...fs.readdirSync(directory).filter(n=>n.endsWith('.mjs')).sort().map(n=>directory+'/'+n)],'every scanner module is explicitly covered');
const original=execFileSync('git',['show','48ade8d295:'+entry],{encoding:'utf8'});
const oldLines=original.split(/\r?\n/u),sha=text=>createHash('sha256').update(text).digest('hex');
const migration=JSON.parse(fs.readFileSync('scripts/lab/verification-modularization/identity-self-context-migration.json'));
assert.deepEqual(migration.sourcePaths,SCANNER_SOURCE_PATHS);
assert.equal(migration.rows.length,SCANNER_RETIRED_LINE_CONTEXTS.length);
const repairs=JSON.parse(fs.readFileSync('scripts/lab/verification-modularization/identity-context-repairs.json','utf8'));
const retiredTokens=text=>[...text.matchAll(TOKEN_PATTERN)].map(match=>match[0]).sort();
for(const repair of repairs)assert.deepEqual(retiredTokens(repair.after),retiredTokens(repair.before),'exact context migration preserves the scanner data token inventory');
for(const row of migration.rows){
 const text=fs.readFileSync(row.path,'utf8'),lines=text.split(/\r?\n/u);
 assert.ok(row.originalLines.length>0||Number.isInteger(row.repairIndex));
 for(const lineNumber of row.currentLines){const line=lines[lineNumber-1];assert.equal(sha(line),row.lineSha256);assert.ok(row.originalLines.some(n=>oldLines[n-1]===line||'export '+oldLines[n-1]===line)||(Number.isInteger(row.repairIndex)&&repairs[row.repairIndex].file===row.path&&repairs[row.repairIndex].after.split(/\r?\n/u).includes(line)),'only original lines or recorded token-preserving context migrations may move');}
 assert.deepEqual(SCANNER_RETIRED_LINE_CONTEXTS.find(([path,digest])=>path===row.path&&digest===row.lineSha256),[row.path,row.lineSha256,row.currentLines.length,row.currentLines]);
}
let negatives=0;
for(const path of SCANNER_SOURCE_PATHS){
 const text=fs.readFileSync(path,'utf8');assert.deepEqual(verifyScannerRetiredContexts(text,path),[],path);
 const first=text.split(/\r?\n/u).find(line=>[...line.matchAll(TOKEN_PATTERN)].length);
 for(const mutated of [text+"\nexport const unreviewed = '"+'proof'+'bound'+"';\n",...(first?[text+'\n'+first+'\n',text.replace(first,''),'\n'+text]:[])]){assert.ok(verifyScannerRetiredContexts(mutated,path).length>0,path+' must reject added/deleted/relocated contexts');negatives++;}
 assert.ok(verifyScannerRetiredContexts(text,'scripts/unregistered-scanner.mjs').length>0,'copied source does not inherit authorization');negatives++;
}
console.log('IDENTITY_SELF_CONTEXT_GREEN '+JSON.stringify({sourcePaths:SCANNER_SOURCE_PATHS.length,pins:SCANNER_RETIRED_LINE_CONTEXTS.length,negativeControls:negatives}));
