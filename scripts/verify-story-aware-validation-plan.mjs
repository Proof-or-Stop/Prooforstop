#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const path = 'docs/requirements/decisions/story-aware-dynamic-validation-execution-plan.md';
const navPath = 'docs/requirements/NAV.md';
const expectedSha256 = 'b197fb6cf90914edfb50df91affa7010148860818348b53e78759fd40bb26454';
const expectedBytes = 79749;
const requiredSelectors = [
  '# Story-Aware Dynamic Validation — Execution and Audit Plan',
  '## 1. Executive decision',
  '## 17. Implementation Stories',
  '### Story DYN-1 — Catalog and observe-only selection',
  '### Story DYN-2 — Per-command receipts and shadow reuse',
  '### Story DYN-3 — Low-risk dynamic authority',
  '### Story DYN-4 — Weighted/LPT scheduling',
  '### Story DYN-5 — Quorum and review-pass sharding',
  '## 19. Audit experiment design',
  '## 20. Mutation matrix',
  '## 24. Resolved pre-enforcement decisions',
  '## 27. Independent audit record and remediation trace',
  'DYN-1 observe-only',
  'DYN-3 dynamic TEST authority: GATED',
];
const tamperSelfTest = process.argv.length === 3 && process.argv[2] === '--tamper-self-test';

if (process.argv.length > 2 && !tamperSelfTest) {
  console.error('usage: node scripts/verify-story-aware-validation-plan.mjs [--tamper-self-test]');
  process.exit(2);
}

function exactPayloadBoundary(payload) {
  const sha256 = createHash('sha256').update(payload).digest('hex');
  return {
    bytes: payload.byteLength,
    sha256,
    sizeMatches: payload.byteLength === expectedBytes,
    digestMatches: sha256 === expectedSha256,
    ok: payload.byteLength === expectedBytes && sha256 === expectedSha256,
  };
}

const bytes = readFileSync(path);
const boundary = exactPayloadBoundary(bytes);
const text = bytes.toString('utf8');
const nav = readFileSync(navPath, 'utf8');
const missing = requiredSelectors.filter(selector => !text.includes(selector));
const navSelector = '[Story-Aware Dynamic Validation — Execution and Audit Plan](decisions/story-aware-dynamic-validation-execution-plan.md)';
if (!boundary.ok || missing.length > 0 || !nav.includes(navSelector)) {
  console.error(JSON.stringify({
    ok: false,
    path,
    bytes: boundary.bytes,
    expectedBytes,
    sha256: boundary.sha256,
    expectedSha256,
    missing,
    navSelectorPresent: nav.includes(navSelector),
  }, null, 2));
  process.exit(1);
}
if (statSync(path).size !== expectedBytes) process.exit(1);
console.log('story-aware validation plan integrity PASS');
console.log('  bytes: ' + boundary.bytes);
console.log('  sha256: ' + boundary.sha256);
console.log('  selectors: ' + requiredSelectors.length + '/' + requiredSelectors.length);

if (tamperSelfTest) {
  const tampered = Buffer.from(bytes);
  tampered[0] ^= 0x01;
  const tamperedBoundary = exactPayloadBoundary(tampered);
  if (
    tamperedBoundary.ok
    || !tamperedBoundary.sizeMatches
    || tamperedBoundary.digestMatches
    || tampered[0] === bytes[0]
  ) {
    console.error(JSON.stringify({
      ok: false,
      reason: 'tamper_self_test_boundary_failure',
      original: boundary,
      tampered: tamperedBoundary,
    }, null, 2));
    process.exit(1);
  }
  console.log('tamper self-test PASS');
}
