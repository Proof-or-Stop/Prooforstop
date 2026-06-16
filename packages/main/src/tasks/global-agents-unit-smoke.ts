#!/usr/bin/env node

/**
 * global-agents-unit-smoke — pure-logic unit verification of
 * core/global-agents.ts using an injectable in-memory fs. Runs without a real
 * HOME so it never touches the user's `~/.claude/agents`.
 *
 * Covers (B-097f CHK-002):
 *   - happy: sync creates a symlink for every *.md template pointing at the
 *     CLI package templates dir
 *   - edge: idempotent re-run reports "symlink ok"; broken link / stale copy /
 *     wrong target → unlink + recreate ("replaced")
 *   - adversarial: non-writable global dir (mkdir throws) → clear actionable
 *     error, NOT a silent project-local fallback
 */

import assert from 'node:assert/strict';
import {
  listManagedAgentBasenames,
  resolveAgentTemplateDir,
  resolveGlobalAgentsDir,
  syncGlobalAgents,
  type GlobalAgentsFsDeps,
} from '../core/global-agents.js';

const TEMPLATE_DIR = '/pkg/templates/agents';
const GLOBAL_DIR = '/home/tester/.claude/agents';
const TEMPLATE_FILES = ['lattice-implementer.md', 'lattice-review-concept.md', 'product-reviewer.md'];

type Node =
  | { kind: 'dir' }
  | { kind: 'file'; content: string }
  | { kind: 'symlink'; target: string; broken?: boolean };

/** In-memory fs honoring the GlobalAgentsFsDeps surface. */
function makeMemFs(seed: Record<string, Node>, opts: { mkdirThrows?: boolean } = {}): {
  fs: GlobalAgentsFsDeps;
  nodes: Map<string, Node>;
} {
  const nodes = new Map<string, Node>(Object.entries(seed));
  const fs: GlobalAgentsFsDeps = {
    existsSync(path) {
      const node = nodes.get(path);
      if (!node) return false;
      // A broken symlink resolves to a missing target → existsSync false.
      if (node.kind === 'symlink' && node.broken) return false;
      return true;
    },
    lstatSync(path) {
      const node = nodes.get(path);
      if (!node) {
        const err = new Error(`ENOENT: ${path}`);
        throw err;
      }
      return { isSymbolicLink: () => node.kind === 'symlink' };
    },
    readlinkSync(path) {
      const node = nodes.get(path);
      if (!node || node.kind !== 'symlink') throw new Error(`EINVAL: not a symlink ${path}`);
      return node.target;
    },
    readdirSync(path) {
      if (path !== TEMPLATE_DIR) throw new Error(`unexpected readdir ${path}`);
      return [...TEMPLATE_FILES, 'README.txt'];
    },
    mkdirSync(_path, _o) {
      if (opts.mkdirThrows) {
        const err: NodeJS.ErrnoException = new Error('EACCES: permission denied');
        err.code = 'EACCES';
        throw err;
      }
      nodes.set(_path, { kind: 'dir' });
    },
    symlinkSync(target, path) {
      nodes.set(path, { kind: 'symlink', target });
    },
    unlinkSync(path) {
      nodes.delete(path);
    },
  };
  return { fs, nodes };
}

// --- resolveGlobalAgentsDir: injectable home ---
assert.equal(resolveGlobalAgentsDir('/home/tester'), '/home/tester/.claude/agents');

// --- resolveAgentTemplateDir: resolves from running module location, ends in templates/agents ---
const tplDir = resolveAgentTemplateDir();
assert.match(tplDir, /templates[\\/]agents$/, 'template dir must resolve to <packageRoot>/templates/agents');

// --- listManagedAgentBasenames: only *.md, sorted ---
{
  const { fs } = makeMemFs({ [TEMPLATE_DIR]: { kind: 'dir' } });
  const basenames = listManagedAgentBasenames(TEMPLATE_DIR, fs);
  assert.deepEqual(basenames, [...TEMPLATE_FILES].sort((a, b) => a.localeCompare(b)));
}

