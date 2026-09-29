import { case01, case03, case04, case25, case26 } from './reporting.mjs';
import { case02 } from './planning.mjs';
import { case05, case20, case21, case22, case23, case24 } from './closeout.mjs';
import { case06, case07, case08, case09, case10, case11, case12, case13 } from './freshness.mjs';
import { case14, case15, case16, case27, case28 } from './coverage.mjs';
import { case17, case18, case19 } from './read-only.mjs';
import { case29, case30, case31 } from './cli-behavior.mjs';

export const cases = [
  { id: 'case01', capability: 'reporting', run: case01 },
  { id: 'case02', capability: 'planning', run: case02 },
  { id: 'case03', capability: 'reporting', run: case03 },
  { id: 'case04', capability: 'reporting', run: case04 },
  { id: 'case05', capability: 'closeout', run: case05 },
  { id: 'case06', capability: 'freshness', run: case06 },
  { id: 'case07', capability: 'freshness', run: case07 },
  { id: 'case08', capability: 'freshness', run: case08 },
  { id: 'case09', capability: 'freshness', run: case09 },
  { id: 'case10', capability: 'freshness', run: case10 },
  { id: 'case11', capability: 'freshness', run: case11 },
  { id: 'case12', capability: 'freshness', run: case12 },
  { id: 'case13', capability: 'freshness', run: case13 },
  { id: 'case14', capability: 'coverage', run: case14 },
  { id: 'case15', capability: 'coverage', run: case15 },
  { id: 'case16', capability: 'coverage', run: case16 },
  { id: 'case17', capability: 'read-only', run: case17 },
  { id: 'case18', capability: 'read-only', run: case18 },
  { id: 'case19', capability: 'read-only', run: case19 },
  { id: 'case20', capability: 'closeout', run: case20 },
  { id: 'case21', capability: 'closeout', run: case21 },
  { id: 'case22', capability: 'closeout', run: case22 },
  { id: 'case23', capability: 'closeout', run: case23 },
  { id: 'case24', capability: 'closeout', run: case24 },
  { id: 'case25', capability: 'reporting', run: case25 },
  { id: 'case26', capability: 'reporting', run: case26 },
  { id: 'case27', capability: 'coverage', run: case27 },
  { id: 'case28', capability: 'coverage', run: case28 },
  { id: 'case29', capability: 'cli-behavior', run: case29 },
  { id: 'case30', capability: 'cli-behavior', run: case30 },
  { id: 'case31', capability: 'cli-behavior', run: case31 },
];

export async function runMilestoneStatusCli(args) {
  const capabilities = [...new Set(cases.map(row => row.capability))];
  if (args.length === 1 && args[0] === '--list-capabilities') {
    console.log(JSON.stringify(capabilities.map(id => ({ id, checks: cases.filter(row => row.capability === id).map(row => row.id) }))));
    return;
  }
  let selected = capabilities;
  if (args.length && !(args.length === 1 && args[0] === '--all')) {
    selected = [...new Set(args.map(arg => {
      if (!arg.startsWith('--capability=') || !capabilities.includes(arg.slice(13))) throw new Error('Unknown milestone verification argument: ' + arg);
      return arg.slice(13);
    }))];
  }
  const full = selected.length === capabilities.length;
  for (const row of cases) if (selected.includes(row.capability)) await row.run();
  if (full) console.log('ok milestone-status');
  else console.log('MILESTONE_PARTIAL_PASS ' + JSON.stringify({ full: false, capabilities: selected }));
}
