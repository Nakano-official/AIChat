// chat.html / notes.html 共有ユーティリティ
//  - Markdown描画（XSS対策: HTMLエスケープ後に変換）
//  - クリップボードコピー
// window に公開して両ページから利用する。
(function () {
  let codeId = 0;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function inline(t) {
    t = escapeHtml(t);
    t = t.replace(/`([^`]+)`/g, '<code class="inline">$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return t;
  }

  function renderMarkdown(src) {
    const blocks = [];
    // コードフェンスを退避（\u0000B<n>\u0000 という普通の本文に出ない番兵で置換）
    src = String(src).replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
      blocks.push({ lang: lang.trim(), code });
      return "\u0000B" + (blocks.length - 1) + "\u0000";
    });
    const lines = src.split("\n");
    const out = [];
    let i = 0;
    let list = null;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    while (i < lines.length) {
      const line = lines[i];
      const ph = line.match(/^\u0000B(\d+)\u0000$/);
      if (ph) {
        closeList();
        const b = blocks[+ph[1]];
        const id = "code" + (codeId++);
        out.push(`<div class="codewrap"><div class="codehead"><span>${escapeHtml(b.lang || "code")}</span><button class="copybtn" data-code="${id}">コピー</button></div><pre><code id="${id}">${escapeHtml(b.code.replace(/\n$/, ""))}</code></pre></div>`);
        i++; continue;
      }
      if (/^\s*$/.test(line)) { closeList(); i++; continue; }
      let h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) { closeList(); const lv = h[1].length; out.push(`<h${lv}>${inline(h[2])}</h${lv}>`); i++; continue; }
      if (/^\s*>\s?/.test(line)) { closeList(); out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ""))}</blockquote>`); i++; continue; }
      if (/^\s*[-*]\s+/.test(line)) { if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`); i++; continue; }
      if (/^\s*\d+\.\s+/.test(line)) { if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(line.replace(/^\s*\d+\.\s+/, ""))}</li>`); i++; continue; }
      closeList(); out.push(`<p>${inline(line)}</p>`); i++;
    }
    closeList();
    return out.join("\n");
  }

  async function copyText(t) {
    try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(t); return true; } } catch (e) {}
    try {
      const ta = document.createElement("textarea");
      ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      const ok = document.execCommand("copy"); document.body.removeChild(ta); return ok;
    } catch (e) { return false; }
  }

  window.escapeHtml = escapeHtml;
  window.inline = inline;
  window.renderMarkdown = renderMarkdown;
  window.copyText = copyText;
})();
