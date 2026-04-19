#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const root = process.cwd();
const cli = join(root, 'bin', 'koala.js');
const codexCli = join(root, 'bin', 'koala-codex.js');
const candidateDir = join(root, 'experiments', 'candidates', 'session-brief');
const reportDir = join(root, 'experiments', 'reports');
const resultPath = join(reportDir, 'session-brief-structured-v1.json');
const reportPath = join(reportDir, 'session-brief-structured-v1.md');

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

function parseCliJson(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error(`JSON payload not found:\n${text}`);
  return JSON.parse(text.slice(start));
}

function createTempProject(baselineText) {
  const dir = mkdtempSync(join(tmpdir(), 'koala-session-brief-exp-'));
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
  writeFileSync(join(dir, 'README.md'), '# session brief experiment\n');
  writeFileSync(join(dir, 'samples', 'session-brief.txt'), baselineText);
  run('git', ['init', '-b', 'main'], dir);
  run('git', ['config', 'user.name', 'Koala Lab'], dir);
  run('git', ['config', 'user.email', 'koala-lab@example.com'], dir);
  run('git', ['add', '.'], dir);
  run('git', ['commit', '-m', 'baseline'], dir);
  run('node', [cli, '--root', dir, 'lab', 'create', JSON.stringify({
    id: 'lab-session-brief-structured-v1',
    target: 'session-brief-sample',
    profile: 'session-brief-quality-v1',
    editableFiles: ['samples/session-brief.txt'],
  })]);
  return dir;
}

function candidateText(id, title, body) {
  return [`# ${id} ${title}`, '', body.trim(), ''].join('\n');
}

