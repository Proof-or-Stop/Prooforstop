#!/usr/bin/env bun

import { resolve } from 'node:path';
import { verifyHistoricalReplayArtifact } from '../core/historical-replay-artifact.js';

const result = verifyHistoricalReplayArtifact(resolve(process.cwd()));
if (!result.ok) {
  console.error(`historical replay artifact rejected: ${result.reasons.join('; ')}`);
  process.exit(1);
}

console.log('historical replay artifact admission PASS');
