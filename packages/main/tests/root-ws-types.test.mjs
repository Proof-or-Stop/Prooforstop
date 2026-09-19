#!/usr/bin/env node
// Reproduce root-only installs outside the checkout so nested/ancestor types
// cannot conceal a missing root development dependency.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const sandbox = mkdtempSync(join(tmpdir(), 'proof-or-stop-root-ws-types-'));

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: sandbox, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
  });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  process.stdout.write(output);
  assert.equal(result.error, undefined, `command must execute: ${result.error}`);
  assert.equal(result.signal, null, 'command must finish without a signal');
  return { status: result.status, output };
}

try {
  for (const file of ['package.json', 'package-lock.json']) {
    copyFileSync(join(root, file), join(sandbox, file));
  }
  const main = join(sandbox, 'packages/main');
  mkdirSync(main, { recursive: true });
  for (const file of ['package.json', 'tsconfig.json']) {
    copyFileSync(join(root, 'packages/main', file), join(main, file));
  }
  cpSync(join(root, 'packages/main/src'), join(main, 'src'), { recursive: true });

  // Only root dependencies are installed. Installation failures are environment
  // failures and must never emit the target regression's RED marker.
  const install = run(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['ci', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
  assert.equal(install.status, 0, 'clean root dependency installation must succeed');
  assert.equal(existsSync(join(main, 'node_modules')), false, 'no nested installation may mask missing root types');

  // These directives must consume real type errors; an any-only declaration or
  // disabled strictness would fail with TS2578 instead of satisfying the test.
  writeFileSync(join(main, 'src/root-ws-type-contract.ts'), `
import { WebSocket, WebSocketServer } from 'ws';
const server = new WebSocketServer({ noServer: true });
server.on('connection', socket => {
  const typedSocket: WebSocket = socket;
  // @ts-expect-error WebSocket must not become any.
  const invalidSocket: number = typedSocket;
  socket.on('message', data => {
    // @ts-expect-error RawData must not become any.
    const invalidData: number = data;
    void invalidData;
  });
  void invalidSocket;
});
const { default: DynamicWebSocket } = await import('ws');
const client = new DynamicWebSocket('ws://localhost:9876');
// @ts-expect-error Dynamic imports must retain WebSocket member checking.
client.nonexistentWebSocketMethod();
`);

  const compile = run(process.execPath, [join(sandbox, 'node_modules/typescript/bin/tsc'),
    '--project', 'packages/main/tsconfig.json', '--noEmit']);
  if (compile.status !== 0 && /TS7016: Could not find a declaration file for module 'ws'/.test(compile.output)) {
    assert.fail('ROOT_WS_TYPES_MISSING: clean root install cannot typecheck the actual main sources');
  }
  assert.equal(compile.status, 0, 'main sources and static/dynamic WebSocket type controls must compile');
  console.log('ROOT_WS_TYPES_GREEN: clean root install typechecks main and rejects invalid WebSocket types');
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
