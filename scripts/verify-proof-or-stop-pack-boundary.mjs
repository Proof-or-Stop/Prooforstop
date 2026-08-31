#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import {
  existsSync,
  appendFileSync,
  cpSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
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
const CACHE_FORMAT_VERSION = 'proof-or-stop.pack-boundary-offline-cache.v1';
const CACHE_MANIFEST_FILE = 'cache-manifest.json';
const CACHE_LOCK_STALE_MS = 10 * 60_000;
const CACHE_LOCK_WAIT_MS = 50;
const CACHE_LOCK_TIMEOUT_MS = 3 * 60_000;
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function heartbeat(message) {
  process.stderr.write(`[pack-boundary] ${message}\n`);
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
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
  heartbeat(`packing product artifact ${row.id}`);
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

function directoryContentDigest(root) {
  const hash = createHash('sha256');
  function visit(directory) {
    const entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.name !== 'node_modules')
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const rel = relative(root, absolute).split(sep).join('/');
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        hash.update(`L\0${rel}\0${readlinkSync(absolute)}\0`);
      } else if (stat.isDirectory()) {
        hash.update(`D\0${rel}\0`);
        visit(absolute);
      } else if (stat.isFile()) {
        hash.update(`F\0${rel}\0${stat.mode & 0o777}\0`);
        hash.update(readFileSync(absolute));
        hash.update('\0');
      }
    }
  }
  visit(root);
  return hash.digest('hex');
}

function resolveOfflineDependencyGraph(manifests) {
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

  for (const node of packages.values()) node.sourceDigest = directoryContentDigest(node.packageDir);
  return { packages, seedKeys };
}

function offlineCacheInput(manifests, graph) {
  const lockDigests = PACKAGE_ROWS.map((row) => {
    const path = join(row.directory, 'package-lock.json');
    return { path, sha256: sha256File(join(ROOT, path)) };
  });
  const manifestDigest = sha256(JSON.stringify(Object.fromEntries(
    Object.entries(manifests).sort(([a], [b]) => a.localeCompare(b)).map(([id, manifest]) => [id, manifestProjection(manifest)]),
  )));
  const packages = [...graph.packages.values()].sort((a, b) => a.key.localeCompare(b.key)).map((node) => ({
    key: node.key,
    name: node.manifest.name,
    version: node.manifest.version,
    sourceDigest: node.sourceDigest,
    edges: [...node.edges.entries()].sort(([a], [b]) => a.localeCompare(b)),
  }));
  const seeds = [...graph.seedKeys.entries()].sort(([a], [b]) => a.localeCompare(b));
  const npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  const material = { cacheFormat: CACHE_FORMAT_VERSION, manifestDigest, lockDigests, packages, seeds, npmVersion, nodeVersion: process.version };
  return { ...material, cacheKey: sha256(JSON.stringify(material)) };
}

function cacheRootPath() {
  return resolve(process.env.PROOF_OR_STOP_PACK_BOUNDARY_CACHE_DIR
    || join(tmpdir(), 'proof-or-stop-pack-boundary-cache-v1'));
}

function ensureSafeCacheRoot(cacheRoot) {
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const fromRepo = relative(realpathSync(ROOT), realpathSync(cacheRoot));
  const insideRepository = fromRepo === '' || (fromRepo !== '..' && !fromRepo.startsWith(`..${sep}`));
  assert(!insideRepository, 'pack-boundary cache must be outside the repository');
  const stat = lstatSync(cacheRoot);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'pack-boundary cache root must be a real directory');
  if (typeof process.getuid === 'function') assert(stat.uid === process.getuid(), 'pack-boundary cache root must be owned by the current user');
  assert((stat.mode & 0o022) === 0, 'pack-boundary cache root must not be group/world writable');
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function acquireCacheLock(lockDir) {
  const started = Date.now();
  let lastHeartbeat = 0;
  while (true) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      writeFileSync(join(lockDir, 'owner.json'), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, { flag: 'wx' });
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let owner = null;
      try { owner = readJson(join(lockDir, 'owner.json')); } catch {}
      let age = 0;
      try { age = Date.now() - statSync(lockDir).mtimeMs; } catch {}
      if (age > CACHE_LOCK_STALE_MS && !processAlive(Number(owner?.pid))) {
        const stale = `${lockDir}.stale-${process.pid}-${Date.now()}`;
        try {
          renameSync(lockDir, stale);
          rmSync(stale, { recursive: true, force: true });
          continue;
        } catch (staleError) {
          if (staleError?.code !== 'ENOENT') throw staleError;
        }
      }
      if (Date.now() - started > CACHE_LOCK_TIMEOUT_MS) fail(`timed out waiting for pack-boundary cache lock ${lockDir}`);
      if (Date.now() - lastHeartbeat > 5_000) {
        heartbeat(`waiting for cache lock ${lockDir}`);
        lastHeartbeat = Date.now();
      }
      sleepSync(CACHE_LOCK_WAIT_MS);
    }
  }
}

