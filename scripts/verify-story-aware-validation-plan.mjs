#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const path = 'docs/requirements/decisions/story-aware-dynamic-validation-execution-plan.md';
const navPath = 'docs/requirements/NAV.md';
// Identity of the user-supplied source payload.  The current repository record
// has a narrowly scoped, audited amendment below; this value preserves the
// import boundary required by the original acceptance intent.
const approvedSourceSha256 = 'db16fccb5af01d296362e0d5e882e69922525b3341e5ce1a68376a352865c68a';
// The approved plan was amended with the signed-artifact admission boundary.
// Keep this exact byte identity beside the verifier so newline, Unicode, and
// payload-prefix drift fail closed instead of silently changing the contract.
const expectedSha256 = '1132853e574f3b28e4b7ba53bfb81717b4755d425f56e0ee268930b37970372c';
const expectedBytes = 80447;
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
console.log('approved source sha256: ' + approvedSourceSha256);
console.log('  bytes: ' + boundary.bytes);
console.log('  sha256: ' + boundary.sha256);
console.log('  selectors: ' + requiredSelectors.length + '/' + requiredSelectors.length);

if (tamperSelfTest) {
  const prefixMutation = Buffer.from(bytes);
  prefixMutation[0] ^= 0x01;
  const lineEndingMutation = Buffer.from(bytes.toString('utf8').replace(/\n/, '\r\n'), 'utf8');
  const unicodeMutation = Buffer.from(bytes.toString('utf8').replace('Story-Aware', 'Story-Aware\u0301'), 'utf8');
  const mutations = [
    ['payload-prefix', prefixMutation],
    ['line-ending', lineEndingMutation],
    ['unicode-normalization', unicodeMutation],
  ];
  const rejected = mutations.map(([name, payload]) => ({ name, boundary: exactPayloadBoundary(payload) }));
  if (rejected.some(({ boundary: candidate }) => candidate.ok || candidate.digestMatches)) {
    console.error(JSON.stringify({
      ok: false,
      reason: 'tamper_self_test_boundary_failure',
      original: boundary,
      rejected,
    }, null, 2));
    process.exit(1);
  }
  console.log('payload digest mismatch rejected: ' + rejected.map(({ name }) => name).join(', '));
  console.log('tamper self-test PASS');
}
