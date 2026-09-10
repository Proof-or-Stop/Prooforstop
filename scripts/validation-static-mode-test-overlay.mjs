import fs from 'node:fs';import path from 'node:path';import {syncBuiltinESMExports} from 'node:module';
const original=fs.readFileSync;const target=process.env.U18_MUTATION_SOURCE;const bytes=process.env.U18_MUTATION_BYTES;
fs.readFileSync=function(file,...args){if(target && path.resolve(String(file))===target)return original.call(this,bytes,...args);return original.call(this,file,...args);};syncBuiltinESMExports();
