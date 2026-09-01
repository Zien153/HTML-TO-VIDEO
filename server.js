const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;
const upload = multer({ dest: "/tmp/html-video-uploads" });

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

app.post("/render", upload.single("html"), async (req, res) => {
  let browser;
  const job = `job-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const work = path.join("/tmp", job);
  fs.mkdirSync(work, { recursive: true });

  try {
    if (!req.file) return res.status(400).json({ error: "ارفع ملف HTML باسم html." });

    const duration = Math.min(Math.max(Number(req.body.duration || 10), 3), 30);
    const width = Number(req.body.width || 1080);
    const height = Number(req.body.height || 1920);
    const fps = Math.min(Math.max(Number(req.body.fps || 30), 15), 30);

    const htmlPath = path.join(work, "index.html");
    fs.copyFileSync(req.file.path, htmlPath);

    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
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

    // Allow local HTML plus remote CDN assets such as Three.js.
    await page.goto("file:///" + htmlPath, { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(2500);

    const frames = Math.ceil(duration * fps);
    for (let i = 0; i < frames; i++) {
      const filename = path.join(work, `frame-${String(i).padStart(6, "0")}.png`);
      await page.screenshot({ path: filename, animations: "allow" });
      await page.waitForTimeout(1000 / fps);
    }

    const out = path.join(work, "video.mp4");
    const { execFile } = require("child_process");
    await new Promise((resolve, reject) => {
      execFile("ffmpeg", [
        "-y", "-framerate", String(fps),
        "-i", path.join(work, "frame-%06d.png"),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", out
      ], (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve());
    });

    res.download(out, "html-render.mp4", () => {
      fs.rmSync(work, { recursive: true, force: true });
      try { fs.unlinkSync(req.file.path); } catch {}
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    fs.rmSync(work, { recursive: true, force: true });
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: "فشل إنشاء الفيديو", details: err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`HTML-to-video server listening on ${PORT}`));
