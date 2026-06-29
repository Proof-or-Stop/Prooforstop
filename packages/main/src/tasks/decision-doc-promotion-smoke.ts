#!/usr/bin/env node

/**
 * @task B-5155
 * @checklist CHK-001
 * @title Map decision-doc verificationRequirements to implemented promotion coverage
 * @type chore
 * @priority high
 * @description
 *   Existing smoke coverage already exercises `verificationRequirements` in
 *   the promotion path and keeps saved docs inside the canonical
 *   `requirementsDir`.
 *   This is local CLI coverage only; it does not claim Authority receipt
 *   completion.
 * @changes
 *   - Add a truthful gap_analyze anchor for the existing decision-doc
 *     promotion smoke without changing runtime behavior.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildScopeExtensionDecision,
  buildScopeExtensionProposal,
  digestScopeExtensionProposal,
} from '../core/scope-anti-expansion.js';
import { StoryStore } from '../core/store.js';
import type {
  ChecklistData,
  DecisionData,
  DecisionDocProposal,
  ScopeExtensionProposal,
  ScopeContractData,
  ScopeExtensionProposalData,
  StoryInfo,
} from '../core/types.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');
const storyId = 'B-ddp-smoke';
const decisionTimestamp = '2026-06-14T00:00:00.000Z';
const sessionEnv = {
  ...process.env,
  LATTICE_SESSION_ID: 'decision-doc-promotion-smoke',
  LATTICE_AGENT: 'decision-doc-promotion-smoke',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, relPath: string, content: string): void {
  const absolute = join(root, relPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

function runCli(root: string, command: string, args: Record<string, unknown>, allowFailure = false): string {
  try {
    return execFileSync(process.execPath, [cliPath, '--root', root, command, JSON.stringify(args)], {
      cwd: root,
      env: sessionEnv,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error: any) {
    const text = String(error.stdout || '') + String(error.stderr || '') + String(error.message || '');
    if (allowFailure) return text;
    throw new Error(text);
  }
}

function runHelp(root: string, command: string): string {
  return execFileSync(process.execPath, [cliPath, '--root', root, command, '--help'], {
    cwd: root,
    env: sessionEnv,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function seedDecision(): DecisionData {
  return {
    principles: [
      'Promote only durable decisions',
      'Keep save separate from preview',
      'Keep local workflow evidence separate from release readiness',
    ],
    drivers: ['The decision needs to be discoverable after the story closes'],
    options: [
      {
        name: 'Explicit promotion command',
        pros: ['Reviewable before writing durable docs'],
        cons: ['Requires one extra operator step'],
      },
      {
        name: 'Manual document edits',
        pros: ['No new command surface'],
        cons: ['Easy to miss digest and scope checks'],
      },
    ],
    chosen: 'Explicit promotion command',
    rationale: 'The explicit promotion flow keeps durable policy writes intentional and reviewable.',
    timestamp: decisionTimestamp,
  };
}

function baseProposal(slug: string, overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    storyId,
    slug,
    title: `Decision Doc Promotion Smoke ${slug}`,
    decision: `The ${slug} decision must be promoted only through an explicit proposal and save command.`,
    context: 'Story-local decisions are useful during implementation but durable project rules need a visible Markdown document.',
    scope: 'Applies to the smoke test project decision-doc promotion path and its canonical decisions directory.',
    nonGoals: [
      'Do not write outside the canonical decisions directory',
      'Do not claim release readiness from legacy out-of-core receipt artifacts',
    ],
    chosenApproach: 'Use a story-local proposal artifact, preview it read-only, then save it with explicit confirmation.',
    alternatives: [
      {
        name: 'Auto-promote every decision',
        pros: ['No manual save command'],
        cons: ['Turns temporary implementation choices into durable policy'],
      },
      {
        name: 'Leave promotion fully manual',
        pros: ['Small implementation surface'],
        cons: ['No mechanical freshness, scope, or overwrite guard'],
      },
    ],
    operationalRules: [
      'A save requires confirm:true',
      'A save writes only docs/requirements/decisions/<slug>.md',
    ],
    verificationRequirements: [
      'Preview output must match the saved Markdown',
      'Stale proposal and source decision digests must fail closed',
    ],
    risks: [
      'Operators could over-promote temporary design notes',
      'Existing docs could be overwritten without an explicit update mode',
    ],
    ...overrides,
  };
}

function latestProposal(store: StoryStore, id: string): DecisionDocProposal {
  const proposal = store.readDecisionDocProposals(storyId).proposals.find(item => item.id === id);
  assert.ok(proposal, `expected proposal ${id}`);
  return proposal;
}

function reviewedAnchors(proposal: DecisionDocProposal): { expectedProposalDigest: string; expectedSourceDecisionDigest: string } {
  assert.ok(proposal.sourceDecisionDigest, `expected source decision digest for ${proposal.id}`);
  return {
    expectedProposalDigest: proposal.proposalDigest,
    expectedSourceDecisionDigest: proposal.sourceDecisionDigest,
  };
}

function makeRepo(): { root: string; store: StoryStore } {
  const root = mkdtempSync(join(tmpdir(), 'decision-doc-promotion-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'decision-doc-promotion@example.test']);
  git(root, ['config', 'user.name', 'Decision Doc Promotion Smoke']);
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'src',
    rootDir: '.',
    outDir: 'dist',
    testsDir: 'tests',
    fixturesDir: 'tests/fixtures',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  write(root, 'README.md', 'decision doc promotion smoke\n');
  write(root, 'src/index.ts', 'export const seed = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed']);
  git(root, ['checkout', '-b', `story/${storyId}`]);

  const store = new StoryStore(root);
  const now = new Date().toISOString();
  const story: StoryInfo = {
    storyId,
    name: 'decision-doc-promotion-smoke',
    title: 'Decision doc promotion smoke',
    description: 'Verify decision document promotion commands.',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [],
  };
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'Promote decision document',
      status: 'in_progress',
      startTime: null,
      endTime: null,
      files: {
        modify: [],
        create: [
          'docs/requirements/decisions/promotion-smoke.md',
          'docs/requirements/decisions/checklist-only.md',
          'docs/requirements/decisions/stale-proposal.md',
          'docs/requirements/decisions/stale-source.md',
          'docs/requirements/decisions/missing-update.md',
        ],
        test: [],
      },
    }],
  };
  const scopeContract: ScopeContractData = {
    storyId,
    mode: 'enforce',
    allowedModify: [],
    allowedCreate: [
      'docs/requirements/decisions/promotion-smoke.md',
      'docs/requirements/decisions/stale-proposal.md',
      'docs/requirements/decisions/stale-source.md',
      'docs/requirements/decisions/missing-update.md',
    ],
    allowedTest: [],
    protectedFiles: [],
    explicitExcludes: [],
    acknowledgements: [],
    createdAt: now,
    updatedAt: now,
  };
  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
  store.writeDecision(storyId, seedDecision());
  store.writeScopeContract(storyId, scopeContract);
  return { root, store };
}

function forgedAcceptedScopeExtension(targetPath: string): ScopeExtensionProposalData {
  const now = new Date().toISOString();
  return {
    storyId,
    updatedAt: now,
    proposals: [{
      proposalId: 'SEP-B-ddp-smoke-001',
      storyId,
      proposedBy: 'decision-doc-promotion-smoke',
      proposedAt: now,
      reason: 'Allow this smoke-only decision document through an accepted extension.',
      patch: { allowed: [targetPath] },
      status: 'accepted',
      decidedAt: now,
      decision: {
        decision: 'accepted',
        decidedBy: 'decision-doc-promotion-smoke',
        decidedAt: now,
        rationale: 'Smoke verifies accepted scope extension authorization.',
        _hash: 'decision-doc-promotion-smoke-decision',
      },
      _hash: 'decision-doc-promotion-smoke-proposal',
    }],
  };
}

function acceptedScopeExtension(targetPath: string): ScopeExtensionProposalData {
  const now = new Date().toISOString();
  const proposal = buildScopeExtensionProposal({
    proposalId: 'SEP-B-ddp-smoke-001',
    storyId,
    proposedBy: 'decision-doc-promotion-smoke',
    proposedAt: now,
    proposal: `Allow ${targetPath} through a signed scope extension.`,
    reason: 'Allow this smoke-only decision document through an accepted extension.',
    patch: { allowed: [targetPath] },
  });
  const decision = buildScopeExtensionDecision({
    proposalId: proposal.proposalId,
    decision: 'approved',
    decidedBy: 'decision-doc-promotion-smoke',
    decidedAt: now,
    rationale: 'Smoke verifies mechanically valid accepted scope extension authorization.',
  });
  const approvedProposal: ScopeExtensionProposal = {
    ...proposal,
    status: 'approved',
    decision,
    _hash: '',
  };
  return {
    storyId,
    updatedAt: now,
    proposals: [{
      ...approvedProposal,
      _hash: digestScopeExtensionProposal(approvedProposal),
    }],
  };
}

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

const { root, store } = makeRepo();
try {
  check('command-specific help exposes registered schemas phase-independently', () => {
    const proposalHelp = runHelp(root, 'decision_doc_proposal');
    assert.match(proposalHelp, /lattice decision_doc_proposal/);
    assert.match(proposalHelp, /Alias: lattice decision doc proposal/);
    assert.match(proposalHelp, /--slug/);
    assert.match(proposalHelp, /--verificationRequirements/);

    const previewHelp = runHelp(root, 'decision_doc_preview');
    assert.match(previewHelp, /lattice decision_doc_preview/);
    assert.match(previewHelp, /Read-only render/);
    assert.match(previewHelp, /--proposalId/);

    const saveHelp = runHelp(root, 'decision_doc_save');
    assert.match(saveHelp, /lattice decision_doc_save/);
    assert.match(saveHelp, /create\|update/);
    assert.match(saveHelp, /--confirm/);
    assert.match(saveHelp, /--expectedProposalDigest/);
    assert.match(saveHelp, /Required reviewed proposal digest/);
    assert.match(saveHelp, /Required when sourceDecision is decision\.json/);
  });

  check('proposal -> preview(read-only) -> save(create) happy path', () => {
    const proposalOut = runCli(root, 'decision_doc_proposal', baseProposal('promotion-smoke'));
    assert.match(proposalOut, /Decision doc proposal DDP-001 saved/);
    let proposal = latestProposal(store, 'DDP-001');
    assert.equal(proposal.targetPath, 'docs/requirements/decisions/promotion-smoke.md');
    assert.ok(proposal.proposalDigest.length > 20, 'proposal digest is recorded');
    assert.ok(proposal.sourceDecisionDigest && proposal.sourceDecisionDigest.length > 20, 'source decision digest is recorded');

    const proposalFilePath = store.storyFilePath(storyId, 'decision-doc-proposals.json');
    const proposalFileBeforePreview = readFileSync(proposalFilePath, 'utf8');
    const processEventsPath = store.storyFilePath(storyId, 'process-events.jsonl');
    const processEventsFileBeforePreview = readFileSync(processEventsPath, 'utf8');
    const processEventsBeforePreview = store.readProcessEvents(storyId);
    const preview = runCli(root, 'decision_doc_preview', { storyId, proposalId: 'DDP-001' });
    assert.match(preview, /Decision doc preview for DDP-001/);
    assert.match(preview, /Target exists: no/);
    assert.match(preview, /# Decision Doc Promotion Smoke promotion-smoke/);
    assert.equal(readFileSync(proposalFilePath, 'utf8'), proposalFileBeforePreview, 'preview must not mutate proposal metadata');
    assert.equal(readFileSync(processEventsPath, 'utf8'), processEventsFileBeforePreview, 'preview must not append process-events.jsonl');
    assert.deepEqual(store.readProcessEvents(storyId), processEventsBeforePreview, 'preview must not change the process-event projection');
    assert.equal(existsSync(join(root, proposal.targetPath)), false, 'preview must not write the target doc');

    const save = runCli(root, 'decision_doc_save', {
      storyId,
      proposalId: 'DDP-001',
      mode: 'create',
      confirm: true,
      ...reviewedAnchors(proposal),
    });
    assert.match(save, /Decision doc saved to docs\/requirements\/decisions\/promotion-smoke\.md/);
    assert.match(save, /authorityBoundary: local workflow evidence only/);

    const savedMarkdown = readFileSync(join(root, proposal.targetPath), 'utf8');
    assert.ok(preview.includes(savedMarkdown), 'saved Markdown must match the read-only preview render');
    proposal = latestProposal(store, 'DDP-001');
    assert.equal(proposal.status, 'saved');
    assert.equal(proposal.saves?.length, 1);

    const events = store.readProcessEvents(storyId);
    assert.equal(events.some(event => event.type === 'decision_doc_proposal' && event.proposalId === 'DDP-001'), true);
    assert.equal(events.some(event =>
      event.type === 'decision_doc_save' &&
      event.proposalId === 'DDP-001' &&
      event.targetPath === 'docs/requirements/decisions/promotion-smoke.md' &&
      String(event.authorityBoundary || '').includes('not remote receipt completion')
    ), true);
  });

  check('save requires reviewed proposal and source decision anchors', () => {
    const proposal = latestProposal(store, 'DDP-001');
    const anchors = reviewedAnchors(proposal);
    const targetAbs = join(root, proposal.targetPath);
    const savedBefore = readFileSync(targetAbs, 'utf8');

    const missingProposalDigest = runCli(root, 'decision_doc_save', {
      storyId,
      proposalId: 'DDP-001',
      mode: 'update',
      confirm: true,
      expectedSourceDecisionDigest: anchors.expectedSourceDecisionDigest,
    }, true);
    assert.match(missingProposalDigest, /expectedProposalDigest/);
    assert.equal(readFileSync(targetAbs, 'utf8'), savedBefore, 'missing proposal anchor must not rewrite target');

    const blankProposalDigest = runCli(root, 'decision_doc_save', {
      storyId,
      proposalId: 'DDP-001',
      mode: 'update',
      confirm: true,
      expectedProposalDigest: '   ',
      expectedSourceDecisionDigest: anchors.expectedSourceDecisionDigest,
    }, true);
    assert.match(blankProposalDigest, /expectedProposalDigest/);
    assert.equal(readFileSync(targetAbs, 'utf8'), savedBefore, 'blank proposal anchor must not rewrite target');

    const missingSourceDigest = runCli(root, 'decision_doc_save', {
      storyId,
      proposalId: 'DDP-001',
      mode: 'update',
      confirm: true,
      expectedProposalDigest: anchors.expectedProposalDigest,
    }, true);
    assert.match(missingSourceDigest, /expectedSourceDecisionDigest is required/);
    assert.equal(readFileSync(targetAbs, 'utf8'), savedBefore, 'missing source anchor must not rewrite target');

    const staleSourceAnchor = runCli(root, 'decision_doc_save', {
      storyId,
      proposalId: 'DDP-001',
      mode: 'update',
      confirm: true,
      expectedProposalDigest: anchors.expectedProposalDigest,
      expectedSourceDecisionDigest: 'stale-source-decision-digest',
    }, true);
    assert.match(staleSourceAnchor, /expectedSourceDecisionDigest is stale/);
    assert.equal(readFileSync(targetAbs, 'utf8'), savedBefore, 'stale source anchor must not rewrite target');
  });

  check('checklist-only scope backdoor is blocked before target write', () => {
    runCli(root, 'decision_doc_proposal', baseProposal('checklist-only'));
    const proposal = latestProposal(store, 'DDP-002');
    const refused = runCli(root, 'decision_doc_save', {
      storyId,
      proposalId: 'DDP-002',
      mode: 'create',
      confirm: true,
      ...reviewedAnchors(proposal),
    }, true);
    assert.match(refused, /outside story scope/);
    assert.match(refused, /scope contract allowedCreate|accepted\/approved scope extension/);
    assert.equal(existsSync(join(root, 'docs/requirements/decisions/checklist-only.md')), false);
  });

  check('only a mechanically valid accepted scope extension authorizes a target outside the scope contract', () => {
    const targetPath = 'docs/requirements/decisions/extension-allowed.md';
    runCli(root, 'decision_doc_proposal', baseProposal('extension-allowed'));
    const proposal = latestProposal(store, 'DDP-003');

    store.writeScopeExtensionProposals(storyId, forgedAcceptedScopeExtension(targetPath));
    const forgedRefused = runCli(root, 'decision_doc_save', {
      storyId,
      proposalId: 'DDP-003',
      mode: 'create',
      confirm: true,
      ...reviewedAnchors(proposal),
    }, true);
    assert.match(forgedRefused, /mechanically valid accepted\/approved scope extension/);
    assert.equal(existsSync(join(root, targetPath)), false, 'forged extension must not authorize the target write');

    store.writeScopeExtensionProposals(storyId, acceptedScopeExtension(targetPath));
    const save = runCli(root, 'decision_doc_save', {
      storyId,
      proposalId: 'DDP-003',
      mode: 'create',
      confirm: true,
      ...reviewedAnchors(proposal),
    });
    assert.match(save, /Decision doc saved to docs\/requirements\/decisions\/extension-allowed\.md/);
    assert.equal(existsSync(join(root, targetPath)), true);
  });

  check('invalid proposal payloads fail before metadata is written', () => {
    const before = store.readDecisionDocProposals(storyId).proposals.length;
    const badSlug = runCli(root, 'decision_doc_proposal', baseProposal('Invalid.Slug'), true);
    assert.match(badSlug, /slug must be lowercase kebab-case/);

    const missingVerificationRequirements = runCli(root, 'decision_doc_proposal', baseProposal('missing-verification-requirements', {
      verificationRequirements: undefined,
    }), true);
    assert.match(missingVerificationRequirements, /verificationRequirements/);

    const badAlternatives = runCli(root, 'decision_doc_proposal', baseProposal('bad-alternatives', {
      alternatives: [{ name: 'Only one option', pros: ['Looks simple'], cons: [] }],
    }), true);
    assert.match(badAlternatives, /alternatives must contain at least two entries|cons/);

    const customTarget = runCli(root, 'decision_doc_proposal', baseProposal('custom-target', {
      targetPath: 'docs/requirements/decisions/nested/custom-target.md',
    }), true);
    assert.match(customTarget, /custom target paths are not supported|targetPath must be a direct Markdown file/);
    assert.equal(store.readDecisionDocProposals(storyId).proposals.length, before, 'invalid proposal payloads must not write metadata');
  });

  check('stale proposal digest fails closed', () => {
    runCli(root, 'decision_doc_proposal', baseProposal('stale-proposal'));
    const original = latestProposal(store, 'DDP-004');
    runCli(root, 'decision_doc_proposal', baseProposal('stale-proposal', {
      proposalId: 'DDP-004',
      decision: 'The stale-proposal decision changed after review and must require an updated digest approval.',
    }));
    const refused = runCli(root, 'decision_doc_save', {
      storyId,
      proposalId: 'DDP-004',
      mode: 'create',
      confirm: true,
      ...reviewedAnchors(original),
    }, true);
    assert.match(refused, /expectedProposalDigest is stale/);
    assert.equal(existsSync(join(root, 'docs/requirements/decisions/stale-proposal.md')), false);
  });

  check('stale source decision digest fails closed', () => {
    runCli(root, 'decision_doc_proposal', baseProposal('stale-source'));
    const proposal = latestProposal(store, 'DDP-005');
    store.writeDecision(storyId, {
      ...seedDecision(),
      rationale: 'The source decision changed after proposal review, so the promotion must be refreshed before save.',
      timestamp: new Date().toISOString(),
    });
    const refused = runCli(root, 'decision_doc_save', {
      storyId,
      proposalId: 'DDP-005',
      mode: 'create',
      confirm: true,
      ...reviewedAnchors(proposal),
    }, true);
    assert.match(refused, /source decision digest is stale/);
    assert.equal(existsSync(join(root, 'docs/requirements/decisions/stale-source.md')), false);
    store.writeDecision(storyId, seedDecision());
  });

  check('create/update mode guards prevent accidental overwrite and wrong update', () => {
    const savedProposal = latestProposal(store, 'DDP-001');
    const createAgain = runCli(root, 'decision_doc_save', {
      storyId,
      proposalId: 'DDP-001',
      mode: 'create',
      confirm: true,
      ...reviewedAnchors(savedProposal),
    }, true);
    assert.match(createAgain, /target already exists/);

    runCli(root, 'decision_doc_proposal', baseProposal('missing-update'));
    const proposal = latestProposal(store, 'DDP-006');
    const missingUpdate = runCli(root, 'decision_doc_save', {
      storyId,
      proposalId: 'DDP-006',
      mode: 'update',
      confirm: true,
      ...reviewedAnchors(proposal),
    }, true);
    assert.match(missingUpdate, /target does not exist/);
    assert.equal(existsSync(join(root, 'docs/requirements/decisions/missing-update.md')), false);
  });

  console.log(`decision doc promotion smoke passed (${passed} checks)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
