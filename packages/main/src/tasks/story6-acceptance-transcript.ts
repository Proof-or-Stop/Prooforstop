import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetConfigCache } from '../core/config.js';
import { canonicalJsonStringify } from '../core/prompt-contracts.js';
import { verifyPromptEnvelopeIntegrity } from '../core/prompt-envelope.js';
import {
  ACTIVE_MODULAR_COMPLEX_ROLE_IDS,
  PROMPT_ENVELOPE_ROLLOUT_VERSION,
  resolvePromptRoleBody,
} from '../core/prompt-role-contract-registry.js';
import {
  BUDGETED_COMPLEX_ROLE_IDS,
  COMPLEX_ROLE_PROMPT_BUDGETS,
  observeComplexRolePromptBudget,
} from '../core/prompt-budget.js';
import { StoryStore } from '../core/store.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { createAgentPromptHandlers } from '../handlers/agent-prompt.js';

const CAMPAIGN_ID = 'story6-20260721-v3';
const SUMMARY_PATH = 'experiments/role-prompt-ab-replay/story6-20260721-v3-summary.json';
const RUNTIME_DIR = 'experiments/role-prompt-ab-replay/runtime/story6';
const ADJUDICATION_PATH = `${RUNTIME_DIR}/${CAMPAIGN_ID}.independent-adjudication.json`;
const roles = [...ACTIVE_MODULAR_COMPLEX_ROLE_IDS];

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function git(store: StoryStore, storyId: string, projectRoot: string, args: string[]): string {
  const gitCwd = resolveGitCwd({ store, storyId, metadataRoot: projectRoot, projectRoot });
  return execFileSync('git', args, {
    cwd: gitCwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Story 6 Acceptance',
      GIT_AUTHOR_EMAIL: 'story6-acceptance@example.invalid',
      GIT_COMMITTER_NAME: 'Story 6 Acceptance',
      GIT_COMMITTER_EMAIL: 'story6-acceptance@example.invalid',
    },
  }).trim();
}

function availability(rows: any[], metric: string): 'available' | 'INCONCLUSIVE' {
  const observations = rows.map(row => row.metrics?.[metric]);
  assert.ok(observations.length > 0, `tracked summary is missing ${metric} observations`);
  return observations.every(metricRow => (
    Number.isSafeInteger(metricRow?.availableCount)
      && metricRow.availableCount > 0
      && metricRow.unavailableCount === 0
  )) ? 'available' : 'INCONCLUSIVE';
}

function assertAuditBudgetBinding(role: string, response: any, event: any): any {
  assert.ok(response?.promptBudget, `${role} audit response is missing promptBudget`);
  assert.ok(event?.promptBudget, `${role} persisted audit event is missing promptBudget`);
  assert.equal(response.promptBudget.bytes, response.envelope.bytes);
  assert.equal(response.promptBudget.estimatedTokens, response.envelope.estimatedTokens);
  assert.equal(response.promptBudget.limitBytes, COMPLEX_ROLE_PROMPT_BUDGETS.fullBytes);
  const recomputed = observeComplexRolePromptBudget({
    roleId: role,
    contextMode: 'full',
    bytes: response.envelope.bytes,
    estimatedTokens: response.envelope.estimatedTokens,
  });
  assert.deepEqual(response.promptBudget, recomputed);
  assert.deepEqual(event.promptBudget, recomputed);
  return recomputed;
}

