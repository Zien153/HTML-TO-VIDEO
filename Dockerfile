FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

COPY package.json ./

# Keep the Playwright npm package version exactly aligned with the Docker image.
RUN npm install --omit=dev --no-audit --no-fund

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY . .

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
