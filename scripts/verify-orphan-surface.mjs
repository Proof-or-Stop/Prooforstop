#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const handlersDir = join(repoRoot, 'packages/main/src/handlers');
const registryFile = join(repoRoot, 'packages/main/src/registry.ts');
const commandCatalogFile = join(repoRoot, 'packages/main/src/cli/command-catalog.ts');

const retiredSurfaces = new Map([
  [
    'packages/main/src/handlers/implementation-review.ts',
    'replaced by signed review_run_start + finding_add/review_pass_set review evidence',
  ],
  [
    'packages/main/src/core/intent-coverage.ts',
    'legacy testIntent/fixture coverage path replaced by verificationIntent + verificationEvidence',
  ],
  [
    'packages/main/src/core/zod.ts',
    'unexported extension bridge; formal package exports should be added in a future story if needed',
  ],
  [
    'packages/main/src/verifier/index.ts',
    'unexported generic verifier API not used by the current CLI surface',
  ],
  [
    'packages/main/src/verifier/validate.ts',
    'unexported generic verifier API not used by the current CLI surface',
  ],
  [
    'packages/main/src/verifier/cli-executor.ts',
    'unexported generic verifier API not used by the current CLI surface',
  ],
  [
    'packages/main/src/verifier/types.ts',
    'unexported generic verifier API not used by the current CLI surface',
  ],
]);

const protectedDynamicSurfaces = [
  'packages/main/src/verifier/serve.ts',
  'packages/main/src/verifier/dev-host.ts',
  'packages/main/src/verifier/bridge-host.ts',
  'packages/main/src/verifier/browser-client.ts',
  'packages/main/src/verifier/browser-server.ts',
  'packages/main/src/verifier/browser-executor.ts',
];

const allowedCatalogWithoutRegisteredHandler = new Map([
  ['dashboard', 'implemented by the long-running CLI engine path, not a normal handler registry entry'],
  ['help', 'built into the CLI dispatcher'],
  ['version', 'built into the CLI dispatcher'],
]);

function read(path) {
  return readFileSync(path, 'utf8');
}

function rel(path) {
  return relative(repoRoot, path);
}

function listFiles(dir, predicate) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(path, predicate));
      continue;
    }
    if (predicate(path)) out.push(path);
  }
  return out.sort();
}

function matchAll(source, pattern) {
  return [...source.matchAll(pattern)];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isConstConsumedByRegistry(registrySource, constName) {
  const escapedConst = escapeRegExp(constName);
  return (
    new RegExp(String.raw`registry\.registerBatch(?:Missing)?\(\s*${escapedConst}\s*\)`).test(registrySource) ||
    new RegExp(
      String.raw`registry\.register\(\s*['"][a-z][a-z0-9_]*['"]\s*,\s*${escapedConst}(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?\s*\)`,
    ).test(registrySource)
  );
}

function collectDirectlyRegisteredFactories(registrySource) {
  const factories = new Set(
    matchAll(
      registrySource,
      /registry\.registerBatch(?:Missing)?\(\s*(create[A-Za-z0-9]+Handlers)\s*\(\s*(?:ctx(?:\s*,\s*[A-Za-z_$][\w$]*)*)?\s*\)\s*\)/g,
    ).map(match => match[1]),
  );

  for (const [, constName, factory] of matchAll(
    registrySource,
    /const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(create[A-Za-z0-9]+Handlers)\s*\(\s*(?:ctx(?:\s*,\s*[A-Za-z_$][\w$]*)*)?\s*\)\s*;/g,
  )) {
    if (isConstConsumedByRegistry(registrySource, constName)) factories.add(factory);
  }

  return factories;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`orphan-surface self-test failed: ${message}`);
  }
}

function runSelfTest() {
  const registered = collectDirectlyRegisteredFactories(`
    registry.registerBatch(createDirectHandlers(ctx));
    registry.registerBatch(createInjectedHandlers(ctx, admittedProducer));
    createUnregisteredInjectedHandlers(ctx, admittedProducer);
    registry.registerBatchMissing(createDirectMissingHandlers(ctx));

    const batchHandlers = createBatchHandlers(ctx);
    registry.registerBatch(batchHandlers);

    const missingHandlers = createMissingHandlers(ctx);
    registry.registerBatchMissing(missingHandlers);

    const clusterHandlers = createClusterHandlers(ctx);
    registry.register('finding_cluster', clusterHandlers.finding_cluster);

    const orphanHandlers = createOrphanHandlers(ctx);
    void orphanHandlers;
  `);

  assert(registered.has('createInjectedHandlers'), 'registered injected factory is recognized');
  assert(!registered.has('createUnregisteredInjectedHandlers'), 'unregistered injected factory remains rejected');
  assert(registered.has('createDirectHandlers'), 'direct registerBatch factory should be registered');
  assert(registered.has('createDirectMissingHandlers'), 'direct registerBatchMissing factory should be registered');
  assert(registered.has('createBatchHandlers'), 'const consumed by registerBatch should be registered');
  assert(registered.has('createMissingHandlers'), 'const consumed by registerBatchMissing should be registered');
  assert(registered.has('createClusterHandlers'), 'const consumed by registry.register member should be registered');
  assert(!registered.has('createOrphanHandlers'), 'instantiated-but-unregistered factory must remain unregistered');
}

function fail(message, details = []) {
  console.error(`orphan-surface check failed: ${message}`);
  for (const detail of details) console.error(`  - ${detail}`);
  process.exitCode = 1;
}

