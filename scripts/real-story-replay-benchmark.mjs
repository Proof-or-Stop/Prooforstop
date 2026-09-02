#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

const root = process.cwd();
const storyRoot = join(root, 'docs', 'story', 'actives');
const replayArtifactPath = join(root, 'experiments', 'replay-artifacts', 'real-story-replay-v1.json');
const reportJsonPath = join(root, 'experiments', 'reports', 'real-story-replay-v1.json');
const reportMdPath = join(root, 'experiments', 'reports', 'real-story-replay-v1.md');
const generatedAt = process.env.PROOF_OR_STOP_REAL_STORY_REPLAY_GENERATED_AT || 'real-story-replay-v1';
const replayArtifacts = readJson(replayArtifactPath, { stories: {} });

const STORIES = [
  {
    id: 'B-7670',
    category: 'story_review output',
    beforeProblem: 'story_review output was too diffuse for agents to pick the next action confidently.',
    afterCapability: 'Adds actionSummary and reviewPromptSummary while preserving legacy fields.',
  },
  {
    id: 'B-8d6a',
    category: 'testIntent prompt',
    beforeProblem: 'test-intent guidance was too abstract to translate directly into fixture cases.',
    afterCapability: 'Adds fixture-heavy desc/type/input/expect/WHY guidance to production prompts.',
  },
  {
    id: 'B-57e7',
    category: 'lab scoring profile',
    beforeProblem: 'test-intent prompt quality had no repeatable score.',
    afterCapability: 'Adds test-intent-prompt-quality-v1 with normalizedScore support.',
  },
  {
    id: 'B-9c2c',
    category: 'real bug fix',
    beforeProblem: 'story_get detail could attach fixture evidence from an unrelated story.',
    afterCapability: 'Scopes fixture mapping to the current story intentRef and records regression cases.',
  },
  {
    id: 'B-990d',
    category: 'user value review',
    beforeProblem: 'DONE could be technically green while missing user-facing value evidence.',
    afterCapability: 'Adds product-reviewer advisory checks and outcome transcript quality pressure.',
  },
  {
    id: 'B-e452',
    category: 'transcript gate',
    beforeProblem: 'User-value validation depended on agent discipline instead of a replayable artifact.',
    afterCapability: 'Adds transcript-diff gate; this older story also reveals summary artifact gaps.',
  },
  {
    id: 'B-78d2',
    category: 'implementation review',
    beforeProblem: 'implementation-reviewer had no structured result protocol for session_brief to consume.',
    afterCapability: 'Adds verdict/findings/summary artifacts and reviewer status visibility.',
  },
  {
    id: 'B-6bee',
    category: 'session recovery',
    beforeProblem: 'session_brief did not expose enough role/activity context to resume confidently.',
    afterCapability: 'Adds source/role/status activity semantics and sharper next-step inference.',
  },
  {
    id: 'B-8bcf',
    category: 'worktree stability',
    beforeProblem: 'Concurrent INIT_CHECK bootstrap could race and create broken story worktrees.',
    afterCapability: 'Serializes bootstrap with a lock and verifies story metadata reaches the branch.',
  },
];

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function validateReplayArtifacts(data) {
  for (const [storyId, backfill] of Object.entries(data.stories || {})) {
    for (const field of ['evidenceQuality', 'source', 'why', 'explain']) {
      if (!backfill[field] || typeof backfill[field] !== 'string') {
        throw new Error(`Invalid replay backfill for ${storyId}: missing ${field}`);
      }
    }
    if (!backfill.summary?.changes || !backfill.summary?.usage) {
      throw new Error(`Invalid replay backfill for ${storyId}: missing summary changes/usage`);
    }
    if (!backfill.evidence || typeof backfill.evidence !== 'object') {
      throw new Error(`Invalid replay backfill for ${storyId}: missing evidence object`);
    }
  }
}

validateReplayArtifacts(replayArtifacts);

function readStoryArtifacts(storyId) {
  const dir = join(storyRoot, storyId);
  const backfill = replayArtifacts.stories?.[storyId] || null;
  return {
    story: readJson(join(dir, 'index.json'), {}),
    summary: readJson(join(dir, 'summary.json'), null),
    evidence: readJson(join(dir, 'test-evidence.json'), null),
    runs: readJson(join(dir, 'test-runs.json'), null),
    bugs: readJson(join(dir, 'bugs.json'), { bugs: [] }),
    implementationReview: readJson(join(dir, 'implementation-review.json'), null),
    backfill,
  };
}

