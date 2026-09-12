import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

export function verifyRouteReaderWiring() {
  const root = resolve(import.meta.dirname, '..');
  const require = createRequire(resolve(root, 'package.json'));
  const ts = require('typescript');
  const testPath = 'packages/main/tests/red/red-dynamic-finding-four-gaps.mjs';
  const testSource = readFileSync(resolve(root, testPath), 'utf8');
  const tree = ts.createSourceFile(testPath, testSource, ts.ScriptTarget.Latest, true);
  const statement = tree.statements.find(node => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression) && node.expression.expression.getText(tree) === 'check'
    && node.expression.arguments[0]?.text === 'REATTEST-gate-consumes-verified-closure');
  assert(statement, 'actual four-gaps wiring callback must exist');
  const callback = statement.expression.arguments[1].getText(tree);
  // Read once outside VM budgets; guarded callbacks only inspect cached text.
  const paths = ['core/finding-applicability-projection.ts', 'registry.ts',
    'handlers/finding-material-reattestation.ts', 'handlers/finding-route.ts'];
  const sources = new Map(paths.map(path => [path, readFileSync(resolve(root, 'packages/main/src', path), 'utf8')]));
  const source = path => { assert(sources.has(path), 'unexpected wiring source: ' + path); return sources.get(path); };
  const runWiring = overrides => runInNewContext('(' + callback + ')()', {
    assert, source: path => overrides.get(path) ?? source(path),
  }, { timeout: 1000 });
  runWiring(new Map());
  const routePath = 'handlers/finding-route.ts';
  const adapterPath = 'handlers/finding-material-reattestation.ts';
  const adapter = source(adapterPath);
  const declaration = 'export const readRouteSourceRestoration: RouteSourceRestorationReader = (ctx, source) => {';
  assert.equal(adapter.split(declaration).length, 2, 'exact production adapter declaration must exist once');
  const cases = [
    ['adapter body replaced while unrelated tokens survive', adapterPath,
      adapter.replace(declaration, 'export const readRouteSourceRestoration: RouteSourceRestorationReader = () => undefined;\nconst unrelatedReader = (ctx, source) => {')],
    ['alternate static import', routePath, source(routePath) + "\nimport { x } from '../handlers/finding-material-reattestation.js';\n"],
    ['dynamic import', routePath, source(routePath) + "\nawait import('../handlers/finding-material-reattestation.js');\n"],
  ];
  // Exact committed callback from cec884ccde (the official target RED revision).
  const historicalLooseCallback = "() => {\n  assert.match(source('core/finding-applicability-projection.ts'), /readMaterialDriftReattestation\\(/);\n  assert.match(source('registry.ts'), /createFindingRouteHandlers\\(ctx, readRouteSourceRestoration\\)/);\n  assert.match(source('registry.ts'), /createFindingHistoryHandlers\\(ctx, observeDeferralInvalidation, readRouteSourceRestoration\\)/);\n  assert.match(source('handlers/finding-material-reattestation.ts'), /readRouteSourceRestoration[\\s\\S]*readMaterialDriftReattestation\\(ctx, source\\.storyId, source\\.recordId\\)/);\n  assert.match(source('handlers/finding-route.ts'), /readRestoration\\?\\.\\(ctx, source\\)/);\n  assert.doesNotMatch(source('handlers/finding-route.ts'), /from ['\"]\\.\\/finding-material-reattestation\\.js['\"]/);\n}";
  runInNewContext('(' + historicalLooseCallback + ')()', { assert, source }, { timeout: 1000 });
  for (const [name, path, changed] of cases) {
    assert.doesNotThrow(() => runInNewContext('(' + historicalLooseCallback + ')()', {
      assert, source: requested => requested === path ? changed : source(requested),
    }, { timeout: 1000 }), name + ' must demonstrate the historical loose guard accepts this exact mutation');
  }
  const missed = [];
  for (const [name, path, changed] of cases) {
    try { runWiring(new Map([[path, changed]])); missed.push(name); }
    catch (error) { assert.equal(error.code, 'ERR_ASSERTION', name + ' must fail an actual wiring assertion'); }
  }
  if (missed.length) console.error('ROUTE_READER_WIRING_MUTATION_RED ' + missed.join('; '));
  assert.deepEqual(missed, [], 'actual four-gaps guards must reject each dependency mutation');
  console.log('ROUTE_READER_WIRING_MUTATIONS PASS adapter scope and alternate imports');

}