function buildCandidates(baseline) {
  const current = baseline.trim();
  return [
    ['c01-current', 'Current Full Output', current, true],
    ['c02-next-step-top', 'Next Step First', `
## → Next step
DEV 阶段。下一项：checklist_update --storyId=B-ff27 --itemId=CHK-001 --status=in_progress（准备 session_brief baseline 与 12 个候选样本）

## Current Story
**Story**: B-ff27 — 用 koala-lab 跑 session_brief 结构化候选实验
**Phase**: DEV
**Checklist**: 0/3 done

## Risk Signals
- Git: uncommitted story metadata present
- Reviewer status: implementation review missing
- Artifacts: test evidence and summary missing

## Runtime health
[✓] worktree registered — /Users/jek/Documents/Work/Orchestrate/.worktrees/B-ff27
`],
    ['c03-action-dashboard', 'Action Dashboard', `
## Action
Next step: start CHK-001 and generate baseline/candidate files.

## Story / Phase
- Story: B-ff27 — 用 koala-lab 跑 session_brief 结构化候选实验
- Phase: DEV
- Checklist: 0/3 done; next pending CHK-001

## Reviewer status
- story review: pass
- test-intent review: missing 0/9 pass
- implementation review: missing

## Artifacts
- understanding: present
- decision: present
- test evidence: missing
- summary: missing

## Git
- working tree: dirty story metadata
- recent commit: koala story B-ff27 init

## Runtime health
- worktree registered
`],
    ['c04-git-risk-first', 'Git Risk First', `
## Git
Working tree: dirty
Uncommitted: story metadata for B-ff27

## → Next step
Continue DEV: run checklist_update for CHK-001 in_progress, then create experiment samples.

## Story
B-ff27 — session_brief structured experiment
Phase: DEV
Checklist: 0/3 done

## Reviewer status
story review pass; test-intent review missing; implementation review missing

## Artifacts
understanding/decision/story review present; test evidence/summary missing

## Runtime health
worktree registered
`],
    ['c05-reviewer-artifact-combined', 'Reviewer And Artifact Combined', `
## Story
B-ff27 — 用 koala-lab 跑 session_brief 结构化候选实验
Phase: DEV
Checklist: 0/3 done

## Quality gates
- Reviewer status: story review pass; test-intent review missing; implementation review missing
- Artifacts: understanding present; decision present; evidence missing; summary missing

## Git
dirty story metadata

## Runtime health
worktree registered

## → Next step
Start CHK-001 and create baseline/candidate samples.
`],
    ['c06-exception-only-health', 'Exception-only Health', `
## Story
B-ff27 — 用 koala-lab 跑 session_brief 结构化候选实验
Phase: DEV
Checklist: 0/3 done

## Reviewer status
story review pass; test-intent review missing; implementation review missing

## Artifacts
understanding/decision present; test evidence/summary missing

## Git
dirty story metadata

## → Next step
Start CHK-001 and create candidates.
`],
    ['c07-next-pending-only', 'Checklist Next Pending Only', `
## Story
B-ff27 — 用 koala-lab 跑 session_brief 结构化候选实验
Phase: DEV

## Checklist
Next pending: CHK-001 准备 session_brief baseline 与 12 个候选样本

## Reviewer status
story review pass; test-intent review missing; implementation review missing

## Artifacts
understanding/decision present; test evidence/summary missing

## Git
dirty

## Runtime health
worktree registered

## → Next step
Mark CHK-001 in_progress and generate samples.
`],
    ['c08-active-story-card', 'Active Story Card', `
## Active story
**B-ff27** — 用 koala-lab 跑 session_brief 结构化候选实验
Phase: **DEV**
Progress: checklist 0/3

## Next step
Run CHK-001: prepare baseline and 12 candidates.

## Gate state
Reviewer status: story review pass; test-intent missing; implementation missing.
Artifacts: understanding and decision present; test evidence and summary missing.

## Git
dirty story metadata

## Runtime health
worktree registered
`],
    ['c09-minimal', 'Minimal', `
Story B-ff27 in DEV.
Next step: prepare session_brief candidates for CHK-001.
Git dirty.
`],
    ['c10-detailed', 'Detailed', `${current}

## Operator notes
- Must keep active story, phase, git dirty, reviewer status, artifacts, runtime health, and next step.
- Do not proceed to TEST until fixture evidence exists.
- This verbose candidate intentionally tests whether extra detail hurts score or readability.
`],
    ['c11-product-language', 'Product Language', `
## What you should do now
Start the experiment assets: create the baseline and 12 session_brief candidates for CHK-001.

## Why
The story is in DEV and all planning artifacts are ready. The next user-visible outcome is a report that compares before/after session_brief formats.

## Status
- Story: B-ff27
- Phase: DEV
- Checklist: 0/3 done
- Reviewer status: story review pass; implementation review missing
- Artifacts: understanding/decision present; test evidence missing
- Git: dirty story metadata
- Runtime health: worktree registered
`],
    ['c12-chinese-action', 'Chinese Action Style', `
## 下一步
开始 CHK-001：生成当前 session_brief baseline 和 12 个候选样本。

## 当前 Story
- Story: B-ff27 — 用 koala-lab 跑 session_brief 结构化候选实验
- Phase: DEV
- Checklist: 0/3 done

## 风险/门禁
- Git: 有未提交 story metadata
- Reviewer status: story review 已通过；test-intent / implementation review 未完成
- Artifacts: understanding / decision 已有；test evidence / summary 缺失
- Runtime health: worktree registered
`],
  ].map(([id, title, body, raw]) => ({ id, title, text: raw ? `${body.trim()}\n` : candidateText(id, title, body) }));
}

