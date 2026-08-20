#!/usr/bin/env node
/**
 * B-8df9 CHK-006 — check the RESTATED owner-lease exemption for `init_check_set`
 * (packages/main/src/core/command-policy.ts) against what the code actually DOES,
 * not against what the comment claims.
 *
 *   node .lattice/story/actives/B-8df9/chk006-exemption-claims.mjs
 *
 * Each claim in the new `reason` string gets one line of measured output. Every
 * measurement uses the product's own compiled modules and a private `mkdtemp`
 * fixture root; no real story is touched. Exits non-zero if any claim fails, so a
 * later edit that makes the sentence false fails here instead of reading fine.
 *
 * The one claim NOT re-measured here is the gate-level consequence of the
 * signature limit — that an editor who also RE-SIGNS is accepted and the gate
 * ADVANCES. That is row H1 of
 * packages/main/tests/red/red-b8df9-init-check-verdict-signature.mjs, which runs on
 * every validate; duplicating it would create a second place to keep true. What is
 * measured below is the function-level half: the trust predicate itself accepts a
 * record this tool never wrote.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

const REPO = process.cwd();
const DIST = join(REPO, 'packages/main/dist');
const CLI = join(REPO, 'bin/lattice.js');

const { COMMAND_POLICIES } = await import(join(DIST, 'core/command-policy.js'));
const { enforceStoryOwnerLeaseGate, resolveEffectiveOwnershipClass } = await import(join(DIST, 'cli/ownership-gate.js'));
const { StoryStore } = await import(join(DIST, 'core/store.js'));
const initCheckGate = await import(join(DIST, 'core/init-check-gate.js'));

const rows = [];
const claim = (marker, value, ok, detail) => {
  rows.push({ marker, value, ok, detail });
};

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const write = (root, p, c) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), c); };
const run = (root, command, args) => execFileSync(process.execPath, [CLI, '--root', root, command, JSON.stringify(args)], {
  cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
});

/** Every file under `dir`, repo-relative, so a write outside the story dir is visible. */
function listFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) listFiles(abs, base, out);
    else out.push(relative(base, abs));
  }
  return out;
}

// ── 1. the declared classification, read from the compiled policy ────────────
const setPolicy = COMMAND_POLICIES.init_check_set;
const advancePolicy = COMMAND_POLICIES.story_advance;
claim('INIT_CHECK_SET_OWNERSHIP_CLASS_MARKER', setPolicy?.ownershipClass,
  setPolicy?.ownershipClass === 'reviewerWrite',
  'the exemption being justified exists at all');
claim('STORY_ADVANCE_OWNERSHIP_CLASS_MARKER', advancePolicy?.ownershipClass,
  advancePolicy?.ownershipClass === 'storyScopedMutating',
  'the gate consumer named in the reason really is owner-gated');

