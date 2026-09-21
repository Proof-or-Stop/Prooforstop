import { execFileSync } from "node:child_process";


import { existsSync } from "node:fs";




import ts from "typescript";
import { snapshotExactHeadProcesses } from "./tree-lease.mjs";
import { harnessChildEnvironment } from "./process-supervision.mjs";
import { BootstrapFailure, contract, assertHarnessOwnedBase, cleanupHarnessOwnedBase } from "./owned-files.mjs";

export function startExactHeadProcessSupervisor(dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const snapshot = dependencies.snapshot ?? (() => snapshotExactHeadProcesses(platform));
  const pause = dependencies.pause ?? ((milliseconds) => new Promise((resolveWait) => {
    setTimeout(resolveWait, milliseconds);
  }));
  const signalPid = dependencies.signalPid ?? ((pid, signal) => process.kill(pid, signal));
  const taskkill = dependencies.taskkill ?? ((pid, force, tree = true) => {
    execFileSync("taskkill", ["/PID", String(pid), ...(tree ? ["/T"] : []), ...(force ? ["/F"] : [])], {
      env: harnessChildEnvironment(),
      stdio: "ignore",
      timeout: 2_000,
    });
  });
  const roots = new Map();
  const captured = new Map();
  const markers = new Set();
  const cleanupBarrierMarkers = new Set();
  const owners = [];
  const errors = [];
  const rootErrors = new Map();
  const treeClearanceErrors = new Map();
  const uncertainPids = new Set();
  let healthy = true;
  let interval = null;
  let abortSignal = null;
  let abortPromise = null;
  let resolveAbortOutcome;
  const abortOutcome = new Promise((resolveOutcome) => { resolveAbortOutcome = resolveOutcome; });
  const key = (row) => `${row.pid}:${row.birthIdentity}:${row.pgid ?? "windows"}`;
  const retireConfirmedReusedCapture = (identityKey, identity, current) => {
    const rootIdentity = roots.get(identity.pid);
    const isTrackedRootIdentity = rootIdentity?.identityKey === identityKey;
    if (isTrackedRootIdentity || uncertainPids.has(identity.pid)
      || current.birthIdentity === identity.birthIdentity) {
      return false;
    }
    captured.delete(identityKey);
    return true;
  };
  const markerWitnessFor = (row) => [...markers]
    .filter((marker) => row.marker.includes(marker))
    .sort((left, right) => right.length - left.length)[0] ?? null;
  const allErrors = () => [
    ...errors,
    ...rootErrors.values(),
    ...treeClearanceErrors.values(),
  ];
  const validatedSnapshot = () => {
    const rows = [...snapshot()];
    const pids = new Set();
    for (const row of rows) {
      const validPgid = platform === "win32" ? row.pgid === null : Number.isSafeInteger(row.pgid);
      if (!Number.isSafeInteger(row.pid) || row.pid <= 0
        || !Number.isSafeInteger(row.ppid) || row.ppid < 0
        || !validPgid || typeof row.birthIdentity !== "string" || !row.birthIdentity
        || typeof row.marker !== "string" || pids.has(row.pid)) {
        throw new BootstrapFailure("exact-HEAD process snapshot has an invalid or duplicate identity");
      }
      pids.add(row.pid);
    }
    return rows;
  };
  const markerMatches = (row) => [...markers].some((marker) => row.marker.includes(marker));
  const cleanupBarrierMatches = (row) => [...cleanupBarrierMarkers]
    .some((marker) => row.marker.includes(marker));
  const observe = () => {
    let rows;
    try { rows = validatedSnapshot(); }
    catch (error) {
      healthy = false;
      errors.push("snapshot: " + error.message);
      throw error;
    }
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const owned = new Set();
    for (const [pid, rootIdentity] of roots) {
      const row = byPid.get(pid);
      if (row?.state.startsWith("Z")) {
        continue;
      } else if (row && key(row) !== rootIdentity.identityKey) {
        uncertainPids.add(pid);
        rootErrors.set(pid, "root identity changed for pid " + pid);
      } else if (row && rootIdentity.markerWitness !== null
        && !row.marker.includes(rootIdentity.markerWitness)) {
        uncertainPids.add(pid);
        rootErrors.set(pid, "root marker witness changed for pid " + pid);
      } else if (row && !uncertainPids.has(pid)) {
        owned.add(pid);
      }
    }
    for (const row of rows) {
      if (!row.state.startsWith("Z")
        && !uncertainPids.has(row.pid) && markerMatches(row)) owned.add(row.pid);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (!row.state.startsWith("Z") && owned.has(row.ppid)
          && !owned.has(row.pid) && !uncertainPids.has(row.pid)) {
          owned.add(row.pid);
          changed = true;
        }
      }
    }
    for (const row of rows) {
      if (row.state.startsWith("Z") || !owned.has(row.pid)) continue;
      const identityKey = key(row);
      if (!captured.has(identityKey)) {
        captured.set(identityKey, {
          ...row,
          strongCapture: platform === "win32",
          stopped: false,
          cleanupBarrier: cleanupBarrierMatches(row),
        });
      } else if (cleanupBarrierMatches(row)) {
        captured.get(identityKey).cleanupBarrier = true;
      }
    }
    return { rows, byPid, owned };
  };
  const safeObserve = () => {
    try { observe(); } catch { /* a failed census is retained in healthy/errors */ }
  };
  const ensureInterval = () => {
    if (interval || dependencies.startInterval === false) return;
    interval = setInterval(safeObserve, dependencies.intervalMs ?? 1_000);
    interval.unref();
  };
  const addMarker = (marker) => {
    contract(typeof marker === "string" && marker.length >= 16, "exact-HEAD workload marker is too weak");
    markers.add(marker);
    safeObserve();
  };
  const addCleanupBarrierMarker = (marker) => {
    contract(typeof marker === "string" && marker.length >= 16,
      "exact-HEAD cleanup-barrier marker is too weak");
    cleanupBarrierMarkers.add(marker);
    markers.add(marker);
    safeObserve();
  };
  const trackRoot = (pid, options = {}) => {
    contract(Number.isSafeInteger(pid) && pid > 1, "exact-HEAD tracked root pid is invalid");
    const { byPid } = observe();
    const row = byPid.get(pid);
    if (!row) {
      healthy = false;
      throw new BootstrapFailure("exact-HEAD child disappeared before birth identity capture: " + pid);
    }
    const identityKey = key(row);
    const markerWitness = platform === "win32" ? null : markerWitnessFor(row);
    if (platform !== "win32" && markerWitness === null) {
      healthy = false;
      errors.push("tracked POSIX root lacks a registered marker witness for pid " + pid);
      throw new BootstrapFailure(
        "exact-HEAD POSIX child lacks a registered marker witness: " + pid,
      );
    }
    roots.set(pid, {
      identityKey,
      markerWitness,
      requiresTreeClearance: options.requiresTreeClearance === true,
    });
    captured.set(identityKey, {
      ...row,
      strongCapture: platform === "win32",
      stopped: false,
      cleanupBarrier: false,
    });
    ensureInterval();
    observe();
    return row;
  };
  const retireRoot = (pid, terminal, options = {}) => {
    contract(
      terminal?.error === null
        && (Number.isInteger(terminal.status)
          || (typeof terminal.signal === "string" && terminal.signal.length > 0)),
      "exact-HEAD root retirement requires a direct child exit event",
    );
    const rootIdentity = roots.get(pid);
    if (!rootIdentity) return { treeCleared: false };
    const treeCleared = !rootIdentity.requiresTreeClearance || options.treeClearance === true;
    if (!treeCleared) {
      treeClearanceErrors.set(
        pid,
        "root exited without authenticated descendant-tree clearance for pid " + pid,
      );
    } else {
      treeClearanceErrors.delete(pid);
    }
    roots.delete(pid);
    captured.delete(rootIdentity.identityKey);
    uncertainPids.delete(pid);
    rootErrors.delete(pid);
    return { treeCleared };
  };
  const confirmTreeClearance = (pid) => {
    contract(
      treeClearanceErrors.has(pid),
      "exact-HEAD tree-clearance confirmation lacks a pending retired root: " + pid,
    );
    treeClearanceErrors.delete(pid);
  };
  const currentOwned = () => {
    const observation = observe();
    const live = [];
    const ambiguous = [];
    for (const [identityKey, identity] of captured) {
      const current = observation.byPid.get(identity.pid);
      if (!current || current.state.startsWith("Z")) continue;
      // A non-root PID with a different birth identity is a reused PID, not a
      // survivor of the captured process. The old identity is conclusively
      // absent and must never authorize a signal to the unrelated replacement.
      // Keep same-birth PGID/marker drift fail-closed because those fields can
      // change without proving that the captured process exited.
      if (retireConfirmedReusedCapture(identityKey, identity, current)) continue;
      if (uncertainPids.has(identity.pid)) {
        ambiguous.push(identity.pid);
        continue;
      }
      if (key(current) !== key(identity)) {
        healthy = false;
        uncertainPids.add(identity.pid);
        ambiguous.push(identity.pid);
        continue;
      }
      const authorized = observation.owned.has(identity.pid)
        || identity.stopped
        || (platform === "win32" && identity.strongCapture);
      if (authorized) live.push(identity);
      else ambiguous.push(identity.pid);
    }
    return { live, ambiguous: [...new Set([...ambiguous, ...uncertainPids])] };
  };
  const send = (identity, signal) => {
    dependencies.beforeSignal?.(identity, signal);
    let authorization;
    try {
      const observation = observe();
      const current = observation.byPid.get(identity.pid);
      if (!current) return "absent";
      if (retireConfirmedReusedCapture(key(identity), identity, current)) return "absent";
      if (uncertainPids.has(identity.pid)) return "ambiguous";
      if (key(current) !== key(identity)) {
        healthy = false;
        uncertainPids.add(identity.pid);
        return "ambiguous";
      }
      authorization = observation.owned.has(identity.pid)
        || identity.stopped
        || (platform === "win32" && identity.strongCapture);
      if (!authorization) {
        uncertainPids.add(identity.pid);
        return "ambiguous";
      }
    } catch {
      return "ambiguous";
    }
    try {
      if (platform === "win32") {
        const preserveCleanupBarrier = roots.has(identity.pid) && cleanupBarrierMarkers.size > 0;
        taskkill(identity.pid, signal === "SIGKILL", !preserveCleanupBarrier);
      }
      else signalPid(identity.pid, signal);
      return "sent";
    } catch (error) {
      if (error?.code === "ESRCH") return "absent";
      try {
        const row = validatedSnapshot().find((candidate) => candidate.pid === identity.pid);
        if (!row) return "absent";
        if (key(row) !== key(identity)) {
          healthy = false;
          uncertainPids.add(identity.pid);
          return "ambiguous";
        }
      } catch (recheckError) {
        healthy = false;
        uncertainPids.add(identity.pid);
        errors.push(`signal recheck ${identity.pid}: ${recheckError.message}`);
        return "ambiguous";
      }
      if (platform === "win32" && signal === "SIGTERM") return "retry";
      errors.push(`${signal} ${identity.pid}: ${error.message}`);
      return "error";
    }
  };
  const reap = async () => {
    safeObserve();
    let state;
    try { state = currentOwned(); }
    catch { return { reaped: false, survivors: [], ambiguous: [], errors: allErrors() }; }
    const rootsLast = (left, right) => Number(roots.has(left.pid)) - Number(roots.has(right.pid));
    const signalable = (rows) => rows.filter((identity) => identity.cleanupBarrier !== true);
    if (platform === "win32") {
      for (const identity of signalable([...state.live]).sort(rootsLast)) send(identity, "SIGTERM");
    } else {
      for (const identity of signalable([...state.live]).sort(rootsLast)) {
        if (send(identity, "SIGSTOP") === "sent") identity.stopped = true;
      }
      safeObserve();
      try { state = currentOwned(); }
      catch { return { reaped: false, survivors: [], ambiguous: [], errors: allErrors() }; }
      for (const identity of signalable([...state.live]).sort(rootsLast)) send(identity, "SIGTERM");
      for (const identity of signalable([...state.live]).sort(rootsLast)) {
        if (send(identity, "SIGCONT") === "sent") identity.stopped = false;
      }
    }
    await pause(dependencies.termGraceMs ?? 300);
    safeObserve();
    try { state = currentOwned(); }
    catch { return { reaped: false, survivors: [], ambiguous: [], errors: allErrors() }; }
    if (platform !== "win32") {
      for (const identity of signalable([...state.live]).sort(rootsLast)) {
        if (send(identity, "SIGSTOP") === "sent") identity.stopped = true;
      }
      safeObserve();
      try { state = currentOwned(); }
      catch { return { reaped: false, survivors: [], ambiguous: [], errors: allErrors() }; }
    }
    for (const identity of signalable([...state.live]).sort(rootsLast)) send(identity, "SIGKILL");
    let finalState = state;
    for (let attempt = 0; attempt < (dependencies.confirmAttempts ?? 20); attempt += 1) {
      await pause(dependencies.confirmPauseMs ?? 50);
      safeObserve();
      try { finalState = currentOwned(); }
      catch { break; }
      if (finalState.live.length === 0 && finalState.ambiguous.length === 0) break;
      if (platform === "win32") {
        for (const identity of signalable(finalState.live)) send(identity, "SIGKILL");
      } else {
        for (const identity of signalable(finalState.live)) {
          if (!identity.stopped && send(identity, "SIGSTOP") === "sent") identity.stopped = true;
          send(identity, "SIGKILL");
        }
      }
    }
    return {
      reaped: healthy && errors.length === 0 && rootErrors.size === 0
        && treeClearanceErrors.size === 0
        && finalState.live.length === 0 && finalState.ambiguous.length === 0,
      survivors: finalState.live.map((row) => row.pid),
      ambiguous: finalState.ambiguous,
      errors: allErrors(),
    };
  };
  const requestAbort = (signal) => {
    abortSignal ??= signal;
    if (!abortPromise) {
      abortPromise = reap();
      void abortPromise.then(
        (cleanup) => resolveAbortOutcome({ signal: abortSignal, cleanup }),
        (error) => resolveAbortOutcome({
          signal: abortSignal,
          cleanup: { reaped: false, survivors: [], ambiguous: [], errors: [error.message] },
        }),
      );
    }
    return abortPromise;
  };
  return {
    addMarker,
    addCleanupBarrierMarker,
    confirmTreeClearance,
    trackOwner(owner) {
      assertHarnessOwnedBase(owner, "exact-HEAD abort-scope owner");
      owners.push(owner);
    },
    cleanupOwners(cleanup, label) {
      if (!cleanup?.reaped) return false;
      for (const owner of [...owners].reverse()) {
        if (existsSync(owner.path)) cleanupHarnessOwnedBase(owner, label);
      }
      owners.length = 0;
      return true;
    },
    get ownerPaths() { return owners.map((owner) => owner.realpath); },
    trackRoot,
    retireRoot,
    observe: safeObserve,
    reap,
    requestAbort,
    throwIfAborted() {
      if (abortSignal) throw new BootstrapFailure("exact-HEAD isolation interrupted by " + abortSignal);
    },
    get abortSignal() { return abortSignal; },
    waitForAbortOutcome() { return abortOutcome; },
    async finishAbort() { return abortPromise ? await abortPromise : null; },
    close() { if (interval) clearInterval(interval); },
  };
}

