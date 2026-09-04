/* Playback viewer: animate the lifecycle as a flowchart, and export it.

   Ported from the standalone `mermaid-animate` (Flowtrace) app, which was
   React + Vite. This shell has no bundler, so the React components are
   re-expressed as plain DOM here while the pure logic -- timeline arithmetic,
   camera solving, motion easing, scene capture, Canvas rendering, encoding --
   is carried over unchanged. Keeping that logic identical is deliberate: it is
   the part that was tested over there, and rewriting it would have re-derived
   the same equations with new bugs.

   The animated diagram is NOT the phase-flow diagram from the Timeline tab.
   That one aggregates ("4x back"), which has no per-transition ordering to
   animate; this builds one node per phase and one labelled arrow per recorded
   transition, so the animation can walk the story in the order it happened.

   Entry point: window.openPlaybackModal(story). Everything else is private.

   Vendor dependencies, all optional and all local (see io/http.ts VENDOR):
     gsap        UMD script  -- per-frame SVG property writes
     mediabunny  ES module   -- MP4 muxing of WebCodecs packets
     gifenc      ES module   -- GIF quantise + encode
   Without gsap the viewer refuses to open (it cannot animate); without the
   muxers the corresponding export option is hidden.  */
(function(){
"use strict";

/* ============================================================
   Phase palette.

   Read from the page's own --ph-* custom properties so the diagram, the graph
   nodes and the filter dots are all literally the same colours. The fallbacks
   are the dark-theme values from app.css, used when a property is missing.
   ============================================================ */
const PH_VAR={INIT:"--ph-init",INIT_CHECK:"--ph-check",PLAN:"--ph-plan",DEV:"--ph-dev",
  REVIEW:"--ph-review",TEST:"--ph-test",DONE:"--ph-done",DISCARDED:"--ph-disc",META:"--ph-meta"};
const PH_FALLBACK={INIT:"#e0b04a",INIT_CHECK:"#3ec3e0",PLAN:"#a48bf0",DEV:"#35c48a",
  REVIEW:"#f5834e",TEST:"#ea6fc0",DONE:"#6b9be8",DISCARDED:"#8b929d",META:"#e05070"};
const DEFAULT_NODE_STROKE="#607389";
const DEFAULT_EDGE_STROKE="#8b929d";
const DIAGRAM_SANS='"IBM Plex Sans","Source Sans 3",ui-sans-serif,system-ui,sans-serif';
const DIAGRAM_MONO='"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace';

function cssVar(name){
  const v=getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v||"";
}
/* Is the page currently rendering dark?

   The standalone app this was ported from was dark-only, so the diagram inks
   and the node fill were hardcoded. Here the theme has three states -- explicit
   data-theme, or the system preference -- and a dark node fill under the light
   theme leaves the edge captions unreadable, so the two colours that sit ON the
   diagram are chosen from the resolved theme instead. */
function isDarkTheme(){
  const explicit=document.documentElement.dataset.theme;
  if(explicit==="dark") return true;
  if(explicit==="light") return false;
  return matchMedia("(prefers-color-scheme:dark)").matches;
}
/* The diagram's own surface colours, resolved per theme.

   `plate` and `nodeFill` are deliberately NOT --bg2/--panel: the diagram is a
   single visual object and needs its own ground, a touch away from the page so
   the boxes read as sitting on something. */
function diagramInk(){
  return isDarkTheme()
    ? {plate:"#091420", nodeFill:"#101d2c", nodeInk:"#dfe9f5", labelInk:"#ced9e5",
       grid:"rgba(72,103,132,.13)"}
    : {plate:"#eef1f5", nodeFill:"#ffffff", nodeInk:"#2b3340", labelInk:"#4b5565",
       grid:"rgba(58,95,150,.11)"};
}
function phaseClassName(phase){return "ph"+String(phase).replace(/[^A-Za-z0-9]/g,"")}
function phaseBorderColor(phase){
  const key=PH_VAR[phase];
  if(!key) return DEFAULT_NODE_STROKE;
  return cssVar(key)||PH_FALLBACK[phase]||DEFAULT_NODE_STROKE;
}
function hexToRgba(hex,alpha){
  const raw=String(hex).replace("#","");
  const value=raw.length===3?[...raw].map(p=>p+p).join(""):raw;
  const n=Number.parseInt(value,16);
  if(!Number.isFinite(n)) return `rgba(96,115,137,${alpha})`;
  return `rgba(${n>>16&255},${n>>8&255},${n&255},${alpha})`;
}
/* Chrome colours for the exported frame. Read live so an exported MP4 matches
   the theme the viewer was watching, rather than a hardcoded dark frame. */
function chromeColors(){
  const pick=(name,fb)=>cssVar(name)||fb;
  return {
    bg:pick("--bg","#0b0e14"), panel:pick("--panel","#151a23"),
    ink:pick("--ink","#e9ebef"), ink2:pick("--ink2","#a7afbc"),
    ink3:pick("--ink3","#6f7885"), acc:pick("--acc","#7ea0d0"),
    edge:pick("--edge","#2a313d"), rail:pick("--rail","#8b929d"),
  };
}

const clamp01=v=>Math.min(1,Math.max(0,v));

/* ============================================================
   motion.ts -- easing. Timeline time stays linear; movement gets a
   slow-fast-slow rhythm so departures and arrivals feel deliberate.
   ============================================================ */
function flowProgress(progress){
  const t=clamp01(progress);
  return t*t*(3-2*t);
}
function edgeTravelProgress(progress){return flowProgress((clamp01(progress)-.36)/.64)}
function phaseDwellPulse(progress){
  const t=clamp01(progress);
  if(t<=0||t>=.36) return 0;
  const dwell=t/.36;
  const fadeIn=flowProgress(Math.min(1,dwell/.2));
  const fadeOut=1-flowProgress(Math.max(0,(dwell-.82)/.18));
  const wave=.45+.55*(.5-.5*Math.cos(dwell*Math.PI*2));
  return fadeIn*fadeOut*wave;
}
function phaseGlowFilter(pulse,color="#439cff"){
  return `drop-shadow(0 0 12px ${hexToRgba(color,clamp01(pulse)*.86)})`;
}
/** Fade the moving tracer in after departure and out before the completed state. */
function tracerOpacity(progress){
  const t=clamp01(progress);
  return Math.min(1,t/.04,(1-t)/.05);
}

/* ============================================================
   camera.ts -- viewBox solving. All pure: a box in, a box out.
   ============================================================ */
function fitRectToAspect(rect,aspect,paddingRatio=0.12){
  const paddedWidth=Math.max(1,rect.width*(1+paddingRatio*2));
  const paddedHeight=Math.max(1,rect.height*(1+paddingRatio*2));
  const width=Math.max(paddedWidth,paddedHeight*aspect);
  const height=width/aspect;
  return {x:rect.x+rect.width/2-width/2, y:rect.y+rect.height/2-height/2, width, height};
}
/** Keep the camera from zooming in tighter than `minWidth` (world units). */
function limitViewBoxMinSize(box,minWidth){
  if(!(minWidth>box.width)) return box;
  const height=minWidth*(box.height/Math.max(1,box.width));
  return {x:box.x+box.width/2-minWidth/2, y:box.y+box.height/2-height/2, width:minWidth, height};
}
function zoomViewBox(box,factor){
  const width=box.width*factor, height=box.height*factor;
  return {x:box.x+(box.width-width)/2, y:box.y+(box.height-height)/2, width, height};
}
function panViewBox(box,dxPixels,dyPixels,viewportWidth,viewportHeight){
  return {...box,
    x:box.x-(dxPixels/viewportWidth)*box.width,
    y:box.y-(dyPixels/viewportHeight)*box.height};
}
function centerViewBox(box,x,y){return {...box, x:x-box.width/2, y:y-box.height/2}}
function interpolateViewBox(from,to,amount){
  const p=clamp01(amount);
  return {x:from.x+(to.x-from.x)*p, y:from.y+(to.y-from.y)*p,
    width:from.width+(to.width-from.width)*p, height:from.height+(to.height-from.height)*p};
}
function approachViewBox(from,to,amount=.14,epsilon=.2){
  const delta=Math.max(Math.abs(from.x-to.x),Math.abs(from.y-to.y),
    Math.abs(from.width-to.width),Math.abs(from.height-to.height));
  return delta<epsilon?{box:to,settled:true}:{box:interpolateViewBox(from,to,amount),settled:false};
}
function followFocusPoint(tracer,ahead,label,viewport){
  const lead={x:tracer.x*.25+ahead.x*.75, y:tracer.y*.25+ahead.y*.75};
  if(!label) return lead;
  const labelCenter={x:label.x+label.width/2, y:label.y+label.height/2};
  const normalizedDistance=Math.hypot(
    (labelCenter.x-tracer.x)/viewport.width,(labelCenter.y-tracer.y)/viewport.height);
  if(normalizedDistance>.45) return lead;
  return {x:lead.x*.8+labelCenter.x*.2, y:lead.y*.8+labelCenter.y*.2};
}
function smoothstep(from,to,value){
  const p=clamp01((value-from)/(to-from));
  return p*p*(3-2*p);
}
function mixPoint(from,to,amount){
  return {x:from.x+(to.x-from.x)*amount, y:from.y+(to.y-from.y)*amount};
}
function edgeFollowFocusPoint(tracer,ahead,fromNode,toNode,label,viewport,progress){
  const phase=clamp01(progress);
  const lead=followFocusPoint(tracer,ahead,null,viewport);
  const labelFocus=label?followFocusPoint(tracer,ahead,label,viewport):lead;
  const labelBlend=smoothstep(.25,.45,phase)*(1-smoothstep(.75,.92,phase));
  const middle=mixPoint(lead,labelFocus,labelBlend);
  const departed=mixPoint(fromNode,middle,smoothstep(0,.18,phase));
  return mixPoint(departed,toNode,smoothstep(.82,1,phase));
}
function followViewBox(openingView,medianNodeWidth,aspect){
  const width=Math.max(openingView.width*1.65,medianNodeWidth*6.4);
  return centerViewBox({x:0,y:0,width,height:width/aspect},
    openingView.x+openingView.width/2, openingView.y+openingView.height/2);
}
function keepPointVisible(box,point,marginRatio=.15){
  const margin=Math.min(.45,Math.max(0,marginRatio));
  const left=box.x+box.width*margin, right=box.x+box.width*(1-margin);
  const top=box.y+box.height*margin, bottom=box.y+box.height*(1-margin);
  return {...box,
    x:point.x<left?box.x+point.x-left:point.x>right?box.x+point.x-right:box.x,
    y:point.y<top?box.y+point.y-top:point.y>bottom?box.y+point.y-bottom:box.y};
}
function limitViewBoxMovement(from,to,maxViewportFraction){
  const fromCenter={x:from.x+from.width/2, y:from.y+from.height/2};
  const toCenter={x:to.x+to.width/2, y:to.y+to.height/2};
  const dx=toCenter.x-fromCenter.x, dy=toCenter.y-fromCenter.y;
  const normalizedDistance=Math.hypot(dx/from.width,dy/from.height);
  if(!normalizedDistance||normalizedDistance<=maxViewportFraction) return to;
  const scale=maxViewportFraction/normalizedDistance;
  return centerViewBox(to,fromCenter.x+dx*scale,fromCenter.y+dy*scale);
}
function cameraSmoothingForFrame(frameSeconds,stepDuration){
  const safeFrame=Math.max(1/240,frameSeconds);
  const timeConstant=Math.max(.01,Math.min(.18,stepDuration/5));
  return 1-Math.exp(-safeFrame/timeConstant);
}
function smoothForcedFollowFrame(from,target,tracer,smoothing,maxViewportFraction){
  const approached=approachViewBox(from,target,smoothing).box;
  const safe=tracer?keepPointVisible(approached,tracer,.04):approached;
  return maxViewportFraction>=1?safe:limitViewBoxMovement(from,safe,maxViewportFraction);
}

/* ============================================================
   svgGeometry.ts -- rect maths and the dashed-stroke reveal.
   ============================================================ */
function padRect(rect,horizontal,vertical=horizontal){
  return {x:rect.x-horizontal, y:rect.y-vertical,
    width:rect.width+horizontal*2, height:rect.height+vertical*2};
}
/* Grow a dashed stroke from the start of a path. The remainder is always a gap,
   never a dash, and the gap is long enough that the pattern cannot repeat back
   onto the path. */
function dashedStrokeReveal(length,progress,pattern){
  const pathLength=Math.max(length,1);
  const hide=pathLength*2;
  const visible=Math.max(0,clamp01(progress)*pathLength);
  if(visible<=.01) return `0 ${hide}`;
  const cycle=pattern.length?pattern:[pathLength];
  const parts=[];
  let drawn=0, index=0;
  while(drawn<visible-.01){
    const segment=cycle[index%cycle.length];
    const take=Math.min(segment,visible-drawn);
    parts.push(Number(take.toFixed(2)));
    drawn+=take; index+=1;
  }
  if(parts.length%2===1) parts.push(hide); else parts.push(0,hide);
  return parts.join(" ");
}
function boundsForPoints(points,padding=0){
  if(!points.length) return null;
  const xs=points.map(p=>p.x), ys=points.map(p=>p.y);
  return padRect({x:Math.min(...xs), y:Math.min(...ys),
    width:Math.max(...xs)-Math.min(...xs), height:Math.max(...ys)-Math.min(...ys)}, padding);
}
function distanceFromPointToRect(point,rect){
  const dx=Math.max(rect.x-point.x,0,point.x-rect.x-rect.width);
  const dy=Math.max(rect.y-point.y,0,point.y-rect.y-rect.height);
  return Math.hypot(dx,dy);
}
function rectanglesOverlap(first,second,margin=8){
  return first.x<second.x+second.width+margin
    && first.x+first.width+margin>second.x
    && first.y<second.y+second.height+margin
    && first.y+first.height+margin>second.y;
}
function averageSegmentLength(points){
  if(points.length<2) return 1;
  let length=0;
  for(let i=1;i<points.length;i++)
    length+=Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y);
  return Math.max(1,length/(points.length-1));
}
function candidateRect(entry,pathIndex,side){
  const point=entry.path[pathIndex];
  const before=entry.path[Math.max(0,pathIndex-1)];
  const after=entry.path[Math.min(entry.path.length-1,pathIndex+1)];
  const tangentLength=Math.max(1,Math.hypot(after.x-before.x,after.y-before.y));
  const tangent={x:(after.x-before.x)/tangentLength, y:(after.y-before.y)/tangentLength};
  const normal={x:-tangent.y*side, y:tangent.x*side};
  const offset=entry.rect.height/2+10;
  return {x:point.x+normal.x*offset-entry.rect.width/2,
    y:point.y+normal.y*offset-entry.rect.height/2,
    width:entry.rect.width, height:entry.rect.height};
}
/* Corrects Dagre's occasional long-loop label anchors. Native labels within a
   readable distance stay untouched; only outliers are tethered to their path. */
function tetherEdgeLabels(entries,obstacles=[]){
  const result=new Map();
  const reserved=[...obstacles];
  const distant=[];
  for(const entry of entries){
    if(!entry.path.length){ result.set(entry.id,{dx:0,dy:0}); continue }
    let nearestIndex=0, nearestDistance=Number.POSITIVE_INFINITY;
    entry.path.forEach((point,index)=>{
      const distance=distanceFromPointToRect(point,entry.rect);
      if(distance<nearestDistance){ nearestDistance=distance; nearestIndex=index }
    });
    const threshold=Math.max(56,entry.rect.height*1.5);
    if(nearestDistance<=threshold){
      result.set(entry.id,{dx:0,dy:0}); reserved.push(entry.rect); continue;
    }
    const point=entry.path[nearestIndex];
    const before=entry.path[Math.max(0,nearestIndex-1)];
    const after=entry.path[Math.min(entry.path.length-1,nearestIndex+1)];
    const tangent={x:after.x-before.x, y:after.y-before.y};
    const normal={x:-tangent.y, y:tangent.x};
    const originalCenter={x:entry.rect.x+entry.rect.width/2, y:entry.rect.y+entry.rect.height/2};
    const side=(originalCenter.x-point.x)*normal.x+(originalCenter.y-point.y)*normal.y>=0?1:-1;
    distant.push({entry,nearestIndex,side});
  }
  for(const {entry,nearestIndex,side} of distant){
    const indexStep=Math.max(2,Math.ceil((entry.rect.width*.72)/averageSegmentLength(entry.path)));
    const offsets=[0,1,-1,2,-2,3,-3];
    const candidates=offsets.map(offset=>candidateRect(entry,
      Math.min(entry.path.length-1,Math.max(0,nearestIndex+offset*indexStep)),side));
    const target=candidates.find(c=>reserved.every(rect=>!rectanglesOverlap(c,rect)))??candidates[0];
    reserved.push(target);
    result.set(entry.id,{dx:target.x-entry.rect.x, dy:target.y-entry.rect.y});
  }
  return result;
}

/* ============================================================
   timeline.ts -- step durations and the frame lookup.
   ============================================================ */
const MIN_ALLOCATED_STEP_DURATION=2;
function activeSteps(steps){return steps.filter(s=>s.enabled)}
function durationFor(steps){return activeSteps(steps).reduce((sum,s)=>sum+s.duration,0)}
function playbackEnded(playing,timeSeconds,duration){
  return playing&&duration>0&&timeSeconds>=duration;
}
function median(values){
  const sorted=[...values].sort((a,b)=>a-b);
  const middle=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
}
/* Spread a requested total across the enabled steps.

   "proportional" weights each step by how long the story actually sat in the
   phase it is leaving, compressed through a 0.45 power so a 3-day DEV phase
   reads as longer than a 2-minute one without consuming the whole clip. */
function allocateStepDurations(steps,requestedTotal,mode){
  const enabled=steps.map((step,index)=>({step,index})).filter(({step})=>step.enabled);
  if(!enabled.length) return steps;
  const total=Math.max(enabled.length*MIN_ALLOCATED_STEP_DURATION,
    Number.isFinite(requestedTotal)?requestedTotal:0);
  const positive=enabled.map(({step})=>step.sourceDurationMs??0).filter(v=>v>0);
  const reference=positive.length?median(positive):1;
  const weights=enabled.map(({step})=>{
    if(mode==="even") return 1;
    const ratio=Math.max(0,step.sourceDurationMs??0)/reference;
    return Math.min(1.85,Math.max(.65,ratio>0?ratio**.45:.65));
  });
  const weightTotal=weights.reduce((sum,w)=>sum+w,0);
  const weightedBudget=total-enabled.length*MIN_ALLOCATED_STEP_DURATION;
  const allocations=weights.map(w=>Number((
    MIN_ALLOCATED_STEP_DURATION+weightedBudget*w/weightTotal).toFixed(3)));
  allocations[allocations.length-1]=Number((allocations[allocations.length-1]
    +total-allocations.reduce((sum,d)=>sum+d,0)).toFixed(3));
  const durationByIndex=new Map(enabled.map(({index},position)=>[index,allocations[position]]));
  return steps.map((step,index)=>durationByIndex.has(index)
    ?{...step,duration:durationByIndex.get(index)}:step);
}
function sameStepSet(previous,next){
  if(previous.length!==next.length) return false;
  const previousIds=new Set(previous.map(s=>s.id));
  return next.every(s=>previousIds.has(s.id));
}
function stepStart(steps,index){
  return activeSteps(steps).slice(0,index).reduce((sum,s)=>sum+s.duration,0);
}
function frameAt(allSteps,timeSeconds){
  const steps=activeSteps(allSteps);
  if(!steps.length) throw new Error("The timeline requires at least one animation event");
  const total=durationFor(steps);
  const elapsed=Math.min(Math.max(timeSeconds,0),total);
  let cursor=0, stepIndex=0;
  for(let index=0;index<steps.length;index+=1){
    const end=cursor+steps[index].duration;
    if(elapsed<end||index===steps.length-1){ stepIndex=index; break }
    cursor=end;
  }
  const step=steps[stepIndex];
  const progress=clamp01((elapsed-cursor)/step.duration);
  const completedThrough=progress>=1?stepIndex+1:stepIndex;
  return {step, stepIndex, progress, elapsed,
    completedIds:new Set(steps.slice(0,completedThrough).map(i=>i.id))};
}
function formatClock(seconds){
  const rounded=Math.max(0,Math.floor(seconds));
  return `${String(Math.floor(rounded/60)).padStart(2,"0")}:${String(rounded%60).padStart(2,"0")}`;
}

/* ============================================================
   timelineLabels.ts -- which dense tick labels can stay visible.
   ============================================================ */
function labeledTimelineIndices(positionsPx,activeIndex,minGapPx=36){
  const n=positionsPx.length;
  if(n===0) return [];
  const forced=new Set([0,n-1]);
  if(activeIndex>=0&&activeIndex<n) forced.add(activeIndex);
  const forcedOrder=[...forced].sort((a,b)=>positionsPx[a]-positionsPx[b]||a-b);
  const keptForced=[];
  for(const index of forcedOrder){
    const previous=keptForced[keptForced.length-1];
    if(previous===undefined||positionsPx[index]-positionsPx[previous]>=minGapPx){
      keptForced.push(index); continue;
    }
    const preferCurrent=index===activeIndex||(previous!==activeIndex&&index===n-1);
    if(preferCurrent){ keptForced.pop(); keptForced.push(index) }
  }
  const labeled=new Set(keptForced);
  let lastX=Number.NEGATIVE_INFINITY;
  const nextForcedAfter=from=>{
    for(const index of keptForced) if(index>from) return index;
    return undefined;
  };
  for(let index=0;index<n;index+=1){
    if(labeled.has(index)){ lastX=positionsPx[index]; continue }
    const nextForced=nextForcedAfter(index);
    const nextX=nextForced!==undefined?positionsPx[nextForced]:Number.POSITIVE_INFINITY;
    if(positionsPx[index]-lastX>=minGapPx&&nextX-positionsPx[index]>=minGapPx){
      labeled.add(index); lastX=positionsPx[index];
    }
  }
  return [...labeled].sort((a,b)=>a-b);
}

/* ============================================================
   storyTimeline.ts -- parse the timeline export and build the animated spec.

   The input is exactly what the Timeline tab's "Export JSON" button produces
   (see timelineExport in app.js): storyId, title, phase, exportedAt,
   transitions, segments[]. Validating it rather than trusting it means a
   hand-edited or truncated file fails with a precise message instead of
   animating something wrong.
   ============================================================ */
function assertRecord(value,name){
  if(!value||typeof value!=="object"||Array.isArray(value)) throw new Error(`${name} must be an object`);
}
function requiredString(value,name){
  if(typeof value!=="string"||!value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}
function optionalString(value){return typeof value==="string"?value.trim():""}
function finiteNumber(value,name){
  if(typeof value!=="number"||!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}
function parseCounts(value,name){
  assertRecord(value,name);
  return Object.fromEntries(Object.entries(value)
    .map(([key,count])=>[key,finiteNumber(count,`${name}.${key}`)]));
}
function parseItems(value,name){
  if(!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item,index)=>{
    assertRecord(item,`${name}[${index}]`);
    return {kind:optionalString(item.kind), at:optionalString(item.at),
      id:optionalString(item.id), severity:optionalString(item.severity),
      status:optionalString(item.status), category:optionalString(item.category),
      agent:optionalString(item.agent), detail:optionalString(item.detail)};
  });
}
function parseSegment(value,position){
  assertRecord(value,`segments[${position}]`);
  const enteredAt=requiredString(value.enteredAt,`segments[${position}].enteredAt`);
  if(!Number.isFinite(Date.parse(enteredAt)))
    throw new Error(`segments[${position}].enteredAt must be a valid timestamp`);
  const leftAt=optionalString(value.leftAt);
  if(leftAt&&!Number.isFinite(Date.parse(leftAt)))
    throw new Error(`segments[${position}].leftAt must be a valid timestamp`);
  return {
    index:finiteNumber(value.index,`segments[${position}].index`),
    phase:requiredString(value.phase,`segments[${position}].phase`),
    action:requiredString(value.action,`segments[${position}].action`),
    enteredAt, leftAt,
    heldFor:optionalString(value.heldFor),
    agent:optionalString(value.agent),
    reason:optionalString(value.reason),
    findingCount:finiteNumber(value.findingCount??0,`segments[${position}].findingCount`),
    counts:parseCounts(value.counts??{},`segments[${position}].counts`),
    items:parseItems(value.items??[],`segments[${position}].items`),
  };
}
function formatTimestamp(value){
  const d=new Date(value);
  const pad=n=>String(n).padStart(2,"0");
  return `${d.getMonth()+1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function storySegmentDurationMs(segment,exportedAt){
  return Math.max(0,Date.parse(segment.leftAt||exportedAt)-Date.parse(segment.enteredAt));
}
function storyEventSourceDurationMs(event,exportedAt){
  return storySegmentDurationMs(event.sourceSegment??event.segment,exportedAt);
}
function formatResidence(milliseconds){
  const minutes=Math.max(0,Math.round(milliseconds/60000));
  if(minutes<60) return `${minutes}m`;
  const hours=Math.floor(minutes/60), remainder=minutes%60;
  return remainder?`${hours}h ${remainder}m`:`${hours}h`;
}
function eventLabel(segment,exportedAt){
  const duration=segment.heldFor||formatResidence(storySegmentDurationMs(segment,exportedAt));
  return [
    `#${segment.index} · ${formatTimestamp(segment.enteredAt)} · ${duration}`,
    segment.findingCount>0?`findings: ${segment.findingCount}`:"",
  ].filter(Boolean).join("\n");
}
function escapeLabel(value){
  return String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/\n/g,"<br/>");
}

