#!/usr/bin/env node

/**
 * global-agents-unit-smoke — pure-logic unit verification of
 * core/global-agents.ts using an injectable in-memory fs. Runs without a real
 * HOME so it never touches the user's `~/.claude/agents`.
 *
 * Covers (B-097f CHK-002, thin-shim pivot):
 *   - happy: sync writes a thin-shim regular file for every *.md template —
 *     verbatim frontmatter (tools sandbox preserved) + a CLI-fetch body that
 *     references `lattice agent_prompt --role=<name>` and contains NO role body
 *   - edge: idempotent re-run reports "shim ok"; broken link / stale full copy /
 *     old symlink / drifted shim → unlink + rewrite ("replaced")
 *   - adversarial: non-writable global dir (mkdir throws) → clear actionable
 *     error, NOT a silent project-local fallback
 */

import assert from 'node:assert/strict';
import {
  buildShimBody,
  extractTemplateFrontmatter,
  listManagedAgentBasenames,
  renderAgentShim,
  resolveAgentTemplateDir,
  resolveGlobalAgentsDir,
  syncGlobalAgents,
  type GlobalAgentsFsDeps,
} from '../core/global-agents.js';

const TEMPLATE_DIR = '/pkg/templates/agents';
const GLOBAL_DIR = '/home/tester/.claude/agents';

// Realistic template fixtures: one with a multi-line YAML tools list, one with
// inline `tools:` + a `model:` line (both frontmatter shapes Claude uses).
const TEMPLATES: Record<string, string> = {
  'lattice-implementer.md': [
    '---',
    'name: lattice-implementer',
    'description: Dedicated implementation role',
    'tools:',
    '  - Read',
    '  - Edit',
    '  - Bash',
    '---',
    'FULL ROLE BODY that must never leak into the shim.',
    'More body lines here.',
  ].join('\n'),
  'lattice-review-concept.md': [
    '---',
    'name: lattice-review-concept',
    'description: REVIEW concept reviewer',
    'model: sonnet',
    'tools: Grep, Glob, Bash',
    '---',
    'READ-ONLY reviewer body that must never leak into the shim.',
  ].join('\n'),
};
const TEMPLATE_FILES = Object.keys(TEMPLATES).sort((a, b) => a.localeCompare(b));
const ROLE_BY_FILE: Record<string, string> = {
  'lattice-implementer.md': 'lattice-implementer',
  'lattice-review-concept.md': 'lattice-review-concept',
};

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
      if (node.kind === 'symlink' && node.broken) return false;
      return true;
    },
    lstatSync(path) {
      const node = nodes.get(path);
      if (!node) throw new Error(`ENOENT: ${path}`);
      return { isSymbolicLink: () => node.kind === 'symlink' };
    },
    readFileSync(path) {
      const node = nodes.get(path);
      if (!node) throw new Error(`ENOENT: ${path}`);
      if (node.kind === 'symlink') throw new Error(`EINVAL: symlink ${path}`);
      if (node.kind === 'dir') throw new Error(`EISDIR: ${path}`);
      return node.content;
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
    writeFileSync(path, content) {
      nodes.set(path, { kind: 'file', content });
    },
    unlinkSync(path) {
      nodes.delete(path);
    },
  };
  // Seed template contents so readFileSync over template paths works.
  for (const [file, content] of Object.entries(TEMPLATES)) {
    nodes.set(`${TEMPLATE_DIR}/${file}`, { kind: 'file', content });
  }
  return { fs, nodes };
}

function expectedShim(file: string): string {
  const role = ROLE_BY_FILE[file];
  const { frontmatter } = extractTemplateFrontmatter(TEMPLATES[file], file);
  return renderAgentShim(frontmatter, role);
}

// --- resolveGlobalAgentsDir: injectable home ---
assert.equal(resolveGlobalAgentsDir('/home/tester'), '/home/tester/.claude/agents');

// --- resolveAgentTemplateDir: resolves from running module location ---
assert.match(resolveAgentTemplateDir(), /templates[\\/]agents$/, 'template dir must resolve to <packageRoot>/templates/agents');

// --- listManagedAgentBasenames: only *.md, sorted ---
{
  const { fs } = makeMemFs({ [TEMPLATE_DIR]: { kind: 'dir' } });
  assert.deepEqual(listManagedAgentBasenames(TEMPLATE_DIR, fs), [...TEMPLATE_FILES]);
}

// --- extractTemplateFrontmatter: keeps tools verbatim, parses name ---
{
  const multi = extractTemplateFrontmatter(TEMPLATES['lattice-implementer.md'], 'x');
  assert.equal(multi.name, 'lattice-implementer');
  assert.match(multi.frontmatter, /tools:\n {2}- Read\n {2}- Edit\n {2}- Bash/, 'multi-line tools list kept verbatim');
  const inline = extractTemplateFrontmatter(TEMPLATES['lattice-review-concept.md'], 'y');
  assert.equal(inline.name, 'lattice-review-concept');
  assert.match(inline.frontmatter, /tools: Grep, Glob, Bash/, 'inline tools kept verbatim');
  assert.match(inline.frontmatter, /model: sonnet/, 'model line preserved when present');
  // missing frontmatter / name → throws
  assert.throws(() => extractTemplateFrontmatter('no frontmatter here', 'z'), /missing YAML frontmatter/);
  assert.throws(() => extractTemplateFrontmatter('---\ndescription: x\n---\nbody', 'z'), /no 'name:' field/);
}

