


import assert from 'node:assert/strict';


import { cpSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';


import { join } from 'node:path';



import ts from 'typescript';



import { distRoot, COMMAND_POLICIES, resolveEffectiveOwnershipClass, commandRequiresAuthoritativeRuntime, enforceStoryRuntimeAdmission, packageRoot, repoRoot } from "./data.mjs";
import { check } from "./runner.mjs";
import { createRuntimeFixture, snapshotRuntimeState, assertRuntimeFixtureUnchanged, assertRuntimeAuthoritativeStateUnchanged } from "./public-fixtures.mjs";
import { runCli } from "./fixture-support.mjs";
import { ensureRuntimeTopologyFixture, runtimeTopologyInput } from "./runtime-topology.mjs";

export function prepareExternalRuntimeProbe(fixture, ownership, enginePath = join(distRoot, 'cli-engine.js')) {
  const command = `b49df_extension_${ownership.toLowerCase()}_probe`;
  const entrypoint = join(fixture.root, 'extension-runtime-probe.mjs');
  const markers = Object.fromEntries(['registration', 'hook', 'handler'].map(stage => [stage, join(fixture.root, `extension-${stage}.txt`)]));
  const hookPath = join(fixture.root, 'extension-hook.mjs');
  writeFileSync(hookPath, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(markers.hook)}, 'hook reached');\n`);
  const configPath = join(fixture.root, 'proof-or-stop.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.hooks = { preCommand: { [command]: [`${JSON.stringify(process.execPath)} ${JSON.stringify(hookPath)}`] } };
  writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  writeFileSync(entrypoint, `
import { runCli } from ${JSON.stringify(enginePath)};
import { writeFileSync } from 'node:fs';
const name = ${JSON.stringify(command)};
const ownership = ${JSON.stringify(ownership)};
await runCli({
  extraTools: [{ name, description: 'Fresh F-105 runtime-admission extension witness', schema: {} }],
  extraOwnershipClasses: { [name]: ownership },
  extraAllowedPhases: { [name]: 'all' },
  extraRegister(registry) {
    if (ownership !== 'readOnly') writeFileSync(${JSON.stringify(markers.registration)}, ownership);
    registry.register(name, () => {
      if (ownership !== 'readOnly') writeFileSync(${JSON.stringify(markers.handler)}, ownership);
      return 'F105_EXTENSION_HANDLER_REACHED';
    });
  },
});
`);
  return { command, entrypoint, markers };
}

export async function runCases() {
for (const ownership of ['reviewerWrite', 'storyScopedMutating']) {
  await check(['runtime'], `F-105 foreign runtime rejects declared extension ${ownership} before all writes`, () => {
    const fixture = createRuntimeFixture();
    const probe = prepareExternalRuntimeProbe(fixture, ownership);
    const before = snapshotRuntimeState(fixture);
    const result = runCli(fixture.root, probe.command, {}, {}, { entrypoint: probe.entrypoint });
    const output = `${result.stdout}${result.stderr}`;
    // Report the genuine handler observation even when the broken admission
    // predicate makes the first assertion fail; do not replace it with a mock.
    assert.equal(result.status, 1, `${ownership} must refuse a foreign runtime before registration/hooks/handler: ${output}`);
    assert.match(output, /foreign_self_project_runtime_for_story_write/);
    assert.match(output, /node .*proof-or-stop|repair|local.*runtime/i);
    for (const [stage, path] of Object.entries(probe.markers)) assert.equal(existsSync(path), false, `${stage} ran before runtime refusal`);
    assertRuntimeFixtureUnchanged(fixture, before);
  });
}

await check(['runtime'], 'F-105 raw and final effective extension ownership share the authoritative predicate', async () => {
  const { resolveRawRuntimeAdmissionOwnership } = await import(join(distRoot, 'cli/ownership-gate.js'));
  const topology = ensureRuntimeTopologyFixture();
  for (const ownership of ['reviewerWrite', 'storyScopedMutating', 'readOnly']) {
    const command = `b49df_extension_${ownership.toLowerCase()}_probe`;
    const declarations = { [command]: ownership };
    assert.equal(Object.hasOwn(COMMAND_POLICIES, command), false, 'witness must not be a built-in command');
    const raw = resolveRawRuntimeAdmissionOwnership(command, ['{}'], declarations);
    const effective = resolveEffectiveOwnershipClass(command, {}, 'B-fixture', declarations);
    assert.equal(raw, ownership);
    assert.equal(effective, ownership);
    assert.equal(commandRequiresAuthoritativeRuntime(command, raw), ownership !== 'readOnly');
    const finalAdmission = () => enforceStoryRuntimeAdmission({
      ...runtimeTopologyInput(command, topology.main, topology.linked), effectiveOwnership: effective,
    });
    if (ownership === 'readOnly') assert.doesNotThrow(finalAdmission);
    else assert.throws(finalAdmission, /foreign_self_project_runtime_for_story_write/);
  }
});

await check(['runtime'], 'F-105 real extension writers remain usable in matching runtimes and external consumers', () => {
  for (const topology of ['matching', 'consumer']) {
    const fixture = createRuntimeFixture();
    let enginePath = join(distRoot, 'cli-engine.js');
    if (topology === 'matching') {
      cpSync(packageRoot, join(fixture.root, 'packages', 'main'), { recursive: true });
      cpSync(join(repoRoot, 'proof-or-stop.config.json'), join(fixture.root, 'proof-or-stop.config.json'));
      symlinkSync(join(repoRoot, 'node_modules'), join(fixture.root, 'node_modules'), 'dir');
      enginePath = join(fixture.root, 'packages', 'main', 'dist', 'cli-engine.js');
    } else {
      writeFileSync(join(fixture.root, 'package.json'), JSON.stringify({ name: 'f105-external-consumer', type: 'module' }));
      writeFileSync(join(fixture.root, 'packages', 'main', 'package.json'), JSON.stringify({ name: '@fixture/core', type: 'module' }));
    }
    for (const ownership of ['reviewerWrite', 'storyScopedMutating']) {
      const probe = prepareExternalRuntimeProbe(fixture, ownership, enginePath);
      for (const path of Object.values(probe.markers)) if (existsSync(path)) rmSync(path);
      const result = runCli(fixture.root, probe.command, {}, {}, { entrypoint: probe.entrypoint });
      assert.equal(result.status, 0, `${topology}/${ownership}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /F105_EXTENSION_HANDLER_REACHED/);
      for (const [stage, path] of Object.entries(probe.markers)) assert.ok(existsSync(path), `${topology}/${ownership}: ${stage} must be genuinely reached`);
    }
  }
});

await check(['runtime'], 'F-105 read-only extension remains available through a foreign runtime without writes', () => {
  const fixture = createRuntimeFixture();
  const probe = prepareExternalRuntimeProbe(fixture, 'readOnly');
  const before = snapshotRuntimeState(fixture);
  const result = runCli(fixture.root, probe.command, {}, {}, { entrypoint: probe.entrypoint });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /F105_EXTENSION_HANDLER_REACHED/);
  for (const path of Object.values(probe.markers)) assert.equal(existsSync(path), false, 'read-only extension must not run writing hooks or marker writes');
  assertRuntimeAuthoritativeStateUnchanged(fixture, before);
});
}
