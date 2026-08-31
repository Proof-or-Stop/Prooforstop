/* ============================================================================
   2D graph renderer: D3 + SVG.

   Flat by construction. The previous attempts painted spheres -- radial
   gradients, specular highlights, drop shadows -- which is how a "2D" view ends
   up still reading as a field of glass balls. Here a node is an SVG <circle>
   with a flat fill and a hairline stroke: the shape encodes size (dependent
   count) and colour (lifecycle phase), and nothing else.

   Why SVG rather than canvas: at 367 nodes / 425 edges the DOM is comfortably
   fast, and it buys real text rendering, crisp strokes at any zoom, and CSS
   control over the whole scene. Canvas would only start to pay off an order of
   magnitude larger.

   Swappable with the hand-rolled painter in app.js: it satisfies the same small
   contract -- render(), focus(), resize() -- so `?gl=0` returns to that path,
   which is also the automatic fallback when d3 is unavailable.
   ============================================================================ */
function createGraph2DView(opts){
  const { mount, stories, edges, phaseColor, ground, isVisible,
          onNodeClick, onNodeHover } = opts;
  const d3 = window.d3;
  if (!d3) return null;

  /* Run a real 2D force simulation rather than importing the 3D layout.

     Reusing those positions and dropping z was the mistake behind the overlap:
     projecting a sphere-packed volume onto a plane guarantees collisions, since
     two nodes far apart in z land on top of each other. A 2D layout has to be
     solved in 2D, and forceCollide is what keeps discs from intersecting.

     The simulation also gives the view its animation: nodes fly out from the
     seed positions and settle, which is the standard D3 force-graph behaviour. */
  /* Ambient drift parameters, one set per node.

     Seeded from the id rather than Math.random so the motion is identical
     across reloads -- a graph that reshuffles its wobble on every refresh reads
     as instability rather than life. Periods are deliberately co-prime-ish and
     slow (7-13s) so no two nodes visibly pulse in lockstep. */
  let seed = 0;
  const hash = (str) => { let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
    return (h >>> 0) / 4294967295; };
  const nodes = stories.map(s => {
    const a = hash(s.id), b = hash(s.id + '#'), c = hash(s.id + '##');
    return { id: s.id, s, x: s.x, y: s.y, r: Math.max(1.6, s.r),
      /* Amplitude in SCREEN pixels, divided by the zoom at draw time.

         Twice raised: layout units made it invisible (the default 0.42x fit
         rendered a 1.1-unit drift as half a pixel), and 2.6-4.8px was still hard
         to perceive at a glance against 367 nodes. Periods shortened with it --
         a larger amplitude over a 7-13s cycle moves too slowly to read as
         motion, so the excursion is bigger AND quicker. */
      dax: 6 + a * 5, day: 6 + b * 5,
      dpx: 4200 + a * 3200, dpy: 4200 + c * 3200,
      dox: a * 6.283, doy: b * 6.283 };
  });
  const byId = new Map(nodes.map(n => [n.id, n]));
  const links = edges
    .filter(e => byId.has(e.s) && byId.has(e.t))
    .map(e => ({ source: byId.get(e.s), target: byId.get(e.t) }));

  let focusSet = null, selId = null, hoverId = null;

  /* Background is read from the page's --bg, not from the `ground` option.

     `ground` was captured once at construction, so switching theme left the
     graph -- the largest surface on screen -- on the old ground while every
     panel around it changed. paint() refreshes it along with the stroke
     colours; the option remains the fallback for a caller with no stylesheet. */
  const svg = d3.select(mount).append('svg')
    .attr('width', '100%').attr('height', '100%')
    .style('display', 'block')
    .style('background', ground);

  // One arrowhead per state, referenced by marker-end; SVG markers cannot
  // inherit the line's colour, so the dim variant needs its own definition.
  const defs = svg.append('defs');
  const marker = (id, colour) => defs.append('marker')
    .attr('id', id).attr('viewBox', '0 -4 8 8')
    .attr('refX', 8).attr('refY', 0)
    .attr('markerWidth', 5).attr('markerHeight', 5)
    .attr('orient', 'auto')
    .append('path').attr('d', 'M0,-3L7,0L0,3').attr('fill', colour);
  /* Theme colours come from the page's CSS custom properties, not literals.

     These were hardcoded light-mode hex, so the graph stayed light while the
     rest of the page went dark. Read once per paint and cached: 400 nodes each
     calling getComputedStyle would be a measurable cost on every hover. */
  const THEME_KEYS = ['--g-link','--g-link-lit','--g-link-hi','--g-arrow',
    '--g-arrow-off','--g-node-ring','--g-node-hover','--g-node-sel'];
  let C = {};
  let lastGround = null;
  function readTheme(){
    const cs = getComputedStyle(document.documentElement);
    const next = {};
    for (const k of THEME_KEYS) next[k] = cs.getPropertyValue(k).trim() || '#888';
    C = next;
    const bg = cs.getPropertyValue('--bg').trim() || ground;
    if (bg !== lastGround) { lastGround = bg; svg.style('background', bg) }
    return C;
  }
  readTheme();

  marker('ar-on', C['--g-arrow']);
  marker('ar-off', C['--g-arrow-off']);
  marker('ar-hi', C['--g-link-hi']);   // edges of the hovered node

  /* Halo for the biggest hubs: a larger translucent disc behind the node.

     This was first written as an SVG feGaussianBlur filter, which looked better
     and made the browser unusable -- 85 filtered nodes re-rasterised on every
     simulation tick froze the tab hard enough to hang the devtools protocol. A
     plain circle costs nothing and carries the same weight. */
  const root = svg.append('g');
  const gGlow = root.append('g').attr('pointer-events', 'none');
  const gLink = root.append('g').attr('fill', 'none');
  const gNode = root.append('g');
  /* Selection ring above the edges and discs -- as a sibling earlier in the
     document it was drawn underneath 425 edges and 367 nodes and never visible. */
  const gSel = root.append('g').attr('pointer-events', 'none').attr('fill', 'none');
  /* Labels LAST of all, so they are the topmost layer.
     Sitting them before the ring and halo groups meant ids were overpainted by
     the halo of the very node they name, and by any arrowhead crossing them. */
  const gPulse = root.append('g').attr('pointer-events', 'none').attr('fill', 'none');
  const gText = root.append('g').attr('pointer-events', 'none');

  /* Edges stop at the target's rim rather than its centre, so the arrowhead is
     visible instead of buried under the disc it points at. */
  /* Gently curved edges. In a graph this dense, straight chords between the same
     cluster overlay each other into a grey mat; a slight arc separates parallel
     runs and makes direction easier to follow. Ends are inset to each disc's rim
     so the arrowhead stays visible instead of hiding under the target. */
  const path = l => {
    const dx = l.target.x - l.source.x, dy = l.target.y - l.source.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d;
    const x1 = l.source.x + ux * l.source.r, y1 = l.source.y + uy * l.source.r;
    const x2 = l.target.x - ux * (l.target.r + 3.2), y2 = l.target.y - uy * (l.target.r + 3.2);
    // Large radius => shallow arc. Enough to separate parallel runs, not enough
    // to make the topology harder to trace.
    return `M${x1},${y1}A${d * 1.6},${d * 1.6} 0 0,1 ${x2},${y2}`;
  };

  const litLink = l => !focusSet || (focusSet.has(l.source.id) && focusSet.has(l.target.id));
  const litNode = n => !focusSet || focusSet.has(n.id);
  // Edges touching the hovered node, so pointing at a story shows its relations.
  const onHover = l => hoverId && (l.source.id === hoverId || l.target.id === hoverId);

  /* Recently-updated stories.

     The poll tells us which stories changed; those nodes get an expanding ring
     that fades over a few seconds, so a background update is visible at a glance
     without having to diff anything by eye. Deliberately the same visual
     language as the selection ring -- a ring, not a colour change -- so it reads
     as "look here" rather than "this is a different kind of story". */
  const pulses = new Map();          // id -> start timestamp
  const PULSE_MS = 4200;
  let selRing = null;
  let link = gLink.selectAll('path');
  let node = gNode.selectAll('circle');
  let glow = gGlow.selectAll('circle');
  let label = gText.selectAll('text');
  let zoomK = 1;
  const HUB = 11;                    // radius above which a node gets the bloom

  function paint(){
    readTheme();
    link.attr('stroke', l => onHover(l) ? C['--g-link-hi'] : litLink(l) ? C['--g-link-lit'] : C['--g-link'])
        .attr('stroke-width', l => (onHover(l) ? 2 : litLink(l) ? 1 : 0.6) / (zoomK > 1 ? 1 : 1))
        .attr('marker-end', l => onHover(l) ? 'url(#ar-hi)' : litLink(l) ? 'url(#ar-on)' : null);
    glow.attr('fill', n => phaseColor(n.s.phase))
        .attr('opacity', n => litNode(n) ? (n.id === selId ? 0.30 : 0.14) : 0.03);
    node.attr('fill', n => phaseColor(n.s.phase))
        // The selection is never dimmed, even when a search excludes it.
        .attr('fill-opacity', n => (n.id === selId || litNode(n)) ? 1 : 0.16)
        .attr('stroke', n => n.id === selId ? C['--g-node-sel']
                           : n.id === hoverId ? C['--g-node-hover'] : C['--g-node-ring'])
        .attr('stroke-opacity', n => litNode(n) ? 1 : 0.3)
        .attr('stroke-width', n => (n.id === selId ? 2.2 : n.id === hoverId ? 1.6 : 0.9) / zoomK);
    /* The selected node gets a ring of its own -- colour alone is not findable
       among 367 discs, and the 2px stroke on the node itself disappears at the
       default zoom. Sized in screen pixels so it stays legible at any scale. */
    /* The ring shows whenever something is selected -- it must NOT be gated on
       the focus set. Opening a story from search results sets both `sel` and a
       search highlight, and a selected story is frequently not among its own
       search matches (searching "b-" ranks 80 others above it), so gating on
       focusSet suppressed the ring in exactly the case the reader most needs it:
       "I just clicked this, which one is it?" */
    const selNode = selId ? byId.get(selId) : null;
    gSel.selectAll('circle')
      .data(selNode ? [selNode] : [], n => n.id)
      .join(
        enter => enter.append('circle')
          .attr('stroke', C['--g-node-sel'])
          .call(g => g.append('animate')
            .attr('attributeName', 'stroke-opacity')
            .attr('values', '1;0.35;1').attr('dur', '1.8s')
            .attr('repeatCount', 'indefinite')),
        update => update)
      .attr('cx', n => n.x).attr('cy', n => n.y)
      // Screen-constant geometry: a ring specified in data units shrinks to a
      // hairline as the reader zooms in, which is where it is needed most.
      .attr('r', n => n.r + 9 / zoomK)
      .attr('stroke-width', 3 / zoomK);

    /* Labels only where they are readable: at the default fit all 367 ids
       overlap into an unreadable mat, so one needs both a large node and enough
       zoom that neighbours have separated. Selection and hover always show. */
    // Position here as well as on tick: the tick skips labels while zoomed out
    // (a frame-budget saving during the settle), so a label first revealed by
    // zooming in after the simulation cooled would otherwise have no
    // coordinates and render at the origin.
    label.attr('x', n => n.x).attr('y', n => n.y - n.r - 1.5 / zoomK);
    /* Visibility via opacity, not display: `display:none` cannot be
       transitioned, so labels appeared instantly the moment a zoom crossed the
       threshold. pointer-events stays off the whole layer, so an invisible label
       still intercepts nothing. */
    label.attr('opacity', n => (n.id === selId || n.id === hoverId ||
        (litNode(n) && n.r > 9 && zoomK > 1.15) ||
        (litNode(n) && n.r > 5 && zoomK > 2.2)) ? 1 : 0)
      .attr('font-size', `${Math.max(7, 11 / zoomK)}px`)
      .attr('y', n => n.y - n.r - 1.5 / zoomK)
      .attr('dominant-baseline', 'auto');
  }

  function bind(vn){
    const keep = new Set(vn.map(n => n.id));
    glow = gGlow.selectAll('circle').data(vn.filter(n => n.r > HUB), n => n.id)
      .join('circle').attr('cx', n => n.x).attr('cy', n => n.y)
      .attr('r', n => n.r * 1.9);
    const vl = links.filter(l => keep.has(l.source.id) && keep.has(l.target.id));

    link = gLink.selectAll('path').data(vl, l => `${l.source.id}>${l.target.id}`)
      .join('path').attr('d', path);

    node = gNode.selectAll('circle').data(vn, n => n.id)
      .join('circle')
        .attr('cx', n => n.x).attr('cy', n => n.y).attr('r', n => n.r)
        .style('cursor', 'pointer')
        .on('click', (_, n) => onNodeClick && onNodeClick(n.s))
        .on('mouseenter', (_, n) => { hoverId = n.id; paint(); onNodeHover && onNodeHover(n.s) })
        .on('mouseleave', () => { hoverId = null; paint(); onNodeHover && onNodeHover(null) })
        .call(d3.drag()
          .on('start', (ev, n) => { stopDrift();
                                    if (!ev.active) sim.alphaTarget(0.22).restart();
                                    n.fx = n.x; n.fy = n.y })
          .on('drag',  (ev, n) => { n.fx = ev.x; n.fy = ev.y })
          .on('end',   (ev, n) => { if (!ev.active) sim.alphaTarget(0);
                                    n.fx = null; n.fy = null }));

    label = gText.selectAll('text').data(vn, n => n.id)
      .join('text')
        .attr('x', n => n.x)
        .attr('text-anchor', 'middle')
        .attr('font-family', '"IBM Plex Mono",monospace')
        .attr('font-weight', 500)
        .attr('fill', C['--g-node-sel'])
        .text(n => n.id);
    paint();
  }

  /* Once the reader zooms or pans, automatic refits stop.

     The settle-fit below and the window resize handler both called fitAll, so a
     zoom performed during the first 9 seconds -- or any time the drawer opened --
     was silently thrown away and the graph snapped back to the full view. An
     explicit fit (right-click, or focus()) clears the flag again. */
  let userMoved = false;
  const zoom = d3.zoom().scaleExtent([0.12, 9])
    .on('zoom', ev => {
      // sourceEvent is null for programmatic transforms (fitAll / focus).
      if (ev.sourceEvent) userMoved = true;
      zoomK = ev.transform.k; root.attr('transform', ev.transform); paint();
    });
  svg.call(zoom).on('dblclick.zoom', null);
  /* Right-click resets the view. After clicking into a story the camera sits
     zoomed on one node, and there was no way back to the whole graph short of
     scrolling out by hand. The browser menu is suppressed since it offers
     nothing useful over a canvas. */
  svg.on('contextmenu', ev => { ev.preventDefault(); userMoved = false; fitAll() });

  bind(nodes);

  /* Entrance. The discs scale up from nothing and the edges fade in behind them,
     staggered by depth so the hubs land first and the periphery follows -- the
     graph assembles itself instead of appearing all at once. Respects
     prefers-reduced-motion by skipping straight to the final state. */
  /* Keep the graph framed while it settles: the layout expands a long way from
     its seed positions, and without this the reader watches it walk off-screen
     before the final fit snaps it back. */
  let simRef = null;
  const isHot = () => !!simRef && simRef.alpha() > 0.02;
  const settleFit = setInterval(() => { if (!userMoved) fitAll() }, 700);
  setTimeout(() => clearInterval(settleFit), 9000);

  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const maxD = Math.max(1, ...nodes.map(n => n.s.depth || 0));
    node.attr('r', 0).transition().duration(620)
      .delay(n => 90 + (1 - (n.s.depth || 0) / maxD) * 520)
      .ease(d3.easeBackOut.overshoot(1.5))
      .attr('r', n => n.r);
    glow.attr('r', 0).transition().duration(700).delay(120)
      .attr('r', n => n.r * 1.9);
    gLink.attr('opacity', 0).transition().duration(900).delay(520).attr('opacity', 1);
  }

  /* The forces, in the order they matter here:
       link     - pulls related stories together; distance grows with the two
                  radii so big hubs do not swallow their dependants
       charge   - global repulsion, scaled by radius so hubs clear more space
       collide  - the one that actually prevents overlap; radius + padding
       x/y      - a weak pull to centre, keeping detached components from
                  drifting off-screen instead of a hard centring force */
  const sim = simRef = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(n => n.id)
      .distance(l => 26 + l.source.r + l.target.r).strength(0.28))
    .force('charge', d3.forceManyBody().strength(n => -34 - n.r * 5.5))
    .force('collide', d3.forceCollide(n => n.r + 2.4).iterations(2))
    .force('x', d3.forceX(0).strength(0.028))
    .force('y', d3.forceY(0).strength(0.028))
    .alphaDecay(0.0182)
    .on('tick', () => {
      link.attr('d', path);
      node.attr('cx', n => n.x).attr('cy', n => n.y);
      glow.attr('cx', n => n.x).attr('cy', n => n.y);
      if (selId) gSel.selectAll('circle').attr('cx', n => n.x).attr('cy', n => n.y);
      // Labels are hidden at the default zoom, so moving 367 <text> nodes every
      // tick is wasted work during the one moment the frame budget is tight.
      if (zoomK > 1.15) label.attr('x', n => n.x).attr('y', n => n.y - n.r - 1.5 / zoomK);
    })
    .on('end', () => {
      setTimeout(() => { if (!userMoved) fitAll() }, 60);
      startDrift();                       // the field breathes once it settles
    });

  // Fit once the mount has its real size: measuring synchronously here reads a
  // container that has not been laid out yet and parks the graph off-screen.
  function fitAll(){
    const b = root.node().getBBox();
    const w = mount.clientWidth || innerWidth, h = mount.clientHeight || innerHeight;
    if (!b.width || !b.height) return;
    const k = Math.min(w / b.width, h / b.height) * 0.9;
    const next = d3.zoomIdentity
      .translate(w / 2, h / 2).scale(k)
      .translate(-(b.x + b.width / 2), -(b.y + b.height / 2));

    /* Skip fits that would barely move the camera.

       The settle interval calls this every 700ms while the layout expands, and
       each call fitted to a bounding box that had grown slightly -- applying a
       new scale INSTANTLY, because the no-transition branch below is taken while
       the simulation is hot. The result was a visible step: the whole canvas
       jumping from one zoom level to another in a single frame, every 700ms.
       Frame-differencing a recording found exactly that, an isolated one-frame
       discontinuity with still frames either side.

       A fit that changes the scale by under 2% and the translation by under a
       few pixels is not worth showing, so it is dropped. Real changes still
       apply, and the first fit (no previous transform) always runs. */
    const cur = d3.zoomTransform(svg.node());
    if (cur && cur.k) {
      const dk = Math.abs(next.k - cur.k) / cur.k;
      const dt = Math.hypot(next.x - cur.x, next.y - cur.y);
      /* Threshold measured from a recording, not guessed.

         Frame-differencing the reported jolt and comparing ink spread either
         side of it gave a scale change of just 0.75% applied in ONE frame. Tiny
         in magnitude, but simultaneous across 368 nodes, which is exactly why it
         reads as the canvas jumping between zoom levels while being easy to miss
         in a numeric probe. An earlier 2% threshold would have let it through,
         so the bar is 0.3% -- below what a re-fit of a still-growing bounding box
         produces, and far below any change worth showing the reader. */
      if (dk < 0.003 && dt < 3) return;
    }

    /* Always transition. Applying instantly while the simulation is hot was the
       other half of the step: it made every accepted fit a hard cut. A short
       ease is imperceptible when the change is small and smooth when it is not,
       and successive fits simply supersede one another rather than fighting --
       d3 interrupts the previous transition on the same element. */
    svg.transition().duration(isHot() ? 260 : 450)
      .ease(d3.easeCubicOut)
      .call(zoom.transform, next);
  }

  /* Ambient motion.

     The layout itself is NOT re-simulated: running the forces forever would
     keep moving nodes and slowly rearrange the graph under the reader. Instead
     each node keeps its settled position (bx/by) and is drawn at a small
     sinusoidal offset from it, so the field breathes while the topology stays
     put. Two consequences that matter:
       - it is O(n) trigonometry, no force solving, so it is cheap enough to run
         while the reader is doing nothing;
       - it is skipped entirely while the simulation is hot, while a node is
         being dragged, and for prefers-reduced-motion.
     Edges follow because path() reads the same live x/y. */
  let drifting = false, driftRAF = 0;
  let driftK = 1;            // eased stand-in for zoomK; see the drift loop
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function startDrift(){
    if (reduced || drifting) return;
    drifting = true;
    driftK = zoomK || 1;     // no step on the first frame
    for (const n of nodes) { n.bx = n.x; n.by = n.y }
    const t0 = performance.now();
    /* Throttled to ~30fps. At full frame rate this held a renderer at ~47% CPU
       forever, which is not a reasonable price for ambient decoration on a page
       someone leaves open -- and the motion is a 7-13 second sine, so 30fps is
       indistinguishable from 60. Also pauses entirely when the tab is hidden. */
    const MIN_FRAME_MS = 33;
    let lastFrame = 0;
    const step = (now) => {
      if (!drifting) return;
      if (document.hidden || now - lastFrame < MIN_FRAME_MS) {
        driftRAF = requestAnimationFrame(step); return;
      }
      lastFrame = now;
      const t = now - t0;
      // Chase the live zoom instead of adopting it instantly (see below).
      driftK += (zoomK - driftK) * 0.12;
      if (Math.abs(zoomK - driftK) < 0.001) driftK = zoomK;
      for (const n of nodes) {
        if (n.fx != null) continue;                        // pinned by a drag
        /* The focused node holds still WHERE IT IS, not at its base position.

           Snapping it back to base moved it up to 11px out from under the
           cursor, which un-hovered it, which released the freeze, which drifted
           it back under the cursor -- an oscillation that made hovering a node
           jitter continuously. Latching the current position keeps it steady
           without ever moving it at the moment focus is acquired. */
        if (n.id === selId || n.id === hoverId) {
          if (n.hx == null) { n.hx = n.x; n.hy = n.y }
          n.x = n.hx; n.y = n.hy;
          continue;
        }
        n.hx = null; n.hy = null;
        /* Amplitude follows the zoom, but SMOOTHLY.

           Dividing by the live zoomK keeps the wobble a constant size on screen,
           which is what we want -- but clicking a story zooms 0.42 -> 2.2 in one
           step, and every unfocused node's excursion then shrank ~5x within a
           single frame. 367 nodes all contracting at once is the jolt that
           looked like the whole canvas shaking. Easing the divisor toward the
           real zoom spreads that change over ~15 frames, below the threshold
           where it reads as motion of its own. */
        n.x = n.bx + Math.sin(t / n.dpx + n.dox) * n.dax / driftK;
        n.y = n.by + Math.cos(t / n.dpy + n.doy) * n.day / driftK;
      }
      link.attr('d', path);
      node.attr('cx', d => d.x).attr('cy', d => d.y);
      glow.attr('cx', d => d.x).attr('cy', d => d.y);
      if (selId) gSel.selectAll('circle').attr('cx', d => d.x).attr('cy', d => d.y);
      if (zoomK > 1.15) label.attr('x', d => d.x).attr('y', d => d.y - d.r - 1.5 / zoomK);
      drawPulses(now);
      driftRAF = requestAnimationFrame(step);
    };
    driftRAF = requestAnimationFrame(step);
  }
  function drawPulses(now){
    if (!pulses.size) { if (gPulse.node().childNodes.length) gPulse.selectAll('circle').remove(); return }
    for (const [id, t0] of pulses) if (now - t0 > PULSE_MS) pulses.delete(id);
    const live = [...pulses.keys()].map(id => byId.get(id)).filter(Boolean);
    gPulse.selectAll('circle').data(live, n => n.id)
      .join('circle')
      .attr('cx', n => n.x).attr('cy', n => n.y)
      .attr('stroke', n => phaseColor(n.s.phase))
      .attr('r', n => {
        const p = Math.min(1, (now - (pulses.get(n.id) || now)) / PULSE_MS);
        return n.r + 4 / zoomK + p * 26 / zoomK;       // expands outward
      })
      .attr('stroke-width', n => {
        const p = Math.min(1, (now - (pulses.get(n.id) || now)) / PULSE_MS);
        return (3.2 * (1 - p)) / zoomK;                 // and thins as it goes
      })
      .attr('stroke-opacity', n => {
        const p = Math.min(1, (now - (pulses.get(n.id) || now)) / PULSE_MS);
        return 0.85 * (1 - p) * (1 - p);
      });
  }

  function stopDrift(){
    drifting = false;
    if (driftRAF) cancelAnimationFrame(driftRAF), driftRAF = 0;
    // Hand the settled positions back so the simulation resumes from what the
    // reader can see, not from where the drift happened to be mid-cycle.
    for (const n of nodes) if (n.bx != null) { n.x = n.bx; n.y = n.by }
  }

  let lastSig = null;
  return {
    engine: 'd3-svg',
    render({ focus, sel, visibleIds }){
      focusSet = focus || null;
      selId = sel || null;
      /* Re-bind only when the VISIBLE SET changes. draw() fires on hover,
         search, filter toggles and polling; re-joining the whole selection each
         time would thrash the DOM. Colour and opacity go through paint(). */
      const vn = nodes.filter(n => visibleIds ? visibleIds.has(n.id) : isVisible(n.s));
      const sig = vn.length + ':' + (vn.length && vn[vn.length - 1].id);
      if (sig !== lastSig) {
        lastSig = sig;
        bind(vn);
        const keep = new Set(vn.map(n => n.id));
        sim.nodes(vn);
        sim.force('link').links(links.filter(l => keep.has(l.source.id) && keep.has(l.target.id)));
        stopDrift();
        sim.alpha(0.5).restart();     // re-settle the new subset, visibly
      } else paint();
    },
    markUpdated(ids){
      const now = performance.now();
      for (const id of ids) if (byId.has(id)) pulses.set(id, now);
      // The pulse is drawn by the drift loop; if the layout has settled and drift
      // is off (reduced motion), fall back to a single paint so the ring at least
      // appears rather than silently doing nothing.
      if (!drifting) { drawPulses(now); paint() }
    },
    focus(s){
      if (!s) return;
      /* Clicking a story is a deliberate camera move, so the automatic refits
         must stand down -- otherwise the settle interval or a resize snaps the
         view back to the full graph a moment after it arrives. */
      userMoved = true;
      const w = mount.clientWidth || innerWidth, h = mount.clientHeight || innerHeight;
      /* Centre in the VISIBLE area, not the viewport.

         The detail panel covers the right ~52% of the window, so translating to
         w/2 puts the node the reader just clicked underneath the panel. Measure
         the drawer instead of assuming its width: it is a resizable element and
         the CSS value is a min() of two units. */
      const dr = document.getElementById('dr');
      /* Use offsetWidth, NOT getBoundingClientRect().left: the drawer slides in
         with a transform, so at the moment focus() is called its rect still
         reports the off-screen position and the offset would come out as 0. Its
         width is already final. */
      const covered = dr && dr.classList.contains('on') ? dr.offsetWidth : 0;
      const cx = (w - covered) / 2;
      /* Use the SIMULATION's node, not the story object.

         `s.x/s.y` are the seed coordinates handed in from app.js; the force
         layout has since moved every node, so centring on them aimed the camera
         at where the story used to be -- roughly a third of a screen off. The
         live position lives on the simulation node. */
      const n = byId.get(s.id) || { x: s.x, y: s.y };
      /* Ease in AND out, over a little longer.

         d3's default transition easing (cubic-in-out) still starts fast enough
         that a 260px camera flight feels like a snap at the beginning -- which is
         the "jolt" on click: the whole field is genuinely sliding, because the
         camera is moving, and the first frames carry most of the acceleration.
         easeCubicInOut over 760ms starts and ends near zero velocity, so the
         motion reads as a deliberate move rather than a lurch. */
      svg.transition().duration(760).ease(d3.easeCubicInOut)
        .call(zoom.transform, d3.zoomIdentity
          .translate(cx, h / 2).scale(2.2).translate(-n.x, -n.y));
    },
    resize(){ if (!userMoved) fitAll() },   // never fight the reader's zoom
    dispose(){ stopDrift(); sim.stop(); svg.remove() },
  };
}
