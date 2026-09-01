// Ollamaチャット & 授業サマリ用の軽量サーバー（依存ライブラリなし）
//  - "/"            → chat.html を配信
//  - "/notes"       → notes.html（授業サマリ）を配信
//  - "/notes/api/*" → ノート保存API（<プロジェクトルート>/data/notes.json に保存）
//  - "/api/*"        → Ollama(127.0.0.1:11434) へリバースプロキシ（許可リスト方式）
// 画面もAPIも同一オリジンになるので、HTTPS化(tailscale serve)時の
// 「混在コンテンツ」ブロックとCORSを完全に回避できる。
const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec, execFile } = require("child_process");

const PORT = 80;                 // ポート80で配信 → URLにポート番号不要 (http://aichat)
const OLLAMA = { host: "127.0.0.1", port: 11434 };
const MAX_UPLOAD = 48 * 1024 * 1024; // ファイル抽出(PDF/画像)の最大受信サイズ
const MAX_JSON   = 8 * 1024 * 1024;  // ノートJSON APIの最大受信サイズ
// Ollamaへ中継してよいパス（破壊的/管理系エンドポイントは通さない）
// /api/show はモデルの能力(thinking対応の有無/レベル制か)を読むだけの参照系。
const PROXY_ALLOW = new Set(["/api/tags", "/api/version", "/api/show", "/api/chat", "/api/generate", "/api/embeddings"]);
// このファイルは src/ 配下にあるので、ブラウザ配信物は同階層、
// data/ と tools/ は1つ上（プロジェクトルート）を見る。
const ROOT = path.join(__dirname, "..");
const HTML = (name) => path.join(__dirname, name);
const DATA_DIR = path.join(ROOT, "data");
const NOTES_FILE = path.join(DATA_DIR, "notes.json");
const CHATS_FILE = path.join(DATA_DIR, "chats.json"); // 会話履歴（全端末共有）
const TMP_DIR = path.join(DATA_DIR, "tmp");
const LOG_FILE = path.join(DATA_DIR, "server.log");

// コンソールと data/server.log の両方へ出力（24時間稼働サーバーの恒久ログ）
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (_) {}
}

// ===== 外部ツール（PDF抽出 / OCR）のパス解決 =====
function findPopplerBin() {
  const root = path.join(ROOT, "tools", "poppler");
  const stack = [root];
  try {
    while (stack.length) {
      const d = stack.pop();
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) stack.push(fp);
        else if (e.name.toLowerCase() === "pdftotext.exe") return path.dirname(fp);
      }
    }
  } catch (_) {}
  return null;
}
const POPPLER_BIN = findPopplerBin();
const PDFTOTEXT = POPPLER_BIN ? path.join(POPPLER_BIN, "pdftotext.exe") : "pdftotext.exe";
const PDFTOPPM  = POPPLER_BIN ? path.join(POPPLER_BIN, "pdftoppm.exe")  : "pdftoppm.exe";
const TESSERACT = fs.existsSync("C:\\Program Files\\Tesseract-OCR\\tesseract.exe")
  ? "C:\\Program Files\\Tesseract-OCR\\tesseract.exe" : "tesseract.exe";
const TESSDATA = path.join(ROOT, "tools", "tessdata");
const IMG_EXT = ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "gif"];

