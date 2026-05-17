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
  'node18-macos-x64',
  'node18-macos-arm64',
  'node18-linux-x64',
  'node18-win-x64',
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
  if (platform === 'macos' && (arch === 'x64' || arch === 'arm64')) return `node18-macos-${arch}`;
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) return `node18-linux-${arch}`;
  if (platform === 'win32' && arch === 'x64') return 'node18-win-x64';
  throw new Error(`Unsupported host target for pkg: ${process.platform}/${process.arch}`);
}

function artifactName(target) {
  const [, platform, arch] = target.match(/^node18-(macos|linux|win)-(.+)$/) || [];
  if (!platform || !arch) throw new Error(`Unsupported pkg target: ${target}`);
  return `koala-${platform}-${arch}${platform === 'win' ? '.exe' : ''}`;
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
    throw new Error('Packaged Koala asset is missing from the pkg snapshot: ' + relPath);
  }
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, readFileSync(source));
}

function prepareRuntime() {
  const snapshotRoot = join(__dirname, '..', '..');
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'koala-desktop-'));
  const manifestPath = join(__dirname, 'asset-manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error('Packaged Koala asset manifest is missing from the pkg snapshot.');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const relPath of manifest.files) copyIntoRuntime(snapshotRoot, runtimeRoot, relPath);
  process.once('exit', () => {
    try { rmSync(runtimeRoot, { recursive: true, force: true }); } catch {}
  });
  return runtimeRoot;
}

process.env.KOALA_DESKTOP_PACKAGED_RUNTIME = '1';

async function main() {
  const runtimeRoot = prepareRuntime();
  const bootstrapPath = join(runtimeRoot, 'bin', 'bootstrap-runner.js');
  if (!existsSync(bootstrapPath)) {
    throw new Error('Packaged Koala bootstrap is missing from the desktop runtime.');
  }
  const bootstrap = await import(pathToFileURL(bootstrapPath).href);
  if (typeof bootstrap.runLocalBootstrap !== 'function') {
    throw new Error('Packaged Koala bootstrap does not export runLocalBootstrap().');
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
    'packages/main/package.json',
    ...listFiles('packages/main/dist'),
    'packages/utils/package.json',
    ...listFiles('packages/utils/dist'),
    'packages/lab/package.json',
    ...listFiles('packages/lab/dist'),
    ...listFiles('node_modules/typescript'),
    ...listFiles('node_modules/xstate'),
    ...listFiles('node_modules/zod'),
  ].sort();
  writeFileSync(assetManifestPath, JSON.stringify({ files }, null, 2) + '\n', 'utf8');
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

function buildPackages() {
  const tsc = bin('tsc');
  assertExists(tsc, 'Run npm install from the repository root.');
  run(tsc, ['-p', 'packages/main/tsconfig.json']);
  run(tsc, ['-p', 'packages/utils/tsconfig.json']);
  run(tsc, ['-p', 'packages/lab/tsconfig.json']);
}

function patchPkgRuntimeCompatibility() {
  const profilerPath = join(repoRoot, 'packages', 'main', 'dist', 'tasks', 'profiler.js');
  const source = readFileSync(profilerPath, 'utf8');
  const node19Import = "import { Session } from 'node:inspector/promises';";
  if (!source.includes(node19Import)) return;
  const node18Compat = `class Session {
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
  writeFileSync(profilerPath, source.replace(node19Import, node18Compat), 'utf8');
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
    entry: 'bin/koala.js via generated pkg-entry.js',
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
