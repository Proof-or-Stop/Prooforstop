#!/usr/bin/env node
/**
 * B-ab8d CHK-001: logic smoke for the pure experiment arm context resolver
 * (core/experiment-arm.ts, M3 of the experience-layer ablation plan).
 *
 * Coverage (named `check:` lines; exits non-zero on any failure; prints
 * `experiment-arm smoke passed` at the very end):
 *   - Both vars valid -> { experimentId, arm } for control AND treatment,
 *     with surrounding whitespace trimmed; no warning emitted.
 *   - Neither var set -> null, silently (production mode, no warning).
 *   - Partial context (id only / arm only / whitespace-only counterpart)
 *     -> null + exactly one console.warn naming the ignored var.
 *   - Invalid arm value -> null + one console.warn naming control|treatment.
 *   - Empty / whitespace-only experimentId -> treated as unset.
 *   - Once-latch: repeated misconfigured resolution warns only once per
 *     process until resetExperimentArmWarnLatch() (test hook) is called.
 *   - Default env argument reads process.env.
 *
 * Pure logic test: no temp dirs, no fs, no story fixtures.
 */

import assert from 'node:assert/strict';

import {
  EXPERIMENT_ARM_ENV_VAR,
  EXPERIMENT_ID_ENV_VAR,
  resetExperimentArmWarnLatch,
  resolveExperimentArm,
} from '../core/experiment-arm.js';

let total = 0;
let passed = 0;
function check(label: string, fn: () => void): void {
  total += 1;
  try {
    fn();
    passed += 1;
    console.log(`check: ${label} — PASS`);
  } catch (err) {
    console.error(`check: ${label} — FAIL`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  }
}

/** Run fn with console.warn captured; returns the captured warning lines. */
function captureWarns(fn: () => void): string[] {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return warns;
}

check('both vars valid (control) -> context with trimmed values, no warning', () => {
  resetExperimentArmWarnLatch();
  const warns = captureWarns(() => {
    const ctx = resolveExperimentArm({
      [EXPERIMENT_ID_ENV_VAR]: '  exp-2026-07 ',
      [EXPERIMENT_ARM_ENV_VAR]: ' control ',
    });
    assert.deepEqual(ctx, { experimentId: 'exp-2026-07', arm: 'control' });
  });
  assert.equal(warns.length, 0);
});

check('both vars valid (treatment) -> context', () => {
  resetExperimentArmWarnLatch();
  const ctx = resolveExperimentArm({
    [EXPERIMENT_ID_ENV_VAR]: 'exp-a',
    [EXPERIMENT_ARM_ENV_VAR]: 'treatment',
  });
  assert.deepEqual(ctx, { experimentId: 'exp-a', arm: 'treatment' });
});

check('neither var set -> null, silently', () => {
  resetExperimentArmWarnLatch();
  const warns = captureWarns(() => {
    assert.equal(resolveExperimentArm({}), null);
  });
  assert.equal(warns.length, 0);
});

check('partial: id only -> null + warning naming the ignored id var', () => {
  resetExperimentArmWarnLatch();
  const warns = captureWarns(() => {
    assert.equal(resolveExperimentArm({ [EXPERIMENT_ID_ENV_VAR]: 'exp-a' }), null);
  });
  assert.equal(warns.length, 1);
  assert.match(warns[0], new RegExp(`ignoring ${EXPERIMENT_ID_ENV_VAR}`));
  assert.match(warns[0], new RegExp(`${EXPERIMENT_ARM_ENV_VAR} is missing`));
});

check('partial: arm only -> null + warning naming the ignored arm var', () => {
  resetExperimentArmWarnLatch();
  const warns = captureWarns(() => {
    assert.equal(resolveExperimentArm({ [EXPERIMENT_ARM_ENV_VAR]: 'control' }), null);
  });
  assert.equal(warns.length, 1);
  assert.match(warns[0], new RegExp(`ignoring ${EXPERIMENT_ARM_ENV_VAR}`));
  assert.match(warns[0], new RegExp(`${EXPERIMENT_ID_ENV_VAR} is missing`));
});

check('partial: valid id + whitespace-only arm -> arm treated as unset', () => {
  resetExperimentArmWarnLatch();
  const warns = captureWarns(() => {
    const ctx = resolveExperimentArm({
      [EXPERIMENT_ID_ENV_VAR]: 'exp-a',
      [EXPERIMENT_ARM_ENV_VAR]: '   ',
    });
    assert.equal(ctx, null);
  });
  assert.equal(warns.length, 1);
  assert.match(warns[0], new RegExp(`ignoring ${EXPERIMENT_ID_ENV_VAR}`));
});

check('invalid arm value -> null + warning naming control|treatment', () => {
  resetExperimentArmWarnLatch();
  const warns = captureWarns(() => {
    const ctx = resolveExperimentArm({
      [EXPERIMENT_ID_ENV_VAR]: 'exp-a',
      [EXPERIMENT_ARM_ENV_VAR]: 'CONTROL',
    });
    assert.equal(ctx, null);
  });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /control\|treatment/);
  assert.match(warns[0], /"CONTROL"/);
});

