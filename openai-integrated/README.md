# HTML → VIDEO — OpenAI + Chromium/FFmpeg

نسخة مدمجة من واجهة HTML-to-Video مع OpenAI ومحرك الرندر Chromium + FFmpeg.

## المزايا
- محرر HTML ومعاينة حية.
- ChatGPT لتوليد وتعديل HTML.
- رندر MP4 على الخادم باستخدام Playwright/Chromium ثم FFmpeg.
- دعم 16:9 و9:16 و1:1 و15/24/30 FPS و3–30 ثانية.
- دعم Canvas/WebGL مع `window.HTML_VIDEO_READY = true` عند الحاجة.
- تخفيض دقة الرندر الداخلي للمشاهد الثقيلة ثم إعادة التحجيم إلى المقاس النهائي.
- مفتاح OpenAI يبقى على الخادم ولا يصل إلى المتصفح.

## التشغيل
```bash
npm install
npm run build
OPENAI_API_KEY=... npm start
```

## Render
استخدم `Dockerfile` و`render.yaml`، ثم أضف `OPENAI_API_KEY` كمتغير بيئة سري.

> لا تضع مفتاح OpenAI داخل React أو داخل Git.