const transcript: string[] = [];
const root = mkdtempSync(join(tmpdir(), 'story6-acceptance-transcript-'));
try {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: '.', rootDir: '.', testsDir: 'tests', fixturesDir: 'tests/fixtures',
    storyDir: '.proof-or-stop/story/actives', requirementsDir: 'docs/requirements',
    promptEnvelope: {
      version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
      roles: Object.fromEntries(roles.map(role => [role, 'legacy-full-context'])),
    },
  }, null, 2));
  resetConfigCache();

  const store = new StoryStore(root);
  const storyId = 'B-story6-acceptance';
  const baseStory = {
    storyId, name: storyId, title: 'Story 6 acceptance transcript',
    description: 'Real production dispatch acceptance.', type: 'feature', phase: 'DEV', priority: 'high',
    createdAt: '2026-07-21T05:00:00.000Z', startedAt: '2026-07-21T05:00:00.000Z', endedAt: null, events: [],
  };
  store.writeStory(storyId, baseStory as never);
  store.writeChecklist(storyId, { items: [{
    id: 'CHK-001', title: 'Exercise Story 6', context: 'real production entrypoint', status: 'in_progress', relatedDocs: [],
    files: { modify: [], create: [], test: [] }, verificationIntent: { happy: [], edge: [], adversarial: [] },
  }] } as never);
  git(store, storyId, root, ['init', '-b', 'main']);
  git(store, storyId, root, ['config', 'user.email', 'story6-acceptance@example.invalid']);
  git(store, storyId, root, ['config', 'user.name', 'Story 6 Acceptance']);
  git(store, storyId, root, ['add', '.']);
  git(store, storyId, root, ['commit', '-m', 'acceptance fixture']);

  const handlers = createAgentPromptHandlers({ root, scanRoot: root, store });
  for (const role of roles) {
    const legacy = resolvePromptRoleBody(role, {
      version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
      roles: { [role]: 'legacy-full-context' },
    });
    const defaultPrompt = handlers.agent_prompt({ role, storyId, format: 'json' });
    assert.equal(defaultPrompt, legacy.body, `${role} production default must remain exact legacy bytes`);
    transcript.push(
      `PRODUCTION_DEFAULT role=${role} rollout=legacy-full-context exactLegacyBinding=true`
      + ` roleBodyDigest=${legacy.bodyDigest}`,
    );

    const response = JSON.parse(handlers.agent_prompt({
      role, storyId, format: 'json', auditExperiment: true,
      experimentalModeOverride: 'full-envelope',
    }));
    assert.equal(response.mode, 'full-envelope');
    assert.equal(response.auditOnly, true);
    assert.equal(response.canMintReviewEvidence, false);
    assert.equal(response.envelope.roleId, role);
    assert.equal(response.envelope.dispatchKind, 'story-dispatch');
    assert.equal(verifyPromptEnvelopeIntegrity(response.envelope), true);
    assert.equal(
      verifyPromptEnvelopeIntegrity({ ...response.envelope, contextDigest: '0'.repeat(64) }),
      false,
      'a falsified context digest must fail before transcript emission',
    );
    const persisted = store.readPromptEnvelopes(storyId).envelopes.find(
      envelope => envelope.envelopeId === response.envelope.envelopeId,
    );
    assert.ok(persisted && verifyPromptEnvelopeIntegrity(persisted));
    const event: any = store.readProcessEvents(storyId).find(candidate => (
      candidate.promptEnvelopeId === response.envelope.envelopeId
    ));
    assert.equal(event?.targetKind, 'story-dispatch');
    assert.equal(event?.promptEnvelopeDigest, response.envelope.contextDigest);
    assert.equal(event?.assembledPromptDigest, response.envelope.assembledPromptDigest);
    transcript.push(
      `AUDIT_DISPATCH role=${role} rollout=${response.mode} auditOnly=${response.auditOnly}`
      + ` canMintReviewEvidence=${response.canMintReviewEvidence} dispatchKind=${response.envelope.dispatchKind}`
      + ` envelopeId=${response.envelope.envelopeId} envelopeDigest=${response.envelope.contextDigest}`
      + ` assembledPromptDigest=${response.envelope.assembledPromptDigest} persisted=true`,
    );

    if ((BUDGETED_COMPLEX_ROLE_IDS as readonly string[]).includes(role)) {
      const budget = assertAuditBudgetBinding(role, response, event);
      assert.equal(budget.withinBudget, true);
      assert.equal(budget.violation, 'none');
      assert.equal(budget.correctnessExecution, 'continue-full');
      assert.equal(budget.baselineAccepted, true);
      assert.equal(event?.budgetViolation, undefined);
      transcript.push(
        `AUDIT_BUDGET role=${role} observation=within bytes=${budget.bytes}`
        + ` estimatedTokens=${budget.estimatedTokens} limitBytes=${budget.limitBytes}`
        + ' budgetViolation=none fullExecuted=true baselineAccepted=true auditOnly=true canMintReviewEvidence=false',
      );
      if (role === BUDGETED_COMPLEX_ROLE_IDS[0]) {
        assert.throws(() => assertAuditBudgetBinding(role, { ...response, promptBudget: undefined }, event));
        assert.throws(() => assertAuditBudgetBinding(role, {
          ...response, promptBudget: { ...response.promptBudget, bytes: response.promptBudget.bytes + 1 },
        }, event));
        assert.throws(() => assertAuditBudgetBinding(role, {
          ...response, promptBudget: { ...response.promptBudget, estimatedTokens: response.promptBudget.estimatedTokens + 1 },
        }, event));
        assert.throws(() => assertAuditBudgetBinding(role, {
          ...response, promptBudget: { ...response.promptBudget, limitBytes: response.promptBudget.limitBytes + 1 },
        }, event));
        assert.throws(() => assertAuditBudgetBinding(role, response, { ...event, promptBudget: undefined }));
        assert.throws(() => assertAuditBudgetBinding(role, response, {
          ...event, promptBudget: { ...event.promptBudget, bytes: event.promptBudget.bytes + 1 },
        }));
      }
    } else {
      assert.equal(response.promptBudget, undefined, 'evaluator is not budgeted before Story 7');
    }
  }

  store.writeStory(storyId, {
    ...baseStory,
    description: `Force a real over-limit full context without suppressing execution.\n${'x'.repeat(55_000)}`,
  } as never);
  const overResponse = JSON.parse(handlers.agent_prompt({
    role: 'proof-or-stop-implementer', storyId, format: 'json', auditExperiment: true,
    experimentalModeOverride: 'full-envelope',
  }));
  const overPersisted = store.readPromptEnvelopes(storyId).envelopes.find(
    envelope => envelope.envelopeId === overResponse.envelope.envelopeId,
  );
  const overEvent = store.readProcessEvents(storyId).find(
    event => event.promptEnvelopeId === overResponse.envelope.envelopeId,
  );
  assert.ok(overPersisted && verifyPromptEnvelopeIntegrity(overPersisted));
  const overBudget = assertAuditBudgetBinding('proof-or-stop-implementer', overResponse, overEvent);
  assert.equal(overBudget.withinBudget, false);
  assert.equal(overBudget.violation, 'complex-role-budget');
  assert.equal(overBudget.correctnessExecution, 'continue-full');
  assert.equal(overBudget.baselineAccepted, false);
  assert.equal(overEvent?.budgetViolation, 'full');
  transcript.push(
    `AUDIT_BUDGET role=proof-or-stop-implementer observation=over-limit bytes=${overBudget.bytes}`
    + ` estimatedTokens=${overBudget.estimatedTokens} limitBytes=${overBudget.limitBytes}`
    + ' budgetViolation=full'
    + ' fullExecuted=true baselineAccepted=false auditOnly=true canMintReviewEvidence=false',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
  resetConfigCache();
}

