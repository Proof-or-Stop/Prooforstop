#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = join(repoRoot, 'dist', 'desktop');
const entryPath = join(desktopDir, 'pkg-entry.js');
const configPath = join(desktopDir, 'pkg.config.json');
const manifestPath = join(desktopDir, 'manifest.json');
const assetManifestPath = join(desktopDir, 'asset-manifest.json');
const mode = process.argv[2] || 'host';

const hostTarget = targetForHost();
const releaseTargets = [
  'node24-macos-x64',
  'node24-macos-arm64',
  'node24-linux-x64',
  'node24-win-x64',
];

function bin(name) {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  return join(repoRoot, 'node_modules', '.bin', `${name}${suffix}`);
}

function run(command, args) {
  console.log(`$ ${[command, ...args].join(' ')}`);
  execFileSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

function assertExists(path, hint) {
  if (!existsSync(path)) {
    throw new Error(`${path} is missing. ${hint}`);
  }
}

function targetForHost() {
  const platform = process.platform === 'darwin' ? 'macos' : process.platform;
  const arch = process.arch;
  if (platform === 'macos' && (arch === 'x64' || arch === 'arm64')) return `node24-macos-${arch}`;
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) return `node24-linux-${arch}`;
  if (platform === 'win32' && arch === 'x64') return 'node24-win-x64';
  throw new Error(`Unsupported host target for pkg: ${process.platform}/${process.arch}`);
}

function artifactName(target) {
  const [, platform, arch] = target.match(/^node24-(macos|linux|win)-(.+)$/) || [];
  if (!platform || !arch) throw new Error(`Unsupported pkg target: ${target}`);
  return `proof-or-stop-${platform}-${arch}${platform === 'win' ? '.exe' : ''}`;
}

function writePkgEntrypoint() {
  mkdirSync(desktopDir, { recursive: true });
  writeFileSync(entryPath, `#!/usr/bin/env node
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { dirname, join } = require('path');
const { pathToFileURL } = require('url');

function copyIntoRuntime(snapshotRoot, runtimeRoot, relPath) {
  const source = join(snapshotRoot, relPath);
  const destination = join(runtimeRoot, relPath);
  if (!existsSync(source)) {
    throw new Error('Packaged ProofOrStop asset is missing from the pkg snapshot: ' + relPath);
  }
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, readFileSync(source));
}

function prepareRuntime() {
  const snapshotRoot = join(__dirname, '..', '..');
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-desktop-'));
  const manifestPath = join(__dirname, 'asset-manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error('Packaged ProofOrStop asset manifest is missing from the pkg snapshot.');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const relPath of manifest.files) {
    copyIntoRuntime(snapshotRoot, runtimeRoot, relPath);
    // pkg rewrites package.json for its CJS snapshot. The extracted assets retain
    // their original ESM sources, so restore the exact build-time manifests.
    if (Object.hasOwn(manifest.packageJsonSources || {}, relPath)) {
      writeFileSync(join(runtimeRoot, relPath), manifest.packageJsonSources[relPath], 'utf8');
    }
  }
  process.once('exit', () => {
    try { rmSync(runtimeRoot, { recursive: true, force: true }); } catch {}
  });
  return runtimeRoot;
}

process.env.PROOF_OR_STOP_DESKTOP_PACKAGED_RUNTIME = '1';

async function main() {
  const runtimeRoot = prepareRuntime();
  const bootstrapPath = join(runtimeRoot, 'bin', 'bootstrap-runner.js');
  if (!existsSync(bootstrapPath)) {
    throw new Error('Packaged ProofOrStop bootstrap is missing from the desktop runtime.');
  }
  const bootstrap = await import(pathToFileURL(bootstrapPath).href);
  if (typeof bootstrap.runLocalBootstrap !== 'function') {
    throw new Error('Packaged ProofOrStop bootstrap does not export runLocalBootstrap().');
  }
  await bootstrap.runLocalBootstrap();
}

main().catch((error) => {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(err.stack || err.message);
  process.exit(1);
});
`, 'utf8');
}

