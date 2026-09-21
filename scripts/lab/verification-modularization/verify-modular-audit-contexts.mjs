import assert from 'node:assert/strict';import fs from 'node:fs';import {execFileSync} from 'node:child_process';
import {reviewedDataResidueAllowed,validateReviewedDataSources} from '../../identity-reviewed-json-contexts.mjs';
const path='scripts/identity-reviewed-json-data.json',inventory=JSON.parse(fs.readFileSync(path)),before=JSON.parse(execFileSync('git',['show','0a73e0aed5:'+path],{encoding:'utf8',maxBuffer:16*1024*1024}));
assert.deepEqual(inventory.entries.slice(0,804),before.entries,'all prior reviewed nodes retained unchanged');
const added=inventory.entries.slice(804),registration=JSON.parse(fs.readFileSync('scripts/lab/verification-modularization/audit-json-registration.json'));
assert.equal(added.length,registration.addedCount);assert.deepEqual([...new Set(added.map(r=>r.path))],registration.files);
const read=path=>fs.readFileSync(path,'utf8');assert.deepEqual(validateReviewedDataSources(read),[]);
let negatives=0;
for(const file of registration.files){
 const row=added.find(r=>r.path===file&&r.nodeKind==='value'),text=read(file),data=JSON.parse(text),keys=row.jsonPointer.slice(1).split('/').map(s=>s.replaceAll('~1','/').replaceAll('~0','~'));let owner=data;for(const key of keys.slice(0,-1))owner=owner[key];const key=keys.at(-1),value=owner[key];
 owner[key]=value+' changed evidence';let changed=JSON.stringify(data,null,2);assert.ok(validateReviewedDataSources(path=>path===file?changed:read(path)).some(error=>error.includes(file)));negatives++;
 owner[key]=value;owner[key+'-moved']=owner[key];delete owner[key];changed=JSON.stringify(data,null,2);assert.ok(validateReviewedDataSources(path=>path===file?changed:read(path)).some(error=>error.includes(file)));negatives++;
 assert.equal(reviewedDataResidueAllowed({path:'unregistered/'+file,token:row.token,lineNumber:1,line:text.split('\n')[0],text}),false);negatives++;
}
console.log('MODULAR_AUDIT_CONTEXTS_GREEN '+JSON.stringify({unchanged:804,added:added.length,files:registration.files.length,mutationControls:negatives}));
