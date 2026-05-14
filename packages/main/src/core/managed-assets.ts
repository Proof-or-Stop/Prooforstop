import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENTS_MD_TEMPLATE,
  CLAUDE_MD_TEMPLATE,
  CODEX_README_TEMPLATE,
  KOALA_MD_TEMPLATE,
  getKoalaHooks,
  listAgentPromptFiles,
  renderCodexAdapterManifest,
  renderCodexAgentContent,
  renderCodexWrapperScript,
  renderKoalaBootstrapScript,
  type InitProfile,
} from '../init-assets.js';
import {
  KOALA_RUNTIME_IGNORE_BLOCK_END,
  KOALA_RUNTIME_IGNORE_BLOCK_START,
  listRuntimeArtifactIgnorePatterns,
} from './runtime-artifact-registry.js';

export type ManagedAssetStatus =
  | 'OK'
  | 'MISSING'
  | 'STALE_SAFE'
  | 'STALE_LOCAL_EDIT'
  | 'INCOMPATIBLE';

export type ManagedAssetKind =
  | 'managed-block'
  | 'whole-file'
  | 'gitignore-runtime'
  | 'claude-settings'
  | 'excluded-path'
  | 'remove-extra';

export interface ManagedAssetCheckOptions {
  apply?: boolean;
  profile?: InitProfile;
}

export interface ManagedAssetCheckItem {
  id: string;
  relPath: string;
  kind: ManagedAssetKind;
  status: ManagedAssetStatus;
  expectedHash?: string;
  actualHash?: string;
  reason: string;
  action: string;
  applied?: boolean;
}

export interface ManagedAssetCheckResult {
  ok: boolean;
  profile: InitProfile;
  applied: string[];
  summary: Record<ManagedAssetStatus, number>;
  items: ManagedAssetCheckItem[];
  manifestPath: string;
}

interface ManagedAssetDefinition {
  id: string;
  relPath: string;
  kind: ManagedAssetKind;
  expectedContent?: string;
  executable?: boolean;
  ownedWhen?: (actual: string) => boolean;
}

interface ManagedAssetManifest {
  version: 1;
  profile: InitProfile;
  generatedAt: string;
  assets: Record<string, {
    relPath: string;
    templateHash?: string;
    contentHash?: string;
    updatedAt: string;
  }>;
}

type ManagedAssetPathKind = 'missing' | 'file' | 'directory' | 'other';

const MANIFEST_REL_PATH = '.koala/managed-assets.json';
const INIT_DOC_SECTION_RE = /<!--\s*koala:start\s*-->[\s\S]*?<!--\s*koala:end\s*-->/;
const KOALA_INTERNAL_SECTION_RE = /<!--\s*koala:internal:start\s*-->[\s\S]*?<!--\s*koala:internal:end\s*-->\n?/g;

function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function agentTemplateDir(root = packageRoot()): string | null {
  return [
    join(root, 'templates', 'agents'),
    join(root, '..', '..', '.claude', 'agents'),
  ].find(existsSync) ?? null;
}

function hookTemplateDir(root = packageRoot()): string | null {
  const dir = join(root, '..', '..', '.claude', 'hooks');
  return existsSync(dir) ? dir : null;
}

function normalizeContent(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function managedAssetPathKind(root: string, relPath: string): ManagedAssetPathKind {
  const full = join(root, relPath);
  if (!existsSync(full)) return 'missing';
  try {
    const entry = lstatSync(full);
    const stats = entry.isSymbolicLink() ? statSync(full) : entry;
    if (stats.isFile()) return 'file';
    if (stats.isDirectory()) return 'directory';
    return 'other';
  } catch {
    // PROBE: filesystem races should be reported as missing/other by the next check run.
    return 'other';
  }
}

function readText(root: string, relPath: string): string | null {
  const full = join(root, relPath);
  if (managedAssetPathKind(root, relPath) !== 'file') return null;
  return readFileSync(full, 'utf-8');
}

function writeText(root: string, relPath: string, content: string, executable = false): void {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, normalizeContent(content));
  if (executable) chmodSync(full, 0o755);
}

