import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CODEX_ADAPTER_MANIFEST,
  listAgentPromptFiles,
  renderCodexAdapterManifest,
  renderCodexAgentContent,
} from '../init-assets.js';
import { readActivityLogTail } from './activity-log.js';
import type { StoryStore } from './store.js';
import type { ProcessEvent } from './types.js';

export type CodexAdapterCheckStatus = 'pass' | 'warn' | 'fail';

export interface CodexAdapterCheck {
  id: string;
  label: string;
  status: CodexAdapterCheckStatus;
  hard: boolean;
  detail: string;
  command?: string;
}

export interface CodexAdapterCheckResult {
  ok: boolean;
  summary: string;
  checks: CodexAdapterCheck[];
  timestamp: string;
}

export const GLOBAL_CODEX_FALLBACK_COMMAND = 'KOALA_ACTIVITY_SOURCE=codex KOALA_ACTIVITY_RECORD_READONLY=1 koala';

interface RunCodexChecksOptions {
  executeHeartbeats?: boolean;
  registryNames?: Set<string>;
  storyId?: string;
  store?: StoryStore;
  timeoutMs?: number;
}

function readText(path: string): string {
  return readFileSync(path, 'utf-8').replace(/\r\n/g, '\n');
}

function push(
  checks: CodexAdapterCheck[],
  id: string,
  label: string,
  status: CodexAdapterCheckStatus,
  hard: boolean,
  detail: string,
  command?: string,
): void {
  checks.push({ id, label, status, hard, detail, ...(command ? { command } : {}) });
}

function checkManifest(root: string, checks: CodexAdapterCheck[]): void {
  const manifestPath = join(root, '.Codex', 'koala.json');
  if (!existsSync(manifestPath)) {
    push(checks, 'manifest', 'Codex manifest', 'fail', true, 'missing .Codex/koala.json', 'koala init --verify-codex');
    return;
  }
  const actual = readText(manifestPath);
  const expected = renderCodexAdapterManifest();
  if (actual !== expected) {
    push(checks, 'manifest', 'Codex manifest', 'fail', true, '.Codex/koala.json drifted from Koala template', 'koala init --verify-codex');
    return;
  }
  const parsed = JSON.parse(actual);
  if (
    parsed?.adapterOwner !== CODEX_ADAPTER_MANIFEST.adapterOwner ||
    parsed?.adapterKind !== CODEX_ADAPTER_MANIFEST.adapterKind ||
    parsed?.activitySource !== CODEX_ADAPTER_MANIFEST.activitySource
  ) {
    push(checks, 'manifest', 'Codex manifest', 'fail', true, '.Codex/koala.json has invalid adapter identity', 'koala init --verify-codex');
    return;
  }
  push(checks, 'manifest', 'Codex manifest', 'pass', true, '.Codex/koala.json matches template');
}

function checkAgentMirror(root: string, checks: CodexAdapterCheck[]): void {
  const claudeDir = join(root, '.claude', 'agents');
  const codexDir = join(root, '.Codex', 'agents');
  if (!existsSync(claudeDir) || !existsSync(codexDir)) {
    push(checks, 'agents-mirror', 'Codex agents mirror', 'fail', true, 'missing .claude/agents or .Codex/agents', 'koala init --verify-codex');
    return;
  }
  const sourceFiles = listAgentPromptFiles(claudeDir);
  const targetFiles = listAgentPromptFiles(codexDir);
  const targetSet = new Set(targetFiles);
  const sourceSet = new Set(sourceFiles);
  const issues: string[] = [];
  for (const file of sourceFiles) {
    const targetPath = join(codexDir, file);
    if (!targetSet.has(file)) {
      issues.push(`missing .Codex/agents/${file}`);
      continue;
    }
    const expected = renderCodexAgentContent(readText(join(claudeDir, file))).trim();
    const actual = readText(targetPath).trim();
    if (expected !== actual) issues.push(`drift .Codex/agents/${file}`);
  }
  for (const file of targetFiles) {
    if (!sourceSet.has(file)) issues.push(`stale .Codex/agents/${file}`);
  }
  if (issues.length > 0) {
    push(checks, 'agents-mirror', 'Codex agents mirror', 'fail', true, issues.slice(0, 6).join('; '), 'koala init --verify-codex');
    return;
  }
  push(checks, 'agents-mirror', 'Codex agents mirror', 'pass', true, `${sourceFiles.length} prompt(s) mirrored`);
}

