





import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { contract, json } from "./owned-files.mjs";

export const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const repoRoot = resolve(here, "..", "..", "..", "..");

export const sourceTasks = join(repoRoot, "packages/main/src/tasks");

export const distTasks = join(repoRoot, "packages/main/dist/tasks");

export const smokeSourcePath = join(sourceTasks, "quorum-submit-smoke.ts");

export const smokeDistPath = join(distTasks, "quorum-submit-smoke.js");

export const manifestPath = join(sourceTasks, "quorum-submit-smoke-cases.json");

export const catalogSourcePath = join(sourceTasks, "quorum-submit-smoke-case-catalog.ts");

export const catalogDistPath = join(distTasks, "quorum-submit-smoke-case-catalog.js");

export const fixtureSourcePath = join(sourceTasks, "quorum-submit-smoke-fixture.ts");

export const fixtureDistPath = join(distTasks, "quorum-submit-smoke-fixture.js");

export const workerSourcePath = join(sourceTasks, "quorum-submit-smoke-worker.ts");

export const workerDistPath = join(distTasks, "quorum-submit-smoke-worker.js");

export const validationChildEnvironmentPath = join(sourceTasks, "validation-child-environment.mjs");

export const validationCaseAdapterPath = join(sourceTasks, "story-aware-validation-case-adapter.mjs");

export const validationDomainRunnerPath = join(sourceTasks, "story-aware-validation-domain-case-runner.mjs");

export const storyAwareValidationHandlerPath = join(repoRoot, "packages/main/src/handlers/story-aware-validation.ts");

export const validationRuntimeTracerPath = join(repoRoot, "packages/main/src/core/validation-runtime-tracer.cjs");

export const integrationCasesSourcePath = join(sourceTasks, "quorum-submit-smoke-integration-cases.ts");

export const FIXTURE_HANDLER_PROBE_SOURCE = [
  "const { readFileSync } = require('node:fs');",
  "const story = JSON.parse(readFileSync(3, 'utf8'));",
  "if (story.phase !== 'REVIEW') process.exit(9);",
  "console.log('HANDLER_PASS B-template');",
  "",
].join("\n");

export const caseSourcePaths = [
  smokeSourcePath,
  join(sourceTasks, "quorum-submit-smoke-pure-cases.ts"),
  integrationCasesSourcePath,
  join(sourceTasks, "quorum-submit-smoke-prune-cases.ts"),
];

export const configPath = join(repoRoot, "proof-or-stop.config.json");

export const dynRegistryPath = join(sourceTasks, "story-aware-validation-domain-cases.json");

export const ORIGINAL_SMOKE_COMMIT = "3eec15009ba93740b5dd74c0563bf1b3ca098b32";

export const BOUNDED_SHELL_SOURCE_DIGEST = "583509e6565ee7c736cc959152c91f66c9cb89bb0a5714c32548ff1c3e8e1d97";

export const harnessRelativePath = relative(repoRoot, join(here, "red-B-e40f-quorum-submit-harness.mjs")).split(sep).join("/");

export const EXACT_HEAD_ISOLATION_SELECTORS = new Set([
  "selector-contract",
  "partition-contract",
  "fixture-template-contract",
  "coordinator-fault-contract",
  "resource-parallel-contract",
]);

export const EXACT_HEAD_ISOLATION_SCHEMA = "proof-or-stop.b-e40f.exact-head-isolation.v1";

export const SELECTOR_CASE_TIMEOUT_MS = 180_000;

export const SELECTOR_WORKER_ENVELOPE_MS = 1_000;

export const SELECTOR_CLEANUP_ALLOWANCE_MS = 30_000;

export const SELECTOR_OUTER_TIMEOUT_MS = 240_000;

export const EXACT_HEAD_TREE_LEASE_FD = 4;

export const EXACT_HEAD_TREE_LEASE_ROOT_ENV = "PROOF_OR_STOP_B_E40F_TREE_LEASE_ROOT";

export const EXACT_HEAD_TREE_LEASE_GUARDIAN_ENV = "PROOF_OR_STOP_B_E40F_TREE_LEASE_GUARDIAN";

export const EXACT_HEAD_TREE_LEASE_RELEASE_PATH_ENV = "PROOF_OR_STOP_B_E40F_TREE_LEASE_RELEASE_PATH";

export const EXACT_HEAD_TREE_LEASE_RELEASE_NONCE_ENV = "PROOF_OR_STOP_B_E40F_TREE_LEASE_RELEASE_NONCE";

export const EXACT_HEAD_TREE_LEASE_MARKER_ENV = "PROOF_OR_STOP_B_E40F_TREE_LEASE_MARKER";

export const EXACT_HEAD_TREE_LEASE_TRACE_TRANSPORT_ENV_KEYS = new Set([
  EXACT_HEAD_TREE_LEASE_ROOT_ENV,
  EXACT_HEAD_TREE_LEASE_GUARDIAN_ENV,
  EXACT_HEAD_TREE_LEASE_RELEASE_PATH_ENV,
  EXACT_HEAD_TREE_LEASE_RELEASE_NONCE_ENV,
  EXACT_HEAD_TREE_LEASE_MARKER_ENV,
]);

export const EXACT_HEAD_ISOLATION_MANIFEST_ENV = "PROOF_OR_STOP_B_E40F_EXACT_HEAD_MANIFEST";

export const EXACT_HEAD_ISOLATION_NONCE_ENV = "PROOF_OR_STOP_B_E40F_EXACT_HEAD_NONCE";

export const EXACT_HEAD_ISOLATION_ENV_KEYS = new Set([
  EXACT_HEAD_ISOLATION_MANIFEST_ENV,
  EXACT_HEAD_ISOLATION_NONCE_ENV,
  EXACT_HEAD_TREE_LEASE_ROOT_ENV,
  EXACT_HEAD_TREE_LEASE_GUARDIAN_ENV,
  EXACT_HEAD_TREE_LEASE_RELEASE_PATH_ENV,
  EXACT_HEAD_TREE_LEASE_RELEASE_NONCE_ENV,
  EXACT_HEAD_TREE_LEASE_MARKER_ENV,
]);

export const SETUP_REFACTORED_CASE_IDS = new Set([
  "qsm-023", "qsm-024", "qsm-025", "qsm-026", "qsm-027", "qsm-029", "qsm-030",
]);

export function exactHeadTreeLeasePreloadSource(requiredTreeMarker) {
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

export const EXPECTED_CASES = [
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
