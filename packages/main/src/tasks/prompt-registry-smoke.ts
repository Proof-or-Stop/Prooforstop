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
import { LOAD_BEARING_PROOF_OR_STOP_PROMPT_SLICE, MODULAR_COMPLEX_ROLE_IDS, MODULAR_REVIEWER_ROLE_IDS, PROMPT_REGISTRY_SOURCE, PROMPT_REGISTRY_VERSION, listPromptTemplateFiles, readPromptRegistry, renderPromptEntryForHost, restoreLegacyPromptTemplate } from '../core/prompt-registry.js';
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
import { PROOF_OR_STOP_ADAPTER_DIR } from '../core/brand-paths.js';

const registry = readPromptRegistry();
const files = listPromptTemplateFiles(registry.root);
const projectRoot = join(registry.root, '..', '..', '..', '..');
const loadBearingPromptFiles = new Set([
  'proof-or-stop-review-channel.md',
  'proof-or-stop-evaluator-cli.md',
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
function extractLatticeBlock(content: string): string | null {
  return content.match(/<!-- proof-or-stop:start -->[\s\S]*?<!-- proof-or-stop:end -->/)?.[0]
    ?? content.match(/<!-- lattice:start -->[\s\S]*?<!-- lattice:end -->/)?.[0]
    ?? null;
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
  const canonicalSource = renderPromptEntryForHost(entry, 'claude', 'full-envelope');
  if (ACTIVE_MODULAR_REVIEWER_ROLE_IDS.includes(entry.agentId as typeof ACTIVE_MODULAR_REVIEWER_ROLE_IDS[number])) {
    assert.match(expectedClaude, /review_run_start/, `${entry.file} Claude registry render is bootstrap-only`);
    assert.match(expectedCodex, /review_run_start/, `${entry.file} Codex registry render is bootstrap-only`);
    assert.doesNotMatch(expectedClaude, /proofbound:modular-role-body:v1/, `${entry.file} Claude registry excludes role body`);
    assert.doesNotMatch(expectedCodex, /proofbound:modular-role-body:v1/, `${entry.file} Codex registry excludes role body`);
  } else if (!isComplexRole) {
    assert.equal(expectedClaude, canonicalSource, `${entry.file} Claude render matches canonical template output`);
  }
  if (isComplexRole) {
    const legacy = restoreLegacyPromptTemplate(entry);
    const canonicalLegacy = legacy
      .replace('<!-- lattice:start -->', '<!-- proof-or-stop:start -->')
      .replace('<!-- lattice:end -->', '<!-- proof-or-stop:end -->');
    assert.equal(expectedClaude, canonicalLegacy, `${entry.file} default full-context Claude render canonicalizes historical markers`);
    assert.equal(expectedCodex, renderCodexAgentContent(canonicalLegacy), `${entry.file} default full-context Codex render canonicalizes historical markers`);
    assert.match(legacy, /<!-- lattice:start -->[\s\S]*<!-- lattice:end -->/, `${entry.file} retains legacy markers only in historical reconstruction`);
    assert.equal(renderPromptEntryForHost(entry, 'claude', 'full-envelope'), source, `${entry.file} modular Claude render remains explicitly selectable`);
    assert.equal(renderPromptEntryForHost(entry, 'codex', 'full-envelope'), renderCodexAgentContent(source), `${entry.file} modular Codex render remains explicitly selectable`);
    assert.notEqual(expectedClaude, source, `${entry.file} rejected rollout cannot yield the modular Claude render`);
  } else if (!ACTIVE_MODULAR_REVIEWER_ROLE_IDS.includes(entry.agentId as typeof ACTIVE_MODULAR_REVIEWER_ROLE_IDS[number])) {
    assert.equal(expectedCodex, renderCodexAgentContent(canonicalSource), `${entry.file} Codex render matches canonical transform`);
  }
  if (loadBearingPromptFiles.has(entry.file)) {
    assert.equal(extractLatticeBlock(source), LOAD_BEARING_PROOF_OR_STOP_PROMPT_SLICE, `${entry.file} uses the canonical load-bearing prompt slice`);
    assert.match(source, /<!-- proof-or-stop:start -->[\s\S]*<!-- proof-or-stop:end -->/);
    assert.doesNotMatch(source, /<!-- lattice:start -->[\s\S]*<!-- lattice:end -->/);
    for (const phrase of requiredSafetyPhrases) {
      assert.ok(source.includes(phrase), `${entry.file} keeps load-bearing prompt phrase: ${phrase}`);
    }
  }
  if (entry.file === 'proof-or-stop-review-quality.md') {
    for (const phrase of qualityProofMetadataPhrases) {
      assert.ok(source.includes(phrase), `${entry.file} keeps proof metadata review phrase: ${phrase}`);
    }
  }
  const claudeMirrorPath = join(projectRoot, '.claude', 'agents', entry.file);
  if (existsSync(claudeMirrorPath)) {
    assert.equal(readFileSync(claudeMirrorPath, 'utf8'), expectedClaude, `${entry.file} .claude asset matches its canonical host render`);
  }
  const codexMirrorPath = join(projectRoot, PROOF_OR_STOP_ADAPTER_DIR, 'agents', entry.file);
  if (existsSync(codexMirrorPath)) {
    assert.equal(readFileSync(codexMirrorPath, 'utf8'), expectedCodex, `${entry.file} .proof-or-stop-codex asset matches its canonical host render`);
  }
  material.update(`${entry.file}\0${entry.templateHash}\0${entry.bytes}\n`);
}
assert.equal(registry.materialHash, material.digest('hex'), 'registry material hash is deterministic');

assert.equal(MODULAR_REVIEWER_ROLE_IDS.length, 6, 'the migrated reviewer definition roster has exactly six roles');
assert.deepEqual(
  [...ACTIVE_MODULAR_REVIEWER_ROLE_IDS],
  MODULAR_REVIEWER_ROLE_IDS.filter(roleId => roleId !== 'proof-or-stop-review-topology-critic'),
  'the five active REVIEW lanes are the migrated reviewer roles other than topology critic',
);
assert.equal(ACTIVE_MODULAR_REVIEWER_ROLE_IDS.length, 5, 'the active REVIEW rollout roster remains exactly five lanes');
const fullRoles = Object.fromEntries(MODULAR_REVIEWER_ROLE_IDS.map(roleId => [roleId, 'full-envelope']));
const fullConfig = { version: PROMPT_ENVELOPE_ROLLOUT_VERSION, roles: fullRoles };
for (const roleId of MODULAR_REVIEWER_ROLE_IDS) {
  const entry = registry.agents.find(candidate => candidate.agentId === roleId)!;
  const legacy = resolvePromptRoleBody(roleId, {
    version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
    roles: { [roleId]: 'legacy-full-context' },
  });
  const modular = resolvePromptRoleBody(roleId, fullConfig);
  assert.equal(legacy.body, restoreLegacyPromptTemplate(entry), `${roleId} rollback restores frozen bytes`);
  assert.equal(legacy.legacyBytesRestored, true);
  assert.equal(modular.mode, 'full-envelope');
  assert.equal(modular.legacyBytesRestored, false);
  assert.ok(Buffer.byteLength(modular.body) < Buffer.byteLength(legacy.body), `${roleId} modular body is smaller`);
  assert.notEqual(modular.bodyDigest, legacy.bodyDigest, `${roleId} bodies are independently content-addressed`);
  assert.equal(modular.body, readFileSync(entry.sourcePath, 'utf8'), `${roleId} package asset is the actual modular body`);
  assert.equal(extractLatticeBlock(modular.body), null, `${roleId} modular body contains no legacy Runtime Guide`);
  assert.ok(modular.body.includes('proof-or-stop:modular-role-body:v1'), `${roleId} keeps the modular reconstruction anchor`);
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
  }
}
assert.equal(resolvePromptEnvelopeRolloutMode('proof-or-stop-review-concept', undefined), 'legacy-full-context');
for (const roles of [
  { 'proof-or-stop-review-channel': 'full-envelope' },
  { 'implementation-reviewer': 'full-envelope' },
  { 'unknown-reviewer': 'full-envelope' },
]) {
  assert.throws(
    () => resolvePromptEnvelopeRolloutMode('proof-or-stop-review-concept', {
      version: PROMPT_ENVELOPE_ROLLOUT_VERSION,
      roles,
    }),
    PromptRoleContractRegistryError,
  );
}
for (const [source, expected] of [
  [
    '{"promptEnvelope":{"version":"proofbound.prompt-envelope-rollout.v1","roles":{}},"promptEnvelope":{"version":"proofbound.prompt-envelope-rollout.v1","roles":{"proof-or-stop-review-quality":"full-envelope"}}}',
    /duplicate promptEnvelope key/,
  ],
  [
    '{"promptEnvelope":{"version":"proofbound.prompt-envelope-rollout.v1","roles":{},"roles":{"proof-or-stop-review-quality":"full-envelope"}}}',
    /duplicate promptEnvelope\.roles key/,
  ],
  [
    '{"promptEnvelope":{"version":"proofbound.prompt-envelope-rollout.v1","roles":{"proof-or-stop-review-quality":"full-envelope","proof-or-stop-review-quality":"legacy-full-context"}}}',
    /duplicate promptEnvelope\.roles\.proof-or-stop-review-quality key/,
  ],
] as const) {
  assert.throws(() => assertNoDuplicatePromptEnvelopeRoleKeys(source), expected);
}
for (const malformed of [
  { version: 'proofbound.prompt-envelope-rollout.v0', roles: {} },
  { version: PROMPT_ENVELOPE_ROLLOUT_VERSION, roles: { 'proof-or-stop-review-quality': 'unknown-mode' } },
  { version: PROMPT_ENVELOPE_ROLLOUT_VERSION, roles: JSON.parse('{"__proto__":"full-envelope"}') },
]) {
  assert.throws(
    () => resolvePromptEnvelopeRolloutMode('proof-or-stop-review-quality', malformed),
    PromptRoleContractRegistryError,
  );
}

console.log(`✓ prompt registry smoke passed: ${registry.agentCount} agents rendered for claude and codex`);
