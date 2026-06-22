#!/usr/bin/env node
/**
 * @task B-5f42
 * @checklist CHK-003
 * @title English-only guards smoke — detector, scope, keep-in-sync, gate block, hook spawn
 * @type feature
 * @priority high
 * @description
 *   End-to-end coverage for the English-only-artifacts policy (B-5f42):
 *
 *   1. detectCjk unit cases: a Chinese string is detected (built from code
 *      points — NO literal CJK in this file); pure ASCII/English is not
 *      detected; matched positions (line/col/codepoint) are reported.
 *   2. Keep-in-sync: the self-contained CJK range in
 *      .claude/hooks/english-only-guard.cjs equals core/cjk-detect.ts CJK_RANGES.
 *   3. Scope: english-artifact-gate never flags content OUTSIDE the current
 *      story dir (legacy Chinese elsewhere is ignored) and returns ok for
 *      English-only current-story content.
 *   4. Gate block: a CJK fixture (commit message and/or metadata built from
 *      code points) flips english-artifact-gate to ok=false naming source+line;
 *      English-only flips it back to ok=true (proves the block is real).
 *   5. Default git reader: the REAL defaultGitLogReader parses `git log
 *      main..HEAD` for this very worktree with zero parse errors / zero notes
 *      (regression guard for the CHK-002 NUL-byte delimiter fix).
 *   6. Hook spawn: spawn node .claude/hooks/english-only-guard.cjs with
 *      (a) a git-commit command containing CJK -> warning on stderr + exit 0;
 *      (b) an English-only command -> no output + exit 0;
 *      (c) empty / malformed stdin -> exit 0.
 *
 *   CONSTRAINT: this file contains NO literal CJK. Every Chinese fixture is
 *   assembled from numeric Unicode code points via cp() (same technique as
 *   english-open-source-surface-smoke.ts), so the smoke passes BOTH this gate
 *   and the Phase 3 English-surface gate without a self-exemption.
 *
 * @changes
 *   - [CHK-003] Add english-only guards smoke (detector/scope/sync/gate/hook).
 */

import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectCjk, CJK_RANGES, isCjkCodepoint } from '../core/cjk-detect.js';
import {
  runEnglishArtifactGate,
  renderEnglishArtifactViolations,
  type GitLogReader,
} from '../handlers/english-artifact-gate.js';
import {
  getClaudeHooks,
  PRETOOL_SCOPE_HOOK_MATCHER,
  ENGLISH_ONLY_GUARD_HOOK_FILE,
} from '../init-assets.js';

const here = dirname(fileURLToPath(import.meta.url));
// dist/tasks -> dist -> packages/main
const pkgRoot = resolve(here, '..', '..');
// packages/main -> packages -> repo root
const repoRoot = resolve(pkgRoot, '..', '..');
const hookPath = join(repoRoot, '.claude', 'hooks', 'english-only-guard.cjs');
const cjkDetectSrc = join(pkgRoot, 'src', 'core', 'cjk-detect.ts');
// packages/main/dist/cli.js — the compiled CLI entry, resolved like the
// pretool-scope-hook smoke (dist sibling of dist/tasks).
const cliPath = join(pkgRoot, 'dist', 'cli.js');

/** Assemble a string from Unicode code points (keeps literal CJK out of this file). */
function cp(...points: number[]): string {
  return String.fromCodePoint(...points);
}

// Reusable Chinese fixtures, decoded:
//   ZH_HELLO  -> U+4F60 U+597D            ("ni hao")
//   ZH_FIX    -> U+4FEE U+590D            ("xiu fu")
//   ZH_EXT_A  -> U+3400                   (CJK Extension A, outside the BMP-core block)
const ZH_HELLO = cp(0x4f60, 0x597d);
const ZH_FIX = cp(0x4fee, 0x590d);
const ZH_EXT_A = cp(0x3400);

// ─── Test 1: detectCjk unit cases ────────────────────────────────────────────

