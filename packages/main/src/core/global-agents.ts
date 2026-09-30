/**
 * global-agents.ts — host-neutral thin-shim materialization of Proof-or-Stop agent
 * adapters into the user-global `~/.claude/agents` directory (B-097f).
 *
 * Contract source of truth:
 *   docs/requirements/decisions/lifecycle-artifact-scope.md
 *   §"Policy: host-neutral prompt content, thin host adapters (B-097f)"
 *
 * Design pivot (symlink → thin-shim):
 *   Prompt CONTENT must NEVER be materialized under a host directory — a symlink
 *   exposes the full body just as much as a copy does. The single source of truth
 *   for every role body is the package prompt registry
 *   (`promptRegistryManifest()` / templates/agents). Each Claude role keeps only a
 *   *thin shim* file: the registry template's frontmatter (name/description/tools,
 *   plus model if present) followed by a standard imperative body that tells the
 *   agent to fetch its authoritative instructions from the Proof-or-Stop via
 *   `proof-or-stop agent_prompt --role=<name>`. The five modular REVIEW roles instead
 *   use the canonical `review_run_start` bootstrap so the host receives exactly
 *   one mode-selected role body. Every shim contains NO role body.
 *
 *   Keeping the `tools:` frontmatter verbatim preserves each host's read-only
 *   sandbox (e.g. `proof-or-stop-review-*` stay read-only). Thinning the body does not
 *   weaken the sandbox.
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
  readFileSync as fsReadFileSync,
  readdirSync as fsReaddirSync,
  unlinkSync as fsUnlinkSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimePackageRoot as installedPackageRoot } from './runtime-layout.js';
import {
  projectPromptAsset,
} from './prompt-registry.js';
export {
  buildReviewerRunBootstrapBody,
  buildShimBody,
  renderAgentShim,
  extractTemplateFrontmatter,
  renderReviewerRunBootstrap,
  renderReviewerRunBootstrapForTemplate,
} from './prompt-registry.js';

/**
 * Resolve the user-global Claude agents directory: `<home>/.claude/agents`.
 * `home` is injectable for tests; defaults to `os.homedir()` which honors $HOME
 * on POSIX.
 */
export function resolveGlobalAgentsDir(home: string = osHomedir()): string {
  return join(home, '.claude', 'agents');
}

/**
 * Resolve the running CLI package's `templates/agents` directory from the
 * installation layout (`runtime-layout.ts` → packageRoot → `templates/agents`).
 * NEVER a hardcoded dev-checkout path. Robust for `npm i -g` installs, local dev
 * and the CLI bundle alike.
 *
 * An explicit `moduleUrl` keeps the old contract: that module is taken to live
 * at `<packageRoot>/dist/core/<name>.js` (or `src/core/<name>.ts`), so
 * packageRoot is two levels up from its directory.
 */
export function resolveAgentTemplateDir(moduleUrl?: string): string {
  // No explicit module URL: use the installation layout, which also holds
  // inside the CLI bundle where this module's import.meta.url is the bundle.
  const packageRoot = moduleUrl === undefined
    ? installedPackageRoot()
    : join(dirname(fileURLToPath(moduleUrl)), '..', '..');
  return join(packageRoot, 'templates', 'agents');
}

export interface GlobalAgentsFsDeps {
  existsSync: (path: string) => boolean;
  lstatSync: (path: string) => { isSymbolicLink: () => boolean };
  readFileSync: (path: string, encoding: 'utf8') => string;
  readdirSync: (path: string) => string[];
  mkdirSync: (path: string, opts: { recursive: boolean }) => void;
  writeFileSync: (path: string, content: string) => void;
  unlinkSync: (path: string) => void;
}

