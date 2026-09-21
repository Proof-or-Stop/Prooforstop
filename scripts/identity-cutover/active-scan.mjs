


import { resolve } from 'node:path';






import { reviewedDataResidueAllowed } from ".././identity-reviewed-json-contexts.mjs";
import { reviewedFixtureResidueAllowed } from ".././identity-reviewed-fixture-contexts.mjs";
import { reviewedSourceResidueAllowed } from ".././identity-reviewed-source-contexts.mjs";

import { EXACT_ALLOWLIST } from "./base-contexts.mjs";
import { RETIRED_ROLES, RETIRED_ROLE_SUFFIXES, RETIRED_PRODUCT_NAME, LEGACY_WORD, SCRIPT_PATH, HISTORICAL_DECISION_FILENAME_PATHS } from "./rules.mjs";
import { schemaRows, isActiveTextPath, isFrozenSurface } from "./schema-scan.mjs";
import { currentTruthSourcePaths, isRetiredActiveInstruction } from "./guidance.mjs";
import { FROZEN_FILE_BASELINE_PATHS } from "./provenance-data.mjs";
import { readTrackedText, sha256 } from "./repository.mjs";
import { SCANNER_RETIRED_LINE_CONTEXTS } from "./scanner-contexts.mjs";
import { BOTH_FAMILY_CONTEXT_ROWS, BOTH_FAMILY_CONTEXT_WITNESSES } from "./reviewed-contexts.mjs";

export const TOKEN_PATTERN = /@(?:lattice|proofbound)\/[A-Za-z0-9._/-]+|__?(?:LATTICE|PROOFBOUND)_[A-Z0-9_]+|(?:LATTICE|PROOFBOUND)_[A-Z0-9_]+|\.(?:lattice|proofbound)(?:-[A-Za-z0-9._-]+|\/[A-Za-z0-9._/-]*)?|(?:lattice|proofbound)\.config\.json|(?:lattice|proofbound)\.json|(?:lattice|proofbound)-[a-z0-9-]+|[A-Za-z0-9_.-]*(?:lattice|proofbound)[A-Za-z0-9_.-]*/giu;

export function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

export function lineAt(text, index) {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const endIndex = text.indexOf('\n', index);
  return text.slice(start, endIndex === -1 ? text.length : endIndex);
}

export function exactAllowedRow(path, token, line = '') {
  return EXACT_ALLOWLIST.find((row) => row.path === path && (
    row.token === token
    || (line.includes(row.token) && row.token.includes(token))
  ));
}

export function classifyToken(path, token, line) {
  if (RETIRED_ROLES.has(token) || RETIRED_ROLE_SUFFIXES.some(suffix => token === `${RETIRED_PRODUCT_NAME}-${suffix}`)) return 'agent_role';
  if (/^_*(?:LATTICE|PROOFBOUND)_/iu.test(token)) return 'environment';
  if (/^(?:lattice|proofbound)(?:\.config)?\.json$/iu.test(token) || /^\.(?:lattice|proofbound)/iu.test(token)) return 'path_config';
  if ((path.endsWith('package.json') || path.endsWith('package-lock.json') || path.endsWith('npm-shrinkwrap.json'))
    && (/^@(?:lattice|proofbound)\//iu.test(token) || /["']name["']\s*:\s*["'](?:lattice|proofbound)["']/iu.test(line))) return 'package';
  if ((path.endsWith('package.json') || path.endsWith('package-lock.json'))
    && /["'](?:lattice|proofbound)["']\s*:/iu.test(line)) return 'bin';
  if ((path.startsWith('bin/') && path.includes(LEGACY_WORD)) || /(?:^|\/)lattice(?:\.js|-codex\.js)$/u.test(path)) return 'bin';
  if (path.startsWith('packages/main/templates/agents/') || path.startsWith('.claude/agents/') || path.startsWith('.proof-or-stop-codex/agents/')) return 'prompt';
  if (/\.md$/u.test(path) || ['README.md', 'AGENTS.md', 'CLAUDE.md'].includes(path)) return 'documentation';
  if (/(?:^|[^A-Za-z0-9_-])(?:lattice|proofbound)\s+[a-z][a-z0-9_-]*/iu.test(line)) return 'command';
  return 'runtime';
}

export function scanRegisteredActiveIdentityResidue(root, files) {
  // The public residue scan and mutation probes share the same complete tracked
  // text universe. Registration lists describe runtime guards, not scan scope.
  return scanActiveResidue(root, files);
}

export function scanActiveResidue(root, files) {
  const hits = [];
  const schemaSet = new Set(schemaRows(root, files).map((row) => `${row.path}\0${row.token}`));
  const currentTruthSources = currentTruthSourcePaths(root);
  for (const path of files) {
    if (!isActiveTextPath(path) || isFrozenSurface(path) || FROZEN_FILE_BASELINE_PATHS.has(path)) continue;
    const absolute = resolve(root, path);
    let text;
    try {
      text = readTrackedText(root, path);
    } catch {
      continue;
    }
    for (const match of text.matchAll(TOKEN_PATTERN)) {
      const token = match[0].replace(/\.+$/u, '');
      const line = lineAt(text, match.index);
      if (SCANNER_RETIRED_LINE_CONTEXTS.some(([sourcePath, digest, , positions]) =>
        sourcePath === path && digest === sha256(line) && positions.includes(lineNumberAt(text, match.index)))) continue;
      if (reviewedSourceResidueAllowed({ path, token, line, lineNumber: lineNumberAt(text, match.index), text })
        || reviewedDataResidueAllowed({ path, token, line, lineNumber: lineNumberAt(text, match.index), text })
        || reviewedFixtureResidueAllowed({ path, token, line, lineNumber: lineNumberAt(text, match.index), text })) continue;
      if (schemaSet.has(`${path}\0${token}`)) continue;
      const exactRow = exactAllowedRow(path, token, line);
      const activeInstruction = isRetiredActiveInstruction(path, token, line, currentTruthSources);
      if (exactRow && (!activeInstruction || exactRow.class === 'migration_input' || exactRow.historicalStatement === true)) continue;
      hits.push({ class: classifyToken(path, token, line), path, line: lineNumberAt(text, match.index), token });
    }
    for (const match of path.matchAll(TOKEN_PATTERN)) {
      const token = match[0];
      if (HISTORICAL_DECISION_FILENAME_PATHS.has(path)) continue;
      if (BOTH_FAMILY_CONTEXT_ROWS.some(row => row.path === path && row.token === token && row.allowFilename === true)
        && BOTH_FAMILY_CONTEXT_WITNESSES.some(pin => pin.path === path && pin.sha256 === sha256(readTrackedText(root, path)))) continue;
      hits.push({ class: classifyToken(path, token, path), path, line: 0, token: `<path:${token}>` });
    }
  }
  const deduped = new Map();
  for (const hit of hits) deduped.set(`${hit.class}\0${hit.path}\0${hit.line}\0${hit.token}`, hit);
  return [...deduped.values()].sort((a, b) => `${a.class}\0${a.path}\0${a.line}\0${a.token}`.localeCompare(`${b.class}\0${b.path}\0${b.line}\0${b.token}`));
}
