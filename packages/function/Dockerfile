FROM oven/bun:1.3-alpine AS base
WORKDIR /app

FROM base AS deps
COPY bun.lock package.json ./
COPY packages/function/package.json ./packages/function/
RUN bun install --frozen-lockfile --filter @opencode-ai/function

FROM deps AS runtime
COPY packages/function/src ./packages/function/src
COPY packages/function/tsconfig.json ./packages/function/tsconfig.json
WORKDIR /app/packages/function
EXPOSE 3000
ENV PORT=3000
CMD ["bun", "run", "src/server.ts"]
