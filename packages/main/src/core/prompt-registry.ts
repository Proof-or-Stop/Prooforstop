/**
 * @task B-9b76
 * @checklist CHK-002
 * @title Registry-backed agent prompt templates
 * @type feature
 * @priority high
 * @description
 * Package-owned registry for Koala/Lattice agent prompt templates. Project
 * assets can point at this registry instead of materializing every prompt file.
 * @changes
 * - [CHK-002] Add stable prompt metadata, hashes, and host-specific rendering.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROMPT_REGISTRY_VERSION = 'koala.prompt-registry.v1';
export const PROMPT_REGISTRY_SOURCE = '@koala-agent/core/templates/agents';
export const SUPPORTED_PROMPT_HOSTS = ['claude', 'codex'] as const;

export type PromptHost = typeof SUPPORTED_PROMPT_HOSTS[number];

export interface PromptRegistryEntry {
  agentId: string;
  file: string;
  relPath: string;
  sourcePath: string;
  templateHash: string;
  bytes: number;
}

export interface PromptRegistrySnapshot {
  schemaVersion: typeof PROMPT_REGISTRY_VERSION;
  source: typeof PROMPT_REGISTRY_SOURCE;
  root: string;
  agentCount: number;
  materialHash: string;
  agents: PromptRegistryEntry[];
}

export interface PromptRegistryManifest {
  schemaVersion: typeof PROMPT_REGISTRY_VERSION;
  source: typeof PROMPT_REGISTRY_SOURCE;
  agentCount: number;
  materialHash: string;
}

function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function defaultPromptTemplateDir(root = packageRoot()): string {
  return join(root, 'templates', 'agents');
}

export function listPromptTemplateFiles(templateDir = defaultPromptTemplateDir()): string[] {
  if (!existsSync(templateDir)) return [];
  return readdirSync(templateDir)
    .filter(file => file.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b));
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function renderCodexPromptContent(content: string): string {
  return content
    .replace(/Claude Code/g, 'Codex')
    .replace(/\.claude\/agents\//g, '.Codex/agents/');
}

export function renderPromptForHost(content: string, host: PromptHost): string {
  if (host === 'codex') return renderCodexPromptContent(content);
  return content;
}

export function readPromptRegistry(templateDir = defaultPromptTemplateDir()): PromptRegistrySnapshot {
  const agents = listPromptTemplateFiles(templateDir).map((file): PromptRegistryEntry => {
    const sourcePath = join(templateDir, file);
    const content = readFileSync(sourcePath, 'utf8');
    return {
      agentId: file.replace(/\.md$/, ''),
      file,
      relPath: relative(packageRoot(), sourcePath).split('\\').join('/'),
      sourcePath,
      templateHash: sha256(content),
      bytes: Buffer.byteLength(content),
    };
  });

  const hash = createHash('sha256');
  hash.update(`${PROMPT_REGISTRY_VERSION}\n`);
  for (const entry of agents) {
    hash.update(`${entry.file}\0${entry.templateHash}\0${entry.bytes}\n`);
  }

  return {
    schemaVersion: PROMPT_REGISTRY_VERSION,
    source: PROMPT_REGISTRY_SOURCE,
    root: templateDir,
    agentCount: agents.length,
    materialHash: hash.digest('hex'),
    agents,
  };
}

export function promptRegistryManifest(templateDir = defaultPromptTemplateDir()): PromptRegistryManifest {
  const snapshot = readPromptRegistry(templateDir);
  return {
    schemaVersion: snapshot.schemaVersion,
    source: snapshot.source,
    agentCount: snapshot.agentCount,
    materialHash: snapshot.materialHash,
  };
}

export function readPromptTemplate(entry: PromptRegistryEntry): string {
  return readFileSync(entry.sourcePath, 'utf8');
}

export function renderPromptEntryForHost(entry: PromptRegistryEntry, host: PromptHost): string {
  return renderPromptForHost(readPromptTemplate(entry), host);
}
