#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  check(doctorSource.includes('runRuntimeEnvironmentChecks'), 'doctor should call runRuntimeEnvironmentChecks');
  check(doctorSource.includes('runtime,'), 'doctor JSON should expose runtime');
  check(doctorSource.includes('renderRuntimeEnvironmentReport'), 'doctor text should render runtime scan');

  const registryModule = await importDist(root, 'packages/main/dist/core/runtime-fact-registry.js');
  const checksModule = await importDist(root, 'packages/main/dist/core/runtime-environment-checks.js');
  const doctorModule = await importDist(root, 'packages/main/dist/handlers/doctor.js');
  const storeModule = await importDist(root, 'packages/main/dist/core/store.js');

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

  const tmp = mkdtempSync(join(tmpdir(), 'koala-runtime-fact-contract-'));
  try {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({
      name: 'runtime-contract-smoke',
      version: '1.0.0',
      scripts: { test: 'node -e "process.stdout.write(\\"ok\\")"' },
    }));
    writeFileSync(join(tmp, 'koala.config.json'), JSON.stringify({
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

      const localBinName = process.platform === 'win32' ? 'koala.cmd' : 'koala';
      const localBinDir = join(tmp, 'node_modules', '.bin');
      const localBin = join(localBinDir, localBinName);
      mkdirSync(localBinDir, { recursive: true });
      writeFileSync(localBin, 'local koala');
      const matchingLocalBinReport = checksModule.runRuntimeEnvironmentChecks(tmp, {
        commandResolver: () => localBin,
        globalNpmRootResolver: () => null,
      });
      check(matchingLocalBinReport.projectLocalBin.status === 'pass', 'project-local-bin should pass when local bin realpath equals active CLI realpath');
      check(matchingLocalBinReport.projectLocalBin.actual.matchesEntrypoint === true, 'project-local-bin should record matching local bin realpath');
      check(matchingLocalBinReport.projectLocalBin.actual.shadowsEntrypoint === false, 'project-local-bin should not shadow when realpaths match');

      const activeCli = join(tmp, 'active-koala');
      writeFileSync(activeCli, 'active koala');
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
      const doctor = doctorModule.createDoctorHandlers({
        root: tmp,
        scanRoot: tmp,
        store: new storeModule.StoryStore(tmp),
        log: () => {},
        getAllToolNames: () => new Set(),
      }).doctor;
      const json = doctor({ format: 'json' });
      check(Boolean(json.runtime), 'doctor JSON missing runtime section');
      for (const [id, outputKey] of requiredFacts) {
        check(json.runtime?.[outputKey]?.id === id, `doctor runtime missing output key: ${outputKey}`);
      }
      const text = doctor();
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
