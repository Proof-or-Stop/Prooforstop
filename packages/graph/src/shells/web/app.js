/* ---------- time: stored UTC -> displayed in the viewer's local zone ---------- */
const TZ=(()=>{ try{ return Intl.DateTimeFormat().resolvedOptions().timeZone||"local" }catch{ return "local" } })();
function D(v){ if(!v)return null; const d=new Date(v); return isNaN(d)?null:d }
const P2=n=>String(n).padStart(2,"0");
function fDay(v){ const d=D(v); return d?`${d.getFullYear()}-${P2(d.getMonth()+1)}-${P2(d.getDate())}`:"" }
function fMin(v){ const d=D(v); return d?`${fDay(v)} ${P2(d.getHours())}:${P2(d.getMinutes())}`:"" }
function fSec(v){ const d=D(v); return d?`${fMin(v)}:${P2(d.getSeconds())}`:"" }
function fTime(v){ const d=D(v); return d?`${P2(d.getHours())}:${P2(d.getMinutes())}:${P2(d.getSeconds())}`:"" }

/* Managed runtime changes are independent of the Story graph's content hashes. */
const managedNotificationMemory=new Set();
let latestManagedStatus=null;
function renderManagedRunStatus(status){
  latestManagedStatus=status;
  const list=document.getElementById('managedRunsList'),connection=document.getElementById('managedRunsConnection'),notices=document.getElementById('managedRunNotifications');
  if(!list||!connection||!notices)return;
  const view=status.managedRuns;
  if(!view||!Array.isArray(view.runs)||!Array.isArray(view.diagnostics)){connection.textContent='Managed run status unavailable; reconnecting…';return;}
  const diagnosticText={invalid_managed_run:'Some run records could not be verified',managed_runtime_unavailable:'Run status unavailable',managed_runtime_scan_limit:'Partial run list: observation limit reached','Managed run status unavailable; reconnect to retry.':'Managed run status unavailable; reconnect to retry.'};
  connection.textContent=view.diagnostics.length?view.diagnostics.map(code=>diagnosticText[code]||'Run status unavailable').join(' · '):(view.runs.length?'Live · updates every 5 seconds':'No managed runs');
  const fragment=document.createDocumentFragment();
  for(const run of view.runs){
    const row=document.createElement('div');row.className='managed-run-row';row.dataset.runId=run.runId;
    const identifier=document.createElement('div');identifier.className='managed-run-id';identifier.textContent='Run '+(run.runId.length>24?run.runId.slice(0,24)+'…':run.runId);identifier.title=run.runId;row.append(identifier);
    const title=document.createElement('strong');title.textContent=`${run.storyId||'Owner task'} · ${run.host} · ${run.state}`;row.append(title);
    const stageNames={accepted:'Accepted',starting_provider:'Starting provider',provider_running:'Provider running',finalizing_result:'Finalizing result',terminal:'Finished'};
    const detail=document.createElement('p');detail.textContent=`${run.stage.number}/${run.stage.total} ${stageNames[run.stage.name]||run.stage.name}${run.queueReason&&!run.terminal?' · Waiting: '+run.queueReason:''}`;row.append(detail);
    const progress=document.createElement('p');progress.textContent=run.lastProviderProgressAt?`Last provider output: ${fSec(run.lastProviderProgressAt)}`:'No provider output observed';row.append(progress);
    const eta=document.createElement('p');eta.textContent=run.durationEstimate.kind==='historical'&&run.durationEstimate.estimatedTerminalAt?`Historical ETA: ${fSec(run.durationEstimate.estimatedTerminalAt)} (${run.durationEstimate.sampleCount} samples)`:'Historical ETA unavailable';row.append(eta);
    fragment.append(row);
  }
  list.replaceChildren(fragment);
  // Background tabs have not shown the owner a notification. Replay on visibility.
  if(document.hidden)return;
  const storageKey='proof-or-stop:managed-terminals:'+status.root;
  let stored=[];try{const value=JSON.parse(localStorage.getItem(storageKey)||'[]');if(Array.isArray(value))stored=value.filter(x=>typeof x==='string');}catch{}
  for(const run of view.runs){
    if(!run.terminal)continue;
    const token=JSON.stringify([run.runId,run.terminal.digest]),memoryKey=storageKey+token;
    if(stored.includes(token)||managedNotificationMemory.has(memoryKey))continue;
    const notice=document.createElement('div');notice.className='managed-run-toast';notice.dataset.runId=run.runId;
    const close=document.createElement('button');close.type='button';close.textContent='×';close.setAttribute('aria-label','Dismiss run notification');close.onclick=()=>notice.remove();
    const text=document.createElement('span');text.textContent=`${run.storyId||'Owner task'} · ${run.host}: ${run.terminal.state} at ${fSec(run.terminal.terminalAt)}`;notice.append(close,text);notices.append(notice);
    // Acknowledge only after the real DOM notification has been attached.
    managedNotificationMemory.add(memoryKey);stored.push(token);
    try{localStorage.setItem(storageKey,JSON.stringify(stored));}catch{}
  }
}
function managedRunConnectionFailed(){const element=document.getElementById('managedRunsConnection');if(element)element.textContent='Managed run connection lost; retrying…';}
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&latestManagedStatus)renderManagedRunStatus(latestManagedStatus);});

/* ---------- project raw story files into the view model (no truncation) ---------- */
function S1(v){
  if(v===null||v===undefined) return "";
  if(typeof v==="string") return v;
  if(typeof v==="number"||typeof v==="boolean") return String(v);
  if(Array.isArray(v)) return v.map(S1).filter(Boolean).join(" · ");
  const parts=[];
  for(const [k,x] of Object.entries(v)){
    if(x===null||x===undefined||x==="")continue;
    parts.push(typeof x==="object"?`${k}: ${Array.isArray(x)?x.map(S1).filter(Boolean).join(", "):S1(x)}`:`${k}: ${x}`);
  }
  return parts.join(" · ");
}
function SA(a){ return (Array.isArray(a)?a:[]).map(S1).filter(Boolean) }
function F(d,name){ const f=d.files&&d.files[name]; return f?(f.data!==undefined?f.data:(f.rows!==undefined?f.rows:f.text)):null }
function arr(v){ return Array.isArray(v)?v:(v&&Array.isArray(v.findings)?v.findings:[]) }

function projectDetail(d,s){
  const c=F(d,'checklist.json')||{}, items=c.items||[];
  const fs_=arr(F(d,'findings.json'));
  const O={items:[],findings:[],findingsTotal:fs_.length,raw:d};
  for(const it of items){
    const evb={}, loose=[];
    for(const e of (it.verificationEvidence||[])){
      const rc=e.receipt||{};
      const rec={kind:e.kind,result:e.result,cmd:e.command||'',file:e.file||'',
        note:e.note||'',mech:!!e.mechanical,
        rc:Object.keys(rc).length?{x:rc.exitCode,sel:rc.selectorMatched,dig:(rc.outputDigest||'').slice(0,12)}:null,
        tail:rc.outputTail||'',nmr:e.nonMechanicalReason||'',wv:e.waiverType||''};
      if(e.intentRef){ (evb[e.intentRef] ||= []).push(rec) } else loose.push(rec);
    }
    const lanes=[];
    const vi=it.verificationIntent||{};
    const order=['happy','edge','adversarial'].filter(k=>Array.isArray(vi[k]))
      .concat(Object.keys(vi).filter(k=>!['happy','edge','adversarial'].includes(k)&&Array.isArray(vi[k])));
    for(const lane of order){
      const L=[];
      (vi[lane]||[]).forEach((e,k)=>{
        if(!e||typeof e!=='object')return;
        const iid=e.id||`${it.id}:${lane}:${k}`;
        const pin=e.verification||null;
        L.push({id:iid,desc:e.desc||'',type:e.type,pri:e.priority,
          pin:pin?{c:pin.command||'',s:pin.selector||''}:null,
          ev:evb[iid]||evb[`${it.id}:${lane}:${k}`]||[]});
      });
      if(L.length) lanes.push({lane,items:L});
    }
    O.items.push({id:it.id,title:it.title||'',status:it.status,userSees:it.userSees||'',
      docs:it.relatedDocs||[],lanes,loose});
  }
  for(const f of fs_) O.findings.push({id:f.id,sev:f.severity,status:f.status,cat:f.category,
    agent:(f.agent||'').replace('lattice-review-',''),desc:S1(f.desc),files:SA(f.files),
    res:S1(f.resolvedReason),rtype:S1(f.resolutionType)||null,cl:f.clusterId,ev:f.evidenceState});
  return O;
}

function extractStoryFields(d,s){
  const i=F(d,'index.json')||{}, u=F(d,'understanding.json')||{}, dec=F(d,'decision.json')||{};
  const ps=F(d,'proofstory.json')||{}, dc=F(d,'delivery-check.json')||{}, sm=F(d,'summary.json')||{};
  const te=F(d,'test-evidence.json')||{}, dre=F(d,'done-required-evidence.json')||{};
  const sc=F(d,'scope-check.json')||{}, ic=F(d,'init-check.json')||{}, bug=F(d,'bug.json')||{};
  const cl=F(d,'clusters.json')||{}, red=F(d,'red-evidence.json')||{}, ml=F(d,'milestone-ledger.json')||{};
  const rv=F(d,'review.json')||{}, pm=F(d,'process-metrics.json')||{};
  const ois=F(d,'original-intent-snapshot.json')||{}, icol=F(d,'intent-collision.json')||{};
  const sct=F(d,'scope-contract.json')||{}, sb=F(d,'scope-boundary.json')||{}, eb=F(d,'execution-boundary.json')||{};
  const sfc=F(d,'scope-freeze-check.json')||{}, isc=F(d,'init-self-check.json')||{};
  const mc=F(d,'milestone-closeout.json')||{}, ab=F(d,'acceptance-basis.json')||{};
  const prc=F(d,'pre-review-check.json')||{}, tcr=F(d,'topology-critic-receipt.json')||{};
  const rie=F(d,'review-inventory-epochs.json')||{}, cw=F(d,'certification-window.json')||{};
  const lease=F(d,'owner-lease.json')||null, bs=F(d,'breaker-state.json')||null;
  const gfc=F(d,'gate-failure-counts.json')||null, tk=F(d,'takeover-count.json')||null;
  const pe=F(d,'process-events.jsonl')||[], cwr=F(d,'closeout-write-receipts.jsonl')||[];
  const penF=d.files&&d.files['prompt-envelopes.json'];
  const rrF =d.files&&d.files['review-runs.json'];
  const c=F(d,'checklist.json')||{}, items=c.items||[];
  const revs=rv.reviews||[], last=revs[revs.length-1]||{};
  const cov=te.verificationCoverage||{};
  const evk={}; let nInt=0,evp=0,evf=0,mech=0,nEv=0;
  for(const it of items){
    for(const a of Object.values(it.verificationIntent||{})) if(Array.isArray(a)) nInt+=a.length;
    for(const e of (it.verificationEvidence||[])){ nEv++; evk[e.kind]=(evk[e.kind]||0)+1;
      if(e.result==='pass')evp++; else if(e.result==='fail')evf++; if(e.mechanical)mech++ }
  }
  const cnt=a=>{const m={};for(const x of a)m[x]=(m[x]||0)+1;return m};
  const fs_=arr(F(d,'findings.json'));
  const rrRows=(rrF&&rrF.count!=null)?rrF.count:((F(d,'review-runs.json')||{}).runs||[]).length;
  const lanes=[...new Set(((F(d,'review-runs.json')||{}).runs||[]).map(r=>(r.lane||r.agent||'').replace('lattice-review-','')))].filter(Boolean);
  const startedAt=i.startedAt||i.createdAt, endedAt=i.endedAt;
  const wall=(startedAt&&endedAt)?(new Date(endedAt)-new Date(startedAt)):null;
  return {
    desc:i.description||'',task:u.task||'',outcome:u.outcome||'',
    facts:SA(u.facts),constraints:SA(u.constraints),unknowns:SA(u.unknowns),
    tp:(u.touchpoints||[]).filter(x=>typeof x==='string'),
    principles:SA(dec.principles),chosen:dec.chosen,rationale:dec.rationale||'',
    options:(dec.options||[]).map(o=>({n:S1(o.name),p:SA(o.pros),c:SA(o.cons)})),
    preMortem:(dec.preMortem||[]).map(x=>({s:x.scenario||'',m:x.mitigation||''})),
    claims:SA((ps.acceptanceBindings||[]).map(b=>b.acceptanceClaim)),
    hardening:ps.hardeningLevel,
    nItems:items.length,nDone:items.filter(x=>x.status==='done').length,
    itemStatus:cnt(items.map(x=>x.status||'pending')),
    nInt,nEv,evPass:evp,evFail:evf,mech,evKinds:evk,
    nFind:fs_.length,sev:cnt(fs_.map(f=>f.severity)),fstat:cnt(fs_.map(f=>f.status)),
    nRuns:rrRows,nPass:((F(d,'review-passes.json')||{}).passes||[]).length,lanes,
    verdict:sm.acceptanceVerdict,outcomeKind:sm.outcomeKind,outcomeDiff:sm.outcomeDiff||'',
    limits:S1(sm.limitations),
    pitfalls:S1(sm.pitfalls),
    changes:S1(sm.changes),
    totalMs:sm.totalDurationMs??null,phaseStats:sm.phaseStats||null,wall,
    cov:cov.total!=null?{t:cov.total,r:cov.required,c:cov.covered,m:cov.missingRequired}:null,
    valCmd:te.command||'',valResult:te.result,
    gate:dre.status?{status:dre.status,ms:dre.durationMs,
      r:(dre.receipts||[]).map(x=>({l:x.label||'',st:x.status,x:x.exitCode,ms:x.durationMs,
        dig:(x.commandSpec?.digest||'').slice(0,12)}))}:null,
    selfCheck:dc.closingSelfCheck||{},
    promises:(dc.docsPromises||[]).map(p=>({d:p.docPath||'',p:p.promise||'',v:p.verifiedBy||'',w:p.waiverReason||''})),
    openQ:(sc.openQuestions||[]).map(x=>({q:x.q||'',r:x.resolution||''})),
    initIssues:(ic.issues||[]).map(x=>({s:S1(x.severity),d:S1(x.desc)})),
    bugs:(bug.bugs||[]).map(b=>({id:b.id,t:b.title||'',st:b.status,ev:b.evidence?JSON.stringify(b.evidence):''})),
    clusters:(cl.clusters||[]).map(x=>({id:x.clusterId,rc:x.rootCause||'',n:(x.findingIds||[]).length,sev:x.severity,f:x.files||[]})),
    red:(red.records||[]).map(x=>({t:x.trigger||'',f:x.observedFailure||'',c:x.failingCommand||''})),
    miles:(ml.milestones||[]).map(m=>({id:S1(m.id),d:S1(m.desc||m.title),st:S1(m.status)})),
    ledgerHash:ml.ledgerHash||'',
    bg:F(d,'background.md')||'',plan:F(d,'plan.md')||'',
    planRev:revs.length?{n:revs.length,iss:last.issueCount,blk:last.blockerCount,
      items:(last.issues||[]).map(x=>({t:x.type,s:x.severity,i:x.itemId,m:x.message||''}))}:null,
    metrics:pm.dimensions?{snap:pm.sourceSnapshot,
      dims:Object.fromEntries(Object.entries(pm.dimensions).map(([k,v])=>{
        if(v==null||typeof v!=='object') return [k,v];
        const eff=v.effective||{};
        let val=eff.value;
        if(val===null||val===undefined){
          // fall back to the first concrete sub-metric
          const m=v.metrics||{};
          const first=Object.values(m).find(x=>x&&x.value!==null&&x.value!==undefined);
          val=first?first.value:null;
        }
        const conf=eff.confidence?` (${eff.confidence})`:"";
        return [k, (val===null||val===undefined) ? "not measured" : String(val)+conf];
      })),
      gaps:SA(pm.overallGaps)}:null,
    origIntent:ois.sourceText?{src:ois.sourceText,norm:ois.normalizedOutcome||'',
      claim:ois.acceptanceClaim||'',reqs:ois.keyRequirementIds||[]}:null,
    reqHash:ois.requestHash||'',
    collision:icol.id?{id:icol.id,dec:icol.decision,st:icol.status,
      acc:icol.acceptedInterpretation||'',notes:S1(icol.notes)}:null,
    scope:(sct.mode||sb.mode)?{mode:sct.mode||sb.mode,mod:SA(sct.allowedModify),cre:SA(sct.allowedCreate),
      tst:SA(sct.allowedTest),prot:SA(sct.protectedFiles),exc:SA(sct.explicitExcludes||sb.excluded),
      reason:S1(sct.scopeChangeReason),note:S1(sb.confirmationNote)}:null,
    exec:eb.allowedCommands?{cmds:SA(eb.allowedCommands),tools:SA(eb.allowedTools),paths:SA(eb.allowedPaths),
      xcmds:SA(eb.excludedCommands),xtools:SA(eb.excludedTools),note:S1(eb.confirmationNote)}:null,
    freeze:sfc.status?{st:sfc.status,mode:sfc.mode,kw:SA(sfc.effectiveExcludedKeywords),
      hits:SA(sfc.keywordHits),iss:SA(sfc.issues)}:null,
    selfQ:isc.question?{q:isc.question,a:isc.answer||''}:null,
    closeout:mc.rows?{phase:mc.phase,rows:mc.rows.map(r=>({m:String(r.milestoneId||r.id||''),st:r.status,n:String(r.note||'')}))}:null,
    basis:ab.basis?{st:ab.basis.status,methods:ab.basis.discoveryMethods||[],blind:SA(ab.basis.blindSpots)}:null,
    basisProv:ab.basis?{profile:ab.basis.discoveryProfileRef,profDig:ab.basis.discoveryProfileDigest||'',
      gen:ab.basis.generatedBy?.command,ver:ab.basis.generatedBy?.algorithmVersion,dig:ab.basis.basisDigest||'',
      rcpt:ab.receipt?.receiptRef||'',issuer:ab.receipt?.issuer,sig:ab.receipt?.signature||'',seal:ab.receipt?.sealDigest||''}:null,
    preRev:prc.status?{st:prc.status,codes:prc.codes||[]}:null,
    preRevProv:prc.storyId?{mode:prc.mode,cut:prc.cutoffAt||'',planDig:prc.planBasisDigest||'',
      topoDig:prc.topologyDigest||'',scDig:prc.scopeCheckDigest||'',sfh:prc.storyFilesHash||'',sig:prc.signature||''}:null,
    critic:tcr.verdict?{v:tcr.verdict,role:tcr.criticRole,f:tcr.findingRefs||[]}:null,
    prov:tcr.criticProvenance?{critic:{id:tcr.criticProvenance.agentId,sess:tcr.criticProvenance.sessionId||'',
        disp:tcr.criticProvenance.dispatchId||'',head:tcr.criticProvenance.headHash||'',auth:tcr.criticProvenance.businessCommitAuthor},
      impl:tcr.implementationProvenance?{id:tcr.implementationProvenance.agentId,sess:tcr.implementationProvenance.sessionId||'',
        disp:tcr.implementationProvenance.dispatchId||'',head:tcr.implementationProvenance.headHash||''}:null,
      sig:tcr.signature||'',key:tcr.signerPublicKey||'',basisDig:tcr.basisDigest||'',topoDig:tcr.topologyDigest||''}:null,
    epochs:(rie.epochs||[]).map(e=>({id:e.epochId,st:e.state,rd:e.reviewRound||'',
      cut:e.cutoff||{},sd:e.scopeDigest||'',lanes:(e.requiredLanes||[]).map(x=>String(x).replace('lattice-review-',''))})),
    certReceipts:(cw.receipts||[]).map(r=>({id:r.receiptId,w:r.windowId,auth:r.authority,
      heavy:r.authorizesHeavyCertification,h:r._hash||''})),
    certWin:(cw.windows||[]).map(w=>({id:w.windowId,st:w.state,b:w.blockerCode})),
    psHashes:ps.originalIntentRequestHash?{orig:ps.originalIntentRequestHash,ledger:ps.confirmedMilestoneLedgerHash||''}:null,
    live:lease?{sess:lease.sessionId||'',host:lease.hostname,pid:lease.pid,cmd:lease.command,
      cwd:lease.cwd,acq:lease.acquiredAt,beat:lease.heartbeatAt,src:lease.sessionSource,
      // a bare "story_advance" is ambiguous; name the phase it moved into
      cmdTarget:(()=>{
        if(!/^story_(advance|resume)$/.test(String(lease.command||"")))return "";
        const ev=(i.events||[]).filter(e=>e.phase&&e.timestamp).sort((a,b)=>a.timestamp<b.timestamp?-1:1);
        const last=ev[ev.length-1];
        return last?`${last.phase}${last.action?" ("+last.action+")":""}`:"";
      })()}:null,
    takeovers:tk?.count??null,
    breaker:bs?{frozen:bs.frozen,spent:bs.autoRecoveriesSpent,reasons:SA(bs.trippedReasons)}:null,
    gateFails:gfc&&Object.keys(gfc).length?gfc:null,
    nPE:pe.length,peKinds:cnt(pe.map(x=>x.type)),
    nWriteReceipts:cwr.length,
    writeReceipts:cwr.slice(0,40).map(x=>({a:(x.artifactPath||'').split('/').pop(),c:x.writerCommand,
      ph:x.phase,seq:x.sequence,dig:(x.artifactDigest||'').slice(0,16),
      prev:(x.previousIntegrityHash||'').slice(0,16),ih:(x.integrityHash||'').slice(0,16)})),
    chainStats:(()=>{ if(!cwr.length)return null;
      const by={}; for(const r of cwr) (by[r.artifactPath] ||= []).push(r);
      let ok=0,bad=0;
      for(const rs of Object.values(by)){ let prev=null,good=true;
        for(const r of rs.sort((a,b)=>(a.sequence||0)-(b.sequence||0))){ if(r.previousIntegrityHash!==prev){good=false;break} prev=r.integrityHash }
        good?ok++:bad++ }
      return {artifacts:Object.keys(by).length,valid:ok,broken:bad} })(),
    chainOk:(()=>{ if(!cwr.length)return null;
      const by={}; for(const r of cwr) (by[r.artifactPath] ||= []).push(r);
      for(const rs of Object.values(by)){ let prev=null;
        for(const r of rs.sort((a,b)=>(a.sequence||0)-(b.sequence||0))){ if(r.previousIntegrityHash!==prev)return false; prev=r.integrityHash } }
      return true })(),
    nEnvelopes:penF?.count??0,
    envDigestKinds:penF?.keys?.filter(k=>/igest|Hash/i.test(k))||[],
    envelopes:(penF?.sample||[]).map(x=>({role:x.roleId,lane:x.lane,kind:x.dispatchKind,run:x.reviewRunId,
      dg:Object.fromEntries(Object.entries(x).filter(([k])=>/igest|Hash/i.test(k)).map(([k,v])=>[k,String(v).slice(0,14)]))})),
    nEvents:(i.events||[]).length,
    timeline:buildTimeline(i,pe,fs_),
    flow:buildFlow(i,pe,fs_),
    inFlight:!['DONE','DISCARDED'].includes(i.phase),
    wt:d.worktree||null,
    files:d.files||{},
  };
}