const root = mkdtempSync(join(tmpdir(), 'b8df9-chk006-'));
try {
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'chk006@example.test']);
  git(root, ['config', 'user.name', 'B-8df9 CHK-006']);
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src',
    storyDir: '.lattice/story/actives', requirementsDir: 'docs/requirements', storyPrefix: 'B',
  }, null, 2));
  write(root, 'README.md', 'chk006\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);

  const created = run(root, 'story_create', {
    name: 'chk006-exemption', title: 'Fixture story for the B-8df9 CHK-006 exemption claims',
    description: 'Fixture story used to measure the init_check_set owner-lease exemption.',
    type: 'chore', priority: 'medium',
    background: [
      '## Trigger Event',
      '2026-08-03 B-8df9 CHK-006 needs a fixture story to measure the init_check_set owner-lease exemption.',
      '## Key Insights',
      'The owner lease decides WHO may write; the init-check signature decides WHAT a record contains.',
      '## Tradeoffs',
      'This fixture writes a hand-signed init-check.json on purpose; that write is the measurement.',
      '## Conversation Texture',
      'A maintainer wants to know whether the stated exemption reason survives contact with the code.',
    ].join('\n\n'),
    checklist: [{ title: 'Fixture item', context: 'Fixture only.' }],
  });
  const sid = created.match(/B-[a-f0-9]+/)?.[0];
  if (!sid) throw new Error(`story_create did not return a story id:\n${created}`);

  const storyDir = join(root, '.lattice/story/actives', sid);
  const leasePath = join(storyDir, 'owner-lease.json');
  const store = new StoryStore(root);

  // ── 2. the lease gate really exempts it, and really does not exempt a control ──
  // story_create/scope commands may already have taken a lease; clear it so the
  // measurement is about THIS call and not about fixture history.
  if (existsSync(leasePath)) rmSync(leasePath);
  enforceStoryOwnerLeaseGate('init_check_set', { storyId: sid }, store, null, root);
  const leaseAfterExemptCall = existsSync(leasePath);
  claim('LEASE_GATE_TOOK_LEASE_FOR_INIT_CHECK_SET_MARKER', leaseAfterExemptCall, leaseAfterExemptCall === false,
    'exempt: the gate returns before any lease is read or written');

  enforceStoryOwnerLeaseGate('checklist_update', { storyId: sid }, store, null, root);
  const leaseAfterControlCall = existsSync(leasePath);
  claim('LEASE_GATE_TOOK_LEASE_FOR_STORY_SCOPED_CONTROL_MARKER', leaseAfterControlCall, leaseAfterControlCall === true,
    'CONTROL: an owner-gated command on the same story DOES take the lease, so the line above is an exemption and not a dead gate');
  claim('OWNERSHIP_CLASS_OF_CONTROL_COMMAND_MARKER', resolveEffectiveOwnershipClass('checklist_update', { storyId: sid }, sid),
    resolveEffectiveOwnershipClass('checklist_update', { storyId: sid }, sid) === 'storyScopedMutating',
    'the control is owner-gated by classification, not by accident');

  // ── 3. what the write actually touches, and what it leaves alone ──────────
  const phaseBefore = store.readStory(sid).phase;
  const beforeFiles = new Set(listFiles(join(root, '.lattice')).filter(p => !p.startsWith('locks/')));
  run(root, 'init_check_set', { storyId: sid, issues: [], agentId: 'lattice-review-story-init' });
  const afterFiles = listFiles(join(root, '.lattice')).filter(p => !p.startsWith('locks/'));
  const phaseAfter = new StoryStore(root).readStory(sid).phase;

  claim('INIT_CHECK_SET_CHANGED_PHASE_MARKER', `${phaseBefore}->${phaseAfter}`, phaseBefore === phaseAfter,
    'deposits evidence only: the phase is unchanged by the write itself');

  const storyPrefix = `story/actives/${sid}/`;
  const outsideStoryDir = afterFiles.filter(p => !beforeFiles.has(p) && !p.startsWith(storyPrefix));
  claim('INIT_CHECK_SET_NEW_FILES_OUTSIDE_STORY_DIR_MARKER', outsideStoryDir.length === 0 ? 'none' : outsideStoryDir.join(','),
    outsideStoryDir.length === 0,
    'the write is confined to this story directory (runtime locks excluded)');

  // ── 4. the limit the reason states: the signature binds CONTENT, not the WRITER ──
  const icPath = join(storyDir, 'init-check.json');
  const record = JSON.parse(readFileSync(icPath, 'utf8'));
  // Inject a reviewer nobody dispatched, then RE-SIGN with the product's own
  // exported salt + sign function — exactly what a file-writer can do.
  record.agentResults = [
    ...(record.agentResults ?? []),
    { agentId: 'product-reviewer', checkedAt: new Date(0).toISOString(), issues: [] },
  ];
  const beforeReSign = initCheckGate.initCheckSignatureIsValid(sid, new StoryStore(root), root, record);
  record._hash = initCheckGate.recomputeInitCheckHash(sid, new StoryStore(root), root, record);
  writeFileSync(icPath, JSON.stringify(record, null, 2));
  const afterReSign = initCheckGate.initCheckSignatureIsValid(
    sid, new StoryStore(root), root, JSON.parse(readFileSync(icPath, 'utf8')),
  );
  claim('SIGNATURE_REJECTS_EDIT_WITHOUT_RESIGN_MARKER', beforeReSign === false, beforeReSign === false,
    'tamper-EVIDENCE holds: an edit that does not re-sign is refused');
  claim('SIGNATURE_ACCEPTS_AN_OUT_OF_TOOL_RESIGN_MARKER', afterReSign, afterReSign === true,
    'and its LIMIT, which the reason must state rather than hide: re-signing with the exported INIT_CHECK_SALT / signInitCheck IS accepted, so the signature binds CONTENT and never the WRITER, and cannot justify who may write');
  claim('INIT_CHECK_SALT_IS_EXPORTED_SOURCE_MARKER', typeof initCheckGate.INIT_CHECK_SALT === 'string' && initCheckGate.INIT_CHECK_SALT.length > 0,
    typeof initCheckGate.INIT_CHECK_SALT === 'string' && initCheckGate.INIT_CHECK_SALT.length > 0,
    'the salt is a public constant, not a secret key');
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ── report ───────────────────────────────────────────────────────────────────
console.log('=== B-8df9 CHK-006: the restated init_check_set exemption, measured against the code ===');
for (const r of rows) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.marker}=${r.value}`);
  console.log(`        ${r.detail}`);
}
const failed = rows.filter(r => !r.ok);
console.log(`  ${failed.length} FAILED / ${rows.length} claims`);
console.log(
  failed.length === 0
    ? '  EXEMPTION_REASON_MATCHES_CODE_MARKER=true — deposit-only justification holds, and the stated signature limit is real'
    : `  EXEMPTION_REASON_MATCHES_CODE_MARKER=false — ${failed.map(r => r.marker).join(', ')}`,
);
console.log(`  claims digest=${createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 12)}`);
process.exit(failed.length === 0 ? 0 : 1);
