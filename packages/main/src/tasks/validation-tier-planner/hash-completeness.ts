import assert from 'node:assert/strict';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';


import { type StoryRelevanceInput } from '../../core/validation-relevance-input.js';
import { captureEvidenceHashSnapshot, type EvidenceHashSnapshot } from '../../core/evidence-freshness.js';
import type { StoryInfo } from '../../core/types.js';


import { VALIDATION_WIDENING_REASONS, resolveValidationTierPlan, validationWideningReasonGloss } from '../../core/validation-tier-planner.js';

import { assertValidationPlanStatusInvariant } from '../../handlers/validation-plan.js';
import type { HandlerContext } from '../../handlers/context.js';





import { resetConfigCache } from '../../core/config.js';
import { StoryStore } from '../../core/store.js';





import { beginSection, EVIDENCE_DIGEST_NAMES, EvidenceDigestName, testCase, collect, statusReader, snapshotWithout, hashEscalationDetail, FIXTURE_HEAD_SNAPSHOT, planFor, reasonCodes, planInput, planCliRoot, planCli, PLAN_CLI_STORY_ID, escalationCodes, temporaryRoots, writeFixtureFile, fixtureGit, gitOutputIn } from "./support.js";
export function runHashCompleteness(): void {


// ---------------------------------------------------------------------------
// B-a745 F-022 (Codex cross-host review round 3) — AN INCOMPLETE HASH SNAPSHOT
// IS NOT AN AVAILABLE ONE.
//
// `captureEvidenceHashSnapshot` never throws for a git or hash failure: it
// OMITS `headHash` / `materialHash` / `storyFilesHash` and returns the rest. The
// collector used to mark every RETURNED snapshot `available` and classified only
// the thrown path, so a non-git directory, an unborn repository (git init, zero
// commits) or a failed hash read produced an "available" snapshot whose three
// bindings were null, no `hash_snapshot_unavailable` escalation, and a plan that
// never disclosed it had bound nothing. The Story's honesty property is that a
// plan either binds freshness or SAYS it could not; these cases hold every layer
// to it: the collector classifies, the planner escalates and re-validates, and
// the CLI report carries the binding and refuses a plan that claims one it does
// not have.
// ---------------------------------------------------------------------------

beginSection('B-a745 F-022 incomplete hash snapshot cases');


for (const missing of [['headHash'], ['materialHash'], ['storyFilesHash'], EVIDENCE_DIGEST_NAMES] as EvidenceDigestName[][]) {
  testCase(`F-022: a returned snapshot missing ${missing.join(' + ')} is hash_snapshot_unavailable and the detail names it`, () => {
    const input = collect({ readers: { changedFileStatuses: statusReader({}), hashSnapshot: snapshotWithout(missing) } });
    assert.equal(
      input.hashes.status,
      'hash_snapshot_unavailable',
      `a snapshot without ${missing.join(', ')} binds nothing and must not be labelled available`,
    );
    assert.ok(
      input.escalations.some((entry) => entry.code === 'hash_snapshot_unavailable'),
      'the missing binding must be a classified escalation, not a silent null',
    );
    const detail = hashEscalationDetail(input);
    for (const name of EVIDENCE_DIGEST_NAMES) {
      assert.equal(
        detail.includes(name),
        missing.includes(name),
        `the detail must name exactly the missing digest(s) ${missing.join(', ')}; got: ${detail}`,
      );
    }
    // The thrown path is unchanged and still distinguishable: it carries the raw error.
    assert.ok(input.hashes.status === 'hash_snapshot_unavailable' && typeof input.hashes.error === 'string');
  });
}


testCase('F-022: the thrown-reader path is still classified exactly as before', () => {
  const input = collect({
    readers: {
      changedFileStatuses: statusReader({}),
      hashSnapshot: () => {
        throw new Error('fatal: not a git repository');
      },
    },
  });
  assert.equal(input.hashes.status, 'hash_snapshot_unavailable');
  assert.match(hashEscalationDetail(input), /not a git repository/i);
});


testCase('F-022: a complete snapshot stays available with no hash escalation (no over-classification)', () => {
  const input = collect();
  assert.equal(input.hashes.status, 'available');
  assert.equal(input.escalations.some((entry) => entry.code === 'hash_snapshot_unavailable'), false);
});


testCase('F-022: the collector classifies a snapshot without materialDirtyFiles as unavailable', () => {
  const input = collect({
    readers: {
      changedFileStatuses: statusReader({}),
      hashSnapshot: () => {
        const snapshot: Record<string, unknown> = { ...FIXTURE_HEAD_SNAPSHOT };
        delete snapshot.materialDirtyFiles;
        return snapshot as unknown as EvidenceHashSnapshot;
      },
    },
  });
  assert.equal(input.hashes.status, 'hash_snapshot_unavailable');
  assert.ok(input.escalations.some((entry) =>
    entry.code === 'hash_snapshot_unavailable' && entry.detail.includes('materialDirtyFiles')));
});


testCase('F-022: the planner escalates an incomplete snapshot with a glossed hash_snapshot_unavailable reason', () => {
  assert.ok(
    Object.prototype.hasOwnProperty.call(VALIDATION_WIDENING_REASONS, 'hash_snapshot_unavailable'),
    'hash_snapshot_unavailable must be a row of the widening matrix so it is rendered with a gloss',
  );
  const result = planFor('story-fast', {
    readers: { changedFileStatuses: statusReader({}), hashSnapshot: snapshotWithout(EVIDENCE_DIGEST_NAMES) },
  });
  assert.ok(
    reasonCodes(result).includes('hash_snapshot_unavailable'),
    `the plan must disclose the missing binding as an escalation, got ${reasonCodes(result).join(', ')}`,
  );
  const reason = result.escalationReasons.find((entry) => entry.code === 'hash_snapshot_unavailable')!;
  assert.equal(reason.detail.includes('\n'), false, 'the planner detail must be one line');
  assert.match(reason.detail, /headHash/);
  assert.equal(reason.gloss, validationWideningReasonGloss('hash_snapshot_unavailable'));
});


testCase('F-022: the planner classifies a schema-bypassing "available" snapshot that carries a null binding', () => {
  for (const missing of EVIDENCE_DIGEST_NAMES) {
    const head: Record<string, unknown> = { ...FIXTURE_HEAD_SNAPSHOT };
    delete head[missing];
    const input = { ...planInput(), hashes: { status: 'available', head } } as unknown as StoryRelevanceInput;
    const result = resolveValidationTierPlan({ input, requestedTier: 'story-fast' });
    assert.equal(result.status, 'plan');
    assert.equal(result.status === 'plan' && result.effectiveTier, 'repository-full');
    assert.ok(reasonCodes(result).includes('hash_snapshot_unavailable'));
    assert.ok(result.escalationReasons.some((reason) => reason.detail.includes(missing)));
  }
});


testCase('F-022: a schema-bypassing snapshot without materialDirtyFiles widens instead of throwing', () => {
  const head: Record<string, unknown> = { ...FIXTURE_HEAD_SNAPSHOT };
  delete head.materialDirtyFiles;
  const input = { ...planInput(), hashes: { status: 'available', head } } as unknown as StoryRelevanceInput;
  const result = resolveValidationTierPlan({ input, requestedTier: 'story-fast' });
  assert.equal(result.status, 'plan');
  assert.equal(result.status === 'plan' && result.effectiveTier, 'repository-full');
  assert.ok(reasonCodes(result).includes('hash_snapshot_unavailable'));
  assert.ok(result.escalationReasons.some((reason) => reason.detail.includes('materialDirtyFiles')));
});


testCase('F-022: the CLI report carries the freshness binding and discloses an unbound one', () => {
  // planCliRoot is deliberately NOT a git repository: the REAL reader returns a snapshot with no digests.
  const { ctx } = planCliRoot();
  const report = JSON.parse(planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', json: true })) as Record<string, any>;
  assert.equal(report.freshnessBinding?.status, 'unbound', `the report must state it bound nothing, got ${JSON.stringify(report.freshnessBinding)}`);
  assert.ok(escalationCodes(report).includes('hash_snapshot_unavailable'), 'the unbound binding must be an escalation in the report');
  const text = planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', explain: true });
  assert.match(text, /^freshnessBinding: unbound/m);
  assert.ok(text.includes('[hash_snapshot_unavailable]'), 'the escalation code must be printed');
  assert.ok(text.includes(validationWideningReasonGloss('hash_snapshot_unavailable').slice(0, 60)), 'printed with its gloss');
  assert.match(text, /headHash, materialHash, storyFilesHash/, 'the detail must name every missing digest');
});


testCase('F-022: the render invariant refuses status: plan with a null head / material / storyFiles binding', () => {
  const { ctx } = planCliRoot();
  const report = JSON.parse(planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', json: true })) as Record<string, any>;
  assert.equal(report.status, 'plan');
  const bound = {
    headHash: 'head0000000000000000000000000000000000000',
    materialHash: 'material00000000000000000000000000000000',
    storyFilesHash: 'storyfiles000000000000000000000000000000',
  };
  // A genuinely bound plan renders.
  assert.doesNotThrow(() => assertValidationPlanStatusInvariant({ ...report, freshnessBinding: { status: 'bound', ...bound } } as never));
  // A "bound" binding with any digest null is refused, naming the digest.
  for (const missing of EVIDENCE_DIGEST_NAMES) {
    assert.throws(
      () => assertValidationPlanStatusInvariant({ ...report, freshnessBinding: { status: 'bound', ...bound, [missing]: null } } as never),
      new RegExp(missing),
      `status: plan with a null ${missing} binding must not render`,
    );
  }
  // An unbound plan renders ONLY when it discloses the escalation.
  const withoutEscalation = {
    ...report,
    freshnessBinding: { status: 'unbound', summary: 'fixture' },
    escalationReasons: report.escalationReasons.filter((entry: { code: string }) => entry.code !== 'hash_snapshot_unavailable'),
  };
  assert.throws(() => assertValidationPlanStatusInvariant(withoutEscalation as never), /hash_snapshot_unavailable/);
  // A report with no binding at all is not a plan either.
  const { freshnessBinding: _dropped, ...withoutBinding } = report;
  assert.throws(() => assertValidationPlanStatusInvariant(withoutBinding as never), /freshnessBinding/);
});


testCase('F-022: the REAL reader on an unborn repository (git init, zero commits) never yields a plan with null bindings', () => {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-unborn-repo-'));
  temporaryRoots.push(root);
  writeFixtureFile(root, 'proof-or-stop.config.json', `${JSON.stringify({
    storyDir: '.proof-or-stop/story/actives',
    validate: { commands: [{ label: 'unit', command: 'npm', args: ['test'], id: 'unit-suite' }] },
  }, null, 2)}\n`);
  fixtureGit(root, ['init', '-q']);
  assert.equal(gitOutputIn(root, ['rev-parse', '--verify', 'HEAD']), null, 'the fixture must be an UNBORN repository: HEAD resolves to nothing');

  // The canonical reader really does return a snapshot with every digest omitted here.
  const snapshot = captureEvidenceHashSnapshot({ gitCwd: root, metadataRoot: root, ref: 'HEAD' });
  for (const name of EVIDENCE_DIGEST_NAMES) {
    assert.equal(Object.prototype.hasOwnProperty.call(snapshot, name), false, `the unborn repository must yield no ${name}`);
  }

  resetConfigCache();
  const store = new StoryStore(root);
  store.writeStory(PLAN_CLI_STORY_ID, {
    storyId: PLAN_CLI_STORY_ID,
    name: 'unborn-repository',
    title: 'Planner on an unborn repository',
    description: 'Fixture story in a repository with zero commits.',
    type: 'feature',
    phase: 'DEV' as StoryInfo['phase'],
    priority: 'high',
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
  });
  store.writeChecklist(PLAN_CLI_STORY_ID, { items: [] });
  const ctx = { store, root, scanRoot: root } as HandlerContext;

  const report = JSON.parse(planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast', json: true })) as Record<string, any>;
  const text = planCli(ctx)({ storyId: PLAN_CLI_STORY_ID, tier: 'fast' });
  assert.ok(
    escalationCodes(report).includes('hash_snapshot_unavailable'),
    `an unborn repository binds no freshness and must say so; escalations were ${escalationCodes(report).join(', ')} and the render was:\n${text}`,
  );
  assert.notEqual(report.freshnessBinding?.status, 'bound', 'nothing was bound, so the report may not claim a binding');
  if (report.status === 'plan') {
    assert.equal(report.freshnessBinding?.status, 'unbound', 'a plan on an unborn repository must disclose an unbound freshness binding');
    assert.match(text, /^freshnessBinding: unbound/m);
  }
  assert.match(text, /headHash, materialHash, storyFilesHash/, 'the rendered detail must name every missing digest');
});
}
