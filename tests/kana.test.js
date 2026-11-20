// Unit tests for kana.js. Run: node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../kana.js');

test('dakuten toggles both ways', () => {
  const cases = [['か', 'が'], ['が', 'か'], ['し', 'じ'], ['つ', 'づ'], ['は', 'ば'],
    ['ば', 'は'], ['う', 'ゔ'], ['ゔ', 'う'], ['カ', 'ガ'], ['ウ', 'ヴ'], ['ヴ', 'ウ'],
    ['ぱ', 'ば'], ['パ', 'バ']];
  for (const [a, b] of cases) assert.equal(K.applyModifier(a, 'dakuten'), b, a);
  assert.equal(K.applyModifier('あ', 'dakuten'), null);
  assert.equal(K.applyModifier('ん', 'dakuten'), null);
});

test('handakuten: は→ぱ→は, ば→ぱ', () => {
  assert.equal(K.applyModifier('は', 'handakuten'), 'ぱ');
  assert.equal(K.applyModifier('ぱ', 'handakuten'), 'は');
  assert.equal(K.applyModifier('ば', 'handakuten'), 'ぱ');
  assert.equal(K.applyModifier('ほ', 'handakuten'), 'ぽ');
  assert.equal(K.applyModifier('ホ', 'handakuten'), 'ポ');
  assert.equal(K.applyModifier('か', 'handakuten'), null);
});

test('small kana toggles', () => {
  const cases = [['つ', 'っ'], ['っ', 'つ'], ['や', 'ゃ'], ['ゃ', 'や'], ['ゆ', 'ゅ'],
    ['よ', 'ょ'], ['あ', 'ぁ'], ['ぉ', 'お'], ['わ', 'ゎ'], ['ツ', 'ッ'], ['ャ', 'ヤ'],
    ['づ', 'っ']];
  for (const [a, b] of cases) assert.equal(K.applyModifier(a, 'small'), b, a);
  assert.equal(K.applyModifier('か', 'small'), null);
});

test('kana conversion', () => {
  assert.equal(K.toKatakana('らーめん、ゔぁ'), 'ラーメン、ヴァ');
  assert.equal(K.toHiragana('ラーメン、ヴァ'), 'らーめん、ゔぁ');
  assert.equal(K.toHiragana('漢字abc'), '漢字abc');
});

test('okuri consonants', () => {
  assert.equal(K.okuriConsonant('く'), 'k');
  assert.equal(K.okuriConsonant('う'), 'u');
  assert.equal(K.okuriConsonant('っ'), 't');
  assert.equal(K.okuriConsonant('ん'), 'n');
  assert.equal(K.okuriConsonant('び'), 'b');
  assert.equal(K.okuriConsonant('ク'), 'k');
  assert.equal(K.okuriConsonant('ー'), null);
});

test('flick directions', () => {
  assert.equal(K.flickDirection(0, 0), 'c');
  assert.equal(K.flickDirection(5, 5), 'c');
  assert.equal(K.flickDirection(-30, 4), 'l');
  assert.equal(K.flickDirection(30, -4), 'r');
  assert.equal(K.flickDirection(3, -30), 'u');
  assert.equal(K.flickDirection(3, 30), 'd');
  assert.equal(K.FLICK['か'].u, 'く');
  assert.equal(K.FLICK['わ'].r, 'ー');
  assert.equal(K.FLICK['わ'].d, undefined);
});

test('rank / learn helpers', () => {
  assert.deepEqual(K.rankCandidates(['a', 'b', 'c'], ['c']), ['c', 'a', 'b']);
  assert.deepEqual(K.rankCandidates(['a'], undefined), ['a']);
  assert.deepEqual(K.learnInto(['x', 'y'], 'y'), ['y', 'x']);
  assert.equal(K.learnInto(Array.from({ length: 20 }, (_, i) => 'c' + i), 'n', 8).length, 8);
});

// --- Composer ---------------------------------------------------------------
function harness(dict) {
  const out = { text: '', learned: [], renders: 0, page: [] };
  const io = {
    lookup: async (key, ari) => (dict[(ari ? 'a:' : 'n:') + key] || []).slice(),
    learn: (key, cand, ari) => out.learned.push([key, cand, ari]),
    commit: (t) => { out.text += t; },
    pageBackspace: () => { out.text = out.text.slice(0, -1); },
    pageModify: (kind) => {
      const next = K.applyModifier(out.text.slice(-1), kind);
      if (next === null) return false;
      out.text = out.text.slice(0, -1) + next;
      return true;
    },
    render: () => { out.renders++; },
  };
  return { c: new K.Composer(io), out };
}

const DICT = {
  'n:かんじ': ['漢字', '幹事', '感じ'],
  'a:かk': ['書', '掛'],
  'a:いt': ['言', '行'],
};

async function typeAll(c, s) { for (const ch of s) await c.type(ch); }

test('buffer, convert, cycle, confirm', async () => {
  const { c, out } = harness(DICT);
  await typeAll(c, 'かんじ');
  assert.equal(out.text, '');
  assert.equal(c.state().stem, 'かんじ');
  await c.convert();
  assert.deepEqual(c.state().candidates, ['漢字', '幹事', '感じ', 'カンジ']);
  await c.convert();
  assert.equal(c.state().index, 1);
  await c.confirm();
  assert.equal(out.text, '幹事');
  assert.deepEqual(out.learned, [['かんじ', '幹事', false]]);
  assert.equal(c.composing, false);
});