{
  // 1a) A Chinese string is detected, with positions reported.
  const text = `English line one\nprefix ${ZH_HELLO} suffix`;
  const result = detectCjk(text);
  assert.equal(result.found, true, 'detectCjk: Chinese string must be detected');
  assert.equal(result.matches.length, 2, 'detectCjk: both CJK code points must be reported');
  // "prefix " is 7 code points, so the first CJK char is at 1-based col 8 on line 2.
  assert.equal(result.matches[0].line, 2, 'detectCjk: line is 1-based and correct');
  assert.equal(result.matches[0].col, 8, 'detectCjk: column is 1-based code-point index');
  assert.equal(result.matches[0].codepoint, 0x4f60, 'detectCjk: codepoint of first match reported');
  assert.equal(result.matches[1].col, 9, 'detectCjk: second CJK char column is contiguous');

  // 1b) Extension A (outside the core block) is also detected — exercises both ranges.
  const extResult = detectCjk(`x${ZH_EXT_A}y`);
  assert.equal(extResult.found, true, 'detectCjk: CJK Extension A must be detected');
  assert.equal(extResult.matches[0].col, 2, 'detectCjk: Ext-A column counted in code points (one column)');
  assert.equal(extResult.matches[0].codepoint, 0x3400, 'detectCjk: Ext-A codepoint reported');

  // 1c) Pure ASCII / English is NOT detected.
  for (const ascii of ['', 'plain english only', 'git commit -m "fix the bug"', 'symbols: {}[]()<>!@#$%^&*']) {
    assert.equal(detectCjk(ascii).found, false, `detectCjk: ASCII "${ascii}" must NOT be detected`);
    assert.equal(detectCjk(ascii).matches.length, 0, `detectCjk: ASCII "${ascii}" must report zero matches`);
  }

  // 1d) isCjkCodepoint boundary checks (the range edges are inclusive).
  assert.equal(isCjkCodepoint(0x4e00), true, 'isCjkCodepoint: range start (U+4E00) inside');
  assert.equal(isCjkCodepoint(0x9fff), true, 'isCjkCodepoint: range end (U+9FFF) inside');
  assert.equal(isCjkCodepoint(0x4dff), false, 'isCjkCodepoint: just below the core block is outside');
  assert.equal(isCjkCodepoint(0x41), false, 'isCjkCodepoint: ASCII "A" is outside');

  console.log('✓ Test 1: detectCjk detects Chinese (positions reported), ignores ASCII/English');
}

// ─── Test 2: keep-in-sync — hook range === core/cjk-detect.ts range ───────────

{
  const hookSrc = readFileSync(hookPath, 'utf8');
  const coreSrc = readFileSync(cjkDetectSrc, 'utf8');

  // Extract every { start: 0x..., end: 0x... } pair from a source file's
  // CJK_RANGES definition. Both files declare the array identically.
  const rangeRe = /\{\s*start:\s*(0x[0-9a-fA-F]+),\s*end:\s*(0x[0-9a-fA-F]+)\s*\}/g;
  function extractRanges(src: string): Array<{ start: number; end: number }> {
    const out: Array<{ start: number; end: number }> = [];
    let m: RegExpExecArray | null;
    rangeRe.lastIndex = 0;
    while ((m = rangeRe.exec(src)) !== null) {
      out.push({ start: parseInt(m[1], 16), end: parseInt(m[2], 16) });
    }
    return out;
  }

  const hookRanges = extractRanges(hookSrc);
  const coreRanges = extractRanges(coreSrc);

  assert.ok(hookRanges.length >= 2, 'keep-in-sync: hook must declare its CJK ranges');
  assert.ok(coreRanges.length >= 2, 'keep-in-sync: core must declare its CJK ranges');
  // The constant exported from core is the single source of truth — compare the
  // hook's literal ranges AND the core's literal ranges against the runtime constant.
  const canonical = CJK_RANGES.map((r) => ({ start: r.start, end: r.end }));
  assert.deepEqual(
    coreRanges,
    canonical,
    'keep-in-sync: core/cjk-detect.ts literal ranges must equal exported CJK_RANGES',
  );
  assert.deepEqual(
    hookRanges,
    canonical,
    'keep-in-sync: english-only-guard.cjs ranges must equal core/cjk-detect.ts CJK_RANGES',
  );

  console.log('✓ Test 2: hook CJK range is byte-for-byte in sync with core/cjk-detect.ts');
}

// ─── Test 3: scope — content outside the current story dir is NOT flagged ─────

