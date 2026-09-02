/* Story Dossier -- a full-window mission-control page for ONE story.

   Opened from the drawer header; self-registers window.openStoryDossier like
   playback.js does. Seeded with the drawer's raw /api/story detail, then it
   polls the same endpoint on its own while open, so the page tracks a story
   that is still moving. Every panel derives from one shared time cursor:

     MAP    one dot per finding, packed into hulls by a selectable dimension
     LOOP   the seven-phase lifecycle with visits, held time and bounces
     SWARM  one cell per dispatch, coloured by agent type
     PULSE  findings opened vs settled over story time, phase bands behind
     WIRE   the process-event log, one line per event

   Opening runs a fast sweep from T+0 to now (skipped under reduced motion),
   so the reader watches the story assemble before landing on the full state.
   While the story is in flight the T+ clock ticks with the wall clock, the
   current phase box breathes, and open critical findings ping. When a poll
   brings new findings/events/a phase change, the new material lands with a
   burst on the map, a flash in the wire log, a counter bump and a toast.

   Every colour is read as a CSS custom property (var(--...)), so the page
   follows the light/dark toggle with no repaint hook: there is no canvas and
   nothing caches a resolved colour. All interpolated data goes through esc()
   before touching innerHTML, matching the app.js convention. Uses the
   module-global helpers from app.js (F, arr, S1, D, fTime, fDay) -- this
   script loads after it. */
