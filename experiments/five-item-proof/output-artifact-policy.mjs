import assert from 'node:assert/strict';
import {isVolatileRuntimeArtifactPath,isRepairableTrackedRuntimeArtifactPath,isMaterialExcludedRuntimeArtifactPath} from '../../packages/main/dist/core/runtime-artifact-registry.js';
for(const prefix of ['.proof-or-stop/story/actives/B-lab','.lattice/story/actives/B-lab','docs/story/actives/B-lab']){
 const path=prefix+'/causal-evidence/outputs/'+'a'.repeat(64)+'.json';
 assert.equal(isVolatileRuntimeArtifactPath(path),false,'Load-bearing output must not be classified disposable');
 assert.equal(isRepairableTrackedRuntimeArtifactPath(path),false,'Evidence must not be offered for runtime cleanup');
 assert.equal(isMaterialExcludedRuntimeArtifactPath(path),true,'Publishing output must not change source identity');
}
console.log('SELECTOR_EVIDENCE_RETENTION_POLICY_GREEN');
