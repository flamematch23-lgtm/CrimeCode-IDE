FROM oven/bun:1-alpine

WORKDIR /app

# Copy only what the relay needs
COPY relay-server.ts ./relay-server.ts
COPY packages/opencode/src/share/relay.ts ./packages/opencode/src/share/relay.ts

EXPOSE 3747

ENV RELAY_PORT=3747

CMD ["bun", "run", "relay-server.ts"]
