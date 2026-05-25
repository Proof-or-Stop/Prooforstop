#!/usr/bin/env node

/**
 * B-30b2 CHK-001: riskSignal auto-elevation rollback smoke (black-box via real CLI).
 *
 * Proves the full chain:
 *   1. story_create auto-elevates a low-priority story that hits a riskSignal and
 *      records the pre-elevation priority in `priorityElevatedFrom`.
 *   2. story_review_dismiss rolls the priority back ONLY when the dismissal clears
 *      the last active riskSignal AND the elevation was automatic (marker present
 *      and < high). After rollback both isHighRisk consumers (story-review.ts:152
 *      and decision.ts:97 — identical formula) see false, so the high-risk gate
 *      (≥3 preMortem) no longer fires.
 *   3. User-explicit high/critical is NEVER downgraded (no marker is ever written
 *      for them; a forged/tampered marker is rejected by runtime validation).
 *   4. Multi-category: dismissing one while another is still active does not roll
 *      back and keeps high-risk status.
 *
 * Each scenario prints `ok <mode>` on success so the fixture can assert on it.
 */

import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = process.cwd();
const cli = join(root, 'packages', 'main', 'dist', 'cli.js');
const mode = process.argv[2] || 'all';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createProject(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
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
  writeFileSync(join(dir, 'docs', 'requirements', 'truth.md'), '# Truth\n\nKeep risk handling honest.\n');
  return dir;
}

