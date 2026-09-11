#!/usr/bin/env node

/**
 * Persistent RED -> GREEN contract for B-e40f.
 *
 * This file deliberately freezes the pre-refactor 73-case identity/title/domain
 * mapping.  It is not a snapshot that accepts today's behaviour: each selector
 * states the desired contract and therefore fails on the unchanged baseline.
 *
 * The implementation-facing seams exercised here are intentionally small:
 *
 * - quorum-submit-smoke.js: --case, fail-closed --grep, and --list-cases=json
 * - quorum-submit-smoke-case-catalog.js:
 *     validateQuorumSmokeInventory({ manifestCases, executableCases })
 *     validateQuorumSmokePartitions({ cases })
 * - quorum-submit-smoke-fixture.js:
 *     QUORUM_SMOKE_FIXTURE_TEMPLATE_MANIFEST
 *     createQuorumSmokeFixtureTemplatePool({ cacheRoot, buildTemplate })
 * - quorum-submit-smoke-worker.js: MAX_QUORUM_SMOKE_JOBS and
 *     runQuorumSmokeCoordinator({ registrations, jobs, timeoutMs, context })
 *
 * Missing target modules are reported as a target-specific RED. A target source
 * that exists without a built artifact, or cannot be imported, is reported as a
 * BOOTSTRAP_ERROR so build/syntax noise cannot be mistaken for product evidence.
 */

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import {
  closeSync,
  chmodSync,
  cpSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");
const sourceTasks = join(repoRoot, "packages/main/src/tasks");
const distTasks = join(repoRoot, "packages/main/dist/tasks");
const smokeSourcePath = join(sourceTasks, "quorum-submit-smoke.ts");
const smokeDistPath = join(distTasks, "quorum-submit-smoke.js");
const manifestPath = join(sourceTasks, "quorum-submit-smoke-cases.json");
const catalogSourcePath = join(sourceTasks, "quorum-submit-smoke-case-catalog.ts");
const catalogDistPath = join(distTasks, "quorum-submit-smoke-case-catalog.js");
const fixtureSourcePath = join(sourceTasks, "quorum-submit-smoke-fixture.ts");
const fixtureDistPath = join(distTasks, "quorum-submit-smoke-fixture.js");
const workerSourcePath = join(sourceTasks, "quorum-submit-smoke-worker.ts");
const workerDistPath = join(distTasks, "quorum-submit-smoke-worker.js");
const validationChildEnvironmentPath = join(sourceTasks, "validation-child-environment.mjs");
const validationCaseAdapterPath = join(sourceTasks, "story-aware-validation-case-adapter.mjs");
const validationDomainRunnerPath = join(sourceTasks, "story-aware-validation-domain-case-runner.mjs");
const storyAwareValidationHandlerPath = join(repoRoot, "packages/main/src/handlers/story-aware-validation.ts");
const validationRuntimeTracerPath = join(repoRoot, "packages/main/src/core/validation-runtime-tracer.cjs");
const integrationCasesSourcePath = join(sourceTasks, "quorum-submit-smoke-integration-cases.ts");
const FIXTURE_HANDLER_PROBE_SOURCE = [
  "const { readFileSync } = require('node:fs');",
  "const story = JSON.parse(readFileSync(3, 'utf8'));",
  "if (story.phase !== 'REVIEW') process.exit(9);",
  "console.log('HANDLER_PASS B-template');",
  "",
].join("\n");
const caseSourcePaths = [
  smokeSourcePath,
  join(sourceTasks, "quorum-submit-smoke-pure-cases.ts"),
  integrationCasesSourcePath,
  join(sourceTasks, "quorum-submit-smoke-prune-cases.ts"),
];
const configPath = join(repoRoot, "proof-or-stop.config.json");
const dynRegistryPath = join(sourceTasks, "story-aware-validation-domain-cases.json");
const ORIGINAL_SMOKE_COMMIT = "3eec15009ba93740b5dd74c0563bf1b3ca098b32";
const BOUNDED_SHELL_SOURCE_DIGEST = "583509e6565ee7c736cc959152c91f66c9cb89bb0a5714c32548ff1c3e8e1d97";
const harnessRelativePath = relative(repoRoot, fileURLToPath(import.meta.url)).split(sep).join("/");
const EXACT_HEAD_ISOLATION_SELECTORS = new Set([
  "selector-contract",
  "partition-contract",
  "fixture-template-contract",
  "coordinator-fault-contract",
  "resource-parallel-contract",
]);
const EXACT_HEAD_ISOLATION_SCHEMA = "proof-or-stop.b-e40f.exact-head-isolation.v1";
// qsm-022 is an intentionally Git-heavy integration witness. Two fresh-process
// measurements on this host completed in 93.1s and 124.9s, so 90s was a false
// timeout rather than an order-dependence failure.
const SELECTOR_CASE_TIMEOUT_MS = 180_000;
const SELECTOR_WORKER_ENVELOPE_MS = 1_000;
const SELECTOR_CLEANUP_ALLOWANCE_MS = 30_000;
const SELECTOR_OUTER_TIMEOUT_MS = 240_000;
// fd 3 is already used by the fixture-handler probe. Node 26/libuv aborts on
// sufficiently high inherited stdio indexes on macOS, so keep this lease on
// the first source-audited free descriptor instead of using a sparse high fd.
const EXACT_HEAD_TREE_LEASE_FD = 4;
const EXACT_HEAD_TREE_LEASE_ROOT_ENV = "PROOF_OR_STOP_B_E40F_TREE_LEASE_ROOT";
const EXACT_HEAD_TREE_LEASE_GUARDIAN_ENV = "PROOF_OR_STOP_B_E40F_TREE_LEASE_GUARDIAN";
const EXACT_HEAD_TREE_LEASE_RELEASE_PATH_ENV = "PROOF_OR_STOP_B_E40F_TREE_LEASE_RELEASE_PATH";
const EXACT_HEAD_TREE_LEASE_RELEASE_NONCE_ENV = "PROOF_OR_STOP_B_E40F_TREE_LEASE_RELEASE_NONCE";
const EXACT_HEAD_TREE_LEASE_MARKER_ENV = "PROOF_OR_STOP_B_E40F_TREE_LEASE_MARKER";
const EXACT_HEAD_TREE_LEASE_TRACE_TRANSPORT_ENV_KEYS = new Set([
  EXACT_HEAD_TREE_LEASE_ROOT_ENV,
  EXACT_HEAD_TREE_LEASE_GUARDIAN_ENV,
  EXACT_HEAD_TREE_LEASE_RELEASE_PATH_ENV,
  EXACT_HEAD_TREE_LEASE_RELEASE_NONCE_ENV,
  EXACT_HEAD_TREE_LEASE_MARKER_ENV,
]);
const EXACT_HEAD_ISOLATION_MANIFEST_ENV = "PROOF_OR_STOP_B_E40F_EXACT_HEAD_MANIFEST";
const EXACT_HEAD_ISOLATION_NONCE_ENV = "PROOF_OR_STOP_B_E40F_EXACT_HEAD_NONCE";
const EXACT_HEAD_ISOLATION_ENV_KEYS = new Set([
  EXACT_HEAD_ISOLATION_MANIFEST_ENV,
  EXACT_HEAD_ISOLATION_NONCE_ENV,
  EXACT_HEAD_TREE_LEASE_ROOT_ENV,
  EXACT_HEAD_TREE_LEASE_GUARDIAN_ENV,
  EXACT_HEAD_TREE_LEASE_RELEASE_PATH_ENV,
  EXACT_HEAD_TREE_LEASE_RELEASE_NONCE_ENV,
  EXACT_HEAD_TREE_LEASE_MARKER_ENV,
]);
let exactHeadOuterSupervisorSafetyProven = false;
const SETUP_REFACTORED_CASE_IDS = new Set([
  "qsm-023", "qsm-024", "qsm-025", "qsm-026", "qsm-027", "qsm-029", "qsm-030",
]);

function exactHeadTreeLeasePreloadSource(requiredTreeMarker) {
  contract(
    typeof requiredTreeMarker === "string"
      && requiredTreeMarker.length >= 16
      && !/\s/.test(requiredTreeMarker),
    "exact-HEAD tree marker is invalid",
  );
  return [
    '"use strict";',
    'const childProcess = require("node:child_process");',
    'const { fstatSync } = require("node:fs");',
    'const { syncBuiltinESMExports } = require("node:module");',
    'const { basename, isAbsolute } = require("node:path");',
    'const { promisify } = require("node:util");',
    `const leaseFd = ${EXACT_HEAD_TREE_LEASE_FD};`,
    `const rootFlag = ${json(EXACT_HEAD_TREE_LEASE_ROOT_ENV)};`,
    `const guardianKey = ${json(EXACT_HEAD_TREE_LEASE_GUARDIAN_ENV)};`,
    `const releasePathKey = ${json(EXACT_HEAD_TREE_LEASE_RELEASE_PATH_ENV)};`,
    `const releaseNonceKey = ${json(EXACT_HEAD_TREE_LEASE_RELEASE_NONCE_ENV)};`,
    `const treeMarkerKey = ${json(EXACT_HEAD_TREE_LEASE_MARKER_ENV)};`,
    `const requiredTreeMarker = ${json(requiredTreeMarker)};`,
    'const inheritedProcessTitle = process.title;',
    // Node can initialize process.title to the absolute executable path. On
    // POSIX, assigning a longer title is bounded by the original argv storage,
    // so prefixing that whole path can truncate its tail and make the preload
    // reject an otherwise healthy short-argv child. The basename is the stable
    // informational identity; requiredTreeMarker remains the cleanup authority.
    'const preservedProcessTitle = isAbsolute(inheritedProcessTitle)',
    '  ? basename(inheritedProcessTitle)',
    '  : inheritedProcessTitle;',
    'const inheritedTreeMarker = process.env[treeMarkerKey];',
    'if (inheritedTreeMarker !== undefined && inheritedTreeMarker !== requiredTreeMarker) {',
    '  throw new Error("tree-lease inherited marker does not match its preload authority");',
    '}',
    'process.env[treeMarkerKey] = requiredTreeMarker;',
    'if (inheritedProcessTitle !== requiredTreeMarker',
    '  && !inheritedProcessTitle.startsWith(requiredTreeMarker + ":")) {',
    '  process.title = requiredTreeMarker + ":" + preservedProcessTitle;',
    '}',
    'const executableIdentityBound = isAbsolute(inheritedProcessTitle)',
    '  && basename(process.execPath) === preservedProcessTitle;',
    'if (process.env[treeMarkerKey] !== requiredTreeMarker',
    '  || (!process.title.includes(preservedProcessTitle)',
    '    && !executableIdentityBound)) {',
    '  throw new Error("tree-lease process title cannot preserve outer and inner identities");',
    '}',
    'const guardRoot = process.env[rootFlag] === "1";',
    'const guardianMarker = process.env[guardianKey];',
    'const releasePath = process.env[releasePathKey];',
    'const releaseNonce = process.env[releaseNonceKey];',
    'delete process.env[rootFlag];',
    'delete process.env[guardianKey];',
    'delete process.env[releasePathKey];',
    'delete process.env[releaseNonceKey];',
    'if (guardRoot && (typeof guardianMarker !== "string" || guardianMarker.length < 16',
    '  || /\\s/.test(guardianMarker) || typeof releasePath !== "string"',
    '  || !isAbsolute(releasePath) || /\\s/.test(releasePath)',
    '  || typeof releaseNonce !== "string" || releaseNonce.length < 16)) {',
    '  throw new Error("tree-lease guardian authority is incomplete");',
    '}',
    'if (/\\s/.test(__filename)) throw new Error("tree-lease preload path contains unsupported whitespace");',
    'const trustedRequire = "--require=" + __filename;',
    'fstatSync(leaseFd);',
    'function leaseStdio(stdio, forkMode = false, forkSilent = false) {',
    '  let result;',
    '  if (Array.isArray(stdio)) {',
    '    result = [...stdio];',
    '    if (forkMode && result.filter((entry) => entry === "ipc").length !== 1) {',
    '      throw new Error("tree-lease fork requires exactly one ipc descriptor");',
    '    }',
    '  }',
    '  else {',
    '    const mode = stdio ?? (forkMode && !forkSilent ? "inherit" : "pipe");',
    '    if (!new Set(["pipe", "ignore", "inherit"]).has(mode)) {',
    '      throw new Error("tree-lease preload rejects unsupported stdio shorthand");',
    '    }',
    '    result = [mode, mode, mode];',
    '    if (forkMode) result.push("ipc");',
    '  }',
    '  while (result.length < leaseFd) result.push("ignore");',
    '  const existing = result[leaseFd];',
    '  if (existing !== undefined && existing !== null) {',
    '    throw new Error("tree-lease fd collides with child stdio");',
    '  }',
    '  result[leaseFd] = "inherit";',
    '  return result;',
    '}',
    'function preserveMetadata(original, replacement) {',
    '  for (const key of Reflect.ownKeys(original)) {',
    '    if (["length", "name", "prototype", "arguments", "caller"].includes(key)) continue;',
    '    const descriptor = Object.getOwnPropertyDescriptor(original, key);',
    '    if (descriptor) Object.defineProperty(replacement, key, descriptor);',
    '  }',
    '  return replacement;',
    '}',
    'function leaseOptions(options, forkMode = false) {',
    '  if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options))) {',
    '    throw new Error("tree-lease preload rejects non-object child options");',
    '  }',
    '  const result = { ...(options ?? {}) };',
    '  if (result.shell !== undefined && result.shell !== false) {',
    '    throw new Error("tree-lease preload rejects child shell overrides");',
    '  }',
    '  if (forkMode && result.execPath !== undefined && result.execPath !== process.execPath) {',
    '    throw new Error("tree-lease preload rejects fork execPath overrides");',
    '  }',
    '  if (result.env !== undefined) {',
    '    if (result.env === null || typeof result.env !== "object" || Array.isArray(result.env)) {',
    '      throw new Error("tree-lease preload rejects non-object child env");',
    '    }',
    '    const childEnv = { ...result.env };',
    '    const aliases = Object.keys(childEnv).filter((key) => key.toUpperCase() === "NODE_OPTIONS");',
    '    if (aliases.some((key) => key !== "NODE_OPTIONS") || aliases.length > 1) {',
    '      throw new Error("tree-lease preload rejects non-canonical NODE_OPTIONS");',
    '    }',
    '    const inheritedOptions = childEnv.NODE_OPTIONS ?? "";',
    '    if (typeof inheritedOptions !== "string") {',
    '      throw new Error("tree-lease preload rejects non-string NODE_OPTIONS");',
    '    }',
    '    const suppliedTreeMarker = childEnv[treeMarkerKey];',
    '    if (suppliedTreeMarker !== undefined && suppliedTreeMarker !== requiredTreeMarker) {',
    '      throw new Error("tree-lease child environment changes its ownership marker");',
    '    }',
    '    childEnv.NODE_OPTIONS = inheritedOptions.split(/\\s+/).includes(trustedRequire)',
    '      ? inheritedOptions',
    '      : (inheritedOptions + " " + trustedRequire).trim();',
    '    childEnv[treeMarkerKey] = requiredTreeMarker;',
    '    result.env = childEnv;',
    '  }',
    '  result.stdio = leaseStdio(result.stdio, forkMode, result.silent === true);',
    '  return result;',
    '}',
    'const originalSpawn = childProcess.spawn;',
    'if (guardRoot) {',
    '  const guardianSource = [',
    '    "const { readFileSync } = require(\\"node:fs\\");",',
    '    "const releasePath = " + JSON.stringify(releasePath) + ";",',
    '    "const releaseNonce = " + JSON.stringify(releaseNonce) + ";",',
    '    "const hold = setTimeout(() => process.exit(86), 7200000);",',
    '    "let disconnected = false;",',
    '    "const poll = setInterval(() => {",',
    '    "  if (!disconnected) return;",',
    '    "  try {",',
    '    "    if (readFileSync(releasePath, \\"utf8\\") !== releaseNonce) return;",',
    '    "    clearTimeout(hold);",',
    '    "    clearInterval(poll);",',
    '    "    process.exit(0);",',
    '    "  } catch {}",',
    '    "}, 20);",',
    '    "for (const signal of [\\"SIGINT\\", \\"SIGHUP\\", \\"SIGTERM\\"]) {",',
    '    "  try { process.on(signal, () => {}); } catch {}",',
    '    "}",',
    '    "process.once(\\"disconnect\\", () => { disconnected = true; });",',
    '  ].join("\\n");',
    '  const guardianEnv = { ...process.env };',
    '  delete guardianEnv[rootFlag];',
    '  const guardian = originalSpawn(process.execPath, ["--title=" + guardianMarker, "-e", guardianSource], {',
    '    detached: process.platform !== "win32",',
    '    env: guardianEnv,',
    '    stdio: ["ignore", "ignore", "ignore", "ipc", "inherit"],',
    '    windowsHide: true,',
    '  });',
    '  guardian.once("error", (error) => {',
    '    console.error("tree-lease guardian failed: " + error.message);',
    '    process.exit(86);',
    '  });',
    '  guardian.unref();',
    '  guardian.channel?.unref();',
    '}',
    'childProcess.spawn = preserveMetadata(originalSpawn, function(command, args, options) {',
    '  return Array.isArray(args)',
    '    ? originalSpawn.call(this, command, args, leaseOptions(options))',
    '    : originalSpawn.call(this, command, leaseOptions(args));',
    '});',
    'const originalSpawnSync = childProcess.spawnSync;',
    'childProcess.spawnSync = preserveMetadata(originalSpawnSync, function(command, args, options) {',
    '  return Array.isArray(args)',
    '    ? originalSpawnSync.call(this, command, args, leaseOptions(options))',
    '    : originalSpawnSync.call(this, command, leaseOptions(args));',
    '});',
    'const originalExecFileSync = childProcess.execFileSync;',
    'childProcess.execFileSync = preserveMetadata(originalExecFileSync, function(file, args, options) {',
    '  return Array.isArray(args)',
    '    ? originalExecFileSync.call(this, file, args, leaseOptions(options))',
    '    : originalExecFileSync.call(this, file, leaseOptions(args));',
    '});',
    'const originalExecSync = childProcess.execSync;',
    'childProcess.execSync = preserveMetadata(originalExecSync, function(command, options) {',
    '  return originalExecSync.call(this, command, leaseOptions(options));',
    '});',
    'function rejectExecFile() { throw new Error("tree-lease mode rejects async execFile authority"); }',
    'function rejectExec() { throw new Error("tree-lease mode rejects async exec authority"); }',
    'Object.defineProperty(rejectExecFile, promisify.custom, {',
    '  configurable: true, value: async function() { return rejectExecFile(); },',
    '});',
    'Object.defineProperty(rejectExec, promisify.custom, {',
    '  configurable: true, value: async function() { return rejectExec(); },',
    '});',
    'childProcess.execFile = rejectExecFile;',
    'childProcess.exec = rejectExec;',
    'const originalFork = childProcess.fork;',
    'childProcess.fork = preserveMetadata(originalFork, function(modulePath, args, options) {',
    '  return Array.isArray(args)',
    '    ? originalFork.call(this, modulePath, args, leaseOptions(options, true))',
    '    : originalFork.call(this, modulePath, leaseOptions(args, true));',
    '});',
    'syncBuiltinESMExports();',
    '',
  ].join("\n");
}

const EXPECTED_CASES = [
  ["qsm-001", "every production process-event writer honors the shared append lock", "integration"],
  ["qsm-002", "reviewer provider mapping is explicit and unsupported providers fail closed", "pure"],
  ["qsm-003", "explicit invalid provider wins over competing host inference while true absence still infers", "pure"],
  ["qsm-004", "real story-owned fixture delta is host-independent and requires case-level Story intent closure", "integration"],
  ["qsm-005", "duplicate fixture identities always force full regardless of alias or ordering", "integration"],
  ["qsm-006", "review_run_start CLI records reviewer-requested full escalation in envelope and signed run", "integration"],
  ["qsm-007", "unsupported session providers cannot enter the dispatch-to-review-run-to-gate chain", "integration"],
  ["qsm-008", "Codex and Claude CLI provider aliases complete the thin zero-asset review chain", "integration"],
  ["qsm-009", "shared binding derivation is byte-identical to the former quorum envelopes", "pure"],
  ["qsm-010", "shared derivation preserves optional-head and missing-evidence envelopes", "pure"],
  ["qsm-011", "shared derivation fails closed on every required envelope field", "pure"],
  ["qsm-012", "shared derivation binds every replay-sensitive input", "pure"],
  ["qsm-013", "worktree-local CLI commits the exact quorum batch through the production entrypoint", "integration"],
  ["qsm-014", "explicit full-envelope reviewer evidence crosses collector, REVIEW gate, and quorum admission", "integration"],
  ["qsm-015", "production CLI refuses process-events, staged source, and lifecycle metadata pre-dirt", "integration"],
  ["qsm-016", "historical RED dirty baseline makes CLI validation refuse canonical PASS persistence", "integration"],
  ["qsm-017", "refuses when required reviewer passes are absent and writes no verdicts", "integration"],
  ["qsm-018", "numerically sufficient compatibility/retired-only receipts cannot authorize quorum", "integration"],
  ["qsm-019", "refuses when reviewer passes are stale and writes no verdicts", "integration"],
  ["qsm-020", "machine REVIEW and quorum consume the same full-envelope replay/tamper proof", "integration"],
  ["qsm-021", "explicit full-asset mode binds Claude and Codex independently and rejects selected-host drift", "integration"],
  ["qsm-022", "emits exactly rounds x 2 verdicts after current reviewer passes", "integration"],
  ["qsm-023", "review_escalation_status and review assurance floor report complete voluntary 3x2 rounds", "integration"],
  ["qsm-024", "auto-computed materialDigest and storyFilesHash match current helpers", "integration"],
  ["qsm-025", "hosts are independent by hostId, sessionId, and keyId", "integration"],
  ["qsm-026", "never sets authorityDone, fullAuthorityDone, or productionDone", "integration"],
  ["qsm-027", "refuses a same-material re-submit and writes no new verdicts", "integration"],
  ["qsm-028", "same-material duplicate refusal survives deletion of the ignored verdict cache", "integration"],
  ["qsm-029", "allows a fresh quorum after a material change", "integration"],
  ["qsm-030", "--rounds=N (N != 3) emits exactly N x 2 verdicts with N runIds", "integration"],
  ["qsm-031", "refuses a redundant re-submit when the standing quorum drift-accepts", "integration"],
  ["qsm-032", "blank storyFilesHash on committed legacy verdicts is no-signal for the drift branch", "integration"],
  ["qsm-033", "EMPTY_STORY_FILES_HASH current state allows resubmit instead of falsely drift-accepting (F-035)", "integration"],
  ["qsm-034", "a second main drift does not circumvent the drift-accept refusal", "integration"],
  ["qsm-035", "a story-owned file change after main drift makes the re-quorum genuine again", "integration"],
  ["qsm-036", "refuses pre-existing user dirt before writing any verdict", "integration"],
  ["qsm-037", "foreign append fails exact verification and rolls back only the six owned verdicts", "integration"],
  ["qsm-038", "capture-time failure rolls back the just-written event and verdict JSON", "integration"],
  ["qsm-039", "between-row foreign append preserves foreign bytes and rolls back row two", "integration"],
  ["qsm-040", "writer-owned append identity never claims a foreign row inserted before host_verdict", "integration"],
  ["qsm-041", "rollback never deletes an owned-row byte sequence embedded inside foreign binary", "integration"],
  ["qsm-042", "same-verdictId mutation of a gate-consumed field is refused and rolled back", "integration"],
  ["qsm-043", "rollback preserves a concurrently changed verdict JSON with the same verdictId", "integration"],
  ["qsm-044", "rollback preserves non-UTF8 blank and unterminated foreign suffix bytes exactly", "integration"],
  ["qsm-045", "commit-hook rejection rolls back all rows and a clean retry succeeds once", "integration"],
  ["qsm-046", "atomic quorum commit hashes process-events larger than one MiB", "integration"],
  ["qsm-047", "large atomic quorum commit still rejects a post-manifest mutation", "integration"],
  ["qsm-048", "HEAD movement loses the CAS without reverting the competing HEAD", "integration"],
  ["qsm-049", "rollback conflict preserves competing prefix bytes and removes every countable verdict", "integration"],
  ["qsm-050", "rejects non-independent host identity before writing additional verdicts", "integration"],
  ["qsm-051", "quorum_prune dry-run lists the poisoned duplicates without mutating", "prune"],
  ["qsm-052", "quorum_prune apply removes the losing set, backs up, and the floor returns to full-3x2", "prune"],
  ["qsm-053", "quorum_prune resolves AND executes through the built CLI in the story phase (catalog + policy + DEFAULT_PHASE_TOOLS)", "prune"],
  ["qsm-054", "quorum_prune refuses when there is nothing to prune", "prune"],
  ["qsm-055", "quorum_prune apply refuses on a dirty tree before any mutation", "prune"],
  ["qsm-056", "quorum_prune keeps exactly one event per group for a triple-duplicate", "prune"],
  ["qsm-057", "quorum_prune runIds filter prunes only the specified runIds", "prune"],
  ["qsm-058", "quorum_prune preserves interleaved non-host_verdict lines byte-identically", "prune"],
  ["qsm-059", "quorum_prune keep:oldest-material inverts which duplicate survives", "prune"],
  ["qsm-060", "quorum_prune refuses an uncommitted process-events file", "prune"],
  ["qsm-061", "quorum_prune never overwrites a previous run backup", "prune"],
  ["qsm-062", "quorum_prune apply leaves a clean worktree and a second apply needs no manual git", "prune"],
  ["qsm-063", "quorum_prune apply through the production CLI under codex leaves no process-event dirt", "prune"],
  ["qsm-064", "quorum_prune --dryRun is a real declared flag, is honored, and refuses when combined with --apply", "prune"],
  ["qsm-065", "quorum_prune dryRun:false executes instead of being a silent no-op", "prune"],
  ["qsm-066", "quorum_prune refuses the symmetric apply:false + dryRun:false conflict", "prune"],
  ["qsm-067", "every quorum_prune apply/dryRun description states both executors", "prune"],
  ["qsm-068", "quorum_prune refuses a non-pass duplicate group instead of laundering the round (F-024)", "prune"],
  ["qsm-069", "quorum_prune never deletes a verdict cache path outside the story verdict dir (F-025)", "prune"],
  ["qsm-070", "quorum_prune holds the shared append lock across read and rewrite (F-026)", "prune"],
  ["qsm-071", "quorum_prune installs the pruned log by atomic rename, never an in-place overwrite (F-027)", "prune"],
  ["qsm-072", "quorum_submit re-checks the duplicate guard against the captured HEAD (F-028)", "integration"],
  ["qsm-073", "quorum_submit compares the same-material guard on the normalized digest (F-029)", "integration"],
].map(([id, title, domain]) => ({ id, title, domain }));

const SUPPORTED_CASES = new Map([
  ["selector-contract", selectorContract],
  ["inventory-bijection", inventoryBijection],
  ["partition-contract", partitionContract],
  ["fixture-template-contract", fixtureTemplateContract],
  ["coordinator-fault-contract", proveRealCoordinatorFaultSeam],
  ["detached-containment-contract", async () => {
    const worker = await loadWorkerContract("detached-containment-contract");
    await proveDetachedDescendantContainment(worker);
  }],
  ["worker-safety-contract", async () => {
    const worker = await loadWorkerContract("worker-safety-contract");
    await proveFixtureAndEnvironmentSourceClosure(worker);
    await proveProtectedMutationGuard(worker);
    await proveAmbientGitRoutingIsolation();
    await proveTracedEnvironmentClosureAndDynTemp(worker);
  }],
  ["exact-head-supervisor-contract", proveExactHeadSupervisorSafety],
  ["resource-parallel-contract", resourceParallelContract],
  ["performance-preflight-isolation-contract", performancePreflightIsolationContract],
  ["performance-host-accounting-contract", performanceHostAccountingContract],
  ["performance-idle-wait-contract", performanceIdleWaitContract],
  ["performance-idle-budget-contract", performanceIdleBudgetContract],
  ["performance-preflight-idle-contract", performancePreflightIdleContract],
  ["performance-contamination-retry-contract", performanceContaminationRetryContract],
  ["performance-current-jobs1-contract", () => performanceCurrentJobsContract(1)],
  ["performance-current-jobs2-contract", () => performanceCurrentJobsContract(2)],
  ["performance-contract", performanceContract],
]);

class ContractFailure extends Error {}
class PerformanceContamination extends ContractFailure {}
class BootstrapFailure extends Error {}

function contract(condition, message) {
  if (!condition) throw new ContractFailure(message);
}

function json(value) {
  return JSON.stringify(value);
}

function noFollowFlag() {
  return Number.isInteger(fsConstants.O_NOFOLLOW) && fsConstants.O_NOFOLLOW > 0
    ? fsConstants.O_NOFOLLOW
    : 0;
}

function strictDescendant(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== ""
    && rel !== ".."
    && !rel.startsWith(".." + sep)
    && !isAbsolute(rel);
}

function strictOwnedDescendant(owner, candidate) {
  const normalized = resolve(candidate);
  return strictDescendant(owner.resolved, normalized)
    || strictDescendant(owner.realpath, normalized);
}

function createHarnessOwnedBase(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  const entry = lstatSync(path);
  contract(entry.isDirectory() && !entry.isSymbolicLink(), "mkdtemp did not create a real directory: " + path);
  const owner = {
    path,
    resolved: resolve(path),
    realpath: realpathSync(path),
    dev: entry.dev,
    ino: entry.ino,
  };
  const repositoryRealpath = realpathSync(repoRoot);
  contract(
    owner.realpath !== "/"
      && owner.realpath !== repositoryRealpath
      && !strictDescendant(owner.realpath, repositoryRealpath)
      && !strictDescendant(repositoryRealpath, owner.realpath),
    "harness-owned base overlaps the repository: " + owner.realpath,
  );
  return owner;
}

function assertHarnessOwnedBase(owner, label) {
  contract(owner && typeof owner.path === "string", label + " has no harness ownership record");
  let entry = null;
  try {
    entry = lstatSync(owner.path);
  } catch (error) {
    throw new ContractFailure(label + " is missing or unreadable: " + error.message);
  }
  contract(entry.isDirectory() && !entry.isSymbolicLink(), label + " became a symlink or non-directory");
  contract(entry.dev === owner.dev && entry.ino === owner.ino, label + " was replaced after mkdtemp");
  contract(resolve(owner.path) === owner.resolved, label + " changed normalized identity");
  contract(realpathSync(owner.path) === owner.realpath, label + " changed realpath identity");
  return owner.realpath;
}

function assertOwnedPath(owner, candidate, label, options = {}) {
  assertHarnessOwnedBase(owner, label + " owner");
  contract(typeof candidate === "string" && isAbsolute(candidate), label + " is not an absolute path");
  contract(
    !candidate.split(/[\\/]+/).includes(".."),
    label + " contains parent traversal: " + candidate,
  );
  const normalized = resolve(candidate);
  contract(candidate === normalized, label + " is not normalized: " + candidate);
  contract(
    strictOwnedDescendant(owner, normalized),
    label + " is not a strict child of the harness-owned base: " + candidate,
  );
  const repositoryRealpath = realpathSync(repoRoot);
  contract(
    normalized !== resolve(repoRoot)
      && normalized !== resolve(dirname(repoRoot))
      && !strictDescendant(normalized, resolve(repoRoot)),
    label + " aliases the repository or its parent: " + candidate,
  );
  const base = strictDescendant(owner.resolved, normalized) ? owner.resolved : owner.realpath;
  const parts = relative(base, normalized).split(sep).filter(Boolean);
  let cursor = base;
  let missingTail = false;
  let leafEntry = null;
  let leafRealpath = null;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = join(cursor, parts[index]);
    if (missingTail) continue;
    let entry = null;
    try {
      entry = lstatSync(cursor);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new ContractFailure(label + " cannot inspect path component safely: " + error.message);
      }
      contract(options.mustExist === false, label + " does not exist: " + cursor);
      missingTail = true;
      continue;
    }
    contract(!entry.isSymbolicLink(), label + " contains symlink component: " + cursor);
    if (index < parts.length - 1) {
      contract(entry.isDirectory(), label + " contains non-directory component: " + cursor);
    }
    const canonical = realpathSync(cursor);
    contract(
      strictDescendant(owner.realpath, canonical),
      label + " component realpath escaped the harness-owned base: " + canonical,
    );
    contract(
      canonical !== repositoryRealpath && canonical !== dirname(repositoryRealpath),
      label + " component realpath aliases the repository or its parent",
    );
    if (index === parts.length - 1) {
      leafEntry = entry;
      leafRealpath = canonical;
    }
  }
  if (leafEntry && options.directory !== false) {
    contract(leafEntry.isDirectory(), label + " is not a directory: " + candidate);
  }
  return { path: candidate, normalized, realpath: leafRealpath, entry: leafEntry };
}

function assertOwnedDirectory(owner, candidate, label) {
  return assertOwnedPath(owner, candidate, label, { mustExist: true, directory: true });
}

function assertOwnedPathAbsent(owner, candidate, label) {
  const inspected = assertOwnedPath(owner, candidate, label, { mustExist: false });
  contract(!inspected.entry, label + " still exists after cleanup: " + candidate);
}

function createHarnessOwnedFile(owner, name, label) {
  const path = join(owner.path, name);
  assertOwnedPath(owner, path, label, { mustExist: false, directory: false });
  const fd = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
    0o600,
  );
  try {
    const opened = fstatSync(fd);
    const rebound = lstatSync(path);
    contract(
      opened.isFile() && rebound.isFile() && !rebound.isSymbolicLink()
        && opened.dev === rebound.dev && opened.ino === rebound.ino,
      label + " changed identity during exclusive creation",
    );
    return { owner, path, dev: opened.dev, ino: opened.ino, realpath: realpathSync(path) };
  } finally {
    closeSync(fd);
  }
}

function assertHarnessOwnedFile(record, label) {
  assertOwnedPath(record.owner, record.path, label, { mustExist: true, directory: false });
  const entry = lstatSync(record.path);
  contract(entry.isFile() && !entry.isSymbolicLink(), label + " is no longer a regular file");
  contract(entry.dev === record.dev && entry.ino === record.ino, label + " was replaced by the tested process");
  contract(realpathSync(record.path) === record.realpath, label + " changed realpath identity");
}

function openVerifiedFile(path, expected, flags, label) {
  const before = lstatSync(path);
  contract(
    before.isFile() && !before.isSymbolicLink()
      && before.dev === expected.dev && before.ino === expected.ino,
    label + " changed before verified open",
  );
  const fd = openSync(path, flags | noFollowFlag());
  try {
    const actual = fstatSync(fd);
    const rebound = lstatSync(path);
    contract(
      actual.isFile() && rebound.isFile() && !rebound.isSymbolicLink()
        && actual.dev === expected.dev && actual.ino === expected.ino
        && rebound.dev === expected.dev && rebound.ino === expected.ino,
      label + " changed during verified open",
    );
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function readHarnessOwnedFile(record, label, encoding = null) {
  assertHarnessOwnedFile(record, label);
  const fd = openVerifiedFile(record.path, record, fsConstants.O_RDONLY, label);
  try {
    return readFileSync(fd, encoding ? { encoding } : undefined);
  } finally {
    closeSync(fd);
  }
}

function writeHarnessOwnedFile(record, label, content, append = false) {
  assertHarnessOwnedFile(record, label);
  const flags = fsConstants.O_WRONLY | (append ? fsConstants.O_APPEND : 0);
  const fd = openVerifiedFile(record.path, record, flags, label);
  try {
    if (!append) ftruncateSync(fd, 0);
    writeFileSync(fd, content, "utf8");
  } finally {
    closeSync(fd);
  }
}

function safeFixturePath(owner, root, relativePath, label, options = {}) {
  const rootEntry = assertOwnedDirectory(owner, root, label + " root");
  contract(
    typeof relativePath === "string"
      && relativePath.length > 0
      && !isAbsolute(relativePath)
      && !relativePath.split(/[\\/]+/).includes(".."),
    label + " relative path is unsafe: " + json(relativePath),
  );
  const target = resolve(rootEntry.normalized, relativePath);
  contract(strictDescendant(rootEntry.normalized, target), label + " escaped the guarded fixture root");
  const parentRelative = relative(rootEntry.normalized, dirname(target));
  let cursor = rootEntry.normalized;
  for (const component of parentRelative.split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    const inspected = assertOwnedPath(owner, cursor, label + " parent", {
      mustExist: options.createParents !== true,
      directory: true,
    });
    if (!inspected.entry) {
      mkdirSync(cursor);
      assertOwnedDirectory(owner, cursor, label + " created parent");
    }
  }
  return assertOwnedPath(owner, target, label + " leaf", {
    mustExist: options.mustExist ?? false,
    directory: options.directory,
  });
}

function readFixtureFile(owner, root, relativePath, label, encoding = "utf8") {
  const inspected = safeFixturePath(owner, root, relativePath, label, {
    mustExist: true,
    directory: false,
  });
  contract(inspected.entry.isFile(), label + " is not a regular file");
  const fd = openVerifiedFile(inspected.normalized, inspected.entry, fsConstants.O_RDONLY, label);
  try {
    return readFileSync(fd, { encoding });
  } finally {
    closeSync(fd);
  }
}

function writeFixtureFile(owner, root, relativePath, content) {
  const inspected = safeFixturePath(owner, root, relativePath, "fixture write", {
    createParents: true,
    mustExist: false,
    directory: false,
  });
  if (inspected.entry) contract(inspected.entry.isFile(), "fixture write leaf is not a regular file");
  const fd = inspected.entry
    ? openVerifiedFile(inspected.normalized, inspected.entry, fsConstants.O_WRONLY, "fixture write")
    : openSync(
      inspected.normalized,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
      0o600,
    );
  try {
    if (!inspected.entry) {
      const opened = fstatSync(fd);
      const rebound = lstatSync(inspected.normalized);
      contract(
        opened.isFile() && rebound.isFile() && !rebound.isSymbolicLink()
          && opened.dev === rebound.dev && opened.ino === rebound.ino,
        "fixture write target changed identity during exclusive creation",
      );
    }
    if (inspected.entry) ftruncateSync(fd, 0);
    writeFileSync(fd, content, "utf8");
  } finally {
    closeSync(fd);
  }
}

function appendFixtureFile(owner, root, relativePath, content, label) {
  const inspected = safeFixturePath(owner, root, relativePath, label, {
    mustExist: true,
    directory: false,
  });
  contract(inspected.entry.isFile(), label + " is not a regular file");
  const fd = openVerifiedFile(
    inspected.normalized,
    inspected.entry,
    fsConstants.O_WRONLY | fsConstants.O_APPEND,
    label,
  );
  try {
    writeFileSync(fd, content, "utf8");
  } finally {
    closeSync(fd);
  }
}

function assertOwnedTreeNoSymlinks(owner, root, label) {
  const pending = [assertOwnedDirectory(owner, root, label + " root").normalized];
  while (pending.length > 0) {
    const directory = assertOwnedDirectory(owner, pending.pop(), label + " directory");
    for (const dirent of readdirSync(directory.normalized, { withFileTypes: true })) {
      const path = join(directory.normalized, dirent.name);
      const inspected = assertOwnedPath(owner, path, label + " entry", {
        mustExist: true,
        directory: false,
      });
      contract(!inspected.entry.isSymbolicLink(), label + " contains a nested symlink: " + path);
      contract(
        inspected.entry.isDirectory() || inspected.entry.isFile(),
        label + " contains a non-file/non-directory node: " + path,
      );
      if (inspected.entry.isDirectory()) pending.push(inspected.normalized);
    }
  }
}

function cleanupHarnessOwnedBase(owner, label) {
  assertHarnessOwnedBase(owner, label);
  rmSync(owner.path, { recursive: true, force: true });
}

function parseHarnessCase(argv) {
  const caseArgs = argv.filter((arg) => arg.startsWith("--case="));
  const unknown = argv.filter((arg) => !arg.startsWith("--case="));
  if (caseArgs.length !== 1 || unknown.length > 0) {
    throw new BootstrapFailure(
      "usage requires exactly one --case=<selector>; received " + json(argv),
    );
  }
  const selected = caseArgs[0].slice("--case=".length);
  if (!selected || !SUPPORTED_CASES.has(selected)) {
    throw new BootstrapFailure(
      "unknown harness selector " + json(selected) + "; expected one of "
      + [...SUPPORTED_CASES.keys()].join(", "),
    );
  }
  return selected;
}

function readJsonTarget(path, label) {
  if (!existsSync(path)) {
    throw new ContractFailure(label + " target is absent: " + path);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ContractFailure(label + " target is not valid JSON: " + error.message);
  }
}

async function loadBuiltTarget(sourcePath, distPath, label) {
  if (!existsSync(sourcePath)) {
    throw new ContractFailure(label + " target module is absent: " + sourcePath);
  }
  if (!existsSync(distPath)) {
    throw new BootstrapFailure(
      label + " source exists but built artifact is missing: " + distPath
      + "; run npm --prefix packages/main run build",
    );
  }
  try {
    return await import(pathToFileURL(distPath).href + "?b-e40f=" + Date.now());
  } catch (error) {
    throw new BootstrapFailure(label + " built module failed to import: " + error.stack);
  }
}

function processGroupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcessTree(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    }
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH" && processGroupAlive(child.pid)) throw error;
  }
}

async function waitForProcessGroupExit(pid, maximumMs = 2_000) {
  const deadline = Date.now() + maximumMs;
  while (processGroupAlive(pid) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return !processGroupAlive(pid);
}

function snapshotHarnessProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  if (process.platform === "win32") {
    const script = "$row=Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid
      + "'; if ($null -ne $row) { $row | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress }";
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", windowsHide: true, timeout: 2_000,
    });
    if (result.status !== 0 || !result.stdout.trim()) return null;
    const row = JSON.parse(result.stdout);
    return {
      pid: Number(row.ProcessId),
      ppid: Number(row.ParentProcessId),
      birthIdentity: String(row.CreationDate ?? ""),
      marker: String(row.CommandLine ?? ""),
    };
  }
  const result = spawnSync("ps", ["eww", "-p", String(pid), "-o", "pid=,ppid=,lstart=,state=,command="], {
    encoding: "utf8", env: harnessChildEnvironment({ LC_ALL: "C" }), timeout: 2_000,
  });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.*?)\s*$/.exec(
    result.stdout.trim(),
  );
  if (!match) throw new ContractFailure("could not parse detached-helper process identity");
  return {
    pid: Number(match[1]), ppid: Number(match[2]), birthIdentity: match[3],
    state: match[4], marker: match[5],
  };
}

function inspectHarnessProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    return { kind: "error", error: "invalid pid" };
  }
  try {
    const identity = snapshotHarnessProcess(pid);
    if (identity) return { kind: "present", identity };
  } catch (error) {
    return { kind: "error", error: error?.message ?? String(error) };
  }
  try {
    process.kill(pid, 0);
    return { kind: "error", error: "identity census returned empty for a live pid" };
  } catch (error) {
    if (error?.code === "ESRCH") return { kind: "absent" };
    return { kind: "error", error: error?.message ?? String(error) };
  }
}

function boundProcessTerminal(state, identity) {
  if (state.kind === "absent") return true;
  if (state.kind !== "present" || !identity) return false;
  return state.identity.birthIdentity !== identity.birthIdentity
    || state.identity.state?.startsWith("Z") === true;
}

const HARNESS_CHILD_ENV_KEYS = [
  "PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "LANG", "LC_ALL", "TZ",
  "NODE_OPTIONS", "PROOF_OR_STOP_RUNTIME_TRACE_FILE",
  "PROOF_OR_STOP_VALIDATION_SHARD_ADAPTER", "CI",
  "TMPDIR", "TMP", "TEMP", "PROOF_OR_STOP_DYN5_CASE",
  "PROOF_OR_STOP_SESSION_ID", "PROOF_OR_STOP_ACTIVITY_SOURCE",
  "PROOF_OR_STOP_ACTIVITY_SESSION", "PROOF_OR_STOP_AGENT",
  "PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER", "PROOF_OR_STOP_OWNER_SESSION_ADAPTER_SESSION",
  "PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK", "PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT",
  "PROOF_OR_STOP_OWNER_SESSION_ADAPTER_ROLE", "PROOF_OR_STOP_OWNER_SESSION_ADAPTER_BOUNDARY",
  "PROOF_OR_STOP_OWNER_SESSION_ADAPTER_GENERATED", "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_SESSION_ID", "CODEX_SESSION_ID", "CODEX_THREAD_ID", "OPENAI_SESSION_ID",
  "TERM_SESSION_ID", "ANTIGRAVITY_SESSION_ID", "AGY_SESSION_ID",
];

function harnessChildEnvironment(overrides = {}) {
  const env = {};
  for (const key of HARNESS_CHILD_ENV_KEYS) {
    if (typeof process.env[key] === "string") env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    contract(
      !EXACT_HEAD_ISOLATION_ENV_KEYS.has(key),
      "exact-HEAD isolation authority cannot enter a workload child environment: " + key,
    );
    if (typeof value === "string") env[key] = value;
    else delete env[key];
  }
  return env;
}

function createIsolatedQuorumRuntime(owner, label) {
  assertHarnessOwnedBase(owner, label + " owner");
  const safeLabel = label.replace(/[^a-z0-9-]/gi, "-");
  const runtimeRoot = join(owner.realpath, safeLabel + "-runtime");
  const gitHome = join(owner.realpath, safeLabel + "-git-home");
  const gitTemplate = join(owner.realpath, safeLabel + "-git-template");
  const gitHooks = join(owner.realpath, safeLabel + "-git-hooks");
  for (const path of [gitHome, gitTemplate, gitHooks]) mkdirSync(path);
  const gitConfig = join(gitHome, ".gitconfig");
  writeFixtureFile(owner, gitHome, ".gitconfig", "");
  execFileSync(
    "git",
    ["clone", "--local", "--no-hardlinks", "--quiet", repoRoot, runtimeRoot],
    {
      cwd: owner.realpath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: harnessChildEnvironment({
        HOME: gitHome,
        USERPROFILE: gitHome,
        XDG_CONFIG_HOME: gitHome,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: gitConfig,
        GIT_ATTR_NOSYSTEM: "1",
        GIT_TEMPLATE_DIR: gitTemplate,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: gitHooks,
      }),
    },
  );
  assertOwnedDirectory(owner, runtimeRoot, label + " isolated runtime");
  const targetMain = join(runtimeRoot, "packages/main");
  cpSync(join(repoRoot, "packages/main/dist"), join(targetMain, "dist"), {
    recursive: true,
    force: true,
  });
  for (const source of [
    validationCaseAdapterPath,
    validationDomainRunnerPath,
    validationChildEnvironmentPath,
    dynRegistryPath,
  ]) {
    cpSync(source, join(runtimeRoot, relative(repoRoot, source)), { force: true });
  }
  const dependencyCandidates = [
    join(repoRoot, "node_modules"),
    join(dirname(dirname(repoRoot)), "node_modules"),
  ];
  const dependencyRoot = dependencyCandidates.find((path) => existsSync(path));
  contract(Boolean(dependencyRoot), label + " could not locate the installed dependency tree");
  cpSync(realpathSync(dependencyRoot), join(runtimeRoot, "node_modules"), {
    recursive: true,
    force: true,
  });
  return runtimeRoot;
}

async function runNodeSubprocess(nodeArgs, timeoutMs, options, label) {
  const detached = process.platform !== "win32";
  const child = spawn(process.execPath, nodeArgs, {
    cwd: options.cwd ?? repoRoot,
    env: harnessChildEnvironment(options.env),
    detached,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  let timedOut = false;
  let forceKillTimer = null;
  const timeout = setTimeout(() => {
    timedOut = true;
    signalProcessTree(child, "SIGTERM");
    forceKillTimer = setTimeout(() => signalProcessTree(child, "SIGKILL"), 500);
  }, timeoutMs);
  const terminal = await new Promise((resolveTerminal) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolveTerminal(value);
    };
    child.once("error", (error) => settle({ error, status: null, signal: null }));
    child.once("close", (status, signal) => settle({ error: null, status, signal }));
    child.once("exit", (status, signal) => {
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        settle({ error: null, status, signal });
      }, 100).unref();
    });
  });
  clearTimeout(timeout);
  if (forceKillTimer) clearTimeout(forceKillTimer);

  if (terminal.error) {
    throw new BootstrapFailure("could not execute " + label + ": " + terminal.error.message);
  }
  const orphanedDescendants = detached && processGroupAlive(child.pid);
  if (orphanedDescendants) signalProcessTree(child, "SIGKILL");
  const processGroupReaped = await waitForProcessGroupExit(child.pid);
  if (!processGroupReaped) {
    throw new BootstrapFailure(
      label + " process group " + child.pid + " survived SIGKILL",
    );
  }
  return {
    pid: child.pid,
    status: terminal.status,
    signal: terminal.signal,
    timedOut,
    orphanedDescendants,
    processGroupReaped,
    output: stdout + stderr,
  };
}

async function proveTransactionalTempAllocation() {
  const owner = createHarnessOwnedBase("b-e40f-overlap-allocation-");
  const repository = join(owner.realpath, "repository");
  mkdirSync(repository);
  try {
    fixtureGit(owner, repository, ["init", "-q"]);
    const entriesBefore = json(readdirSync(repository).sort());
    const execution = await runNodeSubprocess(
      [smokeDistPath, "--case=qsm-002", "--jobs=1", "--report=json"],
      5_000,
      {
        cwd: repository,
        env: { TMPDIR: repository, TMP: repository, TEMP: repository },
      },
      "transactional overlapping-temp rejection",
    );
    contract(execution.status !== 0 && !execution.timedOut,
      "overlapping temp allocation was not rejected promptly");
    contract(/ambient temp parent overlaps the repository/i.test(execution.output),
      "overlapping temp allocation emitted no specific refusal");
    contract(execution.processGroupReaped && execution.orphanedDescendants === false,
      "overlapping temp allocation left a process descendant");
    contract(json(readdirSync(repository).sort()) === entriesBefore,
      "rejected overlapping temp allocation leaked a post-mkdtemp directory");
  } finally {
    cleanupHarnessOwnedBase(owner, "overlapping temp allocation base");
  }

  const gitCommonRaw = execFileSync(
    "git", ["-C", repoRoot, "rev-parse", "--git-common-dir"], { encoding: "utf8" },
  ).trim();
  const gitCommon = realpathSync(resolve(repoRoot, gitCommonRaw));
  const commonHeadPath = join(gitCommon, "HEAD");
  const commonHeadBefore = readFileSync(commonHeadPath);
  const commonEntriesBefore = json(readdirSync(gitCommon).sort());
  const statusBefore = execFileSync(
    "git", ["-C", repoRoot, "status", "--short"], { encoding: "utf8" },
  );
  const execution = await runNodeSubprocess(
    [smokeDistPath, "--case=qsm-002", "--jobs=1", "--report=json"],
    5_000,
    {
      cwd: repoRoot,
      env: { PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE: gitCommon },
    },
    "git-common overlapping-temp rejection",
  );
  contract(
    execution.status !== 0 && !execution.timedOut
      && execution.processGroupReaped && execution.orphanedDescendants === false,
    "git-common temp allocation was not rejected promptly and cleanly",
  );
  contract(
    /owned temp base overlaps.*git common directory/i.test(execution.output)
      && !execution.output.includes("CASE_PASS qsm-002"),
    "git-common temp allocation emitted no specific pre-execution refusal",
  );
  contract(
    readFileSync(commonHeadPath).equals(commonHeadBefore)
      && json(readdirSync(gitCommon).sort()) === commonEntriesBefore
      && execFileSync("git", ["-C", repoRoot, "status", "--short"], { encoding: "utf8" }) === statusBefore,
    "git-common temp rejection changed protected Git bytes or repository status",
  );
}

async function proveProtectedTraceSinkRejection() {
  const owner = createHarnessOwnedBase("b-e40f-protected-trace-sink-");
  const redirectedOwner = createHarnessOwnedBase("b-e40f-redirected-git-boundary-");
  const tracked = createHarnessOwnedFile(owner, "tracked-trace.jsonl", "protected tracked trace sink");
  const trackedSentinel = "tracked trace sentinel\n";
  writeHarnessOwnedFile(tracked, "protected tracked trace sink", trackedSentinel);
  const git = (...args) => execFileSync("git", args, {
    cwd: owner.realpath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "b-e40f@example.test");
    git("config", "user.name", "B-e40f trace guard");
    git("add", "tracked-trace.jsonl");
    git("commit", "-qm", "trace guard probe");
    execFileSync("git", ["init", "-q"], {
      cwd: redirectedOwner.realpath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const commonDir = realpathSync(resolve(owner.realpath, git("rev-parse", "--git-common-dir")));
    writeFixtureFile(owner, commonDir, "b-e40f-trace-sink.jsonl", "git common trace sentinel\n");
    const probes = [
      ["callback", {
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE: tracked.realpath,
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE: randomUUID(),
      }, tracked.realpath, trackedSentinel],
      ["fixture", {
        PROOF_OR_STOP_QUORUM_SMOKE_FIXTURE_TRACE_FILE: tracked.realpath,
      }, tracked.realpath, trackedSentinel],
      ["resource", {
        PROOF_OR_STOP_QUORUM_SMOKE_RESOURCE_TRACE_FILE: tracked.realpath,
      }, tracked.realpath, trackedSentinel],
      ["git-common", {
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE: join(commonDir, "b-e40f-trace-sink.jsonl"),
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE: randomUUID(),
      }, join(commonDir, "b-e40f-trace-sink.jsonl"), "git common trace sentinel\n"],
      ["ambient-git-redirect", {
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE: tracked.realpath,
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE: randomUUID(),
        GIT_DIR: join(redirectedOwner.realpath, ".git"),
        GIT_WORK_TREE: redirectedOwner.realpath,
      }, tracked.realpath, trackedSentinel],
    ];
    for (const [kind, selectedEnv, sink, expectedBytes] of probes) {
      const execution = await runNodeSubprocess(
        [smokeDistPath, "--case=qsm-002", "--report=json"],
        5_000,
        {
          cwd: owner.realpath,
          env: {
            PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE: "",
            PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE: "",
            PROOF_OR_STOP_QUORUM_SMOKE_FIXTURE_TRACE_FILE: "",
            PROOF_OR_STOP_QUORUM_SMOKE_RESOURCE_TRACE_FILE: "",
            ...selectedEnv,
          },
        },
        "protected " + kind + " trace-sink rejection",
      );
      contract(
        execution.status !== 0
          && !execution.timedOut
          && execution.processGroupReaped
          && execution.orphanedDescendants === false,
        "protected " + kind + " trace sink did not fail closed before execution",
      );
      contract(
        /strictly outside the repository and git common directory/i.test(execution.output)
          && !execution.output.includes("CASE_PASS qsm-002"),
        "protected " + kind + " trace sink emitted no specific pre-execution refusal",
      );
      contract(
        readFileSync(sink, "utf8") === expectedBytes,
        "protected " + kind + " trace sink bytes changed before refusal",
      );
      contract(git("status", "--short") === "", "protected " + kind + " trace sink dirtied the probe repo");
    }
  } finally {
    try {
      cleanupHarnessOwnedBase(owner, "protected trace-sink probe repo");
    } finally {
      cleanupHarnessOwnedBase(redirectedOwner, "redirected Git-boundary probe repo");
    }
  }
}

async function proveProtectedMutationGuard(worker) {
  contract(
    typeof worker.createQuorumSmokeProtectedMutationGuard === "function",
    "worker must export the parent-owned protected mutation guard",
  );
  const owner = createHarnessOwnedBase("b-e40f-protected-mutation-");
  const protectedRepo = join(owner.realpath, "repo");
  mkdirSync(protectedRepo);
  writeFixtureFile(owner, protectedRepo, "tracked.txt", "original\n");
  const sentinelPath = join(protectedRepo, "tracked.txt");
  try {
    fixtureGit(owner, protectedRepo, ["init", "-q"]);
    fixtureGit(owner, protectedRepo, ["add", "tracked.txt"]);
    fixtureGit(owner, protectedRepo, ["commit", "-qm", "protected mutation baseline"]);
    const baselineStatus = fixtureGit(owner, protectedRepo, ["status", "--short"]);
    const cleanGuard = worker.createQuorumSmokeProtectedMutationGuard([protectedRepo]);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    const clean = await cleanGuard.close();
    contract(
      clean.clean === true && clean.eventCount === 0 && clean.stateMatched === true
        && clean.baselineDigest === clean.finalDigest,
      "protected mutation guard rejected an unchanged disposable repository: " + json(clean),
    );

    const foreignRepo = join(owner.realpath, "foreign-repo");
    mkdirSync(foreignRepo);
    fixtureGit(owner, foreignRepo, ["init", "-q"]);
    writeFixtureFile(owner, foreignRepo, "foreign.txt", "before\n");
    fixtureGit(owner, foreignRepo, ["add", "."]);
    fixtureGit(owner, foreignRepo, ["commit", "-qm", "foreign baseline"]);
    const isolatedGuard = worker.createQuorumSmokeProtectedMutationGuard([protectedRepo]);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    writeFixtureFile(owner, foreignRepo, "foreign.txt", "after\n");
    fixtureGit(owner, foreignRepo, ["add", "."]);
    fixtureGit(owner, foreignRepo, ["commit", "-qm", "foreign concurrent change"]);
    const isolated = await isolatedGuard.close();
    contract(
      isolated.clean === true && isolated.eventCount === 0 && isolated.stateMatched === true,
      "protected mutation guard attributed a foreign repository change to the active checkout: "
        + json(isolated),
    );

    const coordinatorSource = readFileSync(workerSourcePath, "utf8");
    contract(
      /createQuorumSmokeProtectedMutationGuard\(\[\s*quorumSmokeRepositoryRoot\(\),?\s*\]\)/
        .test(coordinatorSource),
      "quorum coordinator still protects every linked worktree and shared Git metadata",
    );

    const guard = worker.createQuorumSmokeProtectedMutationGuard([protectedRepo]);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    writeFixtureFile(owner, protectedRepo, "tracked.txt", "mutated then restored\n");
    writeFixtureFile(owner, protectedRepo, "tracked.txt", "original\n");
    writeFixtureFile(owner, protectedRepo, "transient.txt", "transient\n");
    unlinkSync(join(protectedRepo, "transient.txt"));
    const observed = await guard.close();
    contract(
      observed.clean === false && observed.eventCount > 0
        && observed.paths.some((path) => path === sentinelPath || path.endsWith("transient.txt"))
        && observed.stateMatched === true && observed.baselineDigest === observed.finalDigest,
      "write-then-restore/create-then-delete escaped the real protected mutation guard: " + json(observed),
    );
    const restoredBytes = readFixtureFile(
      owner, protectedRepo, "tracked.txt", "restored protected mutation sentinel",
    );
    const restoredStatus = fixtureGit(owner, protectedRepo, ["status", "--short"]);
    contract(
      restoredBytes === "original\n" && restoredStatus === baselineStatus,
      "protected mutation negative did not restore its disposable repository: "
        + json({ restoredBytes, restoredStatus }),
    );
  } finally {
    cleanupHarnessOwnedBase(owner, "protected mutation guard probe");
  }
}

async function proveFixtureAndEnvironmentSourceClosure(worker) {
  const config = readJsonTarget(configPath, "fixture/environment closure config");
  const quorumRow = config.validate?.commands?.find((command) => (
    command.command === "node" && command.args?.includes("packages/main/dist/tasks/quorum-submit-smoke.js")
  ));
  const reviewPassRow = config.validate?.commands?.find((command) => (
    command.label === "review-pass-discard-smoke"
  ));
  contract(Boolean(quorumRow), "fixture/environment closure could not find the quorum validation row");
  contract(Boolean(reviewPassRow), "fixture/environment closure could not find the review-pass validation row");
  const environmentModule = await import(
    pathToFileURL(validationChildEnvironmentPath).href + "?closure=" + randomUUID()
  );
  contract(
    [quorumRow, reviewPassRow].every((row) => (
      json(row.declaredEnvironmentKeys) === json(environmentModule.VALIDATION_CHILD_ENVIRONMENT_KEYS)
    )),
    "configured quorum/review-pass declaredEnvironmentKeys diverged from the finite child-environment authority",
  );
  for (const overrides of [
    { GIT_DIR: "/tmp/b-e40f-hostile-git-dir" },
    { GIT_COMMON_DIR: "/tmp/b-e40f-hostile-common-dir" },
    { GIT_WORK_TREE: "/tmp/b-e40f-hostile-work-tree" },
    { GIT_CONFIG_GLOBAL: "/tmp/b-e40f-hostile-git-config" },
    { HOME: "/tmp/b-e40f-hostile-home" },
    { PROOF_OR_STOP_HEALTH_PATH: "/tmp/b-e40f-hostile-health" },
    { PROOF_OR_STOP_REVIEWER_READONLY: "1" },
    { QUORUM_CLI_PROBE_COUNTER: "/tmp/b-e40f-hostile-counter" },
    { SHLVL: "99" },
    { _: "/tmp/b-e40f-hostile-launcher" },
    { B_E40F_UNDECLARED_ENVIRONMENT_KEY: "hostile" },
  ]) {
    let rejected = false;
    try { environmentModule.validationChildEnvironment(overrides, {}); }
    catch { rejected = true; }
    contract(rejected, "finite child environment accepted undeclared/host-routing overrides: " + json(overrides));
  }
  const sanitizedRouting = environmentModule.validationChildEnvironment({}, {
    GIT_DIR: "/tmp/hostile-dir", GIT_COMMON_DIR: "/tmp/hostile-common", GIT_WORK_TREE: "/tmp/hostile-work",
    PATH: "/b-e40f/bin",
    HOME: "/tmp/b-e40f-hostile-home",
    GIT_CONFIG_GLOBAL: "/tmp/b-e40f-hostile-git-config",
    PROOF_OR_STOP_EXPERIMENT_ARM: "control",
    PROOF_OR_STOP_EXPERIMENT_ID: "b-e40f-causal",
    PROOF_OR_STOP_HEALTH_PATH: "/tmp/b-e40f-hostile-health",
    PROOF_OR_STOP_REVIEWER_READONLY: "1",
    PWD: "/b-e40f/project",
    QUORUM_CLI_PROBE_COUNTER: "/tmp/b-e40f-hostile-counter",
    SHLVL: "99",
    _: "/tmp/b-e40f-hostile-launcher",
  });
  contract(
    sanitizedRouting.PATH === "/b-e40f/bin"
      && sanitizedRouting.GIT_DIR === undefined && sanitizedRouting.GIT_COMMON_DIR === undefined && sanitizedRouting.GIT_WORK_TREE === undefined
      && sanitizedRouting.PROOF_OR_STOP_EXPERIMENT_ARM === "control"
      && sanitizedRouting.PROOF_OR_STOP_EXPERIMENT_ID === "b-e40f-causal"
      && sanitizedRouting.PWD === "/b-e40f/project"
      && sanitizedRouting.HOME === undefined
      && sanitizedRouting.GIT_CONFIG_GLOBAL === undefined
      && sanitizedRouting.PROOF_OR_STOP_HEALTH_PATH === undefined
      && sanitizedRouting.PROOF_OR_STOP_REVIEWER_READONLY === undefined
      && sanitizedRouting.QUORUM_CLI_PROBE_COUNTER === undefined
      && sanitizedRouting.SHLVL === undefined
      && sanitizedRouting._ === undefined,
    "finite child environment did not preserve causal keys or strip routing/transport keys",
  );
  const stableStringDigest = (path) => createHash("sha256")
    .update(JSON.stringify(readFileSync(path, "utf8")))
    .digest("hex");
  const handlerSource = readFileSync(storyAwareValidationHandlerPath, "utf8");
  contract(
    handlerSource.includes(`DYN5_ADAPTER_SOURCE_DIGEST = '${stableStringDigest(validationCaseAdapterPath)}'`)
      && handlerSource.includes(
        `DYN5_CHILD_ENVIRONMENT_SOURCE_DIGEST = '${stableStringDigest(validationChildEnvironmentPath)}'`,
      )
      && handlerSource.includes("sourceDependencies: [{")
      && handlerSource.includes("stableDigest(readFileSync(dependencyPath, 'utf8')) !== dependency.sourceDigest"),
    "registered DYN adapter does not machine-bind its adapter/environment-helper source closure",
  );
  const forbiddenAllocatorNames = new Set(["mkdtemp", "mkdtempSync", "tmpdir"]);
  const childProcessNames = new Set([
    "spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork",
  ]);
  const childProcessModules = new Set(["node:child_process", "child_process"]);
  const propertyName = (name) => (
    name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : null
  );
  const unwrap = (input) => {
    let node = input;
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)
      || (typeof ts.isSatisfiesExpression === "function" && ts.isSatisfiesExpression(node)))) {
      node = node.expression;
    }
    return node;
  };
  const collectNodes = (root, predicate) => {
    const matches = [];
    const visit = (node) => {
      if (predicate(node)) matches.push(node);
      ts.forEachChild(node, visit);
    };
    visit(root);
    return matches;
  };
  const isExactProcessEnvironmentProperty = (input, key) => {
    const node = unwrap(input);
    const environment = ts.isPropertyAccessExpression(node)
      ? unwrap(node.expression)
      : null;
    return ts.isPropertyAccessExpression(node)
      && node.name.text === key
      && ts.isPropertyAccessExpression(environment)
      && environment.name.text === "env"
      && ts.isIdentifier(unwrap(environment.expression))
      && unwrap(environment.expression).text === "process";
  };
  const workerEnvironmentSource = ts.createSourceFile(
    workerSourcePath,
    readFileSync(workerSourcePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const createWorkerEnvironmentDeclaration = workerEnvironmentSource.statements.find((statement) => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === "createWorkerEnvironment"
  ));
  const workerNodeOptionsProperties = createWorkerEnvironmentDeclaration
    ? collectNodes(createWorkerEnvironmentDeclaration, (node) => (
        ts.isPropertyAssignment(node) && propertyName(node.name) === "NODE_OPTIONS"
      ))
    : [];
  const workerNodeOptionsValue = unwrap(workerNodeOptionsProperties[0]?.initializer);
  const inheritedNodeOptionsDeclarations = createWorkerEnvironmentDeclaration
    ? collectNodes(createWorkerEnvironmentDeclaration, (node) => (
        ts.isVariableDeclaration(node)
          && ts.isIdentifier(node.name)
          && node.name.text === "inheritedNodeOptions"
      ))
    : [];
  contract(
    workerNodeOptionsProperties.length === 1
      && ts.isIdentifier(workerNodeOptionsValue)
      && workerNodeOptionsValue.text === "inheritedNodeOptions"
      && inheritedNodeOptionsDeclarations.length === 1
      && isExactProcessEnvironmentProperty(
        inheritedNodeOptionsDeclarations[0].initializer,
        "NODE_OPTIONS",
      ),
    "worker marker must remain on the root argv/environment and must not propagate through NODE_OPTIONS",
  );
  const runWorkerDeclaration = workerEnvironmentSource.statements.find((statement) => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === "runQuorumSmokeWorkerProcess"
  ));
  const rootWorkerSpawns = runWorkerDeclaration
    ? collectNodes(runWorkerDeclaration, (node) => {
        if (!ts.isCallExpression(node)
          || !ts.isIdentifier(unwrap(node.expression))
          || unwrap(node.expression).text !== "spawn"
          || node.arguments.length < 3) return false;
        const executable = unwrap(node.arguments[0]);
        const argv = unwrap(node.arguments[1]);
        const options = unwrap(node.arguments[2]);
        if (!ts.isPropertyAccessExpression(executable)
          || !ts.isIdentifier(unwrap(executable.expression))
          || unwrap(executable.expression).text !== "process"
          || executable.name.text !== "execPath"
          || !ts.isArrayLiteralExpression(argv)
          || !ts.isObjectLiteralExpression(options)) return false;
        const first = unwrap(argv.elements[0]);
        const environmentProperty = options.properties.find((property) => (
          ts.isPropertyAssignment(property) && propertyName(property.name) === "env"
        ));
        return ts.isTemplateExpression(first)
          && first.head.text === "--title="
          && first.templateSpans.length === 1
          && ts.isIdentifier(unwrap(first.templateSpans[0].expression))
          && unwrap(first.templateSpans[0].expression).text === "workerProcessMarker"
          && first.templateSpans[0].literal.text === ""
          && ts.isPropertyAssignment(environmentProperty)
          && ts.isIdentifier(unwrap(environmentProperty.initializer))
          && unwrap(environmentProperty.initializer).text === "environment";
      })
    : [];
  contract(
    rootWorkerSpawns.length === 1,
    "worker root lost its explicit process-title ownership marker",
  );

  const integrationEnvironmentSource = ts.createSourceFile(
    integrationCasesSourcePath,
    readFileSync(integrationCasesSourcePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const fixtureEnvironmentDeclaration = collectNodes(integrationEnvironmentSource, (node) => (
    ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === "FIXTURE_PROCESS_ENVIRONMENT_KEYS"
  ))[0];
  const fixtureEnvironmentKeys = unwrap(fixtureEnvironmentDeclaration?.initializer);
  contract(
    fixtureEnvironmentDeclaration
      && ts.isArrayLiteralExpression(fixtureEnvironmentKeys)
      && fixtureEnvironmentKeys.elements.some((element) => (
        ts.isStringLiteralLike(unwrap(element))
          && unwrap(element).text === "PROOF_OR_STOP_QUORUM_SMOKE_WORKER_PROCESS_MARKER"
      )),
    "fixture subprocess environment does not preserve the worker ownership marker",
  );
  const fixtureEnvironmentFunction = integrationEnvironmentSource.statements.find((statement) => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === "fixtureProcessEnvironment"
  ));
  const fixtureMarkerDeclarations = fixtureEnvironmentFunction
    ? collectNodes(fixtureEnvironmentFunction, (node) => (
        ts.isVariableDeclaration(node)
          && ts.isIdentifier(node.name)
          && node.name.text === "workerProcessMarker"
      ))
    : [];
  contract(
    fixtureMarkerDeclarations.length === 1
      && isExactProcessEnvironmentProperty(
        fixtureMarkerDeclarations[0].initializer,
        "PROOF_OR_STOP_QUORUM_SMOKE_WORKER_PROCESS_MARKER",
      ),
    "fixture subprocess marker is not bound to the inherited worker authority",
  );
  const fixtureEnvironmentObjects = fixtureEnvironmentFunction
    ? collectNodes(fixtureEnvironmentFunction, ts.isObjectLiteralExpression)
    : [];
  const pinnedEnvironmentObject = fixtureEnvironmentObjects.find((object) => (
    object.properties.some((property) => (
      ts.isPropertyAssignment(property)
        && ts.isComputedPropertyName(property.name)
        && ts.isIdentifier(property.name.expression)
        && property.name.expression.text === "WORKER_PROCESS_MARKER_ENV"
    ))
  ));
  const overrideSpreadIndex = pinnedEnvironmentObject?.properties.findIndex((property) => (
    ts.isSpreadAssignment(property)
      && ts.isIdentifier(unwrap(property.expression))
      && unwrap(property.expression).text === "overrides"
  )) ?? -1;
  const markerPinIndex = pinnedEnvironmentObject?.properties.findIndex((property) => (
    ts.isPropertyAssignment(property)
      && ts.isComputedPropertyName(property.name)
      && ts.isIdentifier(property.name.expression)
      && property.name.expression.text === "WORKER_PROCESS_MARKER_ENV"
      && ts.isIdentifier(unwrap(property.initializer))
      && unwrap(property.initializer).text === "workerProcessMarker"
  )) ?? -1;
  contract(
    overrideSpreadIndex >= 0 && markerPinIndex > overrideSpreadIndex,
    "fixture subprocess caller overrides can replace the worker ownership marker",
  );
  contract(
    typeof worker?.runQuorumSmokeWorkerProcess === "function",
    "worker environment probe requires the real production worker runner",
  );
  const workerProbeOwner = createHarnessOwnedBase("b-e40f-worker-env-probe-");
  const workerProbe = createHarnessOwnedFile(
    workerProbeOwner,
    "worker-env-probe.mjs",
    "real worker environment probe",
  );
  writeHarnessOwnedFile(workerProbe, "real worker environment probe", [
    'import { spawnSync } from "node:child_process";',
    'const workerKey = "PROOF_OR_STOP_QUORUM_SMOKE_WORKER_PROCESS_MARKER";',
    `const treeKey = ${json(EXACT_HEAD_TREE_LEASE_MARKER_ENV)};`,
    'const workerMarker = process.env[workerKey] ?? null;',
    'const treeMarker = process.env[treeKey] ?? null;',
    'const nodeOptions = process.env.NODE_OPTIONS ?? "";',
    'const forbiddenTitle = workerMarker === null ? null : "--title=" + workerMarker;',
    'if (workerMarker === null || nodeOptions.split(/\\s+/).includes(forbiddenTitle)) process.exit(91);',
    'const nestedSource = `console.log(JSON.stringify({',
    '  workerMarker: process.env.PROOF_OR_STOP_QUORUM_SMOKE_WORKER_PROCESS_MARKER ?? null,',
    '  treeMarker: process.env.PROOF_OR_STOP_B_E40F_TREE_LEASE_MARKER ?? null,',
    '  nodeOptions: process.env.NODE_OPTIONS ?? ""',
    '}))`;',
    'const nested = spawnSync(process.execPath, ["-"], {',
    '  input: nestedSource, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],',
    '});',
    'if (nested.status !== 0) process.exit(92);',
    'const nestedReceipt = JSON.parse(nested.stdout.trim());',
    'if (nestedReceipt.workerMarker !== workerMarker || nestedReceipt.treeMarker !== treeMarker',
    '  || String(nestedReceipt.nodeOptions).split(/\\s+/).includes(forbiddenTitle)) process.exit(93);',
    'console.log("B_E40F_WORKER_ENV_PASS " + JSON.stringify({',
    '  workerMarker, treeMarker, nodeOptions, nestedReceipt,',
    '}));',
  ].join("\n"));
  try {
    const workerProbeResult = await worker.runQuorumSmokeWorkerProcess(
      workerProbe.realpath,
      [],
      "worker-environment-probe-" + randomUUID(),
      5_000,
      {
        TMPDIR: workerProbeOwner.realpath,
        TMP: workerProbeOwner.realpath,
        TEMP: workerProbeOwner.realpath,
        PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE: workerProbeOwner.realpath,
      },
      new AbortController().signal,
    );
    const receiptLine = workerProbeResult.output.split(/\r?\n/).find((line) => (
      line.startsWith("B_E40F_WORKER_ENV_PASS ")
    ));
    contract(
      workerProbeResult.status === 0
        && workerProbeResult.timedOut === false
        && workerProbeResult.cancelled === false
        && workerProbeResult.processTreeReaped === true
        && Boolean(receiptLine),
      "real worker environment did not preserve markers without propagating its title: "
        + json(workerProbeResult),
    );
  } finally {
    cleanupHarnessOwnedBase(workerProbeOwner, "real worker environment probe");
  }
  const assertFiniteEnvironmentAccess = (source, label) => {
    const environmentAliases = new Set();
    const staticElementName = (node) => {
      const argument = ts.isElementAccessExpression(node)
        ? unwrap(node.argumentExpression)
        : null;
      return argument && ts.isStringLiteralLike(argument) ? argument.text : null;
    };
    const staticMemberName = (node) => (
      ts.isPropertyAccessExpression(node) ? node.name.text : staticElementName(node)
    );
    const isProcessEnvironment = (input) => {
      const node = unwrap(input);
      return (ts.isPropertyAccessExpression(node)
          && ts.isIdentifier(node.expression) && node.expression.text === "process"
          && node.name.text === "env")
        || (ts.isElementAccessExpression(node)
          && ts.isIdentifier(node.expression) && node.expression.text === "process"
          && ts.isStringLiteralLike(unwrap(node.argumentExpression))
          && unwrap(node.argumentExpression).text === "env");
    };
    const isEnvironmentValue = (input) => {
      const node = unwrap(input);
      return isProcessEnvironment(node)
        || (ts.isIdentifier(node) && environmentAliases.has(node.text));
    };
    let changed = true;
    while (changed) {
      changed = false;
      for (const declaration of collectNodes(source, (node) => (
        (ts.isVariableDeclaration(node) || ts.isParameter(node))
          && ts.isIdentifier(node.name) && Boolean(node.initializer)
      ))) {
        if (isEnvironmentValue(declaration.initializer)
          && !environmentAliases.has(declaration.name.text)) {
          environmentAliases.add(declaration.name.text);
          changed = true;
        }
      }
    }
    const reflectionMethods = new Set([
      "keys", "values", "entries", "getOwnPropertyNames", "getOwnPropertySymbols",
      "getOwnPropertyDescriptors", "ownKeys",
    ]);
    const reflectionAliases = new Set();
    for (const declaration of collectNodes(source, (node) => (
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && Boolean(node.initializer)
    ))) {
      const initializer = unwrap(declaration.initializer);
      if ((ts.isPropertyAccessExpression(initializer) || ts.isElementAccessExpression(initializer))
        && ts.isIdentifier(initializer.expression)
        && ["Object", "Reflect"].includes(initializer.expression.text)
        && reflectionMethods.has(staticMemberName(initializer))) {
        reflectionAliases.add(declaration.name.text);
      }
    }
    const reflectiveCalls = collectNodes(source, (node) => {
      if (!ts.isCallExpression(node) || node.arguments.length === 0
        || !isEnvironmentValue(node.arguments[0])) return false;
      const callee = unwrap(node.expression);
      return ((ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))
          && ts.isIdentifier(callee.expression)
          && ["Object", "Reflect"].includes(callee.expression.text)
          && reflectionMethods.has(staticMemberName(callee)))
        || (ts.isIdentifier(callee) && reflectionAliases.has(callee.text));
    });
    const forInEnumerations = collectNodes(source, (node) => (
      ts.isForInStatement(node) && isEnvironmentValue(node.expression)
    ));
    const spreads = collectNodes(source, (node) => (
      (ts.isSpreadElement(node) || ts.isSpreadAssignment(node))
        && isEnvironmentValue(node.expression)
    ));
    const isFiniteKeySequence = (input) => {
      const node = unwrap(input);
      if (ts.isArrayLiteralExpression(node)) {
        return node.elements.length > 0
          && node.elements.every((element) => ts.isStringLiteralLike(unwrap(element)));
      }
      if (ts.isCallExpression(node) && node.arguments.length === 1
        && ts.isPropertyAccessExpression(unwrap(node.expression))
        && ts.isIdentifier(unwrap(node.expression).expression)
        && unwrap(node.expression).expression.text === "Object"
        && unwrap(node.expression).name.text === "freeze") {
        return isFiniteKeySequence(node.arguments[0]);
      }
      if (!ts.isIdentifier(node)) return false;
      return collectNodes(source, (candidate) => (
        ts.isVariableDeclaration(candidate) && ts.isIdentifier(candidate.name)
          && candidate.name.text === node.text && Boolean(candidate.initializer)
          && (candidate.parent.flags & ts.NodeFlags.Const) !== 0
          && isFiniteKeySequence(candidate.initializer)
      )).length === 1;
    };
    const isFiniteEnvironmentKey = (input) => {
      const node = unwrap(input);
      if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
      const finiteParameter = (identifier) => {
        for (let cursor = identifier.parent; cursor && cursor !== source; cursor = cursor.parent) {
          if ((ts.isArrowFunction(cursor) || ts.isFunctionExpression(cursor)
            || ts.isFunctionDeclaration(cursor))
            && cursor.parameters.some((parameter) => (
              ts.isIdentifier(parameter.name) && parameter.name.text === identifier.text
            ))) {
            const functionName = ts.isFunctionDeclaration(cursor)
              ? cursor.name?.text
              : ts.isVariableDeclaration(cursor.parent) && ts.isIdentifier(cursor.parent.name)
                ? cursor.parent.name.text
                : null;
            if (!functionName) return false;
            const parameterIndex = cursor.parameters.findIndex((parameter) => (
              ts.isIdentifier(parameter.name) && parameter.name.text === identifier.text
            ));
            const calls = collectNodes(source, (candidate) => (
              ts.isCallExpression(candidate) && ts.isIdentifier(candidate.expression)
                && candidate.expression.text === functionName
            ));
            return calls.length > 0 && calls.every((call) => (
              ts.isStringLiteralLike(unwrap(call.arguments[parameterIndex]))
            ));
          }
        }
        return false;
      };
      if (ts.isTemplateExpression(node)) {
        return node.templateSpans.length > 0
          && node.templateSpans.every((span) => (
            ts.isIdentifier(unwrap(span.expression)) && finiteParameter(unwrap(span.expression))
          ));
      }
      if (!ts.isIdentifier(node)) return false;
      const fixedConstants = collectNodes(source, (candidate) => (
        ts.isVariableDeclaration(candidate) && ts.isIdentifier(candidate.name)
          && candidate.name.text === node.text && Boolean(candidate.initializer)
          && (candidate.parent.flags & ts.NodeFlags.Const) !== 0
          && ts.isStringLiteralLike(unwrap(candidate.initializer))
      ));
      if (fixedConstants.length === 1) return true;
      if (finiteParameter(node)) return true;
      for (let cursor = node.parent; cursor && cursor !== source; cursor = cursor.parent) {
        if (ts.isForOfStatement(cursor)
          && ts.isVariableDeclarationList(cursor.initializer)
          && cursor.initializer.declarations.some((declaration) => (
            ts.isIdentifier(declaration.name) && declaration.name.text === node.text
          ))
          && isFiniteKeySequence(cursor.expression)) return true;
        if ((ts.isArrowFunction(cursor) || ts.isFunctionExpression(cursor))
          && cursor.parameters.some((parameter) => (
            ts.isIdentifier(parameter.name) && parameter.name.text === node.text
          ))) {
          const call = cursor.parent;
          const callee = ts.isCallExpression(call) ? unwrap(call.expression) : null;
          return Boolean(callee && ts.isPropertyAccessExpression(callee)
            && callee.name.text === "map" && isFiniteKeySequence(callee.expression));
        }
      }
      return false;
    };
    const isWriteOnlyEnvironmentElement = (node) => {
      const parent = node.parent;
      return (ts.isDeleteExpression(parent) && parent.expression === node)
        || (ts.isBinaryExpression(parent) && parent.left === node
          && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken);
    };
    const dynamicEnvironmentReads = collectNodes(source, (node) => (
      ts.isElementAccessExpression(node)
        && isEnvironmentValue(node.expression)
        && !isWriteOnlyEnvironmentElement(node)
        && !isFiniteEnvironmentKey(node.argumentExpression)
    ));
    const wholeEnvironmentTransfers = collectNodes(source, (node) => {
      if (!isProcessEnvironment(node)
        && !(ts.isIdentifier(node) && environmentAliases.has(node.text))) return false;
      const parent = node.parent;
      if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent))
        && parent.initializer === node && ts.isIdentifier(parent.name)
        && environmentAliases.has(parent.name.text)) return false;
      if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
        && parent.expression === node) return false;
      if ((ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent))
        && parent.expression === node) return false;
      if (ts.isForInStatement(parent) && parent.expression === node) return false;
      if (ts.isCallExpression(parent) && parent.arguments.includes(node)) return true;
      if (ts.isReturnStatement(parent) || ts.isYieldExpression(parent)) return true;
      if (ts.isBinaryExpression(parent) && parent.right === node
        && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return true;
      if (ts.isVariableDeclaration(parent) && parent.initializer === node
        && !ts.isIdentifier(parent.name)) return true;
      return false;
    });
    contract(
      reflectiveCalls.length === 0 && forInEnumerations.length === 0
        && spreads.length === 0 && dynamicEnvironmentReads.length === 0
        && wholeEnvironmentTransfers.length === 0,
      label + " reflects, enumerates, or transfers the complete host environment: "
        + json({
          reflectiveCalls: reflectiveCalls.length,
          forInEnumerations: forInEnumerations.length,
          spreads: spreads.length,
          dynamicEnvironmentReads: dynamicEnvironmentReads.length,
          wholeEnvironmentTransfers: wholeEnvironmentTransfers.length,
        }),
    );
  };
  for (const [name, sourceText] of [
    ["Reflect.ownKeys", "Reflect.ownKeys(process.env);"],
    ["Object.getOwnPropertyNames", "Object.getOwnPropertyNames(process.env);"],
    ["for-in", "for (const key in process.env) void key;"],
    ["environment alias", "const ambient=process.env; Object.keys(ambient);"],
    ["reflection alias", "const ambient=process.env; const enumerate=Reflect.ownKeys; enumerate(ambient);"],
    ["computed reflection", "Reflect['ownKeys'](process.env);"],
    ["dynamic environment key", "const key=process.argv[2]; process.env[key];"],
  ]) {
    const mutant = ts.createSourceFile(
      `b-e40f-environment-${name}.mjs`, sourceText,
      ts.ScriptTarget.Latest, true, ts.ScriptKind.JS,
    );
    let rejected = false;
    try { assertFiniteEnvironmentAccess(mutant, name + " negative"); }
    catch (error) {
      if (!(error instanceof ContractFailure)) throw error;
      rejected = true;
    }
    contract(rejected, "source closure accepted " + name + " host-environment enumeration");
  }
  const assertNoCreateRequireEscape = (source, label) => {
    const unsafeImports = source.statements.filter((statement) => {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)
        || !["node:module", "module"].includes(statement.moduleSpecifier.text)
        || statement.importClause?.isTypeOnly) return false;
      if (statement.importClause?.name) return true;
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) return true;
      return bindings && ts.isNamedImports(bindings)
        ? bindings.elements.some((element) => !element.isTypeOnly)
        : false;
    });
    const opaqueLoads = collectNodes(source, (node) => (
      (ts.isCallExpression(node) && node.arguments.length > 0
        && ts.isStringLiteralLike(node.arguments[0])
        && ["node:module", "module"].includes(node.arguments[0].text)
        && ((ts.isIdentifier(node.expression) && node.expression.text === "require")
          || node.expression.kind === ts.SyntaxKind.ImportKeyword))
      || (ts.isImportEqualsDeclaration(node)
        && ts.isExternalModuleReference(node.moduleReference)
        && ts.isStringLiteralLike(node.moduleReference.expression)
        && ["node:module", "module"].includes(node.moduleReference.expression.text))
    ));
    contract(
      unsafeImports.length === 0 && opaqueLoads.length === 0,
      label + " imports createRequire or opaque module-loader authority",
    );
  };
  const createRequireEscape = ts.createSourceFile(
    "b-e40f-create-require-negative.mjs",
    "import {createRequire as makeLoader} from 'node:module';\n"
      + "const load=makeLoader(import.meta.url);\n"
      + "const cp=load('node:child_process');\n"
      + "cp.spawnSync('node',[],{env:process.env});\n",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let createRequireEscapeRejected = false;
  try { assertNoCreateRequireEscape(createRequireEscape, "createRequire alias negative"); }
  catch (error) {
    if (!(error instanceof ContractFailure)) throw error;
    createRequireEscapeRejected = true;
  }
  contract(
    createRequireEscapeRejected,
    "source closure accepted createRequire alias -> loader -> child_process -> process.env escape",
  );
  const assertDirectChildProcessReferences = (source, localNames, label) => {
    const detachedReferences = collectNodes(source, (node) => (
      ts.isIdentifier(node) && localNames.has(node.text)
        && !ts.isImportSpecifier(node.parent)
        && !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ));
    contract(
      detachedReferences.length === 0,
      label + " aliases, exports, or detaches an imported child_process capability",
    );
  };
  const detachedChildProcessEscape = ts.createSourceFile(
    "b-e40f-child-process-alias-negative.mjs",
    "import {spawnSync} from 'node:child_process';\n"
      + "const launch=spawnSync;\n"
      + "launch('node',[],{env:process.env});\n",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let detachedChildProcessRejected = false;
  try {
    assertDirectChildProcessReferences(
      detachedChildProcessEscape,
      new Set(["spawnSync"]),
      "child_process alias negative",
    );
  } catch (error) {
    if (!(error instanceof ContractFailure)) throw error;
    detachedChildProcessRejected = true;
  }
  contract(
    detachedChildProcessRejected,
    "source closure accepted imported child_process -> alias -> process.env escape",
  );
  const sourceRows = [
    { path: smokeSourcePath, finiteBuilders: new Set() },
    ...caseSourcePaths.slice(1).map((path) => ({
      path,
      finiteBuilders: new Set(["fixtureProcessEnvironment"]),
      fixtureCaseModule: true,
    })),
    { path: catalogSourcePath, finiteBuilders: new Set(["quorumSmokeGitDiscoveryEnvironment"]) },
    {
      path: workerSourcePath,
      finiteBuilders: new Set(["quorumSmokeMinimalEnvironment", "createWorkerEnvironment"]),
    },
    { path: validationCaseAdapterPath, finiteBuilders: new Set(["validationChildEnvironment"]) },
    { path: validationDomainRunnerPath, finiteBuilders: new Set(["validationChildEnvironment"]) },
    { path: validationChildEnvironmentPath, finiteBuilders: new Set() },
  ];
  const assertNoTreeLeaseStdioCollision = (source, call, label) => {
    const options = call.arguments.find((argument) => ts.isObjectLiteralExpression(argument));
    const stdioProperty = options?.properties.find((property) => (
      ts.isPropertyAssignment(property) && propertyName(property.name) === "stdio"
    ));
    const stdio = unwrap(stdioProperty?.initializer);
    const occupiedLeaseFd = Boolean(stdio) && ts.isArrayLiteralExpression(stdio)
      && stdio.elements.length > EXACT_HEAD_TREE_LEASE_FD
      && !ts.isOmittedExpression(stdio.elements[EXACT_HEAD_TREE_LEASE_FD])
      && stdio.elements[EXACT_HEAD_TREE_LEASE_FD].kind !== ts.SyntaxKind.NullKeyword;
    contract(
      !occupiedLeaseFd,
      `${label}:${source.getLineAndCharacterOfPosition(call.getStart()).line + 1} `
        + `occupies exact-HEAD tree-lease fd ${EXACT_HEAD_TREE_LEASE_FD}`,
    );
  };
  const isProcessExecPath = (input) => {
    const executable = unwrap(input);
    return ts.isPropertyAccessExpression(executable)
      && ts.isIdentifier(executable.expression)
      && executable.expression.text === "process"
      && executable.name.text === "execPath";
  };
  const boundedNativeExecutables = new Set([
    "git", "powershell.exe", "ps", "taskkill",
  ]);
  const assertBoundedChildExecutable = (source, call, method, path, label) => {
    const executable = unwrap(call.arguments[0]);
    const isRegistryRunner = path === validationCaseAdapterPath
      && ts.isPropertyAccessExpression(executable)
      && ts.isIdentifier(executable.expression)
      && executable.expression.text === "runner"
      && executable.name.text === "command";
    const isBoundedNative = ts.isStringLiteralLike(executable)
      && boundedNativeExecutables.has(executable.text);
    const isDigestBoundShell = ts.isStringLiteralLike(executable)
      && executable.text === "/bin/sh"
      && path === integrationCasesSourcePath
      && stableStringDigest(path) === BOUNDED_SHELL_SOURCE_DIGEST;
    contract(
      isProcessExecPath(executable) || isBoundedNative || isDigestBoundShell || isRegistryRunner,
      `${label}:${source.getLineAndCharacterOfPosition(call.getStart()).line + 1} `
        + "launches an executable outside the exact-HEAD source closure",
    );
    contract(
      method !== "spawn" || isProcessExecPath(executable),
      `${label}:${source.getLineAndCharacterOfPosition(call.getStart()).line + 1} `
        + "launches an asynchronous native executable outside the bounded Node tree lease",
    );
  };
  const assertNoExplicitTreeLeaseClose = (source, label) => {
    const directCloses = collectNodes(source, (node) => (
      ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "closeSync"
        && ts.isNumericLiteral(unwrap(node.arguments[0]))
        && Number(unwrap(node.arguments[0]).text) === EXACT_HEAD_TREE_LEASE_FD
    ));
    const shellCloses = collectNodes(source, (node) => (
      ts.isStringLiteralLike(node)
        && new RegExp(`(?:^|[;&|\\s])${EXACT_HEAD_TREE_LEASE_FD}>&-`).test(node.text)
    ));
    contract(
      directCloses.length === 0 && shellCloses.length === 0,
      label + " explicitly closes the exact-HEAD tree lease",
    );
  };
  const stdioCollisionMutant = ts.createSourceFile(
    "b-e40f-tree-lease-stdio-negative.mjs",
    "spawn(process.execPath, [], { stdio: ['ignore','ignore','ignore','ignore','ignore'] });",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const stdioCollisionCall = collectNodes(stdioCollisionMutant, ts.isCallExpression)[0];
  let stdioCollisionRejected = false;
  try {
    assertNoTreeLeaseStdioCollision(
      stdioCollisionMutant,
      stdioCollisionCall,
      "tree-lease stdio collision negative",
    );
  } catch (error) {
    if (!(error instanceof ContractFailure)) throw error;
    stdioCollisionRejected = true;
  }
  contract(stdioCollisionRejected, "source closure accepted an occupied tree-lease fd");
  const nativeAsyncMutant = ts.createSourceFile(
    "b-e40f-native-async-negative.mjs",
    "spawn('git', ['status'], { env: finiteEnvironment() });",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let nativeAsyncRejected = false;
  try {
    assertBoundedChildExecutable(
      nativeAsyncMutant,
      collectNodes(nativeAsyncMutant, ts.isCallExpression)[0],
      "spawn",
      null,
      "native async negative",
    );
  } catch (error) {
    if (!(error instanceof ContractFailure)) throw error;
    nativeAsyncRejected = true;
  }
  contract(nativeAsyncRejected, "source closure accepted an asynchronous native launch");
  const unboundShellMutant = ts.createSourceFile(
    "b-e40f-unbound-shell-negative.mjs",
    "execFileSync('/bin/sh', ['-c', 'sleep 60 &'], { env: finiteEnvironment() });",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let unboundShellRejected = false;
  try {
    assertBoundedChildExecutable(
      unboundShellMutant,
      collectNodes(unboundShellMutant, ts.isCallExpression)[0],
      "execFileSync",
      null,
      "unbound shell negative",
    );
  } catch (error) {
    if (!(error instanceof ContractFailure)) throw error;
    unboundShellRejected = true;
  }
  contract(unboundShellRejected, "source closure accepted an unbound shell launch");
  const explicitCloseMutant = ts.createSourceFile(
    "b-e40f-tree-lease-close-negative.mjs",
    `closeSync(${EXACT_HEAD_TREE_LEASE_FD});`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let explicitCloseRejected = false;
  try { assertNoExplicitTreeLeaseClose(explicitCloseMutant, "tree-lease close negative"); }
  catch (error) {
    if (!(error instanceof ContractFailure)) throw error;
    explicitCloseRejected = true;
  }
  contract(explicitCloseRejected, "source closure accepted an explicit tree-lease close");
  const domainCases = readJsonTarget(dynRegistryPath, "bounded validation domain registry");
  contract(
    Array.isArray(domainCases) && domainCases.length > 0
      && domainCases.every((entry) => entry?.runner?.command === "node"),
    "DYN validation registry contains an unbounded native runner command",
  );
  for (const { path, finiteBuilders, fixtureCaseModule = false } of sourceRows) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    );
    assertFiniteEnvironmentAccess(source, relative(repoRoot, path));
    assertNoCreateRequireEscape(source, relative(repoRoot, path));
    assertNoExplicitTreeLeaseClose(source, relative(repoRoot, path));
    const childProcessLocals = new Set();
    const childProcessMethods = new Map();
    for (const statement of source.statements.filter(ts.isImportDeclaration)) {
      if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
      const moduleName = statement.moduleSpecifier.text;
      if (childProcessModules.has(moduleName)) {
        contract(
          !statement.importClause?.name
            && statement.importClause?.namedBindings
            && ts.isNamedImports(statement.importClause.namedBindings),
          relative(repoRoot, path) + " must use inspectable named child_process imports",
        );
        for (const element of statement.importClause.namedBindings.elements) {
          if (element.isTypeOnly) continue;
          const importedName = element.propertyName?.text ?? element.name.text;
          contract(
            childProcessNames.has(importedName),
            relative(repoRoot, path) + " imports aggregate or untraced child_process authority " + importedName,
          );
          contract(
            !["exec", "execFile"].includes(importedName),
            relative(repoRoot, path)
              + " imports async child authority that cannot preserve the exact-HEAD tree lease",
          );
          const binding = namedImportBinding(
            source, moduleName, importedName, relative(repoRoot, path),
          );
          childProcessLocals.add(binding.localName);
          childProcessMethods.set(binding.localName, importedName);
        }
      }
      if (fixtureCaseModule && (moduleName === "node:fs" || moduleName === "node:fs/promises"
        || moduleName === "node:os")) {
        contract(
          !statement.importClause?.name
            && (!statement.importClause?.namedBindings
              || ts.isNamedImports(statement.importClause.namedBindings)),
          relative(repoRoot, path) + " uses an opaque filesystem/temp import",
        );
        if (statement.importClause?.namedBindings
          && ts.isNamedImports(statement.importClause.namedBindings)) {
          contract(
            statement.importClause.namedBindings.elements.every((element) => (
              element.isTypeOnly
                || !["default", "promises"].includes(element.propertyName?.text ?? element.name.text)
            )),
            relative(repoRoot, path) + " imports aggregate filesystem/temp authority",
          );
        }
      }
    }
    const authorityModules = new Set([
      ...childProcessModules,
      "node:module",
      "module",
      ...(fixtureCaseModule ? ["node:fs", "node:fs/promises", "node:os"] : []),
    ]);
    const opaqueAuthorityLoads = collectNodes(source, (node) => (
      (ts.isCallExpression(node) && node.arguments.length > 0
        && ts.isStringLiteralLike(node.arguments[0])
        && authorityModules.has(node.arguments[0].text)
        && ((ts.isIdentifier(node.expression) && node.expression.text === "require")
          || node.expression.kind === ts.SyntaxKind.ImportKeyword))
      || (ts.isImportEqualsDeclaration(node)
        && ts.isExternalModuleReference(node.moduleReference)
        && ts.isStringLiteralLike(node.moduleReference.expression)
        && authorityModules.has(node.moduleReference.expression.text))
    ));
    contract(
      opaqueAuthorityLoads.length === 0,
      relative(repoRoot, path) + " loads filesystem/temp/process authority opaquely",
    );
    const localBuilder = (name, delegateName) => {
      const declarations = collectNodes(source, (node) => (
        ts.isFunctionDeclaration(node) && node.name?.text === name && Boolean(node.body)
      ));
      const shadowBindings = collectNodes(source, (node) => (
        ts.isIdentifier(node) && node.text === name
          && ((ts.isVariableDeclaration(node.parent) || ts.isParameter(node.parent)
            || ts.isBindingElement(node.parent)) && node.parent.name === node)
      ));
      const body = declarations[0]?.body;
      const delegateCalls = body ? collectNodes(body, (node) => (
        ts.isCallExpression(node) && ts.isIdentifier(node.expression)
          && node.expression.text === delegateName
      )) : [];
      const returns = body ? collectNodes(body, ts.isReturnStatement) : [];
      const returned = unwrap(returns[0]?.expression);
      const returnsDelegate = ts.isCallExpression(returned)
        && ts.isIdentifier(returned.expression) && returned.expression.text === delegateName;
      const returnsDelegateResult = ts.isIdentifier(returned) && body
        && collectNodes(body, (node) => (
          ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
            && node.name.text === returned.text
            && node.parent.flags === ts.NodeFlags.Const
            && ts.isCallExpression(unwrap(node.initializer))
            && ts.isIdentifier(unwrap(node.initializer).expression)
            && unwrap(node.initializer).expression.text === delegateName
        )).length === 1;
      contract(
        declarations.length === 1 && shadowBindings.length === 0
          && delegateCalls.length === 1 && returns.length === 1
          && (returnsDelegate || returnsDelegateResult),
        `${relative(repoRoot, path)} does not exclusively return ${name}'s ${delegateName} result`,
      );
    };
    if (path === validationCaseAdapterPath || path === validationDomainRunnerPath) {
      const binding = namedImportBinding(
        source,
        "./validation-child-environment.mjs",
        "validationChildEnvironment",
        relative(repoRoot, path),
      );
      finiteBuilders.clear();
      finiteBuilders.add(binding.localName);
    } else if (path.endsWith("quorum-submit-smoke-integration-cases.ts")) {
      const minimal = namedImportBinding(
        source,
        "./quorum-submit-smoke-case-catalog.js",
        "quorumSmokeMinimalEnvironment",
        relative(repoRoot, path),
      );
      localBuilder("fixtureProcessEnvironment", minimal.localName);
    } else if (path === catalogSourcePath) {
      localBuilder("quorumSmokeGitDiscoveryEnvironment", "quorumSmokeMinimalEnvironment");
    } else if (path === workerSourcePath) {
      const minimal = namedImportBinding(
        source,
        "./quorum-submit-smoke-case-catalog.js",
        "quorumSmokeMinimalEnvironment",
        relative(repoRoot, path),
      );
      finiteBuilders.delete("quorumSmokeMinimalEnvironment");
      finiteBuilders.add(minimal.localName);
      localBuilder("createWorkerEnvironment", minimal.localName);
    }
    const forbidden = fixtureCaseModule ? collectNodes(source, (node) => (
      (ts.isImportSpecifier(node)
        && forbiddenAllocatorNames.has(node.propertyName?.text ?? node.name.text))
        || (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
          && forbiddenAllocatorNames.has(node.expression.text))
    )) : [];
    contract(
      forbidden.length === 0,
      relative(repoRoot, path) + " bypasses the parent-owned fixture allocator",
    );
    const subprocessCalls = collectNodes(source, (node) => (
      ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && childProcessLocals.has(node.expression.text)
    ));
    assertDirectChildProcessReferences(source, childProcessLocals, relative(repoRoot, path));
    for (const call of subprocessCalls) {
      const childMethod = childProcessMethods.get(call.expression.text);
      const options = call.arguments.find((argument) => ts.isObjectLiteralExpression(argument));
      const envProperty = options?.properties.find((property) => (
        ts.isPropertyAssignment(property)
          && propertyName(property.name) === "env"
      ));
      const usesFiniteBuilder = (input, seen = new Set()) => {
        const initializer = unwrap(input);
        if (ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression)) {
          return finiteBuilders.has(initializer.expression.text);
        }
        if (!ts.isIdentifier(initializer) || seen.has(initializer.text)) return false;
        seen.add(initializer.text);
        const candidates = collectNodes(source, (node) => (
          ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
            && node.name.text === initializer.text && Boolean(node.initializer)
            && node.getStart(source) < initializer.getStart(source)
        )).sort((left, right) => right.getStart(source) - left.getStart(source));
        return candidates.length > 0 && usesFiniteBuilder(candidates[0].initializer, seen);
      };
      contract(
        Boolean(envProperty) && usesFiniteBuilder(envProperty.initializer),
        `${relative(repoRoot, path)}:${source.getLineAndCharacterOfPosition(call.getStart()).line + 1} `
          + "spawns a subprocess without the file's approved finite environment builder",
      );
      const shellProperty = options?.properties.find((property) => (
        ts.isPropertyAssignment(property) && propertyName(property.name) === "shell"
      ));
      const shellValue = unwrap(shellProperty?.initializer);
      contract(
        !shellProperty || shellValue?.kind === ts.SyntaxKind.FalseKeyword,
        `${relative(repoRoot, path)}:${source.getLineAndCharacterOfPosition(call.getStart()).line + 1} `
          + "uses an unbounded child shell override",
      );
      const execPathProperty = options?.properties.find((property) => (
        ts.isPropertyAssignment(property) && propertyName(property.name) === "execPath"
      ));
      contract(
        childMethod !== "fork" || !execPathProperty,
        `${relative(repoRoot, path)}:${source.getLineAndCharacterOfPosition(call.getStart()).line + 1} `
          + "uses an unbounded fork execPath override",
      );
      assertNoTreeLeaseStdioCollision(source, call, relative(repoRoot, path));
      assertBoundedChildExecutable(
        source,
        call,
        childMethod,
        path,
        relative(repoRoot, path),
      );
    }
  }
}

async function proveTracedEnvironmentClosureAndDynTemp(worker) {
  const traceOwner = createHarnessOwnedBase("b-e40f-env-trace-");
  const workerTempOwner = createHarnessOwnedBase("b-e40f-env-worker-owned-");
  const traceRoot = createHarnessOwnedFile(traceOwner, "runtime.json", "runtime environment trace");
  try {
    const runtimeRoot = createIsolatedQuorumRuntime(traceOwner, "dyn-success");
    const isolatedSourceTasks = join(runtimeRoot, "packages/main/src/tasks");
    const isolatedAdapter = join(isolatedSourceTasks, "story-aware-validation-case-adapter.mjs");
    const isolatedRegistry = join(isolatedSourceTasks, "story-aware-validation-domain-cases.json");
    const isolatedSmoke = join(runtimeRoot, "packages/main/dist/tasks/quorum-submit-smoke.js");
    const tracer = realpathSync(validationRuntimeTracerPath);
    const inheritedNodeOptions = process.env.NODE_OPTIONS ?? "";
    contract(
      hasTrustedRuntimeTracer(`--require=${tracer}`, tracer)
        && !hasTrustedRuntimeTracer(`--require=${fileURLToPath(import.meta.url)}`, tracer)
        && !hasTrustedRuntimeTracer("--require=/b-e40f/missing-tracer.cjs", tracer),
      "runtime tracer NODE_OPTIONS identity guard is not fail closed",
    );
    const nodeOptions = hasTrustedRuntimeTracer(inheritedNodeOptions, tracer)
      ? inheritedNodeOptions
      : `${inheritedNodeOptions} --require=${tracer}`.trim();
    const shardDir = join(traceOwner.realpath, "shard-evidence");
    mkdirSync(shardDir);
    const execution = await runNodeSubprocess(
      [isolatedAdapter],
      60_000,
      {
        cwd: runtimeRoot,
        env: {
          NODE_OPTIONS: nodeOptions,
          PROOF_OR_STOP_RUNTIME_TRACE_FILE: traceRoot.realpath,
          PROOF_OR_STOP_VALIDATION_SHARD_CASE_REGISTRY: isolatedRegistry,
          PROOF_OR_STOP_VALIDATION_SHARD_DIR: shardDir,
          PROOF_OR_STOP_VALIDATION_SHARD_DOMAIN: "quorum",
          PROOF_OR_STOP_VALIDATION_SHARD_ID: "b-e40f-env-probe",
          PROOF_OR_STOP_VALIDATION_SHARD_SENTINEL: "quorum:scenario-3",
          PROOF_OR_STOP_VALIDATION_SHARD_CASE_REGISTRY_DIGEST: "b-e40f-registry-probe",
          PROOF_OR_STOP_VALIDATION_SHARD_ADAPTER_DIGEST: "b-e40f-adapter-probe",
          PROOF_OR_STOP_VALIDATION_SHARD_CASE_IDS: "quorum:scenario-3",
          PROOF_OR_STOP_VALIDATION_PROJECT_ROOT: runtimeRoot,
          PROOF_OR_STOP_VALIDATION_CASE_TIMEOUT_MS: "60000",
          PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE: workerTempOwner.realpath,
        },
      },
      "traced DYN environment closure",
    );
    contract(
      execution.status === 0 && !execution.timedOut && execution.processGroupReaped
        && execution.orphanedDescendants === false
        && execution.output.includes("PROOF_OR_STOP_CASE_EXECUTED:quorum:scenario-3")
        && execution.output.includes("PROOF_OR_STOP_SENTINEL:quorum:scenario-3"),
      "DYN case did not run through the owned worker coordinator: " + json(execution),
    );
    const fragments = readdirSync(traceOwner.path)
      .filter((name) => name.startsWith("runtime.json.") && name.endsWith(".json"));
    contract(fragments.length >= 4, "official tracer did not merge the adapter/domain/worker process closure");
    const dynEnvironmentKeys = new Set();
    for (const name of fragments) {
      assertOwnedPath(traceOwner, join(traceOwner.realpath, name), "DYN runtime trace fragment", {
        mustExist: true,
        directory: false,
      });
      const row = JSON.parse(readFileSync(join(traceOwner.path, name), "utf8"));
      contract(
        row.traceRoot === "runtime.json" && Number.isSafeInteger(row.pid) && row.pid > 1
          && Array.isArray(row.environmentKeys),
        "runtime trace fragment lost its process/trace-root binding",
      );
      for (const key of row.environmentKeys) dynEnvironmentKeys.add(key);
    }
    const configuredQuorum = readJsonTarget(configPath, "DYN traced environment closure config")
      .validate.commands.find((command) => (
        command.args?.includes("packages/main/dist/tasks/quorum-submit-smoke.js")
      ));
    console.log("DYN_OBSERVED_ENVIRONMENT_KEYS " + json(businessEnvironmentKeys([...dynEnvironmentKeys]).sort()));
    const dynUndeclared = businessEnvironmentKeys([...dynEnvironmentKeys])
      .filter((key) => !configuredQuorum.declaredEnvironmentKeys.includes(key))
      .sort();
    contract(
      dynUndeclared.length === 0,
      "DYN adapter/domain/worker trace observed undeclared environment keys: " + dynUndeclared.join(","),
    );

    const callbackFile = createHarnessOwnedFile(traceOwner, "dyn-callback.jsonl", "DYN callback trace");
    const resourceFile = createHarnessOwnedFile(traceOwner, "dyn-resource.jsonl", "DYN resource trace");
    const ownedTempBase = workerTempOwner.realpath;
    const callbackNonce = randomUUID();
    const directExecution = await runNodeSubprocess(
      [isolatedSmoke, "--jobs=1", "--report=json"],
      60_000,
      {
        cwd: runtimeRoot,
        env: {
          PROOF_OR_STOP_DYN5_CASE: "quorum:scenario-3",
          PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE: callbackFile.realpath,
          PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE: callbackNonce,
          PROOF_OR_STOP_QUORUM_SMOKE_RESOURCE_TRACE_FILE: resourceFile.realpath,
          PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE: ownedTempBase,
        },
      },
      "direct DYN coordinator/resource proof",
    );
    const directReport = parseRunReport(directExecution.output, "direct DYN coordinator/resource proof");
    const directRows = directReport.results ?? [];
    contract(
      directExecution.status === 0 && !directExecution.timedOut
        && directExecution.processGroupReaped && directExecution.orphanedDescendants === false
        && directReport.ok === true && directReport.status === "PASS"
        && directReport.protectedMutationGuard?.clean === true
        && directRows.length === 1 && resultCaseId(directRows[0]) === "quorum:scenario-3"
        && directRows[0].status === "PASS" && Number(directRows[0].workerPid) > 1
        && directReport.fixtureSummary?.directFixtures === 1
        && directReport.fixtureSummary?.directFixtureCleanups === 1,
      "DYN fixture did not execute and clean through an authenticated worker report: "
        + json({ directExecution, directReport }),
    );
    assertReportResidue(directReport, "direct DYN coordinator/resource proof");
    const directMarkers = directExecution.output.split(/\r?\n/)
      .filter((line) => line.startsWith("CASE_PASS "));
    contract(
      json(directMarkers) === json(["CASE_PASS quorum:scenario-3"]),
      "DYN worker emitted an unexpected or malformed CASE_PASS marker",
    );
    const callbackTrace = parseOwnedJsonLines(callbackFile, "direct DYN callback");
    assertCallbackTrace(
      callbackTrace,
      ["quorum:scenario-3"],
      directReport,
      callbackNonce,
      "direct DYN callback",
    );
    const resourceTrace = parseOwnedJsonLines(resourceFile, "direct DYN resource");
    await worker.validateQuorumSmokeResourceTrace({
      claims: [{ class: "git-common-dir", key: ".", access: "shared" }],
      trace: {
        nonce: callbackNonce,
        runId: directReport.runId,
        ownedTempBase,
        ownedTempRoots: directReport.ownedTempRoots,
        accesses: resourceTrace.rows,
        raw: resourceTrace.raw,
      },
      repositoryRoot: runtimeRoot,
      proof: {
        expectedCaseIds: ["quorum:scenario-3"],
        callbackEvents: callbackTrace.rows,
        callbackTraceRaw: callbackTrace.raw,
        report: directReport,
      },
    });
    contract(readdirSync(ownedTempBase).length === 0, "DYN worker-owned base retained fixture residue");

    const protectedTemp = join(traceOwner.realpath, "external-protected-temp");
    mkdirSync(protectedTemp);
    fixtureGit(traceOwner, protectedTemp, ["init", "-q"]);
    for (const hostile of [
      {
        label: "ambient",
        env: { TMPDIR: protectedTemp, TMP: protectedTemp, TEMP: protectedTemp },
        pattern: /ambient temp parent overlaps an external Git repository/i,
      },
      {
        label: "inherited-owned",
        env: { PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE: protectedTemp },
        pattern: /owned temp base overlaps an external Git repository/i,
      },
    ]) {
      const hostileShardDir = join(traceOwner.realpath, `hostile-${hostile.label}-evidence`);
      mkdirSync(hostileShardDir);
      const guard = worker.createQuorumSmokeProtectedMutationGuard([protectedTemp]);
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      const hostileExecution = await runNodeSubprocess(
        [isolatedAdapter],
        20_000,
        {
          cwd: runtimeRoot,
          env: {
            ...hostile.env,
            PROOF_OR_STOP_VALIDATION_SHARD_CASE_REGISTRY: isolatedRegistry,
            PROOF_OR_STOP_VALIDATION_SHARD_DIR: hostileShardDir,
            PROOF_OR_STOP_VALIDATION_SHARD_DOMAIN: "quorum",
            PROOF_OR_STOP_VALIDATION_SHARD_ID: `b-e40f-hostile-${hostile.label}`,
            PROOF_OR_STOP_VALIDATION_SHARD_SENTINEL: "quorum:scenario-3",
            PROOF_OR_STOP_VALIDATION_SHARD_CASE_REGISTRY_DIGEST: "b-e40f-registry-probe",
            PROOF_OR_STOP_VALIDATION_SHARD_ADAPTER_DIGEST: "b-e40f-adapter-probe",
            PROOF_OR_STOP_VALIDATION_SHARD_CASE_IDS: "quorum:scenario-3",
            PROOF_OR_STOP_VALIDATION_PROJECT_ROOT: runtimeRoot,
            PROOF_OR_STOP_VALIDATION_CASE_TIMEOUT_MS: "15000",
          },
        },
        `hostile DYN ${hostile.label} temp-parent refusal`,
      );
      const observed = await guard.close();
      contract(
        hostileExecution.status !== 0 && !hostileExecution.timedOut
          && hostileExecution.processGroupReaped && hostileExecution.orphanedDescendants === false
          && hostile.pattern.test(hostileExecution.output)
          && observed.clean === true && observed.eventCount === 0 && observed.stateMatched === true,
        `hostile DYN ${hostile.label} temp base caused a transient external write/delete: `
          + json({ hostileExecution, observed }),
      );
    }
  } finally {
    try {
      cleanupHarnessOwnedBase(workerTempOwner, "DYN worker-owned temp probe");
    } finally {
      cleanupHarnessOwnedBase(traceOwner, "DYN coordinator/environment/temp probe");
    }
  }
}

function hasTrustedRuntimeTracer(nodeOptions, trustedTracer) {
  const tokens = String(nodeOptions).trim().split(/\s+/).filter(Boolean);
  const candidates = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--require" && index + 1 < tokens.length) {
      candidates.push(tokens[index + 1]);
      index += 1;
    } else if (token.startsWith("--require=")) {
      candidates.push(token.slice("--require=".length));
    }
  }
  const trustedDigest = createHash("sha256").update(readFileSync(trustedTracer)).digest("hex");
  return candidates.some((candidate) => {
    try {
      if (!isAbsolute(candidate) || basename(candidate) !== basename(trustedTracer)) return false;
      const entry = lstatSync(candidate);
      return entry.isFile() && !entry.isSymbolicLink()
        && createHash("sha256").update(readFileSync(candidate)).digest("hex") === trustedDigest;
    } catch {
      return false;
    }
  });
}

function businessEnvironmentKeys(keys) {
  return keys.filter((key) => {
    if (!EXACT_HEAD_TREE_LEASE_TRACE_TRANSPORT_ENV_KEYS.has(key)) return true;
    const marker = process.env[EXACT_HEAD_TREE_LEASE_MARKER_ENV];
    contract(
      exactHeadOuterSupervisorSafetyProven
        && typeof marker === "string" && marker.length >= 16 && !/\s/.test(marker),
      "tree-lease trace transport key lacks bound outer supervisor authority",
    );
    return false;
  });
}

async function proveAmbientGitRoutingIsolation() {
  const owner = createHarnessOwnedBase("b-e40f-ambient-git-routing-");
  const workerTempOwner = createHarnessOwnedBase("b-e40f-ambient-worker-owned-");
  const runtimeRoot = createIsolatedQuorumRuntime(owner, "ambient-git");
  const isolatedSmoke = join(runtimeRoot, "packages/main/dist/tasks/quorum-submit-smoke.js");
  const victim = join(owner.realpath, "victim");
  mkdirSync(victim);
  const ambientHome = join(owner.realpath, "ambient-home");
  const ambientXdg = join(owner.realpath, "ambient-xdg");
  const ambientHooks = join(owner.realpath, "ambient-hooks");
  const ambientTemplate = join(owner.realpath, "ambient-template");
  const ambientSystem = join(owner.realpath, "ambient-system");
  for (const path of [ambientHome, ambientXdg, join(ambientXdg, "git"), ambientHooks,
    ambientTemplate, join(ambientTemplate, "hooks"), ambientSystem]) mkdirSync(path);
  const ambientMarker = createHarnessOwnedFile(owner, "ambient-hook-fired.log", "ambient Git hook marker");
  const hookSource = `#!/bin/sh\nprintf 'ambient-hook-fired\\n' >> ${JSON.stringify(ambientMarker.realpath)}\n`;
  const externalHook = join(ambientHooks, "pre-commit");
  const templateHook = join(ambientTemplate, "hooks", "pre-commit");
  writeFixtureFile(owner, ambientHooks, "pre-commit", hookSource);
  writeFixtureFile(owner, ambientTemplate, "hooks/pre-commit", hookSource);
  chmodSync(externalHook, 0o755);
  chmodSync(templateHook, 0o755);
  const hostileConfig = `[core]\n\thooksPath = ${ambientHooks}\n[init]\n\ttemplateDir = ${ambientTemplate}\n`;
  writeFixtureFile(owner, ambientHome, ".gitconfig", hostileConfig);
  writeFixtureFile(owner, ambientXdg, "git/config", hostileConfig);
  writeFixtureFile(owner, ambientSystem, "gitconfig", hostileConfig);
  try {
    fixtureGit(owner, victim, ["init", "-q"]);
    writeFixtureFile(owner, victim, "sentinel.txt", "ambient Git routing sentinel\n");
    fixtureGit(owner, victim, ["add", "."]);
    fixtureGit(owner, victim, ["commit", "-qm", "ambient routing sentinel"]);
    const indexPath = join(victim, ".git", "index");
    const headPath = join(victim, ".git", "HEAD");
    const indexBefore = readFileSync(indexPath);
    const headBefore = readFileSync(headPath);
    const statusBefore = fixtureGit(owner, victim, ["status", "--short"]);
    const execution = await runNodeSubprocess(
      [isolatedSmoke, "--case=qsm-004", "--jobs=1", "--report=json"],
      30_000,
      {
        cwd: runtimeRoot,
        env: {
          GIT_DIR: join(victim, ".git"),
          GIT_COMMON_DIR: join(victim, ".git"),
          GIT_WORK_TREE: victim,
          GIT_INDEX_FILE: indexPath,
          GIT_OBJECT_DIRECTORY: join(victim, ".git", "objects"),
          GIT_ALTERNATE_OBJECT_DIRECTORIES: join(victim, ".git", "objects"),
          HOME: ambientHome,
          USERPROFILE: ambientHome,
          XDG_CONFIG_HOME: ambientXdg,
          GIT_CONFIG_SYSTEM: join(ambientSystem, "gitconfig"),
          GIT_CONFIG_GLOBAL: join(ambientHome, ".gitconfig"),
          GIT_TEMPLATE_DIR: ambientTemplate,
          PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE: workerTempOwner.realpath,
        },
      },
      "ambient Git routing isolation",
    );
    contract(
      execution.output.includes("QUORUM_SMOKE_RUN_JSON "),
      "ambient Git routing isolation emitted no coordinator report: " + json(execution),
    );
    const ambientReport = parseRunReport(execution.output, "ambient Git routing isolation");
    const ambientCase = ambientReport.results?.find((row) => resultCaseId(row) === "qsm-004");
    contract(
      execution.status === 0 && !execution.timedOut
        && execution.processGroupReaped && execution.orphanedDescendants === false
        && execution.output.includes("CASE_PASS qsm-004")
        && ambientCase?.status === "PASS"
        && ambientReport.ok === true && ambientReport.status === "PASS"
        && ambientReport.protectedMutationGuard?.clean === true,
      "ambient Git routing variables were not sanitized before a real fixture-consuming case: "
        + json(execution),
    );
    assertReportResidue(ambientReport, "ambient Git routing isolation");
    contract(
      readFileSync(indexPath).equals(indexBefore)
        && readFileSync(headPath).equals(headBefore)
        && fixtureGit(owner, victim, ["status", "--short"]) === statusBefore,
      "ambient Git routing redirected real fixture writes into an external repository",
    );
    contract(
      readHarnessOwnedFile(ambientMarker, "ambient Git hook marker", "utf8") === "",
      "ambient HOME/XDG/system config/template/hooks influenced a fixture Git process",
    );
  } finally {
    try {
      cleanupHarnessOwnedBase(workerTempOwner, "ambient Git worker-owned temp probe");
    } finally {
      cleanupHarnessOwnedBase(owner, "ambient Git routing probe repo");
    }
  }
}

async function proveSiblingWorktreeProtection() {
  const owner = createHarnessOwnedBase("b-e40f-sibling-worktree-");
  const primary = join(owner.realpath, "primary");
  const sibling = join(owner.realpath, "sibling");
  mkdirSync(primary);
  try {
    fixtureGit(owner, primary, ["init", "-q"]);
    writeFixtureFile(owner, primary, "sentinel.txt", "sibling worktree sentinel\n");
    fixtureGit(owner, primary, ["add", "."]);
    fixtureGit(owner, primary, ["commit", "-qm", "linked-worktree boundary"]);
    fixtureGit(owner, primary, ["worktree", "add", "-q", "-b", "b-e40f-sibling", sibling]);
    const siblingSentinel = safeFixturePath(
      owner,
      sibling,
      "sentinel.txt",
      "sibling worktree tracked sink",
      { mustExist: true, directory: false },
    );
    const sentinelBefore = readFileSync(siblingSentinel.normalized);
    const siblingStatus = () => execFileSync(
      "git",
      ["-C", sibling, "status", "--short"],
      {
        encoding: "utf8",
        env: Object.fromEntries(
          ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]
            .filter((key) => typeof process.env[key] === "string")
            .map((key) => [key, process.env[key]]),
        ),
      },
    );
    const statusBefore = siblingStatus();
    const execution = await runNodeSubprocess(
      [smokeDistPath, "--case=qsm-002", "--jobs=1", "--report=json"],
      5_000,
      {
        cwd: primary,
        env: {
          PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE: realpathSync(siblingSentinel.normalized),
          PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE: randomUUID(),
        },
      },
      "sibling worktree trace-sink rejection",
    );
    contract(
      execution.status !== 0 && !execution.timedOut
        && execution.processGroupReaped && execution.orphanedDescendants === false,
      "sibling worktree trace sink was not rejected before execution",
    );
    contract(
      /strictly outside the repository and git common directory/i.test(execution.output)
        && !execution.output.includes("CASE_PASS qsm-002"),
      "sibling worktree trace sink emitted no protected-boundary refusal",
    );
    contract(
      readFileSync(siblingSentinel.normalized).equals(sentinelBefore)
        && siblingStatus() === statusBefore,
      "sibling worktree trace rejection changed tracked bytes or status",
    );
  } finally {
    cleanupHarnessOwnedBase(owner, "sibling linked-worktree probe");
  }
}

async function smoke(args, timeoutMs = 90_000, options = {}) {
  if (!existsSync(smokeDistPath)) {
    throw new BootstrapFailure(
      "quorum smoke build artifact is missing: " + smokeDistPath
      + "; run npm --prefix packages/main run build",
    );
  }
  return runNodeSubprocess(
    [smokeDistPath, ...args], timeoutMs, options, "quorum smoke " + json(args),
  );
}

function gitStatus() {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function normalizeRows(rows) {
  return rows.map((row) => ({
    id: String(row.id ?? row.caseId ?? ""),
    title: String(row.title ?? row.name ?? ""),
    domain: String(row.domain ?? ""),
  })).sort((left, right) => left.id.localeCompare(right.id));
}

function objectProperty(object, name) {
  const matches = object.properties.filter((property) => {
    if (!ts.isPropertyAssignment(property)) return false;
    if (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) {
      return property.name.text === name;
    }
    return false;
  });
  contract(matches.length <= 1, "defineQuorumSmokeCase has duplicate " + name + " properties");
  return matches[0];
}

function literalRegistrationField(object, name, sourceFile, location) {
  const property = objectProperty(object, name);
  contract(Boolean(property), location + " defineQuorumSmokeCase is missing literal " + name);
  contract(
    ts.isStringLiteralLike(property.initializer),
    location + " defineQuorumSmokeCase " + name + " must be a string literal",
  );
  const value = property.initializer.text;
  contract(value.trim().length > 0, location + " defineQuorumSmokeCase " + name + " is empty");
  return value;
}

const NON_WORK_CALLS = new Set([
  "Boolean", "String", "Number", "BigInt", "Object", "Array",
  "Date.now", "performance.now", "JSON.stringify", "JSON.parse",
  "console.log", "console.error", "process.stdout.write", "process.stderr.write",
]);

function callbackSemanticTokens(callback) {
  if (!ts.isBlock(callback.body)) return [];
  const tokens = [];
  const collectAssertionLiterals = (node, prefix) => {
    if (ts.isStringLiteralLike(node) || ts.isRegularExpressionLiteral(node)) {
      tokens.push(prefix + ":" + (ts.isStringLiteralLike(node) ? json(node.text) : node.text));
    }
    ts.forEachChild(node, (child) => collectAssertionLiterals(child, prefix));
  };
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(callback.getSourceFile()).replace(/\s+/g, "");
      if (!NON_WORK_CALLS.has(callee) && !callee.startsWith("Math.")) {
        tokens.push("call:" + callee);
      }
      if (callee === "assert" || callee.startsWith("assert.")) {
        for (const argument of node.arguments) collectAssertionLiterals(argument, "assert-literal");
      }
    }
    if (ts.isThrowStatement(node)) {
      tokens.push("throw");
      if (node.expression) collectAssertionLiterals(node.expression, "throw-literal");
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(callback.body, visit);
  return tokens.sort();
}

const TEXT_BEARING_SYNTAX_KINDS = new Set([
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.PrivateIdentifier,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

function syntaxFingerprint(node, replacementFor = () => undefined) {
  const parts = [];
  const visit = (candidate) => {
    const replacement = replacementFor(candidate);
    if (replacement !== undefined) {
      parts.push(replacement);
      return;
    }
    parts.push(String(candidate.kind));
    if (TEXT_BEARING_SYNTAX_KINDS.has(candidate.kind)) {
      parts.push(String(candidate.text ?? ""));
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return createHash("sha256").update("b-e40f-ts-ast-v1\u0000" + parts.join("\u0000")).digest("hex");
}

function qsm046StatePathFingerprint(callback, mode) {
  contract(ts.isBlock(callback.body), "qsm-046 callback body must be a block");
  let legacy = 0, canonical = 0;
  const fingerprint = syntaxFingerprint(callback.body, (candidate) => {
    const isLegacy = ts.isStringLiteralLike(candidate) && candidate.text === ".lattice";
    const isCanonical = ts.isIdentifier(candidate) && candidate.text === "PROOF_OR_STOP_STATE_DIR";
    if (!isLegacy && !isCanonical) return undefined;
    if (isLegacy) legacy += 1;
    else canonical += 1;
    return "QSM_046_STATE_DIR";
  });
  contract(mode === "baseline" ? legacy === 1 && canonical === 0 : legacy === 0 && canonical === 1,
    "qsm-046 must uniquely replace legacy .lattice with PROOF_OR_STOP_STATE_DIR");
  return fingerprint;
}

function callbackBodyFingerprint(callback) {
  contract(ts.isBlock(callback.body), "case callback body must be a block");
  return syntaxFingerprint(callback.body);
}

function statementFingerprint(statement) {
  return syntaxFingerprint(statement);
}

function callbackHasRealWork(callback) {
  if (!ts.isBlock(callback.body) || callback.body.statements.length === 0) return false;
  return callbackSemanticTokens(callback).some((token) => token === "throw" || token.startsWith("call:"));
}

function syntheticCallback(bodySource) {
  const sourceFile = ts.createSourceFile(
    "b-e40f-negative-control.ts",
    "const callback = () => { " + bodySource + " };",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = sourceFile.statements[0]?.declarationList?.declarations?.[0];
  contract(
    declaration && ts.isArrowFunction(declaration.initializer),
    "callback fingerprint negative control did not parse",
  );
  return declaration.initializer;
}

function assertTrivialCallbackDetector() {
  const dateOnly = syntheticCallback("Date.now();");
  const booleanOnly = syntheticCallback("Boolean('static-pass');");
  contract(!callbackHasRealWork(dateOnly), "Date.now-only callback incorrectly counts as real work");
  contract(!callbackHasRealWork(booleanOnly), "Boolean-only callback incorrectly counts as real work");
  return { dateOnly, booleanOnly };
}

function assertMigrationCallbackControls(baselines) {
  const { dateOnly, booleanOnly } = assertTrivialCallbackDetector();
  for (const title of [EXPECTED_CASES[0].title, EXPECTED_CASES[22].title]) {
    const baseline = baselines.get(title);
    let rejected = false;
    try {
      assertCallbackMatchesBaseline({
        id: EXPECTED_CASES.find((row) => row.title === title).id,
        title,
        callbackNode: title === EXPECTED_CASES[0].title ? dateOnly : booleanOnly,
      }, baseline);
    } catch (error) {
      if (!(error instanceof ContractFailure)) throw error;
      rejected = true;
    }
    contract(rejected, "trivial callback mutation unexpectedly preserves " + title + " semantics");
  }
}

function multisetContains(actual, expected) {
  const counts = new Map();
  for (const token of actual) counts.set(token, (counts.get(token) ?? 0) + 1);
  for (const token of expected) {
    const remaining = counts.get(token) ?? 0;
    if (remaining === 0) return false;
    counts.set(token, remaining - 1);
  }
  return true;
}

function originalCallbackBaselines() {
  let sourceText = "";
  try {
    sourceText = execFileSync(
      "git",
      ["show", ORIGINAL_SMOKE_COMMIT + ":packages/main/src/tasks/quorum-submit-smoke.ts"],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (error) {
    throw new BootstrapFailure(
      "cannot read the immutable quorum smoke baseline " + ORIGINAL_SMOKE_COMMIT + ": " + error.message,
    );
  }
  const sourceFile = ts.createSourceFile(
    "quorum-submit-smoke@" + ORIGINAL_SMOKE_COMMIT + ".ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  contract(sourceFile.parseDiagnostics.length === 0, "immutable quorum smoke baseline has parse diagnostics");
  const rows = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "check"
      && node.arguments.length === 2
      && ts.isStringLiteralLike(node.arguments[0])
      && (ts.isArrowFunction(node.arguments[1]) || ts.isFunctionExpression(node.arguments[1]))
    ) {
      const callback = node.arguments[1];
      rows.push({
        title: node.arguments[0].text,
        bodyFingerprint: node.arguments[0].text === EXPECTED_CASES[45].title ? qsm046StatePathFingerprint(callback, "baseline") : callbackBodyFingerprint(callback),
        statementFingerprints: callback.body.statements.map(statementFingerprint),
        semanticTokens: callbackSemanticTokens(callback),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  contract(
    rows.length === EXPECTED_CASES.length && new Set(rows.map((row) => row.title)).size === rows.length,
    "immutable baseline must expose 73 uniquely titled check callbacks; found=" + rows.length,
  );
  const expectedTitles = EXPECTED_CASES.map((row) => row.title).sort();
  contract(
    json(rows.map((row) => row.title).sort()) === json(expectedTitles),
    "immutable baseline titles diverge from the frozen 73-case map",
  );
  return new Map(rows.map((row) => [row.title, row]));
}

function allowedSetupPrefixStatement(statement) {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.every((declaration) => {
      if (!declaration.initializer) return false;
      let invokesSetup = false;
      const visit = (node) => {
        if (ts.isCallExpression(node) || ts.isAwaitExpression(node)) invokesSetup = true;
        ts.forEachChild(node, visit);
      };
      visit(declaration.initializer);
      return invokesSetup;
    });
  }
  if (!ts.isExpressionStatement(statement)) return false;
  let invokesSetup = false;
  const visit = (node) => {
    if (ts.isCallExpression(node) || ts.isAwaitExpression(node)) invokesSetup = true;
    ts.forEachChild(node, visit);
  };
  visit(statement.expression);
  return invokesSetup;
}

function assertCallbackMatchesBaseline(registration, baseline) {
  const currentTokens = callbackSemanticTokens(registration.callbackNode);
  contract(
    multisetContains(currentTokens, baseline.semanticTokens),
    registration.id + " dropped an original assertion/throw/helper-call fingerprint",
  );
  const exact = (registration.id === "qsm-046"
    ? qsm046StatePathFingerprint(registration.callbackNode, "current")
    : callbackBodyFingerprint(registration.callbackNode)) === baseline.bodyFingerprint;
  if (!SETUP_REFACTORED_CASE_IDS.has(registration.id)) {
    contract(
      exact,
      registration.id + " changed a mechanically migrated callback body outside the seven setup refactors",
    );
    return true;
  }
  if (exact) return true;
  const statements = registration.callbackNode.body.statements;
  const tailLength = baseline.statementFingerprints.length;
  contract(statements.length > tailLength, registration.id + " setup refactor did not preserve the original body tail");
  const prefix = statements.slice(0, statements.length - tailLength);
  const tail = statements.slice(-tailLength).map(statementFingerprint);
  contract(
    prefix.every(allowedSetupPrefixStatement),
    registration.id + " setup prefix contains branching, early exit, or declarations unrelated to setup calls",
  );
  contract(
    json(tail) === json(baseline.statementFingerprints),
    registration.id + " setup refactor did not preserve the exact original top-level statement tail",
  );
  return false;
}

function assertOriginalCallbackCoverage(registrations) {
  const baselines = originalCallbackBaselines();
  assertMigrationCallbackControls(baselines);
  let exactBodies = 0;
  for (const registration of registrations) {
    const baseline = baselines.get(registration.title);
    contract(Boolean(baseline), "registration has no immutable callback baseline: " + registration.id);
    if (assertCallbackMatchesBaseline(registration, baseline)) exactBodies += 1;
    else {
      contract(
        SETUP_REFACTORED_CASE_IDS.has(registration.id),
        registration.id + " used setup refactoring outside the frozen seven-case allowlist",
      );
    }
    contract(
      callbackHasRealWork(registration.callbackNode),
      registration.id + " callback is empty, trivial, or static PASS-only",
    );
  }
  contract(
    exactBodies >= EXPECTED_CASES.length - SETUP_REFACTORED_CASE_IDS.size,
    "fewer than 66 callbacks preserved the immutable body fingerprint; exact=" + exactBodies,
  );
}

function scanExecutableRegistrations() {
  const registrations = [];
  for (const path of caseSourcePaths) {
    contract(existsSync(path), "planned executable case source is absent: " + path);
    const sourceText = readFileSync(path, "utf8");
    const sourceFile = ts.createSourceFile(
      path,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    contract(
      sourceFile.parseDiagnostics.length === 0,
      relative(repoRoot, path) + " has TypeScript parse diagnostics: "
        + sourceFile.parseDiagnostics.map((diagnostic) => diagnostic.messageText).join(" | "),
    );
    let registrationsInFile = 0;
    const visit = (node) => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "defineQuorumSmokeCase"
      ) {
        registrationsInFile += 1;
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        const location = relative(repoRoot, path) + ":" + line;
        contract(
          node.arguments.length === 1 && ts.isObjectLiteralExpression(node.arguments[0]),
          location + " defineQuorumSmokeCase must receive one object literal",
        );
        const record = node.arguments[0];
        contract(
          record.properties.every(
            (property) => ts.isPropertyAssignment(property)
              && !ts.isComputedPropertyName(property.name),
          ),
          location + " defineQuorumSmokeCase forbids spread, shorthand, methods, and computed properties",
        );
        const runProperty = objectProperty(record, "run");
        contract(Boolean(runProperty), location + " defineQuorumSmokeCase is missing run callback");
        contract(
          ts.isArrowFunction(runProperty.initializer)
            || ts.isFunctionExpression(runProperty.initializer),
          location + " defineQuorumSmokeCase run must be an inline function literal",
        );
        contract(
          callbackHasRealWork(runProperty.initializer),
          location + " defineQuorumSmokeCase run is empty or a print-only/static PASS callback",
        );
        const id = literalRegistrationField(record, "id", sourceFile, location);
        if (id === "qsm-046") {
          const binding = namedImportBinding(
            sourceFile, "../core/brand-paths.js", "PROOF_OR_STOP_STATE_DIR", location,
          );
          contract(binding.localName === "PROOF_OR_STOP_STATE_DIR", location + " must not alias the canonical state-dir import");
        }
        registrations.push({
          id,
          title: literalRegistrationField(record, "title", sourceFile, location),
          domain: literalRegistrationField(record, "domain", sourceFile, location),
          shard: literalRegistrationField(record, "shard", sourceFile, location),
          registrationSource: relative(repoRoot, path),
          callbackBound: true,
          callbackNode: runProperty.initializer,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (registrationsInFile > 0) {
      const binding = namedImportBinding(
        sourceFile, "./quorum-submit-smoke-case-catalog.js", "defineQuorumSmokeCase", relative(repoRoot, path),
      );
      contract(
        binding.localName === "defineQuorumSmokeCase",
        relative(repoRoot, path)
          + " registrations must use the named defineQuorumSmokeCase import from the catalog without shadowing",
      );
    }
  }
  return registrations;
}

function normalizeRegistrationRows(rows) {
  return rows.map((row) => ({
    id: String(row.id ?? row.caseId ?? ""),
    title: String(row.title ?? row.name ?? ""),
    domain: String(row.domain ?? ""),
    shard: String(row.shard ?? row.shardId ?? ""),
  })).sort((left, right) => left.id.localeCompare(right.id));
}

function assertRuntimeRowsAreCallbackBound(runtimeRows, registrations) {
  const sourceById = new Map(registrations.map((row) => [row.id, row.registrationSource]));
  contract(
    runtimeRows.every((row) => row.callbackBound === true),
    "--list-cases=json contains a row not bound to an executable callback",
  );
  for (const row of runtimeRows) {
    const id = String(row.id ?? row.caseId ?? "");
    contract(
      row.registrationSource === sourceById.get(id),
      "--list-cases=json row " + id + " does not identify its scanned callback source; "
        + "a manifest echo is not executable registration evidence",
    );
  }
}

function caseDistPath(sourcePath) {
  return join(distTasks, sourcePath.slice(sourceTasks.length + 1).replace(/\.ts$/, ".js"));
}

async function loadBuiltCallbackRegistrations() {
  const rows = [];
  for (const sourcePath of caseSourcePaths.slice(1)) {
    const module = await loadBuiltTarget(
      sourcePath,
      caseDistPath(sourcePath),
      "executable callback registry",
    );
    contract(
      Array.isArray(module.QUORUM_SMOKE_CASES),
      relative(repoRoot, sourcePath) + " must export QUORUM_SMOKE_CASES",
    );
    for (const row of module.QUORUM_SMOKE_CASES) {
      contract(
        row && typeof row.run === "function",
        relative(repoRoot, sourcePath) + " exports a registration without a real run callback",
      );
      rows.push({
        ...row,
        registrationSource: relative(repoRoot, sourcePath),
        callbackBound: true,
      });
    }
  }
  return rows;
}
function namedImportBinding(file, moduleName, importedName, label) {
  const matches = [];
  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement)
      && ts.isStringLiteralLike(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === moduleName
      && !statement.importClause?.isTypeOnly
      && statement.importClause?.namedBindings
      && ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      for (const element of statement.importClause.namedBindings.elements) {
        if (!element.isTypeOnly && (element.propertyName?.text ?? element.name.text) === importedName) matches.push(element);
      }
    }
  }
  contract(matches.length === 1, label + " must named-import exactly one " + importedName + " from " + moduleName);
  const specifier = matches[0];
  const localName = specifier.name.text;
  const shadows = [];
  const isRuntimeBinding = (node) => {
    if (!ts.isIdentifier(node) || node.text !== localName || node === specifier.name) return false;
    const parent = node.parent;
    return (
      ((ts.isVariableDeclaration(parent)
        || ts.isParameter(parent)
        || ts.isBindingElement(parent)) && parent.name === node)
      || ((ts.isFunctionDeclaration(parent)
        || ts.isFunctionExpression(parent)
        || ts.isClassDeclaration(parent)
        || ts.isClassExpression(parent)
        || ts.isEnumDeclaration(parent)
        || ts.isModuleDeclaration(parent)) && parent.name === node)
      || ((ts.isImportSpecifier(parent)
        || ts.isImportClause(parent)
        || ts.isNamespaceImport(parent)
        || ts.isImportEqualsDeclaration(parent)) && parent.name === node)
    );
  };
  const visit = (node) => {
    if (isRuntimeBinding(node)) shadows.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  contract(
    shadows.length === 0,
    label + " shadows imported " + importedName + "; binding identity cannot be proven",
  );
  return { localName, specifier };
}
function assertEntrypointCaseModuleWiring() {
  const sourceText = readFileSync(smokeSourcePath, "utf8");
  const sourceFile = ts.createSourceFile(
    smokeSourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  contract(sourceFile.parseDiagnostics.length === 0, "quorum smoke entrypoint has parse diagnostics");
  const expectedModules = caseSourcePaths.slice(1).map(
    (path) => "./" + relative(sourceTasks, path).replace(/\.ts$/, ".js"),
  );
  const importedArrays = expectedModules.map((module) => ({
    module,
    binding: namedImportBinding(sourceFile, module, "QUORUM_SMOKE_CASES", "quorum smoke entrypoint"),
  }));
  const registryBinding = namedImportBinding(
    sourceFile,
    "./quorum-submit-smoke-case-catalog.js",
    "createQuorumSmokeRegistry",
    "quorum smoke entrypoint",
  );
  const registryCalls = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === registryBinding.localName
    ) {
      registryCalls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  contract(
    registryCalls.length === 1,
    "entrypoint must make exactly one real createQuorumSmokeRegistry call",
  );
  assertCoordinatorExecutionWiring(sourceFile, registryCalls[0]);
  contract(
    registryCalls[0].arguments.length === importedArrays.length
      && registryCalls[0].arguments.every((argument, index) => ts.isIdentifier(argument)
        && argument.text === importedArrays[index].binding.localName),
    "createQuorumSmokeRegistry must receive only the three exact imported case arrays in module order",
  );
  contract(
    !sourceText.includes("quorum-submit-smoke-cases.json"),
    "entrypoint reads the declarative manifest; --list could be a manifest echo",
  );
  for (const path of caseSourcePaths.slice(1)) {
    contract(
      !readFileSync(path, "utf8").includes("quorum-submit-smoke-cases.json"),
      relative(repoRoot, path) + " reads the declarative manifest instead of defining callbacks",
    );
  }
  contract(
    !readFileSync(catalogSourcePath, "utf8").includes("quorum-submit-smoke-cases.json"),
    "catalog runtime reads the declarative manifest; runtime listing must derive from callback registrations",
  );
}
function assertCoordinatorExecutionWiring(entryFile, registryCall) {
  const collect = (root, predicate) => {
    const matches = [];
    const visit = (node) => {
      if (predicate(node)) matches.push(node);
      ts.forEachChild(node, visit);
    };
    visit(root);
    return matches;
  };
  const propertyName = (name) => (
    name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : null
  );
  const unwrap = (input) => {
    if (!input) return input;
    let node = input;
    while (
      ts.isParenthesizedExpression(node)
      || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node)
      || ts.isNonNullExpression(node)
      || ts.isAwaitExpression(node)
      || (typeof ts.isSatisfiesExpression === "function" && ts.isSatisfiesExpression(node))
    ) node = node.expression;
    return node;
  };
  const objectValue = (object, key) => object.properties
    .find((candidate) => propertyName(candidate.name) === key).initializer;
  const functionsNamed = (file, name) => collect(file, (node) => (
    (ts.isFunctionDeclaration(node) && node.name?.text === name && Boolean(node.body))
      || (ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.name.text === name
        && node.initializer
        && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))
  )).map((node) => ts.isVariableDeclaration(node) ? node.initializer : node);
  const runtimeBindingParents = [
    ts.isVariableDeclaration, ts.isParameter, ts.isBindingElement,
    ts.isFunctionDeclaration, ts.isFunctionExpression, ts.isClassDeclaration, ts.isClassExpression,
  ];
  const runtimeBindings = (root, name) => collect(root, (node) => ts.isIdentifier(node)
    && node.text === name && runtimeBindingParents.some((isKind) => isKind(node.parent))
    && node.parent.name === node);
  const readSource = (path, label) => {
    contract(existsSync(path), label + " source is absent: " + path);
    const text = readFileSync(path, "utf8");
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    if (file.parseDiagnostics.length > 0) {
      throw new BootstrapFailure(label + " has TypeScript parse diagnostics");
    }
    return { text, file };
  };
  const coordinatorBinding = namedImportBinding(
    entryFile,
    "./quorum-submit-smoke-worker.js",
    "runQuorumSmokeCoordinator",
    "quorum smoke entrypoint",
  );
  const sensitiveModules = new Set([
    "./quorum-submit-smoke-worker.js",
    "./quorum-submit-smoke-case-catalog.js",
    ...caseSourcePaths.slice(1).map((path) => "./" + relative(sourceTasks, path).replace(/\.ts$/, ".js")),
  ]);
  for (const statement of entryFile.statements.filter((node) => (
    ts.isImportDeclaration(node)
      && ts.isStringLiteralLike(node.moduleSpecifier)
      && sensitiveModules.has(node.moduleSpecifier.text)
      && !node.importClause?.isTypeOnly
  ))) {
    contract(
      !statement.importClause?.name
        && statement.importClause?.namedBindings
        && ts.isNamedImports(statement.importClause.namedBindings),
      "quorum smoke execution modules must use inspectable named imports",
    );
    if (statement.moduleSpecifier.text === "./quorum-submit-smoke-worker.js") {
      const values = statement.importClause.namedBindings.elements.filter((element) => !element.isTypeOnly);
      contract(
        values.every((element) => (
          (element.propertyName?.text ?? element.name.text) === "runQuorumSmokeCoordinator"
        )),
        "entrypoint imports an alternate worker execution API",
      );
    }
  }
  const mainDefinitions = functionsNamed(entryFile, "runQuorumSmokeMain");
  contract(mainDefinitions.length === 1, "entrypoint must define one runQuorumSmokeMain");
  const main = mainDefinitions[0];
  contract(
    ts.isFunctionDeclaration(main)
      && main.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      && ts.isBlock(main.body),
    "runQuorumSmokeMain must be a named exported function with an inspectable body",
  );
  const mainParameter = main.parameters[0];
  contract(
    main.parameters.length === 1 && mainParameter && ts.isObjectBindingPattern(mainParameter.name),
    "runQuorumSmokeMain must accept one destructured options object",
  );
  const requiredMainKeys = ["argv", "registrations", "coordinator", "reportSink", "context"];
  contract(
    !mainParameter.initializer && mainParameter.name.elements.length === requiredMainKeys.length
      && mainParameter.name.elements.every((element) => !element.dotDotDotToken && !element.initializer
        && ts.isIdentifier(element.propertyName ?? element.name) && ts.isIdentifier(element.name)),
    "runQuorumSmokeMain must use only five simple bindings with no rest, computed key, or default initializer",
  );
  const mainBindings = new Map();
  for (const key of requiredMainKeys) {
    const elements = mainParameter.name.elements.filter(
      (element) => propertyName(element.propertyName ?? element.name) === key,
    );
    contract(
      elements.length === 1 && ts.isIdentifier(elements[0].name),
      "runQuorumSmokeMain options must bind exactly one " + key,
    );
    mainBindings.set(key, elements[0].name.text);
  }
  const coordinatorLocal = mainBindings.get("coordinator");
  contract(
    runtimeBindings(main, coordinatorLocal).length === 1,
    "runQuorumSmokeMain coordinator binding is shadowed",
  );
  const coordinatorCalls = collect(main.body, (node) => (
    ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === coordinatorLocal
  ));
  contract(coordinatorCalls.length === 1, "runQuorumSmokeMain must call its injected coordinator exactly once");
  const dynBinding = namedImportBinding(
    entryFile,
    "./quorum-submit-smoke-integration-cases.js",
    "runQuorumSmokeDynCase",
    "quorum smoke DYN execution",
  );
  const dynCalls = collect(main.body, (node) => (
    ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === dynBinding.localName
  ));
  contract(dynCalls.length === 1, "runQuorumSmokeMain must bind exactly one DYN case callback");
  const dynCall = dynCalls[0];
  const dynCallback = dynCall.parent;
  const dynRunProperty = dynCallback?.parent;
  const dynRegistration = dynRunProperty?.parent;
  contract(
    dynCall.arguments.length === 1 && ts.isIdentifier(dynCall.arguments[0])
      && dynCall.arguments[0].text === "dynCase"
      && ts.isArrowFunction(dynCallback) && dynCallback.parameters.length === 0
      && dynCallback.body === dynCall
      && ts.isPropertyAssignment(dynRunProperty) && propertyName(dynRunProperty.name) === "run"
      && dynRunProperty.initializer === dynCallback
      && ts.isObjectLiteralExpression(dynRegistration)
      && objectValue(dynRegistration, "id")?.getText(entryFile) === "dynCase"
      && ts.isStringLiteralLike(objectValue(dynRegistration, "registrationSource"))
      && objectValue(dynRegistration, "registrationSource").text
        === "packages/main/src/tasks/quorum-submit-smoke-integration-cases.ts",
    "DYN execution must be the synthetic registration callback consumed by the coordinator",
  );
  const dynReferences = collect(entryFile, (node) => ts.isIdentifier(node)
    && node.text === dynBinding.localName
    && ![dynBinding.specifier.name, dynBinding.specifier.propertyName, dynCall.expression].includes(node));
  contract(
    dynReferences.length === 0,
    "runQuorumSmokeDynCase may only execute from the coordinator-owned synthetic registration",
  );

  const mainCalls = collect(entryFile, (node) => (
    ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "runQuorumSmokeMain"
  ));
  contract(mainCalls.length === 1, "real CLI must have one runQuorumSmokeMain launch point");
  const mainCall = mainCalls[0];
  const topOptions = unwrap(mainCall.arguments[0]);
  contract(
    mainCall.arguments.length === 1 && ts.isObjectLiteralExpression(topOptions),
    "real CLI must call runQuorumSmokeMain with one inspectable options object",
  );
  const topKeys = ["argv", "registrations", "coordinator", "reportSink", "context"];
  contract(
    topOptions.properties.length === topKeys.length && topKeys.every((key) => topOptions.properties
      .filter((property) => ts.isPropertyAssignment(property) && propertyName(property.name) === key).length === 1),
    "real CLI runQuorumSmokeMain options must contain only five exact, side-effect-free properties",
  );
  contract(
    unwrap(objectValue(topOptions, "registrations")) === registryCall,
    "real CLI must pass the exact createQuorumSmokeRegistry result into runQuorumSmokeMain",
  );
  const topCoordinator = unwrap(objectValue(topOptions, "coordinator"));
  contract(
    ts.isIdentifier(topCoordinator) && topCoordinator.text === coordinatorBinding.localName,
    "real CLI must inject the exact imported runQuorumSmokeCoordinator",
  );
  const coordinatorReferences = collect(entryFile, (node) => ts.isIdentifier(node)
    && node.text === coordinatorBinding.localName
    && ![coordinatorBinding.specifier.name, coordinatorBinding.specifier.propertyName, topCoordinator].includes(node));
  contract(
    coordinatorReferences.length === 0,
    "real coordinator import may only appear as the runQuorumSmokeMain coordinator capability",
  );
  const isProcessArgv = (node) => node.getText(entryFile).replace(/\s+/g, "") === "process.argv.slice(2)";
  contract(
    isProcessArgv(unwrap(objectValue(topOptions, "argv"))),
    "real CLI must pass process.argv.slice(2) into runQuorumSmokeMain",
  );
  const resolveBinding = namedImportBinding(entryFile, "node:path", "resolve", "quorum smoke entrypoint");
  const fileUrlBinding = namedImportBinding(entryFile, "node:url", "fileURLToPath", "quorum smoke entrypoint");
  const resolvedArgv = resolveBinding.localName + "(process.argv[1])";
  const currentModule = fileUrlBinding.localName + "(import.meta.url)";
  const directModuleGuard = (node) => node.getText(entryFile).replace(/\s+/g, "")
    === "process.argv[1]&&" + resolvedArgv + "===" + currentModule;
  const launchAwait = mainCall.parent;
  const launchStatement = launchAwait?.parent;
  const launchBlock = launchStatement?.parent;
  const launchGuard = launchBlock?.parent;
  contract(
    ts.isAwaitExpression(launchAwait)
      && launchAwait.expression === mainCall
      && ts.isExpressionStatement(launchStatement)
      && launchStatement.expression === launchAwait
      && ts.isBlock(launchBlock)
      && launchBlock.statements.length === 1
      && launchBlock.statements[0] === launchStatement
      && ts.isIfStatement(launchGuard)
      && launchGuard.thenStatement === launchBlock
      && !launchGuard.elseStatement
      && launchGuard.parent === entryFile
      && directModuleGuard(unwrap(launchGuard.expression)),
    "real CLI launch must be the sole awaited runQuorumSmokeMain call in a direct-module guard",
  );
  const staticInitializer = (node) => {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)
      || (typeof ts.isSatisfiesExpression === "function" && ts.isSatisfiesExpression(node))) {
      return staticInitializer(node.expression);
    }
    if (ts.isLiteralExpression(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)
      || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return true;
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.every((element) => ts.isOmittedExpression(element) || staticInitializer(element));
    }
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.every((property) => ts.isPropertyAssignment(property)
        && !ts.isComputedPropertyName(property.name) && staticInitializer(property.initializer));
    }
    return false;
  };
  const topSink = unwrap(objectValue(topOptions, "reportSink"));
  contract(
    (ts.isArrowFunction(topSink) || ts.isFunctionExpression(topSink))
      && staticInitializer(objectValue(topOptions, "context")),
    "real CLI reportSink must be inline code and context must be a static value",
  );
  const executableStatements = entryFile.statements.filter(
    (statement) => !(
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        || ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement)
        || ts.isTypeAliasDeclaration(statement) || (ts.isVariableStatement(statement)
          && statement.declarationList.flags === ts.NodeFlags.Const
          && [...statement.declarationList.declarations].every((declaration) => ts.isIdentifier(declaration.name)
            && declaration.initializer && (staticInitializer(declaration.initializer)
              || directModuleGuard(unwrap(declaration.initializer)))))
    ),
  );
  contract(
    executableStatements.length === 1 && executableStatements[0] === launchGuard,
    "direct-module runQuorumSmokeMain guard must be the entrypoint's only executable top-level statement",
  );

  const worker = readSource(workerSourcePath, "quorum smoke coordinator");
  const catalog = readSource(catalogSourcePath, "quorum smoke catalog");
  const caseModules = caseSourcePaths.slice(1).map((path) => readSource(path, "quorum smoke case module"));
  const runAccess = (node) => (
    (ts.isPropertyAccessExpression(node) && node.name.text === "run")
      || (ts.isElementAccessExpression(node)
        && ts.isStringLiteralLike(node.argumentExpression)
        && node.argumentExpression.text === "run")
  );
  const runDestructure = (node) => (
    ts.isObjectBindingPattern(node)
      && node.elements.some((element) => propertyName(element.propertyName ?? element.name) === "run")
  );
  for (const source of [{ file: entryFile, text: entryFile.getFullText() }, worker, ...caseModules]) {
    contract(
      collect(source.file, runAccess).length === 0 && collect(source.file, runDestructure).length === 0,
      relative(repoRoot, source.file.fileName) + " accesses, detaches, or mutates registration.run outside the catalog",
    );
  }

  const forbiddenImports = collect(entryFile, (node) => {
    if (
      !ts.isImportSpecifier(node)
      || node.isTypeOnly
      || (ts.isImportClause(node.parent.parent) && node.parent.parent.isTypeOnly)
    ) return false;
    const imported = node.propertyName?.text ?? node.name.text;
    return /(?:execute|worker.*plan|report|verdict|callback.*trace|run.*schema)/i.test(imported)
      && imported !== "runQuorumSmokeCoordinator";
  });
  const forbiddenShapes = collect(entryFile, (node) => {
    if (!ts.isObjectLiteralExpression(node)) return false;
    const keys = new Set(node.properties.map((property) => propertyName(property.name)));
    return keys.has("results")
      || ((keys.has("caseId") || keys.has("id")) && keys.has("status") && keys.has("attempts"))
      || (keys.has("schema") && keys.has("phase") && (keys.has("caseId") || keys.has("id")));
  });
  contract(
    forbiddenImports.length === 0
      && forbiddenShapes.length === 0
      && !entryFile.getFullText().includes("runQuorumSmokeWorkerPlan"),
    "entrypoint imports or constructs an alternate execution/report path",
  );

  const executorBinding = namedImportBinding(
    worker.file,
    "./quorum-submit-smoke-case-catalog.js",
    "executeQuorumSmokeCase",
    "quorum smoke coordinator",
  );
  const workerCoordinators = functionsNamed(worker.file, "runQuorumSmokeCoordinator");
  contract(workerCoordinators.length === 1, "worker module must define one runQuorumSmokeCoordinator");
  const workerCoordinator = workerCoordinators[0];
  contract(ts.isBlock(workerCoordinator.body), "runQuorumSmokeCoordinator must have an inspectable body");
  const executorCalls = collect(worker.file, (node) => (
    ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === executorBinding.localName
  ));
  const callsInsideCoordinator = collect(workerCoordinator.body, (node) => executorCalls.includes(node));
  contract(
    executorCalls.length > 0 && callsInsideCoordinator.length === executorCalls.length,
    "runQuorumSmokeCoordinator must be the sole caller of executeQuorumSmokeCase",
  );

  const executors = functionsNamed(catalog.file, "executeQuorumSmokeCase");
  contract(executors.length === 1 && ts.isBlock(executors[0].body), "catalog must define one executeQuorumSmokeCase");
  const catalogRunAccesses = collect(catalog.file, runAccess);
  const catalogRunDestructures = collect(catalog.file, runDestructure);
  const uniqueRun = catalogRunAccesses[0];
  const insideExecutor = (node) => {
    for (let current = node; current; current = current.parent) {
      if (current === executors[0].body) return true;
    }
    return false;
  };
  contract(
    catalogRunAccesses.length === 1
      && catalogRunDestructures.length === 0
      && ts.isCallExpression(uniqueRun?.parent)
      && uniqueRun.parent.expression === uniqueRun
      && insideExecutor(uniqueRun),
    "executeQuorumSmokeCase must uniquely own the direct registration.run invocation",
  );

  const literals = (file, value) => collect(file, (node) => (
    ts.isStringLiteralLike(node) && node.text === value
  )).length;
  const callbackSchema = "proof-or-stop.quorum-smoke-callback-trace.v1";
  const runSchema = "proof-or-stop.quorum-smoke-run.v1";
  contract(
    literals(catalog.file, callbackSchema) === 1
      && [entryFile, worker.file, ...caseModules.map((source) => source.file)]
        .every((file) => literals(file, callbackSchema) === 0),
    "catalog executor must be the unique callback-trace schema owner",
  );
  contract(
    literals(worker.file, runSchema) === 1
      && [entryFile, catalog.file, ...caseModules.map((source) => source.file)]
        .every((file) => literals(file, runSchema) === 0)
      && !worker.text.includes("runQuorumSmokeWorkerPlan"),
    "real coordinator must uniquely own the run schema without a bypass worker-plan API",
  );
}
function manifestRows(manifest) {
  contract(
    manifest && !Array.isArray(manifest) && Array.isArray(manifest.cases),
    "canonical inventory must be an object with a cases array",
  );
  contract(
    manifest.schemaVersion === "proof-or-stop.quorum-submit-smoke-cases.v1",
    "canonical inventory must declare schemaVersion proof-or-stop.quorum-submit-smoke-cases.v1",
  );
  return manifest.cases;
}

function exactCaseMarkers(output) {
  return output.match(/^CASE_PASS qsm-\d{3}$/gm) ?? [];
}

function assertInvalidSelection(execution, label, errorPattern) {
  contract(execution.processGroupReaped, label + " did not reap its process group");
  contract(execution.orphanedDescendants === false, label + " left descendants after its direct child exited");
  contract(!execution.timedOut, label + " timed out instead of refusing before case execution");
  contract(execution.status !== 0, label + " exited zero; selector must fail closed");
  contract(errorPattern.test(execution.output), label + " did not emit the required diagnostic: " + json(execution.output));
  contract(!/passed \(0 checks\)/i.test(execution.output), label + " emitted the forbidden zero-check PASS");
  contract(!/quorum_submit smoke passed/i.test(execution.output), label + " emitted an aggregate PASS");
  contract(exactCaseMarkers(execution.output).length === 0, label + " executed a case while refusing selection");
}

function parseExecutableCases(output) {
  const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith("QUORUM_SMOKE_CASES_JSON "));
  contract(Boolean(line), "--list-cases=json did not emit QUORUM_SMOKE_CASES_JSON");
  try {
    const rows = JSON.parse(line.slice("QUORUM_SMOKE_CASES_JSON ".length));
    contract(Array.isArray(rows), "--list-cases=json payload must be an array");
    return rows;
  } catch (error) {
    if (error instanceof ContractFailure) throw error;
    throw new ContractFailure("--list-cases=json emitted invalid JSON: " + error.message);
  }
}

function parseRunReport(output, label) {
  const lines = output.split(/\r?\n/)
    .filter((candidate) => candidate.startsWith("QUORUM_SMOKE_RUN_JSON "));
  contract(lines.length === 1, label + " must emit exactly one QUORUM_SMOKE_RUN_JSON report");
  try {
    const report = JSON.parse(lines[0].slice("QUORUM_SMOKE_RUN_JSON ".length));
    contract(report && typeof report === "object", label + " run report must be an object");
    return report;
  } catch (error) {
    if (error instanceof ContractFailure) throw error;
    throw new ContractFailure(label + " emitted invalid run-report JSON: " + error.message);
  }
}

function assertReportResidue(report, label) {
  contract(report.residue && typeof report.residue === "object", label + " omitted residue accounting");
  for (const kind of ["temp", "process", "ticket", "quarantine"]) {
    contract(Number(report.residue[kind]) === 0, label + " left " + kind + " residue: " + json(report.residue));
  }
}

function assertRealCliRun(execution, expectedIds, label, expectedSentinels, callbackNonce) {
  contract(execution.processGroupReaped, label + " did not reap its process group");
  contract(execution.orphanedDescendants === false, label + " left descendants after completion");
  contract(!execution.timedOut, label + " timed out");
  contract(execution.status === 0, label + " failed: " + execution.output);
  const report = parseRunReport(execution.output, label);
  contract(
    report.schema === "proof-or-stop.quorum-smoke-run.v1"
      && typeof report.runId === "string"
      && report.runId.length > 0
      && report.status === "PASS"
      && Number.isInteger(report.jobs)
      && report.jobs >= 1
      && Number.isInteger(report.parentPid)
      && report.parentPid > 0
      && report.parentPid === execution.pid
      && report.callbackTraceNonce === callbackNonce,
    label + " omitted the versioned terminal run identity/status/jobs/parentPid contract",
  );
  contract(report.executionKind === "real-case-bodies", label + " did not execute real case bodies");
  contract(Array.isArray(report.results), label + " omitted the terminal results array");
  const resultIds = (report.results ?? []).map(resultCaseId).sort();
  const sortedExpected = [...expectedIds].sort();
  const manifestById = new Map(
    manifestRows(readJsonTarget(manifestPath, label + " runtime inventory"))
      .map((row) => [row.id, row]),
  );
  contract(
    json(resultIds) === json(sortedExpected),
    label + " report ID set diverged; expected=" + json(sortedExpected) + " actual=" + json(resultIds),
  );
  contract(
    report.results.every((row) => {
      const expected = EXPECTED_CASES.find((candidate) => candidate.id === resultCaseId(row));
      return row.status === "PASS"
        && Number(row.attempts) === 1
        && Number.isInteger(row.workerPid)
        && row.workerPid > 0
        && row.workerPid !== report.parentPid
        && Number.isFinite(Number(row.startedAtMs))
        && Number.isFinite(Number(row.endedAtMs))
        && Number(row.endedAtMs) >= Number(row.startedAtMs)
        && row.callbackTraceNonce === callbackNonce
        && row.marker === "CASE_PASS " + resultCaseId(row)
        && row.title === expected?.title
        && row.domain === expected?.domain
        && row.shard === manifestById.get(resultCaseId(row))?.shard;
    }),
    label + " changed a verdict or retried a case: " + json(report.results),
  );
  const markerIds = exactCaseMarkers(execution.output)
    .map((marker) => marker.slice("CASE_PASS ".length))
    .sort();
  contract(
    json(markerIds) === json(sortedExpected),
    label + " CASE_PASS set diverged; expected=" + json(sortedExpected) + " actual=" + json(markerIds),
  );
  for (const id of expectedSentinels) {
    contract(
      execution.output.includes("REAL_SENTINEL " + id),
      label + " did not emit the real sentinel marker for " + id,
    );
  }
  assertReportResidue(report, label);
  return report;
}

function parseOwnedJsonLines(record, label) {
  const raw = readHarnessOwnedFile(record, label + " trace file", "utf8");
  const rows = raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new ContractFailure(
        label + " trace line " + (index + 1) + " is invalid JSON: " + error.message,
      );
    }
  });
  return { raw, rows };
}

function assertCallbackTrace(trace, expectedIds, report, nonce, label) {
  const sortedExpected = [...expectedIds].sort();
  contract(
    trace.rows.length === sortedExpected.length * 2,
    label + " callback trace must contain one start and one end per real callback",
  );
  contract(
    report.callbackTraceDigest
      === createHash("sha256").update(trace.raw).digest("hex"),
    label + " report is not digest-bound to the callback trace bytes",
  );
  const tracedIds = [...new Set(trace.rows.map((row) => String(row.caseId ?? "")))].sort();
  contract(
    json(tracedIds) === json(sortedExpected),
    label + " callback trace ID set diverged from report/CASE_PASS IDs",
  );
  for (const id of sortedExpected) {
    const events = trace.rows.filter((row) => row.caseId === id);
    const starts = events.filter((row) => row.phase === "start");
    const ends = events.filter((row) => row.phase === "end");
    contract(
      starts.length === 1 && ends.length === 1,
      label + " callback " + id + " did not emit exactly one start and one end",
    );
    const start = starts[0];
    const end = ends[0];
    const result = report.results.find((row) => resultCaseId(row) === id);
    contract(
      events.every((row) => (
        row.schema === "proof-or-stop.quorum-smoke-callback-trace.v1"
          && row.nonce === nonce
          && row.runId === report.runId
          && Number.isInteger(row.pid)
          && Number.isFinite(Number(row.atMs))
      )),
      label + " callback " + id + " trace omitted schema/nonce/runId/pid/time binding",
    );
    contract(
      start.pid === end.pid
        && start.pid === result?.workerPid
        && trace.rows.indexOf(start) < trace.rows.indexOf(end)
        && Number(result?.startedAtMs) <= Number(start.atMs)
        && Number(start.atMs) <= Number(end.atMs)
        && Number(end.atMs) <= Number(result?.endedAtMs)
        && end.status === "PASS"
        && end.marker === "CASE_PASS " + id
        && result?.marker === end.marker,
      label + " callback " + id + " trace disagrees with its worker verdict timeline",
    );
  }
}

async function runPositiveRealCli(args, expectedIds, label, options = {}) {
  const traceOwner = createHarnessOwnedBase("b-e40f-callback-trace-");
  const traceFile = createHarnessOwnedFile(traceOwner, "callbacks.jsonl", label + " callback");
  const nonce = randomUUID();
  try {
    const execution = await smoke(args, options.timeoutMs ?? 90_000, {
      env: {
        ...(options.env ?? {}),
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE: traceFile.realpath,
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE: nonce,
      },
    });
    const report = assertRealCliRun(
      execution,
      expectedIds,
      label,
      options.expectedSentinels ?? [],
      nonce,
    );
    const callbackTrace = parseOwnedJsonLines(traceFile, label + " callback");
    assertCallbackTrace(callbackTrace, expectedIds, report, nonce, label);
    return { execution, report, callbackTrace, callbackNonce: nonce };
  } finally {
    cleanupHarnessOwnedBase(traceOwner, label + " callback trace base");
  }
}

async function runNoCallbackCli(args, label, timeoutMs = 15_000) {
  const owner = createHarnessOwnedBase("b-e40f-zero-callback-");
  const traceFile = createHarnessOwnedFile(owner, "callbacks.jsonl", label + " zero-callback");
  try {
    const execution = await smoke(args, timeoutMs, {
      env: {
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE: traceFile.realpath,
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE: randomUUID(),
      },
    });
    contract(
      parseOwnedJsonLines(traceFile, label + " zero-callback").rows.length === 0,
      label + " executed or forged a callback while selection/listing should be side-effect-free",
    );
    return execution;
  } finally {
    cleanupHarnessOwnedBase(owner, label + " zero-callback base");
  }
}

async function proveCatalogCallbackExecutor(catalog) {
  contract(
    typeof catalog.executeQuorumSmokeCase === "function",
    "catalog must export executeQuorumSmokeCase for behavioral callback/trace verification",
  );
  const owner = createHarnessOwnedBase("b-e40f-catalog-executor-");
  const traceFile = createHarnessOwnedFile(owner, "callbacks.jsonl", "catalog executor callback trace");
  const witnessFile = createHarnessOwnedFile(owner, "callback-witness.jsonl", "catalog executor witness");
  const nonce = randomUUID();
  const runId = "b-e40f-catalog-" + randomUUID();
  try {
    let calls = 0;
    const result = await catalog.executeQuorumSmokeCase({
      registration: {
        id: "b-e40f-callback-probe",
        title: "B-e40f behavioral callback probe",
        domain: "pure",
        shard: "probe",
        run: async () => {
          calls += 1;
          writeHarnessOwnedFile(
            witnessFile,
            "catalog executor callback witness",
            json({ nonce, runId, pid: process.pid, atMs: Date.now() }) + "\n",
            true,
          );
        },
      },
      context: {},
      runId,
      callbackTrace: { file: traceFile.realpath, nonce },
    });
    contract(calls === 1, "catalog executor did not invoke the supplied callback exactly once");
    const witness = parseOwnedJsonLines(witnessFile, "catalog executor witness").rows;
    const trace = parseOwnedJsonLines(traceFile, "catalog executor callback").rows;
    contract(witness.length === 1 && trace.length === 2, "catalog executor omitted callback witness events");
    const start = trace.find((row) => row.phase === "start");
    const end = trace.find((row) => row.phase === "end");
    contract(
      start?.schema === "proof-or-stop.quorum-smoke-callback-trace.v1"
        && end?.schema === "proof-or-stop.quorum-smoke-callback-trace.v1"
        && start.nonce === nonce
        && end.nonce === nonce
        && start.runId === runId
        && end.runId === runId
        && start.caseId === "b-e40f-callback-probe"
        && end.caseId === "b-e40f-callback-probe"
        && start.pid === process.pid
        && end.pid === process.pid
        && start.atMs <= witness[0].atMs
        && witness[0].atMs <= end.atMs
        && end.status === "PASS"
        && result?.status === "PASS",
      "catalog trace does not surround the actual callback invocation",
    );
  } finally {
    cleanupHarnessOwnedBase(owner, "catalog executor probe base");
  }
}

async function listedExecutableCases() {
  const execution = await runNoCallbackCli(["--list-cases=json"], "--list-cases=json");
  contract(execution.processGroupReaped, "--list-cases=json did not reap its process group");
  contract(execution.orphanedDescendants === false, "--list-cases=json left descendant processes");
  contract(!execution.timedOut, "--list-cases=json timed out; listing must not execute case bodies");
  contract(execution.status === 0, "--list-cases=json failed: " + execution.output);
  contract(!/✓ /.test(execution.output), "--list-cases=json executed a case body");
  return parseExecutableCases(execution.output);
}

async function expectRejected(action, pattern, label) {
  let failure = null;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  contract(Boolean(failure), label + " was silently accepted");
  contract(pattern.test(String(failure?.message ?? failure)), label + " rejection did not name the defect: " + String(failure));
}

function validateSelectorTimeoutBudget({ caseTimeoutMs, workerEnvelopeMs, cleanupAllowanceMs, outerTimeoutMs }) {
  for (const [label, value] of Object.entries({
    caseTimeoutMs, workerEnvelopeMs, cleanupAllowanceMs, outerTimeoutMs,
  })) {
    contract(Number.isSafeInteger(value) && value > 0, `selector ${label} must be a positive integer`);
  }
  const requiredOuterMs = caseTimeoutMs + workerEnvelopeMs + cleanupAllowanceMs;
  contract(
    outerTimeoutMs >= requiredOuterMs,
    `selector outer timeout ${outerTimeoutMs}ms cannot observe the worker timeout and cleanup; required>=${requiredOuterMs}ms`,
  );
  return { requiredOuterMs, outerTimeoutMs };
}

async function selectorContract() {
  const failures = [];
  const smokeModule = await loadBuiltTarget(
    smokeSourcePath,
    smokeDistPath,
    "selector default-timeout contract",
  );
  contract(
    smokeModule.DEFAULT_QUORUM_SMOKE_CASE_TIMEOUT_MS === SELECTOR_CASE_TIMEOUT_MS,
    "real CLI default case timeout drifted from the measured exact-selector workload budget",
  );
  const timeoutBudget = validateSelectorTimeoutBudget({
    caseTimeoutMs: SELECTOR_CASE_TIMEOUT_MS,
    workerEnvelopeMs: SELECTOR_WORKER_ENVELOPE_MS,
    cleanupAllowanceMs: SELECTOR_CLEANUP_ALLOWANCE_MS,
    outerTimeoutMs: SELECTOR_OUTER_TIMEOUT_MS,
  });
  await expectRejected(
    () => validateSelectorTimeoutBudget({
      caseTimeoutMs: SELECTOR_CASE_TIMEOUT_MS,
      workerEnvelopeMs: SELECTOR_WORKER_ENVELOPE_MS,
      cleanupAllowanceMs: SELECTOR_CLEANUP_ALLOWANCE_MS,
      outerTimeoutMs: SELECTOR_CASE_TIMEOUT_MS,
    }),
    /cannot observe the worker timeout and cleanup/,
    "equal inner/outer selector timeout budget",
  );
  contract(
    timeoutBudget.outerTimeoutMs - timeoutBudget.requiredOuterMs >= 0,
    "selector timeout budget lost its cleanup allowance",
  );
  const source = readFileSync(smokeSourcePath, "utf8");
  const hasExactCapability = source.includes("--case=") && source.includes("--list-cases=json");
  const observeInvalid = async (args, label, pattern) => {
    try {
      assertInvalidSelection(await runNoCallbackCli(args, label), label, pattern);
    } catch (error) {
      if (error instanceof BootstrapFailure) throw error;
      failures.push(error.message);
    }
  };

  if (!hasExactCapability) {
    // On the unchanged baseline, --grep="" is a substring match for every
    // title and starts the whole suite. Preserve a fast RED until the new pure
    // resolver and its entrypoint wiring can be inspected.
    failures.push("empty --grep still uses legacy substring selection and would match all 73 cases");
    await observeInvalid(
      ["--grep=definitely-no-such-quorum-check"],
      "unmatched --grep",
      /ERROR: unknown quorum smoke selector definitely-no-such-quorum-check; zero cases executed/i,
    );
    await observeInvalid(
      ["--grep=shared derivation"],
      "ambiguous --grep",
      /ERROR: ambiguous quorum smoke selector shared derivation; matches=3; zero cases executed/i,
    );
    failures.push("stable exact --case and side-effect-free --list-cases=json selection are absent");
  } else {
    const catalog = await loadBuiltTarget(
      catalogSourcePath,
      catalogDistPath,
      "selector-contract",
    );
    contract(
      typeof catalog.resolveQuorumSmokeSelection === "function",
      "catalog must export the pure resolveQuorumSmokeSelection preflight",
    );
    assertEntrypointCaseModuleWiring();
    const registrations = await loadBuiltCallbackRegistrations();
    const resolveSelection = (argv) => catalog.resolveQuorumSmokeSelection({
      argv,
      cases: registrations,
    });
    await expectRejected(
      () => resolveSelection(["--grep="]),
      /empty.*zero cases executed/i,
      "pure empty --grep preflight",
    );
    await expectRejected(
      () => resolveSelection(["--grep=definitely-no-such-quorum-check"]),
      /unknown.*definitely-no-such-quorum-check.*zero cases executed/i,
      "pure unmatched --grep preflight",
    );
    await expectRejected(
      () => resolveSelection(["--grep=shared derivation"]),
      /ambiguous.*shared derivation.*matches=3.*zero cases executed/i,
      "pure ambiguous --grep preflight",
    );
    const exact = await resolveSelection(["--case=qsm-022"]);
    contract(
      json(exact.selectedCaseIds) === json(["qsm-022"]),
      "pure selector did not resolve exact --case=qsm-022 to one identity",
    );
    const entrypoint = ts.createSourceFile(
      smokeSourcePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    let callsResolver = false;
    const visit = (node) => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "resolveQuorumSmokeSelection"
      ) {
        callsResolver = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(entrypoint);
    contract(callsResolver, "entrypoint does not call the inspected selection resolver");

    await observeInvalid(
      ["--grep="],
      "empty --grep",
      /ERROR: empty quorum smoke selector; zero cases executed/i,
    );
    await observeInvalid(
      ["--grep=definitely-no-such-quorum-check"],
      "unmatched --grep",
      /ERROR: unknown quorum smoke selector definitely-no-such-quorum-check; zero cases executed/i,
    );
    await observeInvalid(
      ["--grep=shared derivation"],
      "ambiguous --grep",
      /ERROR: ambiguous quorum smoke selector shared derivation; matches=3; zero cases executed/i,
    );
  }
  contract(
    failures.length === 0,
    "selector contract is not implemented:\n- " + failures.join("\n- "),
  );

  const listed = normalizeRows(await listedExecutableCases());
  contract(
    listed.some((row) => row.id === "qsm-022") && listed.some((row) => row.id === "qsm-023"),
    "case listing does not expose both formerly order-dependent identities qsm-022 and qsm-023",
  );

  assertInvalidSelection(
    await runNoCallbackCli(["--case=qsm-999"], "unknown exact --case"),
    "unknown exact --case",
    /ERROR: unknown quorum smoke selector qsm-999; zero cases executed/i,
  );

  // Both orders use a fresh OS process for each identity. qsm-023 historically
  // consumed the qsm-022 result variable and therefore failed in isolation.
  const reverse = ["qsm-023", "qsm-022"];
  const forward = [...reverse].reverse();
  for (const [label, order] of [["reverse", reverse], ["forward", forward]]) {
    for (const id of order) {
      await runPositiveRealCli(
        ["--case=" + id, `--case-timeout-ms=${SELECTOR_CASE_TIMEOUT_MS}`, "--report=json"],
        [id],
        label + " exact selection",
        { timeoutMs: SELECTOR_OUTER_TIMEOUT_MS },
      );
    }
  }

  const compatible = await runPositiveRealCli(
    ["--grep=shared derivation binds every replay-sensitive input", "--report=json"],
    ["qsm-012"],
    "single-match compatibility --grep",
  );
  contract(
    /DEPRECATED: --grep; use --case=qsm-012/.test(compatible.execution.output),
    "single-match --grep must emit an exact migration warning naming --case=qsm-012",
  );

  console.log("SELECTOR_PASS exact=1 unknown=closed ambiguous=closed order=independent");
}

async function inventoryBijection() {
  const manifest = readJsonTarget(manifestPath, "inventory-bijection");
  const rows = manifestRows(manifest);
  const actual = normalizeRows(rows);
  const expected = normalizeRows(EXPECTED_CASES);
  contract(
    json(actual) === json(expected),
    "frozen 73-case identity/title/domain inventory drifted; expected="
      + json(expected) + " actual=" + json(actual),
  );
  contract(new Set(actual.map((row) => row.id)).size === 73, "inventory identities are not 73 unique stable IDs");

  contract(
    rows.every((row) => row.callbackBound === undefined && row.registrationSource === undefined),
    "manifest must remain declarative; executable callback provenance cannot be copied into it",
  );
  const scanned = scanExecutableRegistrations();
  assertTrivialCallbackDetector();
  // This immutable pre-refactor comparison is deliberately opt-in: it is a
  // one-time migration witness, not a dependency of the long-lived inventory
  // gate (which must also work in shallow clones). Story evidence runs this
  // selector once with PROOF_OR_STOP_B_E40F_MIGRATION_WITNESS=1.
  if (process.env.PROOF_OR_STOP_B_E40F_MIGRATION_WITNESS === "1") {
    assertOriginalCallbackCoverage(scanned);
    console.log("MIGRATION_WITNESS_PASS baseline=" + ORIGINAL_SMOKE_COMMIT + " callbacks=73 exact>=66");
  }
  const registrations = scanned.map(({ callbackNode: _callbackNode, ...row }) => row);
  contract(
    registrations.length === 73 && new Set(registrations.map((row) => row.id)).size === 73,
    "AST scan did not find 73 unique real defineQuorumSmokeCase callbacks; found="
      + registrations.length,
  );
  contract(
    json(normalizeRows(registrations)) === json(expected),
    "AST-scanned executable callbacks do not match the frozen identities/titles/domains",
  );
  contract(
    json(normalizeRegistrationRows(registrations))
      === json(normalizeRegistrationRows(rows)),
    "AST-scanned callback id/title/domain/shard rows do not exactly match the manifest",
  );
  const runMain = await loadSmokeMainContract("inventory-bijection thin entrypoint");
  await proveThinEntrypointFlow(runMain);
  const builtRegistrations = await loadBuiltCallbackRegistrations();
  contract(
    builtRegistrations.length === 73
      && builtRegistrations.every((row) => typeof row.run === "function"),
    "built executable registry does not expose 73 callable case bodies",
  );
  contract(
    json(normalizeRegistrationRows(builtRegistrations))
      === json(normalizeRegistrationRows(registrations)),
    "built callable registrations diverge from the AST-scanned source registrations",
  );

  const executableCases = await listedExecutableCases();
  assertRuntimeRowsAreCallbackBound(executableCases, builtRegistrations);
  const executable = normalizeRows(executableCases);
  contract(
    json(executable) === json(expected),
    "registered executable cases are not the exact frozen inventory; executable=" + json(executable),
  );
  contract(
    json(normalizeRegistrationRows(executableCases))
      === json(normalizeRegistrationRows(builtRegistrations)),
    "runtime --list callback registrations diverge from the directly imported callable registrations",
  );

  // The DYN-5 registry remains a four-sentinel compatibility surface. It must
  // not be inflated into a second 73-row source of truth.
  const dynRegistry = readJsonTarget(dynRegistryPath, "DYN-5 compatibility registry");
  contract(Array.isArray(dynRegistry), "DYN-5 compatibility registry must remain an array");
  const dynQuorumIds = dynRegistry
    .filter((row) => row.domain === "quorum")
    .map((row) => row.caseId)
    .sort();
  contract(
    json(dynQuorumIds) === json([
      "quorum:scenario-1",
      "quorum:scenario-2",
      "quorum:scenario-3",
      "quorum:scenario-4",
    ]),
    "the four DYN-5 quorum sentinels changed or were used as the internal inventory: " + json(dynQuorumIds),
  );
  const validationConfig = readJsonTarget(configPath, "inventory validation registration");
  const harnessRows = (validationConfig?.validate?.commands ?? []).filter((command) => (
    command.command === "node"
      && Array.isArray(command.args)
      && command.args.includes("packages/main/tests/red/red-B-e40f-quorum-submit-harness.mjs")
  ));
  contract(
    harnessRows.length === 1
      && harnessRows[0].args.includes("--case=inventory-bijection")
      && harnessRows[0].env?.PROOF_OR_STOP_B_E40F_MIGRATION_WITNESS !== "1"
      && !harnessRows[0].args.some((arg) => /(?:partition|fixture|resource)-.*contract/.test(arg)),
    "validate must register only the fast inventory selector; heavy selectors remain Story evidence/benchmarks",
  );

  const catalog = await loadBuiltTarget(
    catalogSourcePath,
    catalogDistPath,
    "inventory-bijection",
  );
  contract(
    typeof catalog.validateQuorumSmokeInventory === "function",
    "catalog module must export validateQuorumSmokeInventory",
  );
  await proveCatalogCallbackExecutor(catalog);
  const validate = (manifestCases, executableRows) => catalog.validateQuorumSmokeInventory({
    manifestCases,
    executableCases: executableRows,
  });
  await validate(rows, builtRegistrations);

  const duplicateQsm001 = builtRegistrations.find((row) => row.id === "qsm-001");
  contract(Boolean(duplicateQsm001), "duplicate mutation target qsm-001 is absent");
  await expectRejected(
    () => validate(rows, [...builtRegistrations, { ...duplicateQsm001 }]),
    /duplicate.*qsm-001|qsm-001.*duplicate/i,
    "duplicate real registration mutation",
  );
  await expectRejected(
    () => validate(rows, builtRegistrations.filter((row) => row.id !== "qsm-073")),
    /missing.*qsm-073|qsm-073.*missing/i,
    "deleted real registration mutation",
  );
  await expectRejected(
    () => validate(rows, [...builtRegistrations, {
      id: "qsm-999",
      title: "invented extra case",
      domain: "integration",
      shard: rows.find((row) => row.domain === "integration")?.shard,
      callbackBound: true,
      registrationSource: relative(repoRoot, smokeSourcePath),
    }]),
    /extra.*qsm-999|qsm-999.*extra/i,
    "extra real registration mutation",
  );
  await expectRejected(
    () => validate(rows, builtRegistrations.map((row) => (
      (row.id ?? row.caseId) === "qsm-073"
        ? { ...row, id: "qsm-unresolved", caseId: "qsm-unresolved" }
        : row
    ))),
    /unresolved.*qsm-unresolved|qsm-unresolved.*unresolved|missing.*qsm-073/i,
    "unresolved executable mutation",
  );

  // Count-only guards miss this: both sides still contain 73 mutually resolving
  // rows, but one frozen identity has been silently replaced.
  const replace = (row) => (
    (row.id ?? row.caseId) === "qsm-073"
      ? {
          ...row,
          id: "qsm-999",
          caseId: "qsm-999",
          title: "same-count replacement",
          name: "same-count replacement",
        }
      : row
  );
  await expectRejected(
    () => validate(rows.map(replace), builtRegistrations.map(replace)),
    /qsm-073|qsm-999|frozen|replacement/i,
    "same-count replacement mutation",
  );
  await expectRejected(
    () => validate(rows.filter((row) => row.id !== "qsm-001"), builtRegistrations),
    /missing.*qsm-001|qsm-001.*missing|extra.*qsm-001/i,
    "missing manifest mutation",
  );

  console.log("INVENTORY_PASS 73/73 unique cases");
}

function countDomains(rows) {
  return Object.fromEntries(["pure", "integration", "prune"].map((domain) => [
    domain,
    rows.filter((row) => row.domain === domain).length,
  ]));
}

async function partitionContract() {
  const manifest = readJsonTarget(manifestPath, "partition-contract");
  const rows = manifestRows(manifest);
  const counts = countDomains(rows);
  contract(
    counts.pure === 6 && counts.integration === 46 && counts.prune === 21,
    "partition counts must be pure=6 integration=46 prune=21; actual=" + json(counts),
  );

  const expectedDomains = new Map(EXPECTED_CASES.map((row) => [row.id, row.domain]));
  for (const row of rows) {
    contract(
      expectedDomains.get(row.id) === row.domain,
      "case " + row.id + " is routed to " + row.domain + " instead of " + expectedDomains.get(row.id),
    );
    contract(
      typeof row.shard === "string" && row.shard.trim().length > 0,
      "case " + row.id + " has no explicit shard",
    );
    contract(Array.isArray(row.capabilities), "case " + row.id + " has no observed capabilities array");
  }

  const requiredCapabilityWitnesses = new Map([
    ["qsm-001", "lock"],
    ["qsm-006", "cli"],
    ["qsm-008", "environment"],
    ["qsm-013", "git"],
    ["qsm-014", "signature"],
    ["qsm-039", "concurrency"],
    ["qsm-046", "large-file"],
  ]);
  for (const [id, capability] of requiredCapabilityWitnesses) {
    const row = rows.find((candidate) => candidate.id === id);
    contract(
      row?.domain === "integration" && row.capabilities.includes(capability),
      id + " must witness integration capability " + capability,
    );
  }
  const integrationCapabilities = new Set([
    "git", "cli", "lock", "concurrency", "environment", "signature", "large-file",
  ]);
  for (const row of rows.filter((candidate) => candidate.domain === "pure")) {
    contract(
      row.capabilities.every((capability) => !integrationCapabilities.has(capability)),
      "pure case " + row.id + " carries an integration capability: " + json(row.capabilities),
    );
  }

  const shardIds = [...new Set(rows.map((row) => row.shard))].sort();
  contract(
    shardIds.length >= 3 && shardIds.length <= 4,
    "canonical inventory must form three or four shards; actual=" + json(shardIds),
  );
  const sentinels = shardIds.map((shard) => rows.find(
    (row) => row.shard === shard && row.sentinel === "real",
  ));
  contract(
    sentinels.every(Boolean),
    "every shard must name a real case-body sentinel; shards=" + json(shardIds),
  );
  contract(
    new Set(sentinels.map((row) => row.domain)).size === 3,
    "real sentinels must cover pure, integration, and prune domains",
  );

  const catalog = await loadBuiltTarget(
    catalogSourcePath,
    catalogDistPath,
    "partition-contract",
  );
  contract(
    typeof catalog.validateQuorumSmokePartitions === "function",
    "catalog module must export validateQuorumSmokePartitions",
  );
  const validate = (cases) => catalog.validateQuorumSmokePartitions({ cases });
  await validate(rows);

  const removedShard = shardIds[0];
  await expectRejected(
    () => validate(rows.filter((row) => row.shard !== removedShard)),
    new RegExp("missing.*" + removedShard + "|" + removedShard + ".*missing", "i"),
    "deleted shard mutation",
  );
  await expectRejected(
    () => validate([...rows, { ...rows[0] }]),
    /duplicate.*qsm-001|qsm-001.*duplicate/i,
    "duplicate partition identity mutation",
  );
  await expectRejected(
    () => validate(rows.map((row) => (
      row.id === "qsm-002" ? { ...row, domain: "integration" } : row
    ))),
    /qsm-002.*(pure|integration)|(pure|integration).*qsm-002/i,
    "wrong-domain routing mutation",
  );
  const staticShard = shardIds[0];
  await expectRejected(
    () => validate(rows.map((row) => (
      row.shard === staticShard && row.sentinel === "real"
        ? { ...row, sentinel: "static-pass" }
        : row
    ))),
    new RegExp(staticShard + ".*(real|static)|(?:real|static).*" + staticShard, "i"),
    "static PASS sentinel mutation",
  );

  const before = gitStatus();
  const shardRuntimeIds = [];
  for (const shard of shardIds) {
    const expectedShardIds = rows
      .filter((row) => row.shard === shard)
      .map((row) => row.id);
    const expectedShardSentinels = sentinels
      .filter((row) => row.shard === shard)
      .map((row) => row.id);
    const { report } = await runPositiveRealCli(
      ["--shard=" + shard, "--report=json"],
      expectedShardIds,
      "real shard " + shard,
      { timeoutMs: 20 * 60_000, expectedSentinels: expectedShardSentinels },
    );
    contract(report.mode === "shard" && report.shardId === shard, "shard CLI report did not bind " + shard);
    shardRuntimeIds.push(...report.results.map(resultCaseId));
  }
  contract(
    json([...shardRuntimeIds].sort()) === json(EXPECTED_CASES.map((row) => row.id).sort()),
    "real shard execution union was not the canonical 73-case set",
  );

  await proveRealCoordinatorFaultSeam();

  contract(gitStatus() === before, "real shard sentinels left repository residue");

  console.log(
    "PARTITION_PASS shards=" + shardIds.length
    + " cases=73 missing=0 duplicate=0 residue=0",
  );
}

function fixtureGit(owner, root, args) {
  assertOwnedDirectory(owner, root, "fixture git root");
  assertOwnedTreeNoSymlinks(owner, root, "fixture tree before git " + args[0]);
  const configName = ".b-e40f-empty-gitconfig";
  let safeConfig = safeFixturePath(owner, root, configName, "fixture git config", {
    mustExist: false,
    directory: false,
  });
  if (!safeConfig.entry) {
    writeFixtureFile(owner, root, configName, "");
    safeConfig = safeFixturePath(owner, root, configName, "fixture git config", {
      mustExist: true,
      directory: false,
    });
  }
  contract(safeConfig.entry.isFile(), "fixture git config is not a regular file");
  const ensureSafeDirectory = (name, label) => {
    let inspected = safeFixturePath(owner, root, name, label, { mustExist: false, directory: true });
    if (!inspected.entry) {
      mkdirSync(inspected.normalized);
      inspected = assertOwnedDirectory(owner, inspected.normalized, label);
    }
    return inspected.normalized;
  };
  const safeTemplate = ensureSafeDirectory(".b-e40f-empty-git-template", "fixture git template");
  const safeHooks = ensureSafeDirectory(".b-e40f-disabled-hooks", "fixture git hooks");
  const gitMetadata = safeFixturePath(owner, root, ".git", "fixture git metadata", {
    mustExist: args[0] !== "init",
    directory: false,
  });
  if (gitMetadata.entry) {
    contract(gitMetadata.entry.isDirectory(), "fixture git metadata must be a local directory, never gitdir indirection");
  }
  const gitEnv = harnessChildEnvironment({
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: safeConfig.normalized,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: safeTemplate,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: safeHooks,
    GIT_AUTHOR_NAME: "B-e40f fixture contract",
    GIT_AUTHOR_EMAIL: "b-e40f@example.invalid",
    GIT_COMMITTER_NAME: "B-e40f fixture contract",
    GIT_COMMITTER_EMAIL: "b-e40f@example.invalid",
  });
  const output = execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: gitEnv,
  }).trim();
  const createdMetadata = safeFixturePath(owner, root, ".git", "fixture git metadata after command", {
    mustExist: true,
    directory: false,
  });
  contract(createdMetadata.entry.isDirectory(), "fixture git command created non-local .git indirection");
  assertOwnedTreeNoSymlinks(owner, root, "fixture tree after git " + args[0]);
  return output;
}

function buildSyntheticFixtureTemplate(owner, { profile, targetRoot }) {
  contract(
    profile && typeof profile.id === "string" && profile.inputs,
    "fixture pool did not pass the complete profile to buildTemplate",
  );
  contract(
    typeof targetRoot === "string" && targetRoot.length > 0,
    "fixture pool did not provide an isolated targetRoot to buildTemplate",
  );
  assertOwnedDirectory(owner, targetRoot, "fixture build targetRoot");
  writeFixtureFile(owner, targetRoot, "README.md", "immutable quorum fixture\n");
  writeFixtureFile(
    owner,
    targetRoot,
    "proof-or-stop.config.json",
    json({ profile: profile.inputs, workflow: { profile: "balanced" } }) + "\n",
  );
  writeFixtureFile(
    owner,
    targetRoot,
    ".proof-or-stop/story/actives/B-template/index.json",
    json({ storyId: "B-template", phase: "REVIEW", profile: profile.inputs }) + "\n",
  );
  writeFixtureFile(
    owner,
    targetRoot,
    ".proof-or-stop/story/actives/B-template/process-events.jsonl",
    json({ type: "seed", storyId: "B-template" }) + "\n",
  );
  writeFixtureFile(owner, targetRoot, ".proof-or-stop/cache/seed.txt", "cache-seed\n");
  writeFixtureFile(owner, targetRoot, ".proof-or-stop/locks/seed.txt", "lock-seed\n");
  writeFixtureFile(
    owner,
    targetRoot,
    "handler-probe.mjs",
    FIXTURE_HANDLER_PROBE_SOURCE,
  );
  fixtureGit(owner, targetRoot, ["init", "-b", "main"]);
  fixtureGit(owner, targetRoot, ["add", "."]);
  fixtureGit(owner, targetRoot, ["commit", "-m", "seed immutable template"]);
}

function fixtureSnapshot(owner, root, label) {
  assertOwnedDirectory(owner, root, label + " root");
  const handlerProbe = readFixtureFile(owner, root, "handler-probe.mjs", label + " handler source");
  contract(
    handlerProbe === FIXTURE_HANDLER_PROBE_SOURCE,
    label + " handler probe bytes diverged before safe literal execution",
  );
  const storyPath = safeFixturePath(
    owner,
    root,
    ".proof-or-stop/story/actives/B-template/index.json",
    label + " handler story input",
    { mustExist: true, directory: false },
  );
  contract(storyPath.entry.isFile(), label + " handler story input is not a regular file");
  const storyFd = openVerifiedFile(storyPath.normalized, storyPath.entry, fsConstants.O_RDONLY, label);
  let handler = null;
  try {
    const openedStory = fstatSync(storyFd);
    contract(
      openedStory.isFile()
        && openedStory.dev === storyPath.entry.dev
        && openedStory.ino === storyPath.entry.ino,
      label + " handler story input changed before no-follow open",
    );
    handler = spawnSync(process.execPath, ["-e", FIXTURE_HANDLER_PROBE_SOURCE], {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe", storyFd],
    });
  } finally {
    closeSync(storyFd);
  }
  contract(
    handler.status === 0 && /HANDLER_PASS B-template/.test(handler.stdout),
    "derived fixture handler behavior diverged: " + String(handler.stdout) + String(handler.stderr),
  );
  return {
    head: fixtureGit(owner, root, ["rev-parse", "HEAD"]),
    refs: fixtureGit(owner, root, ["show-ref", "--head"]),
    status: fixtureGit(owner, root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    readme: readFixtureFile(owner, root, "README.md", label + " README"),
    config: readFixtureFile(owner, root, "proof-or-stop.config.json", label + " config"),
    story: readFixtureFile(
      owner,
      root,
      ".proof-or-stop/story/actives/B-template/index.json",
      label + " story",
    ),
    events: readFixtureFile(
      owner,
      root,
      ".proof-or-stop/story/actives/B-template/process-events.jsonl",
      label + " events",
    ),
    cache: readFixtureFile(owner, root, ".proof-or-stop/cache/seed.txt", label + " cache"),
    lock: readFixtureFile(owner, root, ".proof-or-stop/locks/seed.txt", label + " lock"),
    handlerProbe,
  };
}

function assertEquivalentFixture(left, right, label) {
  contract(json(left) === json(right), label + " diverged: left=" + json(left) + " right=" + json(right));
}

async function proveActualFixtureWiring(manifest) {
  const rows = manifestRows(manifest);
  const consumers = rows.filter((row) => row.fixtureConsumer === true);
  contract(consumers.length >= 2, "manifest does not identify at least two real fixture-consuming cases");
  const byShard = new Map();
  for (const row of consumers) {
    if (!byShard.has(row.shard)) byShard.set(row.shard, []);
    byShard.get(row.shard).push(row);
  }
  const selected = [...byShard.entries()].find(([, shardRows]) => shardRows.length >= 2);
  contract(Boolean(selected), "no real shard contains at least two fixture-consuming cases");
  const [shard, shardConsumers] = selected;
  const expectedIds = rows.filter((row) => row.shard === shard).map((row) => row.id);
  const sentinels = rows.filter((row) => row.shard === shard && row.sentinel === "real").map((row) => row.id);
  const traceOwner = createHarnessOwnedBase("b-e40f-actual-fixture-trace-");
  const fixtureOwner = createHarnessOwnedBase("b-e40f-actual-fixture-owned-");
  const traceFile = createHarnessOwnedFile(traceOwner, "fixture-trace.jsonl", "actual fixture");
  try {
    const run = await runPositiveRealCli(
      ["--shard=" + shard, "--report=json"],
      expectedIds,
      "fixture-traced real shard " + shard,
      {
        timeoutMs: 20 * 60_000,
        expectedSentinels: sentinels,
        env: {
          PROOF_OR_STOP_QUORUM_SMOKE_FIXTURE_TRACE_FILE: traceFile.realpath,
          PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE: fixtureOwner.realpath,
        },
      },
    );
    const { report, callbackNonce } = run;
    const trace = parseOwnedJsonLines(traceFile, "actual fixture").rows;
    contract(trace.length > 0, "actual fixture runtime emitted no trace events");
    contract(
      trace.every((row) => (
        row.schema === "proof-or-stop.quorum-smoke-fixture-trace.v1"
          && row.nonce === callbackNonce
          && row.runId === report.runId
          && Number.isFinite(Number(row.atMs))
      )),
      "actual fixture trace is not bound to the callback nonce/runId/timeline",
    );
    const builds = trace.filter((row) => row.type === "template-build");
    const clones = trace.filter((row) => row.type === "fixture-clone");
    const cleanups = trace.filter((row) => row.type === "fixture-cleanup");
    const templateCleanups = trace.filter((row) => row.type === "template-cleanup");
    const executedConsumers = new Set(
      clones.map((row) => row.caseId).filter((id) => shardConsumers.some((item) => item.id === id)),
    );
    contract(executedConsumers.size >= 2, "real shard did not clone fixtures for two real case callbacks");
    contract(builds.length > 0 && builds.length < clones.length, "actual smoke rebuilt a template per clone");
    contract(
      Number(report.fixtureSummary?.builds) === builds.length
        && Number(report.fixtureSummary?.clones) === clones.length
        && report.fixtureSummary?.ownedTempBase === fixtureOwner.realpath,
      "run report fixture counters do not match the runtime trace",
    );
    const cloneRoots = new Set();
    const profileTemplates = new Map();
    const normalizedBuilds = builds.map((row) => ({
      row,
      template: assertOwnedPath(fixtureOwner, row.templateRoot, "built templateRoot", {
        mustExist: false,
        directory: true,
      }).normalized,
    }));
    const normalizedClones = [];
    for (const row of clones) {
      contract(
        typeof row.caseId === "string" && typeof row.profileId === "string",
        "fixture clone trace omitted caseId/profileId",
      );
      const callbackStart = run.callbackTrace.rows.find(
        (event) => event.caseId === row.caseId && event.phase === "start",
      );
      const callbackEnd = run.callbackTrace.rows.find(
        (event) => event.caseId === row.caseId && event.phase === "end",
      );
      contract(
        expectedIds.includes(row.caseId)
          && row.pid === callbackStart?.pid
          && row.pid === callbackEnd?.pid
          && Number(callbackStart?.atMs) <= Number(row.atMs)
          && Number(row.atMs) <= Number(callbackEnd?.atMs),
        "fixture event is not linked to an actually invoked callback: " + row.caseId,
      );
      const template = assertOwnedPath(
        fixtureOwner,
        row.templateRoot,
        "actual fixture templateRoot",
        { mustExist: false, directory: true },
      );
      const clone = assertOwnedPath(
        fixtureOwner,
        row.cloneRoot,
        "actual fixture cloneRoot",
        { mustExist: false, directory: true },
      );
      contract(template.normalized !== clone.normalized, "actual case received the template as mutable state");
      contract(!cloneRoots.has(clone.normalized), "two actual cases shared one mutable cloneRoot");
      cloneRoots.add(clone.normalized);
      const previous = profileTemplates.get(row.profileId);
      contract(!previous || previous === template.normalized, "one profileId resolved to multiple template roots");
      profileTemplates.set(row.profileId, template.normalized);
      const matchingBuilds = normalizedBuilds.filter((build) => (
        build.row.profileId === row.profileId
          && build.template === template.normalized
          && Number(build.row.atMs) <= Number(row.atMs)
      ));
      contract(
        matchingBuilds.length === 1,
        "fixture clone lacks one earlier matching profile/template build: " + json(row),
      );
      normalizedClones.push({ row, clone: clone.normalized });
    }
    const normalizedCleanups = cleanups.map((row) => ({
      row,
      clone: assertOwnedPath(fixtureOwner, row.cloneRoot, "fixture cleanup cloneRoot", {
        mustExist: false,
        directory: true,
      }).normalized,
    }));
    contract(
      normalizedCleanups.length === normalizedClones.length
        && new Set(normalizedCleanups.map((item) => item.clone)).size === normalizedClones.length
        && normalizedClones.every((clone) => normalizedCleanups.filter((cleanup) => (
          cleanup.clone === clone.clone
            && cleanup.row.caseId === clone.row.caseId
            && cleanup.row.pid === clone.row.pid
            && Number(cleanup.row.atMs) >= Number(clone.row.atMs)
        )).length === 1),
      "actual fixture cleanup events do not cover every clone exactly once",
    );
    for (const root of cloneRoots) {
      assertOwnedPathAbsent(fixtureOwner, root, "actual derived fixture");
    }
    const templateRoots = new Set(builds.map((row) => (
      assertOwnedPath(fixtureOwner, row.templateRoot, "built templateRoot", {
        mustExist: false,
        directory: true,
      }).normalized
    )));
    const cleanedTemplateRoots = templateCleanups.map((row) => (
      assertOwnedPath(fixtureOwner, row.templateRoot, "template cleanup root", {
        mustExist: false,
        directory: true,
      }).normalized
    ));
    contract(
      cleanedTemplateRoots.length === templateRoots.size
        && new Set(cleanedTemplateRoots).size === templateRoots.size
        && json([...new Set(cleanedTemplateRoots)].sort()) === json([...templateRoots].sort()),
      "actual immutable templates were not cleaned at process completion",
    );
    for (const root of templateRoots) {
      assertOwnedPathAbsent(fixtureOwner, root, "actual immutable template");
    }
    assertReportResidue(report, "fixture-traced real shard");
    contract(
      readdirSync(fixtureOwner.path).length === 0,
      "fixture-traced shard left unreported data inside its harness-owned base",
    );
  } finally {
    try {
      cleanupHarnessOwnedBase(fixtureOwner, "actual fixture owned base");
    } finally {
      cleanupHarnessOwnedBase(traceOwner, "actual fixture trace base");
    }
  }
}

async function fixtureTemplateContract() {
  const fixtureModule = await loadBuiltTarget(
    fixtureSourcePath,
    fixtureDistPath,
    "fixture-template-contract",
  );
  contract(
    typeof fixtureModule.createQuorumSmokeFixtureTemplatePool === "function",
    "fixture module must export createQuorumSmokeFixtureTemplatePool",
  );
  contract(
    typeof fixtureModule.QUORUM_SMOKE_FIXTURE_TEMPLATE_MANIFEST === "string"
      && fixtureModule.QUORUM_SMOKE_FIXTURE_TEMPLATE_MANIFEST.length > 0,
    "fixture module must export QUORUM_SMOKE_FIXTURE_TEMPLATE_MANIFEST",
  );
  const actualManifest = readJsonTarget(manifestPath, "fixture-template-contract inventory");
  await proveActualFixtureWiring(actualManifest);

  const cacheOwner = createHarnessOwnedBase("b-e40f-fixture-contract-");
  const outside = createHarnessOwnedFile(cacheOwner, "outside.txt", "fixture symlink sentinel");
  writeHarnessOwnedFile(outside, "fixture symlink sentinel", "outside-must-not-be-consumed\n");
  const assertSentinelIntact = (stage) => {
    assertHarnessOwnedFile(outside, "fixture symlink sentinel " + stage);
    contract(
      readHarnessOwnedFile(outside, "fixture symlink sentinel " + stage, "utf8")
        === "outside-must-not-be-consumed\n",
      "symlink target was mutated " + stage,
    );
  };
  const profile = {
    id: "global-thin-codex",
    inputs: {
      assetMode: "global-thin",
      selectedHost: "codex",
      storySchema: "v1",
      configDigest: "fixture-contract-a",
    },
  };
  const changedProfile = {
    ...profile,
    inputs: { ...profile.inputs, configDigest: "fixture-contract-b" },
  };
  let pool = null;
  let poolDisposalSafe = true;
  const guardedLeasePaths = new Map();
  const guardLease = (lease, label) => {
    try {
      contract(lease && typeof lease === "object", label + " returned no fixture lease");
      const root = assertOwnedDirectory(cacheOwner, lease.root, label + " root");
      const template = assertOwnedDirectory(cacheOwner, lease.templateRoot, label + " templateRoot");
      const clone = lease.cloneRoot === undefined
        ? root
        : assertOwnedDirectory(cacheOwner, lease.cloneRoot, label + " cloneRoot");
      contract(root.realpath === clone.realpath, label + " root and cloneRoot identify different directories");
      contract(root.realpath !== template.realpath, label + " handed the immutable template out as mutable state");
      for (const inspected of [root, template, clone]) {
        if (!guardedLeasePaths.has(inspected.path)) {
          guardedLeasePaths.set(inspected.path, {
            dev: inspected.entry.dev,
            ino: inspected.entry.ino,
            realpath: inspected.realpath,
          });
        }
      }
      return { ...lease, rootPath: root.realpath, templatePath: template.realpath };
    } catch (error) {
      poolDisposalSafe = false;
      throw error;
    }
  };
  try {
    pool = fixtureModule.createQuorumSmokeFixtureTemplatePool({
      cacheRoot: cacheOwner.realpath,
      buildTemplate: (request) => buildSyntheticFixtureTemplate(cacheOwner, request),
    });
    contract(pool && typeof pool.clone === "function", "fixture template pool must expose clone(profile)");
    contract(typeof pool.stats === "function", "fixture template pool must expose stats()");
    contract(typeof pool.dispose === "function", "fixture template pool must expose dispose()");

    const first = guardLease(await pool.clone(profile), "first compatible clone");
    const second = guardLease(await pool.clone(profile), "second compatible clone");
    contract(first.rootPath !== second.rootPath, "compatible cases received the same mutable fixture root");
    contract(first.templatePath === second.templatePath, "compatible profiles did not reuse one immutable template");

    const templateBefore = fixtureSnapshot(cacheOwner, first.templateRoot, "immutable template");
    const firstBefore = fixtureSnapshot(cacheOwner, first.root, "first clone");
    const siblingBefore = fixtureSnapshot(cacheOwner, second.root, "sibling clone");
    assertEquivalentFixture(firstBefore, templateBefore, "first clone equivalence");
    assertEquivalentFixture(siblingBefore, templateBefore, "sibling clone equivalence");

    writeFixtureFile(cacheOwner, first.root, "README.md", "mutated first clone\n");
    writeFixtureFile(cacheOwner, first.root, "proof-or-stop.config.json", json({ mutated: true }) + "\n");
    appendFixtureFile(
      cacheOwner,
      first.root,
      ".proof-or-stop/story/actives/B-template/process-events.jsonl",
      json({ type: "mutated" }) + "\n",
      "first clone event log",
    );
    writeFixtureFile(cacheOwner, first.root, ".proof-or-stop/cache/seed.txt", "mutated-cache\n");
    writeFixtureFile(cacheOwner, first.root, ".proof-or-stop/locks/seed.txt", "mutated-lock\n");
    fixtureGit(cacheOwner, first.root, ["checkout", "-b", "mutated-first-clone"]);
    fixtureGit(cacheOwner, first.root, ["add", "."]);
    fixtureGit(cacheOwner, first.root, ["commit", "-m", "mutate only first clone"]);

    assertEquivalentFixture(
      fixtureSnapshot(cacheOwner, second.root, "sibling clone after mutation"),
      siblingBefore,
      "sibling fixture after files/refs/events/config/cache/lock mutation",
    );
    assertEquivalentFixture(
      fixtureSnapshot(cacheOwner, first.templateRoot, "template after clone mutation"),
      templateBefore,
      "immutable template after derived fixture mutation",
    );

    const different = guardLease(await pool.clone(changedProfile), "profile-mismatched clone");
    contract(
      different.templatePath !== first.templatePath,
      "behavior-affecting profile input mismatch reused the old template",
    );
    contract(
      readFixtureFile(
        cacheOwner,
        different.root,
        "proof-or-stop.config.json",
        "profile-mismatched config",
      ).includes("fixture-contract-b"),
      "profile-mismatched clone did not rebuild from its authoritative inputs",
    );

    let recoveryIndex = 0;
    const recover = async (label, mutate) => {
      recoveryIndex += 1;
      const scenarioProfile = {
        ...profile,
        id: profile.id + "-recovery-" + recoveryIndex,
        inputs: { ...profile.inputs, configDigest: "fixture-recovery-" + recoveryIndex },
      };
      const current = guardLease(await pool.clone(scenarioProfile), label + " seed clone");
      const pristine = fixtureSnapshot(cacheOwner, current.root, label + " seed clone");
      const templateRoot = current.templateRoot;
      const buildsBefore = Number(pool.stats().builds);
      await mutate(templateRoot);
      let clone = null;
      let rawClone = null;
      let rejection = null;
      try {
        rawClone = await pool.clone(scenarioProfile);
      } catch (error) {
        rejection = error;
      }
      if (rejection) {
        contract(
          /template|manifest|corrupt|symlink|profile|missing|digest/i.test(String(rejection.message)),
          label + " was rejected without a fail-closed template diagnostic: " + rejection.message,
        );
        return;
      } else {
        clone = guardLease(rawClone, label + " recovery clone");
        contract(
          Number(pool.stats().builds) > buildsBefore,
          label + " was silently accepted without rebuilding the template",
        );
      }
      assertEquivalentFixture(
        fixtureSnapshot(cacheOwner, clone.root, label + " recovery clone"),
        pristine,
        label + " recovery",
      );
    };

    await recover("missing template", async (templateRoot) => {
      const source = assertOwnedDirectory(cacheOwner, templateRoot, "missing template mutation source");
      const quarantine = join(cacheOwner.path, "harness-missing-template-" + recoveryIndex);
      const destination = assertOwnedPath(cacheOwner, quarantine, "missing template quarantine", {
        mustExist: false,
        directory: true,
      });
      renameSync(source.normalized, destination.normalized);
      assertOwnedPathAbsent(cacheOwner, source.normalized, "renamed missing template source");
      const moved = assertOwnedDirectory(cacheOwner, destination.normalized, "renamed missing template quarantine");
      contract(
        moved.entry.dev === source.entry.dev && moved.entry.ino === source.entry.ino,
        "missing template rename changed directory identity",
      );
    });
    await recover("altered template", async (templateRoot) => {
      writeFixtureFile(cacheOwner, templateRoot, "README.md", "corrupt template bytes\n");
    });
    await recover("symlinked template", async (templateRoot) => {
      assertOwnedDirectory(cacheOwner, templateRoot, "symlinked template mutation root");
      const target = safeFixturePath(cacheOwner, templateRoot, "README.md", "symlinked template target", {
        mustExist: true,
        directory: false,
      });
      contract(target.entry.isFile(), "symlink mutation target is not a regular file");
      unlinkSync(target.normalized);
      const missing = safeFixturePath(cacheOwner, templateRoot, "README.md", "unlinked template target", {
        mustExist: false,
        directory: false,
      });
      contract(!missing.entry, "symlink mutation target survived unlink");
      assertHarnessOwnedFile(outside, "fixture symlink sentinel before link");
      symlinkSync(outside.realpath, missing.normalized);
      contract(lstatSync(missing.normalized).isSymbolicLink(), "symlink mutation precondition was not established");
    });
    await recover("profile-mismatched template manifest", async (templateRoot) => {
      assertOwnedDirectory(cacheOwner, templateRoot, "profile manifest mutation root");
      const manifestName = fixtureModule.QUORUM_SMOKE_FIXTURE_TEMPLATE_MANIFEST;
      const record = JSON.parse(readFixtureFile(
        cacheOwner,
        templateRoot,
        manifestName,
        "fixture template manifest",
      ));
      writeFixtureFile(
        cacheOwner,
        templateRoot,
        manifestName,
        json({ ...record, profileDigest: "wrong-profile" }) + "\n",
      );
    });
    assertSentinelIntact("after recovery probes");

    // Finish with enough compatible clones to make reuse mechanically visible.
    guardLease(await pool.clone(profile), "final compatible clone one");
    guardLease(await pool.clone(profile), "final compatible clone two");
    assertSentinelIntact("after final clones");
    const stats = pool.stats();
    contract(Number.isInteger(stats.profiles) && stats.profiles >= 2, "fixture stats did not count profile keys");
    contract(Number.isInteger(stats.builds) && stats.builds >= 2, "fixture stats did not count template builds");
    contract(Number.isInteger(stats.clones) && stats.clones > stats.builds, "fixture setup was rebuilt per clone");
    console.log(
      "FIXTURE_TEMPLATE_PASS profiles=" + stats.profiles
      + " builds=" + stats.builds
      + " clones=" + stats.clones
      + " isolated=true",
    );
  } finally {
    try {
      if (pool && poolDisposalSafe) {
        for (const [path, identity] of guardedLeasePaths) {
          try {
            const inspected = assertOwnedDirectory(cacheOwner, path, "fixture lease before dispose");
            if (
              inspected.entry.dev !== identity.dev
              || inspected.entry.ino !== identity.ino
              || inspected.realpath !== identity.realpath
            ) {
              poolDisposalSafe = false;
              break;
            }
          } catch {
            poolDisposalSafe = false;
            break;
          }
        }
      }
      if (pool && poolDisposalSafe) {
        try {
          await pool.dispose();
        } finally {
          assertSentinelIntact("after pool dispose");
        }
      }
    } finally {
      cleanupHarnessOwnedBase(cacheOwner, "synthetic fixture cacheRoot");
    }
  }
}

async function loadSmokeMainContract(label) {
  assertEntrypointCaseModuleWiring();
  if (!existsSync(smokeDistPath)) {
    throw new BootstrapFailure(label + " build artifact is missing: " + smokeDistPath);
  }
  const owner = createHarnessOwnedBase("b-e40f-import-probe-");
  const trace = createHarnessOwnedFile(owner, "callbacks.jsonl", "import callback trace");
  const before = gitStatus();
  try {
    const url = pathToFileURL(smokeDistPath).href + "?b-e40f-import=" + randomUUID();
    const script = "const m=await import(" + json(url) + ");"
      + "if(typeof m.runQuorumSmokeMain!=='function')process.exit(23);"
      + "process.stdout.write('IMPORT_PASS runQuorumSmokeMain\\n');";
    const execution = await runNodeSubprocess(
      ["--input-type=module", "--eval", script, "--", "--case=import-probe"],
      5_000,
      { env: {
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE: trace.realpath,
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE: randomUUID(),
      } },
      label + " side-effect-free import",
    );
    contract(
      execution.status === 0 && !execution.timedOut && execution.processGroupReaped
        && execution.orphanedDescendants === false
        && execution.output === "IMPORT_PASS runQuorumSmokeMain\n",
      label + " import executed CLI work, emitted output, or left a process: " + json(execution),
    );
    contract(
      parseOwnedJsonLines(trace, label + " import callback").rows.length === 0,
      label + " import executed a callback",
    );
    contract(gitStatus() === before, label + " import changed repository state");
  } finally {
    cleanupHarnessOwnedBase(owner, label + " import probe");
  }
  const module = await loadBuiltTarget(smokeSourcePath, smokeDistPath, label);
  contract(typeof module.runQuorumSmokeMain === "function", label + " must export runQuorumSmokeMain");
  return module.runQuorumSmokeMain;
}

async function probeMainRoute(runMain, route) {
  const nonce = randomUUID();
  const ids = [0, 1, 2].map((index) => "qsm-probe-" + index + "-" + nonce);
  const shards = [0, 1, 2].map((index) => "probe-shard-" + index + "-" + nonce);
  const access = { coordinator: false };
  const callbackCalls = new Map();
  const callbacks = new Map();
  const callbackTokens = new Map();
  const registrations = ids.map((id, index) => {
    callbackCalls.set(id, 0);
    const token = Object.freeze({ id, secret: Symbol(id) });
    callbackTokens.set(id, token);
    const run = () => { callbackCalls.set(id, callbackCalls.get(id) + 1); return token; };
    const target = Object.freeze({
      id, title: "Private " + id, domain: index === 0 ? "pure" : "integration",
      shard: shards[index], resources: Object.freeze([]), run,
    });
    let proxy = null;
    proxy = new Proxy(target, {
      get(object, key, receiver) {
        if (key === "run" && !access.coordinator) throw new ContractFailure(route.name + " read run outside coordinator");
        return Reflect.get(object, key, receiver);
      },
      getOwnPropertyDescriptor(object, key) {
        if (key === "run" && !access.coordinator) throw new ContractFailure(route.name + " detached or copied run");
        return Reflect.getOwnPropertyDescriptor(object, key);
      },
      set() { throw new ContractFailure(route.name + " mutated a registration"); },
      deleteProperty() { throw new ContractFailure(route.name + " deleted a registration field"); },
      defineProperty() { throw new ContractFailure(route.name + " redefined a registration field"); },
    });
    callbacks.set(proxy, run);
    return proxy;
  });
  Object.freeze(registrations);
  const faultTarget = route.kind === "timeout" ? registrations[0]
    : route.kind === "fail" ? registrations[2] : null;
  const selected = route.kind === "aggregate" || faultTarget ? registrations
    : [registrations[1]];
  const timeoutMs = 1_700 + route.name.length;
  const argv = ["--jobs=2", "--case-timeout-ms=" + timeoutMs, "--report=json"];
  if (route.kind === "shard") argv.push("--shard=" + shards[1]);
  if (route.kind === "fail" || route.kind === "timeout") {
    argv.push("--coordinator-fault=" + route.kind + ":" + faultTarget.id);
  }
  Object.freeze(argv);
  const privateError = (route.kind === "fail" || route.kind === "timeout")
    ? new Error("private " + route.kind + " " + nonce) : null;
  const resultRows = selected.map((row) => Object.freeze({
    caseId: row.id,
    status: privateError && row === faultTarget ? route.kind.toUpperCase() : "PASS",
    ...(privateError && row === faultTarget ? { error: privateError } : {}),
  }));
  const report = { ok: !privateError, probeNonce: nonce, results: Object.freeze(resultRows) };
  Object.freeze(report);
  const contextCapability = Symbol("context-" + nonce);
  const baseContext = Object.freeze({ harnessCapability: contextCapability });
  let coordinatorCalls = 0;
  const coordinator = async (options) => {
    coordinatorCalls += 1;
    contract(
      options?.jobs === 2 && options?.timeoutMs === timeoutMs
        && Array.isArray(options.registrations)
        && options.registrations.length === selected.length
        && options.registrations.every((row, index) => row === selected[index]),
      route.name + " did not pass exact selected registration capabilities/jobs/timeout",
    );
    const expectedMode = route.kind === "aggregate" ? "aggregate"
      : route.kind === "shard" ? "shard" : "fault-probe";
    contract(
      options.context?.harnessCapability === contextCapability && options.context.mode === expectedMode,
      route.name + " lost context capability or mode",
    );
    if (route.kind === "shard") contract(options.context.shardId === shards[1], "shard context lost shardId");
    if (route.kind === "fail" || route.kind === "timeout") {
      contract(
        options.context.fault?.kind === route.kind && options.context.fault?.caseId === faultTarget.id,
        route.name + " lost exact fault context",
      );
    }
    access.coordinator = true;
    try {
      for (const row of selected) {
        contract(row.run === callbacks.get(row), route.name + " replaced a callback capability");
        if (!route.coordinatorError) {
          contract(row.run() === callbackTokens.get(row.id), route.name + " lost callback return capability");
        }
      }
    } finally {
      access.coordinator = false;
    }
    if (route.coordinatorError) throw route.coordinatorError;
    return report;
  };
  const sinkValues = [];
  const serialized = [];
  const reportSink = (value) => {
    sinkValues.push(value);
    serialized.push(JSON.stringify(value, (_key, item) => item instanceof Error
      ? { name: item.name, message: item.message } : item));
    if (route.sinkError) throw route.sinkError;
  };
  let returned = null;
  let rejected = null;
  try {
    returned = await runMain({ argv, registrations, coordinator, reportSink, context: baseContext });
  } catch (error) {
    rejected = error;
  }
  const expectedRejection = route.coordinatorError ?? route.sinkError ?? null;
  if (rejected && rejected !== expectedRejection) throw rejected;
  contract(coordinatorCalls === 1, route.name + " did not call coordinator exactly once");
  if (expectedRejection) {
    contract(rejected === expectedRejection && returned === null, route.name + " wrapped or swallowed Error identity");
    contract(sinkValues.length === (route.sinkError ? 1 : 0), route.name + " used reportSink at the wrong time");
  } else {
    contract(returned === report, route.name + " did not return coordinator report identity");
    contract(sinkValues.length === 1 && sinkValues[0] === report, route.name + " did not sink the exact report once");
    contract(serialized[0]?.includes(nonce), route.name + " reportSink did not serialize the private report");
    if (privateError) {
      contract(
        returned.results.find((row) => row.caseId === faultTarget.id)?.error === privateError,
        route.name + " replaced report Error identity",
      );
    }
  }
  for (const row of registrations) {
    contract(
      callbackCalls.get(row.id) === (selected.includes(row) && !route.coordinatorError ? 1 : 0),
      route.name + " invoked a callback outside its exact selected coordinator path",
    );
  }
  const stable = json([coordinatorCalls, sinkValues.length, ...callbackCalls.values()]);
  await wait(30);
  contract(stable === json([coordinatorCalls, sinkValues.length, ...callbackCalls.values()]), route.name + " continued after return");
}

async function proveThinEntrypointFlow(runMain) {
  await probeMainRoute(runMain, { name: "aggregate", kind: "aggregate" });
  await probeMainRoute(runMain, { name: "shard", kind: "shard" });
  await probeMainRoute(runMain, { name: "fault-fail", kind: "fail" });
  await probeMainRoute(runMain, { name: "fault-timeout", kind: "timeout" });
  await probeMainRoute(runMain, { name: "coordinator-throw", kind: "aggregate", coordinatorError: new Error("private coordinator throw") });
  await probeMainRoute(runMain, { name: "sink-throw", kind: "aggregate", sinkError: new Error("private sink throw") });
}

async function loadWorkerContract(label) {
  const runMain = await loadSmokeMainContract(label + " thin entrypoint");
  await proveThinEntrypointFlow(runMain);
  const worker = await loadBuiltTarget(workerSourcePath, workerDistPath, label);
  contract(
    typeof worker.runQuorumSmokeCoordinator === "function",
    "worker module must export runQuorumSmokeCoordinator",
  );
  contract(
    Number.isInteger(worker.MAX_QUORUM_SMOKE_JOBS)
      && worker.MAX_QUORUM_SMOKE_JOBS >= 2
      && worker.MAX_QUORUM_SMOKE_JOBS <= 64,
    "worker module must export a bounded MAX_QUORUM_SMOKE_JOBS between 2 and 64",
  );
  return worker;
}

function taskResults(result) {
  contract(result && Array.isArray(result.results), "worker plan did not return a results array");
  return result.results;
}

function resultCaseId(result) {
  return String(result.caseId ?? result.id ?? "");
}

function assertZeroWorkerResidue(result, label) {
  contract(result.processTreeReaped === true, label + " did not prove its worker process tree was reaped");
  contract(result.orphanedDescendants === false, label + " reported orphaned descendants");
  contract(result.residue && typeof result.residue === "object", label + " omitted residue accounting");
  for (const kind of ["temp", "process", "ticket", "quarantine"]) {
    contract(Number(result.residue[kind]) === 0, label + " left " + kind + " residue: " + json(result.residue));
  }
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function behaviorProof(secret, caseId, phase, ordinal) {
  return createHash("sha256")
    .update(["b-e40f-behavior-v1", secret, caseId, phase, String(ordinal)].join("\u0000"))
    .digest("hex");
}

function observedConcurrency(events) {
  const ordered = events
    .map((event) => ({ ...event, order: event.phase === "end" ? 0 : 1 }))
    .sort((left, right) => left.atMs - right.atMs || left.order - right.order);
  let active = 0;
  let maximum = 0;
  for (const event of ordered) {
    active += event.phase === "start" ? 1 : -1;
    contract(active >= 0, "behavior witness ended a closure before it started");
    maximum = Math.max(maximum, active);
  }
  contract(active === 0, "behavior witness left an invoked closure incomplete");
  return maximum;
}

function coordinatorProbeOptions(registrations, jobs, timeoutMs, mode, context = {}) {
  return { registrations, jobs, timeoutMs, context: { ...context, mode } };
}

async function runHarnessClosurePassPlan(worker, jobs) {
  const owner = createHarnessOwnedBase("b-e40f-worker-behavior-");
  const witness = createHarnessOwnedFile(owner, "effects.jsonl", "worker behavior witness");
  const callbackFile = createHarnessOwnedFile(owner, "callbacks.jsonl", "coordinator catalog trace");
  const secret = randomUUID();
  const nonce = randomUUID();
  const runId = "b-e40f-coordinator-" + randomUUID();
  const ids = ["behavior-a", "behavior-b", "behavior-c", "behavior-d"];
  const calls = new Map(ids.map((id) => [id, 0]));
  const tokens = new Map(ids.map((id) => [id, Object.freeze({ id, capability: Symbol(id) })]));
  const events = [];
  const pending = [];
  const emit = (caseId, phase) => {
    const ordinal = events.filter((row) => row.caseId === caseId && row.phase === phase).length + 1;
    const event = {
      caseId,
      phase,
      ordinal,
      atMs: Date.now(),
      proof: behaviorProof(secret, caseId, phase, ordinal),
    };
    events.push(event);
    writeHarnessOwnedFile(witness, "worker behavior witness", json(event) + "\n", true);
  };
  const registrations = ids.map((id) => ({
    id,
    title: "Harness behavior " + id,
    domain: "pure",
    shard: "behavior-probe",
    resources: [],
    run: () => {
      const execution = (async () => {
        calls.set(id, calls.get(id) + 1);
        emit(id, "start");
        await wait(80);
        emit(id, "end");
        return tokens.get(id);
      })();
      pending.push(execution.catch(() => undefined));
      return execution;
    },
  }));
  try {
    const result = await worker.runQuorumSmokeCoordinator(coordinatorProbeOptions(
      registrations,
      jobs,
      2_000,
      "harness-behavior-probe",
      { runId, callbackTrace: { file: callbackFile.realpath, nonce } },
    ));
    contract(result?.ok === true, "jobs=" + jobs + " rejected harness-owned passing closures");
    const rows = taskResults(result);
    contract(
      json(rows.map(resultCaseId).sort()) === json([...ids].sort()),
      "jobs=" + jobs + " did not return the exact invoked closure IDs",
    );
    for (const id of ids) {
      const row = rows.find((candidate) => resultCaseId(candidate) === id);
      contract(calls.get(id) === 1, "jobs=" + jobs + " invoked " + id + " more or less than once");
      contract(
        row?.status === "PASS" && Number(row.attempts) === 1 && row.value === tokens.get(id),
        "jobs=" + jobs + " did not preserve the unforgeable closure return capability for " + id,
      );
    }
    const callsAtReturn = json([...calls]);
    const effectsAtReturn = events.length;
    await wait(125);
    contract(
      json([...calls]) === callsAtReturn && events.length === effectsAtReturn,
      "jobs=" + jobs + " invoked a closure after resolving the aggregate",
    );
    const trace = parseOwnedJsonLines(witness, "jobs=" + jobs + " worker behavior").rows;
    contract(json(trace) === json(events), "no-follow witness diverged from harness-private closure effects");
    contract(trace.length === ids.length * 2, "closure witness lacks one start/end pair per task");
    for (const event of trace) {
      contract(
        event.proof === behaviorProof(secret, event.caseId, event.phase, event.ordinal),
        "closure witness contains an effect not authenticated by the harness-private secret",
      );
    }
    const callbackTrace = parseOwnedJsonLines(callbackFile, "jobs=" + jobs + " coordinator catalog");
    assertCallbackTrace(callbackTrace, ids, result, nonce, "jobs=" + jobs + " direct coordinator");
    for (const id of ids) {
      const privateEvents = trace.filter((event) => event.caseId === id);
      const catalogEvents = callbackTrace.rows.filter((event) => event.caseId === id);
      contract(
        catalogEvents[0].atMs <= privateEvents[0].atMs
          && privateEvents[1].atMs <= catalogEvents[1].atMs,
        "catalog executor trace does not surround coordinator callback effects for " + id,
      );
    }
    const maximum = observedConcurrency(events);
    contract(maximum === (jobs === 1 ? 1 : 2), "jobs=" + jobs + " observed concurrency=" + maximum);
    assertZeroWorkerResidue(result, "jobs=" + jobs + " harness closure plan");
    return rows.map((row) => [resultCaseId(row), row.status]).sort();
  } finally {
    await Promise.race([Promise.all(pending), wait(250)]);
    cleanupHarnessOwnedBase(owner, "worker behavior base");
  }
}

async function proveHarnessClosureFailures(worker) {
  const owner = createHarnessOwnedBase("b-e40f-worker-negative-");
  const witness = createHarnessOwnedFile(owner, "effects.jsonl", "negative behavior witness");
  const secret = randomUUID();
  const effects = [];
  const emit = (caseId, phase) => {
    const effect = { caseId, phase, atMs: Date.now(), proof: behaviorProof(secret, caseId, phase, 1) };
    effects.push(effect);
    writeHarnessOwnedFile(witness, "negative behavior witness", json(effect) + "\n", true);
  };
  const failure = new Error("harness-owned failure " + randomUUID());
  let failureCalls = 0;
  let timeoutCalls = 0;
  let timeoutAborts = 0;
  let timeoutSelfLimits = 0;
  let timeoutInvokedAt = null;
  let timeoutAbortedAt = null;
  let timeoutSettled = Promise.resolve();
  const timeoutFailure = new Error("harness-owned timeout abort " + randomUUID());
  try {
    const failed = await worker.runQuorumSmokeCoordinator(coordinatorProbeOptions([{
        id: "behavior-fail",
        title: "Harness behavior FAIL",
        domain: "pure",
        shard: "behavior-probe",
        resources: [],
        run: async () => {
          failureCalls += 1;
          emit("behavior-fail", "throw");
          throw failure;
        },
      }], 2, 1_000, "harness-behavior-fail"));
    const failedRows = taskResults(failed);
    contract(
      failedRows.length === 1 && resultCaseId(failedRows[0]) === "behavior-fail",
      "closure FAIL aggregate added, dropped, or replaced a result row",
    );
    const failedRow = failedRows[0];
    contract(failed?.ok === false && failedRow?.status === "FAIL", "closure throw was not propagated as FAIL");
    contract(Number(failedRow.attempts) === 1 && failureCalls === 1, "closure FAIL was retried");
    contract(
      failedRow.error === failure || failedRow.error?.cause === failure,
      "worker did not preserve the harness-owned thrown capability",
    );
    assertZeroWorkerResidue(failed, "harness closure FAIL");

    const timedOut = await worker.runQuorumSmokeCoordinator(coordinatorProbeOptions([{
        id: "behavior-timeout",
        title: "Harness behavior TIMEOUT",
        domain: "pure",
        shard: "behavior-probe",
        resources: [],
        run: ({ signal } = {}) => {
          const closure = new Promise((_resolveTask, rejectTask) => {
            timeoutCalls += 1;
            timeoutInvokedAt = process.hrtime.bigint();
            emit("behavior-timeout", "start");
            contract(
              signal && typeof signal.addEventListener === "function",
              "timeout closure was not given an AbortSignal",
            );
            let finished = false;
            let selfLimit = null;
            const abort = () => {
              if (finished) return;
              finished = true;
              clearTimeout(selfLimit);
              timeoutAbortedAt = process.hrtime.bigint();
              timeoutAborts += 1;
              emit("behavior-timeout", "abort");
              rejectTask(timeoutFailure);
            };
            selfLimit = setTimeout(() => {
              if (finished) return;
              finished = true;
              signal.removeEventListener("abort", abort);
              timeoutSelfLimits += 1;
              emit("behavior-timeout", "self-limit");
              rejectTask(new Error("harness timeout closure reached its self-limit"));
            }, 500);
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          });
          timeoutSettled = closure.catch(() => undefined);
          return closure;
        },
      }], 1, 50, "harness-behavior-timeout"));
    const timeoutReturnedAt = process.hrtime.bigint();
    await wait(25);
    const timeoutRows = taskResults(timedOut);
    contract(
      timeoutRows.length === 1 && resultCaseId(timeoutRows[0]) === "behavior-timeout",
      "closure TIMEOUT aggregate added, dropped, or replaced a result row",
    );
    const timeoutRow = timeoutRows[0];
    contract(timedOut?.ok === false && timeoutRow?.status === "TIMEOUT", "closure deadline was not TIMEOUT");
    contract(Number(timeoutRow.attempts) === 1 && timeoutCalls === 1, "closure TIMEOUT was retried");
    contract(timeoutAborts === 1 && timeoutSelfLimits === 0, "timeout did not abort and reap its closure exactly once");
    const abortElapsedMs = Number(timeoutAbortedAt - timeoutInvokedAt) / 1e6;
    const returnElapsedMs = Number(timeoutReturnedAt - timeoutInvokedAt) / 1e6;
    contract(
      abortElapsedMs >= 35 && abortElapsedMs <= 250 && returnElapsedMs >= abortElapsedMs && returnElapsedMs <= 300,
      "timeout deadline was not enforced near 50ms: abort=" + abortElapsedMs + "ms return=" + returnElapsedMs + "ms",
    );
    contract(
      timeoutRow.error === timeoutFailure || timeoutRow.error?.cause === timeoutFailure,
      "TIMEOUT result was not causally bound to the harness-owned abort",
    );
    assertZeroWorkerResidue(timedOut, "harness closure TIMEOUT");

    const callsAtReturn = [failureCalls, timeoutCalls, timeoutAborts, effects.length];
    await wait(125);
    contract(
      json([failureCalls, timeoutCalls, timeoutAborts, effects.length]) === json(callsAtReturn),
      "worker invoked a negative closure after resolving its aggregate",
    );
    const trace = parseOwnedJsonLines(witness, "negative worker behavior").rows;
    contract(json(trace) === json(effects), "negative no-follow witness diverged from closure effects");
    contract(
      trace.filter((row) => row.caseId === "behavior-fail" && row.phase === "throw").length === 1
        && trace.filter((row) => row.caseId === "behavior-timeout" && row.phase === "start").length === 1
        && trace.filter((row) => row.caseId === "behavior-timeout" && row.phase === "abort").length === 1
        && !trace.some((row) => row.phase === "self-limit"),
      "negative closure effects were missing, retried, or left live",
    );
    for (const effect of trace) {
      contract(
        effect.proof === behaviorProof(secret, effect.caseId, effect.phase, 1),
        "negative closure effect lacks the harness-private proof",
      );
    }
  } finally {
    await Promise.race([timeoutSettled, wait(650)]);
    cleanupHarnessOwnedBase(owner, "negative worker behavior base");
  }
}

async function proveHarnessOwnedBehaviorExecution(worker) {
  const serial = await runHarnessClosurePassPlan(worker, 1);
  const parallel = await runHarnessClosurePassPlan(worker, 2);
  contract(json(serial) === json(parallel), "jobs=1/jobs=2 closure verdict parity failed");
  await proveHarnessClosureFailures(worker);
}

function canonicalResourceClaims(resources) {
  return (resources ?? []).map((claim) => ({
    class: claim.class,
    key: claim.key,
    access: claim.access,
    ...(claim.ownership ? { ownership: claim.ownership } : {}),
  }));
}

function containedBy(root, candidate) {
  return resolve(root) === resolve(candidate) || strictDescendant(resolve(root), resolve(candidate));
}

function assertTimelineOverlap(report, callbackTrace, jobs, label) {
  contract(
    Number(report.maxConcurrent) >= 1 && Number(report.maxConcurrent) <= jobs,
    label + " exceeded jobs=" + jobs + ": maxConcurrent=" + report.maxConcurrent,
  );
  const intervals = report.results.map((row) => {
    const id = resultCaseId(row);
    const start = callbackTrace.rows.find((event) => event.caseId === id && event.phase === "start");
    const end = callbackTrace.rows.find((event) => event.caseId === id && event.phase === "end");
    return { id, pid: start?.pid, start: Number(start?.atMs), end: Number(end?.atMs) };
  });
  contract(
    intervals.every((row) => Number.isFinite(row.start) && Number.isFinite(row.end) && row.end >= row.start),
    label + " omitted valid real case timelines",
  );
  if (jobs === 1) {
    contract(
      Number(report.maxConcurrent) === 1
        && intervals.every((left, index) => intervals.slice(index + 1).every((right) => (
          left.end <= right.start || right.end <= left.start
        ))),
      label + " did not honor serial jobs=1",
    );
    return;
  }
  const overlapped = intervals.some((left, index) => (
    intervals.slice(index + 1).some((right) => (
      left.start < right.end && right.start < left.end
    ))
  ));
  contract(
    Number(report.maxConcurrent) >= 2
      && new Set(intervals.map((row) => row.pid)).size >= 2
      && overlapped,
    label + " established no nonce-bound real callback overlap",
  );
}

async function runTracedFullAggregate(jobs) {
  const inventory = manifestRows(readJsonTarget(manifestPath, "resource aggregate inventory"));
  const shardIds = [...new Set(inventory.map((row) => row.shard))].sort();
  const sentinelIds = inventory.filter((row) => row.sentinel === "real").map((row) => row.id);
  const traceOwner = createHarnessOwnedBase("b-e40f-resource-trace-j" + jobs + "-");
  const ownedTempOwner = createHarnessOwnedBase("b-e40f-resource-owned-j" + jobs + "-");
  const traceFile = createHarnessOwnedFile(traceOwner, "resource-trace.jsonl", "resource jobs=" + jobs);
  const runtimeTraceFile = jobs === 2
    ? createHarnessOwnedFile(traceOwner, "runtime-trace.json", "configured quorum runtime trace")
    : null;
  try {
    const trustedTracer = realpathSync(validationRuntimeTracerPath);
    const inheritedNodeOptions = process.env.NODE_OPTIONS ?? "";
    const tracedNodeOptions = hasTrustedRuntimeTracer(inheritedNodeOptions, trustedTracer)
      ? inheritedNodeOptions
      : `${inheritedNodeOptions} --require=${trustedTracer}`.trim();
    const run = await runPositiveRealCli(
      ["--jobs=" + jobs, "--report=json"],
      EXPECTED_CASES.map((row) => row.id),
      "real full aggregate jobs=" + jobs,
      {
        timeoutMs: 30 * 60_000,
        expectedSentinels: sentinelIds,
        env: {
          PROOF_OR_STOP_QUORUM_SMOKE_RESOURCE_TRACE_FILE: traceFile.realpath,
          PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE: ownedTempOwner.realpath,
          ...(runtimeTraceFile ? {
            NODE_OPTIONS: tracedNodeOptions,
            PROOF_OR_STOP_RUNTIME_TRACE_FILE: runtimeTraceFile.realpath,
          } : {}),
        },
      },
    );
    const { report, callbackNonce } = run;
    contract(
      report.mode === "aggregate" && report.coordinator === "default-parent",
      "jobs=" + jobs + " did not execute the default parent aggregate",
    );
    contract(
      Array.isArray(report.shards)
        && json(report.shards.map((row) => row.shardId).sort()) === json(shardIds),
      "jobs=" + jobs + " default parent did not consume every actual shard",
    );
    for (const shardReport of report.shards) {
      const expectedShardIds = inventory
        .filter((row) => row.shard === shardReport.shardId)
        .map((row) => row.id)
        .sort();
      const expectedShardSentinels = inventory
        .filter((row) => row.shard === shardReport.shardId && row.sentinel === "real")
        .map((row) => row.id)
        .sort();
      contract(
        Number.isInteger(shardReport.workerPid)
          && shardReport.workerPid > 0
          && shardReport.workerPid !== report.parentPid
          && shardReport.status === "PASS"
          && Number(shardReport.attempts) === 1
          && Array.isArray(shardReport.caseIds)
          && json([...shardReport.caseIds].sort()) === json(expectedShardIds)
          && Array.isArray(shardReport.sentinelCaseIds)
          && json([...shardReport.sentinelCaseIds].sort()) === json(expectedShardSentinels),
        "default parent shard report is not exact: " + json(shardReport),
      );
      assertReportResidue(shardReport, "default parent shard " + shardReport.shardId);
    }
    contract(report.jobs === jobs, "default parent ignored requested jobs=" + jobs);
    assertTimelineOverlap(report, run.callbackTrace, jobs, "real full aggregate jobs=" + jobs);
    const resourceTrace = parseOwnedJsonLines(traceFile, "resource jobs=" + jobs);
    const runtimeEnvironmentKeys = new Set();
    const runtimeTracePids = new Set();
    let runtimeTraceProcessCount = 0;
    if (runtimeTraceFile) {
      const prefix = runtimeTraceFile.path.slice(runtimeTraceFile.path.lastIndexOf(sep) + 1) + ".";
      for (const name of readdirSync(traceOwner.path).filter((name) => (
        name.startsWith(prefix) && name.endsWith(".json")
      ))) {
        const path = join(traceOwner.realpath, name);
        assertOwnedPath(traceOwner, path, "configured quorum runtime trace fragment", {
          mustExist: true,
          directory: false,
        });
        const fragment = JSON.parse(readFileSync(path, "utf8"));
        const filenamePid = Number(name.slice(prefix.length).split(".", 1)[0]);
        contract(
          fragment.traceRoot === "runtime-trace.json"
            && Number.isSafeInteger(fragment.pid) && fragment.pid > 1
            && filenamePid === fragment.pid && !runtimeTracePids.has(fragment.pid)
            && Array.isArray(fragment.environmentKeys),
          "configured quorum runtime trace fragment lost its process/root binding",
        );
        runtimeTracePids.add(fragment.pid);
        runtimeTraceProcessCount += 1;
        for (const key of fragment.environmentKeys) {
          contract(typeof key === "string" && key.length > 0, "runtime trace emitted an invalid env key");
          runtimeEnvironmentKeys.add(key);
        }
      }
    }
    return {
      ...run,
      accesses: resourceTrace.rows,
      resourceTraceRaw: resourceTrace.raw,
      traceOwner,
      ownedTempOwner,
      traceFile,
      callbackNonce,
      runtimeTraceProcessCount,
      runtimeTracePids: [...runtimeTracePids].sort((left, right) => left - right),
      runtimeEnvironmentKeys: [...runtimeEnvironmentKeys].sort(),
    };
  } catch (error) {
    try {
      cleanupHarnessOwnedBase(ownedTempOwner, "failed resource owned temp base jobs=" + jobs);
    } finally {
      cleanupHarnessOwnedBase(traceOwner, "failed resource trace base jobs=" + jobs);
    }
    throw error;
  }
}

function assertConfiguredOfficialEnvironmentClosure(run, quorumRow) {
  contract(
    run.report.jobs === 2 && run.report.mode === "aggregate"
      && run.report.results?.length === EXPECTED_CASES.length,
    "environment closure did not use the configured jobs=2 full 73-case quorum row",
  );
  contract(
    run.runtimeTraceProcessCount >= 5 && run.runtimeEnvironmentKeys.length > 0,
    "configured full quorum run emitted no complete official process trace",
  );
  const tracedPids = new Set(run.runtimeTracePids);
  const authenticatedPids = [run.report.parentPid, ...run.report.shards.map((shard) => shard.workerPid)];
  contract(
    authenticatedPids.every((pid) => Number.isSafeInteger(pid) && tracedPids.has(pid)),
    "configured full quorum trace omitted an authenticated parent/shard process",
  );
  const declared = new Set(quorumRow.declaredEnvironmentKeys ?? []);
  const undeclared = businessEnvironmentKeys(run.runtimeEnvironmentKeys)
    .filter((key) => !declared.has(key));
  contract(
    undeclared.length === 0,
    "configured 73-case official trace observed undeclared environment keys: " + undeclared.join(","),
  );
}

function assertRealResourceTrace(run, label) {
  const repoResolved = resolve(repoRoot);
  const repoRealpath = realpathSync(repoRoot);
  const owned = run.report.ownedTempRoots;
  contract(Array.isArray(owned) && owned.length > 0, label + " omitted ownedTempRoots");
  contract(
    run.report.ownedTempBase === run.ownedTempOwner.realpath,
    label + " did not bind its owned roots to the harness-provided temp base",
  );
  const ownedNormalized = owned.map((root, index) => assertOwnedPath(
    run.ownedTempOwner,
    root,
    label + " owned temp root " + index,
    { mustExist: false, directory: true },
  ).normalized);
  for (let left = 0; left < ownedNormalized.length; left += 1) {
    for (let right = left + 1; right < ownedNormalized.length; right += 1) {
      contract(
        !containedBy(ownedNormalized[left], ownedNormalized[right])
          && !containedBy(ownedNormalized[right], ownedNormalized[left]),
        label + " reports overlapping worker-owned roots",
      );
    }
  }
  contract(run.accesses.length > 0, label + " emitted no runtime resource accesses");
  let repoReadCount = 0;
  let fixtureWriteCount = 0;
  for (const access of run.accesses) {
    const callbackStart = run.callbackTrace.rows.find(
      (event) => event.caseId === access.caseId && event.phase === "start",
    );
    const callbackEnd = run.callbackTrace.rows.find(
      (event) => event.caseId === access.caseId && event.phase === "end",
    );
    contract(
      access.schema === "proof-or-stop.quorum-smoke-resource-trace.v1"
        && access.nonce === run.callbackNonce
        && access.runId === run.report.runId
        && Number.isFinite(Number(access.atMs))
        && access.pid === callbackStart?.pid
        && Number(callbackStart?.atMs) <= Number(access.atMs)
        && Number(access.atMs) <= Number(callbackEnd?.atMs),
      label + " resource access is not nonce/runId/callback bound: " + json(access),
    );
    contract(access.op === "read" || access.op === "write", label + " trace has invalid op: " + json(access));
    contract(
      typeof access.path === "string"
        && isAbsolute(access.path)
        && !access.path.split(/[\\/]+/).includes(".."),
      label + " trace has an unsafe or unresolved path: " + json(access),
    );
    const normalized = resolve(access.path);
    const lexicalRepo = containedBy(repoResolved, normalized) || containedBy(repoRealpath, normalized);
    const lexicalOwned = strictOwnedDescendant(run.ownedTempOwner, normalized);
    contract(lexicalRepo || lexicalOwned, label + " accessed a path outside repo and owned temp: " + access.path);
    if (lexicalRepo) {
      let entry = null;
      try {
        entry = lstatSync(access.path);
      } catch (error) {
        throw new ContractFailure(label + " traced missing repository read path: " + error.message);
      }
      contract(Boolean(entry), label + " traced no repository entry");
      const canonical = realpathSync(access.path);
      contract(containedBy(repoRealpath, canonical), label + " repository path realpath escaped: " + canonical);
      contract(access.op === "read", label + " wrote inside the repository: " + access.path);
      repoReadCount += 1;
    } else {
      assertOwnedPath(run.ownedTempOwner, access.path, label + " owned resource access", {
        mustExist: false,
        directory: false,
      });
      contract(
        ownedNormalized.some((root) => containedBy(root, normalized)),
        label + " wrote outside all owned temp roots: " + access.path,
      );
      if (access.op === "write" && (access.resource === "fixture" || access.kind === "fixture")) {
        fixtureWriteCount += 1;
      }
    }
  }
  contract(repoReadCount > 0, label + " did not trace its real repository reads");
  contract(fixtureWriteCount > 0, label + " did not trace real fixture writes");
  for (const root of ownedNormalized) {
    assertOwnedPathAbsent(run.ownedTempOwner, root, label + " cleaned worker-owned root");
  }
  contract(
    readdirSync(run.ownedTempOwner.path).length === 0,
    label + " left unreported residue inside the harness-owned temp base",
  );
}

function resourceTraceEnvelope(run, overrides = {}) {
  return {
    nonce: run.callbackNonce,
    runId: run.report.runId,
    ownedTempBase: run.ownedTempOwner.realpath,
    ownedTempRoots: run.report.ownedTempRoots,
    accesses: run.accesses,
    raw: run.resourceTraceRaw,
    ...overrides,
  };
}

function resourceTraceProof(run) {
  return {
    expectedCaseIds: EXPECTED_CASES.map((row) => row.id),
    callbackEvents: run.callbackTrace.rows,
    callbackTraceRaw: run.callbackTrace.raw,
    report: run.report,
  };
}

function cleanupResourceRun(run, label) {
  if (!run) return;
  try {
    cleanupHarnessOwnedBase(run.ownedTempOwner, label + " owned temp base");
  } finally {
    cleanupHarnessOwnedBase(run.traceOwner, label + " resource trace base");
  }
}

function parseNegativeRun(execution, label, callbackNonce, expectedStatus) {
  contract(execution.processGroupReaped, label + " did not reap the CLI process group");
  contract(
    execution.orphanedDescendants === false,
    label + " left descendants; harness cleanup cannot turn this into GREEN",
  );
  contract(!execution.timedOut, label + " exceeded the harness timeout");
  contract(execution.status !== 0, label + " returned a positive process status");
  const report = parseRunReport(execution.output, label);
  contract(
    report.schema === "proof-or-stop.quorum-smoke-run.v1"
      && typeof report.runId === "string"
      && report.runId.length > 0
      && report.ok === false
      && report.status === expectedStatus
      && report.parentPid === execution.pid
      && report.callbackTraceNonce === callbackNonce
      && report.processTreeReaped === true
      && report.orphanedDescendants === false
      && Array.isArray(report.results),
    label + " omitted the versioned negative run/process-tree/nonce contract",
  );
  contract(
    report.mode === "fault-probe" && report.coordinator === "default-parent",
    label + " bypassed the real parent coordinator",
  );
  contract(
    report.maxConcurrent === 2 && report.shards.length >= 2 && report.results.length > 1,
    label + " did not exercise aggregate overlap and concurrent cancellation",
  );
  const cancelledSibling = report.shards.find((row) => (
    row.shardId !== "pure" && row.status !== "PASS"
  ));
  contract(
    cancelledSibling?.processTreeReaped === true
      && cancelledSibling?.orphanedDescendants === false
      && Object.values(cancelledSibling?.residue ?? {}).every((value) => value === 0),
    label + " did not independently reap and clean the concurrently cancelled shard",
  );
  assertReportResidue(report, label);
  return report;
}

async function runNegativeRealCli(args, label, expectedStatus) {
  const owner = createHarnessOwnedBase("b-e40f-negative-callback-");
  const ownedTempOwner = createHarnessOwnedBase("b-e40f-negative-owned-");
  const traceFile = createHarnessOwnedFile(owner, "callbacks.jsonl", label + " callback");
  const nonce = randomUUID();
  try {
    const execution = await smoke(args, 30_000, {
      env: {
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE: traceFile.realpath,
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE: nonce,
        PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE: ownedTempOwner.realpath,
      },
    });
    const report = parseNegativeRun(execution, label, nonce, expectedStatus);
    const trace = parseOwnedJsonLines(traceFile, label + " callback");
    const result = report.results.find((row) => resultCaseId(row) === "qsm-002");
    const starts = trace.rows.filter((row) => row.caseId === "qsm-002" && row.phase === "start");
    const ends = trace.rows.filter((row) => row.caseId === "qsm-002" && row.phase === "end");
    contract(
      report.callbackTraceDigest === createHash("sha256").update(trace.raw).digest("hex")
        && report.results.length > 1
        && result?.status === expectedStatus
        && Number(result?.attempts) === 1
        && starts.length === 1
        && ends.length === 1
        && trace.rows.every((row) => (
          row.schema === "proof-or-stop.quorum-smoke-callback-trace.v1"
            && row.nonce === nonce
            && row.runId === report.runId
        ))
        && trace.rows.indexOf(starts[0]) < trace.rows.indexOf(ends[0])
        && Number(result.startedAtMs) <= Number(starts[0].atMs)
        && Number(starts[0].atMs) <= Number(ends[0].atMs)
        && Number(ends[0].atMs) <= Number(result.endedAtMs)
        && ends[0].status === expectedStatus
        && !execution.output.includes("CASE_PASS qsm-002"),
      label + " callback trace is not bound to its negative report",
    );
    contract(
      report.ownedTempBase === ownedTempOwner.realpath && Array.isArray(report.ownedTempRoots),
      label + " did not bind fault cleanup to the harness-owned temp base",
    );
    for (const root of report.ownedTempRoots) {
      const normalized = assertOwnedPath(ownedTempOwner, root, label + " fault owned root", {
        mustExist: false,
        directory: true,
      }).normalized;
      assertOwnedPathAbsent(ownedTempOwner, normalized, label + " cleaned fault root");
    }
    contract(readdirSync(ownedTempOwner.path).length === 0, label + " left fault-injection residue");
    return report;
  } finally {
    try {
      cleanupHarnessOwnedBase(ownedTempOwner, label + " owned temp base");
    } finally {
      cleanupHarnessOwnedBase(owner, label + " callback trace base");
    }
  }
}

async function proveRealCoordinatorFaultSeam() {
  const failed = await runNegativeRealCli([
      "--jobs=2",
      "--report=json",
      "--coordinator-fault=fail:qsm-002",
    ],
    "real parent injected FAIL",
    "FAIL",
  );
  const failedRow = failed.results.find((row) => resultCaseId(row) === "qsm-002");
  contract(failedRow?.status === "FAIL", "real parent did not preserve injected child FAIL");
  contract(Number(failedRow.attempts) === 1, "real parent retried injected child FAIL");
  contract(Number(failed.retryCount) === 0, "real parent reports retry after child FAIL");

  const timedOut = await runNegativeRealCli([
      "--jobs=2",
      "--report=json",
      "--case-timeout-ms=300",
      "--coordinator-fault=timeout:qsm-002",
    ],
    "real parent injected TIMEOUT",
    "TIMEOUT",
  );
  const timeoutRow = timedOut.results.find((row) => resultCaseId(row) === "qsm-002");
  contract(timeoutRow?.status === "TIMEOUT", "real parent did not preserve injected child TIMEOUT");
  contract(Number(timeoutRow.attempts) === 1, "real parent retried injected child TIMEOUT");
  contract(Number(timedOut.retryCount) === 0, "real parent reports retry after child TIMEOUT");
  contract(
    timedOut.processTreeReaped === true,
    "real parent did not prove the timed-out worker process tree was reaped",
  );
}

async function proveCrossPlatformProcessTreeDispatch(worker) {
  contract(
    typeof worker.signalQuorumSmokeProcessTree === "function",
    "worker must export the dependency-injected cross-platform process-tree signal seam",
  );
  const runnerSource = worker.runQuorumSmokeWorkerProcess.toString();
  const terminateStart = runnerSource.indexOf("const terminateChild");
  const terminateEnd = runnerSource.indexOf("const onAbort", terminateStart);
  const terminateSource = runnerSource.slice(terminateStart, terminateEnd);
  contract(
    terminateStart >= 0 && terminateEnd > terminateStart
      && terminateSource.indexOf("descendantTracker?.capture()") >= 0
      && terminateSource.indexOf("descendantTracker?.capture()")
        < terminateSource.indexOf("descendantTracker?.killCurrent()")
      && terminateSource.indexOf("descendantTracker?.killCurrent()")
        < terminateSource.indexOf("signalOwnedProcessGroup(processGroup, 'SIGTERM')")
      && terminateSource.includes("signalOwnedProcessGroup(processGroup, 'SIGKILL')")
      && !terminateSource.includes("SIGSTOP")
      && !terminateSource.includes(".freeze()"),
    "timeout/cancel must use authenticated TERM-first cleanup without manufacturing stopped survivors",
  );
  const windowsCalls = [];
  const windowsResult = worker.signalQuorumSmokeProcessTree(456, "SIGTERM", {
    platform: "win32",
    kill: () => { throw new ContractFailure("Windows process-tree dispatch used POSIX kill"); },
    taskkill: (pid) => windowsCalls.push(pid),
  });
  contract(
    windowsResult === "signalled" && json(windowsCalls) === json([456]),
    "Windows process-tree dispatch did not use taskkill /PID tree ownership",
  );
  const windowsPosixSignalCalls = [];
  let windowsContRejected = false;
  try {
    worker.signalQuorumSmokeProcessTree(456, "SIGCONT", {
      platform: "win32",
      kill: (...args) => windowsPosixSignalCalls.push(["kill", ...args]),
      taskkill: (...args) => windowsPosixSignalCalls.push(["taskkill", ...args]),
    });
  } catch (error) {
    windowsContRejected = /refuses POSIX-only SIGCONT on win32/.test(String(error?.message));
  }
  contract(
    windowsContRejected && windowsPosixSignalCalls.length === 0,
    "Windows termination admitted POSIX SIGCONT or translated it into taskkill",
  );
  const posixCalls = [];
  const posixResult = worker.signalQuorumSmokeProcessTree(457, "SIGKILL", {
    platform: "linux",
    kill: (pid, signal) => posixCalls.push([pid, signal]),
    taskkill: () => { throw new ContractFailure("POSIX process-tree dispatch used taskkill"); },
  });
  contract(
    posixResult === "signalled" && json(posixCalls) === json([[-457, "SIGKILL"]]),
    "POSIX process-tree dispatch did not signal the owned negative PGID",
  );
  const absent = new Error("gone");
  absent.code = "ESRCH";
  contract(
    worker.signalQuorumSmokeProcessTree(458, "SIGTERM", {
      platform: "linux",
      kill: () => { throw absent; },
    }) === "absent",
    "process-tree dispatch did not recognize only ESRCH as absent",
  );
  const denied = new Error("denied");
  denied.code = "EPERM";
  let deniedObserved = false;
  try {
    worker.signalQuorumSmokeProcessTree(459, "SIGTERM", {
      platform: "win32",
      taskkill: () => { throw denied; },
    });
  } catch (error) {
    deniedObserved = /failed to signal.*win32/i.test(String(error?.message));
  }
  contract(deniedObserved, "Windows taskkill EPERM was treated as a reaped process tree");
  contract(
    typeof worker.reapQuorumSmokeWorkerDescendants === "function",
    "worker must export the dependency-injected descendant reconciliation seam",
  );
  let windowsChildAlive = true;
  const windowsDescendantCalls = [];
  const windowsReap = await worker.reapQuorumSmokeWorkerDescendants(500, {
    platform: "win32",
    snapshot: () => windowsChildAlive
      ? [{ pid: 501, ppid: 500, birthIdentity: "win-birth" }]
      : [],
    taskkill: (pid) => {
      windowsDescendantCalls.push(pid);
      windowsChildAlive = false;
    },
    signal: () => { throw new ContractFailure("Windows descendant reconciliation used POSIX signal"); },
    pause: async () => {},
  });
  contract(
    windowsReap.reaped === true && windowsReap.survivorPids.length === 0
      && json(windowsDescendantCalls) === json([501]),
    "Windows descendant reconciliation did not taskkill the authenticated child tree",
  );
  let reparentedWindowsAlive = true;
  const reparentedWindowsCalls = [];
  const reparentedWindowsIdentity = {
    pid: 511, ppid: 500, birthIdentity: "20260907001234.123456+000",
  };
  const reparentedWindowsReap = await worker.reapQuorumSmokeWorkerDescendants(500, {
    platform: "win32",
    initialIdentities: [reparentedWindowsIdentity],
    snapshot: () => reparentedWindowsAlive
      ? [{ ...reparentedWindowsIdentity, ppid: 1 }]
      : [],
    taskkill: (pid) => {
      reparentedWindowsCalls.push(pid);
      reparentedWindowsAlive = false;
    },
    signal: () => { throw new ContractFailure("Windows reparent recovery used POSIX signal"); },
    pause: async () => {},
  });
  contract(
    reparentedWindowsReap.reaped === true
      && reparentedWindowsReap.survivorPids.length === 0
      && json(reparentedWindowsCalls) === json([511]),
    "Windows reconciliation did not taskkill a tracker-captured reparent with exact CreationDate",
  );
  let posixChildAlive = true;
  const posixDescendantCalls = [];
  const posixReap = await worker.reapQuorumSmokeWorkerDescendants(600, {
    platform: "linux",
    snapshot: () => posixChildAlive
      ? [{ pid: 601, ppid: 600, birthIdentity: "posix-birth" }]
      : [],
    signal: (pid, signal) => {
      posixDescendantCalls.push([pid, signal]);
      if (signal === "SIGKILL") posixChildAlive = false;
    },
    taskkill: () => { throw new ContractFailure("POSIX descendant reconciliation used taskkill"); },
    pause: async () => {},
  });
  contract(
    posixReap.reaped === true && posixReap.survivorPids.length === 0
      && posixDescendantCalls.some(([pid, signal]) => pid === 601 && signal === "SIGSTOP")
      && posixDescendantCalls.some(([pid, signal]) => pid === 601 && signal === "SIGKILL"),
    "POSIX descendant reconciliation did not freeze and kill the authenticated descendant",
  );
  const ambiguousSignals = [];
  const ambiguousIdentity = { pid: 611, ppid: 600, birthIdentity: "Sun Sep  7 00:12:34 2026" };
  const ambiguousReap = await worker.reapQuorumSmokeWorkerDescendants(600, {
    platform: "linux",
    initialIdentities: [ambiguousIdentity],
    snapshot: () => [{ ...ambiguousIdentity, ppid: 1 }],
    signal: (pid, signal) => ambiguousSignals.push([pid, signal]),
    taskkill: () => { throw new ContractFailure("POSIX ambiguity probe used taskkill"); },
    pause: async () => {},
  });
  contract(
    ambiguousReap.reaped === false
      && json(ambiguousReap.survivorPids) === json([611])
      && ambiguousSignals.length === 0,
    "POSIX weak pid/lstart sample was signalled after ownership became ambiguous",
  );
}

async function proveDetachedDescendantContainment(worker) {
  contract(
    typeof worker.runQuorumSmokeWorkerProcess === "function",
    "worker must expose its real parent-owned worker-process runner for containment probes",
  );
  for (const mode of ["normal", "timeout", "cancel"]) {
    const owner = createHarnessOwnedBase(`b-e40f-detached-${mode}-`);
    const heartbeat = createHarnessOwnedFile(owner, "heartbeat.log", `${mode} descendant heartbeat`);
    const descendantPid = createHarnessOwnedFile(owner, "descendant.pid", `${mode} descendant pid`);
    const helper = createHarnessOwnedFile(owner, "worker-helper.mjs", `${mode} descendant helper`);
    const nativeExecutable = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
    const nativeArgs = process.platform === "win32"
      ? [
          "-NoProfile", "-NonInteractive", "-Command",
          "$pidPath=$args[0]; $heartbeat=$args[1]; "
            + "$marker=$env:PROOF_OR_STOP_QUORUM_SMOKE_WORKER_PROCESS_MARKER; "
            + "[IO.File]::WriteAllText($pidPath, \"$PID|$marker`n\"); "
            + "for ($i=0; $i -lt 100; $i++) { "
            + "[IO.File]::AppendAllText($heartbeat, \"beat`n\"); Start-Sleep -Milliseconds 50 }",
          descendantPid.realpath,
          heartbeat.realpath,
        ]
      : [
          "-c",
          'pid_path=$1; heartbeat=$2; '
            + 'printf "%s|%s\\n" "$$" "$PROOF_OR_STOP_QUORUM_SMOKE_WORKER_PROCESS_MARKER" > "$pid_path"; '
            + 'i=0; while [ "$i" -lt 100 ]; do printf "beat\\n" >> "$heartbeat"; '
            + 'i=$((i + 1)); sleep 0.05; done',
          "qsm-native-helper",
          descendantPid.realpath,
          heartbeat.realpath,
        ];
    const intermediateSource = [
      'const { spawn } = require("node:child_process");',
      `const child = spawn(${JSON.stringify(nativeExecutable)}, ${JSON.stringify(nativeArgs)}, `
        + '{ detached: true, stdio: "inherit" });',
      'child.unref();',
      'setTimeout(() => process.exit(0), 1600);',
    ].join("\n");
    const helperSource = [
      'import { spawn } from "node:child_process";',
      `import { runQuorumSmokeCoordinator } from ${JSON.stringify(pathToFileURL(workerDistPath).href)};`,
      `const mode = ${JSON.stringify(mode)};`,
      `const intermediateSource = ${JSON.stringify(intermediateSource)};`,
      'const registration = { id: "qsm-detached-probe", title: "detached probe", domain: "pure",'
        + ' shard: "pure", resources: [], callbackBound: true,'
        + ' registrationSource: "packages/main/src/tasks/quorum-submit-smoke-pure-cases.ts", run: async () => {',
      '  const intermediate = spawn(process.execPath, ["-e", intermediateSource],'
        + ' { stdio: "inherit" });',
      '  intermediate.unref();',
      '  await new Promise((resolve) => setTimeout(resolve, 150));',
      '  if (mode !== "normal") await new Promise(() => {});',
      '} };',
      'const report = await runQuorumSmokeCoordinator({ registrations: [registration], jobs: 1, timeoutMs: 60000,'
        + ' context: { execution: "cli", mode: "worker", runId: "detached-helper" } });',
      'console.log(JSON.stringify(report));',
      'if (!report.ok) process.exitCode = 1;',
    ].join("\n");
    writeHarnessOwnedFile(helper, `${mode} descendant helper`, helperSource);
    const controller = new AbortController();
    let abortTimer = null;
    let escaped = false;
    let result = null;
    let launchedIdentity = null;
    let launchedMarker = null;
    try {
      if (mode === "cancel") abortTimer = setTimeout(() => controller.abort(), 450);
      const workerPromise = worker.runQuorumSmokeWorkerProcess(
        helper.realpath,
        [],
        `detached-${mode}-${randomUUID()}`,
        mode === "timeout" ? 450 : 5_000,
        {
          TMPDIR: owner.realpath,
          TMP: owner.realpath,
          TEMP: owner.realpath,
          PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE: owner.realpath,
        },
        controller.signal,
      );
      const launchDeadline = Date.now() + 2_000;
      let pidRecord = "";
      while (!pidRecord && Date.now() < launchDeadline) {
        pidRecord = readHarnessOwnedFile(descendantPid, `${mode} descendant launch record`, "utf8").trim();
        if (!pidRecord) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
      if (!pidRecord) {
        result = await workerPromise;
        throw new ContractFailure(
          `${mode} detached-descendant probe never launched its native background topology: ${result.output}`,
        );
      }
      const [pidText, marker] = pidRecord.split("|");
      const launchedPid = Number(pidText);
      launchedMarker = marker;
      contract(Number.isSafeInteger(launchedPid) && launchedPid > 1 && Boolean(launchedMarker),
        `${mode} detached-descendant probe emitted an invalid native launch record`);
      launchedIdentity = snapshotHarnessProcess(launchedPid);
      contract(
        launchedIdentity?.pid === launchedPid && launchedIdentity.birthIdentity.length > 0,
        `${mode} detached-descendant probe did not bind the launched process identity`,
      );
      result = await workerPromise;
      if (abortTimer) clearTimeout(abortTimer);
      const bytesAtExit = readHarnessOwnedFile(heartbeat, `${mode} heartbeat at exit`).length;
      contract(bytesAtExit > 0, `${mode} detached-descendant probe produced no heartbeat`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 180));
      const bytesAfter = readHarnessOwnedFile(heartbeat, `${mode} heartbeat after exit`).length;
      escaped = bytesAfter > bytesAtExit;
      const current = snapshotHarnessProcess(launchedPid);
      const sameProcessAlive = current?.birthIdentity === launchedIdentity.birthIdentity
        && !current.state?.startsWith("Z");
      contract(result.processTreeReaped === true && !escaped && !sameProcessAlive,
        `${mode} worker reported a reaped tree while a detached inherited-pipe descendant survived: `
          + json({ result, bytesAtExit, bytesAfter, sameProcessAlive, processState: current?.state }));
      if (mode === "normal") contract(result.status === 0 && !result.timedOut && !result.cancelled,
        "normal detached-descendant probe did not complete through the real worker path: " + json(result));
      if (mode === "timeout") contract(result.timedOut === true,
        "detached-descendant timeout probe did not exercise the parent timeout path");
      if (mode === "cancel") contract(result.cancelled === true,
        "detached-descendant cancel probe did not exercise the parent cancel path");
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
      let current = launchedIdentity ? snapshotHarnessProcess(launchedIdentity.pid) : null;
      if (current?.birthIdentity === launchedIdentity?.birthIdentity && current.state?.startsWith("Z")) {
        const zombieDeadline = Date.now() + 2_000;
        while (current?.birthIdentity === launchedIdentity.birthIdentity
          && current.state?.startsWith("Z") && Date.now() < zombieDeadline) {
          await new Promise((resolveWait) => setTimeout(resolveWait, 25));
          current = snapshotHarnessProcess(launchedIdentity.pid);
        }
      }
      if (current && launchedIdentity && current.birthIdentity === launchedIdentity.birthIdentity
        && !current.state?.startsWith("Z")) {
        const cleanup = await worker.reapQuorumSmokeWorkerDescendants(result?.pid ?? process.pid, {
          initialIdentities: [launchedIdentity],
          initialIdentitiesAreStopped: process.platform !== "win32" && current.state?.startsWith("T"),
          marker: launchedMarker,
        });
        current = snapshotHarnessProcess(launchedIdentity.pid);
        contract(
          cleanup.reaped && current?.birthIdentity !== launchedIdentity.birthIdentity,
          `${mode} detached probe retained ${owner.path}: its authenticated native helper survived cleanup: `
            + json({ cleanup, current, result }),
        );
      }
      cleanupHarnessOwnedBase(owner, `${mode} detached-descendant probe`);
    }
  }
  await proveCoordinatorLossAfterWorkerTerm(worker);
}

async function proveCoordinatorLossAfterWorkerTerm(worker) {
  if (process.platform === "win32") return;
  const owner = createHarnessOwnedBase("b-e40f-worker-term-first-");
  const workerRecord = createHarnessOwnedFile(owner, "worker.json", "TERM-first worker identity");
  const childRecord = createHarnessOwnedFile(owner, "child.txt", "TERM-first descendant identity");
  const childHeartbeat = createHarnessOwnedFile(owner, "child-heartbeat.log", "TERM-first descendant heartbeat");
  const termReceipt = createHarnessOwnedFile(owner, "term.receipt", "TERM-first worker receipt");
  const signalTrace = createHarnessOwnedFile(owner, "signals.jsonl", "TERM-first signal trace");
  const target = createHarnessOwnedFile(owner, "worker-target.mjs", "TERM-first worker target");
  const parent = createHarnessOwnedFile(owner, "worker-parent.mjs", "TERM-first worker parent");
  const parentMarker = "b-e40f-term-parent-" + randomUUID();
  writeHarnessOwnedFile(target, "TERM-first worker target", [
    'import { writeFileSync } from "node:fs";',
    'import { spawn } from "node:child_process";',
    'writeFileSync(process.argv[2], JSON.stringify({',
    '  pid: process.pid, marker: process.env.PROOF_OR_STOP_QUORUM_SMOKE_WORKER_PROCESS_MARKER,',
    '}));',
    'const child = spawn("/bin/sh", ["-c",',
    '  "printf \'%s|%s\\\\n\' \\"$$\\" \\"$PROOF_OR_STOP_QUORUM_SMOKE_WORKER_PROCESS_MARKER\\" > \\"$1\\"; "',
    '    + "while :; do printf \'beat\\\\n\' >> \\"$2\\"; sleep 0.02; done",',
    '  "term-first-child", process.argv[4], process.argv[5],',
    '], { detached: true, env: process.env, stdio: "ignore" });',
    'child.unref();',
    'const coordinatorPid = process.ppid;',
    'process.once("SIGTERM", () => {',
    '  writeFileSync(process.argv[3], "TERM_DELIVERED\\n");',
    '  const parentWatch = setInterval(() => {',
    '    let parentGone = process.ppid !== coordinatorPid;',
    '    if (!parentGone) {',
    '      try { process.kill(coordinatorPid, 0); }',
    '      catch (error) { parentGone = error?.code === "ESRCH"; }',
    '    }',
    '    if (parentGone) { clearInterval(parentWatch); process.exit(143); }',
    '  }, 5);',
    '});',
    'setInterval(() => {}, 1_000);',
  ].join("\n"));
  writeHarnessOwnedFile(parent, "TERM-first worker parent", [
    `import { runQuorumSmokeWorkerProcess } from ${json(pathToFileURL(workerDistPath).href)};`,
    'import { appendFileSync } from "node:fs";',
    `const originalKill = process.kill.bind(process);`,
    'process.kill = (pid, signal) => {',
    '  const result = originalKill(pid, signal);',
    `  appendFileSync(${json(signalTrace.realpath)}, JSON.stringify({ pid, signal: signal ?? 0 }) + "\\n");`,
    '  return result;',
    '};',
    'const controller = new AbortController();',
    `void runQuorumSmokeWorkerProcess(${json(target.realpath)},`,
    `  [${json(workerRecord.realpath)}, ${json(termReceipt.realpath)},`,
    `    ${json(childRecord.realpath)}, ${json(childHeartbeat.realpath)}],`,
    '  "term-first-parent-loss", 2_000, {',
    `    TMPDIR: ${json(owner.realpath)}, TMP: ${json(owner.realpath)}, TEMP: ${json(owner.realpath)},`,
    `    PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE: ${json(owner.realpath)},`,
    '  }, controller.signal).catch(() => undefined);',
    'setInterval(() => {}, 1_000);',
  ].join("\n"));

  const parentChild = spawn(process.execPath, ["--title=" + parentMarker, parent.realpath], {
    cwd: repoRoot,
    env: harnessChildEnvironment(),
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  let parentIdentity = null;
  let workerIdentity = null;
  let childIdentity = null;
  let workerMarker = null;
  let childMarker = null;
  let parentTerminal = false;
  parentChild.once("exit", () => { parentTerminal = true; });
  parentChild.once("error", () => { parentTerminal = true; });
  try {
    const parentBindDeadline = Date.now() + 2_000;
    while (!parentIdentity && Date.now() < parentBindDeadline) {
      const parentState = inspectHarnessProcess(parentChild.pid);
      if (parentState.kind === "error") {
        throw new ContractFailure("TERM-first parent census failed: " + parentState.error);
      }
      if (parentState.kind === "present" && parentState.identity.marker?.includes(parentMarker)) {
        parentIdentity = parentState.identity;
        break;
      }
      await wait(10);
    }
    contract(
      parentIdentity?.pid === parentChild.pid && parentIdentity.marker?.includes(parentMarker),
      "TERM-first parent-loss probe could not authenticate its parent immediately after spawn",
    );
    const launchDeadline = Date.now() + 4_000;
    let rawIdentity = "";
    let rawChildIdentity = "";
    while ((!rawIdentity || !rawChildIdentity) && Date.now() < launchDeadline) {
      rawIdentity = readHarnessOwnedFile(workerRecord, "TERM-first worker identity", "utf8").trim();
      rawChildIdentity = readHarnessOwnedFile(childRecord, "TERM-first descendant identity", "utf8").trim();
      if (!rawIdentity || !rawChildIdentity) await wait(10);
    }
    contract(Boolean(rawIdentity) && Boolean(rawChildIdentity),
      "TERM-first parent-loss probe did not launch its worker and detached descendant");
    const parsedIdentity = JSON.parse(rawIdentity);
    const [childPidText, recordedChildMarker] = rawChildIdentity.split("|");
    workerMarker = parsedIdentity.marker;
    childMarker = recordedChildMarker;
    const workerState = inspectHarnessProcess(Number(parsedIdentity.pid));
    const childState = inspectHarnessProcess(Number(childPidText));
    workerIdentity = workerState.kind === "present" ? workerState.identity : null;
    childIdentity = childState.kind === "present" ? childState.identity : null;
    contract(
      workerIdentity?.pid === Number(parsedIdentity.pid)
        && typeof workerMarker === "string" && workerMarker.length >= 16
        && workerIdentity.marker?.includes(workerMarker),
      "TERM-first parent-loss probe could not authenticate its worker: " + json(workerState),
    );
    contract(
      childIdentity?.pid === Number(childPidText)
        && childIdentity.ppid === workerIdentity.pid
        && childMarker === workerMarker
        && childIdentity.marker?.includes(childRecord.realpath),
      "TERM-first parent-loss probe could not authenticate its detached descendant: " + json(childState),
    );

    const traceDeadline = Date.now() + 4_000;
    let signals = [];
    let workerStoppedObserved = false;
    let childStoppedObserved = false;
    let workerCensusError = null;
    let childCensusError = null;
    while (Date.now() < traceDeadline) {
      signals = parseOwnedJsonLines(signalTrace, "TERM-first signal trace").rows;
      const observedWorker = inspectHarnessProcess(workerIdentity.pid);
      const observedChild = inspectHarnessProcess(childIdentity.pid);
      if (observedWorker.kind === "error") workerCensusError = observedWorker.error;
      if (observedChild.kind === "error") childCensusError = observedChild.error;
      if (observedWorker.kind === "present"
        && observedWorker.identity.birthIdentity === workerIdentity.birthIdentity
        && observedWorker.identity.state?.startsWith("T")) workerStoppedObserved = true;
      if (observedChild.kind === "present"
        && observedChild.identity.birthIdentity === childIdentity.birthIdentity
        && observedChild.identity.state?.startsWith("T")) childStoppedObserved = true;
      if (signals.some((row) => row.pid === -workerIdentity.pid && row.signal === "SIGTERM")) break;
      await wait(5);
    }
    contract(
      signals.some((row) => row.pid === -workerIdentity.pid && row.signal === "SIGTERM"),
      "TERM-first parent-loss probe did not observe authenticated worker TERM",
    );
    contract(
      !signals.some((row) => row.pid === -workerIdentity.pid && row.signal === "SIGSTOP"),
      "worker timeout froze the process group before TERM",
    );
    const childKillIndex = signals.findIndex((row) => (
      row.pid === childIdentity.pid && row.signal === "SIGKILL"
    ));
    const workerTermIndex = signals.findIndex((row) => (
      row.pid === -workerIdentity.pid && row.signal === "SIGTERM"
    ));
    contract(
      childKillIndex >= 0 && childKillIndex < workerTermIndex,
      "current detached descendant was not identity-killed before worker TERM: " + json(signals),
    );
    contract(
      !workerStoppedObserved && !childStoppedObserved
        && workerCensusError === null && childCensusError === null,
      "worker tree entered T state or its identity census failed before TERM: "
        + json({ workerStoppedObserved, childStoppedObserved, workerCensusError, childCensusError }),
    );
    const heartbeatAtTerm = readHarnessOwnedFile(
      childHeartbeat,
      "TERM-first descendant heartbeat at TERM",
    ).length;
    contract(heartbeatAtTerm > 0, "TERM-first detached descendant produced no heartbeat");
    const termBarrierDeadline = Date.now() + 150;
    let liveWorkerAtParentLoss = null;
    let childStateAtParentLoss = inspectHarnessProcess(childIdentity.pid);
    while (Date.now() < termBarrierDeadline) {
      const candidate = inspectHarnessProcess(workerIdentity.pid);
      childStateAtParentLoss = inspectHarnessProcess(childIdentity.pid);
      if (readHarnessOwnedFile(termReceipt, "TERM-first worker receipt", "utf8") === "TERM_DELIVERED\n"
        && candidate.kind === "present"
        && candidate.identity.birthIdentity === workerIdentity.birthIdentity
        && !candidate.identity.state?.startsWith("Z")
        && !candidate.identity.state?.startsWith("T")
        && boundProcessTerminal(childStateAtParentLoss, childIdentity)) {
        liveWorkerAtParentLoss = candidate.identity;
        break;
      }
      await wait(5);
    }
    contract(
      liveWorkerAtParentLoss?.birthIdentity === workerIdentity.birthIdentity
        && liveWorkerAtParentLoss.marker?.includes(workerMarker)
        && boundProcessTerminal(childStateAtParentLoss, childIdentity),
      "TERM barrier did not keep the exact worker live after killing its detached descendant: "
        + json({ liveWorkerAtParentLoss, childStateAtParentLoss }),
    );
    const currentParentState = inspectHarnessProcess(parentIdentity.pid);
    const currentParent = currentParentState.kind === "present" ? currentParentState.identity : null;
    contract(
      currentParent?.birthIdentity === parentIdentity.birthIdentity
        && currentParent.marker?.includes(parentMarker),
      "TERM-first parent identity changed before the parent-loss trigger: " + json(currentParentState),
    );
    process.kill(currentParent.pid, "SIGKILL");
    const parentDeadline = Date.now() + 1_000;
    while (!parentTerminal && Date.now() < parentDeadline) await wait(10);
    contract(parentTerminal, "TERM-first parent did not reach a terminal event");

    const workerDeadline = Date.now() + 1_000;
    let currentWorkerState = inspectHarnessProcess(workerIdentity.pid);
    let currentChildState = inspectHarnessProcess(childIdentity.pid);
    while ((!boundProcessTerminal(currentWorkerState, workerIdentity)
      || !boundProcessTerminal(currentChildState, childIdentity)) && Date.now() < workerDeadline) {
      if (currentWorkerState.kind === "present"
        && currentWorkerState.identity.birthIdentity === workerIdentity.birthIdentity
        && currentWorkerState.identity.state?.startsWith("T")) workerStoppedObserved = true;
      if (currentChildState.kind === "present"
        && currentChildState.identity.birthIdentity === childIdentity.birthIdentity
        && currentChildState.identity.state?.startsWith("T")) childStoppedObserved = true;
      if (currentWorkerState.kind === "error") break;
      if (currentChildState.kind === "error") break;
      await wait(10);
      currentWorkerState = inspectHarnessProcess(workerIdentity.pid);
      currentChildState = inspectHarnessProcess(childIdentity.pid);
    }
    await wait(100);
    const heartbeatAfter = readHarnessOwnedFile(
      childHeartbeat,
      "TERM-first descendant heartbeat after parent loss",
    ).length;
    contract(
      readHarnessOwnedFile(termReceipt, "TERM-first worker receipt", "utf8") === "TERM_DELIVERED\n"
        && !workerStoppedObserved && !childStoppedObserved
        && boundProcessTerminal(currentWorkerState, workerIdentity)
        && boundProcessTerminal(currentChildState, childIdentity)
        && heartbeatAfter === heartbeatAtTerm,
      "coordinator loss after TERM retained the authenticated worker tree: "
        + json({
          currentWorkerState, currentChildState, workerStoppedObserved,
          childStoppedObserved, heartbeatAtTerm, heartbeatAfter, signals,
        }),
    );
  } finally {
    const cleanupErrors = [];
    const recoverIdentity = (identity, pidHint, uniqueMarker, label) => {
      if (identity) return identity;
      if (Number.isSafeInteger(pidHint) && pidHint > 1) {
        const state = inspectHarnessProcess(pidHint);
        if (state.kind === "error") cleanupErrors.push(`${label} census: ${state.error}`);
        if (state.kind === "present" && state.identity.marker?.includes(uniqueMarker)) {
          return state.identity;
        }
        if (state.kind === "present") cleanupErrors.push(`${label} pid is present without its marker`);
      }
      try {
        const candidates = snapshotExactHeadProcesses().filter((row) => (
          !row.state?.startsWith("Z") && row.marker?.includes(uniqueMarker)
        ));
        if (candidates.length === 1) return candidates[0];
        if (candidates.length > 1) cleanupErrors.push(`${label} marker matched multiple processes`);
      } catch (error) {
        cleanupErrors.push(`${label} full census: ${error.message}`);
      }
      return null;
    };
    parentIdentity = recoverIdentity(
      parentIdentity,
      parentChild.pid,
      parentMarker,
      "TERM-first parent",
    );
    let recordedWorkerPid = null;
    let recordedChildPid = null;
    try {
      const rawWorker = readHarnessOwnedFile(workerRecord, "TERM-first cleanup worker identity", "utf8").trim();
      if (rawWorker) {
        const parsed = JSON.parse(rawWorker);
        recordedWorkerPid = Number(parsed.pid);
        workerMarker ??= parsed.marker;
      }
      const rawChild = readHarnessOwnedFile(childRecord, "TERM-first cleanup child identity", "utf8").trim();
      if (rawChild) {
        const [pidText, marker] = rawChild.split("|");
        recordedChildPid = Number(pidText);
        childMarker ??= marker;
      }
    } catch (error) {
      cleanupErrors.push("TERM-first identity record: " + error.message);
    }
    workerIdentity = recoverIdentity(
      workerIdentity,
      recordedWorkerPid,
      workerMarker || target.realpath,
      "TERM-first worker",
    );
    childIdentity = recoverIdentity(
      childIdentity,
      recordedChildPid,
      childRecord.realpath,
      "TERM-first descendant",
    );
    const bindings = [
      { label: "parent", identity: parentIdentity, marker: parentMarker },
      { label: "worker", identity: workerIdentity, marker: workerMarker },
      { label: "descendant", identity: childIdentity, marker: childRecord.realpath },
    ];
    for (const binding of bindings) {
      if (!binding.identity || !binding.marker) {
        cleanupErrors.push(`${binding.label} identity was never bound`);
        continue;
      }
      let state = inspectHarnessProcess(binding.identity.pid);
      if (state.kind === "error") {
        cleanupErrors.push(`${binding.label} cleanup census: ${state.error}`);
        continue;
      }
      if (state.kind === "present"
        && state.identity.birthIdentity === binding.identity.birthIdentity
        && !state.identity.state?.startsWith("Z")) {
        if (!state.identity.marker?.includes(binding.marker)) {
          cleanupErrors.push(`${binding.label} cleanup marker changed`);
          continue;
        }
        if (state.identity.state?.startsWith("T")) {
          try { process.kill(state.identity.pid, "SIGCONT"); }
          catch (error) { if (error?.code !== "ESRCH") cleanupErrors.push(`${binding.label} CONT: ${error.message}`); }
          await wait(25);
          state = inspectHarnessProcess(binding.identity.pid);
        }
        if (state.kind === "present"
          && state.identity.birthIdentity === binding.identity.birthIdentity
          && !state.identity.state?.startsWith("Z")) {
          if (!state.identity.marker?.includes(binding.marker)) {
            cleanupErrors.push(`${binding.label} marker changed before KILL`);
          } else {
            try { process.kill(state.identity.pid, "SIGKILL"); }
            catch (error) { if (error?.code !== "ESRCH") cleanupErrors.push(`${binding.label} KILL: ${error.message}`); }
          }
        }
      }
    }
    const cleanupDeadline = Date.now() + 1_500;
    let finalStates = bindings.map((binding) => (
      binding.identity ? inspectHarnessProcess(binding.identity.pid) : { kind: "error", error: "unbound" }
    ));
    while (Date.now() < cleanupDeadline
      && finalStates.some((state, index) => !boundProcessTerminal(state, bindings[index].identity))) {
      if (finalStates.some((state) => state.kind === "error")) break;
      await wait(10);
      finalStates = bindings.map((binding) => inspectHarnessProcess(binding.identity.pid));
    }
    const cleanupProven = cleanupErrors.length === 0
      && finalStates.every((state, index) => boundProcessTerminal(state, bindings[index].identity));
    contract(
      cleanupProven,
      `TERM-first parent-loss teardown retained ${owner.path}: `
        + json({ cleanupErrors, finalStates, bindings }),
    );
    cleanupHarnessOwnedBase(owner, "TERM-first parent-loss probe");
  }
}

async function resourceParallelContract() {
  const config = readJsonTarget(configPath, "resource-parallel-contract config");
  const commands = config?.validate?.commands;
  contract(Array.isArray(commands), "proof-or-stop config has no validate.commands array");
  const quorumRows = commands.filter((command) => (
    command.command === "node"
      && Array.isArray(command.args)
      && command.args.includes("packages/main/dist/tasks/quorum-submit-smoke.js")
  ));
  contract(quorumRows.length === 1, "expected exactly one configured quorum-submit-smoke command");
  const quorumRow = quorumRows[0];
  const expectedClaims = [{ class: "git-common-dir", key: ".", access: "shared" }];
  contract(
    json(canonicalResourceClaims(quorumRow.resources)) === json(expectedClaims),
    "quorum validation resource claim must exactly describe shared repository reads; "
      + "per-worker temporary writes are unique and must not be forged as a shared repo path. actual="
      + json(canonicalResourceClaims(quorumRow.resources)),
  );
  contract(
    quorumRow.args.includes("--jobs=2")
      || quorumRow.env?.PROOF_OR_STOP_QUORUM_SMOKE_JOBS === "2",
    "configured quorum validation must select bounded jobs=2 explicitly",
  );

  const worker = await loadWorkerContract("resource-parallel-contract");
  contract(
    exactHeadOuterSupervisorSafetyProven,
    "resource-parallel isolation did not bind its outer supervisor-safety proof",
  );
  await proveFixtureAndEnvironmentSourceClosure(worker);
  await proveCrossPlatformProcessTreeDispatch(worker);
  await proveDetachedDescendantContainment(worker);
  await proveProtectedMutationGuard(worker);
  await proveProtectedTraceSinkRejection();
  await proveSiblingWorktreeProtection();
  await proveAmbientGitRoutingIsolation();
  await proveTracedEnvironmentClosureAndDynTemp(worker);
  const maxJobs = worker.MAX_QUORUM_SMOKE_JOBS;
  const guardedRegistration = {
    id: "behavior-invalid-bound",
    title: "Harness invalid bound guard",
    domain: "pure",
    shard: "behavior-probe",
    resources: [],
    run: () => { throw new ContractFailure("guarded registration executed before bounds rejection"); },
  };
  for (const invalid of [0, -1, "nope", maxJobs + 1]) {
    await expectRejected(
      () => worker.runQuorumSmokeCoordinator(coordinatorProbeOptions(
        [guardedRegistration], invalid, 1_000, "harness-invalid-jobs",
      )),
      /jobs.*(?:positive|integer|between|maximum|bounded|<=)/i,
      "invalid jobs=" + invalid,
    );
  }
  contract(
    typeof worker.validateQuorumSmokeResourceTrace === "function",
    "worker module must export validateQuorumSmokeResourceTrace",
  );
  await proveTransactionalTempAllocation();
  await expectRejected(
    () => worker.validateQuorumSmokeResourceTrace({
      claims: quorumRow.resources,
      trace: {
        nonce: "forged",
        runId: "forged",
        ownedTempBase: repoRoot,
        ownedTempRoots: [join(repoRoot, "never-created-worker")],
        accesses: [],
      },
      repositoryRoot: repoRoot,
    }),
    /trusted.*(?:expected|callback|report)|proof/i,
    "self-reported resource envelope without trusted execution proof",
  );
  const before = gitStatus();
  await proveHarnessOwnedBehaviorExecution(worker);
  contract(gitStatus() === before, "harness closure coordinator probe changed repository state");
  let serial = null;
  let parallel = null;
  try {
    serial = await runTracedFullAggregate(1);
    parallel = await runTracedFullAggregate(2);
    assertConfiguredOfficialEnvironmentClosure(parallel, quorumRow);
    assertRealResourceTrace(serial, "real jobs=1");
    assertRealResourceTrace(parallel, "real jobs=2");
    const validateTrace = (run) => worker.validateQuorumSmokeResourceTrace({
      claims: quorumRow.resources,
      trace: resourceTraceEnvelope(run),
      repositoryRoot: repoRoot,
      proof: resourceTraceProof(run),
    });
    await validateTrace(serial);
    await validateTrace(parallel);
    await expectRejected(
      () => worker.validateQuorumSmokeResourceTrace({
        claims: quorumRow.resources,
        trace: resourceTraceEnvelope(parallel),
        repositoryRoot: repoRoot,
        proof: {
          ...resourceTraceProof(parallel),
          report: { ...parallel.report, callbackTraceDigest: "0".repeat(64) },
        },
      }),
      /callback.*digest|authentic parent run|proof/i,
      "tampered parent callback-trace digest",
    );
    await expectRejected(
      () => worker.validateQuorumSmokeResourceTrace({
        claims: quorumRow.resources,
        trace: resourceTraceEnvelope(parallel),
        repositoryRoot: repoRoot,
        proof: {
          ...resourceTraceProof(parallel),
          report: {
            ...parallel.report,
            processTreeReaped: false,
            orphanedDescendants: true,
            residue: { temp: 9, process: 9, ticket: 9, quarantine: 9 },
          },
        },
      }),
      /authentic parent run|process|orphan|residue|proof/i,
      "tampered parent cleanup verdict",
    );
    const truncatedAccesses = [...parallel.accesses];
    const removedFixtureIndex = truncatedAccesses.findIndex((access) => (
      access.resource === "fixture" && access.op === "write"
    ));
    contract(removedFixtureIndex >= 0, "resource truncation mutation needs a real fixture write");
    truncatedAccesses.splice(removedFixtureIndex, 1);
    await expectRejected(
      () => worker.validateQuorumSmokeResourceTrace({
        claims: quorumRow.resources,
        trace: resourceTraceEnvelope(parallel, {
          accesses: truncatedAccesses,
          raw: truncatedAccesses.map((row) => json(row)).join("\n") + "\n",
        }),
        repositoryRoot: repoRoot,
        proof: resourceTraceProof(parallel),
      }),
      /resource.*(?:digest|count)|fixture writes|authentic parent run|proof/i,
      "truncated real fixture-write trace",
    );
    const authenticAccess = parallel.accesses.find((access) => access.op === "write")
      ?? parallel.accesses[0];
    const forgedWriteAccesses = [...parallel.accesses, {
      ...authenticAccess,
      op: "write",
      path: configPath,
    }];
    const forgedWriteRaw = forgedWriteAccesses.map((row) => json(row)).join("\n") + "\n";
    await expectRejected(
      () => worker.validateQuorumSmokeResourceTrace({
        claims: quorumRow.resources,
        trace: resourceTraceEnvelope(parallel, {
          accesses: forgedWriteAccesses,
          raw: forgedWriteRaw,
        }),
        repositoryRoot: repoRoot,
        proof: {
          ...resourceTraceProof(parallel),
          report: {
            ...parallel.report,
            resourceTraceDigest: createHash("sha256").update(forgedWriteRaw).digest("hex"),
            resourceTraceCount: forgedWriteAccesses.length,
          },
        },
      }),
      /write.*(?:repo|repository)|repository.*write|outside.*owned/i,
      "forged repository write trace",
    );
    const firstOwned = parallel.report.ownedTempRoots[0];
    const firstIdentity = parallel.report.ownedTempRootIdentities.find((row) => row.path === firstOwned);
    contract(Boolean(firstIdentity), "overlapping-root mutation needs the parent-owned root identity");
    const overlappingRoot = join(firstOwned, "overlap");
    const overlappingRoots = [...parallel.report.ownedTempRoots, overlappingRoot];
    const overlappingIdentities = [
      ...parallel.report.ownedTempRootIdentities,
      { ...firstIdentity, path: overlappingRoot },
    ];
    await expectRejected(
      () => worker.validateQuorumSmokeResourceTrace({
        claims: quorumRow.resources,
        trace: resourceTraceEnvelope(parallel, {
          ownedTempRoots: overlappingRoots,
        }),
        repositoryRoot: repoRoot,
        proof: {
          ...resourceTraceProof(parallel),
          report: {
            ...parallel.report,
            ownedTempRoots: overlappingRoots,
            ownedTempRootIdentities: overlappingIdentities,
          },
        },
      }),
      /overlap/i,
      "overlapping worker-owned roots",
    );
    const crossRootAccess = parallel.accesses.find((access) => access.resource === "fixture");
    const otherRoot = parallel.report.ownedTempRoots.find((root) => root !== crossRootAccess?.workerRoot);
    contract(Boolean(crossRootAccess && otherRoot), "cross-root mutation needs two real worker roots");
    const crossRootAccesses = parallel.accesses.map((access) => access === crossRootAccess
      ? { ...access, path: join(otherRoot, "forged-cross-root-write") }
      : access);
    const crossRootRaw = crossRootAccesses.map((row) => json(row)).join("\n") + "\n";
    await expectRejected(
      () => worker.validateQuorumSmokeResourceTrace({
        claims: quorumRow.resources,
        trace: resourceTraceEnvelope(parallel, {
          accesses: crossRootAccesses,
          raw: crossRootRaw,
        }),
        repositoryRoot: repoRoot,
        proof: {
          ...resourceTraceProof(parallel),
          report: {
            ...parallel.report,
            resourceTraceDigest: createHash("sha256").update(crossRootRaw).digest("hex"),
            resourceTraceCount: crossRootAccesses.length,
          },
        },
      }),
      /root|escaped|trusted execution/i,
      "cross-root worker write",
    );
    const serialVerdicts = serial.report.results
      .map((row) => [resultCaseId(row), row.status]).sort();
    const parallelVerdicts = parallel.report.results
      .map((row) => [resultCaseId(row), row.status]).sort();
    contract(
      json(serialVerdicts) === json(parallelVerdicts)
        && serialVerdicts.length === EXPECTED_CASES.length,
      "real jobs=1/jobs=2 exact 73-case verdict parity failed",
    );
    await proveRealCoordinatorFaultSeam();
    contract(gitStatus() === before, "real parallel contract changed repository state");
    console.log(
      "PARALLEL_PASS jobs=2 cases=" + parallel.report.results.length + " residue=0",
    );
  } finally {
    try {
      cleanupResourceRun(serial, "serial resource run");
    } finally {
      cleanupResourceRun(parallel, "parallel resource run");
    }
  }
}

const PERFORMANCE_CAPABILITY = Object.freeze({
  schema: "proof-or-stop.quorum-smoke-parallel-capability.v1",
  shardCount: 4,
  workerModel: "one-process-per-shard",
  tempIsolation: "parent-owned-roots-v1",
});

function assertPerformanceSourceCapability() {
  contract(existsSync(workerSourcePath), "performance worker source is absent: " + workerSourcePath);
  const source = ts.createSourceFile(
    workerSourcePath,
    readFileSync(workerSourcePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const matches = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)
      || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)
        && declaration.name.text === "QUORUM_SMOKE_PARALLEL_CAPABILITY") matches.push(declaration);
    }
  }
  contract(
    matches.length === 1 && Boolean(matches[0].initializer),
    "parallel performance source capability is absent; expected one exported const QUORUM_SMOKE_PARALLEL_CAPABILITY",
  );
  const unwrap = (input) => {
    let node = input;
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node)
      || (typeof ts.isSatisfiesExpression === "function" && ts.isSatisfiesExpression(node))) {
      node = node.expression;
    }
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === "Object"
      && node.expression.name.text === "freeze"
      && node.arguments.length === 1) return unwrap(node.arguments[0]);
    return node;
  };
  const object = unwrap(matches[0].initializer);
  contract(
    ts.isObjectLiteralExpression(object),
    "parallel performance source capability must be a static literal object",
  );
  const actual = {};
  for (const property of object.properties) {
    contract(
      ts.isPropertyAssignment(property)
        && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))
        && !Object.hasOwn(actual, property.name.text),
      "parallel performance source capability contains a dynamic or duplicate property",
    );
    const value = unwrap(property.initializer);
    contract(
      ts.isStringLiteralLike(value) || ts.isNumericLiteral(value),
      "parallel performance source capability property " + property.name.text + " is not literal",
    );
    actual[property.name.text] = ts.isNumericLiteral(value) ? Number(value.text) : value.text;
  }
  contract(
    Object.keys(actual).length === Object.keys(PERFORMANCE_CAPABILITY).length
      && Object.entries(PERFORMANCE_CAPABILITY).every(([key, value]) => actual[key] === value),
    "parallel performance source capability is not ready for the nine-run protocol; expected="
      + json(PERFORMANCE_CAPABILITY) + " actual=" + json(actual),
  );
}

function performanceStop(reason) {
  console.log("PERFORMANCE_STOP " + reason);
  throw new ContractFailure("performance protocol stopped: " + reason);
}

function measurementEnvironment() {
  const env = { ...process.env };
  const trustedTracer = realpathSync(join(repoRoot, "packages/main/src/core/validation-runtime-tracer.cjs"));
  const isTrustedTracer = (operand) => {
    if (typeof operand !== "string" || !isAbsolute(operand)) return false;
    try { return realpathSync(operand) === trustedTracer; } catch { return false; }
  };
  const raw = String(env.NODE_OPTIONS ?? "");
  const tokens = raw.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => (
    /^(["']).*\1$/.test(token) ? token.slice(1, -1) : token
  )) ?? [];
  const retained = [];
  let removedOfficialTracer = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const following = tokens[index + 1];
    if ((token === "--require" || token === "-r")
      && isTrustedTracer(following)) {
      removedOfficialTracer = true;
      index += 1;
      continue;
    }
    const inlineRequire = token.match(/^(?:--require=|-r=)(.+)$/)?.[1];
    if (isTrustedTracer(inlineRequire)) {
      removedOfficialTracer = true;
      continue;
    }
    retained.push(token);
  }
  const profilerOption = retained.find((token) => (
    /^(?:--(?:cpu-prof|heap-prof|prof|inspect|inspect-brk|trace-|perf-|diagnostic-dir|heapsnapshot)[^=]*|--require|-r|--import|--loader|--experimental-loader)(?:=|$)/.test(token)
  ));
  const profilerEnvironment = [
    "NODE_V8_COVERAGE", "V8_CPU_PROFILER", "CPU_PROFILE", "HEAP_PROFILE",
    "PROOF_OR_STOP_PROFILER", "PROOF_OR_STOP_PROFILE_DIR",
  ].find((key) => typeof env[key] === "string" && env[key].length > 0);
  const injectionEnvironment = ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "DYLD_FRAMEWORK_PATH"]
    .find((key) => typeof env[key] === "string" && env[key].length > 0);
  if (profilerOption || profilerEnvironment || injectionEnvironment) {
    performanceStop("profiler_or_injection_active " + (profilerOption ?? profilerEnvironment ?? injectionEnvironment));
  }
  const forbiddenControl = [
    "PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE",
    "PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE",
    "PROOF_OR_STOP_QUORUM_SMOKE_FIXTURE_TRACE_FILE",
    "PROOF_OR_STOP_QUORUM_SMOKE_RESOURCE_TRACE_FILE",
    "PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE",
    "PROOF_OR_STOP_QUORUM_SMOKE_RUN_ID",
    "PROOF_OR_STOP_QUORUM_SMOKE_FAULT_KIND",
    "PROOF_OR_STOP_QUORUM_SMOKE_FAULT_CASE_ID",
    "PROOF_OR_STOP_DYN5_CASE",
  ].find((key) => typeof env[key] === "string" && env[key].length > 0);
  if (forbiddenControl) performanceStop("measurement_control_active " + forbiddenControl);
  const validationTraceFileActive = typeof env.PROOF_OR_STOP_RUNTIME_TRACE_FILE === "string"
    && env.PROOF_OR_STOP_RUNTIME_TRACE_FILE.length > 0;
  if (validationTraceFileActive !== removedOfficialTracer) {
    performanceStop("validation_tracer_pair_incomplete");
  }
  if (retained.length > 0) {
    env.NODE_OPTIONS = retained.map((token) => /\s/.test(token) ? JSON.stringify(token) : token).join(" ");
  } else {
    delete env.NODE_OPTIONS;
  }
  delete env.PROOF_OR_STOP_RUNTIME_TRACE_FILE;
  contract(!/validation-runtime-tracer\.cjs/.test(env.NODE_OPTIONS ?? ""), "official validation tracer survived sanitization");
  return { env, removedOfficialTracer };
}

function acquirePerformanceLease() {
  const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: repoRoot, encoding: "utf8",
  }).trim();
  const commonDirRealpath = realpathSync(isAbsolute(commonDir) ? commonDir : resolve(repoRoot, commonDir));
  const key = createHash("sha256").update(commonDirRealpath).digest("hex").slice(0, 24);
  const path = join(tmpdir(), "proof-or-stop-quorum-smoke-performance-" + key + ".lease");
  let fd = null;
  let identity = null;
  try {
    fd = openSync(
      path,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY
        | noFollowFlag(),
      0o600,
    );
    identity = fstatSync(fd);
    const rebound = lstatSync(path);
    contract(
      identity.isFile() && rebound.isFile() && !rebound.isSymbolicLink()
        && identity.dev === rebound.dev && identity.ino === rebound.ino,
      "performance lease changed identity during exclusive creation",
    );
    writeFileSync(fd, json({
      pid: process.pid,
      gitCommonDir: commonDirRealpath,
      startedAt: new Date().toISOString(),
    }));
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* report the original acquisition failure */ }
    }
    if (identity) {
      try {
        const entry = lstatSync(path);
        if (entry.dev === identity.dev && entry.ino === identity.ino && !entry.isSymbolicLink()) unlinkSync(path);
      } catch { /* never remove a path whose identity cannot be re-established */ }
    }
    performanceStop("benchmark_lease_unavailable " + path + " " + error.message);
  }
  return { fd, path, dev: identity.dev, ino: identity.ino, commonDirRealpath };
}

function releasePerformanceLease(lease) {
  let valid = false;
  let problem = null;
  try {
    const opened = fstatSync(lease.fd);
    const entry = lstatSync(lease.path);
    valid = opened.dev === lease.dev && opened.ino === lease.ino
      && entry.dev === lease.dev && entry.ino === lease.ino
      && entry.isFile() && !entry.isSymbolicLink();
    if (!valid) problem = new ContractFailure("performance lease identity changed while held");
  } catch (error) {
    problem = new ContractFailure("performance lease could not be verified at release: " + error.message);
  } finally {
    try { closeSync(lease.fd); } catch (error) { problem ??= error; }
  }
  if (valid) {
    try { unlinkSync(lease.path); } catch (error) { problem ??= error; }
  }
  if (problem) throw problem;
}

function retainPerformanceLease(lease) {
  let problem = null;
  try {
    const opened = fstatSync(lease.fd);
    const entry = lstatSync(lease.path);
    contract(
      opened.dev === lease.dev && opened.ino === lease.ino
        && entry.dev === lease.dev && entry.ino === lease.ino
        && entry.isFile() && !entry.isSymbolicLink(),
      "cannot safely retain a changed performance lease",
    );
  } catch (error) {
    problem = error;
  } finally {
    try { closeSync(lease.fd); } catch (error) { problem ??= error; }
  }
  if (problem) throw problem;
}

function cpuTimes() {
  return cpus().reduce((sum, cpu) => {
    const total = Object.values(cpu.times).reduce((value, item) => value + item, 0);
    return { idle: sum.idle + cpu.times.idle, total: sum.total + total };
  }, { idle: 0, total: 0 });
}

function performanceProcessRows() {
  return execFileSync("ps", ["-ww", "-axo", "pid=,ppid=,pgid=,lstart=,%cpu=,command="], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
  }).split(/\r?\n/).map((line) => line.match(
    /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+([0-9.]+)\s+(.*)$/,
  )).filter(Boolean).map((match) => ({
    pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]),
    started: match[4], cpuPercent: Number(match[5]), command: match[6],
  }));
}

function relatedProcessIds(rows, rootPid) {
  const related = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (related.has(row.ppid) && !related.has(row.pid)) {
        related.add(row.pid);
        changed = true;
      }
    }
  }
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  for (let cursor = byPid.get(rootPid); cursor && cursor.ppid > 0; cursor = byPid.get(cursor.ppid)) {
    related.add(cursor.ppid);
  }
  return related;
}

function competingPerformanceProcesses(rows, excluded) {
  return rows.filter((row) => !excluded.has(row.pid) && (
    /quorum-submit-smoke|red-B-e40f-quorum-submit-harness\.mjs.*performance-contract/.test(row.command)
      || /(?:npm .* run build|typescript[\\/]bin[\\/]tsc|proof-or-stop(?:\.js)? (?:validate|done_prepare))/.test(row.command)
      || /(?:^|\s)(?:npm|pnpm|yarn|bun)(?:\s+[^\s]+)*\s+(?:install|ci|add|update)(?:\s|$)/.test(row.command)
  ));
}

async function assertIdlePerformanceHost(label) {
  const initialRows = performanceProcessRows();
  const excluded = relatedProcessIds(initialRows, process.pid);
  const processes = competingPerformanceProcesses(initialRows, excluded);
  const before = cpuTimes();
  await wait(1_000);
  const after = cpuTimes();
  const total = after.total - before.total;
  return {
    idleFraction: total > 0 ? (after.idle - before.idle) / total : 0,
    oneMinuteLoad: loadavg()[0],
    logicalCpus: cpus().length,
    competingPids: processes.map((row) => row.pid),
    label,
  };
}

function installedDependencyRoot() {
  const resolvedTypeScript = realpathSync(dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))));
  for (let cursor = repoRoot; ; cursor = dirname(cursor)) {
    const candidate = join(cursor, "node_modules");
    const packagePath = join(candidate, "typescript/package.json");
    if (existsSync(join(candidate, ".pnpm")) && existsSync(packagePath)
      && realpathSync(dirname(packagePath)) === resolvedTypeScript) return candidate;
    const parent = dirname(cursor);
    if (parent === cursor) break;
  }
  performanceStop("complete_dependency_root_unavailable");
}

function observePerformanceTree(rootPid) {
  const identities = new Map();
  const harnessPgid = performanceProcessRows().find((row) => row.pid === process.pid)?.pgid;
  contract(rootPid > 1 && harnessPgid > 1, "performance process identities are not signal-safe");
  const identityKey = (row) => row.pid + ":" + row.pgid + ":" + row.started;
  let rootIdentity = null;
  const observe = () => {
    const rows = performanceProcessRows();
    const current = new Map(rows.map((row) => [row.pid, row]));
    if (!rootIdentity) {
      const root = current.get(rootPid);
      contract(Boolean(root), "performance child disappeared before its process identity was captured");
      contract(root.pgid === rootPid, "performance child is not the leader of its detached process group");
      rootIdentity = root;
      identities.set(identityKey(root), root);
    }
    const active = new Map([...identities.values()].filter((identity) => {
      const row = current.get(identity.pid);
      return row && row.pgid === identity.pgid && row.started === identity.started;
    }).map((identity) => [identity.pid, current.get(identity.pid)]));
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        const key = identityKey(row);
        if (active.has(row.ppid) && !identities.has(key)) {
          identities.set(key, row);
          active.set(row.pid, row);
          changed = true;
        }
      }
    }
    return { rows, active };
  };
  const live = () => [...observe().active.values()];
  const signal = (name) => {
    const { active } = observe();
    const groups = new Set([...active.values()].map((row) => row.pgid));
    for (const pgid of groups) {
      const leader = [...identities.values()].find((identity) => identity.pid === pgid && identity.pgid === pgid);
      contract(
        pgid > 1 && pgid !== harnessPgid && leader?.pgid === pgid,
        "refusing to signal an unauthenticated performance process group " + pgid,
      );
      try { process.kill(-pgid, name); } catch (error) { if (error?.code !== "ESRCH") throw error; }
    }
  };
  observe();
  return { identities, observe, live, signal };
}

async function waitForObservedTreeExit(tree, maximumMs = 2_000) {
  const deadline = Date.now() + maximumMs;
  while (tree.live().length > 0 && Date.now() < deadline) await wait(25);
  return tree.live();
}

function createPerformanceCleanupScope() {
  const trees = new Set();
  const owners = new Set();
  let lease = null;
  let aborting = null;
  const safeSignal = (tree, signal, errors) => {
    try { tree.signal(signal); } catch (error) { errors.push(signal + ": " + error.message); }
  };
  const reapTrees = async () => {
    const errors = [];
    for (const tree of trees) safeSignal(tree, "SIGTERM", errors);
    await wait(750);
    for (const tree of trees) safeSignal(tree, "SIGKILL", errors);
    await wait(250);
    let survivors = 0;
    for (const tree of [...trees]) {
      try {
        const live = await waitForObservedTreeExit(tree, 4_000);
        survivors += live.length;
        if (live.length === 0) trees.delete(tree);
      } catch (error) {
        errors.push("reap: " + error.message);
        survivors += 1;
      }
    }
    return { errors, survivors };
  };
  const abort = (signal) => {
    if (aborting) return aborting;
    aborting = (async () => {
      const { errors, survivors } = await reapTrees();
      if (survivors === 0) {
        for (const owner of owners) {
          try { if (existsSync(owner.path)) cleanupHarnessOwnedBase(owner, "performance signal cleanup"); }
          catch (error) { errors.push("temp cleanup: " + error.message); }
        }
      }
      if (lease) {
        const activeLease = lease;
        lease = null;
        try {
          if (survivors === 0) releasePerformanceLease(activeLease);
          else {
            retainPerformanceLease(activeLease);
            errors.push("lease retained because a benchmark descendant survived: " + activeLease.path);
          }
        }
        catch (error) { errors.push("lease cleanup: " + error.message); }
      }
      process.stderr.write(
        "PERFORMANCE_STOP interrupted signal=" + signal
          + " survivors=" + survivors + " cleanupErrors=" + errors.length + "\n",
      );
      process.exit(signal === "SIGINT" ? 130 : 143);
    })();
    return aborting;
  };
  const handlers = new Map(["SIGINT", "SIGTERM"].map((signal) => {
    const handler = () => { void abort(signal); };
    process.on(signal, handler);
    return [signal, handler];
  }));
  return {
    trees,
    owners,
    trackTree(tree) { trees.add(tree); },
    untrackTree(tree) { trees.delete(tree); },
    trackOwner(owner) { owners.add(owner); },
    untrackOwner(owner) { owners.delete(owner); },
    reapTrees,
    setLease(value) { lease = value; },
    clearLease(value) { if (lease === value) lease = null; },
    close() {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      contract(trees.size === 0 && owners.size === 0 && lease === null, "performance cleanup scope closed with live resources");
    },
  };
}

function preparePerformanceCheckout(owner, name, candidateHead) {
  const checkout = join(owner.realpath, name);
  try {
    execFileSync("git", ["clone", "--shared", "--no-checkout", "--quiet", repoRoot, checkout], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    execFileSync("git", ["checkout", "--detach", "--quiet", candidateHead], {
      cwd: checkout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    performanceStop("cow_checkout_failed " + String(error.stderr ?? error.message));
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
  contract(head === candidateHead, name + " checkout did not start at the candidate HEAD: " + head);
  const alternates = join(checkout, ".git/objects/info/alternates");
  contract(existsSync(alternates), name + " checkout is not a shared-object copy-on-write clone");
  const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: repoRoot, encoding: "utf8",
  }).trim();
  const expectedObjects = realpathSync(join(isAbsolute(commonDir) ? commonDir : resolve(repoRoot, commonDir), "objects"));
  const actualObjects = realpathSync(readFileSync(alternates, "utf8").trim());
  contract(actualObjects === expectedObjects, name + " clone shares an unexpected object store");
  const dependencyRoot = installedDependencyRoot();
  const checkoutDependencies = join(checkout, "node_modules");
  try {
    if (process.platform === "darwin") {
      execFileSync("/bin/cp", ["-cR", dependencyRoot, checkoutDependencies]);
    } else if (process.platform === "linux") {
      execFileSync("cp", ["--reflink=always", "-a", dependencyRoot, checkoutDependencies]);
    } else {
      performanceStop("cow_checkout_unsupported platform=" + process.platform);
    }
  } catch (error) {
    if (error instanceof ContractFailure) throw error;
    performanceStop("cow_dependency_copy_failed " + error.message);
  }
  contract(lstatSync(checkoutDependencies).isDirectory(), "copy-on-write dependency root is not a directory");
  for (const dependency of [
    "typescript/bin/tsc", "@types/node/package.json", "proper-lockfile/package.json",
    "ws/package.json", "xstate/package.json", "zod/package.json",
  ]) contract(existsSync(join(checkoutDependencies, dependency)), "copy-on-write toolchain omitted " + dependency);
  contract(
    strictDescendant(realpathSync(checkoutDependencies), realpathSync(join(checkoutDependencies, "typescript/package.json"))),
    "copy-on-write TypeScript link escaped the checkout dependency tree",
  );
  return { checkout, dependencyRoot: checkoutDependencies };
}

function prepareBaselineCheckout(owner, candidateHead) {
  const prepared = preparePerformanceCheckout(owner, "baseline", candidateHead);
  const { checkout } = prepared;
  const smokeRelative = "packages/main/src/tasks/quorum-submit-smoke.ts";
  const originalBytes = execFileSync("git", ["show", ORIGINAL_SMOKE_COMMIT + ":" + smokeRelative], {
    cwd: repoRoot, encoding: null, maxBuffer: 16 * 1024 * 1024,
  });
  writeFileSync(join(checkout, smokeRelative), originalBytes);
  execFileSync("git", ["add", "--", smokeRelative], { cwd: checkout });
  execFileSync("git", [
    "-c", "user.name=Quorum Smoke Performance",
    "-c", "user.email=quorum-performance@example.test",
    "-c", "commit.gpgsign=false",
    "commit", "--quiet", "-m", "benchmark: restore fixed quorum smoke baseline",
  ], { cwd: checkout, env: { ...process.env, GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" } });
  const syntheticHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
  const parent = execFileSync("git", ["rev-parse", "HEAD^"], { cwd: checkout, encoding: "utf8" }).trim();
  const changed = execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], {
    cwd: checkout, encoding: "utf8",
  }).trim().split(/\r?\n/).filter(Boolean);
  const baselineBlob = execFileSync("git", ["rev-parse", "HEAD:" + smokeRelative], {
    cwd: checkout, encoding: "utf8",
  }).trim();
  const originalBlob = execFileSync("git", ["rev-parse", ORIGINAL_SMOKE_COMMIT + ":" + smokeRelative], {
    cwd: repoRoot, encoding: "utf8",
  }).trim();
  contract(parent === candidateHead, "synthetic baseline parent is not the candidate HEAD");
  contract(json(changed) === json([smokeRelative]), "synthetic baseline changed more than the fixed smoke source");
  contract(baselineBlob === originalBlob, "synthetic baseline blob differs from the fixed source commit");
  contract(
    fileDigest(join(checkout, smokeRelative)) === createHash("sha256").update(originalBytes).digest("hex"),
    "synthetic baseline working bytes differ from the fixed source commit",
  );
  return { ...prepared, syntheticHead, parent, changed, originalBlob };
}

async function buildPerformanceTarget(cwd, label, env, scope) {
  const result = await runSupervisedPerformanceProcess({
    cwd,
    executable: execFileSync("/usr/bin/which", ["npm"], { encoding: "utf8", env }).trim(),
    args: ["--prefix", "packages/main", "run", "build"],
    env,
    label: label + " build",
    timeoutMs: 5 * 60_000,
    measure: false,
    scope,
  });
  if (result.status !== 0) {
    const detail = (result.stdout + result.stderr).slice(-4_000);
    performanceStop((label === "baseline" ? "baseline_incompatible " : "")
      + label + " build_failed exit=" + result.status + " " + detail);
  }
}

function fileDigest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function treeContentDigest(root, label) {
  const rootEntry = lstatSync(root);
  contract(rootEntry.isDirectory() && !rootEntry.isSymbolicLink(), label + " is not a real directory");
  const hash = createHash("sha256");
  const visit = (directory, relativeDirectory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = relativeDirectory ? relativeDirectory + "/" + name : name;
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) {
        hash.update("L\0").update(relativePath).update("\0").update(readlinkSync(path)).update("\0");
      } else if (entry.isDirectory()) {
        hash.update("D\0").update(relativePath).update("\0");
        visit(path, relativePath);
      } else if (entry.isFile()) {
        hash.update("F\0").update(relativePath).update("\0").update(String(entry.mode & 0o777)).update("\0");
        hash.update(readFileSync(path)).update("\0");
      } else {
        throw new ContractFailure(label + " contains an unsupported filesystem node: " + path);
      }
    }
  };
  visit(root, "");
  return hash.digest("hex");
}

function executableIdentity(path, label) {
  const realpath = realpathSync(path);
  const entry = lstatSync(realpath);
  contract(entry.isFile() && !entry.isSymbolicLink(), label + " is not a regular executable");
  return {
    realpath,
    dev: entry.dev,
    ino: entry.ino,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    digest: fileDigest(realpath),
  };
}

function assertExecutableFrozen(expected, label) {
  const entry = lstatSync(expected.realpath);
  contract(
    entry.isFile() && !entry.isSymbolicLink()
      && entry.dev === expected.dev && entry.ino === expected.ino
      && entry.size === expected.size && entry.mtimeMs === expected.mtimeMs,
    label + " executable identity changed during performance sampling",
  );
}

function performanceToolchainIdentity(dependencyRoot) {
  const npmPath = execFileSync("/usr/bin/which", ["npm"], { encoding: "utf8" }).trim();
  const typescriptPackage = readJsonTarget(join(dependencyRoot, "typescript/package.json"), "TypeScript toolchain");
  return {
    node: process.version,
    v8: process.versions.v8,
    npm: execFileSync(npmPath, ["--version"], { encoding: "utf8" }).trim(),
    typescript: String(typescriptPackage.version),
    nodeExecutable: executableIdentity(process.execPath, "Node executable"),
    npmExecutable: executableIdentity(npmPath, "npm executable"),
    typescriptExecutableDigest: fileDigest(realpathSync(join(dependencyRoot, "typescript/bin/tsc"))),
  };
}

function dependencySentinelDigest(dependencyRoot) {
  const hash = createHash("sha256");
  for (const relativePath of [
    ".modules.yaml",
    "typescript/package.json", "typescript/bin/tsc",
    "proper-lockfile/package.json", "ws/package.json", "xstate/package.json", "zod/package.json",
    "@types/node/package.json", "@types/ws/package.json",
  ]) {
    const path = join(dependencyRoot, relativePath);
    contract(existsSync(path), "dependency sentinel is missing: " + relativePath);
    const entry = lstatSync(path);
    hash.update(relativePath).update("\0");
    if (entry.isSymbolicLink()) hash.update("L\0").update(readlinkSync(path)).update("\0");
    const target = realpathSync(path);
    const targetEntry = lstatSync(target);
    contract(targetEntry.isFile() && !targetEntry.isSymbolicLink(), "dependency sentinel is not a regular file: " + relativePath);
    hash.update(readFileSync(target)).update("\0");
  }
  return hash.digest("hex");
}

function performanceMaterialIdentity(root, binding, dependencyRoot) {
  const manifest = binding.verifyBuildBinding(root);
  return {
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    status: execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: root, encoding: "utf8",
    }),
    sourceDigest: manifest.sourceDigest,
    distDigest: manifest.distDigest,
    buildScriptDigest: fileDigest(join(root, "scripts/build-main-with-binding.mjs")),
    buildLockDigest: fileDigest(join(root, "scripts/build-lock.mjs")),
    packageDigest: fileDigest(join(root, "packages/main/package.json")),
    tsconfigDigest: fileDigest(join(root, "packages/main/tsconfig.json")),
    rootPackageLockDigest: fileDigest(join(root, "package-lock.json")),
    mainPackageLockDigest: fileDigest(join(root, "packages/main/package-lock.json")),
    dependencySentinelDigest: dependencySentinelDigest(dependencyRoot),
  };
}

function assertPerformanceMaterialFrozen(
  binding,
  expectedCurrent,
  expectedBaseline,
  currentRoot,
  baselineRoot,
  currentDependencyRoot,
  baselineDependencyRoot,
  toolchain,
) {
  contract(
    json(performanceMaterialIdentity(currentRoot, binding, currentDependencyRoot)) === json(expectedCurrent),
    "current HEAD/source/dist/build identity changed during performance sampling",
  );
  contract(
    json(performanceMaterialIdentity(baselineRoot, binding, baselineDependencyRoot)) === json(expectedBaseline),
    "baseline HEAD/source/dist/build identity changed during performance sampling",
  );
  assertExecutableFrozen(toolchain.nodeExecutable, "Node");
  assertExecutableFrozen(toolchain.npmExecutable, "npm");
}

async function runSupervisedPerformanceProcess({
  cwd,
  executable,
  args,
  env,
  label,
  timeoutMs,
  measure,
  scope,
}) {
  const started = process.hrtime.bigint();
  const hostBefore = cpuTimes();
  const child = spawn(executable, args, {
    cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  const tree = observePerformanceTree(child.pid);
  scope.trackTree(tree);
  const competition = new Map();
  let monitorError = null;
  let forceKillTimer = null;
  const safeSignal = (signal) => {
    try { tree.signal(signal); }
    catch (error) { monitorError ??= new Error(label + " " + signal + " failed: " + error.message); }
  };
  const observeHost = () => {
    try {
      const { rows, active } = tree.observe();
      const excluded = relatedProcessIds(rows, process.pid);
      for (const identity of active.values()) excluded.add(identity.pid);
      for (const row of competingPerformanceProcesses(rows, excluded)) {
        competition.set(row.pid + ":" + row.started, row);
      }
    } catch (error) {
      monitorError ??= new Error(label + " process monitor failed: " + error.message);
      safeSignal("SIGTERM");
      if (!forceKillTimer) forceKillTimer = setTimeout(() => safeSignal("SIGKILL"), 500);
    }
  };
  const observer = setInterval(observeHost, 2_000);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    safeSignal("SIGTERM");
    forceKillTimer = setTimeout(() => safeSignal("SIGKILL"), 500);
  }, timeoutMs);
  const terminal = await new Promise((resolveTerminal) => {
    child.once("error", (error) => resolveTerminal({ error, status: null }));
    child.once("close", (status) => resolveTerminal({ error: null, status }));
  });
  clearTimeout(timer);
  clearInterval(observer);
  observeHost();
  if (forceKillTimer) clearTimeout(forceKillTimer);
  const hostAfter = cpuTimes();
  const wallNs = process.hrtime.bigint() - started;
  const wallMs = Number(wallNs) / 1e6;
  let orphaned = [];
  let survivors = [];
  try { orphaned = tree.live(); }
  catch (error) { monitorError ??= new Error(label + " final process observation failed: " + error.message); }
  if (orphaned.length > 0 || monitorError) safeSignal("SIGKILL");
  try { survivors = await waitForObservedTreeExit(tree, 4_000); }
  catch (error) { monitorError ??= new Error(label + " reap observation failed: " + error.message); survivors = [{}]; }
  if (survivors.length === 0) scope.untrackTree(tree);
  contract(!timedOut, label + " exceeded its " + timeoutMs + "ms timeout");
  contract(
    orphaned.length === 0 && survivors.length === 0,
    label + " left a live observed descendant: " + json(orphaned.map((row) => row.pid)),
  );
  contract(!monitorError, monitorError?.message ?? label + " process monitor failed");
  if (terminal.error) throw new BootstrapFailure(label + " could not start: " + terminal.error.message);
  const timing = measure
    ? [...stderr.matchAll(/(?:^|\n)real\s+([0-9.]+)\s*\nuser\s+([0-9.]+)\s*\nsys\s+([0-9.]+)/g)].at(-1)
    : null;
  contract(!measure || Boolean(timing), label + " did not emit parseable process-tree CPU timing");
  const userMs = timing ? Number(timing[2]) * 1_000 : 0;
  const systemMs = timing ? Number(timing[3]) * 1_000 : 0;
  const hostTotalMs = hostAfter.total - hostBefore.total;
  const hostBusyMs = hostTotalMs - (hostAfter.idle - hostBefore.idle);
  const externalBusyMs = Math.max(0, hostBusyMs - userMs - systemMs);
  const externalBusyFraction = hostTotalMs > 0 ? externalBusyMs / hostTotalMs : 1;
  return {
    status: terminal.status,
    stdout, stderr, wallMs, wallNs, userMs, systemMs, hostBusyMs, externalBusyMs,
    competingPids: [...competition.values()].map((row) => row.pid),
    externalBusyFraction,
    cpuUtilization: measure ? (userMs + systemMs) / wallMs : 0,
  };
}

async function runTimedPerformanceProcess({ cwd, script, args, env, label, scope }) {
  const timeExecutable = "/usr/bin/time";
  if (!existsSync(timeExecutable)) performanceStop("portable_process_timer_missing");
  return runSupervisedPerformanceProcess({
    cwd,
    executable: timeExecutable,
    args: ["-p", process.execPath, script, ...args],
    env,
    label,
    timeoutMs: 45 * 60_000,
    measure: true,
    scope,
  });
}

function performanceVerdictDigest(rows, label) {
  const normalized = rows.map((row) => [String(row.id), String(row.status)]).sort();
  const expected = EXPECTED_CASES.map((row) => [row.id, "PASS"]);
  contract(json(normalized) === json(expected), label + " did not produce the exact 73 PASS identities");
  return createHash("sha256").update(normalized.map((row) => row.join(":" )).join("\n") + "\n").digest("hex");
}

function baselinePerformanceDigest(stdout) {
  const idsByTitle = new Map(EXPECTED_CASES.map((row) => [row.title, row.id]));
  const titles = stdout.split(/\r?\n/).map((line) => line.match(/^  ✓ (.+)$/)?.[1]).filter(Boolean);
  const unknown = titles.filter((title) => !idsByTitle.has(title));
  const duplicate = titles.filter((title, index) => titles.indexOf(title) !== index);
  contract(unknown.length === 0, "baseline emitted unknown case titles: " + json(unknown));
  contract(duplicate.length === 0, "baseline emitted duplicate case titles: " + json(duplicate));
  const rows = titles.map((title) => ({ id: idsByTitle.get(title), status: "PASS" }));
  contract(/quorum_submit smoke passed \(73 checks\)/.test(stdout), "baseline did not finish all 73 checks");
  return performanceVerdictDigest(rows, "fixed baseline");
}

function currentPerformanceDigest(stdout, jobs, owner) {
  const report = parseRunReport(stdout, "performance jobs=" + jobs);
  contract(
    report.ok === true && report.status === "PASS" && report.jobs === jobs
      && report.retryCount === 0 && report.processTreeReaped === true
      && report.orphanedDescendants === false,
    "performance current report failed or omitted terminal process/retry state",
  );
  assertReportResidue(report, "performance jobs=" + jobs);
  const inventory = manifestRows(readJsonTarget(manifestPath, "performance inventory"));
  const shards = inventory.map((row) => row.shard).filter((value, index, all) => all.indexOf(value) === index).sort();
  contract(
    Array.isArray(report.shards) && json(report.shards.map((row) => row.shardId).sort()) === json(shards)
      && report.shards.every((row) => {
        const expectedIds = inventory.filter((item) => item.shard === row.shardId).map((item) => item.id).sort();
        const sentinels = inventory.filter((item) => item.shard === row.shardId && item.sentinel === "real")
          .map((item) => item.id).sort();
        assertReportResidue(row, "performance shard " + row.shardId);
        return row.status === "PASS" && row.attempts === 1 && row.retryCount === 0
          && row.processTreeReaped === true && row.orphanedDescendants === false
          && Number.isInteger(row.workerPid) && row.workerPid > 0 && row.workerPid !== report.parentPid
          && Array.isArray(row.caseIds) && Array.isArray(row.sentinelCaseIds)
          && json([...row.caseIds].sort()) === json(expectedIds)
          && json([...row.sentinelCaseIds].sort()) === json(sentinels);
      }),
    "performance current report omitted an exact successful shard set",
  );
  contract(report.ownedTempBase === owner.realpath, "performance run ignored its owned temp base");
  for (const root of report.ownedTempRoots ?? []) {
    const normalized = assertOwnedPath(owner, root, "performance worker root", { mustExist: false, directory: true }).normalized;
    assertOwnedPathAbsent(owner, normalized, "performance cleaned worker root");
  }
  contract(
    report.results.every((row) => row.status === "PASS" && row.attempts === 1
      && Number.isInteger(row.workerPid) && row.workerPid > 0 && row.workerPid !== report.parentPid),
    "performance results omitted exact-once worker verdicts",
  );
  const intervals = report.results.map((row) => ({
    pid: row.workerPid, start: Number(row.startedAtMs), end: Number(row.endedAtMs),
  }));
  const overlap = intervals.some((left, index) => intervals.slice(index + 1)
    .some((right) => left.pid !== right.pid && left.start < right.end && right.start < left.end));
  contract(
    jobs === 1 ? report.maxConcurrent === 1 && !overlap : report.maxConcurrent >= 2 && report.maxConcurrent <= jobs && overlap,
    "performance jobs=" + jobs + " did not demonstrate its requested concurrency",
  );
  return performanceVerdictDigest(
    report.results.map((row) => ({ id: resultCaseId(row), status: row.status })),
    "performance jobs=" + jobs,
  );
}

async function performanceSample(mode, currentRoot, baselineRoot, env, round, slot, assertFrozen, scope) {
  const idle = await assertIdlePerformanceHost("round=" + round + " slot=" + slot);
  assertFrozen();
  const owner = createHarnessOwnedBase("b-e40f-performance-sample-");
  scope.trackOwner(owner);
  const current = mode !== "baseline";
  const jobs = mode === "jobs2" ? 2 : 1;
  try {
    const execution = await runTimedPerformanceProcess({
      cwd: current ? currentRoot : baselineRoot,
      script: join(
        current ? currentRoot : baselineRoot,
        "packages/main/dist/tasks/quorum-submit-smoke.js",
      ),
      args: current ? ["--jobs=" + jobs, "--report=json"] : [],
      env: {
        ...env,
        TMPDIR: owner.realpath, TMP: owner.realpath, TEMP: owner.realpath,
        PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE: owner.realpath,
      },
      label: "performance " + mode + " round=" + round,
      scope,
    });
    if (execution.status !== 0) {
      const detail = (execution.stdout + execution.stderr).slice(-4_000);
      if (!current) performanceStop("baseline_incompatible sample_exit=" + execution.status + " " + detail);
      throw new ContractFailure("performance " + mode + " exited " + execution.status + ": " + detail);
    }
    assertFrozen();
    let digest;
    try {
      digest = current
        ? currentPerformanceDigest(execution.stdout, jobs, owner)
        : baselinePerformanceDigest(execution.stdout);
    } catch (error) {
      if (!current && error instanceof ContractFailure) {
        performanceStop("baseline_incompatible " + error.message);
      }
      throw error;
    }
    contract(readdirSync(owner.path).length === 0, "performance " + mode + " left temp residue");
    console.log(
      "PERFORMANCE_SAMPLE round=" + round + " slot=" + slot + " mode=" + mode
        + " wallMs=" + execution.wallMs.toFixed(1)
        + " cpuMs=" + (execution.userMs + execution.systemMs).toFixed(1)
        + " cpuUtilization=" + execution.cpuUtilization.toFixed(3)
        + " idleBefore=" + idle.idleFraction.toFixed(3)
        + " load1Before=" + idle.oneMinuteLoad.toFixed(2)
        + " externalBusy=" + execution.externalBusyFraction.toFixed(3)
        + " competitorsBefore=" + json(idle.competingPids)
        + " competitorsDuring=" + json(execution.competingPids)
        + " digest=" + digest,
    );
    return { mode, digest, idle, ...execution };
  } finally {
    if (scope.trees.size === 0) {
      cleanupHarnessOwnedBase(owner, "performance sample " + mode);
      contract(!existsSync(owner.path), "performance sample cleanup left its owned base");
      scope.untrackOwner(owner);
    }
  }
}

function median(values) {
  const ordered = [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return ordered[Math.floor(ordered.length / 2)];
}

function performancePreflightIsolationContract() {
  const source = ts.createSourceFile(
    harnessRelativePath,
    readFileSync(fileURLToPath(import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const declaration = source.statements.find((statement) => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === "performanceContract"
  ));
  contract(Boolean(declaration?.body), "performanceContract source body is absent");
  const buildRoots = [];
  let verifiesCurrentBinding = false;
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "buildPerformanceTarget") {
        buildRoots.push(node.arguments[0]?.getText(source) ?? "");
      }
      if (node.expression.text === "performanceMaterialIdentity"
        && node.arguments[0]?.getText(source) === "currentRoot") verifiesCurrentBinding = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.body);
  contract(
    json(buildRoots) === json(["currentRoot", "baselineRoot"]),
    "performance preflight must build only the two isolated benchmark checkouts: " + json(buildRoots),
  );
  contract(verifiesCurrentBinding, "performance preflight omitted the isolated candidate build binding");
  console.log("PERFORMANCE_ISOLATION_PASS build_roots=temp_only candidate=isolated");
}

function performanceHostAccountingContract() {
  const supervisor = runSupervisedPerformanceProcess.toString();
  const idleGuard = assertIdlePerformanceHost.toString();
  const timedRunner = runTimedPerformanceProcess.toString();
  contract(
    !/highCpuCounts|cpuPercent\s*<\s*50/.test(supervisor),
    "performance supervisor still rejects a single short per-process CPU burst",
  );
  contract(
    /externalBusyFraction/.test(supervisor),
    "performance supervisor omitted aggregate external-busy telemetry",
  );
  contract(
    !/idleFraction\s*>=/.test(idleGuard) && !/oneMinuteLoad\s*<=/.test(idleGuard),
    "performance preflight adds a host-wide threshold not present in the frozen intent",
  );
  contract(
    /competingPerformanceProcesses/.test(supervisor),
    "performance supervisor omitted named build/validation competitor telemetry",
  );
  contract(
    !/performanceStop/.test(idleGuard) && !/PerformanceContamination/.test(supervisor),
    "performance evidence still blocks on a host condition absent from the frozen intent",
  );
  contract(
    /timeoutMs:\s*45\s*\*\s*60_000/.test(timedRunner),
    "performance sample timeout regressed below the observed busy-host envelope",
  );
  console.log("PERFORMANCE_ACCOUNTING_PASS named_competitors=telemetry host_metrics=telemetry");
}

async function collectPerformanceSamples(latinSquare, runSample, maxDiscards = 3) {
  contract(
    Number.isSafeInteger(maxDiscards) && maxDiscards >= 0 && maxDiscards <= 3,
    "performance contamination discard budget must be from 0 through 3",
  );
  const samples = [];
  let discarded = 0;
  for (let round = 0; round < latinSquare.length; round += 1) {
    for (let slot = 0; slot < latinSquare[round].length; slot += 1) {
      const mode = latinSquare[round][slot];
      while (true) {
        try {
          samples.push(await runSample(mode, round + 1, slot + 1, discarded + 1));
          break;
        } catch (error) {
          if (!(error instanceof PerformanceContamination)) throw error;
          discarded += 1;
          console.log(
            "PERFORMANCE_DISCARD round=" + (round + 1) + " slot=" + (slot + 1)
              + " mode=" + mode + " discarded=" + discarded + "/" + maxDiscards
              + " reason=" + error.message,
          );
          if (discarded > maxDiscards) {
            performanceStop(
              "contamination_retry_exhausted discarded=" + discarded
                + " max=" + maxDiscards + " last=" + error.message,
            );
          }
        }
      }
    }
  }
  return samples;
}

function performanceIdleWaitContract() {
  const idleGuard = assertIdlePerformanceHost.toString();
  contract(
    !/PROOF_OR_STOP_IDLE_TIMEOUT_MS/.test(idleGuard),
    "performance preflight still exposes a host-wide idle wait budget",
  );
  contract(
    !/while\s*\(true\)/.test(idleGuard),
    "performance preflight still loops waiting for an unrelated host-wide threshold",
  );
  contract(
    /competingPerformanceProcesses/.test(idleGuard),
    "performance preflight stopped recording directly competing benchmark tasks",
  );
  console.log("PERFORMANCE_IDLE_WAIT_PASS wait=removed competitors=telemetry");
}

function performanceIdleBudgetContract() {
  const idleGuard = assertIdlePerformanceHost.toString();
  contract(
    !/timeoutMs/.test(idleGuard) && !/idle_wait_timeout/.test(idleGuard),
    "performance preflight still turns host utilization into a multi-hour acceptance gate",
  );
  console.log("PERFORMANCE_IDLE_BUDGET_PASS wait_budget=none scope=intent_only");
}

function performancePreflightIdleContract() {
  const source = performanceContract.toString();
  const idleIndex = source.indexOf('await assertIdlePerformanceHost("baseline build")');
  const buildIndex = source.indexOf("await buildPerformanceTarget(baselineRoot");
  contract(
    idleIndex >= 0 && buildIndex >= 0 && idleIndex < buildIndex,
    "performance baseline build starts before the bounded idle-host guard",
  );
  console.log("PERFORMANCE_PREFLIGHT_IDLE_PASS build=guarded");
}

async function performanceContaminationRetryContract() {
  contract(
    typeof collectPerformanceSamples === "function",
    "performance protocol has no accepted-sample collector",
  );
  let calls = 0;
  const samples = await collectPerformanceSamples(
    [["baseline", "jobs1"]],
    async (mode) => {
      calls += 1;
      if (calls === 1) throw new PerformanceContamination("synthetic host activity");
      return { mode, accepted: true };
    },
    1,
  );
  contract(
    calls === 3 && samples.length === 2
      && samples.every((sample) => sample.accepted === true),
    "performance protocol did not replace the contaminated sample exactly once",
  );
  console.log("PERFORMANCE_RETRY_PASS accepted=2 discarded=1 budget=1");
}

async function performanceCurrentJobsContract(jobs) {
  assertPerformanceSourceCapability();
  const { env } = measurementEnvironment();
  const before = gitStatus();
  contract(before === "", "focused current-performance contract requires a clean checkout");
  const candidateHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot, encoding: "utf8",
  }).trim();
  const scope = createPerformanceCleanupScope();
  let lease = null;
  try {
    lease = acquirePerformanceLease();
    scope.setLease(lease);
    const assertFrozen = () => contract(
      gitStatus() === before
        && execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim()
          === candidateHead,
      "focused current-performance material changed during execution",
    );
    const sample = await performanceSample(
      jobs === 2 ? "jobs2" : "jobs1", repoRoot, repoRoot, env, 1, 1, assertFrozen, scope,
    );
    console.log(
      "PERFORMANCE_CURRENT_PASS jobs=" + jobs + " cases=73 residue=0 wallMs="
        + sample.wallMs.toFixed(1),
    );
  } finally {
    const cleanupErrors = [];
    if (scope.trees.size > 0) {
      try {
        const result = await scope.reapTrees();
        if (result.survivors > 0 || result.errors.length > 0) {
          cleanupErrors.push("process cleanup survivors=" + result.survivors
            + " errors=" + json(result.errors));
        }
      } catch (error) { cleanupErrors.push("process cleanup: " + error.message); }
    }
    if (scope.trees.size === 0) {
      for (const owner of [...scope.owners]) {
        try {
          if (existsSync(owner.path)) cleanupHarnessOwnedBase(owner, "focused performance cleanup");
          scope.untrackOwner(owner);
        } catch (error) { cleanupErrors.push("temp cleanup: " + error.message); }
      }
    }
    if (lease) {
      try { releasePerformanceLease(lease); }
      catch (error) { cleanupErrors.push("lease cleanup: " + error.message); }
      scope.clearLease(lease);
    }
    try { scope.close(); } catch (error) { cleanupErrors.push(error.message); }
    if (cleanupErrors.length > 0) {
      throw new ContractFailure("focused performance cleanup failed: " + cleanupErrors.join("; "));
    }
  }
}

async function performanceContract() {
  assertPerformanceSourceCapability();
  const { env, removedOfficialTracer } = measurementEnvironment();
  const before = gitStatus();
  contract(before === "", "performance protocol requires a clean current checkout");
  const candidateHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot, encoding: "utf8",
  }).trim();
  const scope = createPerformanceCleanupScope();
  let lease = null;
  let checkoutOwner = null;
  let currentRoot = null;
  let baselineRoot = null;
  let currentDependencyRoot = null;
  let baselineDependencyRoot = null;
  let frozenDependencyTreeDigest = null;
  let successSummary = null;
  try {
    lease = acquirePerformanceLease();
    scope.setLease(lease);
    // The candidate dist is already bound to its exact source by the signed build
    // manifest checked below. Rebuilding it here would write inside a checkout
    // managed by FileProvider on some hosts and make the benchmark contaminate
    // its own host-idle witness. Keep candidate material read-only; only build
    // the synthetic baseline in its isolated temporary checkout.
    contract(gitStatus() === before, "candidate checkout changed before isolated setup");
    contract(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim() === candidateHead,
      "candidate HEAD changed during isolated setup",
    );
    const worker = await loadWorkerContract("performance-contract");
    contract(
      json(worker.QUORUM_SMOKE_PARALLEL_CAPABILITY) === json(PERFORMANCE_CAPABILITY),
      "parallel performance capability is not ready for the nine-run protocol; expected="
        + json(PERFORMANCE_CAPABILITY),
    );
    checkoutOwner = createHarnessOwnedBase("b-e40f-performance-checkout-");
    scope.trackOwner(checkoutOwner);
    const current = preparePerformanceCheckout(checkoutOwner, "current", candidateHead);
    currentRoot = current.checkout;
    currentDependencyRoot = current.dependencyRoot;
    const baseline = prepareBaselineCheckout(checkoutOwner, candidateHead);
    baselineRoot = baseline.checkout;
    baselineDependencyRoot = baseline.dependencyRoot;
    await assertIdlePerformanceHost("baseline build");
    await buildPerformanceTarget(currentRoot, "current", env, scope);
    await buildPerformanceTarget(baselineRoot, "baseline", env, scope);
    const fixedSmokeBlob = execFileSync("git", [
      "rev-parse", ORIGINAL_SMOKE_COMMIT + ":packages/main/src/tasks/quorum-submit-smoke.ts",
    ], { cwd: repoRoot, encoding: "utf8" }).trim();
    contract(
      baseline.parent === candidateHead
        && baseline.originalBlob === fixedSmokeBlob
        && json(baseline.changed) === json(["packages/main/src/tasks/quorum-submit-smoke.ts"]),
      "controlled source baseline lost its candidate-parent/single-blob binding",
    );
    const toolchainMaterial = performanceToolchainIdentity(currentDependencyRoot);
    const toolchain = {
      ...toolchainMaterial,
      git: execFileSync("git", ["--version"], { encoding: "utf8" }).trim(),
      platform: process.platform,
      arch: process.arch,
      cpuModel: cpus()[0]?.model ?? "unknown",
      logicalCpus: cpus().length,
      validationTracerRemoved: removedOfficialTracer,
    };
    const binding = await import(pathToFileURL(join(repoRoot, "scripts/full-suite-build-binding.mjs")).href
      + "?b-e40f-performance=" + Date.now());
    const currentIdentity = performanceMaterialIdentity(currentRoot, binding, currentDependencyRoot);
    const baselineIdentity = performanceMaterialIdentity(baselineRoot, binding, baselineDependencyRoot);
    const currentDependencyTreeDigest = treeContentDigest(currentDependencyRoot, "current dependency tree");
    const baselineDependencyTreeDigest = treeContentDigest(baselineDependencyRoot, "baseline dependency tree");
    contract(
      currentDependencyTreeDigest === baselineDependencyTreeDigest,
      "copy-on-write baseline dependency bytes differ from the candidate install",
    );
    frozenDependencyTreeDigest = currentDependencyTreeDigest;
    contract(currentIdentity.head === candidateHead, "current candidate moved after preflight");
    contract(baselineIdentity.head === baseline.syntheticHead, "baseline material moved from its synthetic commit");
    contract(currentIdentity.status === "" && baselineIdentity.status === "", "a built benchmark checkout is dirty");
    const sharedMaterialFields = [
      "buildScriptDigest", "buildLockDigest", "packageDigest", "tsconfigDigest",
      "rootPackageLockDigest", "mainPackageLockDigest", "dependencySentinelDigest",
    ];
    contract(
      sharedMaterialFields.every((field) => currentIdentity[field] === baselineIdentity[field]),
      "baseline/current build scripts, locks, packages, config, or CoW dependencies differ",
    );
    contract(
      String(readJsonTarget(join(baselineDependencyRoot, "typescript/package.json"), "baseline TypeScript").version)
        === toolchain.typescript
        && fileDigest(realpathSync(join(baselineDependencyRoot, "typescript/bin/tsc")))
          === toolchain.typescriptExecutableDigest,
      "baseline/current TypeScript toolchains differ",
    );
    const assertFrozen = () => assertPerformanceMaterialFrozen(
      binding,
      currentIdentity,
      baselineIdentity,
      currentRoot,
      baselineRoot,
      currentDependencyRoot,
      baselineDependencyRoot,
      toolchain,
    );
    console.log("PERFORMANCE_PREFLIGHT " + json({
      sourceBaselineCommit: ORIGINAL_SMOKE_COMMIT,
      candidateHead,
      syntheticBaselineHead: baseline.syntheticHead,
      fixedSmokeBlob,
      checkout: "git-shared-objects-cow-v1",
      toolchain,
      currentBuild: {
        sourceDigest: currentIdentity.sourceDigest,
        distDigest: currentIdentity.distDigest,
        buildScriptDigest: currentIdentity.buildScriptDigest,
        buildLockDigest: currentIdentity.buildLockDigest,
      },
      baselineBuild: {
        sourceDigest: baselineIdentity.sourceDigest,
        distDigest: baselineIdentity.distDigest,
        buildScriptDigest: baselineIdentity.buildScriptDigest,
        buildLockDigest: baselineIdentity.buildLockDigest,
      },
      dependencyTreeDigest: frozenDependencyTreeDigest,
    }));
    const latinSquare = [
      ["baseline", "jobs1", "jobs2"],
      ["jobs1", "jobs2", "baseline"],
      ["jobs2", "baseline", "jobs1"],
    ];
    const samples = await collectPerformanceSamples(
      latinSquare,
      (mode, round, slot) => performanceSample(
        mode, currentRoot, baselineRoot, env, round, slot, assertFrozen, scope,
      ),
    );
    const digests = new Set(samples.map((row) => row.digest));
    contract(digests.size === 1, "baseline/jobs1/jobs2 verdict digests diverged");
    const medianNs = Object.fromEntries(["baseline", "jobs1", "jobs2"].map((mode) => [
      mode, median(samples.filter((row) => row.mode === mode).map((row) => row.wallNs)),
    ]));
    const medians = Object.fromEntries(Object.entries(medianNs).map(([mode, value]) => [mode, Number(value) / 1e6]));
    const baselineGain = Number(medianNs.baseline - medianNs.jobs2) / Number(medianNs.baseline);
    const serialGain = Number(medianNs.jobs1 - medianNs.jobs2) / Number(medianNs.jobs1);
    console.log("PERFORMANCE_MEDIANS " + json({ ...medians, baselineGain, serialGain, toolchain }));
    if (medianNs.jobs2 * 100n > medianNs.baseline * 80n
      || medianNs.jobs2 * 100n > medianNs.jobs1 * 85n) performanceStop("threshold_not_met");
    successSummary = "PERFORMANCE_PASS baseline_gain>=20% serial_gain>=15%"
      + " baselineMedianMs=" + medians.baseline.toFixed(1)
      + " jobs1MedianMs=" + medians.jobs1.toFixed(1)
      + " jobs2MedianMs=" + medians.jobs2.toFixed(1);
  } finally {
    const cleanupErrors = [];
    if (scope.trees.size > 0) {
      try {
        const result = await scope.reapTrees();
        if (result.survivors > 0 || result.errors.length > 0) {
          cleanupErrors.push("process cleanup survivors=" + result.survivors + " errors=" + json(result.errors));
        }
      } catch (error) { cleanupErrors.push("process cleanup: " + error.message); }
    }
    try {
      contract(gitStatus() === before, "performance protocol changed the current checkout");
    } catch (error) { cleanupErrors.push(error.message); }
    for (const [root, label] of [[currentRoot, "current"], [baselineRoot, "baseline"]]) {
      if (root !== null && existsSync(root)) {
        try {
          contract(
            execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
              cwd: root, encoding: "utf8",
            }) === "",
            "performance protocol changed the controlled " + label + " checkout",
          );
        } catch (error) { cleanupErrors.push(error.message); }
      }
    }
    if (frozenDependencyTreeDigest !== null && baselineDependencyRoot !== null) {
      try {
        contract(
          treeContentDigest(currentDependencyRoot, "final current dependency tree")
              === frozenDependencyTreeDigest
            && treeContentDigest(baselineDependencyRoot, "final baseline dependency tree")
              === frozenDependencyTreeDigest,
          "dependency tree bytes changed during performance sampling",
        );
      } catch (error) { cleanupErrors.push(error.message); }
    }
    if (scope.trees.size === 0) {
      for (const owner of [...scope.owners]) {
        try {
          if (existsSync(owner.path)) cleanupHarnessOwnedBase(owner, "performance final cleanup");
          contract(!existsSync(owner.path), "performance final cleanup left an owned base");
          scope.untrackOwner(owner);
        } catch (error) { cleanupErrors.push("temp cleanup: " + error.message); }
      }
    } else {
      cleanupErrors.push("refusing temp cleanup while a benchmark process remains live");
    }
    if (lease) {
      const activeLease = lease;
      const retainForSurvivor = scope.trees.size > 0;
      try {
        if (retainForSurvivor) {
          retainPerformanceLease(activeLease);
          cleanupErrors.push("performance lease retained because a descendant survived: " + activeLease.path);
        } else {
          releasePerformanceLease(activeLease);
        }
      } catch (error) { cleanupErrors.push("lease cleanup: " + error.message); }
      scope.clearLease(activeLease);
      lease = null;
    }
    try { scope.close(); } catch (error) { cleanupErrors.push(error.message); }
    if (cleanupErrors.length > 0) {
      throw new ContractFailure("performance cleanup failed: " + cleanupErrors.join("; "));
    }
  }
  console.log(successSummary);
}

function exactHeadGitEnvironment(overrides = {}) {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return harnessChildEnvironment({
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: nullDevice,
    ...overrides,
  });
}

function exactHeadGit(cwd, args, env = exactHeadGitEnvironment()) {
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

function canonicalGitPath(cwd, args, env) {
  const raw = exactHeadGit(cwd, args, env);
  return realpathSync(isAbsolute(raw) ? raw : resolve(cwd, raw));
}

function requireCleanExactHeadStatus(status, label) {
  contract(status === "", label + " requires a clean tracked and untracked worktree");
}

function expectExactHeadIsolationRejection(action, pattern, label) {
  let observed = null;
  try {
    action();
  } catch (error) {
    observed = error;
  }
  contract(observed instanceof ContractFailure, label + " did not fail closed");
  contract(pattern.test(observed.message), label + " emitted the wrong refusal: " + observed.message);
}

function captureExactHeadSource() {
  const env = exactHeadGitEnvironment();
  const head = exactHeadGit(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"], env);
  const tree = exactHeadGit(repoRoot, ["rev-parse", "HEAD^{tree}"], env);
  const status = exactHeadGit(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"], env);
  requireCleanExactHeadStatus(status, "exact-HEAD correctness isolation");
  const harnessBlob = exactHeadGit(repoRoot, ["rev-parse", "HEAD:" + harnessRelativePath], env);
  const workingHarnessBlob = exactHeadGit(
    repoRoot,
    ["hash-object", "--no-filters", "--", harnessRelativePath],
    env,
  );
  contract(workingHarnessBlob === harnessBlob, "correctness harness bytes differ from the captured HEAD blob");
  contract(
    exactHeadGit(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"], env) === head,
    "source HEAD moved during exact-HEAD preflight",
  );
  return {
    head,
    tree,
    harnessBlob,
    commonDir: canonicalGitPath(repoRoot, ["rev-parse", "--git-common-dir"], env),
    objectDir: canonicalGitPath(repoRoot, ["rev-parse", "--git-path", "objects"], env),
    distDigest: treeContentDigest(join(repoRoot, "packages/main/dist"), "source correctness dist"),
  };
}

function assertExactHeadSourceUnchanged(snapshot) {
  const env = exactHeadGitEnvironment();
  requireCleanExactHeadStatus(
    exactHeadGit(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"], env),
    "completed exact-HEAD correctness isolation",
  );
  contract(
    exactHeadGit(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"], env) === snapshot.head
      && exactHeadGit(repoRoot, ["rev-parse", "HEAD^{tree}"], env) === snapshot.tree
      && exactHeadGit(repoRoot, ["rev-parse", "HEAD:" + harnessRelativePath], env) === snapshot.harnessBlob
      && exactHeadGit(repoRoot, ["hash-object", "--no-filters", "--", harnessRelativePath], env)
        === snapshot.harnessBlob,
    "source HEAD, tree, or harness blob moved during correctness isolation",
  );
  contract(
    treeContentDigest(join(repoRoot, "packages/main/dist"), "final source correctness dist")
      === snapshot.distDigest,
    "source dist bytes changed during correctness isolation",
  );
}

function createExactHeadIsolationOwner(source) {
  const ambientParent = resolve(tmpdir());
  const parentEntry = lstatSync(ambientParent);
  contract(parentEntry.isDirectory() && !parentEntry.isSymbolicLink(), "isolation temp parent is not a real directory");
  const parentRealpath = realpathSync(ambientParent);
  const sourceRealpath = realpathSync(repoRoot);
  for (const protectedPath of [sourceRealpath, source.commonDir, source.objectDir]) {
    contract(
      parentRealpath !== protectedPath
        && !strictDescendant(parentRealpath, protectedPath)
        && !strictDescendant(protectedPath, parentRealpath),
      "isolation temp parent overlaps protected source material: " + protectedPath,
    );
  }
  return createHarnessOwnedBase("b-e40f-exact-head-");
}

function createExactHeadCloneGitEnvironment(owner) {
  const home = join(owner.realpath, "git-home");
  const template = join(owner.realpath, "git-template");
  const hooks = join(owner.realpath, "git-hooks");
  for (const path of [home, template, hooks]) mkdirSync(path);
  writeFixtureFile(owner, home, ".gitconfig", "");
  return exactHeadGitEnvironment({
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_VALUE_0: hooks,
    GIT_TEMPLATE_DIR: template,
  });
}

function assertIndependentExactHeadClone(owner, cloneRoot, source, gitEnv) {
  const cloneRealpath = assertOwnedDirectory(owner, cloneRoot, "exact-HEAD clone").realpath;
  const commonDir = canonicalGitPath(cloneRoot, ["rev-parse", "--git-common-dir"], gitEnv);
  const objectDir = canonicalGitPath(cloneRoot, ["rev-parse", "--git-path", "objects"], gitEnv);
  const alternatesRaw = exactHeadGit(cloneRoot, ["rev-parse", "--git-path", "objects/info/alternates"], gitEnv);
  const alternates = isAbsolute(alternatesRaw) ? alternatesRaw : resolve(cloneRoot, alternatesRaw);
  contract(!existsSync(alternates), "exact-HEAD clone has a shared-object alternates file");
  contract(
    strictDescendant(cloneRealpath, commonDir) && strictDescendant(commonDir, objectDir),
    "exact-HEAD clone Git common/object directories escaped the owned clone",
  );
  for (const sourcePath of [source.commonDir, source.objectDir]) {
    contract(
      sourcePath !== commonDir
        && sourcePath !== objectDir
        && !strictDescendant(sourcePath, commonDir)
        && !strictDescendant(commonDir, sourcePath)
        && !strictDescendant(sourcePath, objectDir)
        && !strictDescendant(objectDir, sourcePath),
      "exact-HEAD clone shares a Git common/object directory with the source",
    );
  }
  contract(
    exactHeadGit(cloneRoot, ["rev-parse", "--is-shallow-repository"], gitEnv) === "false",
    "exact-HEAD correctness clone lost complete history",
  );
  exactHeadGit(cloneRoot, ["cat-file", "-e", ORIGINAL_SMOKE_COMMIT + "^{commit}"], gitEnv);
  contract(
    exactHeadGit(cloneRoot, ["rev-parse", "--verify", "HEAD^{commit}"], gitEnv) === source.head
      && exactHeadGit(cloneRoot, ["rev-parse", "HEAD^{tree}"], gitEnv) === source.tree
      && exactHeadGit(cloneRoot, ["rev-parse", "HEAD:" + harnessRelativePath], gitEnv)
        === source.harnessBlob,
    "exact-HEAD clone is not bound to the captured commit/tree/harness blob",
  );
  requireCleanExactHeadStatus(
    exactHeadGit(cloneRoot, ["status", "--porcelain=v1", "--untracked-files=all"], gitEnv),
    "exact-HEAD clone",
  );
  return { cloneRealpath, commonDir, objectDir, alternates };
}

function correctnessDependencyRoot() {
  for (let cursor = repoRoot; ; cursor = dirname(cursor)) {
    const candidate = join(cursor, "node_modules");
    if (existsSync(join(candidate, "typescript/package.json"))) return realpathSync(candidate);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new BootstrapFailure("exact-HEAD correctness isolation could not locate node_modules");
}

function snapshotCorrectnessDependencies(path) {
  const entry = lstatSync(path);
  contract(entry.isDirectory() && !entry.isSymbolicLink(), "correctness dependency target is not a real directory");
  return {
    path,
    dev: entry.dev,
    ino: entry.ino,
    mode: entry.mode,
    mtimeMs: entry.mtimeMs,
    digest: treeContentDigest(path, "correctness dependency target"),
  };
}

function assertCorrectnessDependenciesUnchanged(snapshot, link) {
  const entry = lstatSync(snapshot.path);
  contract(
    entry.isDirectory() && !entry.isSymbolicLink()
      && entry.dev === snapshot.dev && entry.ino === snapshot.ino
      && entry.mode === snapshot.mode && entry.mtimeMs === snapshot.mtimeMs
      && treeContentDigest(snapshot.path, "final correctness dependency target") === snapshot.digest,
    "read-only correctness dependency target changed during inner execution",
  );
  const linkEntry = lstatSync(link.path);
  contract(
    linkEntry.isSymbolicLink()
      && linkEntry.dev === link.dev && linkEntry.ino === link.ino
      && realpathSync(link.path) === snapshot.path,
    "read-only correctness dependency link or target changed during inner execution",
  );
}

const EXACT_HEAD_MANIFEST_FIELDS = [
  "schema", "nonce", "selector", "innerRoot", "head", "tree", "harnessBlob",
  "originalSmokeCommit", "outerPid", "ownerDev", "ownerIno", "manifestDev", "manifestIno", "createdAtMs",
  "supervisorSafetyProven",
].sort();

function validateExactHeadIsolationManifest(payload, expected) {
  contract(payload && typeof payload === "object" && !Array.isArray(payload), "isolation manifest is not an object");
  contract(
    json(Object.keys(payload).sort()) === json(EXACT_HEAD_MANIFEST_FIELDS),
    "isolation manifest fields are not exact",
  );
  contract(payload.schema === EXACT_HEAD_ISOLATION_SCHEMA, "isolation manifest schema is invalid");
  contract(payload.nonce === expected.nonce, "isolation manifest nonce is invalid");
  contract(payload.selector === expected.selector, "isolation manifest selector is invalid");
  contract(payload.innerRoot === expected.innerRoot, "isolation manifest inner realpath is invalid");
  contract(
    payload.head === expected.head
      && payload.tree === expected.tree
      && payload.harnessBlob === expected.harnessBlob,
    "isolation manifest HEAD/tree/harness binding is invalid",
  );
  contract(payload.originalSmokeCommit === ORIGINAL_SMOKE_COMMIT, "isolation manifest lost baseline history binding");
  contract(
    payload.supervisorSafetyProven === expected.supervisorSafetyProven,
    "isolation manifest supervisor-safety binding is invalid",
  );
  contract(payload.outerPid === expected.outerPid, "isolation manifest parent PID is invalid");
  contract(Number.isSafeInteger(payload.ownerDev) && Number.isSafeInteger(payload.ownerIno),
    "isolation manifest owner identity is invalid");
  contract(Number.isSafeInteger(payload.manifestDev) && Number.isSafeInteger(payload.manifestIno),
    "isolation manifest file identity is invalid");
  contract(
    Number.isSafeInteger(payload.createdAtMs)
      && Date.now() >= payload.createdAtMs
      && Date.now() - payload.createdAtMs < 5 * 60_000,
    "isolation manifest is stale or future-dated",
  );
}

function consumeExactHeadIsolationAuthorization(selected) {
  const manifestPathValue = process.env[EXACT_HEAD_ISOLATION_MANIFEST_ENV];
  const nonce = process.env[EXACT_HEAD_ISOLATION_NONCE_ENV];
  delete process.env[EXACT_HEAD_ISOLATION_MANIFEST_ENV];
  delete process.env[EXACT_HEAD_ISOLATION_NONCE_ENV];
  if (manifestPathValue === undefined && nonce === undefined) return null;
  if (typeof manifestPathValue !== "string" || typeof nonce !== "string") {
    throw new BootstrapFailure("partial or non-string exact-HEAD isolation authority");
  }
  contract(isAbsolute(manifestPathValue) && resolve(manifestPathValue) === manifestPathValue,
    "isolation manifest path is not canonical and absolute");
  const ownerPath = dirname(manifestPathValue);
  const ownerEntry = lstatSync(ownerPath);
  const ownerRealpath = realpathSync(ownerPath);
  contract(ownerEntry.isDirectory() && !ownerEntry.isSymbolicLink(), "isolation owner is not a real directory");
  const before = lstatSync(manifestPathValue);
  contract(before.isFile() && !before.isSymbolicLink() && before.nlink === 1,
    "isolation manifest is not a single-link regular file");
  const fd = openSync(manifestPathValue, fsConstants.O_RDONLY | noFollowFlag());
  let payload;
  try {
    const opened = fstatSync(fd);
    const rebound = lstatSync(manifestPathValue);
    contract(
      opened.isFile() && opened.dev === before.dev && opened.ino === before.ino
        && rebound.isFile() && !rebound.isSymbolicLink()
        && rebound.dev === before.dev && rebound.ino === before.ino,
      "isolation manifest changed during verified open",
    );
    payload = JSON.parse(readFileSync(fd, "utf8"));
  } catch (error) {
    if (error instanceof ContractFailure) throw error;
    throw new ContractFailure("isolation manifest is unreadable: " + error.message);
  } finally {
    closeSync(fd);
  }
  const env = exactHeadGitEnvironment();
  const actualInnerRoot = realpathSync(repoRoot);
  const actualHead = exactHeadGit(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"], env);
  validateExactHeadIsolationManifest(payload, {
    nonce,
    selector: selected,
    innerRoot: actualInnerRoot,
    head: actualHead,
    tree: exactHeadGit(repoRoot, ["rev-parse", "HEAD^{tree}"], env),
    harnessBlob: exactHeadGit(repoRoot, ["rev-parse", "HEAD:" + harnessRelativePath], env),
    outerPid: process.ppid,
    supervisorSafetyProven: selected === "resource-parallel-contract",
  });
  contract(
    payload.ownerDev === ownerEntry.dev && payload.ownerIno === ownerEntry.ino
      && payload.manifestDev === before.dev && payload.manifestIno === before.ino,
    "isolation manifest filesystem identity is invalid",
  );
  contract(strictDescendant(ownerRealpath, actualInnerRoot), "authorized inner root escaped its owned base");
  requireCleanExactHeadStatus(
    exactHeadGit(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"], env),
    "authorized exact-HEAD inner clone",
  );
  contract(
    exactHeadGit(repoRoot, ["hash-object", "--no-filters", "--", harnessRelativePath], env)
      === payload.harnessBlob,
    "authorized inner harness bytes differ from HEAD",
  );
  exactHeadGit(repoRoot, ["cat-file", "-e", ORIGINAL_SMOKE_COMMIT + "^{commit}"], env);
  const finalEntry = lstatSync(manifestPathValue);
  contract(finalEntry.dev === before.dev && finalEntry.ino === before.ino,
    "isolation manifest changed before one-shot consumption");
  unlinkSync(manifestPathValue);
  return payload;
}

function snapshotExactHeadProcesses(platform = process.platform) {
  if (platform === "win32") {
    const script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process "
      + "| Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress";
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 2_000,
      env: harnessChildEnvironment(),
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
      throw new BootstrapFailure(
        "could not snapshot Windows exact-HEAD descendants: "
          + (result.error?.message ?? String(result.stderr ?? `exit ${result.status}`)),
      );
    }
    const raw = result.stdout.trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
      pid: Number(row.ProcessId),
      ppid: Number(row.ParentProcessId),
      pgid: null,
      birthIdentity: String(row.CreationDate ?? ""),
      state: "",
      marker: String(row.CommandLine ?? ""),
    })).filter((row) => row.pid !== result.pid);
  }
  const result = spawnSync(
    "ps",
    ["eww", "-axo", "pid=,ppid=,pgid=,lstart=,state=,command="],
    {
      encoding: "utf8",
      env: harnessChildEnvironment({ LC_ALL: "C" }),
      maxBuffer: 8 * 1024 * 1024,
      timeout: 2_000,
    },
  );
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    throw new BootstrapFailure(
      "could not snapshot POSIX exact-HEAD descendants: "
        + (result.error?.message ?? String(result.stderr ?? `exit ${result.status}`)),
    );
  }
  const rows = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.*?)\s*$/.exec(line);
    if (!match) throw new BootstrapFailure("POSIX exact-HEAD process snapshot contained an unparseable row");
    const row = {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      birthIdentity: match[4],
      state: match[5],
      marker: match[6],
    };
    if (row.pid !== result.pid) rows.push(row);
  }
  return rows;
}

function exactHeadTreeLeaseStdio() {
  contract(
    EXACT_HEAD_TREE_LEASE_FD === 4,
    "exact-HEAD tree lease must remain on the source-audited low descriptor 4",
  );
  const stdio = ["ignore", "inherit", "inherit"];
  while (stdio.length < EXACT_HEAD_TREE_LEASE_FD) stdio.push("ignore");
  stdio[EXACT_HEAD_TREE_LEASE_FD] = "pipe";
  return stdio;
}

function exactHeadTreeLeaseRootEnvironment(overrides, guardianMarker, releaseRecord, releaseNonce) {
  contract(
    typeof guardianMarker === "string" && guardianMarker.length >= 16 && !/\s/.test(guardianMarker),
    "exact-HEAD guardian marker is invalid",
  );
  contract(
    releaseRecord && typeof releaseRecord.realpath === "string"
      && typeof releaseNonce === "string" && releaseNonce.length >= 16,
    "exact-HEAD guardian release authority is invalid",
  );
  const env = harnessChildEnvironment(overrides);
  env[EXACT_HEAD_TREE_LEASE_ROOT_ENV] = "1";
  env[EXACT_HEAD_TREE_LEASE_GUARDIAN_ENV] = guardianMarker;
  env[EXACT_HEAD_TREE_LEASE_RELEASE_PATH_ENV] = releaseRecord.realpath;
  env[EXACT_HEAD_TREE_LEASE_RELEASE_NONCE_ENV] = releaseNonce;
  return env;
}

function createExactHeadTreeLeaseGuardianAuthority(owner, label) {
  assertHarnessOwnedBase(owner, label + " guardian owner");
  const releaseRecord = createHarnessOwnedFile(
    owner,
    "tree-lease-release-" + randomUUID() + ".token",
    label + " guardian release token",
  );
  return {
    marker: "b-e40f-tree-lease-guardian-" + randomUUID(),
    releaseRecord,
    nonce: randomUUID(),
    released: false,
  };
}

function releaseExactHeadTreeLeaseGuardian(authority, label) {
  contract(authority && authority.released === false, label + " guardian was already released");
  writeHarnessOwnedFile(
    authority.releaseRecord,
    label + " guardian release token",
    authority.nonce,
  );
  authority.released = true;
}

function monitorExactHeadTreeLease(stream, rootProcess = null) {
  contract(stream && typeof stream.once === "function" && typeof stream.resume === "function",
    "exact-HEAD tree lease stream is unavailable");
  contract(
    rootProcess === null || (typeof rootProcess === "object" && rootProcess !== null),
    "exact-HEAD tree lease root-process binding is invalid",
  );
  let settled = false;
  let latest = null;
  let rootTerminalObserved = false;
  let resolveOutcome;
  const outcome = new Promise((resolve) => { resolveOutcome = resolve; });
  const settle = (value) => {
    if (settled) return;
    settled = true;
    latest = value;
    resolveOutcome(value);
  };
  const rootTerminalKnown = () => rootTerminalObserved
    || rootProcess?.exitCode !== null && rootProcess?.exitCode !== undefined
    || rootProcess?.signalCode !== null && rootProcess?.signalCode !== undefined;
  if (rootProcess && typeof rootProcess.once === "function") {
    rootProcess.once("exit", () => { rootTerminalObserved = true; });
  }
  stream.once("end", () => {
    const afterRootTerminal = rootTerminalKnown();
    settle({
      cleared: afterRootTerminal,
      reason: afterRootTerminal ? "eof" : "eof-before-root-terminal",
      afterRootTerminal,
    });
  });
  stream.once("error", (error) => settle({
    cleared: false,
    reason: "error: " + error.message,
    afterRootTerminal: false,
  }));
  stream.once("close", () => {
    if (settled) return;
    if (stream.readableEnded === true) {
      const afterRootTerminal = rootTerminalKnown();
      settle({
        cleared: afterRootTerminal,
        reason: afterRootTerminal ? "eof-close" : "eof-before-root-terminal",
        afterRootTerminal,
      });
    } else {
      settle({ cleared: false, reason: "premature-close", afterRootTerminal: false });
    }
  });
  stream.resume();
  return {
    async wait(timeoutMs = 2_000) {
      contract(Number.isSafeInteger(timeoutMs) && timeoutMs >= 0,
        "exact-HEAD tree lease wait is invalid");
      if (latest) return latest;
      return await new Promise((resolveWait) => {
        const timer = setTimeout(
          () => resolveWait({ cleared: false, reason: "timeout", afterRootTerminal: false }),
          timeoutMs,
        );
        void outcome.then((value) => {
          clearTimeout(timer);
          resolveWait(value);
        });
      });
    },
    markRootTerminal() { rootTerminalObserved = true; },
    close() { stream.destroy(); },
  };
}

async function proveExactHeadTreeLeaseKernel() {
  const owner = createHarnessOwnedBase("b-e40f-kernel-tree-lease-");
  const preload = createHarnessOwnedFile(owner, "tree-lease-preload.cjs", "kernel tree lease preload");
  const treeMarker = "b-e40f-kernel-tree-marker-" + randomUUID();
  const innerMarker = "b-e40f-kernel-inner-marker-" + randomUUID();
  const titleReceipt = createHarnessOwnedFile(owner, "tree-title.txt", "kernel tree title receipt");
  writeHarnessOwnedFile(preload, "kernel tree lease preload", exactHeadTreeLeasePreloadSource(treeMarker));
  const nativeCommand = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
  const nativeArgs = process.platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Milliseconds 300"]
    : ["-c", "sleep 0.3"];
  const source = [
    'const { writeFileSync } = require("node:fs");',
    'const { spawn } = require("node:child_process");',
    `writeFileSync(${json(titleReceipt.realpath)}, process.title);`,
    `const child = spawn(${json(nativeCommand)}, ${json(nativeArgs)}, { detached: true, stdio: "ignore" });`,
    "child.unref();",
    "setTimeout(() => {}, 200);",
  ].join("\n");
  let child = null;
  let lease = null;
  let outcome = null;
  let immediate = null;
  let guardianAuthority = null;
  const startedAt = Date.now();
  try {
    guardianAuthority = createExactHeadTreeLeaseGuardianAuthority(owner, "kernel native lease");
    child = spawn(process.execPath, ["--title=" + innerMarker, "-e", source], {
      cwd: owner.realpath,
      env: exactHeadTreeLeaseRootEnvironment(
        { NODE_OPTIONS: "--require=" + preload.realpath },
        guardianAuthority.marker,
        guardianAuthority.releaseRecord,
        guardianAuthority.nonce,
      ),
      detached: process.platform !== "win32",
      stdio: exactHeadTreeLeaseStdio(),
      windowsHide: true,
    });
    lease = monitorExactHeadTreeLease(child.stdio[EXACT_HEAD_TREE_LEASE_FD], child);
    const titleDeadline = Date.now() + 2_000;
    let titleIdentity = null;
    while (Date.now() < titleDeadline) {
      const title = readHarnessOwnedFile(titleReceipt, "kernel tree title receipt", "utf8");
      const identity = snapshotHarnessProcess(child.pid);
      // Win32_Process.CommandLine is immutable and therefore proves the
      // explicit inner argv marker plus CreationDate, while the receipt proves
      // the runtime composite title. POSIX ps exposes the rewritten title and
      // must retain both markers in the OS-visible identity.
      const osIdentityBound = process.platform === "win32"
        ? identity?.birthIdentity.length > 0 && identity.marker?.includes(innerMarker)
        : identity?.marker?.includes(treeMarker) && identity.marker.includes(innerMarker);
      if (title.startsWith(treeMarker + ":") && title.includes(innerMarker)
        && osIdentityBound) {
        titleIdentity = { title, identity };
        break;
      }
      await wait(10);
    }
    contract(
      titleIdentity !== null,
      "tree-lease preload did not preserve the outer and inner process-title markers",
    );
    const terminal = await new Promise((resolveTerminal) => {
      child.once("error", (error) => resolveTerminal({ error, status: null, signal: null }));
      child.once("exit", (status, signal) => {
        lease.markRootTerminal();
        releaseExactHeadTreeLeaseGuardian(guardianAuthority, "kernel native lease");
        resolveTerminal({ error: null, status, signal });
      });
    });
    contract(terminal.error === null && terminal.status === 0,
      "tree-lease kernel probe root failed: " + json(terminal));
    immediate = await lease.wait(0);
    outcome = await lease.wait(2_000);
    const elapsedMs = Date.now() - startedAt;
    contract(
      immediate.cleared === false && outcome.cleared === true
        && outcome.afterRootTerminal === true && elapsedMs >= 200,
      "kernel tree lease reached EOF before its detached native descendant: "
        + json({ immediate, outcome, elapsedMs }),
    );
    lease.close();
    lease = null;

    const leaseCheck = createHarnessOwnedFile(owner, "lease-check.cjs", "tree lease API check");
    writeHarnessOwnedFile(
      leaseCheck,
      "tree lease API check",
      `require("node:fs").fstatSync(${EXACT_HEAD_TREE_LEASE_FD});\n`
        + "if (typeof process.disconnect === 'function' && process.connected) process.disconnect();\n",
    );
    const metadataPreload = createHarnessOwnedFile(
      owner,
      "metadata-preload.cjs",
      "tree lease metadata preload",
    );
    const metadataSymbol = "proof-or-stop.b-e40f.tree-lease-metadata";
    writeHarnessOwnedFile(
      metadataPreload,
      "tree lease metadata preload",
      'const cp = require("node:child_process");\n'
        + `Object.defineProperty(cp.spawn, Symbol.for(${json(metadataSymbol)}), `
        + '{ configurable: true, value: "preserved" });\n',
    );
    const execSyncCommand = process.platform === "win32"
      ? `"${process.execPath.replaceAll('"', '""')}" "${leaseCheck.realpath.replaceAll('"', '""')}"`
      : [process.execPath, leaseCheck.realpath]
        .map((value) => "'" + value.replaceAll("'", "'\\''") + "'")
        .join(" ");
    const apiProbe = createHarnessOwnedFile(owner, "lease-api-probe.cjs", "tree lease API probe");
    const nestedWorkerMarker = "proof-or-stop-qsm-" + randomUUID();
    writeHarnessOwnedFile(apiProbe, "tree lease API probe", [
      '"use strict";',
      'const assert = require("node:assert/strict");',
      'const cp = require("node:child_process");',
      'const bareCp = require("child_process");',
      'const { promisify } = require("node:util");',
      'const { spawn: cjsSpawn } = cp;',
      `const node = ${json(process.execPath)};`,
      `const check = ${json(leaseCheck.realpath)};`,
      `const command = ${json(execSyncCommand)};`,
      `const leaseFd = ${EXACT_HEAD_TREE_LEASE_FD};`,
      `const treeMarkerKey = ${json(EXACT_HEAD_TREE_LEASE_MARKER_ENV)};`,
      `const treeMarker = ${json(treeMarker)};`,
      `const metadata = Symbol.for(${json(metadataSymbol)});`,
      'const wait = (child, label) => new Promise((resolve, reject) => {',
      '  child.once("error", reject);',
      '  child.once("exit", (status, signal) => {',
      '    if (status === 0) resolve();',
      '    else reject(new Error(label + " failed: " + JSON.stringify({ status, signal })));',
      '  });',
      '});',
      'function rejectsSync(action, pattern, label) {',
      '  let error = null;',
      '  try { action(); } catch (caught) { error = caught; }',
      '  assert.match(error?.message ?? "", pattern, label);',
      '}',
      'async function main() {',
      '  const finiteEnv = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]',
      '    .filter((key) => typeof process.env[key] === "string")',
      '    .map((key) => [key, process.env[key]]));',
      '  assert.equal(cp.spawn[metadata], "preserved");',
      '  assert.equal(cp.spawnSync(node, [check], { stdio: "ignore" }).status, 0);',
      // A short argv gives process.title less backing storage than the long
      // absolute fixture path above. This is the qsm-001 regression shape.
      '  assert.equal(cp.spawnSync(node, ["-e", ""], { stdio: "ignore" }).status, 0);',
      '  const shortArgvSource = "if (process.env[" + JSON.stringify(treeMarkerKey)',
      '    + "] !== " + JSON.stringify(treeMarker) + ") process.exit(91);";',
      '  assert.equal(cp.spawnSync(node, ["-"], {',
      '    input: shortArgvSource, stdio: ["pipe", "ignore", "ignore"],',
      '  }).status, 0);',
      `  const nestedWorkerMarker = ${json(nestedWorkerMarker)};`,
      '  const nestedWorkerEnv = {',
      '    ...process.env,',
      '    PROOF_OR_STOP_QUORUM_SMOKE_WORKER_PROCESS_MARKER: nestedWorkerMarker,',
      '  };',
      '  const nestedWorkerSource = shortArgvSource',
      '    + "if (process.env.PROOF_OR_STOP_QUORUM_SMOKE_WORKER_PROCESS_MARKER !== "',
      '    + JSON.stringify(nestedWorkerMarker) + ") process.exit(92);";',
      '  assert.equal(cp.spawnSync(node, ["-"], {',
      '    input: nestedWorkerSource, stdio: ["pipe", "ignore", "ignore"], env: nestedWorkerEnv,',
      '  }).status, 0);',
      '  cp.execFileSync(node, [check], { stdio: "ignore" });',
      '  cp.execSync(command, { stdio: "ignore" });',
      '  await wait(cjsSpawn(node, [check], { stdio: "ignore" }), "CJS destructured spawn");',
      '  await wait(bareCp.spawn(node, [check], { stdio: "ignore", env: finiteEnv }),',
      '    "bare CJS spawn with explicit env");',
      '  const esm = await import("node:child_process");',
      '  await wait(esm.spawn(node, [check], { stdio: "ignore" }), "ESM named spawn");',
      '  const bareEsm = await import("child_process");',
      '  await wait(bareEsm.spawn(node, [check], { stdio: "ignore" }), "bare ESM named spawn");',
      '  const defaultFork = cp.fork(check, [], {});',
      '  assert.equal(defaultFork.stdout, null);',
      '  await wait(defaultFork, "default fork");',
      '  const silentFork = cp.fork(check, [], { silent: true });',
      '  assert.ok(silentFork.stdout && silentFork.stderr);',
      '  await wait(silentFork, "silent fork");',
      '  await wait(cp.fork(check, [], {',
      '    stdio: ["ignore", "ignore", "ignore", "ipc"],',
      '  }), "explicit-ipc fork");',
      '  await wait(cp.fork(check, [], { silent: true, env: finiteEnv }),',
      '    "explicit-env fork");',
      '  rejectsSync(() => cp.spawn(node, [check], {',
      '    stdio: ["ignore", "ignore", "ignore", "ignore", "ignore"],',
      '  }), /collides with child stdio/, "fd collision was accepted");',
      '  rejectsSync(() => cp.fork(check, [], {',
      '    stdio: ["ignore", "ignore", "ignore"],',
      '  }), /exactly one ipc descriptor/, "fork without ipc was accepted");',
      '  rejectsSync(() => cp.fork(check, [], {',
      '    stdio: ["ignore", "ignore", "ignore", "ipc", null, "ipc"],',
      '  }), /exactly one ipc descriptor/, "fork with duplicate ipc was accepted");',
      '  rejectsSync(() => cp.spawn(node, [check], { shell: "/bin/sh" }),',
      '    /rejects child shell overrides/, "spawn shell override was accepted");',
      '  rejectsSync(() => cp.fork(check, [], { execPath: "/bin/sh" }),',
      '    /rejects fork execPath overrides/, "fork execPath override was accepted");',
      '  rejectsSync(() => cp.execFile(node, [check], () => {}),',
      '    /rejects async execFile authority/, "async execFile was accepted");',
      '  rejectsSync(() => cp.exec(command, () => {}),',
      '    /rejects async exec authority/, "async exec was accepted");',
      '  await assert.rejects(promisify(cp.execFile)(node, [check]), /rejects async execFile authority/);',
      '  await assert.rejects(promisify(cp.exec)(command), /rejects async exec authority/);',
      '  assert.equal(leaseFd, 4);',
      '}',
      'main().catch((error) => { console.error(error); process.exitCode = 1; });',
      '',
    ].join("\n"));
    outcome = null;
    guardianAuthority = createExactHeadTreeLeaseGuardianAuthority(owner, "kernel API lease");
    child = spawn(process.execPath, [apiProbe.realpath], {
      cwd: owner.realpath,
      env: exactHeadTreeLeaseRootEnvironment(
        { NODE_OPTIONS: `--require=${metadataPreload.realpath} --require=${preload.realpath}` },
        guardianAuthority.marker,
        guardianAuthority.releaseRecord,
        guardianAuthority.nonce,
      ),
      detached: process.platform !== "win32",
      stdio: exactHeadTreeLeaseStdio(),
      windowsHide: true,
    });
    lease = monitorExactHeadTreeLease(child.stdio[EXACT_HEAD_TREE_LEASE_FD], child);
    const apiTerminal = await new Promise((resolveTerminal) => {
      child.once("error", (error) => resolveTerminal({ error, status: null, signal: null }));
      child.once("exit", (status, signal) => {
        lease.markRootTerminal();
        releaseExactHeadTreeLeaseGuardian(guardianAuthority, "kernel API lease");
        resolveTerminal({ error: null, status, signal });
      });
    });
    outcome = await lease.wait(2_000);
    contract(
      apiTerminal.error === null && apiTerminal.status === 0
        && outcome.cleared === true && outcome.afterRootTerminal === true,
      "tree-lease preload API surface failed: " + json({ apiTerminal, outcome }),
    );
    lease.close();
    lease = null;

    const explicitEnvGrandchild = createHarnessOwnedFile(
      owner,
      "explicit-env-grandchild.cjs",
      "tree lease explicit-env grandchild",
    );
    const longNativeArgs = process.platform === "win32"
      ? ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Milliseconds 700"]
      : ["-c", "sleep 0.7"];
    const boundedEnvSource = "Object.fromEntries(['PATH','SystemRoot','WINDIR','ComSpec','PATHEXT']"
      + ".filter((key) => typeof process.env[key] === 'string')"
      + ".map((key) => [key, process.env[key]]))";
    writeHarnessOwnedFile(explicitEnvGrandchild, "tree lease explicit-env grandchild", [
      'const { spawn } = require("node:child_process");',
      `const child = spawn(${json(nativeCommand)}, ${json(longNativeArgs)}, {`,
      `  detached: ${process.platform === "win32" ? "false" : "true"},`,
      `  env: ${boundedEnvSource},`,
      '  stdio: "ignore",',
      '});',
      'child.unref();',
      '',
    ].join("\n"));
    const explicitEnvRoot = createHarnessOwnedFile(
      owner,
      "explicit-env-root.cjs",
      "tree lease explicit-env root",
    );
    writeHarnessOwnedFile(explicitEnvRoot, "tree lease explicit-env root", [
      'const { spawn } = require("node:child_process");',
      `const child = spawn(process.execPath, [${json(explicitEnvGrandchild.realpath)}], {`,
      `  detached: ${process.platform === "win32" ? "false" : "true"},`,
      `  env: ${boundedEnvSource},`,
      '  stdio: "ignore",',
      '});',
      'child.unref();',
      '',
    ].join("\n"));
    outcome = null;
    guardianAuthority = createExactHeadTreeLeaseGuardianAuthority(owner, "kernel explicit-env lease");
    const explicitEnvStartedAt = Date.now();
    child = spawn(process.execPath, [explicitEnvRoot.realpath], {
      cwd: owner.realpath,
      env: exactHeadTreeLeaseRootEnvironment(
        { NODE_OPTIONS: "--require=" + preload.realpath },
        guardianAuthority.marker,
        guardianAuthority.releaseRecord,
        guardianAuthority.nonce,
      ),
      detached: process.platform !== "win32",
      stdio: exactHeadTreeLeaseStdio(),
      windowsHide: true,
    });
    lease = monitorExactHeadTreeLease(child.stdio[EXACT_HEAD_TREE_LEASE_FD], child);
    const explicitEnvTerminal = await new Promise((resolveTerminal) => {
      child.once("error", (error) => resolveTerminal({ error, status: null, signal: null }));
      child.once("exit", (status, signal) => {
        lease.markRootTerminal();
        releaseExactHeadTreeLeaseGuardian(guardianAuthority, "kernel explicit-env lease");
        resolveTerminal({ error: null, status, signal });
      });
    });
    outcome = await lease.wait(2_000);
    const explicitEnvElapsedMs = Date.now() - explicitEnvStartedAt;
    contract(
      explicitEnvTerminal.error === null && explicitEnvTerminal.status === 0
        && outcome.cleared === true && outcome.afterRootTerminal === true
        && explicitEnvElapsedMs >= 600,
      "explicit child env dropped recursive tree-lease preload propagation: "
        + json({ explicitEnvTerminal, outcome, explicitEnvElapsedMs }),
    );
  } finally {
    if (!outcome?.cleared) await new Promise((resolveWait) => setTimeout(resolveWait, 400));
    lease?.close();
    cleanupHarnessOwnedBase(owner, "kernel tree lease probe");
  }
}

function startExactHeadProcessSupervisor(dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const snapshot = dependencies.snapshot ?? (() => snapshotExactHeadProcesses(platform));
  const pause = dependencies.pause ?? ((milliseconds) => new Promise((resolveWait) => {
    setTimeout(resolveWait, milliseconds);
  }));
  const signalPid = dependencies.signalPid ?? ((pid, signal) => process.kill(pid, signal));
  const taskkill = dependencies.taskkill ?? ((pid, force, tree = true) => {
    execFileSync("taskkill", ["/PID", String(pid), ...(tree ? ["/T"] : []), ...(force ? ["/F"] : [])], {
      env: harnessChildEnvironment(),
      stdio: "ignore",
      timeout: 2_000,
    });
  });
  const roots = new Map();
  const captured = new Map();
  const markers = new Set();
  const cleanupBarrierMarkers = new Set();
  const owners = [];
  const errors = [];
  const rootErrors = new Map();
  const treeClearanceErrors = new Map();
  const uncertainPids = new Set();
  let healthy = true;
  let interval = null;
  let abortSignal = null;
  let abortPromise = null;
  let resolveAbortOutcome;
  const abortOutcome = new Promise((resolveOutcome) => { resolveAbortOutcome = resolveOutcome; });
  const key = (row) => `${row.pid}:${row.birthIdentity}:${row.pgid ?? "windows"}`;
  const retireConfirmedReusedCapture = (identityKey, identity, current) => {
    const rootIdentity = roots.get(identity.pid);
    const isTrackedRootIdentity = rootIdentity?.identityKey === identityKey;
    if (isTrackedRootIdentity || uncertainPids.has(identity.pid)
      || current.birthIdentity === identity.birthIdentity) {
      return false;
    }
    captured.delete(identityKey);
    return true;
  };
  const markerWitnessFor = (row) => [...markers]
    .filter((marker) => row.marker.includes(marker))
    .sort((left, right) => right.length - left.length)[0] ?? null;
  const allErrors = () => [
    ...errors,
    ...rootErrors.values(),
    ...treeClearanceErrors.values(),
  ];
  const validatedSnapshot = () => {
    const rows = [...snapshot()];
    const pids = new Set();
    for (const row of rows) {
      const validPgid = platform === "win32" ? row.pgid === null : Number.isSafeInteger(row.pgid);
      if (!Number.isSafeInteger(row.pid) || row.pid <= 0
        || !Number.isSafeInteger(row.ppid) || row.ppid < 0
        || !validPgid || typeof row.birthIdentity !== "string" || !row.birthIdentity
        || typeof row.marker !== "string" || pids.has(row.pid)) {
        throw new BootstrapFailure("exact-HEAD process snapshot has an invalid or duplicate identity");
      }
      pids.add(row.pid);
    }
    return rows;
  };
  const markerMatches = (row) => [...markers].some((marker) => row.marker.includes(marker));
  const cleanupBarrierMatches = (row) => [...cleanupBarrierMarkers]
    .some((marker) => row.marker.includes(marker));
  const observe = () => {
    let rows;
    try { rows = validatedSnapshot(); }
    catch (error) {
      healthy = false;
      errors.push("snapshot: " + error.message);
      throw error;
    }
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const owned = new Set();
    for (const [pid, rootIdentity] of roots) {
      const row = byPid.get(pid);
      if (row?.state.startsWith("Z")) {
        continue;
      } else if (row && key(row) !== rootIdentity.identityKey) {
        uncertainPids.add(pid);
        rootErrors.set(pid, "root identity changed for pid " + pid);
      } else if (row && rootIdentity.markerWitness !== null
        && !row.marker.includes(rootIdentity.markerWitness)) {
        uncertainPids.add(pid);
        rootErrors.set(pid, "root marker witness changed for pid " + pid);
      } else if (row && !uncertainPids.has(pid)) {
        owned.add(pid);
      }
    }
    for (const row of rows) {
      if (!row.state.startsWith("Z")
        && !uncertainPids.has(row.pid) && markerMatches(row)) owned.add(row.pid);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (!row.state.startsWith("Z") && owned.has(row.ppid)
          && !owned.has(row.pid) && !uncertainPids.has(row.pid)) {
          owned.add(row.pid);
          changed = true;
        }
      }
    }
    for (const row of rows) {
      if (row.state.startsWith("Z") || !owned.has(row.pid)) continue;
      const identityKey = key(row);
      if (!captured.has(identityKey)) {
        captured.set(identityKey, {
          ...row,
          strongCapture: platform === "win32",
          stopped: false,
          cleanupBarrier: cleanupBarrierMatches(row),
        });
      } else if (cleanupBarrierMatches(row)) {
        captured.get(identityKey).cleanupBarrier = true;
      }
    }
    return { rows, byPid, owned };
  };
  const safeObserve = () => {
    try { observe(); } catch { /* a failed census is retained in healthy/errors */ }
  };
  const ensureInterval = () => {
    if (interval || dependencies.startInterval === false) return;
    interval = setInterval(safeObserve, dependencies.intervalMs ?? 1_000);
    interval.unref();
  };
  const addMarker = (marker) => {
    contract(typeof marker === "string" && marker.length >= 16, "exact-HEAD workload marker is too weak");
    markers.add(marker);
    safeObserve();
  };
  const addCleanupBarrierMarker = (marker) => {
    contract(typeof marker === "string" && marker.length >= 16,
      "exact-HEAD cleanup-barrier marker is too weak");
    cleanupBarrierMarkers.add(marker);
    markers.add(marker);
    safeObserve();
  };
  const trackRoot = (pid, options = {}) => {
    contract(Number.isSafeInteger(pid) && pid > 1, "exact-HEAD tracked root pid is invalid");
    const { byPid } = observe();
    const row = byPid.get(pid);
    if (!row) {
      healthy = false;
      throw new BootstrapFailure("exact-HEAD child disappeared before birth identity capture: " + pid);
    }
    const identityKey = key(row);
    const markerWitness = platform === "win32" ? null : markerWitnessFor(row);
    if (platform !== "win32" && markerWitness === null) {
      healthy = false;
      errors.push("tracked POSIX root lacks a registered marker witness for pid " + pid);
      throw new BootstrapFailure(
        "exact-HEAD POSIX child lacks a registered marker witness: " + pid,
      );
    }
    roots.set(pid, {
      identityKey,
      markerWitness,
      requiresTreeClearance: options.requiresTreeClearance === true,
    });
    captured.set(identityKey, {
      ...row,
      strongCapture: platform === "win32",
      stopped: false,
      cleanupBarrier: false,
    });
    ensureInterval();
    observe();
    return row;
  };
  const retireRoot = (pid, terminal, options = {}) => {
    contract(
      terminal?.error === null
        && (Number.isInteger(terminal.status)
          || (typeof terminal.signal === "string" && terminal.signal.length > 0)),
      "exact-HEAD root retirement requires a direct child exit event",
    );
    const rootIdentity = roots.get(pid);
    if (!rootIdentity) return { treeCleared: false };
    const treeCleared = !rootIdentity.requiresTreeClearance || options.treeClearance === true;
    if (!treeCleared) {
      treeClearanceErrors.set(
        pid,
        "root exited without authenticated descendant-tree clearance for pid " + pid,
      );
    } else {
      treeClearanceErrors.delete(pid);
    }
    roots.delete(pid);
    captured.delete(rootIdentity.identityKey);
    uncertainPids.delete(pid);
    rootErrors.delete(pid);
    return { treeCleared };
  };
  const confirmTreeClearance = (pid) => {
    contract(
      treeClearanceErrors.has(pid),
      "exact-HEAD tree-clearance confirmation lacks a pending retired root: " + pid,
    );
    treeClearanceErrors.delete(pid);
  };
  const currentOwned = () => {
    const observation = observe();
    const live = [];
    const ambiguous = [];
    for (const [identityKey, identity] of captured) {
      const current = observation.byPid.get(identity.pid);
      if (!current || current.state.startsWith("Z")) continue;
      // A non-root PID with a different birth identity is a reused PID, not a
      // survivor of the captured process. The old identity is conclusively
      // absent and must never authorize a signal to the unrelated replacement.
      // Keep same-birth PGID/marker drift fail-closed because those fields can
      // change without proving that the captured process exited.
      if (retireConfirmedReusedCapture(identityKey, identity, current)) continue;
      if (uncertainPids.has(identity.pid)) {
        ambiguous.push(identity.pid);
        continue;
      }
      if (key(current) !== key(identity)) {
        healthy = false;
        uncertainPids.add(identity.pid);
        ambiguous.push(identity.pid);
        continue;
      }
      const authorized = observation.owned.has(identity.pid)
        || identity.stopped
        || (platform === "win32" && identity.strongCapture);
      if (authorized) live.push(identity);
      else ambiguous.push(identity.pid);
    }
    return { live, ambiguous: [...new Set([...ambiguous, ...uncertainPids])] };
  };
  const send = (identity, signal) => {
    dependencies.beforeSignal?.(identity, signal);
    let authorization;
    try {
      const observation = observe();
      const current = observation.byPid.get(identity.pid);
      if (!current) return "absent";
      if (retireConfirmedReusedCapture(key(identity), identity, current)) return "absent";
      if (uncertainPids.has(identity.pid)) return "ambiguous";
      if (key(current) !== key(identity)) {
        healthy = false;
        uncertainPids.add(identity.pid);
        return "ambiguous";
      }
      authorization = observation.owned.has(identity.pid)
        || identity.stopped
        || (platform === "win32" && identity.strongCapture);
      if (!authorization) {
        uncertainPids.add(identity.pid);
        return "ambiguous";
      }
    } catch {
      return "ambiguous";
    }
    try {
      if (platform === "win32") {
        const preserveCleanupBarrier = roots.has(identity.pid) && cleanupBarrierMarkers.size > 0;
        taskkill(identity.pid, signal === "SIGKILL", !preserveCleanupBarrier);
      }
      else signalPid(identity.pid, signal);
      return "sent";
    } catch (error) {
      if (error?.code === "ESRCH") return "absent";
      try {
        const row = validatedSnapshot().find((candidate) => candidate.pid === identity.pid);
        if (!row) return "absent";
        if (key(row) !== key(identity)) {
          healthy = false;
          uncertainPids.add(identity.pid);
          return "ambiguous";
        }
      } catch (recheckError) {
        healthy = false;
        uncertainPids.add(identity.pid);
        errors.push(`signal recheck ${identity.pid}: ${recheckError.message}`);
        return "ambiguous";
      }
      if (platform === "win32" && signal === "SIGTERM") return "retry";
      errors.push(`${signal} ${identity.pid}: ${error.message}`);
      return "error";
    }
  };
  const reap = async () => {
    safeObserve();
    let state;
    try { state = currentOwned(); }
    catch { return { reaped: false, survivors: [], ambiguous: [], errors: allErrors() }; }
    const rootsLast = (left, right) => Number(roots.has(left.pid)) - Number(roots.has(right.pid));
    const signalable = (rows) => rows.filter((identity) => identity.cleanupBarrier !== true);
    if (platform === "win32") {
      for (const identity of signalable([...state.live]).sort(rootsLast)) send(identity, "SIGTERM");
    } else {
      for (const identity of signalable([...state.live]).sort(rootsLast)) {
        if (send(identity, "SIGSTOP") === "sent") identity.stopped = true;
      }
      safeObserve();
      try { state = currentOwned(); }
      catch { return { reaped: false, survivors: [], ambiguous: [], errors: allErrors() }; }
      for (const identity of signalable([...state.live]).sort(rootsLast)) send(identity, "SIGTERM");
      for (const identity of signalable([...state.live]).sort(rootsLast)) {
        if (send(identity, "SIGCONT") === "sent") identity.stopped = false;
      }
    }
    await pause(dependencies.termGraceMs ?? 300);
    safeObserve();
    try { state = currentOwned(); }
    catch { return { reaped: false, survivors: [], ambiguous: [], errors: allErrors() }; }
    if (platform !== "win32") {
      for (const identity of signalable([...state.live]).sort(rootsLast)) {
        if (send(identity, "SIGSTOP") === "sent") identity.stopped = true;
      }
      safeObserve();
      try { state = currentOwned(); }
      catch { return { reaped: false, survivors: [], ambiguous: [], errors: allErrors() }; }
    }
    for (const identity of signalable([...state.live]).sort(rootsLast)) send(identity, "SIGKILL");
    let finalState = state;
    for (let attempt = 0; attempt < (dependencies.confirmAttempts ?? 20); attempt += 1) {
      await pause(dependencies.confirmPauseMs ?? 50);
      safeObserve();
      try { finalState = currentOwned(); }
      catch { break; }
      if (finalState.live.length === 0 && finalState.ambiguous.length === 0) break;
      if (platform === "win32") {
        for (const identity of signalable(finalState.live)) send(identity, "SIGKILL");
      } else {
        for (const identity of signalable(finalState.live)) {
          if (!identity.stopped && send(identity, "SIGSTOP") === "sent") identity.stopped = true;
          send(identity, "SIGKILL");
        }
      }
    }
    return {
      reaped: healthy && errors.length === 0 && rootErrors.size === 0
        && treeClearanceErrors.size === 0
        && finalState.live.length === 0 && finalState.ambiguous.length === 0,
      survivors: finalState.live.map((row) => row.pid),
      ambiguous: finalState.ambiguous,
      errors: allErrors(),
    };
  };
  const requestAbort = (signal) => {
    abortSignal ??= signal;
    if (!abortPromise) {
      abortPromise = reap();
      void abortPromise.then(
        (cleanup) => resolveAbortOutcome({ signal: abortSignal, cleanup }),
        (error) => resolveAbortOutcome({
          signal: abortSignal,
          cleanup: { reaped: false, survivors: [], ambiguous: [], errors: [error.message] },
        }),
      );
    }
    return abortPromise;
  };
  return {
    addMarker,
    addCleanupBarrierMarker,
    confirmTreeClearance,
    trackOwner(owner) {
      assertHarnessOwnedBase(owner, "exact-HEAD abort-scope owner");
      owners.push(owner);
    },
    cleanupOwners(cleanup, label) {
      if (!cleanup?.reaped) return false;
      for (const owner of [...owners].reverse()) {
        if (existsSync(owner.path)) cleanupHarnessOwnedBase(owner, label);
      }
      owners.length = 0;
      return true;
    },
    get ownerPaths() { return owners.map((owner) => owner.realpath); },
    trackRoot,
    retireRoot,
    observe: safeObserve,
    reap,
    requestAbort,
    throwIfAborted() {
      if (abortSignal) throw new BootstrapFailure("exact-HEAD isolation interrupted by " + abortSignal);
    },
    get abortSignal() { return abortSignal; },
    waitForAbortOutcome() { return abortOutcome; },
    async finishAbort() { return abortPromise ? await abortPromise : null; },
    close() { if (interval) clearInterval(interval); },
  };
}

function installExactHeadAbortScope(supervisor, dependencies = {}) {
  const on = dependencies.on ?? ((signal, handler) => process.on(signal, handler));
  const off = dependencies.off ?? ((signal, handler) => process.off(signal, handler));
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => { void supervisor.requestAbort(signal); };
    handlers.set(signal, handler);
    on(signal, handler);
  }
  return {
    close() { for (const [signal, handler] of handlers) off(signal, handler); },
  };
}

async function settleExactHeadTerminal({
  child,
  terminalPromise,
  cleanupOutcomes,
  pause = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
  settleMs = 250,
}) {
  const first = await Promise.race([
    terminalPromise.then((terminal) => ({ kind: "terminal", terminal })),
    ...cleanupOutcomes.map((outcome) => outcome.then((value) => ({ kind: "cleanup", ...value }))),
  ]);
  if (first.kind === "terminal") return { terminal: first.terminal, cleanup: null, bounded: false };
  const bounded = await Promise.race([
    terminalPromise.then((terminal) => ({ terminal })),
    pause(settleMs).then(() => ({ terminal: null })),
  ]);
  if (bounded.terminal) {
    return { terminal: bounded.terminal, cleanup: first.cleanup, bounded: false };
  }
  child.stdout?.destroy?.();
  child.stderr?.destroy?.();
  child.unref?.();
  return { terminal: null, cleanup: first.cleanup, bounded: true };
}

async function proveExactHeadSupervisorSafety() {
  const wrapperSource = runExactHeadIsolatedSelector.toString();
  const abortScopeIndex = wrapperSource.indexOf("installExactHeadAbortScope(supervisor)");
  const setupIndex = wrapperSource.indexOf("await prepareExactHeadIsolation(");
  contract(
    abortScopeIndex >= 0 && setupIndex >= 0 && abortScopeIndex < setupIndex,
    "exact-HEAD wrapper does not install its abort scope before setup",
  );
  const setupHandlers = new Map();
  const setupSupervisor = startExactHeadProcessSupervisor({
    platform: "linux", snapshot: () => [], pause: async () => {}, startInterval: false,
  });
  const setupScope = installExactHeadAbortScope(setupSupervisor, {
    on: (signal, handler) => setupHandlers.set(signal, handler),
    off: (signal) => setupHandlers.delete(signal),
  });
  const setupOwner = createHarnessOwnedBase("b-e40f-setup-cancel-di-");
  setupSupervisor.trackOwner(setupOwner);
  contract(setupHandlers.has("SIGTERM"), "exact-HEAD abort handler was not installed before setup");
  setupHandlers.get("SIGTERM")();
  contract(setupSupervisor.abortSignal === "SIGTERM", "setup cancellation did not enter the abort scope");
  const setupCleanup = await setupSupervisor.finishAbort();
  contract(setupCleanup?.reaped === true, "empty pre-setup cancellation did not close cleanly");
  contract(
    setupSupervisor.cleanupOwners(setupCleanup, "setup-cancel DI cleanup")
      && !existsSync(setupOwner.path),
    "setup cancellation did not remove its owner after authenticated zero-process cleanup",
  );
  setupScope.close();
  setupSupervisor.close();

  const posixRows = [
    {
      pid: 210,
      ppid: 1,
      pgid: 210,
      birthIdentity: "root-birth",
      state: "S",
      marker: "owned-root-marker",
    },
    { pid: 211, ppid: 210, pgid: 211, birthIdentity: "child-birth", state: "S", marker: "owned-workload-marker" },
  ];
  const posixSignals = [];
  const posix = startExactHeadProcessSupervisor({
    platform: "linux", snapshot: () => posixRows.map((row) => ({ ...row })),
    signalPid: (pid, signal) => {
      posixSignals.push([pid, signal]);
      if (pid === 211 && signal === "SIGKILL") posixRows.splice(posixRows.findIndex((row) => row.pid === pid), 1);
      if (pid === 210 && signal === "SIGTERM") posixRows.splice(posixRows.findIndex((row) => row.pid === pid), 1);
    },
    pause: async () => {}, startInterval: false, confirmAttempts: 2,
  });
  posix.addMarker("owned-root-marker");
  posix.addMarker("owned-workload-marker");
  posix.trackRoot(210);
  posix.observe();
  const child = posixRows.find((row) => row.pid === 211);
  child.ppid = 1;
  const detached = await posix.reap();
  contract(
    detached.reaped === true
      && posixSignals.some(([pid, signal]) => pid === 211 && signal === "SIGTERM")
      && posixSignals.some(([pid, signal]) => pid === 211 && signal === "SIGSTOP")
      && posixSignals.some(([pid, signal]) => pid === 211 && signal === "SIGKILL"),
    "POSIX supervisor did not reap a reparented detached new-PGID descendant: " + json({ detached, posixSignals }),
  );
  posix.close();

  const windowsRows = [
    { pid: 310, ppid: 1, pgid: null, birthIdentity: "20260907010000.000000+000", state: "", marker: "inner" },
    { pid: 311, ppid: 310, pgid: null, birthIdentity: "20260907010001.000000+000", state: "", marker: "child" },
  ];
  const windowsCalls = [];
  const windows = startExactHeadProcessSupervisor({
    platform: "win32", snapshot: () => windowsRows.map((row) => ({ ...row })),
    taskkill: (pid, force) => {
      windowsCalls.push([pid, force]);
      if (force) {
        const index = windowsRows.findIndex((row) => row.pid === pid);
        if (index >= 0) windowsRows.splice(index, 1);
      }
    },
    pause: async () => {}, startInterval: false, confirmAttempts: 2,
  });
  windows.trackRoot(310);
  windows.observe();
  windowsRows.splice(windowsRows.findIndex((row) => row.pid === 310), 1);
  windowsRows[0].ppid = 1;
  const windowsCleanup = await windows.reap();
  contract(
    windowsCleanup.reaped === true
      && windowsCalls.some(([pid, force]) => pid === 311 && force === false)
      && windowsCalls.some(([pid, force]) => pid === 311 && force === true),
    "Windows supervisor did not taskkill an exact-CreationDate reparented descendant: "
      + json({ windowsCleanup, windowsCalls }),
  );
  windows.close();

  const ambiguousRows = [
    {
      pid: 410,
      ppid: 1,
      pgid: 410,
      birthIdentity: "root-birth",
      state: "S",
      marker: "ambiguous-root-marker",
    },
    { pid: 411, ppid: 410, pgid: 411, birthIdentity: "child-birth", state: "S", marker: "sanitized" },
  ];
  const ambiguousSignals = [];
  const ambiguousSupervisor = startExactHeadProcessSupervisor({
    platform: "linux", snapshot: () => ambiguousRows.map((row) => ({ ...row })),
    signalPid: (pid, signal) => {
      ambiguousSignals.push([pid, signal]);
      if (pid === 410) ambiguousRows.splice(ambiguousRows.findIndex((row) => row.pid === pid), 1);
    },
    pause: async () => {}, startInterval: false, confirmAttempts: 1,
  });
  const ambiguousOwner = createHarnessOwnedBase("b-e40f-ambiguous-retain-di-");
  ambiguousSupervisor.trackOwner(ambiguousOwner);
  ambiguousSupervisor.addMarker("ambiguous-root-marker");
  ambiguousSupervisor.trackRoot(410);
  ambiguousSupervisor.observe();
  ambiguousRows.splice(ambiguousRows.findIndex((row) => row.pid === 410), 1);
  ambiguousRows[0].ppid = 1;
  const ambiguous = await ambiguousSupervisor.reap();
  contract(
    ambiguous.reaped === false && ambiguous.ambiguous.includes(411)
      && !ambiguousSignals.some(([pid]) => pid === 411)
      && ambiguousSupervisor.cleanupOwners(ambiguous, "ambiguous DI cleanup") === false
      && existsSync(ambiguousOwner.path),
    "POSIX weak reparented identity was signalled instead of retaining its owner: "
      + json({ ambiguous, ambiguousSignals }),
  );
  cleanupHarnessOwnedBase(ambiguousOwner, "ambiguous DI retained-owner teardown");
  ambiguousSupervisor.close();

  const reusedRows = [
    {
      pid: 510,
      ppid: 1,
      pgid: 510,
      birthIdentity: "same-second-birth",
      state: "S",
      marker: "owned-reuse-marker",
    },
  ];
  const reusedSignals = [];
  let replacedBeforeSignal = false;
  const reuseSupervisor = startExactHeadProcessSupervisor({
    platform: "linux", snapshot: () => reusedRows.map((row) => ({ ...row })),
    beforeSignal: (_identity, signal) => {
      if (!replacedBeforeSignal && signal === "SIGSTOP") {
        replacedBeforeSignal = true;
        reusedRows[0].marker = "unrelated-reused-marker";
      }
    },
    signalPid: (pid, signal) => reusedSignals.push([pid, signal]),
    pause: async () => {}, startInterval: false, confirmAttempts: 1,
  });
  const reuseOwner = createHarnessOwnedBase("b-e40f-same-second-reuse-di-");
  reuseSupervisor.trackOwner(reuseOwner);
  reuseSupervisor.addMarker("owned-reuse-marker");
  reuseSupervisor.trackRoot(510);
  const reused = await reuseSupervisor.reap();
  contract(
    reused.reaped === false && reused.ambiguous.includes(510) && reusedSignals.length === 0
      && reuseSupervisor.cleanupOwners(reused, "same-second reuse DI cleanup") === false
      && existsSync(reuseOwner.path),
    "same-second PID/PGID marker reuse was not rejected before any signal: "
      + json({ reused, reusedSignals }),
  );
  cleanupHarnessOwnedBase(reuseOwner, "same-second reuse DI retained-owner teardown");
  reuseSupervisor.close();

  const differentBirthRows = [
    {
      pid: 530,
      ppid: 1,
      pgid: 530,
      birthIdentity: "different-birth-root",
      state: "S",
      marker: "different-birth-owned-marker",
    },
    {
      pid: 531,
      ppid: 530,
      pgid: 531,
      birthIdentity: "different-birth-child-old",
      state: "S",
      marker: "sanitized-child",
    },
  ];
  const differentBirthSignals = [];
  let differentBirthReplacedBeforeSignal = false;
  const differentBirthSupervisor = startExactHeadProcessSupervisor({
    platform: "linux", snapshot: () => differentBirthRows.map((row) => ({ ...row })),
    beforeSignal: (identity, signal) => {
      if (!differentBirthReplacedBeforeSignal && identity.pid === 531 && signal === "SIGSTOP") {
        differentBirthReplacedBeforeSignal = true;
        differentBirthRows[1] = {
          ...differentBirthRows[1],
          ppid: 1,
          birthIdentity: "different-birth-child-reused",
          marker: "unrelated-reused-process",
        };
      }
    },
    signalPid: (pid, signal) => {
      differentBirthSignals.push([pid, signal]);
      if (pid === 530 && signal === "SIGKILL") {
        differentBirthRows.splice(differentBirthRows.findIndex((row) => row.pid === pid), 1);
      }
    },
    pause: async () => {}, startInterval: false, confirmAttempts: 1,
  });
  const differentBirthOwner = createHarnessOwnedBase("b-e40f-different-birth-reuse-di-");
  differentBirthSupervisor.trackOwner(differentBirthOwner);
  differentBirthSupervisor.addMarker("different-birth-owned-marker");
  differentBirthSupervisor.trackRoot(530);
  differentBirthSupervisor.observe();
  const differentBirthCleanup = await differentBirthSupervisor.reap();
  const differentBirthOwnersRemoved = differentBirthSupervisor.cleanupOwners(
    differentBirthCleanup,
    "different-birth reuse DI cleanup",
  );
  const differentBirthOwnerStillExists = existsSync(differentBirthOwner.path);
  if (differentBirthOwnerStillExists) {
    cleanupHarnessOwnedBase(differentBirthOwner, "different-birth reuse DI failed-RED teardown");
  }
  differentBirthSupervisor.close();
  contract(
    differentBirthCleanup.reaped === true
      && differentBirthCleanup.ambiguous.length === 0
      && differentBirthReplacedBeforeSignal === true
      && differentBirthSignals.every(([pid]) => pid !== 531)
      && differentBirthSignals.some(([pid, signal]) => pid === 530 && signal === "SIGKILL")
      && differentBirthOwnersRemoved === true
      && differentBirthOwnerStillExists === false,
    "different-birth PID reuse during signal reauth was signalled or retained its owner: "
      + json({ differentBirthCleanup, differentBirthSignals }),
  );

  const descendantToRootRows = [
    {
      pid: 540,
      ppid: 1,
      pgid: 540,
      birthIdentity: "descendant-to-root-parent",
      state: "S",
      marker: "descendant-to-root-old-marker",
    },
    {
      pid: 541,
      ppid: 540,
      pgid: 541,
      birthIdentity: "descendant-to-root-old-child",
      state: "S",
      marker: "sanitized-child",
    },
  ];
  const descendantToRootSignals = [];
  const descendantToRootSignalBirths = [];
  const descendantToRootSupervisor = startExactHeadProcessSupervisor({
    platform: "linux", snapshot: () => descendantToRootRows.map((row) => ({ ...row })),
    beforeSignal: (identity, signal) => descendantToRootSignalBirths.push([identity.birthIdentity, signal]),
    signalPid: (pid, signal) => {
      descendantToRootSignals.push([pid, signal]);
      if (pid === 541 && signal === "SIGKILL") {
        descendantToRootRows.splice(descendantToRootRows.findIndex((row) => row.pid === pid), 1);
      }
    },
    pause: async () => {}, startInterval: false, confirmAttempts: 1,
  });
  const descendantToRootOwner = createHarnessOwnedBase("b-e40f-descendant-to-root-reuse-di-");
  descendantToRootSupervisor.trackOwner(descendantToRootOwner);
  descendantToRootSupervisor.addMarker("descendant-to-root-old-marker");
  descendantToRootSupervisor.trackRoot(540);
  descendantToRootSupervisor.observe();
  descendantToRootRows.splice(descendantToRootRows.findIndex((row) => row.pid === 540), 1);
  descendantToRootSupervisor.retireRoot(540, { error: null, status: 0, signal: null });
  descendantToRootRows[0] = {
    ...descendantToRootRows[0],
    ppid: 1,
    birthIdentity: "descendant-to-root-new-root",
    marker: "descendant-to-root-new-marker",
  };
  descendantToRootSupervisor.addMarker("descendant-to-root-new-marker");
  descendantToRootSupervisor.trackRoot(541);
  const descendantToRootCleanup = await descendantToRootSupervisor.reap();
  const descendantToRootOwnersRemoved = descendantToRootSupervisor.cleanupOwners(
    descendantToRootCleanup,
    "descendant-to-root reuse DI cleanup",
  );
  const descendantToRootOwnerStillExists = existsSync(descendantToRootOwner.path);
  if (descendantToRootOwnerStillExists) {
    cleanupHarnessOwnedBase(descendantToRootOwner, "descendant-to-root reuse DI failed-RED teardown");
  }
  descendantToRootSupervisor.close();
  contract(
    descendantToRootCleanup.reaped === true
      && descendantToRootCleanup.ambiguous.length === 0
      && descendantToRootSignalBirths.every(([birth]) => birth !== "descendant-to-root-old-child")
      && descendantToRootSignalBirths.some(([birth]) => birth === "descendant-to-root-new-root")
      && descendantToRootSignals.some(([pid, signal]) => pid === 541 && signal === "SIGKILL")
      && descendantToRootOwnersRemoved === true
      && descendantToRootOwnerStillExists === false,
    "reused descendant PID poisoned or escaped cleanup after becoming a new tracked root: "
      + json({ descendantToRootCleanup, descendantToRootSignals, descendantToRootSignalBirths }),
  );

  const zombieRows = [{
    pid: 560,
    ppid: 1,
    pgid: 560,
    birthIdentity: "zombie-root-birth",
    state: "S",
    marker: "owned-zombie-root-marker",
  }];
  const zombieSignals = [];
  const zombieSupervisor = startExactHeadProcessSupervisor({
    platform: "linux", snapshot: () => zombieRows.map((row) => ({ ...row })),
    signalPid: (pid, signal) => zombieSignals.push([pid, signal]),
    pause: async () => {}, startInterval: false, confirmAttempts: 1,
  });
  const zombieOwner = createHarnessOwnedBase("b-e40f-zombie-root-di-");
  zombieSupervisor.trackOwner(zombieOwner);
  zombieSupervisor.addMarker("owned-zombie-root-marker");
  zombieSupervisor.trackRoot(560);
  zombieRows[0].state = "Z";
  zombieRows[0].marker = "[node] <defunct>";
  const zombieCleanup = await zombieSupervisor.reap();
  const zombieOwnersRemoved = zombieSupervisor.cleanupOwners(
    zombieCleanup,
    "zombie root DI cleanup",
  );
  const zombieOwnerStillExists = existsSync(zombieOwner.path);
  if (zombieOwnerStillExists) {
    cleanupHarnessOwnedBase(zombieOwner, "zombie root DI failed-RED teardown");
  }
  zombieSupervisor.close();
  contract(
    zombieCleanup.reaped === true && zombieCleanup.ambiguous.length === 0
      && zombieCleanup.errors.length === 0 && zombieSignals.length === 0
      && zombieOwnersRemoved === true && zombieOwnerStillExists === false,
    "normally exited zombie root was treated as marker/PID reuse: "
      + json({ zombieCleanup, zombieSignals, zombieOwnersRemoved, zombieOwnerStillExists }),
  );

  const terminalRows = [{
    pid: 580,
    ppid: 1,
    pgid: 580,
    birthIdentity: "terminal-root-birth",
    state: "S",
    marker: "owned-terminal-root-marker",
  }];
  const terminalSignals = [];
  const terminalSupervisor = startExactHeadProcessSupervisor({
    platform: "linux", snapshot: () => terminalRows.map((row) => ({ ...row })),
    signalPid: (pid, signal) => terminalSignals.push([pid, signal]),
    pause: async () => {}, startInterval: false, confirmAttempts: 1,
  });
  const terminalOwner = createHarnessOwnedBase("b-e40f-terminal-root-di-");
  terminalSupervisor.trackOwner(terminalOwner);
  terminalSupervisor.addMarker("owned-terminal-root-marker");
  terminalSupervisor.trackRoot(580);
  expectExactHeadIsolationRejection(
    () => terminalSupervisor.retireRoot(580, {
      error: new Error("synthetic child error"), status: null, signal: null,
    }),
    /direct child exit event/,
    "non-terminal root retirement",
  );
  terminalRows[0].marker = "[node] terminal transition";
  terminalSupervisor.observe();
  terminalSupervisor.retireRoot(580, { error: null, status: 0, signal: null });
  terminalRows.length = 0;
  const terminalCleanup = await terminalSupervisor.reap();
  const terminalOwnersRemoved = terminalSupervisor.cleanupOwners(
    terminalCleanup,
    "terminal root DI cleanup",
  );
  const terminalOwnerStillExists = existsSync(terminalOwner.path);
  if (terminalOwnerStillExists) {
    cleanupHarnessOwnedBase(terminalOwner, "terminal root DI failed-RED teardown");
  }
  terminalSupervisor.close();
  contract(
    terminalCleanup.reaped === true && terminalCleanup.ambiguous.length === 0
      && terminalCleanup.errors.length === 0 && terminalSignals.length === 0
      && terminalOwnersRemoved === true && terminalOwnerStillExists === false,
    "direct terminal proof was followed by marker reauthentication: "
      + json({
        terminalCleanup,
        terminalSignals,
        terminalOwnersRemoved,
        terminalOwnerStillExists,
      }),
  );

  const lateRows = [{
    pid: 590,
    ppid: 1,
    pgid: 590,
    birthIdentity: "late-root-birth",
    state: "S",
    marker: "owned-late-root-marker",
  }];
  const lateSignals = [];
  const lateSupervisor = startExactHeadProcessSupervisor({
    platform: "linux", snapshot: () => lateRows.map((row) => ({ ...row })),
    signalPid: (pid, signal) => lateSignals.push([pid, signal]),
    pause: async () => {}, startInterval: false, confirmAttempts: 1,
  });
  const lateOwner = createHarnessOwnedBase("b-e40f-late-descendant-di-");
  lateSupervisor.trackOwner(lateOwner);
  lateSupervisor.addMarker("owned-late-root-marker");
  lateSupervisor.trackRoot(590, { requiresTreeClearance: true });
  lateRows.push({
    pid: 591,
    ppid: 1,
    pgid: 591,
    birthIdentity: "late-child-birth",
    state: "S",
    marker: "sanitized-late-child",
  });
  lateRows.shift();
  lateSupervisor.retireRoot(
    590,
    { error: null, status: 0, signal: null },
    { treeClearance: false },
  );
  const lateCleanup = await lateSupervisor.reap();
  const lateOwnersRemoved = lateSupervisor.cleanupOwners(
    lateCleanup,
    "late descendant DI cleanup",
  );
  const lateOwnerStillExists = existsSync(lateOwner.path);
  const lateChildStillLive = lateRows.some((row) => row.pid === 591);
  if (lateOwnerStillExists) {
    cleanupHarnessOwnedBase(lateOwner, "late descendant DI retained-owner teardown");
  }
  lateSupervisor.close();
  contract(
    lateCleanup.reaped === false && lateCleanup.ambiguous.length === 0
      && lateSignals.length === 0 && lateOwnersRemoved === false
      && lateOwnerStillExists === true && lateChildStillLive === true,
    "late uncaptured detached descendant authorized owner cleanup without tree clearance: "
      + json({
        lateCleanup,
        lateSignals,
        lateOwnersRemoved,
        lateOwnerStillExists,
        lateChildStillLive,
      }),
  );

  const earlyLeaseStream = new PassThrough();
  const earlyLease = monitorExactHeadTreeLease(earlyLeaseStream);
  earlyLeaseStream.end();
  const earlyLeaseOutcome = await earlyLease.wait(100);
  earlyLease.markRootTerminal();
  const authenticatedLeaseOutcome = await earlyLease.wait(100);
  earlyLease.close();
  contract(
    earlyLeaseOutcome.cleared === false
      && earlyLeaseOutcome.reason === "eof-before-root-terminal"
      && authenticatedLeaseOutcome.cleared === false
      && authenticatedLeaseOutcome.reason === "eof-before-root-terminal",
    "tree lease upgraded EOF that arrived before direct-root exit: "
      + json({ earlyLeaseOutcome, authenticatedLeaseOutcome }),
  );

  const recoveredRows = [{
    pid: 600,
    ppid: 1,
    pgid: 600,
    birthIdentity: "recovered-root-birth",
    state: "S",
    marker: "owned-recovered-root-marker",
  }];
  const recoveredSupervisor = startExactHeadProcessSupervisor({
    platform: "linux", snapshot: () => recoveredRows.map((row) => ({ ...row })),
    signalPid: () => {}, pause: async () => {}, startInterval: false, confirmAttempts: 1,
  });
  const recoveredOwner = createHarnessOwnedBase("b-e40f-recovered-clearance-di-");
  recoveredSupervisor.trackOwner(recoveredOwner);
  recoveredSupervisor.addMarker("owned-recovered-root-marker");
  recoveredSupervisor.trackRoot(600, { requiresTreeClearance: true });
  recoveredRows.length = 0;
  recoveredSupervisor.retireRoot(
    600,
    { error: null, status: 0, signal: null },
    { treeClearance: false },
  );
  const beforeClearance = await recoveredSupervisor.reap();
  recoveredSupervisor.confirmTreeClearance(600);
  const afterClearance = await recoveredSupervisor.reap();
  const recoveredOwnersRemoved = recoveredSupervisor.cleanupOwners(
    afterClearance,
    "recovered tree-clearance DI cleanup",
  );
  recoveredSupervisor.close();
  contract(
    beforeClearance.reaped === false && afterClearance.reaped === true
      && recoveredOwnersRemoved === true && !existsSync(recoveredOwner.path),
    "late authenticated tree clearance could not release a safely reaped owner: "
      + json({ beforeClearance, afterClearance, recoveredOwnersRemoved }),
  );

  const barrierRows = [
    {
      pid: 620,
      ppid: 1,
      pgid: 620,
      birthIdentity: "barrier-root-birth",
      state: "S",
      marker: "owned-barrier-root-marker",
    },
    {
      pid: 621,
      ppid: 620,
      pgid: 621,
      birthIdentity: "barrier-guardian-birth",
      state: "S",
      marker: "owned-barrier-guardian-marker",
    },
  ];
  const barrierSignals = [];
  const barrierSupervisor = startExactHeadProcessSupervisor({
    platform: "linux",
    snapshot: () => barrierRows.map((row) => ({ ...row })),
    signalPid: (pid, signal) => {
      barrierSignals.push([pid, signal]);
      if (pid === 620 && signal === "SIGTERM") {
        barrierRows.splice(barrierRows.findIndex((row) => row.pid === 620), 1);
      }
    },
    pause: async () => {
      const guardianIndex = barrierRows.findIndex((row) => row.pid === 621);
      if (guardianIndex >= 0) barrierRows.splice(guardianIndex, 1);
    },
    startInterval: false,
    confirmAttempts: 1,
  });
  barrierSupervisor.addMarker("owned-barrier-root-marker");
  barrierSupervisor.addCleanupBarrierMarker("owned-barrier-guardian-marker");
  barrierSupervisor.trackRoot(620);
  const barrierCleanup = await barrierSupervisor.reap();
  barrierSupervisor.close();
  contract(
    barrierCleanup.reaped === true
      && barrierSignals.some(([pid, signal]) => pid === 620 && signal === "SIGTERM")
      && barrierSignals.every(([pid]) => pid !== 621),
    "timeout cleanup signalled the terminal-order guardian before its root: "
      + json({ barrierCleanup, barrierSignals }),
  );

  const windowsBarrierRows = [
    {
      pid: 630,
      ppid: 1,
      pgid: null,
      birthIdentity: "20260907020000.000000+000",
      state: "",
      marker: "windows-barrier-root",
    },
    {
      pid: 631,
      ppid: 630,
      pgid: null,
      birthIdentity: "20260907020001.000000+000",
      state: "",
      marker: "windows-barrier-guardian-marker",
    },
  ];
  const windowsBarrierCalls = [];
  const windowsBarrierSupervisor = startExactHeadProcessSupervisor({
    platform: "win32",
    snapshot: () => windowsBarrierRows.map((row) => ({ ...row })),
    taskkill: (pid, force, tree) => {
      windowsBarrierCalls.push([pid, force, tree]);
      if (pid === 630) {
        windowsBarrierRows.splice(windowsBarrierRows.findIndex((row) => row.pid === 630), 1);
      }
    },
    pause: async () => {
      const guardianIndex = windowsBarrierRows.findIndex((row) => row.pid === 631);
      if (guardianIndex >= 0) windowsBarrierRows.splice(guardianIndex, 1);
    },
    startInterval: false,
    confirmAttempts: 1,
  });
  windowsBarrierSupervisor.addCleanupBarrierMarker("windows-barrier-guardian-marker");
  windowsBarrierSupervisor.trackRoot(630);
  const windowsBarrierCleanup = await windowsBarrierSupervisor.reap();
  windowsBarrierSupervisor.close();
  contract(
    windowsBarrierCleanup.reaped === true
      && windowsBarrierCalls.some(([pid, force, tree]) => (
        pid === 630 && force === false && tree === false
      ))
      && windowsBarrierCalls.every(([pid]) => pid !== 631),
    "Windows timeout cleanup tree-killed the terminal-order guardian: "
      + json({ windowsBarrierCleanup, windowsBarrierCalls }),
  );

  let failSnapshot = false;
  const failedCensusSupervisor = startExactHeadProcessSupervisor({
    platform: "linux",
    snapshot: () => {
      if (failSnapshot) throw new Error("injected census failure");
      return [{
        pid: 610,
        ppid: 1,
        pgid: 610,
        birthIdentity: "live-root",
        state: "S",
        marker: "failed-census-root-marker",
      }];
    },
    signalPid: () => { throw new ContractFailure("failed-census cleanup attempted an unauthenticated signal"); },
    pause: async () => {}, startInterval: false,
  });
  failedCensusSupervisor.addMarker("failed-census-root-marker");
  failedCensusSupervisor.trackRoot(610);
  failSnapshot = true;
  let unrefCount = 0;
  let destroyedStreams = 0;
  const neverTerminal = new Promise(() => {});
  const fakeChild = {
    stdout: { destroy: () => { destroyedStreams += 1; } },
    stderr: { destroy: () => { destroyedStreams += 1; } },
    unref: () => { unrefCount += 1; },
  };
  void failedCensusSupervisor.requestAbort("SIGTERM");
  const boundedFailure = await settleExactHeadTerminal({
    child: fakeChild,
    terminalPromise: neverTerminal,
    cleanupOutcomes: [failedCensusSupervisor.waitForAbortOutcome()],
    pause: async () => {},
  });
  contract(
    boundedFailure.bounded === true && boundedFailure.terminal === null
      && boundedFailure.cleanup?.reaped === false
      && unrefCount === 1 && destroyedStreams === 2,
    "failed cleanup census left terminal settlement unbounded: "
      + json({ boundedFailure, unrefCount, destroyedStreams }),
  );
  failedCensusSupervisor.close();
  await proveExactHeadTreeLeaseKernel();
  console.log(
    "EXACT_HEAD_SUPERVISOR_PASS setup_abort=1 posix_detached=1 windows=1 "
      + "ambiguity_retain=1 signal_reauth=1 zombie_exit=1 terminal_retire=1 "
      + "late_tree_clearance=1 early_eof_reject=1 clearance_recovery=1 "
      + "kernel_tree_lease=1 guardian=1 guardian_cancel=posix+windows recursive_env=1 preload_api=1 "
      + "fd4_collision=1 bounded_failed_cleanup=1",
  );
}

async function runSupervisedExactHeadGit(supervisor, cwd, args, env, label) {
  supervisor.throwIfAborted();
  const child = spawn("git", args, {
    cwd,
    env: { ...env, PWD: cwd },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    supervisor.trackRoot(child.pid);
  } catch (error) {
    try { child.kill("SIGKILL"); } catch { /* direct ChildProcess handle is the only remaining authority */ }
    throw error;
  }
  const terminalPromise = new Promise((resolveTerminal) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolveTerminal(value);
    };
    child.once("error", (error) => settle({ error, status: null, signal: null }));
    child.once("close", (status, signal) => settle({ error: null, status, signal }));
    child.once("exit", (status, signal) => {
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        settle({ error: null, status, signal });
      }, 100).unref();
    });
  });
  const settled = await settleExactHeadTerminal({
    child,
    terminalPromise,
    cleanupOutcomes: [supervisor.waitForAbortOutcome()],
  });
  const terminal = settled.terminal;
  if (terminal?.error === null) supervisor.retireRoot(child.pid, terminal);
  supervisor.throwIfAborted();
  if (!terminal) {
    throw new BootstrapFailure(
      label + " did not terminate after bounded cleanup; cleanup=" + json(settled.cleanup),
    );
  }
  if (terminal.error || terminal.status !== 0) {
    throw new BootstrapFailure(
      label + " failed: "
        + (terminal.error?.message ?? stderr.trim() ?? `exit ${terminal.status} signal ${terminal.signal}`),
    );
  }
  return stdout.trim();
}

async function prepareExactHeadIsolation(selected, supervisor, workloadMarker, supervisorSafetyProven) {
  const source = captureExactHeadSource();
  supervisor.throwIfAborted();
  expectExactHeadIsolationRejection(
    () => requireCleanExactHeadStatus(" M " + harnessRelativePath, "synthetic dirty source"),
    /clean tracked and untracked worktree/,
    "dirty-HEAD negative",
  );
  const owner = createExactHeadIsolationOwner(source);
  supervisor.trackOwner(owner);
  try {
    const treeLeasePreload = createHarnessOwnedFile(
      owner,
      "tree-lease-preload-" + randomUUID() + ".cjs",
      "exact-HEAD tree lease preload",
    );
    writeHarnessOwnedFile(
      treeLeasePreload,
      "exact-HEAD tree lease preload",
      exactHeadTreeLeasePreloadSource(workloadMarker),
    );
    const treeLeaseGuardian = createExactHeadTreeLeaseGuardianAuthority(
      owner,
      "exact-HEAD isolation",
    );
    const workloadOwner = createHarnessOwnedBase("b-e40f-exact-head-workload-");
    supervisor.trackOwner(workloadOwner);
    contract(
      owner.realpath !== workloadOwner.realpath
        && !strictDescendant(owner.realpath, workloadOwner.realpath)
        && !strictDescendant(workloadOwner.realpath, owner.realpath),
      "exact-HEAD clone and workload temp owners overlap",
    );
    const gitEnv = createExactHeadCloneGitEnvironment(owner);
    const cloneRoot = join(owner.realpath, "checkout");
    supervisor.addMarker(cloneRoot);
    supervisor.addMarker(workloadOwner.realpath);
    assertOwnedPath(owner, cloneRoot, "exact-HEAD clone destination", { mustExist: false, directory: true });
    await runSupervisedExactHeadGit(supervisor, owner.realpath, [
      "clone", "--no-local", "--no-checkout", "--quiet", "--", repoRoot, cloneRoot,
    ], gitEnv, "exact-HEAD no-local clone");
    supervisor.throwIfAborted();
    assertOwnedDirectory(owner, cloneRoot, "exact-HEAD clone after clone");
    await runSupervisedExactHeadGit(
      supervisor,
      cloneRoot,
      ["checkout", "--detach", "--quiet", source.head],
      gitEnv,
      "exact-HEAD detached checkout",
    );
    supervisor.throwIfAborted();
    const topology = assertIndependentExactHeadClone(owner, cloneRoot, source, gitEnv);
    try {
      writeFixtureFile(owner, cloneRoot, ".git/objects/info/alternates", source.objectDir + "\n");
      expectExactHeadIsolationRejection(
        () => assertIndependentExactHeadClone(owner, cloneRoot, source, gitEnv),
        /alternates/,
        "shared-alternates negative",
      );
    } finally {
      if (existsSync(topology.alternates)) unlinkSync(topology.alternates);
    }
    assertIndependentExactHeadClone(owner, cloneRoot, source, gitEnv);

    const cloneDist = join(cloneRoot, "packages/main/dist");
    contract(!existsSync(cloneDist), "exact-HEAD checkout unexpectedly contains a dist overlay");
    cpSync(join(repoRoot, "packages/main/dist"), cloneDist, { recursive: true, force: true });
    supervisor.throwIfAborted();
    contract(
      treeContentDigest(cloneDist, "copied correctness dist") === source.distDigest,
      "complete copied dist differs from the source build",
    );
    const bindingPath = join(cloneRoot, "scripts/full-suite-build-binding.mjs");
    const binding = await import(pathToFileURL(bindingPath).href + "?exact-head=" + randomUUID());
    contract(typeof binding.verifyBuildBinding === "function", "clone build-binding verifier is unavailable");
    binding.verifyBuildBinding(cloneRoot);
    supervisor.throwIfAborted();

    const dependency = snapshotCorrectnessDependencies(correctnessDependencyRoot());
    const dependencyLinkPath = join(cloneRoot, "node_modules");
    contract(!existsSync(dependencyLinkPath), "exact-HEAD clone unexpectedly contains node_modules");
    symlinkSync(dependency.path, dependencyLinkPath, process.platform === "win32" ? "junction" : "dir");
    const dependencyLinkEntry = lstatSync(dependencyLinkPath);
    contract(
      dependencyLinkEntry.isSymbolicLink() && realpathSync(dependencyLinkPath) === dependency.path,
      "correctness dependency link is not bound to the captured read-only target",
    );
    const dependencyLink = {
      path: dependencyLinkPath,
      dev: dependencyLinkEntry.dev,
      ino: dependencyLinkEntry.ino,
    };
    supervisor.throwIfAborted();

    const nonce = randomUUID();
    const manifest = createHarnessOwnedFile(owner, "inner-authority-" + randomUUID() + ".json", "inner authority");
    const ownerEntry = lstatSync(owner.realpath);
    const payload = {
      schema: EXACT_HEAD_ISOLATION_SCHEMA,
      nonce,
      selector: selected,
      innerRoot: realpathSync(cloneRoot),
      head: source.head,
      tree: source.tree,
      harnessBlob: source.harnessBlob,
      originalSmokeCommit: ORIGINAL_SMOKE_COMMIT,
      outerPid: process.pid,
      ownerDev: ownerEntry.dev,
      ownerIno: ownerEntry.ino,
      manifestDev: manifest.dev,
      manifestIno: manifest.ino,
      createdAtMs: Date.now(),
      supervisorSafetyProven,
    };
    validateExactHeadIsolationManifest(payload, {
      nonce,
      selector: selected,
      innerRoot: payload.innerRoot,
      head: source.head,
      tree: source.tree,
      harnessBlob: source.harnessBlob,
      outerPid: process.pid,
      supervisorSafetyProven,
    });
    expectExactHeadIsolationRejection(
      () => validateExactHeadIsolationManifest(payload, {
        nonce: randomUUID(),
        selector: selected,
        innerRoot: payload.innerRoot,
        head: source.head,
        tree: source.tree,
        harnessBlob: source.harnessBlob,
        outerPid: process.pid,
        supervisorSafetyProven,
      }),
      /nonce/,
      "forged internal marker negative",
    );
    expectExactHeadIsolationRejection(
      () => validateExactHeadIsolationManifest(
        { ...payload, supervisorSafetyProven: !supervisorSafetyProven },
        {
          nonce,
          selector: selected,
          innerRoot: payload.innerRoot,
          head: source.head,
          tree: source.tree,
          harnessBlob: source.harnessBlob,
          outerPid: process.pid,
          supervisorSafetyProven,
        },
      ),
      /supervisor-safety binding/,
      "forged supervisor-safety binding negative",
    );
    writeHarnessOwnedFile(manifest, "inner authority", json(payload) + "\n");
    assertExactHeadSourceUnchanged(source);
    assertCorrectnessDependenciesUnchanged(dependency, dependencyLink);
    supervisor.throwIfAborted();
    return {
      owner, workloadOwner, source, gitEnv, cloneRoot, topology,
      binding, dependency, dependencyLink, manifest, nonce, treeLeasePreload,
      treeLeaseGuardian,
    };
  } catch (error) {
    throw error;
  }
}

async function runExactHeadIsolatedSelector(selected, supervisorSafetyProven = false) {
  const supervisor = startExactHeadProcessSupervisor();
  const abortScope = installExactHeadAbortScope(supervisor);
  const workloadMarker = "b-e40f-exact-head-workload-" + randomUUID();
  supervisor.addMarker(workloadMarker);
  let prepared = null;
  let timeout = null;
  let timeoutCleanupPromise = null;
  let cleanup = null;
  let timedOut = false;
  let child = null;
  let treeLease = null;
  try {
    supervisor.throwIfAborted();
    prepared = await prepareExactHeadIsolation(
      selected,
      supervisor,
      workloadMarker,
      supervisorSafetyProven,
    );
    supervisor.throwIfAborted();
    const childEnv = harnessChildEnvironment({
      TMPDIR: prepared.workloadOwner.realpath,
      TMP: prepared.workloadOwner.realpath,
      TEMP: prepared.workloadOwner.realpath,
    });
    contract(!/\s/.test(prepared.treeLeasePreload.realpath),
      "exact-HEAD tree lease preload path contains unsupported whitespace");
    childEnv.NODE_OPTIONS = (
      `${childEnv.NODE_OPTIONS ?? ""} --title=${workloadMarker} `
        + `--require=${prepared.treeLeasePreload.realpath}`
    ).trim();
    childEnv[EXACT_HEAD_TREE_LEASE_ROOT_ENV] = "1";
    childEnv[EXACT_HEAD_TREE_LEASE_GUARDIAN_ENV] = prepared.treeLeaseGuardian.marker;
    childEnv[EXACT_HEAD_TREE_LEASE_RELEASE_PATH_ENV]
      = prepared.treeLeaseGuardian.releaseRecord.realpath;
    childEnv[EXACT_HEAD_TREE_LEASE_RELEASE_NONCE_ENV] = prepared.treeLeaseGuardian.nonce;
    childEnv[EXACT_HEAD_ISOLATION_MANIFEST_ENV] = prepared.manifest.path;
    childEnv[EXACT_HEAD_ISOLATION_NONCE_ENV] = prepared.nonce;
    supervisor.addCleanupBarrierMarker(prepared.treeLeaseGuardian.marker);
    child = spawn(process.execPath, [
      "--title=" + workloadMarker,
      join(prepared.cloneRoot, harnessRelativePath),
      "--case=" + selected,
    ], {
      cwd: prepared.cloneRoot,
      env: childEnv,
      detached: process.platform !== "win32",
      stdio: exactHeadTreeLeaseStdio(),
      windowsHide: true,
    });
    treeLease = monitorExactHeadTreeLease(child.stdio[EXACT_HEAD_TREE_LEASE_FD], child);
    supervisor.trackRoot(child.pid, { requiresTreeClearance: true });
    let resolveTimeoutOutcome;
    const timeoutOutcome = new Promise((resolveOutcome) => { resolveTimeoutOutcome = resolveOutcome; });
    timeout = setTimeout(() => {
      timedOut = true;
      timeoutCleanupPromise ??= supervisor.reap();
      void timeoutCleanupPromise.then(
        (result) => resolveTimeoutOutcome({ signal: null, cleanup: result }),
        (error) => resolveTimeoutOutcome({
          signal: null,
          cleanup: { reaped: false, survivors: [], ambiguous: [], errors: [error.message] },
        }),
      );
    }, selected === "resource-parallel-contract" ? 50 * 60_000 : 30 * 60_000);
    const terminalPromise = new Promise((resolveTerminal) => {
      child.once("error", (error) => resolveTerminal({ error, status: null, signal: null }));
      child.once("exit", (status, signal) => {
        treeLease.markRootTerminal();
        releaseExactHeadTreeLeaseGuardian(
          prepared.treeLeaseGuardian,
          "exact-HEAD isolation",
        );
        resolveTerminal({ error: null, status, signal });
      });
    });
    const settled = await settleExactHeadTerminal({
      child,
      terminalPromise,
      cleanupOutcomes: [supervisor.waitForAbortOutcome(), timeoutOutcome],
    });
    const terminal = settled.terminal;
    cleanup ??= settled.cleanup;
    clearTimeout(timeout);
    timeout = null;
    let treeLeaseOutcome = await treeLease.wait(2_000);
    if (terminal?.error === null) {
      const retirement = supervisor.retireRoot(child.pid, terminal, {
        treeClearance: treeLeaseOutcome.cleared
          && treeLeaseOutcome.afterRootTerminal === true,
      });
      if (retirement.treeCleared) {
        // Never authorize owner deletion from a stale abort/timeout result.
        cleanup = await supervisor.reap();
      } else {
        cleanup = await supervisor.reap();
        if (!treeLeaseOutcome.cleared && treeLeaseOutcome.reason === "timeout") {
          treeLeaseOutcome = await treeLease.wait(2_000);
          if (treeLeaseOutcome.cleared && treeLeaseOutcome.afterRootTerminal === true) {
            supervisor.confirmTreeClearance(child.pid);
            cleanup = await supervisor.reap();
          }
        }
      }
    } else if (!treeLeaseOutcome.cleared) {
      cleanup = {
        reaped: false,
        survivors: cleanup?.survivors ?? [],
        ambiguous: cleanup?.ambiguous ?? [],
        errors: [
          ...(cleanup?.errors ?? []),
          "exact-HEAD descendant tree lease did not reach EOF: " + treeLeaseOutcome.reason,
        ],
      };
    }
    if (!terminal) {
      if (!cleanup?.reaped) {
        throw new BootstrapFailure(
          "isolated harness did not terminate after bounded failed cleanup; retained "
            + supervisor.ownerPaths.join(",") + " detail=" + json(cleanup),
        );
      }
      if (supervisor.abortSignal) {
        return { isolated: true, status: null, signal: supervisor.abortSignal };
      }
      if (timedOut) return { isolated: true, status: 124, signal: null };
      throw new BootstrapFailure("isolated harness terminal event was not observed after cleanup");
    }
    if (terminal.error) throw new BootstrapFailure("could not start isolated harness: " + terminal.error.message);
    const abortCleanup = await supervisor.finishAbort();
    cleanup ??= abortCleanup
      ?? (timeoutCleanupPromise ? await timeoutCleanupPromise : await supervisor.reap());
    if (!cleanup.reaped) {
      throw new BootstrapFailure(
        "isolated harness process tree cleanup was not authenticated; retained "
          + supervisor.ownerPaths.join(",") + " detail=" + json(cleanup),
      );
    }
    if (supervisor.abortSignal) {
      return { isolated: true, status: null, signal: supervisor.abortSignal };
    }
    contract(!existsSync(prepared.manifest.path), "inner harness did not consume its one-shot authority manifest");
    assertIndependentExactHeadClone(prepared.owner, prepared.cloneRoot, prepared.source, prepared.gitEnv);
    prepared.binding.verifyBuildBinding(prepared.cloneRoot);
    assertCorrectnessDependenciesUnchanged(prepared.dependency, prepared.dependencyLink);
    assertExactHeadSourceUnchanged(prepared.source);
    contract(
      readdirSync(prepared.workloadOwner.path).length === 0,
      "isolated correctness selector left workload temp residue",
    );
    return {
      isolated: true,
      status: timedOut ? 124 : terminal.status,
      signal: timedOut ? null : terminal.signal,
    };
  } catch (error) {
    if (!cleanup) {
      const abortCleanup = await supervisor.finishAbort();
      cleanup = abortCleanup
        ?? (timeoutCleanupPromise ? await timeoutCleanupPromise : await supervisor.reap());
    }
    if (!cleanup.reaped) {
      throw new BootstrapFailure(
        "exact-HEAD isolation failed with unauthenticated cleanup; retained "
          + supervisor.ownerPaths.join(",") + " detail=" + json(cleanup)
          + " cause=" + error.message,
      );
    }
    if (supervisor.abortSignal) {
      return { isolated: true, status: null, signal: supervisor.abortSignal };
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    abortScope.close();
    supervisor.close();
    if (cleanup?.reaped) {
      supervisor.cleanupOwners(cleanup, "exact-HEAD correctness abort-scope cleanup");
      contract(
        supervisor.ownerPaths.length === 0,
        "exact-HEAD cleanup scope retained owners after authenticated process cleanup",
      );
    }
    treeLease?.close();
  }
}

const selected = (() => {
  try {
    return parseHarnessCase(process.argv.slice(2));
  } catch (error) {
    const prefix = error instanceof BootstrapFailure ? "HARNESS_USAGE" : "HARNESS_ERROR";
    console.error(prefix + ": " + error.message);
    process.exit(2);
  }
})();

try {
  const isolationAuthorization = consumeExactHeadIsolationAuthorization(selected);
  exactHeadOuterSupervisorSafetyProven = isolationAuthorization?.supervisorSafetyProven === true;
  if (isolationAuthorization && !EXACT_HEAD_ISOLATION_SELECTORS.has(selected)) {
    throw new BootstrapFailure("exact-HEAD inner authority targeted a non-isolated selector");
  }
  if (!isolationAuthorization && EXACT_HEAD_ISOLATION_SELECTORS.has(selected)) {
    const supervisorSafetyProven = selected === "resource-parallel-contract";
    if (supervisorSafetyProven) await proveExactHeadSupervisorSafety();
    const terminal = await runExactHeadIsolatedSelector(selected, supervisorSafetyProven);
    if (terminal.signal && process.platform !== "win32") {
      process.kill(process.pid, terminal.signal);
      process.exit(2);
    }
    process.exit(terminal.status ?? (terminal.signal === "SIGINT" ? 130 : 143));
  }
  await SUPPORTED_CASES.get(selected)();
  console.log("GREEN " + selected);
} catch (error) {
  if (error instanceof ContractFailure) {
    console.error("RED " + selected + ": " + error.message);
    process.exit(1);
  }
  if (error instanceof BootstrapFailure) {
    console.error("BOOTSTRAP_ERROR " + selected + ": " + error.message);
    process.exit(2);
  }
  console.error("HARNESS_ERROR " + selected + ": " + (error?.stack ?? error));
  process.exit(2);
}
