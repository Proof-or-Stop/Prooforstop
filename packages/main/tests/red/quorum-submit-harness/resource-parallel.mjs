
import { createHash } from "node:crypto";




import { join } from "node:path";

import ts from "typescript";
import { readJsonTarget } from "./selection.mjs";
import { configPath, repoRoot, EXPECTED_CASES } from "./support.mjs";
import { contract, json, ContractFailure } from "./owned-files.mjs";
import { canonicalResourceClaims, loadWorkerContract, coordinatorProbeOptions, proveHarnessOwnedBehaviorExecution, resultCaseId } from "./worker-coordination.mjs";
import { exactHeadOuterSupervisorSafetyProven } from "./driver.mjs";
import { proveFixtureAndEnvironmentSourceClosure } from "./fixture-source-closure.mjs";
import { proveCrossPlatformProcessTreeDispatch, proveDetachedDescendantContainment } from "./containment.mjs";
import { proveProtectedMutationGuard, proveProtectedTraceSinkRejection, proveTransactionalTempAllocation } from "./mutation-controls.mjs";
import { proveSiblingWorktreeProtection, proveAmbientGitRoutingIsolation, proveTracedEnvironmentClosureAndDynTemp } from "./environment-closure.mjs";
import { expectRejected } from "./selection-contracts.mjs";
import { gitStatus } from "./callback-inventory.mjs";
import { runTracedFullAggregate, assertConfiguredOfficialEnvironmentClosure, assertRealResourceTrace, resourceTraceEnvelope, resourceTraceProof, proveRealCoordinatorFaultSeam, cleanupResourceRun } from "./resource-traces.mjs";