function checkExcludedAssets(root: string, checks: CodexAdapterCheck[]): void {
  const offenders = CODEX_ADAPTER_MANIFEST.excludedRuntimeAssets.filter(asset => existsSync(join(root, asset)));
  if (offenders.length > 0) {
    push(checks, 'excluded-assets', 'Codex runtime exclusions', 'fail', true, `unexpected asset(s): ${offenders.join(', ')}`, `rm -rf ${offenders.join(' ')}`);
    return;
  }
  push(checks, 'excluded-assets', 'Codex runtime exclusions', 'pass', true, 'no .Codex/hooks or .Codex/settings.json');
}

function activityFor(root: string, session: string, tool: string): Record<string, unknown> | null {
  return readActivityLogTail(root, 200)
    .find(entry => entry.session === session && entry.tool === tool) || null;
}

function runHeartbeat(
  root: string,
  checks: CodexAdapterCheck[],
  id: string,
  label: string,
  command: string,
  args: string[],
  session: string,
  expectedEntrypoint: string,
  timeoutMs: number,
): void {
  try {
    execFileSync(command, args, {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: {
        ...process.env,
        KOALA_ACTIVITY_SOURCE: id === 'local-wrapper-heartbeat' ? 'not-codex' : 'codex',
        KOALA_ACTIVITY_RECORD_READONLY: '1',
        KOALA_ACTIVITY_SESSION: session,
      },
    });
  } catch (e: any) {
    push(checks, id, label, 'fail', true, `heartbeat command failed: ${e?.stderr?.toString?.().trim() || e?.message || e}`, id === 'local-wrapper-heartbeat' ? 'node bin/koala-codex.js session_brief' : `${GLOBAL_CODEX_FALLBACK_COMMAND} session_brief`);
    return;
  }

  const record = activityFor(root, session, 'session_brief');
  if (!record) {
    push(checks, id, label, 'fail', true, `no activity heartbeat for session ${session}`, id === 'local-wrapper-heartbeat' ? 'node bin/koala-codex.js session_brief' : `${GLOBAL_CODEX_FALLBACK_COMMAND} session_brief`);
    return;
  }
  if (record.source !== 'codex') {
    push(checks, id, label, 'fail', true, `activity source=${String(record.source)} expected codex`, id === 'local-wrapper-heartbeat' ? 'node bin/koala-codex.js session_brief' : `${GLOBAL_CODEX_FALLBACK_COMMAND} session_brief`);
    return;
  }
  if (!record.entrypoint && expectedEntrypoint === 'global-fallback') {
    push(checks, id, label, 'pass', true, `source=codex session=${session}; installed global CLI has no entrypoint field yet`);
    return;
  }
  if (record.entrypoint !== expectedEntrypoint) {
    push(checks, id, label, 'fail', true, `entrypoint=${String(record.entrypoint)} expected ${expectedEntrypoint}`, id === 'local-wrapper-heartbeat' ? 'node bin/koala-codex.js session_brief' : `${GLOBAL_CODEX_FALLBACK_COMMAND} session_brief`);
    return;
  }
  push(checks, id, label, 'pass', true, `source=codex session=${session} entrypoint=${expectedEntrypoint}`);
}

function checkLocalWrapper(root: string, checks: CodexAdapterCheck[], executeHeartbeats: boolean, timeoutMs: number): void {
  const wrapper = join(root, 'bin', 'koala-codex.js');
  if (!existsSync(wrapper)) {
    push(checks, 'local-wrapper', 'Local Codex wrapper', 'fail', true, 'missing bin/koala-codex.js', 'koala init --verify-codex');
    return;
  }
  const text = readText(wrapper);
  const required = ['KOALA_ACTIVITY_SOURCE', 'codex', 'KOALA_ACTIVITY_RECORD_READONLY', 'KOALA_CODEX_ENTRYPOINT'];
  const missing = required.filter(piece => !text.includes(piece));
  if (missing.length > 0) {
    push(checks, 'local-wrapper', 'Local Codex wrapper', 'fail', true, `wrapper missing ${missing.join(', ')}`, 'koala init --verify-codex');
    return;
  }
  push(checks, 'local-wrapper', 'Local Codex wrapper', 'pass', true, 'bin/koala-codex.js sets Codex activity env');
  if (executeHeartbeats) {
    runHeartbeat(
      root,
      checks,
      'local-wrapper-heartbeat',
      'Local wrapper heartbeat',
      'node',
      ['bin/koala-codex.js', 'session_brief'],
      `codex-check-local-${Date.now()}`,
      'local-wrapper',
      timeoutMs,
    );
  } else {
    push(checks, 'local-wrapper-heartbeat', 'Local wrapper heartbeat', 'warn', false, 'not executed in this diagnostic mode', 'koala verify_codex');
  }
}

