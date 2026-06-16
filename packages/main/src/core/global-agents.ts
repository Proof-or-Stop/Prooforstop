/**
 * global-agents.ts — single-source materialization of Lattice agent prompts into
 * the user-global `~/.claude/agents` directory (B-097f).
 *
 * Contract source of truth:
 *   docs/requirements/decisions/lifecycle-artifact-scope.md
 *   §"Policy: global agents single source (Claude-side runtime-owned, B-097f)"
 *
 * Claude Code can only resolve `subagent_type: lattice-*` from on-disk
 * `.claude/agents/*.md`. Rather than copy the 16 managed templates into every
 * project, Lattice materializes them exactly once into the user-global
 * `~/.claude/agents` as symlinks pointing back at the running CLI package's
 * `templates/agents`. Editing the CLI templates is reflected everywhere with no
 * per-project snapshot drift.
 *
 * This module is pure logic with injectable fs deps so it unit-tests without a
 * real HOME. It never silently falls back to project-local materialization: if
 * the global directory cannot be created or written, it throws a clear,
 * actionable error.
 */

import {
  existsSync as fsExistsSync,
  lstatSync as fsLstatSync,
  mkdirSync as fsMkdirSync,
  readdirSync as fsReaddirSync,
  readlinkSync as fsReadlinkSync,
  symlinkSync as fsSymlinkSync,
  unlinkSync as fsUnlinkSync,
} from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the user-global Claude agents directory: `<home>/.claude/agents`.
 * `home` is injectable for tests; defaults to `os.homedir()` which honors $HOME
 * on POSIX.
 */
export function resolveGlobalAgentsDir(home: string = osHomedir()): string {
  return join(home, '.claude', 'agents');
}

/**
 * Resolve the running CLI package's `templates/agents` directory, resolved from
 * this module's own location (`fileURLToPath(import.meta.url)` → packageRoot →
 * `templates/agents`). NEVER a hardcoded dev-checkout path. Robust for
 * `npm i -g` installs and local dev alike.
 *
 * This module lives at `<packageRoot>/dist/core/global-agents.js` (or
 * `<packageRoot>/src/core/global-agents.ts` pre-build), so packageRoot is two
 * levels up from this file's directory.
 */
export function resolveAgentTemplateDir(moduleUrl: string = import.meta.url): string {
  const here = dirname(fileURLToPath(moduleUrl));
  const packageRoot = join(here, '..', '..');
  return join(packageRoot, 'templates', 'agents');
}

export interface GlobalAgentsFsDeps {
  existsSync: (path: string) => boolean;
  lstatSync: (path: string) => { isSymbolicLink: () => boolean };
  readlinkSync: (path: string) => string;
  readdirSync: (path: string) => string[];
  mkdirSync: (path: string, opts: { recursive: boolean }) => void;
  symlinkSync: (target: string, path: string) => void;
  unlinkSync: (path: string) => void;
}

const DEFAULT_FS_DEPS: GlobalAgentsFsDeps = {
  existsSync: fsExistsSync,
  lstatSync: fsLstatSync,
  readlinkSync: fsReadlinkSync,
  readdirSync: fsReaddirSync,
  mkdirSync: fsMkdirSync,
  symlinkSync: fsSymlinkSync,
  unlinkSync: fsUnlinkSync,
};

export interface SyncGlobalAgentsOptions {
  /** Global agents dir; defaults to resolveGlobalAgentsDir(). */
  globalDir?: string;
  /** Template source dir; defaults to resolveAgentTemplateDir(). */
  templateDir?: string;
  /** Injectable fs for tests. */
  fs?: Partial<GlobalAgentsFsDeps>;
}

export interface SyncGlobalAgentsFileResult {
  file: string;
  /** Absolute path of the created/verified symlink. */
  link: string;
  /** Absolute symlink target. */
  target: string;
  outcome: 'symlink ok' | 'replaced' | 'created';
}

export interface SyncGlobalAgentsResult {
  globalDir: string;
  templateDir: string;
  synced: number;
  skipped: number;
  replaced: number;
  files: SyncGlobalAgentsFileResult[];
}

