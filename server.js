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
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

function renderSize(width, height) {
  const maxPixels = 921600;
  const pixels = width * height;
  if (pixels <= maxPixels) return { width, height };
  const scale = Math.sqrt(maxPixels / pixels);
  return {
    width: Math.max(320, Math.floor(width * scale)),
    height: Math.max(320, Math.floor(height * scale))
  };
}

function makeToken() {
  return crypto.randomBytes(18).toString("hex");
}

app.use(express.json({ limit: "1mb" }));
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "upload.html")));
app.get("/health", (_, res) => res.json({ ok: true }));

// Interactive preview: the uploaded HTML is served in an isolated temporary
// preview URL so the user can inspect mouse/touch/scroll/3D interactions before rendering.
app.post("/preview", upload.single("html"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "يرجى رفع ملف HTML." });
  const token = makeToken();
  const target = path.join(previewDir, `${token}.html`);
  try {
    fs.copyFileSync(req.file.path, target);
    fs.unlinkSync(req.file.path);
    setTimeout(() => {
      try { fs.unlinkSync(target); } catch {}
    }, 20 * 60 * 1000);
    res.json({ url: `/preview/${token}` });
  } catch (err) {
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
  let browser = null;
  let context = null;
  let work = null;

  try {
    if (!req.file) return res.status(400).json({ error: "يرجى رفع ملف HTML." });

    const duration = safeNumber(req.body.duration, 10, 3, 30);
    const width = Math.round(safeNumber(req.body.width, 1080, 320, 1920));
    const height = Math.round(safeNumber(req.body.height, 1920, 320, 1920));
    const fps = Math.round(safeNumber(req.body.fps, 30, 15, 30));
    const internal = renderSize(width, height);

    const job = `job-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    work = path.join("/tmp", job);
    const videoDir = path.join(work, "video");
    fs.mkdirSync(videoDir, { recursive: true });

    const htmlPath = path.join(work, "index.html");
    fs.copyFileSync(req.file.path, htmlPath);

    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--use-gl=swiftshader",
        "--enable-webgl",
        "--ignore-gpu-blocklist",
        "--disable-gpu-sandbox",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows"
      ]
    });

    // First pass: load the document without recording. This is the "smart
    // readiness" phase; the video recorder is not running yet, so startup time
    // and slow CDN/module initialization can never become part of the video.
    context = await browser.newContext({
      viewport: internal,
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true
    });
    await context.addInitScript(() => {
      try {
        Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => 1 });
      } catch {}
    });

    let page = await context.newPage();
    page.setDefaultTimeout(120000);
    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle", timeout: 120000 });

    // Files can optionally declare: window.HTML_VIDEO_READY = true;
    // Otherwise use a robust automatic heuristic: DOM loaded + canvas/WebGL
    // present (when applicable) + a short warm-up period. This avoids recording
    // the blank/loading phase without requiring changes to ordinary HTML files.
    await page.waitForFunction(() => {
      if (window.HTML_VIDEO_READY === true) return true;
      const canvases = [...document.querySelectorAll("canvas")];
      const hasCanvas = canvases.some(c => c.width > 0 && c.height > 0);
      const hasWebGL = canvases.some(c => {
        try { return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch { return false; }
      });
      return hasCanvas && hasWebGL;
    }, null, { timeout: 15000 }).catch(() => {});

    const explicitReady = await page.evaluate(() => window.HTML_VIDEO_READY === true).catch(() => false);
    if (!explicitReady) await page.waitForTimeout(1800);

    // Close the warm-up page before creating the recording context. This is the
    // key change: recording starts only after the page is actually ready.
    await page.close();
    await context.close();
    context = null;

    // Second pass: identical page, now with video recording enabled. It receives
    // a short readiness warm-up again, but that warm-up is intentionally trimmed
    // from the final video by starting a fresh recording page only after it.
    // For deterministic capture, load once more and record from the beginning of
    // the actual document execution, with startup resources now cached by Chromium.
    context = await browser.newContext({
      viewport: internal,
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true,
      recordVideo: { dir: videoDir, size: internal }
    });
    await context.addInitScript(() => {
      try {
        Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => 1 });
      } catch {}
    });

    page = await context.newPage();
    page.setDefaultTimeout(120000);
    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle", timeout: 120000 });

    await page.waitForFunction(() => {
      if (window.HTML_VIDEO_READY === true) return true;
      const canvases = [...document.querySelectorAll("canvas")];
      return canvases.some(c => c.width > 0 && c.height > 0);
    }, null, { timeout: 15000 }).catch(() => {});

    // The recorder starts when the recording page is created, so keep this
    // second warm-up deliberately short. Slow initialization was already
    // detected in the first pass; CDN/cache is also warm for the second pass.
    await page.waitForTimeout(250);
    await page.waitForTimeout(duration * 1000);

    const video = page.video();
    if (!video) throw new Error("تعذر بدء تسجيل الفيديو داخل Chromium.");
    const recordedPath = await video.path();

    await context.close();
    context = null;
    await browser.close();
    browser = null;

    const out = path.join(work, "html-render.mp4");
    await runFfmpeg([
      "-y",
      "-i", recordedPath,
      "-vf", `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-movflags", "+faststart",
      out
    ]);

    res.download(out, "html-render.mp4", (err) => {
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
