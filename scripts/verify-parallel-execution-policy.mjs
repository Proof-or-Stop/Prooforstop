#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = process.cwd();
const cli = join(root, 'packages/main/dist/cli.js');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(projectRoot, command, payload) {
  const args = [cli, '--root', projectRoot, command];
  if (payload !== undefined) args.push(JSON.stringify(payload));
  return execFileSync('node', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function extractStoryId(text) {
  const storyId = text.match(/B-[a-f0-9]+/)?.[0];
  if (!storyId) throw new Error(`failed to parse story id from: ${text}`);
  return storyId;
}

function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error(`no JSON payload found in output: ${text}`);
  return JSON.parse(text.slice(start));
}

function createTempProject() {
  const dir = mkdtempSync(join(tmpdir(), 'proof-or-stop-parallel-policy-'));
  mkdirSync(join(dir, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
  writeFileSync(join(dir, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  return dir;
}

const temp = createTempProject();

try {
  const primaryId = extractStoryId(run(temp, 'story_create', {
    name: 'parallel-primary',
    title: 'Primary lane story',
    description: 'Mainline story for session_brief policy verification.',
    type: 'feature',
    priority: 'high',
    phase: 'DEV',
    lane: 'mainline',
    parallelSafe: 'no',
    sharedHotspots: ['packages/main/src/handlers/session.ts'],
    blockingFor: ['B-ffff'],
  }));

  const candidateId = extractStoryId(run(temp, 'story_create', {
    name: 'parallel-candidate',
    title: 'Supporting plan-only story',
    description: 'Supporting story that should appear as a plan-only candidate.',
    type: 'chore',
    priority: 'medium',
    phase: 'PLAN',
    lane: 'supporting',
    parallelSafe: 'plan_only',
    sharedHotspots: ['packages/main/src/handlers/worktree.ts'],
  }));

  const conflictId = extractStoryId(run(temp, 'story_create', {
    name: 'parallel-conflict',
    title: 'Conflicting DEV story',
    description: 'Supporting story that collides with the primary hotspot.',
    type: 'feature',
    priority: 'medium',
    phase: 'DEV',
    lane: 'supporting',
    parallelSafe: 'yes',
    sharedHotspots: ['packages/main/src/handlers/session.ts'],
  }));

  const brief = run(temp, 'session_brief');
  assert(brief.includes('## Primary lane'), 'session_brief missing Primary lane section');
  assert(brief.includes(primaryId), 'session_brief missing primary story in Primary lane');
  assert(brief.includes('## Parallel candidates'), 'session_brief missing Parallel candidates section');
  assert(brief.includes(candidateId), 'session_brief missing supporting candidate story');
  assert(brief.includes('plan_only') || brief.includes('keep this in PLAN only'), 'session_brief missing plan_only guidance');
  assert(brief.includes('## Conflict warnings'), 'session_brief missing Conflict warnings section');
  assert(brief.includes(conflictId), 'session_brief missing conflicting story warning');

  const reviewId = extractStoryId(run(temp, 'story_create', {
    name: 'parallel-review-target',
    title: 'Review target for parallel policy',
    description: 'Validate story_review parallel policy advisories.',
    type: 'feature',
    priority: 'high',
    phase: 'PLAN',
    depends: [primaryId],
    lane: 'supporting',
    parallelSafe: 'yes',
    sharedHotspots: ['packages/main/src/handlers/session.ts'],
    checklist: [{
      title: 'Plan the multi-session execution policy',
      context: 'Need advisory-only guardrails before any hard gates.',
      testIntent: {
        happy: [{ desc: 'primary lane and candidates are visible', type: 'cli_blackbox' }],
        edge: [{ desc: 'depends + parallelSafe=yes warns instead of hard failing', type: 'cli_blackbox' }],
        adversarial: [{ desc: 'shared hotspot overlap is surfaced as a conflict warning', type: 'cli_blackbox' }],
      },
    }],
  }));

  run(temp, 'understanding_set', {
    storyId: reviewId,
    task: 'Verify story_review parallel policy advisory behavior',
    outcome: '>>> proof-or-stop session_brief\n## Primary lane\n  B-xxxx DEV Primary lane story [mainline/no]\n## Parallel candidates\n  B-yyyy PLAN [supporting/plan_only] keep this in PLAN only\n## Conflict warnings\n  - B-zzzz: shares hotspots with B-xxxx: packages/main/src/handlers/session.ts',
    facts: ['parallelSafe=yes should stay advisory even with depends'],
    constraints: ['first version is advisory-only'],
    unknowns: [],
    touchpoints: ['packages/main/src/handlers/story-review.ts'],
  });

  run(temp, 'decision_set', {
    storyId: reviewId,
    principles: ['Prefer advisory over hard gate', 'Expose conflicts early', 'Keep the model understandable'],
    drivers: ['avoid harming mainline tasks', 'support multi-session planning'],
    options: [
      { name: 'A: advisory review + brief hints', pros: ['low friction'], cons: ['operators must read warnings'] },
      { name: 'B: hard gate on every conflict', pros: ['strict safety'], cons: ['too heavy for first rollout'] },
    ],
    chosen: 'A: advisory review + brief hints',
    rationale: 'The first rollout should surface conflicts without blocking legitimate planning work.',
    preMortem: [
      { scenario: 'Hints are too noisy', trigger: 'Every story gets multiple warnings', consequence: 'Operators ignore them', mitigation: 'Keep checks focused on lane/safety/hotspot mismatches' },
      { scenario: 'Conflicts stay invisible', trigger: 'Hotspots are omitted', consequence: 'Parallel DEV collides later', mitigation: 'Add a missing_hotspots advisory' },
      { scenario: 'Dependencies are ignored', trigger: 'parallelSafe=yes on downstream story', consequence: 'A dependent story races into DEV', mitigation: 'Flag depends + yes as advisory' },
    ],
  });

  const review = extractJsonObject(run(temp, 'story_review', { storyId: reviewId }));
  const issueTypes = new Set((review.issues || []).map((issue) => issue.type));
  assert(issueTypes.has('parallel_policy_depends_conflict'), 'story_review missing depends + parallelSafe advisory');
  assert(issueTypes.has('parallel_policy_conflict'), 'story_review missing hotspot conflict advisory');

  const missingMetaId = extractStoryId(run(temp, 'story_create', {
    name: 'parallel-missing-metadata',
    title: 'Missing policy metadata story',
    description: 'Validate missing lane/safety/hotspot advisories.',
    type: 'chore',
    priority: 'medium',
    phase: 'PLAN',
    checklist: [{
      title: 'Document the rollout shape',
      context: 'Need enough structure for a lightweight review.',
      testIntent: {
        happy: [{ desc: 'review still runs without blocking', type: 'cli_blackbox' }],
        edge: [{ desc: 'missing metadata is surfaced clearly', type: 'cli_blackbox' }],
        adversarial: [{ desc: 'operators do not need to guess what to fill next', type: 'cli_blackbox' }],
      },
    }],
  }));

  run(temp, 'understanding_set', {
    storyId: missingMetaId,
    task: 'Verify missing parallel metadata advisories',
    outcome: '> proof-or-stop story_review\nparallel_policy_missing_lane\nparallel_policy_missing_safety\nparallel_policy_missing_hotspots',
    facts: ['metadata is optional but should be nudged'],
    constraints: ['must remain advisory'],
    unknowns: [],
    touchpoints: ['packages/main/src/handlers/story-review.ts'],
  });

  run(temp, 'decision_set', {
    storyId: missingMetaId,
    principles: ['Keep the policy light', 'Prefer explicit metadata over guesses', 'Do not block planning'],
    drivers: ['clarity', 'low friction'],
    options: [
      { name: 'A: advisory nudges', pros: ['easy to adopt'], cons: ['relies on operator follow-through'] },
      { name: 'B: hard gate', pros: ['strict completeness'], cons: ['too disruptive'] },
    ],
    chosen: 'A: advisory nudges',
    rationale: 'Missing metadata should be visible, but teams still need room to keep planning moving.',
  });

  const missingMetaReview = extractJsonObject(run(temp, 'story_review', { storyId: missingMetaId }));
  const missingMetaTypes = new Set((missingMetaReview.issues || []).map((issue) => issue.type));
  assert(missingMetaTypes.has('parallel_policy_missing_lane'), 'story_review missing lane advisory');
  assert(missingMetaTypes.has('parallel_policy_missing_safety'), 'story_review missing safety advisory');
  assert(missingMetaTypes.has('parallel_policy_missing_hotspots'), 'story_review missing hotspot advisory');

  console.log('parallel execution policy verified');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
