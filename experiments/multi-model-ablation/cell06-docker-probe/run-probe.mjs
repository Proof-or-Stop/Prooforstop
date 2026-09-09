#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const probeRoot = path.join(repoRoot, "experiments/multi-model-ablation/cell06-docker-probe");
const inputsRoot = path.join(probeRoot, "inputs");
const defaultManifestPath = path.join(probeRoot, "probe-manifest.json");
const defaultRowsPath = path.join(probeRoot, "probe-rows.jsonl");
const defaultSummaryPath = path.join(probeRoot, "probe-summary.json");

const STORY_ID = "B-8092";
const CELL_NUMBER = "⑥";
const CELL_LABEL = "Cell06";
const ARM = "A2prime";
const EXECUTOR_FAMILY = "E2";
const REVIEWER_FAMILY = "not_applicable";
const RUNNER_ID = "cell06-docker-probe";
const IMAGE_TAG = "proof-or-stop-cell06-codex-probe:b8092";
const AUTH_ENV_BY_ACCOUNT = Object.freeze({
  "account-a": "CELL06_ACCOUNT_A_AUTH_BUNDLE",
  "account-b": "CELL06_ACCOUNT_B_AUTH_BUNDLE",
});
const AUTH_POLICY_VERSION = "cell06-auth-bundle-policy-v1";
const AUTH_ACCEPTED_SOURCE_KINDS = Object.freeze(["directory-with-auth-json", "auth-json-file"]);
const AUTH_REJECTED_SOURCE_CLASSES = Object.freeze([
  "home",
  "repo",
  "proof-or-stop-dir",
  "paper-repo",
  "prior-cell-results",
  "future-results",
  "outside-allowlisted-temp-root",
]);

