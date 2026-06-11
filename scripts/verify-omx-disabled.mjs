#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function repoRoot(start) {
  let current = resolve(start);
  while (current !== dirname(current)) {
    try {
      readFileSync(join(current, 'packages/main/src/core/runtime-artifact-registry.ts'), 'utf8');
      return current;
    } catch {
      current = dirname(current);
    }
  }
  return resolve(start);
}

function importDist(root, relPath) {
  return import(pathToFileURL(join(root, relPath)).href);
}

function assertThrowsOmx(fn, label) {
  assert.throws(fn, /refuses to use disabled \.omx path/, `${label} should reject disabled .omx paths`);
}

const root = repoRoot(process.cwd());
const registrySource = readFileSync(join(root, 'packages/main/src/core/runtime-artifact-registry.ts'), 'utf8');
assert(!registrySource.includes("id: 'omx-runtime'"), 'runtime artifact registry must not contain omx-runtime');
assert(!registrySource.includes("ignorePatterns: ['.omx/']"), 'runtime artifact registry must not ignore .omx');

const registry = await importDist(root, 'packages/main/dist/core/runtime-artifact-registry.js');
assert.equal(registry.isRuntimeArtifactPath('.omx/state.json'), false, '.omx must not be a runtime artifact');
assert.equal(registry.isMaterialExcludedRuntimeArtifactPath('.omx/state.json'), false, '.omx must not be material-hash excluded');
assert.equal(registry.isForbiddenOmxPath('.omx/state.json'), true, '.omx must be recognized as forbidden');
assert.equal(registry.listRuntimeArtifactIgnorePatterns().includes('.omx/'), false, '.omx must not be emitted as a managed ignore');

const scenarioBaseline = await importDist(root, 'packages/main/dist/core/baseline.js');
const suiteReport = await importDist(root, 'packages/main/dist/core/baseline-suite-report.js');
const legacyBaseline = await importDist(root, 'packages/main/dist/core/lattice-baseline.js');

const temp = mkdtempSync(join(tmpdir(), 'lattice-omx-disabled-'));
try {
  assertThrowsOmx(
    () => scenarioBaseline.runBaseline(temp, {
      baselineId: 'NL-CLI-1',
      outputRoot: join(temp, '.omx', 'baseline'),
    }),
    'scenario baseline_run',
  );
  assertThrowsOmx(
    () => suiteReport.buildBaselineSuiteReport({
      root: temp,
      reports: join(temp, '.omx', 'baseline'),
      outputDir: join(temp, '.lattice', 'artifacts', 'baseline'),
    }),
    'baseline_suite_report reports path',
  );
  assertThrowsOmx(
    () => legacyBaseline.runBaseline({
      root: temp,
      baselineId: 'ENG-BUGFIX-1',
      artifactsRoot: join(temp, '.omx', 'legacy-baseline'),
    }),
    'legacy baseline_run',
  );
  assertThrowsOmx(
    () => legacyBaseline.evaluateCapabilityClaim({
      root: temp,
      target: 'engineering',
      writeReport: true,
      outputDir: join(temp, '.omx', 'claim'),
    }),
    'capability claim output',
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log('OMX disabled guard verified');
