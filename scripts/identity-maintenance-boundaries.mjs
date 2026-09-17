import {createHash} from 'node:crypto';
import {findRuntimeArtifactEntry} from '../packages/main/dist/core/runtime-artifact-registry.js';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

// This is the existing registry's deny-only historical cache classification.
// It grants neither legacy reads nor a general exemption for Story evidence.
export function isRetiredGeneratedCache(path){
  const row=findRuntimeArtifactEntry(path);
  return row?.id==='retired-generated-cache-deny-only' && row.materialHash==='exclude';
}

/** New release entries may precede the exact immutable historical body. */
export function changelogPreservesHistory(frozen,current){
  const header=Buffer.from('# Changelog\n\n');
  if(!frozen.subarray(0,header.length).equals(header)||!current.subarray(0,header.length).equals(header))return false;
  if(current.equals(frozen))return true;
  const history=frozen.subarray(header.length);
  const offset=current.length-history.length;
  if(offset<=header.length||!current.subarray(offset).equals(history))return false;
  const insertion=current.subarray(header.length,offset).toString('utf8');
  // Only the new release section changes; duplicating or editing any historical
  // body is refused. No old byte baseline or record is rewritten.
  return /^## (?:Lab [^\n]+ - v\d+\.\d+\.\d+ - \d{4}-\d{2}-\d{2}|\[?v?\d+\.\d+\.\d+)/u.test(insertion)
    && insertion.endsWith('\n\n') && current.indexOf(history)===offset;
}

// User-authorized 2026-09-18 compaction. Only this exact replacement is admitted;
// the original frozen bytes and complete pre-compaction log must remain in Git.
export function reviewedChangelogCompaction(row,frozen,current,readHistory){
  if(row.id!=='changelog-history'||row.path!=='CHANGELOG.md'
    ||row.byteSha256!=='dfac66a15ee7761396e293e915c70b3c2d3dd5b4e1317e51b18d40c30213b2f5'
    ||sha(frozen)!==row.byteSha256)return false;
  const header=Buffer.from('# Changelog\n\n');
  const compactBodyBytes=695;
  if(current.length<header.length+compactBodyBytes)return false;
  const compact=Buffer.concat([header,current.subarray(current.length-compactBodyBytes)]);
  if(sha(compact)!=='a8c521cb6c84f20cbc216c846d51b38757dc9b85a5914adb092c9e4b128ae90d'
    ||!changelogPreservesHistory(compact,current))return false;
  try{
    const previous=readHistory('a8768173bc7488aa8fdc3ef45f1ed295cbd924c8');
    return sha(previous)==='252e0187959b1881a4e902a32be4cd05d1355fe851e60db94d922016c87c0e5d'
      &&changelogPreservesHistory(frozen,previous);
  }catch{return false;}
}

// Explicit amendment already present in main at ef854edb5a16f01dbd7f92a4f1130649d7f80e1a.
// The two edited paragraphs correct an overbroad environment-alias promise;
// both original and amended bytes remain exact Git objects. This is not a
// blanket permission to rebaseline a provenance document.
const BRAND_AMENDMENT={
  id:'brand-rename-provenance',
  path:'docs/requirements/decisions/brand-rename-mapping.md',
  before:'b1d68fcefee481229d3cca312a450922714ade947666817b34598ae202289154',
  after:'9cb6dc795b1b81e4895651a67a4cd043029d2be8f6a480e6ad1f097182686448',
};

export function reviewedProvenanceAmendment(row,frozen,current){
  return row.id===BRAND_AMENDMENT.id && row.path===BRAND_AMENDMENT.path
    && row.byteSha256===BRAND_AMENDMENT.before
    && sha(frozen)===BRAND_AMENDMENT.before && sha(current)===BRAND_AMENDMENT.after;
}

// One immutable descriptor in the existing bootstrap-lock reproduction names
// archived candidate evidence. It is not an executable legacy writer. Both its
// exact occurrence and complete reproduction source stay bound.
export const MAINTENANCE_SCHEMA_PROVENANCE_ROWS=Object.freeze([Object.freeze({
  id:'archived-bootstrap-evidence-descriptor',class:'provenance_bytes',
  path:'packages/main/tests/red/red-bcae-bootstrap-reader-lock.mjs',
  token:['lat','tice.evidence.v1'].join(''),expectedOccurrences:1,
  contextSha256:'55d993c64eda25355f0c7733a54e8f38187231abd2f92199f2aff43cc0a3d246',
  reason:'Exact schema label of byte-bound archived candidate evidence used by the bootstrap reproduction; not a current producer or read permission.',
  disposition:'frozen',verificationCommand:'internal:verify-exact-frozen-occurrence',
  expectedVerification:'PASS exact archived evidence descriptor',
})]);
export const MAINTENANCE_SCHEMA_WITNESSES=Object.freeze([Object.freeze({
  path:'packages/main/tests/red/red-bcae-bootstrap-reader-lock.mjs',
  sha256:'1022aad78dd436672ed3af53517fdcbc1371b30106a8900ded27cfc38fceeb6e',
})]);
