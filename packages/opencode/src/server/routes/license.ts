import { Hono } from "hono"
import { basicAuth } from "hono/basic-auth"
import { createHash } from "node:crypto"
import { lazy } from "../../util/lazy"
import { verifyToken } from "../../license/token"
import {
  cancelOrder,
  confirmOrderAndIssue,
  createOrder,
  findOrCreateCustomerByTelegram,
  getOrder,
  listAudit,
  listLicenses,
  listPendingOrders,
  revokeLicense,
  statsCounts,
  validateBySig,
} from "../../license/store"
import { backupOnce } from "../../license/backup"
import { checkRateLimit } from "../../license/rate-limit"
import {
  listSessionsForCustomer,
  pollAuth,
  revokeSession,
  startAuth,
  syncDelete,
  syncGet,
  syncList,
  syncPut,
  touchSession,
  verifySessionToken,
  type SessionPayload,
} from "../../license/auth"
import {
  addMemberByIdentifier,
  cancelInvite,
  createTeam,
  createTeamSession,
  deleteTeam,
  endSession,
  getMemberRole,
  getTeamDetail,
  heartbeatSession,
  listActiveSessions,
  listTeamsForCustomer,
  removeMember,
  renameTeam,
  setMemberRole,
} from "../../license/teams"
import { subscribeTeam } from "../../license/team-events"
import { streamSSE } from "hono/streaming"

const ADMIN_HASH = (process.env.OPENCODE_ADMIN_PASSPHRASE_SHA256 ?? "").toLowerCase()

