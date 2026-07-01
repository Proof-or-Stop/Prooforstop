#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';

import {
  generatePlaybookRuntimeBaseline,
  verifyPlaybookRuntimeBaseline,
  type PlaybookRuntimeBaselineProfile,
} from '../core/playbook-runtime-baseline.js';

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const direct = process.argv.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function profileFromArgs(): PlaybookRuntimeBaselineProfile {
  const raw = argValue('--profile');
  return raw === 'full' ? 'full' : 'small';
}

async function run(): Promise<void> {
  const profile = profileFromArgs();
  const generated = generatePlaybookRuntimeBaseline({ profile });
  try {
    assert.equal(generated.manifest.authority, 'non_authoritative');
    assert.equal(generated.manifest.gateEvidence, false);
    assert.match(generated.manifest.manifestDigest, /^[0-9a-f]{64}$/);
    if (profile === 'full') {
      assert.equal(generated.manifest.recordCount, 1_000_000);
      assert.equal(generated.manifest.fullProfileExactMillion, true);
    }
    const verified = verifyPlaybookRuntimeBaseline({ inputDir: generated.outputDir });
    assert.equal(verified.status, 'pass');
    assert.equal(verified.authority, 'non_authoritative');
    assert.equal(verified.gateEvidence, false);
    assert.equal(verified.recordCount, generated.manifest.recordCount);
    assert.equal(verified.manifestDigestStable, true);
    assert.equal(verified.correctness.expectedIdsFoundRate, 1);
    assert.equal(verified.correctness.candidateFalseSurfaceRate, 0);
    assert.equal(verified.correctness.currentOverSupersededPreferenceRate, 1);
    console.log([
      'playbook-runtime-memory baseline smoke passed',
      `profile=${verified.profile}`,
      `recordCount=${verified.recordCount}`,
      `fullProfileExactMillion=${verified.fullProfileExactMillion}`,
      `elapsedMs=${verified.performance.elapsedMs}`,
      `peakRssBytes=${verified.performance.peakRssBytes}`,
    ].join(' '));
  } finally {
    if (existsSync(generated.outputDir)) rmSync(generated.outputDir, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});

