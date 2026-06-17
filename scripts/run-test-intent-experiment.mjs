#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = process.cwd();
const cli = join(root, 'bin', 'lattice.js');
const candidateDir = join(root, 'experiments', 'candidates', 'test-intent');
const reportDir = join(root, 'experiments', 'reports');
const resultPath = join(reportDir, 'test-intent-structured-v1.json');
const reportPath = join(reportDir, 'test-intent-structured-v1.md');

function ensureDir(path) { mkdirSync(path, { recursive: true }); }
function run(command, args, cwd = root) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}
function createProject(baseline) {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-test-intent-exp-'));
  ensureDir(join(dir, 'docs', 'story', 'actives'));
  ensureDir(join(dir, 'docs', 'requirements'));
  ensureDir(join(dir, 'samples'));
  writeFileSync(join(dir, 'lattice.config.json'), JSON.stringify({ scanRoot:'packages/main', rootDir:'src', outDir:'packages/main/dist', testsDir:'packages/main/tests', fixturesDir:'packages/main/tests/fixtures', storyDir:'docs/story/actives', requirementsDir:'docs/requirements', storyPrefix:'B' }, null, 2));
  writeFileSync(join(dir, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(dir, 'README.md'), '# testIntent experiment\n');
  writeFileSync(join(dir, 'samples', 'test-intent.json'), baseline);
  run('git', ['init', '-b', 'main'], dir);
  run('git', ['config', 'user.name', 'Lattice Lab'], dir);
  run('git', ['config', 'user.email', 'lattice-lab@example.com'], dir);
  run('git', ['add', '.'], dir);
  run('git', ['commit', '-m', 'baseline'], dir);
  run('node', [cli, '--root', dir, 'lab', 'create', JSON.stringify({ id:'lab-test-intent-structured-v1', target:'test-intent-sample', profile:'test-intent-quality-v1', editableFiles:['samples/test-intent.json'] })]);
  return dir;
}
function score(baseline, candidate) {
  const dir = createProject(baseline);
  try {
    writeFileSync(join(dir, 'samples', 'test-intent.json'), candidate.text);
    run('node', [cli, '--root', dir, 'lab', 'run', '--config', 'experiments/configs/lab-test-intent-structured-v1.json', '--confirm']);
    const result = JSON.parse(readFileSync(join(dir, 'experiments/runs/lab-test-intent-structured-v1/run-001/result.json'), 'utf8'));
    const metrics = JSON.parse(readFileSync(join(dir, 'experiments/runs/lab-test-intent-structured-v1/run-001/metrics.json'), 'utf8'));
    const baselineRecord = JSON.parse(readFileSync(join(dir, 'experiments/baselines/lab-test-intent-structured-v1.json'), 'utf8'));
    return { id:candidate.id, title:candidate.title, score:result.score, normalizedScore:result.normalizedScore, delta:result.delta, normalizedDelta:result.normalizedDelta, status:result.status, lineCount:candidate.text.split('\n').length, lengthDelta:candidate.text.length - baseline.length, contentSummary:result.contentSummary || metrics.contentSummary || [], submetrics:metrics.submetrics, baselineScore:baselineRecord.score, baselineNormalizedScore:baselineRecord.normalizedScore };
  } finally { rmSync(dir, { recursive:true, force:true }); }
}
const baseline = JSON.stringify({
  happy: [{ desc: '正常创建实验 → 成功' }],
  edge: [{ desc: '空输入 → 报错' }],
  adversarial: [{ desc: '异常情况 → 报错' }]
}, null, 2);
const candidates = [
  ['t01-current','Current Baseline', baseline, true],
  ['t02-operation-result','Operation Result', JSON.stringify({ happy:[{desc:'运行 lattice lab create --target=test-case-reviewer --profile=reviewer-quality-v1 → 写入 config 并返回 Next step', type:'cli_blackbox'}], edge:[{desc:'缺少 profile 参数 → 抛出参数校验错误并不写 config', type:'cli_blackbox'}], adversarial:[{desc:'传入未知 target → 抛出 unknown target 错误并保留现有 experiments 目录', type:'cli_blackbox'}] }, null, 2)],
  ['t03-fixture-mappable','Fixture Mappable', JSON.stringify({ happy:[{desc:'input={target:\"test-case-reviewer\",profile:\"reviewer-quality-v1\"} → expect.configPath 存在且 result includes Created experiment', type:'cli_blackbox', input:{target:'test-case-reviewer',profile:'reviewer-quality-v1'}, expect:{created:true, configExists:true}}], edge:[{desc:'input={target:\"test-case-reviewer\"} → expect throws profile required', type:'cli_blackbox', input:{target:'test-case-reviewer'}, expect:{throws:'profile'}}], adversarial:[{desc:'input={target:\"../docs/story\"} → expect throws unknown target / path rejected', type:'cli_blackbox', input:{target:'../docs/story'}, expect:{throws:'unknown target'}}] }, null, 2)],
  ['t04-trigger-condition-result','Trigger Condition Result', JSON.stringify({ happy:[{trigger:'用户运行 lab create', condition:'target/profile 合法', result:'config 写入 experiments/configs 并输出 Next step', type:'cli_blackbox'}], edge:[{trigger:'用户运行 lab create', condition:'profile 缺失', result:'参数校验失败且不写文件', type:'cli_blackbox'}], adversarial:[{trigger:'用户运行 lab create', condition:'target 越权或未知', result:'拒绝并提示 unknown target', type:'cli_blackbox'}] }, null, 2)],
  ['t05-adversarial-first','Adversarial First', JSON.stringify({ adversarial:[{desc:'并发重复运行 lab create 同一个 id → 不破坏已存在 config，输出明确覆盖/已存在行为', type:'cli_blackbox', input:{id:'same'}, expect:{noCorruption:true}}], happy:[{desc:'正常运行 lab create → config 写入且输出 Created experiment', type:'cli_blackbox', input:{target:'test-case-reviewer',profile:'reviewer-quality-v1'}, expect:{created:true}}], edge:[{desc:'profile 为空字符串 → 参数校验失败', type:'cli_blackbox', input:{profile:''}, expect:{throws:'profile'}}] }, null, 2)],
  ['t06-compact-json','Compact JSON', '{"happy":[{"desc":"run create → expect config exists","type":"cli_blackbox","input":{"target":"x"},"expect":{"exists":true}}],"edge":[{"desc":"missing profile → expect validation error","type":"cli_blackbox","expect":{"throws":"profile"}}],"adversarial":[{"desc":"malicious path target → expect rejected","type":"cli_blackbox","expect":{"throws":"unknown target"}}]}'],
  ['t07-reviewer-friendly','Reviewer Friendly', JSON.stringify({ happy:[{desc:'调用 lab_create({target,profile}) → 返回 Created experiment；WHY: 覆盖主路径和可观察输出', type:'cli_blackbox', input:{target:'test-case-reviewer',profile:'reviewer-quality-v1'}, expect:{pattern:'Created experiment'}}], edge:[{desc:'调用 lab_create({target}) → 参数校验失败；WHY: 覆盖缺少必填字段', type:'cli_blackbox', input:{target:'test-case-reviewer'}, expect:{throws:'profile'}}], adversarial:[{desc:'调用 lab_create({target:\"../../docs/story\"}) → 拒绝未知/越权 target；WHY: 覆盖恶意路径输入', type:'cli_blackbox', input:{target:'../../docs/story'}, expect:{throws:'unknown target'}}] }, null, 2)],
  ['t08-duplicate-noise','Duplicate Noise', JSON.stringify({ happy:[{desc:'运行 lab create → 成功', type:'cli_blackbox'}], edge:[{desc:'运行 lab create → 成功', type:'cli_blackbox'}], adversarial:[{desc:'运行 lab create → 成功', type:'cli_blackbox'}] }, null, 2)],
  ['t09-missing-adversarial','Missing Adversarial', JSON.stringify({ happy:[{desc:'运行 lab create → 成功', type:'cli_blackbox'}], edge:[{desc:'缺少 profile → 报错', type:'cli_blackbox'}] }, null, 2)],
  ['t10-no-types','No Types', JSON.stringify({ happy:[{desc:'运行 lab create → 成功'}], edge:[{desc:'缺少 profile → 报错'}], adversarial:[{desc:'恶意 target → 拒绝'}] }, null, 2)]
].map(([id,title,text,raw]) => ({ id, title, text: raw ? text : text }));
function report(results) {
  const sorted = [...results].sort((a,b)=>(b.normalizedScore??0)-(a.normalizedScore??0));
  const base = results.find(r=>r.id==='t01-current') || results[0];
  const top = sorted.slice(0,3);
  const lines = ['# testIntent structured experiment v1','',`Baseline normalizedScore: ${base.normalizedScore}`,`Best candidate: ${top[0].id} ${top[0].title}`,`Best normalizedScore: ${top[0].normalizedScore} (${fmt((top[0].normalizedScore??0)-(base.normalizedScore??0))})`,'','## Top 3','','| rank | candidate | normalizedScore | score | lines | lengthDelta | status |','|---:|---|---:|---:|---:|---:|---|'];
  top.forEach((r,i)=>lines.push(`| ${i+1} | ${r.id} ${r.title} | ${r.normalizedScore} | ${r.score} | ${r.lineCount} | ${r.lengthDelta} | ${r.status} |`));
  lines.push('','## All candidates','','| candidate | normalizedScore | laneCompleteness | typeCoverage | fixtureMapping | adversarial | duplicate | notable contentSummary |','|---|---:|---:|---:|---:|---:|---:|---|');
  for (const r of sorted) lines.push(`| ${r.id} ${r.title} | ${r.normalizedScore} | ${r.submetrics.laneCompleteness} | ${r.submetrics.typeCoverage} | ${r.submetrics.fixtureMappingCoverage} | ${r.submetrics.adversarialStrength} | ${r.submetrics.antiDuplicate} | ${(r.contentSummary||[]).filter(x=>x.startsWith('missing')||x.startsWith('weak')||x.includes('duplicate')).join('; ') || '(all key signals present)'} |`);
  lines.push('','## Recommendation','',`Recommended prompt direction: **${top[0].id} ${top[0].title}**.`,'','Prefer formats with explicit input/expect fields when writing fixture-heavy stories; avoid duplicate happy/edge/adversarial descriptions.');
  return lines.join('\n');
}
function fmt(v){const n=Number(v.toFixed(4)); return n>=0?`+${n}`:`${n}`;}
ensureDir(candidateDir); ensureDir(reportDir);
writeFileSync(join(candidateDir,'00-baseline-current.json'), baseline);
for (const c of candidates) writeFileSync(join(candidateDir,`${c.id}.json`), c.text);
const results = candidates.map(c=>score(baseline,c));
writeFileSync(resultPath, JSON.stringify({generatedAt:new Date().toISOString(), results}, null, 2));
writeFileSync(reportPath, report(results));
const sorted = [...results].sort((a,b)=>(b.normalizedScore??0)-(a.normalizedScore??0));
console.log(`Baseline normalizedScore: ${results.find(r=>r.id==='t01-current')?.normalizedScore}`);
console.log(`Best candidate: ${sorted[0].id} normalizedScore: ${sorted[0].normalizedScore}`);
console.log(`Report: ${reportPath}`);
