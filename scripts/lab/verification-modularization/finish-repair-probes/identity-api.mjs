import fs from 'node:fs';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import {registerHooks} from 'node:module';import assert from 'node:assert/strict';
const target=pathToFileURL(resolve('scripts/identity-cutover/public-api.mjs')).href;
const direct=await import(target);const before=direct.identityCutoverReviewedContexts();
const entry=await import(pathToFileURL(resolve('scripts/verify-proof-or-stop-identity-cutover.mjs')).href);const complete=entry.identityCutoverReviewedContexts();
assert.deepEqual(before,complete,'DIRECT_IDENTITY_PUBLIC_API_MUST_RETURN_COMPLETE_CONTEXTS');
{
 const {EXACT_ALLOWLIST}=await import(pathToFileURL(resolve('scripts/identity-cutover/base-contexts.mjs')).href);const removed=EXACT_ALLOWLIST.pop();
 try{assert.throws(()=>direct.identityCutoverReviewedContexts(),/Incomplete identity context assembly/);}finally{EXACT_ALLOWLIST.push(removed);}
}
console.log('IDENTITY_PUBLIC_API_COMPLETE '+JSON.stringify({rows:before.rows.length,witnesses:before.witnesses.length,missingRowRejected:true}));
