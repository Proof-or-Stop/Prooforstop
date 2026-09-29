import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { cpSync, existsSync, lstatSync, realpathSync, readdirSync, symlinkSync, unlinkSync } from "node:fs";


import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { settleExactHeadTerminal, startExactHeadProcessSupervisor, installExactHeadAbortScope } from "./exact-head-supervisor.mjs";
import { BootstrapFailure, json, createHarnessOwnedFile, writeHarnessOwnedFile, createHarnessOwnedBase, contract, strictDescendant, assertOwnedPath, assertOwnedDirectory, writeFixtureFile } from "./owned-files.mjs";
import { captureExactHeadSource, expectExactHeadIsolationRejection, requireCleanExactHeadStatus, createExactHeadIsolationOwner, createExactHeadCloneGitEnvironment, assertIndependentExactHeadClone, snapshotCorrectnessDependencies, correctnessDependencyRoot, validateExactHeadIsolationManifest, assertExactHeadSourceUnchanged, assertCorrectnessDependenciesUnchanged } from "./exact-head-authorization.mjs";
import { harnessRelativePath, exactHeadTreeLeasePreloadSource, repoRoot, EXACT_HEAD_ISOLATION_SCHEMA, ORIGINAL_SMOKE_COMMIT, EXACT_HEAD_TREE_LEASE_ROOT_ENV, EXACT_HEAD_TREE_LEASE_GUARDIAN_ENV, EXACT_HEAD_TREE_LEASE_RELEASE_PATH_ENV, EXACT_HEAD_TREE_LEASE_RELEASE_NONCE_ENV, EXACT_HEAD_ISOLATION_MANIFEST_ENV, EXACT_HEAD_ISOLATION_NONCE_ENV, EXACT_HEAD_TREE_LEASE_FD } from "./support.mjs";
import { createExactHeadTreeLeaseGuardianAuthority, exactHeadTreeLeaseStdio, monitorExactHeadTreeLease, releaseExactHeadTreeLeaseGuardian } from "./tree-lease.mjs";
import { treeContentDigest } from "./performance-material.mjs";
import { harnessChildEnvironment } from "./process-supervision.mjs";

