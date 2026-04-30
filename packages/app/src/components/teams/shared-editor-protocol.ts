/**
 * Shared editor (CRDT) — Yjs provider over the CrimeCode relay.
 *
 * Exposes a `SharedEditorProvider` that owns a `Y.Doc` keyed by `docId`
 * (typically `${teamSessionId}:${opencodeSessionId}`), wires its update
 * stream into the relay (`packages/relay`), and applies remote updates
 * back into the doc. Awareness updates (cursor / selection / username)
 * flow through a separate sub-channel so they don't compete with doc
 * updates for the same buffer.
 *
 * Wire format on the relay (the relay forwards opaque base64 blobs):
 *
 *   { type: "crdt.sync",      doc_id: string, update_b64: string }
 *   { type: "crdt.awareness", doc_id: string, awareness_b64: string }
 *
 * Why we re-roll a tiny provider instead of using `y-websocket`:
 *   - The relay already exists, is hardened (rate-limit, idle timeout,
 *     resume grace, payload caps) and authenticates per-session.
 *   - `y-websocket` bundles its own server protocol that doesn't fit
 *     the relay's "host + clients" topology — host is a stable peer,
 *     clients are transient and may join mid-session.
 *   - Keeping the provider thin (just sync + awareness over JSON) means
 *     the same channel can host other CRDT messages without renegotiation.
 *
 * Editor binding lands on top of this provider — see y-monaco /
 * y-codemirror for the standard hooks. Both want a `Y.Text` instance
 * which you obtain via `provider.doc.getText("source")`.
 */

import * as Y from "yjs"
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness"

export interface CrdtSyncMessage {
  type: "crdt.sync"
  doc_id: string
  /** Yjs update bytes, base64-encoded. */
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
  // Chunk to avoid blowing the stack with very large updates.
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
  }
  return btoa(bin)
}

/** Decode base64 → Uint8Array. */
export function decodeUpdate(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Minimal transport contract — anything that can `send(json)` and emit
 * messages on a callback works. Lets the provider stay decoupled from
 * the actual WebSocket / SSE / postMessage transport in tests.
 */
export interface CrdtTransport {
  send(msg: CrdtMessage): void
  onMessage(cb: (msg: CrdtMessage) => void): () => void
  /** Called when the underlying connection is ready — provider broadcasts
   * its current doc state so a late-joiner can catch up. */
  onConnect?(cb: () => void): () => void
}

export interface SharedEditorOptions {
  docId: string
  transport: CrdtTransport
  /** Local user identity for awareness — name/color rendered next to the
   * remote cursor in editor bindings. */
  user?: { name?: string; color?: string; customer_id?: string }
}

export class SharedEditorProvider {
  readonly doc: Y.Doc
  readonly awareness: Awareness
  readonly docId: string
  private transport: CrdtTransport
  private offMessage: (() => void) | null = null
  private offConnect: (() => void) | null = null
  private destroyed = false

  constructor(opts: SharedEditorOptions) {
    this.docId = opts.docId
    this.transport = opts.transport
    this.doc = new Y.Doc()
    this.awareness = new Awareness(this.doc)

    if (opts.user) this.awareness.setLocalStateField("user", opts.user)

    // Local doc updates → broadcast.
    this.doc.on("update", this.onLocalDocUpdate)
    // Local awareness updates → broadcast (debounced by Awareness internally).
    this.awareness.on("update", this.onLocalAwarenessUpdate)

    this.offMessage = this.transport.onMessage(this.onRemoteMessage)

    // On (re)connect, re-broadcast the full doc state so peers can recover
    // from missed updates without us tracking deltas explicitly.
    if (this.transport.onConnect) {
      this.offConnect = this.transport.onConnect(() => {
        this.broadcastFullState()
      })
    } else {
      // No connect callback — assume ready now.
      this.broadcastFullState()
    }
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.doc.off("update", this.onLocalDocUpdate)
    this.awareness.off("update", this.onLocalAwarenessUpdate)
    this.offMessage?.()
    this.offConnect?.()
    // Clear local awareness so peers see us go offline.
    this.awareness.setLocalState(null)
    this.doc.destroy()
  }

  private broadcastFullState() {
    const update = Y.encodeStateAsUpdate(this.doc)
    this.transport.send({ type: "crdt.sync", doc_id: this.docId, update_b64: encodeUpdate(update) })
  }

  private onLocalDocUpdate = (update: Uint8Array, origin: unknown) => {
    // Skip echoes — updates we just applied from remote arrive again here.
    if (origin === this) return
    this.transport.send({
      type: "crdt.sync",
      doc_id: this.docId,
      update_b64: encodeUpdate(update),
    })
  }

  private onLocalAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === this) return
    const ids = [...changes.added, ...changes.updated, ...changes.removed]
    if (ids.length === 0) return
    const payload = encodeAwarenessUpdate(this.awareness, ids)
    this.transport.send({
      type: "crdt.awareness",
      doc_id: this.docId,
      awareness_b64: encodeUpdate(payload),
    })
  }

  private onRemoteMessage = (msg: CrdtMessage) => {
    if (msg.doc_id !== this.docId) return
    if (msg.type === "crdt.sync") {
      try {
        Y.applyUpdate(this.doc, decodeUpdate(msg.update_b64), this)
      } catch {
        /* malformed update — ignore */
      }
      return
    }
    if (msg.type === "crdt.awareness") {
      try {
        applyAwarenessUpdate(this.awareness, decodeUpdate(msg.awareness_b64), this)
      } catch {
        /* malformed update — ignore */
      }
    }
  }
}
