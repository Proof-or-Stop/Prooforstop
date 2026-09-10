import {registerHooks} from 'node:module';import {readFileSync} from 'node:fs';
registerHooks({load(url,context,next){if(!url.endsWith('/tasks/quorum-submit-smoke.js'))return next(url,context);let source=readFileSync(new URL(url),'utf8');const target="function check(name, fn) {";if(source.split(target).length!==2)throw new Error('check wrapper anchor changed');source=source.replace(target,`let u17ReachedTarget=false;
function check(name, fn) {
if(u17ReachedTarget)return;
console.log('U17_PREFIX_BEGIN '+name);const u17Start=performance.now();
try {fn();}catch(error){console.error('U17_PREFIX_FAIL '+name);throw error;}
passed++;console.log('U17_PREFIX_PASS '+JSON.stringify({name,durationMs:performance.now()-u17Start}));
if(name==='emits exactly rounds x 2 verdicts after current reviewer passes'){u17ReachedTarget=true;console.log('U17_ORIGINAL_TARGET_PASS');}
return;
`);return{format:'module',source,shortCircuit:true};}});