export async function resourceParallelContract() {
  const config = readJsonTarget(configPath, "resource-parallel-contract config");
  const commands = config?.validate?.commands;
  contract(Array.isArray(commands), "proof-or-stop config has no validate.commands array");
  const quorumRows = commands.filter((command) => (
    command.command === "node"
      && Array.isArray(command.args)
      && command.args.includes("packages/main/dist/tasks/quorum-submit-smoke.js")
  ));
  contract(quorumRows.length === 1, "expected exactly one configured quorum-submit-smoke command");
  const quorumRow = quorumRows[0];
  const expectedClaims = [{ class: "git-common-dir", key: ".", access: "shared" }];
  contract(
    json(canonicalResourceClaims(quorumRow.resources)) === json(expectedClaims),
    "quorum validation resource claim must exactly describe shared repository reads; "
      + "per-worker temporary writes are unique and must not be forged as a shared repo path. actual="
      + json(canonicalResourceClaims(quorumRow.resources)),
  );
  contract(
    quorumRow.args.includes("--jobs=2")
      || quorumRow.env?.PROOF_OR_STOP_QUORUM_SMOKE_JOBS === "2",
    "configured quorum validation must select bounded jobs=2 explicitly",
  );

  const worker = await loadWorkerContract("resource-parallel-contract");
  contract(
    exactHeadOuterSupervisorSafetyProven,
    "resource-parallel isolation did not bind its outer supervisor-safety proof",
  );
  await proveFixtureAndEnvironmentSourceClosure(worker);
  await proveCrossPlatformProcessTreeDispatch(worker);
  await proveDetachedDescendantContainment(worker);
  await proveProtectedMutationGuard(worker);
  await proveProtectedTraceSinkRejection();
  await proveSiblingWorktreeProtection();
  await proveAmbientGitRoutingIsolation();
  await proveTracedEnvironmentClosureAndDynTemp(worker);
  const maxJobs = worker.MAX_QUORUM_SMOKE_JOBS;
  const guardedRegistration = {
    id: "behavior-invalid-bound",
    title: "Harness invalid bound guard",
    domain: "pure",
    shard: "behavior-probe",
    resources: [],
    run: () => { throw new ContractFailure("guarded registration executed before bounds rejection"); },
  };
  for (const invalid of [0, -1, "nope", maxJobs + 1]) {
    await expectRejected(
      () => worker.runQuorumSmokeCoordinator(coordinatorProbeOptions(
        [guardedRegistration], invalid, 1_000, "harness-invalid-jobs",
      )),
      /jobs.*(?:positive|integer|between|maximum|bounded|<=)/i,
      "invalid jobs=" + invalid,
    );
  }
  contract(
    typeof worker.validateQuorumSmokeResourceTrace === "function",
    "worker module must export validateQuorumSmokeResourceTrace",
  );
  await proveTransactionalTempAllocation();
  await expectRejected(
    () => worker.validateQuorumSmokeResourceTrace({
      claims: quorumRow.resources,
      trace: {
        nonce: "forged",
        runId: "forged",
        ownedTempBase: repoRoot,
        ownedTempRoots: [join(repoRoot, "never-created-worker")],
        accesses: [],
      },
      repositoryRoot: repoRoot,
    }),
    /trusted.*(?:expected|callback|report)|proof/i,
    "self-reported resource envelope without trusted execution proof",
  );
  const before = gitStatus();
  await proveHarnessOwnedBehaviorExecution(worker);
  contract(gitStatus() === before, "harness closure coordinator probe changed repository state");
  let serial = null;
  let parallel = null;
  try {
    serial = await runTracedFullAggregate(1);
    parallel = await runTracedFullAggregate(2);
    assertConfiguredOfficialEnvironmentClosure(parallel, quorumRow);
    assertRealResourceTrace(serial, "real jobs=1");
    assertRealResourceTrace(parallel, "real jobs=2");
    const validateTrace = (run) => worker.validateQuorumSmokeResourceTrace({
      claims: quorumRow.resources,
      trace: resourceTraceEnvelope(run),
      repositoryRoot: repoRoot,
      proof: resourceTraceProof(run),
    });
    await validateTrace(serial);
    await validateTrace(parallel);
    await expectRejected(
      () => worker.validateQuorumSmokeResourceTrace({
        claims: quorumRow.resources,
        trace: resourceTraceEnvelope(parallel),
        repositoryRoot: repoRoot,
        proof: {
          ...resourceTraceProof(parallel),
          report: { ...parallel.report, callbackTraceDigest: "0".repeat(64) },
        },
      }),
      /callback.*digest|authentic parent run|proof/i,
      "tampered parent callback-trace digest",
    );
    await expectRejected(
      () => worker.validateQuorumSmokeResourceTrace({
        claims: quorumRow.resources,
        trace: resourceTraceEnvelope(parallel),
        repositoryRoot: repoRoot,
        proof: {
          ...resourceTraceProof(parallel),
          report: {
            ...parallel.report,
            processTreeReaped: false,
            orphanedDescendants: true,
            residue: { temp: 9, process: 9, ticket: 9, quarantine: 9 },
          },
        },
      }),
      /authentic parent run|process|orphan|residue|proof/i,
      "tampered parent cleanup verdict",
    );
    const truncatedAccesses = [...parallel.accesses];
    const removedFixtureIndex = truncatedAccesses.findIndex((access) => (
      access.resource === "fixture" && access.op === "write"
    ));
    contract(removedFixtureIndex >= 0, "resource truncation mutation needs a real fixture write");
    truncatedAccesses.splice(removedFixtureIndex, 1);
    await expectRejected(
      () => worker.validateQuorumSmokeResourceTrace({
        claims: quorumRow.resources,
        trace: resourceTraceEnvelope(parallel, {
          accesses: truncatedAccesses,
          raw: truncatedAccesses.map((row) => json(row)).join("\n") + "\n",
        }),
        repositoryRoot: repoRoot,
        proof: resourceTraceProof(parallel),
      }),
      /resource.*(?:digest|count)|fixture writes|authentic parent run|proof/i,
      "truncated real fixture-write trace",
    );
    const authenticAccess = parallel.accesses.find((access) => access.op === "write")
      ?? parallel.accesses[0];
    const forgedWriteAccesses = [...parallel.accesses, {
      ...authenticAccess,
      op: "write",
      path: configPath,
    }];
    const forgedWriteRaw = forgedWriteAccesses.map((row) => json(row)).join("\n") + "\n";
    await expectRejected(
      () => worker.validateQuorumSmokeResourceTrace({
        claims: quorumRow.resources,
        trace: resourceTraceEnvelope(parallel, {
          accesses: forgedWriteAccesses,
          raw: forgedWriteRaw,
        }),
        repositoryRoot: repoRoot,
        proof: {
          ...resourceTraceProof(parallel),
          report: {
            ...parallel.report,
            resourceTraceDigest: createHash("sha256").update(forgedWriteRaw).digest("hex"),
            resourceTraceCount: forgedWriteAccesses.length,
          },
        },
      }),
      /write.*(?:repo|repository)|repository.*write|outside.*owned/i,
      "forged repository write trace",
    );
    const firstOwned = parallel.report.ownedTempRoots[0];
    const firstIdentity = parallel.report.ownedTempRootIdentities.find((row) => row.path === firstOwned);
    contract(Boolean(firstIdentity), "overlapping-root mutation needs the parent-owned root identity");
    const overlappingRoot = join(firstOwned, "overlap");
    const overlappingRoots = [...parallel.report.ownedTempRoots, overlappingRoot];
    const overlappingIdentities = [
      ...parallel.report.ownedTempRootIdentities,
      { ...firstIdentity, path: overlappingRoot },
    ];
    await expectRejected(
      () => worker.validateQuorumSmokeResourceTrace({
        claims: quorumRow.resources,
        trace: resourceTraceEnvelope(parallel, {
          ownedTempRoots: overlappingRoots,
        }),
        repositoryRoot: repoRoot,
        proof: {
          ...resourceTraceProof(parallel),
          report: {
            ...parallel.report,
            ownedTempRoots: overlappingRoots,
            ownedTempRootIdentities: overlappingIdentities,
          },
        },
      }),
      /overlap/i,
      "overlapping worker-owned roots",
    );
    const crossRootAccess = parallel.accesses.find((access) => access.resource === "fixture");
    const otherRoot = parallel.report.ownedTempRoots.find((root) => root !== crossRootAccess?.workerRoot);
    contract(Boolean(crossRootAccess && otherRoot), "cross-root mutation needs two real worker roots");
    const crossRootAccesses = parallel.accesses.map((access) => access === crossRootAccess
      ? { ...access, path: join(otherRoot, "forged-cross-root-write") }
      : access);
    const crossRootRaw = crossRootAccesses.map((row) => json(row)).join("\n") + "\n";
    await expectRejected(
      () => worker.validateQuorumSmokeResourceTrace({
        claims: quorumRow.resources,
        trace: resourceTraceEnvelope(parallel, {
          accesses: crossRootAccesses,
          raw: crossRootRaw,
        }),
        repositoryRoot: repoRoot,
        proof: {
          ...resourceTraceProof(parallel),
          report: {
            ...parallel.report,
            resourceTraceDigest: createHash("sha256").update(crossRootRaw).digest("hex"),
            resourceTraceCount: crossRootAccesses.length,
          },
        },
      }),
      /root|escaped|trusted execution/i,
      "cross-root worker write",
    );
    const serialVerdicts = serial.report.results
      .map((row) => [resultCaseId(row), row.status]).sort();
    const parallelVerdicts = parallel.report.results
      .map((row) => [resultCaseId(row), row.status]).sort();
    contract(
      json(serialVerdicts) === json(parallelVerdicts)
        && serialVerdicts.length === EXPECTED_CASES.length,
      "real jobs=1/jobs=2 exact 73-case verdict parity failed",
    );
    await proveRealCoordinatorFaultSeam();
    contract(gitStatus() === before, "real parallel contract changed repository state");
    console.log(
      "PARALLEL_PASS jobs=2 cases=" + parallel.report.results.length + " residue=0",
    );
  } finally {
    try {
      cleanupResourceRun(serial, "serial resource run");
    } finally {
      cleanupResourceRun(parallel, "parallel resource run");
    }
  }
}
