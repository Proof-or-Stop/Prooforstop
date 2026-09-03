#!/usr/bin/env node
/**
 * @task B-9b76
 * @checklist CHK-003
 * @title Codex registry-mode adapter checks
 * @type feature
 * @priority high
 * @description
 * Verifies that verify_codex keeps proof-or-stop mirror mode strict while accepting
 * registry-backed thin prompt assets without .proof-or-stop-codex/agents, and rejects
 * legacy-only adapter assets as an active runtime path.
 * @changes
 * - [CHK-003] Cover proof-or-stop mirror, registry thin, registry drift, tampered registry hash,
 *   and legacy-only adapter rejection.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderCodexAgentContent,
  renderCodexEvidencePretoolHookScript,
  renderProofOrStopBootstrapScript,
  renderProofOrStopCodexAdapterManifest,
  renderCodexPretoolScopeHookScript,
  renderProofOrStopCodexWrapperScript,
} from '../init-assets.js';
import { runCodexAdapterChecks, renderCodexAdapterChecks } from '../core/codex-adapter-checks.js';
import { reviewerHostRenderIdentity } from '../core/prompt-role-contract-registry.js';
import {
  readPromptRegistry,
  readPromptTemplate,
  renderPromptEntryForHost,
} from '../core/prompt-registry.js';
import { renderReviewerRunBootstrapForTemplate } from '../core/global-agents.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = join(packageRoot, '..', '..');

const renderedScopeHook = renderCodexPretoolScopeHookScript();
const renderedEvidenceHook = renderCodexEvidencePretoolHookScript();
assert.match(renderedScopeHook, /@proof-or-stop', 'core', 'dist', 'cli\.js'/, 'generated scope hook must resolve the canonical core package');
assert.match(renderedEvidenceHook, /@proof-or-stop', 'core', 'dist', 'cli\.js'/, 'generated evidence hook must resolve the canonical core package');

function writeText(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function makeRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `lattice-${name}-`));
  writeText(root, 'bin/proof-or-stop.js', renderProofOrStopBootstrapScript(packageRoot));
  writeText(root, 'bin/proof-or-stop-codex.js', renderProofOrStopCodexWrapperScript());
  seedCodexNativeHooks(root);
  return root;
}

function seedCodexNativeHooks(root: string): void {
  for (const relPath of ['.codex/hooks.json', '.codex/hooks/proof-or-stop-scope-pretool.cjs']) {
    writeText(root, relPath, readFileSync(join(repoRoot, relPath), 'utf8'));
  }
}

function seedLegacyPrompts(root: string): void {
  const registry = readPromptRegistry();
  for (const entry of registry.agents) {
    writeText(root, `.claude/agents/${entry.file}`, renderPromptEntryForHost(entry, 'claude'));
    writeText(root, `.proof-or-stop-codex/agents/${entry.file}`, renderPromptEntryForHost(entry, 'codex'));
  }
}

function checkById(result: ReturnType<typeof runCodexAdapterChecks>, id: string) {
  const check = result.checks.find(check => check.id === id);
  assert.ok(check, `expected check ${id}`);
  return check;
}

function assertOk(result: ReturnType<typeof runCodexAdapterChecks>): void {
  assert.equal(result.ok, true, renderCodexAdapterChecks(result));
}

const mirrorRoot = makeRoot('codex-mirror');
try {
  writeText(mirrorRoot, '.proof-or-stop-codex/proof-or-stop.json', renderProofOrStopCodexAdapterManifest());
  seedLegacyPrompts(mirrorRoot);
  const mirror = runCodexAdapterChecks(mirrorRoot, { executeHeartbeats: false });
  assertOk(mirror);
  assert.equal(checkById(mirror, 'manifest').status, 'pass');
  assert.equal(checkById(mirror, 'agents-mirror').status, 'pass');
  assert.equal(mirror.checks.some(check => check.id === 'prompt-registry'), false);
} finally {
  rmSync(mirrorRoot, { recursive: true, force: true });
}

const jointlyDriftedHostRoot = makeRoot('codex-joint-host-drift');
try {
  writeText(jointlyDriftedHostRoot, '.proof-or-stop-codex/proof-or-stop.json', renderProofOrStopCodexAdapterManifest());
  seedLegacyPrompts(jointlyDriftedHostRoot);
  const file = 'proof-or-stop-review-quality.md';
  const drift = '\n<!-- jointly drifted host asset -->\n';
  for (const relPath of [`.claude/agents/${file}`, `.proof-or-stop-codex/agents/${file}`]) {
    const path = join(jointlyDriftedHostRoot, relPath);
    writeText(jointlyDriftedHostRoot, relPath, readFileSync(path, 'utf8') + drift);
  }
  const result = runCodexAdapterChecks(jointlyDriftedHostRoot, { executeHeartbeats: false });
  assert.equal(result.ok, false, 'joint Claude/Codex drift cannot evade the package render identity');
  assert.equal(checkById(result, 'agents-mirror').status, 'fail');
  assert.match(checkById(result, 'agents-mirror').detail, /package\/Claude drift proof-or-stop-review-quality\.md/);
} finally {
  rmSync(jointlyDriftedHostRoot, { recursive: true, force: true });
}

const legacyOnlyRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-codex-legacy-only-'));
try {
  writeText(legacyOnlyRoot, '.proof-or-stop-codex/legacy.json', renderProofOrStopCodexAdapterManifest());
  writeText(legacyOnlyRoot, 'bin/legacy-bootstrap.js', renderProofOrStopBootstrapScript(packageRoot));
  writeText(legacyOnlyRoot, 'bin/legacy-codex.js', renderProofOrStopCodexWrapperScript());
  seedCodexNativeHooks(legacyOnlyRoot);
  seedLegacyPrompts(legacyOnlyRoot);
  const legacyOnly = runCodexAdapterChecks(legacyOnlyRoot, { executeHeartbeats: false });
  assert.equal(legacyOnly.ok, false, 'legacy-only adapter assets must not satisfy verify_codex');
  assert.equal(checkById(legacyOnly, 'manifest').status, 'fail');
  assert.equal(checkById(legacyOnly, 'local-wrapper').status, 'fail');
} finally {
  rmSync(legacyOnlyRoot, { recursive: true, force: true });
}

const thinRoot = makeRoot('codex-thin');
try {
  const canonicalManifest = JSON.parse(renderProofOrStopCodexAdapterManifest({ promptMode: 'registry' }));
  assert.equal(canonicalManifest.promptRegistry.schemaVersion, 'proof-or-stop.prompt-registry.v1', 'new manifests emit the canonical prompt-registry schema');
  writeText(thinRoot, '.proof-or-stop-codex/proof-or-stop.json', `${JSON.stringify(canonicalManifest, null, 2)}\n`);
  const thin = runCodexAdapterChecks(thinRoot, { executeHeartbeats: false });
  assertOk(thin);
  assert.equal(checkById(thin, 'manifest').status, 'pass');
  assert.equal(checkById(thin, 'prompt-registry').status, 'pass');
  assert.equal(thin.checks.some(check => check.id === 'agents-mirror'), false);
  const entry = readPromptRegistry().agents.find(candidate => candidate.agentId === 'proof-or-stop-review-quality')!;
  const actualCodexRegistryPrompt = renderPromptEntryForHost(entry, 'codex');
  assert.match(actualCodexRegistryPrompt, /review_run_start/, 'registry mode returns the reviewer bootstrap');
  assert.doesNotMatch(actualCodexRegistryPrompt, /proofbound:modular-role-body:v1/, 'registry mode never preloads the role body');
  const identity = reviewerHostRenderIdentity(thinRoot, 'proof-or-stop-review-quality', 'codex');
  assert.equal(identity.host, 'codex');
  assert.equal(identity.source, 'package-registry');
  assert.equal(identity.hostRenderDigest.length, 64);
  assert.equal(identity.bootstrapDigest?.length, 64, 'registry mode binds the same body-free review bootstrap');
  assert.notEqual(identity.bootstrapDigest, identity.selectedRoleBodyDigest);

  const legacyManifest = { ...canonicalManifest, promptRegistry: {
    ...canonicalManifest.promptRegistry,
    schemaVersion: 'lattice.prompt-registry.v1',
  } };
  writeText(thinRoot, '.proof-or-stop-codex/proof-or-stop.json', `${JSON.stringify(legacyManifest, null, 2)}\n`);
  const legacy = runCodexAdapterChecks(thinRoot, { executeHeartbeats: false });
  assertOk(legacy);
  assert.equal(checkById(legacy, 'manifest').status, 'pass', 'legacy prompt-registry schema remains readable');
} finally {
  rmSync(thinRoot, { recursive: true, force: true });
}

const globalThinRoot = makeRoot('global-thin-host-render');
try {
  writeText(globalThinRoot, '.lattice/lattice.json', `${JSON.stringify({ assetMode: 'global-thin' }, null, 2)}\n`);
  const codexIdentity = reviewerHostRenderIdentity(globalThinRoot, 'proof-or-stop-review-quality', 'codex');
  const claudeIdentity = reviewerHostRenderIdentity(globalThinRoot, 'proof-or-stop-review-quality', 'claude');
  const entry = readPromptRegistry().agents.find(candidate => candidate.agentId === 'proof-or-stop-review-quality')!;
  assert.match(renderPromptEntryForHost(entry, 'codex'), /review_run_start/);
  assert.match(renderPromptEntryForHost(entry, 'claude'), /review_run_start/);
  assert.equal(codexIdentity.source, 'package-registry');
  assert.equal(claudeIdentity.source, 'package-registry');
  assert.equal(codexIdentity.bootstrapDigest?.length, 64);
  assert.equal(claudeIdentity.bootstrapDigest?.length, 64);
  assert.notEqual(codexIdentity.identityDigest, claudeIdentity.identityDigest, 'host is part of the render identity');
} finally {
  rmSync(globalThinRoot, { recursive: true, force: true });
}

const fullCodexOnlyRoot = makeRoot('full-codex-only-host-render');
try {
  writeText(fullCodexOnlyRoot, '.lattice/lattice.json', `${JSON.stringify({ assetMode: 'full' }, null, 2)}\n`);
  const entry = readPromptRegistry().agents.find(candidate => candidate.agentId === 'proof-or-stop-review-quality')!;
  const packagePrompt = readPromptTemplate(entry);
  const codexBootstrap = renderReviewerRunBootstrapForTemplate(renderCodexAgentContent(packagePrompt), entry.file);
  writeText(fullCodexOnlyRoot, `.proof-or-stop-codex/agents/${entry.file}`, codexBootstrap);
  const identity = reviewerHostRenderIdentity(fullCodexOnlyRoot, entry.agentId, 'codex');
  assert.equal(identity.source, 'full-asset');
  assert.equal(identity.bootstrapDigest?.length, 64);
  assert.equal(identity.selectedRoleBodyDigest.length, 64);
  assert.notEqual(identity.bootstrapDigest, identity.selectedRoleBodyDigest);
  const legacyIdentity = reviewerHostRenderIdentity(
    fullCodexOnlyRoot,
    entry.agentId,
    'codex',
    'legacy-full-context',
  );
  assert.equal(legacyIdentity.bootstrapDigest, identity.bootstrapDigest, 'rollout mode does not change the host bootstrap');
  assert.notEqual(
    legacyIdentity.selectedRoleBodyDigest,
    identity.selectedRoleBodyDigest,
    'rollout mode selects exactly one independently bound role body',
  );
  assert.throws(
    () => reviewerHostRenderIdentity(fullCodexOnlyRoot, entry.agentId, 'claude'),
    /missing claude reviewer prompt asset/,
    'a missing Claude mirror does not prevent the Codex host from establishing its own identity',
  );
  writeText(
    fullCodexOnlyRoot,
    `.proof-or-stop-codex/agents/${entry.file}`,
    `${codexBootstrap}\n<!-- codex-only drift -->\n`,
  );
  assert.throws(
    () => reviewerHostRenderIdentity(fullCodexOnlyRoot, entry.agentId, 'codex'),
    /codex reviewer prompt asset drift/,
  );
} finally {
  rmSync(fullCodexOnlyRoot, { recursive: true, force: true });
}

const fullClaudeOnlyRoot = makeRoot('full-claude-only-host-render');
try {
  writeText(fullClaudeOnlyRoot, '.lattice/lattice.json', `${JSON.stringify({ assetMode: 'full' }, null, 2)}\n`);
  const entry = readPromptRegistry().agents.find(candidate => candidate.agentId === 'proof-or-stop-review-quality')!;
  const packagePrompt = readPromptTemplate(entry);
  writeText(
    fullClaudeOnlyRoot,
    `.claude/agents/${entry.file}`,
    renderReviewerRunBootstrapForTemplate(packagePrompt, entry.file),
  );
  const identity = reviewerHostRenderIdentity(fullClaudeOnlyRoot, entry.agentId, 'claude');
  assert.equal(identity.source, 'full-asset');
  assert.equal(identity.bootstrapDigest?.length, 64);
  assert.equal(identity.selectedRoleBodyDigest.length, 64);
  assert.throws(
    () => reviewerHostRenderIdentity(fullClaudeOnlyRoot, entry.agentId, 'codex'),
    /missing codex reviewer prompt asset/,
    'a missing Codex mirror does not prevent the Claude host from establishing its own identity',
  );
} finally {
  rmSync(fullClaudeOnlyRoot, { recursive: true, force: true });
}

const driftRoot = makeRoot('codex-registry-drift');
try {
  const manifest = JSON.parse(renderProofOrStopCodexAdapterManifest({ promptMode: 'registry' }));
  manifest.recommendedEntrypoints[0].command = 'node bin/changed.js';
  writeText(driftRoot, '.proof-or-stop-codex/proof-or-stop.json', `${JSON.stringify(manifest, null, 2)}\n`);
  const drift = runCodexAdapterChecks(driftRoot, { executeHeartbeats: false });
  assert.equal(drift.ok, false, 'registry manifest static drift must be a hard failure');
  assert.equal(checkById(drift, 'manifest').status, 'fail');
  assert.match(checkById(drift, 'manifest').detail, /registry template/);
  assert.equal(checkById(drift, 'prompt-registry').status, 'pass');
} finally {
  rmSync(driftRoot, { recursive: true, force: true });
}

const tamperedRoot = makeRoot('codex-tampered');
try {
  const manifest = JSON.parse(renderProofOrStopCodexAdapterManifest({ promptMode: 'registry' }));
  manifest.promptRegistry.materialHash = 'tampered';
  writeText(tamperedRoot, '.proof-or-stop-codex/proof-or-stop.json', `${JSON.stringify(manifest, null, 2)}\n`);
  const tampered = runCodexAdapterChecks(tamperedRoot, { executeHeartbeats: false });
  assert.equal(tampered.ok, false, 'tampered registry manifest must be a hard failure');
  assert.equal(checkById(tampered, 'manifest').status, 'fail');
  assert.match(checkById(tampered, 'manifest').detail, /promptRegistry mismatch/);
  assert.equal(checkById(tampered, 'prompt-registry').status, 'pass');
} finally {
  rmSync(tamperedRoot, { recursive: true, force: true });
}

console.log('✓ codex registry mode smoke passed');
