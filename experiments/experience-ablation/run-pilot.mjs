#!/usr/bin/env node
// run-pilot.mjs — M6 committed pilot campaign runner (experience-ablation).
//
// Adapts the identity-keyed campaign-resume pattern proven by the recovery
// powered scratch (experiments/recovery-runner/powered/run-campaign.mjs:
// per-cell identity key on disk, append-only jsonl progress, skip-if-recorded
// resume) into a committed runner that emits RUN-RECORD.md-conformant
// per-arm-run directories the M4 scorer (score.mjs) consumes unchanged.
//
// CELL MODEL
//   One cell = (experimentId, fixtureId, arm). Cells are enumerated from the
//   corpus manifest (<corpus>/manifest.json, fixture-generator.mjs output)
//   in the COMMITTED run order of <experimentRoot>/run-order-seed.json
//   (pair-ledger.mjs build output; armRunId = "<fixtureId>::<arm>").
//   A cell is TERMINAL when its run dir runs/<fixtureId>__<arm>/ contains a
//   run.json that passes the RUN-RECORD.md required-field validation. Resume
//   is the default behavior: terminal cells are skipped on every invocation;
//   a non-terminal leftover run dir (crashed attempt: no valid run.json) is
//   cleared and re-run. Progress is an append-only jsonl ledger at
//   <experimentRoot>/pilot-progress.jsonl (never truncated or rewritten).
//
// PER-CELL EXECUTION
//   1. Copy the fixture's host-visible surface into a FRESH mkdtemp NON-GIT
//      isolated root: workspace/ (the tree the host operates on), prompt.md
//      and acceptance.mjs as siblings. Hidden surfaces (task.json, oracle.mjs,
//      reference-good/, reference-bad/) are NEVER copied.
//   1b. FROZEN-SNAPSHOT MATERIALIZATION (CHK-005, plan sections 4/12/14): the
//      --memorySnapshotDir content (snapshot-builder.mjs output, a mirror of
//      the `.lattice/` subtree) is copied byte-identically into
//      <workspace>/.lattice/ on BOTH arms, then sha256-verified against the
//      frozen protocol.json memorySnapshotHash BEFORE host execution and
//      re-verified unchanged AFTER the run (either mismatch aborts the cell,
//      fail closed, no run.json). Verification hashes exactly the snapshot's
//      own file set (same relpath+bytes algorithm as protocol.mjs
//      hashDirectorySnapshot), so expected runtime additions next to it
//      (activity.jsonl, runtime-memory-pack-cache/) do not count as snapshot
//      drift while any byte change or deletion of a frozen file does.
//   2. STORE-ISOLATION ASSERTION (before any host execution): spawn the real
//      CLI `node <snapshotCli> observability_snapshot --json` with cwd = the
//      isolated workspace and assert its resolvedLearningRoot equals
//      <workspace>/.lattice/learning inside the isolated root (empirically:
//      the CLI resolves the learning root through git, so a workspace nested
//      in any git checkout escapes to that git root — plan section 12; this is
//      why mkdtemp non-git roots are mandatory). Any mismatch aborts the cell
//      AND the campaign (fail closed) with no run.json written. The probe env
//      strips LATTICE_PROJECT_ROOT (it would redirect resolution) and the
//      experiment vars (the read-only probe is not part of the experiment).
//   2b. EXPERIENCE-DELIVERY PRELUDE (CHK-005): spawn the real gated entrypoint
//      `node <snapshotCli> session_brief` with cwd = the isolated workspace
//      and the SAME experiment env the host receives, so the runtime memory
//      pack is computed AND logged (experience_pack_surfaced) on BOTH arms via
//      the production M3 mechanism (experience-pack-surface.ts render gate).
//      The prelude's activity events land in <workspace>/.lattice/
//      activity.jsonl and are therefore part of the captured run slice. The
//      rendered "## Memory Runtime Preflight" section is prepended to the
//      host prompt ONLY when the entrypoint rendered it (treatment); the
//      control host prompt stays byte-identical to the raw prompt.md. Arm
//      contract is fail-closed: control rendering a section, treatment not
//      rendering one, a missing/empty surfaced event, or a prelude failure
//      each abort the cell before host execution.
//   3. Execute the host via the configurable --hostCmd template (placeholders
//      {workspace} {promptFile} {isolatedRoot}; shell-expanded with cwd = the
//      isolated workspace). {promptFile} resolves to the composed host prompt
//      (host-prompt.md), NOT the raw prompt.md (they are byte-identical on
//      control). The child env carries LATTICE_EXPERIMENT_ID +
//      LATTICE_EXPERIMENT_ARM (the M3 arm-switch contract) plus
//      LATTICE_GLOBAL_MEMORY_DIR pinned to an empty dir inside the isolated
//      root (without it the operator's real ~/.lattice/dev-memory global
//      store leaks into the pack — verified empirically — breaking the memory
//      freeze), and never carries LATTICE_PROJECT_ROOT. Default template is a
//      Claude CLI non-interactive form; tests/selfchecks MUST pass a stub
//      --hostCmd (never a real host).
//   4. Capture the run-scoped activity slice: everything the run appended
//      under the isolated root's .lattice/activity.jsonl files (empirically
//      the M3 events land at <workspace>/.lattice/activity.jsonl because the
//      CLI resolves its project root to the host cwd in a non-git isolated
//      root; the isolated root itself is also checked in case the host ran
//      lattice from the parent dir). Copy the post-run workspace verbatim,
//      plus host-prompt.md and prelude-transcript.log as audit artifacts.
//   5. Write run.json LAST (atomic tmp+rename; it is the terminal marker)
//      with every RUN-RECORD.md required field:
//        experimentId, arm, hostId, storeRoot (the ASSERTED resolved learning
//        root inside the isolated root), startedAt/endedAt +
//        timeToDoneMs (elapsed when doneReached, else null), commandCount,
//        doneReached, validationPass.
//      Mechanical outcome definitions (documented, deterministic):
//        doneReached    = the fixture's visible acceptance.mjs exits 0 against
//                         the post-run workspace (terminal completion artifact
//                         present).
//        validationPass = doneReached AND the host process exited 0.
//        commandCount   = number of parsable activity-slice entries carrying a
//                         string `tool` field (the CLI's per-command records).
//      Extra audit-only fields (ignored by the scorer per RUN-RECORD.md):
//        fixtureId, trapClass, hostExitCode, hostTimedOut,
//        memorySnapshotHash, memoryPackRendered.
//
// PRECONDITIONS (hard, checked before any host run)
//   - leakage-audit.jsonl must exist (--leakageAudit, else
//     <experimentRoot>/leakage-audit.jsonl, else <corpus>/leakage-audit.jsonl)
//     with at least one row, every row pass:true, and a row for every fixture
//     in the run order. Any pass:false row or missing coverage refuses the
//     campaign (M6 exit criterion: fixture-leakage audit passes).
//   - --memorySnapshotDir is REQUIRED for execution (not for --plan): without
//     a frozen store both arms see an empty pack and the experiment is null
//     by construction (CHK-005). Its hashDirectorySnapshot sha256 must equal
//     protocol.json memorySnapshotHash or the campaign is refused.
//   - run-order-seed.json must exist (build the pair ledger first — M2).
//   - The corpus manifest and the run-order fixture set must match exactly,
//     and every fixture dir must carry task.json (fixtureId + trapClass
//     matching the manifest), workspace/ and prompt.md.
//   --plan prints the cell table (fixtureId x arm x status + pending/done
//   counts + leakage-audit status) WITHOUT executing anything and exits 0.
//
// The runner itself writes only under <experimentRoot> (runs/, progress
// jsonl) and the mkdtemp scratch roots; it NEVER writes any .lattice/learning
// store, and the pre-run assertion mechanically prevents host lifecycle
// writes from reaching the shared production store (score.mjs additionally
// voids any record whose storeRoot resolves into the production root).
//
// USAGE
//   node run-pilot.mjs --experimentId=<id> --corpus=<dir> [--root=<repoRoot>]
//                      --memorySnapshotDir=<dir>
//                      [--plan] [--smoke] [--maxCells=<n>]
//                      [--hostCmd=<template>] [--hostId=<id>]
//                      [--scratchDir=<dir>] [--timeoutMs=<n>]
//                      [--snapshotCli=<path>] [--leakageAudit=<path>]
//   --smoke is --maxCells=1: run ONE cell end-to-end and stop, so the smoke
//   cell can be validated (scored) before the full enumeration (plan S17 /
//   CHK-003 smoke-cell-first discipline). Resume then skips it.

