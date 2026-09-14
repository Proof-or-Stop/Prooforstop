import { fileURLToPath } from 'node:url';
const selector = process.argv[2];
const selectors = ["core","fault-registered","fault-same-group","fault-pending","fault-coalesced","fault-finite-owner","fault-pending-lineage","handshake-deadline","owner-loss","registration-race","cleanup-diagnostics","isolated-cleanup","isolated-cleanup-non-isolated","isolated-cleanup-primary-failure","isolated-worker-exit","isolated-worker-exit-normal","source-loader","result-prepare-refusal","result-cleanup-primary","result-armed-timeout","cancel-normal","cancel-capture-deadline","cancel-explicit-cleanup-expired","cancel-spoof-cancel","cancel-spoof-register","cancel-delegated-abort","result-cleanup-result","result-ordinary-error","boot-recovery","result-post-capture-cleanup","wrapper-transport","isolated-observation-retry","isolated-observation-unavailable"];
if (process.argv.length !== 3 || !selectors.includes(selector)) throw new Error('Unknown nested reservation regression selector');
// Only selectors that need Darwin kernel descriptor or process identity observation are
// platform-gated; the executor result-contract selectors run through the platform
// independent queue in a private OS-home namespace and execute everywhere.
const DARWIN_ONLY = new Set(selectors.filter(name => !name.startsWith('result-')));
if (process.platform !== 'darwin' && DARWIN_ONLY.has(selector)) {
  console.log('NESTED_RESERVATION_REGISTERED SKIP ' + selector + ': requires Darwin kernel descriptor and process identity observation; platform=' + process.platform);
} else {
  process.chdir(fileURLToPath(new URL('../', import.meta.url)));
  switch (selector) {
    case "core":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-verification-machine-owner.mjs", import.meta.url)), ...[]];
      await import("./verify-nested-verification-machine-owner.mjs");
      break;
    case "fault-registered":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-faults.mjs", import.meta.url)), ...["registered"]];
      await import("./verify-nested-reservation-faults.mjs");
      break;
    case "fault-same-group":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-faults.mjs", import.meta.url)), ...["same-group"]];
      await import("./verify-nested-reservation-faults.mjs");
      break;
    case "fault-pending":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-faults.mjs", import.meta.url)), ...["pending"]];
      await import("./verify-nested-reservation-faults.mjs");
      break;
    case "fault-coalesced":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-faults.mjs", import.meta.url)), ...["coalesced"]];
      await import("./verify-nested-reservation-faults.mjs");
      break;
    case "fault-finite-owner":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-faults.mjs", import.meta.url)), ...["finite-owner"]];
      await import("./verify-nested-reservation-faults.mjs");
      break;
    case "fault-pending-lineage":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-faults.mjs", import.meta.url)), ...["pending-lineage"]];
      await import("./verify-nested-reservation-faults.mjs");
      break;
    case "handshake-deadline":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-handshake-deadline.mjs", import.meta.url)), ...[]];
      await import("./verify-nested-reservation-handshake-deadline.mjs");
      break;
    case "owner-loss":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-owner-loss.mjs", import.meta.url)), ...[]];
      await import("./verify-nested-reservation-owner-loss.mjs");
      break;
    case "registration-race":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-registration-race.mjs", import.meta.url)), ...[]];
      await import("./verify-nested-reservation-registration-race.mjs");
      break;
    case "cleanup-diagnostics":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-cleanup-diagnostics.mjs", import.meta.url)), ...[]];
      await import("./verify-nested-reservation-cleanup-diagnostics.mjs");
      break;
    case "isolated-cleanup":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-isolated-cleanup.mjs", import.meta.url)), ...[]];
      await import("./verify-nested-isolated-cleanup.mjs");
      break;
    case "isolated-cleanup-non-isolated":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-isolated-cleanup.mjs", import.meta.url)), ...["--non-isolated"]];
      await import("./verify-nested-isolated-cleanup.mjs");
      break;
    case "isolated-cleanup-primary-failure":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-isolated-cleanup.mjs", import.meta.url)), ...["--primary-failure"]];
      await import("./verify-nested-isolated-cleanup.mjs");
      break;
    case "isolated-worker-exit":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-isolated-worker-exit.mjs", import.meta.url)), ...[]];
      await import("./verify-nested-isolated-worker-exit.mjs");
      break;
    case "isolated-worker-exit-normal":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-isolated-worker-exit.mjs", import.meta.url)), ...["--normal"]];
      await import("./verify-nested-isolated-worker-exit.mjs");
      break;
    case "source-loader":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-source-loader-semantics.mjs", import.meta.url)), ...[]];
      await import("./verify-nested-source-loader-semantics.mjs");
      break;
    case "result-prepare-refusal":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-validation-result-contract.mjs", import.meta.url)), ...["prepare-refusal"]];
      await import("./verify-nested-validation-result-contract.mjs");
      break;
    case "result-cleanup-primary":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-validation-result-contract.mjs", import.meta.url)), ...["cleanup-primary"]];
      await import("./verify-nested-validation-result-contract.mjs");
      break;
    case "result-armed-timeout":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-validation-result-contract.mjs", import.meta.url)), ...["armed-timeout"]];
      await import("./verify-nested-validation-result-contract.mjs");
      break;
    case "cancel-normal":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-cancellation.mjs", import.meta.url)), ...["normal"]];
      await import("./verify-nested-reservation-cancellation.mjs");
      break;
    case "cancel-capture-deadline":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-cancellation.mjs", import.meta.url)), ...["capture-deadline"]];
      await import("./verify-nested-reservation-cancellation.mjs");
      break;
    case "cancel-explicit-cleanup-expired":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-cancellation.mjs", import.meta.url)), ...["explicit-cleanup-expired"]];
      await import("./verify-nested-reservation-cancellation.mjs");
      break;
    case "cancel-spoof-cancel":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-cancellation.mjs", import.meta.url)), ...["spoof-cancel"]];
      await import("./verify-nested-reservation-cancellation.mjs");
      break;
    case "cancel-spoof-register":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-cancellation.mjs", import.meta.url)), ...["spoof-register"]];
      await import("./verify-nested-reservation-cancellation.mjs");
      break;
    case "cancel-delegated-abort":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-cancellation.mjs", import.meta.url)), ...["delegated-abort"]];
      await import("./verify-nested-reservation-cancellation.mjs");
      break;
    case "result-cleanup-result":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-validation-result-contract.mjs", import.meta.url)), ...["cleanup-result"]];
      await import("./verify-nested-validation-result-contract.mjs");
      break;
    case "result-ordinary-error":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-validation-result-contract.mjs", import.meta.url)), ...["ordinary-error"]];
      await import("./verify-nested-validation-result-contract.mjs");
      break;
    case "boot-recovery":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-boot-recovery.mjs", import.meta.url)), ...[]];
      await import("./verify-nested-reservation-boot-recovery.mjs");
      break;
    case "result-post-capture-cleanup":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-validation-result-contract.mjs", import.meta.url)), ...["post-capture-cleanup"]];
      await import("./verify-nested-validation-result-contract.mjs");
      break;
    case "wrapper-transport":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-wrapper-transport.mjs", import.meta.url)), ...[]];
      await import("./verify-nested-reservation-wrapper-transport.mjs");
      break;
    case "isolated-observation-retry":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-isolated-observation.mjs", import.meta.url)), ...["retry"]];
      await import("./verify-nested-isolated-observation.mjs");
      break;
    case "isolated-observation-unavailable":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-isolated-observation.mjs", import.meta.url)), ...["unavailable"]];
      await import("./verify-nested-isolated-observation.mjs");
      break;
    default: throw new Error('Unreachable nested reservation selector');
  }
}
