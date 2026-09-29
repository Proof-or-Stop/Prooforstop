import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { existsSync, readFileSync, realpathSync, readdirSync } from "node:fs";

import { cpus } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { performanceStop, assertIdlePerformanceHost, assertPerformanceSourceCapability, measurementEnvironment, createPerformanceCleanupScope, acquirePerformanceLease, releasePerformanceLease, PERFORMANCE_CAPABILITY, retainPerformanceLease } from "./performance-context.mjs";
import { runSupervisedPerformanceProcess, preparePerformanceCheckout, prepareBaselineCheckout, buildPerformanceTarget, performanceToolchainIdentity, performanceMaterialIdentity, treeContentDigest, fileDigest, assertPerformanceMaterialFrozen } from "./performance-material.mjs";
import { EXPECTED_CASES, manifestPath, harnessRelativePath, repoRoot, ORIGINAL_SMOKE_COMMIT } from "./support.mjs";
import { contract, json, assertOwnedPath, assertOwnedPathAbsent, createHarnessOwnedBase, ContractFailure, cleanupHarnessOwnedBase, PerformanceContamination } from "./owned-files.mjs";
import { parseRunReport, assertReportResidue } from "./selection-contracts.mjs";
import { manifestRows } from "./coordinator-wiring.mjs";
import { readJsonTarget } from "./selection.mjs";
import { resultCaseId, loadWorkerContract } from "./worker-coordination.mjs";
import { gitStatus } from "./callback-inventory.mjs";

export async function runTimedPerformanceProcess({ cwd, script, args, env, label, scope }) {
  const timeExecutable = "/usr/bin/time";
  if (!existsSync(timeExecutable)) performanceStop("portable_process_timer_missing");
  return runSupervisedPerformanceProcess({
    cwd,
    executable: timeExecutable,
    args: ["-p", process.execPath, script, ...args],
    env,
    label,
    timeoutMs: 45 * 60_000,
    measure: true,
    scope,
  });
}

export function performanceVerdictDigest(rows, label) {
  const normalized = rows.map((row) => [String(row.id), String(row.status)]).sort();
  const expected = EXPECTED_CASES.map((row) => [row.id, "PASS"]);
  contract(json(normalized) === json(expected), label + " did not produce the exact 73 PASS identities");
  return createHash("sha256").update(normalized.map((row) => row.join(":" )).join("\n") + "\n").digest("hex");
}

export function baselinePerformanceDigest(stdout) {
  const idsByTitle = new Map(EXPECTED_CASES.map((row) => [row.title, row.id]));
  const titles = stdout.split(/\r?\n/).map((line) => line.match(/^  ✓ (.+)$/)?.[1]).filter(Boolean);
  const unknown = titles.filter((title) => !idsByTitle.has(title));
  const duplicate = titles.filter((title, index) => titles.indexOf(title) !== index);
  contract(unknown.length === 0, "baseline emitted unknown case titles: " + json(unknown));
  contract(duplicate.length === 0, "baseline emitted duplicate case titles: " + json(duplicate));
  const rows = titles.map((title) => ({ id: idsByTitle.get(title), status: "PASS" }));
  contract(/quorum_submit smoke passed \(73 checks\)/.test(stdout), "baseline did not finish all 73 checks");
  return performanceVerdictDigest(rows, "fixed baseline");
}