(function(){
"use strict";

/* app.js helpers are top-level function declarations in a classic script, so
   they live on window; read them from there so this file stands alone. */
const {D,F,arr,S1,fTime,fDay}=window;

const PHASES=["INIT","INIT_CHECK","PLAN","DEV","REVIEW","TEST","DONE"];
const PHVAR={INIT:"--ph-init",INIT_CHECK:"--ph-check",PLAN:"--ph-plan",DEV:"--ph-dev",
  REVIEW:"--ph-review",TEST:"--ph-test",DONE:"--ph-done",DISCARDED:"--ph-disc"};
const phv=p=>PHVAR[p]||"--ph-disc";
/* Group hues, assigned to hulls largest-first so the dominant clusters get the
   most separated colours. Severity/status groupings override with semantics. */
const GPAL=["--ph-plan","--ph-review","--ph-dev","--ph-test","--ph-check",
  "--ph-init","--ph-done","--ph-meta","--acc","--warn","--fail","--disc"];
const SEVPAL={critical:"--fail",high:"--ph-review",medium:"--warn",low:"--disc"};
const STATPAL={open:"--ph-review",resolved:"--pass",dismissed:"--disc"};
const SEVR={critical:9,high:7,medium:5.5,low:4.2};

const esc=t=>String(t??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const lane=v=>String(v||"").replace(/^lattice-review-|^proof-or-stop-review-|^lattice-|^proof-or-stop-/,"");
const T=v=>{const d=D(v);return d?d.getTime():null};
function dur2(msv){
  if(msv==null||!isFinite(msv)||msv<0)return"";
  const s=Math.floor(msv/1e3),d=Math.floor(s/86400),h=Math.floor(s%86400/3600),
    m=Math.floor(s%3600/60),ss=s%60,P=n=>String(n).padStart(2,"0");
  return d>0?`${d}d ${P(h)}:${P(m)}:${P(ss)}`:`${P(h)}:${P(m)}:${P(ss)}`;
}
function dshort(msv){
  if(msv==null||!isFinite(msv)||msv<=0)return"0m";
  const m=msv/6e4;
  return m<60?`${Math.round(m)}m`:m<60*48?`${(m/60).toFixed(m<600?1:0)}h`:`${(m/1440).toFixed(1)}d`;
}

/* ---------- model: everything derived once from the raw detail ---------- */
function buildModel(story,d){
  const i=F(d,"index.json")||{};
  const pe=F(d,"process-events.jsonl")||[];
  const fsRaw=arr(F(d,"findings.json"));
  const clusters=((F(d,"clusters.json")||{}).clusters||[]);
  const check=F(d,"checklist.json")||{};

  const evs=(i.events||[]).filter(e=>e.timestamp&&e.phase)
    .sort((a,b)=>a.timestamp<b.timestamp?-1:1);
  const live=!i.endedAt;
  let t0=T(i.createdAt||i.startedAt)??(evs[0]?T(evs[0].timestamp):null);
  let t1=T(i.endedAt);
  const bump=v=>{const t=T(v); if(t!=null){ if(t0==null||t<t0)t0=t; if(t1==null||t>t1)t1=t }};
  if(pe.length){ const last=pe[pe.length-1]; if(last&&last.timestamp) bump(last.timestamp) }
  if(evs.length) bump(evs[evs.length-1].timestamp);
  if(t0==null) t0=Date.now();
  if(live) t1=Math.max(t1??0,Date.now());
  if(t1==null||t1<=t0) t1=t0+1;

  // phase segments: [start,end) per index.json event, exactly like buildTimeline
  const segs=evs.map((e,k)=>({phase:e.phase,ms:T(e.timestamp),
    end:k+1<evs.length?T(evs[k+1].timestamp):t1}));

  const clOf={}; for(const c of clusters) for(const fid of (c.findingIds||[]))
    clOf[String(fid).split(":").pop()]=c.clusterId;
  const findings=fsRaw.map((f,k)=>{
    const id=String(f.id||`F-${k}`).split(":").pop();
    const settled=T(f.resolvedAt)??T(f.dismissedAt);
    return {id,sev:f.severity||"medium",cat:f.category||"(none)",
      status:f.status||"open",laneName:lane(f.agent)||"(none)",
      cluster:f.clusterId||clOf[id]||"(unclustered)",
      files:Array.isArray(f.files)?f.files:[],round:f.reviewRound||"",
      desc:S1(f.desc),res:S1(f.resolvedReason||f.dismissReason),
      rtype:S1(f.resolutionType||f.dismissReasonType),
      ms:T(f.createdAt)??t0,settled};
  }).sort((a,b)=>a.ms-b.ms);
  const settledEvents=findings.filter(f=>f.settled!=null)
    .map(f=>({f,ms:f.settled})).sort((a,b)=>a.ms-b.ms);

  const dispatches=pe.filter(e=>e&&e.type==="dispatch"&&e.timestamp)
    .map(e=>({ms:T(e.timestamp),ag:lane(e.agentType)||"(agent)",kind:e.targetKind||""}))
    .filter(e=>e.ms!=null).sort((a,b)=>a.ms-b.ms);
  const allEvents=pe.filter(e=>e&&e.timestamp&&T(e.timestamp)!=null);
  const rounds=[...new Set(findings.map(f=>f.round).filter(Boolean))].sort();

  const items=check.items||[];
  const te=F(d,"test-evidence.json")||{}, dre=F(d,"done-required-evidence.json")||{},
    sm=F(d,"summary.json")||{}, rp=F(d,"review-passes.json")||{};
  const u=F(d,"understanding.json")||{}, dec=F(d,"decision.json")||{},
    bug=F(d,"bug.json")||{}, ml=F(d,"milestone-ledger.json")||{},
    red=F(d,"red-evidence.json")||{}, lease=F(d,"owner-lease.json")||null,
    gfc=F(d,"gate-failure-counts.json")||null, tk=F(d,"takeover-count.json")||null;
  let evP=0,evF=0,evM=0;
  for(const it of items)for(const e of (it.verificationEvidence||[])){
    if(e.result==="pass")evP++; else if(e.result==="fail")evF++;
    if(e.mechanical)evM++;
  }
  const trans=[]; // consecutive phase pairs, for the loop arcs
  for(let k=1;k<segs.length;k++)
    if(segs[k].phase!==segs[k-1].phase)
      trans.push({from:segs[k-1].phase,to:segs[k].phase,ms:segs[k].ms});
  const rank={}; PHASES.forEach((p,k)=>rank[p]=k);
  const bounces=trans.filter(t=>(rank[t.to]??99)<(rank[t.from]??99)).length;

  return {story,i,pe,findings,settledEvents,clusters,dispatches,allEvents,
    rounds,segs,trans,bounces,t0,t1,live,
    nItems:items.length,nDone:items.filter(x=>x.status==="done").length,
    checkItems:items.map(x=>({id:x.id||"",title:x.title||"",status:x.status||"pending"})),
    evP,evF,evM,
    verdict:sm.acceptanceVerdict||"",outcomeKind:sm.outcomeKind||"",
    valCmd:S1(te.command),valRes:te.result||"",
    gateStatus:dre.status||"",gateReceipts:(dre.receipts||[]).length,
    gateOk:(dre.receipts||[]).filter(r=>r.status==="pass"||r.exitCode===0).length,
    nPasses:(rp.passes||[]).length,
    branch:(i.worktree&&i.worktree.branch)||"",
    task:S1(u.task),outcomeText:S1(u.outcome),
    chosen:S1(dec.chosen),rationale:S1(dec.rationale),
    optNames:(dec.options||[]).map(o=>S1(o.name)).filter(Boolean),
    nOptions:(dec.options||[]).length,nPreMortem:(dec.preMortem||[]).length,
    keywords:Array.isArray(i.keywords)?i.keywords.filter(x=>typeof x==="string"):[],
    risks:(i.riskSignals||[]).map(r=>({cat:S1(r.category),m:S1(r.matched)})),
    bugs:(bug.bugs||[]).map(b=>({id:S1(b.id),t:S1(b.title),st:S1(b.status)})),
    miles:(ml.milestones||[]).map(m=>({id:S1(m.id),st:S1(m.status)})),
    nRed:(red.records||[]).length,
    lease,gfc,tk};
}

/* ---------- map layout: deterministic, no physics ----------
   Groups become circles packed greedily on a spiral (largest first, centre
   out); members sit on a phyllotaxis inside their group, ordered by createdAt
   so playback grows each hull from its middle outward. */
function groupKeyFn(dim){
  if(dim==="lane")return f=>f.laneName;
  if(dim==="category")return f=>f.cat;
  if(dim==="severity")return f=>f.sev;
  if(dim==="cluster")return f=>f.cluster;
  return f=>f.files.length?f.files[0].split("/").slice(0,2).join("/"):"(no file)";
}
function layoutMap(findings,dim,W,H){
  const key=groupKeyFn(dim);
  const by=new Map();
  for(const f of findings){ const k=key(f);
    if(!by.has(k))by.set(k,[]);
    by.get(k).push(f) }
  let groups=[...by.entries()].map(([name,members])=>({name,members}))
    .sort((a,b)=>b.members.length-a.members.length);
  // an unbounded dimension (files, clusters) can fragment into dozens of
  // singletons; fold the tail so hulls stay readable
  const MAXG=11;
  if(groups.length>MAXG){
    const rest=groups.slice(MAXG-1);
    groups=groups.slice(0,MAXG-1);
    groups.push({name:`(${rest.length} more)`,members:rest.flatMap(g=>g.members)});
  }
  for(const g of groups) g.r=Math.max(34,13*Math.sqrt(g.members.length)+22);
  // greedy spiral packing
  const placed=[];
  for(const g of groups){
    if(!placed.length){ g.x=0; g.y=0; placed.push(g); continue }
    let best=null;
    for(let a=0;a<720;a+=7){
      const th=a*Math.PI/180;
      for(let rr=g.r;rr<3000;rr+=9){
        const x=rr*Math.cos(th)*1.35,y=rr*Math.sin(th);
        if(placed.every(p=>Math.hypot(x-p.x,y-p.y)>=(g.r+p.r+14))){
          const d=Math.hypot(x,y);
          if(!best||d<best.d)best={x,y,d};
          break;
        }
      }
    }
    g.x=best?best.x:0; g.y=best?best.y:0; placed.push(g);
  }
  // fit into the viewBox
  let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9;
  for(const g of groups){
    minX=Math.min(minX,g.x-g.r);maxX=Math.max(maxX,g.x+g.r);
    minY=Math.min(minY,g.y-g.r);maxY=Math.max(maxY,g.y+g.r);
  }
  const pad=54,s=Math.min((W-2*pad)/Math.max(1,maxX-minX),(H-2*pad)/Math.max(1,maxY-minY),2.2);
  const ox=W/2-s*(minX+maxX)/2, oy=H/2-s*(minY+maxY)/2+8;
  const pos=new Map();
  for(const g of groups){
    g.cx=ox+s*g.x; g.cy=oy+s*g.y; g.pr=s*g.r;
    const n=g.members.length, GA=Math.PI*(3-Math.sqrt(5));
    g.members.forEach((f,k)=>{
      const rr=(g.pr-16)*Math.sqrt((k+.6)/n), th=k*GA;
      pos.set(f.id,{x:g.cx+rr*Math.cos(th),y:g.cy+rr*Math.sin(th),g});
    });
  }
  return {groups,pos};
}
function groupColor(dim,groups){
  const m={};
  if(dim==="severity"){ for(const g of groups) m[g.name]=SEVPAL[g.name]||"--disc"; return m }
  groups.forEach((g,k)=>m[g.name]=GPAL[k%GPAL.length]);
  return m;
}

/* ---------- incremental time ranges: O(delta) on scrub, both directions ---------- */
function mkRange(items,on,off){
  let i=0;
  return {
    reset(){i=0},
    seek(t){
      while(i<items.length&&items[i].ms<=t){on(items[i],i);i++}
      while(i>0&&items[i-1].ms>t){i--;off(items[i],i)}
      return i;
    }
  };
}

/* ---------- wire log ---------- */
const WIRE_SKIP_DEFAULT=new Set(["codex_cli","dispatch"]);
function wireLine(e){
  const t=e.type;
  if(t==="phase_transition")return{tag:"PHASE",cv:phv(e.toPhase),txt:`${e.fromPhase} → ${e.toPhase}`};
  if(t==="reviewer_finding"){
    const id=e.findingId?String(e.findingId).split(":").pop()
      :(Array.isArray(e.importedIds)?`${e.importedIds.length} imported`:"");
    return{tag:"FIND",cv:SEVPAL[e.severity]||"--ph-review",
      txt:`${id}${e.severity?` · ${e.severity}`:""} · ${lane(e.agent)}`};
  }
  if(t==="review_pass")return{tag:"PASS",cv:"--pass",txt:`${lane(e.agent)} · ${e.result||""}`};
  if(t==="validation_terminal")return{tag:"VALID",cv:e.result==="pass"?"--pass":"--fail",
    txt:`${e.result||"?"} · ${e.commandExecutions??"?"} cmds${e.disposition?` · ${e.disposition}`:""}`};
  if(t==="human_confirmation")return{tag:"HUMAN",cv:"--warn",
    txt:String(e.confirmation||e.reason||e.command||"").slice(0,120)};
  if(t==="host_verdict")return{tag:"HOST",cv:"--ph-plan",txt:`${e.decision||""} · ${e.provider||e.hostId||""}`};
  if(t==="dirty_gate_audit")return{tag:"DIRTY",cv:"--fail",
    txt:`${e.gate||e.category||""}${e.pathCount!=null?` · ${e.pathCount} paths`:""}`};
  if(t==="plan_reviewed")return{tag:"PLAN",cv:"--ph-plan",
    txt:`round ${e.round??"?"} · ${e.issueCount??0} issues · ${e.blockerCount??0} blockers`};
  if(t==="subagent_result")return{tag:"SUB",cv:e.success?"--pass":"--fail",
    txt:`${e.checklistId||""} · ${e.success?"ok":"failed"}`};
  if(t==="dispatch")return{tag:"DISP",cv:"--disc",txt:`${lane(e.agentType)} · ${e.targetKind||""}`};
  if(t==="codex_cli")return{tag:"CODEX",cv:"--disc",txt:`${e.role||""} · ${e.result||e.entrypoint||""}`};
  if(t==="plan_updated")return{tag:"PLAN",cv:"--ph-plan",txt:`updated${e.round!=null?` · round ${e.round}`:""}`};
  if(t==="review_escalation_fallback")return{tag:"ESCAL",cv:"--warn",
    txt:S1(e.reason||e.fallback||e.agent||"").slice(0,100)};
  if(t==="init_check_fallback")return{tag:"CHECK",cv:"--ph-check",txt:S1(e.reason||"").slice(0,100)};
  if(t==="review_host_availability_probe")return{tag:"PROBE",cv:"--disc",
    txt:`${e.provider||e.hostId||""} · ${e.available===false?"unavailable":e.result||"ok"}`};
  if(t==="codex_adapter_verification")return{tag:"CODEX",cv:e.ok===false?"--fail":"--disc",
    txt:S1(e.result||e.reason||"verification").slice(0,100)};
  /* anything else: the first word of the type, so "guard_session_start"
     reads GUARD rather than the mid-word cut GUARD_ */
  return{tag:String(t||"?").split("_")[0].slice(0,6).toUpperCase(),cv:"--disc",
    txt:S1(e.result||e.reason||e.command||"").slice(0,100)};
}

/* ================================ page ================================ */
function openStoryDossier(story,raw,hooks,rel){
  if(!raw||!raw.files)return;
  // close (not just remove) any previous instance so its timers stop
  window.closeStoryDossier?.();
  let M=buildModel(story,raw);
  let span=M.t1-M.t0;
  const reduceMotion=matchMedia("(prefers-reduced-motion: reduce)").matches;
  const root=document.createElement("div");
  root.className="dsrmodal"+(M.live?" live":"");
  root.setAttribute("role","dialog");
  root.setAttribute("aria-label",`Story dossier ${story.id}`);
  // stop compositing the graph page underneath: it stays in the DOM (so
  // closing is instant) but paints nothing while the dossier covers it
  document.body.classList.add("dsropen");

  const MAPW=1200,MAPH=620;
  /* lane -> hue must stay stable across live updates, so colours are handed
     out on first sight rather than recomputed from a sorted snapshot */
  const laneCol={}; let laneNext=0;
  const laneColor=l=>{ if(!(l in laneCol))laneCol[l]=GPAL[laneNext++%GPAL.length]; return laneCol[l] };
  const SWARM_CAP=2000;

  function factsHtml(){
    const biggest=[...M.clusters].sort((a,b)=>(b.findingIds||[]).length-(a.findingIds||[]).length)[0];
    const perLane={}; for(const f of M.findings) perLane[f.laneName]=(perLane[f.laneName]||0)+1;
    const top=Object.entries(perLane).sort((a,b)=>b[1]-a[1])[0];
    const facts=[];
    if(M.rounds.length)facts.push(`${M.rounds.length} review rounds`);
    if(M.bounces)facts.push(`${M.bounces} bounce${M.bounces>1?"s":""} backwards`);
    if(biggest)facts.push(`biggest cluster ${biggest.clusterId} · ${(biggest.findingIds||[]).length} findings`);
    if(top)facts.push(`busiest lane ${top[0]} · ${top[1]}`);
    if(M.nItems)facts.push(`checklist ${M.nDone}/${M.nItems} done`);
    if(M.dispatches.length)facts.push(`${M.dispatches.length} dispatches`);
    facts.push(`wall clock ${dshort(span)}`);
    return facts.map(f=>`<span>${esc(f)}</span>`).join('<span class="dot">·</span>');
  }
  function statsHtml(){
    const biggest=[...M.clusters].sort((a,b)=>(b.findingIds||[]).length-(a.findingIds||[]).length)[0];
    const perLane={}; for(const f of M.findings) perLane[f.laneName]=(perLane[f.laneName]||0)+1;
    const topLanes=Object.entries(perLane).sort((a,b)=>b[1]-a[1]);
    const perSev={critical:0,high:0,medium:0,low:0};
    for(const f of M.findings) if(perSev[f.sev]!=null)perSev[f.sev]++;
    const perStat={open:0,resolved:0,dismissed:0};
    for(const f of M.findings) if(perStat[f.status]!=null)perStat[f.status]++;
    return `
      <div class="dsrstat"><i class="mono">findings by status</i>
        <div class="dsrbar">${["open","resolved","dismissed"].map(k=>perStat[k]?
          `<b style="flex:${perStat[k]};background:var(${STATPAL[k]})" title="${k} ${perStat[k]}"></b>`:"").join("")}</div>
        <p class="mono">${["open","resolved","dismissed"].map(k=>`${k} ${perStat[k]}`).join(" · ")}</p></div>
      <div class="dsrstat"><i class="mono">severity</i>
        <div class="dsrbar">${Object.entries(perSev).map(([k,n])=>n?
          `<b style="flex:${n};background:var(${SEVPAL[k]})" title="${k} ${n}"></b>`:"").join("")}</div>
        <p class="mono">${Object.entries(perSev).filter(([,n])=>n).map(([k,n])=>`${k} ${n}`).join(" · ")||"—"}</p></div>
      <div class="dsrstat"><i class="mono">busiest lanes</i>
        ${topLanes.slice(0,5).map(([l,n])=>`<div class="dsrhbar mono"><span>${esc(l)}</span>
          <em><b style="width:${(100*n/(topLanes[0][1]||1)).toFixed(1)}%"></b></em><u>${n}</u></div>`).join("")||'<p class="mono">—</p>'}</div>
      ${biggest?`<div class="dsrstat"><i class="mono">biggest cluster</i>
        <p class="dsrbig">${esc(biggest.clusterId)} · ${(biggest.findingIds||[]).length} findings</p>
        <p class="mono dsrrc">${esc(String(biggest.rootCause||"").slice(0,200))}</p></div>`:""}
      <div class="dsrstat"><i class="mono">totals</i>
        <p class="mono">${M.allEvents.length} process events · ${M.trans.length} transitions
        · ${M.rounds.length} rounds · ${M.nDone}/${M.nItems} checklist</p></div>`;
  }

  root.innerHTML=`
  <header class="dsrhead">
    <div class="dsrid" id="dsrIdBox" style="--ph:var(${phv(M.i.phase||story.phase)})"><span>${esc(story.id)}</span></div>
    <div class="dsrtitle">
      <h1>${esc(story.title||"(untitled)")}</h1>
      <p class="mono" id="dsrSub">${esc(story.id)} · ${esc(story.type||"story")} · ${esc(story.pri||"?")} priority
        · ${esc(fDay(M.i.createdAt||""))} → ${M.i.endedAt?esc(fDay(M.i.endedAt)):"in flight"}</p>
    </div>
    <div class="dsrcounts">
      <div><i>findings</i><b id="dsrNF">0</b></div>
      <div><i>events</i><b id="dsrNE">0</b></div>
      <div><i>dispatches</i><b id="dsrND">0</b></div>
      <div><i>rounds</i><b id="dsrNR">0</b></div>
    </div>
    <div class="dsrclock">
      <button class="dsrplay" id="dsrPlay" title="Replay the story (Space)">
        <svg viewBox="0 0 16 16" id="dsrPlayIco"><path d="M4 2.5v11l9-5.5z" fill="currentColor"/></svg>
      </button>
      <select id="dsrSpeed" class="mono" title="Replay length">
        <option value="15000">15s</option><option value="30000" selected>30s</option>
        <option value="60000">60s</option>
      </select>
      <span class="dsrlive" id="dsrLive"${M.live?"":" hidden"}><i></i>LIVE</span>
      <span class="dsrphase" id="dsrPh">${esc(M.i.phase||story.phase)}</span>
      <b class="mono" id="dsrT">T+00:00:00</b>
    </div>
    <button class="dsrx" data-dsrclose title="Close (Esc)">✕</button>
  </header>
  <div class="dsrfacts mono" id="dsrFacts">${factsHtml()}</div>
  <div class="dsrtoasts" id="dsrToasts"></div>
  <div class="dsrbody" id="dsrBody">
    <section class="dsrsec sec-loop">
      <div class="dsrsechead"><h2>THE LOOP <span class="mono">visits · time held · dotted arcs are bounces</span></h2></div>
      <svg class="dsrloop" id="dsrLoop" viewBox="0 0 1200 200" preserveAspectRatio="xMidYMid meet"></svg>
    </section>
    <section class="dsrsec sec-map${M.findings.length?"":" empty"}">
      <div class="dsrsechead">
        <h2>THE MAP <span class="mono">one dot per finding · size = severity · faded = settled · hulls by</span></h2>
        <div class="dsrseg" id="dsrDim" role="tablist">
          ${[["lane","reviewer"],["cluster","root cause"],["category","category"],
             ["severity","severity"],["file","file"]].map(([k,l],i)=>
            `<button data-dim="${k}" aria-selected="${i===0}">${l}</button>`).join("")}
        </div>
      </div>
      <div class="dsrmapwrap">
        <svg class="dsrmapsvg" id="dsrMap" viewBox="0 0 ${MAPW} ${MAPH}" preserveAspectRatio="xMidYMid meet">
          <g id="dsrHulls"></g><g id="dsrDots"></g>
        </svg>
        <div class="dsrtip mono" id="dsrTip" hidden></div>
        <aside class="dsrinspect" id="dsrIns" hidden></aside>
        <p class="dsrempty mono" id="dsrEmpty"${M.findings.length?" hidden":""}><span>no findings recorded yet
          <small>reviewer findings land here as the story moves through REVIEW</small></span></p>
      </div>
      <p class="dsrfoot mono" id="dsrMapFoot"></p>
    </section>
    <section class="dsrsec sec-out">
      <div class="dsrsechead"><h2>OUTCOME <span class="mono">verdict · validation · gates</span></h2></div>
      <div class="dsrout" id="dsrOut"></div>
    </section>
    <section class="dsrsec sec-pulse">
      <div class="dsrsechead"><h2>PULSE <span class="mono">opened vs settled, cumulative</span></h2></div>
      <svg class="dsrpulse" id="dsrPulse" viewBox="0 0 640 210" preserveAspectRatio="none"></svg>
      <div class="dsrlegend mono"><span><i style="background:var(--ph-review)"></i>opened</span>
        <span><i style="background:var(--pass)"></i>settled</span>
        <span><i class="tick"></i>review round</span></div>
    </section>
    <section class="dsrsec sec-swarm">
      <div class="dsrsechead"><h2>THE SWARM <span class="mono">one cell per dispatch</span></h2></div>
      <div class="dsrswarm" id="dsrSwarm"></div>
      <p class="dsrfoot mono" id="dsrSwFoot" hidden></p>
      <div class="dsrlegend mono" id="dsrSwLg"></div>
    </section>
    <section class="dsrsec sec-web">
      <div class="dsrsechead"><h2>THE WEB <span class="mono">what it builds on · who builds on it${rel&&rel.depth!=null?` · depth ${rel.depth}`:""}</span></h2></div>
      <div id="dsrWeb"></div>
    </section>
    <section class="dsrsec sec-check">
      <div class="dsrsechead"><h2>CHECKLIST <span class="mono" id="dsrCkN"></span></h2></div>
      <div class="dsrcklist" id="dsrCk"></div>
    </section>
    <section class="dsrsec sec-origin">
      <div class="dsrsechead"><h2>ORIGIN &amp; DECISION <span class="mono">task · outcome · the chosen path</span></h2></div>
      <div class="dsrout" id="dsrOrigin"></div>
    </section>
    <section class="dsrsec sec-findings">
      <div class="dsrsechead"><h2>FINDINGS FEED <span class="mono" id="dsrFlN"></span></h2></div>
      <div class="dsrflist" id="dsrFl"></div>
    </section>

    <section class="dsrsec sec-sig">
      <div class="dsrsechead"><h2>SIGNALS &amp; LEDGER <span class="mono">risks · bugs · milestones${story.inFlight?" · ownership":""}</span></h2></div>
      <div class="dsrout" id="dsrSig"></div>
    </section>
    <section class="dsrsec sec-wire">
      <div class="dsrsechead"><h2>WIRE LOG <span class="mono">one line per event, never rewritten</span></h2>
        <div class="dsrchks">
          <label class="dsrchk mono"><input type="checkbox" id="dsrWd">dispatch</label>
          <label class="dsrchk mono"><input type="checkbox" id="dsrWc">codex</label>
        </div>
      </div>
      <div class="dsrlog mono" id="dsrLog"></div>
    </section>
    <aside class="dsrsec dsrstats sec-stats">
      <div class="dsrsechead"><h2>MEASURED <span class="mono">whole story</span></h2></div>
      <div class="dsrstatsb" id="dsrStatsB">${statsHtml()}</div>
    </aside>
  </div>`;
  document.body.appendChild(root);

  const $=sel=>root.querySelector(sel);
  const dotsG=$("#dsrDots"),hullsG=$("#dsrHulls"),tip=$("#dsrTip"),ins=$("#dsrIns");
  const nf=$("#dsrNF"),ne=$("#dsrNE"),nd=$("#dsrND"),nr=$("#dsrNR"),
    tEl=$("#dsrT"),phEl=$("#dsrPh");

  /* ---- map: dot elements keyed by finding id, created on demand ---- */
  const NS="http://www.w3.org/2000/svg";
  const dotEl=new Map();
  let fById={};
  // dot geometry is a fixed attribute; show/hide and the effect rings animate
  // through transform scale, which every engine supports on SVG
  const sq=(cls,r)=>{
    const el=document.createElementNS(NS,"circle");
    if(cls)el.setAttribute("class",cls);
    el.setAttribute("r",r);
    return el;
  };
  function ensureDots(freshIds){
    for(const f of M.findings){
      if(dotEl.has(f.id))continue;
      const g=document.createElementNS(NS,"g");
      g.setAttribute("class","dsrdot"+(f.status==="dismissed"?" dis":""));
      g.dataset.fid=f.id;
      const r=SEVR[f.sev]||5;
      g.appendChild(sq("",r));
      // open criticals ping while the story is live (gated by .dsrmodal.live)
      if(f.sev==="critical")g.appendChild(sq("ping",r+2));
      if(freshIds&&freshIds.has(f.id)){
        // a burst ring marks material that arrived on a live update
        const b=sq("burst",r+2);
        g.appendChild(b);
        g.classList.add("fresh");
        setTimeout(()=>{b.remove();g.classList.remove("fresh")},6000);
      }
      dotsG.appendChild(g); dotEl.set(f.id,g);
    }
    fById={}; for(const f of M.findings) fById[f.id]=f;
  }
  let dim="lane";
  function paintMap(){
    $("#dsrMapFoot").textContent=`measured from findings.json · ${M.findings.length} findings · ${M.clusters.length} root-cause clusters`;
    $("#dsrEmpty").hidden=M.findings.length>0;
    $(".sec-map").classList.toggle("empty",!M.findings.length);
    if(!M.findings.length){hullsG.innerHTML="";return}
    const {groups,pos}=layoutMap(M.findings,dim,MAPW,MAPH);
    const cols=groupColor(dim,groups);
    hullsG.innerHTML=groups.map(g=>{
      const cv=cols[g.name];
      const label=`${g.name.toUpperCase().slice(0,34)} · ${g.members.length}`;
      const lw=label.length*6.6+18;
      const lx=g.cx-lw/2, ly=g.cy-g.pr-24;
      return `<g class="dsrhull" style="--c:var(${cv})">
        <circle cx="${g.cx.toFixed(1)}" cy="${g.cy.toFixed(1)}" r="${g.pr.toFixed(1)}"/>
        <rect x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" width="${lw.toFixed(1)}" height="19" rx="2"/>
        <text x="${g.cx.toFixed(1)}" y="${(ly+13.5).toFixed(1)}" text-anchor="middle">${esc(label)}</text>
      </g>`;
    }).join("");
    for(const f of M.findings){
      const p=pos.get(f.id),g=dotEl.get(f.id);
      if(!p||!g)continue;
      g.style.transform=`translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px)`;
      g.style.setProperty("--c",`var(${cols[p.g.name]||"--disc"})`);
      g.classList.toggle("dis",f.status==="dismissed");
    }
  }
  $("#dsrDim").addEventListener("click",e=>{
    const b=e.target.closest("button[data-dim]"); if(!b||b.dataset.dim===dim)return;
    dim=b.dataset.dim;
    [...$("#dsrDim").children].forEach(x=>x.setAttribute("aria-selected",String(x===b)));
    paintMap();
  });
  dotsG.addEventListener("mousemove",e=>{
    const g=e.target.closest(".dsrdot"); if(!g){tip.hidden=true;return}
    const f=fById[g.dataset.fid]; if(!f){tip.hidden=true;return}
    tip.innerHTML=`<b>${esc(f.id)}</b> · ${esc(f.sev)} · ${esc(f.status)} · ${esc(f.laneName)}`
      +`${f.cluster!=="(unclustered)"?` · ${esc(f.cluster)}`:""}<br>${esc(f.desc.slice(0,220))}${f.desc.length>220?"…":""}`;
    tip.hidden=false;
    const r=$(".dsrmapwrap").getBoundingClientRect();
    tip.style.left=Math.max(6,Math.min(e.clientX-r.left+14,r.width-330))+"px";
    tip.style.top=(e.clientY-r.top+12)+"px";
  });
  dotsG.addEventListener("mouseleave",()=>{tip.hidden=true});
  dotsG.addEventListener("click",e=>{
    const g=e.target.closest(".dsrdot"); if(!g)return;
    const f=fById[g.dataset.fid]; if(!f)return;
    ins.innerHTML=`<button class="dsrx" data-insx>✕</button>
      <h3 class="mono">${esc(f.id)}</h3>
      <p class="dsrtags"><b style="background:var(${SEVPAL[f.sev]||"--disc"})">${esc(f.sev)}</b>
        <b style="background:var(${STATPAL[f.status]||"--disc"})">${esc(f.status)}</b>
        <span class="mono">${esc(f.laneName)} · ${esc(f.cat)}${f.cluster!=="(unclustered)"?` · ${esc(f.cluster)}`:""}</span></p>
      <p class="dsrdesc">${esc(f.desc)}</p>
      ${f.res?`<p class="dsrres"><i class="mono">${esc(f.rtype||"resolved")}</i> ${esc(f.res)}</p>`:""}
      ${f.files.length?`<p class="mono dsrfiles">${f.files.slice(0,6).map(esc).join("<br>")}</p>`:""}
      ${hooks&&hooks.jump?`<button class="dsrgo" data-insgo="${esc(f.id)}">Open in Findings tab →</button>`:""}`;
    ins.hidden=false;
  });
  ins.addEventListener("click",e=>{
    if(e.target.closest("[data-insx]")){ins.hidden=true;return}
    const go=e.target.closest("[data-insgo]");
    if(go&&hooks&&hooks.jump){close();hooks.jump(go.dataset.insgo)}
  });

  /* ---- loop: geometry rebuilt on data change, repainted per cursor ---- */
  const loop=$("#dsrLoop");
  const rank={}; PHASES.forEach((p,k)=>rank[p]=k);
  let shown,bw,bx,arcAgg;
  function rebuildLoopGeom(){
    const extra=[...new Set(M.segs.map(s=>s.phase))].filter(p=>!PHASES.includes(p));
    shown=PHASES.concat(extra);
    bw=Math.min(128,(1200-16*(shown.length+1))/shown.length);
    const gap=(1200-shown.length*bw)/(shown.length+1);
    bx={}; shown.forEach((p,k)=>bx[p]=gap+(bw+gap)*k);
    arcAgg={};
    for(const t of M.trans){const k=t.from+">"+t.to;
      (arcAgg[k]||(arcAgg[k]={from:t.from,to:t.to,ms:[]})).ms.push(t.ms)}
  }
  function arcPath(a,b,up){
    const x1=bx[a]+bw/2,x2=bx[b]+bw/2,y=up?86:132;
    const h=Math.min(52,14+Math.abs(x2-x1)*.09)*(up?-1:1);
    return `M${x1} ${y} C${x1} ${y+h},${x2} ${y+h},${x2} ${y}`;
  }
  let lastLoopHtml="";
  function paintLoop(t){
    const held={},visits={};
    let cur=null;
    for(const sg of M.segs){
      if(sg.ms>t)break;
      visits[sg.phase]=(visits[sg.phase]||0)+1;
      held[sg.phase]=(held[sg.phase]||0)+(Math.min(sg.end??t,t)-sg.ms);
      cur=sg.phase;
    }
    const tot=Object.values(held).reduce((a,b)=>a+b,0)||1;
    const arcs=Object.values(arcAgg).map(a=>{
      const n=a.ms.filter(m=>m<=t).length; if(!n)return"";
      const back=(rank[a.to]??99)<(rank[a.from]??99);
      if(bx[a.from]==null||bx[a.to]==null)return"";
      return `<g class="dsrarc${back?" back":""}"><path d="${arcPath(a.from,a.to,!back)}"/>
        <text x="${((bx[a.from]+bx[a.to]+bw)/2).toFixed(1)}" y="${back?178:34}" text-anchor="middle">${n===1?"":n+"×"}${back?"↩":""}</text></g>`;
    }).join("");
    const html=arcs+shown.map(p=>{
      const v=visits[p]||0,hm=held[p]||0,share=hm/tot;
      const on=v>0,now=cur===p;
      const texts=dy=>`<text class="pn" x="${(bw/2).toFixed(1)}" y="${19+dy}" text-anchor="middle">${esc(p.replace("_"," "))}</text>
        <text class="pv" x="${(bw/2).toFixed(1)}" y="${36+dy}" text-anchor="middle">${on?`${v}× · ${dshort(hm)}`:"—"}</text>`;
      const screen=now&&!playing;
      return `<g class="dsrphbox${on?" on":""}${now?" now":""}" style="--c:var(${phv(p)})" transform="translate(${bx[p].toFixed(1)},86)">
        <rect width="${bw.toFixed(1)}" height="46" rx="4"/>
        ${screen?(()=>{
          /* the running phase is a tiny monitor: faint log lines roll upward
             continuously, and every few seconds the label itself rolls out of
             the top while an identical copy rolls in from below (a CRT
             refresh). Line widths repeat every 4 rows and the loop shifts by
             exactly 4 pitches, so both scrolls are seamless. */
          const P=[.62,.38,.55,.45];
          const lines=Array.from({length:14},(_,k)=>
            `<rect x="10" y="${k*7-14}" width="${((bw-20)*P[k%4]).toFixed(0)}" height="2.5" rx="1.25"/>`).join("");
          return `<clipPath id="dsrNowClip"><rect width="${bw.toFixed(1)}" height="46" rx="4"/></clipPath>
          <g class="nowscreen" clip-path="url(#dsrNowClip)"><g class="roll">${lines}</g>
            <g class="troll">${texts(0)}${texts(46)}</g></g>`;
        })():texts(0)}
        <rect class="ph" y="50" width="${bw.toFixed(1)}" height="4" rx="2"/>
        <rect class="phf" y="50" width="${(bw*share).toFixed(1)}" height="4" rx="2"/>
      </g>`;
    }).join("");
    /* Skip identical rebuilds. The live wall-clock tick repaints every second,
       and replacing the SVG restarts its CSS animations from 0% — the label's
       roll sits at 74% of a 3.2s cycle, so it could never be reached and the
       text looked frozen. Most ticks change nothing (held times round to the
       same string); only a real change touches the DOM. */
    if(html!==lastLoopHtml){lastLoopHtml=html;loop.innerHTML=html}
  }

  /* ---- the web: this story's ego-graph, one hop each way ---- */
  function paintWeb(){
    const host=$("#dsrWeb");
    if(!rel||(!rel.up.length&&!rel.down.length)){
      host.innerHTML='<p class="dsrnote mono">no recorded relations — this story stands alone in the web</p>';
      return;
    }
    const CAP=10;
    const up=rel.up.slice(0,CAP),down=rel.down.slice(0,CAP);
    const rows=Math.max(up.length,down.length,1);
    const H=rows*44+64;
    const cy=k=>64+k*44;
    const midY=H/2+8;
    const pill=(n,cx)=>{
      const t=n.title.length>34?n.title.slice(0,34)+"…":n.title;
      return `<g class="dsrweb-node" data-id="${esc(n.id)}" style="--c:var(${phv(n.phase)})">
        <title>${esc(n.id)} · ${esc(n.phase)}${n.title?` · ${esc(n.title)}`:""} · click to open its dossier</title>
        <rect x="${cx-170}" y="-15" width="340" height="30" rx="15"/>
        <circle cx="${cx-150}" cy="0" r="5"/>
        <text x="${cx-136}" y="4">${esc(n.id)}${t?` · ${esc(t)}`:""}</text>
      </g>`;
    };
    const arc=(x1,y1,x2,y2,kind)=>`<path class="dsrweb-edge${kind==="dep"?" dep":""}"
      d="M${x1} ${y1} C${(x1+x2)/2} ${y1},${(x1+x2)/2} ${y2},${x2} ${y2}"/>`;
    host.innerHTML=`<svg class="dsrwebsvg" viewBox="0 0 1200 ${H}" preserveAspectRatio="xMidYMid meet">
      <text class="wh" x="250" y="26" text-anchor="middle">◂ BUILDS ON · ${rel.up.length}</text>
      <text class="wh" x="950" y="26" text-anchor="middle">BUILT ON BY · ${rel.down.length} ▸</text>
      ${up.map((n,k)=>arc(505,midY,420,cy(k),n.kind)).join("")}
      ${down.map((n,k)=>arc(695,midY,780,cy(k),n.kind)).join("")}
      ${up.map((n,k)=>`<g transform="translate(0,${cy(k)})">${pill(n,250)}</g>`).join("")}
      ${down.map((n,k)=>`<g transform="translate(0,${cy(k)})">${pill(n,950)}</g>`).join("")}
      <g class="dsrweb-center" transform="translate(600,${midY})" style="--c:var(${phv(M.i.phase||story.phase)})">
        <rect x="-95" y="-22" width="190" height="44" rx="8"/>
        <text class="cid" y="-2" text-anchor="middle">${esc(story.id)}</text>
        <text class="cph" y="14" text-anchor="middle">${esc(M.i.phase||story.phase)}</text>
      </g>
      ${rel.up.length>CAP?`<text class="wmore" x="250" y="${H-8}" text-anchor="middle">+${rel.up.length-CAP} more</text>`:""}
      ${rel.down.length>CAP?`<text class="wmore" x="950" y="${H-8}" text-anchor="middle">+${rel.down.length-CAP} more</text>`:""}
      <text class="wlg" x="600" y="${H-8}" text-anchor="middle">solid = declared dependency · faded = prose reference</text>
    </svg>`;
  }
  $("#dsrWeb").addEventListener("click",e=>{
    const g=e.target.closest(".dsrweb-node");
    if(g&&hooks&&hooks.openStory){close(true);hooks.openStory(g.dataset.id)}
  });

  /* Freeze every changing header field at the width of its FINAL value:
     Newsreader's digits are proportional, so a counting-up number otherwise
     resizes its column every frame and the whole masthead judders. */
  function lockHeaderWidths(){
    const lock=(el,n)=>{el.style.minWidth=String(n).length+"ch";el.style.textAlign="right"};
    lock(nf,M.findings.length);lock(ne,M.allEvents.length);
    lock(nd,Math.min(M.dispatches.length,SWARM_CAP));lock(nr,M.rounds.length);
    tEl.style.minWidth=("T+"+dur2(M.t1-M.t0)).length+"ch";
    tEl.style.textAlign="right";
    // the phase badge cycles DEV/REVIEW/… during playback; size it once for
    // the longest phase this story ever visits so the row never shifts
    const longest=[...new Set(M.segs.map(sg=>sg.phase))]
      .concat(M.i.phase||[]).reduce((a,b)=>String(b).length>a.length?String(b):a,"");
    phEl.style.minWidth=Math.max(4,longest.length)+"ch";
    phEl.style.textAlign="center";
  }

  /* ---- checklist / outcome / origin / signals: visual first, prose folded
     behind a <details>. Tiles echo the masthead counters (big serif numeral,
     mono small-caps label); tracks/dots/bars carry the state. ---- */
  const tile=(v,l,sub)=>`<div class="dsrtile"><b>${v}</b><i class="mono">${l}</i>${sub||""}</div>`;
  const minibar=parts=>{const on=parts.filter(p=>p.n>0);
    return on.length?`<span class="dsrminibar">${on.map(p=>
      `<u style="flex:${p.n};background:var(${p.c})" title="${esc(p.t)}"></u>`).join("")}</span>`:""};
  const dots=list=>`<span class="dsrgdots">${list.map(x=>
    `<i class="${x.ok?"":"bad"}"${x.t?` title="${esc(x.t)}"`:""}></i>`).join("")}</span>`;
  const row=(l,v)=>`<div class="dsrorow"><i class="mono">${l}</i><span>${v}</span></div>`;
  function paintPanels(){
    $("#dsrCkN").textContent=`${M.nDone}/${M.nItems} done`;
    const st_=it=>it.status==="done"?"done":(it.status!=="pending"?"doing":"pend");
    $("#dsrCk").innerHTML=M.checkItems.length?
      `<div class="dsrckviz">
        <b class="dsrckbig">${M.nDone}<span>/${M.nItems}</span></b>
        <span class="dsrcktrack">${M.checkItems.map(it=>
          `<i class="${st_(it)}" title="${esc(it.id)} · ${esc(it.title)} · ${esc(it.status)}"></i>`).join("")}</span>
      </div>
      <div class="dsrckitems">${
        M.checkItems.map(it=>`<div class="dsrck ${st_(it)}"><i></i><b class="mono">${esc(it.id)}</b>`
          +`<span title="${esc(it.title)}">${esc(it.title)}</span>`
          +`<u class="mono">${esc(it.status)}</u></div>`).join("")}</div>`
      :'<p class="dsrnote mono">no checklist recorded</p>';

    const ok=M.verdict==="accepted";
    $("#dsrOut").innerHTML=`
      <div class="dsroutviz">
        ${M.verdict?`<div class="dsrseal ${ok?"ok":"warn"}">
          <svg viewBox="0 0 24 24">${ok?'<path d="M5 12.5l4.5 4.5L19 7.5"/>'
            :'<path d="M12 5v8.5"/><path d="M12 17.4v.6"/>'}</svg>
          <b>${esc(M.verdict)}</b>${M.outcomeKind?`<span>${esc(M.outcomeKind)}</span>`:""}
        </div>`:`<div class="dsrseal none"><b>no verdict</b><span>in flight</span></div>`}
        <div class="dsrtiles">
          ${tile(M.evP,"evidence pass",
            minibar([{n:M.evP,c:"--pass",t:`${M.evP} pass`},{n:M.evF,c:"--fail",t:`${M.evF} fail`}])
            +`<em class="mono">${M.evF} fail · ${M.evM} mechanical</em>`)}
          ${M.gateReceipts?tile(`${M.gateOk}<span class="dim">/${M.gateReceipts}</span>`,"done gates",
            dots(Array.from({length:Math.min(M.gateReceipts,8)},(_,k)=>({ok:k<M.gateOk}))))
            :""}
          ${tile(M.nPasses,"review passes")}
          ${M.valRes?tile(`<span class="dsrvbig ${M.valRes==="pass"?"ok":"bad"}">${esc(M.valRes)}</span>`,"validation"):""}
        </div>
      </div>
      ${M.valCmd?`<p class="dsrcmd mono">${esc(M.valCmd.slice(0,120))}</p>`:""}`;

    const forks=M.optNames.length?M.optNames:(M.chosen?[M.chosen]:[]);
    $("#dsrOrigin").innerHTML=(forks.length||M.keywords.length||M.task||M.outcomeText)?[
      forks.length?`<div class="dsrfork">${forks.map(n=>{
        const c=n===M.chosen;
        return `<div class="dsropt${c?" chosen":""}">${c?"✓ ":""}${esc(n)}</div>`;}).join("")}</div>`:"",
      M.nPreMortem?`<div class="dsrpm">${Array.from({length:Math.min(M.nPreMortem,8)},()=>"<i>◆</i>").join("")}<em class="mono">${M.nPreMortem} pre-mortem scenario${M.nPreMortem>1?"s":""} mitigated</em></div>`:"",
      M.keywords.length?`<div class="dsrkws">${M.keywords.slice(0,10).map(k=>
        `<u class="dsrkw mono">${esc(k)}</u>`).join(" ")}</div>`:"",
      (M.task||M.outcomeText||M.rationale)?`<div class="dsrprose">${[
        M.task?row("task",`<span title="${esc(M.task)}">${esc(M.task)}</span>`):"",
        M.outcomeText?row("outcome",`<span title="${esc(M.outcomeText)}">${esc(M.outcomeText)}</span>`):"",
        M.rationale?row("rationale",`<span title="${esc(M.rationale)}">${esc(M.rationale)}</span>`):"",
      ].join("")}</div>`:"",
    ].join(""):'<p class="dsrnote mono">no origin artifacts recorded</p>';

    const done_=/fixed|closed|resolved|done/;
    const sigTiles=[];
    if(M.bugs.length)sigTiles.push(tile(M.bugs.length,"bugs",
      dots(M.bugs.slice(0,8).map(b=>({ok:done_.test(b.st),t:`${b.id} · ${b.st}`})))));
    if(M.miles.length){const md=M.miles.filter(m=>m.st==="done").length;
      sigTiles.push(tile(`${md}<span class="dim">/${M.miles.length}</span>`,"milestones",
        minibar([{n:md,c:"--pass",t:"done"},{n:M.miles.length-md,c:"--disc",t:"open"}])))}
    if(M.tk&&typeof M.tk==="object"&&(M.tk.count!=null||M.tk.takeovers!=null))
      sigTiles.push(tile(esc(String(M.tk.count??M.tk.takeovers)),"takeovers"));
    if(M.nRed)sigTiles.push(tile(M.nRed,"red evidence"));
    if(M.gfc&&typeof M.gfc==="object"){
      const tops=Object.entries(M.gfc).filter(([,v])=>typeof v==="number"&&v>0)
        .sort((a,b)=>b[1]-a[1]);
      const tot=tops.reduce((a,[,v])=>a+v,0);
      if(tot)sigTiles.push(tile(tot,"gate failures",
        `<em class="mono">${tops.slice(0,2).map(([g,n])=>`${esc(g)} ×${n}`).join(" · ")}</em>`));
    }
    const sig=[];
    if(sigTiles.length)sig.push(`<div class="dsrtiles">${sigTiles.join("")}</div>`);
    if(M.risks.length)sig.push(`<div class="dsrkws">${M.risks.slice(0,6).map(r=>
      `<u class="dsrkw mono warn" title="${esc(r.m)}">${esc(r.cat)}</u>`).join(" ")}</div>`);
    if(M.live&&M.lease){
      const beat=M.lease.beat?D(M.lease.beat):null;
      const age=beat?Math.max(0,Math.round((Date.now()-beat.getTime())/1e3)):null;
      const who=S1(M.lease.owner||M.lease.agent||M.lease.sessionId||"").slice(0,40);
      sig.push(`<p class="dsrcmd mono">owner lease · ${who?esc(who)+" · ":""}`
        +`${age!=null?`heartbeat ${age}s ago`:esc(S1(M.lease).slice(0,60))}</p>`);
    }
    if(M.bugs.length)sig.push(`<div class="dsrprose">${
      M.bugs.slice(0,6).map(b=>row(esc(b.id),`<span class="mono">${esc(b.t.slice(0,80))} · ${esc(b.st)}</span>`)).join("")}</div>`);
    $("#dsrSig").innerHTML=sig.join("")
      ||'<p class="dsrnote mono">quiet — no risks, bugs or ledger entries recorded</p>';
  }

  /* ---- findings feed: every finding, newest first, rows expand in place ---- */
  function paintFindings(freshAfterMs){
    const list=[...M.findings].sort((a,b)=>b.ms-a.ms);
    $("#dsrFlN").textContent=`${list.length} findings · newest first · click a row for the full text`;
    $("#dsrFl").innerHTML=list.map(f=>{
      const fresh=freshAfterMs!=null&&f.ms>freshAfterMs;
      return `<div class="dsrfrow${fresh?" fresh":""}">
        <div class="dsrfhead">
          <u class="mono">${esc(fMin(new Date(f.ms).toISOString()).slice(5))}</u>
          <i style="background:var(${SEVPAL[f.sev]||"--disc"})" title="${esc(f.sev)}"></i>
          <b class="mono">${esc(f.id)}</b>
          <em class="mono">${esc(f.laneName)}</em>
          <s class="mono st-${esc(f.status)}">${esc(f.status)}</s>
          <span>${esc(f.desc.slice(0,180))}${f.desc.length>180?"…":""}</span>
        </div>
        <div class="dsrfbody">
          <p>${esc(f.desc)}</p>
          ${f.res?`<p class="dsrres"><i class="mono">${esc(f.rtype||"resolved")}</i> ${esc(f.res)}</p>`:""}
          ${f.files.length?`<p class="mono dim">${f.files.slice(0,4).map(esc).join("<br>")}</p>`:""}
        </div>
      </div>`;
    }).join("")||'<p class="dsrnote mono">no findings recorded</p>';
  }
  $("#dsrFl").addEventListener("click",e=>{
    const r=e.target.closest(".dsrfrow"); if(r)r.classList.toggle("open");
  });

  /* ---- swarm: cells rebuilt on data change; new cells flagged fresh ---- */
  const sw=$("#dsrSwarm");
  let swarmShown=[],swCells=[];
  function buildSwarm(prevCount){
    swarmShown=M.dispatches.slice(0,SWARM_CAP);
    sw.innerHTML=swarmShown.map((x,k)=>
      `<i style="--c:var(${laneColor(x.ag)})"${k>=prevCount?' class="fresh"':""} title="${esc(x.ag)}${x.kind?" · "+esc(x.kind):""}"></i>`).join("");
    swCells=[...sw.children];
    const foot=$("#dsrSwFoot");
    foot.hidden=M.dispatches.length<=SWARM_CAP;
    if(!foot.hidden)foot.textContent=`first ${SWARM_CAP} of ${M.dispatches.length} shown`;
    const perAg={}; for(const x of M.dispatches) perAg[x.ag]=(perAg[x.ag]||0)+1;
    $("#dsrSwLg").innerHTML=Object.entries(perAg).sort((a,b)=>b[1]-a[1]).slice(0,8)
      .map(([l,n])=>`<span><i style="background:var(${laneColor(l)})"></i>${esc(l)} ${n}</span>`).join("")
      ||'<span>no dispatches recorded</span>';
  }

  /* ---- pulse: geometry rebuilt on data change; cursor line per frame ---- */
  const pw=640,phh=210,pl=34,pr=10,pt=12,pb=24;
  let px_=()=>pl,clipR=null,curLine=null;
  function rebuildPulse(){
    px_=t=>pl+(pw-pl-pr)*Math.max(0,Math.min(1,(t-M.t0)/span));
    const maxN=Math.max(M.findings.length,1);
    const py_=n=>pt+(phh-pt-pb)*(1-n/maxN);
    const stepPath=events=>{
      let dstr=`M${pl} ${py_(0).toFixed(1)}`,n=0;
      for(const e of events){dstr+=`L${px_(e.ms).toFixed(1)} ${py_(n).toFixed(1)}`;n++;
        dstr+=`L${px_(e.ms).toFixed(1)} ${py_(n).toFixed(1)}`}
      dstr+=`L${pw-pr} ${py_(n).toFixed(1)}`;
      return dstr;
    };
    $("#dsrPulse").innerHTML=`
      ${M.segs.map(sg=>`<rect class="band" x="${px_(sg.ms).toFixed(1)}" y="0"
        width="${Math.max(0,px_(sg.end??M.t1)-px_(sg.ms)).toFixed(1)}" height="${phh}"
        style="fill:var(${phv(sg.phase)})"/>`).join("")}
      ${M.rounds.map(r=>{const t=T(r);return t?`<line class="rtick" x1="${px_(t).toFixed(1)}" x2="${px_(t).toFixed(1)}" y1="${phh-pb}" y2="${phh-pb-7}"/>`:""}).join("")}
      <clipPath id="dsrClip"><rect id="dsrClipR" x="0" y="0" width="${pw}" height="${phh}"/></clipPath>
      <g clip-path="url(#dsrClip)">
        <path class="opened" d="${stepPath(M.findings)}"/>
        <path class="settled" d="${stepPath(M.settledEvents)}"/>
      </g>
      <line id="dsrCur" class="cursor" x1="${pw-pr}" x2="${pw-pr}" y1="0" y2="${phh-pb}"/>
      <text class="ax" x="${pl}" y="${phh-8}">${esc(fDay(M.t0))}</text>
      <text class="ax" x="${pw-pr}" y="${phh-8}" text-anchor="end">${esc(fDay(M.t1))}</text>
      ${M.findings.length?`<text class="ax" x="${pl-5}" y="${pt+9}" text-anchor="end">${maxN}</text>`
        :`<text class="empty" x="${((pw+pl-pr)/2).toFixed(1)}" y="${((phh-pb)/2).toFixed(1)}" text-anchor="middle">NO FINDINGS TO PLOT</text>`}`;
    clipR=$("#dsrClipR");curLine=$("#dsrCur");
  }

  /* ---- wire log ---- */
  const logBox=$("#dsrLog");
  let wireRange=null,userScrolled=false,cursor=M.t1,wireMaxMs=M.t1;
  let lastWireIdx=-1,wireScrollAt=0;
  logBox.addEventListener("scroll",()=>{
    userScrolled=logBox.scrollTop+logBox.clientHeight<logBox.scrollHeight-30;
  });
  function buildWire(freshAfterMs){
    const skip=new Set(WIRE_SKIP_DEFAULT);
    if($("#dsrWd").checked)skip.delete("dispatch");
    if($("#dsrWc").checked)skip.delete("codex_cli");
    const evs=M.allEvents.filter(e=>!skip.has(e.type))
      .map(e=>({ms:T(e.timestamp),e})).filter(x=>x.ms!=null).sort((a,b)=>a.ms-b.ms);
    const CAPL=3000;
    const rows=evs.slice(-CAPL);
    logBox.innerHTML=(evs.length>CAPL?`<div class="dsrrowc">… ${evs.length-CAPL} earlier lines elided</div>`:"")
      +rows.map(x=>{const w=wireLine(x.e);
        const fresh=freshAfterMs!=null&&x.ms>freshAfterMs;
        return `<div class="dsrline${fresh?" fresh":""}"><u>${esc(fDay(x.e.timestamp).slice(5))} ${esc(fTime(x.e.timestamp))}</u><b style="color:var(${w.cv})">${esc(w.tag)}</b><span>${esc(w.txt)}</span></div>`}).join("")
      ||'<div class="dsrrowc">no events recorded</div>';
    const els=[...logBox.querySelectorAll(".dsrline")];
    const wireRows=rows.map((x,k)=>({ms:x.ms,el:els[k]}));
    wireRange=mkRange(wireRows,r=>r.el.classList.add("on"),r=>r.el.classList.remove("on"));
    lastWireIdx=wireRange.seek(cursor);
    if(!userScrolled)logBox.scrollTop=logBox.scrollHeight;
  }
  $("#dsrWd").addEventListener("change",()=>buildWire());
  $("#dsrWc").addEventListener("change",()=>buildWire());

  /* ---- time ranges + cursor ---- */
  let rCreated,rSettled,rSwarm,rEvents,rRounds;
  function rebuildRanges(){
    rCreated=mkRange(M.findings,f=>dotEl.get(f.id)?.classList.add("on"),
                                f=>dotEl.get(f.id)?.classList.remove("on"));
    rSettled=mkRange(M.settledEvents,x=>dotEl.get(x.f.id)?.classList.add("set"),
                                     x=>dotEl.get(x.f.id)?.classList.remove("set"));
    rSwarm=mkRange(swarmShown,(_,k)=>swCells[k]?.classList.add("on"),
                              (_,k)=>swCells[k]?.classList.remove("on"));
    rEvents=mkRange(M.allEvents.map(e=>({ms:T(e.timestamp)})).filter(x=>x.ms!=null)
      .sort((a,b)=>a.ms-b.ms),()=>{},()=>{});
    rRounds=mkRange(M.rounds.map(r=>({ms:T(r)})).filter(x=>x.ms!=null)
      .sort((a,b)=>a.ms-b.ms),()=>{},()=>{});
  }

  /* follow=true means the cursor rides the story's live edge: the wall-clock
     tick and every poll keep it pinned to "now". A replay drops out of follow
     until it finishes back at the edge. */
  let loopLast=-1,lastPh=null,follow=true;
  function setCursor(t){
    cursor=Math.max(M.t0,Math.min(M.t1,t));
    follow=cursor>=M.t1-1000;
    nf.textContent=rCreated.seek(cursor);
    rSettled.seek(cursor);
    nd.textContent=rSwarm.seek(cursor);
    ne.textContent=rEvents.seek(cursor);
    nr.textContent=rRounds.seek(cursor);
    /* autoscroll only when the visible row count actually changed, and at most
       ~8x/s: reading scrollHeight forces layout, which janked the sweep */
    if(wireRange){
      const wi=wireRange.seek(cursor);
      if(wi!==lastWireIdx){lastWireIdx=wi;
        const nw=performance.now();
        if(!userScrolled&&nw-wireScrollAt>120){wireScrollAt=nw;
          logBox.scrollTop=logBox.scrollHeight}}
    }
    const x=px_(cursor);
    clipR.setAttribute("width",x.toFixed(1));
    curLine.setAttribute("x1",x.toFixed(1));curLine.setAttribute("x2",x.toFixed(1));
    tEl.textContent="T+"+dur2(cursor-M.t0);
    let curPh=M.segs[0]?M.segs[0].phase:story.phase;
    for(const sg of M.segs){if(sg.ms<=cursor)curPh=sg.phase;else break}
    if(lastPh!==curPh){lastPh=curPh;phEl.textContent=curPh;
      phEl.style.color=`var(${phv(curPh)})`;phEl.style.borderColor=`var(${phv(curPh)})`}
    // the loop repaints its own SVG; throttle to 10Hz so playback stays cheap
    const now=performance.now();
    if(now-loopLast>100||cursor>=M.t1||cursor<=M.t0){paintLoop(cursor);loopLast=now}
  }

  /* ---- playback: replay button, plus the fast opening sweep ---- */
  let raf=0,playing=false;
  const playBtn=$("#dsrPlay");
  function setIco(){$("#dsrPlayIco").innerHTML=playing
    ?'<path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor"/>'
    :'<path d="M4 2.5v11l9-5.5z" fill="currentColor"/>'}
  function stopPlay(){playing=false;cancelAnimationFrame(raf);setIco()}
  function runSweep(durMs,ease){
    const from=cursor>=M.t1-1?M.t0:cursor;
    const t0p=performance.now(),f0=(from-M.t0)/span;
    playing=true;setIco();
    const step=n=>{
      if(!playing)return;
      let p=Math.min(1,f0+(n-t0p)/durMs*(1-f0));
      if(ease)p=1-Math.pow(1-p,2);   // decelerate into the present
      setCursor(M.t0+span*p);
      if(p>=1){stopPlay();return}
      raf=requestAnimationFrame(step);
    };
    raf=requestAnimationFrame(step);
  }
  const startPlay=()=>runSweep(Number($("#dsrSpeed").value)||3e4,false);
  playBtn.addEventListener("click",()=>playing?stopPlay():startPlay());

  /* ---- live: wall-clock tick + polling for new material ---- */
  function toast(html){
    const box=$("#dsrToasts");
    const t=document.createElement("div");
    t.className="dsrtoast";
    t.innerHTML=html;
    box.appendChild(t);
    while(box.children.length>3)box.firstChild.remove();
    setTimeout(()=>{t.classList.add("out");setTimeout(()=>t.remove(),400)},7000);
  }
  function bumpCount(el){
    el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump");
  }
  function applyUpdate(d){
    const NM=buildModel(story,d);
    const oldIds=new Set(M.findings.map(f=>f.id));
    const newF=NM.findings.filter(f=>!oldIds.has(f.id));
    const newEv=NM.allEvents.length-M.allEvents.length;
    const newDisp=NM.dispatches.length-M.dispatches.length;
    const phaseFrom=M.i.phase,phaseTo=NM.i.phase;
    const newSettled=NM.settledEvents.length-M.settledEvents.length;
    const wentDone=M.live&&!NM.live;
    if(!newF.length&&newEv<=0&&phaseFrom===phaseTo&&newSettled<=0&&!wentDone){
      // nothing recorded; for a live story just move the edge of time forward
      if(NM.live){M.t1=Math.max(M.t1,NM.t1);span=M.t1-M.t0;M.live=NM.live}
      return;
    }
    const prevSwarm=swarmShown.length,prevWireMax=wireMaxMs;
    M=NM; span=M.t1-M.t0; wireMaxMs=M.t1;
    root.classList.toggle("live",M.live);
    $("#dsrLive").hidden=!M.live;
    $("#dsrIdBox").style.setProperty("--ph",`var(${phv(M.i.phase)})`);
    $("#dsrSub").innerHTML=`${esc(story.id)} · ${esc(story.type||"story")} · ${esc(story.pri||"?")} priority
      · ${esc(fDay(M.i.createdAt||""))} → ${M.i.endedAt?esc(fDay(M.i.endedAt)):"in flight"}`;
    ensureDots(new Set(newF.map(f=>f.id)));
    paintMap();
    rebuildLoopGeom();
    paintWeb();
    paintPanels();
    lockHeaderWidths();
    buildSwarm(prevSwarm);
    rebuildPulse();
    $("#dsrFacts").innerHTML=factsHtml();
    $("#dsrStatsB").innerHTML=statsHtml();
    paintFindings(prevWireMax);
    buildWire(prevWireMax);
    rebuildRanges();
    lastPh=null;  // force the phase badge to repaint from the new segments
    if(follow&&!playing)setCursor(M.t1); else setCursor(cursor);
    if(newF.length)bumpCount(nf);
    if(newEv>0)bumpCount(ne);
    if(newDisp>0)bumpCount(nd);
    // one toast per poll, most important line first
    const parts=[];
    if(phaseFrom!==phaseTo)parts.push(`<b class="tphase" style="color:var(${phv(phaseTo)})">${esc(phaseFrom)} → ${esc(phaseTo)}</b>`);
    if(newF.length){
      const worst=["critical","high","medium","low"].find(s=>newF.some(f=>f.sev===s))||"";
      parts.push(`<b>+${newF.length} finding${newF.length>1?"s":""}</b>
        <span>${newF.slice(0,3).map(f=>esc(f.id)).join(" ")}${newF.length>3?" …":""}${worst?` · ${esc(worst)}`:""}</span>`);
    }
    if(newSettled>0)parts.push(`<span>${newSettled} finding${newSettled>1?"s":""} settled</span>`);
    if(newEv>0&&!newF.length)parts.push(`<span>+${newEv} process event${newEv>1?"s":""}</span>`);
    if(wentDone)parts.push(`<b class="tphase" style="color:var(--ph-done)">story reached DONE</b>`);
    if(parts.length)toast(parts.join("<br>"));
  }
  const tickIv=setInterval(()=>{
    if(!M.live||playing)return;
    M.t1=Math.max(M.t1,Date.now()); span=M.t1-M.t0;
    if(follow)setCursor(M.t1);
  },1000);
  let pollBusy=false,pollIv=0,pollLive=M.live;
  async function poll(){
    if(pollBusy)return;
    pollBusy=true;
    try{
      const r=await fetch(`/api/story?id=${encodeURIComponent(story.id)}`);
      if(r.ok)applyUpdate(await r.json());
    }catch{/* transient; next poll retries */}
    finally{pollBusy=false}
    // a story can come back to life (or finish) under us; retime the poll
    if(M.live!==pollLive){pollLive=M.live;schedulePoll()}
  }
  function schedulePoll(){clearInterval(pollIv);pollIv=setInterval(poll,pollLive?4000:15000)}
  schedulePoll();

  /* ---- responsive two-column layout ----
     Wide screens get a main column and an intelligence rail that flow
     INDEPENDENTLY (a grid row-span couples row heights, so any panel-height
     mismatch opened holes under the map). The sections physically move
     between the flat body and the two column wrappers; listeners live on
     the sections' children, so re-parenting is safe. */
  const colsMQ=matchMedia("(min-width:1100px)");
  const MAIN_COL=["loop","map","web","check","origin","findings"];
  const RAIL_COL=["out","pulse","swarm","sig","stats","wire"];
  const FLAT=["loop","map","out","pulse","swarm","web","check","origin","findings","sig","wire","stats"];
  const secOf=c=>root.querySelector(".sec-"+c);
  function relayout(){
    const body=$("#dsrBody");
    if(colsMQ.matches){
      let main=$("#dsrColMain");
      if(!main){
        main=document.createElement("div");main.id="dsrColMain";main.className="dsrcol";
        const rail=document.createElement("div");rail.id="dsrColRail";rail.className="dsrcol";
        body.append(main,rail);
      }
      const rail=$("#dsrColRail");
      for(const c of MAIN_COL){const el=secOf(c);if(el)main.appendChild(el)}
      for(const c of RAIL_COL){const el=secOf(c);if(el)rail.appendChild(el)}
    }else{
      for(const c of FLAT){const el=secOf(c);if(el)body.appendChild(el)}
      $("#dsrColMain")?.remove();$("#dsrColRail")?.remove();
    }
  }
  colsMQ.addEventListener("change",relayout);
  // belt over the media-query listener: some environments deliver resize but
  // not matchMedia change events; relayout is idempotent and cheap
  addEventListener("resize",relayout);

  /* ---- lifecycle ---- */
  function onKey(e){
    if(e.key==="Escape"){e.stopPropagation();close()}
    else if(e.key===" "&&!e.target.closest("input,select,button")){
      e.preventDefault();playing?stopPlay():startPlay()}
  }
  /* skipNav=true is the story-to-story hop from the web panel: the next
     dossier pushes its own URL, so this close must not reset it to "/" */
  function close(skipNav){
    stopPlay();
    clearInterval(tickIv);clearInterval(pollIv);
    colsMQ.removeEventListener("change",relayout);
    removeEventListener("resize",relayout);
    document.removeEventListener("keydown",onKey,true);
    if(window.closeStoryDossier===closeHandle)window.closeStoryDossier=undefined;
    document.body.classList.remove("dsropen");
    root.remove();
    if(skipNav!==true&&hooks&&hooks.onClose)hooks.onClose();
  }
  const closeHandle=()=>close();
  window.closeStoryDossier=closeHandle;
  document.addEventListener("keydown",onKey,true);
  root.querySelector("[data-dsrclose]").addEventListener("click",()=>close());

  /* ---- first paint + opening sweep ---- */
  relayout();
  ensureDots(null);
  paintMap();
  rebuildLoopGeom();
  paintWeb();
  paintPanels();
  paintFindings();
  lockHeaderWidths();
  buildSwarm(Infinity);
  rebuildPulse();
  buildWire();
  rebuildRanges();
  if(reduceMotion||span<2000||M.allEvents.length+M.findings.length<3){
    setCursor(M.t1);
  }else{
    setCursor(M.t0);
    requestAnimationFrame(()=>runSweep(2400,true));
  }
}

window.openStoryDossier=openStoryDossier;
})();
