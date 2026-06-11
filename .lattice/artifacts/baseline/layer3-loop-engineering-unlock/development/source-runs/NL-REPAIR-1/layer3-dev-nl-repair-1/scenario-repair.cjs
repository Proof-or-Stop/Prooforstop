const { existsSync } = require('node:fs');
const marker = process.argv[2];
if (!existsSync(marker)) { console.error('missing repair marker'); process.exit(1); }
console.log('repair marker accepted');
