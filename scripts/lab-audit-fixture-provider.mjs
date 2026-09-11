// Test-only fake executables exercise the real spawn/transport/cleanup path.
// These fixtures are never independent-provider evidence for a real Lab.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function installLabAuditFixtureProviders(dir) {
  const bin = join(dir, 'audit-fixture-bin'); mkdirSync(bin, { recursive: true });
  const body = `#!/usr/bin/env node
const fs=require('node:fs');
const prompt=fs.readFileSync(0,'utf8');
const binding=JSON.parse(prompt.split('Binding: ')[1].split('\\nSchema:')[0]);
const data=JSON.parse(prompt.split('Untrusted audit input:\\n')[1]);
const mode=process.env.LAB_FIXTURE_AUDIT;
const proposal={...binding,decision:mode==='reject'?'fail':'pass',summary:'Synthetic CLI fixture verifies the transport and gate, not real independent audit.',readRefs:data.files.map(f=>f.path),findings:mode==='reject'?[{severity:'high',file:data.files[0].path,problem:'Synthetic audit rejection witness',fix:'Repair fixture input'}]:[]};
if(mode==='omit-refs')proposal.readRefs=proposal.readRefs.slice(1);
if(mode==='mutate-snapshot')fs.appendFileSync(require('node:path').join(process.cwd(),'snapshot',data.files[0].path),'!');
if(mode==='stale')proposal.head='stale-head';
if(mode==='malformed'){console.log('not-json');process.exit(0)}
const event=binding.auditorHost==='grok'?proposal:binding.auditorHost==='claude'?{type:'result',subtype:'success',is_error:false,structured_output:proposal}:{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(proposal)}};
console.log(JSON.stringify(event));
if(mode==='duplicate')console.log(JSON.stringify(event));
`;
  for (const host of ['claude','codex','grok-fixture-adapter']) { writeFileSync(join(bin,host),body); chmodSync(join(bin,host),0o755); }
  writeFileSync(join(bin,'nonexecutable-adapter'),body); chmodSync(join(bin,'nonexecutable-adapter'),0o644);
  return bin;
}
