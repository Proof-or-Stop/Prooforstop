#!/usr/bin/env node
/**
 * B-3f3d F-115 — coverage for the acceptance_basis_generate REVIEW widening.
 *
 * Commit 783dc6105e widened this command to REVIEW so a basis staleness-invalidated
 * by a scope-contract change could still be regenerated (PLAN is unreachable from
 * REVIEW; REPLAN belongs to DEV). That lifecycle-scope change shipped with no test
 * asserting it, which is what this file supplies.
 *
 * Both directions matter. Widening a gate is only safe if the widening is exactly as
 * wide as intended, so this asserts the phases that must be allowed AND the phases
 * that must still refuse.
 */
import { strict as assert } from 'node:assert';
import { getCommandLifecyclePolicy } from '../core/command-policy.js';
import { DEFAULT_PHASE_TOOLS } from '../core/config.js';

const policy = getCommandLifecyclePolicy('acceptance_basis_generate');
assert.ok(policy, 'acceptance_basis_generate is a registered command');

const allowed = policy.allowedPhases;
assert.ok(Array.isArray(allowed), 'acceptance_basis_generate pins an explicit phase list, not "all"');
const phases = allowed as string[];

for (const phase of ['PLAN', 'DEV', 'REVIEW']) {
  assert.ok(phases.includes(phase), `acceptance_basis_generate must be allowed in ${phase}`);
}
// The widening must not have leaked into terminal or pre-plan phases.
for (const phase of ['INIT', 'INIT_CHECK', 'TEST', 'DONE']) {
  assert.equal(phases.includes(phase), false,
    `acceptance_basis_generate must NOT be allowed in ${phase}; the REVIEW widening was scoped, not blanket`);
}

// allowedPhases alone is not sufficient: the phase tool list is a second, independent
// gate, and omitting the command there refuses it even when allowedPhases permits.
// That two-layer shape is exactly what made the original fix take two attempts.
const reviewTools = DEFAULT_PHASE_TOOLS['REVIEW'];
assert.ok(Array.isArray(reviewTools), 'REVIEW has a phase tool list');
assert.ok(reviewTools.includes('acceptance_basis_generate'),
  'REVIEW phaseTools must list acceptance_basis_generate, or allowedPhases alone silently fails');

console.log('Acceptance basis REVIEW-phase policy: PASS');
console.log(`  allowedPhases: ${phases.join(', ')}`);
console.log('  REVIEW phaseTools lists acceptance_basis_generate: true');
console.log('  refused in: INIT, INIT_CHECK, TEST, DONE');
