import { GROUPS, CAPABILITIES } from './catalog.mjs';
export async function runCanonicalCli(args) {
  if (args.length === 1 && args[0] === '--list-capabilities') {
    console.log(JSON.stringify(CAPABILITIES)); return;
  }
  let groups = null;
  let capabilityMode = false;
  if (args.length && !(args.length === 1 && args[0] === '--all')) {
    if (args.length === 1 && args[0].startsWith('--group=')) groups = [args[0].slice(8)];
    else if (args.every(arg => arg.startsWith('--capability='))) { groups = [...new Set(args.map(arg => arg.slice(13)))]; capabilityMode = true; }
    else throw new Error('Unknown canonical artifact verification arguments: ' + JSON.stringify(args));
    if (!groups.every(id => GROUPS.includes(id))) throw new Error('Unknown canonical artifact capability: ' + JSON.stringify(groups));
  }
  const { runCanonical } = await import('./driver.mjs');
  await runCanonical(groups);
  if (capabilityMode && !process.exitCode) console.log('CANONICAL_ARTIFACT_PARTIAL_PASS ' + JSON.stringify({full:false, capabilities:groups}));
}
