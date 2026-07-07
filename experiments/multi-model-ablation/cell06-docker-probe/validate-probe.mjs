#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const probeRoot = path.join(repoRoot, "experiments/multi-model-ablation/cell06-docker-probe");
const defaultManifestPath = path.join(probeRoot, "probe-manifest.json");
const defaultRowsPath = path.join(probeRoot, "probe-rows.jsonl");
const defaultSummaryPath = path.join(probeRoot, "probe-summary.json");
const negativeControlsRoot = path.join(probeRoot, "negative-controls");

const STORY_ID = "B-8092";
const CELL_NUMBER = "⑥";
const CELL_LABEL = "Cell06";
const ARM = "A2prime";
const EXECUTOR_FAMILY = "E2";
const REVIEWER_FAMILY = "not_applicable";

let assertions = 0;

function parseArgs(argv) {
  const options = {
    json: false,
    manifestPath: defaultManifestPath,
    rowsPath: defaultRowsPath,
    summaryPath: defaultSummaryPath,
  };
  for (const arg of argv) {
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`unknown argument: ${arg}`);
    }
    const [flag, rawValue] = arg.slice(2).split("=", 2);
    if (rawValue == null) {
      throw new Error(`flag requires =value: --${flag}`);
    }
    switch (flag) {
      case "manifest":
        options.manifestPath = path.resolve(rawValue);
        break;
      case "rows-path":
        options.rowsPath = path.resolve(rawValue);
        break;
      case "summary":
        options.summaryPath = path.resolve(rawValue);
        break;
      default:
        throw new Error(`unknown flag: --${flag}`);
    }
  }
  return options;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
  assertions++;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readRows(filePath) {
  assert(fs.existsSync(filePath), `rows file missing: ${filePath}`);
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function rel(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function listFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files.sort();
}

function digestFile(filePath) {
  const bytes = fs.readFileSync(filePath);
  return {
    path: rel(filePath),
    bytes: bytes.length,
    digest: sha256(bytes),
  };
}

function digestTree(root) {
  const items = listFiles(root).map(digestFile);
  const lines = ["cell06-docker-probe-input-manifest-v1"];
  for (const item of items) {
    lines.push(`${item.path}\t${item.bytes}\t${item.digest}`);
  }
  return {
    items,
    digest: sha256(lines.join("\n")),
  };
}

function getAtPath(root, dottedPath) {
  return dottedPath.split(".").reduce((value, segment) => {
    if (value == null) return undefined;
    return value[Number.isInteger(Number(segment)) ? Number(segment) : segment];
  }, root);
}

function setAtPath(root, dottedPath, value) {
  const parts = dottedPath.split(".");
  let cursor = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = Number.isInteger(Number(parts[index])) ? Number(parts[index]) : parts[index];
    if (cursor[key] == null) {
      const nextKey = parts[index + 1];
      cursor[key] = Number.isInteger(Number(nextKey)) ? [] : {};
    }
    cursor = cursor[key];
  }
  const finalKey = Number.isInteger(Number(parts.at(-1))) ? Number(parts.at(-1)) : parts.at(-1);
  cursor[finalKey] = value;
}

function deleteAtPath(root, dottedPath) {
  const parts = dottedPath.split(".");
  let cursor = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = Number.isInteger(Number(parts[index])) ? Number(parts[index]) : parts[index];
    cursor = cursor[key];
  }
  const finalPart = parts.at(-1);
  const finalKey = Number.isInteger(Number(finalPart)) ? Number(finalPart) : finalPart;
  if (Array.isArray(cursor) && Number.isInteger(finalKey)) {
    cursor.splice(finalKey, 1);
  } else {
    delete cursor[finalKey];
  }
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function walkStrings(value, visitor) {
  if (typeof value === "string") {
    visitor(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => walkStrings(item, visitor));
    return;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => walkStrings(item, visitor));
  }
}

function rejectContamination(value) {
  const stringValues = [];
  walkStrings(value, (stringValue) => stringValues.push(stringValue));

  for (const stringValue of stringValues) {
    const lower = stringValue.toLowerCase();
    if (lower.includes("cell03") || lower.includes("reviewer") || lower.includes("proofbound-memory")) {
      throw new Error(`contamination token detected: ${stringValue}`);
    }
    if (stringValue.startsWith("/Users/jek") || lower.includes("/.lattice") || lower.includes("lattice-paper")) {
      throw new Error(`host path contamination detected: ${stringValue}`);
    }
  }
}

