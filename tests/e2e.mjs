// End-to-end test in a real headless Chromium or Brave. Not part of `node --test`.
//
//   node tests/e2e.mjs [browser-binary]      (default: /usr/bin/chromium)
//
// Loads a temporary *test copy* of the extension, injects it through the real
// service worker, clicks keys with trusted CDP mouse events and checks the
// results. The test copy differs from the shipped extension only by:
//   - host_permissions for 127.0.0.1 (stands in for activeTab, which needs a
//     real toolbar click or shortcut that automation cannot produce)
//   - shadow root mode 'open' so the harness can find key coordinates
// Uses a throwaway browser profile and a local server on 127.0.0.1 only.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER = process.argv[2] || process.env.BROWSER || '/usr/bin/chromium';
let PORT = 0; // read from DevToolsActivePort once the browser is up
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Test copy of the extension -----------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kana-float-e2e-'));
const EXT = path.join(TMP, 'ext');
fs.mkdirSync(EXT);
for (const f of ['background.js', 'kana.js', 'icons', 'dict']) {
  fs.cpSync(path.join(ROOT, f), path.join(EXT, f), { recursive: true });
}
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*'];
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(EXT, 'content.js'),
  fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8')
    .replace("attachShadow({ mode: 'closed' })", "attachShadow({ mode: 'open' })"));

// --- Test page (strict CSP + Trusted Types) -------------------------------------
const HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'">
<title>kana-float e2e</title></head><body>
<p><input id="inp" type="text"></p>
<p><input id="pw" type="password"></p>
</body></html>`;
const server = http.createServer((req, res) => {
  if (req.url === '/plain.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); }
  else { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PAGE = `http://127.0.0.1:${server.address().port}/plain.html`;
const ORIGIN = new URL(PAGE).origin;

