// Quality gate for the §6 injection-probes leaves. Runs each expected harness
// file with --self-test; reports N/6 PASS; exits 0 iff all 6 pass.
// Both experiment arms must satisfy this. Do NOT modify this file.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const EXPECTED = [
  'b1-modify-unrelated.mjs',
  'b2-break-architecture.mjs',
  'b6-dep-install-fail.mjs',
  'b9-delete-critical.mjs',
  'b11-high-risk-file.mjs',
  'b13-prod-deploy.mjs',
];

let pass = 0;
const rows = [];
for (const f of EXPECTED) {
  const p = join(here, f);
  if (!existsSync(p)) { rows.push(`MISSING ${f}`); continue; }
  try {
    const out = execFileSync('node', [p, '--self-test'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    rows.push(out.split('\n').pop());
    pass++;
  } catch (e) {
    const msg = (e.stdout || '') + (e.stderr || '') || e.message;
    rows.push(`FAIL ${f}: ${String(msg).trim().split('\n').pop()}`);
  }
}

console.log(rows.join('\n'));
console.log(`\n${pass}/${EXPECTED.length} PASS`);
process.exit(pass === EXPECTED.length ? 0 : 1);
