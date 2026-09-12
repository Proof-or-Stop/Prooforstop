import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { prepareVerification } from './verification-subprocess-budget.mjs';
import { verifyRouteReaderWiring } from './route-reader-wiring-controls.mjs';

const root = resolve(import.meta.dirname, '..');
const testPath = 'packages/main/tests/red/red-dynamic-finding-four-gaps.mjs';
verifyRouteReaderWiring();

const spawnSync = prepareVerification(root, { shareBuild: true, bodyBudgetMs: 540000 });
for (const args of [[testPath],
  ['packages/main/dist/tasks/finding-material-reattestation-smoke.js', '--route-restoration-port'],
  ['packages/main/dist/tasks/finding-material-reattestation-smoke.js', '--route-restoration-port', '--head-continuity']]) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  process.stdout.write(output);
  assert.equal(result.error, undefined, 'child execution must complete');
  assert.equal(result.signal, null, 'child execution must not be signaled');
  assert.equal(result.status, 0, args.join(' ') + ' must preserve native controls');
  assert(output.includes(args.length === 1 ? 'DYNAMIC_FINDING_FOUR_GAPS PASS' : 'ROUTE_RESTORATION_PORT PASS'));
}
console.log('ROUTE_READER_REGRESSION_GREEN composition and native material/head-only refusal controls passed');
