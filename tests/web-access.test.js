const test=require("node:test"), assert=require("node:assert/strict"), fs=require("node:fs"), vm=require("node:vm");
const serverSource=fs.readFileSync(require.resolve("../src/chat-server"),"utf8");
const section=serverSource.slice(serverSource.indexOf('const WEB_UA ='),serverSource.indexOf('async function handleWebApi'));
function context(extra={}){
 const ctx={URL,Buffer,TextDecoder,AbortSignal,AbortController,setTimeout,clearTimeout,
  process:{platform:"win32",env:{SystemRoot:"C:\\Windows"}},
  path:require("node:path"),http:require("node:http"),https:require("node:https"),zlib:require("node:zlib"),
  execFile(){throw new Error("Unexpected native request");},log(){},...extra};
 vm.createContext(ctx);vm.runInContext(section,ctx);return ctx;
}
const rss='<rss><channel><item><title><![CDATA[Official &amp; source]]></title><link>https://example.org/a?x=1&amp;y=2</link><description><![CDATA[<b>Facts</b> from the source]]></description></item></channel></rss>';
test("RSS parser retains paired descriptions and rejects private or invalid links",()=>{
 const ctx=context(), results=ctx.parseBingRss(rss.replace("</channel>","<item><title>Private</title><link>http://127.0.0.1/admin</link></item><item><link>javascript:alert(1)</link></item></channel>"));
 assert.equal(results.length,1);assert.equal(results[0].title,"Official & source");
 assert.equal(results[0].url,"https://example.org/a?x=1&y=2");
 assert.equal(results[0].snippet.trim(),"Facts from the source");
});
test("HTTP 202 switches search provider, caches results and respects cooldown",async()=>{
 const ctx=context(), calls=[];
 ctx.webGet=async url=>{
  calls.push(url);
  if(url.includes("duckduckgo"))throw Object.assign(new Error("challenge"),{upstreamStatus:202});
  return {buf:Buffer.from(rss),headers:{"content-type":"application/xml"}};
 };
 const first=await ctx.searchWeb("test query");
 assert.equal(first.provider,"Bing");assert.equal(first.results.length,1);
 assert.match(first.notices.join(" "),/制限/);
 assert.equal(calls.length,2);
 const cached=await ctx.searchWeb("test query");assert.equal(cached.cached,true);assert.equal(calls.length,2);
 await ctx.searchWeb("different query");assert.equal(calls.length,3);assert.match(calls[2],/bing/);
});
test("a challenge page with HTTP 200 is not treated as empty search success",async()=>{
 const ctx=context();
 ctx.webGet=async url=>({headers:{},buf:Buffer.from(url.includes("duckduckgo")?'<form id="challenge-form">check</form>':rss)});
 const result=await ctx.searchWeb("challenge");
 assert.equal(result.provider,"Bing");assert.match(result.notices.join(" "),/制限/);
});
test("search failure is explicit and abort never starts a fallback provider",async()=>{
 const ctx=context(), calls=[];
 ctx.webGet=async url=>{calls.push(url);throw new Error("Network unavailable");};
 await assert.rejects(ctx.searchWeb("fail"),e=>e.httpStatus===503 && e.code==="SEARCH_UNAVAILABLE");
 assert.equal(calls.length,2);
 const c=new AbortController();c.abort();
 await assert.rejects(ctx.searchWeb("fail",c.signal),{name:"AbortError"});
 assert.equal(calls.length,2);
});
test("upstream 403 and 404 remain distinct from gateway errors",()=>{
 const ctx=context();
 assert.equal(ctx.upstreamError(403).httpStatus,403);
 assert.equal(ctx.upstreamError(404).httpStatus,404);
 assert.equal(ctx.upstreamError(503).upstreamStatus,503);
 assert.equal(ctx.upstreamError(202).upstreamStatus,202);
});
test("legacy TLS retries native transport with certificate verification and limits intact",async()=>{
 let argumentsSeen, optionsSeen;
 const ctx=context({execFile(binary,args,opts,cb){
  argumentsSeen=args;optionsSeen=opts;
  assert.match(binary,/System32[\\/]curl\.exe$/);
  cb(null,Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html>body</html>"));
 }});
 ctx.webGetNode=async()=>{throw new Error("unsafe legacy renegotiation disabled");};
 const c=new AbortController(), result=await ctx.webGet("https://example.org/",0,c.signal);
 assert.equal(result.buf.toString(),"<html>body</html>");
 assert.equal(optionsSeen.signal,c.signal);assert.equal(optionsSeen.windowsHide,true);
 assert.equal(argumentsSeen[0],"--disable");
 for(const forbidden of ["--insecure","-k","--location","-L","--ssl-no-revoke"])assert.equal(argumentsSeen.includes(forbidden),false);
 assert.ok(argumentsSeen.includes("--max-filesize"));
 assert.equal(optionsSeen.shell,undefined);
});
test("certificate errors do not trigger the legacy TLS fallback",async()=>{
 let called=false;const ctx=context({execFile(){called=true;}});
 ctx.webGetNode=async()=>{throw new Error("certificate has expired");};
 await assert.rejects(ctx.webGet("https://example.org/"),/certificate has expired/);assert.equal(called,false);
});
test("native redirects cannot bypass private-address checks",async()=>{
 let calls=0;const ctx=context({execFile(binary,args,opts,cb){
  calls++;cb(null,Buffer.from("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/private\r\n\r\n"));
 }});
 await assert.rejects(ctx.webGetNative("https://example.org/"),e=>e.code==="BLOCKED_URL");
 assert.equal(calls,1);
});
test("native HTTP errors preserve upstream status",async()=>{
 const ctx=context({execFile(binary,args,opts,cb){cb(null,Buffer.from("HTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\n\r\nblocked"));}});
 await assert.rejects(ctx.webGetNative("https://example.org/"),e=>e.httpStatus===403 && e.upstreamStatus===403);
});