function listFiles(relPath) {
  const absolute = join(repoRoot, relPath);
  const stat = statSync(absolute);
  if (stat.isFile()) return [relPath];
  const files = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = `${relPath}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listFiles(child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

function writeAssetManifest() {
  const files = [
    'package.json',
    'bin/bootstrap-runner.js',
    // bin/bootstrap-runner.js statically imports this at module-init (a dependency-free node:-only
    // helper). It lives under scripts/ (not packages/*/dist), so no listFiles() spread below ships it —
    // it MUST be listed explicitly or the packaged desktop runtime crashes with ERR_MODULE_NOT_FOUND at
    // bootstrap (B-1734 D1). red-1734-desktop-asset-manifest.mjs asserts every scripts/ module in
    // bootstrap's static import graph is present here.
    'scripts/build-lock-target.mjs',
    // bin/bootstrap-runner.js reaches this one DYNAMICALLY (after it has confirmed dist is present) to
    // take reader admission before importing the dist entries. A dynamic import is still a hard runtime
    // requirement of the packaged desktop startup path — bootstrap takes that branch on EVERY packaged
    // invocation, because pkg-entry always materializes dist into the runtime root — so it must ship too
    // (B-bcae F-008/F-017). Unlike build-lock-target.mjs this module is NOT dependency-free: it imports
    // proper-lockfile, whose runtime closure is listed below.
    'scripts/build-lock.mjs',
    // The unconditional startup version guard resolves this manifest after runtime materialization.
    // verify-cli-audit-runtime-coverage.mjs boots this generated entry with matching and stale versions.
    'packages/main/package.json',
    ...listFiles('packages/main/dist'),
    // Agent prompt bodies have a single source of truth: this template registry (they are deliberately
    // NOT materialized into host directories). readPromptRegistry() reads packages/main/templates/agents
    // relative to the package root during CLI startup, and the role-policy registry is validated for
    // TOTALITY against whatever it finds — so an absent directory is not a soft degradation, it aborts
    // startup with `unknown prompt role policy "<role>"`. Templates live outside dist, so no spread above
    // ships them. Pre-existing gap, surfaced by red-1734-desktop-asset-manifest.mjs's startup witness.
    ...listFiles('packages/main/templates'),
    // Main-package runtime imports resolve these exact package-local dependencies.
    ...listFiles('packages/main/node_modules/smol-toml'),
    ...listFiles('packages/main/node_modules/ws'),
    'packages/utils/package.json',
    ...listFiles('packages/utils/dist'),
    'packages/lab/package.json',
    ...listFiles('packages/lab/dist'),
    ...listFiles('node_modules/typescript'),
    ...listFiles('node_modules/xstate'),
    ...listFiles('node_modules/zod'),
    // The runtime dependency closure of scripts/build-lock.mjs. proper-lockfile requires graceful-fs,
    // retry and signal-exit; the first two resolve at the root, but signal-exit resolves to the copy
    // NESTED under node_modules/proper-lockfile/node_modules — a different major from the hoisted root
    // one, whose CommonJS export is an object rather than the callable proper-lockfile invokes at
    // module-init. listFiles() recurses, so this spread ships that nested copy along with the package.
    // Shipping the root copy INSTEAD does not work, and that is executed rather than asserted from
    // reading: red-1734-desktop-asset-manifest.mjs derives this closure by real Node resolution, checks
    // every resolved package directory is shipped here, and its manifest:5 substitution control replaces
    // the nested copy with the hoisted root one in a real packaged runtime root and requires startup to
    // still fail (B-bcae F-053). It also asserts the two are different majors, so the control cannot
    // quietly degrade into "some copy is required" if the installs are ever deduped.
    ...listFiles('node_modules/proper-lockfile'),
    ...listFiles('node_modules/graceful-fs'),
    ...listFiles('node_modules/retry'),
  ].sort();
  const packageJsonSources = Object.fromEntries(files
    .filter((file) => file === 'package.json' || file.endsWith('/package.json'))
    .map((file) => [file, readFileSync(join(repoRoot, file), 'utf8')]));
  writeFileSync(assetManifestPath, JSON.stringify({ files, packageJsonSources }, null, 2) + '\n', 'utf8');
  return files;
}

function writePkgConfig() {
  const assetFiles = writeAssetManifest();
  const config = {
    pkg: {
      scripts: [
        'pkg-entry.js',
      ],
      assets: [
        'asset-manifest.json',
        ...assetFiles.map((relPath) => `../../${relPath}`),
      ],
    },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

// KNOWN LIMITATION / FOLLOW-UP (B-1734 #4, deferred to a build-concurrency infra story): this desktop
// packaging build is a 4TH build call-site that BYPASSES the build mutex. It runs tsc DIRECTLY against
// the shared packages/*/dist, outside withBuildLock and outside the atomic staging-swap that the two
// build-*-with-binding.mjs scripts use. If a concurrent build-*-with-binding.mjs (or a reader) runs while
// this is packaging, they are not mutually excluded and can observe a torn dist. Packaging is normally a
// dedicated release step run in isolation, so this is not yet routed through the lock; folding it into the
// same withBuildLock + staging discipline is tracked for the same follow-up.
function buildPackages() {
  const tsc = bin('tsc');
  assertExists(tsc, 'Run npm install from the repository root.');
  run(tsc, ['-p', 'packages/main/tsconfig.json']);
  run(tsc, ['-p', 'packages/utils/tsconfig.json']);
  run(tsc, ['-p', 'packages/lab/tsconfig.json']);
}

// pkg base binaries omit inspector support. Keep profiler loading lazy so ordinary
// CLI commands can boot; invoking inspector-dependent profiling still fails explicitly.
function patchPkgRuntimeCompatibility() {
  const profilerPath = join(repoRoot, 'packages', 'main', 'dist', 'tasks', 'profiler.js');
  const source = readFileSync(profilerPath, 'utf8');
  const node19Import = "import { Session } from 'node:inspector/promises';";
  if (!source.includes(node19Import)) return;
  const lazyInspectorCompat = `class Session {
    delegate = null;
    async ensureDelegate() {
        if (!this.delegate) {
            const inspector = await import('node:inspector');
            this.delegate = new inspector.Session();
            this.delegate.connect();
        }
        return this.delegate;
    }
    connect() {}
    disconnect() {
        if (this.delegate) {
            this.delegate.disconnect();
            this.delegate = null;
        }
    }
    async post(method, params = {}) {
        const delegate = await this.ensureDelegate();
        return new Promise((resolve, reject) => {
            delegate.post(method, params, (error, result) => {
                if (error)
                    reject(error);
                else
                    resolve(result ?? {});
            });
        });
    }
}`;
  writeFileSync(profilerPath, source.replace(node19Import, lazyInspectorCompat), 'utf8');
}

function packageTarget(target) {
  const pkg = bin('pkg');
  assertExists(pkg, 'Run npm install from the repository root.');
  const output = join(desktopDir, artifactName(target));
  run(pkg, [
    '--config',
    configPath,
    '--targets',
    target,
    '--output',
    output,
    '--no-bytecode',
    '--public',
    '--public-packages',
    '*',
    entryPath,
  ]);
  if (process.platform !== 'win32' && !output.endsWith('.exe')) chmodSync(output, 0o755);
  return { target, artifact: output };
}

function writeManifest(results) {
  writeFileSync(manifestPath, JSON.stringify({
    entry: 'bin/proof-or-stop.js via generated pkg-entry.js',
    artifacts: results,
  }, null, 2) + '\n', 'utf8');
}

if (!['host', 'release'].includes(mode)) {
  throw new Error(`Unknown desktop package mode "${mode}". Use "host" or "release".`);
}

buildPackages();
patchPkgRuntimeCompatibility();
writePkgEntrypoint();
writePkgConfig();

const targets = mode === 'host' ? [hostTarget] : releaseTargets;
const results = targets.map(packageTarget);
writeManifest(results);

for (const result of results) {
  console.log(`created ${result.artifact}`);
}
