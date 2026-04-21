import { startRelay } from "./packages/opencode/src/share/relay"

const port = Number(process.env.RELAY_PORT) || 3747
const r = startRelay({ port })

console.log(`
╔═══════════════════════════════════════════════════════╗
║         OpenCode Relay Server (v2)                    ║
╠═══════════════════════════════════════════════════════╣
║  WebSocket: ws://localhost:${String(r.port).padEnd(27)}║
║  HTTP:      http://localhost:${String(r.port).padEnd(25)}║
╚═══════════════════════════════════════════════════════╝
`)

await new Promise(() => {})
