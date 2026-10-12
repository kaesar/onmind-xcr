FROM oven/bun:1.4 AS base
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --production
COPY src ./src
ENV XCR_ENV=production PORT=8790 XCR_DATA_DIR=/data/xcr-data
EXPOSE 8790
VOLUME ["/data"]
CMD ["bun", "src/dev.js"]