function run(projectRoot, command, payload) {
  const args = [cli, '--root', projectRoot, command];
  if (payload !== undefined) args.push(JSON.stringify(payload));
  return execFileSync('node', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

// B-30b2 CHK-002: capture BOTH stdout and stderr. The mention-vs-modify
// guidance (riskHint) is written to stderr, so execFileSync (stdout-only) cannot
// see it — spawnSync surfaces both streams.
function runCapture(projectRoot, command, payload) {
  const args = [cli, '--root', projectRoot, command];
  if (payload !== undefined) args.push(JSON.stringify(payload));
  const r = spawnSync('node', args, { cwd: root, encoding: 'utf8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', combined: (r.stdout ?? '') + (r.stderr ?? '') };
}

function storyPath(projectRoot, storyId) {
  return join(projectRoot, 'docs', 'story', 'actives', storyId, 'index.json');
}

function readStory(projectRoot, storyId) {
  return JSON.parse(readFileSync(storyPath(projectRoot, storyId), 'utf8'));
}

function writeStory(projectRoot, storyId, story) {
  writeFileSync(storyPath(projectRoot, storyId), JSON.stringify(story, null, 2));
}

function background(suffix) {
  return [
    `## 触发事件`,
    `2026-05-25 B-30b2 CHK-001 risk-rollback smoke (${suffix}) builds a synthetic story so the auto-elevation rollback can be exercised end-to-end via the real CLI.`,
    ``,
    `## 关键洞察`,
    `Auto-elevated priority must be reversible when the dismissal clears the last active riskSignal, while user-explicit high/critical must never be downgraded by a dismiss.`,
    ``,
    `## 方案取舍`,
    `Drive the real dist CLI against a temp project instead of poking handlers directly, so the black-box behavior (story_create elevation + story_review_dismiss rollback) is what gets verified.`,
    ``,
    `## 对话纹理`,
    `The maintainer flagged that a mention-only riskSignal false positive should be cheap to reject, including rolling back the priority cost it triggered.`,
  ].join('\n');
}

function createStory(projectRoot, suffix, priority, description, extraCtx = '') {
  const out = run(projectRoot, 'story_create', {
    name: `risk-rollback-${suffix}`,
    title: `Risk rollback ${suffix}`,
    description,
    background: background(suffix),
    type: 'feature',
    priority,
    checklist: [
      { title: 'do the thing', context: `implement the change. ${extraCtx}` },
      { title: 'cover it', context: 'add coverage.' },
      { title: 'wire it', context: 'wire the change.' },
    ],
    forceNew: true,
  });
  const storyId = out.match(/B-[a-f0-9]+/)?.[0];
  if (!storyId) throw new Error(`story id not found in: ${out}`);
  return storyId;
}

// decision_set with NO preMortem: succeeds iff the story is NOT high-risk; throws
// "≥ 3 个 preMortem" iff high-risk. Direct behavioral probe of decision.ts:97.
const DECISION_NO_PREMORTEM = {
  principles: ['p one', 'p two', 'p three'],
  drivers: ['d one'],
  options: [
    { name: 'opt-a', pros: ['fast'], cons: ['risky'] },
    { name: 'opt-b', pros: ['safe'], cons: ['slow'] },
  ],
  chosen: 'opt-a',
  rationale: 'choose opt-a because it is the most direct fix here.',
};

function decisionSucceedsWithoutPreMortem(projectRoot, storyId) {
  try {
    run(projectRoot, 'decision_set', { storyId, ...DECISION_NO_PREMORTEM });
    return true;
  } catch {
    return false;
  }
}

function scenarioHappy() {
  const p = createProject('koala-risk-happy-');
  const id = createStory(p, 'happy', 'low', 'Refactor the state machine guard logic so phase flow is correct.');
  let story = readStory(p, id);
  assert(story.priority === 'high', `happy: expected auto-elevation to high, got ${story.priority}`);
  assert(story.priorityElevatedFrom === 'low', `happy: expected priorityElevatedFrom=low, got ${story.priorityElevatedFrom}`);
  assert((story.riskSignals || []).length >= 1, 'happy: expected at least one riskSignal');
  // Before dismiss: high-risk gate active -> decision_set without preMortem must fail.
  assert(!decisionSucceedsWithoutPreMortem(p, id), 'happy: decision_set should be blocked while high-risk');

  const cat = story.riskSignals[0].category;
  const dismissOut = run(p, 'story_review_dismiss', { storyId: id, category: cat, reason: 'this story only mentions the state machine, it does not modify it' });
  assert(/回退|priorityRolledBackTo|rolled/i.test(dismissOut) || dismissOut.includes('low'), `happy: dismiss output should mention rollback: ${dismissOut}`);

  story = readStory(p, id);
  assert(story.priority === 'low', `happy: expected priority rolled back to low, got ${story.priority}`);
  assert(story.priorityElevatedFrom === undefined, 'happy: priorityElevatedFrom marker should be cleared after rollback');
  // After full dismiss + rollback: no active risk + low priority -> isHighRisk false in both consumers.
  assert(decisionSucceedsWithoutPreMortem(p, id), 'happy: decision_set should pass after rollback (decision.ts isHighRisk=false)');
  console.log('ok happy');
}

function scenarioEdgeHigh() {
  const p = createProject('koala-risk-edge-high-');
  const id = createStory(p, 'edge-high', 'high', 'Adjust the state machine guard logic for the gate.');
  let story = readStory(p, id);
  assert(story.priority === 'high', `edge-high: expected priority high, got ${story.priority}`);
  assert(story.priorityElevatedFrom === undefined, 'edge-high: user-set high must NOT get priorityElevatedFrom marker');

  const cat = story.riskSignals[0].category;
  run(p, 'story_review_dismiss', { storyId: id, category: cat, reason: 'false positive: only references the guard, no behavior change' });
  story = readStory(p, id);
  assert(story.priority === 'high', `edge-high: user-set high must NOT be downgraded, got ${story.priority}`);
  console.log('ok edge-high');
}

function scenarioEdgeCritical() {
  const p = createProject('koala-risk-edge-critical-');
  const id = createStory(p, 'edge-critical', 'critical', 'Touch the state machine guard logic near the gate.');
  let story = readStory(p, id);
  assert(story.priority === 'critical', `edge-critical: expected priority critical, got ${story.priority}`);
  assert(story.priorityElevatedFrom === undefined, 'edge-critical: user-set critical must NOT get priorityElevatedFrom marker');

  const cat = story.riskSignals[0].category;
  run(p, 'story_review_dismiss', { storyId: id, category: cat, reason: 'false positive: mention only, no critical behavior touched' });
  story = readStory(p, id);
  assert(story.priority === 'critical', `edge-critical: user-set critical must NOT be downgraded, got ${story.priority}`);
  console.log('ok edge-critical');
}

function scenarioMulti() {
  const p = createProject('koala-risk-multi-');
  // Two distinct categories: '状态机/门禁' (state machine) + '验证框架' (koala validate).
  const id = createStory(p, 'multi', 'low', 'Change the state machine guard logic and also the koala validate fixture runner.');
  let story = readStory(p, id);
  const cats = (story.riskSignals || []).map(r => r.category);
  assert(cats.length >= 2, `multi: expected >=2 categories, got ${JSON.stringify(cats)}`);
  assert(story.priority === 'high', `multi: expected auto-elevation to high, got ${story.priority}`);
  assert(story.priorityElevatedFrom === 'low', `multi: expected priorityElevatedFrom=low, got ${story.priorityElevatedFrom}`);

  // Dismiss only ONE category; another remains active.
  run(p, 'story_review_dismiss', { storyId: id, category: cats[0], reason: 'first category is a mention-only false positive in this story' });
  story = readStory(p, id);
  assert(story.priority === 'high', `multi: priority must NOT roll back while another risk is active, got ${story.priority}`);
  assert(story.priorityElevatedFrom === 'low', 'multi: marker must remain while a risk is still active');
  // Still high-risk -> decision gate still fires.
  assert(!decisionSucceedsWithoutPreMortem(p, id), 'multi: decision_set should remain blocked while a risk is active');
  console.log('ok multi');
}

function scenarioAdversarial() {
  // (a) user-set critical with a FORGED/tampered priorityElevatedFrom='high' (>= high) -> no downgrade.
  {
    const p = createProject('koala-risk-adv-tampered-');
    const id = createStory(p, 'adv-tampered', 'critical', 'Mentions the state machine guard logic.');
    const story = readStory(p, id);
    const cat = story.riskSignals[0].category;
    story.priorityElevatedFrom = 'high'; // forged: >= high must never trigger a downgrade
    writeStory(p, id, story);
    run(p, 'story_review_dismiss', { storyId: id, category: cat, reason: 'forged marker must not downgrade user critical here' });
    const after = readStory(p, id);
    assert(after.priority === 'critical', `adversarial(tampered>=high): critical must survive, got ${after.priority}`);
  }
  // (b) user-set critical with a GARBAGE priorityElevatedFrom -> no downgrade.
  {
    const p = createProject('koala-risk-adv-garbage-');
    const id = createStory(p, 'adv-garbage', 'critical', 'Mentions the koala validate fixture runner.');
    const story = readStory(p, id);
    const cat = story.riskSignals[0].category;
    story.priorityElevatedFrom = 'not-a-priority'; // invalid value
    writeStory(p, id, story);
    run(p, 'story_review_dismiss', { storyId: id, category: cat, reason: 'garbage marker must not downgrade user critical here' });
    const after = readStory(p, id);
    assert(after.priority === 'critical', `adversarial(garbage): critical must survive, got ${after.priority}`);
  }
  // (c) user-set high, marker MISSING entirely -> no downgrade.
  {
    const p = createProject('koala-risk-adv-missing-');
    const id = createStory(p, 'adv-missing', 'high', 'Mentions the state machine guard logic.');
    const story = readStory(p, id);
    assert(story.priorityElevatedFrom === undefined, 'adversarial(missing): precondition: no marker for user-set high');
    const cat = story.riskSignals[0].category;
    run(p, 'story_review_dismiss', { storyId: id, category: cat, reason: 'no marker present, must not downgrade user high here' });
    const after = readStory(p, id);
    assert(after.priority === 'high', `adversarial(missing): high must survive, got ${after.priority}`);
  }
  console.log('ok adversarial');
}

// === B-30b2 CHK-002: mention-vs-modify guidance is discoverable + honest ===

const STORY_CREATE_GUIDANCE = '若为误报（仅提及未修改），可 koala story_review_dismiss 完整回退';

// CHK-002 happy: a story_create that HITS a riskSignal surfaces the dismiss
// escape hatch on stderr (must contain the exact discoverable phrase + the
// story_review_dismiss command form with the freshly minted storyId).
function scenarioGuidanceHit() {
  const p = createProject('koala-guide-hit-');
  const { stderr, combined } = runCapture(p, 'story_create', {
    name: 'guide-hit',
    title: 'Guide hit',
    description: 'Refactor the state machine guard logic so phase flow is correct.',
    background: background('guide-hit'),
    type: 'feature',
    priority: 'low',
    checklist: [
      { title: 'do the thing', context: 'implement the change.' },
      { title: 'cover it', context: 'add coverage.' },
      { title: 'wire it', context: 'wire the change.' },
    ],
    forceNew: true,
  });
  const id = combined.match(/B-[a-f0-9]+/)?.[0];
  assert(id, `guide-hit: story id not found in: ${combined}`);
  assert(stderr.includes(STORY_CREATE_GUIDANCE), `guide-hit: stderr must contain dismiss guidance, got: ${stderr}`);
  assert(stderr.includes('story_review_dismiss'), `guide-hit: stderr must reference story_review_dismiss command, got: ${stderr}`);
  assert(stderr.includes(id), `guide-hit: dismiss guidance should embed the storyId ${id}, got: ${stderr}`);
  console.log('ok guide-hit');
}

// CHK-002 edge: a story_create that does NOT hit any riskSignal must NOT emit the
// guidance (no false-positive noise on benign stories).
function scenarioGuidanceMiss() {
  const p = createProject('koala-guide-miss-');
  const { stderr, combined } = runCapture(p, 'story_create', {
    name: 'guide-miss',
    title: 'Guide miss',
    description: 'Update the greeting copy in the welcome banner so it reads nicer.',
    background: background('guide-miss'),
    type: 'feature',
    priority: 'low',
    checklist: [
      { title: 'tweak the copy', context: 'edit the banner string.' },
      { title: 'review wording', context: 'confirm tone.' },
    ],
    forceNew: true,
  });
  const id = combined.match(/B-[a-f0-9]+/)?.[0];
  assert(id, `guide-miss: story id not found in: ${combined}`);
  const story = readStory(p, id);
  assert(!story.riskSignals || story.riskSignals.length === 0, `guide-miss: precondition no riskSignals, got ${JSON.stringify(story.riskSignals)}`);
  assert(!stderr.includes(STORY_CREATE_GUIDANCE), `guide-miss: benign story must NOT emit dismiss guidance, got: ${stderr}`);
  assert(!combined.includes(STORY_CREATE_GUIDANCE), `guide-miss: guidance must not appear on any stream, got: ${combined}`);
  console.log('ok guide-miss');
}

// CHK-002 adversarial: the guidance must match CHK-001's ACTUAL behavior, never
// promise more. The story_review advisory must (a) carry the dismiss path and
// (b) the promised "all auto-elevated dismissed -> rollback" must hold while a
// partial dismiss does NOT roll back (claim "仅 dismiss 部分则不回退" is honest).
function scenarioGuidanceHonest() {
  const p = createProject('koala-guide-honest-');
  // Two distinct categories so we can test partial vs full dismiss.
  const id = createStory(p, 'guide-honest', 'low', 'Change the state machine guard logic and also the koala validate fixture runner.');
  let story = readStory(p, id);
  const cats = (story.riskSignals || []).map(r => r.category);
  assert(cats.length >= 2, `guide-honest: expected >=2 categories, got ${JSON.stringify(cats)}`);
  assert(story.priority === 'high' && story.priorityElevatedFrom === 'low', 'guide-honest: precondition auto-elevated');

  // story_review advisory must surface the dismiss escape hatch.
  const review = runCapture(p, 'story_review', { storyId: id });
  assert(/story_review_dismiss/.test(review.combined), `guide-honest: story_review must mention story_review_dismiss, got: ${review.combined}`);
  assert(/提及.*修改|mention/i.test(review.combined), `guide-honest: story_review must explain mention-vs-modify, got: ${review.combined}`);

  // Partial dismiss (one of two) -> NOT rolled back (matches "仅 dismiss 部分则不回退").
  run(p, 'story_review_dismiss', { storyId: id, category: cats[0], reason: 'first category is mention-only here' });
  story = readStory(p, id);
  assert(story.priority === 'high', `guide-honest: partial dismiss must NOT roll back (honest claim), got ${story.priority}`);

  // Full dismiss (all auto-elevated) -> rolled back (matches "全部...自动回退").
  run(p, 'story_review_dismiss', { storyId: id, category: cats[1], reason: 'second category is mention-only here too' });
  story = readStory(p, id);
  assert(story.priority === 'low', `guide-honest: full dismiss must roll back to low (honest claim), got ${story.priority}`);
  assert(story.priorityElevatedFrom === undefined, 'guide-honest: marker cleared after full rollback');
  console.log('ok guide-honest');
}

const scenarios = {
  happy: scenarioHappy,
  'edge-high': scenarioEdgeHigh,
  'edge-critical': scenarioEdgeCritical,
  multi: scenarioMulti,
  adversarial: scenarioAdversarial,
  'guide-hit': scenarioGuidanceHit,
  'guide-miss': scenarioGuidanceMiss,
  'guide-honest': scenarioGuidanceHonest,
};

if (mode === 'all') {
  for (const fn of Object.values(scenarios)) fn();
  console.log('ok all');
} else {
  const fn = scenarios[mode];
  if (!fn) throw new Error(`unknown mode: ${mode}`);
  fn();
}
