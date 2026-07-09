#!/usr/bin/env node

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  canonicalReviewHostLauncherSpec,
  classifyHostExecutionReadiness,
  classifyReviewHostLauncher,
  type CanonicalReviewHost,
} from '../core/host-execution-readiness.js';
import {
  REVIEW_HOST_AVAILABILITY_CANONICAL_HOSTS,
  RETIRED_COMPLETION_FALSE_FIELDS,
  assessReviewHostAvailabilityForFallbackEligibility,
  probeReviewHostAvailability,
  reviewHostAvailabilityProbeRecordFromEvent,
} from '../core/review-escalation.js';
import type { ProcessEvent } from '../core/types.js';

const STORY_ID = 'B-review-host-readiness';
const MATERIAL = 'material-readiness-smoke';
const STORY_FILES_HASH = 'story-files-readiness-smoke';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body, 'utf8');
  chmodSync(path, 0o755);
}

function installFakeHosts(root: string, hosts: readonly CanonicalReviewHost[]): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const script = `#!/bin/sh
case " $* " in
  *" --version "*)
    echo "fake-host 1.0.0"
    exit 0
    ;;
  *" --help "*)
    echo "help probe is not readiness evidence" >&2
    exit 66
    ;;
  *READY*)
    echo "READY"
    exit 0
    ;;
esac
echo "unexpected readiness argv: $*" >&2
exit 64
`;
  for (const host of hosts) writeExecutable(join(bin, host), script);
  return bin;
}

function legacyVersionOnlyProbe(availableHosts: readonly CanonicalReviewHost[]): ProcessEvent {
  const available = new Set(availableHosts);
  return {
    type: 'review_host_availability_probe',
    command: 'review_host_availability_probe',
    timestamp: '2026-07-09T10:00:00.000Z',
    probeId: `${STORY_ID}:legacy`,
    checkedAt: '2026-07-09T10:00:00.000Z',
    materialHash: MATERIAL,
    storyFilesHash: STORY_FILES_HASH,
    hosts: REVIEW_HOST_AVAILABILITY_CANONICAL_HOSTS.map(host => ({
      host,
      command: host,
      ...(available.has(host) ? { executablePath: `/fake/bin/${host}` } : {}),
      versionOk: available.has(host),
      available: available.has(host),
    })),
    availableHostCount: availableHosts.length,
    unavailableHostCount: REVIEW_HOST_AVAILABILITY_CANONICAL_HOSTS.length - availableHosts.length,
  };
}

function readinessRow(host: CanonicalReviewHost, ready: boolean, overrides: Record<string, unknown> = {}) {
  const spec = canonicalReviewHostLauncherSpec(host);
  return {
    host,
    command: host,
    ...(ready ? { executablePath: `/fake/bin/${host}` } : {}),
    versionOk: ready,
    available: ready,
    launcher: spec.launcher,
    launcherArgv: spec.launcherArgv,
    launcherSupport: ready ? 'supported' : 'unverified',
    launcherOk: ready,
    executionReady: ready,
    reviewReady: ready,
    progressMode: spec.progressMode,
    failureKind: ready ? 'none' : 'missing_executable',
    durationMs: ready ? 9 : 0,
    ...(ready ? { firstProgressMs: 9, exitCode: 0 } : {}),
    remediation: ready ? '' : `Install or expose ${host} in PATH.`,
    ...overrides,
  };
}

function readinessProbe(rows: ReturnType<typeof readinessRow>[]): ProcessEvent {
  return {
    schemaVersion: 'lattice.review_host_availability_probe.v2',
    type: 'review_host_availability_probe',
    command: 'review_host_availability_probe',
    timestamp: '2026-07-09T10:01:00.000Z',
    probeId: `${STORY_ID}:readiness`,
    checkedAt: '2026-07-09T10:01:00.000Z',
    materialHash: MATERIAL,
    storyFilesHash: STORY_FILES_HASH,
    hosts: rows,
    availableHostCount: rows.filter(row => row.available).length,
    unavailableHostCount: REVIEW_HOST_AVAILABILITY_CANONICAL_HOSTS.length - rows.filter(row => row.available).length,
    executionReadyHostCount: rows.filter(row => row.executionReady).length,
    reviewReadyHostCount: rows.filter(row => row.reviewReady).length,
  };
}

