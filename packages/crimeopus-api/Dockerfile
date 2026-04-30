# Build stage — produce a single self-contained binary with `bun build --compile`.
# The compiled binary embeds the Bun runtime so the runtime image doesn't need
# Node/Bun installed separately.
FROM oven/bun:1.3-alpine AS build
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN bun install --no-save && bun build src/index.ts --compile --outfile=/out/crimeopus-api

# Runtime — slim Alpine, no toolchain.
FROM alpine:3.20
RUN apk add --no-cache ca-certificates libstdc++ libgcc
WORKDIR /app
COPY --from=build /out/crimeopus-api /app/crimeopus-api
COPY catalog.example.json /app/catalog.example.json

# Default config: bind 0.0.0.0:8787, point at host.docker.internal for Ollama.
# Override at run time:
#   docker run -e API_KEYS='sk-prod:label' \
#              -e OLLAMA_URL='https://ollama.tld' \
#              -e CATALOG_PATH='/app/catalog.json' \
#              -v $(pwd)/catalog.json:/app/catalog.json:ro \
#              -p 8787:8787 ghcr.io/your-org/crimeopus-api
ENV PORT=8787 \
    BIND=0.0.0.0 \
    OLLAMA_URL=http://host.docker.internal:11434 \
    LOG_DB=/data/usage.db \
    CATALOG_PATH=/app/catalog.json

VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -q -O - http://127.0.0.1:8787/healthz | grep -q '"ok":true' || exit 1

ENTRYPOINT ["/app/crimeopus-api"]
