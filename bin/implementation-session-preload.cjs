'use strict';
// Cooperative inherited Node entry protection for an explicitly enrolled host.
// This is not an OS sandbox: a host that deliberately drops its environment or
// disguises a CLI as an arbitrary dynamic import is outside this transport.
const fs = require('node:fs');
const path = require('node:path');

function recognizedCli(entry) {
  const name = path.basename(entry);
  if (name === 'proof-or-stop.js' || name === 'proof-or-stop-codex.js') return true;
  if (name !== 'cli.js' || path.basename(path.dirname(entry)) !== 'dist') return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), '../package.json'), 'utf8'));
    return ['@proof-or-stop/core', '@proof-or-stop/main', 'proof-or-stop'].includes(pkg.name);
  } catch { return false; }
}

function guard() {
  const manifestPath = process.env.PROOF_OR_STOP_IMPLEMENTATION_MANIFEST;
  if (manifestPath === undefined && process.env.PROOF_OR_STOP_REQUIRE_IMPLEMENTATION_PIN !== '1') return;
  if (!process.argv[1]) return; // Ordinary Node -e tools are not CLI entries.
  let entry;
  try { entry = fs.realpathSync(path.resolve(process.argv[1])); } catch { return; }
  if (!recognizedCli(entry)) return;
  const canonical = ['proof-or-stop.js', 'proof-or-stop-codex.js'].map(name => fs.realpathSync(path.join(__dirname, name)));
  // This allowlist is anchored to the loaded guard, not caller-editable manifest
  // rows. Adding an old path to a manifest cannot enroll an unaware old CLI.
  if (!canonical.includes(entry)) throw new Error('IMPLEMENTATION_SESSION_ENTRY_REFUSED: ' + entry);
  if (!manifestPath) throw new Error('IMPLEMENTATION_SESSION_MANIFEST_REQUIRED');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entries = manifest.entrypoints ?? [{entrypoint: manifest.entrypoint, digest: manifest.digest}];
  if (manifest.schema !== 'execution-session.v1' || !Array.isArray(entries) ||
      !entries.some(row => row && row.entrypoint === entry && /^[a-f0-9]{64}$/.test(row.digest)))
    throw new Error('IMPLEMENTATION_SESSION_MANIFEST_INVALID');
  // The admitted core independently checks the actual complete implementation
  // digest. This earlier check covers old cores that cannot perform that check.
}
guard();
