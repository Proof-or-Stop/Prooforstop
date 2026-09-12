// Diagnostic observer only: count actual parser calls and optionally replay the
// same scanner with its AST reuse disabled. No policy verdict is substituted.
const mod=require('node:module'),fs=require('node:fs'),crypto=require('node:crypto');
let calls=0;const keys=new Set(),load=mod._load;
mod._load=function(name,...args){const value=Reflect.apply(load,this,[name,...args]);if(name!=='typescript')return value;return new Proxy({}, {get(_,key){if(key!=='createSourceFile')return value[key];return function(...a){calls++;keys.add(crypto.createHash('sha256').update(String(a[0])+'\0'+String(a[1])+'\0'+JSON.stringify(a.slice(2))).digest('hex'));return value.createSourceFile(...a);};}});};
mod.registerHooks({load(url,context,next){const result=next(url,context);if(process.env.STATIC_AST_REFERENCE==='1'&&url.endsWith('/verify-validation-static-edges.mjs')){const source=String(result.source);return {...result,source:source.replace('const cached = parsedSourceCache.get(file);','const cached = undefined;')};}return result;}});
process.on('exit',()=>fs.writeFileSync(process.env.STATIC_AST_COUNTS,JSON.stringify({calls,unique:keys.size})));
