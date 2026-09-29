
import { createHash, randomUUID } from "node:crypto";

import { lstatSync, readFileSync, realpathSync, readdirSync } from "node:fs";


import { isAbsolute, join, resolve, sep } from "node:path";

import ts from "typescript";
import { manifestRows } from "./coordinator-wiring.mjs";
import { readJsonTarget } from "./selection.mjs";
import { manifestPath, validationRuntimeTracerPath, EXPECTED_CASES, repoRoot } from "./support.mjs";
import { createHarnessOwnedBase, createHarnessOwnedFile, contract, json, assertOwnedPath, cleanupHarnessOwnedBase, strictOwnedDescendant, ContractFailure, assertOwnedPathAbsent } from "./owned-files.mjs";
import { hasTrustedRuntimeTracer, businessEnvironmentKeys } from "./environment-closure.mjs";
import { runPositiveRealCli, assertReportResidue, parseOwnedJsonLines, parseRunReport } from "./selection-contracts.mjs";
import { assertTimelineOverlap, containedBy, resultCaseId } from "./worker-coordination.mjs";
import { smoke } from "./callback-inventory.mjs";

export async function runTracedFullAggregate(jobs) {
  const inventory = manifestRows(readJsonTarget(manifestPath, "resource aggregate inventory"));
  const shardIds = [...new Set(inventory.map((row) => row.shard))].sort();
  const sentinelIds = inventory.filter((row) => row.sentinel === "real").map((row) => row.id);
  const traceOwner = createHarnessOwnedBase("b-e40f-resource-trace-j" + jobs + "-");
  const ownedTempOwner = createHarnessOwnedBase("b-e40f-resource-owned-j" + jobs + "-");
  const traceFile = createHarnessOwnedFile(traceOwner, "resource-trace.jsonl", "resource jobs=" + jobs);
  const runtimeTraceFile = jobs === 2
    ? createHarnessOwnedFile(traceOwner, "runtime-trace.json", "configured quorum runtime trace")
    : null;
  try {
    const trustedTracer = realpathSync(validationRuntimeTracerPath);
    const inheritedNodeOptions = process.env.NODE_OPTIONS ?? "";
    const tracedNodeOptions = hasTrustedRuntimeTracer(inheritedNodeOptions, trustedTracer)
      ? inheritedNodeOptions
      : `${inheritedNodeOptions} --require=${trustedTracer}`.trim();
    const run = await runPositiveRealCli(
      ["--jobs=" + jobs, "--report=json"],
      EXPECTED_CASES.map((row) => row.id),
      "real full aggregate jobs=" + jobs,
      {
        timeoutMs: 30 * 60_000,
        expectedSentinels: sentinelIds,
        env: {
          PROOF_OR_STOP_QUORUM_SMOKE_RESOURCE_TRACE_FILE: traceFile.realpath,
          PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE: ownedTempOwner.realpath,
          ...(runtimeTraceFile ? {
            NODE_OPTIONS: tracedNodeOptions,
            PROOF_OR_STOP_RUNTIME_TRACE_FILE: runtimeTraceFile.realpath,
          } : {}),
        },
      },
    );
    const { report, callbackNonce } = run;
    contract(
      report.mode === "aggregate" && report.coordinator === "default-parent",
      "jobs=" + jobs + " did not execute the default parent aggregate",
    );
    contract(
      Array.isArray(report.shards)
        && json(report.shards.map((row) => row.shardId).sort()) === json(shardIds),
      "jobs=" + jobs + " default parent did not consume every actual shard",
    );
    for (const shardReport of report.shards) {
      const expectedShardIds = inventory
        .filter((row) => row.shard === shardReport.shardId)
        .map((row) => row.id)
        .sort();
      const expectedShardSentinels = inventory
        .filter((row) => row.shard === shardReport.shardId && row.sentinel === "real")
        .map((row) => row.id)
        .sort();
      contract(
        Number.isInteger(shardReport.workerPid)
          && shardReport.workerPid > 0
          && shardReport.workerPid !== report.parentPid
          && shardReport.status === "PASS"
          && Number(shardReport.attempts) === 1
          && Array.isArray(shardReport.caseIds)
          && json([...shardReport.caseIds].sort()) === json(expectedShardIds)
          && Array.isArray(shardReport.sentinelCaseIds)
          && json([...shardReport.sentinelCaseIds].sort()) === json(expectedShardSentinels),
        "default parent shard report is not exact: " + json(shardReport),
      );
      assertReportResidue(shardReport, "default parent shard " + shardReport.shardId);
    }
    contract(report.jobs === jobs, "default parent ignored requested jobs=" + jobs);
    assertTimelineOverlap(report, run.callbackTrace, jobs, "real full aggregate jobs=" + jobs);
    const resourceTrace = parseOwnedJsonLines(traceFile, "resource jobs=" + jobs);
    const runtimeEnvironmentKeys = new Set();
    const runtimeTracePids = new Set();
    let runtimeTraceProcessCount = 0;
    if (runtimeTraceFile) {
      const prefix = runtimeTraceFile.path.slice(runtimeTraceFile.path.lastIndexOf(sep) + 1) + ".";
      for (const name of readdirSync(traceOwner.path).filter((name) => (
        name.startsWith(prefix) && name.endsWith(".json")
      ))) {
        const path = join(traceOwner.realpath, name);
        assertOwnedPath(traceOwner, path, "configured quorum runtime trace fragment", {
          mustExist: true,
          directory: false,
        });
        const fragment = JSON.parse(readFileSync(path, "utf8"));
        const filenamePid = Number(name.slice(prefix.length).split(".", 1)[0]);
        contract(
          fragment.traceRoot === "runtime-trace.json"
            && Number.isSafeInteger(fragment.pid) && fragment.pid > 1
            && filenamePid === fragment.pid && !runtimeTracePids.has(fragment.pid)
            && Array.isArray(fragment.environmentKeys),
          "configured quorum runtime trace fragment lost its process/root binding",
        );
        runtimeTracePids.add(fragment.pid);
        runtimeTraceProcessCount += 1;
        for (const key of fragment.environmentKeys) {
          contract(typeof key === "string" && key.length > 0, "runtime trace emitted an invalid env key");
          runtimeEnvironmentKeys.add(key);
        }
      }
    }
    return {
      ...run,
      accesses: resourceTrace.rows,
      resourceTraceRaw: resourceTrace.raw,
      traceOwner,
      ownedTempOwner,
      traceFile,
      callbackNonce,
      runtimeTraceProcessCount,
      runtimeTracePids: [...runtimeTracePids].sort((left, right) => left - right),
      runtimeEnvironmentKeys: [...runtimeEnvironmentKeys].sort(),
    };
  } catch (error) {
    try {
      cleanupHarnessOwnedBase(ownedTempOwner, "failed resource owned temp base jobs=" + jobs);
    } finally {
      cleanupHarnessOwnedBase(traceOwner, "failed resource trace base jobs=" + jobs);
    }
    throw error;
  }
}

