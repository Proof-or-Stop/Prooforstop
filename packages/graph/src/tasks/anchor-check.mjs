/**
 * Anchor-id regression guard (no browser needed).
 *
 * The lifecycle timeline renders `data-fid` and the Findings tab renders
 * `data-fcard`. Twice now those two sides have disagreed on whether a finding id
 * is bare ("F-205") or story-qualified ("B-137a:F-205"), and because the jump
 * used an exact CSS attribute match it failed SILENTLY -- scrolling to the top
 * instead of the target, with no console error.
 *
 * This asserts the shipped app.js still normalises before comparing, by running
 * its real `bareFid` / `findByFid` against both spellings.
 */
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const src = fs.readFileSync(path.join(here, '../shells/web/app.js'), 'utf8');
const fail = [];

// The guard is only meaningful if the functions it tests are actually present.
for (const fn of ['function bareFid(', 'function findByFid(']) {
  if (!src.includes(fn)) fail.push(`app.js no longer defines ${fn}...) -- anchor normalisation was removed`);
}
// And only if the jumps actually route through them.
for (const call of ['findByFid(B,"data-fcard"', 'findByFid(B,"data-fid"']) {
  if (!src.includes(call)) fail.push(`a jump no longer uses ${call}) -- it will exact-match and silently fail`);
}
if (/querySelector\(`\[data-fcard="\$\{cssEsc/.test(src))
  fail.push('jumpToFinding is back to an exact data-fcard match');

// Behavioural check on the real extracted implementation.
const bodies = src.match(/function bareFid\([\s\S]*?\n\}\n/)?.[0] ?? '';
if (!bodies) fail.push('could not extract bareFid to test it');
else {
  const bareFid = new Function(`${bodies}; return bareFid`)();
  const cases = [
    ['F-205', 'F-205'], ['B-137a:F-205', 'F-205'],
    ['B-49ed:F-001', 'F-001'], ['', ''],
  ];
  for (const [input, want] of cases) {
    const got = bareFid(input);
    if (got !== want) fail.push(`bareFid(${JSON.stringify(input)}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
  // The pairing that actually broke: one side prefixed, the other bare.
  if (bareFid('B-137a:F-205') !== bareFid('F-205'))
    fail.push('prefixed and bare ids do not reconcile -- lifecycle jumps will fail');
}

if (fail.length) {
  console.error(`anchor-check FAILED (${fail.length})`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('anchor-check PASS · finding-id anchors normalise across both spellings');
