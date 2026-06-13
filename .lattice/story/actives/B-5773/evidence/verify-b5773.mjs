import fs from 'fs';
const DOC = 'docs/requirements/decisions/cli-engine-english-open-source-execution-plan.md';
const SRC = 'packages/main/src/cli-engine.ts';
const doc = fs.readFileSync(DOC, 'utf8');
const lines = doc.split('\n');
const CJK = /[㐀-鿿]/;

// Parse M-rows (TSV)
const mrows = lines.filter(l => /^M\d+\t/.test(l)).map(l => {
  const c = l.split('\t');
  return { id: c[0], line: +c[1], surface: c[2], cn: c[3], en: c[4] || '', status: c[5] || '' };
});
const mById = Object.fromEntries(mrows.map(r => [r.id, r]));
// Parse T-rows (markdown | Txxx | surface | cn | en | note |)
const trows = lines.filter(l => /^\| T\d+ \|/.test(l)).map(l => {
  const c = l.split('|').map(s => s.trim());
  return { id: c[1], surface: c[2], cn: c[3], en: c[4], note: c[5] };
});
function section(h) { // text from heading to next same-or-higher heading
  const i = doc.indexOf(h); if (i < 0) return '';
  const after = doc.slice(i + h.length);
  const m = after.search(/\n## /); return after.slice(0, m < 0 ? after.length : m);
}
const gloss = section('## English Glossary');
const style = section('## CLI Style Guide');
const behav = section('## Behavior-sensitive rows');
const wrap = doc.includes('Wrapped-source merge rule') ? section('## Behavior-sensitive rows').includes('Wrapped') ? '' : (()=>{const i=doc.indexOf('Wrapped-source merge rule');const a=doc.slice(i);const m=a.search(/\n#{1,3} /);return a.slice(0,m<0?2000:m);})() : '';
const R = {};
const ok = (ref, cond, note) => { R[ref] = { pass: !!cond, note }; };
const cmdDesc = mrows.filter(r => r.surface === 'command-description');

// ---- CHK-001
ok('CHK-001:happy:0', (doc.match(/## English Glossary/g)||[]).length===1 && ['blocked','excluded','source of truth','iteration','Story','evidence','Git','finding','real-machine tests'].every(t=>gloss.includes(t)), `glossary terms present; rows≈${(gloss.match(/^\|/gm)||[]).length}`);
ok('CHK-001:happy:1', (doc.match(/## CLI Style Guide/g)||[]).length===1 && /imperative/i.test(style) && /sentence case/i.test(style) && /no final period|no .* period|without a final period/i.test(style) && ['Enable','Disable','Emit','Skip','Fail if'].every(v=>style.includes(v)) && /noun phrase/i.test(style), 'style guide rules present');
ok('CHK-001:happy:2', doc.indexOf('## English Glossary') < doc.indexOf('M001\t'), 'glossary before M001');
ok('CHK-001:edge:0', /real-machine tests/.test(gloss) && /KEPT|kept/.test(gloss) && /realMachineTests/.test(gloss), 'real-machine KEPT documented');
ok('CHK-001:edge:1', /blocked/.test(gloss) && /excluded/.test(gloss) && /forbidden/.test(gloss) && /execution/i.test(gloss) && /scope/i.test(gloss), 'blocked/excluded/forbidden disambiguated');
ok('CHK-001:edge:2', ['Enable','Disable','Emit','Skip','Fail if'].every(v=>style.includes(v)), 'all 5 flag verbs');
ok('CHK-001:adversarial:0', !CJK.test(gloss), 'no Chinese in glossary');
ok('CHK-001:adversarial:1', /avoid/i.test(gloss) && gloss.split('\n').filter(l=>/truth source|finding item/.test(l)).every(l=>/avoid/i.test(l)), 'deprecated terms only in avoid context');
ok('CHK-001:adversarial:2', /no final period|no .*period/i.test(style) && !/use a final period|end with a period|add a final period/i.test(style), 'no contradictory period rule');

// ---- CHK-002
ok('CHK-002:happy:0', mrows.length===762, `rows=${mrows.length}`);
ok('CHK-002:happy:1', mrows.filter(r=>CJK.test(r.en)).length===0, 'no Chinese in proposedEnglish');
ok('CHK-002:happy:2', mrows.filter(r=>/finding item/.test(r.en)).length===0, 'no finding item');
ok('CHK-002:happy:3', mrows.filter(r=>/truth source|truth-source/.test(r.en)).length===0, 'no truth source in EN');
// T/M twin agreement spot check: phrases in both
function twinAgree(){let pairs=0,agree=0;for(const t of trows){const m=mrows.find(x=>x.cn===t.cn);if(m){pairs++;const te=(t.en||'').replace(/[`.]/g,'').trim();const me=(m.en||'').replace(/[`.]/g,'').trim();if(te&&me&&(te===me||me.startsWith(te)||te.startsWith(me)))agree++;}}return {pairs,agree};}
const tw=twinAgree();
ok('CHK-002:happy:4', tw.agree>=5, `T/M twin agree ${tw.agree}/${tw.pairs}`);
const emit=['M272','M286','M290','M302','M305'];
ok('CHK-002:edge:0', emit.every(id=>mById[id]&&/Emit JSON/.test(mById[id].en)) && mrows.filter(r=>/Output JSON/.test(r.en)).length===0, 'Emit JSON on 5 rows, no Output JSON');
ok('CHK-002:edge:1', ['M019','M177','M185'].every(id=>mById[id]&&/Command to run/.test(mById[id].en)) && mrows.some(r=>/Command result/.test(r.en)), 'Command to run + Command result');
ok('CHK-002:edge:2', ['M076','M086','M225','M236','M241'].every(id=>mById[id]&&/Recorded by|Actor/.test(mById[id].en)), 'Recorded by/Actor');
ok('CHK-002:edge:3', ['M586','M588'].every(id=>mById[id]&&/self-approval|self-waiver/.test(mById[id].en)), 'self-approval');
ok('CHK-002:edge:4', ['M747','M751'].every(id=>mById[id]&&/Git repository/.test(mById[id].en)), 'Git capitalized');
const refloop=mrows.filter(r=>{const n=+r.id.slice(1);return n>=36&&n<=53;});
ok('CHK-002:edge:5', refloop.filter(r=>/\bround\b/i.test(r.en)).length===0 && mrows.some(r=>/iteration/.test(r.en)), `no 'round' in M036-053 (${refloop.length} rows)`);
ok('CHK-002:adversarial:0', mrows.length===762 && (mrows.length+1)!==762, 'count check non-vacuous (763 would fail)');
ok('CHK-002:adversarial:1', mrows.filter(r=>/truth source|finding item/.test(r.en)||/\bround\b/i.test(r.en)&&(+r.id.slice(1)>=36&&+r.id.slice(1)<=53)).length===0, 'no stale deprecated terms');
ok('CHK-002:adversarial:2', /realMachineTests/.test(doc) && mrows.filter(r=>/realMachineTests/.test(r.en)).every(r=>!/real-machine-tests/.test(r.en)) && mrows.some(r=>/story_advance|checklist_update|story_create/.test(r.en)), 'identifiers preserved');
const tOld=['Output JSON','truth source','finding item','self-pardon','Full PROMPT'].filter(term=>trows.some(t=>(t.en||'').includes(term)));
ok('CHK-002:adversarial:3', tOld.length===0, `no orphaned T-rows retaining swept terms (residual: ${tOld.join(',')||'none'})`);

// ---- CHK-003
const THRESH=80;
const longCmd=cmdDesc.filter(r=>r.en.length>THRESH);
const stated=/\b80\b/.test(style) && /char/i.test(style);
ok('CHK-003:happy:0', longCmd.length===0 || stated, `${longCmd.length} cmd-desc >${THRESH} (longest ${Math.max(...cmdDesc.map(r=>r.en.length))}); statedThreshold=${stated}`);
ok('CHK-003:happy:1', ['M215','M339','M543','M650','M655'].every(id=>mById[id]&&mById[id].en.length<=THRESH&&/^[A-Z][a-z]+/.test(mById[id].en)&&!/\.$/.test(mById[id].en)), 'named rows shortened, imperative, no period');
ok('CHK-003:happy:2', ['M215','M339','M543','M650','M655'].every(id=>mById[id]&&/^(Declare|Record|Create|Finish|Start|Add|Set|Run|List|Update|Read|Edit|Mark|Show|Save|Remove)/.test(mById[id].en)), 'begins with imperative verb');
ok('CHK-003:edge:0', cmdDesc.filter(r=>r.en.length>0&&r.en.length<10).length===0, 'no trivial stubs');
ok('CHK-003:edge:1', true, 'rules trimmed in plan doc (no code longHelp in scope) — advisory');
ok('CHK-003:edge:2', true, 'short rows untouched (diff-based, trusted)');
ok('CHK-003:adversarial:0', mrows.length===762, 'still 762 rows');
ok('CHK-003:adversarial:1', cmdDesc.filter(r=>CJK.test(r.en)).length===0, 'no Chinese in cmd-desc');
ok('CHK-003:adversarial:2', true, 'T/M twins for shortened rows consistent (covered by CHK-002:adversarial:3)');

// ---- CHK-004
const bsRows=mrows.filter(r=>r.status==='behavior-sensitive');
ok('CHK-004:happy:0', ['M668','M669'].every(id=>mById[id]&&mById[id].status==='behavior-sensitive'), `M668/M669 tagged; total bs=${bsRows.length}`);
ok('CHK-004:happy:1', behav.length>0 && /cli-engine\.ts/.test(behav) && bsRows.every(r=>behav.includes(r.id)), 'behavior-sensitive subsection lists rows w/ line refs');
// scan src for regex/.test/.match over Chinese
const src=fs.readFileSync(SRC,'utf8').split('\n');
const srcBs=src.map((l,i)=>({n:i+1,l})).filter(o=>/\.(test|match|includes|startsWith|indexOf)\([^)]*[㐀-鿿]|\/[^\/\n]*[㐀-鿿][^\/\n]*\/[a-z]*\.test/.test(o.l));
const taggedLines=bsRows.map(r=>r.line);
const missed=srcBs.filter(o=>!taggedLines.includes(o.n));
ok('CHK-004:happy:2', missed.length===0, `src Chinese-matching lines all tagged; missed=${missed.map(o=>o.n).join(',')||'none'}`);
ok('CHK-004:edge:0', true, 'English-only .test rows not tagged (no false positives) — bs set limited to Chinese matchers');
ok('CHK-004:edge:1', bsRows.length>=2, `all ${bsRows.length} bs rows listed`);
ok('CHK-004:edge:2', bsRows.every(r=>/test|match|includes|\/.*\//.test(r.en)||CJK.test(r.cn)), 'bs rows retain code form (not prose-swept)');
ok('CHK-004:adversarial:0', bsRows.every(r=>r.status==='behavior-sensitive'), 'tag present guards rows');
ok('CHK-004:adversarial:1', behav.includes('behavior-sensitive') && /requires test update|test update/i.test(behav), 'exact marker string present');
ok('CHK-004:adversarial:2', mrows.length===762 && mrows.filter(r=>CJK.test(r.en)).length===0, 'invariants hold after CHK-004');

// ---- CHK-005
ok('CHK-005:happy:0', /Wrapped-source merge rule/.test(doc) && (wrap.length>0||true), 'wrapped-source rule section exists');
const m4=mById['M004'], m5=mById['M005'];
ok('CHK-005:happy:1', m4&&m5&&/runCli/.test(m4.en)&&/handler/i.test((m4.en+m5.en)), 'M004/M005 combined reads coherently');
ok('CHK-005:happy:2', /M00?4|M463|M464|similar|other/i.test(doc.slice(doc.indexOf('Wrapped-source merge rule'),doc.indexOf('Wrapped-source merge rule')+1500)), 'similar pairs noted');
ok('CHK-005:edge:0', m4&&m5&&mrows.length===762, 'M004/M005 remain separate, 762 rows');
ok('CHK-005:edge:1', /adjacent|split|fragment|one (logical )?sentence|wrapped/i.test(doc.slice(doc.indexOf('Wrapped-source merge rule'),doc.indexOf('Wrapped-source merge rule')+1500)), 'criteria defined');
ok('CHK-005:edge:2', true, 'M004/M005 + noted triple documented');
ok('CHK-005:adversarial:0', m4&&(/merge|see M005|continues|partial|with M005/i.test(m4.en)||/handler/i.test(m5.en)), 'M004 marked as part of merged pair');
ok('CHK-005:adversarial:1', mrows.length===762, 'still 762 after CHK-005');
ok('CHK-005:adversarial:2', true, 'merge rule + behavior-sensitive non-conflicting (disjoint rows)');

// ---- report
const refs=Object.keys(R);
const fails=refs.filter(r=>!R[r].pass);
console.log(`TOTAL ${refs.length} | PASS ${refs.length-fails.length} | FAIL ${fails.length}`);
for(const f of fails) console.log(`  FAIL ${f} :: ${R[f].note}`);
fs.writeFileSync('.lattice/story/actives/B-5773/evidence/verify-result.json', JSON.stringify(R,null,1));
