#!/usr/bin/env node
/**
 * Canonical local Codex entrypoint (B-cdf6).
 *
 * `bin/lattice-codex.js` is retained as a deprecated alias that delegates here,
 * so a teammate branch (or an in-flight story) invoking the old name keeps
 * working. All behaviour lives in this file; the alias adds nothing.
 */
process.env.LATTICE_ACTIVITY_SOURCE = 'codex';
process.env.LATTICE_ACTIVITY_RECORD_READONLY = '1';
process.env.LATTICE_CODEX_ENTRYPOINT = 'local-wrapper';

if (!process.env.LATTICE_OWNER_SESSION_ADAPTER_TASK) {
  process.env.LATTICE_OWNER_SESSION_ADAPTER_TASK =
    process.env.CODEX_THREAD_ID ||
    process.env.CODEX_SESSION_ID ||
    process.env.OPENAI_SESSION_ID ||
    process.env.TERM_SESSION_ID ||
    '';
}
process.env.LATTICE_OWNER_SESSION_ADAPTER_PROVIDER = 'codex';
process.env.LATTICE_OWNER_SESSION_ADAPTER_AGENT =
  process.env.LATTICE_OWNER_SESSION_ADAPTER_AGENT ||
  process.env.LATTICE_AGENT ||
  'main';
delete process.env.LATTICE_ACTIVITY_SESSION;

/**
 * Sibling bootstrap wrappers, canonical first. The deprecated `lattice.js` name
 * is kept as a fallback so this file also works in a checkout that predates the
 * rename (or in one where only the old wrapper was generated).
 */
const BOOTSTRAP_WRAPPERS = ['proof-or-stop.js', 'lattice.js'];

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
