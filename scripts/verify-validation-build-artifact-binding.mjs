#!/usr/bin/env node
// Lab validation-build-artifact-binding RED/GREEN.
//
// Bug: routine validation evidence and the DONE-required evidence bind headHash,
// materialHash and storyFilesHash, all derived from the COMMITTED tree. The
// registered validation commands execute packages/main/dist and
// packages/utils/dist, which are gitignored and therefore invisible to every one
// of those digests. Two runs can carry a byte-identical binding while executing
// different compiled code, and a PASS produced against one dist stays reusable
// and admissible after dist changes. On main this surfaced as 57 same-identity
// re-executions of which 23 flipped the verdict (all fail->pass) across 22 Stories.
//
// This script drives the real public evaluators against a disposable repository
// whose dist tree it controls. It never manufactures gate receipts and never
// imports the repair directly for its assertions: the optional helper import
// below only builds evidence the way the repaired writer would, so the same
// assertions run before and after the fix.
import './lab-source-loader.mjs';
import { registerHooks, createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const ts = createRequire(import.meta.url)('typescript');
// Compile checkout source with TypeScript, including parameter properties.
registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
    source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, esModuleInterop: true,
    }, fileName: fileURLToPath(url) }).outputText };
  return nextLoad(url, context);
} });
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const { evaluateRoutineValidationReuse, buildRoutineValidationIdentity } = await import('../packages/main/src/core/validation-evidence-reuse.ts');
const { evaluateValidationEvidenceAdmissibility } = await import('../packages/main/src/core/validation-evidence-admissibility.ts');
const { currentGitHead, currentMaterialHash, currentStoryFilesHash } = await import('../packages/main/src/core/evidence-freshness.ts');
// Present only after the repair. Used to build evidence exactly as the repaired
// writer does; never used as the subject of an assertion.
const binding = await import('../packages/main/src/core/build-artifacts-identity.ts').catch(() => null);

const MARKER = 'stale build artifacts admitted as fresh validation evidence';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const sandbox = mkdtempSync(join(tmpdir(), 'pos-build-binding-'));
const red = [];
let checks = 0;
function check(value, message) { assert(value, message); checks++; }
function expectRepaired(value, message) { if (value) checks++; else red.push(message); }
function git(root, args) { return execFileSync(realGit, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }

function fixture() {
  const root = join(sandbox, 'repo'); mkdirSync(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'user.name', 'Build Binding Fixture']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ scanRoot: '.', rootDir: '.', outDir: 'dist', testsDir: 'tests', fixturesDir: 'tests/fixtures', storyDir: '.proof-or-stop/story/actives' }));
  writeFileSync(join(root, '.gitignore'), 'dist\n');
  writeFileSync(join(root, 'README.md'), 'base\n');
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'seed isolated fixture']);
  git(root, ['checkout', '-qb', 'story/B-bab']);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/probe.ts'), 'export const probe = 1;\n');
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'story: probe source']);
  const mainDist = join(root, 'packages/main/dist/tasks'); mkdirSync(mainDist, { recursive: true });
  const utilsDist = join(root, 'packages/utils/dist'); mkdirSync(utilsDist, { recursive: true });
  writeFileSync(join(utilsDist, 'index.js'), 'export const utils = 1;\n');
  return { root, probe: join(mainDist, 'probe-smoke.js') };
}

const BUILD_A = 'process.exit(0); // compiled from probe.ts, build A\n';
const BUILD_B = 'process.exit(1); // compiled from probe.ts, build B: same source binding, different code\n';

