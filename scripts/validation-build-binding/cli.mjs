import { red, checks, MARKER } from './support.mjs';
import { runRoutineBinding } from './routine.mjs';
import { runDoneRequiredBinding } from './done-required.mjs';
import { runSharedCacheBinding } from './shared-cache.mjs';
import { runExecutorBinding } from './executor.mjs';
import { runHandlerBinding } from './handler.mjs';

export const CAPABILITIES = [
  { id: 'routine', checks: ['runRoutineBinding'], requires: [], run: runRoutineBinding },
  { id: 'done-required', checks: ['runDoneRequiredBinding'], requires: ['routine'], run: runDoneRequiredBinding },
  { id: 'shared-cache', checks: ['runSharedCacheBinding'], requires: ['routine'], run: runSharedCacheBinding },
  { id: 'executor', checks: ['runExecutorBinding'], requires: ['routine'], run: runExecutorBinding },
  { id: 'handler', checks: ['runHandlerBinding'], requires: ['routine'], run: runHandlerBinding },
];

export async function runBuildBindingCli(args) {
  if (args.length === 1 && args[0] === '--list-capabilities') { console.log(JSON.stringify(CAPABILITIES.map(({id,checks,requires})=>({id,checks,requires})))); return; }
  let selected = CAPABILITIES.map(row=>row.id);
  if (args.length && !(args.length === 1 && args[0] === '--all')) selected = [...new Set(args.map(arg=>{
    if (!arg.startsWith('--capability=') || !CAPABILITIES.some(row=>row.id===arg.slice(13))) throw new Error('Unknown build binding verification argument: '+arg);
    return arg.slice(13);
  }))];
  const effective = new Set(selected);
  for(const row of CAPABILITIES) if(selected.includes(row.id)) for(const dependency of row.requires) effective.add(dependency);
  for(const row of CAPABILITIES) if(effective.has(row.id)) await row.run();
  if (red.length > 0) {
    for (const failure of red) console.error('  - '+failure);
    console.error('RED: '+MARKER+' ('+red.length+' failing expectations, '+checks+' controls passed)');
    process.exitCode=1;return;
  }
  if(effective.size===CAPABILITIES.length) console.log('verify-validation-build-artifact-binding: '+checks+' checks passed');
  else console.log('BUILD_BINDING_PARTIAL_PASS '+JSON.stringify({full:false,selected,effective:[...effective],checks}));
}
