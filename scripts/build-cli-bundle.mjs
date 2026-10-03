#!/usr/bin/env node
/**
 * Bundle the CLI's direct-run graph (dist/cli-direct.js and the ~580 per-file
 * modules it loads eagerly) into ONE file, dist/cli-direct.bundle.mjs, so a CLI
 * call parses and links one module instead of ~715. dist/cli.js stays the only
 * published entry: it loads the bundle when present and fresh (see
 * packages/main/src/cli.ts), otherwise the per-file graph. The per-file tsc
 * output is still emitted and still used by identity pins, child-process
 * entries (managed-host-run-supervisor, host-run-group-anchor,
 * supervised-process-worker, cli-init, verifier/serve) and tests.
 *
 * The bundle is built FROM the emitted dist JavaScript, never from src, so it is
 * a pure function of a dist tree: a post-build overlay (the benchmark adapter
 * patches two dist files) is carried into the bundle by re-running this script
 * on the patched tree with --package-root.
 *
 * Usage:
 *   node scripts/build-cli-bundle.mjs
 *       Repository mode: build packages/main (fast path when the build binding
 *       verifies), then, under the build lock, require a verified-fresh dist,
 *       write the bundle and its freshness manifest, and re-record the binding.
 *   node scripts/build-cli-bundle.mjs --package-root DIR [--node-modules DIR]
 *       Staged mode: bundle DIR/dist in place (no build, no binding). Packages
 *       are resolved from --node-modules (default: this checkout's
 *       node_modules); every inlined package version must equal the one
 *       DIR/package-lock.json installs, or the bundle is refused.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUNDLE_BASENAME = 'cli-direct.bundle.mjs';
export const BUNDLE_MANIFEST_BASENAME = 'cli-direct.bundle.json';
export const BUNDLE_MANIFEST_SCHEMA = 'proof-or-stop.cli-bundle.v1';
// Kept external: typescript is lazy-loaded through core/lazy-typescript-hook.js
// (must stay a runtime `import` the hook can redirect); the sibling packages are
// optional extensions resolved at runtime; ws' native accelerators are optional.
export const BUNDLE_EXTERNALS = ['typescript', '@proof-or-stop/*', 'bufferutil', 'utf-8-validate'];

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = { packageRoot: null, nodeModules: join(projectRoot, 'node_modules') };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--package-root') options.packageRoot = resolve(argv[++i]);
    else if (arg === '--node-modules') options.nodeModules = resolve(argv[++i]);
    else throw new Error(`build-cli-bundle: unknown argument ${arg}`);
  }
  return options;
}

const toPosix = path => path.split(sep).join('/');

/** Every inlined package must be the version the package lock installs next to dist. */
function inlinedPackageVersions(inputs, lockPath) {
  if (lockPath && !existsSync(lockPath)) throw new Error(`build-cli-bundle: ${lockPath} is missing; cannot prove inlined dependency versions`);
  // name -> every version the lock installs (hoisted or nested).
  let lock = null;
  if (lockPath) {
    lock = new Map();
    for (const [key, entry] of Object.entries(JSON.parse(readFileSync(lockPath, 'utf8')).packages ?? {})) {
      const at = key.lastIndexOf('node_modules/');
      if (at < 0 || !entry?.version) continue;
      const name = key.slice(at + 'node_modules/'.length);
      if (!lock.has(name)) lock.set(name, new Set());
      lock.get(name).add(entry.version);
    }
  }
  const roots = new Map();
  for (const input of inputs) {
    const parts = toPosix(input).split('/');
    const at = parts.lastIndexOf('node_modules');
    if (at < 0) continue;
    const nameParts = parts[at + 1]?.startsWith('@') ? parts.slice(at + 1, at + 3) : parts.slice(at + 1, at + 2);
    roots.set(parts.slice(0, at + 1 + nameParts.length).join('/'), nameParts.join('/'));
  }
  const mismatches = [];
  const versions = [];
  for (const [root, name] of [...roots].sort()) {
    const installed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    versions.push(`${name}@${installed}`);
    const locked = lock?.get(name);
    if (lock && !locked?.has(installed)) mismatches.push(`${name}: bundled ${installed}, ${lockPath} locks ${locked ? [...locked].join(', ') : 'nothing'}`);
  }
  if (mismatches.length) throw new Error(`build-cli-bundle: inlined dependency versions differ from the package lock:\n  ${mismatches.join('\n  ')}`);
  return versions;
}

/**
 * `lockPath` (staged mode) proves every inlined package equals what that lock
 * installs beside dist; in repository mode esbuild resolves the very
 * node_modules the per-file graph imports, so there is nothing to compare.
 */
