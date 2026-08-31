#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import {
  existsSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..');
const RETIRED_PRODUCT = ['lat', 'tice'].join('');
const RETIRED_SCOPE = `@${RETIRED_PRODUCT}`;
const EXPECTED_EXTENSION_VERSION = '0.3.65';
const EXPECTED_CORE_PEER_RANGE = '^0.3.65';
const CANONICAL_ROLES = Object.freeze([
  'proof-or-stop-evaluator',
  'proof-or-stop-evaluator-cli',
  'proof-or-stop-implementer',
  'proof-or-stop-review-behavior',
  'proof-or-stop-review-channel',
  'proof-or-stop-review-concept',
  'proof-or-stop-review-delivery',
  'proof-or-stop-review-docs',
  'proof-or-stop-review-quality',
  'proof-or-stop-review-scope-plan',
  'proof-or-stop-review-story-init',
  'proof-or-stop-review-test-coverage',
  'proof-or-stop-review-topology-critic',
]);
const RETIRED_ROLES = Object.freeze(CANONICAL_ROLES.map((role) => role.replace('proof-or-stop', RETIRED_PRODUCT)));
const PACKAGE_ROWS = Object.freeze([
  { id: 'root', directory: '.', name: 'proof-or-stop' },
  { id: 'core', directory: 'packages/main', name: '@proof-or-stop/core' },
  { id: 'lab', directory: 'packages/lab', name: '@proof-or-stop/lab' },
  { id: 'utils', directory: 'packages/utils', name: '@proof-or-stop/utils' },
]);

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function sortedObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function manifestProjection(manifest) {
  return {
    name: manifest.name,
    version: manifest.version,
    bin: sortedObject(manifest.bin),
    dependencies: sortedObject(manifest.dependencies),
    optionalDependencies: sortedObject(manifest.optionalDependencies),
    peerDependencies: sortedObject(manifest.peerDependencies),
  };
}

function internalRangeSatisfied(version, range) {
  if (range === version) return true;
  const versionMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const caretMatch = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!versionMatch || !caretMatch) return false;
  const [, versionMajor, versionMinor, versionPatch] = versionMatch.map(Number);
  const [, rangeMajor, rangeMinor, rangePatch] = caretMatch.map(Number);
  if (rangeMajor !== 0) {
    return versionMajor === rangeMajor
      && (versionMinor > rangeMinor || (versionMinor === rangeMinor && versionPatch >= rangePatch));
  }
  return versionMajor === 0 && versionMinor === rangeMinor && versionPatch >= rangePatch;
}

function collectLegacyIdentityPaths(value, path = '$', output = []) {
  if (typeof value === 'string') {
    if (value.includes(`${RETIRED_SCOPE}/`) || value.startsWith('file:')) output.push(path);
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  for (const [key, child] of Object.entries(value)) {
    if (key.includes(`${RETIRED_SCOPE}/`)) output.push(`${path}.${key}`);
    collectLegacyIdentityPaths(child, `${path}.${key}`, output);
  }
  return output;
}

function validateManifestCohort(manifests) {
  const errors = [];
  const byName = new Map(Object.values(manifests).map((manifest) => [manifest.name, manifest]));
  const root = manifests.root;
  const core = manifests.core;
  const lab = manifests.lab;
  const utils = manifests.utils;

  for (const row of PACKAGE_ROWS) {
    if (manifests[row.id]?.name !== row.name) errors.push(`${row.id} name is not ${row.name}`);
  }
  if (root.version !== core.version) errors.push('root and core versions differ');
  if (lab.version !== EXPECTED_EXTENSION_VERSION) errors.push('Lab independent version changed');
  if (utils.version !== EXPECTED_EXTENSION_VERSION) errors.push('Utils independent version changed');
  if (core.dependencies?.['@proof-or-stop/lab'] !== lab.version) errors.push('core does not depend on the supplied Lab tarball version');
  if (lab.peerDependencies?.['@proof-or-stop/core'] !== EXPECTED_CORE_PEER_RANGE) errors.push('Lab core peer range drifted');
  if (utils.peerDependencies?.['@proof-or-stop/core'] !== EXPECTED_CORE_PEER_RANGE) errors.push('Utils core peer range drifted');
  if (lab.dependencies?.['@proof-or-stop/core']) errors.push('Lab pins core as a regular dependency');
  if (utils.dependencies?.['@proof-or-stop/core']) errors.push('Utils pins core as a regular dependency');

  const productBins = [];
  for (const [id, manifest] of Object.entries(manifests)) {
    for (const binName of Object.keys(manifest.bin || {})) productBins.push(`${id}:${binName}`);
    const legacyPaths = collectLegacyIdentityPaths(manifest);
    if (legacyPaths.length > 0) errors.push(`${id} contains retired package or file dependency at ${legacyPaths.join(', ')}`);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [dependencyName, range] of Object.entries(manifest[field] || {})) {
        if (!dependencyName.startsWith('@proof-or-stop/')) continue;
        const supplied = byName.get(dependencyName);
        if (!supplied) errors.push(`${id} ${field} requires unsupplied internal package ${dependencyName}`);
        else if (!internalRangeSatisfied(supplied.version, range)) {
          errors.push(`${id} ${field} range ${dependencyName}@${range} rejects supplied ${supplied.version}`);
        }
      }
    }
  }
  if (!isDeepStrictEqual(productBins.sort(), ['core:proof-or-stop'])) {
    errors.push(`product bin set is ${productBins.sort().join(', ') || '(empty)'}`);
  }
  return errors;
}

