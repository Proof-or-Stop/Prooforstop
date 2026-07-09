#!/usr/bin/env node

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
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

function shellSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function installFakeHosts(root: string, hosts: readonly CanonicalReviewHost[], argvLog: string): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const quotedArgvLog = shellSingleQuoted(argvLog);
  const script = `#!/bin/sh
argv_log=${quotedArgvLog}
case " $* " in
  *" --version "*)
    echo "fake-host 1.0.0"
    exit 0
    ;;
  *" --help "*)
    echo "help probe is not readiness evidence" >&2
    exit 66
    ;;
esac
has_ready=0
case "$*" in
  *READY*) has_ready=1 ;;
esac
if [ "$has_ready" -ne 1 ]; then
  for arg do
    if [ -f "$arg" ] && grep -q "READY" "$arg"; then
      has_ready=1
    fi
  done
fi
{
  printf 'host=%s\\n' "\${0##*/}"
  printf 'argc=%s\\n' "$#"
  i=0
  for arg do
    i=$((i + 1))
    printf 'arg%s=%s\\n' "$i" "$arg"
  done
  printf -- '---\\n'
} >> "$argv_log"
if [ "$has_ready" -eq 1 ]; then
  echo "READY"
  exit 0
fi
echo "unexpected readiness argv: $*" >&2
exit 64
`;
  for (const host of hosts) writeExecutable(join(bin, host), script);
  return bin;
}

function readCapturedLaunches(path: string): { host: string; argv: string[] }[] {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const launches: { host: string; argv: string[] }[] = [];
  let block = new Map<string, string>();
  function flush(): void {
    if (block.size === 0) return;
    const host = block.get('host') ?? '';
    const argc = Number(block.get('argc') ?? 0);
    const argv: string[] = [];
    for (let i = 1; i <= argc; i++) argv.push(block.get(`arg${i}`) ?? '');
    launches.push({ host, argv });
    block = new Map<string, string>();
  }
  for (const line of text.split('\n')) {
    if (line === '---') {
      flush();
      continue;
    }
    const separator = line.indexOf('=');
    if (separator > 0) block.set(line.slice(0, separator), line.slice(separator + 1));
  }
  flush();
  return launches;
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

    const observed = classifyHostExecutionReadiness({
      host: 'agy',
      executablePath: '/fake/bin/agy',
      versionOk: true,
      durationMs: 12,
      observedLauncherArgv: ['agy', '--prompt-file', '<prompt-file>'],
    });
    assert.equal(observed.launcherOk, false);
    assert.equal(observed.launcherSupport, 'wrong_launcher');
    assert.equal(observed.failureKind, 'wrong_launcher');
    assert.deepEqual(observed.launcherArgv, ['agy', '--prompt-file', '<prompt-file>']);
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
    const argvLog = join(root, 'readiness-argv.log');
    const bin = installFakeHosts(root, ['codex', 'claude', 'agy'], argvLog);
    const event = probeReviewHostAvailability({
      storyId: STORY_ID,
      materialHash: MATERIAL,
      storyFilesHash: STORY_FILES_HASH,
      cwd: root,
      env: {
        ...process.env,
        PATH: [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter),
      },
      timeoutMs: 1000,
    });
    assert.equal(event.executionReadyHostCount, 3);
    assert.equal(event.reviewReadyHostCount, 3);
    const launches = readCapturedLaunches(argvLog);
    assert.equal(launches.length, 3);
    for (const row of event.hosts) {
      const spec = canonicalReviewHostLauncherSpec(row.host);
      const launch = launches.find(candidate => candidate.host === row.host);
      assert.ok(launch, `${row.host} readiness launch should be captured`);
      assert.deepEqual(row.launcherArgv, [row.command, ...launch.argv]);
      assert.equal(row.launcherArgv.includes('<prompt>'), false);
      assert.equal(row.launcherArgv.includes('<prompt-file>'), false);
      if (row.host === 'claude') {
        const promptPath = row.launcherArgv[spec.launcherArgv.indexOf('<prompt-file>')];
        assert.ok(promptPath);
        assert.equal(isAbsolute(promptPath), true);
        assert.doesNotMatch(promptPath, /Reply READY/);
        assert.equal(existsSync(promptPath), false, 'Claude readiness prompt file should be cleaned up');
      } else {
        const prompt = row.launcherArgv[spec.launcherArgv.indexOf('<prompt>')];
        assert.match(prompt, /Reply READY and do not run tools/);
        assert.equal(prompt.length <= 128, true);
      }
      assert.equal(row.launcherSupport, 'supported');
      assert.equal(row.failureKind, 'none');
      assert.equal(row.remediation, '');
    }
    const record = reviewHostAvailabilityProbeRecordFromEvent(event as unknown as ProcessEvent, 0, MATERIAL, STORY_FILES_HASH);
    assert.equal(record.valid, true);
    assert.doesNotMatch(JSON.stringify(event), /"stdout"|"stderr"|fake-host 1\.0\.0|unexpected readiness argv/);
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
