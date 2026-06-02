#!/usr/bin/env node
process.env.KOALA_ACTIVITY_SOURCE = 'codex';
process.env.KOALA_ACTIVITY_RECORD_READONLY = '1';
process.env.KOALA_CODEX_ENTRYPOINT = 'local-wrapper';

if (!process.env.KOALA_ACTIVITY_SESSION) {
  process.env.KOALA_ACTIVITY_SESSION =
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
  const localKoala = join(binDir, 'koala.js');
  if (existsSync(localKoala)) {
    const koala = await import(pathToFileURL(localKoala).href);
    const localMain = koala.main || koala.default?.main;
    if (typeof localMain === 'function') {
      await localMain();
    }
  } else {
    console.error('bin/koala-codex.js did not find a sibling bin/koala.js local bootstrap.');
    console.error('');
    console.error('Recovery:');
    console.error('  - Rerun: npx koala-init --verify-codex');
    console.error('  - If this is the Koala repository, run: npm run build');
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