function expectedTarballFilename(node) {
  const stem = node.manifest.name.replace(/^@/, '').replaceAll('/', '-');
  return `${stem}-${node.manifest.version}.tgz`;
}

function validateOfflineCache(cacheDir, input, graph, publishedCacheDir = cacheDir) {
  try {
    const cacheStat = lstatSync(cacheDir);
    if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink()) return { ok: false, reason: 'cache directory is not a real directory' };
    const manifestPath = join(cacheDir, CACHE_MANIFEST_FILE);
    const manifestStat = lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) return { ok: false, reason: 'cache manifest is not a regular file' };
    const manifest = readJson(manifestPath);
    if (manifest.schemaVersion !== CACHE_FORMAT_VERSION || manifest.cacheKey !== input.cacheKey) return { ok: false, reason: 'cache identity mismatch' };
    if (!isDeepStrictEqual(manifest.lockDigests, input.lockDigests) || manifest.manifestDigest !== input.manifestDigest) {
      return { ok: false, reason: 'cache lock or manifest digest mismatch' };
    }
    if (!Array.isArray(manifest.packages) || manifest.packages.length !== graph.packages.size) return { ok: false, reason: 'cache package count mismatch' };
    const cachedByKey = new Map(manifest.packages.map((row) => [row.key, row]));
    const overrides = {};
    const summary = [];
    for (const node of [...graph.packages.values()].sort((a, b) => a.key.localeCompare(b.key))) {
      const row = cachedByKey.get(node.key);
      if (!row || row.name !== node.manifest.name || row.version !== node.manifest.version || row.sourceDigest !== node.sourceDigest) {
        return { ok: false, reason: `cache package identity mismatch for ${node.key}` };
      }
      if (row.filename !== expectedTarballFilename(node) || row.filename !== row.filename.split('/').pop()) {
        return { ok: false, reason: `cache filename mismatch for ${node.key}` };
      }
      const tarball = join(cacheDir, 'tarballs', row.filename);
      const tarballStat = lstatSync(tarball);
      if (!tarballStat.isFile() || tarballStat.isSymbolicLink()) return { ok: false, reason: `cache tarball is not regular for ${node.key}` };
      if (sha256File(tarball) !== row.tarballSha256) return { ok: false, reason: `cache tarball digest mismatch for ${node.key}` };
      const packedManifestText = execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' });
      const packedManifest = JSON.parse(packedManifestText);
      const expectedDependencies = Object.fromEntries([...node.edges.entries()].map(([name, childKey]) => {
        const child = graph.packages.get(childKey);
        return [name, `file:${join(publishedCacheDir, 'tarballs', expectedTarballFilename(child))}`];
      }));
      if (sha256(packedManifestText) !== row.packedManifestSha256
        || packedManifest.name !== node.manifest.name
        || packedManifest.version !== node.manifest.version
        || !isDeepStrictEqual(packedManifest.dependencies || {}, expectedDependencies)) {
        return { ok: false, reason: `cache packed manifest mismatch for ${node.key}` };
      }
      summary.push({ name: node.manifest.name, version: node.manifest.version });
    }
    for (const [name, key] of graph.seedKeys) {
      const node = graph.packages.get(key);
      overrides[name] = `file:${join(cacheDir, 'tarballs', expectedTarballFilename(node))}`;
    }
    return { ok: true, overrides, summary, manifest };
  } catch (error) {
    return { ok: false, reason: `cache read failed: ${error.message}` };
  }
}

