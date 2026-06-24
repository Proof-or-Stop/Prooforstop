#!/usr/bin/env node
// Fully offline, deterministic corpus self-check for the recovery-runner ablation corpus.
// No `claude -p`, no network, no live LLM. For every task directory under tasks/ it asserts:
//   1. Contract files exist + task.json is well-formed (taskId==dir, outputFile==='solution.mjs',
//      has a `type`).
//   2. Reference invariant: reference-solution.mjs => acceptance ACCEPT PASS (exit 0) AND
//      ground-truth GROUND-TRUTH PASS (exit 0).
//   3. Anti-gaming invariant: the CANONICAL inject() from subtle-wrong-output.mjs (works whether
//      the payload is a separate payload-subtle.mjs file or an inline string) =>
//      acceptance ACCEPT PASS (exit 0) AND ground-truth GROUND-TRUTH FAIL (exit !=0).
//   4. Stratification (pre-reg §2): total tasks === 24, exactly 8 distinct categories present
//      {bug-fix, feature, refactor, test-repair, doc-update, dep-upgrade, contract-validation,
//      CLI-feature}, each category count within [2,5] inclusive.
// Exit 0 only if ALL per-task invariants hold AND stratification holds; otherwise exit 1.
// Run: node experiments/recovery-runner/corpus-selfcheck.mjs   (defaults to ./tasks relative to here)
import {
  readdirSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = process.argv[2] ? process.argv[2] : join(here, 'tasks');

// Pre-reg §2 corpus spec.
const EXPECTED_TOTAL = 24;
const EXPECTED_CATEGORIES = [
  'bug-fix',
  'feature',
  'refactor',
  'test-repair',
  'doc-update',
  'dep-upgrade',
  'contract-validation',
  'CLI-feature',
];
const CAT_MIN = 2; // OQ-001: keep every category represented
const CAT_MAX = 5; // OQ-001: catch drift

// Always-present contract files. payload-subtle.mjs is intentionally NOT required here: some tasks
// (e.g. text-stats) carry an inline payload inside subtle-wrong-output.mjs rather than a separate
// payload file. The canonical inject() path below handles both shapes, which is exactly what the
// real run-driver uses.
const REQUIRED = [
  'task.json',
  'prompt.md',
  'acceptance.mjs',
  'reference-solution.mjs',
  'ground-truth.mjs',
  'subtle-wrong-output.mjs',
];

const SCRATCH = join(tmpdir(), 'corpus-selfcheck-scratch');
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });

function run(file, wsdir) {
  try {
    const out = execFileSync('node', [file, wsdir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exit: 0, out };
  } catch (e) {
    return { exit: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

function lastLine(s) {
  return s.trim().split('\n').pop();
}

const taskDirs = readdirSync(TASKS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const results = [];
for (const t of taskDirs) {
  const dir = join(TASKS_DIR, t);
  const issues = [];
  let type = '?';

  // (1) contract files + task.json well-formed
  for (const f of REQUIRED) {
    if (!existsSync(join(dir, f))) issues.push(`missing ${f}`);
  }
  try {
    const tj = JSON.parse(readFileSync(join(dir, 'task.json'), 'utf8'));
    type = tj.type;
    if (tj.taskId !== t) issues.push(`taskId mismatch ${tj.taskId}!=${t}`);
    if (tj.outputFile !== 'solution.mjs') issues.push(`outputFile!=solution.mjs (${tj.outputFile})`);
    if (!tj.type || typeof tj.type !== 'string') issues.push('task.json missing type');
  } catch {
    issues.push('task.json unreadable/invalid');
  }

  let refAccept = false;
  let refGt = false;
  let injAccept = false;
  let injGtFail = false;

  if (issues.length === 0) {
    const ws = join(SCRATCH, t);
    rmSync(ws, { recursive: true, force: true });
    mkdirSync(ws, { recursive: true });
    copyFileSync(join(dir, 'acceptance.mjs'), join(ws, 'acceptance.mjs'));
    copyFileSync(join(dir, 'ground-truth.mjs'), join(ws, 'ground-truth.mjs'));

    // (2) reference invariant
    copyFileSync(join(dir, 'reference-solution.mjs'), join(ws, 'solution.mjs'));
    const r1 = run(join(ws, 'acceptance.mjs'), ws);
    refAccept = r1.exit === 0 && /ACCEPT PASS/.test(r1.out);
    const r2 = run(join(ws, 'ground-truth.mjs'), ws);
    refGt = r2.exit === 0 && /GROUND-TRUTH PASS/.test(r2.out);
    if (!refAccept) issues.push(`ref!ACCEPT(${r1.exit}:${lastLine(r1.out)})`);
    if (!refGt) issues.push(`ref!GROUND-TRUTH-PASS(${r2.exit}:${lastLine(r2.out)})`);

    // (3) anti-gaming invariant via the CANONICAL inject() path
    try {
      const mod = await import(pathToFileURL(join(dir, 'subtle-wrong-output.mjs')).href);
      const payload = mod.default;
      if (!payload || typeof payload.inject !== 'function') {
        issues.push('subtle-wrong-output.mjs has no default.inject()');
      } else {
        payload.inject(ws, { outputFile: 'solution.mjs', taskId: t });
        const r3 = run(join(ws, 'acceptance.mjs'), ws);
        injAccept = r3.exit === 0 && /ACCEPT PASS/.test(r3.out);
        const r4 = run(join(ws, 'ground-truth.mjs'), ws);
        injGtFail = r4.exit !== 0 && /GROUND-TRUTH FAIL/.test(r4.out);
        if (!injAccept) issues.push(`inject!ACCEPT(${r3.exit}:${lastLine(r3.out)})`);
        if (!injGtFail) issues.push(`inject-NOT-caught-by-GT(${r4.exit}:${lastLine(r4.out)})`);
      }
    } catch (e) {
      issues.push(`inject() threw: ${e.message}`);
    }
  }

  const ok = issues.length === 0 && refAccept && refGt && injAccept && injGtFail;
  results.push({ t, type, ok, issues });
  if (ok) {
    process.stdout.write(`PASS ${t} [${type}] ref:ACCEPT/PASS inject:ACCEPT/FAIL\n`);
  } else {
    process.stdout.write(`FAIL ${t} ${issues.join('; ')}\n`);
  }
}

// (4) stratification — pre-reg §2
const stratIssues = [];
const counts = {};
for (const r of results) counts[r.type] = (counts[r.type] || 0) + 1;
const presentCats = Object.keys(counts).sort();

if (results.length !== EXPECTED_TOTAL) {
  stratIssues.push(`total ${results.length} != ${EXPECTED_TOTAL}`);
}
const expectedSet = new Set(EXPECTED_CATEGORIES);
for (const c of presentCats) {
  if (!expectedSet.has(c)) stratIssues.push(`unexpected category '${c}'`);
}
for (const c of EXPECTED_CATEGORIES) {
  const n = counts[c] || 0;
  if (n < CAT_MIN || n > CAT_MAX) {
    stratIssues.push(`category '${c}' count ${n} outside [${CAT_MIN},${CAT_MAX}]`);
  }
}
const distinctCount = presentCats.length;
if (distinctCount !== EXPECTED_CATEGORIES.length) {
  stratIssues.push(`distinct categories ${distinctCount} != ${EXPECTED_CATEGORIES.length}`);
}

const countsStr = JSON.stringify(
  Object.fromEntries(EXPECTED_CATEGORIES.map((c) => [c, counts[c] || 0])),
);
if (stratIssues.length === 0) {
  process.stdout.write(`stratification OK: 8 categories ${countsStr}\n`);
} else {
  process.stdout.write(`stratification FAIL: ${stratIssues.join('; ')} (counts ${countsStr})\n`);
}

const passCount = results.filter((r) => r.ok).length;
const allTasksOk = passCount === results.length;
const stratOk = stratIssues.length === 0;
process.stdout.write(`\n=== ${passCount}/${results.length} tasks pass the full invariant ===\n`);

if (allTasksOk && stratOk) {
  process.stdout.write('✓ corpus-selfcheck: all tasks pass + stratification holds (offline, no live LLM)\n');
  process.exit(0);
}
process.stdout.write(
  `✗ corpus-selfcheck: ${results.length - passCount} task(s) failed, ${stratIssues.length} stratification issue(s)\n`,
);
process.exit(1);
