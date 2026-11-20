// Tests against the generated dictionary and the worker's lookup logic.
// Run: node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const dict = JSON.parse(fs.readFileSync(path.join(root, 'dict', 'skk-jisyo-l.json'), 'utf8'));

test('dictionary shape', () => {
  assert.ok(Object.keys(dict.ari).length > 10000);
  assert.ok(Object.keys(dict.nasi).length > 100000);
  for (const [k, v] of Object.entries(dict.nasi)) {
    assert.match(k, /^[ぁ-ゖー]+$/u, k);
    assert.ok(Array.isArray(v) && v.length > 0, k);
  }
  for (const k of Object.keys(dict.ari)) assert.match(k, /^[ぁ-ゖー]+[a-z]$/u, k);
});

test('annotations and lisp are stripped', () => {
  for (const list of [...Object.values(dict.ari), ...Object.values(dict.nasi)]) {
    for (const c of list) {
      assert.ok(!c.includes(';'), c);
      assert.ok(!c.startsWith('(concat'), c);
      assert.ok(c.length > 0);
    }
  }
});

test('well-known entries', () => {
  assert.equal(dict.nasi['かんじ'][0], '漢字');
  assert.ok(dict.nasi['にほん'].includes('日本'));
  assert.ok(dict.ari['かk'].includes('書'));
  assert.ok(dict.ari['あu'].includes('会'));
  assert.ok(dict.ari['いt'].includes('言'));
  assert.ok(dict.nasi['わたし'].includes('私'));
});

// Load background.js in a sandbox with a fake chrome / fetch / indexedDB and
// drive it through its onMessage listener, as the content script would.
function loadWorker() {
  let listener = null;
  let clicked = null;
  const store = new Map();
  const fakeIDB = {
    open() {
      const req = {};
      const dbObj = {
        createObjectStore() {},
        transaction() {
          const tx = {
            objectStore() {
              return {
                get(k) {
                  const r = {};
                  setImmediate(() => { r.result = structuredClone(store.get(k)); r.onsuccess && r.onsuccess(); });
                  return r;
                },
                put(v, k) { store.set(k, structuredClone(v)); setImmediate(() => tx.oncomplete && tx.oncomplete()); },
              };
            },
          };
          return tx;
        },
      };
      setImmediate(() => { req.result = dbObj; req.onupgradeneeded && req.onupgradeneeded(); req.onsuccess && req.onsuccess(); });
      return req;
    },
  };
  let fetches = 0;
  const sandbox = {
    console, setTimeout, setImmediate, structuredClone, Promise,
    indexedDB: fakeIDB,
    fetch: async (url) => {
      fetches++;
      assert.equal(url, 'chrome-extension://test/dict/skk-jisyo-l.json');
      return { ok: true, json: async () => dict };
    },
    chrome: {
      runtime: {
        id: 'test',
        getURL: (p) => 'chrome-extension://test/' + p,
        onMessage: { addListener: (fn) => { listener = fn; } },
      },
      action: { onClicked: { addListener: (fn) => { clicked = fn; } } },
      scripting: { executeScript: async () => {} },
    },
  };
  sandbox.self = sandbox;
  sandbox.importScripts = (f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx);
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), ctx);
  const call = (msg, id = 'test') => new Promise((resolve) => {
    const async = listener(msg, { id }, resolve);
    if (!async) resolve(undefined);
  });
  return { call, clicked: () => clicked, fetches: () => fetches, store };
}

test('worker answers lookups and ranks learned candidates first', async () => {
  const w = loadWorker();
  const r1 = await w.call({ type: 'lookup', key: 'かんじ', ari: false });
  assert.equal(r1.ok, true);
  assert.equal(r1.cands[0], '漢字');
  await w.call({ type: 'learn', key: 'かんじ', ari: false, cand: '感じ' });
  const r2 = await w.call({ type: 'lookup', key: 'かんじ', ari: false });
  assert.equal(r2.cands[0], '感じ');
  assert.equal(r2.cands.filter((c) => c === '感じ').length, 1);
  const r3 = await w.call({ type: 'lookup', key: 'かk', ari: true });
  assert.equal(r3.cands[0], '書');
  assert.equal(w.fetches(), 1, 'dictionary loaded once');
});

test('worker rejects foreign senders and bad messages', async () => {
  const w = loadWorker();
  assert.equal(await w.call({ type: 'lookup', key: 'かんじ' }, 'evil'), undefined);
  assert.equal(await w.call({ type: 'lookup', key: 42 }), undefined);
  assert.equal(await w.call({ type: 'setPos', pos: { x: 'a', y: 1 } }), undefined);
});

test('worker stores position', async () => {
  const w = loadWorker();
  const r0 = await w.call({ type: 'getPos' });
  assert.equal(r0.ok, true);
  assert.equal(r0.pos, null);
  await w.call({ type: 'setPos', pos: { x: 10.4, y: 20.6 } });
  const r = await w.call({ type: 'getPos' });
  assert.deepEqual({ ...r.pos }, { x: 10, y: 21 });
});

test('a restarted worker reloads the dictionary', async () => {
  const a = loadWorker();
  await a.call({ type: 'lookup', key: 'にほん' });
  const b = loadWorker(); // fresh globals, as after the worker is stopped
  const r = await b.call({ type: 'lookup', key: 'にほん' });
  assert.ok(r.cands.includes('日本'));
  assert.equal(b.fetches(), 1);
});
