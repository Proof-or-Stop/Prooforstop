#!/usr/bin/env node

// N7 (old-PoS v4.1 cost plan): every managed Codex worker request (lanes,
// critic, implementers, repair, scope/INIT/delivery reviewers) re-sent a fixed
// Codex prefix no role uses: the skills listing (~2.5 KB at the bench) and the
// multi-agent block (the "You are /root ... spawn_agent" developer text, the
// multi_agent_mode text and the `collaboration` tool, ~6.8 KB together). The
// multi-agent block comes from the model catalog (`multi_agent_version`), so a
// feature flag alone does not remove it (measured on Codex 0.154 against a
// recording Responses endpoint).
//
// Contract: a managed codex launch (fresh, resumed, contained and uncontained)
// passes `skills.include_instructions=false` and the multi-agent feature
// switches off, and, when the provider home's config names a model catalog
// whose models carry `multi_agent_version`, a derived catalog that differs
// only in `multi_agent_version: null`. Ordinary (non-managed) launches are
// unchanged; the original catalog is never modified.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as hostRun from '../core/host-run.js';

const MARKER = 'managed codex worker launch carries the skills / multi-agent prefix';

type Launch = { command: string; argv: string[] };
const materialize = hostRun.materializeHostRunLaunch as unknown as (
  args: Record<string, unknown>,
  env?: { platform: NodeJS.Platform; containerBoundaryPresent: boolean },
) => Launch;

function launchArgs(cwd: string, env: NodeJS.ProcessEnv, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    host: 'codex', model: 'deepseek-v4.1-flash', reasoningEffort: 'low',
    storyId: 'B-1234', agentType: 'proof-or-stop-implementer', phase: 'DEV',
    promptText: 'implement CHK-001', launchProfile: 'managed_dispatch',
    env, cwd, root: cwd, recordedAt: new Date().toISOString(), projectRootHash: 'sha256:x',
    ...extra,
  };
}

function configValues(argv: string[]): string[] {
  return argv.flatMap((arg, index) => (arg === '--config' || arg === '-c') && argv[index + 1] ? [argv[index + 1]!] : []);
}