import { createHash } from 'node:crypto';
import {
  appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { experimentRoot, hashDirectorySnapshot, loadFrozenProtocol } from './protocol.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repo root derived from this module's location (score.mjs pattern). */
export function defaultRepoRoot() {
  return normalize(join(HERE, '..', '..'));
}

/** Default CLI used for the read-only store-isolation probe. */
export function defaultSnapshotCli(root = defaultRepoRoot()) {
  return join(root, 'packages', 'main', 'dist', 'cli.js');
}

/** Default host template: Claude CLI non-interactive. Tests use a stub. */
export const DEFAULT_HOST_CMD =
  'claude --print --permission-mode bypassPermissions "$(cat {promptFile})"';

export const DEFAULT_HOST_ID = 'claude-cli';
export const DEFAULT_TIMEOUT_MS = 1_800_000; // 30 min per host run
export const ARM_VALUES = ['control', 'treatment'];
export const RUN_DIR_SEP = '__';
export const PROGRESS_FILENAME = 'pilot-progress.jsonl';

/** One-line actionable failure; the CLI prints err.message verbatim. */
function fail(msg) {
  throw new Error(`run-pilot: ${String(msg).replace(/\s*\n\s*/g, ' ')}`);
}

function readJson(path, label) {
  if (!existsSync(path)) fail(`missing ${label}: ${path}`);
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { fail(`${label} is not valid JSON: ${path}`); }
}

function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** armRunId "<fixtureId>::<arm>" -> {fixtureId, arm} (pair-ledger contract). */
export function parseArmRunId(armRunId) {
  if (typeof armRunId !== 'string') fail(`run-order armRunId must be a string (got ${JSON.stringify(armRunId)})`);
  const i = armRunId.lastIndexOf('::');
  if (i <= 0) fail(`run-order armRunId '${armRunId}' is not '<fixtureId>::<arm>'`);
  const fixtureId = armRunId.slice(0, i);
  const arm = armRunId.slice(i + 2);
  if (!ARM_VALUES.includes(arm)) fail(`run-order armRunId '${armRunId}' has arm '${arm}' (expected ${ARM_VALUES.join('|')})`);
  return { fixtureId, arm };
}

export function runDirName(fixtureId, arm) {
  return `${fixtureId}${RUN_DIR_SEP}${arm}`;
}

/**
 * RUN-RECORD.md required-field validation (presence AND type), mirrored
 * locally so the runner never marks a cell terminal on a malformed record.
 * Returns [] when valid, else one problem string per field.
 */
export function validateRunRecord(run) {
  const problems = [];
  if (run === null || typeof run !== 'object' || Array.isArray(run)) return ['run.json must be an object'];
  for (const key of ['experimentId', 'hostId', 'storeRoot']) {
    if (typeof run[key] !== 'string' || run[key].trim().length === 0) problems.push(`${key} must be a non-empty string`);
  }
  if (typeof run.storeRoot === 'string' && run.storeRoot.length > 0 && !run.storeRoot.startsWith('/')) {
    problems.push('storeRoot must be an absolute path');
  }
  if (!ARM_VALUES.includes(run.arm)) problems.push(`arm must be ${ARM_VALUES.join('|')}`);
  const hasTimings = ('timeToDoneMs' in run
    && (run.timeToDoneMs === null || (typeof run.timeToDoneMs === 'number' && Number.isFinite(run.timeToDoneMs) && run.timeToDoneMs >= 0)))
    || (!Number.isNaN(Date.parse(run.startedAt ?? '')) && !Number.isNaN(Date.parse(run.endedAt ?? '')));
  if (!hasTimings) problems.push('timings must provide timeToDoneMs (number|null) or parseable startedAt+endedAt');
  if (!Number.isInteger(run.commandCount) || run.commandCount < 0) problems.push('commandCount must be a non-negative integer');
  for (const key of ['doneReached', 'validationPass']) {
    if (typeof run[key] !== 'boolean') problems.push(`${key} must be a boolean`);
  }
  return problems;
}

/** Terminal cell = run dir has a run.json passing RUN-RECORD validation. */
export function isTerminalRunDir(runDir) {
  const path = join(runDir, 'run.json');
  if (!existsSync(path)) return false;
  let run;
  try { run = JSON.parse(readFileSync(path, 'utf8')); } catch { return false; }
  return validateRunRecord(run).length === 0;
}

/** Load + validate the committed run order (pair-ledger build output). */
export function loadRunOrder(expRoot) {
  const seedPath = join(expRoot, 'run-order-seed.json');
  if (!existsSync(seedPath)) {
    fail(`run-order-seed.json missing at ${expRoot} — build the pair ledger first (node pair-ledger.mjs build ...)`);
  }
  const doc = readJson(seedPath, 'run-order-seed.json');
  if (!Array.isArray(doc.runOrder) || doc.runOrder.length === 0) {
    fail(`run-order-seed.json has no runOrder entries: ${seedPath}`);
  }
  return doc.runOrder.map(parseArmRunId);
}

/** Load the corpus manifest (fixture-generator output). */
export function loadCorpusManifest(corpusDir) {
  const rows = readJson(join(corpusDir, 'manifest.json'), 'corpus manifest.json');
  if (!Array.isArray(rows) || rows.length === 0) fail(`corpus manifest.json has no fixture rows: ${corpusDir}`);
  return rows;
}

/**
 * Leakage-audit hard precondition: the audit artifact (CHK-002 output; rows
 * {fixtureId, checks, pass}) must exist, parse, contain no pass:false row,
 * and cover every enumerated fixture. Returns {path, rows} or fails.
 */
export function checkLeakageAudit({ explicitPath, expRoot, corpusDir, fixtureIds }) {
  const candidates = explicitPath
    ? [explicitPath]
    : [join(expRoot, 'leakage-audit.jsonl'), join(corpusDir, 'leakage-audit.jsonl')];
  const path = candidates.find((p) => existsSync(p));
  if (!path) {
    fail(`leakage audit has not passed: leakage-audit.jsonl not found (looked at ${candidates.join(', ')}) — run the leakage audit over the corpus first`);
  }
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) fail(`leakage audit has not passed: ${path} is empty`);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    let row;
    try { row = JSON.parse(lines[i]); } catch { fail(`leakage-audit.jsonl line ${i + 1} is not valid JSON: ${path}`); }
    rows.push(row);
  }
  const failing = rows.filter((r) => r.pass !== true).map((r) => r.fixtureId ?? '(unknown fixture)');
  if (failing.length > 0) {
    fail(`leakage audit has not passed: pass:false row(s) for ${[...new Set(failing)].join(', ')} in ${path}`);
  }
  const covered = new Set(rows.map((r) => r.fixtureId));
  const uncovered = fixtureIds.filter((id) => !covered.has(id));
  if (uncovered.length > 0) {
    fail(`leakage audit has not passed: no audit row for fixture(s) ${uncovered.join(', ')} in ${path}`);
  }
  return { path, rows };
}