function makeAdminAuth() {
  return basicAuth({
    realm: "CrimeCode Admin",
    verifyUser(_username, password) {
      if (!ADMIN_HASH) return false
      const incoming = createHash("sha256").update(password).digest("hex").toLowerCase()
      return incoming === ADMIN_HASH
    },
  })
}

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="%23ff5722"/><stop offset="1" stop-color="%23f4511e"/></linearGradient></defs><rect width="32" height="32" rx="6" fill="url(%23g)"/><text x="16" y="22" text-anchor="middle" font-family="ui-monospace,monospace" font-size="14" font-weight="800" fill="%2307070a">CC</text></svg>`

const ADMIN_DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>CrimeCode • License Admin</title>
<link rel="icon" type="image/svg+xml" href='data:image/svg+xml;utf8,${FAVICON_SVG}' />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
    background: radial-gradient(ellipse at top, #1a0a0a 0%, #07070a 70%) fixed;
    color: #f5f5f5;
    min-height: 100vh;
  }
  header {
    padding: 18px 28px;
    border-bottom: 1px solid rgba(255, 87, 34, 0.2);
    display: flex; justify-content: space-between; align-items: center;
    background: rgba(15, 15, 20, 0.7);
    backdrop-filter: blur(8px);
    position: sticky; top: 0; z-index: 10;
  }
  .brand { display: flex; align-items: center; gap: 12px; }
  .brand .logo {
    width: 36px; height: 36px; border-radius: 8px;
    background: linear-gradient(135deg, #ff5722, #f4511e);
    display: flex; align-items: center; justify-content: center;
    font-family: ui-monospace, monospace; font-weight: 800; font-size: 14px;
    color: #07070a;
    box-shadow: 0 4px 16px rgba(255, 87, 34, 0.4);
  }
  .brand-text { display: flex; flex-direction: column; line-height: 1.1; }
  .brand-name {
    position: relative;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.32em;
    color: #ff5722;
    text-shadow: 0 0 8px rgba(255,87,34,0.5);
  }
  .brand-name::before, .brand-name::after {
    content: attr(data-text);
    position: absolute; top: 0; left: 0;
    width: 100%;
  }
  .brand-name::before {
    color: #00e0ff;
    animation: glitch1 2.4s infinite linear alternate-reverse;
    clip-path: polygon(0 0, 100% 0, 100% 33%, 0 33%);
    transform: translateX(-1px);
  }
  .brand-name::after {
    color: #ff00aa;
    animation: glitch2 1.8s infinite linear alternate-reverse;
    clip-path: polygon(0 67%, 100% 67%, 100% 100%, 0 100%);
    transform: translateX(1px);
  }
  @keyframes glitch1 { 0%,90%,100%{transform:translateX(-1px)} 92%{transform:translateX(-3px)} 96%{transform:translateX(-2px)} }
  @keyframes glitch2 { 0%,88%,100%{transform:translateX(1px)} 90%{transform:translateX(3px)} 97%{transform:translateX(2px)} }
  .brand-sub { font-size: 11px; color: rgba(255,255,255,0.45); letter-spacing: 0.04em; margin-top: 2px; }
  main { padding: 24px 28px 48px; max-width: 1280px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat {
    background: rgba(21, 21, 26, 0.85); border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 10px; padding: 16px;
    transition: border-color 0.15s, transform 0.15s;
  }
  .stat:hover { border-color: rgba(255, 87, 34, 0.4); transform: translateY(-2px); }
  .stat .v { font-size: 24px; font-weight: 800; color: #ff5722; line-height: 1; }
  .stat .k { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.1em; margin-top: 6px; }
  section {
    background: rgba(21, 21, 26, 0.85); border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 10px; padding: 20px; margin-bottom: 18px;
  }
  section h2 {
    margin: 0 0 14px 0; font-size: 12px; color: #ff5722;
    text-transform: uppercase; letter-spacing: 0.1em; font-weight: 700;
    display: flex; align-items: center; gap: 8px;
  }
  section h2::before {
    content: ""; width: 14px; height: 1px; background: #ff5722;
  }
  form { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  input, select, textarea {
    background: #07070a; border: 1px solid rgba(255,255,255,0.12); color: #f5f5f5;
    padding: 9px 12px; border-radius: 7px; font: inherit;
    transition: border-color 0.15s;
  }
  input:focus, select:focus { outline: none; border-color: #ff5722; }
  input[type=text], input[type=email] { min-width: 180px; }
  textarea { min-width: 280px; min-height: 60px; }
  button {
    background: linear-gradient(135deg, #ff5722, #f4511e);
    color: white; border: none; padding: 9px 18px; border-radius: 7px;
    cursor: pointer; font-weight: 700; transition: transform 0.1s, box-shadow 0.15s;
  }
  button:hover { transform: translateY(-1px); box-shadow: 0 4px 14px rgba(255, 87, 34, 0.4); }
  button.ghost { background: transparent; border: 1px solid rgba(255,255,255,0.18); color: #ccc; box-shadow: none; }
  button.ghost:hover { border-color: #ff5722; color: #ff5722; }
  button.danger { background: linear-gradient(135deg, #d33b22, #aa2811); }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.05); }
  th { color: #888; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; font-size: 10px; }
  td.token { font-family: ui-monospace, Menlo, Consolas, monospace; word-break: break-all; max-width: 320px; }
  .pill { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
  .pill.valid    { background: rgba(74,222,128,0.15); color: #4ade80; }
  .pill.revoked  { background: rgba(255,80,80,0.15); color: #f87171; }
  .pill.expired  { background: rgba(251,191,36,0.15); color: #fbbf24; }
  .pill.pending  { background: rgba(150,150,150,0.15); color: #aaa; }
  .pill.confirmed{ background: rgba(74,222,128,0.15); color: #4ade80; }
  .toast {
    position: fixed; bottom: 24px; right: 24px;
    background: #15151a; border: 1px solid #ff5722;
    padding: 14px 20px; border-radius: 10px; max-width: 420px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.6);
    word-break: break-all;
  }
  .toast.copy { user-select: all; cursor: pointer; font-family: ui-monospace, monospace; font-size: 12px; }
  .empty { color: #666; text-align: center; padding: 16px; font-style: italic; }
  .row-actions { display: flex; gap: 6px; }
</style>
</head>
<body>
<header>
  <div class="brand">
    <div class="logo" aria-hidden="true">CC</div>
    <div class="brand-text">
      <div class="brand-name" data-text="CRIMECODE">CRIMECODE</div>
      <div class="brand-sub">License Admin Console</div>
    </div>
  </div>
  <div class="row-actions">
    <button class="ghost" onclick="triggerBackup()">📦 Backup now</button>
    <button class="ghost" onclick="refreshAll()">↻ Refresh</button>
  </div>
</header>
<main>
  <div class="stats" id="stats"></div>

  <section>
    <h2>Issue License (manual)</h2>
    <form id="issueForm">
      <input name="customer_telegram" placeholder="Telegram @handle" required />
      <select name="interval">
        <option value="monthly">monthly</option>
        <option value="annual">annual</option>
        <option value="lifetime">lifetime</option>
      </select>
      <input name="tx_hash" placeholder="tx_hash (optional)" />
      <input name="note" placeholder="note (optional)" />
      <button type="submit">Issue Token</button>
    </form>
  </section>

  <section>
    <h2>Pending Orders (Telegram)</h2>
    <table id="ordersTable"><thead><tr>
      <th>ID</th><th>Telegram</th><th>Interval</th><th>Created</th><th>Actions</th>
    </tr></thead><tbody></tbody></table>
  </section>

  <section>
    <h2>Licenses</h2>
    <table id="licensesTable"><thead><tr>
      <th>ID</th><th>Customer</th><th>Interval</th><th>Status</th><th>Issued</th><th>Expires</th><th>Last seen</th><th>Actions</th>
    </tr></thead><tbody></tbody></table>
  </section>

  <section>
    <h2>Recent Audit</h2>
    <table id="auditTable"><thead><tr>
      <th>Time</th><th>Action</th><th>Details</th>
    </tr></thead><tbody></tbody></table>
  </section>
</main>

<div id="toast" class="toast" hidden></div>

<script>
const fmt = (ts) => ts ? new Date(ts * 1000).toLocaleString() : "—"
const api = (path, opts = {}) => fetch("/license" + path, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...opts }).then(async r => {
  const text = await r.text()
  let body
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!r.ok) throw new Error(typeof body === "string" ? body : JSON.stringify(body))
  return body
})

function showToast(msg, opts = {}) {
  const el = document.getElementById("toast")
  el.textContent = msg
  el.className = "toast" + (opts.copy ? " copy" : "")
  el.hidden = false
  if (opts.copy) {
    el.onclick = () => navigator.clipboard.writeText(msg).then(() => { el.textContent = "Copied!"; setTimeout(() => el.hidden = true, 1200) })
  } else {
    setTimeout(() => el.hidden = true, 4500)
  }
}

async function loadStats() {
  const s = await api("/stats")
  document.getElementById("stats").innerHTML = Object.entries(s).map(([k, v]) =>
    \`<div class="stat"><div class="v">\${v}</div><div class="k">\${k.replaceAll("_", " ")}</div></div>\`
  ).join("")
}

async function loadOrders() {
  const orders = await api("/orders/pending")
  const tbody = document.querySelector("#ordersTable tbody")
  tbody.innerHTML = orders.length ? orders.map(o => \`
    <tr>
      <td>\${o.id}</td>
      <td>\${o.customer_telegram || "—"}</td>
      <td>\${o.interval}</td>
      <td>\${fmt(o.created_at)}</td>
      <td>
        <button onclick="confirmOrder('\${o.id}')">Confirm</button>
        <button class="ghost" onclick="cancelOrderRow('\${o.id}')">Cancel</button>
      </td>
    </tr>\`).join("") : '<tr><td colspan="5" style="color:#666;text-align:center;padding:14px">No pending orders</td></tr>'
}

async function loadLicenses() {
  const ls = await api("/list")
  const tbody = document.querySelector("#licensesTable tbody")
  tbody.innerHTML = ls.length ? ls.map(l => {
    const status = l.revoked_at ? "revoked" : (l.expires_at && l.expires_at <= Math.floor(Date.now()/1000) ? "expired" : "valid")
    return \`<tr>
      <td>\${l.id}</td>
      <td>\${l.customer_telegram || l.customer_id}</td>
      <td>\${l.interval}</td>
      <td><span class="pill \${status}">\${status}</span></td>
      <td>\${fmt(l.issued_at)}</td>
      <td>\${fmt(l.expires_at)}</td>
      <td>\${fmt(l.last_validated_at)}</td>
      <td>\${l.revoked_at ? '—' : \`<button class="danger" onclick="revoke('\${l.id}')">Revoke</button>\`}</td>
    </tr>\`
  }).join("") : '<tr><td colspan="8" style="color:#666;text-align:center;padding:14px">No licenses yet</td></tr>'
}

async function loadAudit() {
  const a = await api("/audit")
  const tbody = document.querySelector("#auditTable tbody")
  tbody.innerHTML = a.slice(0, 30).map(e => \`
    <tr><td>\${fmt(e.ts)}</td><td>\${e.action}</td><td><code>\${e.details ? String(e.details).slice(0, 200) : ""}</code></td></tr>\`).join("")
}

async function refreshAll() { await Promise.all([loadStats(), loadOrders(), loadLicenses(), loadAudit()]) }

async function triggerBackup() {
  showToast("📦 Snapshotting database…")
  try {
    const r = await api("/backup", { method: "POST" })
    if (r && r.ok) {
      showToast("✅ Backup uploaded: " + (r.key || "(see audit)"))
    } else {
      showToast("Error: " + (r && r.error ? r.error : "unknown"))
    }
    await loadAudit()
  } catch (e) { showToast("Error: " + e.message) }
}

async function confirmOrder(id) {
  const tx = prompt("tx_hash (optional, leave empty to skip)") || null
  try {
    const r = await api("/orders/" + encodeURIComponent(id) + "/confirm", { method: "POST", body: JSON.stringify({ tx_hash: tx }) })
    showToast(r.token, { copy: true })
    await refreshAll()
  } catch (e) { showToast("Error: " + e.message) }
}

async function cancelOrderRow(id) {
  if (!confirm("Cancel order " + id + "?")) return
  try { await api("/orders/" + encodeURIComponent(id) + "/cancel", { method: "POST" }); await refreshAll() }
  catch (e) { showToast("Error: " + e.message) }
}

async function revoke(id) {
  const reason = prompt("Reason (optional)") || ""
  try { await api("/" + encodeURIComponent(id) + "/revoke", { method: "POST", body: JSON.stringify({ reason }) }); await refreshAll() }
  catch (e) { showToast("Error: " + e.message) }
}

document.getElementById("issueForm").addEventListener("submit", async (e) => {
  e.preventDefault()
  const data = Object.fromEntries(new FormData(e.target))
  try {
    const r = await api("/issue", { method: "POST", body: JSON.stringify(data) })
    showToast(r.token, { copy: true })
    e.target.reset()
    await refreshAll()
  } catch (err) { showToast("Error: " + err.message) }
})

refreshAll()
</script>
</body>
</html>`