function validateManifest(manifest, rows, summary) {
  assert(manifest.artifact === "cell06-docker-probe-manifest-v1", "manifest artifact mismatch");
  assert(manifest.storyId === STORY_ID, "manifest storyId mismatch");
  assert(manifest.cellNumber === CELL_NUMBER, "manifest cellNumber mismatch");
  assert(manifest.cellLabel === CELL_LABEL, "manifest cellLabel mismatch");
  assert(manifest.arm === ARM, "manifest arm must be A2prime");
  assert(manifest.executorFamily === EXECUTOR_FAMILY, "manifest executorFamily mismatch");
  assert(manifest.reviewerFamily === REVIEWER_FAMILY, "manifest reviewerFamily mismatch");
  assert(manifest.rowCount === rows.length, "manifest rowCount mismatch");
  assert(typeof manifest.inputManifestDigest === "string" && manifest.inputManifestDigest.startsWith("sha256:"), "inputManifestDigest missing");
  assert(manifest.authPolicy?.tokensWrittenToRepo === false, "auth policy must forbid repo token writes");
  assert(manifest.sterilePolicy?.mountHome === false, "sterile policy must not mount home");
  assert(manifest.sterilePolicy?.mountRepo === false, "sterile policy must not mount repo");
  assert(Array.isArray(manifest.accounts) && manifest.accounts.length === 2, "manifest must include two accounts");
  assert(Array.isArray(manifest.shards) && manifest.shards.length === 2, "manifest must include two shards");
  assert(typeof manifest.inputRoot === "string", "manifest inputRoot missing");
  assert(manifest.inputRoot === "experiments/multi-model-ablation/cell06-docker-probe/inputs", "manifest inputRoot mismatch");
  const inputRoot = path.join(repoRoot, manifest.inputRoot);
  assert(fs.existsSync(inputRoot), "manifest inputRoot does not exist");
  const actualInputDigest = digestTree(inputRoot);
  assert(manifest.inputManifestDigest === actualInputDigest.digest, "inputManifestDigest drift");
  assert(JSON.stringify(manifest.inputFiles) === JSON.stringify(actualInputDigest.items), "inputFiles digest inventory drift");

  const accountIds = new Set();
  for (const account of manifest.accounts) {
    assert(!accountIds.has(account.accountId), `duplicate account ${account.accountId}`);
    accountIds.add(account.accountId);
    assert(["account-a", "account-b"].includes(account.accountId), "unexpected accountId");
    assert(account.status === (account.authBundlePresent ? "live-if-auth-present" : "pending_auth"), "account status does not match auth presence");
  }

  const rowIds = new Set(rows.map((row) => row.rowId));
  const ownedRows = new Set();
  for (const shard of manifest.shards) {
    assert(accountIds.has(shard.accountId), `shard account missing: ${shard.accountId}`);
    for (const rowId of shard.rowIds) {
      assert(rowIds.has(rowId), `shard references unknown rowId: ${rowId}`);
      assert(!ownedRows.has(rowId), "row ownership must be unique");
      ownedRows.add(rowId);
    }
  }
  assert(ownedRows.size === rows.length, "all rows must be assigned to exactly one shard");
  assert(typeof summary.inputManifestDigest === "string" && summary.inputManifestDigest.startsWith("sha256:"), "inputManifestDigest missing");
  assert(summary.inputManifestDigest === manifest.inputManifestDigest, "summary inputManifestDigest mismatch");
}

