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

function makeToken() { return crypto.randomBytes(18).toString("hex"); }

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
      "--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist",
      "--disable-gpu-sandbox", "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"
    ]
  });
}

async function preparePage(page, htmlPath) {
  page.setDefaultTimeout(120000);
  await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle", timeout: 120000 });
  await page.waitForFunction(() => {
    if (window.HTML_VIDEO_READY === true) return true;
    const canvases = [...document.querySelectorAll("canvas")];
    if (!canvases.length) return document.readyState === "complete";
    return canvases.some(c => c.width > 0 && c.height > 0);
  }, null, { timeout: 15000 }).catch(() => {});

  const ready = await page.evaluate(() => ({
    explicit: window.HTML_VIDEO_READY === true,
    elapsed: performance.now()
  })).catch(() => ({ explicit: false, elapsed: 0 }));

  if (!ready.explicit) await page.waitForTimeout(1800);
  return ready;
}

app.use(express.json({ limit: "1mb" }));
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "upload.html")));
app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/preview", upload.single("html"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "يرجى رفع ملف HTML." });
  const token = makeToken();
  const target = path.join(previewDir, `${token}.html`);
  try {
    fs.copyFileSync(req.file.path, target);
    fs.unlinkSync(req.file.path);
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
    const videoDir = path.join(work, "video");
    fs.mkdirSync(videoDir, { recursive: true });
    const htmlPath = path.join(work, "index.html");
    fs.copyFileSync(req.file.path, htmlPath);

    browser = await launchBrowser();

    // Readiness pass: discover how long the page needs before its real content
    // is ready. Nothing from this pass enters the final video.
    context = await browser.newContext({ viewport: internal, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
    await context.addInitScript(() => {
      try { Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => 1 }); } catch {}
    });
    page = await context.newPage();
    const readiness = await preparePage(page, htmlPath);
    await page.close();
    await context.close();
    context = null;

    // Recording pass. Chromium starts recording immediately, so the final MP4
    // is trimmed by the measured readiness offset. This makes the first video
    // frame correspond to the actual ready scene instead of its loading phase.
    const recordDir = videoDir;
    context = await browser.newContext({
      viewport: internal,
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true,
      recordVideo: { dir: recordDir, size: internal }
    });
    await context.addInitScript(() => {
      try { Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => 1 }); } catch {}
    });
    page = await context.newPage();
    page.setDefaultTimeout(120000);
    const recordingStarted = Date.now();
    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle", timeout: 120000 });
    await page.waitForFunction(() => {
      if (window.HTML_VIDEO_READY === true) return true;
      const canvases = [...document.querySelectorAll("canvas")];
      if (!canvases.length) return document.readyState === "complete";
      return canvases.some(c => c.width > 0 && c.height > 0);
    }, null, { timeout: 15000 }).catch(() => {});

    const readyAt = await page.evaluate(() => performance.now()).catch(() => 0);
    const fallbackOffset = Math.max(0, (Date.now() - recordingStarted) / 1000);
    const trimOffset = Math.max(0, Math.min(20, readyAt > 0 ? readyAt / 1000 : fallbackOffset));
    const explicit = await page.evaluate(() => window.HTML_VIDEO_READY === true).catch(() => false);
    if (!explicit) await page.waitForTimeout(1800);
    await page.waitForTimeout(duration * 1000);

    const video = page.video();
    if (!video) throw new Error("تعذر بدء تسجيل الفيديو داخل Chromium.");
    const recordedPath = await video.path();
    await context.close(); context = null;
    await browser.close(); browser = null;

    const out = path.join(work, "html-render.mp4");
    await runFfmpeg([
      "-y", "-ss", String(trimOffset), "-i", recordedPath, "-t", String(duration),
      "-vf", `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-movflags", "+faststart", out
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