function extractKoalaSection(content: string): string {
  const match = content.match(INIT_DOC_SECTION_RE);
  if (!match) return normalizeContent(content);
  return match[0].replace(KOALA_INTERNAL_SECTION_RE, '');
}

function hasManagedMarkers(content: string): boolean {
  return INIT_DOC_SECTION_RE.test(content);
}

function safeJsonParse(text: string): unknown {
  try { return JSON.parse(text); } catch { /* PROBE: malformed JSON means this asset cannot prove Koala ownership. */ return null; }
}

function isKoalaPrompt(actual: string, file: string): boolean {
  const base = file.replace(/\.md$/, '');
  return actual.includes('<!-- koala:start -->')
    || actual.includes(`name: ${base}`)
    || actual.includes('name: koala-')
    || actual.includes('Koala');
}

function hasHookCommand(entries: unknown, command: string): boolean {
  return Array.isArray(entries) && entries.some((entry: any) =>
    Array.isArray(entry?.hooks) && entry.hooks.some((hook: any) => hook?.type === 'command' && hook?.command === command));
}

function mergeClaudeHooks(existing: any): { updated: any; changed: boolean; incompatible: string[] } {
  const koalaHooks = getKoalaHooks();
  const updated = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
  const hooks = updated.hooks && typeof updated.hooks === 'object' && !Array.isArray(updated.hooks)
    ? { ...updated.hooks }
    : {};
  const incompatible: string[] = [];
  let changed = !updated.hooks;

  for (const [event, eventHooks] of Object.entries(koalaHooks)) {
    const command = eventHooks[0]?.hooks?.[0]?.command;
    if (!hooks[event]) {
      hooks[event] = eventHooks;
      changed = true;
      continue;
    }
    if (!Array.isArray(hooks[event])) {
      incompatible.push(event);
      continue;
    }
    if (command && !hasHookCommand(hooks[event], command)) {
      hooks[event] = [...hooks[event], ...eventHooks];
      changed = true;
    }
  }
  updated.hooks = hooks;
  return { updated, changed, incompatible };
}

function runtimeIgnoreMissing(existing: string | null): string[] {
  if (!existing) return listRuntimeArtifactIgnorePatterns();
  const present = new Set(existing.split('\n').map(line => line.trim()).filter(Boolean));
  return listRuntimeArtifactIgnorePatterns().filter(line => !present.has(line));
}

function renderManagedRuntimeIgnoreBlock(lines: string[]): string {
  return [
    KOALA_RUNTIME_IGNORE_BLOCK_START,
    ...lines,
    KOALA_RUNTIME_IGNORE_BLOCK_END,
  ].join('\n');
}

function mergeRuntimeGitignore(existing: string | null): string {
  const missing = runtimeIgnoreMissing(existing);
  if (missing.length === 0) return existing ?? '';
  const base = (existing ?? '').replace(/\s+$/, '');
  const separator = base.length === 0 ? '' : '\n\n';
  return `${base}${separator}${renderManagedRuntimeIgnoreBlock(missing)}\n`;
}

export function detectManagedAssetProfile(root: string): InitProfile {
  const agents = readText(root, 'AGENTS.md');
  const claude = readText(root, 'CLAUDE.md');
  const hasCodex = Boolean(
    (agents && hasManagedMarkers(agents))
      || existsSync(join(root, '.Codex', 'koala.json'))
      || existsSync(join(root, '.Codex', 'agents'))
      || existsSync(join(root, 'bin', 'koala-codex.js')),
  );
  const hasClaude = Boolean(
    (claude && hasManagedMarkers(claude))
      || existsSync(join(root, '.claude', 'agents'))
      || existsSync(join(root, '.claude', 'hooks'))
      || existsSync(join(root, '.claude', 'skills', 'koala')),
  );
  if (hasCodex && hasClaude) return 'all';
  if (hasCodex) return 'codex';
  if (hasClaude) return 'claude';
  return 'core';
}

