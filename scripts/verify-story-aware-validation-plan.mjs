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

const bytes = readFileSync(path);
const digest = createHash('sha256').update(bytes).digest('hex');
const text = bytes.toString('utf8');
const nav = readFileSync(navPath, 'utf8');
const missing = requiredSelectors.filter(selector => !text.includes(selector));
const navSelector = '[Story-Aware Dynamic Validation — Execution and Audit Plan](decisions/story-aware-dynamic-validation-execution-plan.md)';
if (bytes.byteLength !== expectedBytes || digest !== expectedSha256 || missing.length > 0 || !nav.includes(navSelector)) {
  console.error(JSON.stringify({
    ok: false,
    path,
    bytes: bytes.byteLength,
    expectedBytes,
    sha256: digest,
    expectedSha256,
    missing,
    navSelectorPresent: nav.includes(navSelector),
  }, null, 2));
  process.exit(1);
}
if (statSync(path).size !== expectedBytes) process.exit(1);
console.log('story-aware validation plan integrity PASS');
console.log('  bytes: ' + bytes.byteLength);
console.log('  sha256: ' + digest);
console.log('  selectors: ' + requiredSelectors.length + '/' + requiredSelectors.length);
