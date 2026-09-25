const test = require("node:test");
const assert = require("node:assert/strict");
const { run, createClient, passages, paragraphs, LIMITS } = require("../src/research");
const quote = "公式測定による山の標高は3776メートルです。";
function fixture(overrides = {}){
  const calls = [], searches = [], fetched = [];
  const responses = {
    fallback:{ paragraphs:["この山の標高は、測量基準と最高地点の位置を分けて考えると理解しやすくなります。"] },
    plan:{ needs:["山の標高"], queries:["山 標高 公式"] },
    select:{ pages:[{ id:"P1", reason:"測定機関の原典" }] },
    read:{ notes:["山の標高は3776メートル（公式測定）。"] },
    gaps:{ missing:[], queries:[] },
    ...overrides,
  };
  const written = [];
  return {
    calls, searches, fetched, written,
    options:{
      question:"この山の標高を調べてください。", model:"test",
      history:[{ role:"user", content:"この山は富士山です。" }],
      async ask(request){ calls.push(request); const r=responses[request.stage]; if(r instanceof Error) throw r; return typeof r === "function" ? r(request) : structuredClone(r); },
      async write(request){ written.push(request); if(responses.write instanceof Error) throw responses.write;
        const text = responses.write === undefined ? "山の標高は3776メートルです。" : responses.write;
        request.onToken?.(text); return text; },
      async search(q){ searches.push(q); return [{ title:"公式測定", url:"https://example.org/height", snippet:quote }]; },
      async fetchPage(url){ fetched.push(url); return { url, title:"公式測定", text:quote }; },
    },
  };
}
test("plan, select, read and write produce a persisted answer whose sources stay in the audit", async()=>{
  const f=fixture(), result=await run(f.options);
  assert.equal(result.research.status,"researched");
  assert.equal(result.content,"山の標高は3776メートルです。");
  assert.doesNotMatch(result.content,/\]\(https?:|\[\d+\]/);   // 本文に引用番号もリンクも出さない
  assert.deepEqual(result.research.sources.map(s=>s.url),["https://example.org/height"]);
  assert.deepEqual(f.searches,["山 標高 公式"]);
  assert.equal(f.calls[0].data.history[0].content,"この山は富士山です。");
  assert.equal(result.research.notes[0].text,"山の標高は3776メートル（公式測定）。");
  assert.deepEqual(JSON.parse(JSON.stringify(result)),result);
});
test("each page is read in its own call that sees only that page", async()=>{
  const f=fixture(), r=await run(f.options);
  const reads=f.calls.filter(c=>c.stage==="read");
  assert.equal(reads.length,1);
  // 読み手に渡るのは質問とそのページ本文だけ。他ページの本文も要点も混ざらない。
  assert.deepEqual(Object.keys(reads[0].data).sort(),["needs","question","source","text"]);
  assert.equal(reads[0].data.text,quote);
  assert.equal(r.research.notes[0].sourceId,r.research.sources[0].id);
});
test("the final write receives the notes grouped by source, with no internal ids", async()=>{
  const f=fixture(); await run(f.options);
  assert.equal(f.written.length,1);
  const data=f.written[0].data;
  assert.deepEqual(data.material,[{資料:"公式測定",要点:["山の標高は3776メートル（公式測定）。"]}]);
  assert.equal(JSON.stringify(data).includes("excerpt"),false);   // ページ本文は渡さない
  // N1 / S1 のような内部IDを渡すと、本文に【N1】と書かれてしまう
  assert.doesNotMatch(JSON.stringify(data),/"(id|sourceId)"/);
});
test("reference ids written despite the instruction are stripped from the answer", async()=>{
  const f=fixture({ write:"コスト面で有利です【S1, S5】。速度も上がりました【N6】。詳細 [N3] を参照。" });
  const r=await run(f.options);
  assert.equal(r.content,"コスト面で有利です。速度も上がりました。詳細 を参照。");
});
test("many sources are folded into group summaries before the final write", async()=>{
  // 20件ぶんの資料を用意し、要点の総量が writeChars を超える状況を作る
  const many=Array.from({length:LIMITS.perRound},(_,i)=>({ id:"P"+(i+1), reason:"候補"+(i+1) }));
  const f=fixture({
    select:{ pages:many },
    read:{ notes:Array.from({length:8},(_,k)=>"要点"+k+"。"+"あ".repeat(280)) },
    condense:{ summary:["まとめた要点です。"] },
  });
  const urls=[]; const origSearch=f.options.search;
  f.options.search=async q=>{ await origSearch(q); return many.map((_,i)=>({ title:"資料"+i, url:"https://example.org/p"+i, snippet:"説明" })); };
  f.options.fetchPage=async url=>{ urls.push(url); return { url, title:"資料", text:quote }; };
  await run(f.options);
  assert.ok(urls.length>=8, "複数ページを読んでいる: "+urls.length);
  assert.ok(f.calls.some(c=>c.stage==="condense"), "中間要約が走っている");
  const data=f.written[0].data;
  assert.ok(JSON.stringify(data).length<=LIMITS.writeChars*1.2, "統括役に渡す量が抑えられている");
});
test("a small number of sources skips condensation entirely", async()=>{
  const f=fixture(); await run(f.options);
  assert.equal(f.calls.some(c=>c.stage==="condense"),false);
  assert.deepEqual(f.written[0].data.material,[{資料:"公式測定",要点:["山の標高は3776メートル（公式測定）。"]}]);
});
test("the streamed answer is reported as it arrives", async()=>{
  const f=fixture(), seen=[];
  await run({...f.options, onProgress:(e)=>{ if(e.delta) seen.push(e.message); }});
  assert.deepEqual(seen,["山の標高は3776メートルです。"]);
});
test("empty notes from every page fall back instead of inventing an answer", async()=>{
  const f=fixture({ read:{ notes:[] } });
  const r=await run(f.options);
  assert.equal(r.research.status,"tentative");
  assert.equal(r.research.notes.length,0);
  assert.equal(f.written.length,0);
});
test("a failed write falls back and never leaves the answer empty", async()=>{
  const f=fixture({ write:new Error("model unavailable") });
  const r=await run(f.options);
  assert.equal(r.research.status,"tentative");
  assert.match(r.content,/一般知識や推測を含む参考回答/);
  assert.equal(r.research.sources.length,1);
});
test("URLs invented by the writer are not shown as if they were sources", async()=>{
  const f=fixture({ write:"詳しくは https://invented.example/ を参照してください。" });
  const r=await run(f.options);
  assert.doesNotMatch(r.content,/invented\.example/);
});
test("unknown or duplicate candidate IDs never fetch invented URLs", async()=>{
  const f=fixture({ select:{ pages:[{id:"https://evil.example/",reason:"偽"}, {id:"P99",reason:"不明"}] } });
  await run(f.options);
  assert.deepEqual(f.fetched,[]);
});
test("malformed planning output falls back with an explicit unverified label", async()=>{
  const r=await run(fixture({plan:{queries:"wrong"}}).options);
  assert.equal(r.research.status,"tentative");
  assert.equal(r.research.queries.length,0);
});
test("missing facts trigger bounded follow-up search; duplicates are not repeated", async()=>{
  const f=fixture({ gaps:({data})=>({missing:["未解決"],queries:["山 標高 公式","山 測量 原典 "+data.searched.length]}) });
  const r=await run(f.options);
  assert.equal(f.searches.length,LIMITS.rounds);   // ラウンドごとに新しい検索語で1回
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
  for(const stage of ["plan","select","read","gaps","fallback"]){
    const f=fixture(stage === "fallback" ? {read:{notes:[]}} : {}), c=new AbortController(), ask=f.options.ask;
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
test("a wall of text is split into paragraphs, but existing layout is left alone", ()=>{
  const wall="これは一番目の文で、段落分けの動作を確かめるために十分な長さにしてあります。これは二番目の文で、段落分けの動作を確かめるために十分な長さにしてあります。これは三番目の文で、段落分けの動作を確かめるために十分な長さにしてあります。これは四番目の文で、段落分けの動作を確かめるために十分な長さにしてあります。これは五番目の文で、段落分けの動作を確かめるために十分な長さにしてあります。これは六番目の文で、段落分けの動作を確かめるために十分な長さにしてあります。これは七番目の文で、段落分けの動作を確かめるために十分な長さにしてあります。これは八番目の文で、段落分けの動作を確かめるために十分な長さにしてあります。これは九番目の文で、段落分けの動作を確かめるために十分な長さにしてあります。これは十番目の文で、段落分けの動作を確かめるために十分な長さにしてあります。";
  const out=paragraphs(wall);
  assert.equal(out.split("\n\n").length,3);          // 4文ずつ区切る
  assert.equal(out.replace(/\n/g,""),wall);            // 中身は変えない
  assert.equal(paragraphs("すでに段落が\n\nあります。"),"すでに段落が\n\nあります。");
  assert.equal(paragraphs("短い回答です。"),"短い回答です。");   // 短文は割らない
});
test("the answer keeps the paragraphs the model wrote", async()=>{
  const f=fixture({ write:"一段落目の話です。\n\n二段落目の話です。" });
  const r=await run(f.options);
  assert.equal(r.content,"一段落目の話です。\n\n二段落目の話です。");
});
test("relevant passages near the end of a long page can be extracted",()=>{
  const text="irrelevant boilerplate ".repeat(1200)+"\n山の標高 3776 meters measured\n"+"padding ".repeat(100);
  const selected=passages(text,"山の標高");
  assert.match(selected,/3776 meters/);
  assert.ok(selected.length<=LIMITS.pageChars);
});
test("page reading uses the small model while planning and writing use the main one", async()=>{
  const seen=[];
  const fetchImpl=async(url,opt)=>{
    seen.push({url,model:JSON.parse(opt.body).model,stream:JSON.parse(opt.body).stream});
    return { ok:true, json:async()=>({ message:{content:JSON.stringify({notes:["x"],needs:[],queries:[],pages:[],missing:[],summary:[]})} }) };
  };
  const c=createClient({ base:"http://x", model:"big", readModel:"small", fetchImpl });
  await c.ask({ stage:"read", schema:{type:"object",properties:{},required:[]}, system:"s", data:{} });
  await c.ask({ stage:"condense", schema:{type:"object",properties:{},required:[]}, system:"s", data:{} });
  await c.ask({ stage:"plan", schema:{type:"object",properties:{},required:[]}, system:"s", data:{} });
  assert.deepEqual(seen.map(s=>s.model),["small","small","big"]);
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
 const f=fixture({read:{notes:[]}});
 const r=await run(f.options);
 const fallback=f.calls.find(c=>c.stage==="fallback");
 assert.match(fallback.data.pages[0].text,/3776/);
 assert.equal(r.research.status,"tentative");
 assert.match(r.content,/一般知識や推測を含む参考回答/);
 assert.doesNotMatch(r.content,/\]\(https?:/);
 assert.equal(r.research.notes.length,0);
});
test("reference answer may use search snippets but never treats them as quotations",async()=>{
 const f=fixture();
 f.options.fetchPage=async()=>{throw new Error("unavailable");};
 const r=await run(f.options);
 const fallback=f.calls.find(c=>c.stage==="fallback");
 assert.equal(fallback.data.searchSummaries[0].snippet,quote);
 assert.equal(r.research.notes.length,0);
 assert.equal(r.research.status,"tentative");
});
test("fallback generation failure still reports unavailable and preserves diagnostics",async()=>{
 const f=fixture({read:{notes:[]},fallback:new Error("model disconnected")});
 const r=await run(f.options);
 assert.equal(r.research.status,"unavailable");
 assert.match(r.research.warnings.at(-1),/model disconnected/);
});
test("fabricated URLs and citation numbers cannot appear as verified fallback sources",async()=>{
 const f=fixture({read:{notes:[]},fallback:{paragraphs:["説明 [1](https://invented.example/)"]}});
 const r=await run(f.options);
 assert.doesNotMatch(r.content,/invented\.example|\[1\]/);
 assert.equal(r.research.status,"tentative");
});
test("tentative earlier answers retain their status in the planning context",async()=>{
 const f=fixture();f.options.history=[{role:"assistant",content:"先ほどの参考回答",research:{status:"tentative"}}];
 await run(f.options);
 assert.equal(f.calls[0].data.history[0].verification,"tentative");
});
test("short notes are kept instead of being discarded as too brief",async()=>{
 const f=fixture({read:{notes:["3776メートル"]}});
 const r=await run(f.options);
 assert.equal(r.research.status,"researched");
 assert.equal(r.research.notes[0].text,"3776メートル");
});

test("search provider switch is preserved in the research audit without marking success as failure",async()=>{
 const f=fixture(), original=f.options.search;
 f.options.search=async q=>Object.assign(await original(q),{provider:"Bing",cached:true,notices:["DuckDuckGoから切り替えました"]});
 const r=await run(f.options);
 assert.equal(r.research.status,"researched");
 assert.ok(r.research.events.some(e=>e.message.includes("Bing")));
 assert.ok(r.research.events.some(e=>e.message.includes("切り替え")));
});
test("API error messages show the cause instead of nested HTTP 502 JSON",async()=>{
 const client=createClient({model:"test",fetchImpl:async()=>({ok:false,status:415,text:async()=>JSON.stringify({error:"この資料形式には未対応です",code:"UNSUPPORTED_TYPE"})})});
 await assert.rejects(client.fetchPage("https://example.org/a.pdf"),e=>e.message==="この資料形式には未対応です");
});