function sourceManifests() {
  return Object.fromEntries(PACKAGE_ROWS.map((row) => [
    row.id,
    readJson(join(ROOT, row.directory, 'package.json')),
  ]));
}

function verifyLocks(manifests) {
  const sourceByName = new Map(Object.values(manifests).map((manifest) => [manifest.name, manifest]));
  for (const row of PACKAGE_ROWS) {
    const lock = readJson(join(ROOT, row.directory, 'package-lock.json'));
    const lockRoot = lock.packages?.[''];
    assert(lockRoot, `${row.id} lockfile has no root package record`);
    const expected = manifestProjection(manifests[row.id]);
    const actual = manifestProjection(lockRoot);
    assert(isDeepStrictEqual(actual, expected), `${row.id} package-lock root record differs from package.json`);
    for (const [lockPath, lockPackage] of Object.entries(lock.packages || {})) {
      if (lockPath === '' || !lockPackage?.name) continue;
      const source = sourceByName.get(lockPackage.name);
      if (!source) continue;
      assert(
        isDeepStrictEqual(manifestProjection(lockPackage), manifestProjection(source)),
        `${row.id} package-lock internal record ${lockPath} differs from ${lockPackage.name} package.json`,
      );
    }
  }
}

function packOne(row, tarballDir) {
  const stdout = execFileSync('npm', [
    'pack', '--json', '--ignore-scripts', '--pack-destination', tarballDir, '.',
  ], {
    cwd: join(ROOT, row.directory),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const records = JSON.parse(stdout);
  assert(Array.isArray(records) && records.length === 1, `${row.id} npm pack did not return exactly one artifact`);
  const record = records[0];
  const tarball = join(tarballDir, record.filename);
  assert(existsSync(tarball), `${row.id} tarball is missing after npm pack`);
  const packedManifest = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  return { row, record, tarball, manifest: packedManifest };
}

function resolveInstalledPackageDir(packageName, fromDir) {
  let cursor = realpathSync(fromDir);
  const segments = packageName.split('/');
  while (true) {
    const candidate = join(cursor, 'node_modules', ...segments);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  fail(`installed dependency ${packageName} is unavailable from ${fromDir}`);
}

function prepareOfflineDependencyOverrides(manifests, tempRoot) {
  const packDir = join(tempRoot, 'offline-dependencies');
  const stageRoot = join(tempRoot, 'offline-dependency-staging');
  mkdirSync(packDir, { recursive: true });
  mkdirSync(stageRoot, { recursive: true });
  const seedRequests = [];
  for (const manifest of Object.values(manifests)) {
    for (const [name, range] of Object.entries(manifest.dependencies || {})) {
      if (!name.startsWith('@proof-or-stop/')) seedRequests.push({ name, range, fromDir: ROOT });
    }
  }

  const packages = new Map();
  function visit(request) {
    let packageDir;
    try {
      packageDir = resolveInstalledPackageDir(request.name, request.fromDir);
    } catch (error) {
      if (request.optional) return null;
      throw error;
    }
    const manifest = readJson(join(packageDir, 'package.json'));
    const key = `${manifest.name}@${manifest.version}`;
    if (packages.has(key)) return key;
    const node = { key, packageDir, manifest, edges: new Map() };
    packages.set(key, node);
    for (const [name, range] of Object.entries(manifest.dependencies || {})) {
      const childKey = visit({ name, range, fromDir: packageDir });
      if (childKey) node.edges.set(name, childKey);
    }
    for (const [name, range] of Object.entries(manifest.peerDependencies || {})) {
      if (manifest.peerDependenciesMeta?.[name]?.optional) continue;
      const childKey = visit({ name, range, fromDir: packageDir });
      if (childKey) node.edges.set(name, childKey);
    }
    return key;
  }

  const seedKeys = new Map();
  for (const request of seedRequests) {
    const key = visit(request);
    const previous = seedKeys.get(request.name);
    assert(!previous || previous === key, `product manifests require multiple offline versions of ${request.name}`);
    seedKeys.set(request.name, key);
  }

  function expectedTarballPath(node) {
    const stem = node.manifest.name.replace(/^@/, '').replaceAll('/', '-');
    return join(packDir, `${stem}-${node.manifest.version}.tgz`);
  }

  const overrides = {};
  const summary = [];
  for (const node of [...packages.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const { packageDir, manifest } = node;
    const stageDir = join(stageRoot, Buffer.from(node.key).toString('hex'));
    cpSync(packageDir, stageDir, {
      recursive: true,
      filter: (source) => source === packageDir
        || !relative(packageDir, source).split(sep).includes('node_modules'),
    });
    const stagedManifest = readJson(join(stageDir, 'package.json'));
    stagedManifest.dependencies = Object.fromEntries([...node.edges.entries()].map(([name, childKey]) => [
      name,
      `file:${expectedTarballPath(packages.get(childKey))}`,
    ]));
    delete stagedManifest.optionalDependencies;
    delete stagedManifest.peerDependencies;
    delete stagedManifest.peerDependenciesMeta;
    delete stagedManifest.devDependencies;
    delete stagedManifest.bundleDependencies;
    delete stagedManifest.bundledDependencies;
    writeFileSync(join(stageDir, 'package.json'), `${JSON.stringify(stagedManifest, null, 2)}\n`);
    const stdout = execFileSync('npm', [
      'pack', '--json', '--ignore-scripts', '--pack-destination', packDir, '.',
    ], {
      cwd: stageDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const records = JSON.parse(stdout);
    assert(Array.isArray(records) && records.length === 1, `offline dependency ${manifest.name} did not pack exactly once`);
    const tarball = join(packDir, records[0].filename);
    assert(tarball === expectedTarballPath(node), `offline dependency tarball filename drifted for ${node.key}`);
    summary.push({ name: manifest.name, version: manifest.version });
  }
  for (const [name, key] of seedKeys) overrides[name] = `file:${expectedTarballPath(packages.get(key))}`;
  return { overrides, summary };
}

function verifyPackedArtifacts(packed, sources) {
  for (const artifact of packed) {
    const source = sources[artifact.row.id];
    assert(
      isDeepStrictEqual(manifestProjection(artifact.manifest), manifestProjection(source)),
      `${artifact.row.id} packed manifest differs from source manifest`,
    );
    const filePaths = new Set((artifact.record.files || []).map((entry) => entry.path));
    assert(filePaths.has('package.json'), `${artifact.row.id} tarball lacks package.json`);
    if (artifact.row.id === 'core') {
      assert(filePaths.has('dist/cli.js'), 'core tarball lacks built dist/cli.js');
      for (const role of CANONICAL_ROLES) {
        assert(filePaths.has(`templates/agents/${role}.md`), `core tarball lacks canonical role asset ${role}`);
      }
      for (const role of RETIRED_ROLES) {
        assert(!filePaths.has(`templates/agents/${role}.md`), `core tarball contains retired role asset ${role}`);
      }
    }
    if (artifact.row.id === 'lab' || artifact.row.id === 'utils') {
      assert(filePaths.has('dist/index.js'), `${artifact.row.id} tarball lacks built dist/index.js`);
      assert(filePaths.has('dist/register.js'), `${artifact.row.id} tarball lacks built dist/register.js`);
    }
  }
}

function runInstalledNode(projectDir, source, allowFailure = false) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: projectDir,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  if (!allowFailure && result.status !== 0) {
    fail(`installed Node probe failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result;
}

function runInstalledCli(cli, projectDir, args, allowFailure = false) {
  const result = spawnSync(cli, args, {
    cwd: projectDir,
    encoding: 'utf8',
    env: { ...process.env, PROOF_OR_STOP_BRIEF_OUTPUT: '1' },
  });
  if (!allowFailure && result.status !== 0) {
    fail(`installed CLI probe failed (${args.join(' ')}): ${result.stderr || result.stdout}`);
  }
  return result;
}

function stablePackageSummary(artifact) {
  return {
    id: artifact.row.id,
    name: artifact.manifest.name,
    version: artifact.manifest.version,
    filename: artifact.record.filename,
    integrity: artifact.record.integrity,
    shasum: artifact.record.shasum,
  };
}

function runBoundary() {
  const sources = sourceManifests();
  const manifestErrors = validateManifestCohort(sources);
  assert(manifestErrors.length === 0, `source package graph is not closed:\n- ${manifestErrors.join('\n- ')}`);
  verifyLocks(sources);

  const tempRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-pack-boundary-'));
  const tarballDir = join(tempRoot, 'tarballs');
  const projectDir = join(tempRoot, 'consumer');
  mkdirSync(tarballDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  try {
    const packed = PACKAGE_ROWS.map((row) => packOne(row, tarballDir));
    verifyPackedArtifacts(packed, sources);

    const offlineDependencies = prepareOfflineDependencyOverrides(sources, tempRoot);

    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({
      name: 'proof-or-stop-pack-boundary-consumer',
      version: '1.0.0',
      private: true,
      type: 'module',
      overrides: offlineDependencies.overrides,
    }, null, 2));

    const installArgs = [
      'install',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--omit=optional',
      '--package-lock=false',
      '--install-strategy=nested',
      ...packed.map((artifact) => artifact.tarball),
    ];
    execFileSync('npm', installArgs, {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NPM_CONFIG_OFFLINE: 'true',
        NPM_CONFIG_FETCH_RETRIES: '0',
        NPM_CONFIG_AUDIT: 'false',
        NPM_CONFIG_FUND: 'false',
        NPM_CONFIG_UPDATE_NOTIFIER: 'false',
        HTTP_PROXY: 'http://127.0.0.1:9/',
        HTTPS_PROXY: 'http://127.0.0.1:9/',
      },
    });

    const binDir = join(projectDir, 'node_modules', '.bin');
    const installedBins = readdirSync(binDir).filter((name) => !name.startsWith('.')).sort();
    assert(isDeepStrictEqual(installedBins, ['proof-or-stop']), `installed top-level bins are ${installedBins.join(', ')}`);
    const cli = join(binDir, 'proof-or-stop');
    const versionProbe = runInstalledCli(cli, projectDir, ['--version']);
    assert(versionProbe.stdout.trim() === `Proof-or-Stop ${sources.core.version}`, `installed CLI version is not ${sources.core.version}`);
    const helpProbe = runInstalledCli(cli, projectDir, ['help']);
    assert(helpProbe.stdout.includes('proof-or-stop'), 'installed CLI help does not identify the canonical command');
    const labHelpProbe = runInstalledCli(cli, projectDir, ['lab_create', '--help']);
    assert(labHelpProbe.stdout.includes('proof-or-stop lab_create'), 'installed core cannot load the supplied Lab tarball');

    const retiredBin = spawnSync('/bin/sh', ['-c', `${RETIRED_PRODUCT} --version`], {
      cwd: projectDir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin` },
    });
    assert(retiredBin.status === 127, `retired command returned ${retiredBin.status}, expected 127`);

    const canonicalPackages = PACKAGE_ROWS.filter((row) => row.name.startsWith('@proof-or-stop/')).map((row) => row.name);
    for (const packageName of canonicalPackages) {
      const result = runInstalledNode(projectDir, `console.log(import.meta.resolve(${JSON.stringify(packageName)}))`);
      assert(result.stdout.includes('node_modules'), `canonical package ${packageName} did not resolve from the clean install`);
    }
    for (const suffix of ['core', 'lab', 'utils']) {
      const packageName = `${RETIRED_SCOPE}/${suffix}`;
      const result = runInstalledNode(projectDir, `console.log(import.meta.resolve(${JSON.stringify(packageName)}))`, true);
      assert(result.status !== 0, `retired package ${packageName} unexpectedly resolved`);
    }

    for (const role of CANONICAL_ROLES) {
      const result = runInstalledCli(cli, projectDir, ['agent_prompt', `--role=${role}`]);
      assert(result.stdout.includes(`name: ${role}`), `canonical role lookup did not render ${role}`);
    }
    for (const role of RETIRED_ROLES) {
      const result = runInstalledCli(cli, projectDir, ['agent_prompt', `--role=${role}`], true);
      assert(result.status !== 0, `retired role lookup unexpectedly accepted ${role}`);
      assert(`${result.stdout}${result.stderr}`.includes('unknown role'), `retired role ${role} failed for an unrelated reason`);
    }

    const tree = execFileSync('npm', ['ls', '--all', '--json', '--offline'], {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NPM_CONFIG_OFFLINE: 'true' },
    });
    assert(!tree.includes(`${RETIRED_SCOPE}/`), 'installed dependency tree contains a retired package scope');

    return {
      schemaVersion: 'proof-or-stop.pack-boundary.v1',
      networkPolicy: 'npm-offline-with-unreachable-http-and-https-proxies',
      installInput: 'exactly-four-product-tarballs',
      offlineDependencySource: 'source-resolved-runtime-dependency-tarballs-via-overrides',
      offlineDependencyPackages: offlineDependencies.summary,
      packages: packed.map(stablePackageSummary),
      assertions: {
        sourceLockPackConsistent: true,
        internalDependencyGraphClosed: true,
        installedTopLevelBins: installedBins,
        retiredCommandExitCode: retiredBin.status,
        canonicalPackageResolutions: canonicalPackages.length,
        retiredPackageResolutionFailures: 3,
        canonicalRoleLookups: CANONICAL_ROLES.length,
        retiredRoleLookupFailures: RETIRED_ROLES.length,
        installedDependencyTreeHasRetiredScope: false,
      },
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runSelfTest() {
  const sources = sourceManifests();
  assert(validateManifestCohort(sources).length === 0, 'real source manifests must satisfy the pack graph before mutation tests');

  const exactPin = structuredClone(sources);
  exactPin.lab.peerDependencies['@proof-or-stop/core'] = EXPECTED_EXTENSION_VERSION;
  assert(validateManifestCohort(exactPin).some((error) => error.includes('peer range drifted')), 'exact stale core pin mutation did not fail');

  const unsatisfiedPeer = structuredClone(sources);
  unsatisfiedPeer.utils.peerDependencies['@proof-or-stop/core'] = '^0.4.0';
  assert(validateManifestCohort(unsatisfiedPeer).some((error) => error.includes('rejects supplied')), 'unsatisfied core peer mutation did not fail');

  const extraBin = structuredClone(sources);
  extraBin.root.bin = { [RETIRED_PRODUCT]: 'dist/cli.js' };
  assert(validateManifestCohort(extraBin).some((error) => error.includes('product bin set')), 'extra retired bin mutation did not fail');

  const retiredDependency = structuredClone(sources);
  retiredDependency.root.dependencies[`${RETIRED_SCOPE}/core`] = sources.core.version;
  assert(validateManifestCohort(retiredDependency).some((error) => error.includes('retired package')), 'retired dependency mutation did not fail');

  console.log('PASS pack-boundary self-test: stale exact pin, unsatisfied peer, extra bin, and retired dependency mutations fail closed');
}

if (process.argv.includes('--self-test')) {
  runSelfTest();
} else {
  const transcript = runBoundary();
  const transcriptArg = process.argv.find((arg) => arg.startsWith('--transcript='));
  if (transcriptArg) {
    const outputPath = resolve(transcriptArg.slice('--transcript='.length));
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(transcript, null, 2)}\n`);
  }
  if (!process.argv.includes('--quiet')) console.log(JSON.stringify(transcript, null, 2));
  console.log('PASS proof-or-stop packed clean-install boundary');
}
