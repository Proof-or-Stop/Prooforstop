/**
 * Proves the command is actually documented, rather than assumed to be.
 *
 * Two places must describe `proof-or-stop graph`: the CLAUDE.md section a reader
 * lands on, and the decisions entry recording why the migration was shaped the way
 * it was. This check asserts both exist and cover the specific claims the story
 * promised, so a doc that silently loses a flag or a decision fails here.
 *
 * The CLAUDE.md assertions are scoped to the graph SECTION, not the whole file.
 * Searching the whole file was the first implementation and it was too weak to be
 * worth anything: a flag deleted from the section still "passed" because the same
 * token appeared elsewhere in a 1400-line document. A check that cannot fail proves
 * nothing, so the section is extracted first and every flag must appear inside it.
 */
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const read = rel => {
  const p = path.join(repo, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};

const failures = [];
const requireAll = (label, text, needles) => {
  if (text === null) { failures.push(`${label}: missing`); return }
  for (const n of needles) {
    if (!text.includes(n)) failures.push(`${label}: missing ${JSON.stringify(n)}`);
  }
};

/** Extract one markdown section: its heading up to the next same-or-higher heading. */
const section = (doc, headingIncludes) => {
  if (doc === null) return null;
  const lines = doc.split('\n');
  const start = lines.findIndex(l => /^##\s/.test(l) && l.includes(headingIncludes));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##?\s/.test(lines[i])) { end = i; break }
  }
  return lines.slice(start, end).join('\n');
};

const claude = read('CLAUDE.md');
const graphSection = section(claude, 'proof-or-stop graph');
if (graphSection === null) {
  failures.push('CLAUDE.md: no "## ... proof-or-stop graph ..." section found');
} else {
  requireAll('CLAUDE.md graph section', graphSection, [
    'proof-or-stop graph',
    '--root=', '--port=', '--no-open', '--json',   // the four flags the source CLI parses
    '8731',                                        // default port
    'node:sqlite',                                 // the engines floor
    'packages/graph',
    'graph-command-migration.md',                   // pointer to the decisions doc
  ]);
}

const decision = read('docs/requirements/decisions/graph-command-migration.md');
requireAll('decisions doc', decision, [
  'packages/graph` subpackage',   // decision 1
  'build output',                 // decision 2
  'engines floor',                // decision 3
  'index cache lives outside',    // decision 4
  'validate.commands',            // the trap worth naming
  'SRC_SCAN_ROOTS',
  'Recursive tsc gate',           // the INIT reviewer's INIT-001 advisory
]);

if (failures.length) {
  console.error('DOCS_INCOMPLETE');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`CLAUDE.md graph section: ${graphSection.split('\n').length} lines, all four flags present`);
console.log('decisions doc: all four migration decisions recorded');
console.log('decisions doc: test-surface placement recorded (validate.commands and SRC_SCAN_ROOTS traps named)');
console.log('DOCS_OK');
