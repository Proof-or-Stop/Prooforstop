import fs from 'node:fs';
import { createHash } from 'node:crypto';
const sha = text => createHash('sha256').update(text).digest('hex');
const bytes = fs.readFileSync(new URL('./identity-reviewed-source-data.json', import.meta.url), 'utf8');
const EXPECTED_SHA256 = 'c1d6139dc4865b9794db8f594b05fff0c1c7b258257726e7733c414bc49783a8';
if (sha(bytes) !== EXPECTED_SHA256) throw new Error('reviewed source inventory bytes changed');
const inventory = JSON.parse(bytes);
if (inventory.schemaVersion !== 'identity-reviewed-source-contexts.v1' || inventory.entries.length !== 59) throw new Error('reviewed source inventory shape changed');
const byFile = new Map(), seen = new Set();
for (const row of inventory.entries) {
  const key = JSON.stringify([row.path, row.token, row.lineNumber]);
  if (seen.has(key) || !row.path || !row.token || !Number.isInteger(row.lineNumber) || row.lineNumber < 1
    || !Number.isInteger(row.tokenOccurrences) || row.tokenOccurrences < 1
    || !/^[a-f0-9]{64}$/.test(row.sourceSha256) || !/^[a-f0-9]{64}$/.test(row.lineSha256)
    || !row.classification || !row.reason) throw new Error('reviewed source inventory invalid');
  seen.add(key);
  const entries = byFile.get(row.path) ?? [];
  if (entries.some(entry => entry.sourceSha256 !== row.sourceSha256)) throw new Error('source source identity disagrees');
  entries.push(row); byFile.set(row.path, entries);
}
const lastByFile = new Map();
function facts(path, text) {
  const prior = lastByFile.get(path);
  if (prior?.text === text) return prior;
  const next = { text, sha256: sha(text), lines: text.split(/\r?\n/) };
  lastByFile.set(path, next); return next;
}
export function reviewedSourceResidueAllowed({ path, token, line, lineNumber, text }) {
  const rows = byFile.get(path);
  if (!rows || typeof text !== 'string' || !Number.isInteger(lineNumber)) return false;
  const value = facts(path, text);
  if (line !== value.lines[lineNumber - 1]) return false;
  return rows.some(row => row.token === token && row.lineNumber === lineNumber
    && row.sourceSha256 === value.sha256 && row.lineSha256 === sha(line)
    && text.split(token).length - 1 === row.tokenOccurrences);
}
export function validateReviewedSourceSources(readText) {
  const errors = [];
  for (const [path, rows] of byFile) {
    let text; try { text = readText(path); } catch { errors.push(`reviewed source missing: ${path}`); continue; }
    for (const row of rows) if (!reviewedSourceResidueAllowed({ path, token: row.token, lineNumber: row.lineNumber, line: text.split(/\r?\n/)[row.lineNumber - 1], text })) errors.push(`reviewed source changed: ${path}:${row.lineNumber}`);
  }
  return errors;
}
