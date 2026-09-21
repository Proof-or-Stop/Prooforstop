import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { contract, json, ContractFailure, noFollowFlag, cleanupHarnessOwnedBase } from "./owned-files.mjs";
import { workerSourcePath, repoRoot } from "./support.mjs";
import { wait } from "./worker-coordination.mjs";

export const PERFORMANCE_CAPABILITY = Object.freeze({
  schema: "proof-or-stop.quorum-smoke-parallel-capability.v1",
  shardCount: 4,
  workerModel: "one-process-per-shard",
  tempIsolation: "parent-owned-roots-v1",
});

export function assertPerformanceSourceCapability() {
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

export function performanceStop(reason) {
  console.log("PERFORMANCE_STOP " + reason);
  throw new ContractFailure("performance protocol stopped: " + reason);
}

export function measurementEnvironment() {
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

export function acquirePerformanceLease() {
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

export function releasePerformanceLease(lease) {
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

export function retainPerformanceLease(lease) {
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

export function cpuTimes() {
  return cpus().reduce((sum, cpu) => {
    const total = Object.values(cpu.times).reduce((value, item) => value + item, 0);
    return { idle: sum.idle + cpu.times.idle, total: sum.total + total };
  }, { idle: 0, total: 0 });
}

export function performanceProcessRows() {
  return execFileSync("ps", ["-ww", "-axo", "pid=,ppid=,pgid=,lstart=,%cpu=,command="], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
  }).split(/\r?\n/).map((line) => line.match(
    /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+([0-9.]+)\s+(.*)$/,
  )).filter(Boolean).map((match) => ({
    pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]),
    started: match[4], cpuPercent: Number(match[5]), command: match[6],
  }));
}

export function relatedProcessIds(rows, rootPid) {
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

export function competingPerformanceProcesses(rows, excluded) {
  return rows.filter((row) => !excluded.has(row.pid) && (
    /quorum-submit-smoke|red-B-e40f-quorum-submit-harness\.mjs.*performance-contract/.test(row.command)
      || /(?:npm .* run build|typescript[\\/]bin[\\/]tsc|proof-or-stop(?:\.js)? (?:validate|done_prepare))/.test(row.command)
      || /(?:^|\s)(?:npm|pnpm|yarn|bun)(?:\s+[^\s]+)*\s+(?:install|ci|add|update)(?:\s|$)/.test(row.command)
  ));
}

export async function assertIdlePerformanceHost(label) {
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

export function installedDependencyRoot() {
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

export function observePerformanceTree(rootPid) {
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

export async function waitForObservedTreeExit(tree, maximumMs = 2_000) {
  const deadline = Date.now() + maximumMs;
  while (tree.live().length > 0 && Date.now() < deadline) await wait(25);
  return tree.live();
}

export function createPerformanceCleanupScope() {
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