function fixedBugCount(artifacts) {
  const summaryFixed = artifacts.summary?.bugStats?.fixed;
  if (typeof summaryFixed === 'number') return summaryFixed;
  return (artifacts.bugs?.bugs || []).filter((bug) => bug.status === 'fixed').length;
}

function openBugCount(artifacts) {
  const summaryOpen = artifacts.summary?.bugStats?.open;
  if (typeof summaryOpen === 'number') return summaryOpen;
  return (artifacts.bugs?.bugs || []).filter((bug) => bug.status === 'open').length;
}

function totalCases(artifacts) {
  const summaryCases = artifacts.summary?.fixtureStats?.totalCases;
  if (typeof summaryCases === 'number') return summaryCases;
  const backfilledCases = artifacts.backfill?.evidence?.fixtureCases;
  if (typeof backfilledCases === 'number') return backfilledCases;
  if (Array.isArray(artifacts.runs?.runs)) {
    return artifacts.runs.runs.reduce((sum, run) => sum + (run.totalCases || 0), 0);
  }
  return artifacts.evidence?.totalCases || 0;
}

function cumulativePassedCases(artifacts) {
  const summaryPassed = artifacts.summary?.fixtureStats?.cumulativePassedCases;
  if (typeof summaryPassed === 'number') return summaryPassed;
  const backfilledPassed = artifacts.backfill?.evidence?.cumulativePassedCases;
  if (typeof backfilledPassed === 'number') return backfilledPassed;
  if (Array.isArray(artifacts.runs?.runs)) {
    return artifacts.runs.runs.reduce((sum, run) => sum + (run.passedCases || 0), 0);
  }
  return artifacts.evidence?.passedCases || 0;
}

function totalDurationMs(artifacts) {
  const summaryDuration = artifacts.summary?.totalDurationMs;
  if (typeof summaryDuration === 'number') return summaryDuration;
  const backfilledDuration = artifacts.backfill?.evidence?.totalDurationMs;
  if (typeof backfilledDuration === 'number') return backfilledDuration;
  return null;
}

function scoreStory(storyConfig) {
  const artifacts = readStoryArtifacts(storyConfig.id);
  const hasSummary = Boolean(artifacts.summary && !artifacts.summary._empty);
  const hasBackfill = Boolean(artifacts.backfill);
  const hasSummaryEvidence = hasSummary || hasBackfill;
  const testPassed = artifacts.evidence?.result === 'PASS' || artifacts.evidence?.allPassed === true;
  const cases = totalCases(artifacts);
  const passed = cumulativePassedCases(artifacts);
  const fixed = fixedBugCount(artifacts);
  const open = openBugCount(artifacts);
  const hasPhaseStats = Boolean(artifacts.summary?.phaseStats || artifacts.backfill?.evidence?.hasPhaseStats);
  const hasImplementationReview = Boolean(artifacts.implementationReview || artifacts.backfill?.evidence?.hasImplementationReview);

  const components = {
    testEvidence: testPassed ? 0.25 : 0,
    summaryArtifact: hasSummary ? 0.2 : (hasBackfill ? 0.14 : 0),
    fixtureEvidence: cases > 0 ? (hasSummary ? 0.15 : 0.1) : 0,
    bugClosure: open === 0 ? 0.15 : 0,
    realTaskRelevance: 0.15,
    artifactDepth: (hasPhaseStats ? 0.05 : 0) + (hasImplementationReview ? 0.05 : 0),
  };

  let score = Object.values(components).reduce((sum, value) => sum + value, 0);
  if (fixed > 0) score += 0.03;
  if (!hasSummaryEvidence) score -= 0.12;
  if (cases > 0 && passed < cases) score -= 0.08;
  if (open > 0) score -= 0.2;
  score = Math.max(0, Math.min(1, Number(score.toFixed(2))));

  const whyParts = [];
  whyParts.push(testPassed ? 'PASS evidence' : 'missing PASS evidence');
  whyParts.push(hasSummary ? 'summary artifact present' : (hasBackfill ? 'backfilled summary evidence' : 'summary artifact missing'));
  whyParts.push(cases > 0 ? `${cases} ${hasBackfill && !hasSummary ? 'backfilled evidence item(s)' : 'fixture case(s)'}` : 'no fixture case count');
  whyParts.push(open === 0 ? '0 open bugs' : `${open} open bug(s)`);
  if (fixed > 0) whyParts.push(`${fixed} bug(s) fixed`);

  const summaryText = artifacts.summary?.changes || artifacts.summary?.usage || artifacts.backfill?.summary?.changes || artifacts.backfill?.summary?.usage || 'summary present';
  const explanation = [
    `Score=${score} from deterministic artifacts: testEvidence ${components.testEvidence.toFixed(2)}, summary ${components.summaryArtifact.toFixed(2)}, fixtures ${components.fixtureEvidence.toFixed(2)}, bugClosure ${components.bugClosure.toFixed(2)}, relevance ${components.realTaskRelevance.toFixed(2)}, artifactDepth ${components.artifactDepth.toFixed(2)}.`,
    hasSummary
      ? `Summary says: ${shortText(summaryText)}`
      : hasBackfill
      ? `Native summary is missing, so the score uses explicit backfill metadata (${artifacts.backfill.source}). ${shortText(artifacts.backfill.explain)}`
      : 'Summary is missing, so this story is kept in the benchmark but penalized as an artifact gap.',
  ].join(' ');

  return {
    storyId: storyConfig.id,
    title: artifacts.story?.title || '(missing title)',
    category: storyConfig.category,
    beforeProblem: storyConfig.beforeProblem,
    afterCapability: storyConfig.afterCapability,
    score,
    evidenceQuality: hasSummary ? 'native' : (hasBackfill ? artifacts.backfill.evidenceQuality : 'artifact-gap'),
    why: whyParts.join(' + '),
    explain: explanation,
    evidence: {
      testPassed,
      hasSummary,
      hasBackfill,
      backfillSource: artifacts.backfill?.source || null,
      fixtureCases: cases,
      cumulativePassedCases: passed,
      fixedBugs: fixed,
      openBugs: open,
      hasPhaseStats,
      hasImplementationReview,
      totalDurationMs: totalDurationMs(artifacts),
    },
  };
}

