import { SCANNER_SOURCE_PATHS } from './scanner-contexts.mjs';










import { reviewedDataResidueAllowed } from ".././identity-reviewed-json-contexts.mjs";


import { isRetiredGeneratedCache } from ".././identity-maintenance-boundaries.mjs";
import { readTrackedText, countLiteral, occurrenceContextDigest, sha256 } from "./repository.mjs";
import { lineAt, lineNumberAt } from "./active-scan.mjs";
import { SCRIPT_PATH, CURRENT_LEGACY_CONTEXT_MANIFEST_PATH, CONCEPT_PROVENANCE_MANIFEST_PATH } from "./rules.mjs";
import { EXPERIMENT_PROVENANCE_PATHS, FROZEN_FILE_BASELINE_PATHS, CONCEPT_PROVENANCE_PATHS } from "./provenance-data.mjs";

export const SCHEMA_PATTERN = /(?:^|[^A-Za-z0-9_.-])((?:lattice|Lattice)[A-Za-z0-9_.-]*\.v[0-9]+)(?=$|[^A-Za-z0-9_.-])/gu;

export function schemaRows(root, files) {
  const rows = [];
  for (const path of files) {
    if (!isActiveTextPath(path) || isPersistedSchemaExcludedSurface(path)) continue;
    const text = readTrackedText(root, path);
    const tokens = new Set();
    for (const match of text.matchAll(SCHEMA_PATTERN)) {
      // Authenticated audit excerpts are data, not persisted protocol readers.
      // Unknown or moved nodes still enter the ordinary schema inventory.
      if (reviewedDataResidueAllowed({ path, token: match[1], line: lineAt(text, match.index),
        lineNumber: lineNumberAt(text, match.index), text })) continue;
      tokens.add(match[1]);
    }
    for (const token of tokens) {
      rows.push({
        path,
        token,
        count: countLiteral(text, token),
        contextSha256: occurrenceContextDigest(text, token),
      });
    }
  }
  return rows.sort((a, b) => `${a.path}\0${a.token}`.localeCompare(`${b.path}\0${b.token}`));
}

export function schemaBaselineDigest(rows) {
  return sha256(rows.map((row) => `${row.path}\0${row.token}\0${row.count}\0${row.contextSha256}`).join('\n'));
}

export function isPersistedSchemaExcludedSurface(path) {
  return SCANNER_SOURCE_PATHS.includes(path)
    || path === CURRENT_LEGACY_CONTEXT_MANIFEST_PATH
    || path === 'CHANGELOG.md'
    || path.startsWith('.proof-or-stop/story/')
    || path.startsWith('.proof-or-stop/dev-memory/')
    || path.startsWith('.lattice/story/')
    || path.includes('/tests/fixtures/')
    || path.startsWith('tests/fixtures/')
    || path.startsWith('docs/requirements/decisions/')
    || EXPERIMENT_PROVENANCE_PATHS.has(path);
}

export function isFrozenSurface(path) {
  return path === CONCEPT_PROVENANCE_MANIFEST_PATH
    || path === CURRENT_LEGACY_CONTEXT_MANIFEST_PATH
    || path.startsWith('.proof-or-stop/story/')
    || path.startsWith('.lattice/story/')
    || FROZEN_FILE_BASELINE_PATHS.has(path)
    || CONCEPT_PROVENANCE_PATHS.has(path)
    || EXPERIMENT_PROVENANCE_PATHS.has(path);
}

export function isActiveTextPath(path) {
  // These two exact data tables are authenticated by their reviewed readers.
  if (path === 'scripts/identity-reviewed-source-data.json' || path === 'scripts/identity-reviewed-json-data.json' || path === 'scripts/identity-reviewed-fixture-data.json') return false;
  if (isRetiredGeneratedCache(path)) return false;
  if (path.includes('/dist/') || path.includes('/node_modules/')) return false;
  if (/\.(?:png|jpe?g|gif|ico|pdf|zip|gz|tgz|woff2?|mp[34]|mov)$/iu.test(path)) return false;
  return true;
}

export function scanRootGroups(files) {
  return {
    packages: files.filter((path) => /(^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json)$/u.test(path)),
    runtime: files.filter((path) => path.startsWith('packages/main/src/') || path.startsWith('packages/utils/src/') || path.startsWith('packages/lab/src/') || path.startsWith('bin/') || path.startsWith('scripts/') || path.startsWith('.githooks/')),
    agents: files.filter((path) => path.startsWith('packages/main/templates/agents/') || path.startsWith('.claude/agents/') || path.startsWith('.proof-or-stop-codex/agents/')),
    docs: files.filter((path) => ['README.md', 'AGENTS.md', 'CLAUDE.md', 'docs/CLI.md', 'docs/guide.md', 'docs/guide-hooks.md', 'docs/host-run-usage.md'].includes(path) || path.startsWith('.github/')),
  };
}
