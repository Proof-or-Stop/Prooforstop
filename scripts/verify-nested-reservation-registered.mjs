import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const selector = process.argv[2];
const selectors = ["core","fault-registered","fault-same-group","fault-pending","fault-coalesced","fault-finite-owner","fault-pending-lineage","handshake-deadline","owner-loss","registration-race","cleanup-diagnostics","isolated-cleanup","isolated-cleanup-non-isolated","isolated-cleanup-primary-failure","isolated-worker-exit","isolated-worker-exit-normal","source-loader","result-prepare-refusal","result-cleanup-primary","result-armed-timeout","cancel-normal","cancel-capture-deadline","cancel-explicit-cleanup-expired","cancel-spoof-cancel","cancel-spoof-register","cancel-delegated-abort","result-cleanup-result","result-ordinary-error","boot-recovery","result-post-capture-cleanup","wrapper-transport","isolated-observation-retry","isolated-observation-unavailable","cancel-refused-withdrawn","cancel-refused-live","fault-declared-owner-unclassified","fault-declared-owner-expansion","fault-retirement-backoff","result-caller-deadline","fault-controller-transport-unavailable","fault-drain-observation-transient","fault-unattempted-owner-loss","fault-attempted-owner-loss","cancel-client-rejects-applied","isolated-observation-unavailable-no-token","isolated-observation-worker-spawn-failure","result-descriptor-unavailable","result-refused-registration-cleanup","result-attempt-refusal","fault-registered-row-pruned","fault-spawned-owner-loss","result-refused-registration-short","result-completed-group-residual","result-nested-grant-deadline","fault-controller-inspection-transient","fault-controller-inspection-unavailable","isolated-cleanup-unclearable","fault-owner-start-unavailable","result-residual-record-unwritable","result-queue-wait-cap","fault-enrollment-observation-transient"];
if (process.argv.length !== 3 || !selectors.includes(selector)) throw new Error('Unknown nested reservation regression selector');
// Only selectors that need Darwin kernel descriptor or process identity observation are
// platform-gated; the executor result-contract selectors run through the platform
// independent queue in a private OS-home namespace and execute everywhere.
// Result-contract selectors exercise executor folding on any platform, except the one that
// patches the Darwin-only controller cleanup and the one that runs a real controller with a
// registered child meeting a failing Darwin kernel descriptor observation, and the one whose live
// owner meets a refused spawn-attempt mark.
const DARWIN_ONLY = new Set(selectors.filter(name => !name.startsWith('result-') || name === 'result-post-capture-cleanup' || name === 'result-descriptor-unavailable' || name === 'result-attempt-refusal' || name === 'result-completed-group-residual' || name === 'result-nested-grant-deadline' || name === 'result-residual-record-unwritable'));
if (process.platform !== 'darwin' && DARWIN_ONLY.has(selector)) {
  console.log('NESTED_RESERVATION_REGISTERED SKIP ' + selector + ': requires Darwin kernel descriptor and process identity observation; platform=' + process.platform);
} else {
  process.chdir(fileURLToPath(new URL('../', import.meta.url)));
  switch (selector) {
    case "core": {
      // The pinned driver must own the machine pool it exercises. Under the real executor this
      // wrapper inherits a delegated reservation, so the driver runs in a private OS-home
      // namespace with the locator removed and becomes that namespace's genuine owner. The
      // machine pool root is derived from os.userInfo().homedir, exactly as the Lab's
      // source-runtime isolation overrides it; the override is loaded here and forwarded to
      // every child through NODE_OPTIONS and applied in place here; the driver is then loaded
      // by a dynamic import so the override is in place before its module graph loads.
      const scratch = mkdtempSync(join(os.tmpdir(), 'nested-core-home-'));
      const home = join(scratch, 'home'); mkdirSync(home);
      const isolation = join(scratch, 'isolate-home.mjs');
      writeFileSync(isolation, `import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';const original=os.userInfo;os.userInfo=(...args)=>({...original(...args),homedir:${JSON.stringify(home)}});os.homedir=()=>${JSON.stringify(home)};syncBuiltinESMExports();`);
      process.env.HOME = home;
      process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import=${JSON.stringify(isolation)}`.trim();
      // The locator name is the registered runtime policy's descriptorEnvironment. This closed
      // wrapper cannot import the policy without widening its reviewed import graph, so a rename
      // must fail here instead of silently leaving the driver on the outer reservation.
      const DESCRIPTOR_LOCATOR = 'PROOF_OR_STOP_VALIDATION_RESERVATION_FD';
      if (!readFileSync(new URL('../packages/main/src/core/runtime-fact-registry.ts', import.meta.url), 'utf8').includes(`descriptorEnvironment: '${DESCRIPTOR_LOCATOR}'`)) throw new Error('nested reservation locator name changed; update the core selector isolation');
      delete process.env[DESCRIPTOR_LOCATOR];
      const originalUserInfo = os.userInfo;
      os.userInfo = (...args) => ({ ...originalUserInfo(...args), homedir: home });
      os.homedir = () => home;
      syncBuiltinESMExports();
      try {
        process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-verification-machine-owner.mjs", import.meta.url)), ...[]];
        await import("./verify-nested-verification-machine-owner.mjs");
      } finally { rmSync(scratch, { recursive: true, force: true }); }
      break;
    }
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
    case "cancel-refused-withdrawn":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-cancellation.mjs", import.meta.url)), ...["refused-registration-withdrawn"]];
      await import("./verify-nested-reservation-cancellation.mjs");
      break;
    case "cancel-refused-live":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-cancellation.mjs", import.meta.url)), ...["refused-registration-live"]];
      await import("./verify-nested-reservation-cancellation.mjs");
      break;
    case "fault-declared-owner-unclassified":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-faults.mjs", import.meta.url)), ...["declared-owner-unclassified"]];
      await import("./verify-nested-reservation-faults.mjs");
      break;
    case "fault-declared-owner-expansion":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-faults.mjs", import.meta.url)), ...["declared-owner-expansion"]];
      await import("./verify-nested-reservation-faults.mjs");
      break;
    case "fault-retirement-backoff":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-faults.mjs", import.meta.url)), ...["retirement-backoff"]];
      await import("./verify-nested-reservation-faults.mjs");
      break;
    case "result-caller-deadline":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-validation-result-contract.mjs", import.meta.url)), ...["caller-deadline-before-prepare"]];
      await import("./verify-nested-validation-result-contract.mjs");
      break;
    case "fault-controller-transport-unavailable":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-faults.mjs", import.meta.url)), ...["controller-transport-unavailable"]];
      await import("./verify-nested-reservation-faults.mjs");
      break;
    case "fault-drain-observation-transient":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-faults.mjs", import.meta.url)), ...["drain-observation-transient"]];
      await import("./verify-nested-reservation-faults.mjs");
      break;
    case "fault-unattempted-owner-loss":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-faults.mjs", import.meta.url)), ...["unattempted-owner-loss"]];
      await import("./verify-nested-reservation-faults.mjs");
      break;
    case "fault-attempted-owner-loss":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-faults.mjs", import.meta.url)), ...["attempted-owner-loss"]];
      await import("./verify-nested-reservation-faults.mjs");
      break;
    case "cancel-client-rejects-applied":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-cancellation.mjs", import.meta.url)), ...["client-rejects-applied-registration"]];
      await import("./verify-nested-reservation-cancellation.mjs");
      break;
    case "isolated-observation-unavailable-no-token":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-isolated-observation.mjs", import.meta.url)), ...["unavailable-no-token"]];
      await import("./verify-nested-isolated-observation.mjs");
      break;
    case "isolated-observation-worker-spawn-failure":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-isolated-observation.mjs", import.meta.url)), ...["worker-spawn-failure"]];
      await import("./verify-nested-isolated-observation.mjs");
      break;
    case "result-descriptor-unavailable":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-validation-result-contract.mjs", import.meta.url)), ...["descriptor-unavailable"]];
      await import("./verify-nested-validation-result-contract.mjs");
      break;
    case "result-refused-registration-cleanup":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-validation-result-contract.mjs", import.meta.url)), ...["refused-registration-cleanup"]];
      await import("./verify-nested-validation-result-contract.mjs");
      break;
    case "result-attempt-refusal":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-validation-result-contract.mjs", import.meta.url)), ...["attempt-refusal"]];
      await import("./verify-nested-validation-result-contract.mjs");
      break;
    case "fault-registered-row-pruned":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-faults.mjs", import.meta.url)), ...["registered-row-pruned"]];
      await import("./verify-nested-reservation-faults.mjs");
      break;
    case "fault-spawned-owner-loss":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-faults.mjs", import.meta.url)), ...["spawned-owner-loss"]];
      await import("./verify-nested-reservation-faults.mjs");
      break;
    case "result-refused-registration-short":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-validation-result-contract.mjs", import.meta.url)), ...["refused-registration-short"]];
      await import("./verify-nested-validation-result-contract.mjs");
      break;
    case "result-completed-group-residual":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-validation-result-contract.mjs", import.meta.url)), ...["completed-group-residual"]];
      await import("./verify-nested-validation-result-contract.mjs");
      break;
    case "result-nested-grant-deadline":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-validation-result-contract.mjs", import.meta.url)), ...["nested-grant-deadline"]];
      await import("./verify-nested-validation-result-contract.mjs");
      break;
    case "fault-controller-inspection-transient":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-faults.mjs", import.meta.url)), ...["controller-inspection-transient"]];
      await import("./verify-nested-reservation-faults.mjs");
      break;
    case "fault-controller-inspection-unavailable":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-faults.mjs", import.meta.url)), ...["controller-inspection-unavailable"]];
      await import("./verify-nested-reservation-faults.mjs");
      break;
    case "isolated-cleanup-unclearable":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-isolated-cleanup.mjs", import.meta.url)), ...["--unclearable"]];
      await import("./verify-nested-isolated-cleanup.mjs");
      break;
    case "fault-owner-start-unavailable":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-faults.mjs", import.meta.url)), ...["owner-start-unavailable"]];
      await import("./verify-nested-reservation-faults.mjs");
      break;
    case "result-residual-record-unwritable":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-validation-result-contract.mjs", import.meta.url)), ...["residual-record-unwritable"]];
      await import("./verify-nested-validation-result-contract.mjs");
      break;
    case "result-queue-wait-cap":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-validation-result-contract.mjs", import.meta.url)), ...["queue-wait-cap"]];
      await import("./verify-nested-validation-result-contract.mjs");
      break;
    case "fault-enrollment-observation-transient":
      process.argv = [process.execPath, fileURLToPath(new URL("./verify-nested-reservation-faults.mjs", import.meta.url)), ...["enrollment-observation-transient"]];
      await import("./verify-nested-reservation-faults.mjs");
      break;
    default: throw new Error('Unreachable nested reservation selector');
  }
}
