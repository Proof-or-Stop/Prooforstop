import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url),root=process.cwd();
const module=await import(pathToFileURL(process.env.PROOF_OR_STOP_TEST_PLAYWRIGHT_MODULE||require.resolve('playwright')));
const {chromium}=module.default??module;
const source=fs.readFileSync(path.join(root,'packages/graph/src/shells/web/app.js'),'utf8').split('/* ---------- project raw story files')[0];
const terminal=i=>({runId:'run-'+i,storyId:'B-history',host:'codex',state:'completed',stage:{number:4,total:4,name:'terminal'},durationEstimate:{kind:'unavailable'},terminal:{state:'completed',digest:'d-'+i,terminalAt:'2026-09-05T00:00:00Z'}});
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const context=await browser.newContext();await context.route('http://notification.test/**',route=>route.fulfill({contentType:'text/html',body:'<div id="managedRunsList"></div><div id="managedRunsConnection"></div><div id="managedRunNotifications"></div>'}));
 const page=await context.newPage();
 const load=async()=>{await page.goto('http://notification.test/');await page.addScriptTag({content:source});};
 const render=async runs=>page.evaluate(runs=>renderManagedRunStatus({root:'/fixture',managedRuns:{runs,diagnostics:[]}}),runs);
 await load();const history=Array.from({length:270},(_,i)=>terminal(i));await render(history);
 assert.equal(await page.locator('.managed-run-row').count(),270,'all history remains in list');
 assert.equal(await page.locator('.managed-run-toast').count(),0,'HISTORICAL_TERMINALS_MUST_NOT_FLOOD_ON_OPEN');
 const updated=[...history,...Array.from({length:20},(_,i)=>terminal(i+270))];await render(updated);
 assert.equal(await page.locator('.managed-run-toast').count(),1,'batch transitions are summarized');
 assert.match(await page.locator('.managed-run-toast').innerText(),/20/);
 await render(updated);assert.equal(await page.locator('.managed-run-toast').count(),1,'poll does not duplicate');
 for(let i=290;i<295;i++){updated.push(terminal(i));await render(updated);}
 assert.equal(await page.locator('.managed-run-toast').count(),3,'bounded visible notifications');
 await page.waitForFunction(()=>document.querySelectorAll('.managed-run-toast').length===0,{timeout:12000});
 await load();await render(updated);assert.equal(await page.locator('.managed-run-toast').count(),0,'reload remains silent');
 await page.evaluate(()=>Object.defineProperty(document,'hidden',{configurable:true,value:true}));updated.push(terminal(400));await render(updated);assert.equal(await page.locator('.managed-run-toast').count(),0);
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});assert.equal(await page.locator('.managed-run-toast').count(),1,'new background completion delivered on visibility');
 await page.locator('.managed-run-toast button').click();assert.equal(await page.locator('.managed-run-toast').count(),0);
 await context.clearCookies();await load();await page.evaluate(()=>Object.defineProperty(window,'localStorage',{get(){throw Error('disabled')},configurable:true}));await render(history);assert.equal(await page.locator('.managed-run-toast').count(),0);await render(updated);assert.equal(await page.locator('.managed-run-toast').count(),1);await render(updated);assert.equal(await page.locator('.managed-run-toast').count(),1,'memory fallback deduplicates');
 console.log('MANAGED_HISTORY_SILENT_LIVE_BATCH_BOUNDED_AUTODISMISS_BROWSER_PASS');
}finally{await browser.close();}