const reportVerification = execFileSync('node', [
  'experiments/role-prompt-ab-replay/story6-report.mjs',
  `--campaign-id=${CAMPAIGN_ID}`,
  `--adjudication=${ADJUDICATION_PATH}`,
  `--runtime-dir=${RUNTIME_DIR}`,
  `--verify=${SUMMARY_PATH}`,
], { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
assert.match(reportVerification, /story6-report: VERIFIED/);

const summary = JSON.parse(readFileSync(SUMMARY_PATH, 'utf8'));
assert.equal(summary.campaignId, CAMPAIGN_ID);
assert.equal(summary.status, 'INCONCLUSIVE');
assert.equal(summary.baselineAccepted, false);
assert.equal(summary.story7?.implemented, false);
assert.equal(summary.adjudication?.recall?.legacy?.detected, 24);
assert.equal(summary.adjudication?.recall?.modular?.detected, 20);
assert.equal(summary.adjudication?.falsePositive?.legacy, 0);
assert.equal(summary.adjudication?.falsePositive?.modular, 1);
assert.equal(summary.receiptSet?.count, 72);

const receiptByCell = new Map<string, any>();
for (const receipt of summary.receiptSet.receipts) {
  const raw = readFileSync(join(RUNTIME_DIR, `${CAMPAIGN_ID}.${receipt.cellId}.json`));
  assert.equal(sha256(raw), receipt.sha256, `tracked receipt hash mismatch: ${receipt.cellId}`);
  const row = JSON.parse(raw.toString('utf8'));
  assert.equal(row.campaignId, CAMPAIGN_ID);
  assert.equal(row.cell.cellId, receipt.cellId);
  assert.match(row.promptDigest, /^[a-f0-9]{64}$/);
  receiptByCell.set(receipt.cellId, row);
}
assert.equal(receiptByCell.size, 72);

for (const role of roles) {
  const roleRows = [...receiptByCell.values()].filter(row => row.cell.roleId === role);
  const digestFor = (arm: 'legacy' | 'modular') => sha256(canonicalJsonStringify(
    roleRows
      .filter(row => row.cell.arm === arm)
      .map(row => ({ cellId: row.cell.cellId, promptDigest: row.promptDigest }))
      .sort((a, b) => a.cellId.localeCompare(b.cellId)),
  ));
  const legacyPromptDigest = digestFor('legacy');
  const modularPromptDigest = digestFor('modular');
  assert.notEqual(legacyPromptDigest, modularPromptDigest);
  const usageRows = summary.usageAggregates.filter((row: any) => row.roleId === role);
  const providerUsage = availability(usageRows, 'inputTokens');
  const cache = availability(usageRows, 'cacheReadInputTokens') === 'available'
    && availability(usageRows, 'cacheCreationInputTokens') === 'available'
    ? 'available'
    : 'INCONCLUSIVE';
  const latency = availability(usageRows, 'latencyMs');
  transcript.push(
    `CAMPAIGN role=${role} legacyPromptDigest=${legacyPromptDigest} modularPromptDigest=${modularPromptDigest}`
    + ` providerUsage=${providerUsage} cache=${cache} latency=${latency}`
    + ' receipt=valid status=INCONCLUSIVE baselineAccepted=false',
  );
}
transcript.push(
  `CAMPAIGN id=${CAMPAIGN_ID} receiptSet=valid receipts=${receiptByCell.size}`
  + ' result=INCONCLUSIVE baselineAccepted=false legacyRecall=24/24 modularRecall=20/24'
  + ' legacyFalsePositive=0 modularFalsePositive=1 story7=false',
);

const invariantOutput = execFileSync('node', ['packages/main/dist/tasks/story6-invariants-smoke.js'], {
  cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});
assert.match(invariantOutput, /story6-invariants-smoke: PASS/);
const reasonMatch = invariantOutput.match(/story6-invariant-reasons: (\{[^\n]+\})/);
assert.ok(reasonMatch, 'real invariant task must emit machine-readable consumer reasons');
const reasons = JSON.parse(reasonMatch[1]);
assert.deepEqual(reasons, {
  signature: 'invalid_evidence_signature',
  scope: 'missing_scope_binding',
  authority: 'agent_dispatch_mutation_denied',
  delivery: 'missing_delivery_check',
  evaluator: 'missing_eval_evidence',
});
const behaviorMatch = invariantOutput.match(/story6-invariant-behavior: (\{[^\n]+\})/);
assert.ok(behaviorMatch, 'real invariant task must emit machine-readable consumer behavior');
const behavior = JSON.parse(behaviorMatch[1]);
assert.deepEqual(behavior.reviewCredit, {
  reviewCredit: 'zero', validPasses: 0, validFindings: 0,
  positiveControlValidPasses: 1, source: 'collectReviewerEvidenceState',
});
assert.deepEqual(behavior.wrongAuthor, {
  status: 'fail', dispatchEvidence: 'missing', source: 'checkCommitAuthor',
});
transcript.push(
  'INVARIANTS complex-role-invariants=PASS'
  + ` signature=${reasons.signature} authority=${reasons.authority}`
  + ' contextIntegrity=rejected contextSource=verifyPromptEnvelopeIntegrity'
  + ` reviewCredit=${behavior.reviewCredit.reviewCredit} validPasses=${behavior.reviewCredit.validPasses}`
  + ` validFindings=${behavior.reviewCredit.validFindings}`
  + ` reviewCreditSource=${behavior.reviewCredit.source}`
  + ` positiveControlValidPasses=${behavior.reviewCredit.positiveControlValidPasses}`
  + ` wrongAuthorStatus=${behavior.wrongAuthor.status}`
  + ` wrongAuthorDispatchEvidence=${behavior.wrongAuthor.dispatchEvidence}`
  + ` wrongAuthorSource=${behavior.wrongAuthor.source}`
  + ` evaluator=${reasons.evaluator} delivery=${reasons.delivery} scope=${reasons.scope}`,
);

assert.equal(transcript.filter(line => line.startsWith('PRODUCTION_DEFAULT ')).length, roles.length);
assert.equal(transcript.filter(line => line.startsWith('AUDIT_DISPATCH ')).length, roles.length);
assert.equal(transcript.filter(line => line.startsWith('CAMPAIGN role=')).length, roles.length);
assert.ok(transcript.every(line => !/undefined|null/.test(line)), 'acceptance transcript cannot print missing claims');
for (const line of transcript) console.log(line);
console.log('story6-acceptance-audit-transcript: PASS (production defaults, audit dispatches/budgets, tracked campaign, and invariant consumers)');