/* Per-transition detail for the expanded phase-flow diagram.

   The collapsed view aggregates ("4x back"), which answers how often but never
   why. This records each backward move individually: when it happened, how long
   the story had sat in the phase it left, and which findings were filed during
   that visit -- the findings being the usual reason a phase bounced. */
function backEdgeDetails(i,pe,fs_){
  const ORDER=["INIT","INIT_CHECK","PLAN","DEV","REVIEW","TEST","DONE"];
  const rank={}; ORDER.forEach((p,k)=>rank[p]=k);
  const evs=(i.events||[]).filter(e=>e.timestamp&&e.phase)
    .sort((a,b)=>a.timestamp<b.timestamp?-1:1);
  // findings.json keys are inconsistently story-qualified; compare on the bare id
  const bare=v=>{const t=String(v);const j=t.lastIndexOf(":");return j<0?t:t.slice(j+1)};
  const fmap={}; for(const f of (fs_||[])) fmap[bare(f.id)]=f;
  const out=[];
  for(let k=1;k<evs.length;k++){
    const from=evs[k-1].phase, to=evs[k].phase;
    if(!(from in rank)||!(to in rank)||rank[to]>=rank[from]) continue;
    const start=evs[k-1].timestamp, end=evs[k].timestamp;
    const ids=[];
    for(const r of (pe||[])){
      const t=r&&r.timestamp;
      if(!t||r.type!=="reviewer_finding"||t<start||t>=end) continue;
      if(r.findingId) ids.push(r.findingId);
      else if(Array.isArray(r.importedIds)) ids.push(...r.importedIds);
    }
    const sev={critical:0,high:0,medium:0,low:0};
    const named=[];
    for(const id of ids){
      const f=fmap[bare(id)]||{};
      if(sev[f.severity]!==undefined) sev[f.severity]++;
      named.push({id:bare(id),sev:f.severity,desc:f.desc||""});
    }
    // Anything else recorded in that window that explains the bounce.
    let note="";
    for(const r of (pe||[])){
      const t=r&&r.timestamp;
      if(!t||t<start||t>=end) continue;
      if(r.type==="dirty_gate_audit"&&r.classification) note=note||`dirty gate: ${r.classification}`;
      if(r.type==="validation_terminal"&&r.result&&r.result!=="pass")
        note=note||`validate ${r.result}`;
      if(r.type==="human_confirmation"&&(r.detail||r.command))
        note=note||`human: ${String(r.detail||r.command).slice(0,60)}`;
    }
    out.push({from,to,at:end,enteredAt:start,n:ids.length,sev,note,
      top:named.filter(f=>f.sev==="critical"||f.sev==="high").slice(0,3)});
  }
  return out;
}

function buildFlow(i,pe,fs_){
  const ORDER=["INIT","INIT_CHECK","PLAN","DEV","REVIEW","TEST","DONE"];
  const rank={}; ORDER.forEach((p,k)=>rank[p]=k);
  const evs=(i.events||[]).filter(e=>e.phase);
  const visits={},fwd={},back={};
  let prev=null;
  for(const e of evs){
    const p=e.phase;
    visits[p]=(visits[p]||0)+1;
    if(prev&&p!==prev){
      const key=prev+">"+p;
      if((rank[p]??99)>(rank[prev]??99)) fwd[key]=(fwd[key]||0)+1;
      else back[key]=(back[key]||0)+1;
    }
    prev=p;
  }
  const cur=i.phase;
  const reached=new Set(Object.keys(visits));
  const ps=(x)=>x; // phaseStats lookup happens at render
  return {order:ORDER,visits,fwd,back,cur,reached:[...reached],
          rework:Object.values(back).reduce((a,b)=>a+b,0),
          backs:backEdgeDetails(i,pe,fs_)};
}

function buildTimeline(i,pe,fs_){
  const fmap={}; for(const f of fs_) fmap[f.id]=f;
  const evs=(i.events||[]).filter(e=>e.timestamp).sort((a,b)=>a.timestamp<b.timestamp?-1:1);
  const segs=evs.map((e,k)=>({phase:e.phase,action:e.action,start:e.timestamp,
    end:k+1<evs.length?evs[k+1].timestamp:(i.endedAt||''),
    agent:e.agent,reason:e.reason||'',user:e.user,reviewer:e.reviewer,items:[]}));
  /* 每条 item 额外记录原始 ISO 时间戳 `ts`。

     排序原本用 `t`，而 `t` 是 fTime() 生成的 HH:MM:SS 时钟字符串 —— 等于把日期
     丢掉了。跨午夜时 "00:35:08" < "16:10:53"，于是本地时间 08-28 00:35 的事件
     被排到了 08-27 16:10 之前，看上去像时间倒退、也像"最新数据没显示"。
     显示仍用时钟字符串，排序一律用 ts。 */
  const put=(ts,rec)=>{ if(!ts||!segs.length)return;
    rec.ts=ts;
    let tgt=null;
    for(const sg of segs) if(sg.start&&ts>=sg.start&&(!sg.end||ts<sg.end)) tgt=sg;
    if(!tgt) tgt = ts>=segs[segs.length-1].start ? segs[segs.length-1] : segs[0];
    tgt.items.push(rec); };
  for(const e of pe){
    const t=e.type, ts=e.timestamp, hm=fTime(ts);
    if(t==='reviewer_finding'){
      const ag=(e.agent||'').replace('lattice-review-','');
      // A single event may import a batch of findings (importedIds); each one is a
      // real finding and is what explains a REVIEW -> DEV bounce.
      const ids=e.findingId ? [e.findingId]
        : (Array.isArray(e.importedIds) ? e.importedIds : []);
      for(const raw of ids){
        // importedIds are story-qualified ("B-137a:F-205") while findings.json
        // keys are bare ("F-205"). Match on the bare id or the row is empty.
        const fid=String(raw).includes(':')?String(raw).split(':').pop():String(raw);
        const f=fmap[fid]||fmap[raw]||{};
        put(ts,{k:'finding',t:hm,id:fid,sev:f.severity||e.severity,ag,
                st:f.status,cat:f.category,d:(f.desc||'')});
      }
      if(!ids.length) put(ts,{k:'revact',t:hm,ag,res:e.result});
    }
    else if(t==='review_pass') put(ts,{k:'pass',t:hm,id:e.reviewPassId,ag:(e.agent||'').replace('lattice-review-','')});
    else if(t==='dispatch') put(ts,{k:'dispatch',t:hm,ag:(e.agentType||'').replace('lattice-',''),kind:e.targetKind});
    else if(t==='subagent_result') put(ts,{k:'sub',t:hm,item:e.checklistId,ok:e.success});
    else if(t==='validation_terminal') put(ts,{k:'validate',t:hm,res:e.result,n:e.commandExecutions,disp:e.disposition});
    else if(t==='host_verdict') put(ts,{k:'verdict',t:hm,dec:e.decision,host:e.hostId,run:e.runId});
    else if(t==='plan_reviewed') put(ts,{k:'planrev',t:hm,iss:e.issueCount,blk:e.blockerCount});
    else if(t==='human_confirmation') put(ts,{k:'human',t:hm,d:String(e.detail||e.command||'')});
    else if(t==='dirty_gate_audit') put(ts,{k:'dirty',t:hm,d:String(e.classification||e.result||'')});
  }
  return segs.map(sg=>{
    const f=sg.items.filter(x=>x.k==='finding'), o=sg.items.filter(x=>x.k!=='finding');
    const n={}; for(const x of o) n[x.k]=(n[x.k]||0)+1;
    // findings are never capped — a truncated list hides why a phase bounced
    const keep=f.concat(o.filter(x=>['validate','planrev','human','sub','verdict','revact'].includes(x.k)))
      .sort((a,b)=>(a.ts||'')<(b.ts||'')?-1:1);   // ISO 时间戳，不是时钟字符串
    /* 跨日的行标记天数偏移。

       行只显示 HH:MM:SS，段头只显示段开始那天。一个段可以跨午夜（B-45a0 的
       DEV 段就从本地 08-27 11:44 一直开到 08-28），此时 00:35 这类时间看上去
       比同段里的 16:10 更早，读者会以为最新事件没显示。

       记录相对段首日的天数偏移 `dd`，由渲染层画成一个上标 +1 / +2。之前是在
       时间前面拼 "MM-DD "，但时间格宽度固定（56px），拼进去就换行成两行、
       时间列也不再对齐 —— 偏移量本身才是要传达的信息，日期是多余的。 */
    const segDay=fDay(sg.start||'');
    const dayIndex=v=>Math.floor(Date.parse(`${v}T00:00:00`)/864e5);
    for(const it of keep){
      const d=fDay(it.ts||'');
      if(!d||!segDay||d===segDay) continue;
      const off=dayIndex(d)-dayIndex(segDay);
      if(Number.isFinite(off)&&off>0) it.dd=off;
    }
    const rec={p:sg.phase,a:sg.action,s:sg.start||'',e0:sg.end||''};
    if(sg.end)rec.e=sg.end;
    if(sg.reason)rec.rs=sg.reason;
    if(sg.agent)rec.ag=sg.agent;
    if(Object.keys(n).length)rec.n=n;
    if(f.length)rec.nf=f.length;
    if(keep.length)rec.it=keep;
    return rec;
  });
}


