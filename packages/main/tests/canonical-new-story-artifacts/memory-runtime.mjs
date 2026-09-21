


import assert from 'node:assert/strict';

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';



import ts from 'typescript';



import { check } from "./runner.mjs";
import { distRoot, repoRoot, fixtureRoots } from "./data.mjs";

export async function runCases() {
await check(['memory-identity'], 'CHK-007 finish-decision unsupported identity diagnostics reach the real DONE guard and oracle [CHK-007:adversarial:0] [CHK-007:edge:0]', () => {
  const result = spawnSync(process.execPath, [join(distRoot, 'tasks/dev-memory-lifecycle-gates-smoke.js'), '--finish-schema-only'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /finish-decision identity diagnostic smoke passed:/);
});

await check(['memory-identity'], 'normal memory selection excludes retired identities while audit bytes stay immutable', async () => {
  const memory = await import("../../dist/core/dev-memory.js");
  const runtime = await import("../../dist/core/playbook-runtime-memory.js");
  const cache = await import("../../dist/core/playbook-runtime-memory-cache.js");
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-memory-identity-'));
  fixtureRoots.push(root);
  const path = memory.resolveProjectMemoryPath(root);
  const input = { category: 'pattern', scope: 'project', sourceAgent: 'proof-or-stop-implementer',
    summary: 'Canonical memory identity example', trigger: 'memory fixture',
    lesson: 'Use proof-or-stop.config.json for memory configuration.', reusePrompt: 'Read the canonical memory example.' };
  const canonical = memory.createEntry(input);
  const retired = { ...canonical, id: 'retired1', lesson: `${['Proof', 'bound'].join('')} memory instruction` };
  mkdirSync(dirname(path), { recursive: true });
  const bytes = `${JSON.stringify(canonical)}\n${JSON.stringify(retired)}\n`;
  writeFileSync(path, bytes);
  assert.equal(memory.readEntries(path).length, 2, 'audit-only reader preserves both historical records');
  assert.deepEqual(memory.readProjectMemoryEntries(root).map(entry => entry.id), [canonical.id]);
  const pack = runtime.buildMemoryFreshnessPack({ projectRoot: root, query: 'memory', useIndex: false, useCache: false, maxPlaybooks: 0 });
  assert.equal(pack.items.devMemory.some(entry => entry.id === retired.id), false);
  assert.doesNotMatch(runtime.renderMemoryFreshnessPack(pack), /proofbound|lattice/iu);
  const tampered = structuredClone(pack);
  tampered.items.devMemory[0].lesson = retired.lesson;
  assert.doesNotMatch(runtime.renderMemoryFreshnessPack(tampered), /proofbound|lattice/iu,
    'a stale or tampered cached pack cannot bypass the final rendering boundary');
  const context = { projectRoot: root, schemaVersion: pack.schemaVersion, query: 'memory',
    consumer: 'session-brief', touchedPaths: [], maxEntries: 5, maxPlaybooks: 0, maxLines: 30 };
  cache.clearRuntimeMemoryPackCache();
  cache.rememberRuntimeMemoryPackCache(context, tampered);
  assert.equal(cache.getRuntimeMemoryPackCacheStats().entries, 0, 'retired pack is never cached');
  assert.equal(cache.getRuntimeMemoryPackCacheStats().durableWrites, 0, 'retired pack is never persisted');
  const key = cache.rememberRuntimeMemoryPackCache(context, pack);
  assert.equal(cache.getRuntimeMemoryPackCacheHit(context).hit, true, 'canonical pack cache still works');
  const { resolveLearningDir } = await import("../../dist/core/learning-store.js");
  const cachePath = join(resolveLearningDir(root), 'runtime-memory-pack-cache', `${key.lookupDigest}.json`);
  const stored = JSON.parse(readFileSync(cachePath, 'utf8'));
  stored.pack = tampered;
  const corruptBytes = `${JSON.stringify(stored)}\n`;
  writeFileSync(cachePath, corruptBytes);
  cache.clearRuntimeMemoryPackCache();
  assert.deepEqual(cache.getRuntimeMemoryPackCacheHit(context), { hit: false, reason: 'noncanonical-identity' },
    'a persisted retired pack never becomes a fresh cache hit');
  assert.equal(readFileSync(cachePath, 'utf8'), corruptBytes, 'rejecting a historical cache does not rewrite it');
  assert.equal(readFileSync(path, 'utf8'), bytes, 'selection/rendering never rewrites historical memory');
});

await check(['memory-identity'], 'new memory writers reject retired product tokens before filesystem mutation', async () => {
  const memory = await import("../../dist/core/dev-memory.js");
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-memory-writer-'));
  fixtureRoots.push(root);
  const path = join(root, 'absent', 'experience.jsonl');
  const input = { category: 'pattern', scope: 'project', sourceAgent: 'proof-or-stop-implementer',
    summary: 'Canonical memory identity example', trigger: 'memory fixture',
    lesson: 'A superlattice and proofboundless token is not the product identity.', reusePrompt: 'Read the canonical memory example.' };
  const canonical = memory.createEntry(input);
  for (const token of [['lat', 'tice.config.json'].join(''), ['PROOF', 'BOUND'].join('')]) {
    assert.throws(() => memory.createEntry({ ...input, lesson: `Use ${token} for memory.` }), /canonical.*identity|canonical.*identities/i);
    assert.throws(() => memory.appendEntry(path, { ...canonical, sourceAgent: token }), /canonical.*identity|canonical.*identities/i);
    assert.equal(existsSync(dirname(path)), false, 'rejected append must not create even a parent directory');
  }
  memory.appendEntry(path, canonical);
  assert.equal(memory.readEntries(path).length, 1, 'canonical identity and unrelated substrings remain writable');
});

await check(['runtime'], 'retired generated cache inventory is deny-only and never hides historical Story evidence', async () => {
  const registry = await import("../../dist/core/runtime-artifact-registry.js");
  const entry = registry.RUNTIME_ARTIFACT_REGISTRY.find(item => item.id === 'retired-generated-cache-deny-only');
  assert.ok(entry);
  const retiredRoot = '.' + ['lat', 'tice'].join('');
  const paths = [
    `${retiredRoot}/runtime/host-runs/probe.json`,
    `${retiredRoot}/learning/runtime-memory-pack-cache/probe.json`,
    `${retiredRoot}/runtime/framework-audit/state.json`,
    ...['finding-signals.json', 'playbook-promotion-health.jsonl', 'playbooks.json', 'signature-registry.json']
      .map(file => `${retiredRoot}/learning/${file}`),
  ];
  assert.equal(entry.ignorePatterns.length, 7);
  assert.equal(entry.repairableTrackedArtifact, false, 'deny-only is not a runtime repair/read alias');
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-cache-ignore-'));
  fixtureRoots.push(root);
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, '.gitignore'), entry.ignorePatterns.join('\n') + '\n');
  for (const path of paths) {
    assert.equal(registry.findRuntimeArtifactEntry(path)?.id, entry.id);
    assert.equal(spawnSync('git', ['check-ignore', '-q', path], { cwd: root }).status, 0, path);
  }
  for (const path of [`${retiredRoot}/story/actives/B-1234/index.json`, `${retiredRoot}/dev-memory/experience.jsonl`,
    `${retiredRoot}/learning/unclassified.json`, `${retiredRoot}/runtime/framework-audit/other.json`]) {
    assert.notEqual(registry.findRuntimeArtifactEntry(path)?.id, entry.id);
    assert.equal(spawnSync('git', ['check-ignore', '-q', path], { cwd: root }).status, 1, path);
  }
});

