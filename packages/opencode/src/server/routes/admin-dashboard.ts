/**
 * Production admin dashboard for CrimeCode — single-file SPA mounted at
 * /admin on the licensing API (Fly). Vanilla JS + inline CSS so deploy
 * stays one binary, no build step, no asset CDN.
 *
 * Step 1 covers: Overview · Revenue · Customers (list + detail) · Search.
 * Subsequent steps will add Crypoverse invoices, Teams, System health,
 * Bulk actions, Settings, Audit advanced, Communications, Real-time SSE
 * feed, and TOTP 2FA — all bolted onto the same SPA + router below.
 *
 * Auth: HTTP BasicAuth with ADMIN_PASSWORD (already used by /license/admin
 * — same env var so operators don't manage two passwords).
 *
 * Backwards compat: the old /license/admin path keeps responding but
 * 302-redirects to /admin so any bookmarks still work.
 */
import { Hono } from "hono"
import { basicAuth } from "hono/basic-auth"
import {
  analyticsSnapshot,
  cancelOrder,
  confirmOrderAndIssue,
  getCustomerDetail,
  listLicenses,
  listPendingOrders,
  revenueTimeseries,
  revokeLicense,
  searchEntities,
  statsCounts,
} from "../../license/store"
import {
  approveCustomer,
  listPasswordAccounts,
  listPendingCustomers,
  rejectCustomer,
  revokeSession,
} from "../../license/auth"

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>CrimeCode • Admin Console</title>
<link rel="icon" type="image/svg+xml" href='data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="%23ff5722"/><text x="16" y="22" text-anchor="middle" font-family="ui-monospace,monospace" font-size="14" font-weight="800" fill="%2307070a">CC</text></svg>' />
<style>
  :root { color-scheme: dark; --o: #ff5722; --bg: #07070a; --panel: #15151a; --border: rgba(255,255,255,0.08); --muted: #888; --text: #f5f5f5; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif; background: radial-gradient(ellipse at top, #1a0a0a 0%, #07070a 70%) fixed; color: var(--text); min-height: 100vh; }
  /* App shell */
  .app { display: grid; grid-template-columns: 220px 1fr; min-height: 100vh; }
  aside { background: rgba(10,10,14,0.85); border-right: 1px solid var(--border); padding: 16px 12px; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
  .brand { display: flex; align-items: center; gap: 10px; padding: 8px; margin-bottom: 18px; }
  .brand .logo { width: 32px; height: 32px; border-radius: 7px; background: linear-gradient(135deg, var(--o), #f4511e); display: flex; align-items: center; justify-content: center; font-family: ui-monospace,monospace; font-weight: 800; color: var(--bg); }
  .brand-name { font-weight: 800; font-size: 11px; letter-spacing: 0.22em; color: var(--o); }
  .brand-sub { font-size: 9px; color: var(--muted); letter-spacing: 0.04em; }
  nav a { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 8px; color: #ccc; text-decoration: none; font-weight: 500; font-size: 13px; transition: background 0.1s, color 0.1s; }
  nav a:hover { background: rgba(255,87,34,0.08); color: var(--o); }
  nav a.active { background: rgba(255,87,34,0.15); color: var(--o); }
  nav a .ic { width: 16px; text-align: center; }
  nav .sect { padding: 10px 12px 6px; font-size: 10px; color: var(--muted); letter-spacing: 0.1em; text-transform: uppercase; font-weight: 700; }
  nav .badge { margin-left: auto; background: var(--o); color: var(--bg); font-size: 10px; padding: 1px 6px; border-radius: 999px; font-weight: 800; }
  /* Top bar */
  header.topbar { position: sticky; top: 0; z-index: 10; background: rgba(15,15,20,0.92); backdrop-filter: blur(8px); border-bottom: 1px solid var(--border); padding: 12px 22px; display: flex; align-items: center; gap: 14px; }
  .search { flex: 1; max-width: 560px; position: relative; }
  .search input { width: 100%; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 9px 14px 9px 36px; border-radius: 9px; font: inherit; transition: border-color 0.15s; }
  .search input:focus { outline: none; border-color: var(--o); }
  .search::before { content: "🔍"; position: absolute; left: 12px; top: 50%; transform: translateY(-50%); opacity: 0.55; pointer-events: none; }
  .search-results { position: absolute; top: 44px; left: 0; right: 0; background: var(--panel); border: 1px solid var(--border); border-radius: 9px; max-height: 60vh; overflow-y: auto; box-shadow: 0 10px 30px rgba(0,0,0,0.5); z-index: 20; }
  .search-results .group { padding: 8px 12px 4px; font-size: 10px; color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; font-weight: 700; }
  .search-results a { display: flex; gap: 10px; padding: 8px 14px; color: var(--text); text-decoration: none; font-size: 12px; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.04); }
  .search-results a:hover { background: rgba(255,87,34,0.08); }
  .search-results .meta { color: var(--muted); font-size: 11px; }
  .top-actions { display: flex; gap: 8px; align-items: center; }
  .pill-env { font-size: 10px; padding: 3px 10px; border-radius: 999px; background: rgba(74,222,128,0.15); color: #4ade80; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
  /* Main */
  main { padding: 22px 28px 48px; max-width: 1280px; }
  h1.page { margin: 0 0 16px; font-size: 22px; font-weight: 700; }
  h2 { margin: 20px 0 10px; font-size: 12px; color: var(--o); text-transform: uppercase; letter-spacing: 0.1em; font-weight: 700; }
  .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 22px; }
  .kpi { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; transition: border-color 0.15s; }
  .kpi:hover { border-color: rgba(255,87,34,0.4); }
  .kpi .label { font-size: 10px; color: var(--muted); letter-spacing: 0.1em; text-transform: uppercase; font-weight: 600; margin-bottom: 6px; }
  .kpi .value { font-size: 26px; font-weight: 800; color: var(--text); line-height: 1; }
  .kpi .value .unit { font-size: 14px; color: var(--muted); margin-left: 4px; font-weight: 500; }
  .kpi .delta { font-size: 11px; margin-top: 6px; color: var(--muted); }
  .kpi .delta.up { color: #4ade80; }
  .kpi .delta.down { color: #f87171; }
  section.card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 18px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 9px 11px; border-bottom: 1px solid rgba(255,255,255,0.05); }
  th { color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; font-size: 10px; }
  tr.click { cursor: pointer; }
  tr.click:hover { background: rgba(255,87,34,0.04); }
  td.mono, .mono { font-family: ui-monospace, Menlo, Consolas, monospace; }
  .pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
  .pill.valid    { background: rgba(74,222,128,0.15); color: #4ade80; }
  .pill.revoked  { background: rgba(255,80,80,0.15); color: #f87171; }
  .pill.expired  { background: rgba(251,191,36,0.15); color: #fbbf24; }
  .pill.pending  { background: rgba(150,150,150,0.15); color: #aaa; }
  .pill.confirmed{ background: rgba(74,222,128,0.15); color: #4ade80; }
  .pill.cancelled{ background: rgba(255,80,80,0.15); color: #f87171; }
  .pill.approved { background: rgba(74,222,128,0.15); color: #4ade80; }
  .pill.rejected { background: rgba(255,80,80,0.15); color: #f87171; }
  button, .btn { background: linear-gradient(135deg, var(--o), #f4511e); color: white; border: none; padding: 7px 14px; border-radius: 7px; cursor: pointer; font: 600 12px/1 inherit; transition: transform 0.1s, box-shadow 0.15s; }
  button:hover, .btn:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(255,87,34,0.3); }
  button.ghost { background: transparent; border: 1px solid rgba(255,255,255,0.15); color: #ccc; box-shadow: none; }
  button.ghost:hover { border-color: var(--o); color: var(--o); }
  button.danger { background: linear-gradient(135deg, #d33b22, #aa2811); }
  .actions-row { display: flex; gap: 6px; }
  /* Chart */
  .chart-wrap { position: relative; height: 240px; margin-top: 10px; }
  canvas { width: 100%; height: 100%; display: block; }
  .chart-tip { position: absolute; pointer-events: none; background: var(--bg); border: 1px solid var(--o); border-radius: 6px; padding: 6px 10px; font-size: 11px; white-space: nowrap; transform: translate(-50%, -110%); }
  .chart-tip[hidden] { display: none; }
  .chart-legend { display: flex; gap: 16px; font-size: 11px; color: var(--muted); margin-top: 8px; }
  .legend-dot { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
  /* Customer detail */
  .detail-hero { display: flex; align-items: flex-start; gap: 18px; }
  .detail-hero .avatar { width: 64px; height: 64px; border-radius: 50%; background: linear-gradient(135deg, var(--o), #f4511e); display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: 800; color: var(--bg); flex-shrink: 0; }
  .detail-hero h1 { margin: 0 0 4px; font-size: 20px; }
  .detail-hero .sub { color: var(--muted); font-size: 12px; }
  .tabs { display: flex; gap: 4px; margin: 20px 0 0; border-bottom: 1px solid var(--border); }
  .tab { padding: 9px 16px; cursor: pointer; color: var(--muted); font-weight: 600; border-bottom: 2px solid transparent; transition: color 0.15s, border-color 0.15s; user-select: none; font-size: 12px; }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--o); border-bottom-color: var(--o); }
  .tabpanel { padding-top: 14px; }
  .tabpanel[hidden] { display: none; }
  /* Misc */
  .toast { position: fixed; bottom: 22px; right: 22px; background: var(--panel); border: 1px solid var(--o); border-radius: 8px; padding: 12px 16px; box-shadow: 0 6px 24px rgba(0,0,0,0.4); z-index: 100; max-width: 360px; font-size: 12px; }
  .toast[hidden] { display: none; }
  .toast.err { border-color: #f87171; }
  .empty { color: var(--muted); text-align: center; padding: 22px; font-size: 12px; }
  .hr { height: 1px; background: var(--border); margin: 16px 0; }
  a.link { color: var(--o); text-decoration: none; }
  a.link:hover { text-decoration: underline; }
  .crumb { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
  .crumb a { color: var(--muted); }
  .crumb a:hover { color: var(--o); }
  @media (max-width: 760px) {
    .app { grid-template-columns: 1fr; }
    aside { position: relative; height: auto; }
    main { padding: 18px; }
  }
</style>
</head>
<body>
<div class="app">
  <aside>
    <div class="brand">
      <div class="logo">CC</div>
      <div>
        <div class="brand-name">CRIMECODE</div>
        <div class="brand-sub">admin console</div>
      </div>
    </div>
    <nav id="nav">
      <div class="sect">Overview</div>
      <a href="#overview" data-route="overview"><span class="ic">📊</span>Dashboard</a>
      <a href="#revenue"  data-route="revenue"><span class="ic">💰</span>Revenue</a>
      <div class="sect">People</div>
      <a href="#customers" data-route="customers"><span class="ic">👤</span>Customers</a>
      <a href="#pending"   data-route="pending"><span class="ic">⏳</span>Pending approvals<span class="badge" id="nav-pending-count" hidden>0</span></a>
      <div class="sect">Money</div>
      <a href="#orders"   data-route="orders"><span class="ic">📦</span>Orders<span class="badge" id="nav-orders-count" hidden>0</span></a>
      <a href="#licenses" data-route="licenses"><span class="ic">🎟️</span>Licenses</a>
      <div class="sect">Coming soon</div>
      <a href="#teams"    data-route="teams"   style="opacity:0.55"><span class="ic">👥</span>Teams</a>
      <a href="#payments" data-route="payments" style="opacity:0.55"><span class="ic">💳</span>Payments</a>
      <a href="#health"   data-route="health"   style="opacity:0.55"><span class="ic">📡</span>Health</a>
      <a href="#audit"    data-route="audit"    style="opacity:0.55"><span class="ic">📋</span>Audit</a>
      <a href="#comms"    data-route="comms"    style="opacity:0.55"><span class="ic">📢</span>Communications</a>
      <a href="#settings" data-route="settings" style="opacity:0.55"><span class="ic">⚙️</span>Settings</a>
    </nav>
  </aside>
  <div>
    <header class="topbar">
      <div class="search">
        <input id="searchbox" placeholder="Search customers, orders, licenses, teams… (id, @handle, email, tx_hash)" autocomplete="off" />
        <div id="search-results" class="search-results" hidden></div>
      </div>
      <div class="top-actions">
        <span class="pill-env" title="Production">● PROD</span>
      </div>
    </header>
    <main id="view"></main>
  </div>
</div>
<div id="toast" class="toast" hidden></div>

<script>
"use strict";

// ── tiny helpers ──────────────────────────────────────────────────────
const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => Array.from(p.querySelectorAll(s));
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const fmtNum = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : "—");
const fmtUsd = (n) => (typeof n === "number" ? "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—");
const fmtTs  = (ts) => ts ? new Date(ts * 1000).toLocaleString("en-GB", { day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" }) : "—";
const fmtDate = (ts) => ts ? new Date(ts * 1000).toLocaleDateString("en-GB", { day:"2-digit", month:"short", year:"numeric" }) : "—";
const fmtRel = (ts) => {
  if (!ts) return "—";
  const sec = Math.floor(Date.now()/1000) - ts;
  if (sec < 60) return sec + "s ago";
  if (sec < 3600) return Math.floor(sec/60) + "m ago";
  if (sec < 86400) return Math.floor(sec/3600) + "h ago";
  return Math.floor(sec/86400) + "d ago";
};
function toast(msg, opts = {}) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (opts.err ? " err" : "");
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, opts.err ? 6000 : 3500);
}
async function api(path, opts = {}) {
  const res = await fetch("/admin/api" + path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = typeof body === "string" ? body : (body && body.error) || ("HTTP " + res.status);
    throw new Error(msg);
  }
  return body;
}

// ── routing (hash-based) ──────────────────────────────────────────────
const ROUTES = {
  overview:  renderOverview,
  revenue:   renderRevenue,
  customers: renderCustomersList,
  pending:   renderPendingApprovals,
  orders:    renderOrders,
  licenses:  renderLicenses,
  teams:     renderComingSoon("Teams"),
  payments:  renderComingSoon("Payments"),
  health:    renderComingSoon("System Health"),
  audit:     renderComingSoon("Audit log"),
  comms:     renderComingSoon("Communications"),
  settings:  renderComingSoon("Settings"),
};
function route() {
  const hash = (location.hash || "#overview").slice(1);
  const [name, ...args] = hash.split("/");
  $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === name));
  if (name === "customers" && args[0]) {
    return renderCustomerDetail(args[0]);
  }
  const fn = ROUTES[name] || ROUTES.overview;
  fn(args);
}
window.addEventListener("hashchange", route);

// ── Overview ──────────────────────────────────────────────────────────
async function renderOverview() {
  const view = $("#view");
  view.innerHTML = '<h1 class="page">Dashboard</h1><div class="kpi-grid" id="kpis"></div><section class="card"><h2>Revenue · last 30 days</h2><div class="chart-wrap"><canvas id="chart-overview"></canvas><div class="chart-tip" hidden></div></div><div class="chart-legend"><span><span class="legend-dot" style="background:#ff5722"></span>Revenue (USD)</span><span><span class="legend-dot" style="background:rgba(255,87,34,0.4)"></span>Orders</span></div></section>';
  try {
    const o = await api("/overview");
    refreshNavBadges(o);
    $("#kpis").innerHTML = [
      kpi("MRR", fmtUsd(o.analytics.mrr_usd), "monthly recurring"),
      kpi("Revenue 30d", fmtUsd(o.analytics.revenue_30d_usd), o.analytics.orders_30d + " orders"),
      kpi("Active licenses", fmtNum(o.analytics.licenses_active), o.analytics.licenses_expired + " expired · " + o.analytics.licenses_revoked + " revoked"),
      kpi("Customers", fmtNum(o.stats.customers), "total signups"),
      kpi("Pending orders", fmtNum(o.stats.orders_pending), "awaiting payment"),
      kpi("Conversion", o.analytics.conversion_rate_pct + "%", "confirmed / created"),
      kpi("Churn 30d", o.analytics.churn_30d_pct + "%", "lost vs active"),
      kpi("Revenue total", fmtUsd(o.analytics.revenue_total_usd), "all time"),
    ].join("");
    drawChart($("#chart-overview"), o.timeseries.slice(-30));
  } catch (err) {
    view.innerHTML += '<section class="card"><p class="empty">' + escapeHtml(err.message) + "</p></section>";
  }
}
const kpi = (label, value, delta) => '<div class="kpi"><div class="label">' + escapeHtml(label) + '</div><div class="value">' + value + '</div>' + (delta ? '<div class="delta">' + escapeHtml(delta) + "</div>" : "") + "</div>";

function refreshNavBadges(o) {
  const pCount = o && o.stats ? o.stats.orders_pending : 0;
  const pPending = o && o.counts ? o.counts.pending_approvals : 0;
  const ne = $("#nav-orders-count"); if (ne) { ne.textContent = pCount; ne.hidden = pCount === 0; }
  const np = $("#nav-pending-count"); if (np) { np.textContent = pPending; np.hidden = pPending === 0; }
}

// ── Revenue ───────────────────────────────────────────────────────────
async function renderRevenue() {
  const view = $("#view");
  view.innerHTML = '<h1 class="page">Revenue</h1>'
    + '<div class="kpi-grid" id="kpis"></div>'
    + '<section class="card"><h2>Revenue · last 90 days</h2><div style="margin-bottom:8px"><button class="ghost" data-days="7">7d</button> <button class="ghost" data-days="30">30d</button> <button class="ghost" data-days="90">90d</button> <button class="ghost" data-days="365">1y</button></div><div class="chart-wrap"><canvas id="chart-rev"></canvas><div class="chart-tip" hidden></div></div><div class="chart-legend"><span><span class="legend-dot" style="background:#ff5722"></span>Revenue (USD)</span><span><span class="legend-dot" style="background:rgba(255,87,34,0.4)"></span>Orders</span></div></section>';
  let data = null;
  try {
    const o = await api("/overview");
    refreshNavBadges(o);
    $("#kpis").innerHTML = [
      kpi("MRR", fmtUsd(o.analytics.mrr_usd)),
      kpi("Revenue 30d", fmtUsd(o.analytics.revenue_30d_usd)),
      kpi("Revenue 365d", fmtUsd(o.analytics.revenue_365d_usd)),
      kpi("Revenue total", fmtUsd(o.analytics.revenue_total_usd)),
      kpi("Conversion", o.analytics.conversion_rate_pct + "%"),
      kpi("Churn 30d", o.analytics.churn_30d_pct + "%"),
    ].join("");
    data = o.timeseries;
    drawChart($("#chart-rev"), data);
  } catch (err) { toast(err.message, { err: true }); }
  $$('button[data-days]').forEach((b) => b.addEventListener("click", async () => {
    const days = Number(b.dataset.days);
    try {
      const ts = await api("/timeseries?days=" + days);
      drawChart($("#chart-rev"), ts.points);
    } catch (e) { toast(e.message, { err: true }); }
  }));
}

// ── Customers list ────────────────────────────────────────────────────
async function renderCustomersList() {
  const view = $("#view");
  view.innerHTML = '<h1 class="page">Customers</h1>'
    + '<section class="card"><table id="t"><thead><tr><th>ID</th><th>Telegram</th><th>Email</th><th>Status</th><th>Signed up</th></tr></thead><tbody><tr><td colspan="5" class="empty">Loading…</td></tr></tbody></table></section>';
  try {
    const res = await api("/customers?limit=100");
    const tbody = $("#t tbody");
    if (!res.customers.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty">No customers yet.</td></tr>'; return; }
    tbody.innerHTML = res.customers.map((c) => '<tr class="click" onclick="location.hash=\'customers/' + escapeHtml(c.id) + "'\">"
      + '<td class="mono">' + escapeHtml(c.id) + "</td>"
      + "<td>" + (c.telegram ? "@" + escapeHtml(c.telegram.replace(/^@/, "")) : '<span style="color:#666">—</span>') + "</td>"
      + "<td>" + (c.email ? escapeHtml(c.email) : '<span style="color:#666">—</span>') + "</td>"
      + '<td><span class="pill ' + escapeHtml(c.approval_status) + '">' + escapeHtml(c.approval_status) + "</span></td>"
      + "<td>" + escapeHtml(fmtDate(c.created_at)) + "</td>"
      + "</tr>").join("");
  } catch (err) { toast(err.message, { err: true }); }
}

// ── Customer detail ───────────────────────────────────────────────────
async function renderCustomerDetail(id) {
  const view = $("#view");
  view.innerHTML = '<div class="crumb"><a href="#customers" class="link">← Customers</a></div><section class="card"><p class="empty">Loading…</p></section>';
  try {
    const d = await api("/customers/" + encodeURIComponent(id));
    const initial = (d.customer.telegram || d.customer.email || d.customer.id).replace(/^@/, "").charAt(0).toUpperCase();
    view.innerHTML =
        '<div class="crumb"><a href="#customers" class="link">← Customers</a></div>'
      + '<section class="card"><div class="detail-hero">'
      + '<div class="avatar">' + escapeHtml(initial) + "</div>"
      + '<div style="flex:1">'
      +   "<h1>" + (d.customer.telegram ? "@" + escapeHtml(d.customer.telegram.replace(/^@/, "")) : escapeHtml(d.customer.email || d.customer.id)) + "</h1>"
      +   '<div class="sub">' + escapeHtml(d.customer.id) + " · signed up " + escapeHtml(fmtDate(d.customer.created_at)) + ' · <span class="pill ' + escapeHtml(d.customer.approval_status) + '">' + escapeHtml(d.customer.approval_status) + "</span></div>"
      +   '<div class="sub" style="margin-top:8px">Lifetime spend: <strong>' + fmtUsd(d.spend_total_usd) + "</strong> · "
      +     d.orders.length + " orders · " + d.licenses.length + " licenses · " + d.sessions.length + " sessions · " + d.team_memberships.length + " teams"
      +   "</div>"
      + "</div></div>"
      + '<div class="tabs">'
      + '<div class="tab active" data-tab="orders">Orders (' + d.orders.length + ")</div>"
      + '<div class="tab" data-tab="licenses">Licenses (' + d.licenses.length + ")</div>"
      + '<div class="tab" data-tab="sessions">Sessions (' + d.sessions.length + ")</div>"
      + '<div class="tab" data-tab="teams">Teams (' + d.team_memberships.length + ")</div>"
      + '<div class="tab" data-tab="audit">Audit (' + d.audit.length + ")</div>"
      + "</div>"
      + '<div class="tabpanel" data-panel="orders">'   + renderOrdersTable(d.orders, { showActions: true }) + "</div>"
      + '<div class="tabpanel" data-panel="licenses" hidden>' + renderLicensesTable(d.licenses, { showActions: true }) + "</div>"
      + '<div class="tabpanel" data-panel="sessions" hidden>' + renderSessionsTable(d.sessions) + "</div>"
      + '<div class="tabpanel" data-panel="teams" hidden>'    + renderTeamsTable(d.team_memberships) + "</div>"
      + '<div class="tabpanel" data-panel="audit" hidden>'    + renderAuditTable(d.audit) + "</div>"
      + "</section>";
    $$(".tab").forEach((t) => t.addEventListener("click", () => {
      $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
      $$(".tabpanel").forEach((p) => { p.hidden = p.dataset.panel !== t.dataset.tab; });
    }));
    bindOrderActions();
    bindLicenseActions();
    bindSessionActions();
  } catch (err) { view.innerHTML = '<section class="card"><p class="empty">' + escapeHtml(err.message) + "</p></section>"; }
}

function renderOrdersTable(orders, opts) {
  if (!orders.length) return '<p class="empty">No orders.</p>';
  return '<table><thead><tr><th>ID</th><th>Plan</th><th>Status</th><th>Created</th><th>Confirmed</th><th>Tx</th>' + (opts && opts.showActions ? "<th></th>" : "") + "</tr></thead><tbody>"
    + orders.map((o) =>
        '<tr><td class="mono">' + escapeHtml(o.id) + "</td>"
        + "<td>" + escapeHtml(o.interval) + "</td>"
        + '<td><span class="pill ' + escapeHtml(o.status) + '">' + escapeHtml(o.status) + "</span></td>"
        + "<td>" + escapeHtml(fmtTs(o.created_at)) + "</td>"
        + "<td>" + escapeHtml(fmtTs(o.confirmed_at)) + "</td>"
        + '<td class="mono" style="font-size:11px">' + (o.tx_hash ? escapeHtml(o.tx_hash.slice(0,12)) + "…" : "—") + "</td>"
        + (opts && opts.showActions && o.status === "pending"
            ? '<td class="actions-row"><button class="ghost" data-confirm="' + escapeHtml(o.id) + '">Confirm</button> <button class="danger" data-cancel="' + escapeHtml(o.id) + '">Cancel</button></td>'
            : (opts && opts.showActions ? "<td></td>" : "")) + "</tr>",
      ).join("")
    + "</tbody></table>";
}

function renderLicensesTable(licenses, opts) {
  if (!licenses.length) return '<p class="empty">No licenses.</p>';
  return '<table><thead><tr><th>ID</th><th>Plan</th><th>Status</th><th>Issued</th><th>Expires</th>' + (opts && opts.showActions ? "<th></th>" : "") + "</tr></thead><tbody>"
    + licenses.map((l) => {
        const nowSec = Math.floor(Date.now()/1000);
        const status = l.revoked_at ? "revoked" : (l.expires_at && l.expires_at <= nowSec ? "expired" : "valid");
        return '<tr><td class="mono">' + escapeHtml(l.id) + "</td>"
          + "<td>" + escapeHtml(l.interval) + "</td>"
          + '<td><span class="pill ' + status + '">' + status + "</span></td>"
          + "<td>" + escapeHtml(fmtDate(l.issued_at)) + "</td>"
          + "<td>" + (l.expires_at ? escapeHtml(fmtDate(l.expires_at)) : '<span style="color:#666">never</span>') + "</td>"
          + (opts && opts.showActions && status === "valid"
              ? '<td><button class="danger" data-revoke="' + escapeHtml(l.id) + '">Revoke</button></td>'
              : (opts && opts.showActions ? "<td></td>" : "")) + "</tr>";
      }).join("")
    + "</tbody></table>";
}

function renderSessionsTable(sessions) {
  if (!sessions.length) return '<p class="empty">No active sessions.</p>';
  return '<table><thead><tr><th>Device</th><th>Created</th><th>Last seen</th><th>Status</th><th></th></tr></thead><tbody>'
    + sessions.map((s) =>
        '<tr><td>' + escapeHtml(s.device_label || "unknown") + "</td>"
        + "<td>" + escapeHtml(fmtTs(s.created_at)) + "</td>"
        + "<td>" + escapeHtml(fmtRel(s.last_seen_at)) + "</td>"
        + "<td>" + (s.revoked_at ? '<span class="pill revoked">revoked</span>' : '<span class="pill valid">active</span>') + "</td>"
        + "<td>" + (s.revoked_at ? "" : '<button class="ghost" data-session-revoke="' + escapeHtml(s.id) + '">Revoke</button>') + "</td>"
        + "</tr>").join("")
    + "</tbody></table>";
}

function renderTeamsTable(memberships) {
  if (!memberships.length) return '<p class="empty">Not a member of any team.</p>';
  return '<table><thead><tr><th>Team</th><th>Role</th><th>Joined</th></tr></thead><tbody>'
    + memberships.map((m) =>
        '<tr><td>' + escapeHtml(m.team_name) + ' <span style="color:#666;font-size:11px" class="mono">' + escapeHtml(m.team_id) + "</span></td>"
        + "<td>" + escapeHtml(m.role) + "</td>"
        + "<td>" + escapeHtml(fmtDate(m.added_at)) + "</td>"
        + "</tr>").join("")
    + "</tbody></table>";
}

function renderAuditTable(audit) {
  if (!audit.length) return '<p class="empty">No audit events.</p>';
  return '<table><thead><tr><th>Time</th><th>Action</th><th>Details</th></tr></thead><tbody>'
    + audit.map((a) =>
        '<tr><td>' + escapeHtml(fmtTs(a.ts)) + "</td>"
        + '<td class="mono">' + escapeHtml(a.action) + "</td>"
        + '<td class="mono" style="font-size:11px;word-break:break-all">' + escapeHtml((a.details || "").slice(0, 200)) + "</td>"
        + "</tr>").join("")
    + "</tbody></table>";
}

// ── Orders (top-level page) ──────────────────────────────────────────
async function renderOrders() {
  const view = $("#view");
  view.innerHTML = '<h1 class="page">Pending orders</h1><section class="card" id="orders-card"><p class="empty">Loading…</p></section>';
  try {
    const orders = await api("/orders/pending");
    $("#orders-card").innerHTML = renderOrdersTable(orders, { showActions: true });
    bindOrderActions();
  } catch (err) { toast(err.message, { err: true }); }
}

async function renderLicenses() {
  const view = $("#view");
  view.innerHTML = '<h1 class="page">Licenses</h1><section class="card" id="lic-card"><p class="empty">Loading…</p></section>';
  try {
    const licenses = await api("/licenses?limit=200");
    $("#lic-card").innerHTML = renderLicensesTable(licenses, { showActions: true });
    bindLicenseActions();
  } catch (err) { toast(err.message, { err: true }); }
}

async function renderPendingApprovals() {
  const view = $("#view");
  view.innerHTML = '<h1 class="page">Pending approvals</h1><section class="card" id="pa-card"><p class="empty">Loading…</p></section>';
  try {
    const list = await api("/customers/pending");
    if (!list.length) { $("#pa-card").innerHTML = '<p class="empty">No pending approvals.</p>'; return; }
    $("#pa-card").innerHTML = '<table><thead><tr><th>Customer</th><th>Telegram</th><th>Email</th><th>Method</th><th>Registered</th><th></th></tr></thead><tbody>'
      + list.map((c) =>
          '<tr><td class="mono">' + escapeHtml(c.id) + "</td>"
          + "<td>" + (c.telegram ? "@" + escapeHtml(c.telegram.replace(/^@/, "")) : "—") + "</td>"
          + "<td>" + escapeHtml(c.email || "—") + "</td>"
          + "<td>" + escapeHtml(c.method || "—") + "</td>"
          + "<td>" + escapeHtml(fmtTs(c.created_at)) + "</td>"
          + '<td class="actions-row"><button data-approve="' + escapeHtml(c.id) + '" data-days="2">Approve 2d</button>'
          +   '<button data-approve="' + escapeHtml(c.id) + '" data-days="7">Approve 7d</button>'
          +   '<button class="danger" data-reject="' + escapeHtml(c.id) + '">Reject</button></td>'
          + "</tr>").join("")
      + "</tbody></table>";
    $$('button[data-approve]').forEach((b) => b.addEventListener("click", async () => {
      try {
        await api("/customers/" + b.dataset.approve + "/approve", { method: "POST", body: JSON.stringify({ trial_days: Number(b.dataset.days) }) });
        toast("Approved with " + b.dataset.days + " day trial");
        renderPendingApprovals();
      } catch (e) { toast(e.message, { err: true }); }
    }));
    $$('button[data-reject]').forEach((b) => b.addEventListener("click", async () => {
      try { await api("/customers/" + b.dataset.reject + "/reject", { method: "POST", body: "{}" }); toast("Rejected"); renderPendingApprovals(); } catch (e) { toast(e.message, { err: true }); }
    }));
  } catch (err) { toast(err.message, { err: true }); }
}

function renderComingSoon(name) { return function () { $("#view").innerHTML = '<h1 class="page">' + escapeHtml(name) + '</h1><section class="card"><p class="empty">Coming in the next iteration of the dashboard.</p></section>'; }; }

// ── action bindings (delegated) ──────────────────────────────────────
function bindOrderActions() {
  $$('button[data-confirm]').forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Confirm order " + b.dataset.confirm + "?")) return;
    try { await api("/orders/" + b.dataset.confirm + "/confirm", { method: "POST", body: "{}" }); toast("Order confirmed"); route(); } catch (e) { toast(e.message, { err: true }); }
  }));
  $$('button[data-cancel]').forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Cancel order " + b.dataset.cancel + "?")) return;
    try { await api("/orders/" + b.dataset.cancel + "/cancel", { method: "POST", body: "{}" }); toast("Order cancelled"); route(); } catch (e) { toast(e.message, { err: true }); }
  }));
}
function bindLicenseActions() {
  $$('button[data-revoke]').forEach((b) => b.addEventListener("click", async () => {
    const reason = prompt("Reason for revoking " + b.dataset.revoke + "?", "manual revocation");
    if (reason === null) return;
    try { await api("/licenses/" + b.dataset.revoke + "/revoke", { method: "POST", body: JSON.stringify({ reason }) }); toast("License revoked"); route(); } catch (e) { toast(e.message, { err: true }); }
  }));
}
function bindSessionActions() {
  $$('button[data-session-revoke]').forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Revoke this device session?")) return;
    try { await api("/sessions/" + b.dataset.sessionRevoke + "/revoke", { method: "POST", body: "{}" }); toast("Session revoked"); route(); } catch (e) { toast(e.message, { err: true }); }
  }));
}

// ── Search (global, debounced) ───────────────────────────────────────
let searchT = null;
const sb = $("#searchbox"), sr = $("#search-results");
sb.addEventListener("input", () => {
  clearTimeout(searchT);
  const q = sb.value.trim();
  if (q.length < 2) { sr.hidden = true; sr.innerHTML = ""; return; }
  searchT = setTimeout(async () => {
    try {
      const r = await api("/search?q=" + encodeURIComponent(q));
      const sections = [];
      if (r.customers.length) sections.push('<div class="group">Customers</div>' + r.customers.map((c) => '<a href="#customers/' + escapeHtml(c.id) + '"><strong>' + (c.telegram ? "@" + escapeHtml(c.telegram.replace(/^@/, "")) : escapeHtml(c.email || c.id)) + '</strong> <span class="meta">' + escapeHtml(c.id) + " · " + escapeHtml(c.approval_status) + "</span></a>").join(""));
      if (r.orders.length) sections.push('<div class="group">Orders</div>' + r.orders.map((o) => '<a href="#orders"><strong class="mono">' + escapeHtml(o.id) + '</strong> <span class="meta">' + escapeHtml(o.interval) + " · " + escapeHtml(o.status) + (o.customer_telegram ? " · " + escapeHtml(o.customer_telegram) : "") + "</span></a>").join(""));
      if (r.licenses.length) sections.push('<div class="group">Licenses</div>' + r.licenses.map((l) => '<a href="#customers/' + escapeHtml(l.customer_id) + '"><strong class="mono">' + escapeHtml(l.id) + '</strong> <span class="meta">' + escapeHtml(l.interval) + (l.revoked_at ? " · revoked" : "") + "</span></a>").join(""));
      if (r.teams.length) sections.push('<div class="group">Teams</div>' + r.teams.map((t) => '<a href="#teams"><strong>' + escapeHtml(t.name) + '</strong> <span class="meta">' + escapeHtml(t.id) + "</span></a>").join(""));
      sr.innerHTML = sections.length ? sections.join("") : '<div class="group">No matches</div>';
      sr.hidden = false;
    } catch (e) { sr.hidden = true; }
  }, 200);
});
document.addEventListener("click", (e) => {
  if (!sr.contains(e.target) && e.target !== sb) sr.hidden = true;
});
sb.addEventListener("focus", () => { if (sr.innerHTML) sr.hidden = false; });

// ── Mini chart (canvas, no deps) ─────────────────────────────────────
function drawChart(canvas, points) {
  if (!canvas || !points || points.length === 0) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height, padL = 36, padR = 12, padT = 12, padB = 22;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const revMax = Math.max(...points.map((p) => p.revenue_usd), 1);
  const ordMax = Math.max(...points.map((p) => p.orders), 1);
  // grid + y labels
  ctx.fillStyle = "#888"; ctx.font = "10px ui-monospace,monospace"; ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const y = padT + (innerH * i) / 4;
    ctx.strokeStyle = "rgba(255,255,255,0.05)"; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + innerW, y); ctx.stroke();
    const v = Math.round(revMax * (1 - i / 4));
    ctx.fillText("$" + v, padL - 4, y + 3);
  }
  // bars: orders
  ctx.fillStyle = "rgba(255,87,34,0.35)";
  const barW = Math.max(1, innerW / points.length - 2);
  points.forEach((p, i) => {
    const x = padL + (innerW * i) / points.length + 1;
    const h = (p.orders / ordMax) * innerH;
    ctx.fillRect(x, padT + innerH - h, barW, h);
  });
  // line: revenue
  ctx.strokeStyle = "#ff5722"; ctx.lineWidth = 2; ctx.beginPath();
  points.forEach((p, i) => {
    const x = padL + (innerW * i) / Math.max(1, points.length - 1);
    const y = padT + innerH - (p.revenue_usd / revMax) * innerH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  // dots
  ctx.fillStyle = "#ff5722";
  points.forEach((p, i) => {
    const x = padL + (innerW * i) / Math.max(1, points.length - 1);
    const y = padT + innerH - (p.revenue_usd / revMax) * innerH;
    ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
  });
  // x ticks (first / mid / last)
  ctx.fillStyle = "#888"; ctx.textAlign = "center";
  [0, Math.floor(points.length / 2), points.length - 1].forEach((i) => {
    if (points[i]) {
      const x = padL + (innerW * i) / Math.max(1, points.length - 1);
      ctx.fillText(points[i].day.slice(5), x, H - 6);
    }
  });
  // tooltip hover
  const tip = canvas.parentElement.querySelector(".chart-tip");
  canvas.onmousemove = (e) => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const idx = Math.round(((mx - padL) / innerW) * Math.max(1, points.length - 1));
    if (idx < 0 || idx >= points.length) { tip.hidden = true; return; }
    const p = points[idx];
    tip.innerHTML = "<strong>" + p.day + "</strong><br>" + fmtUsd(p.revenue_usd) + " · " + p.orders + " orders";
    tip.style.left = (padL + (innerW * idx) / Math.max(1, points.length - 1)) + "px";
    tip.style.top = (padT + innerH - (p.revenue_usd / revMax) * innerH) + "px";
    tip.hidden = false;
  };
  canvas.onmouseleave = () => { tip.hidden = true; };
}

// Boot
route();
// Refresh nav badges periodically (cheap query)
setInterval(async () => { try { const o = await api("/overview"); refreshNavBadges(o); } catch (e) {} }, 60_000);
</script>
</body>
</html>`

/**
 * Build the admin dashboard router. Pulls in the existing license-store
 * helpers + the new ones added for Step 1 (revenueTimeseries, getCustomerDetail,
 * searchEntities).
 */
export function adminDashboardRouter(): Hono {
  const r = new Hono()
  const password = process.env.ADMIN_PASSWORD ?? ""
  // Hard gate so we don't silently expose admin endpoints with no auth
  // if the env var is missing.
  r.use("*", async (c, next) => {
    if (!password) {
      return c.json(
        {
          error: "admin_disabled",
          message: "Set ADMIN_PASSWORD on the API server to enable /admin.",
        },
        503,
      )
    }
    await next()
  })
  r.use("*", basicAuth({ username: "admin", password }))

  // SPA shell — single file, no build step.
  r.get("/", (c) => c.html(DASHBOARD_HTML))

  // ── JSON API ────────────────────────────────────────────────────
  r.get("/api/overview", (c) => {
    const stats = statsCounts()
    const analytics = analyticsSnapshot()
    const pending = listPendingCustomers(0)
    const timeseries = revenueTimeseries(30)
    return c.json({
      stats,
      analytics,
      timeseries,
      counts: {
        pending_approvals: pending.length,
      },
    })
  })

  r.get("/api/timeseries", (c) => {
    const days = Math.max(1, Math.min(365, Number.parseInt(c.req.query("days") ?? "30", 10) || 30))
    return c.json({ days, points: revenueTimeseries(days) })
  })

  r.get("/api/customers", (c) => {
    const limit = Math.max(1, Math.min(500, Number.parseInt(c.req.query("limit") ?? "100", 10) || 100))
    // Reuse listLicenses' underlying join shape — for the v1 we expose all
    // customers in the password-accounts table + the recent telegram ones
    // via getDb. Simpler: just paginate raw customers.
    const { getDb } = require("../../license/db") as typeof import("../../license/db")
    const rows = getDb()
      .prepare<{ id: string; telegram: string | null; email: string | null; approval_status: string; created_at: number }, [number]>(
        "SELECT id, telegram, email, approval_status, created_at FROM customers ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit)
    return c.json({ customers: rows, count: rows.length })
  })

  r.get("/api/customers/pending", (c) => c.json(listPendingCustomers(200)))

  r.get("/api/customers/:id", (c) => {
    const id = c.req.param("id")
    const d = getCustomerDetail(id)
    if (!d) return c.json({ error: "not_found" }, 404)
    return c.json(d)
  })

  r.post("/api/customers/:id/approve", async (c) => {
    const id = c.req.param("id")
    const body = (await c.req.json().catch(() => ({}))) as { trial_days?: number }
    const days = Math.max(1, Math.min(365, Number(body.trial_days ?? 7)))
    const result = approveCustomer(id, { trialDays: days, approvedBy: "admin-panel" })
    if (!result) return c.json({ error: "customer_not_found" }, 404)
    return c.json({ ok: true, ...result, trial_days: days })
  })

  r.post("/api/customers/:id/reject", async (c) => {
    const id = c.req.param("id")
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string }
    const result = rejectCustomer(id, { rejectedBy: "admin-panel", reason: body.reason ?? null })
    if (!result) return c.json({ error: "customer_not_found" }, 404)
    return c.json({ ok: true, ...result })
  })

  r.get("/api/orders/pending", (c) => c.json(listPendingOrders(200)))

  r.post("/api/orders/:id/confirm", async (c) => {
    const id = c.req.param("id")
    const body = (await c.req.json().catch(() => ({}))) as { tx_hash?: string }
    const result = confirmOrderAndIssue({ order_id: id, tx_hash: body.tx_hash ?? null })
    if ("error" in result) return c.json(result, 400)
    return c.json({ ok: true, license_id: result.license.id, token: result.token })
  })

  r.post("/api/orders/:id/cancel", (c) => {
    const id = c.req.param("id")
    const r2 = cancelOrder(id)
    if (!r2) return c.json({ error: "not_pending_or_not_found" }, 400)
    return c.json({ ok: true, order: r2 })
  })

  r.get("/api/licenses", (c) => {
    const limit = Math.max(1, Math.min(500, Number.parseInt(c.req.query("limit") ?? "200", 10) || 200))
    return c.json(listLicenses(limit))
  })

  r.post("/api/licenses/:id/revoke", async (c) => {
    const id = c.req.param("id")
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string }
    const result = revokeLicense(id, body.reason ?? null)
    if (!result) return c.json({ error: "license_not_found" }, 404)
    return c.json({ ok: true, ...result })
  })

  r.post("/api/sessions/:id/revoke", (c) => {
    const id = c.req.param("id")
    revokeSession(id)
    return c.json({ ok: true })
  })

  r.get("/api/accounts", (c) => c.json({ accounts: listPasswordAccounts(500) }))

  r.get("/api/search", (c) => {
    const q = c.req.query("q") ?? ""
    return c.json(searchEntities(q))
  })

  return r
}
