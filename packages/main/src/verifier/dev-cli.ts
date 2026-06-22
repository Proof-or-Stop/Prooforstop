#!/usr/bin/env node
/**
 * dev-cli.ts — unified development launcher provided by the framework
 *
 * Usage (run from the project directory):
 *   lattice serve              → core + Dashboard
 */

import { spawn, ChildProcess } from 'child_process';
import { resolve, join } from 'path';
import { existsSync } from 'fs';

const root = process.cwd();

// Deterministic port
function stablePort(s: string, offset: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return 10000 + (Math.abs(h + offset * 7919) % 50000);
}

const wsPort = stablePort(root, 4);

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
const coreEnv: Record<string, string> = { ...process.env as Record<string, string>, LATTICE_SERVE_PORT: String(wsPort) };

const core = spawn('npx', ['tsx', debugFile], {
  cwd: root,
  env: coreEnv,
  stdio: ['ignore', 'inherit', 'inherit'],
});
children.push(core);

// Wait for core to start
await new Promise(r => setTimeout(r, 3000));

// 2. Start serve (Dashboard)
const serve = spawn('node', [servePath], {
  cwd: root,
  stdio: ['ignore', 'inherit', 'inherit'],
});
children.push(serve);

// Any child process exits → all exit
for (const c of children) {
  c.on('exit', () => { cleanup(); process.exit(0); });
}