await check(['runtime'], 'causal receipt runtime classification does not admit a retired Story subtree', async () => {
  const registry = await import("../../dist/core/runtime-artifact-registry.js");
  const suffix = '/story/actives/B-1234/causal-evidence/receipt.json';
  const retiredPath = '.' + ['lat', 'tice'].join('') + suffix;
  assert.equal(registry.findRuntimeArtifactEntry(retiredPath), undefined);
  assert.equal(registry.isMaterialExcludedRuntimeArtifactPath(retiredPath), false);
  assert.equal(registry.isRepairableTrackedRuntimeArtifactPath(retiredPath), false);
  assert.equal(registry.findRuntimeArtifactEntry('.proof-or-stop' + suffix)?.id, 'runtime-causal-evidence-receipts');
});

await check(['runtime'], 'exact retired root imports are deny-only and cannot widen into current config or scratch authority', async () => {
  const registry = await import("../../dist/core/runtime-artifact-registry.js");
  const entry = registry.RUNTIME_ARTIFACT_REGISTRY.find(item => item.id === 'retired-root-import-residue-deny-only');
  assert.ok(entry);
  const retiredConfig = ['lat', 'tice.config.json'].join('');
  const scratchReadManifest = '.remember-scratch-readmanifest.json';
  assert.deepEqual(entry.ignorePatterns, [`/${retiredConfig}`, `/${scratchReadManifest}`]);
  assert.equal(entry.matchers.length, 2, 'root residue inventory stays exact rather than prefix-based');
  assert.equal(entry.materialHash, 'exclude');
  assert.equal(entry.repairableTrackedArtifact, false, 'deny-only roots are not runtime repair/read aliases');

  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-root-residue-ignore-'));
  fixtureRoots.push(root);
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, '.gitignore'), entry.ignorePatterns.join('\n') + '\n');
  for (const path of [retiredConfig, scratchReadManifest]) {
    assert.equal(registry.findRuntimeArtifactEntry(path)?.id, entry.id);
    assert.equal(spawnSync('git', ['check-ignore', '-q', path], { cwd: root }).status, 0, path);
  }
  for (const path of ['proof-or-stop.config.json', '.remember-scratch-other.json', `nested/${retiredConfig}`]) {
    assert.notEqual(registry.findRuntimeArtifactEntry(path)?.id, entry.id);
    assert.equal(spawnSync('git', ['check-ignore', '-q', path], { cwd: root }).status, 1, path);
  }
});

