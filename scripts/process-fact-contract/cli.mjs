import { PROCESS_CAPABILITY_CATALOG } from './catalog.mjs';

export async function runProcessContractCli(args) {
  const selectors = args.filter(arg => arg !== '--quiet');
  if (selectors.length === 1 && selectors[0] === '--list-capabilities') {
    console.log(JSON.stringify(PROCESS_CAPABILITY_CATALOG.map(({ id, checks, obligations }) => ({ id, checks, obligations, completeSuite: false }))));
    return;
  }
  const complete = !selectors.length || selectors.length === 1 && selectors[0] === '--all';
  const selected = complete ? [] : [...new Set(selectors.map(arg => {
    if (!arg.startsWith('--capability=') || !PROCESS_CAPABILITY_CATALOG.some(row => row.id === arg.slice(13))) {
      throw new Error('Unknown process verification argument: ' + arg);
    }
    return arg.slice(13);
  }))];
  // Validate all arguments before importing the build prerequisite or verifiers.
  const { failures } = await import('./support.mjs');
  if (complete) {
    const { runEarlyProcessChecks } = await import('./early.mjs');
    await runEarlyProcessChecks();
    const { runCompleteProcessContract } = await import('./complete.mjs');
    await runCompleteProcessContract();
    return;
  }
  for (const row of PROCESS_CAPABILITY_CATALOG) if (selected.includes(row.id)) {
    const before = failures.length;
    const implementation = await import(row.module);
    for (const check of row.checks) await implementation[check]();
    if (failures.length > before) console.error('PROCESS_CAPABILITY_FAIL ' + JSON.stringify({ capability: row.id, failures: failures.slice(before) }));
  }
  if (failures.length) { process.exitCode = 1; return; }
  console.log('PROCESS_PARTIAL_PASS ' + JSON.stringify({ full: false, capabilities: selected }));
}