runSelfTest();

const registrySource = read(registryFile);
const catalogSource = read(commandCatalogFile);
const handlerFiles = listFiles(handlersDir, path => path.endsWith('.ts'));

const importedFactories = new Map();
for (const [, factory, importPath] of matchAll(
  registrySource,
  /import\s+\{\s*(create[A-Za-z0-9]+Handlers)\s*\}\s+from\s+'\.\/handlers\/([^']+)\.js';/g,
)) {
  importedFactories.set(factory, `packages/main/src/handlers/${importPath}.ts`);
}

const directlyRegisteredFactories = collectDirectlyRegisteredFactories(registrySource);

const exportedFactories = new Map();
for (const file of handlerFiles) {
  const source = read(file);
  for (const [, factory] of matchAll(
    source,
    /export\s+function\s+(create[A-Za-z0-9]+Handlers)\s*\(/g,
  )) {
    exportedFactories.set(factory, rel(file));
  }
}

const registeredFactories = new Set(directlyRegisteredFactories);
let expanded = true;
while (expanded) {
  expanded = false;
  for (const factory of [...registeredFactories]) {
    const file = exportedFactories.get(factory);
    if (!file) continue;
    const source = read(join(repoRoot, file));
    for (const [, nestedFactory] of matchAll(source, /\b(create[A-Za-z0-9]+Handlers)\s*\(/g)) {
      if (nestedFactory === factory || !exportedFactories.has(nestedFactory)) continue;
      if (!registeredFactories.has(nestedFactory)) {
        registeredFactories.add(nestedFactory);
        expanded = true;
      }
    }
  }
}

const unregisteredFactories = [...exportedFactories]
  .filter(([factory]) => !registeredFactories.has(factory))
  .map(([factory, file]) => `${factory} exported from ${file}`);
if (unregisteredFactories.length > 0) {
  fail('handler factories are exported but not registered in createMainRegistry', unregisteredFactories);
}

const registeredButMissingSource = [...registeredFactories]
  .filter(factory => !exportedFactories.has(factory))
  .map(factory => {
    const importedFrom = importedFactories.get(factory);
    return importedFrom
      ? `${factory} registered from missing/non-exporting ${importedFrom}`
      : `${factory} registered without a matching handler export`;
  });
if (registeredButMissingSource.length > 0) {
  fail('registry references handler factories that no longer have source exports', registeredButMissingSource);
}

const importedButNotRegistered = [...importedFactories]
  .filter(([factory]) => !directlyRegisteredFactories.has(factory))
  .map(([factory, file]) => `${factory} imported from ${file}`);
if (importedButNotRegistered.length > 0) {
  fail('registry imports handler factories without registering them', importedButNotRegistered);
}

const registeredCommandNames = new Set([
  ...matchAll(registrySource, /registry\.register\(\s*'([a-z][a-z0-9_]*)'/g).map(match => match[1]),
]);
for (const factory of registeredFactories) {
  const file = exportedFactories.get(factory);
  if (!file) continue;
  const sourcePath = join(repoRoot, file);
  if (!existsSync(sourcePath)) continue;
  const source = read(sourcePath);
  for (const [, commandName] of matchAll(
    source,
    /(?:^|[\s,{])(?:async\s+)?([a-z][a-z0-9_]*)\s*(?:\([^)]*\)\s*[:{]|:\s*(?:async\s*)?\()/gm,
  )) {
    registeredCommandNames.add(commandName);
  }
  for (const [, commandName] of matchAll(
    source,
    /(?:^|[\s,{])(?:async\s+)?([a-z][a-z0-9_]*)\s*\(\s*args\s*:/gm,
  )) {
    registeredCommandNames.add(commandName);
  }
  for (const [, commandName] of matchAll(
    source,
    /(?:^|[\s,{])([a-z][a-z0-9_]*)\s*:\s*[A-Za-z_$][A-Za-z0-9_$]*\s*(?:[,}])/gm,
  )) {
    registeredCommandNames.add(commandName);
  }
}

const catalogCommands = new Set(
  matchAll(catalogSource, /name:\s*'([a-z][a-z0-9_]*)'/g).map(match => match[1]),
);
const catalogWithoutHandler = [...catalogCommands]
  .filter(command => !registeredCommandNames.has(command))
  .filter(command => !allowedCatalogWithoutRegisteredHandler.has(command))
  .map(command => `${command} is declared in command-catalog.ts but no registered handler source exposes it`);
if (catalogWithoutHandler.length > 0) {
  fail('command catalog declares commands without registered handler source', catalogWithoutHandler);
}

const retiredStillPresent = [...retiredSurfaces]
  .filter(([path]) => existsSync(join(repoRoot, path)))
  .map(([path, reason]) => `${path}: ${reason}`);
if (retiredStillPresent.length > 0) {
  fail('retired legacy surfaces are present', retiredStillPresent);
}

const protectedMissing = protectedDynamicSurfaces
  .filter(path => !existsSync(join(repoRoot, path)))
  .map(path => `${path} must not be removed by the orphan-surface cleanup`);
if (protectedMissing.length > 0) {
  fail('protected dynamic verifier surfaces are missing', protectedMissing);
}

if (process.exitCode) process.exit(process.exitCode);

console.log(
  `orphan-surface check passed: ${exportedFactories.size} handler factories registered, ` +
    `${catalogCommands.size} catalog commands checked, ${retiredSurfaces.size} retired surfaces absent.`,
);
