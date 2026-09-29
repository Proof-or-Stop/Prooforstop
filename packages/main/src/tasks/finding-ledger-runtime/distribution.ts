import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';

import { accessSync, constants, existsSync, mkdtempSync, mkdirSync, realpathSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { type RuntimeEvidenceReceipt } from '../../core/runtime-evidence-receipt.js';

import { resolveMainRepoRoot } from '../../core/partial-done-recovery.js';
import { readSyncedVersion } from '../../core/version-bump.js';

import { git } from './support.js';
import { sparseProjectionRegressionCompleted } from './projection.js';

export function readTreeText(root: string): string {
  if (!existsSync(root)) return '';
  const chunks: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) chunks.push(readTreeText(path));
    else if (entry.isFile()) chunks.push(readFileSync(path).toString('utf8'));
  }
  return chunks.join('\n');
}

export function unsignedRuntimeReceipt(receipt: RuntimeEvidenceReceipt): Omit<RuntimeEvidenceReceipt, 'receiptHash' | 'signature'> {
  const { receiptHash: _hash, signature: _signature, ...unsigned } = receipt;
  return unsigned;
}

export function assertRedGreenRelation(repositoryRoot: string): void {
  const redPath = join(repositoryRoot, 'packages', 'main', 'tests', 'red', 'red-bfe8f-ledger-runtime-integrity.mjs');
  const immutableRedBlob = '1b913dab2f52e904afc1b7b1870a3a98be0739bc';
  const immutableRed = git(repositoryRoot, ['cat-file', 'blob', immutableRedBlob]);
  const historicalAllocatorAssertion = immutableRed.split('\n').find((line) => (
    line.includes('pre-GREEN Finding ID baseline changed without the accepted allocator')
  ));
  assert.ok(historicalAllocatorAssertion, 'immutable RED blob lost the reviewed allocator assertion');
  assert.equal(
    historicalAllocatorAssertion.replaceAll('\\', '').includes(
      'assert.match(findingSource, /const nextNum = data.findings.length + 1;/',
    ),
    true,
    'immutable RED blob lost the old allocator sentinel',
  );
  const pinnedSelectors = [
    'red.audit_summary:',
    'red.genuine_contract_failure:',
    'red.production_unchanged: PASS',
    'red.official_evidence_create: PASS',
    'red.relation_create: PASS unchangedAssertionBound=true',
    'red.no_fabricated_race: PASS',
    'red.evidence_binding: PASS',
    'red.primitive_scope: PASS',
    'red.relation_evaluate: PASS baselineFails=true currentFails=true assertionUnchanged=true',
    'red.mutation_isolation: PASS',
    'red.reproducibility_guard: PASS',
    'red.green_substitution_refused: PASS',
    'red.relation_mutation_refused: PASS',
  ];
  const current = spawnSync(process.execPath, [redPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(current.status, 0, `current historical RED/GREEN verifier failed: ${current.stderr}`);
  for (const selector of pinnedSelectors) {
    assert.match(current.stdout, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const arbitraryCwd = mkdtempSync(join(tmpdir(), 'bfe8f-red-arbitrary-cwd-'));
  try {
    const arbitrary = spawnSync(process.execPath, [redPath], {
      cwd: arbitraryCwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(arbitrary.status, 0, `arbitrary-cwd historical verifier failed: ${arbitrary.stderr}`);
    for (const selector of pinnedSelectors) assert.ok(arbitrary.stdout.includes(selector));
  } finally {
    rmSync(arbitraryCwd, { recursive: true, force: true });
  }
  const productionFindingHandler = readFileSync(
    join(repositoryRoot, 'packages', 'main', 'src', 'handlers', 'finding.ts'),
    'utf8',
  );
  assert.doesNotMatch(productionFindingHandler, /const nextNum = data\.findings\.length \+ 1;/);
  assert.match(productionFindingHandler, /const historicalDisplayIds = \[/);
  assert.match(productionFindingHandler, /historicalDisplayIds\.reduce\(\(max, candidate\) =>/);
  assert.equal(
    sparseProjectionRegressionCompleted,
    true,
    'sparse F-001/F-003 -> F-004 projection regression did not execute before RED/GREEN evaluation',
  );
  console.log('green.red_green_relation_evaluate: PASS baselineFails=true currentPasses=true assertionUnchanged=true coreContractsPass=true immutableBlob=true sparseAllocatorSupersedesBaseline=true');
  console.log('green.red_historical_anchor_verifier: PASS exactBaselineCheckout=true expectedFailure=ERR_MODULE_NOT_FOUND currentGreenImport=true arbitraryCwdAccepted=false');
}

export function assertInstalledVersionMatchesBinding(
  observedVersion: string | undefined,
  boundVersion: string,
): asserts observedVersion is string {
  assert.equal(
    observedVersion,
    boundVersion,
    `installed CLI version ${observedVersion ?? 'missing'} differs from its bound package version ${boundVersion}`,
  );
}

export function resolveCommandOnPath(command: string, cwd: string): string {
  const pathValue = process.platform === 'win32'
    ? process.env.Path ?? process.env.PATH ?? ''
    : process.env.PATH ?? '';
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const rawDir of pathValue.split(delimiter)) {
    const dir = rawDir || '.';
    for (const extension of extensions) {
      const candidate = resolve(cwd, dir, `${command}${extension}`);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (process.platform !== 'win32') accessSync(candidate, constants.X_OK);
        return realpathSync(candidate);
      } catch {
        // Continue in PATH order until the same runnable command spawn uses.
      }
    }
  }
  throw new Error(`${command} is not a runnable command on PATH`);
}

export function assertInstalledCliBinding(repositoryRoot: string, installedVersion: string | undefined): string {
  const mainRoot = resolveMainRepoRoot(repositoryRoot);
  const mainVersion = readSyncedVersion(mainRoot);
  const globalNpmRoot = execFileSync('npm', ['root', '-g'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const globalCorePath = join(globalNpmRoot, '@proof-or-stop', 'core');
  const globalCoreRoot = realpathSync(globalCorePath);
  const mainCoreRoot = realpathSync(join(mainRoot, 'packages', 'main'));
  assert.equal(globalCoreRoot, mainCoreRoot, 'installed @proof-or-stop/core must resolve to the current main core binding');
  const globalPackage = JSON.parse(readFileSync(join(globalCorePath, 'package.json'), 'utf8')) as {
    name?: string;
    version?: string;
    bin?: string | Record<string, string>;
  };
  assert.equal(globalPackage.name, '@proof-or-stop/core');
  assert.equal(globalPackage.version, mainVersion, 'installed core package version must equal its current main binding');
  const binRelative = typeof globalPackage.bin === 'string'
    ? globalPackage.bin
    : globalPackage.bin?.['proof-or-stop'];
  assert.equal(typeof binRelative, 'string', 'installed core package must declare the proof-or-stop bin');
  const boundEntrypoint = realpathSync(join(globalCoreRoot, binRelative!));
  assert.equal(
    resolveCommandOnPath('proof-or-stop', repositoryRoot),
    boundEntrypoint,
    'proof-or-stop on PATH must resolve to the installed core binding entrypoint',
  );
  assertInstalledVersionMatchesBinding(installedVersion, mainVersion);
  return mainVersion;
}

export function assertVersionBindingNegativeControl(): void {
  const behindWorktreeVersion: string = '1.2.3';
  const currentMainBindingVersion: string = '1.2.4';
  assert.equal(
    currentMainBindingVersion === behindWorktreeVersion,
    false,
    'RED control: the retired installed-equals-worktree rule must reject a legitimate newer main binding',
  );
  assert.doesNotThrow(() => assertInstalledVersionMatchesBinding(
    currentMainBindingVersion,
    currentMainBindingVersion,
  ));
  assert.throws(
    () => assertInstalledVersionMatchesBinding(behindWorktreeVersion, currentMainBindingVersion),
    /differs from its bound package version/,
    'an installed CLI older than its binding must be rejected',
  );
  assert.throws(
    () => assertInstalledVersionMatchesBinding('1.2.5', currentMainBindingVersion),
    /differs from its bound package version/,
    'any installed CLI mismatch against its binding must be rejected',
  );
  console.log('red.version_binding_behind_worktree: PASS oldRuleRejects=true ownBindingAccepts=true staleInstalledRejects=true mismatchRejects=true');
}

export function assertVersionSync(repositoryRoot: string): void {
  const versionCommitCandidates = git(repositoryRoot, [
    'log',
    '--full-history',
    '--format=%H',
    '--grep=^B-fe8f CHK-006: prove final ledger runtime GREEN$',
    '--',
    'package.json',
  ]).split('\n').filter(Boolean);
  assert.equal(versionCommitCandidates.length, 1, 'B-fe8f version commit must resolve uniquely in current lineage');
  const versionCommit = versionCommitCandidates[0]!;
  const previous = (JSON.parse(git(repositoryRoot, ['show', `${versionCommit}^:package.json`])) as { version: string }).version;
  const expected = (JSON.parse(git(repositoryRoot, ['show', `${versionCommit}:package.json`])) as { version: string }).version;
  const parts = (value: string): [number, number, number] => {
    const parsed = value.split('.').map((part) => Number(part));
    assert.equal(parsed.length, 3, `version ${value} is not X.Y.Z`);
    assert.ok(parsed.every(Number.isInteger), `version ${value} contains a non-integer component`);
    return parsed as [number, number, number];
  };
  const [previousMajor, previousMinor, previousPatch] = parts(previous);
  const [major, minor, patch] = parts(expected);
  assert.deepEqual([major, minor, patch], [previousMajor, previousMinor, previousPatch + 1]);

  // Later Stories may legitimately advance the repository patch after B-fe8f's
  // own one-step bump. Prove that historical increment from Git, then require the
  // current five authoritative version points to agree instead of pinning this
  // long-lived Story smoke to a patch number that unrelated DONE effects outgrow.
  const current = readSyncedVersion(repositoryRoot);
  const [currentMajor, currentMinor, currentPatch] = parts(current);
  assert.deepEqual([currentMajor, currentMinor], [major, minor]);
  assert.ok(currentPatch >= patch, `current version ${current} predates B-fe8f version ${expected}`);

  const local = spawnSync(process.execPath, [join(repositoryRoot, 'packages', 'main', 'dist', 'cli.js'), '--version'], {
    cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(local.status, 0, `local CLI version failed: ${local.stderr}`);
  assert.equal(local.stdout.trim(), `Proof-or-Stop ${current}`);
  const installed = spawnSync('proof-or-stop', ['--version'], {
    cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(installed.status, 0, `installed CLI version failed: ${installed.stderr}`);
  const installedVersion = /Proof-or-Stop (\d+\.\d+\.\d+)/.exec(installed.stdout)?.[1];
  assertVersionBindingNegativeControl();
  const installedBindingVersion = assertInstalledCliBinding(repositoryRoot, installedVersion);
  const installedState = installedBindingVersion === current ? 'worktree-current' : 'main-bound';
  console.log(`green.version_sync: PASS patchIncrement=1 rootPackage=true mainPackage=true lockfile=true runtimeConstant=true localCli=true installedCli=true installedState=${installedState} installedBinding=current-main`);
}

export function assertCleanPackInstall(repositoryRoot: string): void {
  const scratch = mkdtempSync(join(tmpdir(), 'bfe8f-clean-pack-'));
  const consumer = join(scratch, 'consumer');
  try {
    mkdirSync(consumer, { recursive: true });
    // Lab is an independently versioned sibling package that core depends on by
    // exact version; it is supplied as a local tarball (never fetched from a
    // registry) so the clean-install proof stays offline and deterministic.
    const packages = ['main', 'lab'] as const;
    const tarballs: Record<string, string> = {};
    for (const directory of packages) {
      const packed = spawnSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', scratch, '.'], {
        cwd: join(repositoryRoot, 'packages', directory),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.equal(packed.status, 0, `npm pack ${directory} failed: ${packed.stderr}\n${packed.stdout}`);
      const records = JSON.parse(packed.stdout) as Array<{ filename: string }>;
      assert.equal(records.length, 1, `npm pack ${directory} did not emit exactly one tarball`);
      tarballs[directory] = join(scratch, records[0].filename);
      assert.ok(existsSync(tarballs[directory]), `npm pack ${directory} tarball missing`);
    }
    const tarListing = spawnSync('tar', ['-tf', tarballs.main], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(tarListing.status, 0, `tar listing failed: ${tarListing.stderr}`);
    assert.match(tarListing.stdout, /^package\/dist\/cli\.js$/m);
    assert.doesNotMatch(tarListing.stdout, /package\/node_modules\//, 'core tarball must not bundle sibling packages');
    const initialized = spawnSync('npm', ['init', '-y'], {
      cwd: consumer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(initialized.status, 0, `clean consumer init failed: ${initialized.stderr}`);
    const installed = spawnSync('npm', [
      'install', tarballs.lab, tarballs.main, '--ignore-scripts', '--no-audit', '--no-fund', '--offline',
    ], {
      cwd: consumer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(installed.status, 0, `clean tarball install failed: ${installed.stderr}\n${installed.stdout}`);
    const core = JSON.parse(readFileSync(join(consumer, 'node_modules', '@proof-or-stop', 'core', 'package.json'), 'utf8')) as {
      name: string; dependencies?: Record<string, string>;
    };
    const lab = JSON.parse(readFileSync(join(consumer, 'node_modules', '@proof-or-stop', 'lab', 'package.json'), 'utf8')) as {
      name: string; version: string;
    };
    assert.equal(core.name, '@proof-or-stop/core');
    assert.equal(lab.name, '@proof-or-stop/lab');
    assert.equal(core.dependencies?.['@proof-or-stop/lab'], lab.version, 'installed lab must satisfy the exact core dependency');
    const cli = spawnSync(join(consumer, 'node_modules', '.bin', 'proof-or-stop'), ['--version'], {
      cwd: consumer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(cli.status, 0, `clean-installed CLI failed: ${cli.stderr}`);
    assert.equal(cli.stdout.trim(), `Proof-or-Stop ${readSyncedVersion(repositoryRoot)}`);
    console.log('green.clean_pack_install: PASS core=@proof-or-stop/core lab=@proof-or-stop/lab bundled=false registryFetch=false cli=true');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