const DEFAULT_FS_DEPS: GlobalAgentsFsDeps = {
  existsSync: fsExistsSync,
  lstatSync: fsLstatSync,
  readFileSync: (path, encoding) => fsReadFileSync(path, encoding),
  readdirSync: fsReaddirSync,
  mkdirSync: fsMkdirSync,
  writeFileSync: fsWriteFileSync,
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
  /** Absolute path of the created/verified shim file. */
  shim: string;
  /** Role name parsed from the template basename / frontmatter. */
  role: string;
  outcome: 'shim ok' | 'replaced' | 'created';
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
 * Generate a thin shim into the global agents dir for every `*.md` template.
 *
 * For each template:
 *   - parse its frontmatter (name/description/tools, model if present) verbatim,
 *   - write `<globalDir>/<name>.md` = that frontmatter + the standard CLI-fetch
 *     body. The shim keeps `tools:` verbatim and contains NO role body.
 *
 * Idempotent:
 *   - existing file whose content byte-equals the expected shim → skip ("shim ok")
 *   - old full-content copy / old symlink / broken link / stale shim →
 *     unlink + rewrite ("replaced")
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
      `Proof-or-Stop agent template dir not found: ${templateDir}. ` +
        `The running CLI package is missing templates/agents; reinstall or rebuild the Proof-or-Stop.`,
    );
  }

  // mkdir -p the global dir; surface a clear, actionable error (do NOT fall back).
  try {
    deps.mkdirSync(globalDir, { recursive: true });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot create global agents dir ${globalDir}: ${reason}. ` +
        `Proof-or-Stop resolves all agent prompts from this user-global directory and will not fall back ` +
        `to per-project copies. Fix permissions (e.g. ensure $HOME/.claude is writable) and re-run.`,
    );
  }

  const files = listManagedAgentBasenames(templateDir, opts.fs);
  const results: SyncGlobalAgentsFileResult[] = [];
  let synced = 0;
  let skipped = 0;
  let replaced = 0;

  for (const file of files) {
    const templatePath = join(templateDir, file);
    let raw: string;
    try {
      raw = deps.readFileSync(templatePath, 'utf8');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot read Proof-or-Stop agent template ${templatePath}: ${reason}.`);
    }
    const projection = projectPromptAsset({kind:'global-shim',raw,file}, 'claude');
    const canonicalRole = projection.roleId;
    // New shim filenames follow the canonical role even for a legacy input.
    const shimFile = `${projection.roleId}.md`;
    const shimPath = join(globalDir, shimFile);
    const expected = projection.materialized;

    // Probe lstat independently so a stale symlink / broken link is detected and
    // replaced (a broken symlink reports existsSync=false but lstat succeeds).
    let linkPresent = false;
    let isSymlink = false;
    try {
      const stat = deps.lstatSync(shimPath);
      linkPresent = true;
      isSymlink = stat.isSymbolicLink();
    } catch {
      linkPresent = false;
    }

    // A regular file already byte-equal to the expected shim → idempotent skip.
    // Symlinks are never "ok" — content must live as a real file, not a link.
    if (linkPresent && !isSymlink) {
      let current: string | null = null;
      try {
        current = deps.readFileSync(shimPath, 'utf8');
      } catch {
        current = null;
      }
      if (current === expected) {
        skipped += 1;
        results.push({ file, shim: shimPath, role: canonicalRole, outcome: 'shim ok' });
        continue;
      }
    }

    if (linkPresent) {
      // Old full-content copy, stale shim, old symlink, or broken link → unlink + rewrite.
      try {
        deps.unlinkSync(shimPath);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Cannot replace stale global agent file ${shimPath}: ${reason}. ` +
            `Remove it manually so Proof-or-Stop can regenerate the managed thin-shim.`,
        );
      }
      try {
        deps.writeFileSync(shimPath, expected);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`Cannot write global agent thin-shim ${shimPath}: ${reason}.`);
      }
      replaced += 1;
      results.push({ file, shim: shimPath, role: canonicalRole, outcome: 'replaced' });
      continue;
    }

    try {
      deps.writeFileSync(shimPath, expected);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Cannot write global agent thin-shim ${shimPath}: ${reason}. ` +
          `Proof-or-Stop resolves agent prompts from the user-global ${globalDir}; fix permissions and re-run.`,
      );
    }
    synced += 1;
    results.push({ file, shim: shimPath, role: canonicalRole, outcome: 'created' });
  }

  return { globalDir, templateDir, synced, skipped, replaced, files: results };
}
