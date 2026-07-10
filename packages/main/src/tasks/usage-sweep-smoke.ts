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
 *   - --out path traversal refused (pure guard + handler);
 *   - NON-AUTHORITATIVE label present in BOTH human and json outputs;
 *   - multi-thousand-line streaming sanity (proves the readline path).
 *
 * Prints per-check lines and a final summary; exits non-zero on any failure.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildSweepReport,
  parseSinceToMs,
  resolveOutPathWithinRoot,
  sweepClaudeProjects,
  sweepCodexSessions,
  type CodexUsageTotals,
  type ClaudeUsageTotals,
} from '../core/usage-sweep.js';
import { StoryStore } from '../core/store.js';
import { createUsageSweepHandlers, NON_AUTHORITATIVE_HEADER } from '../handlers/usage-sweep.js';
import type { HandlerContext } from '../handlers/context.js';

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
    assert.equal(a.latticeCwd, true, 'worktree cwd → latticeCwd hint true');
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

  // ── 9. --out path traversal refused (pure guard) ───────────────────────────
  await checkAsync('resolveOutPathWithinRoot refuses paths escaping the project root', async () => {
    const projectRoot = join(root, 'guard-root');
    mkdirSync(projectRoot, { recursive: true });
    // Inside root → allowed.
    const inside = resolveOutPathWithinRoot(projectRoot, 'reports/sweep.json');
    assert.ok(inside.startsWith(projectRoot), 'relative path resolves inside root');
    // A relative path that resolves back inside root is allowed even with '..'.
    const backInside = resolveOutPathWithinRoot(projectRoot, 'sub/../report.json');
    assert.equal(backInside, join(projectRoot, 'report.json'), '.. that stays inside root is allowed');
    // Escapes → refused.
    for (const bad of ['../escape.json', '../../etc/passwd', '/etc/passwd', 'sub/../../escape.json']) {
      assert.throws(() => resolveOutPathWithinRoot(projectRoot, bad), /outside the project root/, `refuses ${bad}`);
    }
    // The root itself (a dir, not a file) is refused.
    assert.throws(() => resolveOutPathWithinRoot(projectRoot, '.'), /outside the project root|empty/, 'refuses the root dir itself');
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
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(root, { recursive: true, force: true });
    if (failures.length > 0) {
      console.error(`\n✗ usage-sweep smoke FAILED (${failures.length} failing): ${failures.join(', ')}`);
      process.exit(1);
    }
    console.log(`\n✓ usage-sweep smoke passed (${passed} checks)`);
  });
