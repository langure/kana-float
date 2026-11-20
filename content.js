// content.js: the floating keyboard. Injected on demand (with kana.js) by
// background.js. Running it again in the same tab toggles visibility.
(function () {
  'use strict';
  if (globalThis.__kanaFloat) { globalThis.__kanaFloat.toggle(); return; }

  const K = globalThis.KanaCore;
  const MARGIN = 16;

  // ---------------------------------------------------------------------------
  // Messaging with the service worker.
  function send(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message)); else resolve(resp);
        });
      } catch (e) {
        // "Extension context invalidated" after the extension is reloaded.
        reject(new Error('extension was reloaded, refresh the page'));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Editable targets.
  const TEXT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', '']);

  function isTextControl(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      return TEXT_TYPES.has(t);
    }
    return false;
  }

  function isPassword(el) {
    return !!el && el.tagName === 'INPUT' &&
      (el.type === 'password' || (el.getAttribute('type') || '').toLowerCase() === 'password');
  }

  function isEditable(el) {
    if (!el || el.nodeType !== 1 || el === host) return false;
    if (isPassword(el)) return false;
    if (isTextControl(el)) return !el.readOnly && !el.disabled;
    return !!el.isContentEditable;
  }

  // activeElement, descending into open shadow roots of the page.
  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  let lastEditable = null;
  let savedRange = null; // caret inside a contenteditable

  document.addEventListener('focusin', (e) => {
    const t = e.composedPath ? e.composedPath()[0] : e.target;
    if (t === host) return;
    if (isEditable(t)) lastEditable = t;
    else if (isPassword(t)) lastEditable = null; // never type next to a password
  }, true);

  document.addEventListener('selectionchange', () => {
    if (!lastEditable || isTextControl(lastEditable)) return;
    const sel = document.getSelection();
    if (sel && sel.rangeCount && lastEditable.contains(sel.anchorNode)) {
      savedRange = sel.getRangeAt(0).cloneRange();
    }
  });

  // Make sure the remembered field has focus (and its caret) again.
  function target() {
    const el = lastEditable;
    if (!el || !el.isConnected || !isEditable(el)) {
      composer.message = isPassword(deepActive())
        ? 'not available in password fields'
        : 'click a text field first';
      composer.render();
      return null;
    }
    if (deepActive() !== el) {
      el.focus({ preventScroll: true });
      if (!isTextControl(el) && savedRange && el.contains(savedRange.startContainer)) {
        const sel = document.getSelection();
        sel.removeAllRanges();
        sel.addRange(savedRange);
      }
    }
    return el;
  }

  function fireInput(el, inputType, data) {
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType, data }));
  }

  function insertText(text) {
    const el = target();
    if (!el || !text) return;
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (_) { ok = false; }
    if (ok) return;
    if (isTextControl(el)) {
      try {
        el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
      } catch (_) {
        el.value += text; // type=email has no selection API
      }
      fireInput(el, 'insertText', text);
    } else {
      const sel = document.getSelection();
      if (!sel || !sel.rangeCount) return;
      const r = sel.getRangeAt(0);
      r.deleteContents();
      const node = document.createTextNode(text);
      r.insertNode(node);
      r.setStartAfter(node);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      fireInput(el, 'insertText', text);
    }
  }

  function pageBackspace() {
    const el = target();
    if (!el) return;
    let ok = false;
    try { ok = document.execCommand('delete', false); } catch (_) { ok = false; }
    if (ok || !isTextControl(el)) return;
    try {
      const s = el.selectionStart, e = el.selectionEnd;
      if (s !== e) el.setRangeText('', s, e, 'end');
      else if (s > 0) el.setRangeText('', s - 1, s, 'end');
      else return;
    } catch (_) {
      el.value = el.value.slice(0, -1);
    }
    fireInput(el, 'deleteContentBackward', null);
  }

  // ゛ ゜ 小 with an empty buffer: transform the character before the caret.
  function pageModify(kind) {
    const el = target();
    if (!el) return false;
    if (isTextControl(el)) {
      let s, e;
      try { s = el.selectionStart; e = el.selectionEnd; } catch (_) { return false; }
      if (s == null || s !== e || s === 0) return false;
      const next = K.applyModifier(el.value.charAt(s - 1), kind);
      if (next === null) return false;
      el.setSelectionRange(s - 1, s);
      insertText(next);
      return true;
    }
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
    sel.modify('extend', 'backward', 'character');
    const ch = sel.toString();
    const next = ch.length === 1 ? K.applyModifier(ch, kind) : null;
    if (next === null) { sel.collapseToEnd(); return false; }
    insertText(next);
    return true;
  }

  // ---------------------------------------------------------------------------
  // UI.
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .kb {
      position: relative;
      width: 300px;
      background: #1e1f24;
      color: #e8e8ec;
      border: 1px solid #3a3c45;
      border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0,0,0,.45);
      font: 14px/1.2 "Hiragino Sans", "Noto Sans CJK JP", "Noto Sans JP", "Yu Gothic", system-ui, sans-serif;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
      overflow: visible;
    }
    .hdr {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 8px 6px 12px;
      cursor: grab;
      border-bottom: 1px solid #2c2e36;
      color: #9a9cab; font-size: 12px;
    }
    .hdr.drag { cursor: grabbing; }
    .hdr .title { flex: 1; }
    .close {
      all: unset; cursor: pointer; width: 22px; height: 22px; border-radius: 6px;
      display: grid; place-items: center; color: #9a9cab; font-size: 16px;
    }
    .close:hover { background: #3a3c45; color: #fff; }
    .pre {
      min-height: 34px; padding: 6px 12px;
      font-size: 18px; color: #fff;
      border-bottom: 1px solid #2c2e36;
      word-break: break-all;
    }
    .pre .stem { text-decoration: underline; text-decoration-color: #6c8cff; text-underline-offset: 4px; }
    .pre .mark { color: #ffb86c; padding: 0 2px; }
    .pre .okuri { text-decoration: underline dotted; text-decoration-color: #ffb86c; text-underline-offset: 4px; }
    .pre .msg { color: #8a8c9a; font-size: 12px; }
    .pre .placeholder { color: #5d6070; font-size: 12px; }
    .cands {
      display: flex; flex-wrap: wrap; gap: 4px;
      padding: 6px 8px; max-height: 96px; overflow-y: auto;
      border-bottom: 1px solid #2c2e36;
    }
    .cands:empty { display: none; }
    .cand {
      all: unset; cursor: pointer;
      padding: 4px 8px; border-radius: 6px;
      background: #2a2c34; color: #e8e8ec; font-size: 16px;
    }
    .cand:hover { background: #343744; }
    .cand.sel { background: #4b63d8; color: #fff; }
    .grid {
      display: grid; grid-template-columns: repeat(5, 1fr);
      gap: 5px; padding: 8px;
    }
    .key {
      position: relative;
      height: 46px; border-radius: 8px;
      background: #2e3039; color: #f2f2f5;
      display: grid; place-items: center;
      font-size: 20px; cursor: pointer;
      box-shadow: 0 1px 0 #15161a;
    }
    .key:hover { background: #383b46; }
    .key.down { background: #4a4e5c; }
    .key.fn { background: #262830; color: #b8bac8; font-size: 14px; }
    .key.fn:hover { background: #30323c; }
    .key.accent { background: #3b4f9e; color: #fff; }
    .key.accent:hover { background: #4760bf; }
    .key.fn.mark { font-size: 22px; color: #e8e8ec; }
    .key.wide { grid-column: span 5; height: 36px; font-size: 13px; color: #9a9cab; }
    .key .hint { position: absolute; font-size: 9px; color: #6f7282; line-height: 1; }
    .key .hint.l { left: 4px; top: 50%; transform: translateY(-50%); }
    .key .hint.r { right: 4px; top: 50%; transform: translateY(-50%); }
    .key .hint.u { top: 3px; left: 50%; transform: translateX(-50%); }
    .key .hint.d { bottom: 3px; left: 50%; transform: translateX(-50%); }
    .key.on { outline: 2px solid #6c8cff; outline-offset: -2px; }
    .pop { position: absolute; pointer-events: none; z-index: 2; }
    .pop .cell {
      position: absolute; display: grid; place-items: center;
      border-radius: 8px; background: #3a3d49; color: #fff; font-size: 22px;
      box-shadow: 0 4px 12px rgba(0,0,0,.5);
    }
    .pop .cell.hot { background: #4b63d8; }
  `;

  const host = document.createElement('kana-float');
  host.style.cssText = [
    'all: initial', 'position: fixed', 'z-index: 2147483647',
    'left: 0', 'top: 0', 'display: block', 'visibility: hidden',
  ].map((d) => d + ' !important').join(';');
  const shadow = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  shadow.adoptedStyleSheets = [sheet];

  // Never let the keyboard take focus from the page's field, and keep page
  // handlers (click-outside-to-close menus etc.) from seeing our clicks.
  for (const type of ['mousedown', 'pointerdown']) {
    shadow.addEventListener(type, (e) => {
      if (type === 'mousedown') e.preventDefault();
      e.stopPropagation();
    });
  }
  for (const type of ['mouseup', 'click', 'pointerup', 'dblclick']) {
    shadow.addEventListener(type, (e) => e.stopPropagation());
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const kb = el('div', 'kb');
  const hdr = el('div', 'hdr');
  const title = el('span', 'title', 'Kana Float');
  const closeBtn = el('button', 'close', '×');
  closeBtn.title = 'Hide (Alt+K)';
  hdr.append(title, closeBtn);
  const pre = el('div', 'pre');
  const cands = el('div', 'cands');
  const grid = el('div', 'grid');
  const pop = el('div', 'pop');
  pop.hidden = true;
  kb.append(hdr, pre, cands, grid, pop);
  shadow.append(kb);

  // --- Keys ------------------------------------------------------------------
  const kanaKeys = []; // { node, base, label, hints }
  let modeKey = null;

  function kanaKey(base) {
    const node = el('div', 'key');
    const label = el('span', 'main', base);
    node.append(label);
    const hints = {};
    for (const d of ['l', 'u', 'r', 'd']) {
      const ch = K.FLICK[base][d];
      if (!ch) continue;
      hints[d] = el('span', 'hint ' + d, ch);
      node.append(hints[d]);
    }
    kanaKeys.push({ node, base, label, hints });
    attachFlick(node, base);
    return node;
  }

  function fnKey(text, cls, onPress, title) {
    const node = el('div', 'key fn' + (cls ? ' ' + cls : ''), text);
    if (title) node.title = title;
    node.addEventListener('click', (e) => { e.preventDefault(); onPress(); });
    return node;
  }

  function repeatKey(text, onPress, title) {
    const node = el('div', 'key fn', text);
    if (title) node.title = title;
    let t1 = 0, t2 = 0;
    const stop = () => { clearTimeout(t1); clearInterval(t2); node.classList.remove('down'); };
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      node.setPointerCapture(e.pointerId);
      node.classList.add('down');
      onPress();
      t1 = setTimeout(() => { t2 = setInterval(onPress, 70); }, 450);
    });
    node.addEventListener('pointerup', stop);
    node.addEventListener('pointercancel', stop);
    return node;
  }

  const run = (p) => Promise.resolve(p).catch((e) => console.warn('kana-float:', e));

  modeKey = fnKey('あ', '', () => composer.toggleKatakana(), 'Switch hiragana / katakana');
  const rows = [
    [modeKey, kanaKey('あ'), kanaKey('か'), kanaKey('さ'),
      repeatKey('⌫', () => composer.backspace(), 'Backspace')],
    [fnKey('小', '', () => composer.modify('small'), 'Small kana (つ→っ)'),
      kanaKey('た'), kanaKey('な'), kanaKey('は'),
      fnKey('変換', 'accent', () => run(composer.convert()), 'Convert / next candidate')],
    [fnKey('\u25cc\u309a', 'mark', () => composer.modify('handakuten'), 'Handakuten (は→ぱ)'),
      kanaKey('ま'), kanaKey('や'), kanaKey('ら'),
      fnKey('確定', 'accent', () => run(composer.confirm()), 'Commit selection')],
    [fnKey('送', '', () => composer.toggleOkuri(), 'Mark okurigana start (書く: か 送 く)'),
      fnKey('\u25cc\u3099', 'mark', () => composer.modify('dakuten'), 'Dakuten (か→が)'),
      kanaKey('わ'), kanaKey('、'),
      fnKey('かな', '', () => composer.commitKana(), 'Commit the buffer as kana')],
    [fnKey('全角スペース', 'wide', () => run(composer.typeSymbol('　')), 'Full-width space')],
  ];
  for (const r of rows) for (const k of r) grid.append(k);
  const okuriKey = rows[3][0];

  // --- Flick / long press ----------------------------------------------------
  const HOLD_MS = 300;

  function showPop(node, base, dir) {
    const kr = node.getBoundingClientRect();
    const br = kb.getBoundingClientRect();
    const w = kr.width, h = kr.height;
    pop.replaceChildren();
    pop.style.left = (kr.left - br.left) + 'px';
    pop.style.top = (kr.top - br.top) + 'px';
    const pos = { c: [0, 0], l: [-w, 0], r: [w, 0], u: [0, -h], d: [0, h] };
    for (const d of ['c', 'l', 'u', 'r', 'd']) {
      const ch = K.FLICK[base][d];
      if (!ch) continue;
      const c = el('div', 'cell' + (d === dir ? ' hot' : ''), display(ch));
      c.style.left = pos[d][0] + 'px';
      c.style.top = pos[d][1] + 'px';
      c.style.width = w + 'px';
      c.style.height = h + 'px';
      pop.append(c);
    }
    pop.hidden = false;
  }

  function attachFlick(node, base) {
    let start = null, timer = 0, shown = false, dir = 'c';
    const end = () => {
      clearTimeout(timer);
      start = null; shown = false;
      pop.hidden = true;
      node.classList.remove('down');
    };
    node.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      node.setPointerCapture(e.pointerId);
      node.classList.add('down');
      start = { x: e.clientX, y: e.clientY };
      dir = 'c';
      timer = setTimeout(() => { shown = true; showPop(node, base, dir); }, HOLD_MS);
    });
    node.addEventListener('pointermove', (e) => {
      if (!start) return;
      const d = K.flickDirection(e.clientX - start.x, e.clientY - start.y);
      if (d !== dir || (!shown && d !== 'c')) {
        dir = d;
        shown = true;
        clearTimeout(timer);
        showPop(node, base, dir);
      }
    });
    node.addEventListener('pointerup', (e) => {
      if (!start) return;
      const d = K.flickDirection(e.clientX - start.x, e.clientY - start.y);
      end();
      const ch = K.FLICK[base][d];
      if (ch) run(composer.type(ch));
    });
    node.addEventListener('pointercancel', end);
    node.addEventListener('lostpointercapture', () => { if (start) end(); });
  }

  // --- Drag ------------------------------------------------------------------
  let pos = null; // {x, y} top-left in viewport px; null = default corner

  function clampPos(p) {
    const w = kb.offsetWidth || 300, h = kb.offsetHeight || 360;
    const maxX = Math.max(0, window.innerWidth - w);
    const maxY = Math.max(0, window.innerHeight - h);
    return { x: Math.min(Math.max(0, p.x), maxX), y: Math.min(Math.max(0, p.y), maxY) };
  }
  function defaultPos() {
    return {
      x: window.innerWidth - (kb.offsetWidth || 300) - MARGIN,
      y: window.innerHeight - (kb.offsetHeight || 360) - MARGIN,
    };
  }
  function place() {
    const p = clampPos(pos || defaultPos());
    host.style.setProperty('left', p.x + 'px', 'important');
    host.style.setProperty('top', p.y + 'px', 'important');
  }

  hdr.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.composedPath().includes(closeBtn)) return;
    const r = host.getBoundingClientRect();
    const off = { x: e.clientX - r.left, y: e.clientY - r.top };
    hdr.setPointerCapture(e.pointerId);
    hdr.classList.add('drag');
    const move = (ev) => {
      pos = clampPos({ x: ev.clientX - off.x, y: ev.clientY - off.y });
      place();
    };
    const up = () => {
      hdr.classList.remove('drag');
      hdr.removeEventListener('pointermove', move);
      hdr.removeEventListener('pointerup', up);
      hdr.removeEventListener('pointercancel', up);
      if (pos) send({ type: 'setPos', pos }).catch(() => {});
    };
    hdr.addEventListener('pointermove', move);
    hdr.addEventListener('pointerup', up);
    hdr.addEventListener('pointercancel', up);
  });
  hdr.addEventListener('dblclick', () => {
    pos = null;
    place();
    send({ type: 'setPos', pos: null }).catch(() => {});
  });
  window.addEventListener('resize', () => { if (visible) place(); });

  // --- Render ----------------------------------------------------------------
  let katakanaView = false;
  function display(ch) { return katakanaView ? K.toKatakana(ch) : ch; }

  function render(s) {
    katakanaView = s.katakana;
    modeKey.textContent = s.katakana ? 'ア' : 'あ';
    for (const k of kanaKeys) {
      k.label.textContent = display(k.base);
      for (const d of Object.keys(k.hints)) k.hints[d].textContent = display(K.FLICK[k.base][d]);
    }
    okuriKey.classList.toggle('on', s.okuriMarked);

    pre.replaceChildren();
    if (s.stem || s.okuriMarked) {
      pre.append(el('span', 'stem', s.stem));
      if (s.okuriMarked) {
        pre.append(el('span', 'mark', '*'));
        pre.append(el('span', 'okuri', s.okuri));
      }
    } else if (!s.message) {
      pre.append(el('span', 'placeholder', 'type kana, then 変換'));
    }
    if (s.message) pre.append(el('span', 'msg', (s.stem ? '  ' : '') + s.message));

    cands.replaceChildren();
    if (s.candidates) {
      s.candidates.forEach((c, i) => {
        const b = el('button', 'cand' + (i === s.index ? ' sel' : ''), c + s.okuri);
        // Click selects; clicking the selected one again commits it.
        b.addEventListener('click', () => {
          if (i === composer.index) run(composer.confirm());
          else composer.select(i);
        });
        cands.append(b);
      });
      const selNode = cands.children[s.index];
      if (selNode) {
        // Keep the selection visible without scrollIntoView (which can scroll the page).
        const top = selNode.offsetTop - cands.offsetTop;
        if (top < cands.scrollTop) cands.scrollTop = top;
        else if (top + selNode.offsetHeight > cands.scrollTop + cands.clientHeight) {
          cands.scrollTop = top + selNode.offsetHeight - cands.clientHeight;
        }
      }
    }
    if (visible) place();
  }

  // --- Composer --------------------------------------------------------------
  const composer = new K.Composer({
    lookup: async (key, ari) => {
      const r = await send({ type: 'lookup', key, ari });
      if (!r || !r.ok) throw new Error((r && r.error) || 'no response');
      return r.cands;
    },
    learn: (key, cand, ari) => { send({ type: 'learn', key, cand, ari }).catch(() => {}); },
    commit: insertText,
    pageBackspace,
    pageModify,
    render,
  });

  // --- Show / hide -----------------------------------------------------------
  let visible = false;
  function show() {
    if (!host.isConnected) document.documentElement.append(host);
    visible = true;
    host.style.setProperty('display', 'block', 'important');
    composer.render();
    place();
    host.style.setProperty('visibility', 'visible', 'important');
  }
  function hide() {
    visible = false;
    host.style.setProperty('display', 'none', 'important');
  }
  function toggle() { if (visible) hide(); else show(); }
  closeBtn.addEventListener('click', hide);

  // Remember a field that was already focused when we were injected.
  const a = deepActive();
  if (isEditable(a)) lastEditable = a;

  globalThis.__kanaFloat = { toggle };
  show();
  send({ type: 'getPos' }).then((r) => {
    if (r && r.ok && r.pos) { pos = r.pos; place(); }
  }).catch(() => {});
})();