export function currentPerformanceDigest(stdout, jobs, owner) {
  const report = parseRunReport(stdout, "performance jobs=" + jobs);
  contract(
    report.ok === true && report.status === "PASS" && report.jobs === jobs
      && report.retryCount === 0 && report.processTreeReaped === true
      && report.orphanedDescendants === false,
    "performance current report failed or omitted terminal process/retry state",
  );
  assertReportResidue(report, "performance jobs=" + jobs);
  const inventory = manifestRows(readJsonTarget(manifestPath, "performance inventory"));
  const shards = inventory.map((row) => row.shard).filter((value, index, all) => all.indexOf(value) === index).sort();
  contract(
    Array.isArray(report.shards) && json(report.shards.map((row) => row.shardId).sort()) === json(shards)
      && report.shards.every((row) => {
        const expectedIds = inventory.filter((item) => item.shard === row.shardId).map((item) => item.id).sort();
        const sentinels = inventory.filter((item) => item.shard === row.shardId && item.sentinel === "real")
          .map((item) => item.id).sort();
        assertReportResidue(row, "performance shard " + row.shardId);
        return row.status === "PASS" && row.attempts === 1 && row.retryCount === 0
          && row.processTreeReaped === true && row.orphanedDescendants === false
          && Number.isInteger(row.workerPid) && row.workerPid > 0 && row.workerPid !== report.parentPid
          && Array.isArray(row.caseIds) && Array.isArray(row.sentinelCaseIds)
          && json([...row.caseIds].sort()) === json(expectedIds)
          && json([...row.sentinelCaseIds].sort()) === json(sentinels);
      }),
    "performance current report omitted an exact successful shard set",
  );
  contract(report.ownedTempBase === owner.realpath, "performance run ignored its owned temp base");
  for (const root of report.ownedTempRoots ?? []) {
    const normalized = assertOwnedPath(owner, root, "performance worker root", { mustExist: false, directory: true }).normalized;
    assertOwnedPathAbsent(owner, normalized, "performance cleaned worker root");
  }
  contract(
    report.results.every((row) => row.status === "PASS" && row.attempts === 1
      && Number.isInteger(row.workerPid) && row.workerPid > 0 && row.workerPid !== report.parentPid),
    "performance results omitted exact-once worker verdicts",
  );
  const intervals = report.results.map((row) => ({
    pid: row.workerPid, start: Number(row.startedAtMs), end: Number(row.endedAtMs),
  }));
  const overlap = intervals.some((left, index) => intervals.slice(index + 1)
    .some((right) => left.pid !== right.pid && left.start < right.end && right.start < left.end));
  contract(
    jobs === 1 ? report.maxConcurrent === 1 && !overlap : report.maxConcurrent >= 2 && report.maxConcurrent <= jobs && overlap,
    "performance jobs=" + jobs + " did not demonstrate its requested concurrency",
  );
  return performanceVerdictDigest(
    report.results.map((row) => ({ id: resultCaseId(row), status: row.status })),
    "performance jobs=" + jobs,
  );
}

export async function performanceSample(mode, currentRoot, baselineRoot, env, round, slot, assertFrozen, scope) {
  const idle = await assertIdlePerformanceHost("round=" + round + " slot=" + slot);
  assertFrozen();
  const owner = createHarnessOwnedBase("b-e40f-performance-sample-");
  scope.trackOwner(owner);
  const current = mode !== "baseline";
  const jobs = mode === "jobs2" ? 2 : 1;
  try {
    const execution = await runTimedPerformanceProcess({
      cwd: current ? currentRoot : baselineRoot,
      script: join(
        current ? currentRoot : baselineRoot,
        "packages/main/dist/tasks/quorum-submit-smoke.js",
      ),
      args: current ? ["--jobs=" + jobs, "--report=json"] : [],
      env: {
        ...env,
        TMPDIR: owner.realpath, TMP: owner.realpath, TEMP: owner.realpath,
        PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE: owner.realpath,
      },
      label: "performance " + mode + " round=" + round,
      scope,
    });
    if (execution.status !== 0) {
      const detail = (execution.stdout + execution.stderr).slice(-4_000);
      if (!current) performanceStop("baseline_incompatible sample_exit=" + execution.status + " " + detail);
      throw new ContractFailure("performance " + mode + " exited " + execution.status + ": " + detail);
    }
    assertFrozen();
    let digest;
    try {
      digest = current
        ? currentPerformanceDigest(execution.stdout, jobs, owner)
        : baselinePerformanceDigest(execution.stdout);
    } catch (error) {
      if (!current && error instanceof ContractFailure) {
        performanceStop("baseline_incompatible " + error.message);
      }
      throw error;
    }
    contract(readdirSync(owner.path).length === 0, "performance " + mode + " left temp residue");
    console.log(
      "PERFORMANCE_SAMPLE round=" + round + " slot=" + slot + " mode=" + mode
        + " wallMs=" + execution.wallMs.toFixed(1)
        + " cpuMs=" + (execution.userMs + execution.systemMs).toFixed(1)
        + " cpuUtilization=" + execution.cpuUtilization.toFixed(3)
        + " idleBefore=" + idle.idleFraction.toFixed(3)
        + " load1Before=" + idle.oneMinuteLoad.toFixed(2)
        + " externalBusy=" + execution.externalBusyFraction.toFixed(3)
        + " competitorsBefore=" + json(idle.competingPids)
        + " competitorsDuring=" + json(execution.competingPids)
        + " digest=" + digest,
    );
    return { mode, digest, idle, ...execution };
  } finally {
    if (scope.trees.size === 0) {
      cleanupHarnessOwnedBase(owner, "performance sample " + mode);
      contract(!existsSync(owner.path), "performance sample cleanup left its owned base");
      scope.untrackOwner(owner);
    }
  }
}

