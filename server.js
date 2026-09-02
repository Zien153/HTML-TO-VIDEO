import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { execFile } from "node:child_process";
import OpenAI from "openai";

const __filename=fileURLToPath(import.meta.url),__dirname=path.dirname(__filename);
const app=express(),port=Number(process.env.PORT||3000),uploadDir="/tmp/html-video-uploads";
let activeRender=false;
fs.mkdirSync(uploadDir,{recursive:true});
const upload=multer({dest:uploadDir,limits:{fileSize:10*1024*1024},fileFilter:(_,f,cb)=>{const ok=f.mimetype==='text/html'||/\.html?$/i.test(f.originalname);cb(ok?null:new Error('HTML files only'),ok)}});
app.use(express.json({limit:'1mb'}));
const num=(v,d,min,max)=>{const n=Number(v);return Number.isFinite(n)?Math.min(Math.max(n,min),max):d};
const clean=(w,f)=>{try{if(w)fs.rmSync(w,{recursive:true,force:true})}catch{}try{if(f)fs.unlinkSync(f)}catch{}};
const ffmpeg=args=>new Promise((res,rej)=>execFile('ffmpeg',args,{maxBuffer:16*1024*1024,timeout:180000},(e,o,s)=>e?rej(Error(s||e.message)):res(o)));
const renderSize=(w,h)=>{const max=921600,p=w*h;if(p<=max)return{width:w,height:h};const s=Math.sqrt(max/p);return{width:Math.max(320,Math.floor(w*s)),height:Math.max(320,Math.floor(h*s))}};
const browserArgs=['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--use-gl=swiftshader','--enable-webgl','--ignore-gpu-blocklist','--disable-gpu-sandbox','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows'];
const DEFAULT_TEST_HTML='<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:320px;height:180px;overflow:hidden}body{display:grid;place-items:center;background:#111;color:white;font:24px Arial}.x{animation:a 1s infinite alternate}@keyframes a{from{transform:scale(.8);opacity:.5}to{transform:scale(1.1);opacity:1}}</style></head><body><div class="x">RENDER TEST</div></body></html>';
async function renderHtml({html,duration,width,height,fps,workPrefix='html-video'}){
 let browser=null,context=null,work=null;
 try{
  const internal=renderSize(width,height);
  work=path.join('/tmp',`${workPrefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  const frames=path.join(work,'frames'),htmlPath=path.join(work,'index.html'),out=path.join(work,'html-render.mp4');
  fs.mkdirSync(frames,{recursive:true});fs.writeFileSync(htmlPath,html,'utf8');
  browser=await chromium.launch({headless:true,args:browserArgs});
  context=await browser.newContext({viewport:internal,deviceScaleFactor:1,ignoreHTTPSErrors:true});
  const page=await context.newPage();page.setDefaultTimeout(120000);
  await page.goto(`file://${htmlPath}`,{waitUntil:'domcontentloaded',timeout:120000});
  await page.waitForFunction(()=>document.readyState==='complete',{timeout:30000}).catch(()=>{});
  if(await page.locator('canvas').count()) await page.waitForFunction(()=>window.HTML_VIDEO_READY===true||[...document.querySelectorAll('canvas')].some(c=>c.width>0&&c.height>0),{timeout:30000}).catch(()=>{});
  await page.evaluate(()=>new Promise(requestAnimationFrame));
  const total=Math.ceil(duration*fps);
  for(let i=0;i<total;i++){
   await page.screenshot({path:path.join(frames,`frame-${String(i).padStart(6,'0')}.jpg`),type:'jpeg',quality:82,animations:'allow',timeout:120000});
   if(i+1<total)await page.waitForTimeout(1000/fps);
  }
  await context.close();context=null;await browser.close();browser=null;
  const scale=internal.width!==width||internal.height!==height?['-vf',`scale=${width}:${height}:flags=lanczos`]:[];
  await ffmpeg(['-y','-framerate',String(fps),'-i',path.join(frames,'frame-%06d.jpg'),'-c:v','libx264','-preset','veryfast','-crf','22',...scale,'-pix_fmt','yuv420p','-movflags','+faststart',out]);
  return {out,work};
 }catch(e){try{await context?.close()}catch{}try{await browser?.close()}catch{}clean(work);throw e}
}
app.get('/api/health',(_,r)=>r.json({ok:true,openai:Boolean(process.env.OPENAI_API_KEY),provider:'openai',model:process.env.OPENAI_MODEL||'gpt-5.6-luna',renderer:true,rendererEngine:'chromium-ffmpeg'}));
app.get('/api/render-test',async(_,res)=>{if(activeRender)return res.status(429).json({ok:false,error:'محرك الرندر مشغول حالياً.'});activeRender=true;try{const x=await renderHtml({html:DEFAULT_TEST_HTML,duration:1,width:320,height:180,fps:1,workPrefix:'html-video-selftest'});const size=fs.statSync(x.out).size;clean(x.work);activeRender=false;res.json({ok:true,message:'Chromium + FFmpeg render test passed',bytes:size})}catch(e){activeRender=false;console.error('Self-test error',e);res.status(500).json({ok:false,error:e.message||'Render self-test failed'})}});
app.post('/api/openai',async(req,res)=>{try{if(!process.env.OPENAI_API_KEY)throw Error('OPENAI_API_KEY غير مضبوط على الخادم.');const {messages,system=''}=req.body||{};const input=(Array.isArray(messages)?messages:[]).filter(m=>m&&(m.role==='user'||m.role==='assistant')&&typeof m.content==='string').map(m=>({role:m.role,content:m.content}));if(!input.length)return res.status(400).json({error:'messages مطلوب.'});const ai=new OpenAI({apiKey:process.env.OPENAI_API_KEY});const out=await ai.responses.create({model:process.env.OPENAI_MODEL||'gpt-5.6-luna',instructions:system,input,max_output_tokens:Number(process.env.OPENAI_MAX_OUTPUT_TOKENS||8000)});res.json({text:out.output_text||'',model:out.model,responseId:out.id})}catch(e){console.error(e);res.status(Number(e.status)>=400?Number(e.status):500).json({error:e.message||'OpenAI error'})}});
app.post('/render',upload.single('html'),async(req,res)=>{if(activeRender)return res.status(429).json({error:'محرك الرندر مشغول حالياً.'});if(!req.file)return res.status(400).json({error:'يرجى رفع ملف HTML.'});activeRender=true;try{const duration=num(req.body.duration,5,3,30),width=Math.round(num(req.body.width,1280,320,1920)),height=Math.round(num(req.body.height,720,320,1920)),fps=Math.round(num(req.body.fps,30,15,30));const html=fs.readFileSync(req.file.path,'utf8');const x=await renderHtml({html,duration,width,height,fps});activeRender=false;res.download(x.out,'html-render.mp4',()=>clean(x.work,req.file.path))}catch(e){activeRender=false;clean(null,req.file?.path);console.error('Render error',e);res.status(500).json({error:e.message||'فشل إنشاء الفيديو.'})}});
app.use((e,_q,r,_n)=>r.status(e.code==='LIMIT_FILE_SIZE'?413:400).json({error:e.message||'حدث خطأ'}));
app.use(express.static(path.join(__dirname,'dist')));app.get(/.*/,(req,res)=>res.sendFile(path.join(__dirname,'dist','index.html')));app.listen(port,'0.0.0.0',()=>console.log(`HTML → VIDEO integrated server on ${port}`));
