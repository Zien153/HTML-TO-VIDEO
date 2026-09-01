const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require("playwright");
const { execFile } = require("child_process");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const MAX_UPLOAD = 10 * 1024 * 1024;
const uploadDir = "/tmp/html-video-uploads";
const previewDir = "/tmp/html-video-previews";
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(previewDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: MAX_UPLOAD },
  fileFilter: (_, file, cb) => {
    const ok = file.mimetype === "text/html" || /\.html?$/i.test(file.originalname);
    cb(ok ? null : new Error("HTML files only"), ok);
  }
});

function safeNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
function cleanup(work, uploaded) {
  try { if (work) fs.rmSync(work, { recursive: true, force: true }); } catch {}
  try { if (uploaded) fs.unlinkSync(uploaded); } catch {}
}
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message)); else resolve(stdout);
    });
  });
}
function renderSize(width, height) {
  const maxPixels = 921600;
  const pixels = width * height;
  if (pixels <= maxPixels) return { width, height };
  const scale = Math.sqrt(maxPixels / pixels);
  return { width: Math.max(320, Math.floor(width * scale)), height: Math.max(320, Math.floor(height * scale)) };
}
function makeToken() { return crypto.randomBytes(18).toString("hex"); }
async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--disable-gpu-sandbox", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"]
  });
}

app.use(express.json({ limit: "1mb" }));
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "upload.html")));
app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/preview", upload.single("html"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "يرجى رفع ملف HTML." });
  const token = makeToken();
  const target = path.join(previewDir, `${token}.html`);
  try {
    fs.copyFileSync(req.file.path, target); fs.unlinkSync(req.file.path);
    setTimeout(() => { try { fs.unlinkSync(target); } catch {} }, 20 * 60 * 1000);
    res.json({ url: `/preview/${token}` });
  } catch {
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: "تعذر تجهيز المعاينة." });
  }
});
app.get("/preview/:token", (req, res) => {
  if (!/^[a-f0-9]{36}$/.test(req.params.token)) return res.status(404).send("Not found");
  const target = path.join(previewDir, `${req.params.token}.html`);
  if (!fs.existsSync(target)) return res.status(404).send("انتهت صلاحية المعاينة.");
  res.sendFile(target);
});

app.post("/render", upload.single("html"), async (req, res) => {
  let browser = null, context = null, page = null, work = null;
  try {
    if (!req.file) return res.status(400).json({ error: "يرجى رفع ملف HTML." });
    const duration = safeNumber(req.body.duration, 10, 3, 30);
    const width = Math.round(safeNumber(req.body.width, 1080, 320, 1920));
    const height = Math.round(safeNumber(req.body.height, 1920, 320, 1920));
    const fps = Math.round(safeNumber(req.body.fps, 30, 15, 30));
    const internal = renderSize(width, height);
    const job = `job-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    work = path.join("/tmp", job);
    const framesDir = path.join(work, "frames");
    fs.mkdirSync(framesDir, { recursive: true });
    const htmlPath = path.join(work, "index.html");
    fs.copyFileSync(req.file.path, htmlPath);

    browser = await launchBrowser();
    context = await browser.newContext({ viewport: internal, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
    page = await context.newPage();
    page.setDefaultTimeout(120000);

    // Keep the HTML running continuously. We deliberately avoid Playwright's
    // recordVideo: it records startup frames and can create a large intermediate
    // WebM for heavy Three.js scenes. Instead, after readiness we capture only
    // the requested frames and feed those frames to FFmpeg.
    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle", timeout: 120000 });

    const hasCanvas = await page.locator("canvas").count();
    if (hasCanvas) {
      await page.waitForFunction(() => {
        if (window.HTML_VIDEO_READY === true) return true;
        if (document.readyState !== "complete") return false;
        return [...document.querySelectorAll("canvas")].some(c => c.width > 0 && c.height > 0);
      }, null, { timeout: 30000 }).catch(() => {});

      const explicit = await page.evaluate(() => window.HTML_VIDEO_READY === true).catch(() => false);
      if (!explicit) {
        // Wait for the scene to paint and stabilize before frame 0. The stability
        // check samples the canvas size and DOM mutation count over consecutive
        // animation frames; it does not require the animation itself to stop.
        await page.evaluate(async () => {
          const start = performance.now();
          let stable = 0;
          let last = `${document.querySelectorAll("canvas").length}:${innerWidth}:${innerHeight}`;
          while (performance.now() - start < 12000) {
            await new Promise(requestAnimationFrame);
            const current = `${document.querySelectorAll("canvas").length}:${innerWidth}:${innerHeight}`;
            if (current === last) stable++; else stable = 0;
            last = current;
            if (stable >= 12) break;
          }
        });
      }
    } else {
      await page.waitForFunction(() => document.readyState === "complete", null, { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(500);
    }

    // Give explicit-ready pages one paint cycle after signalling readiness.
    await page.evaluate(() => new Promise(requestAnimationFrame));

    const frames = Math.ceil(duration * fps);
    const framePattern = path.join(framesDir, "frame-%06d.png");
    for (let i = 0; i < frames; i++) {
      await page.screenshot({ path: path.join(framesDir, `frame-${String(i).padStart(6, "0")}.png`), type: "png", animations: "allow", timeout: 120000 });
      // Use a deterministic capture cadence. A tiny delay prevents Chromium
      // from starving its WebGL animation loop while still keeping capture close
      // to the requested FPS.
      if (i + 1 < frames) await page.waitForTimeout(1000 / fps);
    }

    await context.close(); context = null;
    await browser.close(); browser = null;

    const out = path.join(work, "html-render.mp4");
    await runFfmpeg([
      "-y", "-framerate", String(fps), "-i", framePattern,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", out
    ]);

    res.download(out, "html-render.mp4", err => {
      cleanup(work, req.file.path);
      if (err) console.error("Download error:", err.message);
    });
  } catch (err) {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    cleanup(work, req.file?.path);
    console.error("Render error:", err);
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "حجم ملف HTML أكبر من 10 MB." });
    if (err.message === "HTML files only") return res.status(400).json({ error: "يسمح برفع ملفات HTML فقط." });
    return res.status(500).json({ error: "فشل إنشاء الفيديو. تأكد من أن ملف HTML يعمل بشكل صحيح." });
  }
});

app.use((err, _, res, __) => {
  if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "حجم الملف أكبر من 10 MB." });
  if (err.message === "HTML files only") return res.status(400).json({ error: "يسمح برفع ملفات HTML فقط." });
  res.status(500).json({ error: "حدث خطأ غير متوقع." });
});
app.listen(PORT, () => console.log(`HTML-to-video server listening on ${PORT}`));