function checkGlobalFallback(root: string, checks: CodexAdapterCheck[], executeHeartbeats: boolean, timeoutMs: number): void {
  if (!executeHeartbeats) {
    push(checks, 'global-fallback-heartbeat', 'Global fallback heartbeat', 'warn', false, 'not executed in this diagnostic mode', `${GLOBAL_CODEX_FALLBACK_COMMAND} session_brief`);
    return;
  }
  runHeartbeat(
    root,
    checks,
    'global-fallback-heartbeat',
    'Global fallback heartbeat',
    'koala',
    ['session_brief'],
    `codex-check-global-${Date.now()}`,
    'global-fallback',
    timeoutMs,
  );
}

function checkAuxAvailability(checks: CodexAdapterCheck[], registryNames?: Set<string>): void {
  if (!registryNames) {
    push(checks, 'aux-availability', 'Aux command availability', 'warn', false, 'registry not provided; run through koala doctor for live command inventory');
    return;
  }
  if (!registryNames.has('aux_doc_list')) {
    push(checks, 'aux-availability', 'Aux command availability', 'warn', false, 'aux_doc_list is not registered; use local bootstrap or shell search fallback');
    return;
  }
  push(checks, 'aux-availability', 'Aux command availability', 'pass', false, 'aux_doc_list registered');
}

export function runCodexAdapterChecks(root: string, options: RunCodexChecksOptions = {}): CodexAdapterCheckResult {
  const checks: CodexAdapterCheck[] = [];
  const timeoutMs = options.timeoutMs ?? 10_000;
  checkManifest(root, checks);
  checkAgentMirror(root, checks);
  checkExcludedAssets(root, checks);
  checkLocalWrapper(root, checks, options.executeHeartbeats === true, timeoutMs);
  checkGlobalFallback(root, checks, options.executeHeartbeats === true, timeoutMs);
  checkAuxAvailability(checks, options.registryNames);

  const hardFailures = checks.filter(check => check.hard && check.status === 'fail');
  return {
    ok: hardFailures.length === 0,
    summary: hardFailures.length === 0
      ? `Codex adapter checks passed (${checks.filter(c => c.status === 'pass').length}/${checks.length} pass)`
      : `Codex adapter checks failed (${hardFailures.length} hard failure(s))`,
    checks,
    timestamp: new Date().toISOString(),
  };
}

export function renderCodexAdapterChecks(result: CodexAdapterCheckResult): string {
  const icons: Record<CodexAdapterCheckStatus, string> = { pass: '✓', warn: '!', fail: '✗' };
  const lines = [`${result.ok ? '✓' : '✗'} ${result.summary}`];
  for (const check of result.checks) {
    lines.push(`  [${icons[check.status]}] ${check.label}: ${check.detail}`);
    if (check.status !== 'pass' && check.command) lines.push(`      → ${check.command}`);
  }
  return lines.join('\n');
}

export function storyRequiresCodexEvidence(store: StoryStore, storyId: string): boolean {
  try {
    const story = store.readStory(storyId);
    const checklist = store.readChecklist(storyId);
    const haystack = [
      story.title,
      story.description,
      ...(story.riskSignals || []).flatMap(signal => [signal.category, signal.matched]),
      ...checklist.items.flatMap(item => [item.title, item.context || '', ...(item.relatedDocs || [])]),
    ].join('\n');
    return /\bCodex\b|\.Codex|koala-codex|codex adapter|verify_codex/i.test(haystack);
  } catch {
    return false;
  }
}

export function latestCodexVerificationEvent(store: StoryStore, storyId: string): ProcessEvent | null {
  try {
    const events = store.readProcessEvents(storyId)
      .filter(event => event.type === 'codex_adapter_verification');
    return events[events.length - 1] || null;
  } catch {
    return null;
  }
}

export function summarizeCodexEvidence(store: StoryStore, storyId: string): {
  status: 'not-required' | 'missing' | 'failing' | 'passing';
  detail: string;
  command?: string;
} {
  if (!storyRequiresCodexEvidence(store, storyId)) {
    return { status: 'not-required', detail: 'story does not touch Codex adapter surfaces' };
  }
  const event = latestCodexVerificationEvent(store, storyId);
  if (!event) {
    return {
      status: 'missing',
      detail: 'no codex_adapter_verification process-event recorded',
      command: 'koala verify_codex',
    };
  }
  if (event.result !== 'pass') {
    return {
      status: 'failing',
      detail: String(event.summary || 'latest koala verify_codex failed'),
      command: 'koala verify_codex',
    };
  }
  return {
    status: 'passing',
    detail: String(event.summary || `koala verify_codex passed at ${event.timestamp}`),
  };
}
