

import { PassThrough } from "node:stream";
import { existsSync } from "node:fs";




import ts from "typescript";
import { runExactHeadIsolatedSelector } from "./exact-head-checkout.mjs";
import { contract, createHarnessOwnedBase, json, cleanupHarnessOwnedBase, ContractFailure } from "./owned-files.mjs";
import { startExactHeadProcessSupervisor, installExactHeadAbortScope, settleExactHeadTerminal } from "./exact-head-supervisor.mjs";
import { expectExactHeadIsolationRejection } from "./exact-head-authorization.mjs";
import { monitorExactHeadTreeLease, proveExactHeadTreeLeaseKernel } from "./tree-lease.mjs";

export async function proveExactHeadSupervisorSafety() {
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