export function assertConfiguredOfficialEnvironmentClosure(run, quorumRow) {
  contract(
    run.report.jobs === 2 && run.report.mode === "aggregate"
      && run.report.results?.length === EXPECTED_CASES.length,
    "environment closure did not use the configured jobs=2 full 73-case quorum row",
  );
  contract(
    run.runtimeTraceProcessCount >= 5 && run.runtimeEnvironmentKeys.length > 0,
    "configured full quorum run emitted no complete official process trace",
  );
  const tracedPids = new Set(run.runtimeTracePids);
  const authenticatedPids = [run.report.parentPid, ...run.report.shards.map((shard) => shard.workerPid)];
  contract(
    authenticatedPids.every((pid) => Number.isSafeInteger(pid) && tracedPids.has(pid)),
    "configured full quorum trace omitted an authenticated parent/shard process",
  );
  const declared = new Set(quorumRow.declaredEnvironmentKeys ?? []);
  const undeclared = businessEnvironmentKeys(run.runtimeEnvironmentKeys)
    .filter((key) => !declared.has(key));
  contract(
    undeclared.length === 0,
    "configured 73-case official trace observed undeclared environment keys: " + undeclared.join(","),
  );
}

export function assertRealResourceTrace(run, label) {
  const repoResolved = resolve(repoRoot);
  const repoRealpath = realpathSync(repoRoot);
  const owned = run.report.ownedTempRoots;
  contract(Array.isArray(owned) && owned.length > 0, label + " omitted ownedTempRoots");
  contract(
    run.report.ownedTempBase === run.ownedTempOwner.realpath,
    label + " did not bind its owned roots to the harness-provided temp base",
  );
  const ownedNormalized = owned.map((root, index) => assertOwnedPath(
    run.ownedTempOwner,
    root,
    label + " owned temp root " + index,
    { mustExist: false, directory: true },
  ).normalized);
  for (let left = 0; left < ownedNormalized.length; left += 1) {
    for (let right = left + 1; right < ownedNormalized.length; right += 1) {
      contract(
        !containedBy(ownedNormalized[left], ownedNormalized[right])
          && !containedBy(ownedNormalized[right], ownedNormalized[left]),
        label + " reports overlapping worker-owned roots",
      );
    }
  }
  contract(run.accesses.length > 0, label + " emitted no runtime resource accesses");
  let repoReadCount = 0;
  let fixtureWriteCount = 0;
  for (const access of run.accesses) {
    const callbackStart = run.callbackTrace.rows.find(
      (event) => event.caseId === access.caseId && event.phase === "start",
    );
    const callbackEnd = run.callbackTrace.rows.find(
      (event) => event.caseId === access.caseId && event.phase === "end",
    );
    contract(
      access.schema === "proof-or-stop.quorum-smoke-resource-trace.v1"
        && access.nonce === run.callbackNonce
        && access.runId === run.report.runId
        && Number.isFinite(Number(access.atMs))
        && access.pid === callbackStart?.pid
        && Number(callbackStart?.atMs) <= Number(access.atMs)
        && Number(access.atMs) <= Number(callbackEnd?.atMs),
      label + " resource access is not nonce/runId/callback bound: " + json(access),
    );
    contract(access.op === "read" || access.op === "write", label + " trace has invalid op: " + json(access));
    contract(
      typeof access.path === "string"
        && isAbsolute(access.path)
        && !access.path.split(/[\\/]+/).includes(".."),
      label + " trace has an unsafe or unresolved path: " + json(access),
    );
    const normalized = resolve(access.path);
    const lexicalRepo = containedBy(repoResolved, normalized) || containedBy(repoRealpath, normalized);
    const lexicalOwned = strictOwnedDescendant(run.ownedTempOwner, normalized);
    contract(lexicalRepo || lexicalOwned, label + " accessed a path outside repo and owned temp: " + access.path);
    if (lexicalRepo) {
      let entry = null;
      try {
        entry = lstatSync(access.path);
      } catch (error) {
        throw new ContractFailure(label + " traced missing repository read path: " + error.message);
      }
      contract(Boolean(entry), label + " traced no repository entry");
      const canonical = realpathSync(access.path);
      contract(containedBy(repoRealpath, canonical), label + " repository path realpath escaped: " + canonical);
      contract(access.op === "read", label + " wrote inside the repository: " + access.path);
      repoReadCount += 1;
    } else {
      assertOwnedPath(run.ownedTempOwner, access.path, label + " owned resource access", {
        mustExist: false,
        directory: false,
      });
      contract(
        ownedNormalized.some((root) => containedBy(root, normalized)),
        label + " wrote outside all owned temp roots: " + access.path,
      );
      if (access.op === "write" && (access.resource === "fixture" || access.kind === "fixture")) {
        fixtureWriteCount += 1;
      }
    }
  }
  contract(repoReadCount > 0, label + " did not trace its real repository reads");
  contract(fixtureWriteCount > 0, label + " did not trace real fixture writes");
  for (const root of ownedNormalized) {
    assertOwnedPathAbsent(run.ownedTempOwner, root, label + " cleaned worker-owned root");
  }
  contract(
    readdirSync(run.ownedTempOwner.path).length === 0,
    label + " left unreported residue inside the harness-owned temp base",
  );
}

