#!/usr/bin/env node
// Fully offline, deterministic corpus self-check for the recovery-runner ablation corpus.
// No `claude -p`, no network, no live LLM. For every task directory under tasks/ it asserts:
//   1. Contract files exist + task.json is well-formed (taskId==dir, outputFile==='solution.mjs',
//      has a `type`). The 7th file payload-subtle.mjs is REQUIRED for every task whose
//      subtle-wrong-output.mjs actually reads it (separate-file payload); inline-payload legacy
//      tasks stay valid without it (F-004). Only the allowed contract files (+ a small legacy
//      allowlist) may appear in a task dir (F-005).
//   2. Reference invariant: reference-solution.mjs => acceptance ACCEPT PASS (exit 0) AND
//      ground-truth GROUND-TRUTH PASS (exit 0).
//   3. Anti-gaming invariant: the CANONICAL inject() from subtle-wrong-output.mjs (works whether
//      the payload is a separate payload-subtle.mjs file or an inline string) =>
//      acceptance ACCEPT PASS (exit 0) AND ground-truth GROUND-TRUTH FAIL (exit !=0). The
//      untrusted task-local inject() is fully sandboxed:
//        - the scratch harness files are sha256-snapshotted before inject() and asserted unchanged
//          after (a gamed inject() that rewrites the scratch harness is FAILED) (F-007);
//        - the trusted harness CONTENT is cached IN MEMORY before inject() and re-written from that
//          cache after — never re-read from the mutable task dir — and the SOURCE-DIR harness
//          sha256 is asserted unchanged (a gamed inject() that rewrites its own source harness is
//          FAILED) (F-009);
//        - every child node process runs with a SANITIZED env (NODE_OPTIONS and other *_OPTIONS /
//          node preload vectors stripped), so a gamed inject() cannot preload a hook to spoof only
//          the ground-truth child (F-010).
//      The scratch root is a unique mkdtemp dir, cleaned up at the end (F-008).
//   4. Stratification (pre-reg §2): total tasks === 24, exactly 8 distinct categories present
//      {bug-fix, feature, refactor, test-repair, doc-update, dep-upgrade, contract-validation,
//      CLI-feature}, each category count within [2,5] inclusive.
//   5. Negative-control self-test (F-006): synthetic gamed corpora are built in a temp dir and the
//      selfcheck's own guards are asserted to REJECT each, so the guards are exercised, not merely
//      described. The whole script exits non-zero if any guard fails to fire.
// Exit 0 only if ALL per-task invariants hold AND stratification holds AND every negative-control
// guard fires; otherwise exit 1.
// Run: node experiments/recovery-runner/corpus-selfcheck.mjs   (defaults to ./tasks relative to here)
import {
  readdirSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  copyFileSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

// Always-present contract files. payload-subtle.mjs is conditionally required (see F-004 logic in
// validateTask): some legacy tasks (e.g. text-stats) carry an inline payload inside
// subtle-wrong-output.mjs rather than a separate payload file. The canonical inject() path handles
// both shapes, which is exactly what the real run-driver uses.
const REQUIRED = [
  'task.json',
  'prompt.md',
  'acceptance.mjs',
  'reference-solution.mjs',
  'ground-truth.mjs',
  'subtle-wrong-output.mjs',
];
// The full contract file set (REQUIRED + the conditionally-required 7th file).
const CONTRACT_FILES = new Set([...REQUIRED, 'payload-subtle.mjs']);
// Legacy files tolerated in a few of the original 4 task dirs (median/parse-range carry an extra
// overfit-output.mjs payload). Anything outside CONTRACT_FILES ∪ ALLOWLIST is a stray file (F-005).
const LEGACY_ALLOWLIST = new Set(['overfit-output.mjs']);

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// F-010: snapshot the pristine NODE_OPTIONS ONCE at module load, so a gamed inject() that mutates
// process.env mid-run can never influence later child processes. We strip every node preload knob
// from the child env regardless of the snapshot value.
const PRISTINE_NODE_OPTIONS = process.env.NODE_OPTIONS;

// Build a sanitized child env that cannot be used to preload a hook (NODE_OPTIONS=--require/--import,
// or any *_OPTIONS / NODE_REPL_EXTERNAL_MODULE style preload var) so a gamed inject() cannot make
// only the ground-truth child spoof its output. We start from the pristine module-load env, then
// hard-delete known preload vectors.
function sanitizedEnv() {
  const env = { ...process.env };
  // Always drop NODE_OPTIONS for children; restore the pristine value only if it was set and is now
  // identical (defense-in-depth: never trust a mid-run mutation). We simply remove it entirely —
  // the selfcheck harness does not need NODE_OPTIONS to run.
  delete env.NODE_OPTIONS;
  // Strip any other *_OPTIONS vars and known node preload/require vectors.
  for (const k of Object.keys(env)) {
    if (/_OPTIONS$/.test(k) || /^NODE_(REQUIRE|REPL_EXTERNAL_MODULE)/.test(k)) delete env[k];
  }
  void PRISTINE_NODE_OPTIONS; // documented intent: pristine value is intentionally NOT propagated.
  return env;
}

function run(file, wsdir) {
  try {
    const out = execFileSync('node', [file, wsdir], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizedEnv(),
    });
    return { exit: 0, out };
  } catch (e) {
    return { exit: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

function lastLine(s) {
  return s.trim().split('\n').pop();
}

// Validate a single task dir against the full per-task invariant. Returns {t, type, ok, issues}.
// `scratchRoot` is a writable dir under which a per-task scratch workspace is created.
async function validateTask(t, dir, scratchRoot) {
  const issues = [];
  let type = '?';

  // (1a) required contract files present
  for (const f of REQUIRED) {
    if (!existsSync(join(dir, f))) issues.push(`missing ${f}`);
  }

  // (1b) F-004: enforce the 7th file when the injector actually depends on it. If
  // subtle-wrong-output.mjs reads payload-subtle (separate-file payload), that file MUST exist.
  if (existsSync(join(dir, 'subtle-wrong-output.mjs'))) {
    const src = readFileSync(join(dir, 'subtle-wrong-output.mjs'), 'utf8');
    if (/payload-subtle/.test(src) && !existsSync(join(dir, 'payload-subtle.mjs'))) {
      issues.push('subtle-wrong-output.mjs references payload-subtle but payload-subtle.mjs missing');
    }
  }

  // (1c) F-005: reject stray files — only contract files + legacy allowlist may appear.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    if (!CONTRACT_FILES.has(name) && !LEGACY_ALLOWLIST.has(name)) {
      issues.push(`unexpected file in task dir: ${name}`);
    }
  }

  // (1d) task.json well-formed
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
    const ws = join(scratchRoot, t);
    rmSync(ws, { recursive: true, force: true });
    mkdirSync(ws, { recursive: true });
    const wsAccept = join(ws, 'acceptance.mjs');
    const wsGt = join(ws, 'ground-truth.mjs');
    copyFileSync(join(dir, 'acceptance.mjs'), wsAccept);
    copyFileSync(join(dir, 'ground-truth.mjs'), wsGt);

    // (2) reference invariant
    copyFileSync(join(dir, 'reference-solution.mjs'), join(ws, 'solution.mjs'));
    const r1 = run(wsAccept, ws);
    refAccept = r1.exit === 0 && /ACCEPT PASS/.test(r1.out);
    const r2 = run(wsGt, ws);
    refGt = r2.exit === 0 && /GROUND-TRUTH PASS/.test(r2.out);
    if (!refAccept) issues.push(`ref!ACCEPT(${r1.exit}:${lastLine(r1.out)})`);
    if (!refGt) issues.push(`ref!GROUND-TRUTH-PASS(${r2.exit}:${lastLine(r2.out)})`);

    // (3) anti-gaming invariant via the CANONICAL inject() path, sandboxed against a gamed inject().
    try {
      const srcAccept = join(dir, 'acceptance.mjs');
      const srcGt = join(dir, 'ground-truth.mjs');
      // F-009: cache the trusted harness CONTENT into memory BEFORE the untrusted inject() runs, and
      // record the SOURCE-DIR sha256. We will neither re-read nor re-copy from the mutable task dir
      // after inject().
      const cachedAccept = readFileSync(srcAccept);
      const cachedGt = readFileSync(srcGt);
      const srcAcceptHashBefore = createHash('sha256').update(cachedAccept).digest('hex');
      const srcGtHashBefore = createHash('sha256').update(cachedGt).digest('hex');
      // F-007(a): snapshot the SCRATCH harness too (catches a direct scratch-file rewrite).
      const acceptHashBefore = sha256(wsAccept);
      const gtHashBefore = sha256(wsGt);

      const mod = await import(pathToFileURL(join(dir, 'subtle-wrong-output.mjs')).href);
      const payload = mod.default;
      if (!payload || typeof payload.inject !== 'function') {
        issues.push('subtle-wrong-output.mjs has no default.inject()');
      } else {
        payload.inject(ws, { outputFile: 'solution.mjs', taskId: t });

        // F-007(a): a gamed inject() that rewrote the SCRATCH harness to fake the invariant is FAILED.
        if (sha256(wsAccept) !== acceptHashBefore || sha256(wsGt) !== gtHashBefore) {
          issues.push('inject() tampered with harness file');
        }
        // F-009(b): a gamed inject() that rewrote its own SOURCE-DIR harness is FAILED.
        if (
          createHash('sha256').update(readFileSync(srcAccept)).digest('hex') !== srcAcceptHashBefore ||
          createHash('sha256').update(readFileSync(srcGt)).digest('hex') !== srcGtHashBefore
        ) {
          issues.push('inject() tampered with source harness file');
        }
        // F-009(a): restore the post-inject scratch harness from the in-memory CACHED content —
        // never re-read from the (possibly tampered) task source dir.
        writeFileSync(wsAccept, cachedAccept);
        writeFileSync(wsGt, cachedGt);

        const r3 = run(wsAccept, ws);
        injAccept = r3.exit === 0 && /ACCEPT PASS/.test(r3.out);
        const r4 = run(wsGt, ws);
        injGtFail = r4.exit !== 0 && /GROUND-TRUTH FAIL/.test(r4.out);
        if (!injAccept) issues.push(`inject!ACCEPT(${r3.exit}:${lastLine(r3.out)})`);
        if (!injGtFail) issues.push(`inject-NOT-caught-by-GT(${r4.exit}:${lastLine(r4.out)})`);
      }
    } catch (e) {
      issues.push(`inject() threw: ${e.message}`);
    }
  }

  const ok = issues.length === 0 && refAccept && refGt && injAccept && injGtFail;
  return { t, type, ok, issues };
}

