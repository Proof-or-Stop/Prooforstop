import assert from 'node:assert/strict';
































import { grokIsolatedIntegrationRegression } from "./grok-integration.js";
import { managedSupersessionRegression } from "./supersession.js";
import { proposalWorkerMain, importWorkerMain, sanitizedProposalToolMain, brokeredNativeBindingFixtureMain } from "./transport-workers.js";
import { main } from "./suite.js";
export function runLegacyManagedCli(): void {

if (process.argv[2] === '--grok-isolated-regression') {
  grokIsolatedIntegrationRegression().catch(error => { console.error(error); process.exitCode = 1; });
} else if (process.argv[2] === '--supersession-regression') {
  managedSupersessionRegression().catch(error => { console.error(error); process.exitCode = 1; });
} else if (process.argv[2] === '--proposal-worker') {
  proposalWorkerMain(
    process.argv[3] ?? '', process.argv[4] ?? '', process.argv[5] ?? '',
    process.argv[6] ?? '', process.argv[7] ?? '',
  ).catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
} else if (process.argv[2] === '--import-worker') {
  importWorkerMain(
    process.argv[3] ?? '', process.argv[4] ?? '', process.argv[5] ?? '',
    process.argv[6] ?? '', process.argv[7] ?? '', process.argv[8] ?? '',
    process.argv[9], process.argv[10],
  ).catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
} else if (process.argv[2] === '--sanitized-proposal-tool') {
  sanitizedProposalToolMain(process.argv[3] ?? '', process.argv[4] ?? '', process.argv[5] ?? '').catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
} else if (process.argv[2] === '--brokered-native-binding-fixture') {
  try {
    brokeredNativeBindingFixtureMain(process.argv[3] ?? '', process.argv[4] ?? '');
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
} else {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
}
