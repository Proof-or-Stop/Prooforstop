#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { runManagedAssetCheck } from '../core/managed-assets.js';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOAD_BEARING_PROOF_OR_STOP_PROMPT_SLICE,
  isModularComplexRoleId,
  isActiveModularReviewerRoleId,
  isModularReviewerRoleId,
  readPromptRegistry,
  renderCodexPromptContent,
  renderPromptEntryForHost,
} from '../core/prompt-registry.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import { createChecklistHandlers } from '../handlers/checklist.js';
import { createStoryQueryHandlers } from '../handlers/story-query.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = join(packageRoot, '..', '..');
const templateDir = join(packageRoot, 'templates', 'agents');
const auditDocPath = join(repoRoot, 'docs', 'requirements', 'decisions', 'slim-fields-token-savings-execution-plan.md');

const baselineTemplateBytes: Record<string, number> = {
  'proof-or-stop-evaluator.md': 57931,
  'proof-or-stop-implementer.md': 63463,
  'proof-or-stop-review-behavior.md': 63499,
  'proof-or-stop-review-channel.md': 63587,
  'proof-or-stop-review-concept.md': 61085,
  'proof-or-stop-review-delivery.md': 64505,
  'proof-or-stop-review-docs.md': 63591,
  'proof-or-stop-review-quality.md': 60804,
  'proof-or-stop-review-scope-plan.md': 63354,
  'proof-or-stop-review-story-init.md': 70868,
};

const requiredSourcePaths = [
  'docs/requirements/decisions/slim-fields-token-savings-execution-plan.md',
  'packages/main/templates/agents',
  '.claude/agents',
  // B-cc10 F-055: canonical first; a renamed root silently yields zero files.
  '.proof-or-stop-codex/agents',

  'packages/main/src/core/prompt-registry.ts',
  'packages/main/src/core/managed-assets.ts',
  'packages/main/src/handlers/story-query.ts',
  'packages/main/src/handlers/checklist.ts',
  'packages/main/src/cli-engine.ts',
];

const requiredPromptPhrases = [
  'proof-or-stop session_brief',
  'Fresh-Context Fence',
  'Process Fact Contract',
  'review_run_start',
  'review_pass_set',
  'finding_add',
  'reviewRunId',
  'verificationEvidence',
  'signed delivery artifacts',
  'Handoff packs are bounded overflow execution',
];

const compactQueryGuidancePhrases = [
  'For routine status refreshes, prefer compact read-only queries',
  'These examples',
  'are opt-in; default `story_get` and `checklist_get` output remains full',
  `proof-or-stop story_get '{"storyId":"B-xxxx","slim":true,"fields":["story","checklist","review"]}'`,
  `proof-or-stop checklist_get '{"storyId":"B-xxxx","slim":true,"fields":["counts","items"]}'`,
  'Before evidence-sensitive conclusions or mutations, reload the full output',
  `proof-or-stop story_get '{"storyId":"B-xxxx"}'`,
  `proof-or-stop checklist_get '{"storyId":"B-xxxx"}'`,
];
const LEGACY_LOAD_BEARING_PROMPT_SLICE = LOAD_BEARING_PROOF_OR_STOP_PROMPT_SLICE
  .replace('<!-- proof-or-stop:start -->', '<!-- lattice:start -->')
  .replace('<!-- proof-or-stop:end -->', '<!-- lattice:end -->');

const modularReviewerSafetyPhrases = [
  'proof-or-stop:modular-role-body:v1',
  'review_run_start',
  'review_pass_set',
  'finding_add',
  'reviewRunId',
];

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function approxTokens(byteCount: number): number {
  return Math.ceil(byteCount / 4);
}

