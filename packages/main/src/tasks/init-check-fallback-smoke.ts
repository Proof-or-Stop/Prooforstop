#!/usr/bin/env node

/**
 * B-95d8 CHK-001 smoke: explicit, auditable INIT_CHECK fallback/repair command.
 *
 * Covers:
 *  1. init_check_repair refuses when disabled (no acknowledge) or missing/short reason.
 *  2. a successful repair writes a SIGNED init-check.json that story_advance accepts.
 *  3. tampering signed story content after repair still triggers init_check_tampered.
 *  4. story_get distinguishes fallback/manual attestation from an independent reviewer.
 *  5. the missing-init-check diagnostic names required reviewer(s), fallback availability,
 *     and the exact next command shape.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function run(root: string, command: string, args: Record<string, unknown>, allowFailure = false): string {
  try {
    return execFileSync(process.execPath, [cliPath, '--root', root, command, JSON.stringify(args)], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error: any) {
    const text = String(error.stdout || '') + String(error.stderr || '') + String(error.message || '');
    if (allowFailure) return text;
    throw new Error(text);
  }
}

const background = [
  '## Trigger Event',
  '2026-05-21 B-0000 smoke needs enough trigger detail to satisfy background validation for the init-check fallback path.',
  '## Key Insights',
  'Environments without a spawnable init reviewer still need an explicit, auditable exit that does not weaken the signature gate.',
  '## Tradeoffs',
  'The fallback reuses signInitCheck and marks reviewer records as fallback rather than faking an independent reviewer run.',
  '## Conversation Texture',
  'A maintainer sees a clear blocker that names the missing reviewers and offers the controlled init_check_repair fallback command.',
].join('\n\n');

function createStory(root: string, name: string, title: string): string {
  const created = run(root, 'story_create', {
    name,
    title,
    description: 'Verify the controlled INIT_CHECK fallback/repair command.',
    type: 'chore',
    priority: 'medium',
    background,
    checklist: [{ title: 'Verify fallback exit', context: 'INIT_CHECK must have a controlled, auditable fallback.' }],
  });
  const storyId = created.match(/B-[a-f0-9]+/)?.[0];
  assert.ok(storyId, 'story_create should return story id');
  return storyId!;
}

function initCheckPath(root: string, storyId: string): string {
  return join(root, '.lattice/story/actives', storyId, 'init-check.json');
}

const root = mkdtempSync(join(tmpdir(), 'lattice-init-fallback-'));
try {
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'smoke@example.test']);
  git(root, ['config', 'user.name', 'Lattice Smoke']);
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }, null, 2));
  write(root, 'README.md', 'smoke\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);

  // ── Test 5 (run first on a virgin story): missing-init-check diagnostic ──────
  const diagStory = createStory(root, 'fallback-diagnostic', 'Fallback diagnostic story');
  const missingDiag = run(root, 'story_advance', { storyId: diagStory, phase: 'INIT_CHECK' }, true);
  assert.match(missingDiag, /missing_init_check/, 'diagnostic should carry the missing_init_check tag');
  assert.match(missingDiag, /lattice-review-story-init/, 'diagnostic should name the required story-init reviewer');
  assert.match(missingDiag, /product-reviewer/, 'diagnostic should name the required product-reviewer');
  assert.match(missingDiag, /init_check_repair/, 'diagnostic should mention the fallback command');
  assert.match(missingDiag, /acknowledge/, 'diagnostic should show the acknowledge flag in the command shape');
  assert.match(missingDiag, /fallbackReason/, 'diagnostic should show the fallbackReason argument');

  // ── Test 1: refuse when disabled (no acknowledge) or with a too-short reason ─
  const refuseNoAck = run(root, 'init_check_repair', {
    storyId: diagStory,
    fallbackReason: 'No init reviewer is available in this CI sandbox; I manually verified background + checklist.',
  }, true);
  assert.match(refuseNoAck, /refused|acknowledge/i, 'repair without acknowledge must be refused');
  assert.ok(!existsSync(initCheckPath(root, diagStory)), 'refused repair must NOT write init-check.json');
  // Refused path must NOT emit authorization boundary or continuation hint.
  assert.doesNotMatch(
    refuseNoAck,
    /does not authorize implementation/,
    'refused repair (no-ack) must NOT emit the authorization boundary text',
  );
  assert.doesNotMatch(
    refuseNoAck,
    /now can run lattice story_advance|now can story_advance/,
    'refused repair (no-ack) must NOT emit the story_advance continuation hint',
  );

  const refuseShortReason = run(root, 'init_check_repair', {
    storyId: diagStory,
    acknowledge: true,
    fallbackReason: 'too short',
  }, true);
  assert.match(refuseShortReason, /fallbackReason/, 'short reason must be refused with a fallbackReason error');
  assert.ok(!existsSync(initCheckPath(root, diagStory)), 'refused repair (short reason) must NOT write init-check.json');
  // Refused path must NOT emit authorization boundary or continuation hint.
  assert.doesNotMatch(
    refuseShortReason,
    /does not authorize implementation/,
    'refused repair (short reason) must NOT emit the authorization boundary text',
  );
  assert.doesNotMatch(
    refuseShortReason,
    /now can run lattice story_advance|now can run lattice story_advance|now can story_advance/,
    'refused repair (short reason) must NOT emit the story_advance continuation hint',
  );

  // phase must be unchanged (still blocked) after refusals
  const stillBlocked = run(root, 'story_advance', { storyId: diagStory, phase: 'INIT_CHECK' }, true);
  assert.match(stillBlocked, /missing_init_check/, 'phase must stay blocked after refused repairs');

  // ── Test 2: a successful repair writes a signed init-check that the gate accepts ─
  const repaired = run(root, 'init_check_repair', {
    storyId: diagStory,
    acknowledge: true,
    fallbackReason: 'No init reviewer subagent can be spawned here; I manually reviewed background, checklist and product value.',
    evidenceRefs: ['manual-review-2026-05-21'],
  });
  assert.match(repaired, /init-check\.json generated/, 'repair should report init-check.json generated');
  assert.match(repaired, /audit event/, 'repair should report an audit event was recorded');
  // B-6894: repair success output must include the authorization boundary message.
  assert.match(
    repaired,
    /Fallback only repairs INIT_CHECK.*does not authorize implementation.*does not replace later PLAN\/DEV\/REVIEW\/TEST reviewers/s,
    'repair success output must include the authorization boundary message',
  );
  assert.ok(existsSync(initCheckPath(root, diagStory)), 'successful repair must write init-check.json');

  const advanced = run(root, 'story_advance', { storyId: diagStory, phase: 'INIT_CHECK' });
  assert.match(advanced, /advanced to INIT_CHECK/, 'story_advance must accept the signed fallback init-check');

  // ── Test 4: story_get distinguishes fallback attestation from independent reviewer ─
  const fallbackView = JSON.parse(run(root, 'story_get', { storyId: diagStory }));
  assert.equal(fallbackView.initCheckAttestation, 'fallback', 'fallback story_get must report attestation=fallback');
  assert.ok(fallbackView.initCheckFallback, 'fallback story_get must expose the fallback attestation block');
  assert.equal(fallbackView.initCheckFallback.mode, 'repair', 'fallback block records mode=repair by default');
  assert.ok(
    typeof fallbackView.initCheckFallback.reason === 'string' && fallbackView.initCheckFallback.reason.length >= 30,
    'fallback block records the >=30 char reason',
  );
  assert.ok(fallbackView.initCheckFallback.attestedAt, 'fallback block records attestedAt timestamp');
  // B-6894: fallback stories must carry a human-readable warning string.
  assert.ok(
    typeof fallbackView.initCheckFallbackWarning === 'string' && fallbackView.initCheckFallbackWarning.length > 0,
    'fallback story_get must carry initCheckFallbackWarning string',
  );
  assert.match(
    fallbackView.initCheckFallbackWarning,
    /manual fallback attestation, not independent reviewer approval/,
    'initCheckFallbackWarning must describe the attestation gap',
  );
  assert.match(
    fallbackView.initCheckFallbackWarning,
    /PLAN\/DEV\/REVIEW\/TEST gates remain required/,
    'initCheckFallbackWarning must state later gates remain required',
  );
  assert.match(
    fallbackView.initCheckFallbackWarning,
    /explicit user\/project authorization/,
    'initCheckFallbackWarning must name the authorization boundary',
  );

  // independent reviewer path for contrast
  const indepStory = createStory(root, 'independent-review', 'Independent reviewer story');
  run(root, 'init_check_set', { storyId: indepStory, issues: [], agentId: 'lattice-review-story-init' });
  run(root, 'init_check_set', { storyId: indepStory, issues: [], agent: 'product-reviewer' });
  const indepView = JSON.parse(run(root, 'story_get', { storyId: indepStory }));
  assert.equal(indepView.initCheckAttestation, 'independent', 'independent reviewer story_get must report attestation=independent');
  assert.ok(!indepView.initCheckFallback, 'independent path must NOT carry a fallback block');
  // B-6894: independent reviewer stories must NOT carry the warning field.
  assert.ok(!indepView.initCheckFallbackWarning, 'independent path must NOT carry initCheckFallbackWarning');
  const indepAdvanced = run(root, 'story_advance', { storyId: indepStory, phase: 'INIT_CHECK' });
  assert.match(indepAdvanced, /advanced to INIT_CHECK/, 'independent reviewer path still advances normally');

  // B-6894: session_brief for fallback story must surface the authorization boundary warning.
  // Run session_brief on the root (main branch has no story branch active) so the
  // main-dashboard active-stories view is exercised.
  const brief = run(root, 'session_brief', {});
  assert.match(
    brief,
    /INIT fallback warning/,
    'session_brief must render INIT fallback warning section when a fallback story is active',
  );
  assert.match(
    brief,
    /manual fallback attestation, not independent reviewer approval/,
    'session_brief INIT fallback warning must include the attestation gap text',
  );
  assert.match(
    brief,
    /PLAN\/DEV\/REVIEW\/TEST gates remain required/,
    'session_brief INIT fallback warning must state later gates remain required',
  );
  assert.match(
    brief,
    /explicit user\/project authorization/,
    'session_brief INIT fallback warning must include the authorization boundary',
  );

  // ── Test 3: tampering signed story content after repair still triggers tamper ─
  const tamperStory = createStory(root, 'fallback-tamper', 'Fallback tamper story');
  run(root, 'init_check_repair', {
    storyId: tamperStory,
    acknowledge: true,
    fallbackReason: 'No reviewer subagent available; manual attestation performed after reading the whole story envelope.',
  });
  run(root, 'story_update', { storyId: tamperStory, title: 'Fallback tamper story changed after attestation' });
  const tampered = run(root, 'story_advance', { storyId: tamperStory, phase: 'INIT_CHECK' }, true);
  assert.match(tampered, /init_check_tampered/, 'editing signed content after a fallback must trigger init_check_tampered');

  // ── Extra: operator-attested blocking issue still blocks the gate ────────────
  const blockStory = createStory(root, 'fallback-blocking', 'Fallback blocking story');
  const blockRepair = run(root, 'init_check_repair', {
    storyId: blockStory,
    acknowledge: true,
    fallbackReason: 'No reviewer subagent; manual review found a high-severity gap that must be fixed before INIT_CHECK.',
    issues: [{ severity: 'high', desc: 'Manual review found an unresolved high-severity scope gap.' }],
  });
  assert.match(blockRepair, /still blocks|high/, 'repair attesting a high issue should warn the gate still blocks');
  // Blocking output must also include the exact authorization boundary text (not just still blocks/high).
  assert.match(
    blockRepair,
    /Fallback only repairs INIT_CHECK.*does not authorize implementation.*does not replace later PLAN\/DEV\/REVIEW\/TEST reviewers/s,
    'blocking fallback output must include the exact authorization boundary text',
  );
  // Blocking output must NOT include the story_advance continuation hint.
  assert.doesNotMatch(
    blockRepair,
    /now can run lattice story_advance/,
    'blocking fallback output must NOT emit the story_advance continuation hint',
  );
  const blockedByIssue = run(root, 'story_advance', { storyId: blockStory, phase: 'INIT_CHECK' }, true);
  assert.match(blockedByIssue, /init_check_blocking_issues/, 'a fallback that attests a high issue must NOT pass the gate');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('✓ init check fallback/repair smoke passed');
