import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";






import ts from "typescript";
import { harnessChildEnvironment, snapshotHarnessProcess } from "./process-supervision.mjs";
import { BootstrapFailure, contract, assertHarnessOwnedBase, createHarnessOwnedFile, writeHarnessOwnedFile, createHarnessOwnedBase, json, readHarnessOwnedFile, cleanupHarnessOwnedBase } from "./owned-files.mjs";
import { EXACT_HEAD_TREE_LEASE_FD, EXACT_HEAD_TREE_LEASE_ROOT_ENV, EXACT_HEAD_TREE_LEASE_GUARDIAN_ENV, EXACT_HEAD_TREE_LEASE_RELEASE_PATH_ENV, EXACT_HEAD_TREE_LEASE_RELEASE_NONCE_ENV, exactHeadTreeLeasePreloadSource, EXACT_HEAD_TREE_LEASE_MARKER_ENV } from "./support.mjs";
import { wait } from "./worker-coordination.mjs";

export function snapshotExactHeadProcesses(platform = process.platform) {
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

export function exactHeadTreeLeaseStdio() {
  contract(
    EXACT_HEAD_TREE_LEASE_FD === 4,
    "exact-HEAD tree lease must remain on the source-audited low descriptor 4",
  );
  const stdio = ["ignore", "inherit", "inherit"];
  while (stdio.length < EXACT_HEAD_TREE_LEASE_FD) stdio.push("ignore");
  stdio[EXACT_HEAD_TREE_LEASE_FD] = "pipe";
  return stdio;
}

export function exactHeadTreeLeaseRootEnvironment(overrides, guardianMarker, releaseRecord, releaseNonce) {
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

export function createExactHeadTreeLeaseGuardianAuthority(owner, label) {
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

export function releaseExactHeadTreeLeaseGuardian(authority, label) {
  contract(authority && authority.released === false, label + " guardian was already released");
  writeHarnessOwnedFile(
    authority.releaseRecord,
    label + " guardian release token",
    authority.nonce,
  );
  authority.released = true;
}

export function monitorExactHeadTreeLease(stream, rootProcess = null) {
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

export async function proveExactHeadTreeLeaseKernel() {
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
