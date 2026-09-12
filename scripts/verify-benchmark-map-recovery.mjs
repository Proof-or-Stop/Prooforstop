// Historical B-0980 verifier, retained initially to reproduce its coverage defect.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {evaluateStoryScopeBudget} from '../packages/main/dist/core/story-scope-budget.js';
const baseline=JSON.parse(execFileSync('git',['show','e0678f649bbc0b1f6ec61dc0546127ad511ab273:proof-or-stop.config.json'],{encoding:'utf8'}));
const candidate=JSON.parse(readFileSync('proof-or-stop.config.json','utf8'));
const paths=['docs/requirements/decisions/benchmark-execution-plan.md','docs/benchmark/implementation-preconditions.md','docs/benchmark/claude-followup-audit.md','docs/benchmark/m0-feasibility.md','scripts/benchmark/feasibility.mjs','scripts/verify-benchmark-feasibility.mjs'];
const rows=candidate.storyScopeBudget.responsibilities.filter(r=>r.id==='benchmark-feasibility');
assert.deepEqual(rows,[{id:'benchmark-feasibility',paths,hostAdapters:[],validationGroups:[]}]);
const restored=structuredClone(candidate);restored.storyScopeBudget.responsibilities=restored.storyScopeBudget.responsibilities.filter(r=>r.id!=='benchmark-feasibility');assert.deepEqual(restored,baseline);
const subject=p=>({storyId:'B-map-witness',scope:{storyId:'B-map-witness',allowedModify:[],allowedCreate:p,allowedTest:[]},checklist:{items:[]},proofStory:{storyId:'B-map-witness',acceptanceBindings:[]}});
const green=evaluateStoryScopeBudget(subject(paths),candidate);assert.equal(green.blocking,false);assert.deepEqual(green.facts.responsibilityDomains,['benchmark-feasibility']);
assert.equal(evaluateStoryScopeBudget(subject(paths),baseline).blocking,true);
assert.equal(evaluateStoryScopeBudget(subject([...paths,'scripts/benchmark/unregistered.mjs']),candidate).blocking,true);
const malformed=structuredClone(candidate);malformed.storyScopeBudget.responsibilities.find(r=>r.id==='benchmark-feasibility').paths.push('../escape');assert.equal(evaluateStoryScopeBudget(subject(paths),malformed).blocking,true);
const unrelated=subject(paths);unrelated.proofStory.acceptanceBindings=[{id:'missing-topology',checklistRefs:[],verificationIntentRefs:[]}];const rejected=evaluateStoryScopeBudget(unrelated,candidate);assert.equal(rejected.blocking,true);assert.ok(rejected.diagnostics.some(d=>d.includes('missing acceptance topology')));
console.log('BENCHMARK_MAP_PASS: exact six paths; otherwise identical policy; positive admission and negative controls verified');
