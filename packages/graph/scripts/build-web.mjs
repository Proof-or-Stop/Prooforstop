/**
 * Assembles the browser shell from its source parts into assets/app.html.
 *
 * The shell is authored as four files under src/shells/web/ (head, css, body, js)
 * and served as one self-contained document — no bundler, matching the parent
 * project's plain-tsc toolchain. Edit the parts, never the generated asset.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const web = path.join(root, 'src', 'shells', 'web');
const assets = path.join(root, 'assets');
fs.mkdirSync(assets, { recursive: true });

const read = f => {
  const p = path.join(web, f);
  if (!fs.existsSync(p)) throw new Error(`missing web source: ${f}`);
  return fs.readFileSync(p, 'utf8');
};

const out = [
  '<!doctype html><html lang="en"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  read('app.head.html').trim(),
  '<style>', read('app.css').trim(), '</style>',
  '</head><body>',
  read('app.body.html').trim(),
  '<div class="loading" id="boot">loading story graph…</div>',
  // Separate script so the hand-rolled painter still works if the vendored
  // bundle is missing; app.js feature-detects createGraph2DView.
  '<script>', read('graph2d.js').trim(), '</script>',
  '<script>', read('app.js').trim(), '</script>',
  // Playback viewer: animation + MP4/GIF export. Loaded last so app.js can
  // hand it a story; it self-registers on window and needs no bundler.
  '<script>', read('playback.js').trim(), '</script>',
  // Story dossier: the full-window per-story page. Same contract as playback:
  // loads after app.js (whose top-level helpers it reads from window) and
  // self-registers window.openStoryDossier.
  '<script>', read('dossier.js').trim(), '</script>',
  '</body></html>',
].join('\n');

fs.writeFileSync(path.join(assets, 'app.html'), out);
console.log(`assets: app.html (${(out.length / 1024).toFixed(0)}KB)`);

// d3 ships a self-contained UMD bundle, so the graph view needs no CDN and the
// page stays offline-capable.
const fg = path.join(root, 'node_modules', 'd3', 'dist', 'd3.min.js');
if (fs.existsSync(fg)) {
  fs.copyFileSync(fg, path.join(assets, 'd3.min.js'));
  console.log('assets: d3.min.js');
} else {
  // d3 is a hard `dependency`, not an optionalDependency: the 2D force-directed
  // graph cannot render without it. Skipping silently produced a page that still
  // loaded and still showed correct story/edge counts, but fell back to the
  // built-in WebGL draw path -- a visibly different rendering that no count-based
  // check catches. Fail loudly instead.
  console.error(
    `assets: d3 is missing at ${fg}\n` +
    '  d3 is a required dependency; without it the graph view cannot render.\n' +
    '  → install it: npm --prefix packages/graph install',
  );
  process.exit(1);
}

const mm = path.join(root, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js');
if (fs.existsSync(mm)) {
  fs.copyFileSync(mm, path.join(assets, 'mermaid.min.js'));
  console.log('assets: mermaid.min.js');
} else {
  console.warn('assets: mermaid not installed — the phase-flow diagram will fall back to text');
}

/* Playback viewer dependencies.

   gsap drives the per-frame SVG tweens; mediabunny muxes the WebCodecs H.264
   packets into MP4; gifenc quantises and writes the GIF. All three ship
   browser-ready bundles, so the page stays offline-capable and bundler-free --
   same contract as d3 and mermaid above. Each is optional: playback.js
   feature-detects and degrades (no gsap -> no viewer; no muxer -> no export).

   mediabunny and gifenc are ES modules, so playback.js imports them
   dynamically; gsap is a UMD bundle loaded as a plain script. */
for (const [label, from, to] of [
  ['gsap.min.js', ['gsap', 'dist', 'gsap.min.js'], 'gsap.min.js'],
  ['mediabunny.min.mjs', ['mediabunny', 'dist', 'bundles', 'mediabunny.min.mjs'], 'mediabunny.min.mjs'],
  ['gifenc.esm.js', ['gifenc', 'dist', 'gifenc.esm.js'], 'gifenc.esm.js'],
]) {
  const src = path.join(root, 'node_modules', ...from);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(assets, to));
    console.log(`assets: ${label}`);
  } else {
    console.warn(`assets: ${label} not installed — playback export will be unavailable`);
  }
}

/* Plain-DOM playback has no bundler to emit its module worker graph. Copy the
   two first-party modules verbatim; io/http.ts serves them beside gifenc so
   relative worker imports stay offline and same-origin. */
for (const file of ['gif-palette.js', 'gif-encoder.worker.js']) {
  fs.copyFileSync(path.join(web, file), path.join(assets, file));
  console.log(`assets: ${file}`);
}
