// Screen-share WebRTC manager. Uses the existing live-share signaling socket
// to negotiate one RTCPeerConnection per remote viewer. Host side captures a
// desktop source via Electron's getUserMedia and addTrack()s into each peer.
// Viewer side waits for an offer and renders the remote stream.

import { createStore } from "solid-js/store"
import type { Handle as SocketHandle, Msg } from "./live-share-socket"

export type Role = "host" | "viewer"
export type Quality = "720p" | "1080p" | "4k"

export interface PeerInfo {
  id: string
  name: string
  state: RTCPeerConnectionState
}

export interface HostOpts {
  quality?: Quality
  fps?: number
  audio?: boolean
}

const QUALITY: Record<Quality, { w: number; h: number; bitrate: number }> = {
  "720p": { w: 1280, h: 720, bitrate: 1_500_000 },
  "1080p": { w: 1920, h: 1080, bitrate: 3_000_000 },
  "4k": { w: 3840, h: 2160, bitrate: 10_000_000 },
}

export interface State {
  role: Role | null
  active: boolean
  sourceId: string | null
  sourceName: string | null
  peers: PeerInfo[]
  remoteStream: MediaStream | null
  remoteFromId: string | null
  remoteFromName: string | null
  error: string | null
}

const ICE: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }],
}

export interface Handle {
  state: State
  startHost: (sourceId: string, sourceName: string, opts?: HostOpts) => Promise<void>
  stopHost: () => void
  acceptViewer: (viewerId: string, viewerName: string) => Promise<void>
  closeRemote: () => void
  handle: (msg: Msg) => void
}

