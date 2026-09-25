// Explicit UI smoke test. Uses an isolated in-memory API; never reads user conversations.
const assert=require("node:assert/strict"), fs=require("node:fs"), http=require("node:http"), path=require("node:path");
const {spawn}=require("node:child_process");
const root=path.resolve(__dirname,".."), quote="公式測定による山の標高は3776メートルです。";
const profile=fs.mkdtempSync(path.join(root,"data","ui-smoke-"));
let mode="normal", queries=0, saved=new Map(), requests=0;
const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,"http://x"), p=u.pathname;
 const json=v=>{if(!res.destroyed){res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify(v));}};
 if(p==="/api/tags")return json({models:[{name:"test-model"}]});
 if(p==="/api/show")return json({capabilities:["completion"]});
 if(p==="/api/ps")return json({models:[]});
 if(p==="/warm/api/set")return json({ok:true});
 if(p==="/chats/api/list")return json([...saved.values()]);
 if(p==="/chats/api/get")return json(saved.get(u.searchParams.get("id")));
 if(p==="/chats/api/save"){
  let body="";for await(const chunk of req)body+=chunk;
  const c=JSON.parse(body);c.updatedAt=Date.now();saved.set(c.id,c);return json(c);
 }
 if(p==="/web/api/search"){
  queries++;
  if(mode==="failed"){res.writeHead(502);return res.end('{"error":"search unavailable"}');}
  return json({results:[{title:"公式測定",url:"https://example.org/height",snippet:quote}]});
 }
 if(p==="/web/api/fetch")return json({url:"https://example.org/height",title:"公式測定",text:quote});
 if(p==="/api/chat"){
  requests++;let body="";for await(const chunk of req)body+=chunk;
  const data=JSON.parse(body), field=Object.keys(data.format?.properties||{})[0];
  if(mode==="hold")return; // Client abort must stop this request.
  const replies={
   paragraphs:{paragraphs:["参考として、山の高さは測量基準や対象地点を確認すると理解できます。"]},
   needs:{needs:["山の標高"],queries:["山 標高 公式"]},
   pages:{pages:[{id:"P1",reason:"公式資料"}]},
   facts:{facts:[{quote}]},missing:{missing:[],queries:[]},
   statements:{statements:[{text:"山の標高は3776メートルです。",evidenceIds:["E1"]}]},
   checks:{checks:[{id:"C1",verdict:"supported",reason:"数値と単位が一致"}]},
  };
  if(!replies[field]){res.writeHead(400);return res.end("Unexpected model request");}
  return json({message:{content:JSON.stringify(replies[field])},done:true});
 }
 const file={"/":"chat.html","/research.js":"research.js","/shared.js":"shared.js","/app.css":"app.css"}[p];
 if(!file){res.writeHead(404);return res.end();}
 res.writeHead(200,{"Content-Type":file.endsWith(".js")?"application/javascript":file.endsWith(".css")?"text/css":"text/html"});
 res.end(fs.readFileSync(path.join(root,"src",file)));
});
let edge, ws; const pending=new Map();let seq=0;const errors=[];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=15000){const start=Date.now();while(Date.now()-start<ms){try{const r=await fn();if(r)return r;}catch{}await pause(100);}throw new Error("Timed out waiting for UI");}
function cdp(method,params={}){return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){
 const r=await cdp("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});
 if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;
}
(async()=>{
 await new Promise(r=>server.listen(0,"127.0.0.1",r));
 const edgePath=process.env.EDGE_PATH || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
 edge=spawn(edgePath,["--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check","--remote-debugging-port=0","--user-data-dir="+profile,"about:blank"],{windowsHide:true,stdio:"ignore"});
 const portFile=path.join(profile,"DevToolsActivePort");
 await until(()=>fs.existsSync(portFile));
 const port=fs.readFileSync(portFile,"utf8").split("\n")[0];
 const targets=await (await fetch("http://127.0.0.1:"+port+"/json/list")).json();
 ws=new WebSocket(targets.find(t=>t.type==="page").webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}else if(m.method==="Runtime.exceptionThrown")errors.push(m.params);};
 await cdp("Runtime.enable");
 await cdp("Page.enable");
 await cdp("Page.navigate",{url:"http://127.0.0.1:"+server.address().port});
 await until(()=>evaluate('typeof cur !== "undefined" && cur && modelEl.value === "test-model"'));
 await evaluate('settings.autoTitle=false; save(LS.settings,settings); inputEl.value="山の標高は？"; send()');
 let state=await evaluate('({status:cur.messages.at(-1).research.status, count:cur.messages.length, links:msgEls.at(-1)._ans.querySelectorAll("a").length, details:!!msgEls.at(-1)._research, busy:!!controller})');
 assert.deepEqual(state,{status:"checked",count:2,links:1,details:true,busy:false});
 assert.equal(queries,1);
 await evaluate('regenerate()');assert.equal(queries,2);
 await cdp("Page.reload");
 await until(()=>evaluate('typeof cur !== "undefined" && cur?.messages.length===2 && !!msgEls.at(-1)?._research'));
 assert.equal(await evaluate('cur.messages.at(-1).research.evidence.length'),1);
 console.log("PASS: cited answer, regeneration and persisted research after reload");
 // Editing starts a new investigation.
 await evaluate('editMessage(0); msgEls[0]._bubble.querySelector("textarea").value="山の高さを教えて"; [...msgEls[0]._bubble.querySelectorAll("button")].find(b=>b.textContent==="送信しなおす").onclick()');
 assert.equal(queries,3);
 assert.equal(await evaluate('cur.messages[0].content'),"山の高さを教えて");
 console.log("PASS: edited question researches again");
 mode="hold";
 await evaluate('inputEl.value="次の質問"; void send()');
 await until(()=>evaluate('!!controller && modelEl.disabled'));
 await until(()=>evaluate('!!document.querySelector(".research-live")'));
 const live=await evaluate('({title:document.querySelector(".research-live-title").textContent,status:document.querySelector(".research-live-current").getAttribute("role"),stats:document.querySelector(".research-live-stats").textContent})');
 assert.deepEqual(live,{title:"調査を組み立てています",status:"status",stats:"検索 0件候補 0件確認 0ページ根拠 0件"});
 const before=await evaluate('cur.id');
 await evaluate('newConv()');assert.equal(await evaluate('cur.id'),before);
 await evaluate('sendEl.onclick()');
 await until(()=>evaluate('!controller'));
 assert.equal(await evaluate('cur.messages.at(-1).research.status'),"stopped");
 assert.equal(await evaluate('modelEl.disabled'),false);
 console.log("PASS: cancellation, controls and conversation isolation");
 mode="failed";
 await evaluate('regenerate()');
 assert.equal(await evaluate('cur.messages.at(-1).research.status'),"tentative");
 assert.equal(await evaluate('cur.messages.at(-1).research.warnings.length'),1);
 assert.match(await evaluate('cur.messages.at(-1).content'),/一般知識や推測を含む参考回答/);
 assert.equal(await evaluate('msgEls.at(-1)._ans.querySelectorAll("a").length'),0);
 await cdp("Page.reload");
 await until(()=>evaluate('typeof cur !== "undefined" && cur?.messages.at(-1)?.research?.status==="tentative" && !!msgEls.at(-1)?._research'));
 assert.match(await evaluate('msgEls.at(-1)._research.textContent'),/参考回答・ウェブでの確認は不十分/);
 assert.equal(errors.length,0,JSON.stringify(errors));
 await cdp("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
 assert.equal(await evaluate('document.documentElement.scrollWidth <= 390'),true);
 const shot=await cdp("Page.captureScreenshot",{format:"png"});
 fs.writeFileSync(path.join(root,"data","research-ui-smoke.png"),Buffer.from(shot.data,"base64"));
 console.log("PASS: search failure, mobile width, no browser exceptions");
 console.log("UI checks complete; isolated model calls: "+requests);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
 if(ws?.readyState===1){try{await cdp("Browser.close");}catch{}ws.close();}
 edge?.kill();server.closeAllConnections();server.close();
});
