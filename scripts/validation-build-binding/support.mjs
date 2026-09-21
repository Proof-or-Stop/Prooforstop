import ".././lab-source-loader.mjs";
import { registerHooks, createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, lstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const ts = createRequire(import.meta.url)('typescript');

registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
    source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, esModuleInterop: true,
    }, fileName: fileURLToPath(url) }).outputText };
  return nextLoad(url, context);
} });

export const { evaluateRoutineValidationReuse, buildRoutineValidationIdentity } = await import("../../packages/main/src/core/validation-evidence-reuse.ts");

export const { evaluateValidationEvidenceAdmissibility } = await import("../../packages/main/src/core/validation-evidence-admissibility.ts");

export const { currentGitHead, currentMaterialHash, currentStoryFilesHash } = await import("../../packages/main/src/core/evidence-freshness.ts");

export const { runDoneRequiredValidation, evaluateDoneRequiredEvidence, validateReceiptBuildBinding, doneRequiredProtectionRefusal, validateSelfHostBuildProof } = await import("../../packages/main/src/core/done-required-validation.ts");

export const { executeValidationPlan, runValidationCommand, evaluatePlanBuildArtifactsBinding: executorRules } = await import("../../packages/main/src/core/validation-executor.ts");

export const { probeValidationCausalPreflightFacts, launchDirectoryMismatch, freezeLaunchBindings, isLaunchDirectoryDriftError } = await import("../../packages/main/src/handlers/verifier.ts");

export const { acquireOwnerLease } = await import("../../packages/main/src/core/story-owner-lease.ts");

export const { StoryStore } = await import("../../packages/main/src/core/store.ts");

export const { resetConfigCache } = await import("../../packages/main/src/core/config.ts");

export const { persistSyntheticAdmittedWindowForTest } = await import("../../packages/main/src/core/certification-window.ts");

export const { deriveCertificationDomainInputHashes } = await import("../../packages/main/src/handlers/certification-window.ts");

export const identityModule = await import("../../packages/main/src/core/build-artifacts-identity.ts").catch(() => null);

export const protectionModule = await import("../../packages/main/src/core/build-artifacts-protection.ts").catch(() => null);

export const binding = identityModule ? { ...identityModule, ...(protectionModule ?? {}) } : null;

export const MARKER = 'stale build artifacts admitted as fresh validation evidence';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

export const sandbox = mkdtempSync(join(tmpdir(), 'pos-build-binding-'));

process.on('exit', () => { try { rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* best effort at exit */ } });

export const red = [];

export let checks = 0;

export let hostEnforced = false;

export function check(value, message) { assert(value, message); checks++; }

export function expectRepaired(value, message) { if (value) checks++; else red.push(message); }

export function git(root, args) { return execFileSync(realGit, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }

export function spawnWrapped(launch, options = {}) {
  if (!launch.confidential) return spawnSync(launch.command, launch.args, { encoding: 'utf8', env: launch.env, timeout: 20_000, ...options });
  // Exclusive creation, owner-only: the payload carries the launch environment.
  const file = join(sandbox, `confidential-${process.pid}-${Math.random().toString(16).slice(2)}`); writeFileSync(file, launch.confidential.payload, { mode: 0o600, flag: 'wx' });
  if ((lstatSync(file).mode & 0o777) !== 0o600) throw new Error(`confidential payload file is not owner-only (${(lstatSync(file).mode & 0o777).toString(8)})`);
  const fd = openSync(file, 'r');
  const stdio = ['ignore', 'pipe', 'pipe']; while (stdio.length < launch.confidential.fd) stdio.push('ignore'); stdio[launch.confidential.fd] = fd;
  try { return spawnSync(launch.command, launch.args, { encoding: 'utf8', env: launch.env, timeout: 20_000, ...options, stdio }); } finally { closeSync(fd); rmSync(file, { force: true }); }
}

export function rmTree(path) { rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }

export const BUILD_A = 'process.exit(0); // compiled from probe.ts, build A\n';

export const BUILD_B = 'process.exit(1); // compiled from probe.ts, build B: same source binding, different code\n';

export function routineFixture() {
  const root = join(sandbox, 'routine'); mkdirSync(root);
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
  return { root, probe: join(mainDist, 'probe-smoke.js'), mainDist };
}

export function setHostEnforced(value) { hostEnforced = value; }