function scoreCandidate(baseline, candidate) {
  const temp = createTempProject(baseline);
  try {
    writeFileSync(join(temp, 'samples', 'session-brief.txt'), candidate.text);
    run('node', [cli, '--root', temp, 'lab', 'run', '--config', 'experiments/configs/lab-session-brief-structured-v1.json', '--confirm']);
    const result = JSON.parse(readFileSync(join(temp, 'experiments', 'runs', 'lab-session-brief-structured-v1', 'run-001', 'result.json'), 'utf8'));
    const metrics = JSON.parse(readFileSync(join(temp, 'experiments', 'runs', 'lab-session-brief-structured-v1', 'run-001', 'metrics.json'), 'utf8'));
    const baselineRecord = JSON.parse(readFileSync(join(temp, 'experiments', 'baselines', 'lab-session-brief-structured-v1.json'), 'utf8'));
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

function renderReport(baseline, candidates, results) {
  const sorted = [...results].sort((a, b) => {
    if ((b.normalizedScore ?? 0) !== (a.normalizedScore ?? 0)) return (b.normalizedScore ?? 0) - (a.normalizedScore ?? 0);
    return a.lineCount - b.lineCount;
  });
  const baselineResult = results.find((r) => r.id === 'c01-current') || results[0];
  const top = sorted.slice(0, 3);
  const bestCandidate = top[0];
  const compressed = sorted.find((item) => item.lengthDelta < -500 && item.contentSummary.every((entry) => !entry.startsWith('missing ')));
  const hasImprovement = (bestCandidate.normalizedScore ?? 0) > (baselineResult.normalizedScore ?? 0);
  const lines = [];
  lines.push('# session_brief structured experiment v1');
  lines.push('');
  lines.push(`Baseline candidate: c01-current`);
  lines.push(`Baseline normalizedScore: ${baselineResult.normalizedScore}`);
  lines.push(`Best candidate: ${bestCandidate.id} (${bestCandidate.title})`);
  lines.push(`Best normalizedScore: ${bestCandidate.normalizedScore} (${formatDelta((bestCandidate.normalizedScore ?? 0) - (baselineResult.normalizedScore ?? 0))})`);
  lines.push(`Recommendation: ${hasImprovement ? `implement ${bestCandidate.id}` : 'no production change; baseline remains best by score'}`);
  if (compressed) {
    lines.push(`Best compression candidate: ${compressed.id} (${compressed.title}) normalizedScore ${compressed.normalizedScore}, lengthDelta ${compressed.lengthDelta}`);
  }
  lines.push('');
  lines.push('## Top 3');
  lines.push('');
  lines.push('| rank | candidate | normalizedScore | score | lines | lengthDelta | status |');
  lines.push('|---:|---|---:|---:|---:|---:|---|');
  top.forEach((item, index) => {
    lines.push(`| ${index + 1} | ${item.id} ${item.title} | ${item.normalizedScore} | ${item.score} | ${item.lineCount} | ${item.lengthDelta} | ${item.status} |`);
  });
  lines.push('');
  lines.push('## All candidates');
  lines.push('');
  lines.push('| candidate | normalizedScore | score | normalizedDelta | lines | lengthDelta | notable contentSummary |');
  lines.push('|---|---:|---:|---:|---:|---:|---|');
  for (const item of sorted) {
    const summary = (item.contentSummary || []).filter((entry) => entry.startsWith('missing ') || entry === 'has nextStep').slice(0, 4).join('; ');
    lines.push(`| ${item.id} ${item.title} | ${item.normalizedScore} | ${item.score} | ${item.normalizedDelta} | ${item.lineCount} | ${item.lengthDelta} | ${summary || '(all key signals present)'} |`);
  }
  lines.push('');
  lines.push('## Recommendation');
  lines.push('');
  if (hasImprovement) {
    lines.push(`Recommended implementation candidate: **${bestCandidate.id} ${bestCandidate.title}**.`);
  } else {
    lines.push('Recommended implementation candidate: **none yet**. The current baseline remains the best-scoring output.');
  }
  lines.push('');
  lines.push('Why: current output already preserves all must-keep signals (active story/phase, reviewer/artifact status, git dirty, runtime health, next step).');
  if (compressed) {
    lines.push(`If we choose to optimize for brevity, the best lower-length candidate is **${compressed.id} ${compressed.title}**, but it should be dogfooded before implementation.`);
  }
  lines.push('');
  lines.push('Do not implement directly from the highest machine score alone; use this report as design input for a follow-up production story.');
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
  ensureDir(candidateDir);
  ensureDir(reportDir);
  const baseline = run('node', [codexCli, 'session_brief']);
  const candidates = buildCandidates(baseline);
  writeFileSync(join(candidateDir, '00-baseline-current.txt'), baseline);
  for (const candidate of candidates) {
    writeFileSync(join(candidateDir, `${candidate.id}.txt`), candidate.text);
  }
  const results = candidates.map((candidate) => scoreCandidate(baseline, candidate));
  writeFileSync(resultPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  writeFileSync(reportPath, renderReport(baseline, candidates, results));
  const sorted = [...results].sort((a, b) => (b.normalizedScore ?? 0) - (a.normalizedScore ?? 0));
  console.log(`Baseline normalizedScore: ${results.find((r) => r.id === 'c01-current')?.normalizedScore}`);
  console.log(`Best candidate: ${sorted[0].id} normalizedScore: ${sorted[0].normalizedScore}`);
  console.log(`Report: ${reportPath}`);
}

main();