await check(['runtime'], 'canonical config changes force full validation while retired config drift remains conservative', async () => {
  const { classifyFullValidationReasons } = await import("../../dist/core/story-aware-validation.js");
  const reasonsFor = path => classifyFullValidationReasons({ scopeViolations: [], changedFiles: [{ path }] });
  assert.deepEqual(
    reasonsFor('proof-or-stop.config.json'),
    ['validation-runtime-changed:proof-or-stop.config.json'],
    'the active project config must never miss explicit full-validation escalation',
  );
  const retiredConfig = ['lat', 'tice.config.json'].join('');
  assert.deepEqual(
    reasonsFor(retiredConfig),
    [`validation-runtime-changed:${retiredConfig}`],
    'a retired config path remains a conservative invalidation input, not an accepted config reader',
  );
  assert.deepEqual(reasonsFor('docs/requirements/example.md'), []);
});

await check(['runtime'], 'audit scanners reject retired executable identity before canonical help, ignored commands, or deduplication', async () => {
  const auditUrl = new URL("../../dist/core/audit-scan.js", import.meta.url);
  const audit = await import(auditUrl.href);
  const retiredBin = 'lattice'; // Explicit negative input; never an executable alias.
  const assertRejected = scanner => {
    for (const method of ['scanCommandDrift', 'scanFlagDrift']) {
      for (const cmd of ['validate', 'help', 'init', 'audit_config_set']) {
        let calls = 0;
        const report = scanner[method](`${retiredBin} ${cmd} --json`, 'README.md', {
          runHelp: () => { calls += 1; return { ok: true, output: '--json' }; },
        });
        assert.equal(report.drifts.length, 1, `${method} must reject the retired bin even when the canonical command exists`);
        assert.equal(report.drifts[0].symbol, `${retiredBin} ${cmd}`);
        assert.match(report.drifts[0].evidence, /retired-bin/);
        assert.equal(calls, 0, 'retired identity is rejected before probing canonical help');
      }
      let calls = 0;
      const mixed = scanner[method](`proof-or-stop validate --json\n${retiredBin} validate --json`, 'README.md', {
        runHelp: () => { calls += 1; return { ok: true, output: '--json' }; },
      });
      assert.equal(mixed.drifts.length, 1, 'a prior canonical success cannot de-duplicate away retired identity');
      assert.equal(calls, 1);
      assert.equal(scanner[method]('proof-or-stop validate --json', 'README.md', {
        runHelp: () => ({ ok: true, output: '--json' }),
      }).drifts.length, 0, 'canonical positive remains accepted');
    }
  };
  assertRejected(audit);
  const source = readFileSync(auditUrl, 'utf8');
  const guard = 'bin === RETIRED_AUDIT_BIN_TOKEN';
  assert.equal(source.split(guard).length - 1, 2, 'both public scanners must guard retired identity');
  const mutantCode = source.replaceAll(guard, 'false')
    .replace(/(from\s+['"])(\.[^'"]+)(['"])/g, (_match, before, path, after) => `${before}${new URL(path, auditUrl).href}${after}`);
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(mutantCode).toString('base64')}`);
  assert.throws(() => assertRejected(mutant), /must reject the retired bin/,
    'removing the production identity guards must make the same rejection contract fail');
});
}