/**
 * Enumerate cells in the committed run order, cross-checked against the
 * corpus manifest and the on-disk fixtures (fail closed on any drift).
 */
export function enumerateCells({ expRoot, corpusDir, runsDir }) {
  const order = loadRunOrder(expRoot);
  const manifest = loadCorpusManifest(corpusDir);
  const byFixture = new Map(manifest.map((r) => [r.fixtureId, r]));
  const orderFixtures = [...new Set(order.map((c) => c.fixtureId))];
  const notInManifest = orderFixtures.filter((id) => !byFixture.has(id));
  if (notInManifest.length > 0) fail(`run-order fixture(s) missing from corpus manifest: ${notInManifest.join(', ')}`);
  const notInOrder = manifest.filter((r) => !orderFixtures.includes(r.fixtureId)).map((r) => r.fixtureId);
  if (notInOrder.length > 0) fail(`corpus manifest fixture(s) missing from run order (ledger/corpus drift): ${notInOrder.join(', ')}`);
  for (const id of orderFixtures) {
    const dir = join(corpusDir, id);
    const task = readJson(join(dir, 'task.json'), `fixture task.json (${id})`);
    if (task.fixtureId !== id) fail(`fixture ${id}: task.json fixtureId '${task.fixtureId}' does not match its directory`);
    if (task.trapClass !== byFixture.get(id).trapClass) fail(`fixture ${id}: task.json trapClass '${task.trapClass}' does not match the manifest`);
    if (!existsSync(join(dir, 'workspace'))) fail(`fixture ${id}: workspace/ missing at ${dir}`);
    if (!existsSync(join(dir, 'prompt.md'))) fail(`fixture ${id}: prompt.md missing at ${dir}`);
  }
  return order.map(({ fixtureId, arm }, i) => ({
    index: i + 1,
    fixtureId,
    arm,
    trapClass: byFixture.get(fixtureId).trapClass,
    fixtureDir: join(corpusDir, fixtureId),
    runDir: join(runsDir, runDirName(fixtureId, arm)),
    terminal: isTerminalRunDir(join(runsDir, runDirName(fixtureId, arm))),
  }));
}

