#!/usr/bin/env node
/**
 * Lab lineage-object-memo: one story_advance TEST / DONE runs several
 * reviewer-evidence collections (each its own git observation, so each reads
 * the live HEAD and material afresh). Every collection re-walks the same
 * reviewed..live commits and re-reads the same commit subjects, parents,
 * changed paths and committed snapshots. Those reads name full object ids:
 * their bytes cannot change while no replace ref, graft or shallow boundary
 * redirects them. After the per-observation dedupe, story_advance TEST still
 * spent ~1.5 s and story_advance DONE ~2.3 s on such repeats.
 *
 * Budget: a second collection in the same process re-runs no git read that is
 * addressed only by full object ids. Live probes (HEAD, material, ancestry
 * sources) run again whenever the repository's ref state changed
 * (git-ref-witness-memo); a replace ref disables the memo; a commit that is
 * not a permitted advance still invalidates the binding.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentGitHead, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { verifyManagedReviewLiveBinding } from '../core/managed-review-evidence.js';
import { withGitTreeObservation } from '../core/git-tree-observation.js';

const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const git = (cwd: string, args: string[]) => execFileSync(realGit, args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const storyId = 'B-memo';
const LANES = 3;
const OID = /^[0-9a-f]{40}$/;

/** A read whose every revision operand is a full object id (the memo's domain). */
function objectAddressed(argv: string[]): boolean {
  const [sub, ...rest] = argv;
  if (sub === 'show' && rest[0] === '-s') return OID.test(rest.at(-1) ?? '');
  if (sub === 'show' || sub === 'cat-file') return /^[0-9a-f]{40}:/.test(rest.at(-1) ?? '');
  if (sub === 'diff-tree') return OID.test(rest.at(-1) ?? '');
  if (sub === 'ls-tree' && rest[0] === '--name-only') return OID.test(rest[1] ?? '');
  if (sub === 'merge-base' && rest[0] === '--is-ancestor') return OID.test(rest[1] ?? '') && OID.test(rest[2] ?? '');
  if (sub === 'rev-list') return rest.some(arg => /^[0-9a-f]{40}\.\.[0-9a-f]{40}$/.test(arg));
  return false;
}

const root = mkdtempSync(join(tmpdir(), 'lineage-object-memo-'));
const shimDir = `${root}-shim`;
const log = join(shimDir, 'git.log');
try {
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'lab@example.test']);
  git(root, ['config', 'user.name', 'lab']);
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ storyDir: '.proof-or-stop/story/actives', storyPrefix: 'B' }));
  writeFileSync(join(root, 'main.go'), 'package main\n');
  const storyDir = join(root, '.proof-or-stop', 'story', 'actives', storyId);
  mkdirSync(storyDir, { recursive: true });
  writeFileSync(join(storyDir, 'story.json'), '{}\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'reviewed candidate']);
  const expected = { headHash: currentGitHead(root)!, materialHash: currentMaterialHash(root, 'HEAD', root)!, storyFilesHash: currentStoryFilesHash(root, 'HEAD', root)! };
  const metadataCommit = (command: string) => {
    writeFileSync(join(storyDir, 'certification-window.json'), `{"command":"${command}"}\n`);
    writeFileSync(join(storyDir, 'process-events.jsonl'), `{"event":"${command}"}\n`);
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', `proof-or-stop: record ${storyId} ${command} metadata`]);
  };
  writeFileSync(join(storyDir, 'review-passes.json'), '{"passes":[]}\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', `proof-or-stop: record ${storyId} managed_review_evidence_import metadata`]);
  for (const command of ['certification_window_begin', 'validate', 'TEST', 'live_smoke_transcript', 'summary_set']) metadataCommit(command);

  mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(shimDir, 'git'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\037' "$a"; done >> ${JSON.stringify(log)}\nprintf '\\n' >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(join(shimDir, 'git'), 0o755);
  process.env.PATH = `${shimDir}:${process.env.PATH ?? ''}`;
  const calls = (): string[][] => { try { return readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => line.split('\x1f').filter(Boolean)); } catch { return []; } };
  const verify = () => verifyManagedReviewLiveBinding({ gitCwd: root, metadataRoot: root, storyId, expected });
  const collection = (): { valid: boolean[]; argv: string[][] } => {
    const before = calls().length;
    const valid = withGitTreeObservation(() => Array.from({ length: LANES }, () => verify().valid));
    return { valid, argv: calls().slice(before) };
  };

  const first = collection();
  assert.deepEqual(first.valid, Array(LANES).fill(true), 'permitted metadata advances keep every lane valid');
  const firstObjectReads = first.argv.filter(objectAddressed).length;
  assert.ok(firstObjectReads > 0, 'the first collection reads the lineage objects');
  const second = collection();
  assert.deepEqual(second.valid, Array(LANES).fill(true));
  const repeated = second.argv.filter(objectAddressed);
  console.log(`object-addressed git reads: first collection ${firstObjectReads}, second collection ${repeated.length}; second collection total ${second.argv.length}`);
  assert.equal(repeated.length, 0, `a second collection re-ran ${repeated.length} object-addressed git reads (budget 0): ${repeated.slice(0, 3).map(a => a.join(' ')).join(' | ')}`);
  // Live probes are answered once per unchanged repository ref state
  // (git-ref-witness-memo): an unchanged repository is not re-probed, and a
  // moved HEAD is resolved afresh by the next collection.
  assert.equal(second.argv.length, 0, `an unchanged repository is re-probed: ${second.argv.map(a => a.join(' ')).join(' | ')}`);
  metadataCommit('done_prepare');
  const moved = collection();
  assert.deepEqual(moved.valid, Array(LANES).fill(true), 'a permitted metadata advance keeps every lane valid');
  assert.ok(moved.argv.some(argv => argv[0] === 'rev-parse'), 'a collection after HEAD moved resolves the live HEAD afresh');

  // A replace ref can redirect an object id: the memo must step aside.
  const head = git(root, ['rev-parse', 'HEAD']);
  git(root, ['replace', '-f', head, git(root, ['rev-parse', 'HEAD~1'])]);
  const replaced = collection();
  assert.ok(replaced.argv.filter(objectAddressed).length > 0, 'with a replace ref present every object read runs git again');
  git(root, ['replace', '-d', head]);

  // Freshness: a commit that is not a permitted advance is still seen.
  metadataCommit('checklist_update');
  assert.deepEqual(collection().valid, Array(LANES).fill(false), 'a non-permitted HEAD advance invalidates every lane in the next collection');
  console.log('lineage-object-memo-smoke: PASS');
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(shimDir, { recursive: true, force: true });
}
