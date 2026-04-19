#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = process.cwd();
const cli = join(root, 'bin', 'koala.js');
const koala = join(root, 'bin', 'koala-codex.js');
const candidateDir = join(root, 'experiments', 'candidates', 'story-review');
const reportDir = join(root, 'experiments', 'reports');
const resultPath = join(reportDir, 'story-review-structured-v1.json');
const reportPath = join(reportDir, 'story-review-structured-v1.md');

function ensureDir(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function run(command, args, cwd = root) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function parseJson(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error(`JSON not found:\n${text}`);
  return JSON.parse(text.slice(start));
}

function createTempProject(baseline) {
  const dir = mkdtempSync(join(tmpdir(), 'koala-story-review-exp-'));
  ensureDir(join(dir, 'docs', 'story', 'actives'));
  ensureDir(join(dir, 'docs', 'requirements'));
  ensureDir(join(dir, 'samples'));
  writeFileSync(join(dir, 'koala.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  writeFileSync(join(dir, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(dir, 'README.md'), '# story review experiment\n');
  writeFileSync(join(dir, 'samples', 'story-review.txt'), baseline);
  run('git', ['init', '-b', 'main'], dir);
  run('git', ['config', 'user.name', 'Koala Lab'], dir);
  run('git', ['config', 'user.email', 'koala-lab@example.com'], dir);
  run('git', ['add', '.'], dir);
  run('git', ['commit', '-m', 'baseline'], dir);
  run('node', [cli, '--root', dir, 'lab', 'create', JSON.stringify({
    id: 'lab-story-review-structured-v1',
    target: 'story-review-sample',
    profile: 'story-review-quality-v1',
    editableFiles: ['samples/story-review.txt'],
  })]);
  return dir;
}

function sample(id, title, body, raw = false) {
  return {
    id,
    title,
    text: raw ? `${body.trim()}\n` : [`# ${id} ${title}`, '', body.trim(), ''].join('\n'),
  };
}

function buildCandidates(baseline) {
  return [
    sample('r01-current', 'Current Full Output', baseline, true),
    sample('r02-blocker-first', 'Blocker First', `
{
  "summary": { "issueCount": 4, "blockerCount": 2, "intentCoverage": { "covered": 7, "total": 9 } },
  "issues": [
    { "type": "missing_intent", "severity": "blocker", "message": "CHK-002 缺少 testIntent" },
    { "type": "missing_decision", "severity": "blocker", "message": "高风险 story 缺 decision/preMortem" },
    { "type": "risk_signals", "severity": "advisory", "message": "riskSignals 命中 gate" }
  ],
  "_hint": "先补 testIntent 和 decision，然后重新 story_review",
  "_reviewPrompt": "请审查 issueCount/blockerCount/testIntent/riskSignals/decision/preMortem"
}`),
    sample('r03-fix-command-first', 'Fix Command First', `
Fix first:
1. koala checklist_update '{"storyId":"B-x","itemId":"CHK-002","testIntent":{...}}'
2. koala decision_set '{...preMortem...}'
3. koala story_review '{"storyId":"B-x"}'

Review data:
issueCount=4
blockerCount=2
missing_intent=CHK-002
riskSignals=gate
intentCoverage=7/9
decision/preMortem missing
_hint=fix blockers
_reviewPrompt=review prompt present
`),
    sample('r04-advisory-bottom', 'Advisory Bottom', `
BLOCKERS
- missing_intent: CHK-002 缺少 testIntent
- missing_decision: high-risk story needs decision/preMortem

Coverage
- intentCoverage: 7/9
- issueCount: 4
- blockerCount: 2

Fix
- Run checklist_update, decision_set, story_review again.

Advisory
- riskSignals: gate

_reviewPrompt: present
_hint: actionable
`),
    sample('r05-risk-section', 'Risk Section', `
Summary:
issueCount=3
blockerCount=1
intentCoverage=8/9

RiskSignals:
- gate/state machine risk
- requires decision/preMortem

Blocker:
- missing_intent CHK-003

Actionable _hint:
Fix missing testIntent and rerun story_review.

_reviewPrompt:
Please inspect testIntent, riskSignals, decision, preMortem.
`),
    sample('r06-no-review-prompt', 'No ReviewPrompt', `
{
  "summary": { "issueCount": 2, "blockerCount": 1, "intentCoverage": { "covered": 8, "total": 9 } },
  "issues": [
    { "type": "missing_intent", "severity": "blocker" },
    { "type": "risk_signals", "severity": "advisory" }
  ],
  "_hint": "fix blocker and rerun story_review"
}`),
    sample('r07-coverage-table', 'Coverage Table', `
| metric | value |
|---|---|
| issueCount | 3 |
| blockerCount | 1 |
| intentCoverage | 8/9 |
| missing_intent | CHK-002 |
| riskSignals | gate |
| decision/preMortem | present |

_hint: fix CHK-002 testIntent and rerun story_review
_reviewPrompt: present
`),
    sample('r08-human-readable', 'Human Readable', `
This story is not ready for DEV.

Why:
- issueCount: 3
- blockerCount: 1
- missing_intent: CHK-002 has no testIntent
- riskSignals: gate/state-machine path
- decision/preMortem: present
- intentCoverage: 8/9

Next:
Run checklist_update for CHK-002, then story_review again.

_hint: actionable
_reviewPrompt: present
`),
    sample('r09-json-concise', 'Concise JSON', `
{"summary":{"issueCount":3,"blockerCount":1,"intentCoverage":{"covered":8,"total":9}},"issues":[{"type":"missing_intent","severity":"blocker"},{"type":"risk_signals","severity":"advisory"}],"_hint":"fix missing_intent","_reviewPrompt":"present decision preMortem riskSignals"}
`),
    sample('r10-minimal', 'Minimal', `
issueCount=1
missing_intent
fix it
`),
  ];
}

function scoreCandidate(baseline, candidate) {
  const temp = createTempProject(baseline);
  try {
    writeFileSync(join(temp, 'samples', 'story-review.txt'), candidate.text);
    run('node', [cli, '--root', temp, 'lab', 'run', '--config', 'experiments/configs/lab-story-review-structured-v1.json', '--confirm']);
    const result = JSON.parse(readFileSync(join(temp, 'experiments', 'runs', 'lab-story-review-structured-v1', 'run-001', 'result.json'), 'utf8'));
    const metrics = JSON.parse(readFileSync(join(temp, 'experiments', 'runs', 'lab-story-review-structured-v1', 'run-001', 'metrics.json'), 'utf8'));
    const baselineRecord = JSON.parse(readFileSync(join(temp, 'experiments', 'baselines', 'lab-story-review-structured-v1.json'), 'utf8'));
    return {
      id: candidate.id,
      title: candidate.title,
      score: result.score,
      normalizedScore: result.normalizedScore,
      delta: result.delta,
      normalizedDelta: result.normalizedDelta,
      status: result.status,
      lineCount: candidate.text.split('\n').length,
      lengthDelta: candidate.text.length - baseline.length,
      contentSummary: result.contentSummary || metrics.contentSummary || [],
      baselineScore: baselineRecord.score,
      baselineNormalizedScore: baselineRecord.normalizedScore,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function renderReport(baseline, results) {
  const sorted = [...results].sort((a, b) => {
    if ((b.normalizedScore ?? 0) !== (a.normalizedScore ?? 0)) return (b.normalizedScore ?? 0) - (a.normalizedScore ?? 0);
    return a.lineCount - b.lineCount;
  });
  const baselineResult = results.find((r) => r.id === 'r01-current') || results[0];
  const top = sorted.slice(0, 3);
  const best = top[0];
  const hasImprovement = (best.normalizedScore ?? 0) > (baselineResult.normalizedScore ?? 0);
  const lines = [];
  lines.push('# story_review structured experiment v1');
  lines.push('');
  lines.push(`Baseline normalizedScore: ${baselineResult.normalizedScore}`);
  lines.push(`Best candidate: ${best.id} ${best.title}`);
  lines.push(`Best normalizedScore: ${best.normalizedScore} (${formatDelta((best.normalizedScore ?? 0) - (baselineResult.normalizedScore ?? 0))})`);
  lines.push(`Recommendation: ${hasImprovement ? `consider implementing ${best.id}` : 'no production change; baseline remains best by score'}`);
  lines.push('');
  lines.push('## Top 3');
  lines.push('');
  lines.push('| rank | candidate | normalizedScore | score | lines | lengthDelta | status |');
  lines.push('|---:|---|---:|---:|---:|---:|---|');
  top.forEach((item, index) => lines.push(`| ${index + 1} | ${item.id} ${item.title} | ${item.normalizedScore} | ${item.score} | ${item.lineCount} | ${item.lengthDelta} | ${item.status} |`));
  lines.push('');
  lines.push('## All candidates');
  lines.push('');
  lines.push('| candidate | normalizedScore | score | normalizedDelta | lines | lengthDelta | notable contentSummary |');
  lines.push('|---|---:|---:|---:|---:|---:|---|');
  for (const item of sorted) {
    const summary = (item.contentSummary || []).filter((entry) => entry.startsWith('missing ') || entry === 'has blockerCount' || entry === 'has actionableHint').slice(0, 4).join('; ');
    lines.push(`| ${item.id} ${item.title} | ${item.normalizedScore} | ${item.score} | ${item.normalizedDelta} | ${item.lineCount} | ${item.lengthDelta} | ${summary || '(all key signals present)'} |`);
  }
  lines.push('');
  lines.push('## Recommendation');
  lines.push('');
  if (hasImprovement) {
    lines.push(`Recommended implementation candidate: **${best.id} ${best.title}**.`);
  } else {
    lines.push('Recommended implementation candidate: **none yet**. The current baseline remains the best-scoring output.');
  }
  lines.push('');
  lines.push('Use this report as design input, not as an automatic production change.');
  lines.push('');
  lines.push('## Baseline sample');
  lines.push('');
  lines.push('```text');
  lines.push(baseline.trim());
  lines.push('```');
  return lines.join('\n');
}

function formatDelta(value) {
  const rounded = Number(value.toFixed(4));
  return rounded >= 0 ? `+${rounded}` : `${rounded}`;
}

function main() {
  const candidateDir = join(root, 'experiments', 'candidates', 'story-review');
  const reportDir = join(root, 'experiments', 'reports');
  const resultPath = join(reportDir, 'story-review-structured-v1.json');
  const reportPath = join(reportDir, 'story-review-structured-v1.md');
  ensureDir(candidateDir);
  ensureDir(reportDir);
  const reviewPath = join(root, 'docs', 'story', 'actives', 'B-0f18', 'review.json');
  const baseline = existsSync(reviewPath)
    ? readFileSync(reviewPath, 'utf8')
    : run('node', [koala, 'story_review', JSON.stringify({ storyId: 'B-0f18' })]);
  const candidates = buildCandidates(baseline);
  writeFileSync(join(candidateDir, '00-baseline-current.txt'), baseline);
  for (const candidate of candidates) writeFileSync(join(candidateDir, `${candidate.id}.txt`), candidate.text);
  const results = candidates.map((candidate) => scoreCandidate(baseline, candidate));
  writeFileSync(resultPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  writeFileSync(reportPath, renderReport(baseline, results));
  const sorted = [...results].sort((a, b) => (b.normalizedScore ?? 0) - (a.normalizedScore ?? 0));
  const baselineResult = results.find((r) => r.id === 'r01-current') || results[0];
  console.log(`Baseline normalizedScore: ${baselineResult.normalizedScore}`);
  console.log(`Best candidate: ${sorted[0].id} normalizedScore: ${sorted[0].normalizedScore}`);
  console.log(`Report: ${reportPath}`);
}

main();