function runExe(exe, args) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(err.message + (stderr ? " / " + stderr : ""))); else resolve(stdout);
    });
  });
}
function readBodyBuffer(req, max = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > max) { reject(new Error("リクエストが大きすぎます")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
// Tesseractは日本語の文字間にスペースを入れがち → 和字どうしの間のスペースを除去
function collapseJaSpaces(t) {
  const JA = "\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u9fff\\uff00-\\uffef";
  return t.replace(new RegExp("([" + JA + "])[ \\t]+(?=[" + JA + "])", "g"), "$1");
}

// PDF/画像をテキスト化して返す（デジタルPDFはpdftotext、無ければ/画像はTesseract OCR）
async function handleExtract(req, res, name) {
  try {
    const buf = await readBodyBuffer(req);
    const m = name.match(/\.([a-z0-9]+)$/i);
    const ext = (m ? m[1] : "").toLowerCase();
    if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
    const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const inFile = path.join(TMP_DIR, stamp + "." + (ext || "bin"));
    fs.writeFileSync(inFile, buf);
    try {
      let text = "", method = "";
      if (ext === "pdf") {
        text = await runExe(PDFTOTEXT, ["-enc", "UTF-8", inFile, "-"]);
        if (text.trim().length >= 20) {
          method = "pdf-text";                       // 文字が入っているデジタルPDF
        } else {
          const prefix = path.join(TMP_DIR, stamp + "_p");   // スキャンPDF → 画像化してOCR
          await runExe(PDFTOPPM, ["-png", "-r", "200", inFile, prefix]);
          const pages = fs.readdirSync(TMP_DIR).filter((f) => f.startsWith(stamp + "_p") && f.endsWith(".png")).sort();
          let acc = "";
          for (const p of pages) {
            const pf = path.join(TMP_DIR, p);
            acc += await runExe(TESSERACT, ["--tessdata-dir", TESSDATA, "-l", "jpn+eng", pf, "stdout"]) + "\n\n";
          }
          text = acc; method = "pdf-ocr";
        }
      } else if (IMG_EXT.includes(ext)) {
        text = await runExe(TESSERACT, ["--tessdata-dir", TESSDATA, "-l", "jpn+eng", inFile, "stdout"]);
        method = "image-ocr";
      } else {
        text = buf.toString("utf8"); method = "text";
      }
      let clean = text.replace(/\r\n/g, "\n");
      if (method === "image-ocr" || method === "pdf-ocr") clean = collapseJaSpaces(clean);
      sendJson(res, 200, { text: clean.trim(), method });
    } finally {
      // この抽出で作った一時ファイルを stamp プレフィックスで一括削除
      // （pdftoppm が途中失敗して page 列挙前に抜けても取りこぼさない）
      try {
        for (const f of fs.readdirSync(TMP_DIR)) {
          if (f.startsWith(stamp)) { try { fs.unlinkSync(path.join(TMP_DIR, f)); } catch (_) {} }
        }
      } catch (_) {}
    }
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
}

// ===== データ保存（JSON配列ストア：ノート / 会話履歴で共用） =====
function ensureData() {
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  for (const f of [NOTES_FILE, CHATS_FILE]) {
    try { if (!fs.existsSync(f)) fs.writeFileSync(f, "[]", "utf8"); } catch (e) {}
  }
}
function readJsonArr(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) || []; } catch (e) { return []; }
}
function writeJsonArr(file, arr) {
  // 一時ファイルに書いてから rename（書き込み中の中断でファイルが壊れない）
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), "utf8");
  fs.renameSync(tmp, file);
}
// 読み取り→更新→書き込みが重なって書き込みが消えないよう直列化するロックを生成
function makeLock() {
  let p = Promise.resolve();
  return (fn) => { const run = p.then(fn, fn); p = run.then(() => {}, () => {}); return run; };
}
const readNotes = () => readJsonArr(NOTES_FILE);
const writeNotes = (arr) => writeJsonArr(NOTES_FILE, arr);
const withNotesLock = makeLock();
const readChats = () => readJsonArr(CHATS_FILE);
const writeChats = (arr) => writeJsonArr(CHATS_FILE, arr);
const withChatsLock = makeLock();
function readBody(req, max = MAX_JSON) {
  return new Promise((resolve, reject) => {
    let b = ""; let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > max) { reject(new Error("リクエストが大きすぎます")); req.destroy(); return; }
      b += c;
    });
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}
function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