{
  // Build a temp "story dir" that does NOT contain any author metadata files,
  // plus a sibling file holding legacy Chinese OUTSIDE the story dir. The gate
  // must ignore the sibling entirely (it only reads AUTHOR_METADATA_BASENAMES
  // inside storyDir).
  const tmpRoot = mkdtempSync(join(tmpdir(), 'lattice-english-scope-'));
  try {
    const storyDir = join(tmpRoot, 'story');
    // Legacy Chinese living OUTSIDE the story dir — must never be scanned.
    const outsideFile = join(tmpRoot, 'legacy-elsewhere.md');
    mkdirSync(storyDir, { recursive: true });
    writeFileSync(outsideFile, `legacy ${ZH_HELLO} doc\n`, 'utf8');
    // An English-only author metadata file INSIDE the story dir.
    writeFileSync(
      join(storyDir, 'background.md'),
      'This story is documented entirely in English.\n',
      'utf8',
    );

    // No commits to scan -> inject an empty git reader so the commit channel
    // is a no-op and we isolate the metadata-scope behavior.
    const emptyGit: GitLogReader = () => '';
    const result = runEnglishArtifactGate({ storyDir, gitCwd: tmpRoot, gitLogReader: emptyGit });

    assert.equal(result.ok, true, 'scope: English-only current-story content must pass');
    assert.equal(result.violations.length, 0, 'scope: no violations for English-only story + outside legacy Chinese');
    // Defensive: the gate must not have reached for the outside file at all.
    assert.ok(
      !result.violations.some((v) => v.source.includes('legacy-elsewhere')),
      'scope: legacy Chinese OUTSIDE the story dir must never be flagged',
    );

    console.log('✓ Test 3: gate ignores legacy Chinese outside the story dir; English-only story passes');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// ─── Test 4: gate block — CJK fixture flips ok=false naming source+line ───────

{
  const tmpRoot = mkdtempSync(join(tmpdir(), 'lattice-english-block-'));
  try {
    const storyDir = join(tmpRoot, 'story');
    mkdirSync(storyDir, { recursive: true });

    // 4a) CJK in author metadata -> violation naming the basename + line.
    writeFileSync(
      join(storyDir, 'plan.md'),
      `# Plan\nEnglish line\nThis line carries ${ZH_FIX} text\n`,
      'utf8',
    );
    // 4b) CJK in a commit message -> violation naming the short sha.
    const cjkCommitSha = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
    const cjkGit: GitLogReader = () =>
      `${cjkCommitSha}\x1ffeat: add ${ZH_HELLO} feature\nbody line\x1e`;

    const failResult = runEnglishArtifactGate({ storyDir, gitCwd: tmpRoot, gitLogReader: cjkGit });
    assert.equal(failResult.ok, false, 'gate block: a CJK fixture MUST flip ok=false');
    assert.ok(failResult.violations.length >= 2, 'gate block: both the metadata + commit violations reported');

    const rendered = renderEnglishArtifactViolations(failResult.violations).join('\n');
    // Metadata violation names the basename + the offending line number (line 3).
    assert.ok(rendered.includes('plan.md:3'), `gate block: must name plan.md:3 (got: ${rendered})`);
    // Commit violation names the 7-char short sha.
    assert.ok(
      rendered.includes(`commit ${cjkCommitSha.slice(0, 7)}`),
      `gate block: must name the commit short sha (got: ${rendered})`,
    );

    // 4c) Replace the fixtures with English-only -> gate flips back to ok=true.
    writeFileSync(
      join(storyDir, 'plan.md'),
      '# Plan\nEnglish line\nThis line carries only English text\n',
      'utf8',
    );
    const englishGit: GitLogReader = () =>
      `${cjkCommitSha}\x1ffeat: add an English-only feature\nbody line\x1e`;
    const passResult = runEnglishArtifactGate({ storyDir, gitCwd: tmpRoot, gitLogReader: englishGit });
    assert.equal(passResult.ok, true, 'gate block: English-only fixtures MUST flip ok=true');
    assert.equal(passResult.violations.length, 0, 'gate block: English-only fixtures report zero violations');

    console.log('✓ Test 4: CJK fixture flips gate ok=false (named source+line); English-only flips ok=true');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// ─── Test 5: REAL default git reader parses `git log main..HEAD` cleanly ──────
// Regression guard for the CHK-002 NUL-byte delimiter fix: exercise the REAL
// defaultGitLogReader (no injected reader) against THIS worktree's branch and
// assert zero parse errors / zero notes — proving the %x1f / %x1e record/field
// split survives real multi-line commit bodies.

{
  // Only this worktree's own author metadata is in scope; the commit channel is
  // what we are asserting on. Use the real story dir if present, else a tmp dir.
  const realStoryDir = join(repoRoot, '.lattice', 'story', 'actives', 'B-5f42');
  const storyDirForReal = existsSync(realStoryDir)
    ? realStoryDir
    : mkdtempSync(join(tmpdir(), 'lattice-english-realgit-'));

  // No gitLogReader override => defaultGitLogReader runs `git log main..HEAD`.
  const result = runEnglishArtifactGate({ storyDir: storyDirForReal, gitCwd: repoRoot });

  // The default reader must succeed (zero notes means no "git log ... unavailable"
  // and no "story dir not found"). A NUL-byte / parse failure would surface here.
  assert.deepEqual(
    result.notes,
    [],
    `default git reader: expected zero notes (clean parse), got: ${JSON.stringify(result.notes)}`,
  );

  // Sanity: re-running the raw default reader directly must not throw and must
  // be parseable by execFileSync with the %x1f / %x1e ASCII escape spec.
  const raw = execFileSync('git', ['log', 'main..HEAD', '--pretty=format:%H%x1f%B%x1e'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  // The output (if any commits exist on this branch) must split cleanly on the
  // record separator without leaving a dangling field-separator-less record.
  const records = raw.split('\x1e').filter((r) => r.length > 0);
  for (const rec of records) {
    assert.ok(rec.includes('\x1f'), 'default git reader: every non-empty record must contain the field separator');
  }

  console.log(`✓ Test 5: real defaultGitLogReader parsed git log main..HEAD with 0 notes (${records.length} commit record(s))`);
}

// ─── Test 6: hook spawn behavior (warn-only, never blocks) ───────────────────

function spawnHook(payload: string | undefined): { status: number | null; stderr: string; stdout: string } {
  const res = spawnSync(process.execPath, [hookPath], {
    input: payload ?? '',
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { status: res.status, stderr: res.stderr ?? '', stdout: res.stdout ?? '' };
}

{
  // 6a) git commit command carrying CJK -> warning on stderr, exit 0.
  const cjkCommit = JSON.stringify({
    tool_input: { command: `git commit -m "feat: add ${ZH_HELLO} feature"` },
  });
  const a = spawnHook(cjkCommit);
  assert.equal(a.status, 0, 'hook 6a: CJK git commit must still exit 0 (warn-only)');
  assert.match(a.stderr, /warn english-only/i, 'hook 6a: CJK git commit must emit an English warning on stderr');

  // 6a') lattice story-metadata command carrying CJK -> warning, exit 0.
  const cjkLattice = JSON.stringify({
    tool_input: { command: `lattice checklist_update '{"title":"${ZH_FIX}"}'` },
  });
  const aa = spawnHook(cjkLattice);
  assert.equal(aa.status, 0, "hook 6a': CJK lattice metadata command must exit 0");
  assert.match(aa.stderr, /warn english-only/i, "hook 6a': CJK lattice metadata command must warn");

  // 6b) English-only git commit -> no output, exit 0.
  const englishCommit = JSON.stringify({
    tool_input: { command: 'git commit -m "feat: add an English-only feature"' },
  });
  const b = spawnHook(englishCommit);
  assert.equal(b.status, 0, 'hook 6b: English-only commit must exit 0');
  assert.equal(b.stderr.trim(), '', 'hook 6b: English-only commit must produce no stderr warning');

  // 6b') Non-guarded command with CJK (not git commit / not lattice metadata) -> silent, exit 0.
  const unguarded = JSON.stringify({
    tool_input: { command: `echo ${ZH_HELLO}` },
  });
  const bb = spawnHook(unguarded);
  assert.equal(bb.status, 0, "hook 6b': unguarded command must exit 0");
  assert.equal(bb.stderr.trim(), '', "hook 6b': unguarded command must not warn even with CJK");

  // 6c) empty / malformed stdin -> exit 0, no crash.
  for (const bad of ['', '   ', 'not json at all', '{"tool_input":']) {
    const c = spawnHook(bad);
    assert.equal(c.status, 0, `hook 6c: malformed/empty stdin (${JSON.stringify(bad)}) must exit 0`);
  }

  console.log('✓ Test 6: hook warns on CJK commit/metadata, stays silent on English/unguarded, exits 0 on bad stdin');
}

// ─── Test 7: init-rerun Claude hook merge — both PreToolUse hooks survive ─────
// Regression guard for the cb19e86e8 fix: re-running `lattice init` on a project
// whose .claude/settings.json ALREADY has ONLY the scope-pretool PreToolUse
// entry must MERGE the english-only-guard entry in (not silently drop it) while
// keeping the scope hook exactly once (the old loop only inspected hooks[0], so
// it dropped every managed entry after the first and risked re-pushing the whole
// array, duplicating the scope guard).

{
  const tmpRoot = mkdtempSync(join(tmpdir(), 'lattice-english-initrerun-'));
  // A temp HOME so global agent assets / user config never bleed into the run.
  const tmpHome = mkdtempSync(join(tmpdir(), 'lattice-english-initrerun-home-'));
  try {
    // Seed a git repo (init resolves the project root via git).
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmpRoot, stdio: ['pipe', 'pipe', 'pipe'] });
    execFileSync('git', ['config', 'user.email', 'rerun@test'], { cwd: tmpRoot, stdio: ['pipe', 'pipe', 'pipe'] });
    execFileSync('git', ['config', 'user.name', 'Rerun Test'], { cwd: tmpRoot, stdio: ['pipe', 'pipe', 'pipe'] });

    // Pre-existing settings.json with ONLY the scope-pretool PreToolUse entry.
    // Reuse getClaudeHooks().PreToolUse[0] so the command string is byte-exact
    // with what init expects — that is what makes the "exactly once, no dup"
    // assertion meaningful (a mismatched string would be appended, not merged).
    const scopeEntry = getClaudeHooks().PreToolUse[0];
    assert.equal(
      scopeEntry.matcher,
      PRETOOL_SCOPE_HOOK_MATCHER,
      'precondition: seeded entry must be the scope-pretool matcher (Edit|Write|MultiEdit|NotebookEdit)',
    );
    const seeded = { hooks: { PreToolUse: [scopeEntry] } };
    mkdirSync(join(tmpRoot, '.claude'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '.claude', 'settings.json'),
      JSON.stringify(seeded, null, 2) + '\n',
      'utf8',
    );

    // Re-run init over the project that already has the scope hook.
    execFileSync(process.execPath, [cliPath, 'init', '--profile=claude', tmpRoot], {
      cwd: tmpRoot,
      env: { ...process.env, HOME: tmpHome },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const merged = JSON.parse(readFileSync(join(tmpRoot, '.claude', 'settings.json'), 'utf8'));
    const preToolUse = merged?.hooks?.PreToolUse;
    assert.ok(Array.isArray(preToolUse), 'init-rerun: PreToolUse must remain an array');

    const commands = preToolUse
      .flatMap((entry: any) => (Array.isArray(entry?.hooks) ? entry.hooks : []))
      .map((hook: any) => hook?.command)
      .filter((c: any): c is string => typeof c === 'string');

    // The english-only-guard hook must now be present (it was NOT dropped).
    assert.ok(
      commands.some((c: string) => c.includes(ENGLISH_ONLY_GUARD_HOOK_FILE)),
      `init-rerun: english-only-guard hook must be merged in, got: ${JSON.stringify(commands)}`,
    );

    // The scope hook must appear EXACTLY ONCE (not duplicated by re-pushing).
    const scopeHits = commands.filter((c: string) => c.includes('lattice-scope-pretool.cjs')).length;
    assert.equal(
      scopeHits,
      1,
      `init-rerun: scope-pretool hook must appear exactly once, found ${scopeHits} in ${JSON.stringify(commands)}`,
    );

    console.log('✓ Test 7: init-rerun merges english-only-guard into existing scope-only PreToolUse (scope not duplicated)');
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(tmpHome, { recursive: true, force: true });
  }
}

console.log('\n✓ All english-only guards smoke tests passed');
