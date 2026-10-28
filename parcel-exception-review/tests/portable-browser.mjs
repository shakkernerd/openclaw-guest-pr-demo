// Synthetic-only browser regression test; all fixtures and downloads are temporary.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { CDP, chromiumPath, until, delay } from './cdp.mjs';
import { reviewBytes } from '../review.mjs';
const require = createRequire(import.meta.url);
const { auditExports } = require('../../parcel-event-audit');
const here = dirname(fileURLToPath(import.meta.url));
const pageRoot = resolve(here, '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const temporary = await mkdtemp(join(tmpdir(), 'parcel-portable-'));
const fixturePath = join(temporary, 'synthetic-review.json');
const records = [...JSON.parse(await readFile(join(pageRoot,'example.json'))),
  {eventId:'other-delivered',parcelId:'PKG-SECOND',type:'delivered',occurredAt:'2026-10-28T12:00:00Z'},
  {eventId:'other-cancelled',parcelId:'PKG-SECOND',type:'cancelled',occurredAt:'2026-10-28T11:30:00Z'}];
const fixture = Buffer.from(JSON.stringify(records,null,2)+'\n');
await writeFile(fixturePath,fixture);
const html = await readFile(join(pageRoot, 'review.html'), 'utf8');
const evidence = join(temporary,'results'); await mkdir(evidence);
const standalone = join(temporary, 'alone'); await mkdir(standalone);
await copyFile(join(pageRoot, 'review.html'), join(standalone, 'review.html'));
assert.deepEqual(await readdir(standalone), ['review.html']);
const escapeHTML = text => text.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const expectedTotals = { inputRecords:11, uniqueEvents:10, retryDuplicates:1, parcels:5, conflictingEventIds:1, contradictoryParcels:2, exceptions:3 };
const expected = reviewBytes(fixture, 'synthetic-review.json').report;
assert.deepEqual(expected.summary, expectedTotals);
let chrome, browser;
const clients = [];
const outcomes = [];
let count = 0;
const pass = (surface, detail) => { count++; console.log('PASS [' + surface + '] ' + detail); };
try {
  const executable = await chromiumPath();
  chrome = spawn(executable, ['--headless','--no-sandbox','--disable-dev-shm-usage','--disable-background-networking','--disable-component-update','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir=' + join(temporary,'profile'),'about:blank'], { stdio:'ignore', env:{ ...process.env, XDG_CACHE_HOME:join(temporary,'cache'), XDG_CONFIG_HOME:join(temporary,'config') } });
  let spawnError; chrome.on('error', error => { spawnError = error; });
  const endpoint = await until(async () => {
    if (spawnError) throw spawnError;
    if (chrome.exitCode !== null) throw new Error('Chromium exited: ' + chrome.exitCode);
    try { return await readFile(join(temporary,'profile/DevToolsActivePort'),'utf8'); } catch { return null; }
  }, 'Chromium startup');
  const [port, wsPath] = endpoint.trim().split('\n');
  browser = await CDP.open('ws://127.0.0.1:' + port + wsPath);
  const version = await browser.send('Browser.getVersion');

  for (const surface of [
    { name:'saved-file', sandbox:null, functional:true, downloads:true },
    { name:'opaque-preview', sandbox:'allow-scripts allow-downloads', functional:true, downloads:true },
    { name:'scripts-blocked', sandbox:'allow-downloads', functional:false, downloads:true },
    { name:'host-csp-blocked', sandbox:'allow-scripts allow-downloads', csp:true, functional:false, downloads:true },
    { name:'downloads-blocked', sandbox:'allow-scripts', functional:true, downloads:false },
  ]) {
    const output = join(evidence,surface.name); await mkdir(output);
    const downloads = join(output,'downloads'); await mkdir(downloads);
    await browser.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads,eventsEnabled:true});
    const { targetId } = await browser.send('Target.createTarget',{url:'about:blank'});
    const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    let page = await CDP.open(targets.find(target => target.id === targetId).webSocketDebuggerUrl); clients.push(page);
    const displayPage = page;
    const childTargets = [];
    page.on('Target.attachedToTarget', target => { if (target.targetInfo.type === 'iframe') childTargets.push(target); });
    await page.send('Target.setAutoAttach', { autoAttach:true, waitForDebuggerOnStart:true, flatten:true });
    let contexts = new Map();
    const requests = [], errors = [], security = [];
    const wire = client => {
    const frameContexts = new Map();
    client.on('Runtime.executionContextCreated', ({context}) => frameContexts.set(context.id,context));
    client.on('Runtime.executionContextDestroyed', ({executionContextId}) => frameContexts.delete(executionContextId));
    client.on('Runtime.executionContextsCleared', () => frameContexts.clear());
    client.on('Runtime.exceptionThrown', item => errors.push(item.exceptionDetails.exception?.description || item.exceptionDetails.text));
    client.on('Network.requestWillBeSent', item => requests.push({url:item.request.url,method:item.request.method}));
    client.on('Log.entryAdded', ({entry}) => { if (entry.source === 'security') security.push(entry.text); });
    return frameContexts;
    };
    contexts = wire(page);
    await page.send('Runtime.enable'); await page.send('Page.enable'); await page.send('Network.enable'); await page.send('Log.enable');
    await page.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    // Offline mode is applied before loading. There is no HTTP page/asset server.
    await page.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
    let url;
    if (surface.sandbox === null) url = pathToFileURL(join(standalone,'review.html')).href;
    else {
      const wrapper = '<!doctype html><html><head>' + (surface.csp ? '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'">' : '') + '</head><body><iframe title="Portable contained preview" sandbox="' + surface.sandbox + '" style="width:100%;height:2400px;border:0" srcdoc="' + escapeHTML(html) + '"></iframe></body></html>';
      const filename = join(temporary,surface.name + '.html'); await writeFile(filename,wrapper); url = pathToFileURL(filename).href;
    }
    await page.send('Page.navigate',{url});
    let frameId, isolatedFrame = false;
    let contextId = await until(async () => {
      if (surface.sandbox !== null && childTargets.length && !isolatedFrame) {
        const target = childTargets[0];
        page = displayPage.session(target.sessionId); clients.push(page);
        contexts = wire(page); isolatedFrame = true;
        await page.send('Runtime.enable'); await page.send('Page.enable'); await page.send('Network.enable'); await page.send('Log.enable');
        await page.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
        await page.send('Runtime.runIfWaitingForDebugger');
      }
      const {frameTree} = await page.send('Page.getFrameTree');
      frameId = surface.sandbox === null || isolatedFrame ? frameTree.frame.id : frameTree.childFrames?.[0]?.frame.id;
      return [...contexts.values()].find(context => context.auxData?.frameId === frameId && context.auxData?.isDefault)?.id;
    }, surface.name + ' default frame context');
    const evaluate = async expression => {
      const value = await page.send('Runtime.evaluate',{expression,contextId,awaitPromise:true,returnByValue:true,userGesture:true});
      if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
      return value.result.value;
    };
    const text = id => evaluate('document.getElementById(' + JSON.stringify(id) + ').textContent');
    const click = id => evaluate('document.getElementById(' + JSON.stringify(id) + ').click()');
    const input = (id,value) => evaluate('(() => {const el=document.getElementById(' + JSON.stringify(id) + ');el.value=' + JSON.stringify(value) + ';el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input",{bubbles:true}));})()');
    const screenshot = async name => {
      const image = await displayPage.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
      await writeFile(join(output,name + '.png'),Buffer.from(image.data,'base64'),{flag:'wx'});
    };
    await until(() => evaluate('document.readyState === "complete" && !!document.getElementById("file")'),surface.name + ' document');
    assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'), 'rgb(244, 246, 248)');
    assert.equal(await evaluate('document.styleSheets.length'),1);
    if (surface.sandbox !== null) {
      assert.equal(await evaluate('self.origin'), 'null');
      assert.equal(await evaluate('(() => {try { void parent.document; return false; } catch(error) {return error.name === "SecurityError";}})()'),true);
    }
    const state = { name:surface.name, sandbox:surface.sandbox, parentScriptCSPBlocked:!!surface.csp, offline:true, stylingVerified:true, opaqueOrigin:surface.sandbox !== null };
    if (!surface.functional) {
      assert.equal(await evaluate('document.getElementById("portable-startup").hidden'), false);
      assert.match(await text('portable-startup'),/Review engine has not started/);
      assert.equal(await evaluate('document.getElementById("file").disabled'),true);
      assert.equal(await evaluate('document.getElementById("review").hidden'),true);
      await screenshot('visible-startup-warning');
      pass(surface.name,'blocked scripting has visible warning and disabled file chooser, not silent loading');
      outcomes.push({...state,engineReady:false,visibleStartupWarning:true,downloadFiles:await readdir(downloads)});
      await writeFile(join(output,'verification.json'),JSON.stringify(outcomes.at(-1),null,2)+'\n',{flag:'wx'});
      await browser.send('Target.closeTarget',{targetId}); continue;
    }
    await until(() => evaluate('document.documentElement.dataset.portableReady === "true"'),surface.name + ' engine readiness');
    assert.equal(await evaluate('document.getElementById("portable-startup").hidden'),true);
    assert.equal(await evaluate('document.getElementById("file").disabled'),false);
    assert.equal(await evaluate('document.getElementById("download").disabled'),true);
    pass(surface.name,'styled offline document initializes with no sibling assets or module fetches');
    const uploadPath = async path => {
      const node = await page.send('Runtime.evaluate',{expression:'document.getElementById("file")',contextId,returnByValue:false});
      await page.send('DOM.setFileInputFiles',{objectId:node.result.objectId,files:[path]});
      await until(async () => !(await text('file-status')).startsWith('Reading'),surface.name + ' file result');
    };
    const fixtureUpload = async (name,bytes) => { const path=join(temporary,surface.name+'-'+name); await writeFile(path,bytes); await uploadPath(path); };
    const selectedCount = () => evaluate('document.querySelectorAll("#rows input:checked").length');
    const choose = parcel => evaluate('(() => {const row=[...document.querySelectorAll("#rows tr")].find(row=>row.textContent.includes(' + JSON.stringify(parcel) + '));if(!row)throw new Error("Missing row");row.querySelector("input").click();})()');
    const inspect = parcel => evaluate('(() => {const row=[...document.querySelectorAll("#rows tr")].find(row=>row.textContent.includes(' + JSON.stringify(parcel) + '));row.querySelector("button").click();})()');
    const totals = () => evaluate('Object.fromEntries([...document.querySelectorAll("[data-total]")].map(el=>[el.dataset.total,Number(el.querySelector("strong").textContent)]))');
    const downloadBytes = filename => until(async () => {try {return await readFile(join(downloads,filename));}catch{return null;}},surface.name+' download '+filename);

    await uploadPath(fixturePath);
    assert.equal(await evaluate('document.getElementById("review").hidden'),false);
    assert.deepEqual(await totals(),expectedTotals);
    assert.equal(await selectedCount(),0);
    await input('parcel-filter','PKG-NORTH');
    assert.equal(await text('match-count'),'1 of 3 exceptions match');
    await inspect('PKG-NORTH');
    for(const value of ['PKG-NORTH','PKG-SOUTH','Original record #2','Original record #6','2026-10-28T09:30:00Z','no winner']) assert.ok((await text('inspector')).includes(value),value);
    await screenshot('cross-parcel-conflict');
    await choose('PKG-NORTH');
    await input('parcel-filter',''); await input('issue-filter','DELIVERY_CANCELLATION_CONTRADICTION');
    assert.equal(await text('match-count'),'2 of 3 exceptions match');
    assert.equal(await selectedCount(),0);
    assert.match(await text('selection-count'),/^1 selected · 1 hidden/);
    await inspect('PKG-SECOND');
    for(const value of ['Original record #10','Original record #11','2026-10-28T12:00:00Z','2026-10-28T11:30:00Z','Neither overrides']) assert.ok((await text('inspector')).includes(value),value);
    await inspect('PKG-HARBOR');
    for(const value of ['Original record #1','Original record #5','harbor-create','Original record #3','Original record #7','Neither overrides']) assert.ok((await text('inspector')).includes(value),value);
    await choose('PKG-HARBOR');
    assert.equal(await selectedCount(),1); assert.match(await text('selection-count'),/^2 selected · 1 hidden/);
    assert.deepEqual(await totals(),expectedTotals);
    await screenshot('deliberate-selection');
    pass(surface.name,'synthetic totals, complete conflict/contradiction evidence and deliberate hidden selection');
    await click('download');
    if(!surface.downloads) {
      await delay(1800);
      assert.deepEqual(await readdir(downloads),[]);
      assert.match(await evaluate('document.body.textContent'),/If a download does not appear, open the saved review.html directly/);
      assert.equal(await evaluate('document.getElementById("original").hidden'),false);
      await evaluate('document.getElementById("original").open=true'); await click('download-original'); await delay(1000);
      assert.deepEqual(await readdir(downloads),[]);
      pass(surface.name,'sandbox download prohibition is respected; no success claim or attempted bypass');
      outcomes.push({...state,engineReady:true,totals:await totals(),downloadsBlocked:true,downloadFiles:[],securityMessages:security});
      await writeFile(join(output,'verification.json'),JSON.stringify(outcomes.at(-1),null,2)+'\n',{flag:'wx'});
      await browser.send('Target.closeTarget',{targetId}); continue;
    }
    const selected = await downloadBytes('selected-exceptions.json');
    assert.deepEqual(JSON.parse(selected),expected.exceptions.slice(0,2));
    assert.ok(!selected.toString().includes('PKG-SECOND'));
    assert.equal(selected.toString(),JSON.stringify(expected.exceptions.slice(0,2),null,2)+'\n');
    const upstream = auditExports([{filename:'synthetic-review.json',text:JSON.parse(fixture).map(record=>JSON.stringify(record)).join('\n')}]);
    const stripped = JSON.parse(JSON.stringify(JSON.parse(selected),(key,value)=>key==='sources'?value.map(source=>({filename:source.filename,line:source.recordIndex,occurredAt:source.occurredAt})):value));
    assert.deepEqual(stripped,upstream.exceptions.slice(0,2));
    let sources=0;
    for(const issue of JSON.parse(selected)) for(const event of issue.variants||[...issue.delivered,...issue.cancelled]) for(const source of event.sources){sources++; assert.equal(source.rawJSON,fixture.subarray(source.byteStart,source.byteEnd).toString('utf8'));}
    assert.equal(sources,5);
    await evaluate('document.getElementById("original").open=true');
    await until(()=>evaluate('document.getElementById("original-text").textContent.length>0'),'original text');
    assert.equal(await text('original-text'),fixture.toString('utf8'));
    await click('download-original');
    const original = await downloadBytes('original-synthetic-review.json'); assert.deepEqual(original,fixture);
    await evaluate('document.getElementById("original").open=false');
    pass(surface.name,'real selected download has exactly two chosen exceptions and five raw records; original download is byte-identical');

    await click('clear-filters'); await input('search','未登録');
    assert.equal(await text('match-count'),'0 of 3 exceptions match'); assert.match(await text('selection-count'),/^2 selected · 2 hidden/);
    await click('clear-filters'); assert.equal(await selectedCount(),2);
    await click('clear-selection'); assert.equal(await evaluate('document.getElementById("download").disabled'),true);
    const invalids = [
      ['malformed.json','[{},]'],
      ['duplicate.json','[{"eventId":"a","event\\u0049d":"b","parcelId":"P","type":"created","occurredAt":"2026-10-28T08:00:00Z"}]'],
      ['utf8.json',Buffer.from([91,0xc0,0xaf,93])],
      ['late-invalid.json',JSON.stringify([...JSON.parse(fixture),{eventId:'bad',parcelId:'CLEAN',type:'created',occurredAt:'2026-02-30T08:00:00Z'}])],
    ];
    for(const [name,bytes] of invalids){
      await uploadPath(fixturePath); await choose('PKG-NORTH');
      await fixtureUpload(name,bytes);
      assert.equal(await evaluate('document.getElementById("error").hidden'),false,name);
      assert.equal(await evaluate('document.getElementById("review").hidden'),true,name);
      assert.equal(await evaluate('document.querySelectorAll("#totals > *, #rows > *, #inspector > *").length'),0,name);
      assert.equal(await evaluate('document.getElementById("download").disabled'),true,name);
      assert.match(await text('file-status'),/Previous results and selection have been cleared/);
      if(name==='late-invalid.json')await screenshot('invalid-file-no-stale-review');
    }
    pass(surface.name,'invalid JSON, escaped duplicate keys, invalid UTF-8 and invalid later records reject visibly without stale results');
    await uploadPath(fixturePath); assert.match(await text('selection-count'),/^0 selected/);
    await fixtureUpload('empty.json','[]'); assert.equal(await evaluate('document.getElementById("review").hidden'),false);
    assert.match(await text('no-matches'),/not shipment authorization/);
    await click('example'); await until(async()=> (await text('file-status')).startsWith('Validated synthetic-example.json'),'embedded example');
    assert.equal((await totals()).inputRecords,9);
    await click('download-example');
    assert.deepEqual(await downloadBytes('synthetic-events.json'),await readFile(join(pageRoot,'example.json')));
    pass(surface.name,'same-file reload, empty valid array, embedded example and embedded example download work offline');

    // Two overlapping reads, then cancellation, without changing application code.
    await evaluate('globalThis.realArrayBuffer=File.prototype.arrayBuffer;File.prototype.arrayBuffer=async function(){if(this.name.endsWith("slow.json"))await new Promise(resolve=>setTimeout(resolve,250));return realArrayBuffer.call(this);}');
    const slow=join(temporary,surface.name+'-slow.json');await writeFile(slow,fixture);
    const setInput=async path=>{const result=await page.send('Runtime.evaluate',{expression:'document.getElementById("file")',contextId});await page.send('DOM.setFileInputFiles',{objectId:result.result.objectId,files:[path]});};
    await setInput(slow); await fixtureUpload('newer.json','[]'); await delay(350);
    assert.ok((await text('file-status')).includes('newer.json'));assert.equal((await totals()).inputRecords,0);
    await setInput(slow);await click('reset');await delay(350);
    assert.equal(await evaluate('document.getElementById("review").hidden'),true); assert.equal(await evaluate('document.getElementById("empty").hidden'),false);
    await evaluate('File.prototype.arrayBuffer=realArrayBuffer');
    pass(surface.name,'newer load and clear review invalidate pending file reads');

    const badId='<img src=x onerror=globalThis.injected=true>';
    const one={eventId:'x',parcelId:badId,type:'delivered',occurredAt:'2026-10-28T08:00:00Z'};
    await fixtureUpload('markup.json',JSON.stringify([one,{...one,type:'cancelled'}]));
    assert.equal(await evaluate('document.querySelectorAll("#rows img,#inspector img").length'),0);
    assert.equal(await evaluate('globalThis.injected===undefined'),true);
    const many=[];for(let i=0;i<35;i++)many.push({...one,eventId:'id-'+i,parcelId:'P-'+i},{...one,eventId:'id-'+i,parcelId:'Q-'+i});
    await fixtureUpload('many.json',JSON.stringify(many)); assert.equal(await evaluate('document.querySelectorAll("#rows tr").length'),30);
    await click('select-matches');assert.match(await text('selection-count'),/^35 selected/);await click('next');assert.equal(await selectedCount(),5);
    pass(surface.name,'untrusted identifiers stay text and all-match selection spans pagination');
    await uploadPath(fixturePath);
    if(surface.sandbox===null){
      await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
      assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);await screenshot('mobile');
      pass(surface.name,'390px standalone layout does not overflow');
    }
    assert.deepEqual(errors,[]);
    assert.equal(requests.filter(request=>!request.url.startsWith('file:')&&!request.url.startsWith('data:')&&!request.url.startsWith('blob:')).length,0);
    assert.equal(requests.filter(request=>request.method!=='GET').length,0);
    // Only the document is requested; all styles, scripts, help and example are inline.
    assert.equal(requests.filter(request=>request.url.startsWith('file:')).length,1);
    pass(surface.name,'no HTTP(S), sibling asset requests, uploads or runtime exceptions with browser network offline');
    outcomes.push({...state,engineReady:true,totals:expectedTotals,download:{count:2,bytes:selected.length,sha256:sha(selected),sourceRecords:5,excluded:'PKG-SECOND',hiddenSelections:1},originalDownloadSHA256:sha(original),invalidFilesRejected:invalids.map(([name])=>name),requests,scriptErrors:errors});
    await writeFile(join(output,'verification.json'),JSON.stringify(outcomes.at(-1),null,2)+'\n',{flag:'wx'});
    await browser.send('Target.closeTarget',{targetId});
  }
  console.log(JSON.stringify({status:'passed',browser:version.product,groupsPassed:count,portableSHA256:sha(html),syntheticFixture:true,surfaces:outcomes,limits:['Chromium only; simulated iframe policies, not the actual Files host.','No permissions changed; blocked scripts/downloads remain blocked.','Temporary profiles, fixtures, screenshots and downloads are removed on exit.']},null,2));
} finally {
  for(const client of clients)client.close();browser?.close();
  if(chrome && chrome.exitCode===null){const exited=once(chrome,'exit');chrome.kill('SIGTERM');await exited;}
  await rm(temporary,{recursive:true,force:true});
}