// --- happy: fresh sync creates a symlink per template ---
{
  const { fs, nodes } = makeMemFs({ [TEMPLATE_DIR]: { kind: 'dir' } });
  const result = syncGlobalAgents({ globalDir: GLOBAL_DIR, templateDir: TEMPLATE_DIR, fs });
  assert.equal(result.synced, TEMPLATE_FILES.length);
  assert.equal(result.skipped, 0);
  assert.equal(result.replaced, 0);
  for (const file of TEMPLATE_FILES) {
    const node = nodes.get(`${GLOBAL_DIR}/${file}`);
    assert.ok(node && node.kind === 'symlink', `${file} should be a symlink`);
    assert.equal((node as { target: string }).target, `${TEMPLATE_DIR}/${file}`);
  }
  assert.ok(nodes.get(GLOBAL_DIR), 'global dir should be mkdir-ed');
}

// --- edge (idempotent): second run skips everything ("symlink ok") ---
{
  const seed: Record<string, Node> = { [TEMPLATE_DIR]: { kind: 'dir' }, [GLOBAL_DIR]: { kind: 'dir' } };
  for (const file of TEMPLATE_FILES) {
    seed[`${GLOBAL_DIR}/${file}`] = { kind: 'symlink', target: `${TEMPLATE_DIR}/${file}` };
  }
  const { fs } = makeMemFs(seed);
  const result = syncGlobalAgents({ globalDir: GLOBAL_DIR, templateDir: TEMPLATE_DIR, fs });
  assert.equal(result.skipped, TEMPLATE_FILES.length);
  assert.equal(result.synced, 0);
  assert.equal(result.replaced, 0);
  assert.ok(result.files.every(f => f.outcome === 'symlink ok'));
}

// --- edge (broken link / stale copy / wrong target → replaced) ---
{
  const seed: Record<string, Node> = { [TEMPLATE_DIR]: { kind: 'dir' }, [GLOBAL_DIR]: { kind: 'dir' } };
  // file 0: broken symlink (target missing)
  seed[`${GLOBAL_DIR}/${TEMPLATE_FILES[0]}`] = { kind: 'symlink', target: '/gone/old.md', broken: true };
  // file 1: stale plain-file copy
  seed[`${GLOBAL_DIR}/${TEMPLATE_FILES[1]}`] = { kind: 'file', content: '# stale copy' };
  // file 2: symlink to wrong target
  seed[`${GLOBAL_DIR}/${TEMPLATE_FILES[2]}`] = { kind: 'symlink', target: '/elsewhere/x.md' };
  const { fs, nodes } = makeMemFs(seed);
  const result = syncGlobalAgents({ globalDir: GLOBAL_DIR, templateDir: TEMPLATE_DIR, fs });
  assert.equal(result.replaced, TEMPLATE_FILES.length, 'broken/stale/wrong-target should all be replaced');
  assert.equal(result.skipped, 0);
  for (const file of TEMPLATE_FILES) {
    const node = nodes.get(`${GLOBAL_DIR}/${file}`);
    assert.ok(node && node.kind === 'symlink');
    assert.equal((node as { target: string }).target, `${TEMPLATE_DIR}/${file}`);
  }
}

// --- adversarial: non-writable global dir → clear actionable error, no fallback ---
{
  const { fs } = makeMemFs({ [TEMPLATE_DIR]: { kind: 'dir' } }, { mkdirThrows: true });
  let threw = false;
  try {
    syncGlobalAgents({ globalDir: GLOBAL_DIR, templateDir: TEMPLATE_DIR, fs });
  } catch (err) {
    threw = true;
    const msg = err instanceof Error ? err.message : String(err);
    assert.match(msg, /Cannot create global agents dir/, 'error must name the failed global dir');
    assert.match(msg, /will not fall back/, 'error must state it does not fall back to project-local');
  }
  assert.equal(threw, true, 'non-writable global dir must throw, not silently succeed');
}

// --- adversarial: missing template dir → clear error ---
{
  const { fs } = makeMemFs({});
  let threw = false;
  try {
    syncGlobalAgents({ globalDir: GLOBAL_DIR, templateDir: TEMPLATE_DIR, fs });
  } catch (err) {
    threw = true;
    assert.match(err instanceof Error ? err.message : String(err), /template dir not found/);
  }
  assert.equal(threw, true);
}

console.log('PASS global-agents-unit-smoke (happy/idempotent/replaced/non-writable/missing-template)');
