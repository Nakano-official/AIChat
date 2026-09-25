// GitHub Pages 用の静的デモを _site/ に組み立てる。
//   1. src/ の配信物をコピー
//   2. 絶対パス(/app.css 等)を相対パスへ  … サブパス配信(/<repo>/)で404になるため
//   3. demo.js を差し込む                  … サーバーが無いのでfetchを差し替える
// src/ には一切手を入れない。デモ用の細工はここだけに閉じる。
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const OUT = join(ROOT, "_site");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const f of ["app.css", "shared.js", "research.js"]) copyFileSync(join(SRC, f), join(OUT, f));
copyFileSync(join(ROOT, "demo", "demo.js"), join(OUT, "demo.js"));

// 絶対パス -> 相対パス。ファイルによって出てくるものが違うので、
// 「全部あること」ではなく「置換後に1つも残っていないこと」で担保する。
const REWRITE = [
  ['src="/research.js"', 'src="research.js"'],
  ['href="/app.css"',  'href="app.css"'],
  ['src="/shared.js"', 'src="shared.js"'],
  ['href="/notes"',    'href="notes.html"'],
  ['href="/"',         'href="index.html"'],
];
const LEFTOVER = /(?:href|src)="\/[^"]*"/g;
const ANCHOR = '<script src="shared.js"></script>';

for (const [from, to] of [["chat.html", "index.html"], ["notes.html", "notes.html"]]) {
  let html = readFileSync(join(SRC, from), "utf8");
  if(from === "chat.html") html = html.replace('$("webtoggle"), ', '').replace('webMode = WEB_MODES.includes(settings.web) ? settings.web : "research";', 'webMode = "off"; $("webtoggle").disabled = true;');
  for (const [a, b] of REWRITE) html = html.split(a).join(b);

  const left = html.match(LEFTOVER);
  if (left) throw new Error(from + ": 相対化できていない絶対パスが残っている: " + [...new Set(left)].join(", "));

  // demo.js は shared.js の直後・アプリ本体より前に読み込む（fetchを先に差し替えるため）
  if (!html.includes(ANCHOR)) throw new Error(from + ": shared.js の読み込みが見つからない");
  html = html.replace(ANCHOR, ANCHOR + "\n" + '<script src="demo.js"></script>');

  writeFileSync(join(OUT, to), html, "utf8");
  console.log(from + " -> _site/" + to + "  (" + html.length.toLocaleString() + " bytes)");
}

writeFileSync(join(OUT, ".nojekyll"), "");   // _ 始まりのファイルをJekyllに消させない
console.log("done");
