import { spawn, spawnSync, execFileSync } from "node:child_process";


import { cpSync, existsSync, mkdirSync, realpathSync } from "node:fs";


import { dirname, join, relative } from "node:path";

import ts from "typescript";
import { ContractFailure, contract, assertHarnessOwnedBase, writeFixtureFile, assertOwnedDirectory, BootstrapFailure } from "./owned-files.mjs";
import { EXACT_HEAD_ISOLATION_ENV_KEYS, repoRoot, validationCaseAdapterPath, validationDomainRunnerPath, validationChildEnvironmentPath, dynRegistryPath } from "./support.mjs";

export function processGroupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function signalProcessTree(child, signal) {
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

export async function waitForProcessGroupExit(pid, maximumMs = 2_000) {
  const deadline = Date.now() + maximumMs;
  while (processGroupAlive(pid) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return !processGroupAlive(pid);
}

export function snapshotHarnessProcess(pid) {
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

export function inspectHarnessProcess(pid) {
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

export function boundProcessTerminal(state, identity) {
  if (state.kind === "absent") return true;
  if (state.kind !== "present" || !identity) return false;
  return state.identity.birthIdentity !== identity.birthIdentity
    || state.identity.state?.startsWith("Z") === true;
}

export const HARNESS_CHILD_ENV_KEYS = [
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

export function harnessChildEnvironment(overrides = {}) {
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

export function createIsolatedQuorumRuntime(owner, label) {
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

export async function runNodeSubprocess(nodeArgs, timeoutMs, options, label) {
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