function validateRow(row, manifest) {
  const account = manifest.accounts.find((candidate) => candidate.accountId === row.accountId);
  assert(account, `row account missing from manifest: ${row.accountId}`);
  assert(row.storyId === STORY_ID, "row storyId mismatch");
  assert(row.cellNumber === CELL_NUMBER, "row cellNumber must be ⑥");
  assert(row.cellLabel === CELL_LABEL, "row cellLabel mismatch");
  assert(row.arm === ARM, "arm must be A2prime");
  assert(row.executorFamily === EXECUTOR_FAMILY, "row executorFamily mismatch");
  assert(row.reviewerFamily === REVIEWER_FAMILY, "row reviewerFamily mismatch");
  assert(row.cellKey === `${CELL_NUMBER}|${ARM}|${row.taskId}|${row.scenarioId}|${row.repeatIndex}|${EXECUTOR_FAMILY}|${REVIEWER_FAMILY}`, "cellKey mismatch");
  assert(typeof row.inputManifestDigest === "string" && row.inputManifestDigest === manifest.inputManifestDigest, "row inputManifestDigest mismatch");
  assert(Array.isArray(row.inputFiles) && row.inputFiles.length === 2, "row inputFiles mismatch");
  assert(row.inputFiles.every((file) => file.startsWith("experiments/multi-model-ablation/cell06-docker-probe/inputs/")), "row input files must stay in sterile inputs");
  assert(typeof row.inputDigest === "string" && row.inputDigest.startsWith("sha256:"), "row inputDigest missing");
  assert(["completed", "pending_auth", "blocked", "blocked_network", "blocked_install_failed"].includes(row.rowStatus), "invalid rowStatus");
  assert(typeof row.usable === "boolean", "row usable missing");
  assert(row.usable === (row.rowStatus === "completed"), "usable must track completed status");
  assert(row.contaminationScan?.status === "clean", "contamination scan must be clean");
  assert(row.runtime?.hostHomeMounted === false, "host home must not be mounted");
  assert(row.runtime?.repoMounted === false, "repo must not be mounted");
  assert(row.runtime?.latticeMounted === false, "lattice must not be mounted");
  assert(row.runtime?.paperMounted === false, "paper must not be mounted");
  assert(row.runtime?.foreignResultsMounted === false, "foreign results must not be mounted");
  assert(Array.isArray(row.runtime?.mounts) && row.runtime.mounts.length === 1, "row mounts mismatch");
  assert(row.runtime.mounts[0].source.startsWith("experiments/multi-model-ablation/cell06-docker-probe/inputs/rows/"), "mount source must stay in sterile inputs");
  assert(row.runtime.mounts[0].mode === "ro", "input mount must be read-only");
  assert(row.runtime.authMountSource === `env:${row.accountId === "account-a" ? "CELL06_ACCOUNT_A_AUTH_BUNDLE" : "CELL06_ACCOUNT_B_AUTH_BUNDLE"}`, "auth mount source mismatch");
  assert(!Object.prototype.hasOwnProperty.call(row, "reviewerSnapshotId"), "reviewer fields are not allowed");
  assert(!Object.prototype.hasOwnProperty.call(row, "reviewGate"), "reviewer fields are not allowed");
  assert(!Object.prototype.hasOwnProperty.call(row, "reviewerNotes"), "reviewer fields are not allowed");
  assert(row.dockerSmoke?.status, "docker smoke status missing");
  assert(row.codexExec?.status === row.rowStatus, "codexExec status mismatch");
  assert(row.accountStatus === account.status, "row accountStatus must match manifest account status");
  if (!account.authBundlePresent) {
    assert(row.rowStatus === "pending_auth", "auth absent account cannot produce a completed row");
    assert(row.codexExec.attempted === false, "pending_auth row must not attempt codex exec");
  }
  if (row.rowStatus === "completed") {
    assert(account.authBundlePresent === true, "completed row requires an auth bundle");
    assert(row.codexExec.attempted === true, "completed row must attempt codex exec");
    assert(row.codexExec.exitCode === 0, "completed row must have zero codex exit");
    assert(typeof row.codexExec.responseDigest === "string" && row.codexExec.responseDigest.startsWith("sha256:"), "completed row response digest missing");
  }
}

