#!/usr/bin/env bash
# Build dict/skk-jisyo-l.json from the raw SKK-JISYO.L (EUC-JP).
#
# Usage: scripts/build-dict.sh [path/to/SKK-JISYO.L] [output.json]
#
# Steps:
#   1. iconv EUC-JP -> UTF-8
#   2. awk: keep only entries whose reading is hiragana (plus one okuri
#      consonant for okuri-ari), strip ";annotations", decode simple
#      (concat "...") candidates, drop anything else that is Lisp,
#      de-duplicate, and emit compact JSON:
#        {"ari":{"かk":["書","掛",...],...},"nasi":{"かんじ":["漢字",...],...}}
#
# Needs only bash, iconv and a POSIX awk. Runs offline.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"

src="${1:-$root/dict-raw/SKK-JISYO.L}"
out="${2:-$root/dict/skk-jisyo-l.json}"

if [ ! -f "$src" ]; then
  echo "error: $src not found." >&2
  echo "Download it first (about 4.5 MB):" >&2
  echo "  mkdir -p dict-raw && curl -fL -o dict-raw/SKK-JISYO.L https://raw.githubusercontent.com/skk-dev/dict/master/SKK-JISYO.L" >&2
  exit 1
fi

command -v iconv >/dev/null || { echo "error: iconv is required" >&2; exit 1; }

tmp="$(mktemp "${TMPDIR:-/tmp}/skkdict.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

iconv -f EUC-JP -t UTF-8 "$src" > "$tmp"

# Work on raw bytes so the script does not depend on the awk's UTF-8 support.
LC_ALL=C awk '
function octdecode(s,    out, i, c, n) {
  out = ""
  i = 1
  while (i <= length(s)) {
    c = substr(s, i, 1)
    if (c == "\\" && substr(s, i + 1, 3) ~ /^[0-7][0-7][0-7]$/) {
      n = (substr(s, i + 1, 1) + 0) * 64 + (substr(s, i + 2, 1) + 0) * 8 + (substr(s, i + 3, 1) + 0)
      out = out sprintf("%c", n)
      i += 4
    } else if (c == "\\" && i < length(s)) {
      out = out substr(s, i + 1, 1)
      i += 2
    } else {
      out = out c
      i++
    }
  }
  return out
}
function jsonstr(s) {
  gsub(/\\/, "\\\\", s)
  gsub(/"/, "\\\"", s)
  gsub(/\t/, "\\t", s)
  return "\"" s "\""
}
BEGIN {
  section = ""
  # One hiragana code point (U+3041..U+3096) or the long-vowel mark (U+30FC), as UTF-8 bytes.
  kana = "(\343\201[\201-\277]|\343\202[\200-\226]|\343\203\274)"
  re_nasi = "^" kana "+$"
  re_ari  = "^" kana "+[a-z]$"
  printf "{"
  first_section = 1
}
/^;; okuri-ari entries\./  { start_section("ari");  next }
/^;; okuri-nasi entries\./ { start_section("nasi"); next }
/^;/ { next }
section == "" { next }
{
  sp = index($0, " /")
  if (sp == 0) next
  reading = substr($0, 1, sp - 1)
  if (section == "ari"  && reading !~ re_ari)  next
  if (section == "nasi" && reading !~ re_nasi) next

  body = substr($0, sp + 2)
  n = split(body, parts, "/")
  count = 0
  delete seen
  list = ""
  for (i = 1; i <= n; i++) {
    c = parts[i]
    if (c == "") continue
    # (concat "...") candidates: decode the single-string form, drop the rest.
    if (substr(c, 1, 1) == "(") {
      if (c ~ /^\(concat "[^"]*"\)/) {
        c = substr(c, 10)
        c = substr(c, 1, index(c, "\"") - 1)
        c = octdecode(c)
      } else {
        continue
      }
    }
    semi = index(c, ";")
    if (semi > 0) c = substr(c, 1, semi - 1)
    if (c == "" || (c in seen)) continue
    seen[c] = 1
    list = list (count ? "," : "") jsonstr(c)
    count++
  }
  if (count == 0) next
  printf "%s\n%s:[%s]", (entries ? "," : ""), jsonstr(reading), list
  entries++
}
function start_section(name) {
  if (section != "") printf "\n}"
  printf "%s\"%s\":{", (first_section ? "" : ","), name
  first_section = 0
  section = name
  entries = 0
}
END {
  if (section != "") printf "\n}"
  printf "}\n"
}
' "$tmp" > "$out.tmp"

mv "$out.tmp" "$out"
echo "wrote $out ($(wc -c < "$out") bytes)"