(function(){
let ST=[], ED=[], CH={};                 // CH is now a lazily-filled cache
const API={
  graph : ()=>fetch('/api/graph').then(r=>r.json()),
  story : id=>fetch('/api/story?id='+encodeURIComponent(id)).then(r=>r.json()),
  search: q=>fetch('/api/search?q='+encodeURIComponent(q)).then(r=>r.json()),
};
// Every phase that can appear must have a colour, a label and a slot in ORDER —
// otherwise its stories are silently unfilterable and never rendered. DEV and REVIEW
// only started appearing once worktree state was read, which is how they were missed.
const PH={INIT:"--ph-init",INIT_CHECK:"--ph-check",PLAN:"--ph-plan",DEV:"--ph-dev",
          REVIEW:"--ph-review",TEST:"--ph-test",DONE:"--ph-done",DISCARDED:"--ph-disc",
          META:"--ph-meta"};   // one palette: see the --ph-* block in app.css
const PHL={INIT:"Init",INIT_CHECK:"Init check",PLAN:"Plan",DEV:"Dev",REVIEW:"Review",
           TEST:"Test",DONE:"Done",DISCARDED:"Discarded",META:"Meta"};
const ORDER=["INIT","INIT_CHECK","PLAN","DEV","REVIEW","TEST","DONE","DISCARDED","META"];
// Filter state lives here (above applyGraph) so the self-correcting phase adoption
// in applyGraph can enable newly seen phases without hitting a temporal dead zone.
const active=new Set(ORDER); let query=""; let hubOnly=false;
const cv=document.getElementById("cv"), tp=document.getElementById("tp");
let ctx=cv.getContext("2d");
function css(v){return getComputedStyle(document.documentElement).getPropertyValue(v).trim()||"#888"}
let GROUND="#f4f5f7";
function syncGround(){ GROUND=css("--bg")||"#f4f5f7" }
syncGround();
matchMedia("(prefers-color-scheme:dark)").addEventListener("change",()=>{
  syncGround(); draw(); repaintTheme();
});

/* ---- theme: OS by default, overridable, remembered ----

   Three states, not two: no attribute means follow the OS, and the two explicit
   values pin it. The toggle moves to whichever is opposite the CURRENT resolved
   theme, so it always does the visible thing rather than cycling through a
   third state the reader cannot see.

   Nothing here restyles anything directly -- the palette lives entirely in CSS
   custom properties. This only sets the attribute and then pokes the surfaces
   that cache colours instead of reading them live: the 2D canvas, and Mermaid,
   which bakes its theme in at initialize() time. */
const THEME_KEY="pg.theme";
function resolvedTheme(){
  const t=document.documentElement.dataset.theme;
  if(t==="dark"||t==="light") return t;
  return matchMedia("(prefers-color-scheme:dark)").matches?"dark":"light";
}
function repaintTheme(){
  syncGround();
  draw();
  /* Mermaid captures theme colours when it initialises, so a live diagram keeps
     the old palette until it is re-rendered from source. Drop the cached
     instance and repaint the open tab. */
  MERMAID=null; playbackMermaidReset();
  if(curStory) paint();
}
function playbackMermaidReset(){
  try{ if(window.resetPlaybackMermaid) window.resetPlaybackMermaid() }catch{}
}
function applyTheme(mode){
  const root=document.documentElement;
  if(mode==="dark"||mode==="light") root.dataset.theme=mode;
  else delete root.dataset.theme;
  const meta=document.querySelector('meta[name="theme-color"]');
  if(meta) meta.setAttribute("content",css("--bg")||"#0b0e14");
  repaintTheme();
}
(function initTheme(){
  let stored=null;
  try{ stored=localStorage.getItem(THEME_KEY) }catch{}
  if(stored==="dark"||stored==="light") document.documentElement.dataset.theme=stored;
  syncGround();
  const btn=document.getElementById("themeBtn");
  if(!btn) return;
  const label=()=>{
    const next=resolvedTheme()==="dark"?"light":"dark";
    btn.setAttribute("aria-label",`Switch to ${next} theme`);
    btn.title=`Switch to ${next} theme`;
  };
  label();
  btn.addEventListener("click",()=>{
    const next=resolvedTheme()==="dark"?"light":"dark";
    try{ localStorage.setItem(THEME_KEY,next) }catch{}
    applyTheme(next);
    label();
  });
  // Following the OS: keep the button's promise honest when the OS flips.
  matchMedia("(prefers-color-scheme:dark)").addEventListener("change",label);
})();

let byId={}, N=0, maxD=1, outE={}, inE={}, P=null, IX={};
function applyGraph(g){
  ST=g.stories; ED=g.edges;
  for(const s of ST){
    const p=s.phase;
    if(!p) continue;
    if(!ORDER.includes(p)) ORDER.push(p);
    if(!PH[p]) PH[p]="--ink3";
    if(!PHL[p]) PHL[p]=p;
    active.add(p);                       // never leave a phase unselectable
  }
  byId=Object.fromEntries(ST.map(s=>[s.id,s]));
  N=ST.length;
  maxD=Math.max(1,...ST.map(s=>s.depth||0));
ST.forEach(s=>{
  const d=s.depth||0;
  s.r = 4.2 + 15.5*Math.sqrt(d/maxD);      // area-ish scaling by dependents
});

/* adjacency */
  outE={};inE={};
ST.forEach(s=>{outE[s.id]=[];inE[s.id]=[]});
ED.forEach(e=>{ if(outE[e.s]&&inE[e.t]){outE[e.s].push(e.t); inE[e.t].push(e.s);} });

/* ---------- 3D force layout (precomputed once) ---------- */
  P=new Float64Array(N*3), V=new Float64Array(N*3);IX={};
ST.forEach((s,i)=>{
  IX[s.id]=i;
  // fibonacci sphere seed: even initial spread, no clumping
  const t=(i+0.5)/N, phi=Math.acos(1-2*t), th=Math.PI*(1+Math.sqrt(5))*i;
  const rr=120+300*Math.cbrt(t);
  P[i*3]  =Math.cos(th)*Math.sin(phi)*rr;
  P[i*3+1]=Math.sin(th)*Math.sin(phi)*rr;
  P[i*3+2]=Math.cos(phi)*rr;
});
const EL=ED.map(e=>[IX[e.s],IX[e.t]]).filter(p=>p[0]!=null&&p[1]!=null);
(function solve(){
  const CELL=130;
  for(let it=0;it<300;it++){
    for(let i=0;i<N*3;i++)V[i]*=0.84;
    // spatial-hash repulsion in 3D
    const bins=new Map();
    for(let i=0;i<N;i++){
      const k=Math.floor(P[i*3]/CELL)+","+Math.floor(P[i*3+1]/CELL)+","+Math.floor(P[i*3+2]/CELL);
      if(!bins.has(k))bins.set(k,[]); bins.get(k).push(i);
    }
    for(let i=0;i<N;i++){
      const gx=Math.floor(P[i*3]/CELL),gy=Math.floor(P[i*3+1]/CELL),gz=Math.floor(P[i*3+2]/CELL);
      for(let ox=-1;ox<=1;ox++)for(let oy=-1;oy<=1;oy++)for(let oz=-1;oz<=1;oz++){
        const b=bins.get((gx+ox)+","+(gy+oy)+","+(gz+oz)); if(!b)continue;
        for(const j of b){
          if(j<=i)continue;
          let dx=P[i*3]-P[j*3],dy=P[i*3+1]-P[j*3+1],dz=P[i*3+2]-P[j*3+2];
          let d2=dx*dx+dy*dy+dz*dz; if(d2>CELL*CELL*4)continue;
          if(d2<1)d2=1;
          const f=(1500+ST[i].r*ST[j].r*26)/d2, d=Math.sqrt(d2);
          dx/=d;dy/=d;dz/=d;
          V[i*3]+=dx*f; V[i*3+1]+=dy*f; V[i*3+2]+=dz*f;
          V[j*3]-=dx*f; V[j*3+1]-=dy*f; V[j*3+2]-=dz*f;
        }
      }
    }
    for(const [a,b] of EL){
      let dx=P[b*3]-P[a*3],dy=P[b*3+1]-P[a*3+1],dz=P[b*3+2]-P[a*3+2];
      const d=Math.hypot(dx,dy,dz)||1, rest=95+ST[a].r+ST[b].r;
      const f=(d-rest)*0.013;
      dx/=d;dy/=d;dz/=d;
      V[a*3]+=dx*f*d*.5; V[a*3+1]+=dy*f*d*.5; V[a*3+2]+=dz*f*d*.5;
      V[b*3]-=dx*f*d*.5; V[b*3+1]-=dy*f*d*.5; V[b*3+2]-=dz*f*d*.5;
    }
    // hubs sink to the core
    for(let i=0;i<N;i++){
      const g=0.0020+0.011*(ST[i].depth||0)/maxD;
      V[i*3]-=P[i*3]*g; V[i*3+1]-=P[i*3+1]*g; V[i*3+2]-=P[i*3+2]*g;
    }
    const cap=13;
    for(let i=0;i<N*3;i++){let v=V[i]; if(v>cap)v=cap; if(v<-cap)v=-cap; P[i]+=v}
  }
  // center on bounding box, normalize
  let lo=[1e9,1e9,1e9], hi=[-1e9,-1e9,-1e9];
  for(let i=0;i<N;i++)for(let c=0;c<3;c++){
    const v=P[i*3+c]; if(v<lo[c])lo[c]=v; if(v>hi[c])hi[c]=v;
  }
  const mid=[0,1,2].map(c=>(lo[c]+hi[c])/2);
  const half=Math.max(...[0,1,2].map(c=>(hi[c]-lo[c])/2),1);
  const k=430/half;
  for(let i=0;i<N;i++)for(let c=0;c<3;c++)P[i*3+c]=(P[i*3+c]-mid[c])*k;
})();
ST.forEach((s,i)=>{s.x=P[i*3]; s.y=P[i*3+1]; s.z=P[i*3+2]});


  document.getElementById("mN").textContent=ST.length;
  document.getElementById("mE").textContent=ED.length;
  buildFilters();
  draw();
}
/* ---------- view ---------- */
let cam={ry:0.5,rx:-0.20,dist:780,px:0,py:0}, spin=false, drag=null, hover=null, sel=null;
// (declared earlier, above applyGraph)
function vis(s){
  if(hubOnly&&(s.depth||0)<3)return false;
  if(!active.has(s.phase))return false;
  // search never empties the canvas: matches are highlighted via hlSet, others stay visible
  return true;
}
function fit(){
  const d=Math.min(devicePixelRatio||1,2);
  cv.width=innerWidth*d; cv.height=innerHeight*d;
  cv.style.width=innerWidth+"px"; cv.style.height=innerHeight+"px";
  ctx=cv.getContext("2d"); ctx.setTransform(d,0,0,d,0,0);
}
const FOV=780;
function T(s){
  const cy=Math.cos(cam.ry), sy=Math.sin(cam.ry), cx=Math.cos(cam.rx), sx=Math.sin(cam.rx);
  // rotate Y then X
  let x=s.x*cy - s.z*sy;
  let z=s.x*sy + s.z*cy;
  let y=s.y*cx - z*sx;
  z    =s.y*sx + z*cx;
  const zc=z+cam.dist;
  const k=FOV/Math.max(60,zc);
  return {x:innerWidth/2+x*k+cam.px, y:innerHeight/2+y*k+cam.py, k, zc};
}

/* neighbourhood of selection/hover for focus+context */
function nbr(id){
  if(!id)return null;
  const s=new Set([id]);
  (outE[id]||[]).forEach(x=>s.add(x));
  (inE[id]||[]).forEach(x=>s.add(x));
  return s;
}

function arrow(a,b,ra,rb,col,alpha,w){
  const dx=b.x-a.x, dy=b.y-a.y, len=Math.hypot(dx,dy)||1;
  const ux=dx/len, uy=dy/len;
  const x1=a.x+ux*ra, y1=a.y+uy*ra;
  const x2=b.x-ux*(rb+6.5), y2=b.y-uy*(rb+6.5);
  ctx.globalAlpha=alpha; ctx.strokeStyle=col; ctx.lineWidth=w;
  ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
  // arrowhead at the target (direction: source -> target)
  const hl=Math.min(8,4+w*2.2), ha=0.44;
  ctx.beginPath();
  ctx.moveTo(x2+ux*hl,y2+uy*hl);
  ctx.lineTo(x2-uy*hl*ha, y2+ux*hl*ha);
  ctx.lineTo(x2+uy*hl*ha, y2-ux*hl*ha);
  ctx.closePath(); ctx.fillStyle=col; ctx.fill();
}

let GLVIEW=null;   // set at boot when the D3/SVG engine is in use

function draw(){
  if(GLVIEW){
    // Same inputs the 2D path computes below, handed to the WebGL engine.
    const vis2=new Set(ST.filter(vis).map(x=>x.id));
    GLVIEW.render({focus:nbr(sel)||(hlSet&&hlSet.size?hlSet:null),
                   sel, visibleIds:vis2});
    return;
  }
  fit();
  ctx.clearRect(0,0,innerWidth,innerHeight);
  // Only a CLICK (sel) or an active search dims the field. Hover never does —
  // recolouring 367 nodes on every mousemove read as flicker.
  const focusId=sel;
  const focus=nbr(sel)||(hlSet&&hlSet.size?hlSet:null);
  const hoverSet=hover?nbr(hover.id):null;
  // project once
  const PR=new Map();
  for(const s of ST){ if(vis(s)) PR.set(s.id,T(s)); }
  // ---- edges, far first ----
  const el=[];
  for(const e of ED){
    const A=byId[e.s],B=byId[e.t];
    if(!A||!B)continue;
    const a=PR.get(e.s), b=PR.get(e.t);
    if(!a||!b)continue;
    el.push({e,A,B,a,b,zc:(a.zc+b.zc)/2});
  }
  el.sort((m,n)=>n.zc-m.zc);
  for(const o of el){
    const {e,A,B,a,b}=o;
    const selOn=focus&&focus.has(e.s)&&focus.has(e.t)&&(e.s===focusId||e.t===focusId);
    const hovOn=hover&&(e.s===hover.id||e.t===hover.id);
    const dep=e.k==="dep";
    const t=Math.min(.72,Math.max(0,(o.zc-460)/1500));
    let ec;
    if(selOn||hovOn) ec=css("--acc");
    else if(focus) ec=mix(css("--ink3"),GROUND,.88);           // only a click dims the field
    else ec=mix(css("--ink3"),GROUND,(dep?.42:.62)+t*.30);
    arrow(a,b,A.r*a.k,B.r*b.k,ec,1,
      (selOn||hovOn)?2.2:(dep?1.4:1.0)*Math.max(.6,a.k));
  }
  // ---- nodes, far first ----
  const nl=[];
  for(const s of ST){ const p=PR.get(s.id); if(p) nl.push({s,p}); }
  nl.sort((m,n)=>n.p.zc-m.p.zc);
  const drawn=[];
  for(const {s,p} of nl){
    const r=Math.max(1.8,s.r*p.k);
    const on=!focus||focus.has(s.id);
    const near=hoverSet?hoverSet.has(s.id):false;
    // depth cue: blend toward the page ground. NO transparency anywhere.
    const t=Math.min(.62,Math.max(0,(p.zc-460)/1500));           // 0 near .. .62 far
    let col=mix(css(PH[s.phase]||"--disc"),GROUND,t);
    if(!on) col=mix(col,GROUND,.72);                             // click-selection context only
    else if(near) col=mix(col,css(PH[s.phase]||"--disc"),0.55);   // hover: saturate, never wash out
    ctx.globalAlpha=1;
    // contact shadow, opaque blend
    if(r>3.4){
      ctx.beginPath(); ctx.arc(p.x,p.y+r*.26,r*1.0,0,6.283);
      ctx.fillStyle=mix(GROUND,"#000000",on?.13:.05); ctx.fill();
    }
    const g=ctx.createRadialGradient(p.x-r*.36,p.y-r*.42,r*.12,p.x,p.y,r);
    g.addColorStop(0,mix(col,"#ffffff",on?.46:.20));
    g.addColorStop(.60,col);
    g.addColorStop(1,mix(col,"#000000",on?.28:.12));
    ctx.beginPath(); ctx.arc(p.x,p.y,r,0,6.283); ctx.fillStyle=g; ctx.fill();
    if(on&&r>5){
      ctx.beginPath(); ctx.ellipse(p.x-r*.30,p.y-r*.38,r*.27,r*.17,-0.5,0,6.283);
      ctx.fillStyle=mix(col,"#ffffff",.72); ctx.fill();
    }
    if(s.id===sel){ctx.lineWidth=2.4;ctx.strokeStyle=css("--ink");ctx.stroke()}
    else if(s.id===hover){ctx.lineWidth=1.8;ctx.strokeStyle=css("--ink2");ctx.stroke()}
    if(on)drawn.push({s,p,r,t});
  }
  // ---- labels: nearest & biggest win, collision-avoided ----
  ctx.globalAlpha=1;
  ctx.font="500 10px 'IBM Plex Mono',monospace";
  ctx.textAlign="center";
  const boxes=[];
  drawn.sort((a,b)=>(b.r-a.r)||(a.p.zc-b.p.zc));
  for(const d of drawn){
    const isF=d.s.id===focusId||(hover&&d.s.id===hover.id);
    if(!isF){
      const nb=hoverSet&&hoverSet.has(d.s.id);
      if(!nb){
        if(d.r<7)continue;
        if((d.s.depth||0)<4)continue;
      }
    }
    const w=ctx.measureText(d.s.id).width+6,h=12;
    const bx=d.p.x-w/2, by=d.p.y-d.r-4-h;
    let hit=false;
    for(const b of boxes){ if(bx<b.x+b.w&&bx+w>b.x&&by<b.y+b.h&&by+h>b.y){hit=true;break} }
    if(hit&&!isF)continue;
    boxes.push({x:bx,y:by,w,h});
    ctx.globalAlpha=1;
    ctx.fillStyle=isF?css("--ink"):mix(css("--ink2"),GROUND,Math.min(.5,d.t));
    ctx.fillText(d.s.id,d.p.x,d.p.y-d.r-5);
  }
  ctx.textAlign="left"; ctx.globalAlpha=1;
}
function mix(a,b,t){
  const p=c=>{c=c.trim();
    if(c[0]==="#"){const v=c.slice(1);const n=v.length===3?v.split("").map(x=>x+x).join(""):v;
      return [parseInt(n.slice(0,2),16),parseInt(n.slice(2,4),16),parseInt(n.slice(4,6),16)]}
    const m=c.match(/rgba?\(([^)]+)\)/); if(m){const q=m[1].split(",").map(Number);return [q[0],q[1],q[2]]}
    return [128,128,128]};
  const A=p(a),B=p(b);
  return `rgb(${Math.round(A[0]+(B[0]-A[0])*t)},${Math.round(A[1]+(B[1]-A[1])*t)},${Math.round(A[2]+(B[2]-A[2])*t)})`;
}

/* ---------- picking ---------- */
function pick(mx,my){
  let best=null,bz=1e9;
  for(const s of ST){
    if(!vis(s))continue;
    const p=T(s), r=Math.max(6,s.r*p.k+3);
    if((p.x-mx)**2+(p.y-my)**2 < r*r){
      if(p.zc<bz){bz=p.zc;best=s}   // nearest to camera wins
    }
  }
  return best;
}
cv.addEventListener("mousemove",e=>{
  if(drag){
    if(drag.shift){ cam.px+=e.clientX-drag.x; cam.py+=e.clientY-drag.y; }
    else{
      cam.ry+=(e.clientX-drag.x)*0.006;
      cam.rx=Math.max(-1.35,Math.min(1.35,cam.rx-(e.clientY-drag.y)*0.005));
    }
    drag={x:e.clientX,y:e.clientY,shift:drag.shift}; draw(); return;
  }
  const s=pick(e.clientX,e.clientY);
  if(s!==hover){hover=s;draw()}
  if(s){
    tp.style.setProperty("--ph",`var(${PH[s.phase]||"--disc"})`);
    tp.innerHTML=`<div class="i">${s.id}</div><div class="t">${esc(s.title||"")}</div>`+
      `<div class="m">${s.phase} · ${s.depth||0} dependents · ${s.indeg||0} direct · ${s.nEv||0} evidence · ${s.nFind||0} findings${(!s.indeg&&!s.outdeg)?" · isolated":""}</div>`;
    tp.classList.add("on");
    const w=tp.offsetWidth,h=tp.offsetHeight;
    tp.style.left=Math.min(e.clientX+14,innerWidth-w-10)+"px";
    tp.style.top=Math.max(8,e.clientY-h-12)+"px";
    cv.style.cursor="pointer";
  } else {tp.classList.remove("on"); cv.style.cursor=drag?"grabbing":"grab"}
});
cv.addEventListener("mousedown",e=>{const s=pick(e.clientX,e.clientY); if(!s){drag={x:e.clientX,y:e.clientY,shift:e.shiftKey};spin=false;cv.classList.add("drag")}});
addEventListener("mouseup",()=>{drag=null;cv.classList.remove("drag")});
cv.addEventListener("mouseleave",()=>{hover=null;tp.classList.remove("on");draw()});
cv.addEventListener("click",e=>{const s=pick(e.clientX,e.clientY); if(s)open(s.id)});
cv.addEventListener("wheel",e=>{
  e.preventDefault(); spin=false;
  cam.dist=Math.max(220,Math.min(3600,cam.dist*(e.deltaY<0?0.9:1.111)));
  draw();
},{passive:false});
addEventListener("resize",draw);
function esc(t){
  if(t===null||t===undefined) return "";
  if(typeof t==="object"){
    // render small records readably rather than "[object Object]"
    if(Array.isArray(t)) return t.map(esc).filter(Boolean).join(" · ");
    const parts=[];
    for(const [k,v] of Object.entries(t)){
      if(v===null||v===undefined||v==="")continue;
      if(typeof v==="object")continue;              // one level only
      parts.push(`${k}: ${v}`);
    }
    return esc(parts.join(" · "));
  }
  return String(t).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
}
function md(t){
  const lines=esc(t).split("\n"); let o=[],inCode=false;
  for(const L of lines){
    if(/^```/.test(L)){ o.push(inCode?"</pre>":'<pre class="tail">'); inCode=!inCode; continue }
    if(inCode){ o.push(L); continue }
    if(/^#{1,4}\s/.test(L)) o.push(`<p class="mdh">${L.replace(/^#{1,4}\s/,"")}</p>`);
    else if(/^\s*[-*]\s/.test(L)) o.push(`<div class="mdli">${L.replace(/^\s*[-*]\s/,"")}</div>`);
    else if(/^\s*\d+\.\s/.test(L)) o.push(`<div class="mdli">${L}</div>`);
    else if(!L.trim()) o.push("");
    else o.push(`<p class="mdp">${L}</p>`);
  }
  if(inCode)o.push("</pre>");
  return o.join("");
}

/* ================= rich tabbed drawer ================= */
let curTab="chain", curStory=null, fFilter="all";
/* Signature of the graph read that produced the current `byId`. Part of the
   detail-cache key so a projection built from an older read is never reused. */
let lastContentHash="";

async function open(id,keepTab){
  const s=byId[id]; if(!s)return;
  /* Cache key.

     `contentHash` is included because the other four fields are graph-node
     summaries that can be identical across two different states of the same
     story, and because a stale row can be reused: the search results panel now
     keeps its rendered rows when the reader clicks away and back, so a click can
     arrive carrying a `byId` entry from an earlier poll. Matching on the summary
     alone then served a projection built from that older read, which showed as
     tabs greyed out for artifacts that do exist on disk. */
  const _sig=s?`${lastContentHash}|${s.phase}|${s.nEv}|${s.nFind}|${s.nDone}`:"";
  if(!CH[id] || !CH[id].raw || CH[id]._sig!==_sig){
    const tag=document.getElementById("liveTag");
    // One retry: a dropped fetch used to leave an empty stub behind, which the
    // views then rendered as "No lifecycle events recorded" -- an assertion about
    // the DATA, for what was actually a transport failure.
    let d=null, err=null;
    for(let attempt=0;attempt<2 && !d;attempt++){
      try{ d=await API.story(id) }
      catch(e){ err=e; if(attempt===0) await new Promise(r=>setTimeout(r,250)) }
    }
    if(d){
      CH[id]=projectDetail(d,s);
      Object.assign(s,extractStoryFields(d,s));   // full fields, straight from disk
      CH[id]._sig=`${lastContentHash}|${s.phase}|${s.nEv}|${s.nFind}|${s.nDone}`;
    }else{
      // Preserve any previously loaded detail; only mark it stale. Never downgrade
      // a load failure into an empty-looking success.
      const prev=CH[id];
      CH[id]=prev&&prev.raw ? {...prev,err:String(err&&err.message||err),stale:true}
        : {items:[],findings:[],findingsTotal:0,raw:null,err:String(err&&err.message||err),loadFailed:true};
      if(tag){tag.textContent="detail failed";tag.className="livetag err"}
    }
  }
  sel=id; curStory=s;
  dr.style.setProperty("--ph",`var(${PH[s.phase]||"--disc"})`);
  document.getElementById("dId").textContent=s.id;
  document.getElementById("dT").textContent=s.title||"(untitled)";
  const C=CH[id]||{items:[],findings:[]};
  // beside the story id, where the header has room; hidden if the detail
  // fetch failed (the dossier needs the raw files)
  document.getElementById("dossierSlot").innerHTML=C.raw
    ?`<button class="chip dossier" id="dossierBtn"
       title="Open this story's dossier page (/story/${esc(s.id)}) — finding map, lifecycle loop, dispatch swarm, wire log">open dossier<span class="arr">↗</span></button>`
    :"";
  document.getElementById("dC").innerHTML=
    `<span class="chip ph">${s.phase}</span>`+
    (s.inFlight?`<span class="chip live">in flight</span>`:"")+
    (s.wt?`<span class="chip wt" title="Live state read from this linked worktree, not the main checkout">${esc(s.wt)}</span>`:"")+
    (s.type?`<span class="chip">${s.type}</span>`:"")+
    (s.pri?`<span class="chip">${s.pri}</span>`:"")+
    (s.verdict?`<span class="chip">${s.verdict}</span>`:"")+
    (s.created?`<span class="chip">${esc(fDay(s.created))}</span>`:"")+
    (s.wall?`<span class="chip">${ms(s.wall)} wall</span>`:"")+
    (s.totalMs?`<span class="chip">${ms(s.totalMs)} in phases</span>`:"")+
    (s.hardening?`<span class="chip">${s.hardening}</span>`:"")+
    `<div class="tabs" id="tabs" role="tablist">
      ${s.inFlight?tab("live","● Live",null,true):""}
      ${tab("origin","Origin",null,hasOrigin(s))}
      ${tab("plan","Plan",null,hasPlan(s))}
      ${tab("scope","Scope",null,hasScope(s))}
      ${tab("chain","Evidence",(C.items||[]).length,(C.items||[]).length>0)}
      ${tab("find","Findings",(C.findingsTotal||(C.findings||[]).length),((C.findings||[]).length)>0)}
      ${tab("gate","Gates",null,hasGate(s))}
      ${tab("prov","Provenance",null,hasProv(s))}
      ${tab("rel","Timeline",(s.indeg||0)+(s.outdeg||0),true)}
      ${tab("files","Files",Object.keys((C.raw&&C.raw.files)||{}).length,true)}
      <span class="tabbar" id="tabBar"></span>
    </div>`;
  document.getElementById("dossierBtn")?.addEventListener("click",()=>{
    if(!window.openStoryDossier){
      alert("The dossier page did not load. Run npm run build and reload.");
      return;
    }
    openDossierFor(s.id,true);   // pushes /story/<id> so the page has a real URL
  });
  // don't open onto an empty tab
  const avail={live:!!s.inFlight,chain:(C.items||[]).length>0,find:(C.findings||[]).length>0,
               gate:hasGate(s),origin:hasOrigin(s),plan:hasPlan(s),scope:hasScope(s),
               prov:hasProv(s),rel:true,files:true};
  const pref=s.inFlight?["live","chain","plan","origin","scope","find","gate","prov","rel"]
                       :["chain","find","plan","origin","scope","gate","prov","rel"];
  // A refresh (keepTab) preserves whatever the reader was looking at.
  // A fresh open puts in-flight stories on Live; finished ones never land there.
  if(keepTab && avail[keepTab]) curTab=keepTab;
  else if(keepTab) curTab=pref.find(k=>avail[k])||"rel";
  else if(s.inFlight) curTab="live";
  else if(curTab==="live"||!avail[curTab]) curTab=pref.find(k=>avail[k])||"rel";
  paint();
  dr.classList.add("on"); document.body.classList.add("open");
  /* Repaint the GRAPH, not just the drawer.

     `paint()` above renders the detail panel; the canvas/SVG renderer only
     learns that `sel` changed when draw() runs. close() called draw() but
     open() did not, so selecting a story never highlighted its node while
     deselecting correctly cleared the highlight -- an asymmetry that made the
     selection ring look broken when it was simply never asked to appear. */
  draw();
  focusCam(s);
}
const TABTIP={"live": "What this story is doing right now \u2014 owner, heartbeat, blockers", "origin": "Where it came from \u2014 the original request, background, intent check", "plan": "What was planned \u2014 task, decision, milestones, plan.md", "scope": "What it was allowed to touch \u2014 scope and execution boundaries", "chain": "How it was proved \u2014 checklist \u2192 intent \u2192 evidence receipts", "find": "What reviewers found \u2014 full finding text and resolutions", "gate": "What the gates checked at DONE \u2014 receipts, promises, self-check", "prov": "Signed provenance \u2014 identity separation and hash chains", "rel": "Position in the web, elapsed time, and the lifecycle timeline", "files": "Every artifact on disk, verbatim"};
function tab(k,l,n,has){
  const empty=has===false;
  const tip=(TABTIP[k]||"")+(empty?" · no data recorded":"");
  // The label sits in a grid cell that also holds an invisible bold copy of the
  // same text, so switching the active tab to 600 weight cannot widen the box
  // and shove every following tab sideways.
  return `<button data-tab="${k}" role="tab" aria-selected="${curTab===k}" title="${esc(tip)}"${empty?' class="empty"':""}>`+
    `<span class="tablabel" data-label="${esc(l)}"><span>${l}</span></span>`+
    `${n!=null?`<span class="ct">${n}</span>`:""}</button>`;
}
function hasGate(s){return !!(s.gate||Object.keys(s.selfCheck||{}).length||(s.promises||[]).length||(s.red||[]).length||s.outcomeDiff||s.limits||s.pitfalls)}
function hasOrigin(s){return !!(s.origIntent||s.bg||s.collision||(s.selfQ&&(s.selfQ.q||s.selfQ.a))||(s.initIssues||[]).length||(s.spikes||[]).length)}
function hasPlan(s){return !!(s.desc||s.task||s.outcome||(s.claims||[]).length||(s.miles||[]).length||(s.facts||[]).length||(s.principles||[]).length||s.plan||s.planRev||s.metrics)}
function hasScope(s){return !!(s.scope||s.exec||s.freeze||s.shrink||(s.discards||[]).length||s.specSet||s.basis||s.preRev||s.critic||s.guard||s.stall)}
function hasProv(s){return !!(s.prov||s.nWriteReceipts||s.nEnvelopes||s.basisProv||s.preRevProv||(s.epochs||[]).length||(s.certReceipts||[]).length||s.psHashes||s.reqHash)}
function positionTabBar(){
  requestAnimationFrame(()=>{
    const strip=document.getElementById("tabs");
    const bar=document.getElementById("tabBar");
    const act=strip?.querySelector('button[aria-selected="true"]');
    if(!strip||!bar||!act)return;
    const s=strip.getBoundingClientRect(), a=act.getBoundingClientRect();
    bar.style.left=(a.left-s.left)+"px";
    bar.style.width=a.width+"px";
  });
}
function paint(){
  const s=curStory; if(!s)return;
  [...document.querySelectorAll("#tabs button")].forEach(b=>b.setAttribute("aria-selected",String(b.dataset.tab===curTab)));
  const C=CH[s.id]||{items:[],findings:[]};
  positionTabBar();
  const B=document.getElementById("dB");
  const capHtml=TABTIP[curTab]?`<p class="tabcap">${esc(TABTIP[curTab])}</p>`:"";
  if(curTab==="live") B.innerHTML=capHtml+vLive(s,C);
  else if(curTab==="chain") B.innerHTML=capHtml+vChain(s,C);
  else if(curTab==="find") B.innerHTML=capHtml+vFind(s,C);
  else if(curTab==="gate") B.innerHTML=capHtml+vGate(s);
  else if(curTab==="origin") B.innerHTML=capHtml+vOrigin(s);
  else if(curTab==="plan") B.innerHTML=capHtml+vPlan(s);
  else if(curTab==="scope") B.innerHTML=capHtml+vScope(s);
  else if(curTab==="prov") B.innerHTML=capHtml+vProv(s);
  else if(curTab==="files") B.innerHTML=capHtml+vFiles(s,C);
  else B.innerHTML=capHtml+vRel(s);
  B.scrollTop=0;
  if(curTab==="find"){
    const fb=B.querySelector(".fbar");
    if(fb)fb.addEventListener("click",e=>{
      const b=e.target.closest("button"); if(!b)return;
      fFilter=b.dataset.f; paint();
    });
  }
  B.querySelectorAll("[data-go]").forEach(b=>b.addEventListener("click",()=>{open(b.dataset.go)}));
  // cross-tab anchor: lifecycle finding -> Findings tab
  B.querySelectorAll("[data-file]").forEach(el=>el.addEventListener("click",()=>showFile(curStory,CH[curStory.id]||{},el.dataset.file)));
  B.querySelectorAll("[data-fid]").forEach(el=>{
    const go=()=>jumpToFinding(el.dataset.fid);
    el.addEventListener("click",go);
    el.addEventListener("keydown",ev=>{if(ev.key==="Enter"||ev.key===" "){ev.preventDefault();go()}});
    // dwell to preview: read the full finding without leaving the timeline
    let timer=null;
    el.addEventListener("mouseenter",()=>{ timer=setTimeout(()=>showFindingPeek(el),450) });
    el.addEventListener("mouseleave",()=>{ if(timer)clearTimeout(timer); hideFindingPeek() });
    el.addEventListener("focus",()=>showFindingPeek(el));
    el.addEventListener("blur",hideFindingPeek);
  });
  // expand/collapse a clamped finding description in place. Separate control from
  // the row itself, whose click jumps to the Findings tab.
  B.querySelectorAll(".tlf .tlfd").forEach(el=>{
    // The clamped description is the expand target; the row around it keeps its
    // jump-to-Findings click. Only rows with hidden overflow are toggleable.
    if(!el.parentElement.querySelector(".tlfmore")) return;
    el.title="Click to expand";
    el.addEventListener("click",ev=>{
      ev.stopPropagation();
      el.closest(".tlf").classList.toggle("open");
    });
  });
  // anchor: finding card -> its lifecycle position
  B.querySelectorAll("[data-tlexport]").forEach(el=>el.addEventListener("click",ev=>{
    ev.stopPropagation();
    const st=flowStory||(curStory&&CH[curStory.id]?null:null);
    if(st) downloadText(timelineExport(st,el.dataset.tlexport));
  }));
  /* Playback: hand the viewer the SAME JSON the Export JSON button produces.

     Feeding it the export rather than the in-memory projection means the
     animation and the downloadable file can never drift apart -- and the viewer
     validates that JSON on the way in, so a broken timeline reports what is
     wrong instead of animating something misleading. */
  B.querySelectorAll("[data-tlplay]").forEach(el=>el.addEventListener("click",ev=>{
    ev.stopPropagation();
    const st=flowStory||curStory;
    if(!st) return;
    if(!window.openPlaybackModal){
      alert("The playback viewer did not load. Run npm run build and reload.");
      return;
    }
    window.openPlaybackModal(st,timelineExport(st,"json").body);
  }));
  B.querySelectorAll("[data-flowzoom]").forEach(el=>el.addEventListener("click",
    ()=>openFlowModal(flowStory)));
  B.querySelectorAll("[data-reload]").forEach(el=>el.addEventListener("click",()=>{
    if(curStory){ delete CH[curStory.id]; open(curStory.id,true) }
  }));
  B.querySelectorAll("[data-tlback]").forEach(el=>{
    el.addEventListener("click",()=>jumpToLifecycle(el.dataset.tlback));
  });
}

/* ---- TAB 1: evidence chain, full text ---- */
function vChain(s,C){
  const cov=s.cov;
  let h=sec("Coverage",`<div class="mt">
      ${mt((s.nDone||0)+"/"+(s.nItems||0),"items done",(s.nItems&&s.nDone===s.nItems)?"g":"")}
      ${mt(s.nInt||0,"intents")}
      ${mt(s.nEv||0,"evidence","g")}
      ${mt(s.mech||0,"receipts","b")}
    </div>`+(cov&&cov.t!=null?`<dl class="kv" style="margin-top:8px">
      <dt>required intents</dt><dd>${cov.r??"—"}</dd>
      <dt>covered</dt><dd>${cov.c??"—"}</dd>
      <dt>missing required</dt><dd>${cov.m===0?"0":`<span style="color:var(--fail)">${cov.m}</span>`}</dd>
      ${s.valCmd?`<dt>validated by</dt><dd style="word-break:break-all">${esc(s.valCmd)}</dd>`:""}
      ${s.valResult?`<dt>result</dt><dd style="color:var(--pass)">${esc(s.valResult)}</dd>`:""}
    </dl>`:""));
  if(C.err) return h+`<span class="emp">Could not load this story's files: ${esc(C.err)}</span>`;
  if(!(C.items||[]).length) return h+`<span class="emp">No checklist recorded.</span>`;
  h+=`<div class="sec"><p class="st">Chain — checklist &rarr; intent &rarr; evidence</p>`;
  C.items.forEach((it,i)=>{
    h+=`<details class="chk"${i===0?" open":""}>
      <summary><span class="cid">${it.id}</span><span class="ctitle">${esc(it.title||"")}</span>
        <span class="cst ${it.status==="done"?"done":""}">${it.status||"—"}</span></summary>
      <div class="body">`;
    if(it.userSees) h+=`<div class="us"><b>User sees</b>${esc(it.userSees)}</div>`;
    (it.lanes||[]).forEach(L=>{
      h+=`<div class="lane ${L.lane}"><div class="lh"><i></i>${L.lane} &middot; ${L.items.length}</div>`;
      L.items.forEach(I=>{
        h+=`<div class="int"><div class="idesc">${esc(I.desc||"")}</div>
          <div class="imeta">${I.type?`<span>type <b>${I.type}</b></span>`:""}
            ${I.pri?`<span>priority <b>${I.pri}</b></span>`:""}
            <span>${I.id}</span></div>`;
        if(I.pin&&I.pin.c) h+=`<div class="cmd">${esc(I.pin.c)}</div>`+
          (I.pin.s?`<div class="fpath">selector: ${esc(I.pin.s)}</div>`:"");
        if(!(I.ev||[]).length) h+=`<div class="noev">No evidence bound to this intent.</div>`;
        (I.ev||[]).forEach(E=>{h+=evBlock(E)});
        h+=`</div>`;
      });
      h+=`</div>`;
    });
    if((it.loose||[]).length){
      h+=`<div class="lane"><div class="lh"><i></i>unbound evidence &middot; ${it.loose.length}</div>`;
      it.loose.forEach(E=>{h+=evBlock(E)}); h+=`</div>`;
    }
    if((it.docs||[]).length) h+=`<div class="fpath" style="margin-top:9px">docs: ${it.docs.map(esc).join(" · ")}</div>`;
    h+=`</div></details>`;
  });
  return h+`</div>`;
}
function evBlock(E){
  const r=E.rc;
  return `<div class="ev">
    <div class="eh">
      <span class="kind">${esc(E.kind||"?")}</span>
      ${E.result?`<span class="res ${E.result}">${E.result}</span>`:""}
      ${E.mech?`<span class="mech">mechanical receipt</span>`:`<span class="att">attestation</span>`}
      ${E.wv?`<span class="att">waiver: ${esc(E.wv)}</span>`:""}
    </div>
    ${E.cmd?`<div class="cmd">${esc(E.cmd)}</div>`:""}
    ${E.file?`<div class="fpath">${esc(E.file)}</div>`:""}
    ${E.note?`<div class="enote">${esc(E.note)}</div>`:""}
    ${E.nmr?`<div class="enote" style="color:var(--ink3)"><em>non-mechanical: ${esc(E.nmr)}</em></div>`:""}
    ${r?`<div class="rcpt">
       <span>exit <b class="${r.x===0?"ok":"no"}">${r.x??"—"}</b></span>
       <span>selector <b class="${r.sel?"ok":"no"}">${r.sel?"matched":"absent"}</b></span>
       ${r.dig?`<span>digest <b>${esc(r.dig)}…</b></span>`:""}
     </div>`:""}
    ${E.tail?`<pre class="tail">${esc(E.tail)}</pre>`:""}
  </div>`;
}

/* ---- TAB 2: findings, full text ---- */
function vFind(s,C){
  const F=C.findings||[];
  if(C.err) return `<span class="emp">Could not load this story's files: ${esc(C.err)}</span>`;
  if(!F.length) return `<span class="emp">No findings recorded for this story.</span>`;
  const sev=s.sev||{}, fst=s.fstat||{};
  let h=sec("Review outcome",`<div class="mt">
      ${mt(C.findingsTotal||F.length,"findings",(C.findingsTotal||F.length)?"r":"")}
      ${mt(fst.resolved||0,"resolved","g")}
      ${mt(fst.open||0,"still open",fst.open?"r":"")}
      ${mt(s.nRuns||0,"review runs")}
    </div>`+
    `<div class="sv">
      ${sev.critical?`<b class="c">${sev.critical} critical</b>`:""}
      ${sev.high?`<b class="h">${sev.high} high</b>`:""}
      ${sev.medium?`<b class="m">${sev.medium} medium</b>`:""}
      ${sev.low?`<b class="l">${sev.low} low</b>`:""}
    </div>`+
    (s.lanes&&s.lanes.length?`<p style="margin-top:8px;font-size:11.5px;color:var(--ink2)">Reviewer lanes: <span class="mono">${s.lanes.join(", ")}</span></p>`:""));
  if((s.clusters||[]).length){
    h+=sec("Clusters",s.clusters.map(c=>
      `<details class="gate collapsible">
         <summary><b class="mono">${esc(c.id)||"cluster"}</b>
           <span class="mono cmeta">${c.n||0} findings${c.sev?" · "+esc(c.sev):""}</span>
           <span class="clip">${esc(c.rc||"")}</span></summary>
         <div class="cbody">
           ${c.rc?`<div class="enote">${esc(c.rc)}</div>`:""}
           ${(c.f||[]).length?`<div class="gm">${c.f.map(esc).join(" · ")}</div>`:""}
         </div>
       </details>`).join(""));
  }
  const counts={all:F.length,open:F.filter(f=>f.status==="open").length,
    critical:F.filter(f=>f.sev==="critical").length,high:F.filter(f=>f.sev==="high").length};
  const capped=(C.findingsTotal||F.length)-F.length;
  h+=`<div class="sec"><p class="st">All findings</p>
    ${capped>0?`<p class="note2">Showing full text for ${F.length} of ${C.findingsTotal} findings; the counts above are exact.</p>`:""}
    <div class="fbar">
      ${["all","open","critical","high"].map(k=>
        `<button data-f="${k}" aria-pressed="${fFilter===k}">${k}${counts[k]!=null?` (${counts[k]})`:""}</button>`).join("")}
    </div>`;
  const show=F.filter(f=>fFilter==="all"||(fFilter==="open"?f.status==="open":f.sev===fFilter));
  if(!show.length) h+=`<span class="emp">None matching.</span>`;
  show.forEach(f=>{
    h+=`<details class="fnd collapsible ${f.sev||"low"}" id="fnd-${esc(f.id||"")}" data-fcard="${esc(f.id||"")}">
      <summary>
        <span class="fid mono">${esc(f.id||"")}</span>
        <span class="fsev">${esc(f.sev||"")}</span>
        <span class="fst ${f.status==="open"?"open":""}">${esc(f.status||"")}</span>
        <span class="clip">${esc(f.desc||"")}</span>
      </summary>
      <div class="cbody">
      <div class="fh">
        <span class="fid">${esc(f.id||"")}</span>
        <span class="fsev">${f.sev||""}</span>
        <span class="fst ${f.status==="open"?"open":""}">${f.status||""}</span>
        ${f.cat?`<span class="fst">${f.cat}</span>`:""}
        ${f.agent?`<span class="fag">${esc(f.agent)}</span>`:""}
        <button class="tllink" data-tlback="${esc(f.id||"")}" title="Show where this was raised in the lifecycle">in lifecycle ↗</button>
      </div>
      <div class="fdesc">${esc(f.desc||"")}</div>
      ${(f.files||[]).length?`<div class="ffiles">${f.files.map(esc).join(" · ")}</div>`:""}
      ${f.res?`<div class="fres"><b>Resolution${f.rtype?` · ${esc(f.rtype)}`:""}</b>${esc(f.res)}</div>`:""}
      </div>
    </details>`;
  });
  return h+`</div>`;
}

/* ---- TAB 3: gates & closeout ---- */
function vGate(s){
  let h="";
  const g=s.gate;
  if(g) h+=sec("DONE-required gate",
    `<dl class="kv"><dt>status</dt><dd style="color:${g.status==="PASS"?"var(--pass)":"var(--fail)"}">${g.status||"—"}</dd>
     ${g.ms?`<dt>duration</dt><dd>${(g.ms/1000).toFixed(1)}s</dd>`:""}</dl>`+
    (g.r||[]).map(r=>`<div class="gate" style="margin-top:6px">
      <div class="gh"><span>${esc(r.l)}</span><span class="mono" style="color:${r.st==="PASS"?"var(--pass)":"var(--fail)"}">${r.st||""}</span></div>
      <div class="gm"><span>exit <b>${r.x??"—"}</b></span>${r.ms?`<span>${(r.ms/1000).toFixed(1)}s</span>`:""}${r.dig?`<span>spec ${esc(r.dig)}…</span>`:""}</div>
    </div>`).join(""));
  const sc=s.selfCheck||{};
  if(Object.keys(sc).length) h+=sec("Closing self-check",
    `<dl class="kv">
      <dt>real-machine test</dt><dd>${sc.hasRealMachineTest?"yes":"no"}</dd>
      <dt>edge-case coverage</dt><dd>${sc.hasEdgeCaseCoverage?"yes":"no"}</dd>
      <dt>unresolved TODOs</dt><dd>${sc.hasUnresolvedTodos?"yes":"no"}</dd>
     </dl>${sc.summary?`<p style="margin-top:7px">${esc(sc.summary)}</p>`:""}`);
  if((s.promises||[]).length) h+=sec("Doc promises verified",
    s.promises.map(p=>`<div class="gate"><div class="gh"><span class="mono" style="font-size:10.5px">${esc(p.d)}</span></div>
      <div style="font-size:11.5px;color:var(--ink2);margin-top:4px">${esc(p.p)}</div>
      <div class="gm">${p.v?`<span>verified by <b>${esc(p.v)}</b></span>`:`<span style="color:var(--warn)">unverified</span>`}${p.w?`<span>waiver: ${esc(p.w)}</span>`:""}</div>
    </div>`).join(""));
  if((s.red||[]).length) h+=sec("Red evidence (failing-first)",
    s.red.map(r=>`<div class="gate"><div style="font-size:11.5px;color:var(--ink2)">${esc(r.t)}</div>
      ${r.f?`<div class="enote">${esc(r.f)}</div>`:""}${r.c?`<div class="cmd">${esc(r.c)}</div>`:""}</div>`).join(""));
  if(s.outcomeDiff) h+=sec("Outcome diff",`<p>${esc(s.outcomeDiff)}</p>`);
  if(s.limits) h+=sec("Known limitations",`<p>${esc(s.limits)}</p>`);
  if(s.pitfalls) h+=sec("Pitfalls hit",`<p>${esc(s.pitfalls)}</p>`);
  return h||`<span class="emp">No gate artifacts recorded.</span>`;
}

/* ---- TAB 4: plan / intent ---- */
function vPlan(s){
  let h="";
  if(s.desc) h+=sec("Description",`<p>${esc(s.desc)}</p>`);
  if(s.task) h+=sec("Task",`<p>${esc(s.task)}</p>`);
  if(s.outcome) h+=sec("Expected outcome",`<p>${esc(s.outcome)}</p>`);
  if((s.claims||[]).length) h+=sec("Acceptance claims",`<ul class="l">${s.claims.map(c=>`<li class="c">${esc(c)}</li>`).join("")}</ul>`);
  if((s.miles||[]).length) h+=sec("Milestones",`<ul class="l">${s.miles.map(m=>`<li><span class="mono">${esc(m.id||"")}</span>${m.d?" — "+esc(m.d):""}${m.st?` <span style="color:var(--ink3)">(${m.st})</span>`:""}</li>`).join("")}</ul>`);
  if((s.facts||[]).length) h+=sec("Known facts",`<ul class="l">${s.facts.map(x=>`<li>${esc(x)}</li>`).join("")}</ul>`);
  if((s.constraints||[]).length) h+=sec("Constraints",`<ul class="l">${s.constraints.map(x=>`<li>${esc(x)}</li>`).join("")}</ul>`);
  if((s.unknowns||[]).length) h+=sec("Unknowns at plan time",`<ul class="l">${s.unknowns.map(x=>`<li>${esc(x)}</li>`).join("")}</ul>`);
  if((s.principles||[]).length) h+=sec("Decision principles",`<ul class="l">${s.principles.map(x=>`<li>${esc(x)}</li>`).join("")}</ul>`);
  if((s.options||[]).length) h+=sec("Options weighed",s.options.map(o=>
    `<div class="gate"><div class="gh"><b>${esc(o.n||"")}</b>${s.chosen===o.n?`<span class="mono" style="color:var(--pass)">chosen</span>`:""}</div>
     ${(o.p||[]).length?`<div class="gm" style="color:var(--pass)">+ ${o.p.map(esc).join(" · ")}</div>`:""}
     ${(o.c||[]).length?`<div class="gm" style="color:var(--warn)">− ${o.c.map(esc).join(" · ")}</div>`:""}</div>`).join(""));
  if(s.rationale) h+=sec("Rationale",`<p>${esc(s.rationale)}</p>`);
  if((s.preMortem||[]).length) h+=sec("Pre-mortem",s.preMortem.map(p=>
    `<div class="gate"><div style="font-size:11.5px;color:var(--ink2)">${esc(p.s)}</div>${p.m?`<div class="gm">mitigation: ${esc(p.m)}</div>`:""}</div>`).join(""));
  if((s.openQ||[]).length) h+=sec("Open questions",s.openQ.map(q=>
    `<div class="gate"><div style="font-size:11.5px">${esc(q.q)}</div>${q.r?`<div class="fres"><b>Resolved</b>${esc(q.r)}</div>`:`<div class="gm" style="color:var(--warn)">unresolved</div>`}</div>`).join(""));
  if((s.initIssues||[]).length) h+=sec("INIT review issues",`<ul class="l">${s.initIssues.map(x=>`<li><span class="mono" style="color:var(--warn)">${x.s}</span> ${esc(x.d)}</li>`).join("")}</ul>`);
  if((s.bugs||[]).length) h+=sec("Bugs",s.bugs.map(b=>
    `<div class="gate"><div class="gh"><b class="mono">${esc(b.id||"")}</b><span class="mono" style="font-size:9.5px">${b.st||""}</span></div>
     <div style="font-size:11.5px;color:var(--ink2);margin-top:3px">${esc(b.t||"")}</div>
     ${b.ev?`<pre class="tail">${esc(b.ev)}</pre>`:""}</div>`).join(""));
  if(s.changes) h+=sec("Changes",`<p>${esc(s.changes)}</p>`);
  if((s.tp||[]).length) h+=sec("Touchpoints",`<ul class="l">${s.tp.map(t=>`<li class="pth">${esc(t)}</li>`).join("")}</ul>`);
  if((s.slices||[]).length) h+=sec("Slice plan",s.slices.map(x=>`<div class="gate"><div class="gh"><b class="mono">${esc(x.id||"")}</b></div><div class="gm">${(x.m||[]).map(esc).join(" · ")}</div>${x.r?`<div class="enote">${esc(x.r)}</div>`:""}</div>`).join(""));
  if((s.children||[]).length) h+=sec("Child stories",`<div class="rel">${s.children.map(c=>`<button data-go="${c.id}">${c.id} <span class="dir">${esc(c.st||"")}</span></button>`).join("")}</div>`);
  if(s.closeout) h+=sec("Milestone closeout ("+esc(s.closeout.phase||"")+")",
    `<div class="tl">${(s.closeout.rows||[]).map(r=>`<div class="r"><span class="t">${esc(r.m||"")}</span><span class="p">${esc(r.st||"")}${r.n?` — ${esc(r.n)}`:""}</span></div>`).join("")}</div>`);
  if(s.planRev) h+=sec(`PLAN review (round ${s.planRev.n})`,
    `<dl class="kv"><dt>issues</dt><dd>${s.planRev.iss??"—"}</dd><dt>blockers</dt><dd>${s.planRev.blk??"—"}</dd></dl>`+
    ((s.planRev.items||[]).length?`<ul class="l" style="margin-top:7px">${s.planRev.items.map(x=>`<li><span class="mono" style="color:var(--ink3)">${esc(x.s||"")}</span> <b>${esc(x.i||"")}</b> ${esc(x.m||"")}</li>`).join("")}</ul>`:""));
  if(s.metrics) h+=sec("Process metrics",
    (s.metrics.dims&&Object.keys(s.metrics.dims).length?`<dl class="kv">${Object.entries(s.metrics.dims).map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(String(v))}</dd>`).join("")}</dl>`:"")+
    ((s.metrics.gaps||[]).length?`<ul class="l" style="margin-top:7px">${s.metrics.gaps.map(x=>`<li>${esc(x)}</li>`).join("")}</ul>`:""));
  if(s.plan) h+=sec("plan.md",`<div class="mdblk">${md(s.plan)}</div>`);
  return h||`<span class="emp">No plan artifacts recorded.</span>`;
}

/* ---- TAB: Live — only for in-flight stories ---- */
function vLive(s,C){
  const L=s.live, IS=s.itemStatus||{};
  const tot=Object.values(IS).reduce((a,b)=>a+b,0);
  const done=IS.done||0;
  const age=L&&L.beat?(Date.now()-new Date(L.beat).getTime()):null;
  const stale=age!=null&&age>1000*60*30;
  const since=s.created?ms(Date.now()-new Date(s.created).getTime()):"—";
  let h=sec("Right now",
    `<div class="livebar"><span class="livedot ${L?(stale?"stale":"hot"):"idle"}"></span>
       <b>${esc(s.phase)}</b> &middot; ${since} since created
       ${L?`&middot; heartbeat ${age!=null?ms(age)+" ago":"—"}${stale?" — stale":""}`:"&middot; no owner lease"}
     </div>
     <p class="note2">Times shown in your local zone (<code>${esc(TZ)}</code>); stored on disk as UTC.</p>\n     ${s.wt?`<p class="note2">State read from <code>${esc(s.wt)}</code> — from PLAN onward a story's live artifacts live in its worktree, and the main checkout keeps only the INIT_CHECK snapshot.</p>`:""}
     <div class="mt" style="margin-top:9px">
       ${mt(`${done}/${tot||"—"}`,"checklist done",done&&done===tot?"g":"")}
       ${mt(s.nEv||0,"evidence recorded",s.nEv?"g":"")}
       ${mt(s.nFind||0,"findings open",s.nFind?"r":"")}
       ${mt(s.nPE||0,"process events")}
     </div>`+
    (Object.keys(IS).length?`<div class="segn" style="margin-top:8px">${Object.entries(IS).map(([k,v])=>`<span>${v} ${esc(k)}</span>`).join("")}</div>`:""));

  h+=sec("Blocking the next transition",(()=>{
    const B=[];
    if(!tot) B.push("No checklist items yet — PLAN has not produced a checklist.");
    else if(done<tot) B.push(`${tot-done} of ${tot} checklist items still open.`);
    if(!s.nEv) B.push("No verificationEvidence recorded yet.");
    if(s.fstat&&s.fstat.open) B.push(`${s.fstat.open} finding(s) still open.`);
    if(stale) B.push(`Owner lease heartbeat is ${ms(age)} old — the session that held this story is probably gone.`);
    if(!L) B.push("No owner lease: nothing is actively working this story.");
    if(s.breaker&&s.breaker.frozen) B.push("Convergence breaker is FROZEN.");
    return B.length?`<ul class="l">${B.map(x=>`<li>${esc(x)}</li>`).join("")}</ul>`
                   :`<span class="emp">Nothing obviously blocking — check the lifecycle below.</span>`;
  })());

  if(L) h+=sec("Owner lease",
    `<dl class="kv">
       <dt>session</dt><dd>${esc(L.sess||"")}</dd>
       <dt>host</dt><dd>${esc(L.host||"")}${L.pid?` · pid ${L.pid}`:""}</dd>
       <dt>last command</dt><dd>${esc(L.cmd||"")}${L.cmdTarget?` <span style="color:var(--ink3)">&rarr; ${esc(L.cmdTarget)}</span>`:""}</dd>
       <dt>acquired</dt><dd>${esc(fSec(L.acq))}</dd>
       <dt>heartbeat</dt><dd>${esc(fSec(L.beat))}</dd>
       ${L.src?`<dt>source</dt><dd>${esc(L.src)}</dd>`:""}
       ${L.cwd?`<dt>cwd</dt><dd class="pth">${esc(L.cwd)}</dd>`:""}
     </dl>`+
    (s.takeovers?`<p class="note2">Ownership taken over ${s.takeovers}×.</p>`:""));

  // checklist progress, item by item — what an operator actually wants
  if((C.items||[]).length) h+=sec("Checklist progress",
    `<div class="tl">${C.items.map(it=>`<div class="r">
       <span class="t mono" style="color:${it.status==="done"?"var(--pass)":"var(--ink3)"}">${esc(it.status||"pending")}</span>
       <span class="p"><b>${esc(it.id)}</b> ${esc(it.title||"")}</span>
     </div>`).join("")}</div>`);

  h+=sec("Wall clock",
    `<div class="mt">
       ${mt(since,"elapsed so far","b")}
       ${mt(fDay(s.created)||"—","created")}
       ${mt(s.phase,"current phase")}
     </div>
     <p class="note2">Per-phase timing lands in <code>summary.json</code> at DONE; an in-flight story has none yet.</p>`);
  return h;
}

/* ---- TAB: Origin — the verbatim request, background, intent collision ---- */
function vOrigin(s){
  let h="";
  const oi=s.origIntent;
  if(oi){
    if(oi.src) h+=sec("Original request (verbatim)",`<pre class="tail" style="max-height:260px">${esc(oi.src)}</pre>`);
    if(oi.norm) h+=sec("Normalized outcome",`<p>${esc(oi.norm)}</p>`);
    if(oi.claim) h+=sec("Acceptance claim",`<p>${esc(oi.claim)}</p>`);
    if((oi.reqs||[]).length) h+=sec("Key requirement ids",`<div class="rel">${oi.reqs.map(r=>`<span class="chip">${esc(r)}</span>`).join("")}</div>`);
  }
  if(s.bg) h+=sec("Background",`<div class="mdblk">${md(s.bg)}</div>`);
  const c=s.collision;
  if(c) h+=sec("Intent collision check",
    `<dl class="kv"><dt>id</dt><dd>${esc(c.id||"")}</dd><dt>decision</dt><dd>${esc(c.dec||"")}</dd><dt>status</dt><dd>${esc(c.st||"")}</dd></dl>`+
    (c.acc?`<p style="margin-top:7px">${esc(c.acc)}</p>`:"")+
    (c.notes?`<div class="enote">${esc(c.notes)}</div>`:""));
  if(s.selfQ&&(s.selfQ.q||s.selfQ.a)) h+=sec("INIT self-check",
    (s.selfQ.q?`<p style="color:var(--ink3)">${esc(s.selfQ.q)}</p>`:"")+(s.selfQ.a?`<p style="margin-top:5px">${esc(s.selfQ.a)}</p>`:""));
  if((s.initIssues||[]).length) h+=sec("INIT reviewer issues",`<ul class="l">${s.initIssues.map(x=>`<li><span class="mono" style="color:var(--warn)">${x.s}</span> ${esc(x.d)}</li>`).join("")}</ul>`);
  if((s.spikes||[]).length) h+=sec("Spikes",s.spikes.map(x=>`<div class="gate"><div style="font-size:11.5px">${esc(x.q)}</div>${x.f?`<div class="gm">${esc(x.f)}</div>`:""}</div>`).join(""));
  return h||`<span class="emp">No origin artifacts recorded.</span>`;
}

/* ---- TAB: Scope — boundaries, freeze, provenance receipts ---- */
function vScope(s){
  let h="";
  const sc=s.scope;
  if(sc){
    h+=sec("Scope contract",`<dl class="kv"><dt>mode</dt><dd>${esc(sc.mode||"—")}</dd></dl>`+
      (sc.reason?`<div class="enote">${esc(sc.reason)}</div>`:"")+
      (sc.note?`<div class="enote">${esc(sc.note)}</div>`:"")+
      ((sc.mod||[]).length?`<p class="st" style="margin-top:9px">Allowed modify</p><ul class="l">${sc.mod.map(x=>`<li class="pth">${esc(x)}</li>`).join("")}</ul>`:"")+
      ((sc.cre||[]).length?`<p class="st" style="margin-top:9px">Allowed create</p><ul class="l">${sc.cre.map(x=>`<li class="pth">${esc(x)}</li>`).join("")}</ul>`:"")+
      ((sc.tst||[]).length?`<p class="st" style="margin-top:9px">Allowed test</p><ul class="l">${sc.tst.map(x=>`<li class="pth">${esc(x)}</li>`).join("")}</ul>`:"")+
      ((sc.prot||[]).length?`<p class="st" style="margin-top:9px">Protected</p><ul class="l">${sc.prot.map(x=>`<li class="pth">${esc(x)}</li>`).join("")}</ul>`:"")+
      ((sc.exc||[]).length?`<p class="st" style="margin-top:9px">Excluded</p><ul class="l">${sc.exc.map(x=>`<li class="pth">${esc(x)}</li>`).join("")}</ul>`:""));
  }
  const ex=s.exec;
  if(ex) h+=sec("Execution boundary",
    ((ex.cmds||[]).length?`<p class="st">Allowed commands</p><ul class="l">${ex.cmds.map(x=>`<li class="pth">${esc(x)}</li>`).join("")}</ul>`:"")+
    ((ex.tools||[]).length?`<p class="st" style="margin-top:8px">Allowed tools</p><div class="rel">${ex.tools.map(x=>`<span class="chip">${esc(x)}</span>`).join("")}</div>`:"")+
    ((ex.xcmds||[]).length?`<p class="st" style="margin-top:8px">Excluded commands</p><ul class="l">${ex.xcmds.map(x=>`<li class="pth">${esc(x)}</li>`).join("")}</ul>`:"")+
    (ex.note?`<div class="enote">${esc(ex.note)}</div>`:""));
  const fz=s.freeze;
  if(fz) h+=sec("Scope freeze check",
    `<dl class="kv"><dt>status</dt><dd style="color:${fz.st==="pass"?"var(--pass)":"var(--warn)"}">${esc(fz.st||"—")}</dd><dt>mode</dt><dd>${esc(fz.mode||"—")}</dd></dl>`+
    ((fz.kw||[]).length?`<div class="gm" style="margin-top:6px">${fz.kw.map(esc).join(" · ")}</div>`:"")+
    ((fz.iss||[]).length?`<ul class="l" style="margin-top:6px">${fz.iss.map(x=>`<li>${esc(x)}</li>`).join("")}</ul>`:""));
  if(s.shrink) h+=sec("Scope shrinkage",`<dl class="kv"><dt>decision</dt><dd>${esc(s.shrink.d||"")}</dd><dt>user confirmed</dt><dd>${s.shrink.ok?"yes":"no"}</dd></dl>${s.shrink.r?`<div class="enote">${esc(s.shrink.r)}</div>`:""}`);
  if((s.discards||[]).length) h+=sec("Discarded scope",`<ul class="l">${s.discards.map(x=>`<li>${esc(x)}</li>`).join("")}</ul>`);
  if(s.specSet) h+=sec("Candidate spec routing",
    `<dl class="kv"><dt>mode</dt><dd>${esc(s.specSet.mode||"")}</dd><dt>candidates</dt><dd>${s.specSet.n}</dd><dt>escalation</dt><dd>${s.specSet.esc?"required":"no"}</dd></dl>`+
    ((s.specSet.cands||[]).length?`<ul class="l" style="margin-top:6px">${s.specSet.cands.map(x=>`<li class="pth">${esc(x)}</li>`).join("")}</ul>`:"")+
    ((s.specSet.reasons||[]).length?`<div class="gm">${s.specSet.reasons.map(esc).join(" · ")}</div>`:""));
  if(s.basis) h+=sec("Acceptance basis",
    `<dl class="kv"><dt>status</dt><dd>${esc(s.basis.st||"")}</dd></dl>`+
    ((s.basis.methods||[]).length?`<div class="gm">${s.basis.methods.map(esc).join(" · ")}</div>`:"")+
    ((s.basis.blind||[]).length?`<p class="st" style="margin-top:7px">Blind spots</p><ul class="l">${s.basis.blind.map(x=>`<li>${esc(x)}</li>`).join("")}</ul>`:""));
  if(s.preRev) h+=sec("Pre-review check",`<dl class="kv"><dt>status</dt><dd>${esc(s.preRev.st||"")}</dd></dl>${(s.preRev.codes||[]).length?`<div class="gm">${s.preRev.codes.map(esc).join(" · ")}</div>`:""}`);
  if(s.critic) h+=sec("Topology critic",`<dl class="kv"><dt>verdict</dt><dd>${esc(s.critic.v||"")}</dd><dt>role</dt><dd>${esc(s.critic.role||"")}</dd></dl>`);
  if(s.guard) h+=sec("Guard session",`<dl class="kv"><dt>provider</dt><dd>${esc(s.guard.p||"")}</dd><dt>mode</dt><dd>${esc(s.guard.m||"")}</dd><dt>status</dt><dd>${esc(s.guard.st||"")}</dd><dt>violations</dt><dd>${s.guard.v}</dd></dl>`);
  if(s.stall) h+=sec("Stall adjudication",`<dl class="kv"><dt>action</dt><dd>${esc(s.stall.a||"")}</dd><dt>approved by</dt><dd>${esc(s.stall.by||"")}</dd></dl>${s.stall.r?`<div class="enote">${esc(s.stall.r)}</div>`:""}`);
  if((s.certWin||[]).length) h+=sec("Certification windows",s.certWin.map(w=>`<div class="gate"><div class="gh"><b class="mono">${esc(w.id||"")}</b><span class="mono" style="font-size:9.5px">${esc(w.st||"")}</span></div>${w.b?`<div class="gm">${esc(w.b)}</div>`:""}</div>`).join(""));
  if(s.nWriteReceipts) h+=sec(`Closeout write receipts (${s.nWriteReceipts})`,
    `<div class="tl">${(s.writeReceipts||[]).map(r=>`<div class="r"><span class="t">#${r.seq??""}</span><span class="p"><b>${esc(r.a||"")}</b> ${esc(r.c||"")}${r.ph?` · ${esc(r.ph)}`:""}</span></div>`).join("")}</div>`);
  if(s.nEnvelopes) h+=sec(`Prompt envelopes (${s.nEnvelopes})`,
    `<div class="tl">${(s.envelopes||[]).map(e=>`<div class="r"><span class="t">${esc(e.kind||"")}</span><span class="p"><b>${esc(e.role||"")}</b>${e.lane?` · ${esc(e.lane)}`:""}${e.run?` · ${esc(e.run)}`:""}</span></div>`).join("")}</div>`);
  if(s.devMem) h+=sec("Dev-memory preflight",`<div class="gm">${(s.devMem.top||[]).map(esc).join(" · ")}</div>`);
  if((s.gateFails||[]).length) h+=sec(`Gate rejections (${s.gateFails.length})`,
    s.gateFails.map(g=>`<div class="gate">
       <div class="gh"><b class="mono">${esc(g.cmd)}</b>
         <span class="mono" style="font-size:9.5px">${g.count!=null?`${g.count}\u00d7 rejected`:""}${g.at?` · ${esc(fSec(g.at))}`:""}</span></div>
       ${g.reason?`<div class="enote" style="white-space:pre-wrap">${esc(g.reason)}</div>`:""}
     </div>`).join(""));
  return h||`<span class="emp">No scope artifacts recorded.</span>`;
}

/* ---- phase flow as a real Mermaid diagram ---- */
let MERMAID=null, mermaidSeq=0;
async function ensureMermaid(){
  if(MERMAID) return MERMAID;
  if(!window.mermaid){
    await new Promise((res,rej)=>{
      const sc=document.createElement("script");
      sc.src="/vendor/mermaid.min.js"; sc.onload=res; sc.onerror=()=>rej(new Error("mermaid unavailable"));
      document.head.appendChild(sc);
    });
  }
  /* Ask the same resolver the rest of the page uses.

     This read `prefers-color-scheme` AND-ed with "not explicitly light", so an
     explicit data-theme="dark" on a light-OS machine still came out false and
     the diagram rendered with light fills inside a dark drawer. */
  const dark=resolvedTheme()==="dark";
  /* fontSize lifts mermaid's default 16px "base" scale, which rendered the box
     labels and edge captions at roughly 10px -- unreadable next to the 13px body
     text beside them. Spacing grows with it so the wider boxes do not collide. */
  window.mermaid.initialize({startOnLoad:false,securityLevel:"strict",
    theme:dark?"dark":"neutral", fontSize:22,
    themeVariables:{fontSize:"22px"},
    flowchart:{curve:"basis",nodeSpacing:42,rankSpacing:56}});
  MERMAID=window.mermaid;
  return MERMAID;
}
function flowSpec(s,detailed){
  const F=s.flow, PS=s.phaseStats||{};
  const shown=F.order.filter(p=>F.visits[p]||PS[p]||p===F.cur||p==="DONE");
  const idOf=p=>p.replace(/[^A-Za-z0-9]/g,"");
  const L=[];
  L.push("flowchart LR");
  for(const p of shown){
    const seen=!!(F.visits[p]||PS[p]);
    const n=F.visits[p]||0;
    const dur=PS[p]?ms(PS[p].durationMs):"";
    const lines=[p];
    if(seen) lines.push(`${dur?dur+" · ":""}${n}x entered`);
    else lines.push("not reached");
    if(p===F.cur) lines.push("CURRENT PHASE");
    L.push(`  ${idOf(p)}["${lines.join("<br/>")}"]`);
  }
  // forward edges along the shown order
  for(let k=0;k+1<shown.length;k++){
    const a=shown[k], b=shown[k+1];
    const f=F.fwd[a+">"+b]||0;
    L.push(f?`  ${idOf(a)} -->|"${f}x forward"| ${idOf(b)}`
            :`  ${idOf(a)} -.-> ${idOf(b)}`);
  }
  if(detailed && (F.backs||[]).length){
    /* One arrow per actual bounce, labelled with what happened.

       The collapsed form ("4x back") says how often but never why, which is the
       question a reader of a rework-heavy story actually has. Each edge here
       carries its timestamp, how long the story sat in the phase it left, the
       severity spread of findings filed during that visit, and the ids of the
       worst few. */
    const esc2=t=>String(t).replace(/"/g,"&quot;").replace(/[\[\]{}|]/g,"");
    F.backs.forEach((b,k)=>{
      if(!shown.includes(b.from)||!shown.includes(b.to))return;
      /* Keep labels short.

         Full finding prose made each label a paragraph, so the boxes grew taller
         than the gap between phases and drifted away from the arrow they belong
         to. Three compact lines: when + how long, the severity tally, and just
         the ids of the worst findings -- the detail is one click away in the
         Findings tab. */
      const parts=[];
      parts.push(`#${k+1} · ${fDay(b.at).slice(5)} ${fTime(b.at).slice(0,5)} · held ${dur(b.enteredAt,b.at)||"—"}`);
      const sv=["critical","high","medium","low"]
        .filter(x=>b.sev[x]).map(x=>`${b.sev[x]}${x[0].toUpperCase()}`).join(" ");
      if(b.n) parts.push(`${b.n} finding${b.n===1?"":"s"}${sv?" · "+sv:""}`);
      const ids=(b.top||[]).map(f=>f.id).join(" ");
      if(ids) parts.push(ids);
      L.push(`  ${idOf(b.from)} -. "${parts.map(esc2).join("<br/>")}" .-> ${idOf(b.to)}`);
    });
  } else {
    // every backward edge actually recorded, aggregated
    for(const [key,n] of Object.entries(F.back)){
      const [a,b]=key.split(">");
      if(!shown.includes(a)||!shown.includes(b))continue;
      L.push(`  ${idOf(a)} -. "${n}x back" .-> ${idOf(b)}`);
    }
  }
  /* Colour each box by its phase, from the SAME palette the graph nodes and
     filter dots use (the --ph-* vars, read through css()). One palette across
     the whole tool: a REVIEW box, a REVIEW node and the REVIEW filter dot are
     all the same orange.

     Visited phases get a coloured border and matching text on the neutral
     ground. The current phase inverts -- its colour becomes the fill -- which is
     the strongest signal available and needs no separate accent. Text there is
     forced to a light or dark tone chosen by the fill's luminance, so it can
     never come out the same colour as the background it sits on. */
  const PHVAR={INIT:"--ph-init",INIT_CHECK:"--ph-check",PLAN:"--ph-plan",DEV:"--ph-dev",
               REVIEW:"--ph-review",TEST:"--ph-test",DONE:"--ph-done",
               DISCARDED:"--ph-disc",META:"--ph-meta"};
  const lum=hex=>{
    const h=(hex||"").replace("#","");
    if(h.length<6) return 0.5;
    const [r,g,b]=[0,2,4].map(i=>parseInt(h.slice(i,i+2),16)/255);
    const f=c=>c<=0.03928?c/12.92:((c+0.055)/1.055)**2.4;
    return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b);
  };
  shown.forEach(p=>{
    const seen=!!(F.visits[p]||PS[p]);
    const col=css(PHVAR[p]||"--ph-disc")||"#8b939e";
    if(p===F.cur){
      // Contrast picked from the fill, so the label is never lost in it.
      const ink=lum(col)>0.42?"#101418":"#ffffff";
      L.push(`  style ${idOf(p)} fill:${col},stroke:${col},stroke-width:3px,color:${ink},font-weight:bold`);
    } else if(!seen)
      L.push(`  style ${idOf(p)} stroke:${col},color:${col},stroke-dasharray:4 3,opacity:0.45`);
    else
      L.push(`  style ${idOf(p)} stroke:${col},color:${col},stroke-width:1.6px`);
  });
  return L.join("\n");
}
/* Detailed phase-flow is opt-in and remembered.

   On a rework-heavy story it draws one arrow per bounce -- B-137a has 85 -- so
   it is far too dense to be the default, but it is the only view that answers
   "why did it go back". Kept in localStorage so the choice survives navigating
   between stories, wrapped because storage throws in some embeddings. */
