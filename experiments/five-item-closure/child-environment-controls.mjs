import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {VALIDATION_CHILD_ENVIRONMENT_KEYS as keys,validationChildEnvironment} from '../../packages/main/src/tasks/validation-child-environment.mjs';
import {isMaterialExcludedRuntimeArtifactPath} from '../../packages/main/dist/core/runtime-artifact-registry.js';

const config=JSON.parse(readFileSync(new URL('../../proof-or-stop.config.json',import.meta.url)));
const issues=[], negatives=[];
const retiredPrefix='LATTICE_';
const canonicalPrefix='PROOF_OR_STOP_';
const retired=keys.filter(key=>key.startsWith(retiredPrefix));
if(retired.length)issues.push({type:'retired_child_admission',keys:retired});
if(!keys.includes('PROOF_OR_STOP_VALIDATE_CPU'))issues.push({type:'canonical_cpu_input_missing'});
for(const label of ['quorum-submit-smoke','review-pass-discard-smoke']){
 const row=config.validate.commands.find(row=>row.label===label||row.args?.includes('packages/main/dist/tasks/'+label+'.js'));
 if(JSON.stringify(row?.declaredEnvironmentKeys)!==JSON.stringify(keys))issues.push({type:'config_environment_closure_mismatch',label});
}
const reads=[];
validationChildEnvironment({},new Proxy({}, {get(_target,key){reads.push(key);return 'bounded-probe';},ownKeys(){throw Error('ambient enumeration is forbidden');}}));
if(reads.some(key=>key.startsWith(retiredPrefix)))issues.push({type:'ambient_retired_key_read'});
for(const key of keys.filter(key=>key.startsWith(canonicalPrefix))){
 const old=retiredPrefix+key.slice(canonicalPrefix.length);
 try{validationChildEnvironment({[old]:'untrusted'},{});issues.push({type:'retired_override_accepted',key:old});}
 catch{negatives.push(old);}
}
try{const cpu=validationChildEnvironment({PROOF_OR_STOP_VALIDATE_CPU:'2'},{});assert.equal(cpu.PROOF_OR_STOP_VALIDATE_CPU,'2');}
catch{issues.push({type:'canonical_cpu_override_refused'});}
for(const rel of ['packages/main/src/tasks/quorum-submit-smoke-worker.ts','packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts']){
 const body=readFileSync(new URL('../../'+rel,import.meta.url),'utf8');
 if(body.includes(retiredPrefix+'VALIDATION_SHARD_ADAPTER'))issues.push({type:'retired_adapter_forwarding',path:rel});
}
const oldOutput='.lattice/story/actives/B-test/causal-evidence/outputs/abc.json';
if(isMaterialExcludedRuntimeArtifactPath(oldOutput))issues.push({type:'retired_output_material_admission'});
console.log(JSON.stringify({issues,negativeOverrides:negatives.length,finiteAmbientReads:reads.length}));
assert.deepEqual(issues,[],'CURRENT_CHILD_ENVIRONMENT_BOUNDARY_INVALID');
console.log('CURRENT_CHILD_ENVIRONMENT_CONTROLS_GREEN');