export function median(values) {
  const ordered = [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return ordered[Math.floor(ordered.length / 2)];
}

export function performancePreflightIsolationContract() {
  const source = ts.createSourceFile(
    harnessRelativePath,
    readFileSync(fileURLToPath(import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const declaration = source.statements.find((statement) => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === "performanceContract"
  ));
  contract(Boolean(declaration?.body), "performanceContract source body is absent");
  const buildRoots = [];
  let verifiesCurrentBinding = false;
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "buildPerformanceTarget") {
        buildRoots.push(node.arguments[0]?.getText(source) ?? "");
      }
      if (node.expression.text === "performanceMaterialIdentity"
        && node.arguments[0]?.getText(source) === "currentRoot") verifiesCurrentBinding = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.body);
  contract(
    json(buildRoots) === json(["currentRoot", "baselineRoot"]),
    "performance preflight must build only the two isolated benchmark checkouts: " + json(buildRoots),
  );
  contract(verifiesCurrentBinding, "performance preflight omitted the isolated candidate build binding");
  console.log("PERFORMANCE_ISOLATION_PASS build_roots=temp_only candidate=isolated");
}

export function performanceHostAccountingContract() {
  const supervisor = runSupervisedPerformanceProcess.toString();
  const idleGuard = assertIdlePerformanceHost.toString();
  const timedRunner = runTimedPerformanceProcess.toString();
  contract(
    !/highCpuCounts|cpuPercent\s*<\s*50/.test(supervisor),
    "performance supervisor still rejects a single short per-process CPU burst",
  );
  contract(
    /externalBusyFraction/.test(supervisor),
    "performance supervisor omitted aggregate external-busy telemetry",
  );
  contract(
    !/idleFraction\s*>=/.test(idleGuard) && !/oneMinuteLoad\s*<=/.test(idleGuard),
    "performance preflight adds a host-wide threshold not present in the frozen intent",
  );
  contract(
    /competingPerformanceProcesses/.test(supervisor),
    "performance supervisor omitted named build/validation competitor telemetry",
  );
  contract(
    !/performanceStop/.test(idleGuard) && !/PerformanceContamination/.test(supervisor),
    "performance evidence still blocks on a host condition absent from the frozen intent",
  );
  contract(
    /timeoutMs:\s*45\s*\*\s*60_000/.test(timedRunner),
    "performance sample timeout regressed below the observed busy-host envelope",
  );
  console.log("PERFORMANCE_ACCOUNTING_PASS named_competitors=telemetry host_metrics=telemetry");
}

export async function collectPerformanceSamples(latinSquare, runSample, maxDiscards = 3) {
  contract(
    Number.isSafeInteger(maxDiscards) && maxDiscards >= 0 && maxDiscards <= 3,
    "performance contamination discard budget must be from 0 through 3",
  );
  const samples = [];
  let discarded = 0;
  for (let round = 0; round < latinSquare.length; round += 1) {
    for (let slot = 0; slot < latinSquare[round].length; slot += 1) {
      const mode = latinSquare[round][slot];
      while (true) {
        try {
          samples.push(await runSample(mode, round + 1, slot + 1, discarded + 1));
          break;
        } catch (error) {
          if (!(error instanceof PerformanceContamination)) throw error;
          discarded += 1;
          console.log(
            "PERFORMANCE_DISCARD round=" + (round + 1) + " slot=" + (slot + 1)
              + " mode=" + mode + " discarded=" + discarded + "/" + maxDiscards
              + " reason=" + error.message,
          );
          if (discarded > maxDiscards) {
            performanceStop(
              "contamination_retry_exhausted discarded=" + discarded
                + " max=" + maxDiscards + " last=" + error.message,
            );
          }
        }
      }
    }
  }
  return samples;
}

export function performanceIdleWaitContract() {
  const idleGuard = assertIdlePerformanceHost.toString();
  contract(
    !/PROOF_OR_STOP_IDLE_TIMEOUT_MS/.test(idleGuard),
    "performance preflight still exposes a host-wide idle wait budget",
  );
  contract(
    !/while\s*\(true\)/.test(idleGuard),
    "performance preflight still loops waiting for an unrelated host-wide threshold",
  );
  contract(
    /competingPerformanceProcesses/.test(idleGuard),
    "performance preflight stopped recording directly competing benchmark tasks",
  );
  console.log("PERFORMANCE_IDLE_WAIT_PASS wait=removed competitors=telemetry");
}

export function performanceIdleBudgetContract() {
  const idleGuard = assertIdlePerformanceHost.toString();
  contract(
    !/timeoutMs/.test(idleGuard) && !/idle_wait_timeout/.test(idleGuard),
    "performance preflight still turns host utilization into a multi-hour acceptance gate",
  );
  console.log("PERFORMANCE_IDLE_BUDGET_PASS wait_budget=none scope=intent_only");
}

export function performancePreflightIdleContract() {
  const source = performanceContract.toString();
  const idleIndex = source.indexOf('await assertIdlePerformanceHost("baseline build")');
  const buildIndex = source.indexOf("await buildPerformanceTarget(baselineRoot");
  contract(
    idleIndex >= 0 && buildIndex >= 0 && idleIndex < buildIndex,
    "performance baseline build starts before the bounded idle-host guard",
  );
  console.log("PERFORMANCE_PREFLIGHT_IDLE_PASS build=guarded");
}

export async function performanceContaminationRetryContract() {
  contract(
    typeof collectPerformanceSamples === "function",
    "performance protocol has no accepted-sample collector",
  );
  let calls = 0;
  const samples = await collectPerformanceSamples(
    [["baseline", "jobs1"]],
    async (mode) => {
      calls += 1;
      if (calls === 1) throw new PerformanceContamination("synthetic host activity");
      return { mode, accepted: true };
    },
    1,
  );
  contract(
    calls === 3 && samples.length === 2
      && samples.every((sample) => sample.accepted === true),
    "performance protocol did not replace the contaminated sample exactly once",
  );
  console.log("PERFORMANCE_RETRY_PASS accepted=2 discarded=1 budget=1");
}

export async function performanceCurrentJobsContract(jobs) {
  assertPerformanceSourceCapability();
  const { env } = measurementEnvironment();
  const before = gitStatus();
  contract(before === "", "focused current-performance contract requires a clean checkout");
  const candidateHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot, encoding: "utf8",
  }).trim();
  const scope = createPerformanceCleanupScope();
  let lease = null;
  try {
    lease = acquirePerformanceLease();
    scope.setLease(lease);
    const assertFrozen = () => contract(
      gitStatus() === before
        && execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim()
          === candidateHead,
      "focused current-performance material changed during execution",
    );
    const sample = await performanceSample(
      jobs === 2 ? "jobs2" : "jobs1", repoRoot, repoRoot, env, 1, 1, assertFrozen, scope,
    );
    console.log(
      "PERFORMANCE_CURRENT_PASS jobs=" + jobs + " cases=73 residue=0 wallMs="
        + sample.wallMs.toFixed(1),
    );
  } finally {
    const cleanupErrors = [];
    if (scope.trees.size > 0) {
      try {
        const result = await scope.reapTrees();
        if (result.survivors > 0 || result.errors.length > 0) {
          cleanupErrors.push("process cleanup survivors=" + result.survivors
            + " errors=" + json(result.errors));
        }
      } catch (error) { cleanupErrors.push("process cleanup: " + error.message); }
    }
    if (scope.trees.size === 0) {
      for (const owner of [...scope.owners]) {
        try {
          if (existsSync(owner.path)) cleanupHarnessOwnedBase(owner, "focused performance cleanup");
          scope.untrackOwner(owner);
        } catch (error) { cleanupErrors.push("temp cleanup: " + error.message); }
      }
    }
    if (lease) {
      try { releasePerformanceLease(lease); }
      catch (error) { cleanupErrors.push("lease cleanup: " + error.message); }
      scope.clearLease(lease);
    }
    try { scope.close(); } catch (error) { cleanupErrors.push(error.message); }
    if (cleanupErrors.length > 0) {
      throw new ContractFailure("focused performance cleanup failed: " + cleanupErrors.join("; "));
    }
  }
}