async function handleNotesApi(req, res) {
  const url = req.url.replace(/\?.*$/, "");
  try {
    if (url === "/notes/api/list" && req.method === "GET") {
      // 一覧は本文(source/summary)を省いて軽く返す
      const list = readNotes().map(({ id, subject, title, date, type, createdAt, updatedAt }) =>
        ({ id, subject, title, date, type: type || "note", createdAt, updatedAt }));
      list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return sendJson(res, 200, list);
    }
    if (url === "/notes/api/get" && req.method === "GET") {
      const id = new URL(req.url, "http://x").searchParams.get("id");
      const note = readNotes().find((n) => n.id === id);
      return note ? sendJson(res, 200, note) : sendJson(res, 404, { error: "not found" });
    }
    if (url === "/notes/api/save" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const note = await withNotesLock(() => {
        const notes = readNotes();
        const now = Date.now();
        let note = notes.find((n) => n.id === body.id);
        if (note) {
          Object.assign(note, {
            subject: body.subject || "", title: body.title || "",
            date: body.date || "", source: body.source || "", summary: body.summary || "",
            type: body.type || note.type || "note", updatedAt: now,
          });
        } else {
          note = {
            id: body.id || (now.toString(36) + Math.random().toString(36).slice(2, 6)),
            subject: body.subject || "", title: body.title || "",
            date: body.date || "", source: body.source || "", summary: body.summary || "",
            type: body.type || "note", createdAt: now, updatedAt: now,
          };
          notes.push(note);
        }
        writeNotes(notes);
        return note;
      });
      return sendJson(res, 200, note);
    }
    if (url === "/notes/api/delete" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      await withNotesLock(() => writeNotes(readNotes().filter((n) => n.id !== body.id)));
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: "unknown endpoint" });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
}

// ===== 会話履歴API（全端末共有, chats.json） =====
async function handleChatsApi(req, res) {
  const url = req.url.replace(/\?.*$/, "");
  try {
    if (url === "/chats/api/list" && req.method === "GET") {
      // 一覧は messages を省いて軽く返す
      const list = readChats().map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }));
      list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return sendJson(res, 200, list);
    }
    if (url === "/chats/api/get" && req.method === "GET") {
      const id = new URL(req.url, "http://x").searchParams.get("id");
      const chat = readChats().find((c) => c.id === id);
      return chat ? sendJson(res, 200, chat) : sendJson(res, 404, { error: "not found" });
    }
    if (url === "/chats/api/save" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const chat = await withChatsLock(() => {
        const chats = readChats();
        const now = Date.now();
        const messages = Array.isArray(body.messages) ? body.messages : [];
        let chat = chats.find((c) => c.id === body.id);
        if (chat) {
          chat.title = body.title || chat.title || "新しいチャット";
          chat.messages = messages;
          chat.updatedAt = now;
        } else {
          chat = {
            id: body.id || (now.toString(36) + Math.random().toString(36).slice(2, 6)),
            title: body.title || "新しいチャット",
            messages, createdAt: now, updatedAt: now,
          };
          chats.push(chat);
        }
        writeChats(chats);
        return chat;
      });
      return sendJson(res, 200, chat);
    }
    if (url === "/chats/api/delete" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      await withChatsLock(() => writeChats(readChats().filter((c) => c.id !== body.id)));
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: "unknown endpoint" });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
}