test('cycling wraps around', async () => {
  const { c } = harness(DICT);
  await typeAll(c, 'かんじ');
  await c.convert();
  for (let i = 0; i < 4; i++) await c.convert();
  assert.equal(c.state().index, 0);
});

test('select by click then confirm', async () => {
  const { c, out } = harness(DICT);
  await typeAll(c, 'かんじ');
  await c.convert();
  c.select(2);
  await c.confirm();
  assert.equal(out.text, '感じ');
});

test('unknown word offers katakana', async () => {
  const { c, out } = harness(DICT);
  await typeAll(c, 'らーめん');
  await c.convert();
  assert.deepEqual(c.state().candidates, ['ラーメン']);
  await c.confirm();
  assert.equal(out.text, 'ラーメン');
});

test('typing during conversion commits the candidate first', async () => {
  const { c, out } = harness(DICT);
  await typeAll(c, 'かんじ');
  await c.convert();
  await c.type('を');
  assert.equal(out.text, '漢字');
  assert.equal(c.state().stem, 'を');
});

test('punctuation commits the buffer as kana', async () => {
  const { c, out } = harness(DICT);
  await typeAll(c, 'ねこ');
  await c.type('。');
  assert.equal(out.text, 'ねこ。');
  assert.equal(c.composing, false);
});

test('empty buffer types straight to the page', async () => {
  const { c, out } = harness(DICT);
  await c.type('「');
  assert.equal(out.text, '「');
  await c.typeSymbol('　');
  assert.equal(out.text, '「　');
});

test('かな commit respects katakana mode', async () => {
  const { c, out } = harness(DICT);
  await typeAll(c, 'てすと');
  c.setKatakana(true);
  assert.equal(c.state().stem, 'テスト');
  c.commitKana();
  assert.equal(out.text, 'テスト');
});

test('katakana typed in katakana mode still looks up hiragana', async () => {
  const { c, out } = harness(DICT);
  c.setKatakana(true);
  await typeAll(c, 'カンジ');
  await c.convert();
  await c.confirm();
  assert.equal(out.text, '漢字');
});

test('okuri-ari: か 送 く → 書く', async () => {
  const { c, out } = harness(DICT);
  await c.type('か');
  c.toggleOkuri();
  await c.type('く');
  const s = c.state();
  assert.equal(s.stem, 'か');
  assert.equal(s.okuri, 'く');
  await c.convert();
  assert.deepEqual(c.state().candidates, ['書', '掛']);
  await c.confirm();
  assert.equal(out.text, '書く');
  assert.deepEqual(out.learned, [['かk', '書', true]]);
});

test('okuri-ari with っ: い 送 っ た → 言った', async () => {
  const { c, out } = harness(DICT);
  await c.type('い');
  c.toggleOkuri();
  await typeAll(c, 'つた');
  // turn つ into っ with 小 while it is the last okuri char? It is not last; do it in order:
  assert.equal(c.state().okuri, 'つた');
  c.backspace(); c.modify('small'); await c.type('た');
  assert.equal(c.state().okuri, 'った');
  await c.convert();
  await c.confirm();
  assert.equal(out.text, '言った');
});

test('送 needs a stem, toggles off, backspace unmarks', async () => {
  const { c } = harness(DICT);
  c.toggleOkuri();
  assert.equal(c.state().okuriMarked, false);
  await c.type('か');
  c.toggleOkuri();
  assert.equal(c.state().okuriMarked, true);
  c.backspace();
  assert.equal(c.state().okuriMarked, false);
  assert.equal(c.state().stem, 'か');
  c.toggleOkuri();
  await c.type('く');
  c.toggleOkuri(); // unmark folds okuri back into the stem
  assert.equal(c.state().stem, 'かく');
});

test('modifiers act on the buffer, then on the page', async () => {
  const { c, out } = harness(DICT);
  await c.type('か');
  c.modify('dakuten');
  assert.equal(c.state().stem, 'が');
  c.modify('dakuten');
  assert.equal(c.state().stem, 'か');
  c.commitKana();
  assert.equal(out.text, 'か');
  c.modify('dakuten');
  assert.equal(out.text, 'が');
  assert.equal(c.modify('small'), false);
});

test('backspace: cancels conversion, edits buffer, then page', async () => {
  const { c, out } = harness(DICT);
  out.text = 'x';
  await typeAll(c, 'かんじ');
  await c.convert();
  c.backspace();
  assert.equal(c.converting, false);
  assert.equal(c.state().stem, 'かんじ');
  c.backspace(); c.backspace(); c.backspace();
  assert.equal(c.composing, false);
  c.backspace();
  assert.equal(out.text, '');
});

test('no candidates leaves the buffer alone', async () => {
  const { c } = harness({});
  await c.type('か');
  c.toggleOkuri();
  await c.type('く');
  await c.convert();
  assert.equal(c.converting, false);
  assert.equal(c.state().message, '候補なし');
  assert.equal(c.state().stem, 'か');
});

test('stale lookup is ignored after the buffer changes', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { c } = harness(DICT);
  c.io.lookup = async () => { await gate; return ['遅']; };
  await c.type('お');
  const p = c.convert();
  c.backspace(); // buffer changes while lookup is pending
  release();
  await p;
  assert.equal(c.converting, false);
});
