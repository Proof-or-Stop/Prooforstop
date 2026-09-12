/**
 * Diagnostic repair for the historical B-0980 mapping verifier.
 * Run from its candidate checkout after building packages/main. The candidate
 * must equal the pinned e0678f6 configuration plus exactly the six approved paths.
 * The historical commit must be available locally (no network fetch is performed).
 * Disposable configurations exercise the exact old program without altering its
 * Story pin. JSONL retains observations, not signed Story evidence or DONE status.
 * Regression: node scripts/verify-benchmark-map-recovery-contract.mjs
 */
import assert from 'node:assert/strict';
import{mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync}from'node:fs';
import{tmpdir}from'node:os';import{join}from'node:path';import{execFileSync,spawnSync}from'node:child_process';import{createHash}from'node:crypto';
const repo=process.cwd();
const {evaluateStoryScopeBudget}=await import(repo+'/packages/main/dist/core/story-scope-budget.js');
const program="import assert from 'node:assert/strict';\nimport {readFileSync} from 'node:fs';\nimport {execFileSync} from 'node:child_process';\nimport {evaluateStoryScopeBudget} from './packages/main/dist/core/story-scope-budget.js';\nconst baseline=JSON.parse(execFileSync('git',['show','e0678f649bbc0b1f6ec61dc0546127ad511ab273:proof-or-stop.config.json'],{encoding:'utf8'}));\nconst candidate=JSON.parse(readFileSync('proof-or-stop.config.json','utf8'));\nconst paths=['docs/requirements/decisions/benchmark-execution-plan.md','docs/benchmark/implementation-preconditions.md','docs/benchmark/claude-followup-audit.md','docs/benchmark/m0-feasibility.md','scripts/benchmark/feasibility.mjs','scripts/verify-benchmark-feasibility.mjs'];\nconst rows=candidate.storyScopeBudget.responsibilities.filter(r=>r.id==='benchmark-feasibility');\nassert.deepEqual(rows,[{id:'benchmark-feasibility',paths,hostAdapters:[],validationGroups:[]}]);\nconst restored=structuredClone(candidate);restored.storyScopeBudget.responsibilities=restored.storyScopeBudget.responsibilities.filter(r=>r.id!=='benchmark-feasibility');assert.deepEqual(restored,baseline);\nconst subject=p=>({storyId:'B-map-witness',scope:{storyId:'B-map-witness',allowedModify:[],allowedCreate:p,allowedTest:[]},checklist:{items:[]},proofStory:{storyId:'B-map-witness',acceptanceBindings:[]}});\nconst green=evaluateStoryScopeBudget(subject(paths),candidate);assert.equal(green.blocking,false);assert.deepEqual(green.facts.responsibilityDomains,['benchmark-feasibility']);\nassert.equal(evaluateStoryScopeBudget(subject(paths),baseline).blocking,true);\nassert.equal(evaluateStoryScopeBudget(subject([...paths,'scripts/benchmark/unregistered.mjs']),candidate).blocking,true);\nconst malformed=structuredClone(candidate);malformed.storyScopeBudget.responsibilities.find(r=>r.id==='benchmark-feasibility').paths.push('../escape');assert.equal(evaluateStoryScopeBudget(subject(paths),malformed).blocking,true);\nconst unrelated=subject(paths);unrelated.proofStory.acceptanceBindings=[{id:'missing-topology',checklistRefs:[],verificationIntentRefs:[]}];const rejected=evaluateStoryScopeBudget(unrelated,candidate);assert.equal(rejected.blocking,true);assert.ok(rejected.diagnostics.some(d=>d.includes('missing acceptance topology')));\nconsole.log('BENCHMARK_MAP_PASS: exact six paths; otherwise identical policy; positive admission and negative controls verified');\n";
const programSha256=createHash('sha256').update(program).digest('hex');
assert.equal(programSha256,'c07e1b8606e05a956b0fb7a61cfdbcab601fe38e73a58dfd7dbf8bcd5241aa93','BENCHMARK_MAP_PROGRAM_DRIFT');
const original=JSON.parse(readFileSync(join(repo,'proof-or-stop.config.json'),'utf8'));
const git = (...argv) => execFileSync('git',argv,{cwd:repo,encoding:'utf8',timeout:10000,maxBuffer:1024*1024}).trim();
const baseline=JSON.parse(git('show','e0678f649bbc0b1f6ec61dc0546127ad511ab273:proof-or-stop.config.json'));
const paths=['docs/requirements/decisions/benchmark-execution-plan.md','docs/benchmark/implementation-preconditions.md','docs/benchmark/claude-followup-audit.md','docs/benchmark/m0-feasibility.md','scripts/benchmark/feasibility.mjs','scripts/verify-benchmark-feasibility.mjs'];
assert.ok(Array.isArray(original?.storyScopeBudget?.responsibilities),'BENCHMARK_MAP_INVALID_CONFIG');
const rows=original.storyScopeBudget.responsibilities.filter(row=>row?.id==='benchmark-feasibility');
assert.ok(rows.length,'BENCHMARK_MAP_ROW_MISSING: run from the B-0980 candidate checkout');
assert.deepEqual(rows,[{id:'benchmark-feasibility',paths,hostAdapters:[],validationGroups:[]}],'BENCHMARK_MAP_ROWS_MISMATCH');
const restored=structuredClone(original);
restored.storyScopeBudget.responsibilities=restored.storyScopeBudget.responsibilities.filter(row=>row?.id!=='benchmark-feasibility');
assert.deepEqual(restored,baseline,'BENCHMARK_MAP_BASELINE_DRIFT');
console.log(JSON.stringify({kind:'executed-source',pinnedProgram:program,pinnedProgramSha256:programSha256}));
const gitDir=git('rev-parse','--absolute-git-dir');
const head=git('rev-parse','HEAD');
const root=mkdtempSync(join(tmpdir(),'benchmark-map-mutations-'));
try {
  symlinkSync(join(repo,'packages'),join(root,'packages'),'dir');
  const run=config=>{
    writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify(config));
    const result=spawnSync(process.execPath,['--input-type=module','-e',program],{
      cwd:root,env:{...process.env,GIT_DIR:gitDir},encoding:'utf8',timeout:10000,maxBuffer:1024*1024,
    });
    assert.ifError(result.error);
    assert.equal(result.signal,null,'BENCHMARK_MAP_CHILD_SIGNAL');
    return result;
  };
  const subject=p=>({storyId:'B-map-witness',scope:{storyId:'B-map-witness',allowedModify:[],allowedCreate:p,allowedTest:[]},checklist:{items:[]},proofStory:{storyId:'B-map-witness',acceptanceBindings:[]}});
  const casesForReport=[['candidate',subject(paths),original,false],['baseline',subject(paths),baseline,true],['unregistered',subject([...paths,'scripts/benchmark/unregistered.mjs']),original,true]];
  const malformed=structuredClone(original);
  malformed.storyScopeBudget.responsibilities.find(row=>row.id==='benchmark-feasibility').paths.push('../escape');
  casesForReport.push(['malformed',subject(paths),malformed,true]);
  const unrelated=subject(paths);
  unrelated.proofStory.acceptanceBindings=[{id:'missing-topology',checklistRefs:[],verificationIntentRefs:[]}];
  casesForReport.push(['missing-topology',unrelated,original,true]);
  for(const [id,input,config,blocking] of casesForReport){
    const report=evaluateStoryScopeBudget(input,config);
    assert.equal(report.blocking,blocking,`BENCHMARK_MAP_BLOCKING_MISMATCH: ${id}`);
    console.log(JSON.stringify({kind:'observed-evaluator-report',id,report}));
  }
  const initial=run(original);
  assert.equal(initial.status,0,initial.stderr);
  assert.match(initial.stdout,/BENCHMARK_MAP_PASS/);
  const cases=[['wildcard',r=>r.paths[0]='docs/benchmark/**'],['duplicate',r=>r.paths.push(r.paths[0])],['extra-path',r=>r.paths.push('scripts/benchmark/extra.mjs')],['adapter',r=>r.hostAdapters.push('codex')],['group',r=>r.validationGroups.push('unexpected')]];
  for(const [id,mutate] of cases){
    const config=structuredClone(original);
    mutate(config.storyScopeBudget.responsibilities.find(row=>row.id==='benchmark-feasibility'));
    const bad=run(config);
    assert.equal(bad.status,1,id);
    assert.match(bad.stderr,/AssertionError/,id+' must fail its exact assertion');
    const control=run(original);
    assert.equal(control.status,0,control.stderr);
    assert.match(control.stdout,/BENCHMARK_MAP_PASS/);
    console.log(JSON.stringify({id,rejected:true,rejectionExit:bad.status,rejectionStdout:bad.stdout,rejectionStderr:bad.stderr,restored:true,restoredExit:control.status,restoredOutput:control.stdout}));
  }
  console.log(JSON.stringify({kind:'supplementary-executed-mutation-observations',authority:'diagnostic observations; not signed Story evidence',programSha256,head,result:'PASS'}));
  console.log('BENCHMARK_MAP_SUPPLEMENT_PASS');
} finally {rmSync(root,{recursive:true,force:true});}
