import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync, spawnSync} from 'node:child_process';
const repo=fileURLToPath(new URL('../',import.meta.url));
const verifier=fileURLToPath(new URL('./verify-benchmark-map-recovery.mjs',import.meta.url));
const baseline=JSON.parse(execFileSync('git',['show','e0678f649bbc0b1f6ec61dc0546127ad511ab273:proof-or-stop.config.json'],{cwd:repo,encoding:'utf8',timeout:10000,maxBuffer:1024*1024}));
const paths=['docs/requirements/decisions/benchmark-execution-plan.md','docs/benchmark/implementation-preconditions.md','docs/benchmark/claude-followup-audit.md','docs/benchmark/m0-feasibility.md','scripts/benchmark/feasibility.mjs','scripts/verify-benchmark-feasibility.mjs'];
const candidate=structuredClone(baseline);
candidate.storyScopeBudget.responsibilities.push({id:'benchmark-feasibility',paths,hostAdapters:[],validationGroups:[]});
const env={...process.env,GIT_DIR:execFileSync('git',['rev-parse','--absolute-git-dir'],{cwd:repo,encoding:'utf8',timeout:10000,maxBuffer:1024*1024}).trim()};
const root=mkdtempSync(join(tmpdir(),'benchmark-map-regression-'));
try {
  symlinkSync(join(repo,'packages'),join(root,'packages'),'dir');
  const run=(config,entrypoint=verifier)=>{writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify(config));return spawnSync(process.execPath,[entrypoint],{cwd:root,env,encoding:'utf8',timeout:180000,maxBuffer:2*1024*1024});};
  const completed=result=>{assert.notEqual(result.error?.code,'ETIMEDOUT','BENCHMARK_MAP_OUTER_TIMEOUT: verifier exceeded 180 seconds');assert.ifError(result.error);assert.equal(result.signal,null,'BENCHMARK_MAP_OUTER_SIGNAL');};
  const good=run(candidate);completed(good);assert.equal(good.status,0,good.stderr);
  const rows=good.stdout.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  const source=rows.find(row=>row.kind==='executed-source');
  assert.equal(source?.pinnedProgramSha256,'c07e1b8606e05a956b0fb7a61cfdbcab601fe38e73a58dfd7dbf8bcd5241aa93','BENCHMARK_MAP_PROGRAM_DRIFT');
  assert.equal(createHash('sha256').update(source.pinnedProgram).digest('hex'),source.pinnedProgramSha256);
  const driftFile=join(root,'drift-verifier.mjs');
  const verifierSource=readFileSync(verifier,'utf8');
  const changedSource=verifierSource.replace('assert.deepEqual(rows,','assert.notDeepEqual(rows,');
  assert.notEqual(changedSource,verifierSource);
  writeFileSync(driftFile,changedSource);
  const drift=run(candidate,driftFile);completed(drift);
  assert.equal(drift.status,1);assert.match(drift.stderr,/BENCHMARK_MAP_PROGRAM_DRIFT/);
  assert.doesNotMatch(drift.stdout,/BENCHMARK_MAP_SUPPLEMENT_PASS/);
  const reports=rows.filter(row=>row.kind==='observed-evaluator-report');
  assert.equal(reports.length,5,'BENCHMARK_MAP_COVERAGE_MISSING: retain all five actual evaluator reports');
  assert.deepEqual(reports.map(row=>[row.id,row.report.blocking]),[['candidate',false],['baseline',true],['unregistered',true],['malformed',true],['missing-topology',true]]);
  assert.deepEqual(reports[0].report.facts.responsibilityDomains,['benchmark-feasibility']);
  assert.ok(reports[4].report.diagnostics.some(d=>d.includes('missing acceptance topology')));
  const mutations=rows.filter(row=>row.rejected===true);
  assert.deepEqual(mutations.map(row=>row.id),['wildcard','duplicate','extra-path','adapter','group']);
  for(const row of mutations){assert.equal(row.rejectionExit,1);assert.match(row.rejectionStderr,/AssertionError/);assert.equal(row.restoredExit,0);assert.match(row.restoredOutput,/BENCHMARK_MAP_PASS/);}
  assert.match(good.stdout,/BENCHMARK_MAP_SUPPLEMENT_PASS/);
  const badCases=[
    ['BENCHMARK_MAP_INVALID_CONFIG',c=>{delete c.storyScopeBudget.responsibilities;}],
    ['BENCHMARK_MAP_INVALID_CONFIG',c=>c.storyScopeBudget=null],
    ['BENCHMARK_MAP_INVALID_CONFIG',c=>c.storyScopeBudget.responsibilities='invalid'],
    ['BENCHMARK_MAP_BASELINE_DRIFT',c=>c.storyScopeBudget.mode='observe'],
    ['BENCHMARK_MAP_BASELINE_DRIFT',c=>c.storyScopeBudget.limits.acceptanceTopology++],
    ['BENCHMARK_MAP_ROWS_MISMATCH',c=>c.storyScopeBudget.responsibilities.at(-1).paths.push('extra.mjs')],
    ['BENCHMARK_MAP_ROWS_MISMATCH',c=>c.storyScopeBudget.responsibilities.at(-1).paths[0]='docs/**'],
    ['BENCHMARK_MAP_ROWS_MISMATCH',c=>c.storyScopeBudget.responsibilities.at(-1).paths.push(paths[0])],
    ['BENCHMARK_MAP_ROWS_MISMATCH',c=>c.storyScopeBudget.responsibilities.at(-1).hostAdapters.push('codex')],
    ['BENCHMARK_MAP_ROWS_MISMATCH',c=>c.storyScopeBudget.responsibilities.at(-1).validationGroups.push('extra')],
    ['BENCHMARK_MAP_ROW_MISSING',c=>c.storyScopeBudget.responsibilities.pop()],
    ['BENCHMARK_MAP_BASELINE_DRIFT',c=>c.unrelatedNewPolicy=true],
  ];
  for(const [code,mutate] of badCases){
    const config=structuredClone(candidate);mutate(config);const bad=run(config);completed(bad);
    assert.equal(bad.status,1,bad.stderr);assert.match(bad.stderr,new RegExp(code));
    assert.doesNotMatch(bad.stdout,/BENCHMARK_MAP_SUPPLEMENT_PASS/);
  }
  console.log('BENCHMARK_MAP_RECOVERY_REGRESSION_PASS');
} finally {rmSync(root,{recursive:true,force:true});}