function validateSummary(summary, rows, manifest) {
  assert(summary.artifact === "cell06-docker-probe-summary-v1", "summary artifact mismatch");
  assert(summary.storyId === STORY_ID, "summary storyId mismatch");
  assert(summary.rowCount === rows.length, "summary rowCount mismatch");
  assert(typeof summary.inputManifestDigest === "string" && summary.inputManifestDigest.startsWith("sha256:"), "inputManifestDigest missing");
  assert(summary.inputManifestDigest === manifest.inputManifestDigest, "summary inputManifestDigest mismatch");
  assert(summary.dockerAvailable === true, "Docker must be available for this probe");
  assert(summary.dockerBuildStatus === "built", "Docker image must be built for this probe");
  assert(summary.dockerSmokeStatus === "ok", "Docker smoke must pass for this probe");
  assert(typeof summary.codexVersion === "string" && summary.codexVersion.startsWith("codex-cli "), "container Codex CLI version missing");
  const countedRows = Object.values(summary.statusCounts ?? {}).reduce((sum, count) => sum + count, 0);
  assert(countedRows === rows.length, "summary statusCounts mismatch");
  assert(summary.pendingAuthRows === rows.filter((row) => row.rowStatus === "pending_auth").length, "summary pendingAuthRows mismatch");
  assert(summary.usableRows === rows.filter((row) => row.usable).length, "summary usableRows mismatch");
  assert(["blocked", "pending_auth", "partial", "completed"].includes(summary.overallStatus), "summary overallStatus mismatch");
}

function validateBundle(bundle) {
  rejectContamination(bundle);
  assert(Array.isArray(bundle.rows) && bundle.rows.length === 2, "probe must contain exactly two rows");
  validateManifest(bundle.manifest, bundle.rows, bundle.summary);
  const seenRowIds = new Set();
  const seenCellKeys = new Set();
  for (const row of bundle.rows) {
    assert(!seenRowIds.has(row.rowId), `duplicate rowId ${row.rowId}`);
    assert(!seenCellKeys.has(row.cellKey), `duplicate cellKey ${row.cellKey}`);
    seenRowIds.add(row.rowId);
    seenCellKeys.add(row.cellKey);
    validateRow(row, bundle.manifest);
  }
  validateSummary(bundle.summary, bundle.rows, bundle.manifest);
}

function loadNegativeControls() {
  return fs.readdirSync(negativeControlsRoot)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => readJson(path.join(negativeControlsRoot, fileName)));
}

function applyMutations(bundle, fixture) {
  const mutated = deepClone(bundle);
  for (const mutation of fixture.mutations) {
    const target = mutated[mutation.target];
    if (mutation.op === "set") {
      setAtPath(target, mutation.path, mutation.value);
      continue;
    }
    if (mutation.op === "delete") {
      deleteAtPath(target, mutation.path);
      continue;
    }
    if (mutation.op === "copy") {
      const sourceRoot = mutated[mutation.fromTarget];
      const value = deepClone(getAtPath(sourceRoot, mutation.fromPath));
      setAtPath(target, mutation.path, value);
      continue;
    }
    throw new Error(`unsupported mutation op: ${mutation.op}`);
  }
  return mutated;
}

function runNegativeControls(bundle) {
  let rejected = 0;
  for (const fixture of loadNegativeControls()) {
    const mutated = applyMutations(bundle, fixture);
    const before = assertions;
    try {
      validateBundle(mutated);
    } catch (error) {
      assertions = before;
      assert(String(error.message).includes(fixture.expectedError), `negative control ${fixture.id} failed with wrong error: ${error.message}`);
      rejected += 1;
      continue;
    }
    assertions = before;
    throw new Error(`negative control unexpectedly passed: ${fixture.id}`);
  }
  return rejected;
}

const options = parseArgs(process.argv.slice(2));
const bundle = {
  manifest: readJson(options.manifestPath),
  rows: readRows(options.rowsPath),
  summary: readJson(options.summaryPath),
};

validateBundle(bundle);
const negativeControlsRejected = runNegativeControls(bundle);

const result = {
  ok: true,
  assertions,
  negativeControlsRejected,
  files: {
    manifest: rel(options.manifestPath),
    rows: rel(options.rowsPath),
    summary: rel(options.summaryPath),
  },
  overallStatus: bundle.summary.overallStatus,
};

if (options.json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  console.log(`Cell06 docker probe validator passed: ${assertions} assertions`);
  console.log(`negativeControlsRejected=${negativeControlsRejected}`);
  console.log(`overallStatus=${bundle.summary.overallStatus}`);
}