/** Canonical forward lifecycle, ending in either terminal state. */
const FORWARD_PHASES=["INIT","INIT_CHECK","PLAN","DEV","REVIEW","TEST","DONE"];
const TERMINAL_PHASES=["DONE","DISCARDED"];
function isTerminalPhase(phase){return TERMINAL_PHASES.includes(phase)}
/* A transition is "backward" (drawn dotted) when it moves to an earlier phase.
   Phases outside the canonical list are ranked after it, in first-seen order,
   so an unknown phase never silently reads as rework. */
function isBackwardTransition(fromPhase,toPhase,seenPhases=[]){
  if(fromPhase===toPhase) return false;
  const fromTerminal=isTerminalPhase(fromPhase), toTerminal=isTerminalPhase(toPhase);
  if(toTerminal&&!fromTerminal) return false;
  if(fromTerminal&&!toTerminal) return true;
  if(fromTerminal&&toTerminal) return false;
  const rank=phase=>{
    const canonical=FORWARD_PHASES.indexOf(phase);
    if(canonical>=0) return canonical;
    const seen=seenPhases.indexOf(phase);
    return seen>=0?FORWARD_PHASES.length+seen:Number.POSITIVE_INFINITY;
  };
  return rank(fromPhase)>rank(toPhase);
}

/* One node per phase, one labelled arrow per recorded transition.

   The `EVENT_<n>@` edge ids are what let the animation find its arrow in the
   rendered SVG and walk the transitions in recorded order -- without them the
   only handle is DOM order, which Dagre does not guarantee matches time. */
function buildMermaid(doc,events){
  const phases=[...new Set(doc.segments.map(s=>s.phase))];
  const phaseIds=new Map(phases.map((phase,index)=>[phase,`PHASE_${index}`]));
  const visits=new Map(phases.map(p=>[p,0]));
  const residence=new Map(phases.map(p=>[p,0]));
  for(const segment of doc.segments){
    visits.set(segment.phase,(visits.get(segment.phase)??0)+1);
    residence.set(segment.phase,(residence.get(segment.phase)??0)
      +storySegmentDurationMs(segment,doc.exportedAt));
  }
  const diagramConfig={
    flowchart:{curve:"basis", htmlLabels:false, nodeSpacing:72, rankSpacing:100},
    themeCSS:[
      ".edgeLabel p { background: transparent !important; background-color: transparent !important; max-width: 240px; white-space: normal; line-height: 1.35; text-align: center; }",
      ".edgeLabel, .edgeLabel .label, .edgeLabel .labelBkg { background: transparent !important; background-color: transparent !important; }",
      ".edgeLabel foreignObject, .edgeLabel foreignObject * { background: none !important; background-color: transparent !important; background-image: none !important; box-shadow: none !important; }",
      ".edgeLabel rect { fill: transparent !important; stroke: none !important; }",
      ".flowchart-link { stroke-width: 1px !important; }",
      `.nodeLabel, .nodeLabel text, .node text { font-family: ${DIAGRAM_SANS} !important; }`,
      `.edgeLabel, .edgeLabel text, .edgeLabel tspan { font-family: ${DIAGRAM_MONO} !important; }`,
      ".nodeLabel p { line-height: 1.35; }",
    ].join(" "),
  };
  const lines=[`%%{init: ${JSON.stringify(diagramConfig)}}%%`,"flowchart LR"];
  for(const phase of phases){
    const current=phase===doc.phase?"<br/>Current":"";
    const klass=PH_VAR[phase]?`:::${phaseClassName(phase)}`:"";
    lines.push(`    ${phaseIds.get(phase)}["${escapeLabel(phase)}<br/>`
      +`${formatResidence(residence.get(phase)??0)} · ${visits.get(phase)} visits${current}"]${klass}`);
  }
  const nodeFill=diagramInk().nodeFill;
  for(const phase of phases){
    if(!PH_VAR[phase]) continue;
    const id=phaseIds.get(phase);
    const klass=phaseClassName(phase);
    const stroke=phaseBorderColor(phase);
    lines.push(`    classDef ${klass} fill:${nodeFill},stroke:${stroke},color:${stroke}`);
    lines.push(`    style ${id} stroke:${stroke}`);
  }
  let edgeIndex=0;
  for(const event of events){
    if(!event.fromPhase) continue;
    const from=phaseIds.get(event.fromPhase), to=phaseIds.get(event.toPhase);
    const arrow=isBackwardTransition(event.fromPhase,event.toPhase,phases)?"-.->":"-->";
    lines.push(`    ${from} EVENT_${event.sequence}@${arrow}|"${escapeLabel(event.label)}"| ${to}`);
    event.edgeIndex=edgeIndex;
    edgeIndex+=1;
  }
  return lines.join("\n");
}

function parseStoryTimeline(text){
  let value;
  try{ value=JSON.parse(text) }
  catch(error){ throw new Error(`Unable to parse timeline JSON: ${error&&error.message||error}`) }
  assertRecord(value,"timeline root");
  if(!Array.isArray(value.segments)||!value.segments.length)
    throw new Error("segments must be a non-empty array");
  const segments=value.segments.map(parseSegment).sort((a,b)=>a.index-b.index);
  const indexes=new Set();
  for(const segment of segments){
    if(indexes.has(segment.index)) throw new Error(`segment index ${segment.index} is duplicated`);
    indexes.add(segment.index);
  }
  const doc={
    storyId:requiredString(value.storyId,"storyId"),
    title:requiredString(value.title,"title"),
    phase:requiredString(value.phase,"phase"),
    exportedAt:requiredString(value.exportedAt,"exportedAt"),
    transitions:finiteNumber(value.transitions,"transitions"),
    segments,
  };
  if(!Number.isFinite(Date.parse(doc.exportedAt)))
    throw new Error("exportedAt must be a valid timestamp");
  if(doc.transitions!==segments.length)
    throw new Error(`transitions=${doc.transitions} does not match the ${segments.length} segments`);
  if(!segments.some(s=>s.phase===doc.phase))
    throw new Error(`Current phase ${doc.phase} does not appear in segments`);
  const events=segments.map((segment,index)=>({
    sequence:segment.index,
    fromPhase:index?segments[index-1].phase:undefined,
    toPhase:segment.phase,
    ...(index?{edgeIndex:index-1}:{}),
    label:eventLabel(segment,doc.exportedAt),
    segment,
    ...(index?{sourceSegment:segments[index-1]}:{}),
  }));
  return {...doc, events, mermaid:buildMermaid(doc,events)};
}

/* ============================================================
   discover.ts -- find animation targets in Mermaid's rendered SVG.

   Nothing here knows about phases: it reads the geometry Mermaid produced and
   pairs paths with labels and endpoint nodes. The caller maps those DOM handles
   onto story events afterwards, so a layout change cannot silently reorder the
   animation.
   ============================================================ */
