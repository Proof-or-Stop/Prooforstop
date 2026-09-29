
import { existsSync, readFileSync } from 'node:fs';

import { resolve } from 'node:path';










import { CURRENT_CONTRACT_PATHS, TRUTH_SOURCE_ENTRYPOINTS, EXPLICIT_HISTORICAL_DECISION_DOCS, ALLOWED_LEGACY_STORY_PATH_CONTEXTS, CURRENT_GUIDANCE_PATHS, CANONICAL_STORY_DIR, LEGACY_STORY_DIR, HISTORICAL_DECISION_FILENAME_PATHS, CURRENT_LEGACY_CONTEXT_MANIFEST_PATH, CURRENT_LEGACY_CONTEXT_MANIFEST_SHA256, EXPECTED_CURRENT_LEGACY_CONTEXT_ROW_COUNT } from "./rules.mjs";
import { sha256 } from "./repository.mjs";

export function isConceptProvenancePath(path) {
  return path.startsWith('docs/requirements/decisions/')
    || path.startsWith('.proof-or-stop/dev-memory/')
    || path.includes('/tests/fixtures/')
    || path.startsWith('tests/fixtures/');
}

export function currentTruthSourcePaths(root) {
  const paths = new Set(CURRENT_CONTRACT_PATHS);
  const decisionRef = /(?:docs\/requirements\/decisions\/)?([A-Za-z0-9._-]+\.md)/gu;
  for (const entrypoint of TRUTH_SOURCE_ENTRYPOINTS) {
    const text = readFileSync(resolve(root, entrypoint), 'utf8');
    for (const match of text.matchAll(decisionRef)) {
      const path = `docs/requirements/decisions/${match[1]}`;
      if (existsSync(resolve(root, path)) && !EXPLICIT_HISTORICAL_DECISION_DOCS.has(path)) paths.add(path);
    }
  }
  return paths;
}

export function isHistoricalLegacyContext(line) {
  return /\b(?:legacy|retired|historical|pre-cutover|predecessor|superseded|compatibility|frozen|persisted schema|signature salt|migration input|old (?:name|path|command|identifier)|negative (?:case|fixture|example)|must reject|is rejected)\b/iu.test(line);
}

export function isAllowedLegacyStoryPathContext(path, line) {
  return ALLOWED_LEGACY_STORY_PATH_CONTEXTS.has(`${path}\0${line}`);
}

export function verifyCurrentGuidance(root, readText = (path) => readFileSync(resolve(root, path), 'utf8')) {
  const errors = [];
  const documents = new Map(CURRENT_GUIDANCE_PATHS.map((path) => [path, readText(path)]));
  const agents = documents.get('AGENTS.md');
  const claude = documents.get('CLAUDE.md');

  if (!agents.includes(`"storyDir": "${CANONICAL_STORY_DIR}"`)) {
    errors.push(`current guidance: AGENTS.md must declare canonical storyDir ${CANONICAL_STORY_DIR}`);
  }
  if (!claude.includes('proof-or-stop plan_get') || !claude.includes('proof-or-stop plan_set')) {
    errors.push('current guidance: CLAUDE.md PLAN instructions must use plan_get and plan_set');
  }

  for (const [path, text] of documents) {
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      if (line.includes(LEGACY_STORY_DIR) && !isAllowedLegacyStoryPathContext(path, line)) {
        errors.push(`current guidance: ${path}:${index + 1} contains active legacy StoryStore path ${LEGACY_STORY_DIR}`);
      }
      if (/主 agent 直接写文件|当前无 CLI 命令/u.test(line)) {
        errors.push(`current guidance: ${path}:${index + 1} contains direct-write/no-CLI StoryStore guidance`);
      }
    }
  }
  return errors;
}

export function isHistoricalFilenameToken(token) {
  if (token.length <= 'lattice-'.length) return false;
  return [...HISTORICAL_DECISION_FILENAME_PATHS].some((path) => {
    const basename = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/u, '');
    return token === basename || token === `${basename}.md` || token === `<path:${basename}>`;
  }) || token === 'lattice-lifecycle-readiness-check-flow';
}

export function isPersistedLegacySchemaToken(token) {
  return /^(?:lattice|Lattice)[A-Za-z0-9_.-]*\.v[0-9]+(?:[A-Za-z0-9_.-]*)$/u.test(token);
}

export function isRetiredActiveInstruction(path, token, line, currentTruthSources) {
  if (!currentTruthSources.has(path)) return false;
  if (isHistoricalFilenameToken(token) || isPersistedLegacySchemaToken(token)) return false;
  return !isHistoricalLegacyContext(line);
}

export function verifyCurrentLegacyContextManifest(root, bytes = readFileSync(resolve(root, CURRENT_LEGACY_CONTEXT_MANIFEST_PATH))) {
  const errors = [];
  if (sha256(bytes) !== CURRENT_LEGACY_CONTEXT_MANIFEST_SHA256) {
    errors.push('current legacy contexts: manifest byte digest changed');
  }
  try {
    const rows = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(rows) || rows.length !== EXPECTED_CURRENT_LEGACY_CONTEXT_ROW_COUNT) {
      errors.push(`current legacy contexts: row count ${Array.isArray(rows) ? rows.length : '<not-array>'}, expected ${EXPECTED_CURRENT_LEGACY_CONTEXT_ROW_COUNT}`);
    }
    if (Array.isArray(rows)) for (const row of rows) {
      if (row.sourceSha256 === undefined) continue;
      if (!/^[a-f0-9]{64}$/u.test(row.sourceSha256)
        || !existsSync(resolve(root, row.path))
        || sha256(readFileSync(resolve(root, row.path))) !== row.sourceSha256) {
        errors.push(`current legacy contexts: reviewed source witness changed ${row.path}`);
      }
    }
  } catch {
    errors.push('current legacy contexts: manifest is not valid JSON');
  }
  return errors;
}
