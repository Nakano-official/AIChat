const test = require("node:test");
const assert = require("node:assert/strict");
const { run, createClient, passages, LIMITS } = require("../src/research");
const quote = "公式測定による山の標高は3776メートルです。";
function fixture(overrides = {}){
  const calls = [], searches = [], fetched = [];
  const responses = {
    fallback:{ paragraphs:["この山の標高は、測量基準と最高地点の位置を分けて考えると理解しやすくなります。"] },
    plan:{ needs:["山の標高"], queries:["山 標高 公式"] },
    select:{ pages:[{ id:"P1", reason:"測定機関の原典" }] },
    extract:{ facts:[{ quote }] },
    gaps:{ missing:[], queries:[] },
    draft:{ statements:[{ text:"山の標高は3776メートルです。", evidenceIds:["E1"] }] },
    verify:{ checks:[{ id:"C1", verdict:"supported", reason:"標高と単位が一致" }] },
    ...overrides,
  };
  return {
    calls, searches, fetched,
    options:{
      question:"この山の標高を調べてください。", model:"test",
      history:[{ role:"user", content:"この山は富士山です。" }],
      async ask(request){ calls.push(request); const r=responses[request.stage]; if(r instanceof Error) throw r; return typeof r === "function" ? r(request) : structuredClone(r); },
      async search(q){ searches.push(q); return [{ title:"公式測定", url:"https://example.org/height", snippet:quote }]; },
      async fetchPage(url){ fetched.push(url); return { url, title:"公式測定", text:quote }; },
    },
  };
}
test("plan, select, extract, draft and verify produce a persisted cited answer", async()=>{
  const f=fixture(), result=await run(f.options);
  assert.equal(result.research.status,"checked");
  assert.match(result.content,/\[1\]\(https:\/\/example.org\/height\)/);
  assert.deepEqual(f.searches,["山 標高 公式"]);
  assert.equal(f.calls[0].data.history[0].content,"この山は富士山です。");
  assert.equal(result.research.evidence[0].quote,quote);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),result);
});
test("invented quotations are rejected even if the model says they are true", async()=>{
  const f=fixture({ extract:{ facts:[{ quote:"公式測定による山の標高は9999メートルです。" }] } });
  const r=await run(f.options);
  assert.equal(r.research.status,"tentative");
  assert.equal(r.research.evidence.length,0);
  assert.equal(f.calls.some(c=>c.stage==="draft"),false);
});
test("unknown or duplicate candidate IDs never fetch invented URLs", async()=>{
  const f=fixture({ select:{ pages:[{id:"https://evil.example/",reason:"偽"}, {id:"P99",reason:"不明"}] } });
  await run(f.options);
  assert.deepEqual(f.fetched,[]);
});
test("unsupported or conflicting claims do not appear in the answer", async()=>{
  for(const verdict of ["unsupported","conflicting"]){
    const f=fixture({ verify:{ checks:[{id:"C1",verdict,reason:"根拠不足"}] } });
    const r=await run(f.options);
    assert.equal(r.research.status,verdict === "conflicting" ? "incomplete" : "tentative");
    assert.doesNotMatch(r.content,/3776/);
  }
});
test("missing verification and nonexistent evidence IDs fail closed", async()=>{
  for(const change of [
    { verify:{checks:[]} },
    { draft:{statements:[{text:"山の標高は3776メートルです。",evidenceIds:["E99"]}]} },
    { verify:{checks:[{id:"C1",verdict:"supported",reason:"yes"},{id:"C1",verdict:"supported",reason:"yes"}]} },
  ]){
    const r=await run(fixture(change).options);
    assert.equal(r.research.status,"tentative");
    assert.doesNotMatch(r.content,/3776/);
  }
});
test("verification failure never exposes its draft", async()=>{
  const r=await run(fixture({verify:new Error("model unavailable")}).options);
  assert.equal(r.research.status,"tentative");
  assert.doesNotMatch(r.content,/3776/);
  assert.equal(r.research.sources.length,1);
});
test("malformed planning output falls back with an explicit unverified label", async()=>{
  const r=await run(fixture({plan:{queries:"wrong"}}).options);
  assert.equal(r.research.status,"tentative");
  assert.equal(r.research.queries.length,0);
});
test("missing facts trigger bounded follow-up search; duplicates are not repeated", async()=>{
  const f=fixture({ gaps:({data})=>({missing:["未解決"],queries:["山 標高 公式","山 測量 原典 "+data.searched.length]}) });
  const r=await run(f.options);
  assert.equal(f.searches.length,2);
  assert.ok(f.searches.length<=LIMITS.queries);
  assert.equal(f.fetched.length,1);
  assert.equal(r.research.status,"partial");
});
test("search failures are visible and never count as verification", async()=>{
  const f=fixture();
  f.options.search=async()=>{throw new Error("HTTP 202 bot challenge");};
  const r=await run(f.options);
  assert.equal(r.research.status,"tentative");
  assert.match(r.research.warnings[0],/202/);
});
test("abort in each stage stops all subsequent calls", async()=>{
  for(const stage of ["plan","select","extract","gaps","draft","verify","fallback"]){
    const f=fixture(stage === "fallback" ? {extract:{facts:[]}} : {}), c=new AbortController(), ask=f.options.ask;
    f.options.signal=c.signal;
    f.options.ask=async r=>{ const result=await ask(r); if(r.stage===stage)c.abort(); return result; };
    await assert.rejects(run(f.options),{name:"AbortError"});
    assert.equal(f.calls.at(-1).stage,stage);
  }
});
test("abort during network search is not swallowed as a search failure", async()=>{
  const f=fixture(), c=new AbortController();
  f.options.signal=c.signal;
  f.options.search=async()=>{c.abort();throw new DOMException("stop","AbortError");};
  await assert.rejects(run(f.options),{name:"AbortError"});
});
test("relevant passages near the end of a long page can be extracted",()=>{
  const text="irrelevant boilerplate ".repeat(1200)+"\n山の標高 3776 meters measured\n"+"padding ".repeat(100);
  const selected=passages(text,"山の標高");
  assert.match(selected,/3776 meters/);
  assert.ok(selected.length<=LIMITS.pageChars);
});
test("transport sends schema, distinguishes timeout, and rejects truncated JSON", async()=>{
  const f=fixture();
  let request;
  const client=createClient({model:"test",fetchImpl:async(url,options)=>{
    request=JSON.parse(options.body);
    return {ok:true,json:async()=>({done_reason:"length",message:{content:"{}"}})};
  }});
  await assert.rejects(client.ask({stage:"plan",schema:{type:"object"},data:{},system:"test"}),/上限/);
  assert.equal(request.format.type,"object");
  assert.equal(request.think,false);
  const timeout=createClient({model:"test",timeoutMs:5,fetchImpl:async(url,{signal})=>new Promise((resolve,reject)=>{
    signal.addEventListener("abort",()=>reject(new DOMException("timeout","AbortError")));
  })});
  await assert.rejects(timeout.ask({stage:"plan",schema:{},data:{},system:"test"}),/時間内/);
});

