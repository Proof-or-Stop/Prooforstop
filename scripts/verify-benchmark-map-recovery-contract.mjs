import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync, spawnSync} from 'node:child_process';
const repo=fileURLToPath(new URL('../',import.meta.url));
const verifier=fileURLToPath(new URL('./verify-benchmark-map-recovery.mjs',import.meta.url));
const root=mkdtempSync(join(tmpdir(),'benchmark-map-regression-'));
const baseline=JSON.parse(execFileSync('git',['show','e0678f649bbc0b1f6ec61dc0546127ad511ab273:proof-or-stop.config.json'],{cwd:repo,encoding:'utf8'}));
const paths=['docs/requirements/decisions/benchmark-execution-plan.md','docs/benchmark/implementation-preconditions.md','docs/benchmark/claude-followup-audit.md','docs/benchmark/m0-feasibility.md','scripts/benchmark/feasibility.mjs','scripts/verify-benchmark-feasibility.mjs'];
const candidate=structuredClone(baseline);
candidate.storyScopeBudget.responsibilities.push({id:'benchmark-feasibility',paths,hostAdapters:[],validationGroups:[]});
const env={...process.env,GIT_DIR:execFileSync('git',['rev-parse','--absolute-git-dir'],{cwd:repo,encoding:'utf8'}).trim()};
try {
  symlinkSync(join(repo,'packages'),join(root,'packages'),'dir');
  const run=config=>{writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify(config));return spawnSync(process.execPath,[verifier],{cwd:root,env,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});};
  const good=run(candidate);assert.equal(good.status,0,good.stderr);
  const rows=good.stdout.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  const reports=rows.filter(row=>row.kind==='observed-evaluator-report');
  assert.equal(reports.length,5,'BENCHMARK_MAP_COVERAGE_MISSING: retain all five actual evaluator reports');
  assert.deepEqual(reports.map(row=>[row.id,row.report.blocking]),[['candidate',false],['baseline',true],['unregistered',true],['malformed',true],['missing-topology',true]]);
  assert.deepEqual(reports[0].report.facts.responsibilityDomains,['benchmark-feasibility']);
  assert.ok(reports[4].report.diagnostics.some(d=>d.includes('missing acceptance topology')));
  const mutations=rows.filter(row=>row.rejected===true);
  assert.deepEqual(mutations.map(row=>row.id),['wildcard','duplicate','extra-path','adapter','group']);
  for(const row of mutations){assert.equal(row.rejectionExit,1);assert.match(row.rejectionStderr,/AssertionError/);assert.equal(row.restoredExit,0);assert.match(row.restoredOutput,/BENCHMARK_MAP_PASS/);}
  assert.match(good.stdout,/BENCHMARK_MAP_SUPPLEMENT_PASS/);
  const badCases=[c=>c.storyScopeBudget.mode='observe',c=>c.storyScopeBudget.limits.acceptanceTopology++,c=>c.storyScopeBudget.responsibilities.at(-1).paths.push('extra.mjs'),c=>c.storyScopeBudget.responsibilities.at(-1).paths[0]='docs/**',c=>c.storyScopeBudget.responsibilities.at(-1).paths.push(paths[0]),c=>c.storyScopeBudget.responsibilities.at(-1).hostAdapters.push('codex'),c=>c.storyScopeBudget.responsibilities.at(-1).validationGroups.push('extra'),c=>c.storyScopeBudget.responsibilities.pop(),c=>c.unrelatedNewPolicy=true];
  for(const mutate of badCases){const config=structuredClone(candidate);mutate(config);const bad=run(config);assert.equal(bad.status,1,bad.stderr);assert.doesNotMatch(bad.stdout,/BENCHMARK_MAP_SUPPLEMENT_PASS/);}
  console.log('BENCHMARK_MAP_RECOVERY_REGRESSION_PASS');
} finally {rmSync(root,{recursive:true,force:true});}
