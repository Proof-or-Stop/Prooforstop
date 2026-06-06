/**
 * validate-docs-drift — pure function: scan koala command references in CLAUDE.md vs registry command name alignment.
 *
 * Two directions:
 *   - missing: md references `koala <cmd>` but it's not registered in registry → docs promise a non-existent command
 *   - stale:   registry has it but md never mentions it → advisory (docs lag, non-blocking)
 *
 * Only parses lines starting with koala inside fenced bash code blocks (within ```bash / ```).
 * allowlist excludes known exceptions (e.g. YAGNI commands).
 *
 * B-805f CHK-001
 */

export interface DocsDriftResult {
  /** Commands referenced in md but not registered in registry */
  missing: string[];
  /** Commands in registry but not mentioned in md (advisory) */
  stale: string[];
}

/**
 * Extracts all `koala <cmd>` command names from fenced bash code blocks in markdown text.
 *
 * Only matches lines inside code blocks fenced with ``` or ```bash.
 */
export function extractKoalaCommands(mdContent: string): Set<string> {
  const commands = new Set<string>();
  const lines = mdContent.split('\n');
  let inFencedBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    // Detect fenced block start/end
    if (trimmed.startsWith('```')) {
      if (inFencedBlock) {
        // closing fence
        inFencedBlock = false;
      } else {
        // opening fence — only match bash / sh / no-language-tag code blocks
        const lang = trimmed.slice(3).trim().toLowerCase();
        inFencedBlock = lang === '' || lang === 'bash' || lang === 'sh'
          || lang === 'shell';
      }
      continue;
    }

    if (!inFencedBlock) continue;

    // Inside fenced block, match koala <cmd> pattern
    // Support optional $ / # prefix and whitespace at line start
    const match = trimmed.match(/(?:^[$#]\s+)?koala\s+([a-z][a-z0-9_]*)/);
    if (match) {
      commands.add(match[1]);
    }
  }

  return commands;
}

/**
 * Core pure function: compare koala commands referenced in markdown vs commands actually registered in registry.
 *
 * @param mdContent   - CLAUDE.md text content (can be multiple md files concatenated)
 * @param registryNames - set of command names returned by registry.list()
 * @param allowlist   - whitelist of commands not to report as missing (e.g. YAGNI commands)
 */
export function checkDocsDrift(
  mdContent: string,
  registryNames: Set<string>,
  allowlist: Set<string> = new Set(),
): DocsDriftResult {
  const mdCommands = extractKoalaCommands(mdContent);

  // Internal commands (starting with _) are not included in stale check
  const INTERNAL_PREFIX = '_';
  // Commonly ignored commands (help/status/init etc. also ignored in audit-scan)
  const SCAN_IGNORE = new Set(['help', 'init', 'status']);

  const missing: string[] = [];
  const stale: string[] = [];

  // missing: present in md but not in registry
  for (const cmd of mdCommands) {
    if (allowlist.has(cmd)) continue;
    if (SCAN_IGNORE.has(cmd)) continue;
    if (!registryNames.has(cmd)) {
      missing.push(cmd);
    }
  }

  // stale: present in registry but not mentioned in md
  for (const cmd of registryNames) {
    if (cmd.startsWith(INTERNAL_PREFIX)) continue;
    if (SCAN_IGNORE.has(cmd)) continue;
    if (!mdCommands.has(cmd)) {
      stale.push(cmd);
    }
  }

  missing.sort();
  stale.sort();

  return { missing, stale };
}

// ── Gate result type (for preflight integration) ──

export interface DocsDriftGateResult {
  provider: 'koala-docs-drift';
  status: 'pass' | 'fail' | 'skipped';
  summary: string;
  missing: string[];
  stale: string[];
}

/**
 * Known YAGNI command whitelist (aligned with audit-scan.ts EXPLICIT_YAGNI_COMMANDS).
 * Commands explicitly marked as "do not build this CLI" in CLAUDE.md; not reported as missing when scanned.
 */
export const DOCS_DRIFT_ALLOWLIST = new Set<string>([
  'audit_config_set',
  // utils/bootstrap-only aux command: documented for local Koala dev env, not core registry.
  'aux_scan',
  // legacy human-resume command referenced by historical flow docs; not part of current core registry.
  'testintent_resume',
]);

/**
 * CLI gate entry: reads CLAUDE.md files + registry command names, returns gate result.
 *
 * @param mdContents  - array of CLAUDE.md file contents (multiple files allowed)
 * @param registryNames - set of command names from registry.list()
 */
export function runDocsDriftGate(
  mdContents: string[],
  registryNames: Set<string>,
): DocsDriftGateResult {
  if (mdContents.length === 0) {
    return {
      provider: 'koala-docs-drift',
      status: 'skipped',
      summary: 'CLAUDE.md file not found',
      missing: [],
      stale: [],
    };
  }

  const combined = mdContents.join('\n');
  const result = checkDocsDrift(combined, registryNames, DOCS_DRIFT_ALLOWLIST);

  if (result.missing.length > 0) {
    return {
      provider: 'koala-docs-drift',
      status: 'fail',
      summary: `CLAUDE.md references ${result.missing.length} unregistered commands: ${result.missing.join(', ')}`,
      missing: result.missing,
      stale: result.stale,
    };
  }

  const staleNote = result.stale.length > 0
    ? ` (${result.stale.length} stale advisory)`
    : '';
  return {
    provider: 'koala-docs-drift',
    status: 'pass',
    summary: `CLAUDE.md command references aligned with registry${staleNote}`,
    missing: [],
    stale: result.stale,
  };
}
