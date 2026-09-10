import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const repo=realpathSync(process.argv[2]??fileURLToPath(new URL('..',import.meta.url)));
const {preflightManagedProviderState}=await import(pathToFileURL(join(repo,'packages/main/dist/core/managed-review-provider-state.js')).href);
const root=realpathSync(mkdtempSync(join(tmpdir(),'managed-provider-state-')));
try {
 writeFileSync(join(root,'auth.json'),JSON.stringify({OPENAI_API_KEY:'synthetic-key'}));
 writeFileSync(join(root,'config.toml'),'# Supported file store\n"cli_auth_credentials_store" = "file" # quoted TOML key\n');
 assert.equal(preflightManagedProviderState('codex',{CODEX_HOME:root}).host,'codex');
 writeFileSync(join(root,'auth.json'),JSON.stringify({tokens:{access_token:'synthetic-access',refresh_token:'synthetic-refresh',id_token:'synthetic-id'}}));
 assert.equal(preflightManagedProviderState('codex',{CODEX_HOME:root}).host,'codex');
 writeFileSync(join(root,'settings.json'),'{}');
 assert.equal(preflightManagedProviderState('claude',{CLAUDE_CONFIG_DIR:root,ANTHROPIC_API_KEY:'synthetic-key'}).credentials,null);
 writeFileSync(join(root,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'synthetic-access',refreshToken:'synthetic-refresh'}}));
 assert.ok(preflightManagedProviderState('claude',{CLAUDE_CONFIG_DIR:root}).credentials);
 console.log('PASS supported file/token credentials, quoted file TOML/comments, Claude environment credentials');
} finally {rmSync(root,{recursive:true,force:true});}
