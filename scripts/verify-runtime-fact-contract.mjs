#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const failures = [];

const requiredFacts = [
  ['entrypoint-authority', 'runtimeEntrypointAuthority'],
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
  const cliEngineSource = read(root, 'packages/main/src/cli-engine.ts');
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
  check(registrySource.includes('@proof-or-stop/core'), 'runtime registry should name @proof-or-stop/core as canonical');
  check(!registrySource.includes('@proof-or-stop-agent/core'), 'runtime registry must not advertise retired @proof-or-stop-agent/core');
  check(!registrySource.includes('@koala-agent/core'), 'runtime registry must not advertise @koala-agent/core fallback');
  check(checksSource.includes("const CANONICAL_CORE_PACKAGE_NAME = '@proof-or-stop/core'"), 'runtime checks should resolve @proof-or-stop/core as canonical');
  check(!checksSource.includes('@proof-or-stop-agent/core'), 'runtime checks must not resolve retired @proof-or-stop-agent/core');
  check(!checksSource.includes('@koala-agent/core'), 'runtime checks must not resolve @koala-agent/core fallback');
  check(registrySource.includes('command -v proof-or-stop'), 'cli-entrypoint repair hint should use proof-or-stop');
  check(!registrySource.includes('command -v lattice || command -v koala'), 'cli-entrypoint repair hint must not include koala fallback');
  check(registrySource.includes('node_modules/.bin/proof-or-stop'), 'project-local-bin guidance should prefer proof-or-stop local bins');
  check(!registrySource.includes('node_modules/.bin/koala'), 'project-local-bin guidance must not include koala local bins');
  check(doctorSource.includes('runRuntimeEnvironmentChecks'), 'doctor should call runRuntimeEnvironmentChecks');
  check(doctorSource.includes('runtime,'), 'doctor JSON should expose runtime');
  check(doctorSource.includes('renderRuntimeEnvironmentReport'), 'doctor text should render runtime scan');
  check(checksSource.includes('stale_global_runtime_in_worktree'), 'runtime authority checker must expose the stable stale-global reason code');
  check(checksSource.includes('renderLocalEntrypointRecoveryCommand'), 'runtime authority checker must expose one canonical local recovery renderer');
  // B-cdf6:F-020 — the checker now reads BOTH brand spellings via readBrandEnv instead of a
  // raw `input.env?.PROOF_OR_STOP_CODEX_ENTRYPOINT` property access, so pinning the old literal
  // would fail on a correct implementation. The invariant this check exists to protect is
  // NARROWNESS: the exemption must still be bound to the exact 'global-fallback' value, not
  // widened to any truthy entrypoint. Assert that instead of a brand-specific spelling, so a
  // future brand change cannot break it again (same anti-pattern as F-015's three-way mirror).
  check(
    checksSource.includes("readBrandEnv('CODEX_ENTRYPOINT', input.env) === 'global-fallback'"),
    'runtime authority checker must narrowly bind the explicit global fallback',
  );
  check(checksSource.includes("input.command === 'session_brief'"), 'global fallback exemption must be session_brief-only');
  const authorityPreflight = cliEngineSource.indexOf('raw-argv-safe runtime authority preflight');
  check(authorityPreflight >= 0, 'CLI engine must declare the raw-argv-safe runtime authority preflight');
  for (const [label, needle] of [
    ['strict argument preflight', '\n  preflightStrictCommandArgsBeforeStoryReads(cmd, argv);'],
    ['standalone init', "\n  if (cmd === 'init')"],
    ['standalone dashboard', "\n  if (cmd === 'dashboard')"],
    ['tool lookup', '\n  const tool = TOOLS.find'],
    ['schema lookup', '\n  const schema = validationSchemaForCommand'],
  ]) {
    const downstream = cliEngineSource.indexOf(needle, authorityPreflight);
    check(downstream > authorityPreflight, `runtime authority preflight must run before ${label}`);
  }

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
    const legacyOnlyRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-config-negative-'));
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

      writeFileSync(join(legacyOnlyRoot, 'proof-or-stop.config.json'), JSON.stringify({
        scanRoot: 'proof-or-stop-src',
        validate: {
          command: 'node -e "process.stdout.write(\\"proof-or-stop\\")"',
        },
      }));
      configModule.resetConfigCache?.();
      const proofOrStopConfig = configModule.loadConfig(legacyOnlyRoot);
      check(proofOrStopConfig.scanRoot === 'proof-or-stop-src', 'proof-or-stop.config.json must remain the active config source');
      check(proofOrStopConfig.validate?.command?.includes('proof-or-stop'), 'proof-or-stop.config.json validate command must load');
    } finally {
      rmSync(legacyOnlyRoot, { recursive: true, force: true });
      configModule.resetConfigCache?.();
    }
  }

  const tmp = mkdtempSync(join(tmpdir(), 'proof-or-stop-runtime-fact-contract-'));
  try {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({
      name: 'runtime-contract-smoke',
      version: '1.0.0',
      scripts: { test: 'node -e "process.stdout.write(\\"ok\\")"' },
    }));
    writeFileSync(join(tmp, 'proof-or-stop.config.json'), JSON.stringify({
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
      check(report.cliEntrypoint.expected === 'proof-or-stop executable on PATH', 'cli-entrypoint expected text should be proof-or-stop-only');
      check((report.cliEntrypoint.warnings ?? []).some((warning) => warning.includes('proof-or-stop') && !warning.includes('koala')), 'missing CLI warning should mention proof-or-stop only');

      const pathBinDir = join(tmp, 'path-bin');
      mkdirSync(pathBinDir, { recursive: true });
      const proofOrStopBin = join(pathBinDir, process.platform === 'win32' ? 'proof-or-stop.cmd' : 'proof-or-stop');
      writeFileSync(proofOrStopBin, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n');
      if (process.platform !== 'win32') chmodSync(proofOrStopBin, 0o755);
      const oldPath = process.env.PATH;
      const oldWindowsPath = process.env.Path;
      try {
        process.env.PATH = pathBinDir;
        if (process.platform === 'win32') process.env.Path = pathBinDir;
        const proofOrStopOnlyPathReport = checksModule.runRuntimeEnvironmentChecks(tmp, {
          globalNpmRootResolver: () => null,
        });
        check(proofOrStopOnlyPathReport.cliEntrypoint.status === 'pass', 'cli-entrypoint should pass when PATH exposes proof-or-stop only');
        check(proofOrStopOnlyPathReport.cliEntrypoint.actual.path === proofOrStopBin, 'cli-entrypoint should resolve proof-or-stop before any legacy fallback');
        check(!existsSync(join(pathBinDir, process.platform === 'win32' ? 'koala.cmd' : 'koala')), 'proof-or-stop-only PATH smoke should not create a koala binary');
      } finally {
        if (oldPath === undefined) delete process.env.PATH;
        else process.env.PATH = oldPath;
        if (oldWindowsPath === undefined) delete process.env.Path;
        else process.env.Path = oldWindowsPath;
      }

      const staleLatticeName = process.platform === 'win32' ? 'lattice.cmd' : 'lattice';
      const localBinDir = join(tmp, 'node_modules', '.bin');
      const staleLatticeBin = join(localBinDir, staleLatticeName);
      mkdirSync(localBinDir, { recursive: true });
      writeFileSync(staleLatticeBin, 'local lattice');
      const staleKoalaReport = checksModule.runRuntimeEnvironmentChecks(tmp, {
        commandResolver: () => null,
        globalNpmRootResolver: () => null,
      });
      check(staleKoalaReport.projectLocalBin.status === 'pass', 'project-local-bin should ignore stale lattice-only local bin');
      check(staleKoalaReport.projectLocalBin.actual.path.endsWith(process.platform === 'win32' ? 'proof-or-stop.cmd' : 'proof-or-stop'), 'project-local-bin should inspect the canonical proof-or-stop path only');
      check(staleKoalaReport.projectLocalBin.actual.present === false, 'project-local-bin should not count a legacy lattice-only local bin as present');

      const localBinName = process.platform === 'win32' ? 'proof-or-stop.cmd' : 'proof-or-stop';
      const localBin = join(localBinDir, localBinName);
      writeFileSync(localBin, 'local proof-or-stop');
      const matchingLocalBinReport = checksModule.runRuntimeEnvironmentChecks(tmp, {
        commandResolver: () => localBin,
        globalNpmRootResolver: () => null,
      });
      check(matchingLocalBinReport.projectLocalBin.status === 'pass', 'project-local-bin should pass when local bin realpath equals active CLI realpath');
      check(matchingLocalBinReport.projectLocalBin.actual.matchesEntrypoint === true, 'project-local-bin should record matching local bin realpath');
      check(matchingLocalBinReport.projectLocalBin.actual.shadowsEntrypoint === false, 'project-local-bin should not shadow when realpaths match');

      const activeCli = join(tmp, 'active-proof-or-stop');
      writeFileSync(activeCli, 'active proof-or-stop');
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
      process.env.PROOF_OR_STOP_BURN_ALERT_RECENT_HOURS = '0';
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
