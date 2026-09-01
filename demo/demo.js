/* GitHub Pages 用のデモモード。
   ビルド時にだけ差し込まれるファイルで、アプリ本体（src/）はこれを一切参照しない。
   サーバーが無い環境で fetch を横取りし、作り物のデータを返して見た目だけ再現する。
   ここに出てくる会話・ノート・検索結果はすべて架空のもの。 */
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });

  // NDJSON を1行ずつ流して、実際のストリーミング生成に見せる
  function stream(lines, delay = 26) {
    return new Response(new ReadableStream({
      async start(c) {
        const enc = new TextEncoder();
        for (const l of lines) { c.enqueue(enc.encode(JSON.stringify(l) + "\n")); await sleep(delay); }
        c.close();
      },
    }), { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
  }
  const chunk = (text, key) => {
    const out = [];
    for (let i = 0; i < text.length; i += 3) {
      const s = text.slice(i, i + 3);
      out.push(key === "response" ? { response: s, done: false } : { message: { content: s }, done: false });
    }
    out.push(key === "response" ? { response: "", done: true } : { message: { content: "" }, done: true });
    return out;
  };

  const REPLY = "こんにちは。これは GitHub Pages 上のデモ版です。\n\n"
    + "画面の見た目と操作は本物と同じですが、**AIは動いていません**。あらかじめ用意した文章を流しているだけです。\n\n"
    + "実際に使うには、手元のPCで Ollama とこのサーバーを動かす必要があります。\n\n"
    + "- サイドバーの会話切り替え\n- 設定パネル（モデル・創造性・役割）\n- Markdownの描画とコードのコピー\n\n"
    + "このあたりは実際に触れます。";

  const CONVS = [
    { id: "d1", title: "デモ会話", createdAt: Date.now() - 3600e3, updatedAt: Date.now() - 60e3, messages: [
      { role: "user", content: "このアプリについて教えて" },
      { role: "assistant", model: "qwen3.5:9b", content: REPLY },
    ]},
    { id: "d2", title: "コードの表示例", createdAt: Date.now() - 864e5, updatedAt: Date.now() - 864e5, messages: [
      { role: "user", content: "コードブロックの見え方を見せて" },
      { role: "assistant", model: "qwen3.5:9b", content: "こう表示されます。右上のボタンでコピーできます。\n\n```js\nconst greet = (name) => `こんにちは、${name}さん`;\nconsole.log(greet(\"世界\"));\n```\n\n表も使えます。\n\n| 項目 | 値 |\n|---|---|\n| モデル | qwen3.5:9b |\n| 速度 | 7.6 tok/s |" },
    ]},
  ];
  const NOTES = [
    { id: "n1", type: "note", subject: "データベース論", title: "第5回 トランザクション", date: "2026-05-12",
      source: "（デモ用のサンプルです。実際はここに授業の書き起こしが入ります）",
      summary: "### 要点\n\n- **ACID特性** — 原子性・一貫性・独立性・耐久性\n- **分離レベル** — READ UNCOMMITTED から SERIALIZABLE までの4段階\n- **MVCC** — 更新のたびに版を作り、読み手が書き手を待たない",
      updatedAt: Date.now() - 6048e5 },
    { id: "n2", type: "memo", title: "レポート締切", source: "レポート締切\n再来週の講義開始時まで。2000字程度。", updatedAt: Date.now() - 3600e3 },
  ];

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const real = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const url = String(typeof input === "string" ? input : (input && input.url) || "");
    const path = url.replace(/^https?:\/\/[^/]+/, "").replace(/^\.?\//, "/");

    if (path.startsWith("/api/tags"))    return json({ models: [{ name: "qwen3.5:9b" }, { name: "qwen3.5:4b" }] });
    if (path.startsWith("/api/version")) return json({ version: "demo" });
    if (path.startsWith("/api/show"))    return json({ capabilities: ["completion", "vision", "tools", "thinking"], template: "" });
    if (path.startsWith("/api/ps"))      return json({ models: [{ name: "qwen3.5:9b", size: 6.6e9, size_vram: 6.6e9 }] });
    if (path.startsWith("/warm/api/"))   return json({ warm: "qwen3.5:9b" });
    if (path.startsWith("/api/chat"))    { await sleep(400); return stream(chunk(REPLY, "content")); }
    if (path.startsWith("/api/generate")){ await sleep(400); return stream(chunk(NOTES[0].summary, "response")); }

    if (path.startsWith("/chats/api/list"))   return json(CONVS.map(({ messages, ...m }) => m));
    if (path.startsWith("/chats/api/get"))    return json(clone(CONVS.find((c) => c.id === new URL(url, location.href).searchParams.get("id")) || CONVS[0]));
    if (path.startsWith("/chats/api/save"))   return json({ ok: true });
    if (path.startsWith("/chats/api/delete")) return json({ ok: true });

    if (path.startsWith("/notes/api/list"))   return json(NOTES.map(({ source, summary, ...m }) => m));
    if (path.startsWith("/notes/api/get"))    return json(clone(NOTES.find((n) => n.id === new URL(url, location.href).searchParams.get("id")) || NOTES[0]));
    if (path.startsWith("/notes/api/save"))   return json({ ok: true });
    if (path.startsWith("/notes/api/delete")) return json({ ok: true });
    if (path.startsWith("/notes/api/extract"))return json({ text: "（デモ版ではファイルからの抽出は行いません）", method: "demo" });

    if (path.startsWith("/web/api/search")) return json({ query: "デモ", results: [
      { title: "デモ版では実際の検索は行いません", url: "https://example.com/", snippet: "手元で動かすと DuckDuckGo を検索します。" }] });
    if (path.startsWith("/web/api/fetch"))  return json({ url: "https://example.com/", title: "デモ", text: "（デモ版ではページを取得しません）", chars: 0 });

    return real(input, init);   // 自分自身のCSS/JSなどは素通し
  };

  addEventListener("DOMContentLoaded", () => {
    const b = document.createElement("div");
    b.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:9999;padding:.45rem .8rem;"
      + "font-size:12px;text-align:center;background:#1e293b;color:#e2e8f0;border-top:1px solid #334155";
    b.innerHTML = 'これは<strong>見た目のデモ</strong>です。AIは動作せず、決まった文章を再生しています。'
      + ' <a href="https://github.com/Nakano-official/AIChat" style="color:#7dd3fc;text-decoration:underline">ソースと導入方法</a>';
    document.body.appendChild(b);
    document.body.style.paddingBottom = "2.2rem";
  });
})();
