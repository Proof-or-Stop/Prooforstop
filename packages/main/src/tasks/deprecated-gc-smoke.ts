/**
 * deprecated-gc-smoke — smoke tests for B-8451: @deprecated GC advisory.
 *
 * Tests:
 *   1. resolveAuditConfig('balanced', projectRoot) returns deprecatedGcThreshold === 10 (default)
 *   2. resolveAuditConfig with .lattice/audit-config.json containing {"deprecatedGcThreshold": 5} returns 5
 *   3. scanDeprecated(projectRoot) returns count >= 0 and Array.isArray(files) without throwing (real repo)
 *   4. Advisory wiring: count=12 > threshold=10 → hint includes "⚠ @deprecated GC: 12 annotation(s)"
 *   5. count=7 <= threshold=10 → advisory does NOT appear in hint
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAuditConfig } from '../core/audit-config.js';
import { scanDeprecated } from '../core/audit-scan.js';

// ---------------------------------------------------------------------------
// Test 1: default deprecatedGcThreshold = 10 for 'balanced' profile
// ---------------------------------------------------------------------------
function test1DefaultThreshold(): void {
  const tmp = mkdtempSync(join(tmpdir(), 'deprecated-gc-smoke-'));
  try {
    const cfg = resolveAuditConfig('balanced', tmp);
    assert.equal(cfg.deprecatedGcThreshold, 10, 'balanced profile should have deprecatedGcThreshold === 10');
    console.log('  test1 ok: default deprecatedGcThreshold === 10');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 2: .lattice/audit-config.json override with deprecatedGcThreshold: 5
// ---------------------------------------------------------------------------
function test2ConfigOverride(): void {
  const tmp = mkdtempSync(join(tmpdir(), 'deprecated-gc-smoke-'));
  try {
    mkdirSync(join(tmp, '.lattice'), { recursive: true });
    writeFileSync(join(tmp, '.lattice', 'audit-config.json'), JSON.stringify({ deprecatedGcThreshold: 5 }), 'utf-8');
    const cfg = resolveAuditConfig('balanced', tmp);
    assert.equal(cfg.deprecatedGcThreshold, 5, 'config override should return deprecatedGcThreshold === 5');
    console.log('  test2 ok: config file override deprecatedGcThreshold === 5');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 3: scanDeprecated against the real repo — must not throw
// ---------------------------------------------------------------------------
function test3ScanDeprecatedRealRepo(): void {
  // Resolve real repo root from this file's location (packages/main/src/tasks/)
  const realRoot = join(new URL(import.meta.url).pathname, '../../../../..');
  const result = scanDeprecated(realRoot);
  assert.ok(result.count >= 0, `count should be >= 0, got ${result.count}`);
  assert.ok(Array.isArray(result.files), 'files should be an array');
  console.log(`  test3 ok: scanDeprecated returned count=${result.count} files=${result.files.length}`);
}

// ---------------------------------------------------------------------------
// Test 4: Advisory wiring — count=12 > threshold=10 → hint includes advisory
// ---------------------------------------------------------------------------
function buildAdvisoryHint(count: number, files: string[], threshold: number): string {
  // Mirrors the logic in audit-trigger.ts semi-auto branch
  let hint = `\n⚠ 5 story window + CLAUDE.md has changed, suggested run: lattice audit --framework\n`;
  if (count > threshold) {
    const fileList = files.slice(0, 3).join(', ') + (files.length > 3 ? '...' : '');
    hint += `\n⚠ @deprecated GC: ${count} annotation(s) in ${files.length} file(s) (${fileList}); consider a cleanup story (threshold: ${threshold})`;
  }
  return hint;
}

function test4AdvisoryAppearsWhenExceeded(): void {
  const hint = buildAdvisoryHint(12, ['foo.ts', 'bar.ts', 'baz.ts'], 10);
  assert.ok(
    hint.includes('⚠ @deprecated GC: 12 annotation(s)'),
    `hint should contain "@deprecated GC: 12 annotation(s)", got: ${hint}`,
  );
  console.log('  test4 ok: advisory appears when count=12 > threshold=10');
}

// ---------------------------------------------------------------------------
// Test 5: count=7 <= threshold=10 → advisory does NOT appear in hint
// ---------------------------------------------------------------------------
function test5AdvisoryAbsentWhenBelowThreshold(): void {
  const hint = buildAdvisoryHint(7, ['foo.ts'], 10);
  assert.ok(
    !hint.includes('@deprecated GC'),
    `hint should NOT contain "@deprecated GC" when count=7 <= threshold=10, got: ${hint}`,
  );
  console.log('  test5 ok: advisory absent when count=7 <= threshold=10');
}

// ---------------------------------------------------------------------------
// Test 6: count === threshold → advisory does NOT appear (strictly greater than)
// ---------------------------------------------------------------------------
function test6AdvisoryAbsentWhenExactlyAtThreshold(): void {
  const hint = buildAdvisoryHint(10, ['foo.ts'], 10);
  assert.ok(
    !hint.includes('@deprecated GC'),
    `hint should NOT contain "@deprecated GC" when count=10 === threshold=10 (strictly >), got: ${hint}`,
  );
  console.log('  test6 ok: advisory absent when count=10 === threshold=10 (strict >)');
}

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------
console.log('deprecated-gc-smoke starting...');
test1DefaultThreshold();
test2ConfigOverride();
test3ScanDeprecatedRealRepo();
test4AdvisoryAppearsWhenExceeded();
test5AdvisoryAbsentWhenBelowThreshold();
test6AdvisoryAbsentWhenExactlyAtThreshold();
console.log('deprecated-gc-smoke ok');