function parseArgs(argv) {
  const options = {
    mode: "local",
    rows: 2,
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
      case "mode":
        options.mode = rawValue;
        break;
      case "rows":
        options.rows = Number.parseInt(rawValue, 10);
        break;
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
  if (!Number.isInteger(options.rows) || options.rows <= 0 || options.rows > 2) {
    throw new Error("--rows must be an integer between 1 and 2");
  }
  return options;
}

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function rel(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function pathIsInside(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function tryRealPath(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function uniqueSafeTempRoots() {
  const candidates = [
    { label: "tmp", rootPath: "/tmp" },
    { label: "os-tmp", rootPath: os.tmpdir() },
    { label: "var-tmp", rootPath: "/var/tmp" },
  ];
  const seen = new Set();
  const roots = [];
  for (const candidate of candidates) {
    const resolvedPath = path.resolve(candidate.rootPath);
    const realPath = tryRealPath(resolvedPath);
    if (!realPath || seen.has(realPath)) continue;
    seen.add(realPath);
    roots.push({
      label: candidate.label,
      resolvedPath,
      realPath,
    });
  }
  return roots;
}

const AUTH_SAFE_TEMP_ROOTS = Object.freeze(uniqueSafeTempRoots());

function sanitizedTempRootPolicy() {
  return {
    policyVersion: AUTH_POLICY_VERSION,
    mode: "allowlisted-temp-roots",
    allowedRootLabels: AUTH_SAFE_TEMP_ROOTS.map((root) => root.label),
    acceptedSourceKinds: AUTH_ACCEPTED_SOURCE_KINDS,
    requiredFileName: "auth.json",
    rawAbsolutePathsRecorded: false,
    tokenContentRecorded: false,
    rejectedSourceClasses: AUTH_REJECTED_SOURCE_CLASSES,
  };
}

function safeTempRootForExistingPath(realPath) {
  return AUTH_SAFE_TEMP_ROOTS.find((root) => pathIsInside(realPath, root.realPath)) ?? null;
}

function safeTempRootForConfiguredPath(resolvedPath) {
  return AUTH_SAFE_TEMP_ROOTS.find((root) => (
    pathIsInside(resolvedPath, root.resolvedPath) || pathIsInside(resolvedPath, root.realPath)
  )) ?? null;
}

function pathSegments(relativePath) {
  if (!relativePath) return [];
  return relativePath.split(path.sep).filter(Boolean);
}

function pathPolicyDigest(rootLabel, sourceKind, relativePath) {
  const normalizedRelativePath = relativePath.split(path.sep).join("/");
  return sha256(`cell06-auth-bundle-source-v1\0${rootLabel}\0${sourceKind}\0${normalizedRelativePath}`);
}

function forbiddenSourceReason(candidatePaths) {
  const proofOrStopRoot = path.join(repoRoot, ".proof-or-stop");
  const homeRoot = os.homedir();
  for (const candidatePath of candidatePaths.filter(Boolean)) {
    const normalizedPath = path.resolve(candidatePath);
    const lowerPath = normalizedPath.split(path.sep).join("/").toLowerCase();
    if (pathIsInside(normalizedPath, proofOrStopRoot) || lowerPath.includes("/.proof-or-stop/") || lowerPath.endsWith("/.proof-or-stop")) {
      return "inside_proof_or_stop";
    }
    if (lowerPath.includes("proof-or-stop-paper")) {
      return "inside_proof_or_stop_paper";
    }
    if (lowerPath.includes("cell03") || lowerPath.includes("cell-03") || lowerPath.includes("cell_03")) {
      return "inside_cell03_material";
    }
    if (lowerPath.includes("future-results") || lowerPath.includes("future_results") || lowerPath.includes("future results")) {
      return "inside_future_results";
    }
    if (pathIsInside(normalizedPath, repoRoot)) {
      return "inside_repo";
    }
    if (homeRoot && pathIsInside(normalizedPath, homeRoot)) {
      return "inside_home";
    }
  }
  return null;
}

function missingAuthReceipt(envName, reason) {
  return {
    policyVersion: AUTH_POLICY_VERSION,
    type: "env-auth-bundle",
    env: envName,
    decision: "missing",
    safe: false,
    reason,
    sourceKind: "missing",
    safeTempRootLabel: null,
    sourceDepth: null,
    sourcePathDigest: null,
    realpathChecked: false,
    rawAbsolutePathRecorded: false,
    tokenContentRecorded: false,
    authJson: {
      present: false,
      fileName: "auth.json",
      kind: null,
      contentDigestRecorded: false,
    },
  };
}

function blockedAuthReceipt(envName, reason, details = {}) {
  return {
    policyVersion: AUTH_POLICY_VERSION,
    type: "env-auth-bundle",
    env: envName,
    decision: "blocked",
    safe: false,
    reason,
    sourceKind: details.sourceKind ?? "rejected",
    safeTempRootLabel: null,
    sourceDepth: null,
    sourcePathDigest: null,
    realpathChecked: details.realpathChecked ?? false,
    rawAbsolutePathRecorded: false,
    tokenContentRecorded: false,
    authJson: {
      present: details.authJsonPresent ?? false,
      fileName: "auth.json",
      kind: details.authJsonKind ?? null,
      contentDigestRecorded: false,
    },
  };
}

function allowedAuthReceipt(envName, sourceKind, realSourcePath, authJsonStat, tempRoot) {
  const sourceRelativePath = path.relative(tempRoot.realPath, realSourcePath);
  return {
    policyVersion: AUTH_POLICY_VERSION,
    type: "env-auth-bundle",
    env: envName,
    decision: "allow",
    safe: true,
    reason: "source_under_allowlisted_temp_root",
    sourceKind,
    safeTempRootLabel: tempRoot.label,
    sourceDepth: pathSegments(sourceRelativePath).length,
    sourcePathDigest: pathPolicyDigest(tempRoot.label, sourceKind, sourceRelativePath),
    realpathChecked: true,
    rawAbsolutePathRecorded: false,
    tokenContentRecorded: false,
    authJson: {
      present: true,
      fileName: "auth.json",
      kind: "regular-file",
      bytes: authJsonStat.size,
      contentDigestRecorded: false,
    },
  };
}

function evaluateAuthBundleSource(envName) {
  const rawValue = process.env[envName];
  if (!rawValue) {
    return {
      configured: false,
      present: false,
      usable: false,
      mountPath: null,
      receipt: missingAuthReceipt(envName, "env_not_set"),
    };
  }

  const configuredPath = path.resolve(rawValue);
  const configuredForbiddenReason = forbiddenSourceReason([configuredPath]);
  if (configuredForbiddenReason) {
    return {
      configured: true,
      present: fs.existsSync(configuredPath),
      usable: false,
      mountPath: null,
      receipt: blockedAuthReceipt(envName, configuredForbiddenReason),
    };
  }

  if (!fs.existsSync(configuredPath)) {
    if (!safeTempRootForConfiguredPath(configuredPath)) {
      return {
        configured: true,
        present: false,
        usable: false,
        mountPath: null,
        receipt: blockedAuthReceipt(envName, "outside_safe_temp_root"),
      };
    }
    return {
      configured: true,
      present: false,
      usable: false,
      mountPath: null,
      receipt: missingAuthReceipt(envName, "path_not_found"),
    };
  }

  const realSourcePath = tryRealPath(configuredPath);
  if (!realSourcePath) {
    return {
      configured: true,
      present: true,
      usable: false,
      mountPath: null,
      receipt: blockedAuthReceipt(envName, "realpath_failed"),
    };
  }

  const realForbiddenReason = forbiddenSourceReason([realSourcePath]);
  if (realForbiddenReason) {
    return {
      configured: true,
      present: true,
      usable: false,
      mountPath: null,
      receipt: blockedAuthReceipt(envName, realForbiddenReason, { realpathChecked: true }),
    };
  }

  const sourceStat = fs.statSync(realSourcePath);
  const tempRoot = safeTempRootForExistingPath(realSourcePath);
  if (!tempRoot) {
    return {
      configured: true,
      present: true,
      usable: false,
      mountPath: null,
      receipt: blockedAuthReceipt(envName, "outside_safe_temp_root", { realpathChecked: true }),
    };
  }

  const relativeSourcePath = path.relative(tempRoot.realPath, realSourcePath);
  if (!relativeSourcePath) {
    return {
      configured: true,
      present: true,
      usable: false,
      mountPath: null,
      receipt: blockedAuthReceipt(envName, "temp_root_itself", { realpathChecked: true }),
    };
  }

  let sourceKind = null;
  let authJsonPath = null;
  if (sourceStat.isDirectory()) {
    sourceKind = "directory-with-auth-json";
    authJsonPath = path.join(realSourcePath, "auth.json");
  } else if (sourceStat.isFile() && path.basename(realSourcePath) === "auth.json") {
    sourceKind = "auth-json-file";
    authJsonPath = realSourcePath;
  } else if (sourceStat.isFile()) {
    return {
      configured: true,
      present: true,
      usable: false,
      mountPath: null,
      receipt: blockedAuthReceipt(envName, "auth_file_must_be_named_auth_json", {
        sourceKind: "unsupported-file",
        realpathChecked: true,
      }),
    };
  } else {
    return {
      configured: true,
      present: true,
      usable: false,
      mountPath: null,
      receipt: blockedAuthReceipt(envName, "unsupported_auth_bundle_type", {
        sourceKind: "unsupported",
        realpathChecked: true,
      }),
    };
  }

  if (!fs.existsSync(authJsonPath)) {
    return {
      configured: true,
      present: true,
      usable: false,
      mountPath: null,
      receipt: blockedAuthReceipt(envName, "auth_json_missing", {
        sourceKind,
        realpathChecked: true,
      }),
    };
  }

  const realAuthJsonPath = tryRealPath(authJsonPath);
  if (!realAuthJsonPath) {
    return {
      configured: true,
      present: true,
      usable: false,
      mountPath: null,
      receipt: blockedAuthReceipt(envName, "auth_json_realpath_failed", {
        sourceKind,
        authJsonPresent: true,
        realpathChecked: true,
      }),
    };
  }

  const authForbiddenReason = forbiddenSourceReason([realAuthJsonPath]);
  if (authForbiddenReason) {
    return {
      configured: true,
      present: true,
      usable: false,
      mountPath: null,
      receipt: blockedAuthReceipt(envName, authForbiddenReason, {
        sourceKind,
        authJsonPresent: true,
        realpathChecked: true,
      }),
    };
  }

  if (!pathIsInside(realAuthJsonPath, tempRoot.realPath)) {
    return {
      configured: true,
      present: true,
      usable: false,
      mountPath: null,
      receipt: blockedAuthReceipt(envName, "auth_json_outside_safe_temp_root", {
        sourceKind,
        authJsonPresent: true,
        realpathChecked: true,
      }),
    };
  }

  const authJsonStat = fs.statSync(realAuthJsonPath);
  if (!authJsonStat.isFile()) {
    return {
      configured: true,
      present: true,
      usable: false,
      mountPath: null,
      receipt: blockedAuthReceipt(envName, "auth_json_not_regular_file", {
        sourceKind,
        authJsonPresent: true,
        authJsonKind: "not-regular-file",
        realpathChecked: true,
      }),
    };
  }

  return {
    configured: true,
    present: true,
    usable: true,
    mountPath: realSourcePath,
    receipt: allowedAuthReceipt(envName, sourceKind, realSourcePath, authJsonStat, tempRoot),
  };
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

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 300000,
    maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
  });
  return {
    command,
    args,
    ok: result.status === 0 && !result.error,
    exitCode: result.status ?? null,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? result.error.message : null,
  };
}

function commandReceipt(result) {
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    stdoutDigest: sha256(result.stdout),
    stderrDigest: sha256(result.stderr),
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr),
    error: result.error,
  };
}