function loadManifest(root: string): ManagedAssetManifest | null {
  const text = readText(root, MANIFEST_REL_PATH);
  if (!text) return null;
  const parsed = safeJsonParse(text);
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed as ManagedAssetManifest;
}

function managedDoc(
  id: string,
  relPath: string,
  expectedContent: string,
  ownedWhen: (actual: string) => boolean,
): ManagedAssetDefinition {
  return { id, relPath, kind: 'managed-block', expectedContent, ownedWhen };
}

function wholeFile(
  id: string,
  relPath: string,
  expectedContent: string,
  ownedWhen: (actual: string) => boolean,
  executable = false,
): ManagedAssetDefinition {
  return { id, relPath, kind: 'whole-file', expectedContent, ownedWhen, executable };
}

export function listManagedAssetDefinitions(
  profile: InitProfile,
  root = packageRoot(),
  projectRoot = process.cwd(),
): ManagedAssetDefinition[] {
  const defs: ManagedAssetDefinition[] = [
    managedDoc(
      'doc:KOALA.md',
      'KOALA.md',
      KOALA_MD_TEMPLATE,
      actual => actual.includes('canonical、host-neutral') || actual.includes('所有 init profile 都会创建或同步这个文件'),
    ),
    wholeFile(
      'bin:koala.js',
      'bin/koala.js',
      renderKoalaBootstrapScript(root),
      actual => actual.includes('coreCliEngineCandidates') && actual.includes('runCli'),
      true,
    ),
    { id: 'gitignore:runtime-artifacts', relPath: '.gitignore', kind: 'gitignore-runtime' },
  ];

  const wantsCodex = profile === 'codex' || profile === 'all';
  const wantsClaude = profile === 'claude' || profile === 'all';
  const templates = agentTemplateDir(root);

  if (wantsCodex) {
    defs.push(
      managedDoc(
        'doc:AGENTS.md',
        'AGENTS.md',
        AGENTS_MD_TEMPLATE,
        actual => actual.includes('Codex / AGENTS') || actual.includes('Codex subagent prompts 位于'),
      ),
      wholeFile(
        'bin:koala-codex.js',
        'bin/koala-codex.js',
        renderCodexWrapperScript(),
        actual => actual.includes('KOALA_ACTIVITY_SOURCE') && actual.includes('local-wrapper'),
        true,
      ),
      wholeFile('.Codex:README.md', '.Codex/README.md', CODEX_README_TEMPLATE, actual => actual.includes('Codex + Koala')),
      wholeFile('.Codex:koala.json', '.Codex/koala.json', renderCodexAdapterManifest(), () => true),
      { id: 'excluded:.Codex/hooks', relPath: '.Codex/hooks', kind: 'excluded-path' },
      { id: 'excluded:.Codex/settings.json', relPath: '.Codex/settings.json', kind: 'excluded-path' },
    );
    if (templates) {
      const files = listAgentPromptFiles(templates);
      for (const file of files) {
        const content = readFileSync(join(templates, file), 'utf-8');
        defs.push(wholeFile(
          `.Codex/agents:${file}`,
          `.Codex/agents/${file}`,
          renderCodexAgentContent(content),
          actual => isKoalaPrompt(actual, file),
        ));
      }
    }
  }

  if (wantsClaude) {
    defs.push(
      managedDoc(
        'doc:CLAUDE.md',
        'CLAUDE.md',
        CLAUDE_MD_TEMPLATE,
        actual => actual.includes('Koala For Claude Code') || actual.includes('Claude Code subagents 位于'),
      ),
      { id: '.claude:settings.json', relPath: '.claude/settings.json', kind: 'claude-settings' },
    );
    if (templates) {
      for (const file of listAgentPromptFiles(templates)) {
        const content = readFileSync(join(templates, file), 'utf-8');
        defs.push(wholeFile(
          `.claude/agents:${file}`,
          `.claude/agents/${file}`,
          content,
          actual => isKoalaPrompt(actual, file),
        ));
      }
    }
    const hooks = hookTemplateDir(root);
    if (hooks) {
      for (const file of readdirSync(hooks).filter(file => file.endsWith('.cjs')).sort()) {
        const content = readFileSync(join(hooks, file), 'utf-8');
        defs.push(wholeFile(
          `.claude/hooks:${file}`,
          `.claude/hooks/${file}`,
          content,
          actual => actual.includes('koala') || actual.includes('KOALA'),
        ));
      }
    }
  }

  if (wantsCodex && templates && existsSync(join(projectRoot, '.Codex', 'agents'))) {
    const expected = new Set(listAgentPromptFiles(templates));
    for (const file of listAgentPromptFiles(join(projectRoot, '.Codex', 'agents'))) {
      if (!expected.has(file)) {
        defs.push({ id: `.Codex/agents:extra:${file}`, relPath: `.Codex/agents/${file}`, kind: 'remove-extra' });
      }
    }
  }

  return defs;
}

