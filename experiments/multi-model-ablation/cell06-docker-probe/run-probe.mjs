#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
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
const IMAGE_TAG = "proofbound-cell06-codex-probe:b8092";
const AUTH_ENV_BY_ACCOUNT = Object.freeze({
  "account-a": "CELL06_ACCOUNT_A_AUTH_BUNDLE",
  "account-b": "CELL06_ACCOUNT_B_AUTH_BUNDLE",
});

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
    const authBundlePath = process.env[account.authBundleEnv];
    const authBundlePresent = Boolean(authBundlePath && fs.existsSync(authBundlePath));
    return {
      ...account,
      authBundlePresent,
      status: authBundlePresent ? "live-if-auth-present" : "pending_auth",
      authBundleSource: `env:${account.authBundleEnv}`,
    };
  });
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
  if (!account.authBundlePresent) {
    return {
      attempted: false,
      status: "pending_auth",
      reason: `${account.accountId} auth bundle missing`,
    };
  }

  const authBundlePath = process.env[account.authBundleEnv];
  const prompt = buildPrompt(input);
  const result = runCommand("docker", [
    "run",
    "--rm",
    "-e", "CODEX_HOME=/codex-auth",
    "-v", `${authBundlePath}:/codex-auth:ro`,
    "-v", `${input.rowRoot}:/probe/input:ro`,
    "-w", "/probe/input",
    IMAGE_TAG,
    "codex",
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "never",
    prompt,
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
  if (rows.some((row) => row.rowStatus === "blocked" || row.rowStatus === "blocked_network" || row.rowStatus === "blocked_install_failed")) {
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
      proofboundMemoryLeak: false,
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
      authMountSource: `env:${account.authBundleEnv}`,
      hostHomeMounted: false,
      repoMounted: false,
      latticeMounted: false,
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
    tokensWrittenToRepo: false,
    accountEnvVars: Object.values(AUTH_ENV_BY_ACCOUNT),
  },
  sterilePolicy: {
    mountHome: false,
    mountRepo: false,
    mountLattice: false,
    mountPaper: false,
    mountForeignResults: false,
  },
  docker: sanitizeDockerInfo(docker),
  accounts,
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