export async function runSupervisedExactHeadGit(supervisor, cwd, args, env, label) {
  supervisor.throwIfAborted();
  const child = spawn("git", args, {
    cwd,
    env: { ...env, PWD: cwd },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    supervisor.trackRoot(child.pid);
  } catch (error) {
    try { child.kill("SIGKILL"); } catch { /* direct ChildProcess handle is the only remaining authority */ }
    throw error;
  }
  const terminalPromise = new Promise((resolveTerminal) => {
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
  const settled = await settleExactHeadTerminal({
    child,
    terminalPromise,
    cleanupOutcomes: [supervisor.waitForAbortOutcome()],
  });
  const terminal = settled.terminal;
  if (terminal?.error === null) supervisor.retireRoot(child.pid, terminal);
  supervisor.throwIfAborted();
  if (!terminal) {
    throw new BootstrapFailure(
      label + " did not terminate after bounded cleanup; cleanup=" + json(settled.cleanup),
    );
  }
  if (terminal.error || terminal.status !== 0) {
    throw new BootstrapFailure(
      label + " failed: "
        + (terminal.error?.message ?? stderr.trim() ?? `exit ${terminal.status} signal ${terminal.signal}`),
    );
  }
  return stdout.trim();
}

export async function prepareExactHeadIsolation(selected, supervisor, workloadMarker, supervisorSafetyProven) {
  const source = captureExactHeadSource();
  supervisor.throwIfAborted();
  expectExactHeadIsolationRejection(
    () => requireCleanExactHeadStatus(" M " + harnessRelativePath, "synthetic dirty source"),
    /clean tracked and untracked worktree/,
    "dirty-HEAD negative",
  );
  const owner = createExactHeadIsolationOwner(source);
  supervisor.trackOwner(owner);
  try {
    const treeLeasePreload = createHarnessOwnedFile(
      owner,
      "tree-lease-preload-" + randomUUID() + ".cjs",
      "exact-HEAD tree lease preload",
    );
    writeHarnessOwnedFile(
      treeLeasePreload,
      "exact-HEAD tree lease preload",
      exactHeadTreeLeasePreloadSource(workloadMarker),
    );
    const treeLeaseGuardian = createExactHeadTreeLeaseGuardianAuthority(
      owner,
      "exact-HEAD isolation",
    );
    const workloadOwner = createHarnessOwnedBase("b-e40f-exact-head-workload-");
    supervisor.trackOwner(workloadOwner);
    contract(
      owner.realpath !== workloadOwner.realpath
        && !strictDescendant(owner.realpath, workloadOwner.realpath)
        && !strictDescendant(workloadOwner.realpath, owner.realpath),
      "exact-HEAD clone and workload temp owners overlap",
    );
    const gitEnv = createExactHeadCloneGitEnvironment(owner);
    const cloneRoot = join(owner.realpath, "checkout");
    supervisor.addMarker(cloneRoot);
    supervisor.addMarker(workloadOwner.realpath);
    assertOwnedPath(owner, cloneRoot, "exact-HEAD clone destination", { mustExist: false, directory: true });
    await runSupervisedExactHeadGit(supervisor, owner.realpath, [
      "clone", "--no-local", "--no-checkout", "--quiet", "--", repoRoot, cloneRoot,
    ], gitEnv, "exact-HEAD no-local clone");
    supervisor.throwIfAborted();
    assertOwnedDirectory(owner, cloneRoot, "exact-HEAD clone after clone");
    await runSupervisedExactHeadGit(
      supervisor,
      cloneRoot,
      ["checkout", "--detach", "--quiet", source.head],
      gitEnv,
      "exact-HEAD detached checkout",
    );
    supervisor.throwIfAborted();
    const topology = assertIndependentExactHeadClone(owner, cloneRoot, source, gitEnv);
    try {
      writeFixtureFile(owner, cloneRoot, ".git/objects/info/alternates", source.objectDir + "\n");
      expectExactHeadIsolationRejection(
        () => assertIndependentExactHeadClone(owner, cloneRoot, source, gitEnv),
        /alternates/,
        "shared-alternates negative",
      );
    } finally {
      if (existsSync(topology.alternates)) unlinkSync(topology.alternates);
    }
    assertIndependentExactHeadClone(owner, cloneRoot, source, gitEnv);

    const cloneDist = join(cloneRoot, "packages/main/dist");
    contract(!existsSync(cloneDist), "exact-HEAD checkout unexpectedly contains a dist overlay");
    cpSync(join(repoRoot, "packages/main/dist"), cloneDist, { recursive: true, force: true });
    supervisor.throwIfAborted();
    contract(
      treeContentDigest(cloneDist, "copied correctness dist") === source.distDigest,
      "complete copied dist differs from the source build",
    );
    const bindingPath = join(cloneRoot, "scripts/full-suite-build-binding.mjs");
    const binding = await import(pathToFileURL(bindingPath).href + "?exact-head=" + randomUUID());
    contract(typeof binding.verifyBuildBinding === "function", "clone build-binding verifier is unavailable");
    binding.verifyBuildBinding(cloneRoot);
    supervisor.throwIfAborted();

    const dependency = snapshotCorrectnessDependencies(correctnessDependencyRoot());
    const dependencyLinkPath = join(cloneRoot, "node_modules");
    contract(!existsSync(dependencyLinkPath), "exact-HEAD clone unexpectedly contains node_modules");
    symlinkSync(dependency.path, dependencyLinkPath, process.platform === "win32" ? "junction" : "dir");
    const dependencyLinkEntry = lstatSync(dependencyLinkPath);
    contract(
      dependencyLinkEntry.isSymbolicLink() && realpathSync(dependencyLinkPath) === dependency.path,
      "correctness dependency link is not bound to the captured read-only target",
    );
    const dependencyLink = {
      path: dependencyLinkPath,
      dev: dependencyLinkEntry.dev,
      ino: dependencyLinkEntry.ino,
    };
    supervisor.throwIfAborted();

    const nonce = randomUUID();
    const manifest = createHarnessOwnedFile(owner, "inner-authority-" + randomUUID() + ".json", "inner authority");
    const ownerEntry = lstatSync(owner.realpath);
    const payload = {
      schema: EXACT_HEAD_ISOLATION_SCHEMA,
      nonce,
      selector: selected,
      innerRoot: realpathSync(cloneRoot),
      head: source.head,
      tree: source.tree,
      harnessBlob: source.harnessBlob,
      originalSmokeCommit: ORIGINAL_SMOKE_COMMIT,
      outerPid: process.pid,
      ownerDev: ownerEntry.dev,
      ownerIno: ownerEntry.ino,
      manifestDev: manifest.dev,
      manifestIno: manifest.ino,
      createdAtMs: Date.now(),
      supervisorSafetyProven,
    };
    validateExactHeadIsolationManifest(payload, {
      nonce,
      selector: selected,
      innerRoot: payload.innerRoot,
      head: source.head,
      tree: source.tree,
      harnessBlob: source.harnessBlob,
      outerPid: process.pid,
      supervisorSafetyProven,
    });
    expectExactHeadIsolationRejection(
      () => validateExactHeadIsolationManifest(payload, {
        nonce: randomUUID(),
        selector: selected,
        innerRoot: payload.innerRoot,
        head: source.head,
        tree: source.tree,
        harnessBlob: source.harnessBlob,
        outerPid: process.pid,
        supervisorSafetyProven,
      }),
      /nonce/,
      "forged internal marker negative",
    );
    expectExactHeadIsolationRejection(
      () => validateExactHeadIsolationManifest(
        { ...payload, supervisorSafetyProven: !supervisorSafetyProven },
        {
          nonce,
          selector: selected,
          innerRoot: payload.innerRoot,
          head: source.head,
          tree: source.tree,
          harnessBlob: source.harnessBlob,
          outerPid: process.pid,
          supervisorSafetyProven,
        },
      ),
      /supervisor-safety binding/,
      "forged supervisor-safety binding negative",
    );
    writeHarnessOwnedFile(manifest, "inner authority", json(payload) + "\n");
    assertExactHeadSourceUnchanged(source);
    assertCorrectnessDependenciesUnchanged(dependency, dependencyLink);
    supervisor.throwIfAborted();
    return {
      owner, workloadOwner, source, gitEnv, cloneRoot, topology,
      binding, dependency, dependencyLink, manifest, nonce, treeLeasePreload,
      treeLeaseGuardian,
    };
  } catch (error) {
    throw error;
  }
}

export async function runExactHeadIsolatedSelector(selected, supervisorSafetyProven = false) {
  const supervisor = startExactHeadProcessSupervisor();
  const abortScope = installExactHeadAbortScope(supervisor);
  const workloadMarker = "b-e40f-exact-head-workload-" + randomUUID();
  supervisor.addMarker(workloadMarker);
  let prepared = null;
  let timeout = null;
  let timeoutCleanupPromise = null;
  let cleanup = null;
  let timedOut = false;
  let child = null;
  let treeLease = null;
  try {
    supervisor.throwIfAborted();
    prepared = await prepareExactHeadIsolation(
      selected,
      supervisor,
      workloadMarker,
      supervisorSafetyProven,
    );
    supervisor.throwIfAborted();
    const childEnv = harnessChildEnvironment({
      TMPDIR: prepared.workloadOwner.realpath,
      TMP: prepared.workloadOwner.realpath,
      TEMP: prepared.workloadOwner.realpath,
    });
    contract(!/\s/.test(prepared.treeLeasePreload.realpath),
      "exact-HEAD tree lease preload path contains unsupported whitespace");
    childEnv.NODE_OPTIONS = (
      `${childEnv.NODE_OPTIONS ?? ""} --title=${workloadMarker} `
        + `--require=${prepared.treeLeasePreload.realpath}`
    ).trim();
    childEnv[EXACT_HEAD_TREE_LEASE_ROOT_ENV] = "1";
    childEnv[EXACT_HEAD_TREE_LEASE_GUARDIAN_ENV] = prepared.treeLeaseGuardian.marker;
    childEnv[EXACT_HEAD_TREE_LEASE_RELEASE_PATH_ENV]
      = prepared.treeLeaseGuardian.releaseRecord.realpath;
    childEnv[EXACT_HEAD_TREE_LEASE_RELEASE_NONCE_ENV] = prepared.treeLeaseGuardian.nonce;
    childEnv[EXACT_HEAD_ISOLATION_MANIFEST_ENV] = prepared.manifest.path;
    childEnv[EXACT_HEAD_ISOLATION_NONCE_ENV] = prepared.nonce;
    supervisor.addCleanupBarrierMarker(prepared.treeLeaseGuardian.marker);
    child = spawn(process.execPath, [
      "--title=" + workloadMarker,
      join(prepared.cloneRoot, harnessRelativePath),
      "--case=" + selected,
    ], {
      cwd: prepared.cloneRoot,
      env: childEnv,
      detached: process.platform !== "win32",
      stdio: exactHeadTreeLeaseStdio(),
      windowsHide: true,
    });
    treeLease = monitorExactHeadTreeLease(child.stdio[EXACT_HEAD_TREE_LEASE_FD], child);
    supervisor.trackRoot(child.pid, { requiresTreeClearance: true });
    let resolveTimeoutOutcome;
    const timeoutOutcome = new Promise((resolveOutcome) => { resolveTimeoutOutcome = resolveOutcome; });
    timeout = setTimeout(() => {
      timedOut = true;
      timeoutCleanupPromise ??= supervisor.reap();
      void timeoutCleanupPromise.then(
        (result) => resolveTimeoutOutcome({ signal: null, cleanup: result }),
        (error) => resolveTimeoutOutcome({
          signal: null,
          cleanup: { reaped: false, survivors: [], ambiguous: [], errors: [error.message] },
        }),
      );
    }, selected === "resource-parallel-contract" ? 50 * 60_000 : 30 * 60_000);
    const terminalPromise = new Promise((resolveTerminal) => {
      child.once("error", (error) => resolveTerminal({ error, status: null, signal: null }));
      child.once("exit", (status, signal) => {
        treeLease.markRootTerminal();
        releaseExactHeadTreeLeaseGuardian(
          prepared.treeLeaseGuardian,
          "exact-HEAD isolation",
        );
        resolveTerminal({ error: null, status, signal });
      });
    });
    const settled = await settleExactHeadTerminal({
      child,
      terminalPromise,
      cleanupOutcomes: [supervisor.waitForAbortOutcome(), timeoutOutcome],
    });
    const terminal = settled.terminal;
    cleanup ??= settled.cleanup;
    clearTimeout(timeout);
    timeout = null;
    let treeLeaseOutcome = await treeLease.wait(2_000);
    if (terminal?.error === null) {
      const retirement = supervisor.retireRoot(child.pid, terminal, {
        treeClearance: treeLeaseOutcome.cleared
          && treeLeaseOutcome.afterRootTerminal === true,
      });
      if (retirement.treeCleared) {
        // Never authorize owner deletion from a stale abort/timeout result.
        cleanup = await supervisor.reap();
      } else {
        cleanup = await supervisor.reap();
        if (!treeLeaseOutcome.cleared && treeLeaseOutcome.reason === "timeout") {
          treeLeaseOutcome = await treeLease.wait(2_000);
          if (treeLeaseOutcome.cleared && treeLeaseOutcome.afterRootTerminal === true) {
            supervisor.confirmTreeClearance(child.pid);
            cleanup = await supervisor.reap();
          }
        }
      }
    } else if (!treeLeaseOutcome.cleared) {
      cleanup = {
        reaped: false,
        survivors: cleanup?.survivors ?? [],
        ambiguous: cleanup?.ambiguous ?? [],
        errors: [
          ...(cleanup?.errors ?? []),
          "exact-HEAD descendant tree lease did not reach EOF: " + treeLeaseOutcome.reason,
        ],
      };
    }
    if (!terminal) {
      if (!cleanup?.reaped) {
        throw new BootstrapFailure(
          "isolated harness did not terminate after bounded failed cleanup; retained "
            + supervisor.ownerPaths.join(",") + " detail=" + json(cleanup),
        );
      }
      if (supervisor.abortSignal) {
        return { isolated: true, status: null, signal: supervisor.abortSignal };
      }
      if (timedOut) return { isolated: true, status: 124, signal: null };
      throw new BootstrapFailure("isolated harness terminal event was not observed after cleanup");
    }
    if (terminal.error) throw new BootstrapFailure("could not start isolated harness: " + terminal.error.message);
    const abortCleanup = await supervisor.finishAbort();
    cleanup ??= abortCleanup
      ?? (timeoutCleanupPromise ? await timeoutCleanupPromise : await supervisor.reap());
    if (!cleanup.reaped) {
      throw new BootstrapFailure(
        "isolated harness process tree cleanup was not authenticated; retained "
          + supervisor.ownerPaths.join(",") + " detail=" + json(cleanup),
      );
    }
    if (supervisor.abortSignal) {
      return { isolated: true, status: null, signal: supervisor.abortSignal };
    }
    contract(!existsSync(prepared.manifest.path), "inner harness did not consume its one-shot authority manifest");
    assertIndependentExactHeadClone(prepared.owner, prepared.cloneRoot, prepared.source, prepared.gitEnv);
    prepared.binding.verifyBuildBinding(prepared.cloneRoot);
    assertCorrectnessDependenciesUnchanged(prepared.dependency, prepared.dependencyLink);
    assertExactHeadSourceUnchanged(prepared.source);
    contract(
      readdirSync(prepared.workloadOwner.path).length === 0,
      "isolated correctness selector left workload temp residue",
    );
    return {
      isolated: true,
      status: timedOut ? 124 : terminal.status,
      signal: timedOut ? null : terminal.signal,
    };
  } catch (error) {
    if (!cleanup) {
      const abortCleanup = await supervisor.finishAbort();
      cleanup = abortCleanup
        ?? (timeoutCleanupPromise ? await timeoutCleanupPromise : await supervisor.reap());
    }
    if (!cleanup.reaped) {
      throw new BootstrapFailure(
        "exact-HEAD isolation failed with unauthenticated cleanup; retained "
          + supervisor.ownerPaths.join(",") + " detail=" + json(cleanup)
          + " cause=" + error.message,
      );
    }
    if (supervisor.abortSignal) {
      return { isolated: true, status: null, signal: supervisor.abortSignal };
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    abortScope.close();
    supervisor.close();
    if (cleanup?.reaped) {
      supervisor.cleanupOwners(cleanup, "exact-HEAD correctness abort-scope cleanup");
      contract(
        supervisor.ownerPaths.length === 0,
        "exact-HEAD cleanup scope retained owners after authenticated process cleanup",
      );
    }
    treeLease?.close();
  }
}
