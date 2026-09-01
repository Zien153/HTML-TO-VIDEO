FROM mcr.microsoft.com/playwright:focal

WORKDIR /app

# Copy package files first to leverage Docker cache
COPY package.json package-lock.json* ./

# Install ffmpeg and production dependencies
RUN apt-get update \
  && apt-get install -y ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && npm ci --only=production --silent --no-audit --no-fund

# Copy the app source
COPY . .

ENV PORT 10000
EXPOSE 10000

CMD ["node", "server.js"]