function evaluateDefinition(root: string, def: ManagedAssetDefinition, manifest: ManagedAssetManifest | null): ManagedAssetCheckItem {
  const pathKind = managedAssetPathKind(root, def.relPath);
  const actual = readText(root, def.relPath);
  const expected = def.expectedContent ? normalizeContent(def.expectedContent) : undefined;
  const expectedHash = expected ? sha256(expected) : undefined;
  const actualHash = actual === null ? undefined : sha256(actual);
  const manifestEntry = manifest?.assets?.[def.id];

  if (def.kind === 'excluded-path') {
    if (pathKind === 'missing') {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'OK', reason: 'excluded Codex runtime asset is absent', action: 'none' };
    }
    const found = pathKind === 'file' ? 'file' : pathKind === 'directory' ? 'directory' : 'non-file path';
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'INCOMPATIBLE', actualHash, reason: `Codex runtime must not use this Claude-only asset path (found ${found})`, action: 'remove manually if it is not user-owned' };
  }

  if (def.kind === 'remove-extra') {
    if (pathKind === 'missing') {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'OK', reason: 'extra generated prompt already absent', action: 'none' };
    }
    if (pathKind !== 'file') {
      const found = pathKind === 'directory' ? 'directory' : 'non-file path';
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'INCOMPATIBLE', reason: `stale generated prompt path is a ${found}`, action: 'remove manually if it is Koala-owned' };
    }
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'STALE_SAFE', actualHash, reason: 'Codex agent mirror contains a prompt no longer present in Koala templates', action: 'remove generated stale prompt' };
  }

  if (pathKind === 'directory' || pathKind === 'other') {
    const found = pathKind === 'directory' ? 'directory' : 'non-file path';
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'INCOMPATIBLE', expectedHash, reason: `managed asset path is a ${found}, expected a file`, action: 'replace or remove the path manually before running koala check --apply' };
  }

  if (def.kind === 'gitignore-runtime') {
    const missing = runtimeIgnoreMissing(actual);
    if (missing.length === 0) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'OK', actualHash, reason: 'runtime artifact ignore policy is present', action: 'none' };
    }
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'STALE_SAFE', actualHash, reason: `missing runtime ignore pattern(s): ${missing.join(', ')}`, action: 'merge managed runtime ignore block' };
  }

  if (def.kind === 'claude-settings') {
    if (actual === null) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'MISSING', reason: 'Claude hook settings are missing', action: 'create settings with Koala hooks' };
    }
    const parsed = safeJsonParse(actual);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'INCOMPATIBLE', actualHash, reason: 'settings.json is not a JSON object', action: 'fix JSON manually' };
    }
    const merged = mergeClaudeHooks(parsed);
    if (merged.incompatible.length > 0) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'INCOMPATIBLE', actualHash, reason: `hook event(s) have incompatible shape: ${merged.incompatible.join(', ')}`, action: 'fix hook array shape manually' };
    }
    if (!merged.changed) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'OK', actualHash, reason: 'Koala Claude hooks are present', action: 'none' };
    }
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'STALE_SAFE', actualHash, reason: 'Koala Claude hooks are missing from settings.json', action: 'merge missing Koala hook commands' };
  }

  if (actual === null) {
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'MISSING', expectedHash, reason: 'managed asset is missing', action: 'create from Koala template' };
  }

  if (def.kind === 'managed-block') {
    const desiredSection = extractKoalaSection(expected ?? '');
    const manifestUnchanged = Boolean(manifestEntry?.contentHash && manifestEntry.contentHash === actualHash);
    if (!hasManagedMarkers(actual)) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'INCOMPATIBLE', expectedHash: sha256(desiredSection), actualHash, reason: 'file exists without Koala managed markers', action: 'add markers or merge manually' };
    }
    const actualSection = actual.match(INIT_DOC_SECTION_RE)?.[0] ?? '';
    if (sha256(actualSection) === sha256(desiredSection)) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'OK', expectedHash: sha256(desiredSection), actualHash, reason: 'managed section matches Koala template', action: 'none' };
    }
    if (!manifestUnchanged && !def.ownedWhen?.(actualSection)) {
      return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'STALE_LOCAL_EDIT', expectedHash: sha256(desiredSection), actualHash, reason: 'managed section differs and is not recognized as the generated init block', action: 'review local doc edits before replacing the section' };
    }
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'STALE_SAFE', expectedHash: sha256(desiredSection), actualHash, reason: 'Koala managed section differs from template', action: 'replace managed section only' };
  }

  if (expected && actual === expected) {
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'OK', expectedHash, actualHash, reason: 'managed file matches Koala template', action: 'none' };
  }

  const unchangedSinceManifest = Boolean(manifestEntry?.contentHash && manifestEntry.contentHash === actualHash);
  if (unchangedSinceManifest || def.ownedWhen?.(actual)) {
    return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'STALE_SAFE', expectedHash, actualHash, reason: unchangedSinceManifest ? 'Koala template changed since last managed sync' : 'file has Koala-owned generated signature', action: 'replace generated file from template' };
  }

  return { id: def.id, relPath: def.relPath, kind: def.kind, status: 'STALE_LOCAL_EDIT', expectedHash, actualHash, reason: 'file differs and is not known to be unchanged/generated', action: 'review local edits before overwriting' };
}

