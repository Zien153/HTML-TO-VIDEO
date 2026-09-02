FROM mcr.microsoft.com/playwright:v1.62.1-jammy
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm run build
ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000
CMD ["node","server.js"]
