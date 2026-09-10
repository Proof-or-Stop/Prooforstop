#!/usr/bin/env node

/*
 * DYN-5 repository runner.  The case registry points here instead of a
 * print-only command so every isolated shard reaches the same core signing and
 * assurance code used by the review/quorum smoke domains.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { validationChildEnvironment } from './validation-child-environment.mjs';

const [domain, caseId] = process.argv.slice(2);
if (!domain || !caseId) throw new Error('domain and caseId are required');

if (domain !== 'review-pass' && domain !== 'quorum') {
  throw new Error(`unsupported DYN-5 domain: ${domain}`);
}

const smoke = domain === 'review-pass'
  ? 'packages/main/dist/tasks/review-pass-discard-smoke.js'
  : 'packages/main/dist/tasks/quorum-submit-smoke.js';
const execution = spawnSync(process.execPath, [resolve(process.cwd(), smoke)], {
  cwd: process.cwd(),
  // Preserve the official tracer through the complete descendant closure and
  // pass only the finite, declared environment plus the selected DYN case.
  env: validationChildEnvironment({
    PROOF_OR_STOP_DYN5_CASE: caseId,
    PWD: process.cwd(),
  }),
  encoding: 'utf8',
  // Only the canonical timeout override controls active case execution.
  timeout: Number(process.env.PROOF_OR_STOP_VALIDATION_CASE_TIMEOUT_MS ?? 120000),
});
const output = `${execution.stdout || ''}${execution.stderr || ''}`;
const marker = `PROOF_OR_STOP_DOMAIN_CASE:${caseId}`;
if (execution.error || execution.status !== 0 || !output.includes(marker)) {
  throw new Error(`DYN-5 real ${domain} case failed: ${execution.error?.message || output || `exit ${execution.status}`}`);
}

process.stdout.write(`${marker}\n`);