/** Append one row to the append-only progress ledger. */
export function appendProgress(expRoot, row) {
  mkdirSync(expRoot, { recursive: true });
  appendFileSync(join(expRoot, PROGRESS_FILENAME), JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
}

/** Child env base: never leak LATTICE_PROJECT_ROOT or stale experiment vars. */
function childEnvBase() {
  const env = { ...process.env };
  delete env.LATTICE_PROJECT_ROOT; // would redirect the child's root resolution outside the isolated root
  delete env.LATTICE_EXPERIMENT_ID;
  delete env.LATTICE_EXPERIMENT_ARM;
  delete env.LATTICE_GLOBAL_MEMORY_DIR; // per-cell value is set explicitly; an inherited one would leak
  return env;
}

/**
 * Store-isolation assertion (plan section 12), BEFORE host execution: the
 * real CLI's observability_snapshot resolvedLearningRoot for the isolated
 * workspace cwd must equal <workspace>/.lattice/learning. Read-only spawn.
 */
export function assertIsolatedLearningRoot({ hostCwd, snapshotCli }) {
  if (!existsSync(snapshotCli)) {
    fail(`isolation probe CLI missing: ${snapshotCli} — build it first (npm --prefix packages/main run build) or pass --snapshotCli`);
  }
  const expected = normalize(join(hostCwd, '.lattice', 'learning'));
  const res = spawnSync('node', [snapshotCli, 'observability_snapshot', '--json'], {
    cwd: hostCwd, env: childEnvBase(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
  });
  if (res.error || res.status !== 0) {
    fail(`isolation probe failed to run (exit ${res.status ?? 'spawn-error'}): ${(res.error?.message ?? res.stderr ?? '').slice(0, 300)}`);
  }
  let resolved;
  try {
    const jsonStart = res.stdout.indexOf('{');
    resolved = JSON.parse(res.stdout.slice(jsonStart)).resolvedLearningRoot;
  } catch { fail(`isolation probe output is not parseable JSON (${snapshotCli} observability_snapshot --json)`); }
  if (typeof resolved !== 'string' || normalize(resolved) !== expected) {
    fail(`store-isolation assertion failed: resolvedLearningRoot ${resolved} != expected isolated root ${expected} — the workspace is not an isolated non-git root (plan section 12); aborting before host execution`);
  }
  return expected;
}

// ---------------------------------------------------------------------------
// CHK-005: frozen-snapshot materialization + verification helpers.

/**
 * Enumerate the snapshot's file set as relative paths in EXACTLY the traversal
 * order protocol.mjs hashDirectorySnapshot uses (sorted entries per directory,
 * depth-first), so hashing the same set elsewhere reproduces the same digest.
 */
export function listSnapshotFiles(snapshotDir) {
  const rels = [];
  const walk = (d) => {
    for (const entry of readdirSync(d).sort()) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else rels.push(p.slice(snapshotDir.length + 1));
    }
  };
  walk(snapshotDir);
  if (rels.length === 0) fail(`memory snapshot dir is empty: ${snapshotDir}`);
  return rels;
}

/**
 * sha256 over the snapshot FILE SET rooted at baseDir (relpath + NUL + bytes +
 * NUL per file, in the given order) — byte-compatible with protocol.mjs
 * hashDirectorySnapshot over the original snapshot dir. A missing/unreadable
 * file yields a clearly-mismatching sentinel digest instead of throwing, so
 * callers uniformly report "hash mismatch" (deleted frozen file == drift).
 */
export function hashSnapshotFileSet(baseDir, relPaths) {
  const h = createHash('sha256');
  for (const rel of relPaths) {
    let bytes;
    try { bytes = readFileSync(join(baseDir, rel)); }
    catch { return `missing-or-unreadable:${rel}`; }
    h.update(rel);
    h.update('\0');
    h.update(bytes);
    h.update('\0');
  }
  return h.digest('hex');
}

/**
 * Verify the materialized snapshot copy under <hostCwd>/.lattice still hashes
 * to the frozen protocol memorySnapshotHash. `when` names the phase for the
 * one-line abort message ('BEFORE host execution' / 'AFTER the run').
 */
export function verifyMaterializedSnapshot({ hostCwd, relPaths, expectedHash, when }) {
  const actual = hashSnapshotFileSet(join(hostCwd, '.lattice'), relPaths);
  if (actual !== expectedHash) {
    fail(`memory snapshot verification failed ${when}: materialized store hash ${actual} != frozen protocol.json memorySnapshotHash ${expectedHash} — the frozen store was mutated; aborting cell (fail closed, no run.json)`);
  }
}

/** Marker line opening the pack section session_brief renders on treatment. */
export const MEMORY_PACK_SECTION_HEADER = '## Memory Runtime Preflight';

/**
 * Extract the rendered pack section from session_brief stdout: the header
 * line plus every consecutive following line indented with two spaces.
 * Returns null when the entrypoint did not render the section (control arm,
 * or the early-return path of a store with no stories).
 */
export function extractMemoryPackSection(stdout) {
  const lines = String(stdout).split('\n');
  const start = lines.findIndex((l) => l.trimEnd() === MEMORY_PACK_SECTION_HEADER);
  if (start === -1) return null;
  const section = [lines[start].trimEnd()];
  for (let i = start + 1; i < lines.length && lines[i].startsWith('  '); i++) {
    section.push(lines[i]);
  }
  return section.join('\n');
}

/**
 * Experience-delivery prelude (CHK-005): run the real gated entrypoint
 * `node <snapshotCli> session_brief` with the experiment env, cwd = hostCwd,
 * so the pack computes+logs through the production M3 mechanism on BOTH arms.
 * Fail-closed arm contract (see the module header). Returns
 * { packSection, transcript, surfacedEvent }.
 */
export function runExperiencePrelude({ hostCwd, snapshotCli, hostEnv, experimentId, arm }) {
  const res = spawnSync('node', [snapshotCli, 'session_brief'], {
    cwd: hostCwd, env: hostEnv, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120_000,
  });
  const transcript = `# prelude: node ${snapshotCli} session_brief (arm=${arm})\n# exit: ${res.status ?? 'spawn-error'}\n--- stdout ---\n${res.stdout ?? ''}\n--- stderr ---\n${res.stderr ?? ''}\n`;
  if (res.error || res.status !== 0) {
    fail(`experience-delivery prelude failed (session_brief exit ${res.status ?? 'spawn-error'}): ${(res.error?.message ?? res.stderr ?? '').slice(0, 300)} — aborting cell (fail closed)`);
  }
  const packSection = extractMemoryPackSection(res.stdout ?? '');
  if (arm === 'control' && packSection !== null) {
    fail(`arm contract violation: control-arm session_brief RENDERED the memory pack section — the render gate did not suppress it; aborting cell (fail closed)`);
  }
  if (arm === 'treatment' && packSection === null) {
    fail(`experience-delivery gap: treatment-arm session_brief rendered NO memory pack section — the experiment cell would be null by construction (check the frozen snapshot carries the anchor story and lessons); aborting cell (fail closed)`);
  }
  // Both arms MUST have logged the experience_pack_surfaced event with a
  // non-empty topHitIds (the measurement backbone; scorer surfacedMemoryIds).
  const activityPath = join(hostCwd, '.lattice', 'activity.jsonl');
  let surfacedEvent = null;
  if (existsSync(activityPath)) {
    for (const line of readFileSync(activityPath, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const e = JSON.parse(s);
        if (e.event === 'experience_pack_surfaced' && e.experimentId === experimentId && e.arm === arm) {
          surfacedEvent = e;
          break;
        }
      } catch { /* torn line */ }
    }
  }
  if (!surfacedEvent || !Array.isArray(surfacedEvent.topHitIds) || surfacedEvent.topHitIds.length === 0) {
    fail(`experience-delivery prelude logged no usable experience_pack_surfaced event for arm '${arm}' (event ${surfacedEvent ? 'present but topHitIds empty' : 'missing'}) — the pack surfaced nothing from the frozen store; aborting cell (fail closed)`);
  }
  return { packSection, transcript, surfacedEvent };
}

/** Substitute --hostCmd template placeholders. */
export function renderHostCmd(template, { workspace, promptFile, isolatedRoot }) {
  return template
    .replaceAll('{workspace}', workspace)
    .replaceAll('{promptFile}', promptFile)
    .replaceAll('{isolatedRoot}', isolatedRoot);
}

/** Collect the run-scoped activity slice text from the isolated root. */
function collectActivitySlice(isolatedRoot, hostCwd) {
  let text = '';
  for (const base of [hostCwd, isolatedRoot]) {
    const p = join(base, '.lattice', 'activity.jsonl');
    if (existsSync(p)) text += readFileSync(p, 'utf8');
  }
  return text;
}

/** commandCount proxy: parsable slice entries carrying a per-command `tool`. */
export function countCommands(sliceText) {
  let n = 0;
  for (const line of sliceText.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { const e = JSON.parse(s); if (typeof e.tool === 'string') n++; } catch { /* torn line: not a command record */ }
  }
  return n;
}

/** Execute one cell end-to-end. Returns the written run dir. */
function runCell(cell, cfg) {
  const { experimentId, expRoot } = cfg;
  appendProgress(expRoot, { event: 'cell_start', experimentId, fixtureId: cell.fixtureId, arm: cell.arm });

  // Fresh isolated NON-GIT root (realpath so the child's os-resolved cwd
  // compares byte-equal on macOS /var -> /private/var symlinks).
  const isolatedRoot = realpathSync(mkdtempSync(join(cfg.scratchDir, `ablation-${cell.fixtureId}-${cell.arm}-`)));
  const hostCwd = join(isolatedRoot, 'workspace');
  try {
    cpSync(join(cell.fixtureDir, 'workspace'), hostCwd, { recursive: true });
    const promptFile = join(isolatedRoot, 'prompt.md');
    cpSync(join(cell.fixtureDir, 'prompt.md'), promptFile);
    // Visible acceptance beside workspace/ (it resolves ./workspace itself).
    const acceptancePath = join(isolatedRoot, 'acceptance.mjs');
    if (existsSync(join(cell.fixtureDir, 'acceptance.mjs'))) cpSync(join(cell.fixtureDir, 'acceptance.mjs'), acceptancePath);

    // CHK-005 1b: materialize the frozen snapshot byte-identically into the
    // isolated root's learning path (BOTH arms), then verify BEFORE the host.
    cpSync(cfg.memorySnapshotDir, join(hostCwd, '.lattice'), { recursive: true });
    verifyMaterializedSnapshot({
      hostCwd, relPaths: cfg.snapshotRelPaths,
      expectedHash: cfg.memorySnapshotHash, when: 'BEFORE host execution',
    });
    const globalMemoryDir = join(isolatedRoot, 'global-memory');
    mkdirSync(globalMemoryDir, { recursive: true });

    // HARD GATE before the host: the resolved learning root IS the isolated root.
    const storeRoot = assertIsolatedLearningRoot({ hostCwd, snapshotCli: cfg.snapshotCli });

    const hostEnv = {
      ...childEnvBase(),
      LATTICE_EXPERIMENT_ID: experimentId,
      LATTICE_EXPERIMENT_ARM: cell.arm,
      LATTICE_GLOBAL_MEMORY_DIR: globalMemoryDir,
    };

    // CHK-005 2b: experience-delivery prelude through the production gated
    // entrypoint; compose the host prompt (control stays byte-identical).
    const { packSection, transcript: preludeTranscript } = runExperiencePrelude({
      hostCwd, snapshotCli: cfg.snapshotCli, hostEnv, experimentId, arm: cell.arm,
    });
    const rawPrompt = readFileSync(promptFile, 'utf8');
    const hostPrompt = packSection === null ? rawPrompt : `${packSection}\n\n${rawPrompt}`;
    const hostPromptFile = join(isolatedRoot, 'host-prompt.md');
    writeFileSync(hostPromptFile, hostPrompt);

    const cmd = renderHostCmd(cfg.hostCmd, { workspace: hostCwd, promptFile: hostPromptFile, isolatedRoot });
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const host = spawnSync(cmd, {
      shell: true, cwd: hostCwd, env: hostEnv, encoding: 'utf8',
      timeout: cfg.timeoutMs, maxBuffer: 64 * 1024 * 1024,
    });
    const endedAt = new Date().toISOString();
    const elapsedMs = Date.now() - t0;
    const hostTimedOut = host.error?.code === 'ETIMEDOUT';
    if (host.error && !hostTimedOut) {
      fail(`host command failed to spawn for ${cell.fixtureId}::${cell.arm}: ${host.error.message} (cmd: ${cmd.slice(0, 200)})`);
    }
    const hostExitCode = hostTimedOut ? null : (host.status ?? null);

    // CHK-005: re-verify the frozen snapshot AFTER the run (fail closed BEFORE
    // any scoring input or run.json exists — a mutated store voids the cell).
    verifyMaterializedSnapshot({
      hostCwd, relPaths: cfg.snapshotRelPaths,
      expectedHash: cfg.memorySnapshotHash, when: 'AFTER the run',
    });

    // Mechanical outcomes (documented in the module header).
    let doneReached = false;
    if (existsSync(acceptancePath)) {
      const acc = spawnSync('node', [acceptancePath], { cwd: isolatedRoot, encoding: 'utf8', timeout: 60_000 });
      doneReached = acc.status === 0;
    }
    const validationPass = doneReached && hostExitCode === 0;

    // Capture: activity slice + post-run workspace, then run.json LAST.
    const sliceText = collectActivitySlice(isolatedRoot, hostCwd);
    rmSync(cell.runDir, { recursive: true, force: true });
    mkdirSync(cell.runDir, { recursive: true });
    writeFileSync(join(cell.runDir, 'activity.jsonl'), sliceText);
    cpSync(hostCwd, join(cell.runDir, 'workspace'), { recursive: true });
    writeFileSync(join(cell.runDir, 'host-transcript.log'),
      `# cmd: ${cmd}\n# exit: ${hostExitCode} timedOut: ${hostTimedOut}\n--- stdout ---\n${host.stdout ?? ''}\n--- stderr ---\n${host.stderr ?? ''}\n`);
    // CHK-005 audit artifacts: the exact prompt the host received + the
    // prelude transcript (extra files; RUN-RECORD.md consumers ignore them).
    writeFileSync(join(cell.runDir, 'host-prompt.md'), hostPrompt);
    writeFileSync(join(cell.runDir, 'prelude-transcript.log'), preludeTranscript);
    const runRecord = {
      experimentId,
      arm: cell.arm,
      hostId: cfg.hostId,
      storeRoot,
      startedAt,
      endedAt,
      timeToDoneMs: doneReached ? elapsedMs : null,
      commandCount: countCommands(sliceText),
      doneReached,
      validationPass,
      // audit-only extras (RUN-RECORD.md: unknown fields are ignored):
      fixtureId: cell.fixtureId,
      trapClass: cell.trapClass,
      hostExitCode,
      hostTimedOut,
      memorySnapshotHash: cfg.memorySnapshotHash,
      memoryPackRendered: packSection !== null,
    };
    const problems = validateRunRecord(runRecord);
    if (problems.length > 0) fail(`refusing to write malformed run.json for ${cell.fixtureId}::${cell.arm}: ${problems.join('; ')}`);
    writeAtomic(join(cell.runDir, 'run.json'), JSON.stringify(runRecord, null, 2) + '\n');

    appendProgress(expRoot, {
      event: 'cell_done', experimentId, fixtureId: cell.fixtureId, arm: cell.arm,
      runDir: cell.runDir, hostExitCode, hostTimedOut, doneReached, validationPass, elapsedMs,
    });
    rmSync(isolatedRoot, { recursive: true, force: true });
    return cell.runDir;
  } catch (err) {
    appendProgress(expRoot, {
      event: 'cell_abort', experimentId, fixtureId: cell.fixtureId, arm: cell.arm,
      reason: String(err.message ?? err).slice(0, 500),
    });
    // Keep the isolated root for debugging on abort; no run.json = non-terminal.
    throw err;
  }
}

/** Render the --plan cell table. */
export function renderPlanTable(cells) {
  const done = cells.filter((c) => c.terminal).length;
  const idW = Math.max(9, ...cells.map((c) => c.fixtureId.length));
  const clsW = Math.max(9, ...cells.map((c) => c.trapClass.length));
  const lines = [
    `cell  ${'fixtureId'.padEnd(idW)}  ${'arm'.padEnd(9)}  ${'trapClass'.padEnd(clsW)}  status`,
    ...cells.map((c) =>
      `${String(c.index).padStart(4)}  ${c.fixtureId.padEnd(idW)}  ${c.arm.padEnd(9)}  ${c.trapClass.padEnd(clsW)}  ${c.terminal ? 'done' : 'pending'}`),
    `totals: ${cells.length} cells, ${done} done, ${cells.length - done} pending`,
  ];
  return lines.join('\n');
}

// --- CLI --------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) out[a.slice(2)] = true;
      else out[a.slice(2, eq)] = a.slice(eq + 1);
    } else out._.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (!args.experimentId || !args.corpus) {
      fail('required: --experimentId=<id> --corpus=<dir> (see the module header for the full usage)');
    }
    const root = typeof args.root === 'string' ? args.root : defaultRepoRoot();
    const expRoot = experimentRoot(root, String(args.experimentId));
    const corpusDir = String(args.corpus);
    const runsDir = join(expRoot, 'runs');
    const cells = enumerateCells({ expRoot, corpusDir, runsDir });

    if (args.plan === true) {
      console.log(renderPlanTable(cells));
      try {
        const { path } = checkLeakageAudit({
          explicitPath: typeof args.leakageAudit === 'string' ? args.leakageAudit : null,
          expRoot, corpusDir, fixtureIds: [...new Set(cells.map((c) => c.fixtureId))],
        });
        console.log(`leakage-audit: PASS (${path})`);
      } catch (err) {
        console.log(`leakage-audit: NOT PASSED — execution would refuse: ${err.message}`);
      }
      return; // dry-run: exit 0 without executing
    }

    // HARD PRECONDITION: leakage audit passed over the whole corpus.
    checkLeakageAudit({
      explicitPath: typeof args.leakageAudit === 'string' ? args.leakageAudit : null,
      expRoot, corpusDir, fixtureIds: [...new Set(cells.map((c) => c.fixtureId))],
    });

    // HARD PRECONDITION (CHK-005): the frozen memory snapshot is required for
    // execution and must hash to the frozen protocol.json memorySnapshotHash.
    if (typeof args.memorySnapshotDir !== 'string' || args.memorySnapshotDir.length === 0) {
      fail('required: --memorySnapshotDir=<dir> (snapshot-builder.mjs output) — without the frozen store both arms see an empty pack and the experiment is null by construction');
    }
    const memorySnapshotDir = String(args.memorySnapshotDir);
    if (!existsSync(memorySnapshotDir)) fail(`--memorySnapshotDir does not exist: ${memorySnapshotDir}`);
    const protocolDoc = loadFrozenProtocol(root, String(args.experimentId));
    const memorySnapshotHash = protocolDoc.memorySnapshotHash;
    if (typeof memorySnapshotHash !== 'string' || !/^[0-9a-f]{64}$/.test(memorySnapshotHash)) {
      fail(`frozen protocol.json memorySnapshotHash is not a 64-hex sha256 (got ${JSON.stringify(memorySnapshotHash)}) — re-freeze the protocol (protocol.mjs freeze --snapshotDir=...)`);
    }
    const sourceSnapshotHash = hashDirectorySnapshot(memorySnapshotDir);
    if (sourceSnapshotHash !== memorySnapshotHash) {
      fail(`frozen memory snapshot mismatch: --memorySnapshotDir hashes to ${sourceSnapshotHash} but protocol.json memorySnapshotHash is ${memorySnapshotHash} — the snapshot was tampered or the wrong dir was passed; refusing the campaign`);
    }

    const cfg = {
      memorySnapshotDir,
      memorySnapshotHash,
      snapshotRelPaths: listSnapshotFiles(memorySnapshotDir),
      experimentId: String(args.experimentId),
      expRoot,
      hostCmd: typeof args.hostCmd === 'string' ? args.hostCmd : DEFAULT_HOST_CMD,
      hostId: typeof args.hostId === 'string' ? args.hostId : DEFAULT_HOST_ID,
      scratchDir: typeof args.scratchDir === 'string' ? args.scratchDir : tmpdir(),
      timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : DEFAULT_TIMEOUT_MS,
      snapshotCli: typeof args.snapshotCli === 'string' ? args.snapshotCli : defaultSnapshotCli(root),
    };
    if (!Number.isFinite(cfg.timeoutMs) || cfg.timeoutMs <= 0) fail('--timeoutMs must be a positive number');
    const maxCells = args.smoke === true ? 1 : (args.maxCells ? Number(args.maxCells) : Infinity);
    if (!(maxCells > 0)) fail('--maxCells must be a positive integer');

    appendProgress(expRoot, {
      event: 'campaign_start', experimentId: cfg.experimentId,
      cells: cells.length, pending: cells.filter((c) => !c.terminal).length, maxCells: maxCells === Infinity ? null : maxCells,
    });
    let executed = 0, skipped = 0;
    for (const cell of cells) {
      if (cell.terminal) {
        skipped++;
        appendProgress(expRoot, { event: 'cell_skip', experimentId: cfg.experimentId, fixtureId: cell.fixtureId, arm: cell.arm, reason: 'terminal run.json present' });
        console.log(`SKIP ${cell.fixtureId}::${cell.arm} (terminal)`);
        continue;
      }
      if (executed >= maxCells) break;
      console.log(`RUN  ${cell.fixtureId}::${cell.arm} (cell ${cell.index}/${cells.length})`);
      runCell(cell, cfg);
      executed++;
      console.log(`DONE ${cell.fixtureId}::${cell.arm}`);
    }
    const pendingLeft = cells.filter((c) => !isTerminalRunDir(c.runDir)).length;
    appendProgress(expRoot, { event: 'campaign_end', experimentId: cfg.experimentId, executed, skipped, pendingLeft });
    console.log(`pilot: ${cells.length} cells, ${skipped} skipped (terminal), ${executed} executed, ${pendingLeft} still pending`);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
