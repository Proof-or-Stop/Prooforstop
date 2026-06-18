/**
 * global-agents.ts — host-neutral thin-shim materialization of Lattice agent
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
 *   agent to fetch its authoritative instructions from the Lattice CLI via
 *   `lattice agent_prompt --role=<name>`. The shim contains NO role body.
 *
 *   Keeping the `tools:` frontmatter verbatim preserves each host's read-only
 *   sandbox (e.g. `lattice-review-*` stay read-only). Thinning the body does not
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
 * Extract the verbatim YAML frontmatter block (everything between the first two
 * `---` delimiter lines, exclusive) from a template's raw text. Returns the raw
 * frontmatter string (no surrounding delimiters, trailing newline stripped) and
 * the parsed `name` field. Throws a clear error if the template is missing
 * frontmatter or a `name:` field, because the shim cannot register a
 * `subagent_type` without them.
 *
 * The frontmatter is kept VERBATIM (including the `tools:` sandbox declaration,
 * whether inline `tools: A, B` or a multi-line YAML list) so the host's
 * mechanical role sandbox is preserved exactly.
 */
export function extractTemplateFrontmatter(
  raw: string,
  file: string,
): { frontmatter: string; name: string } {
  // Normalize CRLF so delimiter detection is line-ending agnostic.
  const text = raw.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new Error(
      `Lattice agent template ${file} is missing YAML frontmatter (must start with '---'). ` +
        `Cannot generate a Claude thin-shim without a frontmatter block.`,
    );
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new Error(
      `Lattice agent template ${file} has an unterminated frontmatter block (no closing '---').`,
    );
  }
  const frontmatterLines = lines.slice(1, endIdx);
  const frontmatter = frontmatterLines.join('\n');

  // Parse `name:` — the first top-level (non-indented) `name:` key wins.
  let name = '';
  for (const line of frontmatterLines) {
    const m = /^name:\s*(.+?)\s*$/.exec(line);
    if (m) {
      name = m[1].replace(/^["']|["']$/g, '').trim();
      break;
    }
  }
  if (!name) {
    throw new Error(
      `Lattice agent template ${file} frontmatter has no 'name:' field; cannot register a subagent_type.`,
    );
  }
  return { frontmatter, name };
}

/**
 * Build the standard imperative shim body. The body intentionally contains NO
 * role prompt content — it points the agent at the Lattice CLI single source of
 * truth. The role name is interpolated so the agent can copy/paste the command.
 */
export function buildShimBody(role: string): string {
  return [
    'Your authoritative instructions are served by the Lattice CLI (single source of truth).',
    `FIRST run: \`lattice agent_prompt --role=${role}\` and follow the returned prompt exactly.`,
    'This file is a thin pointer and intentionally contains no role body.',
  ].join('\n');
}

/**
 * Render the full thin-shim file content for a template: the verbatim
 * frontmatter block (delimited by `---`) followed by the standard shim body.
 * Deterministic so idempotency can be decided by byte comparison.
 */
export function renderAgentShim(frontmatter: string, role: string): string {
  return `---\n${frontmatter}\n---\n${buildShimBody(role)}\n`;
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
    const templatePath = join(templateDir, file);
    let raw: string;
    try {
      raw = deps.readFileSync(templatePath, 'utf8');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot read Lattice agent template ${templatePath}: ${reason}.`);
    }
    const { frontmatter, name } = extractTemplateFrontmatter(raw, file);
    // Shim filename follows the role name so Claude resolves subagent_type:<name>.
    const shimFile = `${name}.md`;
    const shimPath = join(globalDir, shimFile);
    const expected = renderAgentShim(frontmatter, name);

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
        results.push({ file, shim: shimPath, role: name, outcome: 'shim ok' });
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
            `Remove it manually so Lattice can regenerate the managed thin-shim.`,
        );
      }
      try {
        deps.writeFileSync(shimPath, expected);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`Cannot write global agent thin-shim ${shimPath}: ${reason}.`);
      }
      replaced += 1;
      results.push({ file, shim: shimPath, role: name, outcome: 'replaced' });
      continue;
    }

    try {
      deps.writeFileSync(shimPath, expected);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Cannot write global agent thin-shim ${shimPath}: ${reason}. ` +
          `Lattice resolves agent prompts from the user-global ${globalDir}; fix permissions and re-run.`,
      );
    }
    synced += 1;
    results.push({ file, shim: shimPath, role: name, outcome: 'created' });
  }

  return { globalDir, templateDir, synced, skipped, replaced, files: results };
}