test("reference answer uses fetched passages when exact quotations cannot be extracted",async()=>{
 const f=fixture({extract:{facts:[]}});
 const r=await run(f.options);
 const fallback=f.calls.find(c=>c.stage==="fallback");
 assert.match(fallback.data.pages[0].text,/3776/);
 assert.equal(r.research.status,"tentative");
 assert.match(r.content,/一般知識や推測を含む参考回答/);
 assert.doesNotMatch(r.content,/\]\(https?:/);
 assert.equal(r.research.evidence.length,0);
});
test("reference answer may use search snippets but never treats them as quotations",async()=>{
 const f=fixture();
 f.options.fetchPage=async()=>{throw new Error("unavailable");};
 const r=await run(f.options);
 const fallback=f.calls.find(c=>c.stage==="fallback");
 assert.equal(fallback.data.searchSummaries[0].snippet,quote);
 assert.equal(r.research.evidence.length,0);
 assert.equal(r.research.status,"tentative");
});
test("fallback generation failure still reports unavailable and preserves diagnostics",async()=>{
 const f=fixture({extract:{facts:[]},fallback:new Error("model disconnected")});
 const r=await run(f.options);
 assert.equal(r.research.status,"unavailable");
 assert.match(r.research.warnings.at(-1),/model disconnected/);
});
test("fabricated URLs and citation numbers cannot appear as verified fallback sources",async()=>{
 const f=fixture({extract:{facts:[]},fallback:{paragraphs:["説明 [1](https://invented.example/)"]}});
 const r=await run(f.options);
 assert.doesNotMatch(r.content,/invented\.example|\[1\]/);
 assert.equal(r.research.status,"tentative");
});
test("tentative earlier answers retain their status in the planning context",async()=>{
 const f=fixture();f.options.history=[{role:"assistant",content:"先ほどの参考回答",research:{status:"tentative"}}];
 await run(f.options);
 assert.equal(f.calls[0].data.history[0].verification,"tentative");
});
test("short exact quotations are usable without requiring twelve characters",async()=>{
 const f=fixture({extract:{facts:[{quote:"3776メートル"}]}});
 const r=await run(f.options);
 assert.equal(r.research.status,"checked");
 assert.equal(r.research.evidence[0].quote,"3776メートル");
});

test("search provider switch is preserved in the research audit without marking success as failure",async()=>{
 const f=fixture(), original=f.options.search;
 f.options.search=async q=>Object.assign(await original(q),{provider:"Bing",cached:true,notices:["DuckDuckGoから切り替えました"]});
 const r=await run(f.options);
 assert.equal(r.research.status,"checked");
 assert.ok(r.research.events.some(e=>e.message.includes("Bing")));
 assert.ok(r.research.events.some(e=>e.message.includes("切り替え")));
});
test("API error messages show the cause instead of nested HTTP 502 JSON",async()=>{
 const client=createClient({model:"test",fetchImpl:async()=>({ok:false,status:415,text:async()=>JSON.stringify({error:"この資料形式には未対応です",code:"UNSUPPORTED_TYPE"})})});
 await assert.rejects(client.fetchPage("https://example.org/a.pdf"),e=>e.message==="この資料形式には未対応です");
});
