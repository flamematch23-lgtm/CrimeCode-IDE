/**
 * Shared editor (CRDT) protocol — relay messages.
 *
 * Status: SCAFFOLD ONLY. The relay (`packages/relay`) now forwards
 * `crdt.sync` and `crdt.awareness` messages between peers, but the
 * client-side Yjs binding is intentionally not yet wired into the
 * editor surface. The next iteration will:
 *
 *  1. Add `yjs` + `y-protocols` to `packages/app/package.json`
 *     (and the desktop renderer if it diverges from app).
 *  2. Construct a `Y.Doc` per active team-session, keyed on the OpenCode
 *     session id so guests joining the same shared workspace land in the
 *     same doc.
 *  3. Bind the doc to the active editor view (Monaco / TextArea / TUI
 *     buffer) via the appropriate y-* binding (`y-monaco`, `y-codemirror`,
 *     etc.).
 *  4. Subscribe an awareness instance for cursor / selection broadcasting
 *     — this REPLACES the current `live-cursors.tsx` viewport-pixel feed
 *     with file-relative ranges so guests see WHERE in the file the host
 *     is editing.
 *  5. Pipe the doc's `update` event through this protocol to the relay
 *     and apply incoming updates with `Y.applyUpdate(doc, update)`.
 *
 * Why this lives as a protocol module first: the relay change is risky
 * (touches the message whitelist) and benefits from a soak in production
 * before we invest in the full Yjs integration. By landing the protocol
 * envelope today we get a stable contract — the relay won't need any more
 * changes when the Yjs binding lands.
 *
 * Wire format on the relay (already supported as of this scaffold):
 *
 *   { type: "crdt.sync", doc_id: string, update_b64: string }
 *   { type: "crdt.awareness", doc_id: string, awareness_b64: string }
 *
 * `update_b64` is the standard Yjs update serialization (Uint8Array → base64).
 * `doc_id` is whatever opaque key the producer picks — typical choice is
 * `${teamSessionId}:${opencodeSessionId}` so a session and its forked
 * sub-sessions each get their own doc.
 */

export interface CrdtSyncMessage {
  type: "crdt.sync"
  doc_id: string
  /** Yjs update bytes, base64-encoded. Opaque to the relay. */
  update_b64: string
}

export interface CrdtAwarenessMessage {
  type: "crdt.awareness"
  doc_id: string
  /** y-protocols/awareness encoded payload, base64. */
  awareness_b64: string
}

export type CrdtMessage = CrdtSyncMessage | CrdtAwarenessMessage

/** Encode a Uint8Array → base64 (browser-safe, no `Buffer`). */
export function encodeUpdate(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

/** Decode base64 → Uint8Array. */
export function decodeUpdate(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
