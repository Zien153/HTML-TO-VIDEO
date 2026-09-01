const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { execFile } = require("child_process");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const MAX_UPLOAD = 10 * 1024 * 1024;
const uploadDir = "/tmp/html-video-uploads";
fs.mkdirSync(uploadDir, { recursive: true });

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
  // Render large/portrait WebGL scenes at a sane internal resolution and
  // upscale the final MP4. This prevents SwiftShader from becoming a bottleneck
  // while preserving the user's requested output dimensions.
  const maxPixels = 921600; // 720x1280
  const pixels = width * height;
  if (pixels <= maxPixels) return { width, height };
  const scale = Math.sqrt(maxPixels / pixels);
  return {
    width: Math.max(320, Math.floor(width * scale)),
    height: Math.max(320, Math.floor(height * scale))
  };
}

app.use(express.json({ limit: "1mb" }));
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "upload.html")));
app.get("/health", (_, res) => res.json({ ok: true }));

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

    context = await browser.newContext({
      viewport: internal,
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true,
      recordVideo: { dir: videoDir, size: internal }
    });

    // Force devicePixelRatio to 1 before user scripts execute. Many Three.js
    // scenes otherwise render at 2x on CI/container environments.
    await context.addInitScript(() => {
      try {
        Object.defineProperty(window, "devicePixelRatio", {
          configurable: true,
          get: () => 1
        });
      } catch {}
    });

    const page = await context.newPage();
    page.setDefaultTimeout(120000);

    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle", timeout: 120000 });
    await page.waitForTimeout(2500);

    // Give WebGL/Three.js time to finish initialization before recording.
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