function svgTextOf(element){
  if(!element) return "";
  const clone=element.cloneNode(true);
  for(const br of Array.from(clone.querySelectorAll("br"))) br.replaceWith("\n");
  Array.from(clone.querySelectorAll("tspan.text-outer-tspan")).forEach((line,index)=>{
    if(index) line.before("\n");
  });
  return (clone.textContent||"").split("\n")
    .map(l=>l.replace(/\s+/g," ").trim()).filter(Boolean).join("\n");
}
function elementCenter(element){
  const box=element.getBBox();
  const local=new DOMPoint(box.x+box.width/2,box.y+box.height/2);
  const matrix=element.getCTM();
  const point=matrix?local.matrixTransform(matrix):local;
  return {x:point.x, y:point.y};
}
function pathEndpoint(path,atEnd){
  const point=path.getPointAtLength(atEnd?path.getTotalLength():0);
  const matrix=path.getCTM();
  return matrix?new DOMPoint(point.x,point.y).matrixTransform(matrix):point;
}
function nearestNodeInfo(nodes,point){
  return nodes.reduce((best,node)=>{
    const distance=Math.hypot(node.x-point.x,node.y-point.y);
    return distance<best.distance?{node,distance}:best;
  },{distance:Number.POSITIVE_INFINITY}).node;
}
function discoverAnimationSteps(svg){
  const nodeElements=Array.from(svg.querySelectorAll("g.node"));
  const nodes=nodeElements.map((element,index)=>({
    id:`node-${index}`, domId:element.id,
    label:svgTextOf(element)||`Node ${index+1}`,
    ...elementCenter(element),
  }));
  const edgeLabels=Array.from(svg.querySelectorAll("g.edgeLabel"));
  const edges=Array.from(svg.querySelectorAll("path.flowchart-link")).map((path,index)=>{
    const edgeKey=Number(path.dataset.playbackEdgeIndex??index);
    const pairedLabel=edgeLabels.find(l=>Number(l.dataset.playbackEdgeIndex)===edgeKey)
      ??edgeLabels[index];
    const label=svgTextOf(pairedLabel);
    const sequenceMatch=path.id.match(/EVENT_(\d+)/)??label.match(/#\s*(\d+)/);
    return {
      id:`edge-${index}`, domId:path.id||`edge-${index}`,
      label:label||`Edge ${index+1}`,
      sequence:sequenceMatch?Number(sequenceMatch[1]):undefined,
      svgEdgeIndex:edgeKey,
      fromNodeId:nearestNodeInfo(nodes,pathEndpoint(path,false))?.domId,
      toNodeId:nearestNodeInfo(nodes,pathEndpoint(path,true))?.domId,
      order:edgeKey,
    };
  });
  return {nodes, edges};
}

/* ============================================================
   MermaidStage -- the live SVG. Renders the spec once, then paints one frame
   at a time and drives the camera.

   The React component became a factory returning the same handle the export
   pipeline consumed (getExportScene / applyFrame / zoomIn / zoomOut), so the
   encoder code below is untouched by the port.
   ============================================================ */
function edgeParts(svg,step){
  const index=step.svgEdgeIndex??Number(String(step.id).replace("edge-",""));
  return {
    path:svg.querySelector(`path.flowchart-link[data-playback-edge-index="${index}"]`)
      ??svg.querySelectorAll("path.flowchart-link")[index],
    label:svg.querySelector(`g.edgeLabel[data-playback-edge-index="${index}"]`)
      ??svg.querySelectorAll("g.edgeLabel")[index],
  };
}
/* Key every path and label by its EVENT_<n> sequence where present, and stash
   the marker/dash Mermaid gave it -- the frame painter clears those to hide an
   edge and needs the originals to restore it. */
function indexEdges(svg){
  Array.from(svg.querySelectorAll("path.flowchart-link")).forEach((path,index)=>{
    const sequence=path.id.match(/EVENT_(\d+)/)?.[1];
    path.dataset.playbackEdgeIndex=sequence??String(index);
    path.dataset.playbackMarkerEnd=path.getAttribute("marker-end")??"";
    path.dataset.playbackDasharray=getComputedStyle(path).strokeDasharray||"none";
  });
  Array.from(svg.querySelectorAll("g.edgeLabel")).forEach((label,index)=>{
    const sequence=label.textContent?.match(/#\s*(\d+)/)?.[1];
    label.dataset.playbackEdgeIndex=sequence??String(index);
  });
}
function nodeById(svg,domId){
  if(!domId) return null;
  return Array.from(svg.querySelectorAll("g.node")).find(n=>n.id===domId)??null;
}
/* Geometry helpers all resolve into the ROOT svg's coordinate space, because
   that is the space the viewBox is expressed in. Mermaid nests everything under
   transformed groups, so a raw getBBox is in the wrong frame. */
function pointInRoot(svg,path,progress){
  const local=path.getPointAtLength(path.getTotalLength()*progress);
  const point=svg.createSVGPoint();
  point.x=local.x; point.y=local.y;
  const pathMatrix=path.getCTM(), rootMatrix=svg.getCTM();
  return pathMatrix&&rootMatrix
    ?point.matrixTransform(pathMatrix).matrixTransform(rootMatrix.inverse())
    :point;
}
function rectInRoot(svg,element){
  const box=element.getBBox();
  const elementMatrix=element.getCTM(), rootMatrix=svg.getCTM();
  if(!elementMatrix||!rootMatrix) return box;
  const transform=(x,y)=>{
    const point=svg.createSVGPoint();
    point.x=x; point.y=y;
    return point.matrixTransform(elementMatrix).matrixTransform(rootMatrix.inverse());
  };
  const points=[transform(box.x,box.y), transform(box.x+box.width,box.y),
    transform(box.x,box.y+box.height), transform(box.x+box.width,box.y+box.height)];
  const xs=points.map(p=>p.x), ys=points.map(p=>p.y);
  return {x:Math.min(...xs), y:Math.min(...ys),
    width:Math.max(...xs)-Math.min(...xs), height:Math.max(...ys)-Math.min(...ys)};
}
function rootVectorInParent(svg,parent,dx,dy){
  const rootMatrix=svg.getCTM(), parentMatrix=parent.getCTM();
  if(!rootMatrix||!parentMatrix) return {x:dx,y:dy};
  const rootPoint=(x,y)=>{
    const point=svg.createSVGPoint();
    point.x=x; point.y=y;
    return point.matrixTransform(rootMatrix).matrixTransform(parentMatrix.inverse());
  };
  const origin=rootPoint(0,0), target=rootPoint(dx,dy);
  return {x:target.x-origin.x, y:target.y-origin.y};
}
/* Mermaid's edge labels are HTML in foreignObject and carry their own plate.
   Ours sit directly on the diagram, so every background layer is stripped --
   inline, with !important, because the serialised SVG used by PNG/video export
   does not carry the page stylesheet. */
function clearEdgeLabelBackgrounds(svg){
  for(const label of Array.from(svg.querySelectorAll("g.edgeLabel"))){
    label.style.setProperty("background","none","important");
    label.style.setProperty("background-color","transparent","important");
    label.querySelectorAll("foreignObject, .label, .labelBkg, foreignObject *").forEach(el=>{
      el.style.setProperty("background","none","important");
      el.style.setProperty("background-color","transparent","important");
      el.style.setProperty("background-image","none","important");
      el.style.setProperty("box-shadow","none","important");
    });
    label.querySelectorAll("rect").forEach(rect=>{
      rect.setAttribute("fill","none");
      rect.setAttribute("stroke","none");
      rect.style.setProperty("fill","none","important");
      rect.style.setProperty("stroke","none","important");
    });
  }
}
function tetherDistantEdgeLabels(svg){
  const labels=Array.from(svg.querySelectorAll("g.edgeLabel"));
  const entries=Array.from(svg.querySelectorAll("path.flowchart-link")).flatMap((path,domIndex)=>{
    const edgeIndex=Number(path.dataset.playbackEdgeIndex??domIndex);
    const label=labels.find((candidate,labelIndex)=>
      Number(candidate.dataset.playbackEdgeIndex??labelIndex)===edgeIndex);
    if(!label) return [];
    const pathPoints=Array.from({length:97},(_,index)=>pointInRoot(svg,path,index/96));
    return [{id:String(edgeIndex), rect:rectInRoot(svg,label), path:pathPoints, label}];
  });
  const obstacles=Array.from(svg.querySelectorAll("g.node")).map(n=>rectInRoot(svg,n));
  const adjustments=tetherEdgeLabels(entries,obstacles);
  for(const entry of entries){
    const adjustment=adjustments.get(entry.id);
    const parent=entry.label.parentElement;
    if(!adjustment||!parent||(!adjustment.dx&&!adjustment.dy)) continue;
    const local=rootVectorInParent(svg,parent,adjustment.dx,adjustment.dy);
    const original=entry.label.getAttribute("transform")??"";
    entry.label.setAttribute("transform",`translate(${local.x} ${local.y}) ${original}`.trim());
  }
}
function nearestNodeElements(svg,path){
  const points=[pointInRoot(svg,path,0), pointInRoot(svg,path,1)];
  const nodes=Array.from(svg.querySelectorAll("g.node"));
  return points.map(point=>nodes.reduce((best,node)=>{
    const box=rectInRoot(svg,node);
    const distance=Math.hypot(box.x+box.width/2-point.x, box.y+box.height/2-point.y);
    return distance<best.distance?{node,distance}:best;
  },{node:null,distance:Number.POSITIVE_INFINITY}).node).filter(Boolean);
}
function stepNodeElements(svg,path,step){
  const direct=[nodeById(svg,step.fromNodeId),nodeById(svg,step.toNodeId)].filter(Boolean);
  return direct.length===2?direct:nearestNodeElements(svg,path);
}
function unionBoxes(boxes){
  const x=Math.min(...boxes.map(b=>b.x)), y=Math.min(...boxes.map(b=>b.y));
  const right=Math.max(...boxes.map(b=>b.x+b.width));
  const bottom=Math.max(...boxes.map(b=>b.y+b.height));
  return {x, y, width:right-x, height:bottom-y};
}
/* Open framed on the first phase at a readable zoom, not fitted to the whole
   diagram: a 100-transition story fits at a scale where no label is legible. */
function readableOpeningView(svg,aspect){
  const boxes=Array.from(svg.querySelectorAll("g.node")).map(n=>rectInRoot(svg,n));
  if(!boxes.length) return null;
  const widths=boxes.map(b=>b.width).sort((a,b)=>a-b);
  const focusWidth=Math.max(620,widths[Math.floor(widths.length/2)]*5);
  const first=boxes[0];
  return centerViewBox({x:0,y:0,width:focusWidth,height:focusWidth/aspect},
    first.x+first.width/2, first.y+first.height/2);
}
function stableFollowView(svg,openingView,aspect){
  const widths=Array.from(svg.querySelectorAll("g.node"))
    .map(n=>rectInRoot(svg,n).width).sort((a,b)=>a-b);
  const medianNodeWidth=widths[Math.floor(widths.length/2)]??openingView.width/5;
  return followViewBox(openingView,medianNodeWidth,aspect);
}
function sampledPathBounds(svg,path,progress){
  const sampleCount=Math.max(2,Math.ceil(clamp01(progress)*48));
  const points=Array.from({length:sampleCount+1},(_,index)=>
    pointInRoot(svg,path,clamp01(progress)*index/sampleCount));
  return boundsForPoints(points,14);
}
function visibleContentBounds(svg){
  const boxes=Array.from(svg.querySelectorAll("g.node, path.flowchart-link, g.edgeLabel"))
    .filter(el=>Number.parseFloat(getComputedStyle(el).opacity||"1")>.01)
    .map(el=>rectInRoot(svg,el));
  for(const overlay of Array.from(svg.querySelectorAll("path.playback-active-edge"))){
    if(Number.parseFloat(getComputedStyle(overlay).opacity||"0")<=.01) continue;
    const edgeIndex=overlay.dataset.playbackSourceEdgeIndex;
    const sourcePath=edgeIndex===undefined?null
      :svg.querySelector(`path.flowchart-link[data-playback-edge-index="${edgeIndex}"]`);
    const progress=Number(overlay.dataset.playbackProgress??0);
    const bounds=sourcePath?sampledPathBounds(svg,sourcePath,progress):null;
    if(bounds) boxes.push(bounds);
  }
  return boxes.length?unionBoxes(boxes):null;
}
/* Recover the label's visual lines. Mermaid emits either <br> or one
   text-outer-tspan per line depending on htmlLabels, and the exported Canvas
   frame has to break in the same places as the screen. */
function exportTextLines(element){
  if(!element) return [];
  const clone=element.cloneNode(true);
  for(const br of Array.from(clone.querySelectorAll("br"))) br.replaceWith("\n");
  Array.from(clone.querySelectorAll("tspan.text-outer-tspan")).forEach((line,index)=>{
    if(index) line.before("\n");
  });
  return (clone.textContent??"").split("\n")
    .map(l=>l.replace(/\s+/g," ").trim()).filter(Boolean);
}
function paintFill(element,color){
  element.setAttribute("fill",color);
  element.style.setProperty("fill",color,"important");
}
function lineText(element){return (element.textContent??"").replace(/\s+/g," ").trim()}
/* Colour the phase name in its own hue and the metadata lines in neutral ink.
   Painted as attributes, not classes, so the serialised SVG the exporter reads
   already carries the colours. */
function paintPhaseTitles(svg){
  svg.style.setProperty("font-family",DIAGRAM_SANS);
  const meta=diagramInk().nodeInk;
  for(const node of Array.from(svg.querySelectorAll("g.node"))){
    const lines=exportTextLines(node);
    const phase=lines[0]??"";
    const shape=node.querySelector("rect, polygon, path, circle");
    const computedStroke=shape?getComputedStyle(shape).stroke:"";
    const mapped=phaseBorderColor(phase);
    const color=mapped!==DEFAULT_NODE_STROKE?mapped
      :computedStroke&&computedStroke!=="none"?computedStroke:mapped;
    node.style.setProperty("--node-accent",color);
    node.dataset.phase=phase;
    const outers=Array.from(node.querySelectorAll("tspan.text-outer-tspan, tspan.row"));
    const linesToPaint=outers.length?outers:Array.from(node.querySelectorAll("text > tspan"));
    if(!linesToPaint.length){
      node.querySelectorAll("text").forEach(text=>paintFill(text,color));
      continue;
    }
    linesToPaint.forEach((line,index)=>{
      const text=lineText(line);
      const accent=index===0||text===phase||text==="Current";
      paintFill(line,accent?color:meta);
      line.querySelectorAll("tspan").forEach(inner=>paintFill(inner,accent?color:meta));
    });
    node.querySelectorAll("text, tspan").forEach(el=>{
      el.style.setProperty("font-family",DIAGRAM_SANS,"important");
    });
  }
  for(const label of Array.from(svg.querySelectorAll("g.edgeLabel"))){
    label.querySelectorAll("text, tspan").forEach(el=>{
      el.style.setProperty("font-family",DIAGRAM_MONO,"important");
    });
  }
}
function parseStrokeDasharray(value){
  const values=String(value).split(/[ ,]+/).map(p=>Number.parseFloat(p))
    .filter(p=>Number.isFinite(p)&&p>0);
  return values.length&&values.some(p=>p>.01)?values:[];
}

/* Freeze the rendered SVG into plain numbers and strings.

   The exporter cannot read the live DOM: it renders off-screen at 1920x1080
   while the viewer keeps animating, and getBBox/getCTM are expensive enough
   that calling them per frame would dominate the encode. So the geometry is
   captured once -- node rects, sampled edge polylines, label rects, text lines
   -- and every exported frame is drawn from that snapshot. */
function captureExportScene(svg,openingView,followView){
  const nodes=Array.from(svg.querySelectorAll("g.node")).map(node=>{
    const lines=exportTextLines(node);
    return {id:node.id, bounds:rectInRoot(svg,node), lines,
      stroke:phaseBorderColor(lines[0]??"")};
  });
  const labels=Array.from(svg.querySelectorAll("g.edgeLabel"));
  const edges=Array.from(svg.querySelectorAll("path.flowchart-link")).map((path,domIndex)=>{
    const index=Number(path.dataset.playbackEdgeIndex??domIndex);
    const length=path.getTotalLength();
    const sampleCount=Math.max(32,Math.min(640,Math.ceil(length/6)));
    const points=Array.from({length:sampleCount+1},(_,pointIndex)=>
      pointInRoot(svg,path,pointIndex/sampleCount));
    const labelElement=labels.find((label,labelIndex)=>
      Number(label.dataset.playbackEdgeIndex??labelIndex)===index)??null;
    return {index, points,
      dash:parseStrokeDasharray(path.dataset.playbackDasharray??""),
      label:labelElement
        ?{bounds:rectInRoot(svg,labelElement), lines:exportTextLines(labelElement)}
        :null};
  });
  const bounds=[
    ...nodes.map(n=>n.bounds),
    ...edges.flatMap(edge=>{
      const pathBounds=boundsForPoints(edge.points);
      return [pathBounds, edge.label?.bounds??null].filter(Boolean);
    }),
  ];
  const overviewBounds=bounds.length?unionBoxes(bounds):openingView;
  return {
    openingView:{...openingView},
    followView:{...followView},
    overviewView:limitViewBoxMinSize(
      fitRectToAspect(overviewBounds,Math.max(.1,followView.width/followView.height),.08),
      followView.width),
    worldBounds:padRect(overviewBounds,32),
    nodes, edges,
  };
}

/* The travelling stroke is drawn on a clone, not on Mermaid's own path.

   Animating the original's dash offset works, but the completed edges behind it
   share that element, so a partially drawn active edge would erase history the
   moment it is revisited -- and a rework-heavy story revisits constantly. */
function activeOverlayFor(svg,path,edgeIndex){
  let overlay=svg.querySelector(
    `path.playback-active-edge[data-playback-source-edge-index="${edgeIndex}"]`);
  if(!overlay){
    overlay=path.cloneNode(false);
    overlay.removeAttribute("id");
    overlay.removeAttribute("data-playback-edge-index");
    overlay.setAttribute("class","playback-active-edge");
    overlay.dataset.playbackSourceEdgeIndex=String(edgeIndex);
    overlay.setAttribute("fill","none");
    overlay.removeAttribute("stroke-dasharray");
    overlay.removeAttribute("stroke-dashoffset");
    overlay.style.removeProperty("visibility");
    overlay.style.removeProperty("opacity");
    path.parentElement?.append(overlay);
  }
  return overlay;
}
function prepareInitialVisibility(svg,gsap){
  const targets=svg.querySelectorAll("g.node, path.flowchart-link, g.edgeLabel");
  if(targets.length) gsap.set(targets,{opacity:0});
}

/* Paint exactly one frame.

   Every frame is drawn from scratch out of `frame.completedIds` rather than by
   accumulating changes, which is what makes scrubbing backwards and seeking
   land in the same state as playing forwards to that point. */
function applyVisualFrame(svg,frame,steps,gsap){
  clearEdgeLabelBackgrounds(svg);
  paintPhaseTitles(svg);
  const activeStep=frame.step;
  const motionProgress=activeStep.kind==="edge"
    ?edgeTravelProgress(frame.progress):flowProgress(frame.progress);
  const dwellPulse=phaseDwellPulse(frame.progress);
  const allNodes=Array.from(svg.querySelectorAll("g.node"));
  const allEdges=Array.from(svg.querySelectorAll("path.flowchart-link"));
  const allLabels=Array.from(svg.querySelectorAll("g.edgeLabel"));
  const activeOverlays=Array.from(svg.querySelectorAll("path.playback-active-edge"));

  const visualElements=[...allNodes,...allEdges,...allLabels];
  if(visualElements.length) gsap.set(visualElements,{opacity:0});
  if(activeOverlays.length) gsap.set(activeOverlays,{opacity:0});
  activeOverlays.forEach(overlay=>{
    delete overlay.dataset.playbackActive;
    delete overlay.dataset.playbackProgress;
    overlay.setAttribute("marker-end","none");
  });

  const completedNodes=new Set();
  const completedEdgeIndexes=new Set();
  for(const step of steps){
    if(!frame.completedIds.has(step.id)) continue;
    if(step.kind==="node"){
      const node=nodeById(svg,step.domId);
      if(node) completedNodes.add(node);
      continue;
    }
    const path=edgeParts(svg,step).path;
    if(!path) continue;
    completedEdgeIndexes.add(step.svgEdgeIndex??Number(String(step.id).replace("edge-","")));
    stepNodeElements(svg,path,step).forEach(node=>completedNodes.add(node));
  }

  let activeSourcePath=null;
  let activeEdgeColor=DEFAULT_EDGE_STROKE;
  allEdges.forEach((path,domIndex)=>{
    const edgeIndex=Number(path.dataset.playbackEdgeIndex??domIndex);
    const done=completedEdgeIndexes.has(edgeIndex);
    const markerEnd=path.dataset.playbackMarkerEnd??"";
    path.setAttribute("marker-end",done&&markerEnd?markerEnd:"none");
    gsap.set(path,{
      opacity:done?1:0,
      visibility:done?"visible":"hidden",
      strokeDasharray:done?path.dataset.playbackDasharray??"none":path.getTotalLength(),
      strokeDashoffset:0, strokeWidth:1, stroke:DEFAULT_EDGE_STROKE});
  });
  allLabels.forEach((label,domIndex)=>{
    const edgeIndex=Number(label.dataset.playbackEdgeIndex??domIndex);
    gsap.set(label,{opacity:completedEdgeIndexes.has(edgeIndex)?1:0});
    delete label.dataset.playbackActive;
  });
  if(completedNodes.size) gsap.set(Array.from(completedNodes),{opacity:1,filter:"none"});

  const activeComplete=frame.completedIds.has(activeStep.id);
  if(!activeComplete&&activeStep.kind==="node"){
    const node=nodeById(svg,activeStep.domId);
    if(node){
      const glow=hexToRgba(phaseBorderColor(exportTextLines(node)[0]??""),.8);
      gsap.set(node,{
        opacity:Math.max(completedNodes.has(node)?1:0,motionProgress),
        filter:`drop-shadow(0 0 7px ${glow})`});
    }
  } else if(!activeComplete){
    const {path,label}=edgeParts(svg,activeStep);
    if(path){
      const edgeIndex=activeStep.svgEdgeIndex??Number(String(activeStep.id).replace("edge-",""));
      const overlay=activeOverlayFor(svg,path,edgeIndex);
      const length=path.getTotalLength();
      const markerEnd=path.dataset.playbackMarkerEnd??"";
      const dash=parseStrokeDasharray(path.dataset.playbackDasharray??"");
      const [fromNode,toNode]=stepNodeElements(svg,path,activeStep);
      activeEdgeColor=fromNode
        ?phaseBorderColor(exportTextLines(fromNode)[0]??""):DEFAULT_EDGE_STROKE;
      overlay.setAttribute("marker-end",motionProgress>.985&&markerEnd?markerEnd:"none");
      gsap.set(overlay,{opacity:Math.min(1,motionProgress*5), visibility:"visible",
        strokeWidth:1, stroke:activeEdgeColor});
      if(dash.length){
        overlay.style.setProperty("stroke-dasharray",dashedStrokeReveal(length,motionProgress,dash));
        overlay.style.setProperty("stroke-dashoffset","0");
      } else {
        overlay.style.setProperty("stroke-dasharray",String(length));
        overlay.style.setProperty("stroke-dashoffset",String(length*(1-motionProgress)));
      }
      overlay.dataset.playbackActive="true";
      overlay.dataset.playbackProgress=String(motionProgress);
      // The cloned overlay can briefly report a null CTM after insertion.
      // Always derive motion coordinates from Mermaid's connected source path.
      activeSourcePath=path;
      if(fromNode){
        gsap.set(fromNode,{opacity:1,
          filter:phaseGlowFilter(dwellPulse,phaseBorderColor(exportTextLines(fromNode)[0]??""))});
      }
      if(toNode){
        const arrival=clamp01((motionProgress-.72)/.28);
        gsap.set(toNode,{opacity:Math.max(completedNodes.has(toNode)?1:0,arrival), filter:"none"});
      }
    }
    if(label){
      gsap.set(label,{opacity:clamp01((motionProgress-.28)/.24)});
      label.dataset.playbackActive="true";
    }
  }

  let token=svg.querySelector("path.playback-token");
  if(!token){
    token=document.createElementNS("http://www.w3.org/2000/svg","path");
    token.classList.add("playback-token");
    token.setAttribute("d","M -4 -4 L 4 0 L -4 4 Z");
    token.setAttribute("fill",DEFAULT_EDGE_STROKE);
    token.setAttribute("stroke",DEFAULT_EDGE_STROKE);
    token.setAttribute("stroke-width","1");
    token.setAttribute("stroke-linejoin","round");
    svg.append(token);
  }
  if(!activeComplete&&activeStep.kind==="edge"&&activeSourcePath){
    const point=pointInRoot(svg,activeSourcePath,motionProgress);
    const tangentStart=pointInRoot(svg,activeSourcePath,Math.max(0,motionProgress-.002));
    const tangentEnd=pointInRoot(svg,activeSourcePath,Math.min(1,motionProgress+.002));
    const angle=Math.atan2(tangentEnd.y-tangentStart.y,tangentEnd.x-tangentStart.x)*180/Math.PI;
    token.setAttribute("fill",activeEdgeColor);
    token.setAttribute("stroke",activeEdgeColor);
    token.setAttribute("transform",`translate(${point.x} ${point.y}) rotate(${angle})`);
    token.style.opacity=String(tracerOpacity(motionProgress));
  } else {
    token.style.opacity="0";
  }
}

/* Build the stage: renders the spec once, then exposes the frame/camera handle.

   `onDiscover` fires after the render with the DOM handles found in the SVG;
   the caller maps them onto story events. Camera state lives in closure
   variables rather than refs -- same lifetimes, no React. */
async function createStage(host,options){
  const {source, mermaid, gsap, onDiscover, onError, onManualCamera, onZoomChange}=options;
  const renderHost=document.createElement("div");
  renderHost.className="pbkrender";
  host.append(renderHost);

  let fitView=null;      // the opening frame; also the 100% zoom reference
  let followView=null;   // the fixed-size box the follow camera slides around
  let view=null;         // the viewBox actually on screen
  let zoomPercent=null;
  let cameraMode="overview";
  let drag=null;
  let overviewTarget=null, overviewAnimation=0;
  let followTarget=null, followPoint=null, followAnimation=0;

  const svgEl=()=>renderHost.querySelector("svg");
  const cancelAnimations=()=>{
    if(overviewAnimation) cancelAnimationFrame(overviewAnimation);
    if(followAnimation) cancelAnimationFrame(followAnimation);
    overviewAnimation=0; followAnimation=0;
    overviewTarget=null; followTarget=null; followPoint=null;
  };
  const setViewBox=(svg,box)=>{
    view=box;
    svg.setAttribute("viewBox",`${box.x} ${box.y} ${box.width} ${box.height}`);
    if(fitView){
      const percent=Math.round((fitView.width/box.width)*100);
      if(zoomPercent!==percent){ zoomPercent=percent; onZoomChange(percent) }
    }
  };
  const zoom=factor=>{
    cancelAnimations();
    const svg=svgEl();
    if(svg&&view){
      const next=zoomViewBox(view,factor);
      setViewBox(svg,fitView?limitViewBoxMinSize(next,fitView.width):next);
    }
  };
  /* Overview eases toward the bounding box of everything revealed so far, so
     the frame grows with the story instead of jumping on each new phase. It
     deliberately fits every visible node, edge and label: readability belongs
     to Follow/manual zoom, while Overview promises complete context. */
  const updateOverview=svg=>{
    const bounds=visibleContentBounds(svg);
    if(!bounds) return;
    const fitted=fitRectToAspect(bounds,
      Math.max(.1,host.clientWidth/Math.max(1,host.clientHeight)),.08);
    const minWidth=followView?.width??fitView?.width??fitted.width;
    overviewTarget=limitViewBoxMinSize(fitted,minWidth);
    if(overviewAnimation) return;
    const tick=()=>{
      if(cameraMode!=="overview"||!view||!overviewTarget){ overviewAnimation=0; return }
      const next=approachViewBox(view,overviewTarget);
      setViewBox(svg,next.box);
      if(next.settled){ overviewAnimation=0; return }
      overviewAnimation=requestAnimationFrame(tick);
    };
    overviewAnimation=requestAnimationFrame(tick);
  };
  /* Follow keeps a fixed-size box centred slightly ahead of the tracer, so the
     eye leads the motion rather than chasing it. `force` is the export path:
     it needs a deterministic per-frame step, not an rAF chase. */
  const follow=(svg,nextFrame,cameraSmoothing=1,maxViewportFraction=1,force=false)=>{
    if((cameraMode!=="follow"&&!force)||!view||!followView) return;
    let point=null, tracerPoint=null;
    if(nextFrame.step.kind==="node"){
      const node=nodeById(svg,nextFrame.step.domId);
      if(node){
        const box=rectInRoot(svg,node);
        point={x:box.x+box.width/2, y:box.y+box.height/2};
        tracerPoint=point;
      }
    } else {
      const {path,label}=edgeParts(svg,nextFrame.step);
      if(path){
        const progress=edgeTravelProgress(nextFrame.progress);
        const pathPoint=pointInRoot(svg,path,progress);
        const aheadPoint=pointInRoot(svg,path,Math.min(1,progress+.055));
        const labelRect=label&&progress>=.28?rectInRoot(svg,label):null;
        const [fromNode,toNode]=stepNodeElements(svg,path,nextFrame.step);
        const fromBox=fromNode?rectInRoot(svg,fromNode):null;
        const toBox=toNode?rectInRoot(svg,toNode):null;
        const fromCenter=fromBox
          ?{x:fromBox.x+fromBox.width/2, y:fromBox.y+fromBox.height/2}:pathPoint;
        const toCenter=toBox
          ?{x:toBox.x+toBox.width/2, y:toBox.y+toBox.height/2}:pathPoint;
        point=edgeFollowFocusPoint(pathPoint,aheadPoint,fromCenter,toCenter,
          labelRect,followView,progress);
        tracerPoint=pathPoint;
      }
    }
    if(!point) return;
    const centeredTarget=centerViewBox(followView,point.x,point.y);
    const target=tracerPoint?keepPointVisible(centeredTarget,tracerPoint,.18):centeredTarget;
    if(cameraSmoothing>=1){
      cancelAnimations();
      setViewBox(svg,maxViewportFraction>=1
        ?target:limitViewBoxMovement(view,target,maxViewportFraction));
      return;
    }
    if(force){
      cancelAnimations();
      setViewBox(svg,smoothForcedFollowFrame(view,target,tracerPoint,
        cameraSmoothing,maxViewportFraction));
      return;
    }
    followTarget=target; followPoint=tracerPoint;
    if(followAnimation) return;
    const tick=()=>{
      if(cameraMode!=="follow"||!view||!followTarget){ followAnimation=0; return }
      const next=approachViewBox(view,followTarget,cameraSmoothing);
      setViewBox(svg,followPoint?keepPointVisible(next.box,followPoint,.04):next.box);
      if(next.settled){ followAnimation=0; return }
      followAnimation=requestAnimationFrame(tick);
    };
    followAnimation=requestAnimationFrame(tick);
  };

  // ---- pointer + wheel: any manual gesture takes the camera off auto ----
  host.addEventListener("pointerdown",event=>{
    if(event.button!==0) return;
    event.preventDefault();
    drag={x:event.clientX, y:event.clientY};
    host.setPointerCapture(event.pointerId);
    host.classList.add("is-grabbing");
  });
  host.addEventListener("pointermove",event=>{
    if(!drag||!view) return;
    const previous=drag;
    drag={x:event.clientX, y:event.clientY};
    const svg=svgEl();
    if(!svg) return;
    cancelAnimations();
    onManualCamera();
    setViewBox(svg,panViewBox(view,event.clientX-previous.x,event.clientY-previous.y,
      host.clientWidth,host.clientHeight));
  });
  const endDrag=()=>{ drag=null; host.classList.remove("is-grabbing") };
  host.addEventListener("pointerup",endDrag);
  host.addEventListener("pointercancel",endDrag);
  host.addEventListener("wheel",event=>{
    event.preventDefault();
    cancelAnimations();
    onManualCamera();
    zoom(event.deltaY<0?.9:1.1);
  },{passive:false});

  let resizeObserver=null;
  if(typeof ResizeObserver!=="undefined"){
    resizeObserver=new ResizeObserver(()=>{
      if(cameraMode!=="overview") return;
      const svg=svgEl();
      if(svg) updateOverview(svg);
    });
    resizeObserver.observe(host);
  }

  const loading=document.createElement("div");
  loading.className="pbkloading";
  loading.textContent="Rendering diagram…";
  host.append(loading);
  try{
    const result=await mermaid.render("pbk"+Date.now()+Math.random().toString(36).slice(2),source);
    renderHost.innerHTML=result.svg;
    result.bindFunctions?.(renderHost);
    const svg=svgEl();
    if(!svg) throw new Error("Mermaid did not produce an SVG");
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.setAttribute("preserveAspectRatio","xMidYMid meet");
    indexEdges(svg);
    paintPhaseTitles(svg);
    /* Inline the font rules into the SVG itself: the page stylesheet does not
       travel with a serialised SVG, and the exporter reads a serialisation. */
    const fontStyle=document.createElementNS("http://www.w3.org/2000/svg","style");
    fontStyle.textContent=`.node,.node text,.node tspan{font-family:${DIAGRAM_SANS}!important}`
      +`.edgeLabel,.edgeLabel text,.edgeLabel tspan{font-family:${DIAGRAM_MONO}!important}`;
    svg.append(fontStyle);
    clearEdgeLabelBackgrounds(svg);
    tetherDistantEdgeLabels(svg);
    prepareInitialVisibility(svg,gsap);
    const rect=host.getBoundingClientRect();
    const aspect=Math.max(.1,rect.width/Math.max(1,rect.height));
    const openingView=readableOpeningView(svg,aspect);
    if(openingView){
      fitView=openingView;
      followView=stableFollowView(svg,openingView,aspect);
      setViewBox(svg,openingView);
    }
    loading.remove();
    onDiscover(discoverAnimationSteps(svg));
    onError(null);
  }catch(error){
    loading.remove();
    onError(error instanceof Error?error.message:String(error));
  }

  return {
    getSvg:()=>svgEl(),
    getExportScene:()=>{
      const svg=svgEl();
      return svg&&fitView&&followView?captureExportScene(svg,fitView,followView):null;
    },
    applyFrame:(nextFrame,nextSteps,opts)=>{
      const svg=svgEl();
      if(!svg) return;
      applyVisualFrame(svg,nextFrame,nextSteps,gsap);
      follow(svg,nextFrame,opts?.cameraSmoothing??1,
        opts?.cameraMaxViewportFraction??1, opts?.forceFollow??false);
    },
    /* The live render path: paint, then let the camera chase per its mode. */
    renderFrame:(nextFrame,nextSteps,playing)=>{
      const svg=svgEl();
      if(!svg||!nextFrame) return;
      applyVisualFrame(svg,nextFrame,nextSteps,gsap);
      if(cameraMode==="overview"){
        if(followAnimation) cancelAnimationFrame(followAnimation);
        followAnimation=0; followTarget=null; followPoint=null;
        updateOverview(svg);
      } else if(cameraMode==="follow"){
        if(overviewAnimation) cancelAnimationFrame(overviewAnimation);
        overviewAnimation=0; overviewTarget=null;
        follow(svg,nextFrame,playing?.18:.24,1);
      } else {
        cancelAnimations();
      }
    },
    setCameraMode:mode=>{ cameraMode=mode },
    getCameraMode:()=>cameraMode,
    zoomIn:()=>zoom(.8),
    zoomOut:()=>zoom(1.25),
    destroy:()=>{ cancelAnimations(); resizeObserver?.disconnect() },
  };
}

/* ============================================================
   exportScene.ts -- the export camera, solved from the captured snapshot.

   The live camera reads the DOM; these read the frozen scene, so the exported
   clip is reproducible frame for frame instead of depending on when rAF
   happened to fire.
   ============================================================ */
function pointAlongPolyline(points,progress){
  if(!points.length) return {x:0,y:0};
  if(points.length===1) return points[0];
  const position=clamp01(progress)*(points.length-1);
  const index=Math.min(points.length-2,Math.floor(position));
  const amount=position-index;
  return {x:points[index].x+(points[index+1].x-points[index].x)*amount,
    y:points[index].y+(points[index+1].y-points[index].y)*amount};
}
function tangentAlongPolyline(points,progress){
  const before=pointAlongPolyline(points,clamp01(progress-.003));
  const after=pointAlongPolyline(points,clamp01(progress+.003));
  const length=Math.hypot(after.x-before.x,after.y-before.y)||1;
  return {x:(after.x-before.x)/length, y:(after.y-before.y)/length};
}
function boundsCenter(bounds){return {x:bounds.x+bounds.width/2, y:bounds.y+bounds.height/2}}
function visiblePoints(points,progress){
  if(!points.length) return [];
  const position=clamp01(progress)*(points.length-1);
  const whole=Math.floor(position);
  const visible=points.slice(0,whole+1);
  if(whole<points.length-1) visible.push(pointAlongPolyline(points,progress));
  return visible;
}
function overviewTargetForFrame(scene,frame,steps){
  const boxes=[];
  const addNode=id=>{
    const node=id?scene.nodes.find(n=>n.id===id):null;
    if(node) boxes.push(node.bounds);
  };
  const addEdge=index=>{
    const edge=index===undefined?null:scene.edges.find(e=>e.index===index);
    if(!edge) return;
    const pathBounds=boundsForPoints(edge.points,14);
    if(pathBounds) boxes.push(pathBounds);
    if(edge.label) boxes.push(edge.label.bounds);
  };
  for(const step of steps){
    if(!frame.completedIds.has(step.id)) continue;
    if(step.kind==="node") addNode(step.domId);
    else { addEdge(step.svgEdgeIndex); addNode(step.fromNodeId); addNode(step.toNodeId) }
  }
  if(!frame.completedIds.has(frame.step.id)){
    if(frame.step.kind==="node") addNode(frame.step.domId);
    else {
      const edge=scene.edges.find(e=>e.index===frame.step.svgEdgeIndex);
      const progress=edgeTravelProgress(frame.progress);
      addNode(frame.step.fromNodeId);
      if(progress>.72) addNode(frame.step.toNodeId);
      if(edge){
        const pathBounds=boundsForPoints(visiblePoints(edge.points,progress),14);
        if(pathBounds) boxes.push(pathBounds);
        if(progress>.28&&edge.label) boxes.push(edge.label.bounds);
      }
    }
  }
  if(!boxes.length) return scene.openingView;
  return limitViewBoxMinSize(
    fitRectToAspect(unionBoxes(boxes),
      Math.max(.1,scene.followView.width/scene.followView.height),.08),
    scene.followView.width);
}
function cameraForExportFrame(scene,frame,previousView,frameSeconds){
  let focus=null, tracer=null;
  if(frame.step.kind==="node"){
    const node=scene.nodes.find(n=>n.id===frame.step.domId);
    if(node){ focus=boundsCenter(node.bounds); tracer=focus }
  } else {
    const edge=scene.edges.find(e=>e.index===frame.step.svgEdgeIndex);
    if(edge){
      const progress=edgeTravelProgress(frame.progress);
      const point=pointAlongPolyline(edge.points,progress);
      const ahead=pointAlongPolyline(edge.points,Math.min(1,progress+.055));
      const fromNode=scene.nodes.find(n=>n.id===frame.step.fromNodeId);
      const toNode=scene.nodes.find(n=>n.id===frame.step.toNodeId);
      focus=edgeFollowFocusPoint(point,ahead,
        fromNode?boundsCenter(fromNode.bounds):point,
        toNode?boundsCenter(toNode.bounds):point,
        progress>=.28?edge.label?.bounds??null:null,
        scene.followView,progress);
      tracer=point;
    }
  }
  if(!focus) return previousView;
  const centered=centerViewBox(scene.followView,focus.x,focus.y);
  const target=tracer?keepPointVisible(centered,tracer,.18):centered;
  return smoothForcedFollowFrame(previousView,target,tracer,
    cameraSmoothingForFrame(frameSeconds,frame.step.duration),.12);
}
function cameraForExportMode(mode,scene,frame,steps,previousView,frameSeconds){
  if(mode==="follow") return cameraForExportFrame(scene,frame,previousView,frameSeconds);
  return approachViewBox(previousView,overviewTargetForFrame(scene,frame,steps),
    cameraSmoothingForFrame(frameSeconds,frame.step.duration)).box;
}

/* ============================================================
   canvasSceneRenderer.ts -- draw a frame of the scene onto a 2D context.

   The exporter cannot rasterise the live SVG per frame and stay near real time,
   so the diagram is redrawn as Canvas primitives from the snapshot. Completed
   history is painted once into two cached layers (edges behind, nodes/labels in
   front) and blitted; only the active edge, its endpoints and the tracer are
   drawn per frame.
   ============================================================ */
function exportTimelineTime(elapsed,duration,overviewSeconds){
  const overviewDuration=Math.min(Math.max(0,overviewSeconds),Math.max(0,duration));
  const animationDuration=Math.max(0,duration-overviewDuration);
  if(elapsed<=animationDuration||overviewDuration===0){
    return {timelineTime:animationDuration>0
      ?clamp01(elapsed/animationDuration)*duration:duration, overviewProgress:0};
  }
  return {timelineTime:duration,
    overviewProgress:clamp01((elapsed-animationDuration)/overviewDuration)};
}
function visiblePolyline(points,progress){return visiblePoints(points,progress)}
function strokeEdge(context,edge,progress,color,width){
  const points=visiblePolyline(edge.points,progress);
  if(points.length<2) return;
  context.save();
  context.strokeStyle=color;
  context.lineWidth=width;
  context.lineCap="round";
  context.lineJoin="round";
  context.setLineDash(edge.dash);
  context.beginPath();
  context.moveTo(points[0].x,points[0].y);
  for(let index=1;index<points.length;index+=1) context.lineTo(points[index].x,points[index].y);
  context.stroke();
  context.restore();
}
function drawArrow(context,point,tangent,color,size,glow=0){
  const normal={x:-tangent.y, y:tangent.x};
  const tip={x:point.x+tangent.x*size*.45, y:point.y+tangent.y*size*.45};
  const tail={x:point.x-tangent.x*size, y:point.y-tangent.y*size};
  context.save();
  context.fillStyle=color;
  context.strokeStyle=glow?"#fff3cf":color;
  context.lineWidth=glow?1.7:1;
  if(glow){ context.shadowColor=color; context.shadowBlur=glow }
  context.beginPath();
  context.moveTo(tip.x,tip.y);
  context.lineTo(tail.x+normal.x*size*.56, tail.y+normal.y*size*.56);
  context.lineTo(tail.x+tangent.x*size*.28, tail.y+tangent.y*size*.28);
  context.lineTo(tail.x-normal.x*size*.56, tail.y-normal.y*size*.56);
  context.closePath();
  context.fill();
  context.stroke();
  context.restore();
}
function drawSceneNode(context,node,alpha,glow,palette){
  if(alpha<=.001) return;
  const {bounds}=node;
  context.save();
  context.globalAlpha=clamp01(alpha);
  const stroke=node.stroke??DEFAULT_NODE_STROKE;
  context.fillStyle=palette.nodeFill;
  context.strokeStyle=stroke;
  context.lineWidth=glow>.01?2.4:1.5;
  if(glow>.01){
    context.shadowColor=hexToRgba(stroke,Math.min(.9,glow*.9));
    context.shadowBlur=18*glow;
  }
  context.fillRect(bounds.x,bounds.y,bounds.width,bounds.height);
  context.strokeRect(bounds.x,bounds.y,bounds.width,bounds.height);
  context.shadowBlur=0;
  context.textAlign="center";
  context.textBaseline="middle";
  /* Sizes are in world units, inside the camera transform, so what reaches the
     viewer depends on the zoom -- and Overview on a long story zooms out far.
     These are set larger than the on-screen SVG's equivalents because the
     export has no hover, no pan and no zoom: whatever the frame shows is all
     the reader gets, so it has to survive the widest shot. */
  const lineHeight=23;
  const firstY=bounds.y+bounds.height/2-((node.lines.length-1)*lineHeight)/2;
  node.lines.forEach((line,index)=>{
    context.fillStyle=index===0||line==="Current"?stroke:palette.nodeInk;
    context.font=index===0?`700 19px ${DIAGRAM_SANS}`:`500 17px ${DIAGRAM_SANS}`;
    context.fillText(line,bounds.x+bounds.width/2,firstY+index*lineHeight);
  });
  context.restore();
}
function drawSceneLabel(context,label,alpha,palette){
  if(alpha<=.001) return;
  context.save();
  context.globalAlpha=clamp01(alpha);
  context.fillStyle=palette.labelInk;
  context.textAlign="center";
  context.textBaseline="middle";
  // Mono at 13 units was the first thing to dissolve; bumped hardest.
  context.font=`500 15px ${DIAGRAM_MONO}`;
  const lineHeight=20;
  const firstY=label.bounds.y+label.bounds.height/2-((label.lines.length-1)*lineHeight)/2;
  label.lines.forEach((line,index)=>{
    context.fillText(line,label.bounds.x+label.bounds.width/2,firstY+index*lineHeight);
  });
  context.restore();
}
function createLayerCanvas(scene,scale){
  const canvas=document.createElement("canvas");
  canvas.width=Math.max(1,Math.ceil(scene.worldBounds.width*scale));
  canvas.height=Math.max(1,Math.ceil(scene.worldBounds.height*scale));
  const context=canvas.getContext("2d",{alpha:true, desynchronized:true});
  if(!context) throw new Error("Unable to create the accelerated scene layer");
  context.setTransform(scale,0,0,scale,
    -scene.worldBounds.x*scale, -scene.worldBounds.y*scale);
  context.imageSmoothingEnabled=true;
  context.imageSmoothingQuality="high";
  return {canvas, context};
}
function createSceneLayerCache(scene,maximumScale=1.5){
  const largestDimension=Math.max(scene.worldBounds.width,scene.worldBounds.height,1);
  const scale=Math.min(maximumScale,8192/largestDimension);
  const edges=createLayerCanvas(scene,scale);
  const foreground=createLayerCanvas(scene,scale);
  return {edgeCanvas:edges.canvas, foregroundCanvas:foreground.canvas,
    edgeContext:edges.context, foregroundContext:foreground.context, scale,
    drawnNodes:new Set(), drawnEdges:new Set(), drawnLabels:new Set()};
}
function cacheNode(cache,scene,palette,id){
  if(!id||cache.drawnNodes.has(id)) return;
  const node=scene.nodes.find(n=>n.id===id);
  if(!node) return;
  drawSceneNode(cache.foregroundContext,node,1,0,palette);
  cache.drawnNodes.add(id);
}
function cacheEdge(cache,scene,palette,index){
  if(index===undefined) return;
  const edge=scene.edges.find(e=>e.index===index);
  if(!edge) return;
  if(!cache.drawnEdges.has(index)){
    strokeEdge(cache.edgeContext,edge,1,DEFAULT_EDGE_STROKE,1);
    drawArrow(cache.edgeContext,pointAlongPolyline(edge.points,1),
      tangentAlongPolyline(edge.points,1),DEFAULT_EDGE_STROKE,8);
    cache.drawnEdges.add(index);
  }
  if(edge.label&&!cache.drawnLabels.has(index)){
    drawSceneLabel(cache.foregroundContext,edge.label,1,palette);
    cache.drawnLabels.add(index);
  }
}
function syncSceneLayerCache(cache,scene,frame,steps,palette){
  for(const step of steps){
    if(!frame.completedIds.has(step.id)) continue;
    if(step.kind==="node"){ cacheNode(cache,scene,palette,step.domId); continue }
    cacheEdge(cache,scene,palette,step.svgEdgeIndex);
    cacheNode(cache,scene,palette,step.fromNodeId);
    cacheNode(cache,scene,palette,step.toNodeId);
  }
}
function drawGrid(context,rect,palette){
  context.save();
  context.beginPath();
  context.rect(rect.x,rect.y,rect.width,rect.height);
  context.clip();
  context.strokeStyle=palette.grid;
  context.lineWidth=1;
  const spacing=64;
  for(let x=rect.x;x<=rect.x+rect.width;x+=spacing){
    context.beginPath(); context.moveTo(x,rect.y); context.lineTo(x,rect.y+rect.height); context.stroke();
  }
  for(let y=rect.y;y<=rect.y+rect.height;y+=spacing){
    context.beginPath(); context.moveTo(rect.x,y); context.lineTo(rect.x+rect.width,y); context.stroke();
  }
  context.restore();
}
function visibleSceneLayerSlice(world,view,scale,padding=32){
  const left=Math.max(world.x,view.x-padding);
  const top=Math.max(world.y,view.y-padding);
  const right=Math.min(world.x+world.width,view.x+view.width+padding);
  const bottom=Math.min(world.y+world.height,view.y+view.height+padding);
  if(right<=left||bottom<=top) return null;
  const destination={x:left,y:top,width:right-left,height:bottom-top};
  return {
    source:{x:(left-world.x)*scale,y:(top-world.y)*scale,
      width:destination.width*scale,height:destination.height*scale},
    destination,
  };
}
function drawVisibleSceneLayer(context,canvas,scene,view,scale){
  const slice=visibleSceneLayerSlice(scene.worldBounds,view,scale);
  if(!slice) return;
  context.drawImage(canvas,
    slice.source.x,slice.source.y,slice.source.width,slice.source.height,
    slice.destination.x,slice.destination.y,
    slice.destination.width,slice.destination.height);
}
function overviewCamera(view,scene,progress){
  return interpolateViewBox(view,scene.overviewView,flowProgress(progress));
}
function renderExportScene(context,scene,frame,steps,view,rect,cache,palette){
  drawGrid(context,rect,palette);
  syncSceneLayerCache(cache,scene,frame,steps,palette);
  const activeStep=frame.step;
  const activeEdge=activeStep.kind==="edge"
    ?scene.edges.find(e=>e.index===activeStep.svgEdgeIndex)??null:null;
  const motionProgress=activeStep.kind==="edge"
    ?edgeTravelProgress(frame.progress):flowProgress(frame.progress);
  const dwell=phaseDwellPulse(frame.progress);

  context.save();
  context.beginPath();
  context.rect(rect.x,rect.y,rect.width,rect.height);
  context.clip();
  context.translate(rect.x,rect.y);
  context.scale(rect.width/view.width, rect.height/view.height);
  context.translate(-view.x,-view.y);

  drawVisibleSceneLayer(context,cache.edgeCanvas,scene,view,cache.scale);

  const activeColor=(activeStep.fromNodeId
    ?scene.nodes.find(n=>n.id===activeStep.fromNodeId)?.stroke:null)??DEFAULT_EDGE_STROKE;

  if(activeEdge&&!frame.completedIds.has(activeStep.id))
    strokeEdge(context,activeEdge,motionProgress,activeColor,1);

  drawVisibleSceneLayer(context,cache.foregroundCanvas,scene,view,cache.scale);

  if(!frame.completedIds.has(activeStep.id)){
    if(activeStep.kind==="node"){
      const node=scene.nodes.find(n=>n.id===activeStep.domId);
      if(node) drawSceneNode(context,node,motionProgress,.72,palette);
    } else {
      if(activeStep.fromNodeId){
        const node=scene.nodes.find(n=>n.id===activeStep.fromNodeId);
        if(node) drawSceneNode(context,node,1,dwell,palette);
      }
      if(activeStep.toNodeId){
        const arrival=clamp01((motionProgress-.72)/.28);
        const node=scene.nodes.find(n=>n.id===activeStep.toNodeId);
        if(node) drawSceneNode(context,node,arrival,0,palette);
      }
    }
  }
  if(activeEdge?.label&&!frame.completedIds.has(activeStep.id))
    drawSceneLabel(context,activeEdge.label,clamp01((motionProgress-.28)/.24),palette);

  if(activeEdge&&!frame.completedIds.has(activeStep.id)){
    const point=pointAlongPolyline(activeEdge.points,motionProgress);
    context.globalAlpha=tracerOpacity(motionProgress);
    drawArrow(context,point,tangentAlongPolyline(activeEdge.points,motionProgress),activeColor,8);
  }
  context.restore();
}

/* ============================================================
   Export settings.
   ============================================================ */
const VIDEO_WIDTH=1920, VIDEO_HEIGHT=1080;
const FINAL_OVERVIEW_SECONDS=2.5;
const DIAGRAM_RECT={x:54, y:92, width:1812, height:820};
const EXPORT_SOFTWARE_ENCODER_LANES=4;
const HARDWARE_LANE_WEIGHT=2.3;
const EXPORT_CACHE_SCALE=1.25;
const MAX_ENCODER_QUEUE=8;
const VIDEO_FPS=30;
const VIDEO_FRAME_RATE_OPTIONS=[
  {value:30, label:"30 FPS", description:"Recommended for timeline animation and smaller files"},
  {value:60, label:"60 FPS", description:"Smoother motion with more frames and a larger file"},
];
const DEFAULT_VIDEO_COMPRESSION="balanced";
const VIDEO_COMPRESSION_PRESETS={
  balanced:{bitrate:{30:3000000, 60:5000000}, keyFrameIntervalSeconds:4,
    label:"Balanced", description:"Recommended low-loss balance of text clarity and file size"},
  maximum:{bitrate:{30:10000000, 60:10000000}, keyFrameIntervalSeconds:2,
    label:"Maximum", description:"Largest file with the highest H.264 bitrate"},
};
function videoCompressionSettings(preset,frameRate=VIDEO_FPS){
  const definition=VIDEO_COMPRESSION_PRESETS[preset];
  return {...definition, bitrate:definition.bitrate[frameRate]};
}
function approximateMegabytesPerMinute(preset,frameRate=VIDEO_FPS){
  return Math.round(videoCompressionSettings(preset,frameRate).bitrate*60/8/1000000);
}
/* 1440x810 keeps the diagram legible.

   The frame layout is authored at 1920x1080 with 15-17px node text, so the old
   960x540 halved it to ~7px and the labels turned to mush -- the chrome text
   still looked sharp because it is drawn per frame, while the diagram went
   through the downscale twice (once here, once in the layer cache).

   Not full 1080p: GIF is palette-indexed and uncompressed between frames, so
   pixel count drives file size almost linearly. 0.75x is the point where the
   text holds up without the file doubling again. */
const GIF_WIDTH=1440, GIF_HEIGHT=810, GIF_FRAME_RATE=10;
const GIF_FRAME_DELAY=1000/GIF_FRAME_RATE;
const GIF_MAX_COLORS=256;
const GIF_WORKER_MAX_IN_FLIGHT=16;
const GIF_WORKER_MIN_FRAMES=180;
/* The standalone exporter budgets 24 KiB per 960x540 frame. Scale that
   estimate for this port's deliberately sharper 1440x810 output so gifenc
   rarely has to copy and grow its backing buffer mid-export. */
const GIF_ESTIMATED_BYTES_PER_FRAME=54*1024;
const GIF_MAX_INITIAL_CAPACITY=96*1024*1024;
/* Supersample the cached history layers rather than rasterising them at 1x.

   Those layers hold every completed phase and edge and are blitted each frame,
   so at 1x the revealed history came out visibly softer than the actively
   drawn step beside it. Scaled to the GIF's own pixel density instead. */
const GIF_CACHE_SCALE=GIF_WIDTH/VIDEO_WIDTH*1.6;
function gifFrameCount(duration){return Math.max(1,Math.ceil(Math.max(0,duration)*GIF_FRAME_RATE))}
function gifProgressInterval(frameCount){return Math.max(1,Math.ceil(Math.max(1,frameCount)/100))}
function gifInitialCapacity(frameCount){
  return Math.min(GIF_MAX_INITIAL_CAPACITY,
    Math.max(GIF_WIDTH*GIF_HEIGHT,Math.max(1,frameCount)*GIF_ESTIMATED_BYTES_PER_FRAME));
}
async function yieldToBrowser(){
  if(typeof window.scheduler?.yield==="function"){
    await window.scheduler.yield();
    return;
  }
  await new Promise(resolve=>window.setTimeout(resolve,0));
}

/* Lazily import the ES-module encoders. Both are optional: a missing bundle
   disables its format rather than breaking the viewer. */
let mediabunnyPromise=null, gifencPromise=null, gifPaletteToolsPromise=null;
function loadMediabunny(){
  mediabunnyPromise??=import("/vendor/mediabunny.min.mjs");
  return mediabunnyPromise;
}
function loadGifenc(){
  gifencPromise??=import("/vendor/gifenc.esm.js");
  return gifencPromise;
}
function loadGifPaletteTools(){
  gifPaletteToolsPromise??=import("/vendor/gif-palette.js");
  return gifPaletteToolsPromise;
}

function downloadBlob(blob,name){
  const url=URL.createObjectURL(blob);
  const anchor=document.createElement("a");
  anchor.href=url; anchor.download=name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(()=>URL.revokeObjectURL(url),10000);
}
function exportStamp(){
  return new Date().toISOString().slice(0,19).replace(/[:T]/g,"-");
}

/* The frame around the diagram: title, current-event caption, progress rail.

   Painted in the page's own theme colours so an exported clip looks like the
   tool it came from. The diagram plate stays dark in both themes -- the phase
   hues and the node fill are tuned for a dark ground. */
function drawChrome(context,elapsed,duration,stepNumber,label,palette,title){
  context.fillStyle=palette.chrome.bg;
  context.fillRect(0,0,VIDEO_WIDTH,VIDEO_HEIGHT);
  context.fillStyle=palette.plate;
  context.fillRect(DIAGRAM_RECT.x,DIAGRAM_RECT.y,DIAGRAM_RECT.width,DIAGRAM_RECT.height);
  context.textAlign="left";
  context.textBaseline="alphabetic";
  context.fillStyle=palette.chrome.ink;
  context.font="600 34px Newsreader, Georgia, serif";
  context.fillText("Story Graph",54,60);
  context.fillStyle=palette.chrome.ink3;
  context.font=`20px ${DIAGRAM_SANS}`;
  context.fillText(title,258,59);

  context.fillStyle=palette.chrome.panel;
  context.fillRect(54,930,1812,120);
  context.fillStyle=palette.chrome.acc;
  context.font=`500 24px ${DIAGRAM_MONO}`;
  context.fillText(stepNumber,84,974);
  const [headline="",detail=""]=String(label).split("\n");
  context.fillStyle=palette.chrome.ink;
  context.font=`21px ${DIAGRAM_SANS}`;
  context.fillText(headline.slice(0,100),170,971);
  context.fillStyle=palette.chrome.ink2;
  context.font=`18px ${DIAGRAM_SANS}`;
  context.fillText(detail.slice(0,130),170,1002);
  context.fillStyle=palette.chrome.edge;
  context.fillRect(84,1023,1752,6);
  context.fillStyle=palette.chrome.rail;
  context.fillRect(84,1023,1752*Math.min(1,elapsed/duration),6);
}

/* Solve every frame's camera up front.

   The camera is a feedback loop -- each frame eases from the previous one -- so
   it cannot be evaluated out of order. Encoding runs several lanes in parallel
   over different frame ranges, so the whole path is computed sequentially here
   first and the lanes then just draw from the table. */
function prepareFrames(scene,steps,duration,frameCount,frameRate,cameraMode){
  const prepared=new Array(frameCount);
  let currentView={...scene.openingView};
  let overviewStartView=currentView;
  let returningToOverview=false;
  for(let index=0;index<frameCount;index+=1){
    const timestamp=index/frameRate;
    const renderTime=index===frameCount-1?duration:timestamp;
    const timing=exportTimelineTime(renderTime,duration,FINAL_OVERVIEW_SECONDS);
    const frame=frameAt(steps,timing.timelineTime);
    if(timing.overviewProgress>0){
      if(!returningToOverview){ returningToOverview=true; overviewStartView=currentView }
      currentView=overviewCamera(overviewStartView,scene,timing.overviewProgress);
    } else {
      currentView=cameraForExportMode(cameraMode,scene,frame,steps,currentView,1/frameRate);
    }
    prepared[index]={renderTime, timelineTime:timing.timelineTime,
      viewX:currentView.x, viewY:currentView.y,
      viewWidth:currentView.width, viewHeight:currentView.height};
  }
  return prepared;
}
function renderPreparedFrame(context,cache,scene,steps,duration,palette,title,preparedFrame){
  const frame=frameAt(steps,preparedFrame.timelineTime);
  drawChrome(context,preparedFrame.renderTime,duration,
    frame.step.sequence?`#${frame.step.sequence}`:`${frame.stepIndex+1}`,
    frame.step.label,palette,title);
  renderExportScene(context,scene,frame,steps,
    {x:preparedFrame.viewX, y:preparedFrame.viewY,
     width:preparedFrame.viewWidth, height:preparedFrame.viewHeight},
    DIAGRAM_RECT,cache,palette);
  return frame;
}

/* ---- pixel validation: prove the encoded frames actually show something ---- */
function diagramPixelMetrics(pixels,sampleStride=8){
  let visible=0, light=0, accent=0;
  for(let index=0;index<pixels.length;index+=4*sampleStride){
    const red=pixels[index], green=pixels[index+1], blue=pixels[index+2], alpha=pixels[index+3];
    const backgroundDifference=Math.abs(red-8)+Math.abs(green-17)+Math.abs(blue-29);
    if(backgroundDifference>45&&alpha>100) visible+=1;
    if(red>150&&green>160&&blue>170&&alpha>100) light+=1;
    if(blue>170&&blue-red>70&&blue-green>40&&alpha>100) accent+=1;
  }
  return {visible, light, accent};
}
function hasReadableDiagramPixels(metrics){
  return metrics.visible>=24&&(metrics.light>=6||metrics.accent>=6);
}

function createEncodingSurface(){
  const canvas=document.createElement("canvas");
  canvas.width=VIDEO_WIDTH; canvas.height=VIDEO_HEIGHT;
  const context=canvas.getContext("2d",{alpha:false, desynchronized:true});
  if(!context) throw new Error("Unable to create the Canvas encoding surface");
  context.imageSmoothingEnabled=true;
  context.imageSmoothingQuality="high";
  return {canvas, context};
}
/* Split the clip across lanes by weight. The hardware lane gets more frames
   because it drains faster; without weighting the software lanes finish and
   idle while it is still working. */
function buildSegments(frameCount,plans){
  const totalWeight=plans.reduce((sum,plan)=>sum+plan.weight,0);
  const segments=[];
  let startFrame=0;
  for(let index=0;index<plans.length;index+=1){
    const remainingSegments=plans.length-index;
    const remainingFrames=frameCount-startFrame;
    const proportionalFrames=Math.round(frameCount*plans[index].weight/totalWeight);
    const segmentFrames=index===plans.length-1?remainingFrames
      :Math.max(1,Math.min(remainingFrames-(remainingSegments-1),proportionalFrames));
    segments.push({startFrame, endFrame:startFrame+segmentFrames});
    startFrame+=segmentFrames;
  }
  return segments;
}
async function verifyVideo(mb,blob,expectedDuration,boundaries,frameRate){
  const input=new mb.Input({source:new mb.BlobSource(blob), formats:mb.ALL_FORMATS});
  const actualDuration=await input.computeDuration();
  const tolerance=Math.max(.08,2/frameRate);
  if(!Number.isFinite(actualDuration)||Math.abs(actualDuration-expectedDuration)>tolerance)
    throw new Error(`Video duration mismatch: expected ${expectedDuration.toFixed(2)}s, got ${actualDuration.toFixed(2)}s`);
  const track=await input.getPrimaryVideoTrack();
  if(!track) throw new Error("Video validation failed: no video track found");
  const packetSink=new mb.EncodedPacketSink(track);
  let packetCount=0;
  for await(const _packet of packetSink.packets()) packetCount+=1;
  const expectedFrames=Math.max(1,Math.ceil(expectedDuration*frameRate));
  if(packetCount!==expectedFrames)
    throw new Error(`Video frame mismatch: expected ${expectedFrames}, got ${packetCount}`);
  const sink=new mb.VideoSampleSink(track);
  const sample=await sink.getSample(
    Math.max(0,Math.min(expectedDuration/2,expectedDuration-1/frameRate)));
  if(!sample) throw new Error("Video validation failed: unable to read a middle frame");
  const canvas=document.createElement("canvas");
  canvas.width=VIDEO_WIDTH; canvas.height=VIDEO_HEIGHT;
  const context=canvas.getContext("2d",{willReadFrequently:true});
  if(!context) throw new Error("Video validation failed: unable to create a sampling canvas");
  const readPlate=()=>context.getImageData(DIAGRAM_RECT.x,DIAGRAM_RECT.y,
    DIAGRAM_RECT.width,DIAGRAM_RECT.height).data;
  sample.draw(context,0,0,VIDEO_WIDTH,VIDEO_HEIGHT);
  sample.close();
  if(!hasReadableDiagramPixels(diagramPixelMetrics(readPlate())))
    throw new Error("Video validation failed: the middle frame is missing readable diagram text or accent strokes");
  // Lane boundaries are where a dropped keyframe would show up as a grey frame.
  for(const boundary of boundaries){
    const boundarySample=await sink.getSample(
      Math.min(expectedDuration-1/frameRate,boundary+1/frameRate));
    if(!boundarySample) throw new Error(`Video validation failed at encoder boundary ${boundary.toFixed(2)}s`);
    boundarySample.draw(context,0,0,VIDEO_WIDTH,VIDEO_HEIGHT);
    boundarySample.close();
    if(!hasReadableDiagramPixels(diagramPixelMetrics(readPlate())))
      throw new Error(`Video validation failed: unreadable encoder boundary at ${boundary.toFixed(2)}s`);
  }
  return actualDuration;
}
async function waitForEncoderCapacity(lane){
  if(lane.failure) throw lane.failure;
  if(lane.encoder.encodeQueueSize<=MAX_ENCODER_QUEUE) return;
  await new Promise((resolve,reject)=>{
    const onDequeue=()=>{
      if(lane.failure){
        lane.encoder.removeEventListener("dequeue",onDequeue);
        reject(lane.failure);
      } else if(lane.encoder.encodeQueueSize<=MAX_ENCODER_QUEUE){
        lane.encoder.removeEventListener("dequeue",onDequeue);
        resolve();
      }
    };
    lane.encoder.addEventListener("dequeue",onDequeue);
    onDequeue();
  });
}
/* avc3 (in-band parameter sets) first, highest profile first: it survives being
   concatenated across lanes, which avc1 does not. */
async function createEncoderConfig(hardwareAcceleration,bitrate,frameRate){
  for(const codec of ["avc3.64002A","avc3.4D002A","avc3.42002A"]){
    const config={codec, width:VIDEO_WIDTH, height:VIDEO_HEIGHT, bitrate,
      bitrateMode:"variable", framerate:frameRate, latencyMode:"realtime",
      hardwareAcceleration, avc:{format:"annexb"}};
    const support=await VideoEncoder.isConfigSupported(config);
    if(support.supported) return support.config??config;
  }
  return null;
}
async function createEncoderPlans(frameCount,bitrate,frameRate){
  const softwareConfig=await createEncoderConfig("prefer-software",bitrate,frameRate);
  if(!softwareConfig)
    throw new Error("No compatible software H.264 encoder is available in this browser");
  const softwareLaneCount=Math.min(frameCount,EXPORT_SOFTWARE_ENCODER_LANES,
    Math.max(2,Math.floor(Math.max(1,navigator.hardwareConcurrency||8)/2)));
  const plans=Array.from({length:softwareLaneCount},()=>({config:softwareConfig, weight:1}));
  const hardwareConfig=await createEncoderConfig("prefer-hardware",bitrate,frameRate);
  if(hardwareConfig&&plans.length<frameCount)
    plans.push({config:hardwareConfig, weight:HARDWARE_LANE_WEIGHT});
  return plans;
}
function createEncoderLane(mb,config,scene){
  const {canvas,context}=createEncodingSurface();
  const lane={canvas, context, encoder:null, packets:[], failure:null,
    cache:createSceneLayerCache(scene,EXPORT_CACHE_SCALE)};
  lane.encoder=new VideoEncoder({
    output:(chunk,metadata)=>{
      lane.packets.push({packet:mb.EncodedPacket.fromEncodedChunk(chunk), metadata});
    },
    error:error=>{ lane.failure=error instanceof Error?error:new Error(String(error)) },
  });
  lane.encoder.configure(config);
  return lane;
}
async function encodeSegment(lane,segment,prepared,scene,steps,duration,palette,title,
    frameRate,keyFrameIntervalSeconds,reportFrame){
  lane.packets=[];
  for(let index=segment.startFrame;index<segment.endFrame;index+=1){
    renderPreparedFrame(lane.context,lane.cache,scene,steps,duration,palette,title,prepared[index]);
    const timestamp=Math.round(index*1000000/frameRate);
    const endTimestamp=Math.round(Math.min(duration,(index+1)/frameRate)*1000000);
    const videoFrame=new VideoFrame(lane.canvas,
      {timestamp, duration:Math.max(1,endTimestamp-timestamp)});
    try{
      lane.encoder.encode(videoFrame,{
        keyFrame:index===segment.startFrame
          ||index%Math.max(1,Math.round(frameRate*keyFrameIntervalSeconds))===0});
    } finally { videoFrame.close() }
    reportFrame();
    await waitForEncoderCapacity(lane);
  }
  await lane.encoder.flush();
  if(lane.failure) throw lane.failure;
  return lane.packets;
}
async function exportAnimationVideo({stage,steps,duration,cameraMode,palette,title,storyId,
    compression=DEFAULT_VIDEO_COMPRESSION, frameRate=VIDEO_FPS, onProgress}){
  const scene=stage.getExportScene();
  if(!scene) throw new Error("The diagram has not finished preparing its export geometry");
  if(!window.VideoEncoder||!window.VideoFrame)
    throw new Error("This browser does not support offline video encoding. Use the latest Chrome or Edge.");
  const mb=await loadMediabunny();

  const format=new mb.Mp4OutputFormat();
  const target=new mb.BufferTarget();
  const output=new mb.Output({format, target});
  const videoSource=new mb.EncodedVideoPacketSource("avc");
  output.addVideoTrack(videoSource,{frameRate});
  await output.start();

  const frameCount=Math.max(1,Math.ceil(duration*frameRate));
  const compressionSettings=videoCompressionSettings(compression,frameRate);
  const plans=await createEncoderPlans(frameCount,compressionSettings.bitrate,frameRate);
  const laneCount=plans.length;
  const segments=buildSegments(frameCount,plans);
  const prepared=prepareFrames(scene,steps,duration,frameCount,frameRate,cameraMode);
  const lanes=plans.map(plan=>createEncoderLane(mb,plan.config,scene));
  let completedFrames=0, nextProgressFrame=0, firstPacket=true;
  try{
    for(let waveStart=0;waveStart<segments.length;waveStart+=laneCount){
      const wave=segments.slice(waveStart,waveStart+laneCount);
      const packetGroups=await Promise.all(wave.map((segment,laneIndex)=>encodeSegment(
        lanes[laneIndex],segment,prepared,scene,steps,duration,palette,title,frameRate,
        compressionSettings.keyFrameIntervalSeconds,
        ()=>{
          completedFrames+=1;
          if(completedFrames>=nextProgressFrame){
            onProgress(completedFrames/frameCount);
            nextProgressFrame=completedFrames+Math.max(1,Math.floor(frameCount/100));
          }
        })));
      for(const packets of packetGroups){
        for(const {packet,metadata} of packets){
          await videoSource.add(packet,firstPacket?metadata:undefined);
          firstPacket=false;
        }
        packets.length=0;
      }
      await new Promise(resolve=>window.setTimeout(resolve,0));
    }
    await output.finalize();
  }catch(error){
    if(output.state==="started") await output.cancel();
    throw error;
  }finally{
    for(const lane of lanes) if(lane.encoder.state!=="closed") lane.encoder.close();
  }

  if(!target.buffer?.byteLength) throw new Error("The encoded video is empty");
  const video=new Blob([target.buffer],{type:format.mimeType});
  const boundaries=segments.slice(1).map(segment=>segment.startFrame/frameRate);
  const actualDuration=await verifyVideo(mb,video,duration,boundaries,frameRate);
  downloadBlob(video,`${storyId}-timeline-${exportStamp()}.mp4`);
  onProgress(1);
  return {bytes:video.size, mimeType:format.mimeType, duration:actualDuration};
}

/* ---- GIF: one global palette, sampled across the clip ---- */
const GIF_PALETTE_SAMPLE_COUNT=7;
const GIF_SAMPLE_PIXEL_STRIDE=4;
function createGifSurface(){
  const canvas=document.createElement("canvas");
  canvas.width=GIF_WIDTH; canvas.height=GIF_HEIGHT;
  // Every frame is read back for quantisation, so ask for the CPU-side buffer
  // up front rather than letting the browser migrate it off the GPU per frame.
  const context=canvas.getContext("2d",
    {alpha:false, desynchronized:true, willReadFrequently:true});
  if(!context) throw new Error("Unable to create the GIF encoding surface");
  context.imageSmoothingEnabled=true;
  context.imageSmoothingQuality="high";
  return {canvas, context};
}
function renderGifFrame(context,cache,scene,steps,duration,palette,title,preparedFrame){
  // Draw at 1080p coordinates and scale down, so one layout serves both formats.
  context.setTransform(GIF_WIDTH/VIDEO_WIDTH,0,0,GIF_HEIGHT/VIDEO_HEIGHT,0,0);
  renderPreparedFrame(context,cache,scene,steps,duration,palette,title,preparedFrame);
  context.resetTransform();
}
function samplePixels(data){
  const sampled=new Uint8Array(Math.ceil(data.length/4/GIF_SAMPLE_PIXEL_STRIDE)*4);
  let output=0;
  for(let input=0;input<data.length;input+=4*GIF_SAMPLE_PIXEL_STRIDE){
    sampled[output]=data[input];
    sampled[output+1]=data[input+1];
    sampled[output+2]=data[input+2];
    sampled[output+3]=data[input+3];
    output+=4;
  }
  return output===sampled.length?sampled:sampled.slice(0,output);
}
function mergeSamples(samples){
  const merged=new Uint8Array(samples.reduce((total,s)=>total+s.length,0));
  let offset=0;
  for(const sample of samples){ merged.set(sample,offset); offset+=sample.length }
  return merged;
}
function paletteSampleIndexes(frameCount){
  const maximum=Math.max(0,frameCount-1);
  const count=Math.min(GIF_PALETTE_SAMPLE_COUNT,frameCount);
  return Array.from({length:count},(_,index)=>
    Math.round(maximum*index/Math.max(1,count-1)));
}
/* Quantise once over frames sampled across the whole clip.

   A per-frame palette would shift colours as phases appear and the diagram
   would visibly flicker between hues. */
async function buildGlobalPalette(gifenc,context,scene,steps,duration,palette,title,prepared,onProgress){
  const cache=createSceneLayerCache(scene,GIF_CACHE_SCALE);
  const indexes=paletteSampleIndexes(prepared.length);
  const samples=[];
  for(let sampleIndex=0;sampleIndex<indexes.length;sampleIndex+=1){
    renderGifFrame(context,cache,scene,steps,duration,palette,title,prepared[indexes[sampleIndex]]);
    samples.push(samplePixels(context.getImageData(0,0,GIF_WIDTH,GIF_HEIGHT).data));
    onProgress((sampleIndex+1)/indexes.length*.08);
    await yieldToBrowser();
  }
  return gifenc.quantize(mergeSamples(samples),GIF_MAX_COLORS,{format:"rgb565"});
}
function isCompleteGif(bytes){
  if(bytes.length<7||bytes[bytes.length-1]!==0x3b) return false;
  return new TextDecoder().decode(bytes.subarray(0,6))==="GIF89a";
}
async function encodePreparedFramesOnMainThread(
  gifenc,createPaletteMapper,context,scene,steps,duration,themePalette,title,
  prepared,gifPalette,onProgress){
  const frameCount=prepared.length;
  const progressInterval=gifProgressInterval(frameCount);
  let nextProgressFrame=progressInterval;
  const cache=createSceneLayerCache(scene,GIF_CACHE_SCALE);
  const mapPalette=createPaletteMapper(gifPalette);
  const encoder=gifenc.GIFEncoder({initialCapacity:gifInitialCapacity(frameCount)});

  for(let index=0;index<frameCount;index+=1){
    renderGifFrame(context,cache,scene,steps,duration,themePalette,title,prepared[index]);
    const rgba=context.getImageData(0,0,GIF_WIDTH,GIF_HEIGHT).data;
    const indexed=mapPalette(rgba);
    encoder.writeFrame(indexed,GIF_WIDTH,GIF_HEIGHT,
      {palette:index===0?gifPalette:undefined,delay:GIF_FRAME_DELAY,repeat:0});
    if(index+1>=nextProgressFrame){
      onProgress(.08+(index+1)/frameCount*.9);
      nextProgressFrame+=progressInterval;
    }
    if(index%8===7) await yieldToBrowser();
  }
  encoder.finish();
  return encoder.bytes().buffer;
}
async function encodePreparedFramesInWorker(
  context,scene,steps,duration,themePalette,title,prepared,gifPalette,onProgress){
  const worker=new Worker("/vendor/gif-encoder.worker.js",{type:"module"});
  const cache=createSceneLayerCache(scene,GIF_CACHE_SCALE);
  const frameCount=prepared.length;
  const progressInterval=gifProgressInterval(frameCount);
  let nextProgressFrame=progressInterval;
  let acknowledgedFrame=-1;
  let failure=null;
  const capacityWaiters=[];
  let resolveResult;
  let rejectResult;
  const resultPromise=new Promise((resolve,reject)=>{
    resolveResult=resolve;
    rejectResult=reject;
  });
  void resultPromise.catch(()=>undefined);

  const wakeCapacityWaiters=()=>{
    for(const resolve of capacityWaiters.splice(0)) resolve();
  };
  const fail=error=>{
    if(failure) return;
    failure=error;
    rejectResult(error);
    wakeCapacityWaiters();
  };
  worker.onmessage=event=>{
    const message=event.data;
    if(message.type==="error"){
      fail(new Error(message.message));
      return;
    }
    if(message.type==="encoded"){
      acknowledgedFrame=Math.max(acknowledgedFrame,message.index);
      if(message.index+1>=nextProgressFrame){
        onProgress(.08+(message.index+1)/frameCount*.9);
        nextProgressFrame+=progressInterval;
      }
      wakeCapacityWaiters();
      return;
    }
    if(message.type==="done") resolveResult(message.bytes);
  };
  worker.onerror=event=>{
    event.preventDefault();
    fail(new Error(event.message||"GIF encoder worker failed"));
  };
  worker.postMessage({type:"initialize",width:GIF_WIDTH,height:GIF_HEIGHT,frameCount,
    delay:GIF_FRAME_DELAY,palette:gifPalette,initialCapacity:gifInitialCapacity(frameCount)});

  try{
    for(let index=0;index<frameCount;index+=1){
      while(index-acknowledgedFrame>GIF_WORKER_MAX_IN_FLIGHT){
        await new Promise(resolve=>capacityWaiters.push(resolve));
        if(failure) throw failure;
      }
      renderGifFrame(context,cache,scene,steps,duration,themePalette,title,prepared[index]);
      const rgba=context.getImageData(0,0,GIF_WIDTH,GIF_HEIGHT).data;
      worker.postMessage({type:"frame",index,rgba:rgba.buffer},[rgba.buffer]);
      if(index%8===7) await yieldToBrowser();
    }
    return await resultPromise;
  }finally{
    worker.terminate();
  }
}
async function exportAnimationGif({stage,steps,duration,cameraMode,palette,title,storyId,onProgress}){
  const scene=stage.getExportScene();
  if(!scene) throw new Error("The diagram has not finished preparing its export geometry");
  const [gifenc,{createRgb565PaletteMapper}]=await Promise.all([loadGifenc(),loadGifPaletteTools()]);
  const frameCount=gifFrameCount(duration);
  const prepared=prepareFrames(scene,steps,duration,frameCount,GIF_FRAME_RATE,cameraMode);
  const {context}=createGifSurface();
  const gifPalette=await buildGlobalPalette(gifenc,context,scene,steps,duration,
    palette,title,prepared,onProgress);
  let encodedBytes;
  try{
    encodedBytes=frameCount>=GIF_WORKER_MIN_FRAMES&&typeof Worker!=="undefined"
      ?await encodePreparedFramesInWorker(context,scene,steps,duration,palette,
        title,prepared,gifPalette,onProgress)
      :await encodePreparedFramesOnMainThread(gifenc,createRgb565PaletteMapper,context,
        scene,steps,duration,palette,title,prepared,gifPalette,onProgress);
  }catch{
    encodedBytes=await encodePreparedFramesOnMainThread(gifenc,createRgb565PaletteMapper,
      context,scene,steps,duration,palette,title,prepared,gifPalette,onProgress);
  }
  const bytes=new Uint8Array(encodedBytes);
  if(!isCompleteGif(bytes))
    throw new Error("GIF validation failed: the encoded animation is incomplete");
  const gif=new Blob([encodedBytes],{type:"image/gif"});
  downloadBlob(gif,`${storyId}-timeline-${exportStamp()}.gif`);
  onProgress(1);
  return {bytes:gif.size, mimeType:gif.type, duration:frameCount/GIF_FRAME_RATE};
}

/* ============================================================
   The viewer.

   Layout is the three regions asked for: a top bar (export + settings), the
   canvas, and the timeline transport. The source panel, details inspector,
   JSON upload and theme toggle from the standalone app are all dropped -- the
   timeline comes from the story already open in this page, and the theme is
   the page's.
   ============================================================ */
function el(tag,className,text){
  const node=document.createElement(tag);
  if(className) node.className=className;
  if(text!==undefined) node.textContent=text;
  return node;
}
const ICONS={
  play:'<path d="m8 5 11 7-11 7V5Z" fill="currentColor" stroke="none"/>',
  pause:'<path d="M8 5v14M16 5v14"/>',
  back:'<path d="M19 20 9 12l10-8v16ZM5 5v14"/>',
  next:'<path d="m5 4 10 8-10 8V4Zm14 1v14"/>',
  export:'<path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 16v4h14v-4"/>',
  settings:'<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  chevron:'<path d="m8 10 4 4 4-4"/>',
};
function icon(name){
  const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
  svg.setAttribute("viewBox","0 0 24 24");
  svg.setAttribute("aria-hidden","true");
  svg.innerHTML=ICONS[name];
  return svg;
}
function iconButton(className,name,label){
  const button=el("button",className);
  button.type="button";
  button.append(icon(name));
  if(label){ button.setAttribute("aria-label",label); button.title=label }
  return button;
}
function stepAccentColor(step){
  if(!step) return phaseBorderColor("");
  const phase=step.kind==="edge"
    ?step.fromPhase??step.toPhase
    :step.toPhase??step.fromPhase;
  return phaseBorderColor(phase??"");
}
/* Both export surfaces share one palette object, read once per export so a
   theme change mid-encode cannot produce a two-tone clip. */
function exportPalette(){
  return {chrome:chromeColors(), ...diagramInk()};
}

async function openPlaybackModal(story,timelineJson){
  const existing=document.getElementById("playbackModal");
  if(existing){
    // Use the existing player's cleanup path so its animation frame, observer
    // and document listeners do not survive a second Playback invocation.
    const existingClose=existing.querySelector(".pbkclose");
    if(existingClose) existingClose.click();
    else existing.remove();
  }

  const wrap=el("div","pbkmodal");
  wrap.id="playbackModal";

  // ---- top bar ----
  const bar=el("div","pbkbar");
  const heading=el("b",null,`${story.id} · timeline playback`);
  const sub=el("span","pbksub");
  const spacer=el("span","pbkspacer");
  const settingsButton=el("button","pbkbtn");
  settingsButton.type="button";
  settingsButton.append(icon("settings"),el("span",null,"Settings"));
  settingsButton.setAttribute("aria-expanded","false");
  const exportGroup=el("div","pbkexport");
  const exportButton=el("button","pbkbtn pbkprimary");
  exportButton.type="button";
  exportButton.setAttribute("aria-haspopup","menu");
  exportButton.setAttribute("aria-expanded","false");
  const exportLabel=el("span",null,"Export");
  exportButton.append(icon("export"),exportLabel,icon("chevron"));
  const exportMenu=el("div","pbkmenu");
  exportMenu.setAttribute("role","menu");
  exportMenu.hidden=true;
  exportGroup.append(exportButton,exportMenu);
  const closeButton=el("button","pbkbtn pbkclose",'Close');
  closeButton.type="button";
  bar.append(heading,sub,spacer,settingsButton,exportGroup,closeButton);

  // ---- settings drawer ----
  const settings=el("div","pbkset");
  settings.hidden=true;

  // ---- canvas ----
  const stageWrap=el("div","pbkstage");
  const cameraControls=el("div","pbkcam");
  const zoomOutButton=el("button",null,"−");
  const zoomReadout=el("output",null,"100%");
  const zoomInButton=el("button",null,"+");
  const overviewButton=el("button","pbkmode","Overview");
  const followButton=el("button","pbkmode","Follow");
  zoomOutButton.type=zoomInButton.type=overviewButton.type=followButton.type="button";
  zoomOutButton.setAttribute("aria-label","Zoom out");
  zoomInButton.setAttribute("aria-label","Zoom in");
  overviewButton.title="Fit everything revealed so far";
  followButton.title="Follow the current transition";
  cameraControls.append(zoomOutButton,zoomReadout,zoomInButton,overviewButton,followButton);
  const host=el("div","pbkhost");
  stageWrap.append(cameraControls,host);

  // ---- transport ----
  const transport=el("div","pbktl");
  const playButton=iconButton("pbkplay","play","Play");
  const clock=el("span","pbkclock");
  const timelineStack=el("div","pbkstack");
  const rail=el("div","pbkrail");
  const track=el("div","pbktrack");
  const railTrack=el("div","pbkline");
  const railProgress=el("div","pbkprog");
  const scrubber=el("input","pbkscrub");
  scrubber.type="range";
  scrubber.min="0";
  scrubber.step="0.01";
  scrubber.setAttribute("aria-label","Animation progress");
  track.append(railTrack,railProgress,scrubber);
  rail.append(track);
  timelineStack.append(rail);
  const prevButton=iconButton("pbktrans","back","Previous transition");
  const nextButton=iconButton("pbktrans","next","Next transition");
  transport.append(playButton,clock,timelineStack,prevButton,nextButton);

  const status=el("div","pbkstatus");
  status.setAttribute("role","status");
  status.hidden=true;

  wrap.append(bar,settings,stageWrap,transport,status);
  document.body.appendChild(wrap);

  // ---- state ----
  let timeline=null;
  let steps=[];
  let time=0;
  let playing=false;
  let speed=1;
  let stage=null;
  let cameraMode="overview";
  let exporting=false;
  let exportMenuOpen=false;
  let targetDuration=60;
  let durationAllocation="proportional";
  let videoFrameRate=VIDEO_FPS;
  let videoCompression=DEFAULT_VIDEO_COMPRESSION;
  let tickHandle=0;
  let lastTick=null;
  let statusTimer=0;
  let markers=[];
  let lastScrolledStep=-2, lastScrolledPlaying=null;
  let destroyed=false;
  let hasVideo=false, hasGif=false;

  const setStatus=(message,tone)=>{
    if(statusTimer) clearTimeout(statusTimer);
    if(!message){ status.hidden=true; return }
    status.textContent=message;
    status.className="pbkstatus"+(tone?" "+tone:"");
    status.hidden=false;
    if(tone!=="err") statusTimer=window.setTimeout(()=>{ status.hidden=true },6000);
  };
  const enabled=()=>activeSteps(steps);
  const duration=()=>durationFor(steps);
  const currentFrame=()=>enabled().length?frameAt(steps,time):null;

  /* ---- timeline ticks ----
     Rebuilt only when the step set or the revealed count changes; per-frame the
     code just moves the progress bar and the active class. */
  const buildMarkers=()=>{
    markers.forEach(m=>m.node.remove());
    markers=[];
    const total=duration();
    const list=enabled();
    if(!total||!list.length) return;
    const shortest=Math.min(...list.map(s=>s.duration));
    const width=Math.max(320,(total/Math.max(.2,shortest))*40);
    rail.style.width=width+"px";
    const positionsPx=list.map((_,index)=>(stepStart(steps,index)/total)*width);
    const labeled=new Set(labeledTimelineIndices(positionsPx,list.length-1));
    list.forEach((step,index)=>{
      const node=el("button","pbkmark");
      node.type="button";
      node.style.left=((stepStart(steps,index)/total)*100)+"%";
      node.style.color=stepAccentColor(step);
      node.title=step.label;
      if(labeled.has(index)) node.classList.add("is-labeled");
      node.append(el("span",null,step.sequence!==undefined?`#${step.sequence}`:String(index+1)),
        el("i"));
      node.addEventListener("click",event=>{
        event.stopPropagation();
        seek(stepStart(steps,index));
      });
      track.append(node);
      markers.push({node, index});
    });
  };
  /* Only transitions already reached are shown, so the rail fills in as the
     story plays rather than spoiling the whole shape up front. */
  const paintTransport=frame=>{
    const total=duration();
    clock.innerHTML="";
    clock.append(document.createTextNode(formatClock(time)),
      el("em",null," / "),document.createTextNode(formatClock(total)));
    scrubber.max=String(total||1);
    scrubber.value=String(Math.min(time,total||1));
    railProgress.style.width=(total?(time/total)*100:0)+"%";
    const activeIndex=frame?frame.stepIndex:-1;
    for(const marker of markers){
      const revealed=marker.index<=activeIndex;
      marker.node.classList.toggle("is-revealed",revealed);
      marker.node.classList.toggle("is-active",marker.index===activeIndex);
      marker.node.style.visibility=revealed?"visible":"hidden";
    }
    const playIcon=playing?"pause":"play";
    playButton.innerHTML="";
    playButton.append(icon(playIcon));
    playButton.setAttribute("aria-label",playing?"Pause":"Play");
    sub.textContent=frame
      ?`transition ${frame.stepIndex+1} of ${enabled().length} · ${formatClock(total)} clip`
      :"no transitions to animate";
    /* Match the source app's effect semantics: centre the active marker only
       when the step or play/pause state changes. Doing this on every animation
       frame continuously restarts the scroll and fights manual rail use. */
    const active=track.querySelector(".pbkmark.is-active");
    const shouldScroll=activeIndex!==lastScrolledStep||playing!==lastScrolledPlaying;
    lastScrolledStep=activeIndex;
    lastScrolledPlaying=playing;
    if(active&&shouldScroll){
      const target=active.offsetLeft+active.offsetWidth/2-timelineStack.clientWidth/2;
      timelineStack.scrollTo({left:Math.max(0,target), behavior:playing?"smooth":"auto"});
    }
  };
  const paint=()=>{
    const frame=currentFrame();
    paintTransport(frame);
    if(frame&&stage) stage.renderFrame(frame,steps,playing);
  };
  const seek=next=>{
    time=Math.min(Math.max(0,next),duration());
    paint();
  };
  const setPlaying=next=>{
    playing=next;
    if(tickHandle) cancelAnimationFrame(tickHandle);
    tickHandle=0;
    lastTick=null;
    if(!playing||!duration()){ paint(); return }
    const tick=now=>{
      if(destroyed) return;
      const last=lastTick??now;
      lastTick=now;
      time=Math.min(time+((now-last)/1000)*speed,duration());
      paint();
      if(playbackEnded(true,time,duration())){
        playing=false;
        tickHandle=0;
        // Land on the whole shape: the last thing seen is the full history.
        setCameraMode("overview");
        paint();
        return;
      }
      tickHandle=requestAnimationFrame(tick);
    };
    tickHandle=requestAnimationFrame(tick);
  };
  const setCameraMode=mode=>{
    cameraMode=mode;
    stage?.setCameraMode(mode);
    overviewButton.classList.toggle("is-active",mode==="overview");
    followButton.classList.toggle("is-active",mode==="follow");
  };

  /* ---- settings: clip length, pacing, and the video encoder knobs ---- */
  const buildSettings=()=>{
    settings.innerHTML="";
    const row=el("div","pbksetrow");
    const lengthLabel=el("label",null,"Clip length");
    const lengthInput=el("input");
    lengthInput.type="number";
    lengthInput.min=String(Math.max(1,enabled().length*MIN_ALLOCATED_STEP_DURATION));
    lengthInput.step="1";
    lengthInput.value=String(Math.round(targetDuration));
    lengthLabel.append(lengthInput,el("span","pbkunit","s"));

    const paceLabel=el("label",null,"Pacing");
    const paceSelect=el("select");
    for(const [value,text] of [["proportional","Proportional to phase time"],["even","Even per transition"]]){
      const option=el("option",null,text);
      option.value=value;
      if(value===durationAllocation) option.selected=true;
      paceSelect.append(option);
    }
    paceLabel.append(paceSelect);

    const speedLabel=el("label",null,"Speed");
    const speedSelect=el("select");
    for(const value of [0.5,1,2,4]){
      const option=el("option",null,`${value}×`);
      option.value=String(value);
      if(value===speed) option.selected=true;
      speedSelect.append(option);
    }
    speedLabel.append(speedSelect);

    const fpsLabel=el("label",null,"Video FPS");
    const fpsSelect=el("select");
    for(const option of VIDEO_FRAME_RATE_OPTIONS){
      const node=el("option",null,option.label);
      node.value=String(option.value);
      node.title=option.description;
      if(option.value===videoFrameRate) node.selected=true;
      fpsSelect.append(node);
    }
    fpsLabel.append(fpsSelect);

    const qualityLabel=el("label",null,"Video quality");
    const qualitySelect=el("select");
    for(const [preset,definition] of Object.entries(VIDEO_COMPRESSION_PRESETS)){
      const node=el("option",null,definition.label);
      node.value=preset;
      node.title=definition.description;
      if(preset===videoCompression) node.selected=true;
      qualitySelect.append(node);
    }
    qualityLabel.append(qualitySelect);

    const note=el("p","pbknote");
    const refreshNote=()=>{
      note.textContent=`MP4 ${VIDEO_WIDTH}×${VIDEO_HEIGHT} · about `
        +`${approximateMegabytesPerMinute(videoCompression,videoFrameRate)} MB per minute. `
        +`GIF ${GIF_WIDTH}×${GIF_HEIGHT} · ${GIF_FRAME_RATE} FPS. `
        +`Both clips end with a ${FINAL_OVERVIEW_SECONDS}s pull-back to the whole history.`;
    };
    refreshNote();

    /* Re-allocating rewrites every step duration, so restart from zero rather
       than leaving the playhead at a time that now means a different step. */
    const reallocate=()=>{
      const count=enabled().length;
      if(!count) return;
      targetDuration=Math.max(count*MIN_ALLOCATED_STEP_DURATION,
        Number(lengthInput.value)||duration());
      lengthInput.value=String(Math.round(targetDuration));
      steps=allocateStepDurations(steps,targetDuration,durationAllocation);
      buildMarkers();
      seek(0);
    };
    lengthInput.addEventListener("change",reallocate);
    paceSelect.addEventListener("change",()=>{
      durationAllocation=paceSelect.value;
      reallocate();
    });
    speedSelect.addEventListener("change",()=>{ speed=Number(speedSelect.value) });
    fpsSelect.addEventListener("change",()=>{
      videoFrameRate=Number(fpsSelect.value);
      refreshNote();
      buildExportMenu();
    });
    qualitySelect.addEventListener("change",()=>{
      videoCompression=qualitySelect.value;
      refreshNote();
    });
    row.append(lengthLabel,paceLabel,speedLabel,fpsLabel,qualityLabel);
    settings.append(row,note);
  };

  const buildExportMenu=()=>{
    exportMenu.innerHTML="";
    const options=[];
    if(hasVideo) options.push(["video","Export MP4",
      `${VIDEO_WIDTH}×${VIDEO_HEIGHT} · ${videoFrameRate} FPS · ${VIDEO_COMPRESSION_PRESETS[videoCompression].label}`]);
    if(hasGif) options.push(["gif","Export GIF",
      `${GIF_WIDTH}×${GIF_HEIGHT} · ${GIF_FRAME_RATE} FPS`]);
    if(!options.length){
      const note=el("p","pbkmenuempty",
        "No encoder bundles are installed. Run npm run build to vendor them.");
      exportMenu.append(note);
      return;
    }
    for(const [format,title,detail] of options){
      const item=el("button");
      item.type="button";
      item.setAttribute("role","menuitem");
      item.append(el("strong",null,title),el("span",null,detail));
      item.addEventListener("click",()=>{
        setExportMenuOpen(false);
        void startExport(format);
      });
      exportMenu.append(item);
    }
  };
  /* `hidden` carries the state on its own -- the popover overlays the stage, so
     nothing else needs a styling hook for it. */
  const setExportMenuOpen=open=>{
    exportMenuOpen=open&&!exporting;
    exportMenu.hidden=!exportMenuOpen;
    exportButton.setAttribute("aria-expanded",String(exportMenuOpen));
  };

  const startExport=async format=>{
    if(!stage||!duration()||exporting) return;
    setPlaying(false);
    exporting=true;
    exportButton.disabled=true;
    const options={
      stage, steps, duration:duration(),
      // Manual panning still exports as overview: the export camera is solved
      // from the snapshot and has no notion of where the viewer dragged to.
      cameraMode:cameraMode==="follow"?"follow":"overview",
      palette:exportPalette(),
      title:`${story.id} timeline`,
      storyId:story.id,
      onProgress:value=>{ exportLabel.textContent=`Exporting ${Math.round(value*100)}%` },
    };
    setStatus(`Encoding ${format==="gif"?"GIF":"MP4"}… this runs in this tab, so leave it open.`);
    try{
      const result=format==="gif"
        ?await exportAnimationGif(options)
        :await exportAnimationVideo({...options,
            compression:videoCompression, frameRate:videoFrameRate});
      const kind=result.mimeType.includes("gif")?"GIF":"MP4";
      const quality=format==="gif"
        ?`${GIF_WIDTH}×${GIF_HEIGHT} · ${GIF_FRAME_RATE} FPS`
        :`${videoFrameRate} FPS · ${VIDEO_COMPRESSION_PRESETS[videoCompression].label}`;
      setStatus(`Exported ${kind} · ${quality} · ${formatClock(result.duration)} · `
        +`${Math.max(1,Math.round(result.bytes/1024))} KB`);
    }catch(error){
      setStatus(`Export failed: ${error&&error.message||error}`,"err");
    }finally{
      exporting=false;
      exportButton.disabled=false;
      exportLabel.textContent="Export";
      seek(0);
    }
  };

  // ---- wiring ----
  const close=()=>{
    destroyed=true;
    if(tickHandle) cancelAnimationFrame(tickHandle);
    if(statusTimer) clearTimeout(statusTimer);
    stage?.destroy();
    wrap.remove();
    removeEventListener("keydown",onKey);
    document.removeEventListener("pointerdown",onDocumentPointerDown,true);
  };
  /* Space is the playback shortcut, but not while a control has focus -- the
     select and number input need it (and Enter) for themselves. */
  const onKey=event=>{
    if(event.key==="Escape"){ event.stopPropagation(); close(); return }
    const tag=(event.target?.tagName||"").toLowerCase();
    if(tag==="input"||tag==="select"||tag==="textarea") return;
    if(event.key===" "){ event.preventDefault(); setPlaying(!playing) }
  };
  addEventListener("keydown",onKey);
  closeButton.addEventListener("click",close);
  playButton.addEventListener("click",()=>{
    if(time>=duration()-0.05) time=0;
    setPlaying(!playing);
  });
  const jump=direction=>{
    const frame=currentFrame();
    if(!frame) return;
    seek(stepStart(steps,Math.min(enabled().length-1,Math.max(0,frame.stepIndex+direction))));
  };
  prevButton.addEventListener("click",()=>jump(-1));
  nextButton.addEventListener("click",()=>jump(1));
  scrubber.addEventListener("input",()=>{
    setPlaying(false);
    seek(Number(scrubber.value));
  });
  track.addEventListener("click",event=>{
    if(event.target.closest?.(".pbkmark")) return;
    const rect=track.getBoundingClientRect();
    const next=((event.clientX-rect.left)/rect.width)*duration();
    setPlaying(false);
    seek(next);
  });
  zoomInButton.addEventListener("click",()=>{ setCameraMode("manual"); stage?.zoomIn() });
  zoomOutButton.addEventListener("click",()=>{ setCameraMode("manual"); stage?.zoomOut() });
  overviewButton.addEventListener("click",()=>{ setCameraMode("overview"); paint() });
  followButton.addEventListener("click",()=>{ setCameraMode("follow"); paint() });
  settingsButton.addEventListener("click",()=>{
    settings.hidden=!settings.hidden;
    settingsButton.setAttribute("aria-expanded",String(!settings.hidden));
    settingsButton.classList.toggle("on",!settings.hidden);
  });
  exportButton.addEventListener("click",()=>setExportMenuOpen(!exportMenuOpen));
  const onDocumentPointerDown=event=>{
    if(exportMenuOpen&&!exportGroup.contains(event.target)) setExportMenuOpen(false);
  };
  document.addEventListener("pointerdown",onDocumentPointerDown,true);

  // ---- boot ----
  try{
    timeline=parseStoryTimeline(timelineJson);
  }catch(error){
    setStatus(`This story's timeline cannot be animated: ${error&&error.message||error}`,"err");
    return;
  }
  heading.textContent=`${timeline.storyId} · timeline playback`;
  sub.textContent=`${timeline.events.length} transitions · preparing…`;

  const gsap=await ensurePlaybackGsap().catch(()=>null);
  if(!gsap){
    setStatus("The animation library (gsap) is not installed. Run npm run build to vendor it.","err");
    return;
  }
  const mermaid=await ensureMermaidForPlayback().catch(()=>null);
  if(!mermaid){
    setStatus("Mermaid is not installed, so the diagram cannot be drawn.","err");
    return;
  }
  hasVideo=Boolean(window.VideoEncoder&&window.VideoFrame)
    &&await loadMediabunny().then(()=>true,()=>false);
  hasGif=await loadGifenc().then(()=>true,()=>false);
  buildExportMenu();
  if(destroyed) return;

  /* Map the DOM handles Mermaid produced onto the story's recorded events.

     This is the join that keeps the animation honest: every event must resolve
     to a real node (and, past the first, a real arrow). If the diagram and the
     timeline ever disagree, this throws rather than animating a plausible
     wrong order. */
  const onDiscover=discovered=>{
    try{
      const phases=[...new Set(timeline.segments.map(s=>s.phase))];
      const domNodeByPhase=new Map(phases.map(phase=>[phase,
        discovered.nodes.find(node=>node.label.split("\n")[0]===phase)]));
      const domEdgeBySequence=new Map(discovered.edges
        .filter(edge=>edge.sequence!==undefined)
        .map(edge=>[edge.sequence,edge]));
      const mapped=timeline.events.map(event=>{
        const fromDomNode=event.fromPhase?domNodeByPhase.get(event.fromPhase):undefined;
        const toDomNode=domNodeByPhase.get(event.toPhase);
        const eventEdge=event.fromPhase?domEdgeBySequence.get(event.sequence):undefined;
        if(!toDomNode||(event.fromPhase&&(!fromDomNode||!eventEdge)))
          throw new Error(`Cannot map transition #${event.sequence} to `
            +`${event.fromPhase?`${event.fromPhase} → `:""}${event.toPhase}`);
        return {
          id:`story-${timeline.storyId}-${event.sequence}`,
          kind:eventEdge?"edge":"node",
          label:event.label,
          domId:eventEdge?.domId??toDomNode.domId,
          svgEdgeIndex:eventEdge?.svgEdgeIndex,
          sequence:event.sequence,
          isNumberedEvent:true,
          fromNodeId:fromDomNode?.domId,
          toNodeId:toDomNode.domId,
          fromPhase:event.fromPhase,
          toPhase:event.toPhase,
          sourceDurationMs:storyEventSourceDurationMs(event,timeline.exportedAt),
          duration:2.4,
          enabled:true,
        };
      });
      // Default the clip to a length that keeps long stories watchable.
      targetDuration=Math.min(180,Math.max(20,mapped.length*2.4));
      steps=allocateStepDurations(mapped,targetDuration,durationAllocation);
      // Allocation enforces a per-event minimum and can therefore exceed the
      // requested target on long stories. Keep Settings and the real timeline
      // duration in sync instead of showing an invalid value below its min.
      targetDuration=durationFor(steps);
      buildSettings();
      buildMarkers();
      setCameraMode("overview");
      seek(0);
      setPlaying(true);
    }catch(error){
      setStatus(`Could not line the diagram up with the timeline: ${error&&error.message||error}`,"err");
    }
  };

  stage=await createStage(host,{
    source:timeline.mermaid, mermaid, gsap,
    onDiscover,
    onError:message=>{ if(message) setStatus(`Diagram error: ${message}`,"err") },
    onManualCamera:()=>setCameraMode("manual"),
    onZoomChange:percent=>{ zoomReadout.textContent=`${percent}%` },
  });
  if(destroyed) stage.destroy();
}

/* gsap is a UMD bundle: load it as a plain script once and reuse it. */
let gsapPromise=null;
function ensurePlaybackGsap(){
  if(window.gsap) return Promise.resolve(window.gsap);
  gsapPromise??=new Promise((resolve,reject)=>{
    const script=document.createElement("script");
    script.src="/vendor/gsap.min.js";
    script.onload=()=>window.gsap?resolve(window.gsap):reject(new Error("gsap did not register"));
    script.onerror=()=>reject(new Error("gsap unavailable"));
    document.head.appendChild(script);
  });
  return gsapPromise;
}
/* The playback diagram needs its own Mermaid configuration -- htmlLabels off,
   wider spacing, transparent edge labels -- so it initialises a second time
   with those settings rather than reusing the phase-flow instance. */
let playbackMermaid=null;
async function ensureMermaidForPlayback(){
  if(playbackMermaid) return playbackMermaid;
  if(!window.mermaid){
    await new Promise((resolve,reject)=>{
      const script=document.createElement("script");
      script.src="/vendor/mermaid.min.js";
      script.onload=resolve;
      script.onerror=()=>reject(new Error("mermaid unavailable"));
      document.head.appendChild(script);
    });
  }
  const ink=diagramInk();
  window.mermaid.initialize({
    startOnLoad:false, securityLevel:"strict", theme:"base",
    themeVariables:{
      background:ink.plate,
      primaryColor:ink.nodeFill,
      primaryTextColor:ink.nodeInk,
      primaryBorderColor:DEFAULT_NODE_STROKE,
      lineColor:DEFAULT_EDGE_STROKE,
      secondaryColor:ink.nodeFill,
      tertiaryColor:ink.nodeFill,
      edgeLabelBackground:"transparent",
      strokeWidth:1,
      fontFamily:DIAGRAM_SANS,
    },
  });
  playbackMermaid=window.mermaid;
  return playbackMermaid;
}

/* The viewer initialises Mermaid with theme colours baked in, so a theme change
   while the page is open must drop that instance or the next diagram renders
   with the old palette. app.js calls this on toggle. */
window.resetPlaybackMermaid=function(){ playbackMermaid=null };
window.openPlaybackModal=openPlaybackModal;
})();
