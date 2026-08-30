#!/usr/bin/env node
/**
 * B-70e9 CHK-005 (M2): fixture-driven smoke for the read-only usage_sweep.
 *
 * Everything runs against OS temp fixture dirs (never the real ~/.codex or
 * ~/.claude stores). Covers the CHK-005 verificationIntent:
 *   - codex per-session totals = the LAST non-null cumulative total_token_usage
 *     (fixture: null-info line, a mid value, then the final value);
 *   - claude four-field dedupe by (requestId ?? message.id) keeping the last;
 *   - B-xxxx story-mention extraction (case-insensitive, deduped);
 *   - --since cutoff excludes old-mtime files BEFORE reading (utimesSync);
 *   - a null-info-only rollout reports usage UNKNOWN (null), not zero;
 *   - empty / missing store dirs → empty report, no throw;
 *   - ZERO WRITES: store-dir file list + mtimes identical before/after a sweep;
 *   - malformed JSONL lines counted in parseErrors without aborting the scan;
 *   - --out fence (F-010): relative-only (absolute refused outright), '..'
 *     traversal refused, existing target refused byte-untouched (exclusive
 *     'wx' create — never overwrite), symlinked ancestors refused with no
 *     write escaping the root, happy relative new-file create parses;
 *   - NON-AUTHORITATIVE label present in BOTH human and json outputs;
 *   - multi-thousand-line streaming sanity (proves the readline path).
 *
 * Prints per-check lines and a final summary; exits non-zero on any failure.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSweepReport,
  openReportFileExclusive,
  parseSinceToMs,
  sweepClaudeProjects,
  sweepCodexSessions,
  type CodexUsageTotals,
  type ClaudeUsageTotals,
} from '../core/usage-sweep.js';
import { StoryStore } from '../core/store.js';
import { createUsageSweepHandlers, NON_AUTHORITATIVE_HEADER } from '../handlers/usage-sweep.js';
import type { HandlerContext } from '../handlers/context.js';
import { getCommandPolicy } from '../core/command-policy.js';
import { resolveEffectiveOwnershipClass } from '../cli/ownership-gate.js';
import { isReadOnlyCommand, shouldWriteActivityLog } from '../cli/activity-policy.js';

let passed = 0;
const failures: string[] = [];

async function checkAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`✓ ${label}`);
  } catch (err) {
    console.error(`✗ ${label}`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    failures.push(label);
    process.exitCode = 1;
  }
}

const root = mkdtempSync(join(tmpdir(), 'usage-sweep-smoke-'));
const FIXED_NOW = Date.parse('2026-07-10T12:00:00.000Z');

// Locate the built CLI entry (same resolution as cli-surface-smoke): dist/tasks
// → packages/main → dist/cli.js. Used by the F-032 end-to-end check that drives
// the REAL CLI to prove the codex process-event write obeys the read-only gate.
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..', '..');
const cliPath = join(packageRoot, 'dist', 'cli.js');
function cliBin(): string | null {
  return existsSync(cliPath) ? cliPath : null;
}

function writeJsonl(file: string, lines: string[]): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

/** Recursive {relPath -> "mtimeMs:size"} snapshot for the zero-writes assertion. */
function snapshotDir(dir: string): Map<string, string> {
  const snap = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const st = statSync(full);
        snap.set(full, `${st.mtimeMs}:${st.size}`);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return snap;
}

function makeCtx(subdir: string): HandlerContext {
  const projectRoot = join(root, subdir);
  mkdirSync(projectRoot, { recursive: true });
  const store = new StoryStore(projectRoot);
  return { store, root: projectRoot, scanRoot: join(projectRoot, 'packages/main') };
}

