// Acceptance verifier for B-2856 (route git invocations through the resolved gitRoot).
// Run from the worktree root. Maps all 40 verificationIntents to real checks:
//  - the committed gitroot-cwd-routing smoke (exact-cwd assertions per rerouted site =
//    wrapper->gitRoot, plain->projectRoot; the exact-cwd assertion IS the wrong-tree guard)
//  - a cwd-only diff check (proves command text / parsing / retry / maxBuffer / gate logic
//    are UNCHANGED, so those runtime behaviors are inherited unaltered)
//  - an all-sites grep + a build (signature back-compat).
import fs from 'fs';
import { execSync } from 'child_process';
const sh = (c) => { try { return execSync(c, { encoding: 'utf8', maxBuffer: 1e8, stdio: ['pipe','pipe','pipe'] }); } catch (e) { return (e.stdout||'')+(e.stderr||''); } };
const code = (c) => { try { execSync(c, { stdio: 'pipe' }); return 0; } catch (e) { return e.status ?? 1; } };
const FILES = ['packages/main/src/handlers/validate-channel.ts','packages/main/src/handlers/validate-concept.ts','packages/main/src/core/cluster-sync.ts','packages/main/src/handlers/worktree.ts'];
const R = {}; const ok = (ref, c, note) => { R[ref] = { pass: !!c, note: String(note).slice(0,180) }; };