export async function bundleDist({ packageRoot, nodeModules, lockPath = null }) {
  const { build } = await import(join(projectRoot, 'node_modules', 'esbuild', 'lib', 'main.js'));
  const entry0 = join(packageRoot, 'dist', 'cli-direct.js');
  if (!existsSync(entry0)) throw new Error(`build-cli-bundle: ${entry0} is missing; build packages/main first`);
  // Real path: esbuild reports inputs by real path (e.g. /private/var on macOS tmp),
  // and the freshness manifest must list them relative to this same dist root.
  const dist = realpathSync(join(packageRoot, 'dist'));
  const entry = join(dist, 'cli-direct.js');
  const outfile = join(dist, BUNDLE_BASENAME);
  const temporary = `${outfile}.tmp-${process.pid}`;
  const result = await build({
    entryPoints: [entry],
    outfile: temporary,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: BUNDLE_EXTERNALS,
    nodePaths: [nodeModules],
    // core/runtime-layout.js: inside the bundle, the dist root is the bundle's own directory.
    define: { __PROOF_OR_STOP_BUNDLED__: 'true' },
    // Inlined CommonJS dependencies (proper-lockfile, ws) call require() for node built-ins.
    banner: { js: "import { createRequire as __proofOrStopCreateRequire } from 'node:module';\nconst require = __proofOrStopCreateRequire(import.meta.url);" },
    legalComments: 'none',
    metafile: true,
    logLevel: 'warning',
  });
  const inputs = Object.keys(result.metafile.inputs).map(input => resolve(process.cwd(), input));
  const inlinedPackages = inlinedPackageVersions(inputs, lockPath);
  // Freshness manifest read by dist/cli.js: size + whole-second mtime of every
  // dist input (tar/cp -p preserve both). Any drift falls back to the per-file graph.
  const distInputs = inputs
    .filter(input => !relative(dist, input).startsWith('..') && !toPosix(input).includes('/node_modules/'))
    .sort()
    .map(input => {
      const stat = statSync(input);
      return [toPosix(relative(dist, input)), stat.size, Math.floor(stat.mtimeMs / 1000)];
    });
  if (distInputs.length === 0 || !distInputs.some(([path]) => path === 'cli-direct.js')) {
    rmSync(temporary, { force: true });
    throw new Error(`build-cli-bundle: no dist inputs recorded under ${dist}; refusing a bundle whose freshness cannot be checked`);
  }
  renameSync(temporary, outfile);
  const bundleStat = statSync(outfile);
  const manifest = {
    schema: BUNDLE_MANIFEST_SCHEMA,
    bundle: [BUNDLE_BASENAME, bundleStat.size, Math.floor(bundleStat.mtimeMs / 1000)],
    inputs: distInputs,
    inlinedPackages,
    external: BUNDLE_EXTERNALS,
  };
  const manifestPath = join(dist, BUNDLE_MANIFEST_BASENAME);
  writeFileSync(`${manifestPath}.tmp-${process.pid}`, `${JSON.stringify(manifest)}\n`);
  renameSync(`${manifestPath}.tmp-${process.pid}`, manifestPath);
  return { outfile, manifestPath, modules: distInputs.length, bytes: bundleStat.size, inlinedPackages };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.packageRoot) {
    const summary = await bundleDist({ ...options, lockPath: join(options.packageRoot, 'package-lock.json') });
    console.log(JSON.stringify(summary));
    return;
  }
  const packageRoot = join(projectRoot, 'packages', 'main');
  execFileSync(process.execPath, [join(projectRoot, 'scripts', 'build-main-with-binding.mjs')], { cwd: packageRoot, stdio: 'inherit' });
  const { withBuildLock } = await import('./build-lock.mjs');
  const { verifyBuildBinding, writeBuildBinding } = await import('./full-suite-build-binding.mjs');
  await withBuildLock(projectRoot, async () => {
    // Never bundle a dist that does not match source: the binding must verify
    // first, and it is re-recorded afterwards so it covers the bundle bytes.
    verifyBuildBinding(projectRoot);
    try {
      const summary = await bundleDist({ packageRoot, nodeModules: options.nodeModules });
      writeBuildBinding(projectRoot);
      console.log(JSON.stringify(summary));
    } catch (error) {
      for (const name of [BUNDLE_BASENAME, BUNDLE_MANIFEST_BASENAME]) rmSync(join(packageRoot, 'dist', name), { force: true });
      writeBuildBinding(projectRoot);
      throw error;
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