/**
 * List managed agent template basenames (`*.md`) from the template dir, sorted.
 * Exported so callers (cli-init / managed-assets / doctor) derive the exact
 * managed basename set from the running CLI package rather than hardcoding.
 */
export function listManagedAgentBasenames(
  templateDir: string = resolveAgentTemplateDir(),
  fs: Partial<GlobalAgentsFsDeps> = {},
): string[] {
  const deps = { ...DEFAULT_FS_DEPS, ...fs };
  if (!deps.existsSync(templateDir)) return [];
  return deps
    .readdirSync(templateDir)
    .filter(file => file.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Symlink every `*.md` from the template dir into the global agents dir.
 *
 * Idempotent:
 *   - existing correct symlink → skip ("symlink ok")
 *   - broken link / stale copy / wrong target → unlink + recreate ("replaced")
 *   - missing → create ("created", counted toward synced)
 *
 * `mkdir -p` the global dir if missing. If the dir cannot be created/written,
 * throws a clear, actionable Error. NEVER silently falls back to project-local.
 */
export function syncGlobalAgents(opts: SyncGlobalAgentsOptions = {}): SyncGlobalAgentsResult {
  const deps = { ...DEFAULT_FS_DEPS, ...opts.fs };
  const globalDir = opts.globalDir ?? resolveGlobalAgentsDir();
  const templateDir = opts.templateDir ?? resolveAgentTemplateDir();

  if (!deps.existsSync(templateDir)) {
    throw new Error(
      `Lattice agent template dir not found: ${templateDir}. ` +
        `The running CLI package is missing templates/agents; reinstall or rebuild the Lattice CLI.`,
    );
  }

  // mkdir -p the global dir; surface a clear, actionable error (do NOT fall back).
  try {
    deps.mkdirSync(globalDir, { recursive: true });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot create global agents dir ${globalDir}: ${reason}. ` +
        `Lattice resolves all agent prompts from this user-global directory and will not fall back ` +
        `to per-project copies. Fix permissions (e.g. ensure $HOME/.claude is writable) and re-run.`,
    );
  }

  const files = listManagedAgentBasenames(templateDir, opts.fs);
  const results: SyncGlobalAgentsFileResult[] = [];
  let synced = 0;
  let skipped = 0;
  let replaced = 0;

  for (const file of files) {
    const target = join(templateDir, file);
    const link = join(globalDir, file);

    let existing = false;
    try {
      existing = deps.existsSync(link);
    } catch {
      existing = false;
    }

    // A broken symlink reports existsSync === false (target gone) but lstat
    // still succeeds — probe lstat independently so stale/broken links are
    // detected and replaced rather than skipped.
    let isManaged = false;
    let currentTarget: string | null = null;
    let linkPresent = existing;
    try {
      const stat = deps.lstatSync(link);
      linkPresent = true;
      if (stat.isSymbolicLink()) {
        try {
          currentTarget = deps.readlinkSync(link);
          isManaged = currentTarget === target;
        } catch {
          isManaged = false;
        }
      }
    } catch {
      // lstat failed → nothing at this path.
      linkPresent = false;
    }

    if (linkPresent && isManaged) {
      skipped += 1;
      results.push({ file, link, target, outcome: 'symlink ok' });
      continue;
    }

    if (linkPresent) {
      // Wrong target, stale copy, or broken link → unlink + recreate.
      try {
        deps.unlinkSync(link);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Cannot replace stale global agent file ${link}: ${reason}. ` +
            `Remove it manually so Lattice can recreate the managed symlink.`,
        );
      }
      try {
        deps.symlinkSync(target, link);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`Cannot create symlink ${link} -> ${target}: ${reason}.`);
      }
      replaced += 1;
      results.push({ file, link, target, outcome: 'replaced' });
      continue;
    }

    try {
      deps.symlinkSync(target, link);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Cannot create symlink ${link} -> ${target}: ${reason}. ` +
          `Lattice resolves agent prompts from the user-global ${globalDir}; fix permissions and re-run.`,
      );
    }
    synced += 1;
    results.push({ file, link, target, outcome: 'created' });
  }

  return { globalDir, templateDir, synced, skipped, replaced, files: results };
}