export function createScreenShare(sock: () => SocketHandle | null, selfId: () => string | null): Handle {
  const [state, set] = createStore<State>({
    role: null,
    active: false,
    sourceId: null,
    sourceName: null,
    peers: [],
    remoteStream: null,
    remoteFromId: null,
    remoteFromName: null,
    error: null,
  })

  // Host side: peer connection per viewer
  const peers = new Map<string, RTCPeerConnection>()
  // Viewer side: single connection back to host
  let viewerPc: RTCPeerConnection | null = null
  let local: MediaStream | null = null

  function send(m: Msg) {
    sock()?.send(m)
  }

  function patchPeer(id: string, name: string, st: RTCPeerConnectionState) {
    const cur = state.peers
    const i = cur.findIndex((p) => p.id === id)
    if (i < 0) set("peers", [...cur, { id, name, state: st }])
    else set("peers", i, "state", st)
  }

  function dropPeer(id: string) {
    set(
      "peers",
      state.peers.filter((p) => p.id !== id),
    )
  }

  async function attachTracksTo(pc: RTCPeerConnection) {
    if (!local) return
    for (const track of local.getTracks()) pc.addTrack(track, local)
    // Apply video bitrate cap (set by host on start).
    if (bitrate) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== "video") continue
        const params = sender.getParameters()
        params.encodings = params.encodings?.length ? params.encodings : [{}]
        for (const e of params.encodings) e.maxBitrate = bitrate
        try {
          await sender.setParameters(params)
        } catch {}
      }
    }
  }

  let bitrate = 0

  async function startHost(sourceId: string, sourceName: string, opts?: HostOpts) {
    set({ error: null })
    if (local) stopHost()
    const q = QUALITY[opts?.quality ?? "1080p"]
    const fps = opts?.fps ?? 30
    bitrate = q.bitrate
    try {
      // Electron-specific constraints to capture desktop source by id.
      local = await (navigator.mediaDevices as any).getUserMedia({
        audio: opts?.audio ? { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId } } : false,
        video: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: sourceId,
            maxWidth: q.w,
            maxHeight: q.h,
            maxFrameRate: fps,
          },
        },
      })
    } catch (e) {
      set({ error: String(e) })
      return
    }
    set({ role: "host", active: true, sourceId, sourceName })
    // Announce so viewers know they can request a stream.
    send({ type: "screen.start", sourceName })
  }

  function stopHost() {
    if (local) {
      for (const t of local.getTracks()) t.stop()
      local = null
    }
    for (const [id, pc] of peers) {
      try {
        pc.close()
      } catch {}
      dropPeer(id)
    }
    peers.clear()
    if (state.active && state.role === "host") send({ type: "screen.stop" })
    set({ role: null, active: false, sourceId: null, sourceName: null, peers: [] })
  }

  function closeRemote() {
    if (viewerPc) {
      try {
        viewerPc.close()
      } catch {}
      viewerPc = null
    }
    if (state.remoteFromId) send({ type: "screen.stop", __to: state.remoteFromId } as Msg)
    set({ remoteStream: null, remoteFromId: null, remoteFromName: null, role: null, active: false })
  }

  async function acceptViewer(viewerId: string, viewerName: string) {
    if (!local) return
    let pc = peers.get(viewerId)
    if (pc) {
      try {
        pc.close()
      } catch {}
    }
    pc = new RTCPeerConnection(ICE)
    peers.set(viewerId, pc)
    patchPeer(viewerId, viewerName, pc.connectionState)
    pc.onicecandidate = (e) => {
      if (e.candidate) send({ type: "screen.ice", candidate: e.candidate.toJSON(), __to: viewerId } as Msg)
    }
    pc.onconnectionstatechange = () => {
      patchPeer(viewerId, viewerName, pc!.connectionState)
      if (pc!.connectionState === "failed" || pc!.connectionState === "closed") {
        peers.delete(viewerId)
        dropPeer(viewerId)
      }
    }
    await attachTracksTo(pc)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    send({ type: "screen.offer", sdp: offer.sdp, __to: viewerId } as Msg)
  }

  async function handleOffer(fromId: string, fromName: string, sdp: string) {
    if (viewerPc) {
      try {
        viewerPc.close()
      } catch {}
    }
    const pc = new RTCPeerConnection(ICE)
    viewerPc = pc
    set({ role: "viewer", active: true, remoteFromId: fromId, remoteFromName: fromName })
    pc.onicecandidate = (e) => {
      if (e.candidate) send({ type: "screen.ice", candidate: e.candidate.toJSON(), __to: fromId } as Msg)
    }
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track])
      set("remoteStream", stream)
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        set({ remoteStream: null, remoteFromId: null, remoteFromName: null, role: null, active: false })
        viewerPc = null
      }
    }
    await pc.setRemoteDescription({ type: "offer", sdp })
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    send({ type: "screen.answer", sdp: answer.sdp, __to: fromId } as Msg)
  }

  async function handleAnswer(fromId: string, sdp: string) {
    const pc = peers.get(fromId)
    if (!pc) return
    if (pc.signalingState === "stable") return
    await pc.setRemoteDescription({ type: "answer", sdp })
  }

  async function handleIce(fromId: string, candidate: RTCIceCandidateInit) {
    const pc = state.role === "host" ? peers.get(fromId) : viewerPc
    if (!pc) return
    try {
      await pc.addIceCandidate(candidate)
    } catch {}
  }

  function handle(msg: Msg) {
    const t = msg.type
    if (!t.startsWith("screen.")) return
    const fromId = (msg as any).from as string | undefined
    if (!fromId || fromId === selfId()) return
    if (t === "screen.request" && state.role === "host" && local) {
      void acceptViewer(fromId, ((msg as any).name as string) ?? "viewer")
      return
    }
    if (t === "screen.start") {
      // Host announced — viewer auto-requests.
      send({ type: "screen.request", __to: fromId } as Msg)
      return
    }
    if (t === "screen.stop") {
      if (state.role === "host" && peers.has(fromId)) {
        const pc = peers.get(fromId)!
        try {
          pc.close()
        } catch {}
        peers.delete(fromId)
        dropPeer(fromId)
      }
      if (state.role === "viewer" && fromId === state.remoteFromId) {
        if (viewerPc) {
          try {
            viewerPc.close()
          } catch {}
          viewerPc = null
        }
        set({ remoteStream: null, remoteFromId: null, remoteFromName: null, role: null, active: false })
      }
      return
    }
    if (t === "screen.offer") {
      void handleOffer(fromId, ((msg as any).name as string) ?? "host", (msg as any).sdp as string)
      return
    }
    if (t === "screen.answer") {
      void handleAnswer(fromId, (msg as any).sdp as string)
      return
    }
    if (t === "screen.ice") {
      void handleIce(fromId, (msg as any).candidate as RTCIceCandidateInit)
      return
    }
  }

  return { state, startHost, stopHost, acceptViewer, closeRemote, handle }
}