export function resourceTraceEnvelope(run, overrides = {}) {
  return {
    nonce: run.callbackNonce,
    runId: run.report.runId,
    ownedTempBase: run.ownedTempOwner.realpath,
    ownedTempRoots: run.report.ownedTempRoots,
    accesses: run.accesses,
    raw: run.resourceTraceRaw,
    ...overrides,
  };
}

export function resourceTraceProof(run) {
  return {
    expectedCaseIds: EXPECTED_CASES.map((row) => row.id),
    callbackEvents: run.callbackTrace.rows,
    callbackTraceRaw: run.callbackTrace.raw,
    report: run.report,
  };
}

export function cleanupResourceRun(run, label) {
  if (!run) return;
  try {
    cleanupHarnessOwnedBase(run.ownedTempOwner, label + " owned temp base");
  } finally {
    cleanupHarnessOwnedBase(run.traceOwner, label + " resource trace base");
  }
}

export function parseNegativeRun(execution, label, callbackNonce, expectedStatus) {
  contract(execution.processGroupReaped, label + " did not reap the CLI process group");
  contract(
    execution.orphanedDescendants === false,
    label + " left descendants; harness cleanup cannot turn this into GREEN",
  );
  contract(!execution.timedOut, label + " exceeded the harness timeout");
  contract(execution.status !== 0, label + " returned a positive process status");
  const report = parseRunReport(execution.output, label);
  contract(
    report.schema === "proof-or-stop.quorum-smoke-run.v1"
      && typeof report.runId === "string"
      && report.runId.length > 0
      && report.ok === false
      && report.status === expectedStatus
      && report.parentPid === execution.pid
      && report.callbackTraceNonce === callbackNonce
      && report.processTreeReaped === true
      && report.orphanedDescendants === false
      && Array.isArray(report.results),
    label + " omitted the versioned negative run/process-tree/nonce contract",
  );
  contract(
    report.mode === "fault-probe" && report.coordinator === "default-parent",
    label + " bypassed the real parent coordinator",
  );
  contract(
    report.maxConcurrent === 2 && report.shards.length >= 2 && report.results.length > 1,
    label + " did not exercise aggregate overlap and concurrent cancellation",
  );
  const cancelledSibling = report.shards.find((row) => (
    row.shardId !== "pure" && row.status !== "PASS"
  ));
  contract(
    cancelledSibling?.processTreeReaped === true
      && cancelledSibling?.orphanedDescendants === false
      && Object.values(cancelledSibling?.residue ?? {}).every((value) => value === 0),
    label + " did not independently reap and clean the concurrently cancelled shard",
  );
  assertReportResidue(report, label);
  return report;
}