function main(): void {
  const root = mkdtempSync(join(tmpdir(), 'managed-worker-codex-prefix-'));
  try {
    const cwd = join(root, 'work');
    mkdirSync(cwd, { recursive: true });
    const codexHome = join(root, 'codex-home');
    mkdirSync(codexHome, { recursive: true });
    const catalogPath = join(root, 'models.json');
    const catalog = { models: [
      { slug: 'deepseek-v4.1-flash', multi_agent_version: 'v2', include_skills_usage_instructions: false, base_instructions: 'You are Codex.', priority: 1 },
      { slug: 'other-model', multi_agent_version: 'v2', priority: 2 },
    ] };
    const catalogText = `${JSON.stringify(catalog, null, 2)}\n`;
    writeFileSync(catalogPath, catalogText);
    writeFileSync(join(codexHome, 'config.toml'), `model = "deepseek-v4.1-flash"\nmodel_catalog_json = ${JSON.stringify(catalogPath)}\n`);
    const env = { CODEX_HOME: codexHome };
    const container = { platform: 'linux' as NodeJS.Platform, containerBoundaryPresent: true };
    const darwin = { platform: 'darwin' as NodeJS.Platform, containerBoundaryPresent: false };

    const cases: Array<[string, Launch]> = [
      ['contained implementer', materialize(launchArgs(cwd, env), container)],
      ['contained implementer resume', materialize(launchArgs(cwd, env, { resumeSessionId: '019a0000-0000-7000-8000-00000000aaaa' }), container)],
      ['contained scope-plan reviewer', materialize(launchArgs(cwd, env, { agentType: 'proof-or-stop-review-scope-plan', phase: 'PLAN' }), container)],
      ['uncontained INIT reviewer', materialize(launchArgs(cwd, env, { agentType: 'proof-or-stop-review-story-init', phase: 'INIT' }), darwin)],
      ['managed review lane', materialize(launchArgs(cwd, env, { agentType: 'proof-or-stop-review-quality', phase: 'REVIEW', launchProfile: 'managed_reviewer', reviewRunId: 'B-1234:RR-001', lane: 'proof-or-stop-review-quality' }), container)],
      ['managed review lane resume', materialize(launchArgs(cwd, env, { agentType: 'proof-or-stop-review-quality', phase: 'REVIEW', launchProfile: 'managed_reviewer', reviewRunId: 'B-1234:RR-002', lane: 'proof-or-stop-review-quality', resumeSessionId: '019a0000-0000-7000-8000-00000000bbbb' }), container)],
    ];
    let derivedPath: string | null = null;
    for (const [label, launch] of cases) {
      const config = configValues(launch.argv);
      assert.ok(config.includes('skills.include_instructions=false'), `${MARKER}: ${label} keeps the skills listing (${launch.argv.join(' ')})`);
      assert.ok(config.includes('features.multi_agent=false'), `${MARKER}: ${label} keeps the multi-agent feature (${launch.argv.join(' ')})`);
      const catalogArg = config.find(value => value.startsWith('model_catalog_json='));
      assert.ok(catalogArg, `${MARKER}: ${label} keeps the catalog's multi_agent_version (no derived model_catalog_json): ${launch.argv.join(' ')}`);
      const path = JSON.parse(catalogArg!.slice('model_catalog_json='.length)) as string;
      derivedPath ??= path;
      assert.equal(path, derivedPath, `${label}: one derived catalog per source catalog content`);
      assert.equal(launch.argv.at(-1), '-', `${label}: the stdin prompt marker stays last`);
    }
    const derived = JSON.parse(readFileSync(derivedPath!, 'utf8')) as typeof catalog;
    assert.deepEqual(derived, { models: catalog.models.map(model => ({ ...model, multi_agent_version: null })) },
      'the derived catalog differs from the source only in multi_agent_version: null');
    assert.equal(readFileSync(catalogPath, 'utf8'), catalogText, 'the source catalog is never modified');

    // No catalog configured: the switches still apply, no catalog argument.
    const bareHome = join(root, 'bare-home');
    mkdirSync(bareHome, { recursive: true });
    const bare = materialize(launchArgs(cwd, { CODEX_HOME: bareHome }), container);
    assert.ok(configValues(bare.argv).includes('skills.include_instructions=false'), `${MARKER}: no catalog: skills switch still applies`);
    assert.ok(!configValues(bare.argv).some(value => value.startsWith('model_catalog_json=')), 'no catalog configured: no derived catalog');

    // A catalog without multi_agent_version needs no derived copy.
    const plainCatalog = join(root, 'plain-models.json');
    writeFileSync(plainCatalog, JSON.stringify({ models: [{ slug: 'deepseek-v4.1-flash', multi_agent_version: null }] }));
    const plainHome = join(root, 'plain-home');
    mkdirSync(plainHome, { recursive: true });
    writeFileSync(join(plainHome, 'config.toml'), `model_catalog_json = ${JSON.stringify(plainCatalog)}\n`);
    const plain = materialize(launchArgs(cwd, { CODEX_HOME: plainHome }), container);
    assert.ok(!configValues(plain.argv).some(value => value.startsWith('model_catalog_json=')), 'a catalog without multi_agent_version is used as is');

    // Ordinary host_run (no managed profile) is unchanged.
    const ordinary = materialize(launchArgs(cwd, env, { launchProfile: undefined, storyId: null, agentType: 'adhoc', phase: 'adhoc' }), container);
    assert.ok(!configValues(ordinary.argv).some(value => value.startsWith('skills.') || value.startsWith('features.') || value.startsWith('model_catalog_json=')),
      `ordinary host_run argv unchanged: ${ordinary.argv.join(' ')}`);
    console.log('managed-worker-codex-prefix-smoke: PASS');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main();
