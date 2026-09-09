import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
assert.ok(process.argv[2], 'Usage: node score-reviews-v2.mjs <review-benchmark-directory>');
const root=resolve(process.argv[2]);
const roster=JSON.parse(execFileSync('python3',['-O',join(import.meta.dirname,'review-roster-check.py'),root,join(root,'roster-verified-v2.json')],{encoding:'utf8'}));
assert.equal(roster.completeFullIdentityMatch,true);
assert.equal(roster.actualCliExitZero,roster.reviewers);
const before=await import(pathToFileURL(join(root,'before/protocol.mjs'))),after=await import(pathToFileURL(join(root,'after/protocol.mjs')));
const eq=(a,b)=>{try{assert.deepEqual(a,b);return true;}catch{return false;}};
const str=x=>typeof x==='string',bool=x=>typeof x==='boolean',obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x),strings=x=>Array.isArray(x)&&x.every(str),pos=x=>Number.isSafeInteger(x)&&x>0;
const claim=c=>obj(c)&&str(c.key)&&['shared','exclusive'].includes(c.access)&&['external','runner-cleanable'].includes(c.ownership);
const resource=c=>obj(c)&&str(c.key)&&bool(c.known)&&['shared','exclusive'].includes(c.access);
const domain={
 isReusable:a=>a.length===2&&a.every(x=>obj(x)&&str(x.version)&&str(x.implementationDigest)),
 hasWitness:a=>a.length===2&&a.every(str)&&a[0].length<=1000&&a[1].length>0,
 renewLease:a=>a.length===4&&obj(a[0])&&str(a[0].owner)&&pos(a[0].generation)&&typeof a[0].heartbeat==='number'&&a[0].heartbeat>=0&&str(a[1])&&pos(a[2])&&typeof a[3]==='number'&&a[3]>=a[0].heartbeat,
 mayPublish:a=>a.length===2&&obj(a[0])&&['pass','fail'].includes(a[0].status)&&Number.isInteger(a[1])&&a[1]>=0&&a[1]<=255,
 uniqueClaims:a=>a.length===1&&Array.isArray(a[0])&&a[0].every(claim),
 historyExtends:a=>a.length===2&&a.every(strings),
 finalAdmission:a=>a.length===1&&obj(a[0])&&bool(a[0].fresh)&&['final','remediation'].includes(a[0].kind),
 coversExactly:a=>a.length===2&&strings(a[0])&&a[0].length>0&&new Set(a[0]).size===a[0].length&&Array.isArray(a[1])&&a[1].every(strings),
 mayShare:a=>a.length===1&&obj(a[0])&&['optIn','inputsKnown','build'].every(k=>bool(a[0][k])),
 mayOverlap:a=>a.length===2&&a.every(resource),
};
// Independently phrased contract oracles, separate from the candidate source.
const spec={
 isReusable:(r,c)=>[r.version,r.implementationDigest].join('\u0000')===[c.version,c.implementationDigest].join('\u0000') && r.version===c.version && r.implementationDigest===c.implementationDigest,
 hasWitness:(s,q)=>s.indexOf(q)!==-1,
 renewLease:(l,o,g,t)=>o!==l.owner||g!==l.generation?null:Object.assign({},l,{heartbeat:t}),
 mayPublish:(r,x)=>x===0?r.status==='pass':false,
 uniqueClaims:cs=>{const seen=new Set();return cs.filter(c=>{const k=JSON.stringify([c.key,c.access,c.ownership]);if(seen.has(k))return false;seen.add(k);return true;});},
 historyExtends:(a,b)=>eq(a,b.slice(0,a.length)),
 finalAdmission:c=>c.kind==='final'?c.fresh:false,
 coversExactly:(r,ss)=>{const counts=new Map(r.map(k=>[k,0]));for(const s of ss)for(const k of s){if(!counts.has(k))return false;counts.set(k,counts.get(k)+1);}return [...counts.values()].every(n=>n===1);},
 mayShare:c=>!c.build && [c.optIn,c.inputsKnown].every(Boolean),
 mayOverlap:(a,b)=>{if(!a.known||!b.known)return false;if(a.key!==b.key)return true;return a.access==='shared'&&b.access==='shared';},
};
const waves=JSON.parse(readFileSync(join(root,'wave-results.json'),'utf8'));assert.equal(waves.length,5,'Campaign must finish all preregistered waves');
const expectedBugIds=['isReusable','hasWitness','renewLease','mayPublish','uniqueClaims','historyExtends','finalAdmission','coversExactly'];
const details=[];const summaries=[];
for(const w of waves){const found=new Set();let invalid=0;for(const r of w.reviews){assert.equal(r.exitCode,0);assert.ok(r.sourceUnchanged&&r.reportPresent);const report=JSON.parse(readFileSync(join(root,'runs',w.arm,w.wave,r.role,'review.json'),'utf8'));assert.equal(report.sourceSha256,r.sourceSha256);const code=w.wave==='final'?after:before;
 for(const f of report.findings){const valid=Array.isArray(f.args)&&domain[f.function]?.(f.args);let actual,expected,classification;if(!valid){classification='outside_contract_domain';invalid++;}else{expected=spec[f.function](...structuredClone(f.args));actual=code[f.function](...structuredClone(f.args));assert.deepEqual(after[f.function](...structuredClone(f.args)),expected,'Candidate disagrees with independently stated oracle');classification=!eq(f.expected,expected)?'incorrect_expected':eq(actual,expected)?'not_a_defect':'validated_defect';if(classification==='validated_defect')found.add(f.function);else invalid++;}details.push({arm:w.arm,wave:w.wave,role:r.role,finding:f,actual,expected,classification});}
 }summaries.push({arm:w.arm,wave:w.wave,wallSeconds:w.elapsedSeconds,reviewerSeconds:w.reviews.reduce((s,r)=>s+r.elapsedSeconds,0),reviewerCount:w.reviews.length,validatedBugIds:[...found].sort(),unsupportedFindings:invalid});}
