import { reportPlannerFull, reportPlannerPartial } from './support.js';
import { runCommandIdentity } from './command-identity.js';
import { runHistoricalPins } from './historical-pins.js';
import { runChangeInputs } from './change-inputs.js';
import { runSelectionWidening } from './selection-widening.js';
import { runCliIntegration } from './cli-integration.js';
import { runHashCompleteness } from './hash-completeness.js';
import { runAcceptanceGuards } from './acceptance-guards.js';
const CAPABILITIES = [
 { id: 'command-identity', requires: [], run: runCommandIdentity },
 { id: 'historical-pins', requires: [], run: runHistoricalPins },
 { id: 'change-inputs', requires: [], run: runChangeInputs },
 { id: 'selection-widening', requires: [], run: runSelectionWidening },
 { id: 'cli-integration', requires: [], run: runCliIntegration },
 { id: 'hash-completeness', requires: [], run: runHashCompleteness },
 { id: 'acceptance-guards', requires: ["command-identity","historical-pins","change-inputs","selection-widening","cli-integration","hash-completeness"], run: runAcceptanceGuards },
];
export function runPlannerCli(args: string[]): void {
 if(args.length===1&&args[0]==='--list-capabilities'){console.log(JSON.stringify(CAPABILITIES.map(({id,requires})=>({id,requires}))));return;}
 const full=!args.length||args.length===1&&args[0]==='--all';
 const selected=full?CAPABILITIES.map(row=>row.id):[...new Set(args.map(arg=>{if(!arg.startsWith('--capability=')||!CAPABILITIES.some(row=>row.id===arg.slice(13)))throw new Error('Unknown planner verification argument: '+arg);return arg.slice(13);}))];
 const effective=new Set(selected);for(const row of CAPABILITIES)if(selected.includes(row.id))for(const dependency of row.requires)effective.add(dependency);
 for(const row of CAPABILITIES)if(effective.has(row.id))row.run();
 if(effective.size===CAPABILITIES.length)reportPlannerFull();else reportPlannerPartial([...effective]);
}