export async function runNegativeRealCli(args, label, expectedStatus) {
  const owner = createHarnessOwnedBase("b-e40f-negative-callback-");
  const ownedTempOwner = createHarnessOwnedBase("b-e40f-negative-owned-");
  const traceFile = createHarnessOwnedFile(owner, "callbacks.jsonl", label + " callback");
  const nonce = randomUUID();
  try {
    const execution = await smoke(args, 30_000, {
      env: {
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_FILE: traceFile.realpath,
        PROOF_OR_STOP_QUORUM_SMOKE_CALLBACK_TRACE_NONCE: nonce,
        PROOF_OR_STOP_QUORUM_SMOKE_OWNED_TEMP_BASE: ownedTempOwner.realpath,
      },
    });
    const report = parseNegativeRun(execution, label, nonce, expectedStatus);
    const trace = parseOwnedJsonLines(traceFile, label + " callback");
    const result = report.results.find((row) => resultCaseId(row) === "qsm-002");
    const starts = trace.rows.filter((row) => row.caseId === "qsm-002" && row.phase === "start");
    const ends = trace.rows.filter((row) => row.caseId === "qsm-002" && row.phase === "end");
    contract(
      report.callbackTraceDigest === createHash("sha256").update(trace.raw).digest("hex")
        && report.results.length > 1
        && result?.status === expectedStatus
        && Number(result?.attempts) === 1
        && starts.length === 1
        && ends.length === 1
        && trace.rows.every((row) => (
          row.schema === "proof-or-stop.quorum-smoke-callback-trace.v1"
            && row.nonce === nonce
            && row.runId === report.runId
        ))
        && trace.rows.indexOf(starts[0]) < trace.rows.indexOf(ends[0])
        && Number(result.startedAtMs) <= Number(starts[0].atMs)
        && Number(starts[0].atMs) <= Number(ends[0].atMs)
        && Number(ends[0].atMs) <= Number(result.endedAtMs)
        && ends[0].status === expectedStatus
        && !execution.output.includes("CASE_PASS qsm-002"),
      label + " callback trace is not bound to its negative report",
    );
    contract(
      report.ownedTempBase === ownedTempOwner.realpath && Array.isArray(report.ownedTempRoots),
      label + " did not bind fault cleanup to the harness-owned temp base",
    );
    for (const root of report.ownedTempRoots) {
      const normalized = assertOwnedPath(ownedTempOwner, root, label + " fault owned root", {
        mustExist: false,
        directory: true,
      }).normalized;
      assertOwnedPathAbsent(ownedTempOwner, normalized, label + " cleaned fault root");
    }
    contract(readdirSync(ownedTempOwner.path).length === 0, label + " left fault-injection residue");
    return report;
  } finally {
    try {
      cleanupHarnessOwnedBase(ownedTempOwner, label + " owned temp base");
    } finally {
      cleanupHarnessOwnedBase(owner, label + " callback trace base");
    }
  }
}

