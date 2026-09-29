import { SUPPORTED_CASES } from './catalog.mjs';
import { runSelectedHarness } from './driver.mjs';
// Each case owns a separate exact-HEAD authority or performance lease.
export async function runHarnessCli(args) {
  if (args.length === 1 && args[0] === '--list-capabilities') {
    console.log(JSON.stringify([...SUPPORTED_CASES.keys()].map(id => ({ id, legacyArgument: '--case=' + id, completeSuite: false, composition: 'one case per invocation' }))));
    return;
  }
  if (args.some(arg => arg.startsWith('--capability='))) {
    const ids = [...new Set(args.map(arg => arg.startsWith('--capability=') ? arg.slice(13) : null))];
    if (ids.length !== 1 || !SUPPORTED_CASES.has(ids[0])) {
      console.error('HARNESS_USAGE: choose one known capability per invocation; each case owns separate isolation authority');
      process.exitCode = 2;
      return;
    }
    await runSelectedHarness(['--case=' + ids[0]]);
    return;
  }
  await runSelectedHarness(args);
}
