







import ts from "typescript";
import { parseHarnessCase } from "./selection.mjs";
import { BootstrapFailure, ContractFailure } from "./owned-files.mjs";
import { consumeExactHeadIsolationAuthorization } from "./exact-head-authorization.mjs";
import { EXACT_HEAD_ISOLATION_SELECTORS } from "./support.mjs";
import { proveExactHeadSupervisorSafety } from "./supervisor-controls.mjs";
import { runExactHeadIsolatedSelector } from "./exact-head-checkout.mjs";
import { SUPPORTED_CASES } from "./catalog.mjs";
export let exactHeadOuterSupervisorSafetyProven = false;
export async function runSelectedHarness(args) {

const selected = (() => {
  try {
    return parseHarnessCase(args);
  } catch (error) {
    const prefix = error instanceof BootstrapFailure ? "HARNESS_USAGE" : "HARNESS_ERROR";
    console.error(prefix + ": " + error.message);
    process.exit(2);
  }
})();

try {
  const isolationAuthorization = consumeExactHeadIsolationAuthorization(selected);
  exactHeadOuterSupervisorSafetyProven = isolationAuthorization?.supervisorSafetyProven === true;
  if (isolationAuthorization && !EXACT_HEAD_ISOLATION_SELECTORS.has(selected)) {
    throw new BootstrapFailure("exact-HEAD inner authority targeted a non-isolated selector");
  }
  if (!isolationAuthorization && EXACT_HEAD_ISOLATION_SELECTORS.has(selected)) {
    const supervisorSafetyProven = selected === "resource-parallel-contract";
    if (supervisorSafetyProven) await proveExactHeadSupervisorSafety();
    const terminal = await runExactHeadIsolatedSelector(selected, supervisorSafetyProven);
    if (terminal.signal && process.platform !== "win32") {
      process.kill(process.pid, terminal.signal);
      process.exit(2);
    }
    process.exit(terminal.status ?? (terminal.signal === "SIGINT" ? 130 : 143));
  }
  await SUPPORTED_CASES.get(selected)();
  console.log("GREEN " + selected);
} catch (error) {
  if (error instanceof ContractFailure) {
    console.error("RED " + selected + ": " + error.message);
    process.exit(1);
  }
  if (error instanceof BootstrapFailure) {
    console.error("BOOTSTRAP_ERROR " + selected + ": " + error.message);
    process.exit(2);
  }
  console.error("HARNESS_ERROR " + selected + ": " + (error?.stack ?? error));
  process.exit(2);
}
}
