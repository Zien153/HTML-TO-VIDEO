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

app.use(express.json({ limit: "1mb" }));
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "upload.html")));
app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/render", upload.single("html"), async (req, res) => {
  let browser = null;
  let work = null;

  try {
    if (!req.file) return res.status(400).json({ error: "يرجى رفع ملف HTML." });

    const duration = safeNumber(req.body.duration, 10, 3, 30);
    const width = Math.round(safeNumber(req.body.width, 1080, 320, 1920));
    const height = Math.round(safeNumber(req.body.height, 1920, 320, 1920));
    const fps = Math.round(safeNumber(req.body.fps, 30, 15, 30));

    const job = `job-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    work = path.join("/tmp", job);
    fs.mkdirSync(work, { recursive: true });

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
        "--ignore-gpu-blocklist"
      ]
    });

    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true
    });
    const page = await context.newPage();
    page.setDefaultTimeout(120000);

    await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle", timeout: 120000 });
    await page.waitForTimeout(2000);

    const frames = Math.ceil(duration * fps);
    for (let i = 0; i < frames; i++) {
      const filename = path.join(work, `frame-${String(i).padStart(6, "0")}.png`);
      await page.screenshot({
        path: filename,
        animations: "allow",
        timeout: 120000,
        type: "png"
      });
      if (i < frames - 1) await page.waitForTimeout(1000 / fps);
    }

    await browser.close();
    browser = null;

    const out = path.join(work, "html-render.mp4");
    await runFfmpeg([
      "-y", "-framerate", String(fps), "-i", path.join(work, "frame-%06d.png"),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", out
    ]);

    res.download(out, "html-render.mp4", (err) => {
      cleanup(work, req.file.path);
      if (err) console.error("Download error:", err.message);
    });
  } catch (err) {
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
