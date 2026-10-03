#!/usr/bin/env node
/**
 * Lab identity-pins: run 6 (2026-09-30) passed every reviewer gate and then
 * stopped at certification_window_begin because a lab change to
 * handlers/checklist.ts left its pinned executable digest stale
 * (review-inventory-epoch boundary). Every registered active identity boundary
 * must accept the emitted executable bytes of this build.
 */
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTIVE_IDENTITY_OPERATION_BOUNDARIES,
  assertCanonicalActiveIdentityBoundary,
} from '../core/runtime-environment-checks.js';

const runtimePackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const projectRoot = resolve(runtimePackageRoot, '..', '..');
const failures: string[] = [];
for (const boundary of ACTIVE_IDENTITY_OPERATION_BOUNDARIES) {
  try {
    assertCanonicalActiveIdentityBoundary({ boundaryId: boundary.id, runtimePackageRoot, projectRoot });
  } catch (error) {
    failures.push(`${boundary.id}: ${(error as Error).message}`);
  }
}
assert.deepEqual(failures, [], `stale active identity pins:\n${failures.join('\n')}`);
console.log(`identity-pins-smoke: PASS (${ACTIVE_IDENTITY_OPERATION_BOUNDARIES.length} boundaries)`);