async function main(): Promise<void> {
  // ── Codex fixtures ─────────────────────────────────────────────────────────
  const codexDir = join(root, 'codex-sessions');
  // A) LAST-non-null cumulative: null-info, mid, final. cwd is a worktree path
  //    (so B-70e9 is a story mention automatically). Extra mentions test
  //    case-insensitive dedupe + multi-attribution.
  const codexCwd = '/Users/jek/Documents/Work/proofbound/.worktrees/B-70e9';
  writeJsonl(join(codexDir, '2026', '07', '10', 'rollout-20260710T000000-aaaa1111.jsonl'), [
    JSON.stringify({
      timestamp: '2026-07-10T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'codex-sess-A', timestamp: '2026-07-10T00:00:00.000Z', cwd: codexCwd, originator: 'codex_exec', source: 'vscode', cli_version: '1.0' },
    }),
    JSON.stringify({ timestamp: '2026-07-10T00:00:01.000Z', type: 'event_msg', payload: { type: 'token_count', info: null } }),
    JSON.stringify({ timestamp: '2026-07-10T00:00:02.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100, reasoning_output_tokens: 50, total_tokens: 1100 } } } }),
    JSON.stringify({ timestamp: '2026-07-10T00:00:03.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 2600, cached_input_tokens: 1100, output_tokens: 248, reasoning_output_tokens: 148, total_tokens: 2848 } } } }),
    '{ this is not valid json',
    JSON.stringify({ timestamp: '2026-07-10T00:00:04.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'see B-70E9 again and also B-abcd here' } }),
  ]);

  // B) null-info-only rollout → usage unknown (null), not zero.
  writeJsonl(join(codexDir, '2026', '07', '10', 'rollout-20260710T010000-bbbb2222.jsonl'), [
    JSON.stringify({ timestamp: '2026-07-10T01:00:00.000Z', type: 'session_meta', payload: { id: 'codex-sess-B', cwd: '/tmp/foreign', originator: 'Codex Desktop', source: 'desktop' } }),
    JSON.stringify({ timestamp: '2026-07-10T01:00:01.000Z', type: 'event_msg', payload: { type: 'token_count', info: null } }),
  ]);

  // C) OLD rollout excluded by mtime cutoff (has valid usage that must NOT count).
  const oldCodexFile = join(codexDir, '2026', '01', '01', 'rollout-20260101T000000-cccc3333.jsonl');
  writeJsonl(oldCodexFile, [
    JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'codex-sess-OLD', cwd: '/tmp/old', originator: 'codex_exec' } }),
    JSON.stringify({ timestamp: '2026-01-01T00:00:01.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 999999, cached_input_tokens: 0, output_tokens: 999999, reasoning_output_tokens: 0, total_tokens: 1999998 } } } }),
  ]);
  const oldMs = Date.parse('2026-01-01T00:00:00.000Z') / 1000;
  utimesSync(oldCodexFile, oldMs, oldMs);

  // ── Claude fixtures ────────────────────────────────────────────────────────
  const claudeDir = join(root, 'claude-projects');
  // D) Dedupe: two events share (req_1/msg_1) → count once (keep last output);
  //    a distinct (req_2/msg_2) sums across keys.
  writeJsonl(join(claudeDir, 'munged-cwd-1', 'claude-sess-D.jsonl'), [
    JSON.stringify({ type: 'assistant', timestamp: '2026-07-10T02:00:00.000Z', cwd: '/Users/jek/Documents/Work/proofbound/.worktrees/B-70e9', requestId: 'req_1', message: { id: 'msg_1', model: 'claude-x', usage: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 5 } } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-07-10T02:00:01.000Z', requestId: 'req_1', message: { id: 'msg_1', model: 'claude-x', usage: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 40 } } }),
    '{ malformed claude line',
    JSON.stringify({ type: 'assistant', timestamp: '2026-07-10T02:00:02.000Z', requestId: 'req_2', message: { id: 'msg_2', model: 'claude-x', usage: { input_tokens: 7, cache_creation_input_tokens: 1, cache_read_input_tokens: 4, output_tokens: 8 } } }),
    JSON.stringify({ type: 'user', timestamp: '2026-07-10T02:00:03.000Z', message: { role: 'user', content: 'mentions B-dead too' } }),
  ]);

  // E) Multi-thousand-line streaming fixture: 5000 unique-requestId assistant
  //    events (output_tokens=1 each) → summed output must equal 5000.
  const streamLines: string[] = [];
  for (let i = 0; i < 5000; i += 1) {
    streamLines.push(
      JSON.stringify({ type: 'assistant', timestamp: '2026-07-10T03:00:00.000Z', requestId: `req_s_${i}`, message: { id: `msg_s_${i}`, usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } }),
    );
  }
  writeJsonl(join(claudeDir, 'munged-cwd-2', 'claude-sess-STREAM.jsonl'), streamLines);

  const sinceMs = parseSinceToMs('2026-07-01', FIXED_NOW).sinceMs;

  // ── 1. codex LAST-non-null cumulative + mentions + label ────────────────────
  await checkAsync('codex totals = LAST non-null cumulative; mentions deduped case-insensitively; malformed counted', async () => {
    const rows = await sweepCodexSessions({ dir: codexDir, sinceMs });
    const a = rows.find((r) => r.sessionId === 'codex-sess-A');
    assert.ok(a, 'codex-sess-A present');
    assert.ok(a.usage, 'session A has usage');
    const u = a.usage as CodexUsageTotals;
    assert.equal(u.inputTokens, 2600, 'inputTokens = final cumulative (incl cached)');
    assert.equal(u.cachedInputTokens, 1100, 'cachedInputTokens = final');
    assert.equal(u.uncachedInputTokens, 1500, 'uncachedInputTokens = input - cached');
    assert.equal(u.outputTokens, 248, 'outputTokens = final');
    assert.equal(u.reasoningOutputTokens, 148, 'reasoningOutputTokens = final');
    assert.equal(a.originLabel, 'codex-exec', 'codex_exec originator → codex-exec label');
    assert.equal(a.proofOrStopCwd, true, 'worktree cwd → proofOrStopCwd hint true');
    assert.deepEqual(a.storyMentions, ['B-70e9', 'B-abcd'], 'B-70E9 and cwd B-70e9 dedupe to one; B-abcd added');
    assert.equal(a.parseErrors, 1, 'one malformed line counted, scan continued');
  });

  // ── 2. null-info-only rollout → usage unknown (null), not zero ─────────────
  await checkAsync('null-info-only rollout reports usage unknown (null), never zero', async () => {
    const rows = await sweepCodexSessions({ dir: codexDir, sinceMs });
    const b = rows.find((r) => r.sessionId === 'codex-sess-B');
    assert.ok(b, 'codex-sess-B present');
    assert.equal(b.usage, null, 'usage is null (unknown), not a zero-filled object');
    assert.equal(b.originLabel, 'codex-desktop', 'Codex Desktop originator → codex-desktop label');
  });

  // ── 3. --since cutoff excludes old-mtime files BEFORE reading ───────────────
  await checkAsync('--since mtime cutoff excludes the old rollout entirely', async () => {
    const rows = await sweepCodexSessions({ dir: codexDir, sinceMs });
    assert.equal(rows.find((r) => r.sessionId === 'codex-sess-OLD'), undefined, 'old rollout not swept');
    assert.equal(rows.length, 2, 'only the two recent rollouts swept');
  });

  // ── 4. claude four-field dedupe by (requestId ?? message.id) keeping last ──
  await checkAsync('claude dedupe: shared req/msg counts once (keep last); distinct keys sum', async () => {
    const rows = await sweepClaudeProjects({ dir: claudeDir, sinceMs });
    const d = rows.find((r) => r.sessionId === 'claude-sess-D');
    assert.ok(d, 'claude-sess-D present');
    assert.ok(d.usage, 'session D has usage');
    const u = d.usage as ClaudeUsageTotals;
    assert.equal(u.inputTokens, 17, 'input = 10 (deduped) + 7');
    assert.equal(u.cacheCreationInputTokens, 3, 'cacheCreation = 2 + 1');
    assert.equal(u.cacheReadInputTokens, 7, 'cacheRead = 3 + 4');
    assert.equal(u.outputTokens, 48, 'output = 40 (LAST of req_1, not 5) + 8');
    assert.equal(d.originLabel, 'claude-code', 'claude origin label');
    assert.equal(d.sessionId, 'claude-sess-D', 'sessionId from filename stem');
    assert.ok(d.storyMentions.includes('B-70e9'), 'cwd mention captured');
    assert.ok(d.storyMentions.includes('B-dead'), 'body mention captured');
    assert.equal(d.parseErrors, 1, 'malformed claude line counted');
  });

  // ── 5. multi-thousand-line streaming sanity ────────────────────────────────
  await checkAsync('streams a 5000-line transcript (summed output = 5000)', async () => {
    const rows = await sweepClaudeProjects({ dir: claudeDir, sinceMs });
    const s = rows.find((r) => r.sessionId === 'claude-sess-STREAM');
    assert.ok(s && s.usage, 'stream session has usage');
    const u = s.usage as ClaudeUsageTotals;
    assert.equal(u.outputTokens, 5000, 'all 5000 unique events summed (streaming read the whole file)');
    assert.equal(u.inputTokens, 5000, 'all 5000 input tokens summed');
  });

  // ── 6. empty / missing dirs → empty report, no throw ───────────────────────
  await checkAsync('empty / missing store dirs → empty report, no throw', async () => {
    const codexEmpty = await sweepCodexSessions({ dir: join(root, 'does-not-exist-codex'), sinceMs });
    const claudeEmpty = await sweepClaudeProjects({ dir: join(root, 'does-not-exist-claude'), sinceMs });
    assert.deepEqual(codexEmpty, [], 'missing codex dir → []');
    assert.deepEqual(claudeEmpty, [], 'missing claude dir → []');
    const report = buildSweepReport([], { since: '2026-07-01', sinceMs });
    assert.equal(report.sessionCount, 0, 'empty report sessionCount 0');
    assert.deepEqual(report.sessions, [], 'no sessions');
    assert.equal(report.label, 'NON-AUTHORITATIVE ESTIMATE', 'label present on empty report');
    assert.equal(report.grandTotals.codex.sessions, 0, 'zero codex grand totals');
  });

  // ── 7. ZERO WRITES: store-dir file list + mtimes identical before/after ────
  await checkAsync('sweep makes ZERO writes to the store dirs', async () => {
    const beforeCodex = snapshotDir(codexDir);
    const beforeClaude = snapshotDir(claudeDir);
    await sweepCodexSessions({ dir: codexDir, sinceMs });
    await sweepClaudeProjects({ dir: claudeDir, sinceMs });
    const afterCodex = snapshotDir(codexDir);
    const afterClaude = snapshotDir(claudeDir);
    assert.deepEqual([...afterCodex.entries()].sort(), [...beforeCodex.entries()].sort(), 'codex store unchanged (no writes, mtimes intact)');
    assert.deepEqual([...afterClaude.entries()].sort(), [...beforeClaude.entries()].sort(), 'claude store unchanged (no writes, mtimes intact)');
  });

  // ── 8. report aggregation: multi-attribution, unattributed, grand totals ───
  await checkAsync('buildSweepReport: multi-attribution, sorting, grand totals, parse-error total', async () => {
    const codexRows = await sweepCodexSessions({ dir: codexDir, sinceMs });
    const claudeRows = await sweepClaudeProjects({ dir: claudeDir, sinceMs });
    const report = buildSweepReport([...codexRows, ...claudeRows], { since: '2026-07-01', sinceMs });
    // Session A mentions B-70e9 + B-abcd → both story rollups multi-attributed.
    const abcd = report.perStory.find((s) => s.storyId === 'B-abcd');
    assert.ok(abcd, 'B-abcd rollup present');
    assert.equal(abcd.multiAttribution, true, 'B-abcd is multi-attributed (session A mentioned >1 story)');
    const b70e9 = report.perStory.find((s) => s.storyId === 'B-70e9');
    assert.ok(b70e9, 'B-70e9 rollup present');
    assert.ok(b70e9.sessionCount >= 2, 'B-70e9 mentioned by codex A and claude D');
    // Sessions sorted by est. total tokens desc (STREAM: 10000 tok is the largest).
    assert.equal(report.sessions[0].sessionId, 'claude-sess-STREAM', 'largest-token session sorts first');
    // Grand totals count each session once; parse errors summed (1 codex + 1 claude).
    assert.equal(report.grandTotals.codex.inputTokens, 2600, 'grand codex input = session A only (B unknown, OLD excluded)');
    assert.equal(report.grandTotals.codex.sessionsUnknownUsage, 1, 'session B counted as unknown-usage');
    assert.equal(report.parseErrorTotal, 2, 'total parse errors across stores');
    // Unattributed: codex-sess-B mentions no story → unattributed bucket.
    assert.ok(report.unattributed.sessionCount >= 1, 'codex-sess-B is unattributed');
  });

  // ── 9. --out fence (core): relative-only, traversal refused, exclusive create
  await checkAsync('openReportFileExclusive: relative-inside-root creates exclusively; traversal/absolute refused', async () => {
    const projectRoot = join(root, 'guard-root');
    mkdirSync(projectRoot, { recursive: true });
    // Relative new file inside root → validated absolute path + exclusive fd.
    const opened = openReportFileExclusive(projectRoot, 'reports/sweep.json');
    closeSync(opened.fd);
    assert.equal(opened.absPath, join(projectRoot, 'reports', 'sweep.json'), 'validated absolute path inside root');
    assert.ok(existsSync(opened.absPath), 'exclusive create made the file (missing dirs created after validation)');
    // A relative path that resolves back inside root is allowed even with '..'.
    const backInside = openReportFileExclusive(projectRoot, 'sub/../report.json');
    closeSync(backInside.fd);
    assert.equal(backInside.absPath, join(projectRoot, 'report.json'), '.. that stays inside root is allowed');
    // '..' traversal escaping root → refused.
    for (const bad of ['../escape.json', '../../etc/passwd', 'sub/../../escape.json']) {
      assert.throws(() => openReportFileExclusive(projectRoot, bad), /outside the project root/, `refuses ${bad}`);
    }
    // Absolute paths are refused OUTRIGHT (even ones that would land inside root).
    for (const abs of ['/etc/passwd', join(projectRoot, 'abs-inside.json')]) {
      assert.throws(() => openReportFileExclusive(projectRoot, abs), /RELATIVE path/, `refuses absolute ${abs}`);
    }
    // The root itself (a dir, not a file) and the empty path are refused.
    assert.throws(() => openReportFileExclusive(projectRoot, '.'), /outside the project root/, 'refuses the root dir itself');
    assert.throws(() => openReportFileExclusive(projectRoot, ''), /empty/, 'refuses the empty path');
    // Re-opening an existing target is refused (never overwrite).
    assert.throws(() => openReportFileExclusive(projectRoot, 'reports/sweep.json'), /never overwrites/, 'refuses an existing target');
  });

  // ── 10. NON-AUTHORITATIVE label present in BOTH human and json handler output
  await checkAsync('handler: NON-AUTHORITATIVE label present in both human and json output; --out writes inside root', async () => {
    const ctx = makeCtx('handler-root');
    const handlers = createUsageSweepHandlers(ctx, { now: () => FIXED_NOW });

    // Human (text) mode: first line is exactly the header.
    const human = (await handlers.usage_sweep({ since: '2026-07-01', codexSessionsDir: codexDir, claudeProjectsDir: claudeDir })) as string;
    assert.equal(typeof human, 'string', 'text mode returns a string');
    assert.equal(human.split('\n')[0], NON_AUTHORITATIVE_HEADER, 'human first line is the exact NON-AUTHORITATIVE header');
    assert.ok(human.includes('PER-STORY ROLLUP'), 'human output has the per-story rollup');
    assert.ok(human.includes('GRAND TOTALS'), 'human output has grand totals');
    assert.ok(human.includes('parse error'), 'human output reports parse-error count');

    // JSON mode: object carries the same label.
    const jsonReport = (await handlers.usage_sweep({ since: '2026-07-01', codexSessionsDir: codexDir, claudeProjectsDir: claudeDir, json: true })) as Awaited<ReturnType<typeof handlers.usage_sweep>>;
    assert.equal(typeof jsonReport, 'object', 'json mode returns an object');
    assert.equal((jsonReport as { label: string }).label, 'NON-AUTHORITATIVE ESTIMATE', 'json report carries the label');
    assert.equal((jsonReport as { generatedAt: string }).generatedAt, new Date(FIXED_NOW).toISOString(), 'generatedAt uses the injected clock');

    // --out inside root writes exactly one report file and nothing else stays behind.
    const outRel = 'sweep-report.json';
    await handlers.usage_sweep({ since: '2026-07-01', codexSessionsDir: codexDir, claudeProjectsDir: claudeDir, json: true, out: outRel });
    const outPath = join(ctx.root, outRel);
    assert.ok(existsSync(outPath), '--out wrote the report inside root');
    const parsed = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(parsed.label, 'NON-AUTHORITATIVE ESTIMATE', 'written report carries the label');

    // --out escaping root is refused by the handler.
    await assert.rejects(
      () => handlers.usage_sweep({ since: '2026-07-01', codexSessionsDir: codexDir, claudeProjectsDir: claudeDir, out: '../escape.json' }),
      /outside the project root/,
      'handler refuses an --out that escapes the project root',
    );
  });

  // ── 11. since parsing shorthand ────────────────────────────────────────────
  await checkAsync('parseSinceToMs: <N>d shorthand, YYYY-MM-DD, ISO datetime; rejects garbage', async () => {
    assert.equal(parseSinceToMs('7d', FIXED_NOW).sinceMs, FIXED_NOW - 7 * 86_400_000, '7d shorthand');
    assert.equal(parseSinceToMs('2026-07-01', FIXED_NOW).sinceMs, Date.parse('2026-07-01T00:00:00.000Z'), 'YYYY-MM-DD at UTC midnight');
    assert.equal(parseSinceToMs('2026-07-01T06:30:00Z', FIXED_NOW).sinceMs, Date.parse('2026-07-01T06:30:00Z'), 'ISO datetime');
    assert.throws(() => parseSinceToMs('not-a-date', FIXED_NOW), /unparseable/, 'rejects garbage');
    assert.throws(() => parseSinceToMs('', FIXED_NOW), /required/, 'rejects empty');
  });

  // ── 12. F-010: absolute --out refused outright (handler) ───────────────────
  await checkAsync('handler: absolute --out is refused outright (relative-only rule), nothing written', async () => {
    const ctx = makeCtx('abs-out-root');
    const handlers = createUsageSweepHandlers(ctx, { now: () => FIXED_NOW });
    // Even an absolute path pointing INSIDE the project root is refused.
    const absOut = join(ctx.root, 'abs-report.json');
    await assert.rejects(
      () => handlers.usage_sweep({ since: '2026-07-01', codexSessionsDir: codexDir, claudeProjectsDir: claudeDir, json: true, out: absOut }),
      /RELATIVE path/,
      'absolute --out refused even when it points inside the project root',
    );
    assert.ok(!existsSync(absOut), 'no file was created by the refused absolute --out');
  });

  // ── 13. F-010: existing --out target refused, file byte-identical ──────────
  await checkAsync('handler: --out targeting an EXISTING file is refused; file untouched byte-identical', async () => {
    const ctx = makeCtx('overwrite-root');
    const handlers = createUsageSweepHandlers(ctx, { now: () => FIXED_NOW });
    // Simulate a tracked project file a readOnly command must never clobber.
    const victim = join(ctx.root, 'package.json');
    const original = '{"name":"victim","version":"1.0.0"}\n';
    writeFileSync(victim, original, 'utf8');
    await assert.rejects(
      () => handlers.usage_sweep({ since: '2026-07-01', codexSessionsDir: codexDir, claudeProjectsDir: claudeDir, json: true, out: 'package.json' }),
      /never overwrites/,
      '--out aimed at an existing tracked file is refused',
    );
    assert.equal(readFileSync(victim, 'utf8'), original, 'existing file is byte-identical (never truncated/replaced)');
  });

  // ── 14. F-010: symlinked --out ancestor refused; no write escapes root ─────
  await checkAsync('handler: symlinked --out ancestor is refused; nothing written outside the project root', async () => {
    const ctx = makeCtx('symlink-root');
    const handlers = createUsageSweepHandlers(ctx, { now: () => FIXED_NOW });
    const outsideDir = mkdtempSync(join(tmpdir(), 'usage-sweep-outside-'));
    try {
      // Inside-root name 'reports' actually points OUTSIDE the project root.
      symlinkSync(outsideDir, join(ctx.root, 'reports'));
      await assert.rejects(
        () => handlers.usage_sweep({ since: '2026-07-01', codexSessionsDir: codexDir, claudeProjectsDir: claudeDir, json: true, out: 'reports/sweep.json' }),
        /symlink/,
        'write through a symlinked ancestor is refused',
      );
      assert.deepEqual(readdirSync(outsideDir), [], 'no report file escaped outside the project root');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  // ── 15. F-010: happy path — relative --out creates a NEW nested report ─────
  await checkAsync('handler: relative --out creates a new nested report that parses; second run refuses overwrite', async () => {
    const ctx = makeCtx('happy-out-root');
    const handlers = createUsageSweepHandlers(ctx, { now: () => FIXED_NOW });
    const outRel = 'reports/nested/sweep.json';
    await handlers.usage_sweep({ since: '2026-07-01', codexSessionsDir: codexDir, claudeProjectsDir: claudeDir, json: true, out: outRel });
    const outPath = join(ctx.root, 'reports', 'nested', 'sweep.json');
    assert.ok(existsSync(outPath), 'missing report dirs created (after validation) and the report written');
    const parsed = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(parsed.label, 'NON-AUTHORITATIVE ESTIMATE', 'written report parses and carries the label');
    assert.equal(parsed.generatedAt, new Date(FIXED_NOW).toISOString(), 'written report carries generatedAt');
    // Create-only: the SAME path on a second run is refused, content untouched.
    const bytesBefore = readFileSync(outPath, 'utf8');
    await assert.rejects(
      () => handlers.usage_sweep({ since: '2026-07-01', codexSessionsDir: codexDir, claudeProjectsDir: claudeDir, json: true, out: outRel }),
      /never overwrites/,
      'second run against the same --out path is refused',
    );
    assert.equal(readFileSync(outPath, 'utf8'), bytesBefore, 'first report untouched by the refused second run');
  });

  // ── 16. F-010: '..'-traversal --out still refused (handler) ────────────────
  await checkAsync('handler: ".."-traversal --out is still refused; no file appears in the parent dir', async () => {
    const ctx = makeCtx('traversal-root');
    const handlers = createUsageSweepHandlers(ctx, { now: () => FIXED_NOW });
    for (const bad of ['../escape.json', 'sub/../../escape.json']) {
      await assert.rejects(
        () => handlers.usage_sweep({ since: '2026-07-01', codexSessionsDir: codexDir, claudeProjectsDir: claudeDir, json: true, out: bad }),
        /outside the project root/,
        `refuses ${bad}`,
      );
    }
    assert.ok(!existsSync(join(root, 'escape.json')), 'no traversal file appeared outside the fixture project root');
  });

  // ── 17. F-014: --out escalates the effective ownership class ───────────────
  // usage_sweep is a readOnly diagnostic, but --out writes a file inside the
  // project root, so a read-only reviewer session must not be able to run it.
  // The base policy stays readOnly (default preview ungated); the ownership gate
  // dynamically escalates a non-empty --out to storyScopedMutating (mirrors the
  // plan_skeleton/evidence_refresh/live_smoke_transcript/delivery_context_pack
  // --write boundary rules). Asserted as a pure resolver call like the other
  // policy smokes.
  await checkAsync('F-014: --out resolves usage_sweep to storyScopedMutating; no --out stays readOnly (base policy still readOnly/none)', async () => {
    const policy = getCommandPolicy('usage_sweep');
    assert.equal(policy?.ownershipClass, 'readOnly', 'usage_sweep base policy is readOnly');
    assert.equal(policy?.destructiveRisk, 'none', 'usage_sweep base policy has no static destructive risk');

    // No --out (read-only preview) → effectively readOnly (runnable by any session).
    assert.equal(
      resolveEffectiveOwnershipClass('usage_sweep', { since: '7d' }, null),
      'readOnly',
      'usage_sweep without --out is effectively readOnly',
    );
    // A blank / whitespace-only --out is NOT a write → still readOnly.
    assert.equal(
      resolveEffectiveOwnershipClass('usage_sweep', { since: '7d', out: '   ' }, null),
      'readOnly',
      'a blank --out is not a write and stays readOnly',
    );
    // A non-empty --out escalates to owner-gated storyScopedMutating.
    assert.equal(
      resolveEffectiveOwnershipClass('usage_sweep', { since: '7d', out: 'reports/sweep.json' }, null),
      'storyScopedMutating',
      'a non-empty --out is effectively storyScopedMutating (a read-only reviewer session cannot create the file)',
    );
  });

  // ── 18. F-028: activity/hook read-only classification for usage_sweep ──────
  // The CLI activity/hook layer (cli-engine) consults isReadOnlyCommand to decide
  // whether a command runs pre/post hooks and writes an activity-log row. Before
  // the fix usage_sweep was missing from that classification, so a plain (no --out)
  // sweep ran the hooks and wrote an activity row — violating the read-only
  // diagnostic contract. isReadOnlyCommand now mirrors the F-014 --out boundary:
  // plain usage_sweep is read-only (no hooks/activity), a non-empty --out is a
  // write. Asserted as a pure predicate call like the F-014 resolver check above.
  await checkAsync('F-028: plain usage_sweep is read-only for hooks/activity; --out makes it a write; other commands unchanged', async () => {
    // Static read-only members stay read-only (arg-independent).
    assert.equal(isReadOnlyCommand('session_brief', {}), true, 'a static READ_ONLY_COMMANDS member is read-only');
    assert.equal(isReadOnlyCommand('host_runtime_list', { anything: 1 }), true, 'static members ignore args');
    // Plain usage_sweep (no --out) → read-only: cli-engine runs no hooks + no activity write.
    assert.equal(isReadOnlyCommand('usage_sweep', {}), true, 'plain usage_sweep is read-only');
    assert.equal(isReadOnlyCommand('usage_sweep', { since: '7d' }), true, 'usage_sweep with only --since stays read-only');
    // A blank / whitespace-only --out is NOT a write → still read-only (matches the handler + ownership gate).
    assert.equal(isReadOnlyCommand('usage_sweep', { out: '   ' }), true, 'a blank --out is not a write, stays read-only');
    // A non-empty --out → NOT read-only (a write: runs hooks + writes activity).
    assert.equal(isReadOnlyCommand('usage_sweep', { out: 'reports/sweep.json' }), false, 'usage_sweep --out is a write, not read-only');
    // A non-usage_sweep, non-static command is not read-only (behaviour unchanged).
    assert.equal(isReadOnlyCommand('story_create', { out: '' }), false, 'a mutating command is not read-only regardless of args');

    // shouldWriteActivityLog reflects the same predicate: plain sweep writes no
    // activity row by default; a --out sweep is a write and IS logged. Save/restore
    // the readonly-record override so the assertion is deterministic regardless of env.
    const prevOverride = process.env.PROOF_OR_STOP_ACTIVITY_RECORD_READONLY;
    delete process.env.PROOF_OR_STOP_ACTIVITY_RECORD_READONLY;
    try {
      assert.equal(shouldWriteActivityLog('usage_sweep', {}), false, 'plain usage_sweep writes no activity log by default');
      assert.equal(shouldWriteActivityLog('usage_sweep', { out: 'reports/sweep.json' }), true, '--out usage_sweep writes an activity log (it is a write)');
      // The env override still forces a read-only activity row when explicitly requested.
      process.env.PROOF_OR_STOP_ACTIVITY_RECORD_READONLY = '1';
      assert.equal(shouldWriteActivityLog('usage_sweep', {}), true, 'PROOF_OR_STOP_ACTIVITY_RECORD_READONLY=1 records read-only rows too');
    } finally {
      if (prevOverride === undefined) delete process.env.PROOF_OR_STOP_ACTIVITY_RECORD_READONLY;
      else process.env.PROOF_OR_STOP_ACTIVITY_RECORD_READONLY = prevOverride;
    }
  });

  // ── 19. F-032: the codex process-event write obeys the read-only contract ──
  // Third surface of the F-028 read-only contract (after hooks + activity log):
  // cli-engine's run() appended a codex process event to the STORY's
  // process-events.jsonl after EVERY successful command. Under
  // PROOF_OR_STOP_ACTIVITY_SOURCE=codex with an inferred active story, a plain (no
  // --out) usage_sweep therefore mutated story metadata against the zero-write
  // contract. This is the honest end-to-end (CLI-level) form the finding asks
  // for: drive the REAL built CLI against a fixture project on a `story/` branch
  // (so detectActiveStory infers the active story) and assert the story's
  // process-events.jsonl is byte-identical after a plain sweep, while a
  // `usage_sweep --out` (a write) DOES append exactly one codex process event.
  await checkAsync('F-032: plain usage_sweep leaves process-events byte-identical; --out appends the codex process event (CLI end-to-end)', async () => {
    const cli = cliBin();
    assert.ok(cli, 'built dist/cli.js is present (run `npm run build` before this smoke)');

    const fixtureRoot = join(root, 'f032-project');
    const storyId = 'B-f032';
    mkdirSync(fixtureRoot, { recursive: true });
    // A git repo on a `story/<id>` branch is what detectActiveStory keys on. A
    // single commit is required so `git rev-parse --abbrev-ref HEAD` resolves
    // (an unborn branch would make rev-parse fail → no inferred active story).
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: fixtureRoot, stdio: ['ignore', 'ignore', 'ignore'] });
    };
    git(['init', '-q']);
    git(['-c', 'user.email=f032@local', '-c', 'user.name=f032', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-q', '-m', 'f032 fixture']);
    git(['checkout', '-q', '-b', `story/${storyId}`]);

    // Seed a readable story so StoryStore(root).readStory(storyId) succeeds and
    // detectActiveStory returns { storyId, phase }.
    const fixtureStore = new StoryStore(fixtureRoot);
    fixtureStore.writeStory(storyId, {
      storyId,
      name: storyId,
      title: 'F-032 read-only contract fixture',
      description: 'fixture story for the codex process-event read-only smoke',
      type: 'chore',
      phase: 'DEV',
      priority: 'normal',
      createdAt: new Date(FIXED_NOW).toISOString(),
      startedAt: null,
      endedAt: null,
    });
    const eventsFile = join(fixtureStore.storyDirPath(storyId), 'process-events.jsonl');
    const readEvents = (): string | null => (existsSync(eventsFile) ? readFileSync(eventsFile, 'utf8') : null);

    const childEnv: NodeJS.ProcessEnv = { ...process.env, PROOF_OR_STOP_ACTIVITY_SOURCE: 'codex', PROOF_OR_STOP_ACTIVITY_SESSION: 'f032-smoke' };
    // Neutralize env that could change the classification under the harness:
    // a read-only override would force an activity row, a reviewer-readonly flag
    // would refuse the --out write, and a stray project-root env is superseded
    // by --root anyway.
    delete childEnv.PROOF_OR_STOP_ACTIVITY_RECORD_READONLY;
    delete childEnv.PROOF_OR_STOP_REVIEWER_READONLY;
    delete childEnv.PROOF_OR_STOP_PROJECT_ROOT;
    const runSweep = (extra: string[]): void => {
      execFileSync(process.execPath, [
        cli, '--root', fixtureRoot, 'usage_sweep', '--since=2026-07-01',
        `--codexSessionsDir=${codexDir}`, `--claudeProjectsDir=${claudeDir}`, ...extra,
      ], { cwd: fixtureRoot, env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    };

    // Plain (no --out) sweep is read-only → NO process event may be written.
    const before = readEvents();
    assert.equal(before, null, 'baseline: no process-events file before any sweep');
    runSweep([]);
    assert.equal(readEvents(), before, 'plain usage_sweep left process-events.jsonl byte-identical (read-only contract holds)');
    assert.equal(readEvents(), null, 'read-only sweep created no process-events file at all');

    // usage_sweep --out is a write → it DOES append exactly one codex event.
    runSweep(['--out=reports/f032-sweep.json']);
    const after = readEvents();
    assert.ok(after && after.trim().length > 0, '--out usage_sweep appended a process event');
    const lines = after.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, 'exactly one process event appended by the mutating (--out) sweep');
    const evt = JSON.parse(lines[0]) as { type?: string; command?: string; storyId?: string; result?: string; source?: string };
    assert.equal(evt.type, 'codex_cli', 'the appended event is the codex_cli process event');
    assert.equal(evt.source, 'codex', 'event carries the codex source');
    assert.equal(evt.command, 'usage_sweep', 'event records the usage_sweep command');
    assert.equal(evt.storyId, storyId, 'event is bound to the inferred active story');
    assert.equal(evt.result, 'pass', 'the --out sweep succeeded (event result=pass)');
    assert.ok(existsSync(join(fixtureRoot, 'reports', 'f032-sweep.json')), '--out wrote the report inside the project root');
  });
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    if (failures.length > 0) {
      console.error(`\n✗ usage-sweep smoke FAILED (${failures.length} failing): ${failures.join(', ')}`);
      process.exit(1);
    }
    console.log(`\n✓ usage-sweep smoke passed (${passed} checks)`);
  });