const arm=a=>{const ws=summaries.filter(w=>w.arm===a),ids=new Set(ws.filter(w=>w.wave!=='final').flatMap(w=>w.validatedBugIds));return {wallSeconds:ws.reduce((s,w)=>s+w.wallSeconds,0),reviewerSeconds:ws.reduce((s,w)=>s+w.reviewerSeconds,0),reviewerCount:ws.reduce((s,w)=>s+w.reviewerCount,0),knownDefectsFound:expectedBugIds.filter(x=>ids.has(x)),missingKnownDefects:expectedBugIds.filter(x=>!ids.has(x)),finalValidatedDefects:ws.filter(w=>w.wave==='final').flatMap(w=>w.validatedBugIds),unsupportedFindings:ws.reduce((s,w)=>s+w.unsupportedFindings,0)};};
const identityDigests=new Set(waves.flatMap(w=>w.reviews.map(r=>r.identityDigest)));assert.equal(identityDigests.size,1);
const result={scope:'One finite ten-function pure-helper calibration; eight known defects and two clean controls; not actual Story delivery or universal recall proof',RED:arm('RED'),GREEN:arm('GREEN'),identityParticipants:roster.participants,identityRoster:roster,methodology:"Exploratory retained fixture; original scoring oracle was authored after 19/20 outputs. V2 only fixes actual owner/roster validation. Does not change findings or establish preregistration.",identityDigests:[...identityDigests],summaries,details};
result.passed=result.RED.missingKnownDefects.length===0&&result.GREEN.missingKnownDefects.length===0&&result.RED.finalValidatedDefects.length===0&&result.GREEN.finalValidatedDefects.length===0&&result.RED.unsupportedFindings===0&&result.GREEN.unsupportedFindings===0;
writeFileSync(join(root,'scored-results-v2.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...result,details:undefined,summaries:undefined},null,2));assert.ok(result.passed,'Review calibration failed finite fixture correctness criteria');