check('empty experimentId -> treated as unset (arm alone = partial warning)', () => {
  resetExperimentArmWarnLatch();
  const warns = captureWarns(() => {
    const ctx = resolveExperimentArm({
      [EXPERIMENT_ID_ENV_VAR]: '',
      [EXPERIMENT_ARM_ENV_VAR]: 'treatment',
    });
    assert.equal(ctx, null);
  });
  assert.equal(warns.length, 1);
  assert.match(warns[0], new RegExp(`ignoring ${EXPERIMENT_ARM_ENV_VAR}`));
});

check('whitespace-only experimentId + no arm -> fully unset, silent null', () => {
  resetExperimentArmWarnLatch();
  const warns = captureWarns(() => {
    assert.equal(resolveExperimentArm({ [EXPERIMENT_ID_ENV_VAR]: '  \t ' }), null);
  });
  assert.equal(warns.length, 0);
});

check('once-latch: repeated misconfigured calls warn exactly once', () => {
  resetExperimentArmWarnLatch();
  const warns = captureWarns(() => {
    resolveExperimentArm({ [EXPERIMENT_ID_ENV_VAR]: 'exp-a' });
    resolveExperimentArm({ [EXPERIMENT_ID_ENV_VAR]: 'exp-a' });
    resolveExperimentArm({
      [EXPERIMENT_ID_ENV_VAR]: 'exp-a',
      [EXPERIMENT_ARM_ENV_VAR]: 'bogus',
    });
  });
  assert.equal(warns.length, 1);
});

check('default env argument reads process.env', () => {
  resetExperimentArmWarnLatch();
  const prevId = process.env[EXPERIMENT_ID_ENV_VAR];
  const prevArm = process.env[EXPERIMENT_ARM_ENV_VAR];
  try {
    process.env[EXPERIMENT_ID_ENV_VAR] = 'exp-proc';
    process.env[EXPERIMENT_ARM_ENV_VAR] = 'control';
    assert.deepEqual(resolveExperimentArm(), { experimentId: 'exp-proc', arm: 'control' });
  } finally {
    if (prevId === undefined) delete process.env[EXPERIMENT_ID_ENV_VAR];
    else process.env[EXPERIMENT_ID_ENV_VAR] = prevId;
    if (prevArm === undefined) delete process.env[EXPERIMENT_ARM_ENV_VAR];
    else process.env[EXPERIMENT_ARM_ENV_VAR] = prevArm;
  }
});

console.log(`\n${passed}/${total} checks passed`);
if (passed === total) {
  console.log('experiment-arm smoke passed');
} else {
  process.exitCode = 1;
}