function applyDefinition(root: string, def: ManagedAssetDefinition, item: ManagedAssetCheckItem): boolean {
  if (item.status !== 'MISSING' && item.status !== 'STALE_SAFE') return false;

  if (def.kind === 'remove-extra') {
    unlinkSync(join(root, def.relPath));
    return true;
  }
  if (def.kind === 'gitignore-runtime') {
    writeText(root, def.relPath, mergeRuntimeGitignore(readText(root, def.relPath)));
    return true;
  }
  if (def.kind === 'claude-settings') {
    const existing = readText(root, def.relPath);
    const parsed = existing ? safeJsonParse(existing) : {};
    const merged = mergeClaudeHooks(parsed && typeof parsed === 'object' ? parsed : {});
    writeText(root, def.relPath, JSON.stringify(merged.updated, null, 2));
    return true;
  }
  if (def.kind === 'managed-block') {
    const expected = normalizeContent(def.expectedContent ?? '');
    const full = join(root, def.relPath);
    mkdirSync(dirname(full), { recursive: true });
    const actual = readText(root, def.relPath);
    if (actual === null) {
      writeFileSync(full, expected);
    } else {
      writeFileSync(full, actual.replace(INIT_DOC_SECTION_RE, extractKoalaSection(expected)));
    }
    return true;
  }
  if (def.kind === 'whole-file') {
    const full = join(root, def.relPath);
    if (existsSync(full)) {
      try {
        if (lstatSync(full).isSymbolicLink()) unlinkSync(full);
      } catch { /* PROBE: best effort before replacing generated file */ }
    }
    writeText(root, def.relPath, def.expectedContent ?? '', def.executable);
    return true;
  }
  return false;
}

