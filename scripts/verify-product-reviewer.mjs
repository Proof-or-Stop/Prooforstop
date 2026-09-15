#!/usr/bin/env node

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { strict as nodeAssert } from 'node:assert';
import { ADAPTER_DIR_NAMES } from '../packages/main/dist/core/brand-paths.js';
import { legacyAgentRoleIds } from '../packages/main/dist/core/agent-role-identity.js';
import { blockingInitCheckIssues, initCheckSignatureIsValid } from '../packages/main/dist/core/init-check-gate.js';
import { StoryStore } from '../packages/main/dist/core/store.js';
import { createInitCheckHandlers } from '../packages/main/dist/handlers/init-check.js';
import { buildScopeBoundary } from '../packages/main/dist/core/scope-anti-expansion.js';


const root = process.cwd();
const PRODUCT_REVIEWER_ROLE = 'proof-or-stop-product-reviewer';
const STORY_INIT_REVIEWER_ROLE = 'proof-or-stop-review-story-init';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(args, opts = {}) {
  return execFileSync('node', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
}

function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('no JSON object found in output');
  return JSON.parse(text.slice(start));
}

function resolveSupportedAgentPath(baseDir, roleId) {
  const basenames = [roleId, ...legacyAgentRoleIds(roleId)];
  for (const relativeDir of baseDir) {
    for (const basename of basenames) {
      const path = join(root, relativeDir, 'agents', `${basename}.md`);
      if (existsSync(path)) return path;
    }
  }
  return join(root, baseDir[0], 'agents', `${roleId}.md`);
}

