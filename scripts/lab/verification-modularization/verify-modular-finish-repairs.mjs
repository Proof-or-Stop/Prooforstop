// Focused Lab regression, not a new routine validation gate or Story receipt.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const base = 'scripts/lab/verification-modularization';
const probe = name => `${base}/finish-repair-probes/${name}.mjs`;
const cases = [
  ['workspace-cli-startup', [probe('workspace-wait')], 0, /WORKSPACE_WAIT_STARTUP_GREEN/],
  ['coordination-transitions', ['packages/main/tests/validation-coordination-residue.test.mjs'], 0, /COORDINATION_TRANSITION_GREEN/],
  ['audit-integration-preflight', ['scripts/verify-lab-audit-batches.mjs'], 0, /LAB_AUDIT_INTEGRATION_PREFLIGHT_GREEN/],
  ['static-ast-helper-reuse', ['scripts/verify-static-ast-reuse.mjs'], 0, /STATIC_AST_REUSE_GREEN/],
  ['modular-export-forms', [`${base}/verify-modular-static-closure.mjs`], 0, /MODULAR_STATIC_CLOSURE_GREEN/],
  ['merge-dependency-pins', [probe('merge-pins')], 0, /MERGE_PINS_PRESERVED/],
  ['u18-static-pass', ['scripts/verify-validation-static-edges.mjs'], 0, /U18_STATIC_PASS/],
  ['isolation-oracle', [probe('isolation-oracle')], 0, /ISOLATION_ORACLE_DISCRIMINATES/],
  ['process-completion-markers', [`${base}/verify-process-structure.mjs`], 0, /PROCESS_MODULAR_STRUCTURE_GREEN/],
  ['mutation-acceptance-controls', [`${base}/verify-mutation-rejection-integrity.mjs`], 0, /MUTATION_EVIDENCE_ACCEPTANCE_GREEN/],
  ['top-level-preservation', [`${base}/verify-modular-top-level-preservation.mjs`], 0, /MODULAR_TOP_LEVEL_PRESERVATION_GREEN/],
  ['process-prerequisite-diagnostic', [probe('process-prerequisite'), 'scripts/process-fact-contract/cli.mjs'], 0, /PROCESS_PREREQUISITE_DIAGNOSTIC_GREEN/],
  ['host-selected', ['packages/main/dist/tasks/host-run-usage-smoke.js', '--capability=evidence-mapping'], 0, /HOST_USAGE_PARTIAL_PASS/],
  ['ledger-selected', ['packages/main/dist/tasks/finding-ledger-runtime-smoke.js', '--capability=build-distribution'], 0, /FINDING_PARTIAL_PASS/],
  ['persistence-real', [probe('persistence-observer'), '--selected-observer'], 0, /LOCK_OBSERVER_SELECTED_CASE_ACCEPTED/],
  ['persistence-stale', [probe('persistence-observer'), '--stale-marker'], 1, /publication observation must belong to the measured CLI process/],
  ['managed-real', [probe('managed-import')], 0, /MANAGED_REVIEW_PARTIAL_PASS/],
  ['managed-duplicate', [probe('managed-import'), '--duplicate-creator'], 1, /2 !== 1/],
  ['planner-new-module', [probe('planner'), 'packages/main/src/tasks/validation-tier-planner/support.ts'], 0, /PLANNER_NEW_CAPABILITY_COVERAGE_PASS/],
  ['canonical-overlay', [probe('canonical-overlay'), 'packages/main/tests/canonical-new-story-artifacts/release.mjs'], 0, /CANONICAL_MODULE_OVERLAY_PASS/],
  ['direct-identity-api', [probe('identity-api')], 0, /IDENTITY_PUBLIC_API_COMPLETE/],
  ['archive-provenance', [probe('archive-provenance'), 'packages/main/tests/canonical-new-story-artifacts/migration-archive.mjs'], 0, /ARCHIVE_PROVENANCE_TABLE_PASS/],
  ['scanner-specific-oracle', [probe('scanner-oracle'), 'packages/main/tests/canonical-new-story-artifacts/identity-runtime-boundaries.mjs'], 0, /SCANNER_PIN_ORACLE_PASS/],
  ['foreign-entry-closure', [probe('foreign-entry'), 'scripts/identity-modular-child-closure.mjs'], 0, /FOREIGN_ENTRY_CLOSURE_PASS/],
  ['process-module-reader', [probe('process-module-reader'), 'scripts/process-fact-contract/review-verification.mjs'], 0, /PROCESS_MODULE_READER_PASS/],
  ['exact-source-bindings', [`${base}/verify-modular-identity-bindings.mjs`], 0, /MODULAR_IDENTITY_WITNESSES_GREEN/],
];
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 1 && args[0].startsWith('--case=')), 'Use no arguments or --case=<id>');
const selected = args.length ? cases.filter(row => row[0] === args[0].slice(7)) : cases;
assert(selected.length > 0, 'Unknown repair regression case');
const logs = mkdtempSync(join(tmpdir(), 'modular-finish-repair-proofs-'));
const results = [];
async function run([name, argv, expectedCode, marker]) {
  const started = Date.now();
  const child = spawn(process.execPath, argv, { cwd: process.cwd(), env: process.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', error, timedOut = false, overflow = false, forced;
  const signal = value => { try { if (process.platform === 'win32') child.kill(value); else process.kill(-child.pid, value); } catch (e) { if (e.code !== 'ESRCH') error ??= e.message; } };
  const abort = () => { signal('SIGTERM'); forced ??= setTimeout(() => signal('SIGKILL'), 2000); };
  const timer = setTimeout(() => { timedOut = true; abort(); }, 260000);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    if (overflow) return;
    output += chunk.toString();
    if (Buffer.byteLength(output) > 16 * 1024 * 1024) { overflow = true; abort(); }
  });
  const terminal = await new Promise(resolve => {
    child.once('error', e => { error = e.message; });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer); clearTimeout(forced);
  // A timed-out group must not retain descendants after a parent closes early.
  if (timedOut || overflow) signal('SIGKILL');
  const passed = !error && !timedOut && !overflow && terminal.signal === null && terminal.code === expectedCode && marker.test(output);
  const log = join(logs, name + '.log'); writeFileSync(log, output);
  const result = { name, passed, ...terminal, error, timedOut, overflow, elapsedMs: Date.now() - started, log };
  results.push(result); console.log('MODULAR_REPAIR_CASE ' + JSON.stringify(result));
  if (!passed) console.error(output.slice(-2500));
}
for (const row of selected) await run(row);
const inventory = JSON.parse(readFileSync(`${base}/verification-module-inventory.json`, 'utf8'));
for (const entry of inventory.entries) for (const module of entry.modules) {
  const actual = readFileSync(module.file, 'utf8').split(/\r?\n/).length - (readFileSync(module.file, 'utf8').endsWith('\n') ? 1 : 0);
  assert.equal(module.lines, actual, 'Module line inventory must match current source: ' + module.file);
  assert(actual <= 2000, 'Module exceeds the authorized 2000-line limit: ' + module.file);
}
const failed = results.filter(row => !row.passed);
writeFileSync(join(logs, 'results.json'), JSON.stringify({ root: resolve('.'), results }, null, 2) + '\n');
assert.equal(failed.length, 0, 'MODULAR_FINISH_REPAIRS_FAILED: ' + failed.map(row => row.name).join(', '));
console.log('MODULAR_FINISH_REPAIRS_GREEN ' + JSON.stringify({ cases: results.length, logs, routineGateAdded: false }));
