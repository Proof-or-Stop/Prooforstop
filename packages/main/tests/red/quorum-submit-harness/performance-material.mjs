import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, readdirSync, writeFileSync } from "node:fs";


import { isAbsolute, join, resolve } from "node:path";

import ts from "typescript";
import { repoRoot, ORIGINAL_SMOKE_COMMIT } from "./support.mjs";
import { performanceStop, installedDependencyRoot, cpuTimes, observePerformanceTree, relatedProcessIds, competingPerformanceProcesses, waitForObservedTreeExit } from "./performance-context.mjs";
import { contract, ContractFailure, strictDescendant, json, BootstrapFailure } from "./owned-files.mjs";
import { readJsonTarget } from "./selection.mjs";

export function preparePerformanceCheckout(owner, name, candidateHead) {
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

export function prepareBaselineCheckout(owner, candidateHead) {
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

export async function buildPerformanceTarget(cwd, label, env, scope) {
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

export function fileDigest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function treeContentDigest(root, label) {
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

export function executableIdentity(path, label) {
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

export function assertExecutableFrozen(expected, label) {
  const entry = lstatSync(expected.realpath);
  contract(
    entry.isFile() && !entry.isSymbolicLink()
      && entry.dev === expected.dev && entry.ino === expected.ino
      && entry.size === expected.size && entry.mtimeMs === expected.mtimeMs,
    label + " executable identity changed during performance sampling",
  );
}

export function performanceToolchainIdentity(dependencyRoot) {
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

export function dependencySentinelDigest(dependencyRoot) {
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

export function performanceMaterialIdentity(root, binding, dependencyRoot) {
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

export function assertPerformanceMaterialFrozen(
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

export async function runSupervisedPerformanceProcess({
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
