#!/usr/bin/env node
// Explicit local host transport. This does not migrate a running foreign host,
// sign Story evidence, or grant a role/owner lease.
import {readFileSync,writeFileSync,mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {spawnSync,spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const entry=realpathSync(join(dirname(fileURLToPath(import.meta.url)),'../bin/proof-or-stop.js'));
const codexEntry=realpathSync(join(dirname(entry),'proof-or-stop-codex.js'));
const [action,target,...rest]=process.argv.slice(2);
const fail=message=>{throw new Error(message);};
if(!target || !['capture','exec'].includes(action)) fail('Usage: implementation-session.mjs capture NEW_MANIFEST | exec MANIFEST -- HOST [ARGS...]');
const manifestPath=resolve(target);
if(action==='capture') {
  if(rest.length) fail('capture does not accept extra arguments');
  // Capture is a deliberate new epoch. Never replace a rejected pin on retry.
  const env={...process.env};
  for(const key of ['PROOF_OR_STOP_IMPLEMENTATION_MANIFEST','PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN','PROOF_OR_STOP_EXPECTED_IMPLEMENTATION_DIGEST']) delete env[key];
  const result=spawnSync(process.execPath,[entry,'--implementation-identity'],{env,encoding:'utf8',maxBuffer:8*1024*1024});
  if(result.status!==0) fail(result.stderr || 'implementation capture failed');
  const identity=JSON.parse(result.stdout);
  if(identity.entrypoint!==entry || !/^[a-f0-9]{64}$/.test(identity.digest)) fail('invalid implementation observation');
  const codex=spawnSync(process.execPath,[codexEntry,'--implementation-identity'],{env,encoding:'utf8',maxBuffer:8*1024*1024});
  if(codex.status!==0) fail(codex.stderr || 'Codex implementation capture failed');
  const codexIdentity=JSON.parse(codex.stdout);
  // Both entrypoints must load the same complete implementation file inventory.
  // Their entrypoint-byte digests intentionally differ; retain both exact pins.
  if(codexIdentity.entrypoint!==codexEntry || JSON.stringify(identity.files)!==JSON.stringify(codexIdentity.files)) fail('entrypoint implementation inventories differ');
  const again=spawnSync(process.execPath,[entry,'--implementation-identity'],{env,encoding:'utf8',maxBuffer:8*1024*1024});
  if(again.status!==0 || JSON.parse(again.stdout).digest!==identity.digest) fail('runtime changed during capture');
  const entrypoints=[{entrypoint:entry,digest:identity.digest},{entrypoint:codexEntry,digest:codexIdentity.digest}];
  writeFileSync(manifestPath,JSON.stringify({schema:'execution-session.v1',entrypoint:entry,digest:identity.digest,entrypoints},null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({manifest:manifestPath,entrypoints,fileCount:identity.fileCount}));
} else {
  if(rest[0]!=='--'||rest.length<2) fail('exec requires -- HOST [ARGS...]');
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  if(manifest.schema!=='execution-session.v1'||manifest.entrypoint!==entry||!/^[a-f0-9]{64}$/.test(manifest.digest)) fail('invalid or foreign implementation manifest');
  if(!Array.isArray(manifest.entrypoints) ||
     !manifest.entrypoints.some(row=>row?.entrypoint===entry && row.digest===manifest.digest) ||
     !manifest.entrypoints.some(row=>row?.entrypoint===codexEntry && /^[a-f0-9]{64}$/.test(row.digest)))
    fail('session must enroll both canonical entrypoints; capture a new epoch');
  if(process.env.PROOF_OR_STOP_EXPECTED_IMPLEMENTATION_DIGEST!==undefined && process.env.PROOF_OR_STOP_EXPECTED_IMPLEMENTATION_DIGEST!==manifest.digest) fail('conflicting inherited implementation pin');
  const env={...process.env,PROOF_OR_STOP_IMPLEMENTATION_MANIFEST:manifestPath,
    PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN:'1'};
  // Manifest selection is per actual entrypoint. A stale/older core that ignores
  // manifests still refuses because REQUIRE is set and no standalone pin exists.
  delete env.PROOF_OR_STOP_EXPECTED_IMPLEMENTATION_DIGEST;
  const admission=spawnSync(process.execPath,[entry,'--implementation-identity'],{env,encoding:'utf8',maxBuffer:8*1024*1024});
  if(admission.status!==0) fail(admission.stderr || 'session admission refused');
  if(JSON.parse(admission.stdout).digest!==manifest.digest) fail('session admission mismatch');
  // A private PATH entry transports the selected absolute runtime into ordinary
  // owner/reviewer shell commands. Direct alternate entries still inherit the
  // required pin and are refused by the shared dispatcher.
  const shims=mkdtempSync(join(tmpdir(),'proof-or-stop-implementation-session-'));
  for(const [name,targetEntry] of [['proof-or-stop',entry],['proof-or-stop-codex',codexEntry]]) writeFileSync(join(shims,name), '#!/usr/bin/env node\n'+
    "const {spawnSync}=require('node:child_process');\n"+
    `const r=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(targetEntry)},...process.argv.slice(2)],{stdio:'inherit',env:process.env});\n`+
    "if(r.error)console.error(r.error.message);process.exit(r.status??1);\n",{mode:0o700});
  env.PATH=shims+':'+(env.PATH??'');
  try {
    const child=spawn(rest[1],rest.slice(2),{env,stdio:'inherit'});
    const forward=signal=>child.kill(signal);
    const term=()=>forward('SIGTERM'),interrupt=()=>forward('SIGINT');
    process.on('SIGTERM',term);process.on('SIGINT',interrupt);
    try {
      const outcome=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
      process.exitCode=outcome.code??1;
    } finally {process.off('SIGTERM',term);process.off('SIGINT',interrupt);}
  } finally {rmSync(shims,{recursive:true,force:true});}
}