function createTempProject() {
  const dir = mkdtempSync(join(tmpdir(), 'proof-or-stop-product-reviewer-'));
  mkdirSync(join(dir, 'docs', 'story', 'actives'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'requirements'), { recursive: true });
  writeFileSync(join(dir, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: 'docs/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'product-reviewer-smoke'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'product-reviewer-smoke@example.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['add', 'proof-or-stop.config.json'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'fixture: initialize product reviewer project'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

function makeBackground(label) {
  return [
    '## Trigger Event',
    `2026-05-01 B-0000 ${label} verifier needs a realistic story_create input so this smoke tests product-reviewer behavior instead of the background gate.`,
    '## Key Insights',
    'The current CLI treats background as source context, and verifier fixtures must model that contract with enough standalone detail for reviewers.',
    '## Solution Tradeoffs',
    'Keep the temporary project minimal, but provide a full four-section background so the smoke remains focused on product review warnings.',
    '## Conversational Texture',
    'The user-facing concern is that engineering success can still leave an abstract outcome, so this verifier preserves that exact review scenario.',
  ].join('\n\n');
}

const agentPaths = [
  resolveSupportedAgentPath(['.claude'], PRODUCT_REVIEWER_ROLE),
  resolveSupportedAgentPath(ADAPTER_DIR_NAMES, PRODUCT_REVIEWER_ROLE),
];
for (const path of agentPaths) {
  assert(existsSync(path), `missing product-reviewer agent: ${path}`);
  const text = readFileSync(path, 'utf8');
  assert(text.includes('user-visible result') || text.includes('concrete, observable user result'), `${path} missing user-value scope`);
  assert(text.includes('Not modifying code') || text.includes('not modifying code') || text.includes('不修改代码'), `${path} missing non-edit boundary`);
  assert(text.includes('init_check_set') && text.includes('pass') && text.includes('fail'), `${path} missing INIT review recording requirement`);
  assert(text.includes('agentId":"proof-or-stop-product-reviewer') || text.includes('agentId` must be exactly `proof-or-stop-product-reviewer`'), `${path} missing exact product-reviewer agentId requirement`);
  assert(text.includes('implementation has not started') && text.includes('must not require'), 'INIT_PRODUCT_REVIEW_PHASE_CONTRACT: product reviewer must explicitly allow planned evidence before implementation');
  assert(text.includes('unchanged facts'), `${path} missing monotonic blocker-set instruction`);
  assert(!text.includes('story_advance DONE') && !text.includes('live-smoke-transcript.json'), 'INIT_PRODUCT_REVIEW_PHASE_CONTRACT: INIT reviewer must not request post-implementation artifacts');
}

const storyInitAgentPaths = [
  resolveSupportedAgentPath(['.claude'], STORY_INIT_REVIEWER_ROLE),
  resolveSupportedAgentPath(ADAPTER_DIR_NAMES, STORY_INIT_REVIEWER_ROLE),
];
for (const path of storyInitAgentPaths) {
  const text = readFileSync(path, 'utf8');
  assert(text.includes('five dimensions below are exhaustive'), `${path} missing finite story-init authority boundary`);
  assert(text.includes('implementation-defined') && text.includes('requirementRef'), `${path} missing anti-amplification and source-binding rules`);
  assert(text.includes('unchanged facts'), `${path} missing monotonic blocker-set instruction`);
  assert(text.includes('initial_checklist_invalid') && text.includes('existing_system_claim_inaccurate'), `${path} missing role-specific blocker kinds`);
}

const deferredEvidenceIssue = {
  storyId: 'B-phase',
  checkedAt: '2026-09-14T00:00:00.000Z',
  reviewRound: '',
  agentId: PRODUCT_REVIEWER_ROLE,
  issues: [{
    kind: 'post_implementation_evidence_missing',
    severity: 'high',
    desc: 'The implementation transcript does not exist before development begins.',
  }],
  _hash: 'fixture',
};
assert(blockingInitCheckIssues(deferredEvidenceIssue).length === 0, 'INIT_PRODUCT_REVIEW_PHASE_CONTRACT: post-implementation evidence cannot block INIT');

const trueInitIssue = {
  ...deferredEvidenceIssue,
  issues: [{
    kind: 'user_outcome_unspecified',
    severity: 'high',
    desc: 'The Story does not say what observable result the user receives.',
  }],
};
assert(blockingInitCheckIssues(trueInitIssue).length === 1, 'INIT_PRODUCT_REVIEW_PHASE_CONTRACT: genuine INIT product gaps must still block');

const legacyInitIssue = {
  ...deferredEvidenceIssue,
  issues: [{ severity: 'high', desc: 'Legacy signed INIT issue without a kind remains blocking.' }],
};
assert(blockingInitCheckIssues(legacyInitIssue).length === 1, 'INIT_PRODUCT_REVIEW_PHASE_CONTRACT: legacy high issues must remain fail-closed');

const temp = createTempProject();
try {
  const created = run([join(root, 'packages/main/dist/cli.js'), '--root', temp, 'story_create', JSON.stringify({
    name: 'product-reviewer-check',
    title: 'Product reviewer check',
    description: 'tmp',
    background: makeBackground('product-reviewer-check'),
    type: 'chore',
    priority: 'low',
    checklist: [{ title: 'review lane', context: 'tmp context' }],
  })]);
  const storyId = created.match(/B-[a-f0-9]+/)?.[0];
  assert(storyId, 'failed to parse temp story id');

  const directStore = new StoryStore(temp);
  const directHandlers = createInitCheckHandlers({ store: directStore, root: temp, scanRoot: join(temp, 'packages/main') });
  const previousStoryInitAgent = process.env.PROOF_OR_STOP_AGENT;
  process.env.PROOF_OR_STOP_AGENT = 'proof-or-stop-review-story-init';
  try {
    directHandlers.init_check_set({
      storyId,
      issues: [{
        severity: 'high',
        desc: 'Choose exact trace labels and active-load reset transitions before implementation starts.',
      }],
    });
  } finally {
    if (previousStoryInitAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
    else process.env.PROOF_OR_STOP_AGENT = previousStoryInitAgent;
  }
  const outOfBoundaryInitCheck = JSON.parse(readFileSync(join(temp, 'docs', 'story', 'actives', storyId, 'init-check.json'), 'utf8'));
  nodeAssert.equal(
    outOfBoundaryInitCheck.agentResults?.[0]?.issues?.[0]?.severity,
    'medium',
    'LAB_RED: out-of-bound INIT implementation preference must be advisory',
  );
  assert(
    blockingInitCheckIssues(outOfBoundaryInitCheck).length === 0,
    'INIT_REVIEW_AUTHORITY_BOUNDARY: an untyped story-init implementation preference cannot block INIT_CHECK',
  );
  nodeAssert.equal(
    outOfBoundaryInitCheck.agentResults?.[0]?.issues?.[0]?.reportedSeverity,
    'high',
    'INIT_REVIEW_AUTHORITY_BOUNDARY: normalized advisory must preserve the reported severity',
  );
  nodeAssert.equal(
    outOfBoundaryInitCheck.agentResults?.[0]?.issues?.[0]?.dispositionReason,
    'outside_init_reviewer_blocking_authority',
    'INIT_REVIEW_AUTHORITY_BOUNDARY: normalized advisory must state why it cannot block',
  );

  const storyAfterAdvisory = directStore.readStory(storyId);
  directStore.writeStory(storyId, {
    ...storyAfterAdvisory,
    description: `${storyAfterAdvisory.description} The authoritative checklist requirement changed before the next review.`,
  });

  process.env.PROOF_OR_STOP_AGENT = 'proof-or-stop-review-story-init';
  try {
    directHandlers.init_check_set({
      storyId,
      issues: [{
        kind: 'initial_checklist_invalid',
        requirementRef: 'checklist:CHK-001',
        severity: 'high',
        desc: 'The named checklist item is mechanically invalid.',
      }],
    });
  } finally {
    if (previousStoryInitAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
    else process.env.PROOF_OR_STOP_AGENT = previousStoryInitAgent;
  }
  const inBoundaryInitCheck = JSON.parse(readFileSync(join(temp, 'docs', 'story', 'actives', storyId, 'init-check.json'), 'utf8'));
  assert(
    blockingInitCheckIssues(inBoundaryInitCheck).length === 1,
    'INIT_REVIEW_AUTHORITY_BOUNDARY: source-bound structural story-init defects must remain blocking',
  );

  const previousAgent = process.env.PROOF_OR_STOP_AGENT;
  process.env.PROOF_OR_STOP_AGENT = PRODUCT_REVIEWER_ROLE;
  try {
    nodeAssert.throws(() => directHandlers.init_check_set({
      storyId,
      issues: [{ kind: 'bogus', severity: 'high', desc: 'Unknown kinds must be rejected after bypassing Zod.' }],
    }), /init_check_set: unsupported issue\.kind/, 'INIT_PRODUCT_REVIEW_PHASE_CONTRACT: init_check_set runtime must reject unknown kinds');
  } finally {
    if (previousAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
    else process.env.PROOF_OR_STOP_AGENT = previousAgent;
  }
  process.env.PROOF_OR_STOP_AGENT = PRODUCT_REVIEWER_ROLE;
  try {
    directHandlers.init_check_set({
      storyId,
      issues: [{
        kind: 'requirements_ambiguous',
        severity: 'high',
        desc: 'Choose a more exact internal trace format before implementation.',
      }],
    });
  } finally {
    if (previousAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
    else process.env.PROOF_OR_STOP_AGENT = previousAgent;
  }
  const unboundProductCheck = JSON.parse(readFileSync(join(temp, 'docs', 'story', 'actives', storyId, 'init-check.json'), 'utf8'));
  const productResult = unboundProductCheck.agentResults?.find(result => result.agentId === PRODUCT_REVIEWER_ROLE);
  nodeAssert.equal(productResult?.issues?.[0]?.severity, 'medium', 'INIT_REVIEW_AUTHORITY_BOUNDARY: unbound product-reviewer high issue must be advisory');

  process.env.PROOF_OR_STOP_AGENT = PRODUCT_REVIEWER_ROLE;
  try {
    directHandlers.init_check_set({ storyId, issues: [] });
    directHandlers.init_check_set({
      storyId,
      issues: [{
        kind: 'user_outcome_unspecified',
        requirementRef: 'story:description',
        severity: 'high',
        desc: 'The Story description does not identify an observable user outcome.',
      }],
    });
  } finally {
    if (previousAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
    else process.env.PROOF_OR_STOP_AGENT = previousAgent;
  }
  const unchangedExpansionCheck = JSON.parse(readFileSync(join(temp, 'docs', 'story', 'actives', storyId, 'init-check.json'), 'utf8'));
  const unchangedExpansionResult = unchangedExpansionCheck.agentResults?.find(result => result.agentId === PRODUCT_REVIEWER_ROLE);
  nodeAssert.equal(
    unchangedExpansionResult?.issues?.[0]?.severity,
    'medium',
    'INIT_REVIEW_MONOTONICITY: PASS cannot become a new high blocker when authoritative INIT inputs are unchanged',
  );
  nodeAssert.equal(
    unchangedExpansionResult?.issues?.[0]?.dispositionReason,
    'unchanged_input_blocker_expansion',
    'INIT_REVIEW_MONOTONICITY: unchanged-input blocker expansion must preserve a machine-owned disposition',
  );

  directStore.writeScopeBoundary(storyId, buildScopeBoundary({
    storyId,
    mode: 'feature',
    allowed: ['Changed authoritative scope boundary'],
    excluded: ['Unrelated behavior'],
    confirmedBy: 'product-reviewer-smoke',
    confirmationNote: 'Change a blocker-citable source that is outside the legacy INIT signature components.',
    now: '2026-09-15T00:00:00.000Z',
  }));
  process.env.PROOF_OR_STOP_AGENT = PRODUCT_REVIEWER_ROLE;
  try {
    directHandlers.init_check_set({
      storyId,
      issues: [{
        kind: 'scope_or_safety_boundary_missing',
        requirementRef: 'scope-boundary',
        severity: 'high',
        desc: 'The changed authoritative scope boundary introduces a blocking ambiguity.',
      }],
    });
  } finally {
    if (previousAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
    else process.env.PROOF_OR_STOP_AGENT = previousAgent;
  }
  const changedScopeCheck = JSON.parse(readFileSync(join(temp, 'docs', 'story', 'actives', storyId, 'init-check.json'), 'utf8'));
  const changedScopeResult = changedScopeCheck.agentResults?.find(result => result.agentId === PRODUCT_REVIEWER_ROLE);
  nodeAssert.equal(changedScopeResult?.issues?.[0]?.severity, 'high', 'INIT_REVIEW_MONOTONICITY: changed scope-boundary input permits a newly discovered source-bound blocker');

  process.env.PROOF_OR_STOP_AGENT = PRODUCT_REVIEWER_ROLE;
  try {
    directHandlers.init_check_set({ storyId, issues: [] });
  } finally {
    if (previousAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
    else process.env.PROOF_OR_STOP_AGENT = previousAgent;
  }
  const changedChecklist = directStore.readChecklist(storyId);
  directStore.writeChecklist(storyId, {
    ...changedChecklist,
    items: changedChecklist.items.map((item, index) => index === 0 ? {
      ...item,
      verificationIntent: {
        happy: [{ id: 'INT-CHANGED', desc: 'Changed verification plan must execute.', type: 'cli', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story' }],
        edge: [],
        adversarial: [],
      },
    } : item),
  });
  process.env.PROOF_OR_STOP_AGENT = PRODUCT_REVIEWER_ROLE;
  try {
    directHandlers.init_check_set({
      storyId,
      issues: [{
        kind: 'verification_plan_unexecutable',
        requirementRef: 'verification-intent:INT-CHANGED',
        severity: 'high',
        desc: 'The changed verification intent cannot be executed as written.',
      }],
    });
  } finally {
    if (previousAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
    else process.env.PROOF_OR_STOP_AGENT = previousAgent;
  }
  const changedIntentCheck = JSON.parse(readFileSync(join(temp, 'docs', 'story', 'actives', storyId, 'init-check.json'), 'utf8'));
  const changedIntentResult = changedIntentCheck.agentResults?.find(result => result.agentId === PRODUCT_REVIEWER_ROLE);
  nodeAssert.equal(changedIntentResult?.issues?.[0]?.severity, 'high', 'INIT_REVIEW_MONOTONICITY: changed verificationIntent permits a newly discovered source-bound blocker');

  const changedStory = directStore.readStory(storyId);
  directStore.writeStory(storyId, {
    ...changedStory,
    description: `${changedStory.description} The authoritative user outcome changed after the previous review.`,
  });

  process.env.PROOF_OR_STOP_AGENT = PRODUCT_REVIEWER_ROLE;
  try {
    directHandlers.init_check_set({
      storyId,
      issues: [{
        kind: 'user_outcome_unspecified',
        requirementRef: 'story:description',
        severity: 'high',
        desc: 'The Story description does not identify an observable user outcome.',
      }],
    });
  } finally {
    if (previousAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
    else process.env.PROOF_OR_STOP_AGENT = previousAgent;
  }
  const boundProductCheck = JSON.parse(readFileSync(join(temp, 'docs', 'story', 'actives', storyId, 'init-check.json'), 'utf8'));
  const boundProductResult = boundProductCheck.agentResults?.find(result => result.agentId === PRODUCT_REVIEWER_ROLE);
  nodeAssert.equal(boundProductResult?.issues?.[0]?.severity, 'high', 'INIT_REVIEW_AUTHORITY_BOUNDARY: source-bound product defect must retain high severity');
  assert(blockingInitCheckIssues(boundProductCheck).length >= 1, 'INIT_REVIEW_AUTHORITY_BOUNDARY: source-bound product defect must block INIT_CHECK');
  nodeAssert.throws(() => directHandlers.init_check_repair({
    storyId,
    acknowledge: true,
    fallbackReason: 'The test directly exercises the runtime fallback validation boundary.',
    issues: [{ kind: 'bogus', severity: 'high', desc: 'Unknown fallback kinds must be rejected after bypassing Zod.' }],
  }), /init_check_repair: unsupported issue\.kind/, 'INIT_PRODUCT_REVIEW_PHASE_CONTRACT: init_check_repair runtime must reject unknown kinds');
  assert(blockingInitCheckIssues({ issues: [{ kind: 'bogus', severity: 'high', desc: 'Unknown persisted kinds remain blocking.' }] }).length === 1, 'INIT_PRODUCT_REVIEW_PHASE_CONTRACT: unknown persisted kinds must remain fail-closed');

  const readOnlyPrompt = run([join(root, 'packages/main/dist/cli.js'), '--root', temp, 'agent_prompt', JSON.stringify({
    role: PRODUCT_REVIEWER_ROLE,
    storyId,
    readOnly: true,
    format: 'text',
  })]);
  assert(readOnlyPrompt.includes('implementation has not started') && readOnlyPrompt.includes('must not require'), 'INIT_PRODUCT_REVIEW_PHASE_CONTRACT: read-only prompt must explain the INIT evidence boundary');
  assert(readOnlyPrompt.includes('implementation-defined') && readOnlyPrompt.includes('requirementRef'), 'INIT_REVIEW_AUTHORITY_BOUNDARY: product reviewer prompt must forbid requirement amplification and require source binding');
  assert(!readOnlyPrompt.includes('story_advance DONE') && !readOnlyPrompt.includes('live-smoke-transcript.json'), 'INIT_PRODUCT_REVIEW_PHASE_CONTRACT: read-only prompt must not request post-implementation artifacts');

  const dispatchRaw = run([join(root, 'packages/main/dist/cli.js'), '--root', temp, 'dispatch', JSON.stringify({
    storyId,
    agentType: PRODUCT_REVIEWER_ROLE,
  })]);
  assert(dispatchRaw.includes('proof-or-stop-product-reviewer'), 'product-reviewer dispatch should identify the canonical reviewer role');
  assert(dispatchRaw.includes('"agentId":"proof-or-stop-product-reviewer"') || dispatchRaw.includes('\\"agentId\\":\\"proof-or-stop-product-reviewer\\"'), 'product-reviewer dispatch should include exact canonical agentId command');
  assert(dispatchRaw.includes('Do not pass "proof-or-stop-review-story-init"') || dispatchRaw.includes('Do not pass \\"proof-or-stop-review-story-init\\"'), 'product-reviewer dispatch should warn against wrong init reviewer agentId');
  assert(dispatchRaw.includes('implementation has not started') && dispatchRaw.includes('must not require'), 'INIT_PRODUCT_REVIEW_PHASE_CONTRACT: dispatch must explain implementation evidence is unavailable during INIT');
  assert(dispatchRaw.includes('implementation-defined') && dispatchRaw.includes('requirementRef'), 'INIT_REVIEW_AUTHORITY_BOUNDARY: product dispatch must preserve requirement-amplification and source-binding rules');
  assert(!dispatchRaw.includes('story_advance DONE') && !dispatchRaw.includes('live-smoke-transcript.json'), 'INIT_PRODUCT_REVIEW_PHASE_CONTRACT: dispatch must not request post-implementation artifacts');

  process.env.PROOF_OR_STOP_AGENT = 'proof-or-stop-review-story-init';
  try {
    directHandlers.init_check_set({ storyId, issues: [] });
  } finally {
    if (previousStoryInitAgent === undefined) delete process.env.PROOF_OR_STOP_AGENT;
    else process.env.PROOF_OR_STOP_AGENT = previousStoryInitAgent;
  }

  run([join(root, 'packages/main/dist/cli.js'), '--root', temp, 'init_check_set', JSON.stringify({
    storyId,
    agentId: PRODUCT_REVIEWER_ROLE,
    issues: [{
      kind: 'post_implementation_evidence_missing',
      severity: 'high',
      desc: 'The implementation transcript does not exist before development begins.',
    }],
  })]);
  const storedInitCheck = JSON.parse(readFileSync(join(temp, 'docs', 'story', 'actives', storyId, 'init-check.json'), 'utf8'));
  const storedProductResult = storedInitCheck.agentResults?.find(result => result.agentId === PRODUCT_REVIEWER_ROLE);
  assert(storedProductResult?.issues?.[0]?.kind === 'post_implementation_evidence_missing', 'INIT_PRODUCT_REVIEW_PHASE_CONTRACT: init_check_set must persist structured stage applicability');
  assert(blockingInitCheckIssues(storedInitCheck).length === 0, 'INIT_PRODUCT_REVIEW_PHASE_CONTRACT: stored post-implementation evidence cannot block INIT');
  assert(initCheckSignatureIsValid(storyId, new StoryStore(temp), temp, storedInitCheck), 'INIT_PRODUCT_REVIEW_PHASE_CONTRACT: stored issue kind must have a valid signature');
  const tamperedKind = structuredClone(storedInitCheck);
  tamperedKind.agentResults.find(result => result.agentId === PRODUCT_REVIEWER_ROLE).issues[0].kind = 'user_outcome_unspecified';
  assert(!initCheckSignatureIsValid(storyId, new StoryStore(temp), temp, tamperedKind), 'INIT_PRODUCT_REVIEW_PHASE_CONTRACT: changing issue kind must invalidate the signature');

  run([join(root, 'packages/main/dist/cli.js'), '--root', temp, 'understanding_set', JSON.stringify({
    storyId,
    task: '验证 product-reviewer advisory',
    outcome: '链路打通，事件触发，机制闭环。',
    facts: ['tmp fact'],
    constraints: ['tmp constraint'],
    unknowns: [],
    touchpoints: ['packages/main/src/handlers/story-review.ts'],
  })]);

  run([join(root, 'packages/main/dist/cli.js'), '--root', temp, 'checklist_update', JSON.stringify({
    storyId,
    itemId: 'CHK-001',
    verificationIntent: {
      happy: [{ desc: 'Normal scenario -> product acceptance reminder', type: 'cli_blackbox', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story' }],
      edge: [{ desc: 'Abstract outcome -> emit advisory', type: 'cli_blackbox', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story' }],
      adversarial: [{ desc: 'Engineering complete but user still asks what comes next -> expose gap', type: 'cli_blackbox', scope: 'focused', expectation: 'absolute_pass', requirementSource: 'story' }],
    },
    agent: 'proof-or-stop-verification-intent',
  })]);

  const reviewRaw = run([join(root, 'packages/main/dist/cli.js'), '--root', temp, 'story_review', JSON.stringify({ storyId })]);
  const review = extractJsonObject(reviewRaw);
  assert(review.summary && typeof review.summary.issueCount === 'number', 'story_review should return structured summary');

  const dispatchSource = readFileSync(join(root, 'packages/main/src/handlers/story-dispatch.ts'), 'utf8');
  assert(dispatchSource.includes('user value perspective') && dispatchSource.includes('verificationIntent'), 'product reviewer planned user-value guidance missing');
  assert(!dispatchSource.includes('Whether there are high-risk signals but insufficient PLAN/decision/verification preparation'), 'INIT_REVIEW_AUTHORITY_BOUNDARY: story-init dispatch must not review PLAN preparation');
  assert(dispatchSource.includes('the five dimensions in the canonical role prompt') && dispatchSource.includes('Out-of-authority or unbound critical/high reports are stored as advisory'), 'INIT_REVIEW_AUTHORITY_BOUNDARY: story-init dispatch must state its complete blocking authority');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log('product reviewer verified');