const root = mkdtempSync(join(tmpdir(), 'review-host-readiness-'));
try {
  check('canonical Claude launcher is observable stream-json, plain --print is not progress-capable', () => {
    const spec = canonicalReviewHostLauncherSpec('claude');
    assert.equal(spec.launcher, 'claude --print --verbose --output-format=stream-json');
    assert.deepEqual(spec.launcherArgv, [
      'claude',
      '--print',
      '--verbose',
      '--output-format=stream-json',
      '<prompt-file>',
    ]);
    const canonical = classifyReviewHostLauncher('claude', spec.launcherArgv);
    assert.equal(canonical.launcherOk, true);
    assert.equal(canonical.progressMode, 'stream-json');

    const plain = classifyReviewHostLauncher('claude', ['claude', '--print', '<prompt-file>']);
    assert.equal(plain.launcherOk, false);
    assert.equal(plain.progressMode, 'bounded-final-output');
    assert.equal(plain.failureKind, 'silent_final_output');
    assert.match(plain.reasons.join('\n'), /--verbose/);
    assert.match(plain.reasons.join('\n'), /stream-json/);

    const splitOutputFormat = classifyReviewHostLauncher('claude', [
      'claude',
      '--print',
      '--verbose',
      '--output-format',
      'stream-json',
      '<prompt-file>',
    ]);
    assert.equal(splitOutputFormat.launcherOk, false);
    assert.equal(splitOutputFormat.launcherSupport, 'wrong_launcher');
    assert.match(splitOutputFormat.reasons.join('\n'), /canonical/);
  });

  check('agy --prompt-file is classified as the wrong launcher', () => {
    const wrong = classifyReviewHostLauncher('agy', ['agy', '--prompt-file', '<prompt-file>']);
    assert.equal(wrong.launcherOk, false);
    assert.equal(wrong.launcherSupport, 'wrong_launcher');
    assert.equal(wrong.failureKind, 'wrong_launcher');
    assert.match(wrong.reasons.join('\n'), /--prompt-file/);
  });

  check('codex exec auth/token invalidation is not review-ready', () => {
    const codex = classifyHostExecutionReadiness({
      host: 'codex',
      executablePath: '/fake/bin/codex',
      versionOk: true,
      durationMs: 37,
      exitCode: 1,
      result: {
        status: 1,
        signal: null,
        stdout: '',
        stderr: 'refresh_token_invalidated: please login again',
      },
    });
    assert.equal(codex.failureKind, 'auth');
    assert.equal(codex.executionReady, false);
    assert.equal(codex.reviewReady, false);
    assert.equal(codex.launcherSupport, 'unverified');
    assert.equal(codex.diagnostic, 'execution_failure:auth');
    assert.equal(codex.outputBytes, Buffer.byteLength('refresh_token_invalidated: please login again', 'utf8'));
    assert.match(codex.remediation, /Codex auth/);
    assert.doesNotMatch(JSON.stringify(codex), /refresh_token_invalidated|please login again/);
  });

  check('bounded probe checks launcher readiness with a smoke prompt', () => {
    const bin = installFakeHosts(root, ['codex', 'claude', 'agy']);
    const oldPath = process.env.PATH;
    process.env.PATH = [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter);
    try {
      const event = probeReviewHostAvailability({
        storyId: STORY_ID,
        materialHash: MATERIAL,
        storyFilesHash: STORY_FILES_HASH,
        cwd: root,
        timeoutMs: 1000,
      });
      assert.equal(event.executionReadyHostCount, 3);
      assert.equal(event.reviewReadyHostCount, 3);
      for (const row of event.hosts) {
        const spec = canonicalReviewHostLauncherSpec(row.host);
        assert.deepEqual(row.launcherArgv, spec.launcherArgv);
        assert.equal(row.launcherSupport, 'supported');
        assert.equal(row.failureKind, 'none');
        assert.equal(row.remediation, '');
      }
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  check('legacy version-only probe cannot satisfy non-human fallback readiness proof', () => {
    const legacy = legacyVersionOnlyProbe(['codex']);
    const record = reviewHostAvailabilityProbeRecordFromEvent(legacy, 0, MATERIAL, STORY_FILES_HASH);
    assert.equal(record.valid, false);
    assert.match(record.reasons.join('\n'), /reviewReadyHostCount|launcher/);
    assert.match(record.reasons.join('\n'), /retired completion flag must be false/);

    const assessment = assessReviewHostAvailabilityForFallbackEligibility(
      [legacy],
      'single-host-environment',
      MATERIAL,
      STORY_FILES_HASH,
    );
    assert.equal(assessment.ok, false);
    assert.match(assessment.reasons.join('\n'), /version-only|launcher readiness/);
  });

  check('wrong agy launcher row invalidates readiness probe evidence', () => {
    const rows = [
      readinessRow('codex', true),
      readinessRow('claude', false),
      readinessRow('agy', false, {
        launcher: 'agy --prompt-file',
        launcherArgv: ['agy', '--prompt-file', '<prompt-file>'],
        launcherSupport: 'wrong_launcher',
        failureKind: 'wrong_launcher',
        remediation: 'Use agy print mode with an explicit timeout.',
      }),
    ];
    const event = readinessProbe(rows);
    const record = reviewHostAvailabilityProbeRecordFromEvent(event, 0, MATERIAL, STORY_FILES_HASH);
    assert.equal(record.valid, false);
    assert.match(record.reasons.join('\n'), /agy.*launcherArgv.*--prompt-file|agy.*launcher must/);
  });

  check('v2 readiness probe may omit retired markers and still rejects forged marker values', () => {
    const event = readinessProbe([
      readinessRow('codex', true),
      readinessRow('claude', false),
      readinessRow('agy', false),
    ]);
    const record = reviewHostAvailabilityProbeRecordFromEvent(event, 0, MATERIAL, STORY_FILES_HASH);
    assert.equal(record.valid, true);
    assert.deepEqual(record.reasons, []);

    for (const forgedField of RETIRED_COMPLETION_FALSE_FIELDS) {
      const forged = { ...event, [forgedField]: true };
      const forgedRecord = reviewHostAvailabilityProbeRecordFromEvent(forged, 0, MATERIAL, STORY_FILES_HASH);
      assert.equal(forgedRecord.valid, false);
      assert.match(forgedRecord.reasons.join('\n'), /retired completion flag must be false when present/);
    }

    const wrongEventType = { ...event, type: 'dispatch' as const };
    const wrongTypeRecord = reviewHostAvailabilityProbeRecordFromEvent(wrongEventType, 0, MATERIAL, STORY_FILES_HASH);
    assert.equal(wrongTypeRecord.valid, false);
    assert.match(wrongTypeRecord.reasons.join('\n'), /retired completion flag must be false/);

    const wrongSchemaVersion = { ...event, schemaVersion: 'lattice.review_host_availability_probe.v1' };
    const wrongSchemaRecord = reviewHostAvailabilityProbeRecordFromEvent(wrongSchemaVersion, 0, MATERIAL, STORY_FILES_HASH);
    assert.equal(wrongSchemaRecord.valid, false);
    assert.match(wrongSchemaRecord.reasons.join('\n'), /retired completion flag must be false/);
  });

  check('two review-ready hosts block non-human degraded fallback', () => {
    const event = readinessProbe([
      readinessRow('codex', true),
      readinessRow('claude', true),
      readinessRow('agy', false),
    ]);
    const assessment = assessReviewHostAvailabilityForFallbackEligibility(
      [event],
      'temporary-host-unavailability',
      MATERIAL,
      STORY_FILES_HASH,
    );
    assert.equal(assessment.ok, false);
    assert.match(assessment.reasons.join('\n'), /reviewReadyHostCount=2\/3/);
  });

  console.log(`✓ review-host execution readiness smoke passed (${passed} checks)`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