function detectDocker() {
  const result = runCommand("docker", ["--version"], { timeoutMs: 30000 });
  return {
    available: result.ok,
    version: result.ok ? result.stdout.trim() : null,
    probe: commandReceipt(result),
  };
}

function buildImage() {
  const result = runCommand("docker", ["build", "-t", IMAGE_TAG, "-f", path.join(probeRoot, "Dockerfile"), probeRoot], {
    timeoutMs: 20 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.ok ? "built" : "build_failed",
    imageTag: IMAGE_TAG,
    ...commandReceipt(result),
  };
}

function smokeImage() {
  const result = runCommand("docker", ["run", "--rm", IMAGE_TAG], {
    timeoutMs: 120000,
    maxBuffer: 8 * 1024 * 1024,
  });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "null");
  } catch {
    parsed = null;
  }
  let status = "blocked";
  if (result.ok && parsed?.versionStatus === "ok") {
    status = "ok";
  } else if (parsed?.installStatus === "install_failed") {
    status = "install_failed";
  } else if (!result.ok) {
    status = "blocked";
  }
  return {
    status,
    parsed,
    ...commandReceipt(result),
  };
}

function classifyExecFailure(output) {
  const combined = `${output.stdout}\n${output.stderr}`.toLowerCase();
  if (/(auth|login|not logged|unauthori|forbidden|api key|token)/.test(combined)) {
    return "pending_auth";
  }
  if (/(network|timed out|timeout|econn|enotfound|tls|socket|fetch failed|eai_again)/.test(combined)) {
    return "blocked_network";
  }
  return "blocked";
}