// ===== Ollamaへのリバースプロキシ =====
function proxyToOllama(req, res) {
  // Ollamaのオリジン保護対策: Host書き換え＋Origin/Refererを除去し、同一オリジン扱いにする
  // (これをしないと外部ホスト名=Tailscale経由のブラウザからのPOSTがOllamaに403で弾かれる)
  const headers = { ...req.headers, host: `${OLLAMA.host}:${OLLAMA.port}` };
  delete headers.origin; delete headers.Origin;
  delete headers.referer; delete headers.Referer;
  const opts = {
    hostname: OLLAMA.host, port: OLLAMA.port, path: req.url, method: req.method,
    headers,
  };
  const pr = http.request(opts, (up) => {
    log(`  -> Ollama ${req.url} status ${up.statusCode}`);
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res); // ストリーミング応答もそのまま中継
  });
  pr.on("error", (e) => { log(`  -> Ollama proxy ERROR ${req.url}: ${e.message}`); if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Ollama proxy error: " + e.message); });
  // クライアントが切断したら上流(Ollama)の生成も止める。
  // 【重要】req の "aborted" は Node 17 で非推奨になり Node 24 では発火しない。
  // これに頼っていた頃は「停止」を押しても Ollama が生成を続け、1並列キュー
  // (enqueueProxy) の都合で次のリクエストが延々待たされていた。
  // res の "close" を主たる検出に使い、writableFinished で正常終了と区別する。
  const abortUpstream = () => {
    if (pr.destroyed) return;
    log(`  -> client ABORTED ${req.url}`);
    pr.destroy();
  };
  res.on("close", () => { if (!res.writableFinished) abortUpstream(); });
  req.on("aborted", abortUpstream);   // 古いNode向けの保険（pr.destroyed で二重実行を防ぐ）
  req.pipe(pr); // リクエストボディを中継
}

// 生成系（/api/chat・/api/generate）は1並列に直列化する。
// 6GB VRAM ではモデルの同時実行で詰まる/失敗するため、複数端末から同時に来ても順番に処理する。
// 軽量な GET（/api/tags 等）はキューを通さず即応する。
let genQueue = Promise.resolve();
function enqueueProxy(req, res) {
  const run = genQueue.then(() => new Promise((resolve) => {
    // 順番待ちの間にクライアントが切断していたら、Ollamaを動かさずスキップ
    if (req.destroyed || res.writableEnded) { resolve(); return; }
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    res.on("close", finish);
    res.on("finish", finish);
    proxyToOllama(req, res);
  }));
  genQueue = run.then(() => {}, () => {});
  return run;
}

function serveFile(res, file, type = "text/html; charset=utf-8") {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("ファイルが見つかりません: " + err.message); return; }
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const p = req.url.replace(/\?.*$/, "");
  log(`${req.method} ${p} from ${req.socket.remoteAddress}`);
  if (p === "/notes/api/extract" && req.method === "POST") {
    const name = new URL(req.url, "http://x").searchParams.get("name") || "";
    return handleExtract(req, res, name);
  }
  if (p.startsWith("/notes/api/")) return handleNotesApi(req, res);
  if (p.startsWith("/chats/api/")) return handleChatsApi(req, res);
  if (p.startsWith("/api/")) {
    // 許可したエンドポイントのみOllamaへ中継（モデル削除/pull等の管理系は拒否）
    if (!PROXY_ALLOW.has(p)) { return sendJson(res, 403, { error: "このエンドポイントは許可されていません" }); }
    // 生成系は逐次キュー、軽量GETは即中継
    if (p === "/api/chat" || p === "/api/generate") return enqueueProxy(req, res);
    return proxyToOllama(req, res);
  }
  if (p === "/app.css") return serveFile(res, HTML("app.css"), "text/css; charset=utf-8");
  if (p === "/shared.js") return serveFile(res, HTML("shared.js"), "application/javascript; charset=utf-8");
  if (p === "/notes" || p === "/notes.html") return serveFile(res, HTML("notes.html"));
  serveFile(res, HTML("chat.html"));
});

ensureData();
// 0.0.0.0 で待ち受け（localhost + Tailscale経由の両方からアクセス可能）
server.listen(PORT, "0.0.0.0", () => {
  const url = PORT === 80 ? "http://localhost" : `http://localhost:${PORT}`;
  log(`チャットツールを起動しました: ${url}`);
  log(`授業サマリ: ${url}/notes`);
  console.log("終了するには このウィンドウで Ctrl+C を押してください。");
  // NO_OPEN=1 のときはブラウザ自動起動を抑止（再起動を繰り返す開発・レビュー用）
  if (!process.env.NO_OPEN) exec(`start "" "${url}"`);
});
