FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /app

# Copy package manifest first so dependency installation can be cached.
COPY package.json ./

# Install Node dependencies. A package-lock.json is not currently tracked,
# so npm ci would fail; npm install is intentional here.
RUN npm install --omit=dev --no-audit --no-fund

# Install FFmpeg required to encode PNG frames into MP4.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Copy application source.
COPY . .

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
