# Dictionary data

`skk-jisyo-l.json` is generated from **SKK-JISYO.L** by `scripts/build-dict.sh`.

- Upstream: https://github.com/skk-dev/dict
- File: https://raw.githubusercontent.com/skk-dev/dict/master/SKK-JISYO.L
- Upstream commit last touching the file: `14a1df7ec8f84410f5fb006978cf00878768150a` (2024-07-18)
- SHA-256 of the raw download used: `c791f578d1b4040fce282db29bc22b2cc7ea46f83e269fab2e0fa779e2967e40`
- Copyright (C) 1988-1995, 1997, 1999-2014 Masahiko Sato, Hironobu Takahashi,
  the SKK Development Team and many contributors (see the header of the original file).
- License: GNU General Public License, version 2 or (at your option) any later
  version. The full text is in [`COPYING`](COPYING).

## What the build changes

The JSON is a mechanical transformation of the original, which is the
preferred form for modification:

1. EUC-JP is converted to UTF-8.
2. Only entries whose reading is hiragana (plus one romaji consonant for
   okuri-ari entries) are kept. Romaji and abbreviation entries are dropped,
   since the keyboard can only type kana.
3. `;annotations` are stripped from candidates. Simple `(concat "...")`
   candidates are decoded; other Lisp candidates are dropped.
4. Duplicate candidates within one entry are removed. Order is preserved.

Format:

```json
{"ari":{"かk":["書","掛",...]}, "nasi":{"かんじ":["漢字","幹事",...]}}
```
