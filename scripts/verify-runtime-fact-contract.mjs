#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const failures = [];

const requiredFacts = [
  ['cli-entrypoint', 'cliEntrypoint'],
  ['global-core-realpath', 'globalCoreRealpath'],
  ['project-local-bin', 'projectLocalBin'],
  ['node-version', 'nodeVersion'],
  ['package-version', 'packageVersion'],
  ['validate-source', 'validateSource'],
  ['external-reference-policy', 'externalReferencePolicy'],
];

function fail(message) {
  failures.push(message);
}

function check(condition, message) {
  if (!condition) fail(message);
}

function findRepoRoot(start) {
  let current = resolve(start);
  while (current !== dirname(current)) {
    if (
      existsSync(join(current, 'packages', 'main', 'src', 'core', 'runtime-fact-registry.ts')) &&
      existsSync(join(current, 'package.json'))
    ) {
      return current;
    }
    current = dirname(current);
  }
  return resolve(start);
}

function read(root, relPath) {
  const abs = join(root, relPath);
  check(existsSync(abs), `${relPath} should exist`);
  if (!existsSync(abs)) return '';
  return readFileSync(abs, 'utf8');
}

async function importDist(root, relPath) {
  const abs = join(root, relPath);
  check(existsSync(abs), `${relPath} should exist; run npm run build first`);
  if (!existsSync(abs)) return null;
  return import(pathToFileURL(abs).href);
}

