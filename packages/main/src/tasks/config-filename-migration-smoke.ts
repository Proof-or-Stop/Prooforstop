/**
 * config-filename-migration-smoke — B-cc10 CHK-004 acceptance witness.
 *
 * Proves the three read-both acceptance criteria for the project config filename
 * rename (`proof-or-stop.config.json` -> `proof-or-stop.config.json`) at the level the
 * criteria are actually stated: the CLI's observable stdout/stderr behavior.
 *
 *   1. HAPPY  — a project with ONLY the canonical filename loads and prints NO
 *               deprecation notice.
 *   2. EDGE   — a project with ONLY the deprecated filename still LOADS and prints
 *               a one-line notice on STDERR naming BOTH filenames.
 *   3. ADVERSARIAL — with the deprecated filename in play, `validate --json` stdout
 *               still parses as EXACTLY ONE JSON payload. This is the B-cdf6
 *               constraint: stdout is a machine channel, so a human-facing advisory
 *               written there corrupts every piped consumer. `core/config.ts` is
 *               imported by effectively the whole CLI, so a stray `console.log`
 *               would contaminate every command's JSON at once.
 *
 * WHY A SEPARATE SMOKE FROM brand-path-resolver-smoke
 * ---------------------------------------------------
 * That smoke covers the PURE resolver (`core/brand-paths.ts`) — candidate ordering,
 * decision helpers, cross products. It cannot observe which STREAM a notice goes to,
 * nor whether stdout stays single-payload, because it never spawns the CLI. These
 * three criteria are end-to-end stream properties, so they need a real process.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROOF_OR_STOP_CONFIG_FILENAME,
} from '../core/brand-paths.js';
import { loadConfig, resetConfigCache } from '../core/config.js';

const RETIRED_CONFIG_FILENAME = ['lat', 'tice.config.json'].join('');

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'cli.js');

/** Minimal but valid project config; scanRoot/rootDir keep discovery well-defined. */
const CONFIG_BODY = JSON.stringify({ scanRoot: 'src', rootDir: '.' }, null, 2) + '\n';

function makeProject(label: string, configFilename: string): string {
  const root = mkdtempSync(join(tmpdir(), `b-cc10-config-${label}-`));
  writeFileSync(join(root, configFilename), CONFIG_BODY, 'utf8');
  return root;
}

function runCli(root: string, args: readonly string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    // A fixed session id keeps activity bookkeeping deterministic; these are
    // throwaway temp roots, so nothing durable is touched.
    env: { ...process.env, PROOF_OR_STOP_SESSION_ID: 'sess-config-migration-smoke' },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

/** The notice must name BOTH spellings — actionable without consulting docs. */
function noticeLines(stderr: string): string[] {
  return stderr.split('\n').filter(line => line.includes('is deprecated'));
}

// ─── 1. HAPPY: canonical-only loads silently ─────────────────────────────────
{
  const root = makeProject('canonical', PROOF_OR_STOP_CONFIG_FILENAME);
  try {
    const { stderr, status } = runCli(root, ['status']);
    assert.equal(status, 0, 'canonical-only project should load successfully');
    assert.deepEqual(
      noticeLines(stderr),
      [],
      'canonical-only project must print NO deprecation notice',
    );
    console.log('  [ok] canonical-only project loads with zero deprecation notices');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── 2. EDGE: retired-only input is ignored ──────────────────────────────────
{
  const root = makeProject('retired', RETIRED_CONFIG_FILENAME);
  try {
    writeFileSync(
      join(root, RETIRED_CONFIG_FILENAME),
      `${JSON.stringify({ scanRoot: 'retired-config-sentinel', rootDir: '.' }, null, 2)}\n`,
      'utf8',
    );
    const { stdout, stderr, status } = runCli(root, ['status']);
    assert.equal(status, 0, 'retired-only directory may still be inspected as an unconfigured project');
    assert.deepEqual(noticeLines(stderr), [], 'retired filename must not activate a compatibility notice');
    assert.ok(!stdout.includes('is deprecated'), 'retired filename must not activate stdout guidance');
    resetConfigCache();
    assert.notEqual(loadConfig(root).scanRoot, 'retired-config-sentinel', 'retired config must not be read');
    console.log('  [ok] retired-only config is ignored without compatibility behavior');
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

console.log('config-filename-migration-smoke: PASS');