// --- buildShimBody: references the CLI fetch command + no role body ---
{
  const body = buildShimBody('lattice-implementer');
  assert.match(body, /lattice agent_prompt --role=lattice-implementer/);
  assert.match(body, /thin pointer/);
  assert.doesNotMatch(body, /FULL ROLE BODY/);
}

// --- happy: fresh sync writes a thin-shim file per template ---
{
  const { fs, nodes } = makeMemFs({ [TEMPLATE_DIR]: { kind: 'dir' } });
  const result = syncGlobalAgents({ globalDir: GLOBAL_DIR, templateDir: TEMPLATE_DIR, fs });
  assert.equal(result.synced, TEMPLATE_FILES.length);
  assert.equal(result.skipped, 0);
  assert.equal(result.replaced, 0);
  for (const file of TEMPLATE_FILES) {
    const role = ROLE_BY_FILE[file];
    const node = nodes.get(`${GLOBAL_DIR}/${role}.md`);
    assert.ok(node && node.kind === 'file', `${file} should be a regular file (not symlink)`);
    const content = (node as { content: string }).content;
    assert.equal(content, expectedShim(file), `${file} content should be the deterministic shim`);
    // tools sandbox preserved, role body absent, CLI fetch present.
    assert.match(content, /tools:/, 'shim keeps tools frontmatter');
    assert.match(content, new RegExp(`lattice agent_prompt --role=${role}`), 'shim body references CLI fetch');
    assert.doesNotMatch(content, /that must never leak into the shim/, 'role body must NOT appear in shim');
  }
  assert.ok(nodes.get(GLOBAL_DIR), 'global dir should be mkdir-ed');
}

// --- edge (idempotent): second run skips everything ("shim ok") ---
{
  const seed: Record<string, Node> = { [TEMPLATE_DIR]: { kind: 'dir' }, [GLOBAL_DIR]: { kind: 'dir' } };
  for (const file of TEMPLATE_FILES) {
    seed[`${GLOBAL_DIR}/${ROLE_BY_FILE[file]}.md`] = { kind: 'file', content: expectedShim(file) };
  }
  const { fs } = makeMemFs(seed);
  const result = syncGlobalAgents({ globalDir: GLOBAL_DIR, templateDir: TEMPLATE_DIR, fs });
  assert.equal(result.skipped, TEMPLATE_FILES.length);
  assert.equal(result.synced, 0);
  assert.equal(result.replaced, 0);
  assert.ok(result.files.every(f => f.outcome === 'shim ok'));
}

// --- edge (old full copy / broken symlink / old symlink / drifted shim → replaced) ---
{
  const seed: Record<string, Node> = { [TEMPLATE_DIR]: { kind: 'dir' }, [GLOBAL_DIR]: { kind: 'dir' } };
  // file 0: old full-content copy (the pre-pivot symlink target materialized)
  seed[`${GLOBAL_DIR}/${ROLE_BY_FILE[TEMPLATE_FILES[0]]}.md`] = { kind: 'file', content: TEMPLATES[TEMPLATE_FILES[0]] };
  // file 1: old symlink (pre-pivot) → must be replaced with a real file
  seed[`${GLOBAL_DIR}/${ROLE_BY_FILE[TEMPLATE_FILES[1]]}.md`] = { kind: 'symlink', target: `${TEMPLATE_DIR}/${TEMPLATE_FILES[1]}` };
  const { fs, nodes } = makeMemFs(seed);
  const result = syncGlobalAgents({ globalDir: GLOBAL_DIR, templateDir: TEMPLATE_DIR, fs });
  assert.equal(result.replaced, TEMPLATE_FILES.length, 'old copy + old symlink should both be replaced');
  assert.equal(result.skipped, 0);
  for (const file of TEMPLATE_FILES) {
    const node = nodes.get(`${GLOBAL_DIR}/${ROLE_BY_FILE[file]}.md`);
    assert.ok(node && node.kind === 'file', `${file} should now be a real file`);
    assert.equal((node as { content: string }).content, expectedShim(file));
  }
}

// --- edge (broken symlink → replaced) ---
{
  const seed: Record<string, Node> = { [TEMPLATE_DIR]: { kind: 'dir' }, [GLOBAL_DIR]: { kind: 'dir' } };
  for (const file of TEMPLATE_FILES) {
    seed[`${GLOBAL_DIR}/${ROLE_BY_FILE[file]}.md`] = { kind: 'symlink', target: '/gone/old.md', broken: true };
  }
  const { fs, nodes } = makeMemFs(seed);
  const result = syncGlobalAgents({ globalDir: GLOBAL_DIR, templateDir: TEMPLATE_DIR, fs });
  assert.equal(result.replaced, TEMPLATE_FILES.length, 'broken links should be replaced');
  for (const file of TEMPLATE_FILES) {
    const node = nodes.get(`${GLOBAL_DIR}/${ROLE_BY_FILE[file]}.md`);
    assert.ok(node && node.kind === 'file');
    assert.equal((node as { content: string }).content, expectedShim(file));
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
  // override existsSync so template dir reads as absent
  const fs2: GlobalAgentsFsDeps = { ...fs, existsSync: () => false };
  let threw = false;
  try {
    syncGlobalAgents({ globalDir: GLOBAL_DIR, templateDir: TEMPLATE_DIR, fs: fs2 });
  } catch (err) {
    threw = true;
    assert.match(err instanceof Error ? err.message : String(err), /template dir not found/);
  }
  assert.equal(threw, true);
}

console.log('PASS global-agents-unit-smoke (thin-shim happy/idempotent/replaced/broken/non-writable/missing-template)');