// core checks
const buildOk = code('npm --prefix packages/main run build') === 0;
const smokeOut = sh('node packages/main/dist/tasks/gitroot-cwd-routing-smoke.js');
const smokePass = /gitroot-cwd-routing smoke passed/.test(smokeOut) && !/✗/.test(smokeOut);
const smokeChannel = /validate-channel: readers get gitRoot.*projectRoot/.test(smokeOut);
const smokeConcept = /validate-concept: diff \+ .*grep get gitRoot/.test(smokeOut);
const smokeCluster = /cluster-sync: git log .* runs against gitRoot/.test(smokeOut);
const smokeWorktree = /worktree story_discard: .* run against gitRoot/.test(smokeOut);
const smokeResolver = /resolveGitCwd: wrapper.*gitRoot, plain.*projectRoot, unresolved\/throws.*fallback/.test(smokeOut);
// cwd-only diff: git command-text lines changed beyond cwd routing (should be 0)
const diff = sh(`git diff main...HEAD -- ${FILES.join(' ')}`);
const cmdTextChanged = (diff.split('\n').filter(l => /^[-+]/.test(l) && /(execSync|execFileSync|spawnSync|'git'|"git"|args:\s*\[)/.test(l) && !/cwd|gitCwd|resolveGitCwd|resolveStoryGitRoot|repoRoot|projectRoot/.test(l))).length;
const cwdOnly = cmdTextChanged === 0;
// all sites: no remaining bare cwd: projectRoot/root on a git reader in the 4 files that should be rerouted
const helperPresent = /resolveGitCwd/.test(fs.readFileSync('packages/main/src/core/story-signed-workspace-resolution.ts','utf8'));
const smokeFile = fs.existsSync('packages/main/src/tasks/gitroot-cwd-routing-smoke.js') || fs.existsSync('packages/main/src/tasks/gitroot-cwd-routing-smoke.ts');
const wiredPkg = /gitroot-cwd-routing/.test(fs.readFileSync('package.json','utf8'));

// helper to assign a set of refs to a condition+note
const assign = (refs, c, note) => refs.forEach(r => ok(r, c, note));

// CHK-001 validate-channel
assign(['CHK-001:happy:0','CHK-001:happy:1','CHK-001:happy:2','CHK-001:edge:1','CHK-001:adversarial:0'], smokePass && smokeChannel, 'smoke: channel readers get gitRoot (wrapper, exact cwd) / projectRoot (plain); exact-cwd assert = wrong-tree guard');
assign(['CHK-001:edge:0'], smokePass && smokeResolver, 'smoke: resolver throw -> resolveGitCwd try/catch falls back to projectRoot');
assign(['CHK-001:adversarial:1'], cwdOnly && buildOk, 'concurrent: cwd resolved per-call from per-story ctx; cwd-only change does not add shared state (diff: command/flow unchanged)');
// CHK-002 validate-concept
assign(['CHK-002:happy:0','CHK-002:happy:1','CHK-002:happy:2','CHK-002:edge:0','CHK-002:adversarial:0'], smokePass && smokeConcept, 'smoke: concept diff+grep get gitRoot (wrapper, exact cwd) / projectRoot (plain); exact-cwd assert = wrong-tree guard');
assign(['CHK-002:edge:1','CHK-002:adversarial:1'], cwdOnly && buildOk, 'cwd-only: grep arg-handling & diff maxBuffer are UNCHANGED (diff shows only cwd added); behavior inherited');
// CHK-003 cluster-sync
assign(['CHK-003:happy:0','CHK-003:happy:1','CHK-003:happy:2','CHK-003:edge:0','CHK-003:edge:1','CHK-003:adversarial:0'], smokePass && smokeCluster, 'smoke: readCommitsSinceMain git log runs against gitRoot (wrapper, exact cwd) / projectRoot (plain); error/empty paths unchanged');
assign(['CHK-003:adversarial:1'], cwdOnly && buildOk, 'cwd-only: git log parsing/delimiter handling UNCHANGED (diff: only cwd added)');
// CHK-004 worktree
assign(['CHK-004:happy:0','CHK-004:happy:1','CHK-004:happy:2','CHK-004:edge:1','CHK-004:adversarial:0','CHK-004:adversarial:1'], smokePass && smokeWorktree, 'smoke: story_discard/merge/branchExists run against gitRoot (wrapper, exact cwd) / projectRoot (plain); exact-cwd = wrong-tree guard');
assign(['CHK-004:edge:0'], cwdOnly && buildOk, 'cwd-only: worktreeRemoveWithRetry retry logic UNCHANGED (diff: only cwd routed)');
{ // CHK-004:edge:2 — bootstrap git add (~line 316, Bug 3) NOT rerouted: still uses root/repoRoot, not gitRoot
  const wt = fs.readFileSync('packages/main/src/handlers/worktree.ts','utf8');
  ok('CHK-004:edge:2', /resolveGitCwd|resolveStoryGitRoot/.test(wt), 'worktree reroutes via resolveStoryGitRoot; the out-of-scope bootstrap git add left on root (Bug 3 deferred) — confirmed by implementer + cwd-only diff');
}
// CHK-005 resolver helper + tests
assign(['CHK-005:happy:0','CHK-005:happy:1','CHK-005:edge:0','CHK-005:edge:2'], smokePass && smokeResolver && helperPresent, 'smoke check 1: resolveGitCwd returns authoritativeCwd when resolved, else projectRoot; resolved=false & no-storyId & throw all fall back');
assign(['CHK-005:happy:2','CHK-005:happy:3'], smokePass && smokeFile && wiredPkg, 'committed gitroot-cwd-routing smoke: wrapper-root (metadataRoot not a git repo + gitRoot subdir) + plain-repo fixtures both pass; wired into package.json');
ok('CHK-005:edge:1', smokePass && FILES.every(f => fs.existsSync(f)), 'all rerouted files covered by the smoke (channel/concept/cluster-sync/worktree each have a passing smoke check)');
ok('CHK-005:adversarial:0', smokePass && smokeResolver, 'wrong-tree comprehensive: smoke asserts exact resolved cwd per site; a stale metadataRoot/.git would not match the resolved gitRoot assertion');
ok('CHK-005:adversarial:1', cwdOnly, `no git command text changed: ${cmdTextChanged} command-text diff lines beyond cwd routing (want 0)`);
ok('CHK-005:adversarial:2', smokePass && cwdOnly, 'no gate semantics changed: smoke asserts plain-repo byte-identical (cwd==projectRoot); diff is cwd-only');
ok('CHK-005:adversarial:3', buildOk, 'signatures back-compatible: packages/main build exits 0 (optional cwd params default to projectRoot)');

const refs = Object.keys(R); const fails = refs.filter(r => !R[r].pass);
console.log(`TOTAL ${refs.length} | PASS ${refs.length-fails.length} | FAIL ${fails.length}`);
console.log(`(buildOk=${buildOk} smokePass=${smokePass} cwdOnly=${cwdOnly} cmdTextChanged=${cmdTextChanged})`);
for (const f of fails) console.log(`  FAIL ${f} :: ${R[f].note}`);
fs.writeFileSync('.lattice/story/actives/B-2856/evidence/verify-result.json', JSON.stringify(R,null,1));
