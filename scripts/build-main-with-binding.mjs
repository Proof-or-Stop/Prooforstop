#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeBuildBinding } from './full-suite-build-binding.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(projectRoot, 'packages/main');
// dist is ignored build output. Removing it makes a successful standard build
// prove every emitted file came from this invocation, not a prior checkout.
rmSync(join(packageRoot, 'dist'), { recursive: true, force: true });
const tsc = fileURLToPath(import.meta.resolve('typescript/bin/tsc'));
execFileSync(process.execPath, [tsc, '-p', join(packageRoot, 'tsconfig.json')], { cwd: projectRoot, stdio: 'inherit' });
writeBuildBinding(projectRoot);
