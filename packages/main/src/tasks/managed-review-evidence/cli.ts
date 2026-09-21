import { main } from './suite.js';
import { managedSupersessionRegression } from './supersession.js';
import { runLegacyManagedCli } from './legacy-cli.js';
const PHASES = ["codex-transport","claude-transport","evidence-binding","native-attestation","sealed-receipts"];
const IDS = [...PHASES, 'descriptor-transport', 'supersession'];
export async function runManagedCli(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--list-capabilities') {
    console.log(JSON.stringify(IDS.map(id => ({id, completeSuite:false, prerequisites: PHASES.includes(id) ? PHASES.slice(0, PHASES.indexOf(id)) : []})))); return;
  }
  if (!args.length || args[0].startsWith('--') && !args.some(arg => arg.startsWith('--capability=')) && args[0] !== '--all') {
    const legacy = ['--grok-isolated-regression','--supersession-regression','--proposal-worker','--import-worker','--sanitized-proposal-tool','--brokered-native-binding-fixture','--descriptor-proposal-transport'];
    if (!args.length || legacy.includes(args[0])) { runLegacyManagedCli(); return; }
  }
  if (args.length === 1 && args[0] === '--all') { await main(); return; }
  const selected = [...new Set(args.map(arg => arg.startsWith('--capability=') ? arg.slice(13) : ''))];
  if (!selected.length || selected.some(id => !IDS.includes(id))) throw new Error('Unknown managed review verification argument: ' + JSON.stringify(args));
  const last = Math.max(...selected.map(id => PHASES.indexOf(id)));
  if (last >= 0 && await main(last) !== last) throw new Error('Selected managed review phases stopped in a legacy diagnostic; no capability receipt issued');
  if (selected.includes('descriptor-transport')) await main(0, true);
  if (selected.includes('supersession')) await managedSupersessionRegression();
  console.log('MANAGED_REVIEW_PARTIAL_PASS ' + JSON.stringify({full:false, capabilities:selected, executedPhases:PHASES.slice(0,last+1)}));
}