export async function performanceContract() {
  assertPerformanceSourceCapability();
  const { env, removedOfficialTracer } = measurementEnvironment();
  const before = gitStatus();
  contract(before === "", "performance protocol requires a clean current checkout");
  const candidateHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot, encoding: "utf8",
  }).trim();
  const scope = createPerformanceCleanupScope();
  let lease = null;
  let checkoutOwner = null;
  let currentRoot = null;
  let baselineRoot = null;
  let currentDependencyRoot = null;
  let baselineDependencyRoot = null;
  let frozenDependencyTreeDigest = null;
  let successSummary = null;
  try {
    lease = acquirePerformanceLease();
    scope.setLease(lease);
    // The candidate dist is already bound to its exact source by the signed build
    // manifest checked below. Rebuilding it here would write inside a checkout
    // managed by FileProvider on some hosts and make the benchmark contaminate
    // its own host-idle witness. Keep candidate material read-only; only build
    // the synthetic baseline in its isolated temporary checkout.
    contract(gitStatus() === before, "candidate checkout changed before isolated setup");
    contract(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim() === candidateHead,
      "candidate HEAD changed during isolated setup",
    );
    const worker = await loadWorkerContract("performance-contract");
    contract(
      json(worker.QUORUM_SMOKE_PARALLEL_CAPABILITY) === json(PERFORMANCE_CAPABILITY),
      "parallel performance capability is not ready for the nine-run protocol; expected="
        + json(PERFORMANCE_CAPABILITY),
    );
    checkoutOwner = createHarnessOwnedBase("b-e40f-performance-checkout-");
    scope.trackOwner(checkoutOwner);
    const current = preparePerformanceCheckout(checkoutOwner, "current", candidateHead);
    currentRoot = current.checkout;
    currentDependencyRoot = current.dependencyRoot;
    const baseline = prepareBaselineCheckout(checkoutOwner, candidateHead);
    baselineRoot = baseline.checkout;
    baselineDependencyRoot = baseline.dependencyRoot;
    await assertIdlePerformanceHost("baseline build");
    await buildPerformanceTarget(currentRoot, "current", env, scope);
    await buildPerformanceTarget(baselineRoot, "baseline", env, scope);
    const fixedSmokeBlob = execFileSync("git", [
      "rev-parse", ORIGINAL_SMOKE_COMMIT + ":packages/main/src/tasks/quorum-submit-smoke.ts",
    ], { cwd: repoRoot, encoding: "utf8" }).trim();
    contract(
      baseline.parent === candidateHead
        && baseline.originalBlob === fixedSmokeBlob
        && json(baseline.changed) === json(["packages/main/src/tasks/quorum-submit-smoke.ts"]),
      "controlled source baseline lost its candidate-parent/single-blob binding",
    );
    const toolchainMaterial = performanceToolchainIdentity(currentDependencyRoot);
    const toolchain = {
      ...toolchainMaterial,
      git: execFileSync("git", ["--version"], { encoding: "utf8" }).trim(),
      platform: process.platform,
      arch: process.arch,
      cpuModel: cpus()[0]?.model ?? "unknown",
      logicalCpus: cpus().length,
      validationTracerRemoved: removedOfficialTracer,
    };
    const binding = await import(pathToFileURL(join(repoRoot, "scripts/full-suite-build-binding.mjs")).href
      + "?b-e40f-performance=" + Date.now());
    const currentIdentity = performanceMaterialIdentity(currentRoot, binding, currentDependencyRoot);
    const baselineIdentity = performanceMaterialIdentity(baselineRoot, binding, baselineDependencyRoot);
    const currentDependencyTreeDigest = treeContentDigest(currentDependencyRoot, "current dependency tree");
    const baselineDependencyTreeDigest = treeContentDigest(baselineDependencyRoot, "baseline dependency tree");
    contract(
      currentDependencyTreeDigest === baselineDependencyTreeDigest,
      "copy-on-write baseline dependency bytes differ from the candidate install",
    );
    frozenDependencyTreeDigest = currentDependencyTreeDigest;
    contract(currentIdentity.head === candidateHead, "current candidate moved after preflight");
    contract(baselineIdentity.head === baseline.syntheticHead, "baseline material moved from its synthetic commit");
    contract(currentIdentity.status === "" && baselineIdentity.status === "", "a built benchmark checkout is dirty");
    const sharedMaterialFields = [
      "buildScriptDigest", "buildLockDigest", "packageDigest", "tsconfigDigest",
      "rootPackageLockDigest", "mainPackageLockDigest", "dependencySentinelDigest",
    ];
    contract(
      sharedMaterialFields.every((field) => currentIdentity[field] === baselineIdentity[field]),
      "baseline/current build scripts, locks, packages, config, or CoW dependencies differ",
    );
    contract(
      String(readJsonTarget(join(baselineDependencyRoot, "typescript/package.json"), "baseline TypeScript").version)
        === toolchain.typescript
        && fileDigest(realpathSync(join(baselineDependencyRoot, "typescript/bin/tsc")))
          === toolchain.typescriptExecutableDigest,
      "baseline/current TypeScript toolchains differ",
    );
    const assertFrozen = () => assertPerformanceMaterialFrozen(
      binding,
      currentIdentity,
      baselineIdentity,
      currentRoot,
      baselineRoot,
      currentDependencyRoot,
      baselineDependencyRoot,
      toolchain,
    );
    console.log("PERFORMANCE_PREFLIGHT " + json({
      sourceBaselineCommit: ORIGINAL_SMOKE_COMMIT,
      candidateHead,
      syntheticBaselineHead: baseline.syntheticHead,
      fixedSmokeBlob,
      checkout: "git-shared-objects-cow-v1",
      toolchain,
      currentBuild: {
        sourceDigest: currentIdentity.sourceDigest,
        distDigest: currentIdentity.distDigest,
        buildScriptDigest: currentIdentity.buildScriptDigest,
        buildLockDigest: currentIdentity.buildLockDigest,
      },
      baselineBuild: {
        sourceDigest: baselineIdentity.sourceDigest,
        distDigest: baselineIdentity.distDigest,
        buildScriptDigest: baselineIdentity.buildScriptDigest,
        buildLockDigest: baselineIdentity.buildLockDigest,
      },
      dependencyTreeDigest: frozenDependencyTreeDigest,
    }));
    const latinSquare = [
      ["baseline", "jobs1", "jobs2"],
      ["jobs1", "jobs2", "baseline"],
      ["jobs2", "baseline", "jobs1"],
    ];
    const samples = await collectPerformanceSamples(
      latinSquare,
      (mode, round, slot) => performanceSample(
        mode, currentRoot, baselineRoot, env, round, slot, assertFrozen, scope,
      ),
    );
    const digests = new Set(samples.map((row) => row.digest));
    contract(digests.size === 1, "baseline/jobs1/jobs2 verdict digests diverged");
    const medianNs = Object.fromEntries(["baseline", "jobs1", "jobs2"].map((mode) => [
      mode, median(samples.filter((row) => row.mode === mode).map((row) => row.wallNs)),
    ]));
    const medians = Object.fromEntries(Object.entries(medianNs).map(([mode, value]) => [mode, Number(value) / 1e6]));
    const baselineGain = Number(medianNs.baseline - medianNs.jobs2) / Number(medianNs.baseline);
    const serialGain = Number(medianNs.jobs1 - medianNs.jobs2) / Number(medianNs.jobs1);
    console.log("PERFORMANCE_MEDIANS " + json({ ...medians, baselineGain, serialGain, toolchain }));
    if (medianNs.jobs2 * 100n > medianNs.baseline * 80n
      || medianNs.jobs2 * 100n > medianNs.jobs1 * 85n) performanceStop("threshold_not_met");
    successSummary = "PERFORMANCE_PASS baseline_gain>=20% serial_gain>=15%"
      + " baselineMedianMs=" + medians.baseline.toFixed(1)
      + " jobs1MedianMs=" + medians.jobs1.toFixed(1)
      + " jobs2MedianMs=" + medians.jobs2.toFixed(1);
  } finally {
    const cleanupErrors = [];
    if (scope.trees.size > 0) {
      try {
        const result = await scope.reapTrees();
        if (result.survivors > 0 || result.errors.length > 0) {
          cleanupErrors.push("process cleanup survivors=" + result.survivors + " errors=" + json(result.errors));
        }
      } catch (error) { cleanupErrors.push("process cleanup: " + error.message); }
    }
    try {
      contract(gitStatus() === before, "performance protocol changed the current checkout");
    } catch (error) { cleanupErrors.push(error.message); }
    for (const [root, label] of [[currentRoot, "current"], [baselineRoot, "baseline"]]) {
      if (root !== null && existsSync(root)) {
        try {
          contract(
            execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
              cwd: root, encoding: "utf8",
            }) === "",
            "performance protocol changed the controlled " + label + " checkout",
          );
        } catch (error) { cleanupErrors.push(error.message); }
      }
    }
    if (frozenDependencyTreeDigest !== null && baselineDependencyRoot !== null) {
      try {
        contract(
          treeContentDigest(currentDependencyRoot, "final current dependency tree")
              === frozenDependencyTreeDigest
            && treeContentDigest(baselineDependencyRoot, "final baseline dependency tree")
              === frozenDependencyTreeDigest,
          "dependency tree bytes changed during performance sampling",
        );
      } catch (error) { cleanupErrors.push(error.message); }
    }
    if (scope.trees.size === 0) {
      for (const owner of [...scope.owners]) {
        try {
          if (existsSync(owner.path)) cleanupHarnessOwnedBase(owner, "performance final cleanup");
          contract(!existsSync(owner.path), "performance final cleanup left an owned base");
          scope.untrackOwner(owner);
        } catch (error) { cleanupErrors.push("temp cleanup: " + error.message); }
      }
    } else {
      cleanupErrors.push("refusing temp cleanup while a benchmark process remains live");
    }
    if (lease) {
      const activeLease = lease;
      const retainForSurvivor = scope.trees.size > 0;
      try {
        if (retainForSurvivor) {
          retainPerformanceLease(activeLease);
          cleanupErrors.push("performance lease retained because a descendant survived: " + activeLease.path);
        } else {
          releasePerformanceLease(activeLease);
        }
      } catch (error) { cleanupErrors.push("lease cleanup: " + error.message); }
      scope.clearLease(activeLease);
      lease = null;
    }
    try { scope.close(); } catch (error) { cleanupErrors.push(error.message); }
    if (cleanupErrors.length > 0) {
      throw new ContractFailure("performance cleanup failed: " + cleanupErrors.join("; "));
    }
  }
  console.log(successSummary);
}