function shortText(value) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length <= 150 ? text : `${text.slice(0, 147)}...`;
}

function formatDuration(ms) {
  if (typeof ms !== 'number') return 'n/a';
  const minutes = ms / 60000;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

function mdEscape(value) {
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

function renderMarkdown(rows) {
  const avg = rows.reduce((sum, row) => sum + row.score, 0) / rows.length;
  const lines = [
    '# Real Story Replay Benchmark v1',
    '',
    `Generated at: ${generatedAt}`,
    `Average score: ${avg.toFixed(2)}`,
    '',
    '## Score Rubric',
    '',
    '- `0.25` PASS test evidence',
    '- `0.20` summary artifact present',
    '- `0.15` fixture evidence exists',
    '- `0.15` zero open bugs',
    '- `0.15` real-task relevance baseline',
    '- `0.10` artifact depth: phase stats and implementation review',
    '- Backfilled summary and fixture evidence are lower-weighted and always marked in `Evidence Quality`',
    '- Penalties: missing summary, partial fixture pass, or open bugs',
    '',
    '## Replay Table',
    '',
    '| Story | Category | Score | Evidence Quality | Why | Explain | Before | After | Cases | Bugs | Time |',
    '|---|---|---:|---|---|---|---|---|---:|---|---:|',
  ];

  for (const row of rows) {
    lines.push([
      row.storyId,
      mdEscape(row.category),
      row.score.toFixed(2),
      mdEscape(row.evidenceQuality),
      mdEscape(row.why),
      mdEscape(row.explain),
      mdEscape(row.beforeProblem),
      mdEscape(row.afterCapability),
      row.evidence.fixtureCases,
      `${row.evidence.fixedBugs} fixed / ${row.evidence.openBugs} open`,
      formatDuration(row.evidence.totalDurationMs),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }

  lines.push(
    '',
    '## Interpretation',
    '',
    '- High scores mean the story has replayable evidence, closed bugs, and enough artifacts to explain why the change helped.',
    '- Lower scores do not mean the story was useless; they identify artifact gaps that make replay evidence weaker.',
    '- `native` evidence comes from story artifacts; `backfilled` evidence is explicitly marked and lower-weighted.',
    '- `B-e452` is intentionally included because it proves the benchmark can keep older real work while explaining artifact gaps.',
    '',
  );
  return lines.join('\n');
}

const rows = STORIES.map(scoreStory);
mkdirSync(dirname(reportJsonPath), { recursive: true });
writeFileSync(reportJsonPath, JSON.stringify({ generatedAt, rows }, null, 2) + '\n');
writeFileSync(reportMdPath, renderMarkdown(rows) + '\n');

console.log('Real Story Replay Benchmark v1');
console.log('| Story | Score | Evidence Quality | Why | Explain |');
console.log('|---|---:|---|---|---|');
for (const row of rows) {
  console.log(`| ${row.storyId} | ${row.score.toFixed(2)} | ${row.evidenceQuality} | ${row.why} | ${shortText(row.explain)} |`);
}
console.log(`Report written: ${reportMdPath}`);
console.log(`JSON written: ${reportJsonPath}`);
