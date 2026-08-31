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
const requiredReviewFindingTriagePhrases = [
  'evidenceState',
  'severity says how harmful it is',
  'applicability reports whether it belongs to this Story',
  'gate impact is computed by the current lifecycle policy',
  'Severity does not determine scope by itself',
  'Start the current lane with `proof-or-stop review_run_start`',
  'Carry its current `reviewRunId` on every `finding_add` or `review_pass_set` submission',
  'fail closed and keep it in the current Story',
  'including medium findings when the current round treats them as blocking',
  'Critical or high findings must never be left without an owner',
  'Do not expand the Story merely to make the repository globally green',
  'A bounded, evidence-backed route is not dismissal, resolution, or proof that the problem disappeared',
  'they do not repair implementation, rewrite scope, or create follow-up Stories',
  'Do not call `finding_dismiss`, `story_create`, or `gap_log` from a REVIEW lane',
  '`disproven` (evidence refutes the observation)',
  '`duplicate` (another tracked Finding owns the same defect)',
  '`stale_or_not_reproduced` (current evidence cannot reproduce an older claim)',
  'Never delete the original observation',
  'silently rewrite its severity',
  'append a traceable revision or superseding Finding',
];

function occurrenceCount(content: string, needle: string): number {
  return content.split(needle).length - 1;
}

function extractLatticeBlock(content: string): string | null {
  return content.match(/<!-- lattice:start -->[\s\S]*?<!-- lattice:end -->/)?.[0] ?? null;
}

function assertReviewFindingTriageDelivery(): void {
  for (const roleId of MODULAR_REVIEWER_ROLE_IDS) {
    const entry = registry.agents.find(candidate => candidate.agentId === roleId);
    assert.ok(entry, `${roleId} is registered`);
    assert.equal(occurrenceCount(restoreLegacyPromptTemplate(entry), reviewFindingTriageContractMarker), 0, `${roleId} frozen reconstruction is unchanged`);
    for (const mode of ['legacy-full-context', 'full-envelope'] as const) {
      const body = resolvePromptTemplateBody(entry, mode);
      assert.equal(occurrenceCount(body, reviewFindingTriageContractMarker), 1, `${roleId}/${mode} receives one contract`);
      assert.ok(body.endsWith(`${REVIEW_FINDING_TRIAGE_CONTRACT}\n`), `${roleId}/${mode} receives canonical contract bytes`);
      for (const phrase of requiredReviewFindingTriagePhrases) {
        assert.ok(body.includes(phrase), `${roleId}/${mode} keeps triage phrase: ${phrase}`);
      }
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
}

assertReviewFindingTriageDelivery();
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
  for (const phrase of requiredReviewFindingTriagePhrases) {
    assert.ok(legacy.body.includes(phrase), `${roleId} legacy path keeps triage phrase: ${phrase}`);
    assert.ok(modular.body.includes(phrase), `${roleId} full-envelope path keeps triage phrase: ${phrase}`);
  }
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
