#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

const HOST = '127.0.0.1';
const PORT = 43127;

type CollisionReceipt = {
  schema: 'proof-or-stop.fixed-port-os-collision.v1';
  host: typeof HOST;
  port: typeof PORT;
  capability: 'detected' | 'unsupported';
  normalBind: 'PASS' | 'UNSUPPORTED';
  collision: { status: 'TERMINAL_FAIL' | 'UNSUPPORTED'; code: string };
  cleanupRebind: 'PASS' | 'UNSUPPORTED';
  mutationDetected: boolean;
  overallStatus: 'PASS' | 'UNSUPPORTED';
};

function parseOutputPath(args: string[]): string {
  if (args.length !== 2 || args[0] !== '--out' || !args[1]) throw new Error('usage: full-suite-fixed-port-os-collision --out <external-json-path>');
  const requested = resolve(args[1]);
  if (!existsSync(dirname(requested))) throw new Error('collision receipt parent must already exist');
  const output = resolve(realpathSync(dirname(requested)), basename(requested));
  const projectRoot = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
  const relation = relative(projectRoot, output);
  if (output === projectRoot || (!relation.startsWith('..') && !isAbsolute(relation))) throw new Error('collision receipt must be outside the project root');
  return output;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(PORT, HOST, () => {
      server.off('error', onError);
      resolveListen();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
}

function atomicWrite(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  renameSync(temporary, path);
}

async function runCollisionProbe(): Promise<CollisionReceipt> {
  const owner = createServer();
  try {
    await listen(owner);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    if (code !== 'EPERM' && code !== 'EACCES') throw error;
    return { schema: 'proof-or-stop.fixed-port-os-collision.v1', host: HOST, port: PORT, capability: 'unsupported', normalBind: 'UNSUPPORTED', collision: { status: 'UNSUPPORTED', code }, cleanupRebind: 'UNSUPPORTED', mutationDetected: false, overallStatus: 'UNSUPPORTED' };
  }

  const contender = createServer();
  let collisionCode = 'NO_ERROR';
  try { await listen(contender); }
  catch (error) { collisionCode = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN'; }
  finally { if (contender.listening) await close(contender); }
  await close(owner);
  if (collisionCode !== 'EADDRINUSE') throw new Error(`second bind did not fail terminally with EADDRINUSE (received ${collisionCode})`);

  const cleanup = createServer();
  await listen(cleanup);
  await close(cleanup);
  return { schema: 'proof-or-stop.fixed-port-os-collision.v1', host: HOST, port: PORT, capability: 'detected', normalBind: 'PASS', collision: { status: 'TERMINAL_FAIL', code: collisionCode }, cleanupRebind: 'PASS', mutationDetected: true, overallStatus: 'PASS' };
}

async function main(): Promise<void> {
  const output = parseOutputPath(process.argv.slice(2));
  const receipt = await runCollisionProbe();
  atomicWrite(output, receipt);
  process.stdout.write(`FULL_SUITE_FIXED_PORT_OS_RECEIPT=${JSON.stringify(receipt)}\n`);
  if (receipt.overallStatus !== 'PASS') process.exitCode = 2;
}

void main().catch(error => {
  process.stderr.write(`full-suite-fixed-port-os-collision: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