function buildOfflineCache(cacheRoot, cacheDir, input, graph) {
  const stageDir = mkdtempSync(join(cacheRoot, `.${input.cacheKey}.tmp-${process.pid}-`));
  const packDir = join(stageDir, 'tarballs');
  const sourceStageRoot = join(stageDir, 'sources');
  mkdirSync(packDir, { recursive: true });
  mkdirSync(sourceStageRoot, { recursive: true });
  const packageRows = [];
  try {
    const sortedNodes = [...graph.packages.values()].sort((a, b) => a.key.localeCompare(b.key));
    sortedNodes.forEach((node, index) => {
      if (index % 10 === 0) heartbeat(`building offline dependency cache ${index}/${sortedNodes.length}`);
      const { packageDir, manifest } = node;
      const sourceStage = join(sourceStageRoot, Buffer.from(node.key).toString('hex'));
      cpSync(packageDir, sourceStage, {
        recursive: true,
        filter: (source) => source === packageDir
          || !relative(packageDir, source).split(sep).includes('node_modules'),
      });
      const stagedManifest = readJson(join(sourceStage, 'package.json'));
      stagedManifest.dependencies = Object.fromEntries([...node.edges.entries()].map(([name, childKey]) => {
        const child = graph.packages.get(childKey);
        return [name, `file:${join(cacheDir, 'tarballs', expectedTarballFilename(child))}`];
      }));
      delete stagedManifest.optionalDependencies;
      delete stagedManifest.peerDependencies;
      delete stagedManifest.peerDependenciesMeta;
      delete stagedManifest.devDependencies;
      delete stagedManifest.bundleDependencies;
      delete stagedManifest.bundledDependencies;
      writeFileSync(join(sourceStage, 'package.json'), `${JSON.stringify(stagedManifest, null, 2)}\n`);
      const stdout = execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir, '.'], {
        cwd: sourceStage,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const records = JSON.parse(stdout);
      assert(Array.isArray(records) && records.length === 1, `offline dependency ${manifest.name} did not pack exactly once`);
      const filename = records[0].filename;
      assert(filename === expectedTarballFilename(node), `offline dependency tarball filename drifted for ${node.key}`);
      const tarball = join(packDir, filename);
      const packedManifestText = execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' });
      const packedManifest = JSON.parse(packedManifestText);
      assert(packedManifest.name === manifest.name && packedManifest.version === manifest.version, `offline dependency packed identity drifted for ${node.key}`);
      packageRows.push({
        key: node.key,
        name: manifest.name,
        version: manifest.version,
        sourceDigest: node.sourceDigest,
        filename,
        tarballSha256: sha256File(tarball),
        packedManifestSha256: sha256(packedManifestText),
      });
    });
    if (process.env.PROOF_OR_STOP_PACK_BOUNDARY_TEST_BUILD_DELAY_MS) {
      sleepSync(Number(process.env.PROOF_OR_STOP_PACK_BOUNDARY_TEST_BUILD_DELAY_MS));
    }
    writeFileSync(join(stageDir, CACHE_MANIFEST_FILE), `${JSON.stringify({
      schemaVersion: CACHE_FORMAT_VERSION,
      cacheKey: input.cacheKey,
      manifestDigest: input.manifestDigest,
      lockDigests: input.lockDigests,
      packages: packageRows,
    }, null, 2)}\n`, { flag: 'wx' });
    const current = validateOfflineCache(stageDir, input, graph, cacheDir);
    assert(current.ok, `new offline cache failed validation: ${current.reason}`);
    let quarantine = null;
    if (existsSync(cacheDir)) {
      quarantine = `${cacheDir}.stale-${process.pid}-${Date.now()}`;
      renameSync(cacheDir, quarantine);
    }
    renameSync(stageDir, cacheDir);
    if (quarantine) rmSync(quarantine, { recursive: true, force: true });
  } catch (error) {
    if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
    throw error;
  }
}

function ensureOfflineDependencyCacheForGraph(manifests, graph, cacheRoot) {
  ensureSafeCacheRoot(cacheRoot);
  const input = offlineCacheInput(manifests, graph);
  const cacheDir = join(cacheRoot, input.cacheKey);
  const initial = existsSync(cacheDir) ? validateOfflineCache(cacheDir, input, graph) : { ok: false, reason: 'cache missing' };
  if (initial.ok) {
    heartbeat(`offline dependency cache hit ${input.cacheKey.slice(0, 12)}`);
    return { ...initial, cacheStatus: 'hit', cacheKey: input.cacheKey };
  }
  const release = acquireCacheLock(`${cacheDir}.lock`);
  try {
    const afterLock = existsSync(cacheDir) ? validateOfflineCache(cacheDir, input, graph) : { ok: false, reason: 'cache missing' };
    if (afterLock.ok) return { ...afterLock, cacheStatus: 'hit-after-wait', cacheKey: input.cacheKey };
    heartbeat(`offline dependency cache ${existsSync(cacheDir) ? 'invalid' : 'miss'}; rebuilding (${afterLock.reason})`);
    buildOfflineCache(cacheRoot, cacheDir, input, graph);
    const built = validateOfflineCache(cacheDir, input, graph);
    assert(built.ok, `published offline cache failed validation: ${built.reason}`);
    return { ...built, cacheStatus: initial.reason === 'cache missing' ? 'built' : 'rebuilt-after-invalid', cacheKey: input.cacheKey };
  } finally {
    release();
  }
}

function ensureOfflineDependencyCache(manifests, cacheRoot = cacheRootPath()) {
  return ensureOfflineDependencyCacheForGraph(manifests, resolveOfflineDependencyGraph(manifests), cacheRoot);
}