function writeManifest(root: string, profile: InitProfile, items: ManagedAssetCheckItem[]): void {
  const assets: ManagedAssetManifest['assets'] = {};
  const now = new Date().toISOString();
  for (const item of items) {
    if (item.status !== 'OK') continue;
    assets[item.id] = {
      relPath: item.relPath,
      templateHash: item.expectedHash,
      contentHash: item.actualHash,
      updatedAt: now,
    };
  }
  writeText(root, MANIFEST_REL_PATH, JSON.stringify({
    version: 1,
    profile,
    generatedAt: now,
    assets,
  } satisfies ManagedAssetManifest, null, 2));
}

function summarize(items: ManagedAssetCheckItem[]): Record<ManagedAssetStatus, number> {
  const summary: Record<ManagedAssetStatus, number> = {
    OK: 0,
    MISSING: 0,
    STALE_SAFE: 0,
    STALE_LOCAL_EDIT: 0,
    INCOMPATIBLE: 0,
  };
  for (const item of items) summary[item.status] += 1;
  return summary;
}

export function runManagedAssetCheck(root: string, options: ManagedAssetCheckOptions = {}): ManagedAssetCheckResult {
  const profile = options.profile ?? detectManagedAssetProfile(root);
  const defs = listManagedAssetDefinitions(profile, packageRoot(), root);
  const manifest = loadManifest(root);
  let items = defs.map(def => evaluateDefinition(root, def, manifest));
  const applied: string[] = [];

  if (options.apply) {
    for (const def of defs) {
      const item = items.find(item => item.id === def.id);
      if (!item) continue;
      if (applyDefinition(root, def, item)) {
        applied.push(def.relPath);
        item.applied = true;
      }
    }
    const afterManifest = loadManifest(root);
    items = defs.map(def => evaluateDefinition(root, def, afterManifest));
    writeManifest(root, profile, items);
  }

  const summary = summarize(items);
  return {
    ok: summary.MISSING === 0 && summary.STALE_SAFE === 0 && summary.STALE_LOCAL_EDIT === 0 && summary.INCOMPATIBLE === 0,
    profile,
    applied,
    summary,
    items,
    manifestPath: MANIFEST_REL_PATH,
  };
}

export function renderManagedAssetCheck(result: ManagedAssetCheckResult): string {
  const lines = [
    `Koala managed asset check: ${result.ok ? 'OK' : 'DRIFT'} (profile=${result.profile})`,
    `Summary: OK=${result.summary.OK}, MISSING=${result.summary.MISSING}, STALE_SAFE=${result.summary.STALE_SAFE}, STALE_LOCAL_EDIT=${result.summary.STALE_LOCAL_EDIT}, INCOMPATIBLE=${result.summary.INCOMPATIBLE}`,
  ];
  if (result.applied.length > 0) {
    lines.push(`Applied: ${result.applied.join(', ')}`);
  }
  const drift = result.items.filter(item => item.status !== 'OK');
  if (drift.length > 0) {
    lines.push('', 'Drift:');
    for (const item of drift) {
      lines.push(`  - ${item.status} ${item.relPath}: ${item.reason}`);
      lines.push(`    action: ${item.action}`);
    }
    lines.push('', 'Run `koala check --apply` to sync MISSING/STALE_SAFE assets. STALE_LOCAL_EDIT/INCOMPATIBLE require manual review.');
  } else {
    lines.push(`Manifest: ${result.manifestPath}`);
  }
  return lines.join('\n');
}
