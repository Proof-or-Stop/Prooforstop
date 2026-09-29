







import ts from "typescript";
import { selectorContract, inventoryBijection } from "./selection-contracts.mjs";
import { partitionContract } from "./partition.mjs";
import { fixtureTemplateContract } from "./fixture-templates.mjs";
import { proveRealCoordinatorFaultSeam } from "./resource-traces.mjs";
import { loadWorkerContract } from "./worker-coordination.mjs";
import { proveDetachedDescendantContainment } from "./containment.mjs";
import { proveFixtureAndEnvironmentSourceClosure } from "./fixture-source-closure.mjs";
import { proveProtectedMutationGuard } from "./mutation-controls.mjs";
import { proveAmbientGitRoutingIsolation, proveTracedEnvironmentClosureAndDynTemp } from "./environment-closure.mjs";
import { proveExactHeadSupervisorSafety } from "./supervisor-controls.mjs";
import { resourceParallelContract } from "./resource-parallel.mjs";
import { performancePreflightIsolationContract, performanceHostAccountingContract, performanceIdleWaitContract, performanceIdleBudgetContract, performancePreflightIdleContract, performanceContaminationRetryContract, performanceCurrentJobsContract, performanceContract } from "./performance-cases.mjs";

export const SUPPORTED_CASES = new Map([
  ["selector-contract", selectorContract],
  ["inventory-bijection", inventoryBijection],
  ["partition-contract", partitionContract],
  ["fixture-template-contract", fixtureTemplateContract],
  ["coordinator-fault-contract", proveRealCoordinatorFaultSeam],
  ["detached-containment-contract", async () => {
    const worker = await loadWorkerContract("detached-containment-contract");
    await proveDetachedDescendantContainment(worker);
  }],
  ["worker-safety-contract", async () => {
    const worker = await loadWorkerContract("worker-safety-contract");
    await proveFixtureAndEnvironmentSourceClosure(worker);
    await proveProtectedMutationGuard(worker);
    await proveAmbientGitRoutingIsolation();
    await proveTracedEnvironmentClosureAndDynTemp(worker);
  }],
  ["exact-head-supervisor-contract", proveExactHeadSupervisorSafety],
  ["resource-parallel-contract", resourceParallelContract],
  ["performance-preflight-isolation-contract", performancePreflightIsolationContract],
  ["performance-host-accounting-contract", performanceHostAccountingContract],
  ["performance-idle-wait-contract", performanceIdleWaitContract],
  ["performance-idle-budget-contract", performanceIdleBudgetContract],
  ["performance-preflight-idle-contract", performancePreflightIdleContract],
  ["performance-contamination-retry-contract", performanceContaminationRetryContract],
  ["performance-current-jobs1-contract", () => performanceCurrentJobsContract(1)],
  ["performance-current-jobs2-contract", () => performanceCurrentJobsContract(2)],
  ["performance-contract", performanceContract],
]);