export const LicenseRoutes = lazy(() => {
  const app = new Hono()

  // ────────────────────────────────────────────────────────────────────────
  //  Public auth flow (Telegram-magic-link)
  // ────────────────────────────────────────────────────────────────────────

  // 1. Client calls POST /auth/start → receives a PIN + bot deep-link URL.
  app.post("/auth/start", async (c) => {
    const ip =
      c.req.header("CF-Connecting-IP") ??
      c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
      "unknown"
    const rl = checkRateLimit("auth-start:" + ip)
    if (!rl.ok) {
      return c.json({ error: "rate_limited", retry_after: rl.retryAfterSeconds }, 429)
    }
    let body: { device_label?: string } = {}
    try {
      body = (await c.req.json()) ?? {}
    } catch {
      // body optional
    }
    const started = startAuth({ device_label: body.device_label?.slice(0, 80) ?? null })
    return c.json(started)
  })

  // 2. Client polls GET /auth/poll/:pin → "pending" until claimed, then "ok"
  //    with a session token (and the PIN row is consumed).
  app.get("/auth/poll/:pin", (c) => {
    const pin = c.req.param("pin").toUpperCase()
    if (!/^[A-Z0-9]{4,32}$/.test(pin)) return c.json({ status: "unknown" }, 400)
    return c.json(pollAuth(pin))
  })

  // 3. Authenticated endpoints: any client with a valid session token.
  const sessionGuard = (c: Parameters<Parameters<typeof app.use>[1]>[0]): SessionPayload | null => {
    const auth = c.req.header("Authorization") ?? ""
    if (!auth.startsWith("Bearer ")) return null
    const token = auth.slice(7)
    const v = verifySessionToken(token)
    if (!v.ok) return null
    touchSession(v.payload.sid)
    return v.payload
  }

  app.get("/auth/me", (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    return c.json({
      customer_id: sess.sub,
      telegram_user_id: sess.tg,
      session_id: sess.sid,
      expires_at: sess.exp,
      sessions: listSessionsForCustomer(sess.sub),
    })
  })

  app.post("/auth/logout", (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    revokeSession(sess.sid)
    return c.json({ ok: true })
  })

  app.post("/auth/sessions/:sid/revoke", (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const target = c.req.param("sid")
    const isOwn = listSessionsForCustomer(sess.sub).some((s) => s.id === target)
    if (!isOwn) return c.json({ error: "not_found" }, 404)
    revokeSession(target)
    return c.json({ ok: true })
  })

  // ────────────────────────────────────────────────────────────────────────
  //  Sync (per-account key-value store, max 64KB per key)
  // ────────────────────────────────────────────────────────────────────────

  app.get("/sync/:key", (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const entry = syncGet(sess.sub, c.req.param("key"))
    if (!entry) return c.json({ error: "not_found" }, 404)
    return c.json(entry)
  })

  app.get("/sync", (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    return c.json({ entries: syncList(sess.sub) })
  })

  app.put("/sync/:key", async (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const key = c.req.param("key")
    const body = (await c.req.json().catch(() => null)) as { value?: string } | null
    if (!body || typeof body.value !== "string") return c.json({ error: "missing_value" }, 400)
    try {
      const entry = syncPut(sess.sub, key, body.value)
      return c.json(entry)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  app.delete("/sync/:key", (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    syncDelete(sess.sub, c.req.param("key"))
    return c.json({ ok: true })
  })

  // ────────────────────────────────────────────────────────────────────────
  //  Teams — workspaces shared by multiple accounts with live sessions
  // ────────────────────────────────────────────────────────────────────────

  const teamError = (err: unknown): { status: number; body: { error: string } } => {
    const msg = err instanceof Error ? err.message : String(err)
    const codes: Record<string, number> = {
      forbidden: 403,
      only_owner: 403,
      invalid_name: 400,
      not_found: 404,
      already_member: 409,
      cannot_remove_owner: 409,
      not_member: 403,
    }
    return { status: codes[msg] ?? 500, body: { error: msg } }
  }

  app.get("/teams", (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    return c.json({ teams: listTeamsForCustomer(sess.sub) })
  })

  app.post("/teams", async (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const body = (await c.req.json().catch(() => ({}))) as { name?: string }
    try {
      const team = createTeam(sess.sub, body.name ?? "")
      return c.json({ team })
    } catch (err) {
      const { status, body: b } = teamError(err)
      return c.json(b, status as 400 | 500)
    }
  })

  app.get("/teams/:id", (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const detail = getTeamDetail(c.req.param("id"), sess.sub)
    if (!detail) return c.json({ error: "not_found" }, 404)
    return c.json(detail)
  })

  app.patch("/teams/:id", async (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const body = (await c.req.json().catch(() => ({}))) as { name?: string }
    try {
      const team = renameTeam(c.req.param("id"), sess.sub, body.name ?? "")
      return c.json({ team })
    } catch (err) {
      const { status, body: b } = teamError(err)
      return c.json(b, status as 400 | 500)
    }
  })

  app.delete("/teams/:id", (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    try {
      deleteTeam(c.req.param("id"), sess.sub)
      return c.json({ ok: true })
    } catch (err) {
      const { status, body: b } = teamError(err)
      return c.json(b, status as 400 | 500)
    }
  })

  app.post("/teams/:id/members", async (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const body = (await c.req.json().catch(() => ({}))) as { identifier?: string }
    if (!body.identifier) return c.json({ error: "missing_identifier" }, 400)
    try {
      const r = addMemberByIdentifier(c.req.param("id"), sess.sub, body.identifier)
      return c.json(r)
    } catch (err) {
      const { status, body: b } = teamError(err)
      return c.json(b, status as 400 | 500)
    }
  })

  app.delete("/teams/:id/members/:customerId", (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    try {
      removeMember(c.req.param("id"), sess.sub, c.req.param("customerId"))
      return c.json({ ok: true })
    } catch (err) {
      const { status, body: b } = teamError(err)
      return c.json(b, status as 400 | 500)
    }
  })

  app.patch("/teams/:id/members/:customerId", async (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const body = (await c.req.json().catch(() => ({}))) as { role?: string }
    if (body.role !== "admin" && body.role !== "member") {
      return c.json({ error: "invalid_role" }, 400)
    }
    try {
      const member = setMemberRole(c.req.param("id"), sess.sub, c.req.param("customerId"), body.role)
      return c.json({ member })
    } catch (err) {
      const { status, body: b } = teamError(err)
      return c.json(b, status as 400 | 500)
    }
  })

  app.delete("/teams/:id/invites/:inviteId", (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    try {
      cancelInvite(c.req.param("id"), sess.sub, c.req.param("inviteId"))
      return c.json({ ok: true })
    } catch (err) {
      const { status, body: b } = teamError(err)
      return c.json(b, status as 400 | 500)
    }
  })

  // Live sessions — a team member advertises an editor session; other
  // members see it in their workspace switcher.
  app.get("/teams/:id/sessions", (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    return c.json({ sessions: listActiveSessions(c.req.param("id"), sess.sub) })
  })

  app.post("/teams/:id/sessions", async (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const body = (await c.req.json().catch(() => ({}))) as { title?: string; state?: unknown }
    if (!body.title) return c.json({ error: "missing_title" }, 400)
    try {
      const row = createTeamSession({
        team_id: c.req.param("id"),
        host: sess.sub,
        title: body.title,
        state: body.state,
      })
      return c.json(row)
    } catch (err) {
      const { status, body: b } = teamError(err)
      return c.json(b, status as 400 | 500)
    }
  })

  app.post("/teams/:id/sessions/:sid/heartbeat", async (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const body = (await c.req.json().catch(() => ({}))) as { state?: unknown }
    const row = heartbeatSession(c.req.param("sid"), sess.sub, body.state)
    if (!row) return c.json({ error: "not_found_or_not_host" }, 404)
    return c.json(row)
  })

  app.delete("/teams/:id/sessions/:sid", (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const ok = endSession(c.req.param("sid"), sess.sub)
    if (!ok) return c.json({ error: "not_found" }, 404)
    return c.json({ ok: true })
  })

  // SSE stream: live push of team events (sessions, member changes, renames).
  // EventSource can't send Authorization headers, so the browser client passes
  // the session token as `?access_token=` — we verify it the same way as the
  // Bearer header.
  app.get("/teams/:id/events", async (c) => {
    const bearer = c.req.header("Authorization")?.replace(/^Bearer\s+/, "")
    const qToken = c.req.query("access_token")
    const token = bearer || qToken
    if (!token) return c.json({ error: "unauthorized" }, 401)
    const verified = verifySessionToken(token)
    if (!verified.ok) return c.json({ error: "unauthorized" }, 401)
    const teamId = c.req.param("id")
    if (!getMemberRole(teamId, verified.payload.sub)) return c.json({ error: "forbidden" }, 403)
    touchSession(verified.payload.sid)

    return streamSSE(c, async (stream) => {
      let closed = false
      const unsubscribe = subscribeTeam(teamId, (event) => {
        if (closed) return
        void stream.writeSSE({ data: JSON.stringify(event), event: event.type })
      })
      // Send an initial hello + snapshot so the client has something to render
      // before the first real event arrives.
      await stream.writeSSE({ data: JSON.stringify({ type: "hello", team_id: teamId }), event: "hello" })
      // Heartbeat every 25s keeps intermediaries (Cloudflare, Fly proxies)
      // from closing the idle connection.
      const hb = setInterval(() => {
        if (closed) return
        void stream.writeSSE({ data: String(Date.now()), event: "ping" }).catch(() => undefined)
      }, 25_000)
      stream.onAbort(() => {
        closed = true
        clearInterval(hb)
        unsubscribe()
      })
      // Keep the promise pending forever (until the client disconnects).
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (closed) {
            clearInterval(check)
            clearInterval(hb)
            resolve()
          }
        }, 1_000)
      })
    })
  })

  // ────────────────────────────────────────────────────────────────────────
  //  Original license endpoints
  // ────────────────────────────────────────────────────────────────────────

  // --- Public endpoint (no admin auth — used by Electron client) ---
  app.post("/validate", async (c) => {
    // Rate limit per source IP — 10 requests / 60 s. Trust CF-Connecting-IP
    // (set by Cloudflare proxy) first, then fall back to the leftmost
    // X-Forwarded-For (Fly's edge proxy) and finally to the connection
    // remote address.
    const ip =
      c.req.header("CF-Connecting-IP") ??
      c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
      c.req.header("Fly-Client-IP") ??
      "unknown"
    const rl = checkRateLimit(ip)
    if (!rl.ok) {
      return new Response(
        JSON.stringify({ status: "rate_limited", retry_after: rl.retryAfterSeconds }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": String(rl.retryAfterSeconds ?? 60),
          },
        },
      )
    }
    let body: { token?: string; machine_id?: string }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ status: "unknown", reason: "invalid_json" }, 400)
    }
    if (!body.token) return c.json({ status: "unknown", reason: "missing_token" }, 400)
    const v = verifyToken(body.token)
    if (!v.ok || !v.payload || !v.sig) return c.json({ status: "unknown", reason: v.reason ?? "bad_token" }, 200)
    const result = validateBySig({ token_sig: v.sig, machine_id: body.machine_id ?? null })
    return c.json({
      ...result,
      interval: v.payload.i,
      issued_at: v.payload.t,
    })
  })

  // --- Admin endpoints (Basic Auth with admin passphrase) ---
  const admin = new Hono()
  admin.use("*", makeAdminAuth())

  admin.get("/stats", (c) => c.json(statsCounts()))

  admin.post("/issue", async (c) => {
    const body = (await c.req.json()) as {
      customer_telegram?: string
      interval?: string
      tx_hash?: string
      note?: string
    }
    if (!body.interval || !["monthly", "annual", "lifetime"].includes(body.interval)) {
      return c.json({ error: "invalid_interval" }, 400)
    }
    if (!body.customer_telegram) return c.json({ error: "missing_telegram" }, 400)
    const customer = findOrCreateCustomerByTelegram({
      telegram: body.customer_telegram,
      note: body.note ?? null,
    })
    const order = createOrder({
      customer_telegram: customer.telegram,
      customer_user_id: customer.telegram_user_id,
      interval: body.interval as "monthly" | "annual" | "lifetime",
      note: body.note ?? null,
    })
    const result = confirmOrderAndIssue({ order_id: order.id, tx_hash: body.tx_hash ?? null })
    if ("error" in result) return c.json(result, 400)
    return c.json({
      token: result.token,
      license_id: result.license.id,
      customer_id: result.customer.id,
      order_id: result.order.id,
    })
  })

  admin.get("/orders/pending", (c) => c.json(listPendingOrders(100)))

  admin.post("/orders/:id/confirm", async (c) => {
    const id = c.req.param("id")
    const body = (await c.req.json().catch(() => ({}))) as { tx_hash?: string }
    const result = confirmOrderAndIssue({ order_id: id, tx_hash: body.tx_hash ?? null })
    if ("error" in result) return c.json(result, 400)
    return c.json({
      token: result.token,
      license_id: result.license.id,
      customer_id: result.customer.id,
      order_id: result.order.id,
    })
  })

  admin.post("/orders/:id/cancel", (c) => {
    const id = c.req.param("id")
    const r = cancelOrder(id)
    if (!r) return c.json({ error: "not_pending_or_not_found" }, 400)
    return c.json(r)
  })

  admin.get("/list", (c) => c.json(listLicenses(200)))

  admin.post("/:id/revoke", async (c) => {
    const id = c.req.param("id")
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string }
    const r = revokeLicense(id, body.reason ?? null)
    if (!r) return c.json({ error: "not_found" }, 404)
    return c.json(r)
  })

  admin.get("/audit", (c) => c.json(listAudit(200)))

  admin.post("/backup", async (c) => {
    const r = await backupOnce()
    return c.json(r, r.ok ? 200 : 500)
  })

  // dashboard HTML (served at /license/admin)
  admin.get("/admin", (c) => c.html(ADMIN_DASHBOARD_HTML))

  app.route("/", admin)

  // top-level alias /admin → dashboard
  app.get("/dashboard", makeAdminAuth(), (c) => c.html(ADMIN_DASHBOARD_HTML))

  return app
})
