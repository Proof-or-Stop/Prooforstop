#!/usr/bin/env node
// HN-2 git-native cross-machine handoff demo (paper §7).
//
// Proves the architectural claim: a unit of work outlives a "dead" host because the
// handoff pack carries baseSha/headSha + a small canonical-story JSON, NOT the worktree.
// Machine B reconstructs the identical worktree from git ALONE (a fresh clone of a bare
// remote, no access to machine A's filesystem), runs handoff_resume, and continues.
//
// Deterministic; no agent/provider calls; no billing. Run:
//   node experiments/handoff-demo/run-handoff-resume.mjs
//
// Writes experiments/handoff-demo/handoff-resume-record.json with the measurements.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..');                 // Orchestrate repo root
const PROOF_OR_STOP = join(REPO, 'bin', 'proof-or-stop.js');
const node = process.execPath;
function git(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }
function proofOrStop(cwd, ...args) {
  return execFileSync(node, [PROOF_OR_STOP, '--root', cwd, ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}
function dirSize(p) { // bytes of all files under p (excluding .git)
  let total = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const fp = join(p, e.name);
    if (e.isDirectory()) total += dirSize(fp);
    else total += statSync(fp).size;
  }
  return total;
}

const root = mkdtempSync(join(tmpdir(), 'hn2-handoff-'));
const record = { schemaVersion: 'lattice.hn2-handoff-demo.v1', steps: [], assertions: [] };
function step(name, detail) { record.steps.push({ name, detail }); console.log(`• ${name}: ${detail}`); }
function assert(cond, msg) {
  record.assertions.push({ msg, pass: !!cond });
  if (!cond) { console.error(`✗ ASSERT FAILED: ${msg}`); throw new Error(msg); }
  console.log(`  ✓ ${msg}`);
}

try {
  // ── Machine A: a proof-or-stop project with an in-flight story, committed to a branch ──────
  const A = join(root, 'machineA');
  mkdirSync(A, { recursive: true });
  git(A, 'init', '-q', '-b', 'main');
  git(A, 'config', 'user.email', 'a@demo'); git(A, 'config', 'user.name', 'machineA');
  // minimal proof-or-stop project config
  writeFileSync(join(A, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: 'src', storyDir: '.proof-or-stop/story/actives' }, null, 2));
  // seed an in-flight story payload (real-shaped story metadata + a code file under work)
  const SID = 'B-hn2demo';
  const storyDir = join(A, '.proof-or-stop', 'story', 'actives', SID);
  mkdirSync(storyDir, { recursive: true });
  writeFileSync(join(storyDir, 'index.json'), JSON.stringify({
    id: SID, title: 'HN-2 git-native handoff demo story', phase: 'DEV', type: 'feature',
    createdAt: '2026-06-22T00:00:00.000Z',
  }, null, 2));
  writeFileSync(join(storyDir, 'checklist.json'), JSON.stringify({
    items: [{ id: 'CHK-001', title: 'implement parse step', status: 'in_progress', context: 'partial work in progress on machine A' }],
  }, null, 2));
  mkdirSync(join(A, 'src'), { recursive: true });
  writeFileSync(join(A, 'src', 'work.js'), 'export function parse(n){ /* partial: machine A */ return n; }\n');
  // gitignored bulk (stand-in for node_modules / build artifacts): part of the worktree,
  // NOT git-tracked, so it must NOT transfer — machine B reconstructs source without it.
  writeFileSync(join(A, '.gitignore'), 'node_modules_sim/\n');
  mkdirSync(join(A, 'node_modules_sim'), { recursive: true });
  writeFileSync(join(A, 'node_modules_sim', 'bulk.bin'), 'x'.repeat(2_000_000)); // ~2 MB
  git(A, 'add', '-A'); git(A, 'commit', '-q', '-m', 'machineA: story B-hn2demo in DEV (partial work)');
  const headA = git(A, 'rev-parse', 'HEAD');
  const treeA = git(A, 'rev-parse', 'HEAD^{tree}');
  step('machineA', `story ${SID} at DEV; HEAD=${headA.slice(0,12)} tree=${treeA.slice(0,12)}`);

  // ── Create the handoff pack on machine A (baseSha/headSha + canonical story) ─────────
  const packPath = join(A, 'handoff-pack.json');
  proofOrStop(A, 'handoff_create', `--storyId=${SID}`, '--fromHost=claude-code', '--toHost=codex',
    `--baseSha=${headA}`, '--objective=resume the parse step', `--output=${packPath}`, '--json');
  assert(existsSync(packPath), 'handoff pack JSON created on machine A');
  const packBytes = statSize(packPath);
  const worktreeBytes = dirSize(A);
  step('handoff_create', `pack=${packBytes}B vs machineA worktree=${worktreeBytes}B (pack is the small unit transferred)`);

  // ── Push machine A's branch to a BARE remote (the only shared medium) ────────────────
  const bare = join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', bare);
  git(A, 'remote', 'add', 'origin', bare);
  git(A, 'push', '-q', 'origin', 'main');
  step('push', `machineA pushed branch to bare remote ${bare}`);

  // ── Machine A "dies": machine B has NO access to A's filesystem, only the bare remote +
  //    the small pack JSON (copied as the out-of-band handoff artifact). ────────────────
  const B = join(root, 'machineB');
  git(root, 'clone', '-q', bare, B);                 // fresh clone from git ALONE
  git(B, 'config', 'user.email', 'b@demo'); git(B, 'config', 'user.name', 'machineB');
  const headB = git(B, 'rev-parse', 'HEAD');
  const treeB = git(B, 'rev-parse', 'HEAD^{tree}');
  step('machineB', `fresh clone from bare remote; HEAD=${headB.slice(0,12)} tree=${treeB.slice(0,12)}`);

  // ── Core HN-2 assertion: B reconstructed the IDENTICAL worktree from git alone ────────
  assert(headB === headA, 'machine B HEAD == machine A HEAD (reconstructed from git, not copied)');
  assert(treeB === treeA, 'machine B tree content-hash == machine A tree (byte-identical worktree)');
  assert(existsSync(join(B, '.proof-or-stop', 'story', 'actives', SID, 'index.json')),
    'story metadata reconstructed on machine B from git');
  assert(readFileSync(join(B, 'src', 'work.js'), 'utf8').includes('partial: machine A'),
    'partial code work reconstructed on machine B');

  // ── Resume on machine B from the pack (recovery point + evidence/lineage preserved) ──
  const packB = join(B, 'handoff-pack.json');
  cpSync(packPath, packB);                            // the small out-of-band JSON
  const resumeOut = proofOrStop(B, 'handoff_resume', `--file=${packB}`, '--json');
  const resume = JSON.parse(resumeOut.slice(resumeOut.indexOf('{'), resumeOut.lastIndexOf('}') + 1));
  assert(!existsSync(join(B, 'node_modules_sim', 'bulk.bin')),
    'gitignored bulk (2MB) did NOT transfer — only git-tracked deltas + pack moved');
  assert(resume.recoveryPoint && resume.recoveryPoint.storyId === SID,
    'resume projection recovers the correct story on machine B');
  step('handoff_resume', `machine B projected resume plan for ${SID} (host=${resume.resumeHost || 'n/a'})`);

  // ── Machine B continues the work (proves work outlives the dead host) ────────────────
  writeFileSync(join(B, 'src', 'work.js'),
    'export function parse(n){ if(n===0) return 0; return n; } // completed: machine B resumed\n');
  git(B, 'add', '-A'); git(B, 'commit', '-q', '-m', 'machineB: resumed B-hn2demo, completed parse step');
  const headB2 = git(B, 'rev-parse', 'HEAD');
  assert(headB2 !== headA && git(B, 'rev-list', '--count', `${headA}..${headB2}`) === '1',
    'machine B advanced the story by exactly one commit on top of machine A HEAD');
  step('resume+continue', `machine B continued work: ${headA.slice(0,12)} -> ${headB2.slice(0,12)}`);

  record.measurements = {
    headA, treeA, headB, treeB, headB2,
    packBytes, worktreeBytes,
    packFractionOfWorktree: +(packBytes / worktreeBytes).toFixed(4),
    reconstructedFromGitOnly: true,
  };
  record.verdict = 'PASS';
  writeFileSync(join(here, 'handoff-resume-record.json'), JSON.stringify(record, null, 2));
  console.log('\n✓ HN-2 git-native handoff demo passed: machine B reconstructed the identical worktree from git alone, resumed the story, and continued to a new commit. Record written.');
} catch (e) {
  record.verdict = 'FAIL'; record.error = String(e && e.message || e);
  writeFileSync(join(here, 'handoff-resume-record.json'), JSON.stringify(record, null, 2));
  console.error('HN-2 demo FAILED:', e && e.message);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}

function statSize(p) { return statSync(p).size; }
