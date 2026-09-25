const test=require("node:test"),assert=require("node:assert/strict"),vm=require("node:vm"),fs=require("node:fs");
const ctx={window:{}};vm.createContext(ctx);vm.runInContext(fs.readFileSync(require.resolve("../src/shared.js"),"utf8"),ctx);
test("escaped model prose stays literal while real citations remain clickable",()=>{
 const html=ctx.window.renderMarkdown("C\\# と \\[偽リンク\\]\\(https://untrusted.example/\\) [1](https://example.org/source)");
 assert.equal((html.match(/<a /g)||[]).length,1);
 assert.match(html,/C# と \[偽リンク\]\(https:\/\/untrusted.example\/\)/);
 assert.match(html,/href="https:\/\/example.org\/source"/);
});
test("escaped HTML stays inert and normal Markdown still works",()=>{
 const html=ctx.window.renderMarkdown("\\<script\\>alert\\(1\\)\\</script\\> **強調**");
 assert.doesNotMatch(html,/<script>/);
 assert.match(html,/&lt;script&gt;/);
 assert.match(html,/<strong>強調<\/strong>/);
});
