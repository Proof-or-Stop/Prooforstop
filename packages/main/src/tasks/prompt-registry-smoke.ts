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
  PROMPT_REGISTRY_SOURCE,
  PROMPT_REGISTRY_VERSION,
  listPromptTemplateFiles,
  readPromptRegistry,
  renderPromptEntryForHost,
} from '../core/prompt-registry.js';
import { renderCodexAgentContent } from '../init-assets.js';

const registry = readPromptRegistry();
const files = listPromptTemplateFiles(registry.root);
const projectRoot = join(registry.root, '..', '..', '..', '..');
const loadBearingPromptFiles = new Set([
  'lattice-evaluator.md',
  'lattice-implementer.md',
  'lattice-review-behavior.md',
  'lattice-review-channel.md',
  'lattice-review-concept.md',
  'lattice-review-delivery.md',
  'lattice-review-docs.md',
  'lattice-review-quality.md',
  'lattice-review-scope-plan.md',
  'lattice-review-story-init.md',
]);
const requiredSafetyPhrases = [
  'Fresh-Context Fence',
  'Process Fact Contract',
  'review_run_start',
  'review_pass_set',
  'finding_add',
  'reviewRunId',
  'verificationEvidence',
  'receiptVerified',
  'productionDone',
  'authorityDone',
  'fullAuthorityDone',
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
  return content.match(/<!-- lattice:start -->[\s\S]*?<!-- lattice:end -->/)?.[0] ?? null;
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
  assert.equal(renderPromptEntryForHost(entry, 'claude'), source, `${entry.file} claude render matches template`);
  assert.equal(
    renderPromptEntryForHost(entry, 'codex'),
    renderCodexAgentContent(source),
    `${entry.file} codex render matches legacy transform`,
  );
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
    assert.equal(readFileSync(claudeMirrorPath, 'utf8'), source, `${entry.file} .claude mirror matches package template`);
  }
  const codexMirrorPath = join(projectRoot, '.lattice-codex', 'agents', entry.file);
  if (existsSync(codexMirrorPath)) {
    assert.equal(readFileSync(codexMirrorPath, 'utf8'), renderCodexAgentContent(source), `${entry.file} .lattice-codex mirror matches codex render`);
  }
  material.update(`${entry.file}\0${entry.templateHash}\0${entry.bytes}\n`);
}
assert.equal(registry.materialHash, material.digest('hex'), 'registry material hash is deterministic');

console.log(`✓ prompt registry smoke passed: ${registry.agentCount} agents rendered for claude and codex`);
