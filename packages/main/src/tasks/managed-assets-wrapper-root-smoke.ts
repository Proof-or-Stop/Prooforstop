#!/usr/bin/env node

/**
 * Regression smoke for `lattice check` managed asset root diagnostics on a
 * wrapper-root layout:
 *
 *   metadataRoot/              <- not a git repo; Lattice metadata/assets live here
 *     lattice.config.json      <- { gitRoot: "repo" }
 *     .lattice/Lattice.md      <- managed asset path base
 *     repo/                    <- configured gitRoot subdir
 *
 * The contract is deliberately split:
 *   - check JSON/text reports metadataRoot, assetRoot, gitRoot, and the split.
 *   - relPath/applied/manifestPath stay relative to assetRoot.
 *   - check --apply writes managed assets under metadataRoot/assetRoot, not gitRoot.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderManagedAssetCheck } from '../core/managed-assets.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cliPath = join(packageRoot, 'dist', 'cli.js');

function runCli(cwd: string, args: string[]): string {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

function readJson(root: string, relPath: string): any {
  return JSON.parse(readFileSync(join(root, relPath), 'utf8'));
}

function assertExists(root: string, relPath: string, label = relPath): void {
  assert.equal(existsSync(join(root, relPath)), true, `${label} should exist`);
}

function assertMissing(root: string, relPath: string, label = relPath): void {
  assert.equal(existsSync(join(root, relPath)), false, `${label} should not exist`);
}

function assertIncludes(text: string, needle: string, label: string): void {
  assert.ok(text.includes(needle), `${label} missing "${needle}"`);
}

function assertGuidanceImmediatelyAfterSummary(text: string, label: string): void {
  const lines = text.split('\n');
  const summaryIndex = lines.findIndex(line => line.startsWith('Summary:'));
  assert.notEqual(summaryIndex, -1, `${label} should include Summary`);
  assert.equal(
    lines[summaryIndex + 1],
    'Paths: managed asset relPath/applied/manifestPath values are relative to assetRoot.',
    `${label} should render root guidance immediately after Summary`,
  );
}

const metadataRoot = mkdtempSync(join(tmpdir(), 'lattice-managed-assets-wrapper-root-'));
const gitRoot = join(metadataRoot, 'repo');

try {
  mkdirSync(gitRoot, { recursive: true });
  git(gitRoot, ['init']);
  runCli(packageRoot, ['init', metadataRoot]);

  const configPath = join(metadataRoot, 'lattice.config.json');
  const config = readJson(metadataRoot, 'lattice.config.json');
  writeFileSync(configPath, `${JSON.stringify({ ...config, gitRoot: 'repo' }, null, 2)}\n`);

  rmSync(join(metadataRoot, '.lattice', 'Lattice.md'), { force: true });
  mkdirSync(join(gitRoot, '.lattice'), { recursive: true });
  const gitRootSentinel = 'git-root sentinel: managed assets must not write here\n';
  writeFileSync(join(gitRoot, '.lattice', 'Lattice.md'), gitRootSentinel);

  const canonicalMetadataRoot = realpathSync(metadataRoot);
  const canonicalGitRoot = realpathSync(gitRoot);
  const checkJson = JSON.parse(runCli(metadataRoot, ['check', '--json']));

  assert.equal(checkJson.ok, false, 'check should report metadata-root managed asset drift');
  assert.equal(checkJson.metadataRoot, canonicalMetadataRoot, 'JSON metadataRoot');
  assert.equal(checkJson.assetRoot, canonicalMetadataRoot, 'JSON assetRoot');
  assert.equal(checkJson.gitRoot, canonicalGitRoot, 'JSON gitRoot');
  assert.equal(checkJson.pathsRelativeTo, 'assetRoot', 'JSON pathsRelativeTo');
  assert.equal(checkJson.assetRootGitRootSplit, true, 'JSON assetRoot/gitRoot split flag');
  assert.equal(checkJson.manifestPath, '.lattice/managed-assets.json', 'manifestPath remains assetRoot-relative');
  assert.ok(
    checkJson.items.some((item: any) => item.relPath === '.lattice/Lattice.md' && item.status === 'MISSING'),
    'check should evaluate relPath under metadataRoot/assetRoot, not gitRoot',
  );

  const driftText = renderManagedAssetCheck(checkJson);
  assertGuidanceImmediatelyAfterSummary(driftText, 'DRIFT text');
  assertIncludes(driftText, `metadataRoot: ${canonicalMetadataRoot}`, 'DRIFT text');
  assertIncludes(driftText, `assetRoot: ${canonicalMetadataRoot}`, 'DRIFT text');
  assertIncludes(
    driftText,
    `gitRoot: ${canonicalGitRoot} (separate from assetRoot; managed assets are not rooted here)`,
    'DRIFT text',
  );
  assert.ok(
    driftText.indexOf('Paths: managed asset relPath/applied/manifestPath values are relative to assetRoot.')
      < driftText.indexOf('Run `lattice check --apply`'),
    'DRIFT text should show root guidance before apply recommendations',
  );

  const applyJson = JSON.parse(runCli(metadataRoot, ['check', '--apply', '--json']));
  assert.equal(applyJson.ok, true, 'check --apply should repair safe metadata-root drift');
  assert.ok(
    applyJson.applied.includes('.lattice/Lattice.md'),
    'applied paths should remain assetRoot-relative',
  );
  assert.equal(applyJson.metadataRoot, canonicalMetadataRoot, 'apply JSON metadataRoot');
  assert.equal(applyJson.assetRoot, canonicalMetadataRoot, 'apply JSON assetRoot');
  assert.equal(applyJson.gitRoot, canonicalGitRoot, 'apply JSON gitRoot');
  assert.equal(applyJson.pathsRelativeTo, 'assetRoot', 'apply JSON pathsRelativeTo');
  assert.equal(applyJson.assetRootGitRootSplit, true, 'apply JSON split flag');
  assertExists(metadataRoot, '.lattice/Lattice.md', 'metadataRoot managed Lattice guide');
  assertExists(metadataRoot, '.lattice/managed-assets.json', 'metadataRoot managed manifest');
  assertMissing(gitRoot, '.lattice/managed-assets.json', 'gitRoot managed manifest');
  assert.equal(
    readFileSync(join(gitRoot, '.lattice', 'Lattice.md'), 'utf8'),
    gitRootSentinel,
    'check --apply should not write managed assets under configured gitRoot',
  );

  const okText = renderManagedAssetCheck(applyJson);
  assertGuidanceImmediatelyAfterSummary(okText, 'OK text');
  assertIncludes(okText, `gitRoot: ${canonicalGitRoot} (separate from assetRoot; managed assets are not rooted here)`, 'OK text');
  assert.ok(
    okText.indexOf('Paths: managed asset relPath/applied/manifestPath values are relative to assetRoot.')
      < okText.indexOf('Manifest: .lattice/managed-assets.json'),
    'OK text should show root guidance before manifest output',
  );

  console.log('managed-assets wrapper-root smoke passed');
} finally {
  rmSync(metadataRoot, { recursive: true, force: true });
}
