#!/usr/bin/env node
/**
 * Lab project-verification-env: run 8 (2026-09-30) recorded evidence with
 * `CONTEXT=abs proof-or-stop verification_evidence_add ...` and then called
 * `proof-or-stop story_advance` without the prefix; every receipt was refused
 * as verification_receipt_stale (environment_digest_changed) and re-recording
 * could not help. The environment a project's tests need is project state:
 * `validate.env` in the PoS config must enter every validation/verification
 * environment, so execution and freshness agree whatever the caller's shell.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveValidationCommandEnvironment } from '../core/validation-command-environment.js';

const root = mkdtempSync(join(tmpdir(), 'project-verification-env-'));
writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({ validate: { env: { CONTEXT: 'abs' } } }));
mkdirSync(join(root, 'pkg'));
const withPrefix = effectiveValidationCommandEnvironment({ PATH: '/bin', CONTEXT: 'abs' }, undefined, root);
const without = effectiveValidationCommandEnvironment({ PATH: '/bin' }, undefined, root);
assert.deepEqual(without, withPrefix, `caller shell changes the verification environment: ${JSON.stringify({ without, withPrefix })}`);
assert.equal(effectiveValidationCommandEnvironment({ PATH: '/bin' }, undefined, join(root, 'pkg')).CONTEXT, 'abs', 'a subdirectory cwd finds the project config');
assert.equal(effectiveValidationCommandEnvironment({ PATH: '/bin', CONTEXT: 'other' }, undefined, root).CONTEXT, 'abs', 'the project value wins over an ambient value');
assert.equal(effectiveValidationCommandEnvironment({ PATH: '/bin' }, { CONTEXT: 'cmd' }, root).CONTEXT, 'cmd', 'an explicit command env still wins');
const bare = mkdtempSync(join(tmpdir(), 'project-verification-env-none-'));
assert.equal(effectiveValidationCommandEnvironment({ PATH: '/bin' }, undefined, bare).CONTEXT, undefined, 'no config, no change');
console.log('project-verification-env-smoke: PASS');