function prepareOfflineDependencyOverrides(manifests) {
  const cache = ensureOfflineDependencyCache(manifests);
  return { overrides: cache.overrides, summary: cache.summary, cacheStatus: cache.cacheStatus, cacheKey: cache.cacheKey };
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

    const offlineDependencies = prepareOfflineDependencyOverrides(sources);

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
    heartbeat(`installing exactly ${packed.length} product tarballs with npm --offline`);
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

    heartbeat('checking canonical and retired role lookup boundary');
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
      offlineDependencyCache: { status: offlineDependencies.cacheStatus, key: offlineDependencies.cacheKey },
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

function cacheProbeGraph(packageDir) {
  const manifest = readJson(join(packageDir, 'package.json'));
  const key = `${manifest.name}@${manifest.version}`;
  const node = {
    key,
    packageDir,
    manifest,
    edges: new Map(),
    sourceDigest: directoryContentDigest(packageDir),
  };
  return { packages: new Map([[key, node]]), seedKeys: new Map([[manifest.name, key]]) };
}

function runCacheWorker(payload) {
  const manifests = sourceManifests();
  const result = ensureOfflineDependencyCacheForGraph(
    manifests,
    cacheProbeGraph(payload.packageDir),
    payload.cacheRoot,
  );
  console.log(JSON.stringify({ cacheStatus: result.cacheStatus, cacheKey: result.cacheKey }));
}

function spawnCacheWorker(payload) {
  return new Promise((resolvePromise, rejectPromise) => {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), `--cache-self-test-worker=${encoded}`], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PROOF_OR_STOP_PACK_BOUNDARY_TEST_BUILD_DELAY_MS: '500' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      if (code !== 0) rejectPromise(new Error(`cache worker exited ${code}: ${stderr || stdout}`));
      else {
        try { resolvePromise(JSON.parse(stdout.trim().split('\n').at(-1))); }
        catch (error) { rejectPromise(new Error(`cache worker returned invalid output: ${error.message}: ${stdout}`)); }
      }
    });
  });
}

async function runSelfTest() {
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

  const temp = mkdtempSync(join(tmpdir(), 'proof-or-stop-pack-cache-self-test-'));
  try {
    const packageDir = join(temp, 'dependency');
    const cacheRoot = join(temp, 'cache');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'proof-or-stop-cache-probe', version: '1.0.0', main: 'index.js' }));
    writeFileSync(join(packageDir, 'index.js'), 'export const cacheProbe = true;\n');
    const graph = cacheProbeGraph(packageDir);

    const cold = ensureOfflineDependencyCacheForGraph(sources, graph, cacheRoot);
    assert(cold.cacheStatus === 'built', `cache cold build status was ${cold.cacheStatus}`);
    const warm = ensureOfflineDependencyCacheForGraph(sources, cacheProbeGraph(packageDir), cacheRoot);
    assert(warm.cacheStatus === 'hit', `cache warm status was ${warm.cacheStatus}`);

    const cacheDir = join(cacheRoot, cold.cacheKey);
    const cacheManifest = readJson(join(cacheDir, CACHE_MANIFEST_FILE));
    const cachedTarball = join(cacheDir, 'tarballs', cacheManifest.packages[0].filename);
    appendFileSync(cachedTarball, 'tamper');
    const afterTamper = ensureOfflineDependencyCacheForGraph(sources, cacheProbeGraph(packageDir), cacheRoot);
    assert(afterTamper.cacheStatus === 'rebuilt-after-invalid', `tampered cache status was ${afterTamper.cacheStatus}`);

    const staleManifest = readJson(join(cacheDir, CACHE_MANIFEST_FILE));
    staleManifest.lockDigests[0].sha256 = '0'.repeat(64);
    writeFileSync(join(cacheDir, CACHE_MANIFEST_FILE), `${JSON.stringify(staleManifest, null, 2)}\n`);
    const afterStale = ensureOfflineDependencyCacheForGraph(sources, cacheProbeGraph(packageDir), cacheRoot);
    assert(afterStale.cacheStatus === 'rebuilt-after-invalid', `stale manifest cache status was ${afterStale.cacheStatus}`);

    const concurrentRoot = join(temp, 'concurrent-cache');
    const concurrentResults = await Promise.all([
      spawnCacheWorker({ cacheRoot: concurrentRoot, packageDir }),
      spawnCacheWorker({ cacheRoot: concurrentRoot, packageDir }),
    ]);
    const statuses = concurrentResults.map((result) => result.cacheStatus).sort();
    assert(statuses.includes('built') && statuses.includes('hit-after-wait'), `concurrent cache statuses were ${statuses.join(', ')}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  console.log('PASS pack-boundary self-test: manifest mutations fail closed; cache hit, tamper/stale rebuild, and concurrent publication verified');
}

const cacheWorkerArg = process.argv.find((arg) => arg.startsWith('--cache-self-test-worker='));
if (cacheWorkerArg) {
  runCacheWorker(JSON.parse(Buffer.from(cacheWorkerArg.slice('--cache-self-test-worker='.length), 'base64url').toString('utf8')));
} else if (process.argv.includes('--self-test')) {
  await runSelfTest();
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
