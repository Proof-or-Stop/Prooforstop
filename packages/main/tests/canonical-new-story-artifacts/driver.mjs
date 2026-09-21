import { rmSync } from 'node:fs';
import { failures, selectedGroup, fixtureRoots, setSelection } from './data.mjs';
import { runCases as run0 } from './scope-init.mjs';
import { runCases as run1 } from './runtime-topology.mjs';
import { runCases as run2 } from './runtime-read.mjs';
import { runCases as run3 } from './identity-inventory.mjs';
import { runCases as run4 } from './identity-cutover.mjs';
import { runCases as run5 } from './identity-sites.mjs';
import { runCases as run6 } from './identity-policy.mjs';
import { runCases as run7 } from './migration-archive.mjs';
import { runCases as run8 } from './identity-runtime-boundaries.mjs';
import { runCases as run9 } from './release.mjs';
import { runCases as run10 } from './artifact-inventory.mjs';
import { runCases as run11 } from './memory-runtime.mjs';
import { runCases as run12 } from './finding-artifacts.mjs';
import { runCases as run13 } from './runtime-extensions.mjs';
export async function runCanonical(groups) {
setSelection(groups);
await run0();
await run1();
await run2();
await run3();
await run4();
await run5();
await run6();
await run7();
await run8();
await run9();
await run10();
await run11();
await run12();
await run13();
if (failures.length > 0) {
  process.stderr.write(`\nRED B-49df: ${failures.length} focused contract(s) failing.\n`);
  process.exitCode = 1;
} else {
  const selection = selectedGroup === null ? 'all focused contracts' : `${selectedGroup} group`;
  process.stdout.write(`\nGREEN B-49df: ${selection} pass.\n`);
}
for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
}
