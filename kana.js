// kana.js: pure logic shared by the content script and the node tests.
// No DOM, no chrome.* APIs. Safe to inject more than once.
(function (root) {
  'use strict';
  if (root.KanaCore) return;

  // ---------------------------------------------------------------------------
  // Flick layout (iPhone 12-key style). Directions: c(enter), l(eft), u(p), r(ight), d(own).
  const FLICK = {
    'あ': { c: 'あ', l: 'い', u: 'う', r: 'え', d: 'お' },
    'か': { c: 'か', l: 'き', u: 'く', r: 'け', d: 'こ' },
    'さ': { c: 'さ', l: 'し', u: 'す', r: 'せ', d: 'そ' },
    'た': { c: 'た', l: 'ち', u: 'つ', r: 'て', d: 'と' },
    'な': { c: 'な', l: 'に', u: 'ぬ', r: 'ね', d: 'の' },
    'は': { c: 'は', l: 'ひ', u: 'ふ', r: 'へ', d: 'ほ' },
    'ま': { c: 'ま', l: 'み', u: 'む', r: 'め', d: 'も' },
    'や': { c: 'や', l: '「', u: 'ゆ', r: '」', d: 'よ' },
    'ら': { c: 'ら', l: 'り', u: 'る', r: 'れ', d: 'ろ' },
    'わ': { c: 'わ', l: 'を', u: 'ん', r: 'ー' },
    '、': { c: '、', l: '。', u: '？', r: '！' },
  };

  // Direction from a pointer delta. Returns 'c' inside the dead zone.
  function flickDirection(dx, dy, threshold) {
    const t = threshold == null ? 18 : threshold;
    if (Math.hypot(dx, dy) < t) return 'c';
    if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'l' : 'r';
    return dy < 0 ? 'u' : 'd';
  }

  // ---------------------------------------------------------------------------
  // Hiragana <-> katakana. Only the hiragana block U+3041..U+3096 maps 1:1
  // (katakana = hiragana + 0x60). ー and punctuation are shared.
  function toKatakana(s) {
    let out = '';
    for (const ch of s) {
      const c = ch.codePointAt(0);
      out += (c >= 0x3041 && c <= 0x3096) ? String.fromCodePoint(c + 0x60) : ch;
    }
    return out;
  }
  function toHiragana(s) {
    let out = '';
    for (const ch of s) {
      const c = ch.codePointAt(0);
      out += (c >= 0x30a1 && c <= 0x30f6) ? String.fromCodePoint(c - 0x60) : ch;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Modifier toggles. Each table maps a character to its transformed form; the
  // transforms are written in hiragana and mirrored to katakana below.
  const DAKUTEN = {};
  const HANDAKUTEN = {};
  const SMALL = {};
  function pairs(table, list) {
    for (let i = 0; i < list.length; i += 2) table[list[i]] = list[i + 1];
  }
  // plain <-> voiced
  const voiced = 'かがきぎくぐけげこごさざしじすずせぜそぞただちぢつづてでとどはばひびふぶへべほぼうゔ';
  for (let i = 0; i < voiced.length; i += 2) {
    DAKUTEN[voiced[i]] = voiced[i + 1];
    DAKUTEN[voiced[i + 1]] = voiced[i];
  }
  // semi-voiced: は -> ぱ -> は, and ば -> ぱ.  ゛ on ぱ gives ば.
  const hrow = 'はひふへほ', brow = 'ばびぶべぼ', prow = 'ぱぴぷぺぽ';
  for (let i = 0; i < 5; i++) {
    HANDAKUTEN[hrow[i]] = prow[i];
    HANDAKUTEN[brow[i]] = prow[i];
    HANDAKUTEN[prow[i]] = hrow[i];
    DAKUTEN[prow[i]] = brow[i];
  }
  // small kana, both ways. づ -> っ as well, since ゛ then 小 is a natural slip.
  pairs(SMALL, 'あぁいぃうぅえぇおぉつっやゃゆゅよょわゎ');
  for (const k of Object.keys(SMALL)) SMALL[SMALL[k]] = k;
  SMALL['づ'] = 'っ';
  SMALL['ゔ'] = 'ぅ';

  // Mirror every hiragana entry to katakana (ゔ -> ヴ, etc.).
  for (const table of [DAKUTEN, HANDAKUTEN, SMALL]) {
    for (const k of Object.keys(table)) {
      const kk = toKatakana(k), vk = toKatakana(table[k]);
      if (kk !== k) table[kk] = vk;
    }
  }

  const MODIFIERS = { dakuten: DAKUTEN, handakuten: HANDAKUTEN, small: SMALL };

  // Apply a modifier ('dakuten' | 'handakuten' | 'small') to one character.
  // Returns the new character, or null if the modifier does not apply.
  function applyModifier(ch, kind) {
    const table = MODIFIERS[kind];
    if (!table) throw new Error('unknown modifier: ' + kind);
    return Object.prototype.hasOwnProperty.call(table, ch) ? table[ch] : null;
  }

  // ---------------------------------------------------------------------------
  // Okurigana: the romaji consonant SKK uses for the first okurigana kana.
  // あ-row kana use their vowel (会う = "あu"), っ files under "t"
  // (言っ = "いt"), ん under "n".
  const OKURI_CONSONANT = {};
  function row(cons, chars) { for (const c of chars) OKURI_CONSONANT[c] = cons; }
  OKURI_CONSONANT['あ'] = 'a'; OKURI_CONSONANT['い'] = 'i'; OKURI_CONSONANT['う'] = 'u';
  OKURI_CONSONANT['え'] = 'e'; OKURI_CONSONANT['お'] = 'o';
  row('k', 'かきくけこ'); row('g', 'がぎぐげご');
  row('s', 'さしすせそ'); row('z', 'ざじずぜぞ');
  row('t', 'たちつてとっ'); row('d', 'だぢづでど');
  row('n', 'なにぬねのん');
  row('h', 'はひふへほ'); row('b', 'ばびぶべぼ'); row('p', 'ぱぴぷぺぽ');
  row('m', 'まみむめも');
  row('y', 'やゆよゃゅょ');
  row('r', 'らりるれろ');
  row('w', 'わを');
  row('v', 'ゔ');

  function okuriConsonant(kana) {
    const h = toHiragana(kana.charAt(0));
    return OKURI_CONSONANT[h] || null;
  }

  // ---------------------------------------------------------------------------
  // Composer: the SKK-style preedit state machine.
  //
  // It owns the reading buffer and the candidate list, and talks to the
  // outside world only through the `io` object:
  //   io.lookup(key, isOkuriAri) -> Promise<string[]>   dictionary lookup
  //   io.learn(key, candidate, isOkuriAri)               remember a choice
  //   io.commit(text)                                    insert into the page
  //   io.pageBackspace()                                 delete before caret
  //   io.pageModify(kind) -> bool                        modifier on page text
  //   io.render(state)                                   redraw the UI
  //
  // The buffer is always stored in hiragana; `katakana` only changes how it
  // is shown and committed.
  class Composer {
    constructor(io) {
      this.io = io;
      this.katakana = false;
      this.reset();
    }

    reset() {
      this.stem = '';          // reading before the okuri mark
      this.okuri = '';         // okurigana after the mark
      this.okuriMarked = false;
      this.candidates = null;  // null = not converting
      this.index = 0;
      this.lookupKey = '';
      this.lookupAri = false;
      this.message = '';
      this.seq = (this.seq || 0) + 1; // invalidates in-flight lookups
    }

    get composing() { return this.stem !== '' || this.okuriMarked; }
    get converting() { return this.candidates !== null; }

    show(s) { return this.katakana ? toKatakana(s) : s; }

    state() {
      return {
        katakana: this.katakana,
        stem: this.show(this.stem),
        okuri: this.show(this.okuri),
        okuriMarked: this.okuriMarked,
        candidates: this.candidates ? this.candidates.slice() : null,
        index: this.index,
        message: this.message,
      };
    }

    render() { this.io.render(this.state()); }

    setKatakana(on) { this.katakana = !!on; this.render(); }
    toggleKatakana() { this.setKatakana(!this.katakana); }

    // A kana key (hiragana or katakana from the layout; stored as hiragana).
    async typeKana(ch) {
      const h = toHiragana(ch);
      this.seq++;
      if (this.converting) await this.commitCandidate();
      if (!this.composing && !this.startsWord(h)) {
        this.io.commit(this.show(h));
        return;
      }
      if (this.okuriMarked) this.okuri += h; else this.stem += h;
      this.message = '';
      this.render();
    }

    // Characters that start a composition. Everything else (punctuation,
    // brackets) is inserted directly and commits any pending buffer first.
    startsWord(h) {
      const c = h.codePointAt(0);
      return (c >= 0x3041 && c <= 0x3096) || h === 'ー';
    }

    // Punctuation / space: commit what is pending, then insert directly.
    async typeSymbol(ch) {
      if (this.converting) await this.commitCandidate();
      else if (this.composing) this.commitKana();
      this.io.commit(ch);
    }

    // Any key from the layout. Kana go to the buffer, symbols commit.
    async type(ch) {
      if (this.startsWord(toHiragana(ch))) return this.typeKana(ch);
      return this.typeSymbol(ch);
    }

    // 送: mark where okurigana starts. Pressing it again unmarks.
    toggleOkuri() {
      this.seq++;
      this.message = '';
      if (this.converting) this.cancelConversion();
      if (this.okuriMarked) {
        this.stem += this.okuri;
        this.okuri = '';
        this.okuriMarked = false;
      } else if (this.stem !== '') {
        this.okuriMarked = true;
      } else {
        this.message = '送: type the stem first';
      }
      this.render();
    }

    // ゛ ゜ 小: transform the last buffered kana, or the page char before the caret.
    modify(kind) {
      this.seq++;
      this.message = '';
      if (this.converting) this.cancelConversion();
      if (this.composing) {
        const target = this.okuriMarked && this.okuri ? 'okuri' : 'stem';
        const s = this[target];
        if (!s) { this.render(); return false; }
        const last = s.slice(-1);
        const next = applyModifier(last, kind);
        if (next === null) { this.render(); return false; }
        this[target] = s.slice(0, -1) + next;
        this.render();
        return true;
      }
      return !!this.io.pageModify(kind);
    }

    backspace() {
      this.seq++;
      if (this.converting) { this.cancelConversion(); this.render(); return; }
      if (!this.composing) { this.io.pageBackspace(); return; }
      if (this.okuriMarked) {
        if (this.okuri) this.okuri = this.okuri.slice(0, -1);
        else this.okuriMarked = false;
      } else {
        this.stem = this.stem.slice(0, -1);
      }
      this.message = '';
      this.render();
    }

    cancelConversion() {
      this.candidates = null;
      this.index = 0;
      this.message = '';
      this.seq++;
    }

    // The dictionary key for the current buffer.
    key() {
      if (this.okuriMarked && this.okuri) {
        const cons = okuriConsonant(this.okuri);
        if (!cons) return null;
        return { key: this.stem + cons, ari: true };
      }
      return { key: this.stem, ari: false };
    }

    // 変換: start conversion, or cycle to the next candidate.
    async convert() {
      if (this.converting) {
        if (this.candidates.length) this.index = (this.index + 1) % this.candidates.length;
        this.render();
        return;
      }
      if (!this.stem) return;
      const k = this.key();
      if (!k) { this.message = 'no okuri consonant'; this.render(); return; }
      const seq = ++this.seq;
      this.message = '…';
      this.render();
      let cands;
      try {
        cands = await this.io.lookup(k.key, k.ari);
      } catch (e) {
        if (seq !== this.seq) return;
        this.message = 'lookup failed: ' + (e && e.message ? e.message : e);
        this.render();
        return;
      }
      if (seq !== this.seq) return; // buffer changed while waiting
      cands = (cands || []).slice();
      // Okuri-nasi: offer the katakana spelling last, for loanwords the
      // dictionary does not list (ラーメン, コンピュータ, ...).
      if (!k.ari) {
        const kata = toKatakana(this.stem);
        if (!cands.includes(kata)) cands.push(kata);
      }
      if (!cands.length) {
        this.message = '候補なし';
        this.render();
        return;
      }
      this.lookupKey = k.key;
      this.lookupAri = k.ari;
      this.candidates = cands;
      this.index = 0;
      this.message = '';
      this.render();
    }

    // Click on a candidate: select it (確定 commits).
    select(i) {
      if (!this.converting || i < 0 || i >= this.candidates.length) return;
      this.index = i;
      this.render();
    }

    // 確定: commit the selected candidate, or the plain kana if not converting.
    async confirm() {
      if (this.converting) return this.commitCandidate();
      if (this.composing) this.commitKana();
    }

    async commitCandidate() {
      const cand = this.candidates[this.index];
      const key = this.lookupKey;
      const ari = this.lookupAri;
      const okuri = this.show(this.okuri);
      this.reset();
      this.io.commit(cand + okuri);
      // Learning the katakana fallback too is intended: it then ranks first.
      try { this.io.learn(key, cand, ari); } catch (_) { /* best effort */ }
      this.render();
    }

    // かな: commit the buffer as kana in the current mode.
    commitKana() {
      if (!this.composing) return;
      const text = this.show(this.stem + this.okuri);
      this.reset();
      if (text) this.io.commit(text);
      this.render();
    }
  }

  // Merge learned candidates (most recent first) ahead of dictionary order.
  function rankCandidates(dictCands, learned) {
    const out = [];
    const seen = new Set();
    for (const c of learned || []) if (!seen.has(c)) { seen.add(c); out.push(c); }
    for (const c of dictCands || []) if (!seen.has(c)) { seen.add(c); out.push(c); }
    return out;
  }

  // Move `cand` to the front of a learned list, capped at `max`.
  function learnInto(list, cand, max) {
    const m = max || 8;
    const out = [cand];
    for (const c of list || []) if (c !== cand && out.length < m) out.push(c);
    return out;
  }

  const api = {
    FLICK, flickDirection, toKatakana, toHiragana, applyModifier,
    okuriConsonant, Composer, rankCandidates, learnInto,
  };
  root.KanaCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