/* Full-window viewer for the detailed phase flow, with its own zoom and pan.
   Wheel zooms toward the cursor, drag pans, and the buttons cover the cases a
   trackpad makes awkward. */
async function openFlowModal(s){
  if(!s||!s.flow) return;
  const F=s.flow;
  const back=(F.backs||[]).length;
  let detail=false;      // the modal opens on the simple view; detail is a click away
  let shownSpec="";      // the mermaid source currently rendered
  let wrap=document.getElementById("flowModal");
  if(wrap) wrap.remove();
  wrap=document.createElement("div");
  wrap.id="flowModal"; wrap.className="flowmodal";
  wrap.innerHTML=
    `<div class="fmbar">
       <b>${esc(s.id)} · phase flow — every bounce</b>
       <span class="fmsub">${back} backward transition${back===1?"":"s"} · drag to pan · scroll to zoom</span>
       <span class="fmspacer"></span>
       ${back?`<button data-fm="detail" class="fmdetail">Explain every bounce</button>`:""}
       <button data-fm="copy" title="Copy the mermaid source of this diagram">Copy mermaid</button>
       <button data-fm="save" title="Download the mermaid source as a .mmd file">.mmd</button>
       <button data-fm="png" title="Download this diagram as a PNG image">PNG</button>
       <button data-fm="svg" title="Download this diagram as an SVG image">SVG</button>
       <button data-fm="out">−</button>
       <button data-fm="in">+</button>
       <button data-fm="fit">Fit</button>
       <button data-fm="reset">100%</button>
       <button data-fm="close" class="fmclose">Close</button>
     </div>
     <div class="fmview"><div class="fmcanvas">rendering ${back} transitions…</div></div>`;
  document.body.appendChild(wrap);

  const view=wrap.querySelector(".fmview"), canvas=wrap.querySelector(".fmcanvas");
  let k=1, tx=0, ty=0;
  const apply=()=>{ canvas.style.transform=`translate(${tx}px,${ty}px) scale(${k})` };
  /* `fit` means fit-to-window; `frame` is what we open on.

     Fitting the detailed diagram is technically correct and useless: 90 stacked
     edge labels make a ~24000px canvas, so fit-to-window lands at 0.03x, far
     below anything readable. On open we instead frame the phase chain at a
     legible zoom and let the reader pan out from there. Fit stays available on
     the button for people who want the whole shape at once. */
  const fit=()=>{
    const svg=canvas.querySelector("svg"); if(!svg) return;
    const vb=(svg.getAttribute("viewBox")||"").split(/\s+/).map(Number);
    if(vb.length<4) return;
    k=Math.min(view.clientWidth/vb[2], view.clientHeight/vb[3])*0.96;
    tx=(view.clientWidth-vb[2]*k)/2; ty=(view.clientHeight-vb[3]*k)/2;
    apply();
  };
  const frame=()=>{
    const svg=canvas.querySelector("svg"); if(!svg) return;
    const vb=(svg.getAttribute("viewBox")||"").split(/\s+/).map(Number);
    if(vb.length<4) return;
    // Width drives the zoom (the chain is horizontal); clamp so text stays
    // readable, then centre on the row of phase boxes rather than the canvas.
    // Read the chain's position from the SVG's own coordinate space via
    // getBBox, NOT from getBoundingClientRect: the latter already includes the
    // current transform, so measuring after apply() feeds the old zoom back in
    // and the centring lands nowhere near the boxes.
    let cx=vb[2]/2, cy=vb[3]/2, chainW=vb[2];
    const nodesG=canvas.querySelector("svg .nodes")||canvas.querySelector("svg g");
    try{
      const b=nodesG&&nodesG.getBBox();
      if(b&&b.width&&b.height){ cx=b.x+b.width/2; cy=b.y+b.height/2; chainW=b.width }
    }catch{ /* getBBox throws on a detached node */ }
    // Zoom on the chain's width so the phases fill the window, clamped so the
    // labels stay legible.
    k=Math.max(0.5,Math.min(1.2,(view.clientWidth/Math.max(1,chainW))*0.92));
    tx=view.clientWidth/2-cx*k;
    ty=view.clientHeight/2-cy*k;
    apply();
  };
  const close=()=>{ wrap.remove(); removeEventListener("keydown",onKey) };
  const onKey=e=>{ if(e.key==="Escape"){ e.stopPropagation(); close() } };
  addEventListener("keydown",onKey);

  wrap.querySelectorAll("[data-fm]").forEach(b=>b.addEventListener("click",()=>{
    const a=b.dataset.fm;
    if(a==="detail") return;              // handled by its own listener
    if(a==="close") return close();
    if(a==="copy"){
      /* Copy the source of the diagram as displayed, including the detail
         variant, so it can be pasted into a doc or issue and render identically.
         Clipboard access can be denied, so fall back to a selectable textarea
         rather than failing silently. */
      const done=()=>{ b.textContent="Copied"; setTimeout(()=>b.textContent="Copy mermaid",1400) };
      if(navigator.clipboard&&navigator.clipboard.writeText)
        navigator.clipboard.writeText(shownSpec).then(done,()=>fallbackCopy(shownSpec,done));
      else fallbackCopy(shownSpec,done);
      return;
    }
    if(a==="png"||a==="svg"){
      const el=canvas.querySelector("svg");
      if(!el) return;
      b.disabled=true; const label=b.textContent; b.textContent="…";
      exportDiagram(el,a,`${s.id}-phase-flow${detail?"-detailed":""}`)
        .catch(err=>console.warn("diagram export failed:",err))
        .then(()=>{ b.disabled=false; b.textContent=label });
      return;
    }
    if(a==="save") return downloadText({
      name:`${s.id}-phase-flow${detail?"-detailed":""}.mmd`,
      type:"text/vnd.mermaid", body:shownSpec});
    if(a==="fit") return fit();
    if(a==="reset"){ k=1; tx=0; ty=0; return apply() }
    // Zoom about the centre of the viewport, so the button behaves like the wheel.
    const cx=view.clientWidth/2, cy=view.clientHeight/2;
    const nk=Math.max(0.05,Math.min(6, k*(a==="in"?1.25:0.8)));
    tx=cx-(cx-tx)*(nk/k); ty=cy-(cy-ty)*(nk/k); k=nk; apply();
  }));
  view.addEventListener("wheel",e=>{
    e.preventDefault();
    const r=view.getBoundingClientRect();
    const px=e.clientX-r.left, py=e.clientY-r.top;
    const nk=Math.max(0.05,Math.min(6, k*(e.deltaY<0?1.12:0.89)));
    // Keep the point under the cursor fixed while scaling.
    tx=px-(px-tx)*(nk/k); ty=py-(py-ty)*(nk/k); k=nk; apply();
  },{passive:false});
  let drag=null;
  view.addEventListener("selectstart",e=>{ if(drag) e.preventDefault() });
  view.addEventListener("dragstart",e=>e.preventDefault());
  view.addEventListener("pointerdown",e=>{ e.preventDefault();
    drag={x:e.clientX,y:e.clientY,tx,ty};
    view.setPointerCapture(e.pointerId); view.classList.add("grabbing") });
  view.addEventListener("pointermove",e=>{ if(!drag)return;
    tx=drag.tx+(e.clientX-drag.x); ty=drag.ty+(e.clientY-drag.y); apply() });
  view.addEventListener("pointerup",()=>{ drag=null; view.classList.remove("grabbing") });
  wrap.addEventListener("click",e=>{ if(e.target===wrap) close() });

  async function draw(){
    canvas.classList.toggle("detail",detail);
    const btn=wrap.querySelector('[data-fm="detail"]');
    if(btn){ btn.textContent=detail?"Simple view":"Explain every bounce";
             btn.classList.toggle("on",detail) }
    canvas.innerHTML=detail?`rendering ${back} transitions…`:"rendering…";
    const spec=flowSpec(s,detail);
    shownSpec=spec;          // export whatever is on screen, never a re-derivation
    try{
      const m=await ensureMermaid();
      const {svg}=await m.render("fmsvg"+(++mermaidSeq),spec);
      canvas.innerHTML=svg;
      const el=canvas.querySelector("svg");
      if(el){
        /* Give the canvas the diagram's real pixel size.

           Stripping width/height and leaving the div to size itself collapsed it
           to 13x24px, so the transform translated an essentially empty box and
           the viewer rendered blank. The SVG scales through the CSS transform,
           so its intrinsic size must be the full viewBox. */
        const vb=(el.getAttribute("viewBox")||"").split(/\s+/).map(Number);
        el.style.maxWidth="none";
        if(vb.length===4&&vb[2]&&vb[3]){
          el.setAttribute("width",String(vb[2]));
          el.setAttribute("height",String(vb[3]));
          el.style.width=vb[2]+"px"; el.style.height=vb[3]+"px";
          canvas.style.width=vb[2]+"px"; canvas.style.height=vb[3]+"px";
        }
      }
      frame();
    }catch(e){
      canvas.innerHTML=`<pre class="raw">${esc(spec)}</pre>`;
    }
  }
  const detailBtn=wrap.querySelector('[data-fm="detail"]');
  if(detailBtn) detailBtn.addEventListener("click",()=>{ detail=!detail; draw() });
  draw();
}
let flowStory=null;      // projection the current phase-flow was built from
function vFlow(s){
  if(!s.flow) return "";
  flowStory=s;
  const F=s.flow;
  const id="mmd"+(++mermaidSeq);
  const nBack=(F.backs||[]).length;
  const spec=flowSpec(s,false);
  // render asynchronously; keep a text fallback if mermaid can't load
  setTimeout(async()=>{
    const host=document.getElementById(id);
    if(!host)return;
    try{
      const m=await ensureMermaid();
      const {svg}=await m.render(id+"svg",spec);
      host.innerHTML=svg;
      /* Pin the SVG to its viewBox width. Mermaid emits width="100%" plus an
         inline max-width, which squeezed a 2088px flowchart into a 641px panel
         at 0.307x and rendered 14.5px labels at about 4.5px. Setting the real
         width makes the text its declared size and lets the host scroll. */
      const el=host.querySelector("svg");
      const vb=el&&el.getAttribute("viewBox");
      if(vb){
        const w=parseFloat(vb.split(/\s+/)[2]);
        /* Scale to a floor, not to the container.

           Fitting the full 2088px chain into a 641px panel rendered the labels
           at 0.307x -- about 4.5px, unreadable. Pinning it to natural width made
           the text crisp but showed only two of eight phases. So allow it to
           shrink only as far as MIN_SCALE, then scroll for the rest: labels stay
           legible and a couple of phases stay visible at once. */
        // Detail mode is already oversized, so let it size naturally and scroll
        // in both axes; only the collapsed view needs a legibility floor.
        /* Inline is a PANORAMA: fit the whole chain into the panel, accepting a
           small font. The reader wants the shape of the lifecycle at a glance
           here; the modal is where it gets read at full size. */
        if(w>0){
          /* Round DOWN and leave a pixel of slack. Rounding the fitted width up
             (or landing exactly on clientWidth) left the panorama one or two
             pixels over its container, which showed a scrollbar on a diagram
             that visibly fits. */
          const width=Math.min(Math.floor((host.clientWidth||w)-2), Math.floor(w));
          el.setAttribute("width",String(width));
          el.style.maxWidth="none"; el.style.width=width+"px";
        }
      }
    }catch(e){
      host.innerHTML=`<pre class="raw">${esc(spec)}</pre>
        <p class="note2">Mermaid could not load; showing the diagram source.</p>`;
    }
  },0);
  /* The detailed diagram opens in a modal, not inline.

     Inline it was unusable: one labelled arrow per bounce makes a canvas ~24000px
     tall, and a capped box in a 640px drawer showed two phases and a lot of white
     space. A full-window viewer with its own zoom and pan is the only way this
     much of a diagram is actually readable. */
  const toggle=nBack
    ? `<button class="flowtog" data-flowzoom="1">Explain every bounce (${nBack})</button>`
    : "";
  /* Playback offered here as well as on the Timeline tab.

     This diagram aggregates ("6x forward", "26x back"), so it answers how often
     but never in what order; the viewer is the thing that does, and this is
     where a reader is already looking at the phase flow. Same [data-tlplay]
     hook, so the one handler in paint() covers both.

     Gated on s.timeline: the viewer is driven by the lifecycle segments, and a
     story whose detail failed to load has a flow diagram (built from the graph
     projection) but nothing to animate. Offering a button that could only error
     is worse than not offering it. */
  const play=(s.timeline||[]).length
    ? `<button class="flowtog" data-tlplay="1" title="Watch the lifecycle animate one transition at a time, and export it as MP4 or GIF">Playback</button>`
    : "";
  return sec("Phase flow",
    `<div class="flowhead">${play}${toggle}</div>`+
    `<div class="mermaid-host" id="${id}">rendering…</div>`+
    `<p class="note2">${F.rework
      ? `<b>${F.rework} backward transition${F.rework===1?"":"s"}</b> — dotted arrows are rework that sent the story back to an earlier phase.`
        +(nBack?` Open the detailed view to see each bounce individually, with when it happened, how long the phase it left had been held, and the findings filed during that visit.`:"")
      : "No backward transitions: this story only moved forward."}</p>`);
}