function readRepo(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function extractLatticeBlock(content: string): string {
  const match = content.match(/<!-- proof-or-stop:start -->[\s\S]*?<!-- proof-or-stop:end -->/)
    ?? content.match(/<!-- lattice:start -->[\s\S]*?<!-- lattice:end -->/);
  assert.ok(match, 'expected lattice managed block');
  return match[0];
}

function assertCompactQueryGuidance(content: string, label: string): void {
  for (const phrase of compactQueryGuidancePhrases) {
    assert.ok(content.includes(phrase), `${label} keeps compact query guidance phrase: ${phrase}`);
  }
}

function assertAuditDocExecutable(): void {
  for (const rel of requiredSourcePaths) {
    assert.doesNotThrow(() => statSync(join(repoRoot, rel)), `audit source path exists: ${rel}`);
  }

  const audit = readFileSync(auditDocPath, 'utf8');
  assert.match(audit, /prompt[- ]cache|prompt caching/i, 'audit mentions prompt cache');
  assert.match(
    audit,
    /approximate context-token estimates|not provider billing receipts|prompt-cache behavior is not proven/i,
    'audit states the token estimate caveat and does not overclaim provider billing proof',
  );
}

function assertPromptReductions(): void {
  let baselineTotal = 0;
  let currentTotal = 0;
  const rows: string[] = [];

  for (const [file, baseline] of Object.entries(baselineTemplateBytes)) {
    const rel = `packages/main/templates/agents/${file}`;
    const content = readRepo(rel);
    const current = bytes(content);
    baselineTotal += baseline;
    currentTotal += current;

    const roleId = file.replace(/\.md$/, '');
    if (isModularReviewerRoleId(roleId)) {
      assert.equal(
        content.match(/<!-- proofOrStop:start -->[\s\S]*?<!-- proofOrStop:end -->/),
        null,
        `${file} does not rematerialize the legacy runtime guide`,
      );
      for (const phrase of modularReviewerSafetyPhrases) {
        assert.ok(content.includes(phrase), `${file} keeps modular reviewer safety phrase: ${phrase}`);
      }
    } else if (isModularComplexRoleId(roleId)) {
      // Complex roles are assembled from the package registry. Their package
      // templates carry the role body marker; the load-bearing runtime slice is
      // injected only by the host renderer.
      assert.match(content, /<!-- proof-or-stop:modular-role-body:v1 -->/, `${file} keeps the modular role-body marker`);
      assert.doesNotMatch(content, /<!-- lattice:start -->[\s\S]*?<!-- lattice:end -->/, `${file} does not inline the host runtime slice`);
    } else {
      const expectedLoadBearingSlice = file === 'proof-or-stop-review-channel.md'
        ? LOAD_BEARING_PROOF_OR_STOP_PROMPT_SLICE
        : LEGACY_LOAD_BEARING_PROMPT_SLICE;
      assert.equal(
        extractLatticeBlock(content),
        expectedLoadBearingSlice,
        `${file} uses the expected load-bearing prompt slice`,
      );
      for (const phrase of requiredPromptPhrases) {
        assert.ok(content.includes(phrase), `${file} keeps prompt-safety phrase: ${phrase}`);
      }
      assertCompactQueryGuidance(content, file);
    }
    assert.ok(current < baseline, `${file} current bytes should be smaller than baseline`);
    rows.push(
      `  ${file}: baseline ${baseline} B (~${approxTokens(baseline)} tok), ` +
      `current ${current} B (~${approxTokens(current)} tok), ` +
      `delta ${baseline - current} B (~${approxTokens(baseline - current)} tok)`,
    );
  }

  assert.ok(
    currentTotal < baselineTotal * 0.35,
    `prompt total should remain materially slimmer than baseline (${currentTotal} vs ${baselineTotal})`,
  );

  console.log('Prompt template byte/token report:');
  for (const row of rows) console.log(row);
  console.log(
    `  total: baseline ${baselineTotal} B (~${approxTokens(baselineTotal)} tok), ` +
    `current ${currentTotal} B (~${approxTokens(currentTotal)} tok), ` +
    `delta ${baselineTotal - currentTotal} B (~${approxTokens(baselineTotal - currentTotal)} tok)`,
  );
  console.log('  caveat: approximate tokens use bytes/4; provider billing tokens are unavailable and prompt-cache billing behavior is not proven by this smoke.');
}

function assertMirrorsMatch(): void {
  const materializedProject = mkdtempSync(join(tmpdir(), 'prompt-token-materialization-'));
  process.once('exit', () => rmSync(materializedProject, {recursive:true,force:true}));
  runManagedAssetCheck(materializedProject, {apply:true,profile:'all',assetMode:'full'});
  for (const file of Object.keys(baselineTemplateBytes)) {
    const packageContent = readRepo(`packages/main/templates/agents/${file}`);
    const claudeContent = readFileSync(join(materializedProject, '.claude', 'agents', file), 'utf8');
    const codexContent = readFileSync(join(materializedProject, '.proof-or-stop-codex', 'agents', file), 'utf8');
    const roleId = file.replace(/\.md$/, '');
    // B-cdf6:F-036 — this was a FOURTH hand-rolled copy of the complex-role render
    // rule, found by the concept lane after three others were consolidated. Like the
    // rest it branched only on isModularReviewerRoleId, so it computed the wrong
    // expected content for the 5 MODULAR_COMPLEX_ROLE_IDS (10 mismatches: 5 roles x 2
    // hosts). It was latent only because a pre-existing assertion earlier in this file
    // ('expected proof-or-stop managed block', which fails identically on main) aborts the
    // run before this function executes. Delegating to renderPromptEntryForHost — the
    // single helper the other three sites now use — is what stops a fifth copy.
    const registryEntry = readPromptRegistry().agents.find(entry => entry.agentId === roleId);
    const expectedClaude = registryEntry
      ? renderPromptEntryForHost(registryEntry, 'claude')
      : packageContent;
    const expectedCodex = registryEntry
      ? renderPromptEntryForHost(registryEntry, 'codex')
      : renderCodexPromptContent(packageContent);
    assert.equal(claudeContent, expectedClaude, `.claude asset matches canonical host input for ${file}`);
    assert.equal(codexContent, expectedCodex, `.proof-or-stop-codex asset matches canonical host input for ${file}`);
    if (isActiveModularReviewerRoleId(roleId)) {
      assert.match(claudeContent, /review_run_start/, `.claude bootstrap selects ${file} at runtime`);
      assert.match(codexContent, /review_run_start/, `.proof-or-stop-codex bootstrap selects ${file} at runtime`);
    } else if (isModularComplexRoleId(roleId)) {
      // Complex roles are assembled from the package registry and receive the
      // runtime slice from the host renderer; they do not carry compact query
      // guidance in their package or mirrored role body.
    } else {
      assertCompactQueryGuidance(packageContent, `package template ${file}`);
      assertCompactQueryGuidance(claudeContent, `.claude mirror ${file}`);
      assertCompactQueryGuidance(codexContent, `.proof-or-stop-codex mirror ${file}`);
    }
  }
}

function jsonBytes(value: unknown): number {
  return bytes(JSON.stringify(value));
}

function assertSlimOutputCompatibility(): void {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-prompt-token-smoke-'));
  const store = new StoryStore(root);
  const storyId = 'B-smoke';
  const story: StoryInfo = {
    storyId,
    name: 'prompt-token-smoke',
    title: 'Prompt token smoke story',
    description: 'Temporary story for prompt-token-cost-smoke default compatibility and slim output checks.',
    type: 'feature',
    phase: 'DEV',
    priority: 'high',
    createdAt: '2026-06-15T00:00:00.000Z',
    startedAt: '2026-06-15T00:00:00.000Z',
    endedAt: null,
    currentReviewRound: '2026-06-15T00:00:00.000Z',
    riskSignals: [{ category: 'state machine/gate', matched: 'gate' }],
  };
  const longContext = 'x'.repeat(3000);
  const checklist: ChecklistData = {
    items: [
      {
        id: 'CHK-001',
        title: 'Exercise default and slim story output',
        context: longContext,
        status: 'done',
        startTime: '2026-06-15T00:00:00.000Z',
        endTime: '2026-06-15T00:01:00.000Z',
        verificationIntent: {
          happy: [{ desc: 'Default output remains full', type: 'cli', priority: 'must' }],
          edge: [{ desc: 'Slim output is opt-in', type: 'cli', priority: 'must' }],
          adversarial: [{ desc: 'Fields filter is explicit', type: 'cli', priority: 'must' }],
        },
        verificationEvidence: [
          {
            intentRef: 'CHK-001:happy:0',
            kind: 'manual_transcript',
            result: 'pass',
            note: 'prompt-token-cost-smoke seeded evidence',
          },
        ],
      },
      {
        id: 'CHK-002',
        title: 'Keep a pending item visible in counts',
        context: longContext,
        status: 'pending',
        startTime: null,
        endTime: null,
      },
    ],
  };

  store.writeStory(storyId, story);
  store.writeChecklist(storyId, checklist);
  store.writeReview(storyId, {
    reviews: [{
      timestamp: '2026-06-15T00:02:00.000Z',
      issueCount: 0,
      blockerCount: 0,
      issues: [],
    }],
  });

  const ctx = { store, root, scanRoot: root };
  const checklistHandlers = createChecklistHandlers(ctx);
  const storyHandlers = createStoryQueryHandlers(ctx);

  const defaultChecklist = checklistHandlers.checklist_get({ storyId });
  assert.deepEqual(defaultChecklist, checklist, 'default checklist_get remains full checklist data');
  const slimChecklist = checklistHandlers.checklist_get({ storyId, slim: true });
  assert.ok(jsonBytes(slimChecklist) < jsonBytes(defaultChecklist), 'slim checklist_get is smaller than default');
  assert.deepEqual(checklistHandlers.checklist_get({ storyId, slim: true, fields: ['counts'] }), {
    counts: { total: 2, done: 1, inProgress: 0, pending: 1, withdrawn: 0 },
  });

  const defaultStory = storyHandlers.story_get({ storyId });
  assert.deepEqual((defaultStory as { checklist: ChecklistData }).checklist, checklist, 'default story_get embeds full checklist data');
  const slimStory = storyHandlers.story_get({ storyId, slim: true });
  assert.ok(jsonBytes(slimStory) < jsonBytes(defaultStory), 'slim story_get is smaller than default');
  assert.deepEqual(Object.keys(storyHandlers.story_get({ storyId, slim: true, fields: ['story', 'checklist'] })).sort(), ['checklist', 'story']);
}

assertAuditDocExecutable();
assertPromptReductions();
assertMirrorsMatch();
assertSlimOutputCompatibility();

console.log('✓ prompt token cost smoke passed: audit paths, prompt safety, mirror sync, default compatibility, and slim reductions verified');
