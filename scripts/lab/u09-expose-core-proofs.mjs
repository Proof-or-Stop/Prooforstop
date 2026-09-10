// Test-only access to the actual bounded proof helpers, without replacing them.
import {registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
registerHooks({load(url,context,next){if(!url.endsWith('/core/story-aware-validation.js'))return next(url,context);const source=readFileSync(new URL(url),'utf8');for(const name of ['certifiedTreesEqual','declaredEnvironmentDigest'])if(!source.includes('function '+name+'('))throw new Error('new proof helper not present: '+name);return{format:'module',source:source+'\nexport { certifiedTreesEqual, declaredEnvironmentDigest };\n',shortCircuit:true};}});