// Validate stratification (pre-reg §2) over a set of {type} results. Returns {issues, counts}.
function validateStratification(results) {
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
  return { issues: stratIssues, counts };
}

// Enumerate + validate every task dir under a tasks/ root using a fresh scratch workspace.
async function validateCorpus(tasksDir, scratchRoot) {
  const dirs = readdirSync(tasksDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const out = [];
  for (const t of dirs) {
    out.push(await validateTask(t, join(tasksDir, t), scratchRoot));
  }
  return out;
}

// =========================================================================================
// F-006: negative-control self-test. Build synthetic gamed tasks and assert the guards REJECT each.
// Each control writes a minimal but real task contract into a temp corpus, then runs the SAME
// validateTask / validateStratification used on the real corpus and asserts the expected guard fires.
// =========================================================================================

// A minimal, self-contained, genuinely-correct task contract whose ground-truth detects the bug.
// solution.mjs must export default add(a,b). acceptance only checks add(1,1)===2 (visible);
// ground-truth also checks add(2,2)===4 (hidden) — a subtle bug that returns a+b+1 passes
// acceptance but fails ground-truth.
const HARNESS_ACCEPT = `import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const ws = process.argv[2];
const mod = await import(pathToFileURL(join(ws, 'solution.mjs')).href);
const add = mod.default;
if (add(1, 1) !== 2) { console.log('ACCEPT FAIL'); process.exit(1); }
console.log('ACCEPT PASS');
`;
const HARNESS_GT = `import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const ws = process.argv[2];
const mod = await import(pathToFileURL(join(ws, 'solution.mjs')).href);
const add = mod.default;
if (add(1, 1) !== 2 || add(2, 2) !== 4) { console.log('GROUND-TRUTH FAIL'); process.exit(1); }
console.log('GROUND-TRUTH PASS');
`;
const REFERENCE = `export default function add(a, b) { return a + b; }\n`;
// inline-payload injector that writes a genuinely-buggy solution (passes acceptance, fails GT).
const INJECT_BUGGY = `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default { id: 'x', inject(ws, task) { writeFileSync(join(ws, task.outputFile), 'export default function add(a,b){ return a+b+(a===2?1:0); }\\n'); return {}; } };
`;
// injector that writes a CORRECT solution (no real bug) — invariant must FAIL: GT still PASSES.
const INJECT_CORRECT = `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default { id: 'x', inject(ws, task) { writeFileSync(join(ws, task.outputFile), 'export default function add(a,b){ return a+b; }\\n'); return {}; } };
`;
// injector that TAMPERS the scratch ground-truth.mjs (fakes the FAIL) while shipping a correct
// solution — the F-007 tamper-assert must FAIL it.
const INJECT_TAMPER = `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default { id: 'x', inject(ws, task) {
  writeFileSync(join(ws, task.outputFile), 'export default function add(a,b){ return a+b; }\\n');
  writeFileSync(join(ws, 'ground-truth.mjs'), 'console.log("GROUND-TRUTH FAIL"); process.exit(1);\\n');
  return {};
} };
`;
// F-009 exploit: an injector that rewrites its OWN SOURCE-DIR ground-truth.mjs (to fake a FAIL) while
// shipping a CORRECT solution. The source-tamper guard must FAIL it. It locates its source dir via
// import.meta.url (the injector executes from the task source dir).
const INJECT_SOURCE_TAMPER = `import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
export default { id: 'x', inject(ws, task) {
  writeFileSync(join(ws, task.outputFile), 'export default function add(a,b){ return a+b; }\\n');
  // tamper the SOURCE-dir ground-truth so any re-copy/re-read from source would fake a FAIL.
  writeFileSync(join(here, 'ground-truth.mjs'), 'console.log("GROUND-TRUTH FAIL"); process.exit(1);\\n');
  return {};
} };
`;
// F-010 exploit: an injector that sets process.env.NODE_OPTIONS=--require <evil hook> and ships a
// CORRECT solution. With a sanitized child env the hook never loads, so ground-truth PASSES on the
// correct solution => the existing 'inject-NOT-caught-by-GT' guard fires (the payload wasn't wrong).
// EVIL_HOOK_PATH is substituted at runtime by the negative-control runner.
const INJECT_ENV_SPOOF = (hookPath) => `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default { id: 'x', inject(ws, task) {
  process.env.NODE_OPTIONS = '--require ${hookPath.replace(/\\\\/g, '\\\\\\\\')}';
  writeFileSync(join(ws, task.outputFile), 'export default function add(a,b){ return a+b; }\\n');
  return {};
} };
`;
// The evil preload hook a spoofing injector would try to inject via NODE_OPTIONS: it forces the
// ground-truth child to print GROUND-TRUTH FAIL + exit 1 no matter the solution. Written as CJS so
// --require can load it.
const EVIL_HOOK = `const path = process.argv[1] || '';
if (/ground-truth/.test(path)) { console.log('GROUND-TRUTH FAIL'); process.exit(1); }
`;

function writeSyntheticTask(dir, { type, taskId, inject, omit }) {
  mkdirSync(dir, { recursive: true });
  const files = {
    'task.json': JSON.stringify({ taskId, type, outputFile: 'solution.mjs', promptFile: 'prompt.md', acceptanceFile: 'acceptance.mjs' }),
    'prompt.md': `# ${taskId}\n`,
    'acceptance.mjs': HARNESS_ACCEPT,
    'ground-truth.mjs': HARNESS_GT,
    'reference-solution.mjs': REFERENCE,
    'subtle-wrong-output.mjs': inject,
  };
  for (const [name, content] of Object.entries(files)) {
    if (omit && omit.includes(name)) continue;
    writeFileSync(join(dir, name), content);
  }
}

async function runNegativeControls(scratchRoot) {
  const ncRoot = mkdtempSync(join(scratchRoot, 'nc-'));
  const controls = [];
  const record = (name, fired, detail) => controls.push({ name, fired, detail });

  // Control 1: inject() writes a CORRECT solution → invariant must FAIL (payload not caught by GT).
  {
    const dir = join(ncRoot, 'c1', 'nc-correct');
    writeSyntheticTask(dir, { type: 'bug-fix', taskId: 'nc-correct', inject: INJECT_CORRECT });
    const r = await validateTask('nc-correct', dir, join(ncRoot, 'c1-scratch'));
    const fired = !r.ok && r.issues.some((i) => /inject-NOT-caught-by-GT/.test(i));
    record('inject-writes-correct-solution => not-caught-by-GT', fired, r.issues.join('; '));
  }

  // Control 2: inject() tampers ground-truth.mjs → F-007 tamper-assert must FAIL.
  {
    const dir = join(ncRoot, 'c2', 'nc-tamper');
    writeSyntheticTask(dir, { type: 'bug-fix', taskId: 'nc-tamper', inject: INJECT_TAMPER });
    const r = await validateTask('nc-tamper', dir, join(ncRoot, 'c2-scratch'));
    const fired = !r.ok && r.issues.some((i) => /tampered with harness file/.test(i));
    record('inject-tampers-ground-truth => tamper-assert', fired, r.issues.join('; '));
  }

  // Control 3: a required file is missing → FAIL.
  {
    const dir = join(ncRoot, 'c3', 'nc-missing');
    writeSyntheticTask(dir, { type: 'bug-fix', taskId: 'nc-missing', inject: INJECT_BUGGY, omit: ['ground-truth.mjs'] });
    const r = await validateTask('nc-missing', dir, join(ncRoot, 'c3-scratch'));
    const fired = !r.ok && r.issues.some((i) => /missing ground-truth\.mjs/.test(i));
    record('missing-required-file => FAIL', fired, r.issues.join('; '));
  }

  // Control 4: stray file in a task dir → F-005 FAIL.
  {
    const dir = join(ncRoot, 'c4', 'nc-stray');
    writeSyntheticTask(dir, { type: 'bug-fix', taskId: 'nc-stray', inject: INJECT_BUGGY });
    writeFileSync(join(dir, 'junk.txt'), 'junk');
    const r = await validateTask('nc-stray', dir, join(ncRoot, 'c4-scratch'));
    const fired = !r.ok && r.issues.some((i) => /unexpected file in task dir: junk\.txt/.test(i));
    record('stray-file => F-005 FAIL', fired, r.issues.join('; '));
  }

  // Control 5: F-004 — injector references payload-subtle but payload-subtle.mjs is absent → FAIL.
  {
    const dir = join(ncRoot, 'c5', 'nc-nopayload');
    const injReadsPayload = `import { readFileSync } from 'node:fs';\nimport { join, dirname } from 'node:path';\nimport { fileURLToPath } from 'node:url';\nconst here = dirname(fileURLToPath(import.meta.url));\nconst P = readFileSync(join(here, 'payload-subtle.mjs'), 'utf8');\nexport default { id:'x', inject(ws, task){ return {}; } };\n`;
    writeSyntheticTask(dir, { type: 'bug-fix', taskId: 'nc-nopayload', inject: injReadsPayload });
    const r = await validateTask('nc-nopayload', dir, join(ncRoot, 'c5-scratch'));
    const fired = !r.ok && r.issues.some((i) => /payload-subtle.mjs missing/.test(i));
    record('injector-needs-payload-but-absent => F-004 FAIL', fired, r.issues.join('; '));
  }

  // Control 6: stratification — 25 tasks → total mismatch.
  {
    const synthetic25 = Array.from({ length: 25 }, () => ({ type: 'bug-fix' }));
    const s = validateStratification(synthetic25);
    const fired = s.issues.some((i) => /total 25 != 24/.test(i));
    record('25-tasks => stratification total guard', fired, s.issues.join('; '));
  }

  // Control 7: stratification — unknown 9th category.
  {
    const base = EXPECTED_CATEGORIES.flatMap((c) => [{ type: c }, { type: c }, { type: c }]);
    // 24 tasks but one is an unknown category (swap one bug-fix → security-audit).
    const synthetic = base.slice(0, 23).concat([{ type: 'security-audit' }]);
    const s = validateStratification(synthetic);
    const fired = s.issues.some((i) => /unexpected category 'security-audit'/.test(i));
    record('unknown-category => stratification category guard', fired, s.issues.join('; '));
  }

  // Control 8: stratification — wrong per-category count (one category at 6, outside [2,5]).
  {
    const synthetic = [];
    for (const c of EXPECTED_CATEGORIES) {
      const n = c === 'bug-fix' ? 6 : c === 'feature' ? 1 : 3;
      for (let i = 0; i < n; i++) synthetic.push({ type: c });
    }
    const s = validateStratification(synthetic);
    const fired = s.issues.some((i) => /count 6 outside/.test(i)) && s.issues.some((i) => /count 1 outside/.test(i));
    record('wrong-category-count => stratification range guard', fired, s.issues.join('; '));
  }

  // Control 9: F-009 — inject() rewrites its OWN SOURCE-DIR ground-truth.mjs (correct solution) →
  // the source-tamper guard must FAIL it.
  {
    const dir = join(ncRoot, 'c9', 'nc-srctamper');
    writeSyntheticTask(dir, { type: 'bug-fix', taskId: 'nc-srctamper', inject: INJECT_SOURCE_TAMPER });
    const r = await validateTask('nc-srctamper', dir, join(ncRoot, 'c9-scratch'));
    const fired = !r.ok && r.issues.some((i) => /tampered with source harness file/.test(i));
    record('inject-tampers-source-ground-truth => source-tamper guard', fired, r.issues.join('; '));
  }

  // Control 10: F-010 — inject() sets process.env.NODE_OPTIONS=--require <evil hook> with a CORRECT
  // solution. With the sanitized child env the hook does NOT load → ground-truth PASSES on the
  // correct solution → the 'inject-NOT-caught-by-GT' guard fires (the payload wasn't actually wrong).
  {
    const hookPath = join(ncRoot, 'evil-hook.cjs');
    try {
      writeFileSync(hookPath, EVIL_HOOK);
      const dir = join(ncRoot, 'c10', 'nc-envspoof');
      writeSyntheticTask(dir, { type: 'bug-fix', taskId: 'nc-envspoof', inject: INJECT_ENV_SPOOF(hookPath) });
      const r = await validateTask('nc-envspoof', dir, join(ncRoot, 'c10-scratch'));
      const fired = !r.ok && r.issues.some((i) => /inject-NOT-caught-by-GT/.test(i));
      record('env-spoof-NODE_OPTIONS => sanitized-env neutralizes hook, not-caught-by-GT', fired, r.issues.join('; '));
    } finally {
      rmSync(hookPath, { recursive: true, force: true });
    }
  }

  rmSync(ncRoot, { recursive: true, force: true });
  return controls;
}

// =========================================================================================
// Main
// =========================================================================================
const SCRATCH = mkdtempSync(join(tmpdir(), 'corpus-selfcheck-')); // F-008: unique per run
let exitCode = 0;
try {
  const results = await validateCorpus(TASKS_DIR, SCRATCH);
  for (const r of results) {
    if (r.ok) {
      process.stdout.write(`PASS ${r.t} [${r.type}] ref:ACCEPT/PASS inject:ACCEPT/FAIL\n`);
    } else {
      process.stdout.write(`FAIL ${r.t} ${r.issues.join('; ')}\n`);
    }
  }

  const strat = validateStratification(results);
  const countsStr = JSON.stringify(
    Object.fromEntries(EXPECTED_CATEGORIES.map((c) => [c, strat.counts[c] || 0])),
  );
  if (strat.issues.length === 0) {
    process.stdout.write(`stratification OK: 8 categories ${countsStr}\n`);
  } else {
    process.stdout.write(`stratification FAIL: ${strat.issues.join('; ')} (counts ${countsStr})\n`);
  }

  // F-006: negative-control self-test (prove the guards fire).
  const controls = await runNegativeControls(SCRATCH);
  const fired = controls.filter((c) => c.fired).length;
  for (const c of controls) {
    if (!c.fired) process.stdout.write(`  ✗ negative-control DID NOT FIRE: ${c.name} (issues: ${c.detail})\n`);
  }
  process.stdout.write(`negative-control self-test: ${fired}/${controls.length} guards fire\n`);

  const passCount = results.filter((r) => r.ok).length;
  const allTasksOk = passCount === results.length;
  const stratOk = strat.issues.length === 0;
  const controlsOk = fired === controls.length;
  process.stdout.write(`\n=== ${passCount}/${results.length} tasks pass the full invariant ===\n`);

  if (allTasksOk && stratOk && controlsOk) {
    process.stdout.write('✓ corpus-selfcheck: all tasks pass + stratification holds + guards fire (offline, no live LLM)\n');
    exitCode = 0;
  } else {
    process.stdout.write(
      `✗ corpus-selfcheck: ${results.length - passCount} task(s) failed, ${strat.issues.length} stratification issue(s), ${controls.length - fired} guard(s) did not fire\n`,
    );
    exitCode = 1;
  }
} finally {
  rmSync(SCRATCH, { recursive: true, force: true }); // F-008: clean up the unique scratch dir
}
process.exit(exitCode);
