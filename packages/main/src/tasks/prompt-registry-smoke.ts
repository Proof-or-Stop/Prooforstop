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
import { readFileSync } from 'node:fs';
import {
  PROMPT_REGISTRY_SOURCE,
  PROMPT_REGISTRY_VERSION,
  listPromptTemplateFiles,
  readPromptRegistry,
  renderPromptEntryForHost,
} from '../core/prompt-registry.js';
import { renderCodexAgentContent } from '../init-assets.js';

const registry = readPromptRegistry();
const files = listPromptTemplateFiles(registry.root);

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
  material.update(`${entry.file}\0${entry.templateHash}\0${entry.bytes}\n`);
}
assert.equal(registry.materialHash, material.digest('hex'), 'registry material hash is deterministic');

console.log(`✓ prompt registry smoke passed: ${registry.agentCount} agents rendered for claude and codex`);
