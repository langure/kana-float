// background.js: MV3 service worker.
//
// - Injects the keyboard into the active tab on toolbar click / Alt+K.
//   A second activation toggles visibility (handled by content.js).
// - Owns the SKK dictionary and answers lookups from the content script, so
//   the dictionary is never exposed to the page.
// - Stores learned candidates and the keyboard position in IndexedDB.
//   (chrome.storage would need the "storage" permission; IndexedDB in the
//   extension's own origin needs none.)
//
// The worker can be stopped at any time; everything is reloaded lazily.

importScripts('kana.js');
const { rankCandidates, learnInto } = self.KanaCore;

const DICT_PATH = 'dict/skk-jisyo-l.json';
const LEARN_KEY = 'learned';
const LEARN_MAX_KEYS = 5000;

let dictPromise = null;

function loadDict() {
  if (!dictPromise) {
    // fetch() of a packaged file never leaves the machine.
    dictPromise = fetch(chrome.runtime.getURL(DICT_PATH))
      .then((r) => {
        if (!r.ok) throw new Error('dictionary missing: ' + r.status);
        return r.json();
      })
      .catch((e) => {
        dictPromise = null; // retry next time
        throw e;
      });
  }
  return dictPromise;
}

// --- Minimal IndexedDB key-value store -------------------------------------
let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('kana-float', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
}
async function kvGet(key) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction('kv').objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function kvSet(key, value) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getLearned() {
  return (await kvGet(LEARN_KEY)) || {};
}

async function lookup(key, ari) {
  const [dict, learned] = await Promise.all([loadDict(), getLearned()]);
  const table = ari ? dict.ari : dict.nasi;
  const base = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : [];
  const mine = learned[(ari ? 'a:' : 'n:') + key];
  return rankCandidates(base, mine);
}

// Serialise writes so two quick commits do not overwrite each other.
let learnChain = Promise.resolve();
function learn(key, ari, cand) {
  learnChain = learnChain.then(async () => {
    const learned = await getLearned();
    const k = (ari ? 'a:' : 'n:') + key;
    learned[k] = learnInto(learned[k], cand);
    // Keep the map bounded: drop the oldest-inserted keys.
    const keys = Object.keys(learned);
    if (keys.length > LEARN_MAX_KEYS) {
      for (const old of keys.slice(0, keys.length - LEARN_MAX_KEYS)) delete learned[old];
    }
    // Re-insert so the recently used key is the newest.
    const v = learned[k]; delete learned[k]; learned[k] = v;
    await kvSet(LEARN_KEY, learned);
  }).catch((e) => console.warn('kana-float: learn failed', e));
  return learnChain;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only our own content scripts can reach us (no externally_connectable),
  // but check anyway.
  if (sender.id !== chrome.runtime.id || !msg || typeof msg !== 'object') return false;
  if (msg.type === 'lookup' && typeof msg.key === 'string' && msg.key.length <= 64) {
    lookup(msg.key, !!msg.ari)
      .then((cands) => sendResponse({ ok: true, cands }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true; // async response
  }
  if (msg.type === 'learn' && typeof msg.key === 'string' && msg.key.length <= 64 &&
      typeof msg.cand === 'string' && msg.cand.length > 0 && msg.cand.length <= 128) {
    learn(msg.key, !!msg.ari, msg.cand).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'getPos') {
    kvGet('pos').then((pos) => sendResponse({ ok: true, pos: pos || null }),
      () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'setPos') {
    const p = msg.pos;
    const valid = p === null ||
      (p && Number.isFinite(p.x) && Number.isFinite(p.y));
    if (!valid) return false;
    kvSet('pos', p && { x: Math.round(p.x), y: Math.round(p.y) })
      .then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  return false;
});

async function activate(tab) {
  if (!tab || tab.id == null) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id }, // top frame only
      files: ['kana.js', 'content.js'],
    });
  } catch (e) {
    // brave://, chrome://, the Web Store, PDF viewer, etc. refuse injection.
    console.warn('kana-float: cannot run on this page:', e && e.message);
    chrome.action.setBadgeBackgroundColor({ color: '#a33', tabId: tab.id });
    chrome.action.setBadgeText({ text: '×', tabId: tab.id });
    setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab.id }), 2000);
    return;
  }
  // Warm the dictionary while the user starts typing.
  loadDict().catch(() => {});
}

// _execute_action (Alt+K) also fires onClicked.
chrome.action.onClicked.addListener(activate);
