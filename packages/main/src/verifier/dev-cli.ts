#!/usr/bin/env node
/**
 * dev-cli.ts — unified development launcher provided by the framework
 *
 * Usage (run from the project directory):
 *   koala-dev              → core + Dashboard
 *   koala-dev --web        → core + vite + Dashboard
 *   koala-dev --cli        → core + CLI shell + Dashboard
 *   koala-dev --web --cli  → core + vite + CLI + Dashboard
 */

import { spawn, ChildProcess } from 'child_process';
import { resolve, join } from 'path';
import { existsSync } from 'fs';

const args = process.argv.slice(2);
const withWeb = args.includes('--web');
const withCli = args.includes('--cli');
const root = process.cwd();

// Deterministic port
function stablePort(s: string, offset: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return 10000 + (Math.abs(h + offset * 7919) % 50000);
}

const wsPort = stablePort(root, 4);
const vitePort = stablePort(root, 5);

// Find the project's debug.ts entry
const debugFile = ['src/core/debug.ts', 'src/core/debug.js', 'src/debug.ts', 'debug.ts'].find(f =>
  existsSync(join(root, f))
);
if (!debugFile) {
  console.error('Cannot find debug entry file (src/core/debug.ts)');
  process.exit(1);
}

// Find serve.js
const servePath = resolve(import.meta.dirname || __dirname, 'serve.js');

const children: ChildProcess[] = [];
function cleanup() {
  for (const c of children) { try { c.kill(); } catch {} }
}
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

// 1. Start core
const coreEnv: Record<string, string> = { ...process.env as Record<string, string>, KOALA_SERVE_PORT: String(wsPort) };
if (withCli) coreEnv.KOALA_SHELL = 'cli';

const core = spawn('npx', ['tsx', debugFile], {
  cwd: root,
  env: coreEnv,
  stdio: withCli ? 'inherit' : ['ignore', 'inherit', 'inherit'],
});
children.push(core);

// Wait for core to start
await new Promise(r => setTimeout(r, 3000));

// 2. Optionally start vite
if (withWeb) {
  const vite = spawn('npx', ['vite', '--port', String(vitePort)], {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  children.push(vite);
  await new Promise(r => setTimeout(r, 1000));
}

// 3. Start serve (Dashboard)
const serve = spawn('node', [servePath], {
  cwd: root,
  stdio: ['ignore', 'inherit', 'inherit'],
});
children.push(serve);

// Any child process exits → all exit
for (const c of children) {
  c.on('exit', () => { cleanup(); process.exit(0); });
}
