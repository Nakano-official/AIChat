// Explicit opt-in smoke test; uses the running local server and public web.
const fs = require("node:fs");
const {run,createClient}=require("../src/research");
const model=process.env.RESEARCH_MODEL || "qwen3.5:4b";
const c=new AbortController();
const timer=setTimeout(()=>c.abort(),480000);
const start=Date.now();
run({question:process.argv[2] || "富士山の標高は何メートルですか。国土地理院の資料を優先して調べてください。",
 model,signal:c.signal,...createClient({base:"http://localhost",model}),
 onProgress:e=>console.log(Math.round((Date.now()-start)/1000)+"s "+e.message),
}).then(r=>{
 console.log(JSON.stringify({status:r.research.status,content:r.content,sources:r.research.sources,checks:r.research.checks,warnings:r.research.warnings},null,2));
 fs.writeFileSync("data/research-smoke.json",JSON.stringify(r,null,2));
 if(!["checked","partial","tentative"].includes(r.research.status))process.exitCode=1;
}).catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>clearTimeout(timer));
