#!/usr/bin/env node
process.env.LATTICE_ACTIVITY_SOURCE = 'codex';
process.env.LATTICE_ACTIVITY_RECORD_READONLY = '1';
process.env.LATTICE_CODEX_ENTRYPOINT = 'local-wrapper';

if (!process.env.LATTICE_ACTIVITY_SESSION) {
  process.env.LATTICE_ACTIVITY_SESSION =
    process.env.CODEX_SESSION_ID ||
    process.env.OPENAI_SESSION_ID ||
    process.env.TERM_SESSION_ID ||
    '';
}

async function main() {
  const [{ existsSync }, { dirname, join }, { pathToFileURL }] = await Promise.all([
    import('node:fs'),
    import('node:path'),
    import('node:url'),
  ]);
  const binDir = dirname(process.argv[1] || '.');
  const localLattice = join(binDir, 'lattice.js');
  if (existsSync(localLattice)) {
    const lattice = await import(pathToFileURL(localLattice).href);
    const localMain = lattice.main || lattice.default?.main;
    if (typeof localMain === 'function') {
      await localMain();
    }
  } else {
    console.error('bin/lattice-codex.js did not find a sibling bin/lattice.js local bootstrap.');
    console.error('');
    console.error('Recovery:');
    console.error('  - Rerun: lattice init --verify-codex');
    console.error('  - If this is the Lattice repository, run: npm run build');
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
