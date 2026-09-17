#!/usr/bin/env node
// Dependency audit gate: fails when any high/critical advisory is present in the
// root or any workspace, outside a documented allowlist. Run RED before a
// dependency-upgrade round to prove the advisories exist, GREEN after the bump.
//
//   node scripts/audit-gate.mjs            # gate on high+critical (exit 1 if any)
//   node scripts/audit-gate.mjs --json     # machine-readable aggregate
//
// Allowlist entries are advisories with no available fix that are build-only
// devtools; each must carry a reason so the exception stays auditable.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const WORKSPACES = ['.', 'packages/main', 'packages/lab', 'packages/utils'];

const GATED_SEVERITIES = new Set(['high', 'critical']);

// Advisories accepted as known exceptions (no fix available). Keyed by package
// name; value documents why the exception is tolerated.
const ALLOWLIST = {
};

function auditWorkspace(ws) {
  const cwd = join(repoRoot, ws);
  let raw;
  try {
    raw = execFileSync('npm', ['audit', '--json'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    // npm audit exits non-zero when vulnerabilities exist; stdout still holds JSON.
    raw = err.stdout?.toString() ?? '';
  }
  if (!raw.trim()) return [];
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    return [];
  }
  const vulns = report.vulnerabilities ?? {};
  const rows = [];
  for (const [name, info] of Object.entries(vulns)) {
    const advisories = (info.via ?? [])
      .filter((v) => typeof v === 'object' && v.title)
      .map((v) => ({ title: v.title, url: v.url, severity: v.severity }));
    rows.push({
      workspace: ws,
      name,
      severity: info.severity,
      fixAvailable: Boolean(info.fixAvailable),
      allowlisted: name in ALLOWLIST,
      advisories,
    });
  }
  return rows;
}

const jsonMode = process.argv.includes('--json');

const all = WORKSPACES.flatMap(auditWorkspace);
const gated = all.filter((r) => GATED_SEVERITIES.has(r.severity) && !r.allowlisted);
const allowlistedHits = all.filter((r) => r.allowlisted);

if (jsonMode) {
  console.log(JSON.stringify({ gatedCount: gated.length, gated, allowlisted: allowlistedHits, all }, null, 2));
} else {
  const counts = all.reduce((acc, r) => ((acc[r.severity] = (acc[r.severity] ?? 0) + 1), acc), {});
  console.log('Dependency audit gate (high+critical block; allowlist exempt)');
  console.log('Severity totals:', JSON.stringify(counts));
  if (gated.length === 0) {
    console.log('\n✓ No gated (high/critical) advisories outside the allowlist.');
  } else {
    console.log(`\n✗ ${gated.length} gated advisory package(s):\n`);
    for (const r of gated) {
      console.log(`  [${r.severity}] ${r.name}  (${r.workspace})  fixAvailable=${r.fixAvailable}`);
      for (const a of r.advisories) {
        console.log(`      - ${a.title}${a.url ? ' — ' + a.url : ''}`);
      }
    }
  }
  if (allowlistedHits.length) {
    console.log('\nAllowlisted (accepted, not gated):');
    for (const r of allowlistedHits) {
      console.log(`  [${r.severity}] ${r.name} — ${ALLOWLIST[r.name]}`);
    }
  }
}

process.exit(gated.length === 0 ? 0 : 1);
