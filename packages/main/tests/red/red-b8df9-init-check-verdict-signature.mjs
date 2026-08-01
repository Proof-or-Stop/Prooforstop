#!/usr/bin/env node
/**
 * B-8df9 RED: the INIT_CHECK signature does not cover the fields the gate decides on.
 *
 * `signInitCheck` (core/init-check-gate.ts) signs
 *   storyId : backgroundHash : title : description : checklistHash : reviewRound : SALT
 * while `canEnterInitCheckGuard` decides on `agentResults` (who reviewed) and
 * `issues` (what they found). Neither is in the domain, so a hand-edited file
 * stays signature-VALID and the gate accepts it with ZERO init_check_set calls.
 *
 * WHY THE CONTROLS MATTER. Two competing explanations would produce the same
 * "it advanced" observation and need different fixes, so this artifact rules
 * both out before claiming anything:
 *
 *   GATE CONTROLS (A, C1) - the gate must have discriminating power at all.
 *     Without these, "it advanced" could just mean "it advances for everything".
 *   SIGNATURE CONTROL (D1, D2) - the signature must be ALIVE and respond to a
 *     field that IS in the domain. Without this, "a dead signature check" would
 *     be indistinguishable from "this specific field is uncovered", and the fix
 *     for that is not the fix for this.
 *
 * If ANY control misbehaves the run reports BROKEN and draws NO conclusion.
 *
 * SCOPE OF THE CLAIM. This proves the record is not tamper-evident for those
 * fields. It does NOT prove anyone gains a capability: one caller can already
 * satisfy both required reviewers, and replace a recorded critical issue with
 * none, through ordinary legal CLI calls (by design; EXP-001; asserted by four
 * smoke tests). What tampering adds is the absence of an audit trail and a
 * bypass of the actor registry. Do not read a green run here as "reviewer
 * coverage is trustworthy" - it never was and this story does not make it so.
 *
 * RED while the defect stands (exit 1). GREEN after agentResults AND issues are
 * both in the domain (exit 0). Covering only one field must leave this RED.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..', '..', '..', '..');      // packages/main/tests/red -> repo root
const CLI = join(REPO, 'packages', 'main', 'dist', 'cli.js');

// Use the product's own recompute path. Reimplementing the domain here would
// let a mistake in the copy masquerade as a finding about the product.
const { recomputeInitCheckHash } = await import(join(REPO, 'packages/main/dist/core/init-check-gate.js'));
const { StoryStore } = await import(join(REPO, 'packages/main/dist/core/store.js'));

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
function write(root, p, c) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), c); }
function run(root, command, args, allowFailure = false) {
  try {
    return execFileSync(process.execPath, [CLI, '--root', root, command, JSON.stringify(args)], {
      cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    const t = String(e.stdout || '') + String(e.stderr || '') + String(e.message || '');
    if (allowFailure) return t;
    throw new Error(t);
  }
}
function freezeScope(root, sid) {
  run(root, 'scope_boundary_set', {
    storyId: sid, mode: 'correctness_fix',
    allowedScope: ['INIT_CHECK required reviewer records'], excludedScope: ['unrelated expansion'],
    userConfirmed: true, confirmation: 'Synthetic boundary for the B-8df9 signature-domain artifact.',
  });
  run(root, 'execution_boundary_set', {
    storyId: sid, allowedCommands: ['npm --prefix packages/main run build'],
    allowedTools: ['shell'], excludedCommands: ['rm -rf'],
  });
  assert.match(run(root, 'scope_freeze_check', { storyId: sid }), /PASS/);
}
function makeStory(root, name, title) {
  const created = run(root, 'story_create', {
    name, title, description: 'Fixture story for the B-8df9 signature-domain artifact.',
    type: 'chore', priority: 'medium',
    background: [
      '## Trigger Event',
      '2026-07-27 B-8df9 needs a fixture story with enough trigger detail to satisfy background validation.',
      '## Key Insights',
      'The signature domain and the fields the gate decides on are not the same set, which is what this measures.',
      '## Tradeoffs',
      'The artifact edits init-check.json directly on purpose; that edit is the tampering being measured.',
      '## Conversation Texture',
      'A maintainer wants to know whether hand-written reviewer coverage is accepted by the INIT_CHECK gate.',
    ].join('\n\n'),
    checklist: [{ title: 'Fixture item', context: 'Fixture only.' }],
  });
  const sid = created.match(/B-[a-f0-9]+/)?.[0];
  assert.ok(sid, 'story_create should return a story id');
  freezeScope(root, sid);
  return sid;
}
const dirOf = (root, sid) => join(root, '.lattice/story/actives', sid);
const icPath = (root, sid) => join(dirOf(root, sid), 'init-check.json');
const readJ = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJ = (p, d) => writeFileSync(p, JSON.stringify(d, null, 2));
const recompute = (root, sid) => recomputeInitCheckHash(sid, new StoryStore(root), root);

const rows = [];
const add = (id, claim, verdict) => rows.push([id, claim, verdict]);

const root = mkdtempSync(join(tmpdir(), 'red-b8df9-'));
try {
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'red@example.test']);
  git(root, ['config', 'user.name', 'B-8df9 Red']);
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src',
    storyDir: '.lattice/story/actives', requirementsDir: 'docs/requirements', storyPrefix: 'B',
  }, null, 2));
  write(root, 'README.md', 'red\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);

  // -- A: GATE CONTROL ---------------------------------------------------
  {
    const sid = makeStory(root, 'ctl-coverage', 'Control one reviewer');
    run(root, 'init_check_set', { storyId: sid, issues: [], agentId: 'lattice-review-story-init' });
    const out = run(root, 'story_advance', { storyId: sid, phase: 'INIT_CHECK' }, true);
    const ok = /missing_init_check_agent/.test(out) && /product-reviewer/.test(out);
    add('A', 'GATE CONTROL: one real reviewer is refused, naming the missing one',
      ok ? 'CONTROL-OK' : 'BROKEN');
  }

  // -- D: SIGNATURE CONTROL ----------------------------------------------
  {
    const sid = makeStory(root, 'ctl-indomain', 'Control in domain field');
    run(root, 'init_check_set', { storyId: sid, issues: [], agentId: 'lattice-review-story-init' });
    run(root, 'init_check_set', { storyId: sid, issues: [], agentId: 'product-reviewer' });

    const stored = readJ(icPath(root, sid))._hash;
    const idxPath = join(dirOf(root, sid), 'index.json');
    const idx = readJ(idxPath);
    idx.title = 'Control in domain field TAMPERED';
    writeJ(idxPath, idx);
    run(root, 'scope_freeze_check', { storyId: sid }); // title is a freeze input; re-freeze to reach the signature check

    add('D1', 'SIGNATURE CONTROL: editing an IN-DOMAIN field changes the recomputed signature',
      recompute(root, sid) !== stored ? 'CONTROL-OK' : 'BROKEN');
    const out = run(root, 'story_advance', { storyId: sid, phase: 'INIT_CHECK' }, true);
    add('D2', 'SIGNATURE CONTROL: the gate REJECTS that in-domain edit as tampering',
      /init_check_tampered/.test(out) ? 'CONTROL-OK' : 'BROKEN');
  }

  // -- B: THE DEFECT, agentResults ---------------------------------------
  {
    const sid = makeStory(root, 'red-inject', 'Injected reviewer coverage');
    run(root, 'init_check_set', { storyId: sid, issues: [], agentId: 'lattice-review-story-init' });

    const stored = readJ(icPath(root, sid))._hash;
    const before = recompute(root, sid);
    const ic = readJ(icPath(root, sid));
    ic.agentResults.push({ agentId: 'product-reviewer', checkedAt: new Date(0).toISOString(), issues: [] });
    writeJ(icPath(root, sid), ic);
    const after = recompute(root, sid);

    add('B1', 'the recomputed signature is UNCHANGED by injecting agentResults',
      after === before ? 'RED' : 'GREEN');
    add('B2', 'the tampered file is still signature-VALID (recomputed === stored)',
      after === stored ? 'RED' : 'GREEN');
    const out = run(root, 'story_advance', { storyId: sid, phase: 'INIT_CHECK' }, true);
    add('B3', 'the gate ACCEPTS hand-injected reviewer coverage, zero init_check_set calls',
      /advanced to INIT_CHECK/.test(out) ? 'RED' : 'GREEN');
  }

  // -- C: THE SAME DEFECT, issues ----------------------------------------
  {
    const sid = makeStory(root, 'red-erase', 'Erased blocking issue');
    run(root, 'init_check_set', { storyId: sid, issues: [], agentId: 'lattice-review-story-init' });
    run(root, 'init_check_set', { storyId: sid, agentId: 'product-reviewer',
      issues: [{ severity: 'critical', desc: 'Fixture blocking issue that must stop INIT_CHECK.' }] });

    const blocked = run(root, 'story_advance', { storyId: sid, phase: 'INIT_CHECK' }, true);
    add('C1', 'GATE CONTROL: a genuinely recorded critical issue blocks the advance',
      /init_check_blocking_issues/.test(blocked) ? 'CONTROL-OK' : 'BROKEN');

    const stored = readJ(icPath(root, sid))._hash;
    const ic = readJ(icPath(root, sid));
    for (const r of ic.agentResults) r.issues = [];
    if (Array.isArray(ic.issues)) ic.issues = [];
    writeJ(icPath(root, sid), ic);

    add('C2', 'erasing a recorded critical issue leaves the file signature-VALID',
      recompute(root, sid) === stored ? 'RED' : 'GREEN');
    const out = run(root, 'story_advance', { storyId: sid, phase: 'INIT_CHECK' }, true);
    add('C3', 'the gate ADVANCES after the critical blocker was erased by hand',
      /advanced to INIT_CHECK/.test(out) ? 'RED' : 'GREEN');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('=== B-8df9: INIT-check verdict fields are outside the signature domain ===\n');
let red = 0, broken = 0;
for (const [id, claim, verdict] of rows) {
  if (verdict === 'RED') red++;
  if (verdict === 'BROKEN') broken++;
  console.log(`  ${id.padEnd(3)} [${verdict.padEnd(10)}] ${claim}`);
}
console.log(`\n  ${red} RED / ${broken} BROKEN / ${rows.length} rows`);

if (broken > 0) {
  console.log('\n  A CONTROL IS BROKEN. No conclusion may be drawn from the RED rows; fix the harness first.\n');
  process.exit(2);
}
if (red > 0) {
  console.log([
    '',
    '  RED: the signature responds to an in-domain field (D1/D2) but IGNORES agentResults',
    '  and issues (B1/B2, C2), so the gate accepts records no legal caller wrote (B3, C3).',
    '  "the signature check is dead for everything" is ruled out by D.',
    '',
    '  This is about audit integrity, NOT access control: both outcomes are already',
    '  reachable through legal CLI calls. Tampering adds only the absence of a trail.',
    '',
  ].join('\n'));
  process.exit(1);
}
console.log('\n  GREEN: agentResults and issues are both inside the signature domain.\n');