export function installExactHeadAbortScope(supervisor, dependencies = {}) {
  const on = dependencies.on ?? ((signal, handler) => process.on(signal, handler));
  const off = dependencies.off ?? ((signal, handler) => process.off(signal, handler));
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => { void supervisor.requestAbort(signal); };
    handlers.set(signal, handler);
    on(signal, handler);
  }
  return {
    close() { for (const [signal, handler] of handlers) off(signal, handler); },
  };
}

export async function settleExactHeadTerminal({
  child,
  terminalPromise,
  cleanupOutcomes,
  pause = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
  settleMs = 250,
}) {
  const first = await Promise.race([
    terminalPromise.then((terminal) => ({ kind: "terminal", terminal })),
    ...cleanupOutcomes.map((outcome) => outcome.then((value) => ({ kind: "cleanup", ...value }))),
  ]);
  if (first.kind === "terminal") return { terminal: first.terminal, cleanup: null, bounded: false };
  const bounded = await Promise.race([
    terminalPromise.then((terminal) => ({ terminal })),
    pause(settleMs).then(() => ({ terminal: null })),
  ]);
  if (bounded.terminal) {
    return { terminal: bounded.terminal, cleanup: first.cleanup, bounded: false };
  }
  child.stdout?.destroy?.();
  child.stderr?.destroy?.();
  child.unref?.();
  return { terminal: null, cleanup: first.cleanup, bounded: true };
}
