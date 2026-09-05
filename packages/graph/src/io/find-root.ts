/** Locates the nearest Proof-or-Stop repository root. */
import fs from 'node:fs';
import path from 'node:path';
import { STORY_ROOTS } from '../core/machine.js';

export interface RootProbe {
  readonly root: string | null;
  readonly reason: string;
}

export function findRoot(start: string): RootProbe {
  let dir = path.resolve(start);
  for (;;) {
    for (const r of STORY_ROOTS) {
      if (fs.existsSync(path.join(dir, r))) return { root: dir, reason: `found ${r}` };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {
    root: null,
    reason: `no ${STORY_ROOTS.join(' or ')} directory found from ${path.resolve(start)} upward`,
  };
}