export async function proveRealCoordinatorFaultSeam() {
  const failed = await runNegativeRealCli([
      "--jobs=2",
      "--report=json",
      "--coordinator-fault=fail:qsm-002",
    ],
    "real parent injected FAIL",
    "FAIL",
  );
  const failedRow = failed.results.find((row) => resultCaseId(row) === "qsm-002");
  contract(failedRow?.status === "FAIL", "real parent did not preserve injected child FAIL");
  contract(Number(failedRow.attempts) === 1, "real parent retried injected child FAIL");
  contract(Number(failed.retryCount) === 0, "real parent reports retry after child FAIL");

  const timedOut = await runNegativeRealCli([
      "--jobs=2",
      "--report=json",
      "--case-timeout-ms=300",
      "--coordinator-fault=timeout:qsm-002",
    ],
    "real parent injected TIMEOUT",
    "TIMEOUT",
  );
  const timeoutRow = timedOut.results.find((row) => resultCaseId(row) === "qsm-002");
  contract(timeoutRow?.status === "TIMEOUT", "real parent did not preserve injected child TIMEOUT");
  contract(Number(timeoutRow.attempts) === 1, "real parent retried injected child TIMEOUT");
  contract(Number(timedOut.retryCount) === 0, "real parent reports retry after child TIMEOUT");
  contract(
    timedOut.processTreeReaped === true,
    "real parent did not prove the timed-out worker process tree was reaped",
  );
}
