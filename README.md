# HTML → MP4 Render Service for Render

This service accepts an HTML file, opens it in headless Chromium, captures frames, and encodes them to MP4 with FFmpeg.

## Deploy on Render

1. Create a new **Web Service** from this project/repository.
2. Choose **Docker** as the runtime.
3. Render will build the included `Dockerfile`.
4. The service listens on Render's `PORT`.
5. After deployment, `GET /health` should return `{"ok":true}`.

## API

`POST /render` as multipart/form-data:

- `html`: the HTML file
- `duration`: seconds, 3–30
- `width`: default 1080
- `height`: default 1920
- `fps`: default 30, maximum 30

Example:

```bash
curl -X POST https://YOUR-SERVICE.onrender.com/render \
  -F "html=@index.html" \
  -F "duration=10" \
  -F "width=1080" \
  -F "height=1920" \
  -F "fps=30" \
  -o video.mp4
```

## Important

The supplied demo HTML loads Three.js from jsDelivr, so the Render service needs outbound internet access while rendering.

For production, add authentication/rate limiting and a job queue if multiple users will render videos concurrently.