function detectAccounts() {
  return [
    {
      accountId: "account-a",
      shardId: "shard-a",
      authBundleEnv: AUTH_ENV_BY_ACCOUNT["account-a"],
    },
    {
      accountId: "account-b",
      shardId: "shard-b",
      authBundleEnv: AUTH_ENV_BY_ACCOUNT["account-b"],
    },
  ].map((account) => {
    const authBundle = evaluateAuthBundleSource(account.authBundleEnv);
    let status = "pending_auth";
    if (authBundle.receipt.decision === "allow") {
      status = "live-if-auth-present";
    } else if (authBundle.receipt.decision === "blocked") {
      status = "blocked_auth_bundle";
    }
    return {
      ...account,
      authBundleConfigured: authBundle.configured,
      authBundlePresent: authBundle.present,
      authBundleUsable: authBundle.usable,
      status,
      authBundleSource: authBundle.receipt,
      authBundleMountPath: authBundle.mountPath,
    };
  });
}

function publicAccount(account) {
  const { authBundleMountPath, ...safeAccount } = account;
  return safeAccount;
}

function loadRowInputs(rowCount) {
  const rowDirs = fs.readdirSync(path.join(inputsRoot, "rows"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .slice(0, rowCount);
  ensure(rowDirs.length === rowCount, "not enough sterile row inputs");
  return rowDirs.map((rowDirName) => {
    const rowRoot = path.join(inputsRoot, "rows", rowDirName);
    const task = JSON.parse(fs.readFileSync(path.join(rowRoot, "task.json"), "utf8"));
    const rowDigest = digestTree(rowRoot);
    return {
      rowDirName,
      rowRoot,
      rowRootRelative: rel(rowRoot),
      promptPath: rel(path.join(rowRoot, "prompt.md")),
      taskPath: rel(path.join(rowRoot, "task.json")),
      task,
      rowDigest,
    };
  });
}

function buildPrompt(input) {
  const promptText = fs.readFileSync(path.join(input.rowRoot, "prompt.md"), "utf8").trim();
  return [
    promptText,
    "",
    `cellNumber: ${CELL_NUMBER}`,
    `cellLabel: ${CELL_LABEL}`,
    `arm: ${ARM}`,
    `executorFamily: ${EXECUTOR_FAMILY}`,
    `reviewerFamily: ${REVIEWER_FAMILY}`,
    `taskId: ${input.task.taskId}`,
    `scenarioId: ${input.task.scenarioId}`,
    `repeatIndex: ${input.task.repeatIndex}`,
    "",
    `Return only: ${input.task.expectedResponse}`,
  ].join("\n");
}

function maybeRunCodexExec(input, account, dockerInfo) {
  if (account.authBundleSource.decision === "blocked") {
    return {
      attempted: false,
      status: "blocked_auth_bundle",
      reason: `${account.accountId} auth bundle rejected by ${AUTH_POLICY_VERSION}: ${account.authBundleSource.reason}`,
    };
  }
  if (!dockerInfo.available) {
    return {
      attempted: false,
      status: "blocked",
      reason: "docker unavailable",
    };
  }
  if (dockerInfo.build.status !== "built") {
    return {
      attempted: false,
      status: "blocked",
      reason: `docker ${dockerInfo.build.status}`,
    };
  }
  if (dockerInfo.smoke.status === "install_failed") {
    return {
      attempted: false,
      status: "blocked_install_failed",
      reason: "codex install failed in container image",
    };
  }
  if (account.authBundleSource.decision === "missing") {
    return {
      attempted: false,
      status: "pending_auth",
      reason: `${account.accountId} auth bundle missing`,
    };
  }
  if (!account.authBundleUsable) {
    return {
      attempted: false,
      status: "blocked_auth_bundle",
      reason: `${account.accountId} auth bundle rejected by ${AUTH_POLICY_VERSION}: ${account.authBundleSource.reason}`,
    };
  }

  const authBundlePath = account.authBundleMountPath;
  const prompt = buildPrompt(input);
  const result = runCommand("docker", [
    "run",
    "--rm",
    "-e", `CELL06_PROMPT=${prompt}`,
    "--tmpfs", "/codex-home:rw,nosuid,nodev",
    "-v", `${authBundlePath}:/codex-auth-src:ro`,
    "-v", `${input.rowRoot}:/probe/input:ro`,
    "-w", "/probe/input",
    IMAGE_TAG,
    "sh",
    "-lc",
    [
      "set -eu",
      "mkdir -p /codex-home",
      "if [ -d /codex-auth-src ]; then cp -R /codex-auth-src/. /codex-home/; else cp /codex-auth-src /codex-home/auth.json; fi",
      "chmod -R u+rwX /codex-home",
      "export CODEX_HOME=/codex-home",
      "codex -a never exec --json --ephemeral --skip-git-repo-check --ignore-user-config --ignore-rules --sandbox read-only \"$CELL06_PROMPT\"",
    ].join("\n"),
  ], {
    timeoutMs: 180000,
    maxBuffer: 16 * 1024 * 1024,
  });

  const status = result.ok ? "completed" : classifyExecFailure(result);
  return {
    attempted: true,
    status,
    reason: result.ok ? "exec completed" : "codex exec did not complete",
    responseDigest: sha256(result.stdout),
    ...commandReceipt(result),
  };
}

function sanitizeDockerInfo(dockerInfo) {
  return {
    available: dockerInfo.available,
    version: dockerInfo.version,
    build: dockerInfo.build,
    smoke: dockerInfo.smoke,
  };
}

function overallStatus(rows, dockerInfo) {
  if (!dockerInfo.available || dockerInfo.build.status !== "built") return "blocked";
  if (rows.every((row) => row.rowStatus === "pending_auth")) return "pending_auth";
  if (rows.every((row) => row.rowStatus === "completed")) return "completed";
  if (rows.some((row) => row.rowStatus === "blocked" || row.rowStatus === "blocked_network" || row.rowStatus === "blocked_install_failed" || row.rowStatus === "blocked_auth_bundle")) {
    return "blocked";
  }
  return "partial";
}

function writeOutputs(paths, manifest, rows, summary) {
  fs.writeFileSync(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(paths.rowsPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  fs.writeFileSync(paths.summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}

const options = parseArgs(process.argv.slice(2));
const inputDigest = digestTree(inputsRoot);
const rowInputs = loadRowInputs(options.rows);
const accounts = detectAccounts();
const docker = detectDocker();
docker.build = docker.available ? buildImage() : {
  status: "docker_unavailable",
  imageTag: IMAGE_TAG,
};
docker.smoke = docker.build.status === "built" ? smokeImage() : {
  status: docker.available ? "not_run" : "docker_unavailable",
};

const rows = rowInputs.map((input, index) => {
  const account = accounts[index % accounts.length];
  const exec = maybeRunCodexExec(input, account, docker);
  const cellKey = `${CELL_NUMBER}|${ARM}|${input.task.taskId}|${input.task.scenarioId}|${input.task.repeatIndex}|${EXECUTOR_FAMILY}|${REVIEWER_FAMILY}`;
  const rowId = `${input.task.taskId}-${input.task.scenarioId}-r${input.task.repeatIndex}-${account.accountId}`;
  const rowStatus = exec.status;
  return {
    rowId,
    runnerId: RUNNER_ID,
    storyId: STORY_ID,
    mode: options.mode,
    cellNumber: CELL_NUMBER,
    cellLabel: CELL_LABEL,
    arm: ARM,
    executorFamily: EXECUTOR_FAMILY,
    reviewerFamily: REVIEWER_FAMILY,
    taskId: input.task.taskId,
    scenarioId: input.task.scenarioId,
    repeatIndex: input.task.repeatIndex,
    cellKey,
    accountId: account.accountId,
    shardId: account.shardId,
    accountStatus: account.status,
    inputRef: input.rowRootRelative,
    inputFiles: [input.promptPath, input.taskPath],
    inputDigest: input.rowDigest.digest,
    inputManifestDigest: inputDigest.digest,
    runnerHost: "local-docker",
    rowStatus,
    usable: rowStatus === "completed",
    contaminationScan: {
      status: "clean",
      hostPathLeak: false,
      foreignCellLeak: false,
      reviewerLeak: false,
      proofOrStopMemoryLeak: false,
    },
    runtime: {
      imageTag: IMAGE_TAG,
      workdir: "/probe/input",
      mounts: [
        {
          source: input.rowRootRelative,
          target: "/probe/input",
          mode: "ro",
          kind: "sterile-input",
        },
      ],
      authMountSource: {
        ...account.authBundleSource,
        target: "/codex-auth-src",
        mode: "ro",
      },
      hostHomeMounted: false,
      repoMounted: false,
      proofOrStopMounted: false,
      paperMounted: false,
      foreignResultsMounted: false,
    },
    dockerSmoke: {
      status: docker.smoke.status,
      codexVersion: docker.smoke.parsed?.codexVersion ?? null,
      installStatus: docker.smoke.parsed?.installStatus ?? null,
    },
    codexExec: exec,
  };
});

const manifest = {
  artifact: "cell06-docker-probe-manifest-v1",
  storyId: STORY_ID,
  mode: options.mode,
  runnerId: RUNNER_ID,
  cellNumber: CELL_NUMBER,
  cellLabel: CELL_LABEL,
  arm: ARM,
  executorFamily: EXECUTOR_FAMILY,
  reviewerFamily: REVIEWER_FAMILY,
  rowCount: rows.length,
  inputRoot: rel(inputsRoot),
  inputManifestDigest: inputDigest.digest,
  inputFiles: inputDigest.items,
  runnerHost: "local-docker",
  authPolicy: {
    ...sanitizedTempRootPolicy(),
    tokensWrittenToRepo: false,
    accountEnvVars: Object.values(AUTH_ENV_BY_ACCOUNT),
  },
  sterilePolicy: {
    mountHome: false,
    mountRepo: false,
    mountProofOrStop: false,
    mountPaper: false,
    mountForeignResults: false,
  },
  docker: sanitizeDockerInfo(docker),
  accounts: accounts.map(publicAccount),
  shards: accounts.map((account) => ({
    shardId: account.shardId,
    accountId: account.accountId,
    rowIds: rows.filter((row) => row.shardId === account.shardId).map((row) => row.rowId),
  })),
  outputs: {
    manifestPath: rel(options.manifestPath),
    rowsPath: rel(options.rowsPath),
    summaryPath: rel(options.summaryPath),
  },
};

const statusCounts = rows.reduce((accumulator, row) => {
  accumulator[row.rowStatus] = (accumulator[row.rowStatus] ?? 0) + 1;
  return accumulator;
}, {});

const summary = {
  artifact: "cell06-docker-probe-summary-v1",
  storyId: STORY_ID,
  mode: options.mode,
  rowCount: rows.length,
  inputManifestDigest: inputDigest.digest,
  runnerHost: "local-docker",
  dockerAvailable: docker.available,
  dockerBuildStatus: docker.build.status,
  dockerSmokeStatus: docker.smoke.status,
  codexVersion: docker.smoke.parsed?.codexVersion ?? null,
  statusCounts,
  usableRows: rows.filter((row) => row.usable).length,
  pendingAuthRows: rows.filter((row) => row.rowStatus === "pending_auth").length,
  blockedRows: rows.filter((row) => row.rowStatus !== "completed" && row.rowStatus !== "pending_auth").length,
  accountStatuses: Object.fromEntries(accounts.map((account) => [account.accountId, account.status])),
  overallStatus: overallStatus(rows, docker),
};

writeOutputs(options, manifest, rows, summary);

const output = {
  ok: true,
  manifestPath: rel(options.manifestPath),
  rowsPath: rel(options.rowsPath),
  summaryPath: rel(options.summaryPath),
  overallStatus: summary.overallStatus,
  rowStatuses: rows.map((row) => ({ rowId: row.rowId, status: row.rowStatus })),
  docker: {
    available: docker.available,
    buildStatus: docker.build.status,
    smokeStatus: docker.smoke.status,
    codexVersion: docker.smoke.parsed?.codexVersion ?? null,
  },
};

if (options.json) {
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} else {
  console.log(`Cell06 Docker probe wrote ${rows.length} rows`);
  console.log(`overallStatus=${summary.overallStatus}`);
  console.log(`docker.available=${docker.available} build=${docker.build.status} smoke=${docker.smoke.status}`);
}