try {
  const { root, probe } = fixture();
  writeFileSync(probe, BUILD_A);
  const head = currentGitHead(root);
  const materialHash = currentMaterialHash(root, 'HEAD', root);
  const storyFilesHash = currentStoryFilesHash(root, 'HEAD', root);
  check(head && materialHash && storyFilesHash, `fixture identity must resolve head/material/storyFiles (got ${head}/${materialHash}/${storyFilesHash})`);

  const identity = buildRoutineValidationIdentity({
    projectRoot: root, sourceKind: 'configured', sourceInputs: { fixture: 'build-binding' },
    commands: [{ label: 'probe', command: 'node', args: ['packages/main/dist/tasks/probe-smoke.js'] }],
    profile: 'balanced', verificationPolicyInputs: { fixture: 'build-binding' },
  });
  check(identity.commands[0].executableDigest, 'identity must bind the node executable (existing behaviour)');
  const currentBuild = () => binding ? binding.currentBuildArtifactsHash(root) : undefined;
  const recordedBuild = currentBuild();
  const evidence = {
    command: 'proof-or-stop validate --story=B-bab --json',
    output: JSON.stringify({ allPass: true }),
    result: 'PASS',
    timestamp: new Date().toISOString(),
    headHash: head, materialHash, storyFilesHash,
    ...(recordedBuild ? { buildArtifactsHash: recordedBuild } : {}),
    verificationCoverage: { missingRequired: 0 },
    commandExecution: { schema: 'proofOrStop.routine-validation-command-execution', version: 1, status: 'PASS', complete: true, commandCount: 1, requiredFailureCount: 0, optionalFailureCount: 0 },
    disposition: 'executed',
    routineValidationIdentity: identity,
  };
  const reuse = () => evaluateRoutineValidationReuse({
    root, gitCwd: root, evidence, currentIdentity: identity, currentCoverage: { missingRequired: 0 },
    currentMaterialHash: materialHash, currentStoryFilesHash: storyFilesHash, clean: true, headBefore: head, headAfter: head,
    ...(binding ? { currentBuildArtifactsHash: currentBuild() } : {}),
  });
  const admissibility = () => evaluateValidationEvidenceAdmissibility({
    evidence, expectedCommand: evidence.command, currentCoverageSnapshot: 'coverage', recordedCoverageSnapshot: 'coverage',
    blockingDirtyReason: '', gitCwd: root, metadataRoot: root,
  });

  // Controls: with the recorded dist in place everything else is fresh, so both consumers admit.
  const reuseBefore = reuse();
  check(reuseBefore.reusable === true, `control: PASS against build A must be reusable (refusalReasons=${reuseBefore.refusalReasons.join(',')})`);
  const admitBefore = admissibility();
  check(admitBefore.ok === true, `control: PASS against build A must be admissible (reasonCodes=${admitBefore.reasonCodes.join(',')})`);

  // Target: the compiled artifact changes while HEAD, materialHash and storyFilesHash stay identical.
  writeFileSync(probe, BUILD_B);
  check(currentGitHead(root) === head && currentMaterialHash(root, 'HEAD', root) === materialHash
    && currentStoryFilesHash(root, 'HEAD', root) === storyFilesHash, 'dist change must leave every committed-tree digest identical');
  const reuseAfter = reuse();
  expectRepaired(reuseAfter.reusable === false, 'reuse: PASS recorded against build A was reused after dist changed to build B');
  if (!reuseAfter.reusable) {
    check(reuseAfter.refusalReasons.includes('build-artifacts-hash-changed-or-missing'), `reuse refusal must name the build binding (got ${reuseAfter.refusalReasons.join(',')})`);
    check(reuseAfter.refusalReasons.every((reason) => reason === 'build-artifacts-hash-changed-or-missing'), `only the build binding may refuse here (got ${reuseAfter.refusalReasons.join(',')})`);
  }
  const admitAfter = admissibility();
  expectRepaired(admitAfter.ok === false, 'admissibility: PASS recorded against build A was admitted after dist changed to build B');
  if (!admitAfter.ok) {
    check(admitAfter.reasonCodes.includes('build_artifacts_mismatch'), `admissibility refusal must name the build binding (got ${admitAfter.reasonCodes.join(',')})`);
    check(admitAfter.reasonCodes.every((code) => code === 'build_artifacts_mismatch'), `only the build binding may refuse here (got ${admitAfter.reasonCodes.join(',')})`);
  }

  // The binding keys on content, not on time: restoring build A admits again.
  writeFileSync(probe, BUILD_A);
  check(reuse().reusable === true, 'restoring build A must make the recorded PASS reusable again');
  check(admissibility().ok === true, 'restoring build A must make the recorded PASS admissible again');

  // A missing artifact tree is not the recorded one either.
  rmSync(join(root, 'packages/main/dist'), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  expectRepaired(reuse().reusable === false, 'reuse: PASS recorded against build A was reused after packages/main/dist disappeared');
  expectRepaired(admissibility().ok === false, 'admissibility: PASS recorded against build A was admitted after packages/main/dist disappeared');

  // Source-text guard (not runtime proof): the canonical terminal event must carry the binding so
  // two executions against different builds are no longer recorded as the same material.
  const verifier = readFileSync(join(repoRoot, 'packages/main/src/handlers/verifier.ts'), 'utf8');
  const start = verifier.indexOf('function recordValidationTerminal(');
  const end = verifier.indexOf('\n}\n', start);
  check(start >= 0 && end > start, 'verifier.ts must define recordValidationTerminal');
  expectRepaired(verifier.slice(start, end).includes('buildArtifactsHash'), 'validation_terminal event does not record buildArtifactsHash (source-text guard)');
} finally {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

if (red.length > 0) {
  for (const failure of red) console.error(`  - ${failure}`);
  console.error(`RED: ${MARKER} (${red.length} failing expectation${red.length === 1 ? '' : 's'}, ${checks} controls passed)`);
  process.exit(1);
}
console.log(`verify-validation-build-artifact-binding: ${checks} checks passed`);
