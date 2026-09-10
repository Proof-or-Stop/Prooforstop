import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const source = readFileSync(new URL('../packages/main/src/tasks/managed-host-run-process-smoke.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
const initializers = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    initializers.set(node.name.text, node.initializer.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast);
const root = mkdtempSync(join(tmpdir(), 'owned-fixture-release-'));
const context = { root, JSON };
if (initializers.has('fixtureKeepAliveScript')) context.fixtureKeepAliveScript = runInNewContext(initializers.get('fixtureKeepAliveScript'), context);
const script = runInNewContext(initializers.get('liveChildScript'), context);
let child;
try {
  child = spawn(process.execPath, ['-e', `${script};console.log('READY')`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('owned fixture did not become ready')), 3000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('error', reject);
  });
  child.kill('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(child.exitCode, null, 'fixture remains TERM-resistant while its owner exists');
  assert.equal(child.signalCode, null);
  rmSync(root, { recursive: true, force: true });
  let timeout;
  const result = await Promise.race([exit, new Promise(resolve => { timeout = setTimeout(() => resolve(null), 1500); })]);
  clearTimeout(timeout);
  assert.deepEqual(result, { code: 0, signal: null }, 'owned fixture must exit when failed smoke removes its root');
  console.log('PASS managed fixture releases after owner cleanup');
} finally {
  rmSync(root, { recursive: true, force: true });
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
