
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';










import { STORY_INIT_COMMIT, POLICY_COMMIT, POLICY_PATH, SCRIPT_PATH, EXPECTED_PACKAGE_SCRIPT } from "./rules.mjs";
import { git } from "./repository.mjs";

export function verifyOrdering(root, options = {}) {
  const storyInitCommit = options.storyInitCommit ?? STORY_INIT_COMMIT;
  const policyCommit = options.policyCommit ?? POLICY_COMMIT;
  const policyPath = options.policyPath ?? POLICY_PATH;
  const scriptPath = options.scriptPath ?? SCRIPT_PATH;
  const errors = [];
  const isAncestor = (older, newer) => {
    try {
      git(['merge-base', '--is-ancestor', older, newer], { cwd: root });
      return true;
    } catch {
      return false;
    }
  };
  const storyInitIsAncestor = isAncestor(storyInitCommit, 'HEAD');
  const policyIsAncestor = isAncestor(policyCommit, 'HEAD');
  if (!storyInitIsAncestor) errors.push(`ordering: Story init commit ${storyInitCommit} is not an ancestor of HEAD`);
  if (!policyIsAncestor) errors.push(`ordering: policy commit ${policyCommit} is not an ancestor of HEAD`);
  let policyPaths = [];
  try {
    policyPaths = git(['show', '--format=', '--name-only', policyCommit], { cwd: root }).trim().split('\n').filter(Boolean);
  } catch {
    errors.push(`ordering: policy commit ${policyCommit} cannot be inspected`);
  }
  if (policyPaths.length !== 1 || policyPaths[0] !== policyPath) {
    errors.push(`ordering: policy commit must contain only ${policyPath}`);
  }
  const introductions = git(['log', '--diff-filter=A', '--format=%H', '--', scriptPath], { cwd: root }).trim().split('\n').filter(Boolean);
  if (introductions.length !== 1) {
    errors.push(`ordering: expected exactly one committed RED verifier introduction, found ${introductions.length}`);
    return errors;
  }
  const redCommit = introductions[0];
  const policyBeforeRed = isAncestor(policyCommit, redCommit);
  if (!policyBeforeRed) errors.push('ordering: RED verifier commit does not descend from policy commit');
  if (!isAncestor(redCommit, 'HEAD')) errors.push('ordering: RED verifier commit is not an ancestor of HEAD');
  const redPaths = git(['show', '--format=', '--name-only', redCommit], { cwd: root }).trim().split('\n').filter(Boolean).sort();
  const expectedRedPaths = ['package.json', scriptPath].sort();
  if (JSON.stringify(redPaths) !== JSON.stringify(expectedRedPaths)) {
    errors.push(`ordering: RED commit changed unexpected paths: ${redPaths.join(', ')}`);
  }
  const forbiddenOrderingPaths = (paths) => paths.filter((path) => !path.startsWith('.lattice/story/actives/B-022e/') && !path.startsWith('.proof-or-stop/story/actives/B-022e/'));
  if (storyInitIsAncestor && isAncestor(storyInitCommit, policyCommit)) {
    const prePolicy = git(['log', '--format=%H', `${storyInitCommit}..${policyCommit}^`], { cwd: root }).trim().split('\n').filter(Boolean);
    for (const commit of prePolicy) {
      const forbidden = forbiddenOrderingPaths(git(['show', '--format=', '--name-only', commit], { cwd: root }).trim().split('\n').filter(Boolean));
      if (forbidden.length > 0) errors.push(`ordering: pre-policy commit ${commit.slice(0, 12)} changed production/non-story paths: ${forbidden.join(', ')}`);
    }
  } else if (storyInitIsAncestor) {
    errors.push('ordering: policy commit does not descend from Story init commit');
  }
  if (policyBeforeRed) {
    const intermediate = git(['log', '--format=%H', `${policyCommit}..${redCommit}^`], { cwd: root }).trim().split('\n').filter(Boolean);
    for (const commit of intermediate) {
      const forbidden = forbiddenOrderingPaths(git(['show', '--format=', '--name-only', commit], { cwd: root }).trim().split('\n').filter(Boolean));
      if (forbidden.length > 0) errors.push(`ordering: pre-RED commit ${commit.slice(0, 12)} changed production/non-story paths: ${forbidden.join(', ')}`);
    }
  }
  try {
    const packageAtRed = JSON.parse(git(['show', `${redCommit}:package.json`], { cwd: root }));
    if (packageAtRed.scripts?.['test:proof-or-stop-identity-cutover'] !== EXPECTED_PACKAGE_SCRIPT) {
      errors.push('ordering: RED commit does not bind the exact focused package target');
    }
  } catch {
    errors.push('ordering: cannot parse package.json at RED commit');
  }
  return errors;
}

export function createOrderingSelfTestFixture(productionBeforePolicy = false, productionBeforeRed = false, policyPathMutation = 'none') {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-ordering-self-test-'));
  git(['init', '-b', 'main'], { cwd: root });
  git(['config', 'user.email', 'ordering@example.test'], { cwd: root });
  git(['config', 'user.name', 'Ordering Self Test'], { cwd: root });
  const write = (path, content) => {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), content, 'utf8');
  };
  write('.proof-or-stop/story/actives/B-022e/index.json', '{"storyId":"B-022e","phase":"INIT"}\n');
  git(['add', '.'], { cwd: root });
  git(['commit', '-m', 'story init'], { cwd: root });
  const storyInitCommit = git(['rev-parse', 'HEAD'], { cwd: root }).trim();
  if (productionBeforePolicy) {
    write('packages/main/src/too-early.ts', 'export const migratedBeforePolicy = true;\n');
    git(['add', '.'], { cwd: root });
    git(['commit', '-m', 'production before policy'], { cwd: root });
  }
  const committedPolicyPath = policyPathMutation === 'wrong'
    ? 'docs/requirements/decisions/wrong-cutover-policy.md'
    : POLICY_PATH;
  write(committedPolicyPath, '# Cutover policy\n');
  if (policyPathMutation === 'extra') {
    write('packages/main/src/policy-side-effect.ts', 'export const changedWithPolicy = true;\n');
    git(['add', committedPolicyPath, 'packages/main/src/policy-side-effect.ts'], { cwd: root });
  } else {
    git(['add', committedPolicyPath], { cwd: root });
  }
  git(['commit', '-m', 'policy only'], { cwd: root });
  const policyCommit = git(['rev-parse', 'HEAD'], { cwd: root }).trim();
  if (productionBeforeRed) {
    write('packages/main/src/too-early.ts', 'export const migratedBeforeRed = true;\n');
    git(['add', '.'], { cwd: root });
    git(['commit', '-m', 'production before RED'], { cwd: root });
  }
  write('package.json', `${JSON.stringify({ scripts: { 'test:proof-or-stop-identity-cutover': EXPECTED_PACKAGE_SCRIPT } }, null, 2)}\n`);
  write(SCRIPT_PATH, '#!/usr/bin/env node\n');
  git(['add', 'package.json', SCRIPT_PATH], { cwd: root });
  git(['commit', '-m', 'RED verifier'], { cwd: root });
  const redCommit = git(['rev-parse', 'HEAD'], { cwd: root }).trim();
  const policyTree = git(['show', '-s', '--format=%T', policyCommit], { cwd: root }).trim();
  const unrelatedPolicyCommit = git(['commit-tree', policyTree, '-m', 'unrelated policy root'], { cwd: root }).trim();
  return { root, storyInitCommit, policyCommit, redCommit, unrelatedPolicyCommit };
}
