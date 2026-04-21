FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src

# No deps to install, but run for good measure
RUN bun install --frozen-lockfile 2>/dev/null || true

EXPOSE 3747

ENV PORT=3747
ENV MAX_CLIENTS=20
ENV SESSION_TTL_MS=3600000
ENV HOST_RESUME_MS=30000
ENV MAX_PAYLOAD_BYTES=262144
ENV WS_IDLE_TIMEOUT_SEC=75

CMD ["bun", "run", "src/index.ts"]
