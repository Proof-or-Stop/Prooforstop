#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = process.env.KOALA_DESKTOP_BINARY || process.argv[2] || defaultHostBinary();

function defaultHostBinary() {
  const platform = process.platform === 'darwin' ? 'macos' : process.platform;
  const arch = process.arch;
  if (platform === 'macos' && (arch === 'x64' || arch === 'arm64')) {
    return join(repoRoot, 'dist', 'desktop', `koala-macos-${arch}`);
  }
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) {
    return join(repoRoot, 'dist', 'desktop', `koala-linux-${arch}`);
  }
  if (platform === 'win32' && arch === 'x64') {
    return join(repoRoot, 'dist', 'desktop', 'koala-win-x64.exe');
  }
  throw new Error(`Unsupported host binary for ${process.platform}/${process.arch}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertIncludes(text, needle, label) {
  assert(text.includes(needle), `${label} missing "${needle}"\n--- output ---\n${text}`);
}

function runBinary(args, label) {
  try {
    return execFileSync(binary, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        KOALA_ACTIVITY_RECORD_READONLY: '1',
      },
    });
  } catch (error) {
    const stdout = error.stdout ? String(error.stdout) : '';
    const stderr = error.stderr ? String(error.stderr) : '';
    throw new Error(`${label} failed with exit ${error.status ?? 'unknown'}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
  }
}

if (!existsSync(binary)) {
  throw new Error(`Desktop Koala binary is missing: ${binary}\nRun npm run package:desktop:host first, or pass KOALA_DESKTOP_BINARY=/path/to/koala.`);
}

const help = runBinary(['help'], 'core help');
assertIncludes(help, 'story_create', 'core help');
assertIncludes(help, 'session_brief', 'core help');

const utilsHelp = runBinary(['aux_doc_list', '--help'], 'utils command help');
assertIncludes(utilsHelp, 'aux_doc_list', 'utils command help');
assertIncludes(utilsHelp, '文档', 'utils command help');

console.log(`desktop package verified: ${binary}`);
