#!/usr/bin/env node
/**
 * Canonical local Codex entrypoint (B-cdf6).
 *
 * B-cc10 CHK-006 REMOVED the deprecated `bin/proof-or-stop-codex.js` alias that used to
 * delegate here. This is the sole local Codex entrypoint; there is no old name to
 * fall back to, so an invocation of the removed alias now fails loudly rather than
 * silently resolving. See CHANGELOG.md for the announcement and replacements.
 */
// Canonical-only environment helpers. The clean break deliberately carries no
// retired environment alias or fallback.
function setEnv(suffix, value) {
  process.env['PROOF_OR_STOP_' + suffix] = value;
}
function readEnv(suffix) {
  return process.env['PROOF_OR_STOP_' + suffix];
}
function deleteEnv(suffix) {
  delete process.env['PROOF_OR_STOP_' + suffix];
}

setEnv('ACTIVITY_SOURCE', 'codex');
setEnv('ACTIVITY_RECORD_READONLY', '1');
setEnv('CODEX_ENTRYPOINT', 'local-wrapper');

if (!readEnv('OWNER_SESSION_ADAPTER_TASK')) {
  setEnv('OWNER_SESSION_ADAPTER_TASK',
    process.env.CODEX_THREAD_ID ||
    process.env.CODEX_SESSION_ID ||
    process.env.OPENAI_SESSION_ID ||
    process.env.TERM_SESSION_ID ||
    '');
}
setEnv('OWNER_SESSION_ADAPTER_PROVIDER', 'codex');
setEnv('OWNER_SESSION_ADAPTER_AGENT',
  readEnv('OWNER_SESSION_ADAPTER_AGENT') || readEnv('AGENT') || 'main');
deleteEnv('ACTIVITY_SESSION');

/**
 * Sibling bootstrap wrapper. B-cc10 CHK-006 removed the deprecated `proofOrStop.js`
 * fallback: it named a file this repository no longer ships, so keeping it in the
 * search list could only mask a genuinely broken checkout behind a stale name.
 */
const BOOTSTRAP_WRAPPERS = ['proof-or-stop.js'];

export async function main() {
  const [{ existsSync }, { dirname, join }, { pathToFileURL }] = await Promise.all([
    import('node:fs'),
    import('node:path'),
    import('node:url'),
  ]);
  const binDir = dirname(process.argv[1] || '.');

  for (const wrapper of BOOTSTRAP_WRAPPERS) {
    const candidate = join(binDir, wrapper);
    if (!existsSync(candidate)) continue;
    const bootstrap = await import(pathToFileURL(candidate).href);
    const localMain = bootstrap.main || bootstrap.default?.main;
    if (typeof localMain === 'function') {
      await localMain();
      return;
    }
    // The wrapper exists but exposes no main(): importing it already ran the
    // bootstrap as a side effect, which is the shape bin/proof-or-stop.js has.
    return;
  }

  console.error(
    'bin/proof-or-stop-codex.js did not find a sibling bootstrap wrapper ' +
      `(looked for: ${BOOTSTRAP_WRAPPERS.join(', ')}).`,
  );
  console.error('');
  console.error('Recovery:');
  console.error('  - Rerun: proof-or-stop init --verify-codex');
  console.error('  - If this is the Proof-or-Stop repository, run: npm run build');
  process.exit(1);
}

main().catch(error => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