/* Export the timeline as structured data.

   The rendered timeline is the most information-dense thing in the UI and there
   was no way to get it out -- so this emits the same segments the view is built
   from, not a scrape of the DOM. JSON keeps the full nesting (each phase segment
   with its findings and events); CSV flattens to one row per item for a
   spreadsheet, since that is what CSV is good for. */
function timelineExport(s,fmt){
  const TL=s.timeline||[];
  const rows=TL.map((sg,i)=>({
    index:i+1, phase:sg.p, action:sg.a||"",
    enteredAt:sg.s||"", leftAt:sg.e||"",
    heldFor:dur(sg.s,sg.e0||sg.e)||"",
    agent:sg.ag||"", reason:sg.rs||"",
    findingCount:sg.nf||0,
    counts:sg.n||{},
    items:(sg.it||[]).map(it=>({
      kind:it.k, at:it.t||"",
      id:it.id||"", severity:it.sev||"", status:it.st||"",
      category:it.cat||"", agent:it.ag||"",
      detail:it.d||it.res||it.dec||"" })),
  }));
  if(fmt==="json"){
    return {name:`${s.id}-timeline.json`, type:"application/json",
      body:JSON.stringify({storyId:s.id, title:s.title||"", phase:s.phase,
        exportedAt:new Date().toISOString(),
        transitions:rows.length, segments:rows}, null, 2)};
  }
  // CSV: one row per item, with its segment repeated, so every row stands alone.
  const cols=["segment","phase","action","enteredAt","leftAt","heldFor","segmentAgent",
    "reason","itemKind","itemAt","itemId","severity","status","category","itemAgent","detail"];
  const q=v=>{ const t=String(v??""); return /[",\n]/.test(t)?`"${t.replace(/"/g,'""')}"`:t };
  const lines=[cols.join(",")];
  for(const r of rows){
    if(!r.items.length){
      lines.push([r.index,r.phase,r.action,r.enteredAt,r.leftAt,r.heldFor,r.agent,
        r.reason,"","","","","","","",""].map(q).join(","));
      continue;
    }
    for(const it of r.items)
      lines.push([r.index,r.phase,r.action,r.enteredAt,r.leftAt,r.heldFor,r.agent,
        r.reason,it.kind,it.at,it.id,it.severity,it.status,it.category,it.agent,it.detail]
        .map(q).join(","));
  }
  return {name:`${s.id}-timeline.csv`, type:"text/csv", body:lines.join("\n")};
}
/* Recover the visual line breaks of a wrapped element.

   getClientRects gives one rectangle per rendered line; walking the text by
   character and watching which rect each position falls into reconstructs the
   lines the browser actually laid out, which is what makes the PNG match the
   screen instead of collapsing to one long line. */
function splitToLines(host,rects){
  const tn=[];
  (function walk(n){ for(const c of n.childNodes){
    if(c.nodeType===3) tn.push(c); else if(c.nodeType===1) walk(c) } })(host);
  const tops=[...new Set(rects.map(r=>Math.round(r.top)))].sort((a,b)=>a-b);
  if(tops.length<2) return [(host.textContent||"").trim()];
  const lines=new Array(tops.length).fill("");
  const rng=document.createRange();
  for(const t of tn){
    const s=t.nodeValue||"";
    for(let i=0;i<s.length;i++){
      rng.setStart(t,i); rng.setEnd(t,i+1);
      const r=rng.getBoundingClientRect();
      if(!r.height) continue;
      let idx=0, best=Infinity;
      tops.forEach((tp,k)=>{ const d=Math.abs(r.top-tp); if(d<best){best=d;idx=k} });
      lines[idx]+=s[i];
    }
  }
  return lines.map(l=>l.trim()).filter(Boolean);
}

/* Rasterise the rendered diagram.

   Serialise the live SVG rather than re-rendering: what is exported is exactly
   what is on screen, including the detail variant. Two things make this work
   where a naive canvas.drawImage would not:

     - The computed label styles are inlined. Mermaid's labels are HTML inside
       foreignObject and our sizing/wrapping lives in the page stylesheet, which
       does not travel with a serialised SVG -- without this the export comes out
       with default-sized, unwrapped text.
     - A blob: URL is used for the image source. A data: URL of a multi-megabyte
       SVG exceeds URL length limits in some browsers, and neither taints the
       canvas the way an external reference would.

   The 2x scale keeps the small phase labels legible in the PNG. */
async function exportDiagram(svgEl,fmt,baseName){
  const clone=svgEl.cloneNode(true);
  const vb=(svgEl.getAttribute("viewBox")||"").split(/\s+/).map(Number);
  const w=vb.length===4&&vb[2]?vb[2]:svgEl.clientWidth||1200;
  const h=vb.length===4&&vb[3]?vb[3]:svgEl.clientHeight||600;
  clone.setAttribute("xmlns","http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink","http://www.w3.org/1999/xlink");
  clone.setAttribute("width",String(w)); clone.setAttribute("height",String(h));

  // Inline the styles the page supplies for label text.
  const src=[...svgEl.querySelectorAll(".nodeLabel,.edgeLabel,.label,p,span,div")];
  const dst=[...clone.querySelectorAll(".nodeLabel,.edgeLabel,.label,p,span,div")];
  const PROPS=["font-size","font-family","font-weight","line-height","color",
    "white-space","text-align","max-width","margin","padding","display"];
  for(let i=0;i<src.length&&i<dst.length;i++){
    const cs=getComputedStyle(src[i]);
    dst[i].setAttribute("style",
      (dst[i].getAttribute("style")||"")+";"+
      PROPS.map(k=>`${k}:${cs.getPropertyValue(k)}`).join(";"));
  }
  // Opaque ground, so a PNG is not transparent where the page background showed.
  const bg=getComputedStyle(document.body).backgroundColor||"#ffffff";
  const rect=document.createElementNS("http://www.w3.org/2000/svg","rect");
  rect.setAttribute("x","0"); rect.setAttribute("y","0");
  rect.setAttribute("width",String(w)); rect.setAttribute("height",String(h));
  rect.setAttribute("fill",bg==="rgba(0, 0, 0, 0)"?"#ffffff":bg);
  clone.insertBefore(rect,clone.firstChild);

  /* Convert foreignObject labels to native SVG <text> for the raster path.

     Chrome taints a canvas that has had an SVG containing foreignObject drawn
     into it, and toBlob then throws SecurityError. Verified directly: after
     stripping every external reference (the Google Fonts @import included) the
     serialised SVG had zero http refs and the canvas was STILL tainted, so this
     is the foreignObject itself, not a resource. The SVG export is unaffected
     and keeps the HTML labels.

     Each label's rendered lines are read back out of the live DOM (getClientRects
     gives one rect per visual line, so wrapping is preserved) and re-emitted as
     <text><tspan> at the same position. */
  if(fmt==="png"){
    const liveFO=[...svgEl.querySelectorAll("foreignObject")];
    const cloneFO=[...clone.querySelectorAll("foreignObject")];
    /* No scale factor. foreignObject width/height are already expressed in the
       SVG's own coordinate system -- the same units the font-size must be in --
       so the earlier `kx = viewBox/renderedWidth` multiplied every label by the
       current zoom (1.81x here) and inflated 18px text to 32px inside a box laid
       out for 18px. That is what produced overflowing, clipped labels. */
    for(let i=0;i<cloneFO.length&&i<liveFO.length;i++){
      const src=liveFO[i], dst=cloneFO[i];
      const host=src.querySelector("p,span,div")||src;
      const cs=getComputedStyle(host);
      const fs=parseFloat(cs.fontSize)||14;
      const lh=parseFloat(cs.lineHeight)||fs*1.35;
      // One rect per rendered line: this is what preserves the wrapping.
      const range=document.createRange(); range.selectNodeContents(host);
      const rects=[...range.getClientRects()].filter(r=>r.width>0.5&&r.height>0.5);
      const text=(host.textContent||"").trim();
      if(!text) continue;
      const lines=rects.length>1?splitToLines(host,rects):[text];
      const bw=parseFloat(dst.getAttribute("width"))||0;
      const bh=parseFloat(dst.getAttribute("height"))||lh*lines.length;
      const t=document.createElementNS("http://www.w3.org/2000/svg","text");
      const cxm=bw/2;
      t.setAttribute("text-anchor","middle");
      t.setAttribute("font-size",String(fs));
      t.setAttribute("font-family","ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif");
      t.setAttribute("fill",cs.color||"#222");
      /* Centre the block vertically in the box mermaid measured.

         foreignObject positions its HTML from the top edge; an SVG <text>
         positions from a baseline. Starting the first baseline at y=fs pushed a
         multi-line label out of the bottom of its box, so the whole block is
         centred instead: half the leftover space, plus a baseline offset. */
      const blockH=lh*lines.length;
      const top=Math.max(0,(bh-blockH)/2);
      lines.forEach((ln,j)=>{
        const ts=document.createElementNS("http://www.w3.org/2000/svg","tspan");
        ts.setAttribute("x",String(cxm));
        ts.setAttribute("y",String(top+lh*j+fs*0.82));   // 0.82em ≈ cap-height baseline
        ts.textContent=ln;
        t.appendChild(ts);
      });
      dst.replaceWith(t);
    }
    /* Guarantee none survive.

       The conversion above pairs the live and cloned foreignObject lists by
       index and skips any whose text is empty, so a mismatch or an empty label
       could leave one behind -- and ONE is enough to taint the canvas. Anything
       still present is dropped: losing an empty label is strictly better than
       failing the whole export. */
    clone.querySelectorAll("foreignObject").forEach(f=>f.remove());
    clone.querySelectorAll("style").forEach(st=>{
      st.textContent=st.textContent
        .replace(/@import[^;]+;/g,"")
        .replace(/url\((['"]?)https?:[^)]*\)/g,"none");
    });
  }
  const text=new XMLSerializer().serializeToString(clone);
  if(fmt==="svg"){
    downloadText({name:`${baseName}.svg`,type:"image/svg+xml",body:text});
    return;
  }
  const url=URL.createObjectURL(new Blob([text],{type:"image/svg+xml;charset=utf-8"}));
  try{
    const img=await new Promise((res,rej)=>{
      const i=new Image();
      i.onload=()=>res(i); i.onerror=()=>rej(new Error("SVG did not load"));
      i.src=url;
    });
    const SCALE=2;
    const c=document.createElement("canvas");
    c.width=Math.round(w*SCALE); c.height=Math.round(h*SCALE);
    const cx=c.getContext("2d");
    cx.setTransform(SCALE,0,0,SCALE,0,0);
    cx.drawImage(img,0,0);
    let blob=null;
    try{ blob=await new Promise(res=>c.toBlob(res,"image/png")) }
    catch(e){ throw new Error(`PNG export blocked (${e.name}); use SVG instead`) }
    if(!blob) throw new Error("canvas produced no image");
    const a=document.createElement("a");
    a.href=URL.createObjectURL(blob); a.download=`${baseName}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  } finally { URL.revokeObjectURL(url) }
}

/* Clipboard fallback for contexts where the async API is unavailable or denied
   (insecure origin, permission prompt dismissed). */
function fallbackCopy(text,done){
  const ta=document.createElement("textarea");
  ta.value=text; ta.style.cssText="position:fixed;left:-9999px;top:0";
  document.body.appendChild(ta); ta.select();
  let ok=false;
  try{ ok=document.execCommand("copy") }catch{ /* ignore */ }
  ta.remove();
  if(ok&&done) done();
}
/* Re-fit an already-rendered phase-flow SVG to its container.

   Resizing the drawer previously left the diagram at its old width -- too wide
   (a scrollbar appeared) or too narrow (it did not grow) -- because the only
   re-fit happened inside the mermaid render path. Repainting through mermaid on
   every pointermove would be far too slow, and re-rendering on pointerup is what
   made widening take seconds. This just sets the width attribute, which is
   instant, so it can run continuously while dragging. */
function refitFlow(){
  for(const host of document.querySelectorAll(".mermaid-host")){
    const el=host.querySelector("svg");
    if(!el) continue;
    const vb=(el.getAttribute("viewBox")||"").split(/\s+/).map(Number);
    if(vb.length!==4||!vb[2]) continue;
    const width=Math.min(Math.floor((host.clientWidth||vb[2])-2), Math.floor(vb[2]));
    el.setAttribute("width",String(width));
    el.style.maxWidth="none"; el.style.width=width+"px";
  }
}

function downloadText({name,type,body}){
  const url=URL.createObjectURL(new Blob([body],{type}));
  const a=document.createElement("a");
  a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

/* ---- lifecycle timeline with findings nested in their phase ---- */
const PHC={INIT:"--ph-init",INIT_CHECK:"--ph-check",PLAN:"--ph-plan",DEV:"--ph-dev",
           REVIEW:"--ph-review",TEST:"--ph-test",DONE:"--ph-done",DISCARDED:"--ph-disc"};
const KIND={finding:"finding",pass:"review pass",dispatch:"dispatch",sub:"subagent",
            validate:"validate",verdict:"host verdict",planrev:"plan review",
            human:"human confirmation",dirty:"dirty gate"};
function dur(a,b){
  if(!a||!b) return "";
  const t=(new Date(b)-new Date(a))/60000;
  if(!isFinite(t)||t<0) return "";
  return t<60?`${Math.round(t)}m`:`${(t/60).toFixed(1)}h`;
}
function vTimeline(s){
  const TL=s.timeline||[];
  if(!TL.length){
    // Distinguish a real empty history from a failed load. Claiming "no events"
    // when the fetch died is a false statement about the story.
    const C=curStory?CH[curStory.id]:null;
    if(C&&(C.loadFailed||C.err))
      return sec("Lifecycle",`<div class="loaderr">Could not load this story's detail`+
        `${C.err?`: <span class="mono">${esc(String(C.err))}</span>`:"."}`+
        `<br>The lifecycle is unknown, not empty. <button data-reload="1">Retry</button></div>`);
    return sec("Lifecycle",`<span class="emp">No lifecycle events recorded.</span>`);
  }
  const totF=TL.reduce((a,x)=>a+(x.nf||0),0);
  let h=`<div class="sec"><p class="st">Lifecycle — ${TL.length} phase transitions, ${totF} findings in place`
    +`<span class="tlexp">`
    +`<button class="tlplay" data-tlplay="1" title="Watch the lifecycle animate one transition at a time, and export it as MP4 or GIF">Playback</button>`
    +`<button data-tlexport="json">Export JSON</button>`
    +`<button data-tlexport="csv">CSV</button></span></p>`;
  TL.forEach((sg,i)=>{
    const col=`var(${PHC[sg.p]||"--ink3"})`;
    const d=dur(sg.s,sg.e);
    const back=i>0&&TL[i-1].p&&rank(sg.p)<rank(TL[i-1].p);
    h+=`<div class="seg">
      <div class="segh">
        <span class="segt mono">${esc(fMin(sg.s))}</span>
        <span class="segdot" style="background:${col}"></span>
        <span class="segp" style="color:${col}">${esc(sg.p||"?")}</span>
        <span class="sega">${esc(sg.a||"")}</span>
        ${d?`<span class="segdur mono">${d}</span>`:""}
        ${back?`<span class="segback">↩ back from ${esc(TL[i-1].p)}</span>`:""}
      </div>`;
    if(sg.rs) h+=`<div class="segrs">${esc(sg.rs)}</div>`;
    const sev={};
    for(const it of (sg.it||[])) if(it.k==="finding") sev[it.sev||"low"]=(sev[it.sev||"low"]||0)+1;
    const sevOrder=["critical","high","medium","low"].filter(k=>sev[k]);
    if(sevOrder.length)
      h+=`<div class="segsev">${sevOrder.map(k=>`<span class="sv-${k}">${sev[k]} ${k}</span>`).join("")}</div>`;
    if(sg.n&&Object.keys(sg.n).length)
      h+=`<div class="segn">${Object.entries(sg.n).map(([k,v])=>`<span>${v} ${esc(KIND[k]||k)}</span>`).join("")}</div>`;
    if((sg.it||[]).length){
      h+=`<div class="segit">`;
      sg.it.forEach(it=>{h+=tlItem(it)});
      h+=`</div>`;
    }
    h+=`</div>`;
  });
  return h+`</div>`;
}
function rank(p){return {INIT:0,INIT_CHECK:1,PLAN:2,DEV:3,REVIEW:4,TEST:5,DONE:6,DISCARDED:6}[p]??9}
/* The time cell, with a superscript day offset when the row is not on the
   segment's first day.

   The offset rides along as a <sup> inside the fixed-width time cell, so the
   time column stays aligned and the row stays one line -- a "MM-DD " prefix did
   neither. Titled with the absolute date, since the marker alone says how far
   but not when. */
function tlTime(it){
  const t=esc(it.t||"");
  if(!it.dd) return `<span class="mono tlt">${t}</span>`;
  const day=fDay(it.ts||"");
  return `<span class="mono tlt">${t}`
    +`<sup class="tldd"${day?` title="${esc(day)}"`:""}>+${it.dd}</sup></span>`;
}
function tlItem(it){
  if(it.k==="finding"){
    const sv=it.sev||"low";
    const known=!!it.id;
    return `<div class="tlf ${sv}${known?" jump":""}"${known?` data-fid="${esc(it.id)}" role="button" tabindex="0" title="Click to open in the Findings tab"`:""}>
      <div class="tlfh">
        ${tlTime(it)}
        <span class="mono fid">${esc(it.id||"")}</span>
        <span class="fsev">${esc(sv)}</span>
        ${it.st?`<span class="fst ${it.st==="open"?"open":""}">${esc(it.st)}</span>`:""}
        ${it.cat?`<span class="fst">${esc(it.cat)}</span>`:""}
        ${it.ag?`<span class="fag">${esc(it.ag)}</span>`:""}
      </div>
      ${it.d?`<div class="tlfd">${esc(it.d)}</div>`+(it.d.length>150?`<div class="tlfmore"></div>`:"")
        :""}
      ${(it.files||[]).length?`<div class="tlff mono">${it.files.map(esc).join(" · ")}</div>`:""}
    </div>`;
  }
  const ic={pass:"✓",dispatch:"→",sub:"◆",validate:"⚙",verdict:"⚖",planrev:"✎",human:"☺",dirty:"!",revact:"✓"}[it.k]||"·";
  let txt="";
  if(it.k==="pass") txt=`review pass <b>${esc(it.ag||"")}</b>${it.id?` <span class="mono">${esc(it.id)}</span>`:""}`;
  else if(it.k==="dispatch") txt=`dispatch <b>${esc(it.ag||"")}</b>${it.kind?` · ${esc(it.kind)}`:""}`;
  else if(it.k==="sub") txt=`subagent returned <b>${esc(it.item||"")}</b> <span style="color:${it.ok?"var(--pass)":"var(--fail)"}">${it.ok?"ok":"failed"}</span>`;
  else if(it.k==="validate") txt=`validate <span style="color:${it.res==="pass"?"var(--pass)":"var(--fail)"}">${esc(it.res||"")}</span>${it.n?` · ${it.n} commands`:""}${it.disp?` · ${esc(it.disp)}`:""}`;
  else if(it.k==="verdict") txt=`host verdict <b>${esc(it.dec||"")}</b>${it.host?` · ${esc(it.host)}`:""}${it.run?` <span class="mono">${esc(it.run)}</span>`:""}`;
  else if(it.k==="planrev") txt=`plan review · <b>${it.iss??"—"}</b> issues, <b>${it.blk??"—"}</b> blockers`;
  else if(it.k==="human") txt=`human confirmation${it.d?` · ${esc(it.d)}`:""}`;
  else if(it.k==="dirty") txt=`dirty-gate audit${it.d?` · ${esc(it.d)}`:""}`;
  else if(it.k==="revact") txt=`reviewer <b>${esc(it.ag||"")}</b> reported${it.res?` · ${esc(it.res)}`:""}`;
  return `<div class="tle">${tlTime(it)}<span class="tlic">${ic}</span><span class="tltx">${txt}</span></div>`;
}

/* ---- TAB: Provenance — signatures, digests, hash chains ---- */
function hx(v){return v?`<span class="hash">${esc(v)}${String(v).length>=12?"…":""}</span>`:'<span class="hash dim">—</span>'}
function vProv(s){
  let h="";
  // 1. identity separation — the anti-self-approval proof
  const p=s.prov;
  if(p&&(p.critic||p.impl)){
    const same=p.critic&&p.impl&&p.critic.sess===p.impl.sess;
    h+=sec("Reviewer / implementer identity separation",
      `<div class="idsep">
        <div class="idcol"><div class="idh">Critic</div>
          <dl class="kv"><dt>agent</dt><dd>${esc(p.critic?.id||"—")}</dd>
          <dt>session</dt><dd>${hx(p.critic?.sess)}</dd>
          <dt>dispatch</dt><dd>${hx(p.critic?.disp)}</dd>
          <dt>head</dt><dd>${hx(p.critic?.head)}</dd></dl></div>
        <div class="idcol"><div class="idh">Implementer</div>
          <dl class="kv"><dt>agent</dt><dd>${esc(p.impl?.id||"—")}</dd>
          <dt>session</dt><dd>${hx(p.impl?.sess)}</dd>
          <dt>dispatch</dt><dd>${hx(p.impl?.disp)}</dd>
          <dt>head</dt><dd>${hx(p.impl?.head)}</dd></dl></div>
      </div>
      <div class="verdictline ${same?"bad":"good"}">${same
        ? "⚠ Same session id on both roles — separation NOT demonstrated."
        : "✓ Distinct session ids: the critic did not review its own implementation."}</div>`+
      (p.critic?.auth?`<div class="gm">commit author: ${esc(p.critic.auth)}</div>`:"")+
      `<dl class="kv" style="margin-top:8px">
        <dt>signer key</dt><dd>${hx(p.key)}</dd><dt>signature</dt><dd>${hx(p.sig)}</dd>
        <dt>basis digest</dt><dd>${hx(p.basisDig)}</dd><dt>topology digest</dt><dd>${hx(p.topoDig)}</dd></dl>`);
  }
  // 2. closeout write receipts: the hash chain
  if(s.nWriteReceipts){
    const cs=s.chainStats||{};
    h+=sec(`Closeout write receipts — hash chain (${s.nWriteReceipts})`,
      `<div class="verdictline ${s.chainOk?"good":"bad"}">${s.chainOk
        ? `✓ Chain intact: ${cs.valid||0}/${cs.artifacts||0} per-artifact chains verify (each links previousIntegrityHash → integrityHash).`
        : `⚠ ${cs.broken||0} of ${cs.artifacts||0} per-artifact chains do not link.`}</div>
      <div class="chaintbl"><div class="chrow chhead"><span>#</span><span>artifact</span><span>writer</span><span>prev → integrity</span></div>
      ${(s.writeReceipts||[]).map(r=>`<div class="chrow">
        <span class="mono">${r.seq??""}</span>
        <span class="mono" style="color:var(--ink)">${esc(r.a||"")}</span>
        <span class="mono">${esc(r.c||"")}${r.ph?` · ${esc(r.ph)}`:""}</span>
        <span>${r.prev?hx(r.prev):'<span class="hash dim">genesis</span>'} <span style="color:var(--ink3)">→</span> ${hx(r.ih)}</span>
      </div>`).join("")}</div>
      ${s.nWriteReceipts>(s.writeReceipts||[]).length?`<div class="gm">showing first ${(s.writeReceipts||[]).length} of ${s.nWriteReceipts}</div>`:""}`);
  }
  // 3. prompt envelopes: what was hashed at dispatch time
  if(s.nEnvelopes){
    h+=sec(`Prompt envelopes (${s.nEnvelopes})`,
      `<p style="font-size:11.5px;color:var(--ink2);margin-bottom:7px">Every agent dispatch is pinned by ${(s.envDigestKinds||[]).length} digests, so a reviewer's verdict cannot be re-bound to different inputs.</p>
       <div class="chips">${(s.envDigestKinds||[]).map(k=>`<span class="chip">${esc(k)}</span>`).join("")}</div>
       <div class="chaintbl" style="margin-top:9px"><div class="chrow chhead"><span>role</span><span>lane</span><span>run</span><span>assembled prompt</span></div>
       ${(s.envelopes||[]).map(e=>`<div class="chrow">
         <span class="mono" style="color:var(--ink)">${esc(e.role||"")}</span>
         <span class="mono">${esc((e.lane||"").replace("lattice-review-",""))}</span>
         <span class="mono">${esc(e.run||"—")}</span>
         <span>${hx((e.dg||{}).assembledPromptDigest||(e.dg||{}).dispatchPromptDigest)}</span>
       </div>`).join("")}</div>`);
  }
  // 4. acceptance basis receipt
  if(s.basisProv) h+=sec("Acceptance basis receipt",
    `<dl class="kv">
      <dt>discovery profile</dt><dd>${esc(s.basisProv.profile||"—")}</dd>
      <dt>profile digest</dt><dd>${hx(s.basisProv.profDig)}</dd>
      <dt>generated by</dt><dd>${esc(s.basisProv.gen||"—")} ${esc(s.basisProv.ver||"")}</dd>
      <dt>basis digest</dt><dd>${hx(s.basisProv.dig)}</dd>
      <dt>receipt ref</dt><dd>${hx(s.basisProv.rcpt)}</dd>
      <dt>issuer</dt><dd>${esc(s.basisProv.issuer||"—")}</dd>
      <dt>seal digest</dt><dd>${hx(s.basisProv.seal)}</dd>
      <dt>signature</dt><dd>${hx(s.basisProv.sig)}</dd>
    </dl>`);
  // 5. pre-review check
  if(s.preRevProv) h+=sec("Pre-review check binding",
    `<dl class="kv">
      <dt>mode</dt><dd>${esc(s.preRevProv.mode||"—")}</dd>
      <dt>cutoff</dt><dd>${esc(fSec(s.preRevProv.cut))||"—"}</dd>
      <dt>plan basis digest</dt><dd>${hx(s.preRevProv.planDig)}</dd>
      <dt>topology digest</dt><dd>${hx(s.preRevProv.topoDig)}</dd>
      <dt>scope-check digest</dt><dd>${hx(s.preRevProv.scDig)}</dd>
      <dt>storyFilesHash</dt><dd>${hx(s.preRevProv.sfh)}</dd>
      <dt>signature</dt><dd>${hx(s.preRevProv.sig)}</dd>
    </dl>`);
  // 6. review inventory epochs
  if((s.epochs||[]).length) h+=sec("Review inventory epochs",
    s.epochs.map(e=>`<div class="gate">
      <div class="gh"><b class="mono">${esc(e.id||"")}</b><span class="mono" style="font-size:9.5px">${esc(e.st||"")}</span></div>
      <div class="gm">round ${esc(fMin(e.rd))}</div>
      <dl class="kv" style="margin-top:5px">
        ${Object.entries(e.cut||{}).map(([k,v])=>`<dt>${esc(k)}</dt><dd>${hx(v)}</dd>`).join("")}
        <dt>scope digest</dt><dd>${hx(e.sd)}</dd></dl>
      ${(e.lanes||[]).length?`<div class="gm">required lanes: ${e.lanes.map(esc).join(" · ")}</div>`:""}
    </div>`).join(""));
  // 7. certification receipts
  if((s.certReceipts||[]).length) h+=sec("Certification receipts",
    s.certReceipts.map(r=>`<div class="gate"><div class="gh"><b class="mono">${esc(r.id||"")}</b>
      <span class="mono" style="font-size:9.5px">${r.heavy?"heavy-certification":"standard"}</span></div>
      <dl class="kv" style="margin-top:4px"><dt>window</dt><dd class="mono">${esc(r.w||"")}</dd>
      <dt>authority</dt><dd>${esc(r.auth||"")}</dd><dt>hash</dt><dd>${hx(r.h)}</dd></dl></div>`).join(""));
  // 8. intent + ledger binding hashes
  const ph=s.psHashes;
  if(ph||s.reqHash||s.ledgerHash||s.ledgerBind) h+=sec("Intent & ledger bindings",
    `<dl class="kv">
      ${s.reqHash?`<dt>original request hash</dt><dd>${hx(s.reqHash)}</dd>`:""}
      ${ph&&ph.orig?`<dt>proofstory → intent</dt><dd>${hx(ph.orig)}</dd>`:""}
      ${ph&&ph.ledger?`<dt>proofstory → ledger</dt><dd>${hx(ph.ledger)}</dd>`:""}
      ${s.ledgerHash?`<dt>milestone ledger hash</dt><dd>${hx(s.ledgerHash)}</dd>`:""}
      ${s.ledgerBind?`<dt>intent collision</dt><dd class="mono">${esc(s.ledgerBind.ic||"")}</dd>
        <dt>accepted interpretation</dt><dd>${hx(s.ledgerBind.h)}</dd>`:""}
    </dl>`+
    (ph&&ph.orig&&s.reqHash?`<div class="verdictline ${String(s.reqHash).slice(0,18)===String(ph.orig).slice(0,18)?"good":"bad"}">${
      String(s.reqHash).slice(0,18)===String(ph.orig).slice(0,18)
      ? "✓ proofstory is bound to the recorded original request hash."
      : "⚠ proofstory intent hash differs from the request snapshot."}</div>`:""));
  // 9. gap-log provenance
  if(s.nGapProv) h+=sec(`Gap-log provenance (${s.nGapProv})`,
    `<div class="chaintbl"><div class="chrow chhead"><span>#</span><span>finding</span><span>fingerprint</span><span>pre → post</span></div>
    ${(s.gapProv||[]).map(g=>`<div class="chrow"><span class="mono">${g.seq??""}</span>
      <span class="mono" style="color:var(--ink)">${esc(g.f||"")}</span><span>${hx(g.fp)}</span>
      <span>${hx(g.pre)} → ${hx(g.post)}</span></div>`).join("")}</div>`);
  return h||`<span class="emp">No signed provenance artifacts recorded for this story.</span>`;
}

/* ---- TAB 5: relations + lifecycle ---- */
function ms(v){
  if(v==null||!isFinite(v))return "—";
  const m=v/60000;
  if(m<1) return `${Math.round(v/1000)}s`;
  if(m<60) return `${Math.round(m)}m`;
  const hh=m/60;
  if(hh<48) return `${hh.toFixed(1)}h`;
  return `${(hh/24).toFixed(1)}d`;
}
function vRel(s){
  const up=(outE[s.id]||[]), dn=(inE[s.id]||[]);
  const PS=s.phaseStats||null;
  const tot=s.totalMs||s.wall||null;
  let h="";
  // ---- in-flight stories: show live state instead of blank duration ----
  if(s.inFlight){
    const L=s.live, IS=s.itemStatus||{};
    const done=IS.done||0, tot=Object.values(IS).reduce((a,b)=>a+b,0);
    const age=L&&L.beat?(Date.now()-new Date(L.beat).getTime()):null;
    const stale=age!=null&&age>1000*60*30;
    h+=sec("Live status",
      `<div class="livebar"><span class="livedot ${L?(stale?"stale":"hot"):"idle"}"></span>
        <b>${esc(s.phase)}</b> &middot; in flight since ${esc(fDay(s.created))||"—"}
        ${L?`&middot; last heartbeat ${esc(fMin(L.beat))}${stale?" (stale)":""}`:"&middot; no active owner lease"}
      </div>`+
      `<div class="mt" style="margin-top:9px">
         ${mt(`${done}/${tot||"—"}`,"checklist done",done&&done===tot?"g":"")}
         ${mt(s.nEv||0,"evidence so far",s.nEv?"g":"")}
         ${mt(s.nFind||0,"findings",s.nFind?"r":"")}
         ${mt(s.nPE||0,"process events")}
       </div>`+
      (Object.keys(IS).length?`<div class="segn" style="margin-top:7px">${Object.entries(IS).map(([k,v])=>`<span>${v} ${esc(k)}</span>`).join("")}</div>`:"")+
      (L?`<dl class="kv" style="margin-top:9px">
           <dt>owner session</dt><dd>${esc(L.sess||"")}</dd>
           <dt>host</dt><dd>${esc(L.host||"")}${L.pid?` · pid ${L.pid}`:""}</dd>
           <dt>last command</dt><dd>${esc(L.cmd||"")}${L.cmdTarget?` <span style="color:var(--ink3)">&rarr; ${esc(L.cmdTarget)}</span>`:""}</dd>
           <dt>lease acquired</dt><dd>${esc(fSec(L.acq))}</dd>
           ${L.src?`<dt>source</dt><dd>${esc(L.src)}</dd>`:""}
         </dl>`:`<p class="note2">No owner-lease file: nothing is holding this story right now.</p>`)+
      (s.takeovers?`<p class="note2">Ownership taken over ${s.takeovers}×.</p>`:"")+
      (s.breaker?`<p class="note2">Convergence breaker: ${s.breaker.frozen?"FROZEN":"active"}${s.breaker.spent!=null?`, ${s.breaker.spent} auto-recoveries spent`:""}${(s.breaker.reasons||[]).length?` — ${s.breaker.reasons.map(esc).join("; ")}`:""}</p>`:""));
  }
  const inPhase=s.totalMs, wall=s.wall;
  const idle=(inPhase!=null&&wall!=null&&wall>inPhase)?wall-inPhase:null;
  h+=sec(s.inFlight?"Elapsed time (final figures land at DONE)":"Elapsed time",
    `<div class="mt">
       ${mt(wall!=null?ms(wall):(s.inFlight&&s.created?ms(Date.now()-new Date(s.created).getTime())+" so far":"—"),"wall clock","b")}
       ${mt(inPhase!=null?ms(inPhase):"—","time in phases")}
       ${mt(idle!=null?ms(idle):"—","between phases")}
       ${mt((fDay(s.created)||"—")+(s.ended?` → ${fDay(s.ended)}`:(s.inFlight?" → now":"")),"span")}
     </div>
     <p class="note2">Wall clock is created&nbsp;→&nbsp;ended. Time in phases is the sum of per-phase durations from <code>summary.json</code>; the remainder is time the story sat between transitions.</p>`+
    (PS?(()=>{
      const sum=Object.values(PS).reduce((a,x)=>a+(x.durationMs||0),0)||1;
      const order=["INIT","INIT_CHECK","PLAN","DEV","REVIEW","TEST","DONE","DISCARDED"];
      const ks=order.filter(k=>PS[k]).concat(Object.keys(PS).filter(k=>!order.includes(k)));
      return `<div class="phbar" role="img" aria-label="time by phase">
          ${ks.map(k=>{const w=(PS[k].durationMs||0)/sum*100;
            return w<0.4?"":`<span style="width:${w.toFixed(2)}%;background:var(${PHC[k]||"--ink3"})" title="${k}: ${ms(PS[k].durationMs)}"></span>`}).join("")}
        </div>
        <div class="phlist">
          ${ks.map(k=>`<div class="phrow">
            <span class="phdot" style="background:var(${PHC[k]||"--ink3"})"></span>
            <span class="phk mono">${esc(k)}</span>
            <span class="phv mono">${ms(PS[k].durationMs)}</span>
            <span class="php mono">${((PS[k].durationMs||0)/sum*100).toFixed(0)}%</span>
            <span class="phc mono">${PS[k].count>1?`${PS[k].count}× entered`:"1× entered"}</span>
          </div>`).join("")}
        </div>`;
    })():`<p class="note2">Per-phase timing is written to <code>summary.json</code> at DONE, so an in-flight story has none yet. The lifecycle below still shows every transition recorded so far.</p>`));
  h+=sec("Position in the web",`<div class="mt">
    ${mt(s.depth||0,"total dependents","b")}${mt(dn.length,"direct dependents")}${mt(up.length,"builds on")}
  </div>`);
  h+=sec("Builds on (outgoing)",up.length?`<div class="rel">${up.map(x=>`<button data-go="${x}">${x} <span class="dir">${esc((byId[x]||{}).phase||"")}</span></button>`).join("")}</div>`:`<span class="emp">Nothing.</span>`);
  h+=sec("Depended on by (incoming)",dn.length?`<div class="rel">${dn.map(x=>`<button data-go="${x}">${x} <span class="dir">${esc((byId[x]||{}).phase||"")}</span></button>`).join("")}</div>`:`<span class="emp">Nothing.</span>`);
  if((s.risk||[]).length) h+=sec("Risk signals",`<ul class="l">${s.risk.map(r=>`<li>${esc(r)}</li>`).join("")}</ul>`);
  if(s.peKinds&&Object.keys(s.peKinds).length) h+=sec(`Process events (${s.nPE||0})`,
    `<dl class="kv">${Object.entries(s.peKinds).map(([k,v])=>`<dt>${k.replace(/_/g," ")}</dt><dd>${v}</dd>`).join("")}</dl>`);
  h=vFlow(s)+h+vTimeline(s);
  return h;
}

/* ---------- shared helpers + camera focus ---------- */
const PEEK=(()=>{
  const el=document.createElement("div");
  el.className="peek"; el.id="findingPeek";
  document.body.appendChild(el);
  return el;
})();
function hideFindingPeek(){ PEEK.classList.remove("on") }
function showFindingPeek(anchor){
  const fid=anchor.dataset.fid;
  const C=curStory?CH[curStory.id]:null;
  const f=(C&&C.findings||[]).find(x=>x.id===fid)
    ||(C&&C.findings||[]).find(x=>bareFid(x.id)===bareFid(fid));
  if(!f){ return }
  PEEK.innerHTML=
    `<div class="pkh">
       <span class="mono pkid">${esc(f.id||"")}</span>
       <span class="fsev">${esc(f.sev||"")}</span>
       <span class="fst ${f.status==="open"?"open":""}">${esc(f.status||"")}</span>
       ${f.cat?`<span class="fst">${esc(f.cat)}</span>`:""}
       ${f.agent?`<span class="fag">${esc(f.agent)}</span>`:""}
     </div>
     <div class="pkd">${esc(f.desc||"")}</div>
     ${(f.files||[]).length?`<div class="pkf mono">${f.files.map(esc).join(" · ")}</div>`:""}
     ${f.res?`<div class="pkr"><b>Resolution${f.rtype?" · "+esc(f.rtype):""}</b>${esc(f.res)}</div>`:""}
     <div class="pkhint">click to open in the Findings tab</div>`;
  PEEK.classList.add("on");
  // place it left of the drawer, clamped to the viewport
  const r=anchor.getBoundingClientRect();
  const w=PEEK.offsetWidth, h=PEEK.offsetHeight;
  let left=r.left-w-14;
  if(left<8) left=Math.min(r.right+14, innerWidth-w-8);
  let top=r.top-6;
  if(top+h>innerHeight-8) top=Math.max(8,innerHeight-h-8);
  PEEK.style.left=left+"px"; PEEK.style.top=top+"px";
}
/* Finding ids are inconsistently story-qualified across stories: some events use
   "B-137a:F-205" while findings.json stores bare "F-205", and other stories
   prefix both sides. Anchors must therefore match on the bare id, never on the
   raw string -- comparing raw is what made lifecycle -> Findings jumps silently
   scroll to the top instead of the target. */
function bareFid(v){ const t=String(v||""); const i=t.lastIndexOf(":"); return i<0?t:t.slice(i+1) }
function findByFid(B,attr,fid){
  const want=bareFid(fid);
  const exact=B.querySelector(`[${attr}="${cssEsc(fid)}"]`);
  if(exact) return exact;
  return [...B.querySelectorAll(`[${attr}]`)].find(e=>bareFid(e.getAttribute(attr))===want)||null;
}
function jumpToFinding(fid){
  if(!fid)return;
  fFilter="all";            // a filter could hide the target
  curTab="find"; paint();
  requestAnimationFrame(()=>{
    positionTabBar();
  const B=document.getElementById("dB");
    const card=findByFid(B,"data-fcard",fid);
    if(!card){B.scrollTop=0;return}
    if(card.tagName==="DETAILS") card.open=true;
    card.scrollIntoView({block:"center",behavior:"smooth"});
    card.classList.remove("flash"); void card.offsetWidth; card.classList.add("flash");
  });
}
function jumpToLifecycle(fid){
  if(!fid)return;
  curTab="rel"; paint();
  requestAnimationFrame(()=>{
    positionTabBar();
  const B=document.getElementById("dB");
    const el=findByFid(B,"data-fid",fid);
    if(!el){B.scrollTop=0;return}
    el.scrollIntoView({block:"center",behavior:"smooth"});
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
  });
}
/* ---- dossier routing: /story/<id> deep-links the full-window page.
   The drawer button pushes that path; closing the dossier restores /; the
   back/forward buttons replay both. The graph page itself stays at /. ---- */
const dossierPath=id=>"/story/"+encodeURIComponent(id);
/* The story's neighbourhood in the web. Edges live in the graph payload, not
   in the story detail, so the dossier is handed a ready-made summary.
   Edge shape is {s,t,k} (graph/fn.ts); s → t means s builds on t. */
function relationsOf(id){
  const up=[],down=[];
  for(const e of ED){
    if(e.s===id&&byId[e.t])up.push({id:e.t,kind:e.k||"ref",phase:byId[e.t].phase,title:byId[e.t].title||""});
    else if(e.t===id&&byId[e.s])down.push({id:e.s,kind:e.k||"ref",phase:byId[e.s].phase,title:byId[e.s].title||""});
  }
  const n=byId[id]||{};
  return {up,down,depth:n.depth??null,indeg:n.indeg||0,outdeg:n.outdeg||0};
}
async function openDossierFor(id,push){
  const s=byId[id];
  if(!s){ console.warn("dossier: unknown story",id); return false }
  if(!CH[id]||!CH[id].raw) await open(id);   // fetches the detail, opens the drawer behind
  const C=CH[id];
  if(!C||!C.raw||!window.openStoryDossier) return false;
  if(push&&location.pathname!==dossierPath(id))
    history.pushState({dossier:id},"",dossierPath(id));
  window.openStoryDossier(s,C.raw,{
    jump:fid=>jumpToFinding(fid),
    openStory:sid=>openDossierFor(sid,true),   // web panel: hop to a neighbour
    onClose:()=>{ if(location.pathname.startsWith("/story/")) history.pushState({},"","/") },
  },relationsOf(id));
  return true;
}
addEventListener("popstate",()=>{
  const m=location.pathname.match(/^\/story\/([^/]+)$/);
  if(m) openDossierFor(decodeURIComponent(m[1]),false);
  else if(window.closeStoryDossier) window.closeStoryDossier();
});
function cssEsc(v){return String(v).replace(/["\\]/g,"\\$&")}
function sec(t,h){return `<div class="sec"><p class="st">${t}</p>${h}</div>`}
function mt(v,l,k){return `<div class="m ${k||""}"><div class="v">${v}</div><div class="l">${l}</div></div>`}
const dr=document.getElementById("dr");
// ---- draggable drawer width (persisted) ----
(function drawerResize(){
  const MIN=380, MAXFRAC=0.92;
  let w=0;try{w=Number(localStorage.getItem("pg.drawerW")||0)}catch{}
  const apply=v=>{
    w=Math.max(MIN,Math.min(innerWidth*MAXFRAC,v));
    dr.style.width=w+"px";
    document.documentElement.style.setProperty("--drawerW",w+"px");
  };
  if(w) apply(w);
  const grip=document.createElement("div");
  grip.className="drgrip"; grip.title="Drag to resize";
  grip.setAttribute("role","separator"); grip.setAttribute("aria-orientation","vertical");
  dr.appendChild(grip);
  let dragging=false;
  grip.addEventListener("pointerdown",e=>{
    dragging=true; grip.setPointerCapture(e.pointerId);
    document.body.style.userSelect="none"; e.preventDefault();
  });
  grip.addEventListener("pointermove",e=>{ if(dragging){ apply(innerWidth-e.clientX); refitFlow() } });
  const stop=()=>{ if(!dragging)return; dragging=false;
    document.body.style.userSelect="";
    try{ localStorage.setItem("pg.drawerW",String(Math.round(w))) }catch{}
    refitFlow(); draw();
  };
  grip.addEventListener("pointerup",stop);
  grip.addEventListener("pointercancel",stop);
  grip.addEventListener("dblclick",()=>{ try{localStorage.removeItem("pg.drawerW")}catch{}
    dr.style.width=""; document.documentElement.style.removeProperty("--drawerW");
    refitFlow(); draw() });
  addEventListener("resize",()=>{ if(w) apply(w); refitFlow() });
})();
// Delegate tab clicks from the drawer: #tabs lives inside #dC, which paint() rewrites,
// so a listener bound to #tabs itself dies on the first repaint.
dr.addEventListener("click",e=>{
  const b=e.target.closest("#tabs button[data-tab]");
  if(!b)return;
  /* Re-clicking the active tab is a no-op.

     paint() rewrites .db wholesale, and .db carries the tabfade animation, so
     clicking the tab you are already on replayed that fade -- the panel visibly
     flickered for no change in content. On the Timeline tab it also threw away
     the rendered Mermaid diagram and re-rendered it from scratch. */
  if(b.dataset.tab===curTab) return;
  curTab=b.dataset.tab; paint();
});
function close(){
  dr.classList.remove("on");document.body.classList.remove("open");
  sel=null;curStory=null;
  /* Closing the panel must restore the field.
     Dimming falls through to the search highlight (see the focus computation in
     draw()), so clearing `sel` alone left the graph faded with the results list
     shut -- washed out and nothing on screen explaining why.

     The highlight is kept while the results list is OPEN (it is what shows where
     the matches sit on the canvas). With the list closed there is no such cue, so
     the graph goes back to full brightness; the query text stays in the box and
     clicking it re-opens the list and the highlight together. */
  if(hlSet && !RES.classList.contains("on")) hlSet=null;
  /* The pick that opened this panel is finished, so the "reader chose a result"
     dismissal should not outlive it -- otherwise returning to the search box
     stays inert and the only way back to the same matches is retyping. */
  delete RES.dataset.dismissed;
  draw();
}
function focusCam(s){
  if(GLVIEW){ GLVIEW.focus(s); return }
  spin=false;
  const ry1=Math.atan2(-s.x,-s.z)+Math.PI;
  const rx1=Math.max(-1.0,Math.min(1.0,-Math.asin(Math.max(-1,Math.min(1,s.y/Math.max(1,Math.hypot(s.x,s.y,s.z)))))));
  const d1=760, px1=-Math.min(660,innerWidth*.52)/2.4, py1=0;
  const t0=performance.now(), r0=cam.ry,x0=cam.rx,D0=cam.dist,X0=cam.px,Y0=cam.py;
  const dd=((ry1-r0+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI;
  (function ease(){
    const k=Math.min(1,(performance.now()-t0)/460), e=1-Math.pow(1-k,3);
    cam.ry=r0+dd*e; cam.rx=x0+(rx1-x0)*e; cam.dist=D0+(d1-D0)*e;
    cam.px=X0+(px1-X0)*e; cam.py=Y0+(py1-Y0)*e;
    draw(); if(k<1)requestAnimationFrame(ease);
  })();
}

document.getElementById("dX").addEventListener("click",close);

addEventListener("keydown",e=>{
  if(e.key==="Escape"){
    const q=document.getElementById("q");
    /* A full-window overlay owns Escape while it is up.

       Both this handler and the overlay's are bound to window, and this one was
       registered first -- so it runs first and stopPropagation() in the overlay
       cannot undo it. Escape then closed the drawer UNDERNEATH the overlay, and
       the reader was returned to an empty page after dismissing the viewer.
       Checking for the overlay here is what keeps the two layers independent. */
    if(document.querySelector(".flowmodal, .pbkmodal")) return;
    if(RES&&RES.classList.contains("on")){RES.classList.remove("on");return}
    if(document.activeElement===q){q.blur();return}
    close();
  }
  // "/" jumps to search unless already typing somewhere
  if(e.key==="/"&&!/^(INPUT|TEXTAREA)$/.test((document.activeElement||{}).tagName||"")){
    e.preventDefault();
    const q=document.getElementById("q"); q.focus(); q.select();
    // Deferred: the document-level click handler that hides the list can run in
    // the same tick and would close what we just re-opened. Called off the
    // element because this handler sits in an earlier IIFE scope.
    setTimeout(()=>q._reopen&&q._reopen(),0);
  }
});

/* ---------- full-text search: server-side SQLite FTS5 ---------- */
const RES=document.getElementById("results");
let hlSet=null, searchSeq=0;
async function showResults(q){
  const term=q.trim();
  if(term) ctl.hidden=true, document.getElementById("filtBtn")?.setAttribute("aria-expanded","false");
  if(!term){RES.classList.remove("on");RES.innerHTML="";delete RES.dataset.term;hlSet=null;draw();return}
  const seq=++searchSeq;
  let r;
  try{ r=await API.search(term) }catch(e){ return }
  if(seq!==searchSeq) return;                       // a newer keystroke won
  const rows=(r.rows||[]).filter(x=>!x.error);
  if(!rows.length){
    RES.innerHTML=`<div class="rhead">no matches for &ldquo;${esc(term)}&rdquo;</div>
      <div class="rnone">All terms must match. Try one word, or a path fragment like <code>packages/main</code>.</div>`;
    RES.dataset.term=q; RES.classList.add("on"); hlSet=null; draw(); return;
  }
  const byStory=new Set(rows.map(x=>x.storyId));
  RES.innerHTML=`<div class="rhead">${r.n} matches in ${byStory.size} stories &middot; ${r.ms}ms</div>`+
    rows.map(h=>`<button class="rrow" data-sid="${esc(h.storyId)}" data-kind="${esc(h.kind)}" data-ref="${esc(h.ref||"")}">
      <span class="rk ${esc(h.kind)}">${esc(h.kind)}</span>
      <span class="rid mono">${esc(h.storyId)}<span class="rph" style="color:var(${PH[(byId[h.storyId]||{}).phase]||"--ink3"})">${esc((byId[h.storyId]||{}).phase||"")}</span>${h.ref&&h.ref!==h.storyId?` &middot; ${esc(h.ref)}`:""}</span>
      <span class="rsn">${h.snip||esc(h.label||"")}</span>
    </button>`).join("");
  RES.dataset.term=q;
  RES.classList.add("on");
  RES.querySelectorAll(".rrow").forEach(b=>b.addEventListener("click",async()=>{
    await open(b.dataset.sid);
    const k=b.dataset.kind, ref=b.dataset.ref;
    if(k==="finding") setTimeout(()=>jumpToFinding(ref),140);
    else if(k==="intent"||k==="evidence"||k==="item") setTimeout(()=>jumpToItem(ref),140);
    RES.dataset.dismissed="1";   // chosen, not merely blurred
    RES.classList.remove("on");
  }));
  hlSet=byStory; draw();
}
function jumpToItem(ref){
  curTab="chain"; paint();
  requestAnimationFrame(()=>{
    positionTabBar();
  const B=document.getElementById("dB");
    const id=String(ref||"").split(":")[0];
    const el=[...B.querySelectorAll(".chk")].find(d=>d.querySelector(".cid")?.textContent===id);
    if(!el){B.scrollTop=0;return}
    el.open=true; el.scrollIntoView({block:"center",behavior:"smooth"});
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
  });
}

/* ---------- controls ---------- */
const ctl=document.getElementById("ctl");
const TERMINAL=new Set(["DONE","DISCARDED"]);
function buildFilters(){
  const present=ORDER.filter(p=>ST.some(s=>s.phase===p));
  ctl.innerHTML=
    `<div class="ctlhead">
       <span>Phases</span>
       <span class="ctlacts">
         <button class="ctllink" data-all="1">All</button>
         <button class="ctllink" data-live="1">In flight</button>
       </span>
     </div>
     <div class="ctlgrid">${present.map(p=>
       `<button class="pill" data-p="${p}" aria-pressed="${active.has(p)}">
          <span class="sw" style="background:var(${PH[p]})"></span>${PHL[p]}
          <span class="n">${ST.filter(s=>s.phase===p).length}</span>
        </button>`).join("")}</div>
     <div class="ctlhead" style="margin-top:9px"><span>View</span></div>
     <div class="ctlgrid">
       <button class="pill" id="hubs" aria-pressed="${hubOnly}">Hubs only
         <span class="n">depth&nbsp;&ge;&nbsp;3</span></button>
     </div>`;
  syncFilterButton();
}
function syncFilterButton(){
  const btn=document.getElementById("filtBtn");
  const cnt=document.getElementById("filtCount");
  if(!btn||!cnt)return;
  const present=ORDER.filter(p=>ST.some(s=>s.phase===p));
  const on=present.filter(p=>active.has(p)).length;
  const all=on===present.length&&!hubOnly;
  cnt.textContent=all?"":(hubOnly?`${on}/${present.length} · hubs`:`${on}/${present.length}`);
  btn.classList.toggle("active",!all);
}
ctl.addEventListener("click",e=>{
  const link=e.target.closest(".ctllink");
  if(link){
    const present=ORDER.filter(p=>ST.some(s=>s.phase===p));
    active.clear();
    for(const p of present) if(link.dataset.all||!TERMINAL.has(p)) active.add(p);
    if(link.dataset.live) hubOnly=false;
    buildFilters(); draw(); count(); return;
  }
  const b=e.target.closest(".pill"); if(!b)return;
  if(b.id==="hubs"){
    hubOnly=!hubOnly;
    b.setAttribute("aria-pressed",String(hubOnly));
    syncFilterButton(); draw(); count(); return;
  }
  const p=b.dataset.p;
  // Plain, predictable toggle: each pill controls exactly its own phase.
  // (An earlier "solo the last one" trick made the round-trip lossy.)
  if(active.has(p)) active.delete(p); else active.add(p);
  // Re-sync every pill from the authoritative set so UI and state cannot diverge.
  for(const el of ctl.querySelectorAll(".pill[data-p]"))
    el.setAttribute("aria-pressed",String(active.has(el.dataset.p)));
  syncFilterButton();
  draw(); count();
});
// ---- collapsible filter panel ----
(function filterPanel(){
  const btn=document.getElementById("filtBtn");
  if(!btn)return;
  const setOpen=v=>{
    ctl.hidden=!v;
    btn.setAttribute("aria-expanded",String(v));
    if(v) RES.classList.remove("on");
  };
  btn.addEventListener("click",e=>{ e.stopPropagation(); setOpen(ctl.hidden) });
  document.addEventListener("click",e=>{
    if(ctl.hidden)return;
    if(!e.target.closest("#ctl")&&!e.target.closest("#filtBtn")) setOpen(false);
  });
  addEventListener("keydown",e=>{ if(e.key==="Escape"&&!ctl.hidden){ setOpen(false); e.stopPropagation() } });
})();

const qEl=document.getElementById("q");
qEl.addEventListener("input",e=>{
  delete RES.dataset.dismissed;
  const v=e.target.value;
  query=v.trim().toLowerCase();
  showResults(v);
  draw(); count();
});
qEl.addEventListener("keydown",e=>{if(e.key==="Escape"){qEl.value="";query="";hlSet=null;showResults("");draw();count()}});
/* Returning to the box brings back the results it already has.
   Clicking away only hides the dropdown -- the rows and the query text are still
   in the DOM -- so without this the reader has to delete a character and retype
   it to see the same matches again.

   A focus listener alone is NOT enough: clicking a non-focusable area (the graph
   canvas, a heading) hides the list without blurring the input, leaving the box
   focused with the list closed and no focus event left to fire. So the box's own
   mousedown re-opens too, and so does the "/" shortcut. */
function reopenResults(){
  if(!qEl.value.trim()) return;
  if(RES.dataset.dismissed) return;              // the reader picked a result
  if(RES.classList.contains("on")) return;
  // Reuse the rendered rows when they still belong to the current text; only
  // re-query if the box changed while the list was closed.
  if(RES.innerHTML.trim() && RES.dataset.term===qEl.value) RES.classList.add("on");
  else showResults(qEl.value);
}
qEl._reopen=reopenResults;                     // reachable from other scopes
qEl.addEventListener("focus",reopenResults);
qEl.addEventListener("mousedown",()=>{ setTimeout(reopenResults,0) });
document.addEventListener("click",e=>{
  if(!e.target.closest("#results")&&!e.target.closest("#q")){
    RES.classList.remove("on");
    // The highlight stays: the reader can reopen the list by clicking the box,
    // and the dimming is what shows where the matches are on the canvas. It is
    // only cleared when the drawer closes (see close()) or the query is emptied.
  }
});
function count(){
  const n=ST.filter(vis).length;
  document.getElementById("mN").textContent=n;
  const tag=document.getElementById("liveTag");
  if(n===0&&tag&&!/offline|error/.test(tag.textContent)){ tag.textContent="0 shown"; tag.className="livetag busy" }
  else if(tag&&tag.textContent==="0 shown"){ tag.textContent="live"; tag.className="livetag ok" }
  document.getElementById("mE").textContent=ED.filter(e=>byId[e.s]&&byId[e.t]&&vis(byId[e.s])&&vis(byId[e.t])).length;
}

/* no ambient auto-rotation: it re-rendered every frame and read as flicker */

/* ---------- Files tab: raw artifacts, zero truncation ---------- */
function vFiles(s,C){
  const files=(C.raw&&C.raw.files)||s.files||{};
  const names=Object.keys(files).sort();
  if(!names.length) return `<span class="emp">No files.</span>`;
  const kb=n=>n==null?"":(n<1024?n+" B":(n<1048576?(n/1024).toFixed(0)+" KB":(n/1048576).toFixed(1)+" MB"));
  let h=sec(`On-disk artifacts (${names.length})`,
    `<p class="note2">Read live from <code>${esc(C.raw?.dir||"")}</code>${C.raw?.worktree?` (worktree <code>${esc(C.raw.worktree)}</code>)`:""}. Click any file for its full contents — nothing is truncated.</p>
     <div class="filetree">${names.map(n=>{const f=files[n];
       return `<div class="filerow" data-file="${esc(n)}">
         <span class="fname">${esc(n)}</span>
         <span class="fkind">${esc(f.kind)}${f.kind==='jsonl'&&f.rows?` · ${f.rows.length} rows`:""}${f.kind==='summary'?` · ${f.count} rows`:""}</span>
         <span class="fsize">${kb(f.bytes)}</span></div>`}).join("")}</div>`);
  return h;
}
function showFile(s,C,name){
  const files=(C.raw&&C.raw.files)||{};
  const f=files[name]; if(!f)return;
  const row=document.querySelector(`#dB .filerow[data-file="${cssEsc(name)}"]`);
  if(!row)return;
  // Toggle a viewer directly beneath the clicked row. It used to render in a fixed
  // section at the bottom of the tab, so opening a file scrolled you away from it.
  const existing=row.nextElementSibling;
  if(existing&&existing.classList.contains("fileview")){
    existing.remove(); row.classList.remove("open"); return;
  }
  for(const el of document.querySelectorAll("#dB .fileview")) el.remove();
  for(const el of document.querySelectorAll("#dB .filerow.open")) el.classList.remove("open");
  const V=document.createElement("div");
  V.className="fileview";
  row.after(V); row.classList.add("open");
  let body;
  if(f.kind==='text') body=f.text||"(empty)";
  else if(f.kind==='jsonl') body=(f.rows||[]).map(r=>JSON.stringify(r,null,1)).join("\n");
  else if(f.kind==='summary') body=`// ${f.count} rows, ${f.bytes} bytes — too large to ship whole.\n`+
    `// keys: ${(f.keys||[]).join(", ")}\n\n`+JSON.stringify(f.sample,null,2);
  else body=JSON.stringify(f.data,null,2);
  V.innerHTML=`<pre class="raw">${esc(body)}</pre>`;
}

/* ---------- boot: fetch graph, then run the same 3D renderer ---------- */
(async function boot(){
  /* /story/<id> deep link: cover the window BEFORE the graph loads, so the
     reader never sees the graph page flash and then get replaced. The cover
     matches the dossier's ground and drops once the dossier is up. The id is
     escaped like all injected data in this file. */
  const dl=location.pathname.match(/^\/story\/([^/]+)$/);
  let cover=null;
  if(dl){
    cover=document.createElement("div");
    cover.className="dsrcover";
    const safeId=decodeURIComponent(dl[1]).replace(/[^\w.-]/g,"");
    cover.innerHTML=`<div><span class="mono">${safeId}</span>loading dossier<i>▍</i></div>`;
    document.body.appendChild(cover);
  }
  const dropCover=()=>{ if(cover){const c=cover;cover=null;
    c.classList.add("out");setTimeout(()=>c.remove(),260)} };
  const tag=document.getElementById("liveTag");
  const setTag=(t,cls)=>{tag.textContent=t;tag.className="livetag "+(cls||"")};
  setTag("loading","busy");
  let g;
  try{ g=await API.graph() }
  catch(e){ setTag("offline","err"); dropCover();
    document.body.insertAdjacentHTML("beforeend",
      `<div class="loading">cannot reach the server — is <code>node server.mjs</code> running?</div>`); return }
  try{ applyGraph(g) }
  catch(e){
    setTag("error","err"); dropCover();
    console.error("applyGraph failed:",e);
    document.body.insertAdjacentHTML("beforeend",
      `<div class="loading"><div style="max-width:70ch"><b>Render error</b><br>${String(e&&e.message||e)}<br><br><pre class="raw">${String(e&&e.stack||"").slice(0,900)}</pre></div></div>`);
    return;
  }
  // Engine selection. D3 + SVG is the default; the hand-rolled painter stays
  // reachable with ?gl=0 and is the automatic fallback when d3 is unavailable.
  if(new URLSearchParams(location.search).get("gl")!=="0"){
    try{
      await new Promise((res,rej)=>{
        const sc=document.createElement("script");
        sc.src="/vendor/d3.min.js";
        sc.onload=res; sc.onerror=()=>rej(new Error("bundle unavailable"));
        document.head.appendChild(sc);
      });
      const host=document.getElementById("glhost");
      const v=createGraph2DView({
        mount:host, stories:ST, edges:ED,
        phaseColor:ph=>css(PH[ph]||"--disc"),
        ground:GROUND,
        isVisible:vis,
        onNodeClick:s=>open(s.id),
        onNodeHover:s=>{ hover=s||null;
          document.getElementById("hv").textContent=s?`${s.id} · ${s.title||""}`.slice(0,90):"\u00a0";
          cv.style.cursor=s?"pointer":"" },
      });
      if(v){
        GLVIEW=v; host.style.display="block"; cv.style.display="none";
        v.resize(innerWidth,innerHeight);
        addEventListener("resize",()=>v.resize(innerWidth,innerHeight));
        draw();
      }
    }catch(e){ console.warn("D3 view unavailable, using the built-in painter:",e.message) }
  }

  setTag("live","ok");
  for(const el of document.querySelectorAll("#boot,.loading")) el.remove();

  // deep link: /story/<id> opens the dossier straight over the graph
  if(dl){
    try{ await openDossierFor(decodeURIComponent(dl[1]),false) }
    finally{ dropCover() }
  }

  // poll for changes; the server rebuilds only when the story tree hash moves
  const sigOfGraph=x=>`${x.contentHash||''}|${x.liveHash||''}`;
  let lastHash=sigOfGraph(g); lastContentHash=lastHash;
  const pollManagedAndStoryStatus=async()=>{
    try{
      const st=await fetch('/api/status').then(r=>{if(!r.ok)throw Error('status unavailable');return r.json()});
      renderManagedRunStatus(st);
      if(sigOfGraph(st)!==lastHash){
        setTag("syncing","busy");
        const ng=await API.graph();
        lastHash=sigOfGraph(ng); lastContentHash=lastHash;
        const keepId=sel, keepTab=curTab;
        const B0=document.getElementById("dB");
        const keepScroll=B0?B0.scrollTop:0;
        const sigOf=x=>x?`${x.phase}|${x.nEv}|${x.nFind}|${x.nDone}|${x.lease?.beat||""}`:"";
        const before=sigOf(byId[keepId]);
        /* Snapshot EVERY story's signature, not just the selected one, so the
           graph can flag which nodes actually moved on this poll. */
        const prevSigs=new Map(ST.map(x=>[x.id,sigOf(x)]));
        applyGraph(ng);                     // graph only — detail cache stays warm
        const touched=ST.filter(x=>prevSigs.has(x.id)&&prevSigs.get(x.id)!==sigOf(x))
                        .map(x=>x.id);
        if(touched.length&&GLVIEW&&GLVIEW.markUpdated) GLVIEW.markUpdated(touched);
        const changed = keepId && sigOf(byId[keepId])!==before;
        if(changed){
          // re-fetch THIS story first, then repaint: never paint from an empty cache
          try{
            const d=await API.story(keepId);
            CH[keepId]=projectDetail(d,byId[keepId]);
            Object.assign(byId[keepId],extractStoryFields(d,byId[keepId]));
          }catch(e){ /* keep the previous detail rather than blanking it */ }
          curStory=byId[keepId];
          if(keepTab) curTab=keepTab;
          paint();
          const B1=document.getElementById("dB");
          if(B1) B1.scrollTop=keepScroll;
        }
        setTag("updated","ok");
        setTimeout(()=>setTag("live","ok"),4000);
      }
    }catch(e){ setTag("offline","err");managedRunConnectionFailed() }
  };
  void pollManagedAndStoryStatus();
  setInterval(pollManagedAndStoryStatus,5000);
})();

})();