const chrome = spawn(BROWSER, [
  '--headless=new', '--remote-debugging-port=0',
  `--user-data-dir=${path.join(TMP, 'profile')}`,
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
  `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1200,800',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'], detached: true }); // own process group
let stderr = '';
chrome.stderr.on('data', (d) => { stderr += d; });
async function targets() {
  for (let i = 0; i < 50 && !PORT; i++) {
    try {
      PORT = Number(fs.readFileSync(path.join(TMP, 'profile', 'DevToolsActivePort'), 'utf8').split('\n')[0]);
    } catch { await sleep(200); }
  }
  for (let i = 0; i < 50; i++) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { await sleep(200); }
  }
  throw new Error('no devtools');
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else events.push(msg);
  };
  const ready = new Promise((r) => { ws.onopen = r; });
  const send = async (method, params = {}) => {
    await ready;
    const myId = ++id;
    ws.send(JSON.stringify({ id: myId, method, params }));
    const res = await new Promise((r) => pending.set(myId, r));
    if (res.error) throw new Error(method + ': ' + JSON.stringify(res.error));
    return res.result;
  };
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  return { send, evaluate, events, close: () => ws.close() };
}

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : '')); };

try {
  // Service worker target.
  let sw;
  for (let i = 0; i < 50 && !sw; i++) {
    sw = (await targets()).find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
    if (!sw) await sleep(200);
  }
  check('service worker started', !!sw, sw && sw.url);
  const w = connect(sw.webSocketDebuggerUrl);
  check('dictionary lookup in worker', true, await w.evaluate(`lookup('かんじ', false).then(c => c.slice(0,3))`));
  check('okuri-ari lookup in worker', true, await w.evaluate(`lookup('かk', true).then(c => c.slice(0,3))`));

  // Open the test page.
  const page = (await targets()).find((t) => t.type === 'page');
  const p = connect(page.webSocketDebuggerUrl);
  await p.send('Page.enable');
  await p.send('Runtime.enable');
  await p.send('Page.navigate', { url: PAGE });
  await sleep(1000);
  const tabId = await w.evaluate(`chrome.tabs.query({}).then(t => t.find(x => x.url.includes('plain.html')).id)`);

  // Inject exactly as a toolbar click would.
  await w.evaluate(`activate({ id: ${tabId} })`);
  await sleep(500);
  check('keyboard injected', await p.evaluate(`!!document.querySelector('kana-float')`));

  const click = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await p.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
    await sleep(120);
  };
  const keyAt = (label) => p.evaluate(`(() => {
    const r = document.querySelector('kana-float').shadowRoot;
    const all = [...r.querySelectorAll('.key, .cand')];
    const k = all.find(n => (n.querySelector('.main') ? n.querySelector('.main').textContent : n.textContent) === ${JSON.stringify(label)});
    const b = k.getBoundingClientRect();
    return [b.x + b.width / 2, b.y + b.height / 2];
  })()`);
  const press = async (label) => { const [x, y] = await keyAt(label); await click(x, y); };
  const flick = async (label, dx, dy) => {
    const [x, y] = await keyAt(label);
    await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 5; i++) await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + dx * i / 5, y: y + dy * i / 5, button: 'left', buttons: 1 });
    await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', clickCount: 1 });
    await sleep(120);
  };

  // Focus the input with a real click.
  const inp = await p.evaluate(`(() => { const b = document.getElementById('inp').getBoundingClientRect(); return [b.x + 20, b.y + b.height / 2]; })()`);
  await click(...inp);

  // にほんご → 変換 → 確定
  await flick('な', -40, 0);       // に
  await flick('は', 0, 40);        // ほ
  await flick('わ', 0, -40);       // ん
  await flick('か', 0, 40); await press('\u25cc\u3099'); // ご
  await press('変換');
  await sleep(300);
  const cands = await p.evaluate(`[...document.querySelector('kana-float').shadowRoot.querySelectorAll('.cand')].map(c => c.textContent).slice(0, 3)`);
  check('candidates for にほんご', cands[0] === '日本語', cands);
  await press('確定');
  const v1 = await p.evaluate(`({ v: inp.value, active: document.activeElement.id })`);
  check('commit 日本語 into input, focus kept', v1.v === '日本語' && v1.active === 'inp', v1);

  // Learning across lookups: かんじ, pick 感じ, then 変換 again should rank it first.
  await press('か'); await flick('わ', 0, -40); await flick('さ', -40, 0); await press('\u25cc\u3099');
  await press('変換'); await sleep(300);
  await press('感じ'); await press('感じ'); // select, then commit
  await sleep(300);
  await press('か'); await flick('わ', 0, -40); await flick('さ', -40, 0); await press('\u25cc\u3099');
  await press('変換'); await sleep(300);
  const c2 = await p.evaluate(`[...document.querySelector('kana-float').shadowRoot.querySelectorAll('.cand')].map(c => c.textContent).slice(0, 2)`);
  check('learned candidate ranked first', c2[0] === '感じ', c2);
  await press('かな');
  const v2 = await p.evaluate(`inp.value`);
  check('かな commits reading', v2 === '日本語感じかんじ', v2);

  // Second activation toggles visibility.
  await w.evaluate(`activate({ id: ${tabId} })`); await sleep(300);
  const hidden = await p.evaluate(`getComputedStyle(document.querySelector('kana-float')).display`);
  await w.evaluate(`activate({ id: ${tabId} })`); await sleep(300);
  const shown = await p.evaluate(`getComputedStyle(document.querySelector('kana-float')).display`);
  check('second activation toggles', hidden === 'none' && shown === 'block', { hidden, shown });

  // Worker restart: stop the worker, then look something up from the page.
  // Really stop the worker (as the browser does after ~30 s idle).
  const swUrl = sw.url;
  const bv = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const bs = connect(bv.webSocketDebuggerUrl);
  const swT = (await bs.send('Target.getTargets')).targetInfos.find((t) => t.type === 'service_worker' && t.url === swUrl);
  await bs.send('Target.closeTarget', { targetId: swT.targetId });
  await sleep(500);
  const stillThere = (await targets()).some((t) => t.type === 'service_worker' && t.url === swUrl);
  check('worker stopped', !stillThere);
  await flick('な', 40, 0); await flick('か', 0, 40); // ねこ
  await press('変換'); await sleep(500);
  const c3 = await p.evaluate(`[...document.querySelector('kana-float').shadowRoot.querySelectorAll('.cand')].map(c => c.textContent).slice(0, 2)`);
  check('lookup after worker restart (reload path)', c3.includes('猫'), { c3 });
  await press('確定');

  // Password field: nothing typed.
  const pw = await p.evaluate(`(() => { const b = document.getElementById('pw').getBoundingClientRect(); return [b.x + 20, b.y + b.height / 2]; })()`);
  await click(...pw);
  await press('か');
  check('password field untouched', (await p.evaluate(`pw.value`)) === '');

  // No network requests other than our test page.
  const net = await p.evaluate(`performance.getEntriesByType('resource').map(e => e.name)`);
  check('page made no extra requests', net.every((u) => u.startsWith(ORIGIN)), net);

  const errs = p.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails.text);
  check('no page exceptions', errs.length === 0, errs);
  w.close(); p.close();
} catch (e) {
  check('harness', false, String(e.stack || e));
} finally {
  // Close the browser over CDP first: some wrappers (Brave's) detach the real
  // browser from our process, so signals alone may not reach it.
  try {
    const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    const b = connect(v.webSocketDebuggerUrl);
    await Promise.race([b.send('Browser.close').catch(() => {}), sleep(2000)]);
    await sleep(500);
  } catch { /* browser never came up */ }
  const exited = new Promise((r) => chrome.once('exit', r));
  // /usr/bin/brave and friends are wrapper scripts: kill the whole group.
  try { process.kill(-chrome.pid, 'SIGTERM'); } catch { chrome.kill(); }
  await Promise.race([exited, sleep(5000)]);
  server.close();
  // Helper processes can write to the profile briefly after the main one exits.
  for (let i = 0; i < 5 && fs.existsSync(TMP); i++) {
    await sleep(400);
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed && stderr) console.log(stderr.split('\n').filter((l) => /ERROR|extension/i.test(l)).slice(0, 15).join('\n'));
  process.exit(failed ? 1 : 0);
}
