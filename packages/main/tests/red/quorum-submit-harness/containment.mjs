import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";





import { pathToFileURL } from "node:url";
import ts from "typescript";
import { contract, ContractFailure, json, createHarnessOwnedBase, createHarnessOwnedFile, writeHarnessOwnedFile, readHarnessOwnedFile, cleanupHarnessOwnedBase } from "./owned-files.mjs";
import { workerDistPath, repoRoot } from "./support.mjs";
import { snapshotHarnessProcess, harnessChildEnvironment, inspectHarnessProcess, boundProcessTerminal } from "./process-supervision.mjs";
import { wait } from "./worker-coordination.mjs";
import { parseOwnedJsonLines } from "./selection-contracts.mjs";
import { snapshotExactHeadProcesses } from "./tree-lease.mjs";

export async function proveCrossPlatformProcessTreeDispatch(worker) {
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

export async function proveDetachedDescendantContainment(worker) {
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

export async function proveCoordinatorLossAfterWorkerTerm(worker) {
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
