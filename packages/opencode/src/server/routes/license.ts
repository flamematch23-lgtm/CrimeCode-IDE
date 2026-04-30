import { Hono } from "hono"
import { basicAuth } from "hono/basic-auth"
import { createHash } from "node:crypto"
import { lazy } from "../../util/lazy"
import { verifyToken } from "../../license/token"
import {
  adminExtendTrial,
  analyticsSnapshot,
  cancelOrder,
  confirmOrderAndIssue,
  createOrder,
  findOrCreateCustomerByTelegram,
  getOffersForOrder,
  getOrder,
  listAudit,
  listLicenses,
  listPendingOrders,
  revokeLicense,
  statsCounts,
  validateBySig,
} from "../../license/store"
import { getWallets } from "../../license/wallets"
import { backupOnce } from "../../license/backup"
import { s3Put, s3Config } from "../../license/s3-upload"
import { randomBytes } from "node:crypto"
import { checkRateLimit } from "../../license/rate-limit"
import {
  approveCustomer,
  getApprovalStatus,
  listPasswordAccounts,
  listPendingCustomers,
  listSessionsForCustomer,
  pollAuth,
  rejectCustomer,
  revokePasswordAccount,
  revokeSession,
  signInWithPassword,
  signUpWithPassword,
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
  notifyAdminNewPendingUser,
  notifyUserApproved,
  notifyUserRejected,
} from "../../license/telegram-notify"
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
  transferOwnership,
  postChatMessage,
  listChatMessages,
  broadcastTyping,
  markChatRead,
  listChatReads,
  listTeamAgents,
  createTeamAgent,
  updateTeamAgent,
  deleteTeamAgent,
  getCustomerDisplay,
  getSessionState,
  createInviteLink,
  listInviteLinks,
  revokeInviteLink,
  previewInviteLink,
  redeemInviteLink,
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
  .stat .k { font-size: 10px; color: #b5b5bd; text-transform: uppercase; letter-spacing: 0.1em; margin-top: 6px; font-weight: 600; }
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
  .empty { color: #b5b5bd; text-align: center; padding: 16px; font-style: italic; }
  .sr-only { position: absolute !important; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  form input, form select, form textarea, form button { min-height: 40px; }
  form :focus-visible { outline: 2px solid #ff5722; outline-offset: 2px; }
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
    <button class="ghost" onclick="triggerBackup()" aria-label="Trigger a manual database backup">📦 Backup now</button>
    <button class="ghost" onclick="refreshAll()" aria-label="Refresh dashboard data">↻ Refresh</button>
  </div>
</header>
<main aria-label="License admin dashboard">
  <div class="stats" id="stats"></div>

  <section>
    <h2>📊 Analytics</h2>
    <div class="stats" id="analytics"></div>
  </section>

  <section>
    <h2>🎁 Extend trial / free days</h2>
    <p style="color:#888;font-size:12px;margin:0 0 10px">Hand a short manual license to a customer (e.g. a promo, a support make-good). Issues a real signed token with the given expiry in days.</p>
    <form id="trialForm">
      <label class="sr-only" for="trial-telegram">Customer Telegram handle</label>
      <input id="trial-telegram" name="customer_telegram" placeholder="@customer" required aria-label="Customer Telegram handle" />
      <label class="sr-only" for="trial-days">Days</label>
      <input id="trial-days" name="days" type="number" min="1" max="365" placeholder="days (1-365)" required aria-label="Days" />
      <label class="sr-only" for="trial-note">Note</label>
      <input id="trial-note" name="note" placeholder="note (optional)" aria-label="Note" />
      <button type="submit">Issue Trial Token</button>
    </form>
  </section>

  <section>
    <h2>Issue License (manual)</h2>
    <form id="issueForm">
      <label class="sr-only" for="issue-telegram">Customer Telegram handle</label>
      <input id="issue-telegram" name="customer_telegram" placeholder="Telegram @handle" required aria-label="Customer Telegram handle" />
      <label class="sr-only" for="issue-interval">Plan</label>
      <select id="issue-interval" name="interval" aria-label="Plan">
        <option value="monthly">monthly</option>
        <option value="annual">annual</option>
        <option value="lifetime">lifetime</option>
      </select>
      <label class="sr-only" for="issue-txhash">Transaction hash (optional)</label>
      <input id="issue-txhash" name="tx_hash" placeholder="tx_hash (optional)" aria-label="Transaction hash (optional)" />
      <label class="sr-only" for="issue-note">Note (optional)</label>
      <input id="issue-note" name="note" placeholder="note (optional)" aria-label="Note (optional)" />
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
    <h2>⏳ Pending approvals</h2>
    <table id="pendingTable"><thead><tr>
      <th>Customer ID</th><th>Username</th><th>Telegram</th><th>Email</th><th>Registered</th><th>Approve</th><th>Reject</th>
    </tr></thead><tbody></tbody></table>
  </section>

  <section>
    <h2>👤 Password accounts</h2>
    <table id="accountsTable"><thead><tr>
      <th>Username</th><th>Customer ID</th><th>Telegram</th><th>Created</th><th>Last login</th><th>Status</th><th>Actions</th>
    </tr></thead><tbody></tbody></table>
  </section>

  <section>
    <h2>Recent Audit</h2>
    <table id="auditTable"><thead><tr>
      <th>Time</th><th>Action</th><th>Details</th>
    </tr></thead><tbody></tbody></table>
  </section>
</main>

<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>

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

async function loadAnalytics() {
  try {
    const a = await api("/analytics")
    const fmt$ = (n) => "$" + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })
    const fmtPct = (n) => Number(n || 0).toFixed(1) + "%"
    const cards = [
      ["MRR", fmt$(a.mrr_usd)],
      ["Revenue 30d", fmt$(a.revenue_30d_usd)],
      ["Revenue 365d", fmt$(a.revenue_365d_usd)],
      ["Revenue total", fmt$(a.revenue_total_usd)],
      ["Conversion rate", fmtPct(a.conversion_rate_pct)],
      ["Churn 30d", fmtPct(a.churn_30d_pct)],
      ["Orders 30d", a.orders_30d],
      ["Licenses active", a.licenses_active],
    ]
    document.getElementById("analytics").innerHTML = cards
      .map(([k, v]) => \`<div class="stat"><div class="v">\${v}</div><div class="k">\${k}</div></div>\`)
      .join("")
  } catch (e) {
    document.getElementById("analytics").innerHTML = '<div class="empty">Analytics unavailable: ' + e.message + "</div>"
  }
}

async function loadAccounts() {
  try {
    const r = await api("/accounts")
    const tbody = document.querySelector("#accountsTable tbody")
    const rows = r.accounts || []
    tbody.innerHTML = rows.length
      ? rows.map((a) => {
          const status = a.revoked_at ? "revoked" : "active"
          return \`<tr>
            <td><code>\${a.username}</code></td>
            <td><code>\${a.customer_id.slice(0, 16)}</code></td>
            <td>\${a.telegram || "—"}</td>
            <td>\${fmt(a.created_at)}</td>
            <td>\${fmt(a.last_login_at)}</td>
            <td><span class="pill \${status}">\${status}</span></td>
            <td>\${a.revoked_at ? "—" : \`<button class="danger" onclick="revokeAccount('\${a.customer_id}')">Revoke</button>\`}</td>
          </tr>\`
        }).join("")
      : '<tr><td colspan="7" class="empty">No accounts yet</td></tr>'
  } catch (e) {
    console.error("loadAccounts", e)
  }
}

async function revokeAccount(cid) {
  if (!confirm("Revoke this password account? The user won't be able to sign in again.")) return
  try {
    await api("/accounts/" + encodeURIComponent(cid) + "/revoke", { method: "POST" })
    showToast("Account revoked.")
    await loadAccounts()
  } catch (e) { showToast("Error: " + e.message) }
}

async function loadPending() {
  try {
    const r = await api("/accounts/pending")
    const tbody = document.querySelector("#pendingTable tbody")
    const rows = r.accounts || []
    tbody.innerHTML = rows.length
      ? rows.map((a) => {
          const cidSafe = encodeURIComponent(a.id)
          return \`<tr>
            <td><code>\${a.id.slice(0, 18)}</code></td>
            <td>\${a.username ? \`<code>\${a.username}</code>\` : "—"}</td>
            <td>\${a.telegram ? "@" + String(a.telegram).replace(/^@/, "") : "—"}</td>
            <td>\${a.email || "—"}</td>
            <td>\${fmt(a.created_at)}</td>
            <td>
              <button onclick="approvePending('\${cidSafe}', 2)" title="Approve with 2-day trial">2d</button>
              <button onclick="approvePending('\${cidSafe}', 7)" title="Approve with 7-day trial">7d</button>
            </td>
            <td><button class="danger" onclick="rejectPending('\${cidSafe}')">Reject</button></td>
          </tr>\`
        }).join("")
      : '<tr><td colspan="7" class="empty">No pending accounts — everything is approved.</td></tr>'
  } catch (e) {
    console.error("loadPending", e)
  }
}

async function approvePending(cidEncoded, days) {
  try {
    const r = await api("/accounts/" + cidEncoded + "/approve?days=" + days, { method: "POST" })
    showToast("Approved with " + days + "d trial" + (r.was_already_approved ? " (was already approved)" : "") + ".")
    await Promise.all([loadPending(), loadAccounts()])
  } catch (e) { showToast("Error: " + e.message) }
}

async function rejectPending(cidEncoded) {
  const reason = prompt("Optional reason (shown to the user on Telegram):") || ""
  try {
    await api("/accounts/" + cidEncoded + "/reject", {
      method: "POST",
      body: JSON.stringify({ reason }),
    })
    showToast("Rejected.")
    await loadPending()
  } catch (e) { showToast("Error: " + e.message) }
}

async function refreshAll() { await Promise.all([loadStats(), loadAnalytics(), loadOrders(), loadLicenses(), loadPending(), loadAccounts(), loadAudit()]) }

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

document.getElementById("trialForm").addEventListener("submit", async (e) => {
  e.preventDefault()
  const data = Object.fromEntries(new FormData(e.target))
  data.days = Number(data.days)
  try {
    const r = await api("/trial-extend", { method: "POST", body: JSON.stringify(data) })
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

  // Classic username + password sign-up / sign-in. For users who don't want
  // to go through Telegram. Rate-limited the same way auth/start is.
  app.post("/auth/signup", async (c) => {
    const ip =
      c.req.header("CF-Connecting-IP") ??
      c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
      "unknown"
    const rl = checkRateLimit("auth-signup:" + ip, { max: 5 })
    if (!rl.ok) return c.json({ error: "rate_limited", retry_after: rl.retryAfterSeconds }, 429)
    let body: {
      username?: string
      password?: string
      telegram?: string
      email?: string
      device_label?: string
      referral_code?: string
    } = {}
    try {
      body = (await c.req.json()) ?? {}
    } catch {
      /* handled below */
    }
    if (!body.username || !body.password) return c.json({ error: "missing_credentials" }, 400)
    try {
      const r = signUpWithPassword({
        username: body.username,
        password: body.password,
        telegram: body.telegram ?? null,
        email: body.email ?? null,
        device_label: body.device_label ?? null,
        referral_code: body.referral_code ?? null,
      })
      // Kick an admin notification when this produced a fresh pending
      // customer — so the admin sees the signup and can approve right
      // from Telegram. Fire-and-forget, never block the response.
      if (r.status === "pending") {
        void notifyAdminNewPendingUser({
          customer_id: r.customer_id,
          username: body.username,
          telegram: body.telegram ?? null,
          telegram_user_id: null,
          email: body.email ?? null,
          method: "password",
          created_at: Math.floor(Date.now() / 1000),
        }).catch(() => undefined)
        return c.json(r, 202)
      }
      return c.json(r)
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error"
      const status: 400 | 409 = msg === "username_taken" ? 409 : 400
      return c.json({ error: msg }, status)
    }
  })

  app.post("/auth/signin", async (c) => {
    const ip =
      c.req.header("CF-Connecting-IP") ??
      c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
      "unknown"
    // A bit tighter than signup — brute-force protection. 5 per minute.
    const rl = checkRateLimit("auth-signin:" + ip, { max: 5 })
    if (!rl.ok) return c.json({ error: "rate_limited", retry_after: rl.retryAfterSeconds }, 429)
    let body: { username?: string; password?: string; device_label?: string } = {}
    try {
      body = (await c.req.json()) ?? {}
    } catch {
      /* handled below */
    }
    if (!body.username || !body.password) return c.json({ error: "missing_credentials" }, 400)
    try {
      const r = signInWithPassword({
        username: body.username,
        password: body.password,
        device_label: body.device_label ?? null,
      })
      if (r.status === "pending") {
        // Someone signed in with correct credentials but the admin
        // hasn't approved them yet. Handy HTTP status 202 = Accepted.
        return c.json(r, 202)
      }
      return c.json(r)
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error"
      const status: 401 | 403 =
        msg === "account_revoked" || msg === "account_rejected" ? 403 : 401
      return c.json({ error: msg }, status)
    }
  })

  /**
   * Polling endpoint the client hits from the "In attesa di approvazione"
   * screen. Returns the current approval state so it can transition to
   * "approved" (fire a sign-in) or "rejected" (show the error) without
   * needing new credentials each time.
   */
  app.get("/auth/status/:cid", (c) => {
    const cid = c.req.param("cid")
    if (!/^cus_[A-Za-z0-9_-]{4,32}$/.test(cid)) return c.json({ error: "invalid_customer_id" }, 400)
    const s = getApprovalStatus(cid)
    if (!s) return c.json({ error: "unknown_customer" }, 404)
    return c.json(s)
  })

  /**
   * Public order-status polling endpoint. Used by the desktop subscription
   * dialog to live-update the UI from "pending" → "payment received,
   * awaiting confirmations (X/Y)" → "confirmed, license issued" without
   * the user needing to refresh. No auth required because the order id
   * itself is the bearer token (250-bit entropy in `ord_<random>`).
   *
   * Returns the order row + the active payment offer's `seen_*` snapshot
   * so the UI can render exactly the same progress info as `/status` in
   * the bot. License token is INCLUDED only when status === "confirmed",
   * so polling is the canonical "did my payment land" flow.
   */
  app.get("/order/:id/status", (c) => {
    const id = c.req.param("id")
    if (!/^ord_[A-Za-z0-9_-]{4,40}$/.test(id)) return c.json({ error: "invalid_order_id" }, 400)
    const o = getOrder(id)
    if (!o) return c.json({ error: "unknown_order" }, 404)
    const offers = getOffersForOrder(id)
    const matched = offers.find((x) => x.matched_tx_hash != null)
    const seen = offers.find((x) => x.seen_tx_hash != null && x.matched_tx_hash == null)
    const wallet = matched
      ? getWallets().find((w) => w.currency === matched.currency)
      : seen
        ? getWallets().find((w) => w.currency === seen.currency)
        : null
    const required = wallet?.minConfirmations ?? null
    return c.json({
      id: o.id,
      status: o.status,
      interval: o.interval,
      created_at: o.created_at,
      confirmed_at: o.confirmed_at,
      tx_hash: o.tx_hash,
      license_id: o.license_id,
      payment: matched
        ? {
            stage: "confirmed" as const,
            currency: matched.currency,
            tx: matched.matched_tx_hash,
            confirmations: required,
            required,
          }
        : seen
          ? {
              stage: "seen" as const,
              currency: seen.currency,
              tx: seen.seen_tx_hash,
              confirmations: seen.seen_confirmations ?? 0,
              required,
            }
          : { stage: "awaiting_payment" as const },
    })
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
    if (body.role !== "admin" && body.role !== "member" && body.role !== "viewer") {
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

  app.post("/teams/:id/transfer-ownership", async (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const body = (await c.req.json().catch(() => ({}))) as { new_owner_customer_id?: string }
    if (!body.new_owner_customer_id) return c.json({ error: "missing_new_owner" }, 400)
    try {
      const team = transferOwnership(c.req.param("id"), sess.sub, body.new_owner_customer_id)
      return c.json({ team })
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

  // Cursor broadcast — intentionally stateless: we emit an event and do NOT
  // persist. The SSE stream fans it out; clients keep a local map keyed by
  // customer_id and fade the dot after N seconds of no update.
  app.post("/teams/:id/sessions/:sid/cursor", async (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const teamId = c.req.param("id")
    const sid = c.req.param("sid")
    if (!getMemberRole(teamId, sess.sub)) return c.json({ error: "forbidden" }, 403)
    // Cross-team leak guard: reject the publish if this session_id isn't
    // an active session of the given team. Without this, a buggy client
    // (or attacker) could spray cursor packets at any team's SSE channel
    // by passing a session id from a totally unrelated team — the server
    // would happily fan it out.
    const { isActiveSessionInTeam } = await import("../../license/teams")
    if (!isActiveSessionInTeam(teamId, sid)) {
      return c.json({ error: "session_not_in_team" }, 404)
    }
    const body = (await c.req.json().catch(() => ({}))) as { x?: number; y?: number; label?: string }
    const x = typeof body.x === "number" ? Math.max(0, Math.min(1, body.x)) : null
    const y = typeof body.y === "number" ? Math.max(0, Math.min(1, body.y)) : null
    if (x === null || y === null) return c.json({ error: "bad_coords" }, 400)
    const { emitTeamEvent } = await import("../../license/team-events")
    emitTeamEvent({
      type: "cursor_moved",
      team_id: teamId,
      session_id: sid,
      customer_id: sess.sub,
      x,
      y,
      label: typeof body.label === "string" ? body.label.slice(0, 32) : null,
    })
    return c.json({ ok: true })
  })

  // CRDT broadcast — thin passthrough: validate membership + session, then
  // re-emit the blob on the team SSE channel. Payload is never persisted.
  app.post("/teams/:id/sessions/:sid/crdt", async (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const teamId = c.req.param("id")
    const sid = c.req.param("sid")
    if (!getMemberRole(teamId, sess.sub)) return c.json({ error: "forbidden" }, 403)
    const { isActiveSessionInTeam } = await import("../../license/teams")
    if (!isActiveSessionInTeam(teamId, sid)) return c.json({ error: "session_not_in_team" }, 404)
    const body = (await c.req.json().catch(() => ({}))) as {
      type?: string
      doc_id?: string
      update_b64?: string
      awareness_b64?: string
    }
    if (typeof body.doc_id !== "string" || !body.doc_id) return c.json({ error: "missing_doc_id" }, 400)
    const { emitTeamEvent } = await import("../../license/team-events")
    if (body.type === "crdt.sync" && typeof body.update_b64 === "string") {
      emitTeamEvent({
        type: "crdt_sync",
        team_id: teamId,
        session_id: sid,
        doc_id: body.doc_id,
        update_b64: body.update_b64,
        from_customer_id: sess.sub,
      })
    } else if (body.type === "crdt.awareness" && typeof body.awareness_b64 === "string") {
      emitTeamEvent({
        type: "crdt_awareness",
        team_id: teamId,
        session_id: sid,
        doc_id: body.doc_id,
        awareness_b64: body.awareness_b64,
        from_customer_id: sess.sub,
      })
    } else {
      return c.json({ error: "unknown_crdt_type" }, 400)
    }
    return c.json({ ok: true })
  })

  // Read the current shared workspace state for a live session. Used by
  // guests when they decide to "follow" a host — they hydrate from this
  // before the next session_state event arrives.
  app.get("/teams/:id/sessions/:sid", (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const teamId = c.req.param("id")
    const sid = c.req.param("sid")
    const data = getSessionState(teamId, sid, sess.sub)
    if (!data) return c.json({ error: "not_found" }, 404)
    return c.json({ session_id: sid, ...data })
  })

  // ── Team invite links ──────────────────────────────────────────
  // Owner/admin generates a shareable token; recipient clicks the URL and
  // joins automatically with the role baked into the link (member|viewer).

  app.post("/teams/:id/invite-links", async (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const teamId = c.req.param("id")
    const body = (await c.req.json().catch(() => ({}))) as {
      role?: "member" | "viewer"
      ttl_ms?: number | null
      max_uses?: number | null
    }
    try {
      const link = createInviteLink({
        team_id: teamId,
        actor: sess.sub,
        role: body.role,
        ttl_ms: body.ttl_ms,
        max_uses: body.max_uses,
      })
      return c.json({ link })
    } catch (err) {
      const { status, body: b } = teamError(err)
      return c.json(b, status as 400 | 500)
    }
  })

  app.get("/teams/:id/invite-links", (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const teamId = c.req.param("id")
    return c.json({ links: listInviteLinks(teamId, sess.sub) })
  })

  app.delete("/teams/:id/invite-links/:token", (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const teamId = c.req.param("id")
    const token = c.req.param("token")
    try {
      revokeInviteLink(teamId, sess.sub, token)
      return c.json({ ok: true })
    } catch (err) {
      const { status, body: b } = teamError(err)
      return c.json(b, status as 400 | 500)
    }
  })

  // Public preview — no session required. Lets the redeem page render the
  // team name + member count before the user signs in.
  app.get("/invite-links/:token", (c) => {
    const token = c.req.param("token")
    const preview = previewInviteLink(token)
    if (!preview) return c.json({ error: "invalid_or_expired" }, 404)
    return c.json(preview)
  })

  // Redeem — requires authentication. Adds the calling customer to the team.
  app.post("/invite-links/:token/redeem", (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const token = c.req.param("token")
    try {
      const result = redeemInviteLink({ token, customer_id: sess.sub })
      return c.json(result)
    } catch (err) {
      const { status, body: b } = teamError(err)
      return c.json(b, status as 400 | 500)
    }
  })

  // ── Team agents (shared system-prompt templates) ───────────────
  // CRUD restricted to owner/admin (enforced inside teams.ts). Members
  // call GET to populate the @-autocomplete in chat / prompt input.

  app.get("/teams/:id/agents", (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const teamId = c.req.param("id")
    return c.json({ agents: listTeamAgents(teamId, sess.sub) })
  })

  app.post("/teams/:id/agents", async (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const teamId = c.req.param("id")
    const body = (await c.req.json().catch(() => ({}))) as {
      slug?: string
      display_name?: string
      system_prompt?: string
      model?: string | null
      description?: string | null
    }
    try {
      const agent = createTeamAgent({
        team_id: teamId,
        actor: sess.sub,
        slug: body.slug ?? "",
        display_name: body.display_name ?? "",
        system_prompt: body.system_prompt ?? "",
        model: body.model ?? null,
        description: body.description ?? null,
      })
      return c.json({ agent })
    } catch (err) {
      const { status, body: b } = teamError(err)
      return c.json(b, status as 400 | 500)
    }
  })

  app.patch("/teams/:id/agents/:aid", async (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const teamId = c.req.param("id")
    const aid = c.req.param("aid")
    const body = (await c.req.json().catch(() => ({}))) as {
      display_name?: string
      system_prompt?: string
      model?: string | null
      description?: string | null
    }
    try {
      const agent = updateTeamAgent({
        team_id: teamId,
        agent_id: aid,
        actor: sess.sub,
        display_name: body.display_name,
        system_prompt: body.system_prompt,
        model: body.model,
        description: body.description,
      })
      return c.json({ agent })
    } catch (err) {
      const { status, body: b } = teamError(err)
      return c.json(b, status as 400 | 500)
    }
  })

  app.delete("/teams/:id/agents/:aid", (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const teamId = c.req.param("id")
    const aid = c.req.param("aid")
    try {
      const ok = deleteTeamAgent({ team_id: teamId, agent_id: aid, actor: sess.sub })
      if (!ok) return c.json({ error: "agent_not_found" }, 404)
      return c.json({ ok: true })
    } catch (err) {
      const { status, body: b } = teamError(err)
      return c.json(b, status as 400 | 500)
    }
  })

  // ── Team chat: attachment upload ───────────────────────────────
  // Accepts a single image/PDF up to 10 MB and pushes it to the
  // configured S3-compatible bucket (R2 in production). Returns the
  // resulting public URL plus type/size/name so the renderer can attach
  // it to the next chat message via the existing /chat endpoint.
  //
  // Authenticated members only — the team membership check prevents the
  // bucket from doubling as a free public file host.
  app.post("/teams/:id/chat/upload", async (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const teamId = c.req.param("id")
    const role = getMemberRole(teamId, sess.sub)
    if (!role) return c.json({ error: "forbidden" }, 403)
    // Viewers are read-only — no posting, no uploads.
    if (role === "viewer") return c.json({ error: "forbidden" }, 403)

    if (!s3Config()) return c.json({ error: "uploads_not_configured" }, 503)

    const contentType = c.req.header("content-type") ?? ""
    const allowedTypes = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]
    if (!allowedTypes.includes(contentType)) {
      return c.json({ error: "invalid_type", allowed: allowedTypes }, 400)
    }
    const filenameHeader = c.req.header("x-attachment-name") ?? "file"
    const sanitizedName = filenameHeader.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200) || "file"

    const buf = await c.req.arrayBuffer()
    const size = buf.byteLength
    if (size <= 0) return c.json({ error: "empty" }, 400)
    if (size > 10 * 1024 * 1024) return c.json({ error: "too_large", max_bytes: 10 * 1024 * 1024 }, 413)

    const ext = (() => {
      switch (contentType) {
        case "image/png":
          return "png"
        case "image/jpeg":
          return "jpg"
        case "image/gif":
          return "gif"
        case "image/webp":
          return "webp"
        case "application/pdf":
          return "pdf"
        default:
          return "bin"
      }
    })()
    const key = `chat/${teamId}/${Date.now()}-${randomBytes(6).toString("hex")}.${ext}`

    try {
      const { url } = await s3Put(key, new Uint8Array(buf), contentType)
      return c.json({
        url,
        type: contentType,
        size,
        name: sanitizedName,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: "upload_failed", detail: msg.slice(0, 200) }, 502)
    }
  })

  // ── Team chat ──────────────────────────────────────────────────
  // Persistent chat: posts a message, prunes oldest beyond N=200 per team,
  // emits a `chat_message` SSE event so all subscribers see it instantly.
  app.post("/teams/:id/chat", async (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const teamId = c.req.param("id")
    if (!getMemberRole(teamId, sess.sub)) return c.json({ error: "forbidden" }, 403)
    const body = (await c.req.json().catch(() => ({}))) as {
      text?: string
      attachment?: { url: string; type: string; size: number; name: string } | null
    }
    const text = typeof body.text === "string" ? body.text : ""
    const attachment = (() => {
      if (!body.attachment) return null
      const a = body.attachment
      // Allow only images and PDF; cap at 10 MB. Invalid attachments are
      // dropped silently — the message still goes through with text only.
      const allowedTypes = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]
      if (typeof a.url !== "string" || !a.url.startsWith("https://")) return null
      if (typeof a.type !== "string" || !allowedTypes.includes(a.type)) return null
      if (typeof a.size !== "number" || a.size <= 0 || a.size > 10 * 1024 * 1024) return null
      if (typeof a.name !== "string") return null
      return { url: a.url, type: a.type, size: a.size, name: a.name.slice(0, 200) }
    })()
    if (!text.trim() && !attachment) return c.json({ error: "empty" }, 400)
    const display = getCustomerDisplay(sess.sub)
    const row = postChatMessage({ team_id: teamId, author: sess.sub, author_name: display, text, attachment })
    if (!row) return c.json({ error: "rejected" }, 400)
    return c.json({ message: row })
  })

  app.get("/teams/:id/chat", (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const teamId = c.req.param("id")
    if (!getMemberRole(teamId, sess.sub)) return c.json({ error: "forbidden" }, 403)
    const limit = Number(c.req.query("limit") ?? "50")
    const messages = listChatMessages(teamId, sess.sub, Number.isFinite(limit) ? limit : 50)
    return c.json({ messages })
  })

  // Lightweight typing indicator — emit-only, not persisted.
  app.post("/teams/:id/chat/typing", (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const teamId = c.req.param("id")
    if (!getMemberRole(teamId, sess.sub)) return c.json({ error: "forbidden" }, 403)
    const display = getCustomerDisplay(sess.sub)
    broadcastTyping({ team_id: teamId, author: sess.sub, author_name: display })
    return c.json({ ok: true })
  })

  // Read receipts — a member calls POST /chat/read with the message_id of
  // the latest message they've seen. Server upserts (high-water-mark, no
  // backwards) and broadcasts a chat_read SSE event so other members can
  // render "seen by N" markers.
  app.post("/teams/:id/chat/read", async (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const teamId = c.req.param("id")
    const body = (await c.req.json().catch(() => ({}))) as { message_id?: number }
    const id = Number(body.message_id)
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "bad_message_id" }, 400)
    const row = markChatRead({ team_id: teamId, customer_id: sess.sub, message_id: id })
    if (!row) return c.json({ error: "forbidden_or_not_found" }, 403)
    return c.json({ read: row })
  })

  // Bulk read state — clients hydrate the "seen by" markers on chat-panel
  // mount instead of waiting for each member's next chat_read event.
  app.get("/teams/:id/chat/reads", (c) => {
    const sess = sessionGuard(c as never)
    if (!sess) return c.json({ error: "unauthorized" }, 401)
    const teamId = c.req.param("id")
    if (!getMemberRole(teamId, sess.sub)) return c.json({ error: "forbidden" }, 403)
    return c.json({ reads: listChatReads(teamId, sess.sub) })
  })

  // SSE stream: live push of team events (sessions, member changes, renames).
  // POST so the renderer can attach the Bearer JWT in the Authorization
  // header (fetch + ReadableStream is the new transport — see
  // `packages/app/src/utils/sse-fetch.ts`). The legacy GET endpoint with
  // `?access_token=` was removed because it leaked tokens into server logs,
  // browser history and proxy referrer headers.
  app.post("/teams/:id/events-stream", async (c) => {
    const bearer = c.req.header("Authorization")?.replace(/^Bearer\s+/, "")
    if (!bearer) return c.json({ error: "unauthorized" }, 401)
    const verified = verifySessionToken(bearer)
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
    // Parse the body FIRST so we can inspect the token for rate-limit tiering.
    // An invalid / absent token falls into the FREE bucket (stingy limit to
    // discourage brute-force), a well-signed token (HMAC-valid) gets the PRO
    // bucket — we don't need to hit the DB here because HMAC alone proves
    // the caller is legitimate proof-of-purchase; expiry / revocation still
    // bite at validateBySig() below.
    let body: { token?: string; machine_id?: string } = {}
    try {
      body = await c.req.json()
    } catch {
      /* handled by the missing-token branch below */
    }

    const token = typeof body.token === "string" ? body.token : ""
    const hmacCheck = token ? verifyToken(token) : { ok: false, reason: "missing_token" }

    // Pick the tier before doing anything else so a flood of free-tier
    // traffic can't use up the Pro pool.
    const ip =
      c.req.header("CF-Connecting-IP") ??
      c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
      c.req.header("Fly-Client-IP") ??
      "unknown"
    const rl =
      hmacCheck.ok && hmacCheck.sig
        ? checkRateLimit("pro:" + hmacCheck.sig, { max: 60 })
        : checkRateLimit("free:" + ip, { max: 10 })
    if (!rl.ok) {
      return new Response(
        JSON.stringify({
          status: "rate_limited",
          retry_after: rl.retryAfterSeconds,
          tier: hmacCheck.ok ? "pro" : "free",
        }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": String(rl.retryAfterSeconds ?? 60),
          },
        },
      )
    }

    if (!token) return c.json({ status: "unknown", reason: "invalid_json" }, 400)
    if (!hmacCheck.ok || !hmacCheck.payload || !hmacCheck.sig) {
      return c.json({ status: "unknown", reason: hmacCheck.reason ?? "bad_token" }, 200)
    }
    const result = validateBySig({ token_sig: hmacCheck.sig, machine_id: body.machine_id ?? null })
    return c.json({
      ...result,
      interval: hmacCheck.payload.i,
      issued_at: hmacCheck.payload.t,
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

  admin.get("/accounts", (c) => c.json({ accounts: listPasswordAccounts(500) }))

  admin.post("/accounts/:customerId/revoke", (c) => {
    const ok = revokePasswordAccount(c.req.param("customerId"))
    if (!ok) return c.json({ error: "not_found_or_already_revoked" }, 404)
    return c.json({ ok: true })
  })

  // ─────────────────────── Approval queue ────────────────────────────
  // Customers that signed up or arrived via Telegram but haven't been
  // greenlit yet. Shown in the admin panel; clicked on from the bot
  // via callback_query for a one-tap approve/reject.

  admin.get("/accounts/pending", (c) => {
    return c.json({ accounts: listPendingCustomers(200) })
  })

  admin.post("/accounts/:customerId/approve", async (c) => {
    const customerId = c.req.param("customerId")
    const url = new URL(c.req.url)
    const daysParam = url.searchParams.get("days") ?? "2"
    const days = Number.parseInt(daysParam, 10)
    if (!Number.isFinite(days) || days <= 0 || days > 365) {
      return c.json({ error: "bad_days" }, 400)
    }
    const before = getApprovalStatus(customerId)
    if (!before) return c.json({ error: "not_found" }, 404)
    const r = approveCustomer(customerId, { trialDays: days, approvedBy: "admin-panel" })
    if (!r) return c.json({ error: "not_found" }, 404)
    // Fire-and-forget DM to the user; if they don't have a tg id it
    // just no-ops. The trial itself is driven client-side today (see
    // desktop-electron state.applyStartTrial), so here we just flip
    // the approval state — the client picks up the change via
    // /auth/status polling and either lets the user in or, on the
    // desktop, wires up the trial locally.
    void notifyUserApproved({
      telegram_user_id: r.telegram_user_id,
      trial_days: r.trial_days_total,
    }).catch(() => undefined)
    return c.json({
      ok: true,
      customer_id: customerId,
      trial_days: r.trial_days_total,
      trial_days_base: days,
      referral_bonus_days: r.referral_bonus_days,
      was_already_approved: r.was_already_approved,
    })
  })

  admin.post("/accounts/:customerId/reject", async (c) => {
    const customerId = c.req.param("customerId")
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string }
    const r = rejectCustomer(customerId, {
      reason: body.reason?.slice(0, 200) ?? null,
      rejectedBy: "admin-panel",
    })
    if (!r) return c.json({ error: "not_found" }, 404)
    void notifyUserRejected({
      telegram_user_id: r.telegram_user_id,
      reason: body.reason ?? null,
    }).catch(() => undefined)
    return c.json({ ok: true, customer_id: customerId })
  })

  admin.get("/analytics", (c) => c.json(analyticsSnapshot()))

  admin.post("/trial-extend", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      customer_telegram?: string
      days?: number
      note?: string
    }
    if (!body.customer_telegram) return c.json({ error: "missing_customer_telegram" }, 400)
    const days = Number(body.days)
    if (!Number.isFinite(days) || days <= 0 || days > 365) return c.json({ error: "bad_days" }, 400)
    try {
      const r = adminExtendTrial({
        customer_telegram: body.customer_telegram,
        days,
        note: body.note ?? null,
      })
      return c.json({
        token: r.token,
        license_id: r.license.id,
        customer_id: r.customer.id,
        expires_at: r.license.expires_at,
      })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

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
