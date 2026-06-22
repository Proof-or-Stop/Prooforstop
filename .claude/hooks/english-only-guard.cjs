#!/usr/bin/env node
/**
 * Claude Code PreToolUse(Bash) hook: english-only artifact guard (warn-only).
 *
 * Layer 1 of the Lattice / Koala english-only-artifacts policy (B-5f42). It
 * inspects Bash commands BEFORE they run and, when a git commit or a Lattice
 * story-metadata command carries CJK (Han) characters, writes an English
 * warning to stderr. It NEVER blocks: it always exits 0. The hard stop is the
 * diff/story-scoped validate gate in the REVIEW->TEST preflight (layer 2).
 *
 * Exit 0 always — warn-only, never exit 2.
 *
 * Graceful degradation: any error / malformed / empty stdin causes a silent
 * pass-through (exit 0), exactly like lattice-scope-pretool.cjs, so a hook bug
 * can never trap the agent.
 *
 * SELF-CONTAINED: this hook does NOT require the compiled dist. Its CJK
 * character class is assembled from numeric code points so the file contains no
 * literal CJK. The ranges are kept identical to
 * packages/main/src/core/cjk-detect.ts (CJK Unified Ideographs U+4E00..U+9FFF
 * plus Extension A U+3400..U+4DBF); a keep-in-sync test asserts the equality.
 *
 * Managed by the Lattice / koala framework: this token is kept verbatim so
 * downstream managed-asset ownership recognizes this generated hook.
 */
'use strict';

// Single source of truth mirror: keep identical to core/cjk-detect.ts CJK_RANGES.
const CJK_RANGES = [
  { start: 0x4e00, end: 0x9fff }, // CJK Unified Ideographs
  { start: 0x3400, end: 0x4dbf }, // CJK Unified Ideographs Extension A
];

// Lattice story-metadata commands that are author-controlled artifacts.
const STORY_METADATA_COMMANDS = new Set([
  'story_create',
  'checklist_add',
  'checklist_update',
  'decision_set',
  'understanding_set',
  'summary_set',
]);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  try {
    const payload = parseHookInput(input);
    if (!payload) { process.exit(0); return; }

    const command = String((payload.tool_input && payload.tool_input.command) || '');
    if (!command.trim()) { process.exit(0); return; }

    if (!isGuardedCommand(command)) { process.exit(0); return; }

    if (containsCjk(command)) {
      process.stderr.write(
        'warn english-only: CJK detected in this git commit / lattice metadata command; '
        + 'Lattice artifacts must be English. This is a warning only; the validate '
        + 'REVIEW->TEST gate is the hard stop.\n',
      );
    }
  } catch {
    // PROBE: hook errors must never block the agent unexpectedly.
  }
  process.exit(0);
});

function parseHookInput(raw) {
  if (!raw || !raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * True only for `git commit ...` or `lattice <story-metadata-cmd> ...`.
 * Narrow and high-signal: other Bash commands are ignored.
 */
function isGuardedCommand(command) {
  if (/(^|[;&|]|\s)git\s+commit(\s|$)/.test(command)) return true;
  const lattice = command.match(/(?:^|[;&|]|\s)lattice\s+([a-z_]+)/);
  if (lattice && STORY_METADATA_COMMANDS.has(lattice[1])) return true;
  return false;
}

/** Build a fresh CJK character class from numeric code points (no literal CJK here). */
function buildCjkRegex() {
  const cls = CJK_RANGES
    .map(r => `${String.fromCodePoint(r.start)}-${String.fromCodePoint(r.end)}`)
    .join('');
  return new RegExp(`[${cls}]`, 'u');
}

function containsCjk(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return buildCjkRegex().test(text);
}
