
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';






import { reviewedDataResidueAllowed, validateReviewedDataSources } from ".././identity-reviewed-json-contexts.mjs";
import { reviewedFixtureResidueAllowed, validateReviewedFixtureSources } from ".././identity-reviewed-fixture-contexts.mjs";


import { LEGACY_WORD, TRUTH_SOURCE_ENTRYPOINTS } from "./rules.mjs";
import { CURRENT_LEGACY_CONTEXT_ROWS, EXACT_ALLOWLIST } from "./base-contexts.mjs";
import { validateExactRows } from "./repository.mjs";
import { schemaRows } from './schema-scan.mjs';
import { verifySchemaInventory } from './source-integrity.mjs';
import { scanActiveResidue } from "./active-scan.mjs";

export function verifyCurrentWitnessCoverage(root, files, expect) {
  const record = expect; let failed = false;
  expect = (condition, message) => { if (!condition) failed = true; record(condition, message); };
  const read = path => readFileSync(resolve(root, path), 'utf8');
  const jsonEntries = JSON.parse(read('scripts/identity-reviewed-json-data.json')).entries;
  const jsonRows = jsonEntries.slice(729, 774);
  const incomingJsonRows = jsonEntries.slice(774, 776);
  const criticJsonRows = jsonEntries.slice(776, 802);
  expect(criticJsonRows.length === 26 && criticJsonRows.every(row =>
    row.path === 'scripts/lab/u18-static-edges/exceptions.json' && row.nodeKind === 'value' &&
    /^\/entries\/(239|240)\/requiredEvidence\/\d+\/excerpt$/.test(row.jsonPointer)),
    'managed critic witness coverage requires all 26 exact copied-source nodes');
  expect(incomingJsonRows.length === 2 && incomingJsonRows.every((row, index) =>
    row.path === 'docs/lab/memory-intake-measurement/u18-static-report.json' && row.jsonPointer === '/rows/187/reason' &&
    row.token === [`${LEGACY_WORD}.js`, `${LEGACY_WORD}-codex`][index]),
    'incoming witness coverage requires the two exact historical report contexts');
  const auditJsonRows = jsonEntries.slice(802, 804);
  expect(auditJsonRows.length === 2 && auditJsonRows.every(row => row.path === 'scripts/lab/u18-static-edges/exceptions.json' && row.jsonPointer === '/entries/261/requiredEvidence/1/excerpt'), 'audit witness coverage requires both exact copied cleanup nodes');
  const modularRows = jsonEntries.slice(804);
  expect(modularRows.every(row => row.class === 'verification-migration-evidence'), 'additional JSON witnesses require reviewed migration classification');
  const modularFileControls = [...new Map(modularRows.filter(row => row.nodeKind === 'value').map(row => [row.path, row])).values()];
  const allJsonRows = [...jsonRows, ...incomingJsonRows, ...criticJsonRows, ...auditJsonRows, ...modularFileControls];
  const fixtureRows = JSON.parse(read('scripts/identity-reviewed-fixture-data.json')).entries.slice(268);
  const provenanceRows = CURRENT_LEGACY_CONTEXT_ROWS.filter(row => row.id.startsWith('current-witness-coverage-'));
  expect(jsonRows.length === 45 && fixtureRows.length === 33 && provenanceRows.length === 12,
    'current witness coverage requires every reviewed addition');
  const scratch = mkdtempSync(join(tmpdir(), 'identity-current-witness-'));
  let controls = 0;
  try {
    for (const row of allJsonRows) {
      const text = read(row.path), parsed = JSON.parse(text);
      const keys = row.jsonPointer.slice(1).split('/').map(key => key.replaceAll('~1', '/').replaceAll('~0', '~'));
      const parent = keys.slice(0, -1).reduce((value, key) => value[key], parsed);
      const key = keys.at(-1), value = parent[key];
      expect(typeof value === 'string', 'reviewed JSON pointer must name its actual string');
      const check = (document, file = row.path) => {
        const input = JSON.stringify(document);
        if (file !== row.path) return reviewedDataResidueAllowed({path: file, token: row.token, lineNumber: 1, line: input, text: input});
        return validateReviewedDataSources(path => path === row.path ? input : read(path)).length === 0;
      };
      expect(check(parsed), 'exact current JSON witness rejected'); controls++;
      for (const replacement of [value + row.token, value + ' changed-context']) {
        parent[key] = replacement;
        expect(!check(parsed), 'changed JSON count or same-count context admitted'); controls++;
        expect(validateReviewedDataSources(path => path === row.path ? JSON.stringify(parsed) : read(path)).length > 0,
          'actual JSON source integrity accepted changed witness'); controls++;
      }
      delete parent[key];
      expect(!check(parsed), 'removed JSON pointer admitted'); controls++;
      parent[key + '-unlisted'] = value;
      expect(!check(parsed), 'relocated JSON pointer admitted'); controls++;
      delete parent[key + '-unlisted']; parent[key] = value;
      expect(!check(parsed, row.path + '.unlisted.json'), 'unlisted JSON path admitted'); controls++;
    }
    for (const row of fixtureRows) {
      const text = read(row.path), lines = text.split(/\r?\n/), line = lines[row.lineNumber - 1];
      const check = (input, file = row.path) => reviewedFixtureResidueAllowed({path: file, token: row.token,
        lineNumber: row.lineNumber, line: input.split(/\r?\n/)[row.lineNumber - 1], text: input});
      expect(check(text), 'exact private or metadata fixture witness rejected'); controls++;
      for (const input of [text + '\n' + row.token, text.replace(line, line + ' // changed-context'), text.replace(line, '')]) {
        expect(!check(input), 'changed fixture count/context/removal admitted'); controls++;
        expect(validateReviewedFixtureSources(path => path === row.path ? input : read(path)).length > 0,
          'actual fixture source integrity accepted mutation'); controls++;
      }
      expect(!check(text, row.path + '.unlisted.ts'), 'unlisted fixture path admitted'); controls++;
    }
    const tracked = new Set(files);
    for (const row of provenanceRows) {
      const text = read(row.path);
      expect(validateExactRows(EXACT_ALLOWLIST, tracked, root).length === 0, 'current provenance positive refused'); controls++;
      for (const input of [text + '\n' + row.token, text.replace(row.token, row.token + ' changed-context'), text.replaceAll(row.token, '')]) {
        expect(validateExactRows(EXACT_ALLOWLIST, tracked, root, path => path === row.path ? input : read(path)).length > 0,
          'provenance count/context/removal mutation admitted'); controls++;
      }
      expect(validateExactRows(EXACT_ALLOWLIST.filter(candidate => candidate !== row), tracked, root).length > 0,
        'removed provenance inventory row admitted'); controls++;
      expect(validateExactRows(EXACT_ALLOWLIST.map(candidate => candidate === row ? {...row, path: 'docs/unlisted-witness.md'} : candidate), tracked, root).length > 0,
        'changed provenance path admitted'); controls++;
    }
    for (const entrypoint of TRUTH_SOURCE_ENTRYPOINTS) {
      mkdirSync(dirname(resolve(scratch, entrypoint)), {recursive:true});
      writeFileSync(resolve(scratch, entrypoint), read(entrypoint));
    }
    const targets = [...new Set([...allJsonRows, ...fixtureRows, ...provenanceRows].map(row => row.path))];
    for (const file of targets) {
      const destination = resolve(scratch, file);
      mkdirSync(dirname(destination), {recursive:true}); writeFileSync(destination, read(file));
    }
    expect(scanActiveResidue(scratch, targets).length === 0, 'exact current witnesses still produce residue'); controls++;
    // Same-directory neighbors remain active, even when they copy approved bytes.
    for (const file of targets) {
      const dot = file.lastIndexOf('.'), neighbor = file.slice(0, dot) + '-unlisted' + file.slice(dot);
      writeFileSync(resolve(scratch, neighbor), read(file));
      const residue = scanActiveResidue(scratch, [neighbor]);
      const schemaErrors = residue.length ? [] : verifySchemaInventory(root, [...schemaRows(root, files), ...schemaRows(scratch, [neighbor])]);
      expect(residue.length > 0 || schemaErrors.some(error => error.includes(neighbor)), `unlisted neighboring witness escaped actual scanners: ${file}`); controls++;
    }
  } finally { rmSync(scratch, {recursive:true, force:true}); }
  if (!failed) console.log(`PASS current witness consumers: ${allJsonRows.length} JSON, ${fixtureRows.length} fixture, ${provenanceRows.length} provenance rows; ${controls} actual checks`);
}
