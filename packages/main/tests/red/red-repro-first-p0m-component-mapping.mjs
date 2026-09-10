#!/usr/bin/env node

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const RED_MARKER = 'RED P0m registry component mapping';
const UNAVAILABLE = 'registry-component-mapping-unavailable';

function expectUnavailable(fn, reason) {
  assert.throws(fn, error => error?.code === UNAVAILABLE && error?.reason === reason);
}

async function main() {
  const processModule = await import(pathToFileURL(new URL('../../dist/core/process-fact-registry.js', import.meta.url).pathname).href);
  const runtimeModule = await import(pathToFileURL(new URL('../../dist/core/runtime-fact-registry.js', import.meta.url).pathname).href);

  const projectProcess = processModule.projectProcessFactRegistry;
  const projectProcessComponent = processModule.projectComponentProcessFactMapping;
  const projectRuntime = runtimeModule.projectRuntimeFactRegistry;
  const projectRuntimeComponent = runtimeModule.projectComponentRuntimeFactMapping;
  assert.equal(typeof projectProcess, 'function');
  assert.equal(typeof projectProcessComponent, 'function');
  assert.equal(typeof projectRuntime, 'function');
  assert.equal(typeof projectRuntimeComponent, 'function');

  const processProjection = projectProcess();
  const runtimeProjection = projectRuntime();
  assert.equal(processProjection.length, processModule.PROCESS_FACT_REGISTRY.length);
  assert.equal(runtimeProjection.length, runtimeModule.RUNTIME_FACT_REGISTRY.length);
  assert(processProjection.every(entry => !Object.hasOwn(entry, 'generatedFrom')));
  assert(runtimeProjection.every(entry => !Object.hasOwn(entry, 'generatedFrom')));
  assert.deepEqual(processProjection.map(entry => entry.factId), processProjection.map(entry => entry.factId).toSorted());
  assert.deepEqual(runtimeProjection.map(entry => entry.runtimeFactId), runtimeProjection.map(entry => entry.runtimeFactId).toSorted());

  const processFixtures = [
    { factId: 'zeta', kind: 'artifact', paths: ['z/path.ts', './a//path.ts'], componentId: 'P0m' },
    { factId: 'alpha', kind: 'command', paths: ['b/path.ts'], componentId: 'P0m' },
  ];
  assert.deepEqual(projectProcess(processFixtures), [
    { factId: 'alpha', kind: 'command', paths: ['b/path.ts'], componentId: 'P0m' },
    { factId: 'zeta', kind: 'artifact', paths: ['a/path.ts', 'z/path.ts'], componentId: 'P0m' },
  ]);
  assert.deepEqual(projectProcessComponent('P0m', processFixtures), [
    { factId: 'alpha', componentId: 'P0m', path: 'b/path.ts' },
    { factId: 'zeta', componentId: 'P0m', path: 'a/path.ts' },
    { factId: 'zeta', componentId: 'P0m', path: 'z/path.ts' },
  ]);

  const runtimeFixtures = [
    { runtimeFactId: 'runtime-z', kind: 'environment-check', paths: ['z/path.ts'], componentId: 'P0m' },
    { runtimeFactId: 'runtime-a', kind: 'environment-check', paths: ['a/path.ts'], componentId: 'P0m' },
  ];
  assert.deepEqual(projectRuntimeComponent('P0m', runtimeFixtures), [
    { runtimeFactId: 'runtime-a', componentId: 'P0m', path: 'a/path.ts' },
    { runtimeFactId: 'runtime-z', componentId: 'P0m', path: 'z/path.ts' },
  ]);

  expectUnavailable(() => projectProcess([{ kind: 'artifact', paths: ['a.ts'] }]), 'process-missing');
  expectUnavailable(() => projectRuntime([{ kind: 'environment-check', paths: ['a.ts'] }]), 'runtime-missing');
  expectUnavailable(() => projectProcess([
    { factId: 'same', kind: 'artifact', paths: ['a.ts'] },
    { factId: 'same', kind: 'artifact', paths: ['b.ts'] },
  ]), 'process-ambiguous');
  expectUnavailable(() => projectRuntime([
    { runtimeFactId: 'same', kind: 'environment-check', paths: ['a.ts'] },
    { runtimeFactId: 'same', kind: 'environment-check', paths: ['b.ts'] },
  ]), 'runtime-ambiguous');
  expectUnavailable(() => projectProcess([{ factId: 'x', kind: 'artifact', paths: ['../escape.ts'] }]), 'process-non-total');
  expectUnavailable(() => projectRuntime([{ runtimeFactId: 'x', kind: 'environment-check', paths: [] }]), 'runtime-non-total');
  expectUnavailable(() => projectProcess([{ factId: 'x', kind: 'artifact', paths: ['packages/main/dist/x.js'], componentId: 'P0m' }]), 'process-generated-without-lineage');
  expectUnavailable(() => projectRuntime([{ runtimeFactId: 'x', kind: 'environment-check', paths: ['packages/main/dist/x.js'], componentId: 'P0m' }]), 'runtime-generated-without-lineage');

  const mutated = processFixtures.map(entry => ({ ...entry }));
  mutated[0] = { ...mutated[0], paths: ['changed.ts'] };
  assert.notDeepEqual(projectProcess(mutated), projectProcess(processFixtures));

  const concurrent = await Promise.all(Array.from({ length: 32 }, async () => JSON.stringify(projectProcess())));
  assert.equal(new Set(concurrent).size, 1);
  console.log('registry-component-mapping: registry=process unavailable=0');
  console.log('registry-component-mapping: registry=runtime unavailable=0');
  console.log('GREEN');
  console.log('mutation=PASS');
  console.log('concurrent-read=PASS');
}

main().catch(error => {
  console.error(`${RED_MARKER}: explicit deterministic registry projections are unavailable`);
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