async function main() {
  const root = findRepoRoot(process.cwd());
  const registrySource = read(root, 'packages/main/src/core/runtime-fact-registry.ts');
  const checksSource = read(root, 'packages/main/src/core/runtime-environment-checks.ts');
  const doctorSource = read(root, 'packages/main/src/handlers/doctor.ts');
  const processFactSource = read(root, 'packages/main/src/core/process-fact-registry.ts');
  const runtimeArtifactSource = read(root, 'packages/main/src/core/runtime-artifact-registry.ts');

  for (const token of [
    "id: 'review-round-receipt-signing-keys'",
    "value: '.lattice/runtime/review-round-receipt-signers/'",
    "ignorePatterns: ['.lattice/runtime/review-round-receipt-signers/']",
    "materialHash: 'exclude'",
    'volatile: true',
    'repairableTrackedArtifact: true',
  ]) {
    check(runtimeArtifactSource.includes(token), `review-round receipt private-key runtime artifact missing contract token: ${token}`);
  }

  for (const [id, outputKey] of requiredFacts) {
    check(registrySource.includes(`id: '${id}'`), `missing runtime fact: ${id}`);
    check(registrySource.includes(`'${id}': '${outputKey}'`), `missing runtime output key mapping: ${id} -> ${outputKey}`);
    check(registrySource.includes(`outputKey: '${outputKey}'`), `missing runtime output key on entry: ${outputKey}`);
    check(!processFactSource.includes(id), `runtime fact leaked into process-fact-registry: ${id}`);
    check(checksSource.includes(outputKey), `missing runtime checker output key reference: ${outputKey}`);
  }

  check(registrySource.includes('selfSeverity'), 'runtime registry entries should declare selfSeverity');
  check(registrySource.includes('externalSeverity'), 'runtime registry entries should declare externalSeverity');
  check(registrySource.includes('checker:'), 'runtime registry entries should declare checker');
  check(registrySource.includes('driftMessage'), 'runtime registry entries should declare driftMessage');
  check(registrySource.includes('repairHint'), 'runtime registry should include repair hints where applicable');
  check(registrySource.includes('@lattice/core'), 'runtime registry should name @lattice/core as canonical');
  check(!registrySource.includes('@lattice-agent/core'), 'runtime registry must not advertise retired @lattice-agent/core');
  check(!registrySource.includes('@koala-agent/core'), 'runtime registry must not advertise @koala-agent/core fallback');
  check(checksSource.includes("const CANONICAL_CORE_PACKAGE_NAME = '@lattice/core'"), 'runtime checks should resolve @lattice/core as canonical');
  check(!checksSource.includes('@lattice-agent/core'), 'runtime checks must not resolve retired @lattice-agent/core');
  check(!checksSource.includes('@koala-agent/core'), 'runtime checks must not resolve @koala-agent/core fallback');
  check(registrySource.includes('command -v lattice'), 'cli-entrypoint repair hint should use lattice');
  check(!registrySource.includes('command -v lattice || command -v koala'), 'cli-entrypoint repair hint must not include koala fallback');
  check(registrySource.includes('node_modules/.bin/lattice'), 'project-local-bin guidance should prefer lattice local bins');
  check(!registrySource.includes('node_modules/.bin/koala'), 'project-local-bin guidance must not include koala local bins');
  check(doctorSource.includes('runRuntimeEnvironmentChecks'), 'doctor should call runRuntimeEnvironmentChecks');
  check(doctorSource.includes('runtime,'), 'doctor JSON should expose runtime');
  check(doctorSource.includes('renderRuntimeEnvironmentReport'), 'doctor text should render runtime scan');

  const registryModule = await importDist(root, 'packages/main/dist/core/runtime-fact-registry.js');
  const checksModule = await importDist(root, 'packages/main/dist/core/runtime-environment-checks.js');
  const doctorModule = await importDist(root, 'packages/main/dist/handlers/doctor.js');
  const storeModule = await importDist(root, 'packages/main/dist/core/store.js');
  const configModule = await importDist(root, 'packages/main/dist/core/config.js');

  if (registryModule) {
    const registry = registryModule.RUNTIME_FACT_REGISTRY ?? [];
    const ids = new Set(registry.map((entry) => entry.id));
    const outputKeys = new Set(registry.map((entry) => entry.outputKey));
    for (const [id, outputKey] of requiredFacts) {
      check(ids.has(id), `missing runtime fact: ${id}`);
      check(outputKeys.has(outputKey), `missing runtime output key: ${outputKey}`);
      const entry = registry.find((candidate) => candidate.id === id);
      check(Boolean(entry?.checker), `runtime fact ${id} missing checker`);
      check(Boolean(entry?.rationale), `runtime fact ${id} missing rationale`);
      check(Boolean(entry?.driftMessage), `runtime fact ${id} missing drift message`);
      check(Boolean(entry?.selfSeverity), `runtime fact ${id} missing selfSeverity`);
      check(Boolean(entry?.externalSeverity), `runtime fact ${id} missing externalSeverity`);
      check(checksSource.includes(`case '${entry?.checker}'`), `runtime checker not wired: ${entry?.checker} for ${id}`);
    }
  }

  if (configModule) {
    const legacyOnlyRoot = mkdtempSync(join(tmpdir(), 'lattice-config-negative-'));
    try {
      writeFileSync(join(legacyOnlyRoot, 'koala.config.json'), JSON.stringify({
        scanRoot: 'legacy-only-src',
        validate: {
          command: 'node -e "process.stdout.write(\\"legacy\\")"',
        },
      }));
      configModule.resetConfigCache?.();
      const legacyOnlyConfig = configModule.loadConfig(legacyOnlyRoot);
      check(legacyOnlyConfig.scanRoot !== 'legacy-only-src', 'koala.config.json must not be read as an active config fallback');
      check(!legacyOnlyConfig.validate, 'koala.config.json validate commands must not be read as active config');

      writeFileSync(join(legacyOnlyRoot, 'lattice.config.json'), JSON.stringify({
        scanRoot: 'lattice-src',
        validate: {
          command: 'node -e "process.stdout.write(\\"lattice\\")"',
        },
      }));
      configModule.resetConfigCache?.();
      const latticeConfig = configModule.loadConfig(legacyOnlyRoot);
      check(latticeConfig.scanRoot === 'lattice-src', 'lattice.config.json must remain the active config source');
      check(latticeConfig.validate?.command?.includes('lattice'), 'lattice.config.json validate command must load');
    } finally {
      rmSync(legacyOnlyRoot, { recursive: true, force: true });
      configModule.resetConfigCache?.();
    }
  }

  const tmp = mkdtempSync(join(tmpdir(), 'lattice-runtime-fact-contract-'));
  try {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({
      name: 'runtime-contract-smoke',
      version: '1.0.0',
      scripts: { test: 'node -e "process.stdout.write(\\"ok\\")"' },
    }));
    writeFileSync(join(tmp, 'lattice.config.json'), JSON.stringify({
      validate: {
        command: 'node -e "process.stdout.write(\\"configured\\")"',
      },
    }));
    execFileSync('git', ['init'], { cwd: tmp, stdio: ['ignore', 'ignore', 'ignore'] });

    if (checksModule) {
      const report = checksModule.runRuntimeEnvironmentChecks(tmp, {
        commandResolver: () => null,
        globalNpmRootResolver: () => null,
      });
      for (const [id, outputKey] of requiredFacts) {
        check(report[outputKey]?.id === id, `missing runtime output key: ${outputKey}`);
      }
      check(report.externalReferencePolicy.connectivityChecked === false, 'external-reference-policy must not claim connectivity pass');
      check(report.externalReferencePolicy.actual.policy === 'reference-only', 'external-reference-policy should be policy-only');
      check(report.projectLocalBin.status === 'pass', 'project-local-bin should pass when no project-local bin exists');
      check(report.projectLocalBin.actual.present === false, 'project-local-bin should record absent local bin');
      check(report.cliEntrypoint.expected === 'lattice executable on PATH', 'cli-entrypoint expected text should be lattice-only');
      check((report.cliEntrypoint.warnings ?? []).some((warning) => warning.includes('lattice') && !warning.includes('koala')), 'missing CLI warning should mention lattice only');

      const pathBinDir = join(tmp, 'path-bin');
      mkdirSync(pathBinDir, { recursive: true });
      const latticeBin = join(pathBinDir, process.platform === 'win32' ? 'lattice.cmd' : 'lattice');
      writeFileSync(latticeBin, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n');
      if (process.platform !== 'win32') chmodSync(latticeBin, 0o755);
      const oldPath = process.env.PATH;
      const oldWindowsPath = process.env.Path;
      try {
        process.env.PATH = pathBinDir;
        if (process.platform === 'win32') process.env.Path = pathBinDir;
        const latticeOnlyPathReport = checksModule.runRuntimeEnvironmentChecks(tmp, {
          globalNpmRootResolver: () => null,
        });
        check(latticeOnlyPathReport.cliEntrypoint.status === 'pass', 'cli-entrypoint should pass when PATH exposes lattice only');
        check(latticeOnlyPathReport.cliEntrypoint.actual.path === latticeBin, 'cli-entrypoint should resolve lattice before any legacy koala fallback');
        check(!existsSync(join(pathBinDir, process.platform === 'win32' ? 'koala.cmd' : 'koala')), 'lattice-only PATH smoke should not create a koala binary');
      } finally {
        if (oldPath === undefined) delete process.env.PATH;
        else process.env.PATH = oldPath;
        if (oldWindowsPath === undefined) delete process.env.Path;
        else process.env.Path = oldWindowsPath;
      }

      const staleKoalaName = process.platform === 'win32' ? 'koala.cmd' : 'koala';
      const localBinDir = join(tmp, 'node_modules', '.bin');
      const staleKoalaBin = join(localBinDir, staleKoalaName);
      mkdirSync(localBinDir, { recursive: true });
      writeFileSync(staleKoalaBin, 'local koala');
      const staleKoalaReport = checksModule.runRuntimeEnvironmentChecks(tmp, {
        commandResolver: () => null,
        globalNpmRootResolver: () => null,
      });
      check(staleKoalaReport.projectLocalBin.status === 'pass', 'project-local-bin should ignore stale koala-only local bin');
      check(staleKoalaReport.projectLocalBin.actual.path.endsWith(process.platform === 'win32' ? 'lattice.cmd' : 'lattice'), 'project-local-bin should inspect lattice path only');
      check(staleKoalaReport.projectLocalBin.actual.present === false, 'project-local-bin should not count koala-only local bin as present');

      const localBinName = process.platform === 'win32' ? 'lattice.cmd' : 'lattice';
      const localBin = join(localBinDir, localBinName);
      writeFileSync(localBin, 'local lattice');
      const matchingLocalBinReport = checksModule.runRuntimeEnvironmentChecks(tmp, {
        commandResolver: () => localBin,
        globalNpmRootResolver: () => null,
      });
      check(matchingLocalBinReport.projectLocalBin.status === 'pass', 'project-local-bin should pass when local bin realpath equals active CLI realpath');
      check(matchingLocalBinReport.projectLocalBin.actual.matchesEntrypoint === true, 'project-local-bin should record matching local bin realpath');
      check(matchingLocalBinReport.projectLocalBin.actual.shadowsEntrypoint === false, 'project-local-bin should not shadow when realpaths match');

      const activeCli = join(tmp, 'active-lattice');
      writeFileSync(activeCli, 'active lattice');
      const mismatchedLocalBinReport = checksModule.runRuntimeEnvironmentChecks(tmp, {
        commandResolver: () => activeCli,
        globalNpmRootResolver: () => null,
      });
      check(mismatchedLocalBinReport.projectLocalBin.status !== 'pass', 'project-local-bin should warn or fail when local bin resolves differently from active CLI');
      check(mismatchedLocalBinReport.projectLocalBin.actual.matchesEntrypoint === false, 'project-local-bin should record mismatched local bin realpath');
      check(mismatchedLocalBinReport.projectLocalBin.actual.shadowsEntrypoint === true, 'project-local-bin should shadow when realpaths differ');
      check((mismatchedLocalBinReport.projectLocalBin.warnings ?? []).some((warning) => warning.includes('resolves to')), 'project-local-bin mismatch should explain the local and active CLI targets');
    }

    if (doctorModule && storeModule) {
      // B-623a: keep this contract check hermetic and fast — doctor's advisory
      // burn scan would otherwise stream the real ~/.codex / ~/.claude stores.
      process.env.LATTICE_BURN_ALERT_RECENT_HOURS = '0';
      const doctor = doctorModule.createDoctorHandlers({
        root: tmp,
        scanRoot: tmp,
        store: new storeModule.StoryStore(tmp),
        log: () => {},
        getAllToolNames: () => new Set(),
      }).doctor;
      // B-623a: doctor() is async now (the advisory host burn scan awaits the
      // read-only store sweeps).
      const json = await doctor({ format: 'json' });
      check(Boolean(json.runtime), 'doctor JSON missing runtime section');
      for (const [id, outputKey] of requiredFacts) {
        check(json.runtime?.[outputKey]?.id === id, `doctor runtime missing output key: ${outputKey}`);
      }
      const text = await doctor();
      check(typeof text === 'string' && text.includes('Runtime scan:'), 'doctor text missing Runtime scan section');
      for (const [id] of requiredFacts) {
        check(text.includes(id), `doctor text Runtime scan missing runtime fact: ${id}`);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error('Runtime fact contract failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(`Runtime fact contract verified (${requiredFacts.map(([id]) => id).join(', ')})`);
}

main().catch((error) => {
  console.error('Runtime fact contract failed:');
  console.error(`- ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
