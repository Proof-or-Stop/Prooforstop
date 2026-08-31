#!/usr/bin/env node
/**
 * @task B-9b76
 * @checklist CHK-002
 * @title Prompt registry compatibility smoke
 * @type feature
 * @priority high
 * @description
 * Verifies that the package prompt registry enumerates and renders all agent
 * prompt templates without changing legacy Claude/Codex content.
 * @changes
 * - [CHK-002] Cover registry metadata, hashes, and host render compatibility.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LOAD_BEARING_LATTICE_PROMPT_SLICE,
  MODULAR_COMPLEX_ROLE_IDS,
  MODULAR_REVIEWER_ROLE_IDS,
  PROMPT_REGISTRY_SOURCE,
  PROMPT_REGISTRY_VERSION,
  REVIEW_FINDING_TRIAGE_CONTRACT,
  listPromptTemplateFiles,
  readPromptRegistry,
  renderPromptEntryForHost,
  resolvePromptTemplateBody,
  restoreLegacyPromptTemplate,
} from '../core/prompt-registry.js';
import { assertNoDuplicatePromptEnvelopeRoleKeys } from '../core/config.js';
import {
  ACTIVE_MODULAR_REVIEWER_ROLE_IDS,
  PROMPT_ENVELOPE_ROLLOUT_VERSION,
  PromptRoleContractRegistryError,
  resolvePromptEnvelopeRolloutMode,
  resolvePromptRoleBody,
  reviewerHostRenderIdentity,
} from '../core/prompt-role-contract-registry.js';
import { renderCodexAgentContent } from '../init-assets.js';
// B-cc10 F-055: resolve whichever adapter dir exists. Hardcoding the renamed one made this
// read a path that no longer exists (ENOENT) or scan zero files.
function adapterDirName(base: string): string {
  return existsSync(join(base, '.proof-or-stop-codex')) ? '.proof-or-stop-codex' : '.lattice-codex';
}


const registry = readPromptRegistry();
const files = listPromptTemplateFiles(registry.root);
const projectRoot = join(registry.root, '..', '..', '..', '..');
const loadBearingPromptFiles = new Set([
  'lattice-review-channel.md',
]);
const requiredSafetyPhrases = [
  'Fresh-Context Fence',
  'Process Fact Contract',
  'review_run_start',
  'review_pass_set',
  'finding_add',
  'reviewRunId',
  'verificationEvidence',
  'admissibilityStatus',
  'assuranceLevel',
  'evidenceScope',
];
const qualityProofMetadataPhrases = [
  'job.metadata',
  'linked run.metadata',
  'server-authored proof keys',
  'checking only one location is insufficient',
  'client-controlled or stale metadata cannot satisfy',
  'not receipt-backed production proof',
];
const reviewFindingTriageContractMarker = '<!-- proofbound:review-finding-triage-contract:v1 -->';
// Independent semantic approval boundary. This digest is intentionally kept in
// the smoke instead of the generated prompt baseline: changing the production
// contract requires a deliberate semantic-test review, and `--write` baseline
// refreshes cannot approve extra or contradictory reviewer instructions.
const approvedReviewFindingTriageContractSha256 = '66c3b113d98c127db56b8b3315d91d5e05ab8eea8e94444ad1ac6820f7a6cce9';
const ownerTriageImmutablePhrases = [
  'not applicability',
  'repair, or resolution proof',
  'does not prove applicability, repair, or resolution',
  'does not prove `out_of_scope`',
  'is not mechanically enforced by prompt text alone',
  'prompt text does not mechanically enforce this discipline',
] as const;
const frozenReviewerLegacyReconstructionDigests = {
  'lattice-review-behavior': '45efbfe90d7705408ed95f0111b2108b5e39fc9397aeb7d99eda600db2ea3fe0',
  'lattice-review-concept': '846023d241693435c995900e5869b13e838795718143f2fab14e7a8f7f23eb5d',
  'lattice-review-docs': '7aafa18c26dd713586f416dfc4a3b9676a88438f858c32374af9a978300dd43e',
  'lattice-review-quality': '1f023f75aeab93b6d08e4ec1261a867e43ebd638f6d5ec18e1407cad7c90f58b',
  'lattice-review-test-coverage': 'e433ed9bded50288388fff6447142555e412756137461d841ca7724848458753',
} as const;
const requiredReviewFindingTriagePhrases = [
  'The Dynamic Finding System execution plan is the future authority',
  'use only commands and fields exposed by the current CLI compatibility path',
  'Never fabricate an unavailable assessment field, verdict, owner, route, signature, freshness result, or command receipt',
  '`finding_dismiss` is compatibility accounting; it is not applicability proof, `out_of_scope` proof, repair, or resolution',
  'evidenceState',
  'severity says how harmful it is',
  'applicability reports whether it belongs to this Story',
  'gate impact is computed by the current lifecycle policy',
  'Severity does not determine scope by itself',
  'Start the current lane with `proof-or-stop review_run_start`',
  'Carry its current `reviewRunId` on every `finding_add` or `review_pass_set` submission',
  'already assembled in-flight reviewer envelope stale',
  'start a fresh current-material run with `review_run_start`, and redispatch the reviewer',
  'never submit evidence from the older envelope',
  'fail closed and keep it in the current Story',
  'including medium findings when the current round treats them as blocking',
  'Critical or high findings must never be left without an owner',
  'deterministic base and head reproduction receipts for the same defect',
  'proof that the Story did not worsen severity or impact',
  'signed scope or decision evidence naming the excluded contract',
  'no contradictory checklist or acceptance promise',
  'a signature-valid live canonical Finding',
  'proof that the duplicate chain is not circular',
  'current command receipts bound to fresh source and runtime evidence',
  'must never be inferred from an old DONE outcome',
  'applicability remains unknown and fails closed',
  'Do not expand the Story merely to make the repository globally green',
  'A bounded, evidence-backed route is not dismissal, resolution, or proof that the problem disappeared',
  'they do not repair implementation, rewrite scope, or create follow-up Stories',
  'Do not call `finding_dismiss`, `story_create`, or `gap_log` from a REVIEW lane',
  '`disproven` (evidence refutes the observation)',
  '`duplicate` (another tracked Finding owns the same defect)',
  '`stale_or_not_reproduced` (current evidence cannot reproduce an older claim)',
  'Never delete the original observation',
  'silently rewrite its severity',
  'report the new evidence to the Story Owner',
  'do not fabricate a revision, superseding Finding, applicability recalculation, or gate-impact recalculation',
  'Only the future official Dynamic Finding System may append a signed revision or superseding Finding',
  'recalculate applicability and gate impact',
];
const forbiddenReviewFindingTriagePermissions = [
  {
    label: 'reviewer gap_log/finding_dismiss permission',
    pattern: /reviewers?\s+(?:may|can|should|must|are permitted to|are allowed to)[^.\n]{0,100}`?(?:gap_log|finding_dismiss)`?/iu,
  },
  {
    label: 'dismissal proves out_of_scope',
    pattern: /(?:finding_dismiss|dismissal)[^.\n]{0,100}(?:proves?|establishes?|confirms?)[^.\n]{0,80}(?:out_of_scope|out of scope)/iu,
  },
  {
    label: 'severity alone decides scope',
    pattern: /severity\s+(?:alone|by itself)[^.\n]{0,80}(?:determines?|decides?|sets?)[^.\n]{0,40}(?:scope|applicability)/iu,
  },
  {
    label: 'stale reviewRunId reuse',
    pattern: /(?:stale|old|previous)[^.\n]{0,80}reviewRunId[^.\n]{0,100}(?:may|can|should|must)[^.\n]{0,60}(?:be\s+)?(?:reused?|used|remain valid)/iu,
  },
  {
    label: 'reviewer repair permission',
    pattern: /reviewers?\s+(?:may|can|should|must|are permitted to|are allowed to)[^.\n]{0,120}(?:repair|fix|modify|patch)\s+(?:the\s+)?(?:implementation|code|product)/iu,
  },
  {
    label: 'reviewer story_create permission',
    pattern: /reviewers?\s+(?:may|can|should|must|are permitted to|are allowed to)[^.\n]{0,120}(?:call|run|use|invoke)\s+`?story_create`?/iu,
  },
  {
    label: 'unilateral scope or global-green expansion',
    pattern: /reviewers?\s+(?:may|can|should|must|are permitted to|are allowed to)[^.\n]{0,120}(?:expand|widen)[^.\n]{0,80}(?:Story|scope)[^.\n]{0,100}(?:unilaterally|globally green|global green|repository green)/iu,
  },
  {
    label: 'severity rewrite permission',
    pattern: /reviewers?\s+(?:may|can|should|must|are permitted to|are allowed to)[^.\n]{0,120}(?:rewrite|replace|change|lower|raise|overwrite)[^.\n]{0,60}(?:original\s+)?(?:Finding\s+)?severity/iu,
  },
  {
    label: 'routing collapses outcome to resolved',
    pattern: /(?:routed?|deferred|dismissed)[^.\n]{0,120}(?:Finding|issue|defect)?[^.\n]{0,80}(?:is|becomes?|counts?\s+as|means?)[^.\n]{0,40}resolved/iu,
  },
  {
    label: 'evidence-free or ownerless routing',
    pattern: /(?:critical|high)[^.\n]{0,100}(?:Finding|issue|defect)[^.\n]{0,120}(?:may|can|should|must)[^.\n]{0,80}(?:routed?|deferred|dismissed)[^.\n]{0,80}(?:without|no)[^.\n]{0,40}(?:evidence|owner)/iu,
  },
  {
    label: 'prompt prose controls lifecycle gates',
    pattern: /(?:reviewer\s+)?prompt\s+prose[^.\n]{0,100}(?:may|can|should|must|does)[^.\n]{0,80}(?:control|decide|determine|override|satisfy)[^.\n]{0,60}(?:gate|blocking|lifecycle)/iu,
  },
  {
    label: 'file disjointness proves pre_existing applicability',
    pattern: /file\s+disjointness\s+(?:alone|by itself)[^.\n]{0,80}(?:proves?|establishes?|confirms?|determines?)[^.\n]{0,60}(?:pre_existing_unaffected|pre-existing unaffected|applicability)/iu,
  },
  {
    label: 'unsigned stale or ownerless duplicate target',
    pattern: /(?:unsigned|stale|ownerless|unowned)[^.\n]{0,100}(?:Finding|issue|target)[^.\n]{0,100}(?:may|can|should|must)[^.\n]{0,80}(?:serve|act|count|qualify)[^.\n]{0,60}(?:duplicate|canonical)/iu,
  },
] as const;

function assertReviewFindingTriageSemantics(content: string, sourceLabel: string): void {
  assert.equal(
    createHash('sha256').update(REVIEW_FINDING_TRIAGE_CONTRACT).digest('hex'),
    approvedReviewFindingTriageContractSha256,
    'production REVIEW triage contract matches the independently approved canonical contract',
  );
  assert.equal(
    occurrenceCount(content, reviewFindingTriageContractMarker),
    1,
    `${sourceLabel} contains exactly one canonical REVIEW triage contract`,
  );
  const deliveredContract = content.slice(content.indexOf(reviewFindingTriageContractMarker)).trimEnd();
  assert.equal(
    createHash('sha256').update(deliveredContract).digest('hex'),
    approvedReviewFindingTriageContractSha256,
    `${sourceLabel} ends at the independently approved canonical REVIEW triage contract`,
  );
  for (const phrase of requiredReviewFindingTriagePhrases) {
    assert.ok(content.includes(phrase), `${sourceLabel} keeps triage phrase: ${phrase}`);
  }
  for (const forbidden of forbiddenReviewFindingTriagePermissions) {
    assert.doesNotMatch(content, forbidden.pattern, `${sourceLabel} rejects contradictory ${forbidden.label}`);
  }
}

function assertReviewFindingTriageMutationFailures(): void {
  const originalMutations = [
    'Reviewers may call `gap_log` or `finding_dismiss` to route a defect.',
    'Dismissal proves `out_of_scope` for the current Story.',
    'Severity alone decides scope and applicability.',
    'An old reviewRunId may be reused after the reviewer envelope changes.',
    'Reviewers may repair the implementation before recording the lane result.',
    'Reviewers may call `story_create` to open a follow-up Story.',
    'Reviewers may expand the Story unilaterally to make the repository globally green.',
    'Reviewers may rewrite the original Finding severity when new evidence arrives.',
    'A routed Finding becomes resolved once it no longer blocks the current Story outcome.',
    'A high Finding may be routed without evidence or an owner.',
    'Reviewer prompt prose may determine lifecycle gate impact.',
    'File disjointness alone proves `pre_existing_unaffected` applicability.',
    'An unsigned, stale, ownerless Finding may serve as the canonical duplicate target.',
  ];
  const paraphraseMutations = [
    'A reviewer is allowed to invoke `gap_log` or `finding_dismiss`.',
    'An out-of-scope classification can be inferred from dismissal.',
    'Scope follows severity without further applicability evidence.',
    'The reviewRunId from the superseded envelope stays valid.',
    'A reviewer is authorized to patch the code before reporting.',
    'The review lane is permitted to invoke `story_create`.',
    'The Story can be widened by reviewers until the repository is green.',
    'Applicability evidence may lower the original Finding severity.',
    'Routed findings are resolved when they stop blocking.',
    'A blocker may be routed even if it lacks evidence and has no owner.',
    'This prompt determines whether the REVIEW gate blocks.',
    'Disjoint files are sufficient to establish `pre_existing_unaffected`.',
    'A canonical duplicate target may be an unsigned, stale, unowned Finding.',
  ];
  assert.equal(originalMutations.length, 13, 'the original semantic mutation inventory remains complete');
  assert.equal(paraphraseMutations.length, 13, 'the independent reviewer paraphrase mutation inventory remains complete');
  for (const [index, mutation] of [...originalMutations, ...paraphraseMutations].entries()) {
    assert.throws(
      () => assertReviewFindingTriageSemantics(`${REVIEW_FINDING_TRIAGE_CONTRACT}\n${mutation}`, `mutation ${index + 1}`),
      /independently approved canonical REVIEW triage contract|rejects contradictory/,
      `semantic mutation ${index + 1} must fail validation`,
    );
  }
}

function occurrenceCount(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

function extractLatticeBlock(content: string): string | null {
  return content.match(/<!-- lattice:start -->[\s\S]*?<!-- lattice:end -->/)?.[0] ?? null;
}

function assertReviewFindingTriageDelivery(): void {
  assert.doesNotMatch(
    REVIEW_FINDING_TRIAGE_CONTRACT,
    /[\u3400-\u9fff]/u,
    'the injected open-source REVIEW triage contract is English-only',
  );
  for (const roleId of MODULAR_REVIEWER_ROLE_IDS) {
    const entry = registry.agents.find(candidate => candidate.agentId === roleId);
    assert.ok(entry, `${roleId} is registered`);
    const frozenLegacyReconstruction = restoreLegacyPromptTemplate(entry);
    assert.equal(occurrenceCount(frozenLegacyReconstruction, reviewFindingTriageContractMarker), 0, `${roleId} frozen reconstruction excludes the appended contract`);
    assert.equal(
      createHash('sha256').update(frozenLegacyReconstruction).digest('hex'),
      frozenReviewerLegacyReconstructionDigests[roleId],
      `${roleId} frozen legacy reconstruction digest remains byte-for-byte unchanged`,
    );
    for (const mode of ['legacy-full-context', 'full-envelope'] as const) {
      const body = resolvePromptTemplateBody(entry, mode);
      assert.equal(occurrenceCount(body, reviewFindingTriageContractMarker), 1, `${roleId}/${mode} receives one contract`);
      assert.ok(body.endsWith(`${REVIEW_FINDING_TRIAGE_CONTRACT}\n`), `${roleId}/${mode} receives canonical contract bytes`);
      assertReviewFindingTriageSemantics(body, `${roleId}/${mode}`);
    }
  }
  for (const entry of registry.agents) {
    if (MODULAR_REVIEWER_ROLE_IDS.includes(entry.agentId as typeof MODULAR_REVIEWER_ROLE_IDS[number])) continue;
    for (const mode of ['legacy-full-context', 'full-envelope'] as const) {
      assert.equal(occurrenceCount(resolvePromptTemplateBody(entry, mode), reviewFindingTriageContractMarker), 0, `${entry.agentId}/${mode} receives no REVIEW contract`);
    }
  }
  for (let mask = 0; mask < 2 ** MODULAR_REVIEWER_ROLE_IDS.length; mask += 1) {
    const roles = Object.fromEntries(MODULAR_REVIEWER_ROLE_IDS.map((roleId, index) => [
      roleId,
      (mask & (1 << index)) === 0 ? 'legacy-full-context' : 'full-envelope',
    ]));
    const config = { version: PROMPT_ENVELOPE_ROLLOUT_VERSION, roles };
    for (const roleId of MODULAR_REVIEWER_ROLE_IDS) {
      assert.equal(occurrenceCount(resolvePromptRoleBody(roleId, config).body, reviewFindingTriageContractMarker), 1, `mixed rollout mask ${mask} delivers one contract to ${roleId}`);
    }
  }
  assertReviewFindingTriageMutationFailures();
}

function assertOwnerAndImplementerTriageGuidance(): void {
  const ownerGuide = readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8');
  for (const phrase of [
    'Every Finding reported only in reviewer prose must be redispatched for structured registration',
    'introduced or worsened by the current Story',
    'directly blocks acceptance or the core user result',
    'would make lifecycle gate evidence or gate truth misleading',
    'including a medium Finding in a policy round where medium is blocking',
    'Critical or high Findings must never be left without a traceable owner',
    'the Dynamic Finding System execution plan is future authority',
    'use only fields and commands exposed by the current CLI compatibility path',
    'never fabricate an assessment field, verdict, owner, route, signature, freshness result, or receipt',
    '`finding_dismiss` is temporary compatibility accounting for a round or profile',
    'does not prove applicability, repair, or resolution',
    'does not prove `out_of_scope`',
    'is not mechanically enforced by prompt text alone',
    'prompt text does not mechanically enforce this discipline',
  ]) {
    assert.ok(ownerGuide.includes(phrase), `Story Owner guidance keeps triage phrase: ${phrase}`);
  }
  const ownerTriageLines = ownerGuide
    .split('\n')
    .filter(line => /REVIEW Finding handling|Bounded current-Story repair|Evidence-backed routing|Compatibility boundary and dismissal/.test(line));
  const ownerTriageSlice = ownerTriageLines.join('\n');
  assert.equal(ownerTriageLines.length, 4, 'all four Story Owner triage rules are isolated for language audit');
  assert.doesNotMatch(ownerTriageSlice, /[\u3400-\u9fff]/u, 'the added Story Owner triage slice is English-only');

  const claudeGuide = readFileSync(join(projectRoot, 'CLAUDE.md'), 'utf8');
  const claudeTriageLines = claudeGuide
    .split('\n')
    .filter(line => /REVIEW Finding handling|Bounded current-Story repair|Evidence-backed routing|Compatibility boundary and dismissal/.test(line));
  assert.deepEqual(claudeTriageLines, ownerTriageLines, 'Claude and Codex Story Owner guidance is byte-identical');
  assert.doesNotMatch(claudeTriageLines.join('\n'), /[\u3400-\u9fff]/u, 'the Claude Story Owner triage slice is English-only');
  for (const [file, slice] of [['AGENTS.md', ownerTriageSlice], ['CLAUDE.md', claudeTriageLines.join('\n')]] as const) {
    for (const phrase of ownerTriageImmutablePhrases) {
      assert.ok(slice.includes(phrase), `${file} Owner triage slice retains immutable phrase: ${phrase}`);
    }
  }

  const implementerGuide = readFileSync(join(registry.root, 'lattice-implementer.md'), 'utf8');
  for (const phrase of [
    'Preserve its reproduction evidence and impact evidence',
    'Report it to the Story Owner',
    'Never widen the assigned item or Story unilaterally',
  ]) {
    assert.ok(implementerGuide.includes(phrase), `implementer guidance keeps triage phrase: ${phrase}`);
  }
  const implementerTriageLine = implementerGuide
    .split('\n')
    .find(line => line.includes('**Out-of-item finding discipline**')) ?? '';
  assert.ok(implementerTriageLine, 'the implementer triage rule is present');
  assert.doesNotMatch(implementerTriageLine, /[\u3400-\u9fff]/u, 'the added implementer triage rule is English-only');
}

assertReviewFindingTriageDelivery();
assertOwnerAndImplementerTriageGuidance();
if (process.argv.includes('--review-finding-triage-only')) {
  console.log('review finding triage registry delivery smoke: PASS');
  process.exit(0);
}

assert.equal(registry.schemaVersion, PROMPT_REGISTRY_VERSION);
assert.equal(registry.source, PROMPT_REGISTRY_SOURCE);
assert.equal(registry.agentCount, files.length);
assert.ok(registry.agentCount > 0, 'registry should expose package prompt templates');
assert.deepEqual(registry.agents.map(agent => agent.file), files);

const material = createHash('sha256');
material.update(`${PROMPT_REGISTRY_VERSION}\n`);
for (const entry of registry.agents) {
  const source = readFileSync(entry.sourcePath, 'utf8');
  const sourceHash = createHash('sha256').update(source).digest('hex');
  assert.equal(entry.templateHash, sourceHash, `${entry.file} template hash matches source`);
  const isComplexRole = MODULAR_COMPLEX_ROLE_IDS.includes(entry.agentId as typeof MODULAR_COMPLEX_ROLE_IDS[number]);
  const expectedClaude = renderPromptEntryForHost(entry, 'claude');
  const expectedCodex = renderPromptEntryForHost(entry, 'codex');
  if (MODULAR_REVIEWER_ROLE_IDS.includes(entry.agentId as typeof MODULAR_REVIEWER_ROLE_IDS[number])) {
    assert.match(expectedClaude, /review_run_start/, `${entry.file} Claude registry render is bootstrap-only`);
    assert.match(expectedCodex, /review_run_start/, `${entry.file} Codex registry render is bootstrap-only`);
    assert.equal(occurrenceCount(expectedClaude, reviewFindingTriageContractMarker), 0, `${entry.file} Claude bootstrap does not duplicate the runtime role contract`);
    assert.equal(occurrenceCount(expectedCodex, reviewFindingTriageContractMarker), 0, `${entry.file} Codex bootstrap does not duplicate the runtime role contract`);
    assert.doesNotMatch(expectedClaude, /proofbound:modular-role-body:v1/, `${entry.file} Claude registry excludes role body`);
    assert.doesNotMatch(expectedCodex, /proofbound:modular-role-body:v1/, `${entry.file} Codex registry excludes role body`);
  } else if (!isComplexRole) {
    assert.equal(expectedClaude, source, `${entry.file} Claude render matches template`);
  }
  if (isComplexRole) {
    const legacy = restoreLegacyPromptTemplate(entry);
    assert.equal(expectedClaude, legacy, `${entry.file} rejected rollout defaults Claude to frozen legacy bytes`);
    assert.equal(expectedCodex, renderCodexAgentContent(legacy), `${entry.file} rejected rollout defaults Codex to frozen legacy bytes`);
    assert.equal(renderPromptEntryForHost(entry, 'claude', 'full-envelope'), source, `${entry.file} modular Claude render remains explicitly selectable`);
    assert.equal(renderPromptEntryForHost(entry, 'codex', 'full-envelope'), renderCodexAgentContent(source), `${entry.file} modular Codex render remains explicitly selectable`);
    assert.notEqual(expectedClaude, source, `${entry.file} rejected rollout cannot yield the modular Claude render`);
  } else if (!MODULAR_REVIEWER_ROLE_IDS.includes(entry.agentId as typeof MODULAR_REVIEWER_ROLE_IDS[number])) {
    assert.equal(expectedCodex, renderCodexAgentContent(source), `${entry.file} Codex render matches legacy transform`);
  }
  if (!MODULAR_REVIEWER_ROLE_IDS.includes(entry.agentId as typeof MODULAR_REVIEWER_ROLE_IDS[number])) {
    assert.equal(occurrenceCount(expectedClaude, reviewFindingTriageContractMarker), 0, `${entry.file} Claude render receives no REVIEW triage contract`);
    assert.equal(occurrenceCount(expectedCodex, reviewFindingTriageContractMarker), 0, `${entry.file} Codex render receives no REVIEW triage contract`);
  }
  if (loadBearingPromptFiles.has(entry.file)) {
    assert.equal(extractLatticeBlock(source), LOAD_BEARING_LATTICE_PROMPT_SLICE, `${entry.file} uses canonical load-bearing prompt slice`);
    for (const phrase of requiredSafetyPhrases) {
      assert.ok(source.includes(phrase), `${entry.file} keeps load-bearing prompt phrase: ${phrase}`);
    }
  }
  if (entry.file === 'lattice-review-quality.md') {
    for (const phrase of qualityProofMetadataPhrases) {
      assert.ok(source.includes(phrase), `${entry.file} keeps proof metadata review phrase: ${phrase}`);
    }
  }
  const claudeMirrorPath = join(projectRoot, '.claude', 'agents', entry.file);
  if (existsSync(claudeMirrorPath)) {
    assert.equal(readFileSync(claudeMirrorPath, 'utf8'), expectedClaude, `${entry.file} .claude asset matches its canonical host input`);
  }
  const codexMirrorPath = join(projectRoot, adapterDirName(projectRoot), 'agents', entry.file);
  if (existsSync(codexMirrorPath)) {
    assert.equal(readFileSync(codexMirrorPath, 'utf8'), expectedCodex, `${entry.file} .lattice-codex asset matches its canonical host input`);
  }
  material.update(`${entry.file}\0${entry.templateHash}\0${entry.bytes}\n`);
}
assert.equal(registry.materialHash, material.digest('hex'), 'registry material hash is deterministic');

assert.deepEqual(
  [...ACTIVE_MODULAR_REVIEWER_ROLE_IDS],
  [...MODULAR_REVIEWER_ROLE_IDS],
  'the modular rollout roster is exactly the five active REVIEW lanes',
);
const fullRoles = Object.fromEntries(MODULAR_REVIEWER_ROLE_IDS.map(roleId => [roleId, 'full-envelope']));
const fullConfig = { version: PROMPT_ENVELOPE_ROLLOUT_VERSION, roles: fullRoles };
for (const roleId of MODULAR_REVIEWER_ROLE_IDS) {
  const entry = registry.agents.find(candidate => candidate.agentId === roleId)!;
  const legacy = resolvePromptRoleBody(roleId, {
    version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
    roles: { [roleId]: 'legacy-full-context' },
  });
  const modular = resolvePromptRoleBody(roleId, fullConfig);
  const frozenLegacyBody = restoreLegacyPromptTemplate(entry);
  const modularSourceBody = readFileSync(entry.sourcePath, 'utf8');
  assert.ok(legacy.body.startsWith(frozenLegacyBody.trimEnd()), `${roleId} rollback preserves frozen bytes before the appended contract`);
  assert.equal(occurrenceCount(frozenLegacyBody, reviewFindingTriageContractMarker), 0, `${roleId} frozen legacy reconstruction digest remains unchanged`);
  assert.equal(occurrenceCount(legacy.body, reviewFindingTriageContractMarker), 1, `${roleId} legacy path appends one triage contract`);
  assert.ok(legacy.body.endsWith(`${REVIEW_FINDING_TRIAGE_CONTRACT}\n`), `${roleId} legacy path appends canonical contract bytes`);
  assert.equal(legacy.legacyBytesRestored, true);
  assert.equal(modular.mode, 'full-envelope');
  assert.equal(modular.legacyBytesRestored, false);
  assert.ok(Buffer.byteLength(modular.body) < Buffer.byteLength(legacy.body), `${roleId} modular body is smaller`);
  assert.notEqual(modular.bodyDigest, legacy.bodyDigest, `${roleId} bodies are independently content-addressed`);
  assert.ok(modular.body.startsWith(modularSourceBody.trimEnd()), `${roleId} package asset precedes the appended contract`);
  assert.equal(occurrenceCount(modularSourceBody, reviewFindingTriageContractMarker), 0, `${roleId} package asset does not duplicate the injected contract`);
  assert.equal(occurrenceCount(modular.body, reviewFindingTriageContractMarker), 1, `${roleId} full-envelope path appends one triage contract`);
  assert.ok(modular.body.endsWith(`${REVIEW_FINDING_TRIAGE_CONTRACT}\n`), `${roleId} full-envelope path appends canonical contract bytes`);
  assertReviewFindingTriageSemantics(legacy.body, `${roleId} legacy path`);
  assertReviewFindingTriageSemantics(modular.body, `${roleId} full-envelope path`);
  assert.equal(extractLatticeBlock(modular.body), null, `${roleId} modular body contains no legacy Runtime Guide`);
  assert.ok(modular.body.includes('proofbound:modular-role-body:v1'), `${roleId} keeps the legacy reconstruction anchor`);
  for (const host of ['claude', 'codex'] as const) {
    const identity = reviewerHostRenderIdentity(projectRoot, roleId, host, 'full-envelope');
    assert.equal(identity.rolloutMode, 'full-envelope');
    assert.ok(identity.hostRenderDigest.length > 0, `${roleId}/${host} binds the actual modular host render`);
    assert.ok(identity.selectedRoleBodyDigest.length > 0, `${roleId}/${host} binds the selected role body`);
    assert.ok(identity.bootstrapDigest?.length, `${roleId}/${host} binds the canonical bootstrap in ${identity.source} mode`);
  }

  const oneRoleConfig = {
    version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
    roles: { [roleId]: 'full-envelope' },
  };
  for (const otherRoleId of MODULAR_REVIEWER_ROLE_IDS) {
    assert.equal(
      resolvePromptEnvelopeRolloutMode(otherRoleId, oneRoleConfig),
      otherRoleId === roleId ? 'full-envelope' : 'legacy-full-context',
      `${roleId} rollout flag does not bleed into ${otherRoleId}`,
    );
  }
}
for (let mask = 0; mask < 2 ** MODULAR_REVIEWER_ROLE_IDS.length; mask += 1) {
  const roles = Object.fromEntries(MODULAR_REVIEWER_ROLE_IDS.map((roleId, index) => [
    roleId,
    (mask & (1 << index)) === 0 ? 'legacy-full-context' : 'full-envelope',
  ]));
  const config = { version: PROMPT_ENVELOPE_ROLLOUT_VERSION, roles };
  for (const [roleId, expected] of Object.entries(roles)) {
    assert.equal(resolvePromptEnvelopeRolloutMode(roleId, config), expected, `mixed rollout mask ${mask} keeps ${roleId}`);
    assert.equal(
      occurrenceCount(resolvePromptRoleBody(roleId, config).body, reviewFindingTriageContractMarker),
      1,
      `mixed rollout mask ${mask} delivers one triage contract to ${roleId}`,
    );
  }
}
assert.equal(resolvePromptEnvelopeRolloutMode('lattice-review-concept', undefined), 'legacy-full-context');
for (const roles of [
  { 'lattice-review-channel': 'full-envelope' },
  { 'implementation-reviewer': 'full-envelope' },
  { 'unknown-reviewer': 'full-envelope' },
]) {
  assert.throws(
    () => resolvePromptEnvelopeRolloutMode('lattice-review-concept', {
      version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
      roles,
    }),
    PromptRoleContractRegistryError,
  );
}
for (const [source, expected] of [
  [
    '{"promptEnvelope":{"version":"proofbound.prompt-envelope-rollout.v1","roles":{}},"promptEnvelope":{"version":"proofbound.prompt-envelope-rollout.v1","roles":{"lattice-review-quality":"full-envelope"}}}',
    /duplicate promptEnvelope key/,
  ],
  [
    '{"promptEnvelope":{"version":"proofbound.prompt-envelope-rollout.v1","roles":{},"roles":{"lattice-review-quality":"full-envelope"}}}',
    /duplicate promptEnvelope\.roles key/,
  ],
  [
    '{"promptEnvelope":{"version":"proofbound.prompt-envelope-rollout.v1","roles":{"lattice-review-quality":"full-envelope","lattice-review-quality":"legacy-full-context"}}}',
    /duplicate promptEnvelope\.roles\.lattice-review-quality key/,
  ],
] as const) {
  assert.throws(() => assertNoDuplicatePromptEnvelopeRoleKeys(source), expected);
}
for (const malformed of [
  { version: 'proofbound.prompt-envelope-rollout.v0', roles: {} },
  { version: PROMPT_ENVELOPE_ROLLOUT_VERSION, roles: { 'lattice-review-quality': 'unknown-mode' } },
  { version: PROMPT_ENVELOPE_ROLLOUT_VERSION, roles: JSON.parse('{"__proto__":"full-envelope"}') },
]) {
  assert.throws(
    () => resolvePromptEnvelopeRolloutMode('lattice-review-quality', malformed),
    PromptRoleContractRegistryError,
  );
}

console.log(`✓ prompt registry smoke passed: ${registry.agentCount} agents rendered for claude and codex`);
