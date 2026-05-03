import z from "zod"
import { SessionID, MessageID, PartID } from "./schema"
import { Snapshot } from "../snapshot"
import { MessageV2 } from "./message-v2"
import { Session } from "."
import { Log } from "../util/log"
import { SyncEvent } from "../sync"
import { Storage } from "@/storage/storage"
import { Bus } from "../bus"
import { SessionPrompt } from "./prompt"
import { SessionSummary } from "./summary"

export namespace SessionRevert {
  const log = Log.create({ service: "session.revert" })

  export const RevertInput = z.object({
    sessionID: SessionID.zod,
    messageID: MessageID.zod,
    partID: PartID.zod.optional(),
  })
  export type RevertInput = z.infer<typeof RevertInput>

  export async function revert(input: RevertInput) {
    // Defensive: assertNotBusy throws when the assistant is still streaming
    // — the client SHOULD wait, but the desktop occasionally fires revert
    // automatically on session-enter and we don't want a 500 to bubble up
    // and freeze the UI in "loading". Treat busy as "no-op return current session".
    try {
      SessionPrompt.assertNotBusy(input.sessionID)
    } catch (err) {
      log.warn("revert called while session busy — returning current state", {
        sessionID: input.sessionID,
        err: err instanceof Error ? err.message : String(err),
      })
      return Session.get(input.sessionID)
    }

    const all = await Session.messages({ sessionID: input.sessionID }).catch((err) => {
      log.warn("revert: Session.messages failed, treating as empty", { err: err?.message })
      return [] as MessageV2.WithParts[]
    })
    const session = await Session.get(input.sessionID)

    // Empty session, missing messageID, or no messages match → nothing to revert.
    // Return the current session unchanged (no 500). This is the path the desktop
    // hits when it auto-reverts on session-enter for a fresh session.
    if (all.length === 0) return session
    if (!all.some((msg) => msg.info.id === input.messageID)) {
      log.info("revert: messageID not in session — no-op", {
        sessionID: input.sessionID,
        messageID: input.messageID,
      })
      return session
    }

    let lastUser: MessageV2.User | undefined
    let revert: Session.Info["revert"]
    const patches: Snapshot.Patch[] = []
    for (const msg of all) {
      if (msg.info.role === "user") lastUser = msg.info
      const remaining = []
      for (const part of msg.parts) {
        if (revert) {
          if (part.type === "patch") {
            patches.push(part)
          }
          continue
        }

        if (!revert) {
          if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
            // if no useful parts left in message, same as reverting whole message
            const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
            revert = {
              messageID: !partID && lastUser ? lastUser.id : msg.info.id,
              partID,
            }
          }
          remaining.push(part)
        }
      }
    }

    if (revert) {
      try {
        const session = await Session.get(input.sessionID)
        revert.snapshot = session.revert?.snapshot ?? (await Snapshot.track().catch(() => undefined))
        if (patches.length > 0) await Snapshot.revert(patches).catch((err) => {
          log.warn("Snapshot.revert failed, skipping", { err: err?.message })
        })
        if (revert.snapshot) {
          revert.diff = await Snapshot.diff(revert.snapshot).catch(() => undefined)
        }
        const rangeMessages = all.filter((msg) => msg.info.id >= revert!.messageID)
        const diffs = await SessionSummary.computeDiff({ messages: rangeMessages }).catch(() => [])
        await Storage.write(["session_diff", input.sessionID], diffs).catch(() => undefined)
        Bus.publish(Session.Event.Diff, {
          sessionID: input.sessionID,
          diff: diffs,
        })
        return Session.setRevert({
          sessionID: input.sessionID,
          revert,
          summary: {
            additions: diffs.reduce((sum, x) => sum + x.additions, 0),
            deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
            files: diffs.length,
          },
        })
      } catch (err) {
        log.error("revert: snapshot/diff pipeline failed", {
          sessionID: input.sessionID,
          err: err instanceof Error ? err.message : String(err),
        })
        // Don't 500 — return the current session; the desktop UI stays alive.
        return session
      }
    }
    return session
  }

  export async function unrevert(input: { sessionID: SessionID }) {
    log.info("unreverting", input)
    SessionPrompt.assertNotBusy(input.sessionID)
    const session = await Session.get(input.sessionID)
    if (!session.revert) return session
    if (session.revert.snapshot) await Snapshot.restore(session.revert.snapshot)
    return Session.clearRevert(input.sessionID)
  }

  export async function cleanup(session: Session.Info) {
    if (!session.revert) return
    const sessionID = session.id
    const msgs = await Session.messages({ sessionID })
    const messageID = session.revert.messageID
    const preserve = [] as MessageV2.WithParts[]
    const remove = [] as MessageV2.WithParts[]
    let target: MessageV2.WithParts | undefined
    for (const msg of msgs) {
      if (msg.info.id < messageID) {
        preserve.push(msg)
        continue
      }
      if (msg.info.id > messageID) {
        remove.push(msg)
        continue
      }
      if (session.revert.partID) {
        preserve.push(msg)
        target = msg
        continue
      }
      remove.push(msg)
    }
    for (const msg of remove) {
      SyncEvent.run(MessageV2.Event.Removed, {
        sessionID: sessionID,
        messageID: msg.info.id,
      })
    }
    if (session.revert.partID && target) {
      const partID = session.revert.partID
      const removeStart = target.parts.findIndex((part) => part.id === partID)
      if (removeStart >= 0) {
        const preserveParts = target.parts.slice(0, removeStart)
        const removeParts = target.parts.slice(removeStart)
        target.parts = preserveParts
        for (const part of removeParts) {
          SyncEvent.run(MessageV2.Event.PartRemoved, {
            sessionID: sessionID,
            messageID: target.info.id,
            partID: part.id,
          })
        }
      }
    }
    await Session.clearRevert(sessionID)
  }
}
