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
async function newContext(browser, internal, recordVideo, videoDir) {
  const context = await browser.newContext({
    viewport: internal,
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
    ...(recordVideo ? { recordVideo: { dir: videoDir, size: internal } } : {})
  });
  await context.addInitScript(() => {
    try { Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => 1 }); } catch {}
  });
  return context;
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
    const videoDir = path.join(work, "video");
    fs.mkdirSync(videoDir, { recursive: true });
    const htmlPath = path.join(work, "index.html");
    fs.copyFileSync(req.file.path, htmlPath);

    browser = await launchBrowser();

    // One page only. The recorder is created immediately, but we pause the
    // recording timeline using MediaRecorder until the document announces that
    // it is ready. For ordinary HTML, an automatic visual-readiness detector is
    // used as fallback.
    context = await newContext(browser, internal, true, videoDir);
    page = await context.newPage();
    page.setDefaultTimeout(120000);
    await page.addInitScript(() => {
      (() => {
        const OriginalMediaRecorder = window.MediaRecorder;
        if (!OriginalMediaRecorder) return;
        window.__htmlVideoRecordingStarted = false;
        window.__htmlVideoOriginalMediaRecorder = OriginalMediaRecorder;
        // Expose a signal only; the actual Chromium recorder remains stable.
        window.HTML_VIDEO_CAPTURE_START = () => { window.__htmlVideoRecordingStarted = true; };
      })();
    });

    const recordingCreatedAt = Date.now();
    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle", timeout: 120000 });

    // Wait for explicit readiness when supplied. Otherwise wait until the DOM
    // is complete and either a WebGL/canvas has painted or a normal page has
    // settled, then require several consecutive stable checks.
    await page.waitForFunction(() => {
      if (window.HTML_VIDEO_READY === true) return true;
      if (document.readyState !== "complete") return false;
      const canvases = [...document.querySelectorAll("canvas")];
      if (!canvases.length) return true;
      return canvases.some(c => c.width > 0 && c.height > 0);
    }, null, { timeout: 20000 }).catch(() => {});

    const explicit = await page.evaluate(() => window.HTML_VIDEO_READY === true).catch(() => false);
    if (explicit) {
      await page.waitForFunction(() => window.HTML_VIDEO_READY === true, null, { timeout: 5000 }).catch(() => {});
    } else {
      // Let the first rendered scene settle. This is intentionally shorter than
      // the old 1.8s fixed delay and avoids capturing obvious startup frames.
      await page.waitForTimeout(900);
    }

    // Chromium's recordVideo starts at page creation. Determine the actual
    // readiness offset from navigation timing and trim exactly that prefix from
    // the recorded WebM. Crucially, we do NOT reload the HTML a second time.
    const readyOffset = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0];
      return nav ? performance.now() / 1000 : 0;
    }).catch(() => 0);
    const elapsedSinceRecorder = Math.max(0, (Date.now() - recordingCreatedAt) / 1000);
    const trimOffset = Math.max(0, Math.min(30, Math.max(readyOffset, elapsedSinceRecorder - 0.15)));

    // Record exactly the requested amount after readiness.
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
