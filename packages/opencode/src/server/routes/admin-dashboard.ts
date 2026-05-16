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
  audtCsvExport,
  bulkCancelOrders,
  bulkRevokeLicenses,
  cancelOrder,
  confirmOrderAndIssue,
  getCustomerDetail,
  listAppSettings,
  listAuditAdvanced,
  listLicenses,
  listPendingOrders,
  revenueTimeseries,
  revokeLicense,
  searchEntities,
  setAppSetting,
  statsCounts,
} from "../../license/store"
import {
  approveCustomer,
  listPasswordAccounts,
  listPendingCustomers,
  rejectCustomer,
  revokeSession,
} from "../../license/auth"
import {
  getCrypoverseStats,
  getInvoiceByTransactionId as getCrypoverseInvoice,
  listInvoicesForAdmin,
  retryListener as crypoverseRetryListener,
} from "../../license/crypoverse"
import {
  getTeamDetailForAdmin,
  listAllTeamsForAdmin,
  transferOwnershipAsAdmin,
} from "../../license/teams"
import { getSystemHealth } from "../../license/health"
import {
  listBroadcasts,
  listSegmentSizes,
  sendBroadcast,
  type BroadcastSegment,
} from "../../license/admin-broadcasts"
import {
  emitAdminEvent,
  getRecentEvents,
  subscribeAdminEvents,
} from "../../license/admin-event-bus"
import { getDb } from "../../license/db"
import {
  disable2fa,
  enable2fa,
  generateTotpSecret,
  getEnabledSecret,
  is2faEnabled,
  otpauthUrl,
  verifyTotpCode,
} from "../../license/admin-2fa"
import {
  getPaymentConfig,
  getSettlementHistory,
  getWalletsWithBalance,
} from "../../license/payments-admin"

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>CrimeCode &#x2022; Admin Console</title>
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
  .search::before { content: "&#x1F50D;"; position: absolute; left: 12px; top: 50%; transform: translateY(-50%); opacity: 0.55; pointer-events: none; }
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
  /* Bulk action bar &#x2014; slides in from bottom when at least one row selected. */
  #bulkbar { position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%); background: var(--panel); border: 1px solid var(--o); border-radius: 10px; padding: 10px 16px; box-shadow: 0 6px 24px rgba(0,0,0,0.5); display: flex; align-items: center; gap: 14px; z-index: 90; min-width: 320px; }
  #bulkbar[hidden] { display: none; }
  #bulkbar .count { font-weight: 700; color: var(--o); }
  #bulkbar .sep { color: var(--muted); }
  /* Settings */
  .setting-row { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
  .setting-row:last-child { border-bottom: 0; }
  .setting-meta { flex: 1; }
  .setting-meta .k { font-weight: 700; font-size: 13px; }
  .setting-meta .desc { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .setting-meta .ts { color: var(--muted); font-size: 11px; margin-top: 4px; }
  .setting-value { min-width: 260px; }
  .setting-value input[type=text], .setting-value input[type=number] { width: 100%; padding: 8px 12px; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 7px; font: inherit; }
  .setting-value .toggle { width: 44px; height: 24px; background: #2a2a2f; border-radius: 999px; position: relative; cursor: pointer; transition: background 0.15s; }
  .setting-value .toggle.on { background: var(--o); }
  .setting-value .toggle::after { content: ""; position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #fff; transition: transform 0.15s; }
  .setting-value .toggle.on::after { transform: translateX(20px); }
  /* Audit */
  .filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 14px; }
  .filters input { background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 8px 12px; border-radius: 7px; font: inherit; }
  details.audit-row summary { cursor: pointer; padding: 8px 0; list-style: none; }
  details.audit-row summary::-webkit-details-marker { display: none; }
  details.audit-row pre { background: var(--bg); border: 1px solid var(--border); border-radius: 7px; padding: 10px; font-size: 11px; overflow: auto; max-height: 320px; }
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
      <a href="#overview" data-route="overview"><span class="ic">&#x1F4CA;</span>Dashboard</a>
      <a href="#revenue"  data-route="revenue"><span class="ic">&#x1F4B0;</span>Revenue</a>
      <div class="sect">People</div>
      <a href="#customers" data-route="customers"><span class="ic">&#x1F464;</span>Customers</a>
      <a href="#pending"   data-route="pending"><span class="ic">&#x23F3;</span>Pending approvals<span class="badge" id="nav-pending-count" hidden>0</span></a>
      <div class="sect">Money</div>
      <a href="#orders"     data-route="orders"><span class="ic">&#x1F4E6;</span>Orders<span class="badge" id="nav-orders-count" hidden>0</span></a>
      <a href="#licenses"   data-route="licenses"><span class="ic">&#x1F39F;&#xFE0F;</span>Licenses</a>
      <a href="#crypoverse" data-route="crypoverse"><span class="ic">&#x1F4B3;</span>Crypoverse</a>
      <div class="sect">Workspace</div>
      <a href="#teams"      data-route="teams"><span class="ic">&#x1F465;</span>Teams</a>
      <div class="sect">System</div>
      <a href="#health"     data-route="health"><span class="ic">&#x1F4E1;</span>Health</a>
      <a href="#payments"   data-route="payments"><span class="ic">&#x1F4BC;</span>Payments</a>
      <div class="sect">Operations</div>
      <a href="#audit"      data-route="audit"><span class="ic">&#x1F4CB;</span>Audit log</a>
      <a href="#comms"      data-route="comms"><span class="ic">&#x1F4E2;</span>Communications</a>
      <a href="#settings"   data-route="settings"><span class="ic">&#x2699;&#xFE0F;</span>Settings</a>
    </nav>
  </aside>
  <div>
    <header class="topbar">
      <div class="search">
        <input id="searchbox" placeholder="Search customers, orders, licenses, teams&#x2026; (id, @handle, email, tx_hash)" autocomplete="off" />
        <div id="search-results" class="search-results" hidden></div>
      </div>
      <div class="top-actions">
        <span class="pill-env" title="Production">&#x25CF; PROD</span>
      </div>
    </header>
    <main id="view"></main>
  </div>
</div>
<div id="toast" class="toast" hidden></div>
<div id="bulkbar" hidden>
  <span><span class="count" id="bulkCount">0</span> selected</span>
  <span class="sep">&#xB7;</span>
  <span id="bulkActions"></span>
  <button class="ghost" id="bulkClear">Clear</button>
</div>

<script>
"use strict";

// &#x2500;&#x2500; tiny helpers &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => Array.from(p.querySelectorAll(s));
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const fmtNum = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : "&#x2014;");
const fmtUsd = (n) => (typeof n === "number" ? "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "&#x2014;");
const fmtTs  = (ts) => ts ? new Date(ts * 1000).toLocaleString("en-GB", { day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" }) : "&#x2014;";
const fmtDate = (ts) => ts ? new Date(ts * 1000).toLocaleDateString("en-GB", { day:"2-digit", month:"short", year:"numeric" }) : "&#x2014;";
const fmtRel = (ts) => {
  if (!ts) return "&#x2014;";
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
let api = async function (path, opts = {}) {
  // Auto-attach the cached admin OTP (set by the 2FA wizard / login
  // prompt). The server only requires it when 2FA is enabled &#x2014; for
  // un-2FA'd setups it's a harmless extra header.
  const cachedOtp = sessionStorage.getItem("admin_otp");
  const baseHeaders = Object.assign({ "Content-Type": "application/json" }, cachedOtp ? { "x-admin-otp": cachedOtp } : {});
  const doFetch = async (extraHeaders) => fetch("/admin/api" + path, {
    credentials: "same-origin",
    ...opts,
    headers: Object.assign({}, baseHeaders, extraHeaders || {}, opts.headers || {}),
  });
  let res = await doFetch();
  let text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  // OTP required &#x2192; prompt + retry once. Caches the new code for the tab.
  if (res.status === 401 && body && body.error === "otp_required") {
    const code = prompt("Two-factor required &#x2014; enter your 6-digit code:");
    if (!code) throw new Error("otp_cancelled");
    sessionStorage.setItem("admin_otp", code);
    res = await doFetch({ "x-admin-otp": code });
    text = await res.text();
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  }
  if (!res.ok) {
    const msg = typeof body === "string" ? body : (body && body.error) || ("HTTP " + res.status);
    throw new Error(msg);
  }
  return body;
};

// &#x2500;&#x2500; routing (hash-based) &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
const ROUTES = {
  overview:  renderOverview,
  revenue:   renderRevenue,
  customers: renderCustomersList,
  pending:   renderPendingApprovals,
  orders:    renderOrders,
  licenses:  renderLicenses,
  crypoverse: renderCrypoverseList,
  teams:     renderTeamsList,
  health:    renderHealth,
  audit:     renderAudit,
  comms:     renderComms,
  settings:  renderSettings,
  payments:  renderPayments,
};
function route() {
  const hash = (location.hash || "#overview").slice(1);
  const [name, ...args] = hash.split("/");
  $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === name));
  if (name === "customers" && args[0]) return renderCustomerDetail(args[0]);
  if (name === "crypoverse" && args[0]) return renderCrypoverseDetail(args[0]);
  if (name === "teams" && args[0]) return renderTeamDetail(args[0]);
  const fn = ROUTES[name] || ROUTES.overview;
  fn(args);
}
window.addEventListener("hashchange", route);

// &#x2500;&#x2500; Overview &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
async function renderOverview() {
  const view = $("#view");
  view.innerHTML = '<h1 class="page">Dashboard</h1><div class="kpi-grid" id="kpis"></div><section class="card"><h2>Revenue &#xB7; last 30 days</h2><div class="chart-wrap"><canvas id="chart-overview"></canvas><div class="chart-tip" hidden></div></div><div class="chart-legend"><span><span class="legend-dot" style="background:#ff5722"></span>Revenue (USD)</span><span><span class="legend-dot" style="background:rgba(255,87,34,0.4)"></span>Orders</span></div></section>';
  try {
    const o = await api("/overview");
    refreshNavBadges(o);
    $("#kpis").innerHTML = [
      kpi("MRR", fmtUsd(o.analytics.mrr_usd), "monthly recurring"),
      kpi("Revenue 30d", fmtUsd(o.analytics.revenue_30d_usd), o.analytics.orders_30d + " orders"),
      kpi("Active licenses", fmtNum(o.analytics.licenses_active), o.analytics.licenses_expired + " expired &#xB7; " + o.analytics.licenses_revoked + " revoked"),
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
  // Step 4: live activity feed widget under the chart.
  try {
    const ev = await api("/events/recent?limit=30");
    liveFeed.events = (ev.events || []).slice().reverse();
    if (liveFeed.events.length) liveFeed.lastId = liveFeed.events[0].id;
  } catch (_) {}
  $("#view").insertAdjacentHTML("beforeend", '<section class="card"><h2>Live activity feed</h2><div id="live-feed"></div></section>');
  renderLiveFeedWidget();
  startLiveFeed();
}
const kpi = (label, value, delta) => '<div class="kpi"><div class="label">' + escapeHtml(label) + '</div><div class="value">' + value + '</div>' + (delta ? '<div class="delta">' + escapeHtml(delta) + "</div>" : "") + "</div>";

function refreshNavBadges(o) {
  const pCount = o && o.stats ? o.stats.orders_pending : 0;
  const pPending = o && o.counts ? o.counts.pending_approvals : 0;
  const ne = $("#nav-orders-count"); if (ne) { ne.textContent = pCount; ne.hidden = pCount === 0; }
  const np = $("#nav-pending-count"); if (np) { np.textContent = pPending; np.hidden = pPending === 0; }
}

// &#x2500;&#x2500; Revenue &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
async function renderRevenue() {
  const view = $("#view");
  view.innerHTML = '<h1 class="page">Revenue</h1>'
    + '<div class="kpi-grid" id="kpis"></div>'
    + '<section class="card"><h2>Revenue &#xB7; last 90 days</h2><div style="margin-bottom:8px"><button class="ghost" data-days="7">7d</button> <button class="ghost" data-days="30">30d</button> <button class="ghost" data-days="90">90d</button> <button class="ghost" data-days="365">1y</button></div><div class="chart-wrap"><canvas id="chart-rev"></canvas><div class="chart-tip" hidden></div></div><div class="chart-legend"><span><span class="legend-dot" style="background:#ff5722"></span>Revenue (USD)</span><span><span class="legend-dot" style="background:rgba(255,87,34,0.4)"></span>Orders</span></div></section>';
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

// &#x2500;&#x2500; Customers list &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
async function renderCustomersList() {
  const view = $("#view");
  view.innerHTML = '<h1 class="page">Customers</h1>'
    + '<section class="card"><table id="t"><thead><tr><th>ID</th><th>Telegram</th><th>Email</th><th>Status</th><th>Signed up</th></tr></thead><tbody><tr><td colspan="5" class="empty">Loading&#x2026;</td></tr></tbody></table></section>';
  try {
    const res = await api("/customers?limit=100");
    const tbody = $("#t tbody");
    if (!res.customers.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty">No customers yet.</td></tr>'; return; }
    tbody.innerHTML = res.customers.map((c) => '<tr class="click" onclick="location.hash=\'customers/' + escapeHtml(c.id) + "'\">"
      + '<td class="mono">' + escapeHtml(c.id) + "</td>"
      + "<td>" + (c.telegram ? "@" + escapeHtml(c.telegram.replace(/^@/, "")) : '<span style="color:#666">&#x2014;</span>') + "</td>"
      + "<td>" + (c.email ? escapeHtml(c.email) : '<span style="color:#666">&#x2014;</span>') + "</td>"
      + '<td><span class="pill ' + escapeHtml(c.approval_status) + '">' + escapeHtml(c.approval_status) + "</span></td>"
      + "<td>" + escapeHtml(fmtDate(c.created_at)) + "</td>"
      + "</tr>").join("");
  } catch (err) { toast(err.message, { err: true }); }
}

// &#x2500;&#x2500; Customer detail &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
async function renderCustomerDetail(id) {
  const view = $("#view");
  view.innerHTML = '<div class="crumb"><a href="#customers" class="link">&#x2190; Customers</a></div><section class="card"><p class="empty">Loading&#x2026;</p></section>';
  try {
    const d = await api("/customers/" + encodeURIComponent(id));
    const initial = (d.customer.telegram || d.customer.email || d.customer.id).replace(/^@/, "").charAt(0).toUpperCase();
    view.innerHTML =
        '<div class="crumb"><a href="#customers" class="link">&#x2190; Customers</a></div>'
      + '<section class="card"><div class="detail-hero">'
      + '<div class="avatar">' + escapeHtml(initial) + "</div>"
      + '<div style="flex:1">'
      +   "<h1>" + (d.customer.telegram ? "@" + escapeHtml(d.customer.telegram.replace(/^@/, "")) : escapeHtml(d.customer.email || d.customer.id)) + "</h1>"
      +   '<div class="sub">' + escapeHtml(d.customer.id) + " &#xB7; signed up " + escapeHtml(fmtDate(d.customer.created_at)) + ' &#xB7; <span class="pill ' + escapeHtml(d.customer.approval_status) + '">' + escapeHtml(d.customer.approval_status) + "</span></div>"
      +   '<div class="sub" style="margin-top:8px">Lifetime spend: <strong>' + fmtUsd(d.spend_total_usd) + "</strong> &#xB7; "
      +     d.orders.length + " orders &#xB7; " + d.licenses.length + " licenses &#xB7; " + d.sessions.length + " sessions &#xB7; " + d.team_memberships.length + " teams"
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
        + '<td class="mono" style="font-size:11px">' + (o.tx_hash ? escapeHtml(o.tx_hash.slice(0,12)) + "&#x2026;" : "&#x2014;") + "</td>"
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

// &#x2500;&#x2500; Orders (top-level page) &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
async function renderOrders() {
  const view = $("#view");
  view.innerHTML = '<h1 class="page">Pending orders</h1><section class="card" id="orders-card"><p class="empty">Loading&#x2026;</p></section>';
  try {
    const orders = await api("/orders/pending");
    const checkboxes = orders.length > 0;
    let html = checkboxes
      ? '<table><thead><tr><th><input type="checkbox" data-bulk-all="orders" /></th><th>ID</th><th>Plan</th><th>Customer</th><th>Created</th><th></th></tr></thead><tbody>'
        + orders.map((o) =>
            '<tr><td><input type="checkbox" data-bulk="orders" value="' + escapeHtml(o.id) + '" /></td>'
            + '<td class="mono">' + escapeHtml(o.id) + "</td>"
            + "<td>" + escapeHtml(o.interval) + "</td>"
            + "<td>" + (o.customer_telegram ? "@" + escapeHtml(o.customer_telegram.replace(/^@/, "")) : "&#x2014;") + "</td>"
            + "<td>" + escapeHtml(fmtTs(o.created_at)) + "</td>"
            + '<td class="actions-row"><button class="ghost" data-confirm="' + escapeHtml(o.id) + '">Confirm</button> <button class="danger" data-cancel="' + escapeHtml(o.id) + '">Cancel</button></td>'
            + "</tr>").join("")
        + "</tbody></table>"
      : '<p class="empty">No pending orders.</p>';
    $("#orders-card").innerHTML = html;
    bindOrderActions();
    if (checkboxes) rebindBulkSelection("orders", [
      { id: "cancel", label: "Cancel " + bulkSel.ids.size + " orders", danger: true, endpoint: "/orders/bulk-cancel", confirm: "Cancel {n} pending orders?" },
    ]);
  } catch (err) { toast(err.message, { err: true }); }
}

async function renderLicenses() {
  const view = $("#view");
  view.innerHTML = '<h1 class="page">Licenses</h1><section class="card" id="lic-card"><p class="empty">Loading&#x2026;</p></section>';
  try {
    const licenses = await api("/licenses?limit=200");
    const nowSec = Math.floor(Date.now()/1000);
    $("#lic-card").innerHTML = licenses.length
      ? '<table><thead><tr><th><input type="checkbox" data-bulk-all="licenses" /></th><th>ID</th><th>Customer</th><th>Plan</th><th>Status</th><th>Issued</th><th>Expires</th><th></th></tr></thead><tbody>'
        + licenses.map((l) => {
            const status = l.revoked_at ? "revoked" : (l.expires_at && l.expires_at <= nowSec ? "expired" : "valid");
            const canBulk = status === "valid";
            return '<tr><td>' + (canBulk ? '<input type="checkbox" data-bulk="licenses" value="' + escapeHtml(l.id) + '" />' : "") + "</td>"
              + '<td class="mono">' + escapeHtml(l.id) + "</td>"
              + "<td>" + escapeHtml(l.customer_telegram || l.customer_id) + "</td>"
              + "<td>" + escapeHtml(l.interval) + "</td>"
              + '<td><span class="pill ' + status + '">' + status + "</span></td>"
              + "<td>" + escapeHtml(fmtDate(l.issued_at)) + "</td>"
              + "<td>" + (l.expires_at ? escapeHtml(fmtDate(l.expires_at)) : '<span style="color:#666">never</span>') + "</td>"
              + "<td>" + (canBulk ? '<button class="danger" data-revoke="' + escapeHtml(l.id) + '">Revoke</button>' : "") + "</td>"
              + "</tr>";
          }).join("")
        + "</tbody></table>"
      : '<p class="empty">No licenses yet.</p>';
    bindLicenseActions();
    rebindBulkSelection("licenses", [
      { id: "revoke", label: "Revoke selected", danger: true, endpoint: "/licenses/bulk-revoke", prompt: "Reason for revocation?", confirm: "Revoke {n} licenses?" },
    ]);
  } catch (err) { toast(err.message, { err: true }); }
}

async function renderPendingApprovals() {
  const view = $("#view");
  view.innerHTML = '<h1 class="page">Pending approvals</h1><section class="card" id="pa-card"><p class="empty">Loading&#x2026;</p></section>';
  try {
    const list = await api("/customers/pending");
    if (!list.length) { $("#pa-card").innerHTML = '<p class="empty">No pending approvals.</p>'; return; }
    $("#pa-card").innerHTML = '<table><thead><tr><th><input type="checkbox" data-bulk-all="pending" /></th><th>Customer</th><th>Telegram</th><th>Email</th><th>Method</th><th>Registered</th><th></th></tr></thead><tbody>'
      + list.map((c) =>
          '<tr><td><input type="checkbox" data-bulk="pending" value="' + escapeHtml(c.id) + '" /></td>'
          + '<td class="mono">' + escapeHtml(c.id) + "</td>"
          + "<td>" + (c.telegram ? "@" + escapeHtml(c.telegram.replace(/^@/, "")) : "&#x2014;") + "</td>"
          + "<td>" + escapeHtml(c.email || "&#x2014;") + "</td>"
          + "<td>" + escapeHtml(c.method || "&#x2014;") + "</td>"
          + "<td>" + escapeHtml(fmtTs(c.created_at)) + "</td>"
          + '<td class="actions-row"><button data-approve="' + escapeHtml(c.id) + '" data-days="2">Approve 2d</button>'
          +   '<button data-approve="' + escapeHtml(c.id) + '" data-days="7">Approve 7d</button>'
          +   '<button class="danger" data-reject="' + escapeHtml(c.id) + '">Reject</button></td>'
          + "</tr>").join("")
      + "</tbody></table>";
    rebindBulkSelection("pending", [
      { id: "approve7", label: "Approve all (7d trial)", endpoint: "/customers/bulk-approve", extra: () => ({ trial_days: 7 }), confirm: "Approve {n} customers with 7-day trial?" },
      { id: "approve2", label: "Approve all (2d)", endpoint: "/customers/bulk-approve", extra: () => ({ trial_days: 2 }), confirm: "Approve {n} customers with 2-day trial?" },
    ]);
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

// &#x2500;&#x2500; Crypoverse invoices &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
async function renderCrypoverseList() {
  const view = $("#view");
  view.innerHTML = '<h1 class="page">Crypoverse invoices</h1>'
    + '<div class="kpi-grid" id="cv-kpis"></div>'
    + '<section class="card">'
    + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px">'
    +   '<select id="cv-filter-status" class="ghost" style="background:#0d0d12;color:#ccc;padding:7px 10px;border-radius:7px;border:1px solid rgba(255,255,255,0.15);font:inherit">'
    +     '<option value="all">All statuses</option>'
    +     '<option value="open">&#x1F7E1; Open (initiated/pending)</option>'
    +     '<option value="paid">&#x2705; Paid</option>'
    +     '<option value="failed">&#x274C; Failed / expired</option>'
    +   '</select>'
    +   '<input id="cv-filter-q" placeholder="Search by tx, order, @handle&#x2026;" style="flex:1;min-width:240px;background:#0d0d12;color:#ccc;padding:7px 12px;border-radius:7px;border:1px solid rgba(255,255,255,0.15);font:inherit" />'
    +   '<button class="ghost" id="cv-reload">&#x21BB; Reload</button>'
    + '</div>'
    + '<div id="cv-table"><p class="empty">Loading&#x2026;</p></div></section>';
  async function reload() {
    try {
      const [stats, list] = await Promise.all([
        api("/crypoverse/stats"),
        api("/crypoverse/invoices?status=" + encodeURIComponent($("#cv-filter-status").value) + "&q=" + encodeURIComponent($("#cv-filter-q").value)),
      ]);
      $("#cv-kpis").innerHTML = [
        kpi("Total revenue", fmtUsd(stats.total_revenue_usd)),
        kpi("Paid invoices", fmtNum(stats.paid_invoices), stats.total_invoices + " created"),
        kpi("Open invoices", fmtNum(stats.open_invoices)),
        kpi("Failed", fmtNum(stats.failed_invoices)),
        kpi("Conversion", stats.conversion_rate_pct + "%"),
        kpi("Avg time-to-pay", stats.avg_time_to_pay_minutes ? stats.avg_time_to_pay_minutes + " min" : "&#x2014;"),
        kpi("Listeners active", fmtNum(stats.listeners_active), "SSE streams"),
      ].join("");
      const invoices = list.invoices;
      $("#cv-table").innerHTML = invoices.length
        ? '<table><thead><tr><th>Transaction</th><th>Order</th><th>Customer</th><th>Amount</th><th>Status</th><th>Created</th><th>Paid</th><th></th></tr></thead><tbody>'
          + invoices.map((i) => {
              const cls = ["paid","confirmed","completed","succeeded"].includes(i.status) ? "valid"
                        : ["expired","cancelled","canceled","failed","refunded"].includes(i.status) ? "revoked"
                        : "pending";
              return '<tr class="click" onclick="location.hash=\'crypoverse/' + escapeHtml(i.transaction_id) + "'\">"
                + '<td class="mono" style="font-size:11px">' + escapeHtml(i.transaction_id.slice(0,16)) + '&#x2026;</td>'
                + '<td class="mono">' + escapeHtml(i.order_id) + "</td>"
                + "<td>" + (i.customer_telegram ? "@" + escapeHtml(i.customer_telegram.replace(/^@/, "")) : '<span style="color:#666">&#x2014;</span>') + "</td>"
                + "<td><strong>" + fmtUsd(i.amount_usd) + "</strong></td>"
                + '<td><span class="pill ' + cls + '">' + escapeHtml(i.status) + "</span></td>"
                + "<td>" + escapeHtml(fmtTs(i.created_at)) + "</td>"
                + "<td>" + escapeHtml(fmtRel(i.paid_at)) + "</td>"
                + '<td><button class="ghost" onclick="event.stopPropagation();location.hash=\'crypoverse/' + escapeHtml(i.transaction_id) + "'\">Open</button></td>"
                + "</tr>";
            }).join("")
          + "</tbody></table>"
        : '<p class="empty">No invoices match these filters.</p>';
    } catch (err) { toast(err.message, { err: true }); }
  }
  $("#cv-filter-status").addEventListener("change", reload);
  $("#cv-reload").addEventListener("click", reload);
  let qTimer = null;
  $("#cv-filter-q").addEventListener("input", () => { clearTimeout(qTimer); qTimer = setTimeout(reload, 250); });
  reload();
}

async function renderCrypoverseDetail(tx) {
  const view = $("#view");
  view.innerHTML = '<div class="crumb"><a href="#crypoverse" class="link">&#x2190; Crypoverse invoices</a></div><section class="card"><p class="empty">Loading&#x2026;</p></section>';
  try {
    const i = await api("/crypoverse/invoices/" + encodeURIComponent(tx));
    const cls = ["paid","confirmed","completed","succeeded"].includes(i.status) ? "valid"
              : ["expired","cancelled","canceled","failed","refunded"].includes(i.status) ? "revoked"
              : "pending";
    const lastEv = i.last_event_parsed ? JSON.stringify(i.last_event_parsed, null, 2) : (i.last_event_payload || "&#x2014;");
    view.innerHTML =
        '<div class="crumb"><a href="#crypoverse" class="link">&#x2190; Crypoverse invoices</a></div>'
      + '<section class="card">'
      + '<h1 class="page" style="margin-bottom:6px">Invoice <span class="mono" style="font-size:14px;color:#888">' + escapeHtml(i.transaction_id) + "</span></h1>"
      + '<div style="color:#888;margin-bottom:18px">Order <a href="#customers" class="link mono">' + escapeHtml(i.order_id) + "</a> &#xB7; <strong>" + fmtUsd(i.amount_usd) + "</strong> &#xB7; "
      +   'Status <span class="pill ' + cls + '">' + escapeHtml(i.status) + "</span> &#xB7; Created " + escapeHtml(fmtTs(i.created_at)) + "</div>"
      + '<table style="margin-bottom:18px">'
      +   '<tr><th>Internal id</th><td class="mono">' + escapeHtml(i.id) + "</td></tr>"
      +   '<tr><th>Transaction id</th><td class="mono">' + escapeHtml(i.transaction_id) + "</td></tr>"
      +   '<tr><th>Order id</th><td class="mono">' + escapeHtml(i.order_id) + "</td></tr>"
      +   "<tr><th>Amount</th><td><strong>" + fmtUsd(i.amount_usd) + "</strong></td></tr>"
      +   '<tr><th>Status</th><td><span class="pill ' + cls + '">' + escapeHtml(i.status) + "</span></td></tr>"
      +   "<tr><th>Order status</th><td>" + (i.order_status ? '<span class="pill ' + escapeHtml(i.order_status) + '">' + escapeHtml(i.order_status) + "</span>" : "&#x2014;") + "</td></tr>"
      +   "<tr><th>Created</th><td>" + escapeHtml(fmtTs(i.created_at)) + "</td></tr>"
      +   "<tr><th>Last event</th><td>" + escapeHtml(fmtRel(i.last_event_at)) + "</td></tr>"
      +   "<tr><th>Paid</th><td>" + escapeHtml(fmtTs(i.paid_at)) + "</td></tr>"
      +   "<tr><th>Paid tx hash</th><td class=\"mono\" style=\"font-size:11px;word-break:break-all\">" + escapeHtml(i.paid_tx_hash || "&#x2014;") + "</td></tr>"
      +   "<tr><th>Pay URL</th><td><a class=\"link mono\" href=\"" + escapeHtml(i.redirect_url) + "\" target=\"_blank\" rel=\"noopener\">" + escapeHtml(i.redirect_url) + "</a></td></tr>"
      + "</table>"
      + '<h2>Last SSE event payload</h2>'
      + '<pre class="mono" style="background:#0d0d12;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:12px;overflow:auto;max-height:260px;font-size:11px">' + escapeHtml(lastEv) + "</pre>"
      + '<div style="margin-top:14px"><button id="cv-retry">&#x1F504; Retry SSE listener</button> <button class="ghost" onclick="location.reload()">&#x21BB; Reload page</button></div>'
      + "</section>";
    $("#cv-retry").addEventListener("click", async () => {
      try {
        const r = await api("/crypoverse/invoices/" + encodeURIComponent(i.transaction_id) + "/retry", { method: "POST", body: "{}" });
        toast(r.ok ? (r.was_running ? "Listener restarted" : "Listener started") : ("Cannot retry: " + (r.reason || "unknown")), { err: !r.ok });
      } catch (e) { toast(e.message, { err: true }); }
    });
  } catch (err) { view.innerHTML = '<section class="card"><p class="empty">' + escapeHtml(err.message) + "</p></section>"; }
}

// &#x2500;&#x2500; Teams &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
async function renderTeamsList() {
  const view = $("#view");
  view.innerHTML = '<h1 class="page">Teams</h1><section class="card" id="teams-card"><p class="empty">Loading&#x2026;</p></section>';
  try {
    const r = await api("/teams?limit=200");
    if (!r.teams.length) { $("#teams-card").innerHTML = '<p class="empty">No teams yet.</p>'; return; }
    $("#teams-card").innerHTML = '<table><thead><tr><th>Name</th><th>ID</th><th>Owner</th><th>Members</th><th>Active sessions</th><th>Created</th></tr></thead><tbody>'
      + r.teams.map((t) =>
          '<tr class="click" onclick="location.hash=\'teams/' + escapeHtml(t.id) + "'\">"
          + "<td><strong>" + escapeHtml(t.name) + "</strong></td>"
          + '<td class="mono" style="font-size:11px">' + escapeHtml(t.id) + "</td>"
          + "<td>" + escapeHtml(t.owner_display || t.owner_customer_id) + "</td>"
          + "<td>" + fmtNum(t.member_count) + "</td>"
          + "<td>" + (t.active_session_count > 0 ? '<span class="pill valid">' + t.active_session_count + " live</span>" : '<span style="color:#666">&#x2014;</span>') + "</td>"
          + "<td>" + escapeHtml(fmtDate(t.created_at)) + "</td>"
          + "</tr>").join("")
      + "</tbody></table>";
  } catch (err) { toast(err.message, { err: true }); }
}

async function renderTeamDetail(id) {
  const view = $("#view");
  view.innerHTML = '<div class="crumb"><a href="#teams" class="link">&#x2190; Teams</a></div><section class="card"><p class="empty">Loading&#x2026;</p></section>';
  try {
    const d = await api("/teams/" + encodeURIComponent(id));
    view.innerHTML =
        '<div class="crumb"><a href="#teams" class="link">&#x2190; Teams</a></div>'
      + '<section class="card">'
      +   '<h1 class="page" style="margin-bottom:4px">' + escapeHtml(d.team.name) + "</h1>"
      +   '<div style="color:#888;margin-bottom:18px"><span class="mono">' + escapeHtml(d.team.id) + "</span> &#xB7; created " + escapeHtml(fmtDate(d.team.created_at)) + " &#xB7; "
      +     d.members.length + " members &#xB7; " + d.invites.length + " invites &#xB7; " + d.active_sessions.length + " active sessions</div>"
      +   '<h2>Members</h2>'
      +   '<table style="margin-bottom:18px"><thead><tr><th>Customer</th><th>Display</th><th>Telegram</th><th>Role</th><th>Joined</th><th>Transfer ownership</th></tr></thead><tbody>'
      +     d.members.map((m) =>
              '<tr><td class="mono" style="font-size:11px">' + escapeHtml(m.customer_id) + "</td>"
              + "<td>" + escapeHtml(m.display || "&#x2014;") + "</td>"
              + "<td>" + (m.telegram ? "@" + escapeHtml(m.telegram.replace(/^@/, "")) : "&#x2014;") + "</td>"
              + "<td><strong>" + escapeHtml(m.role) + "</strong></td>"
              + "<td>" + escapeHtml(fmtDate(m.added_at)) + "</td>"
              + "<td>" + (m.role !== "owner" ? '<button class="ghost" data-transfer="' + escapeHtml(m.customer_id) + '">&#x2192; Make owner</button>' : '<span style="color:#666">owner</span>') + "</td>"
              + "</tr>").join("")
      +   "</tbody></table>"
      +   '<h2>Active sessions (' + d.active_sessions.length + ")</h2>"
      +   (d.active_sessions.length === 0
          ? '<p class="empty">No active workspaces.</p>'
          : '<table style="margin-bottom:18px"><thead><tr><th>Session</th><th>Host</th><th>Title</th><th>Started</th><th>Last heartbeat</th></tr></thead><tbody>'
            + d.active_sessions.map((s) =>
                '<tr><td class="mono" style="font-size:11px">' + escapeHtml(s.id) + "</td>"
                + '<td class="mono" style="font-size:11px">' + escapeHtml(s.host_customer_id) + "</td>"
                + "<td>" + escapeHtml(s.title || "&#x2014;") + "</td>"
                + "<td>" + escapeHtml(fmtTs(s.created_at)) + "</td>"
                + "<td>" + escapeHtml(fmtRel(s.last_heartbeat_at)) + "</td>"
                + "</tr>").join("")
            + "</tbody></table>")
      +   "<h2>Pending invites (" + d.invites.length + ")</h2>"
      +   (d.invites.length === 0
          ? '<p class="empty">No outstanding invites.</p>'
          : '<table><thead><tr><th>Identifier</th><th>Role</th><th>Invited by</th><th>Created</th></tr></thead><tbody>'
            + d.invites.map((iv) =>
                "<tr><td>" + escapeHtml(iv.identifier) + "</td>"
                + "<td>" + escapeHtml(iv.role) + "</td>"
                + '<td class="mono" style="font-size:11px">' + escapeHtml(iv.invited_by) + "</td>"
                + "<td>" + escapeHtml(fmtTs(iv.created_at)) + "</td>"
                + "</tr>").join("")
            + "</tbody></table>")
      + "</section>";
    $$('button[data-transfer]').forEach((b) => b.addEventListener("click", async () => {
      const nid = b.dataset.transfer;
      if (!confirm("Transfer ownership of '" + d.team.name + "' to " + nid + "?")) return;
      try {
        await api("/teams/" + encodeURIComponent(id) + "/transfer", { method: "POST", body: JSON.stringify({ new_owner_customer_id: nid }) });
        toast("Ownership transferred");
        renderTeamDetail(id);
      } catch (e) { toast(e.message, { err: true }); }
    }));
  } catch (err) { view.innerHTML = '<section class="card"><p class="empty">' + escapeHtml(err.message) + "</p></section>"; }
}

// &#x2500;&#x2500; System health &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
async function renderHealth() {
  const view = $("#view");
  view.innerHTML = '<h1 class="page">System health</h1><div id="hc"><p class="empty">Loading&#x2026;</p></div>';
  try {
    const h = await api("/health");
    const fmtBytes = (b) => {
      if (b < 1024) return b + " B";
      if (b < 1024*1024) return (b/1024).toFixed(1) + " KB";
      if (b < 1024*1024*1024) return (b/1024/1024).toFixed(1) + " MB";
      return (b/1024/1024/1024).toFixed(2) + " GB";
    };
    const fmtUptime = (s) => {
      const d = Math.floor(s/86400), hrs = Math.floor((s%86400)/3600), mns = Math.floor((s%3600)/60);
      return (d ? d+"d " : "") + (hrs ? hrs+"h " : "") + mns + "m";
    };
    const okBadge = (v) => v ? '<span class="pill valid">ON</span>' : '<span class="pill revoked">OFF</span>';
    const sub = (title, body) => '<section class="card"><h2>' + title + "</h2>" + body + "</section>";
    $("#hc").innerHTML =
      '<div class="kpi-grid">'
      + kpi("Uptime", fmtUptime(h.process.uptime_seconds), "pid " + h.process.pid)
      + kpi("RSS memory", fmtBytes(h.process.rss_bytes), "heap " + fmtBytes(h.process.heap_used_bytes) + " / " + fmtBytes(h.process.heap_total_bytes))
      + kpi("DB size", h.db ? fmtBytes(h.db.file_size_bytes) : "&#x2014;", h.db ? h.db.page_count + " pages &#xB7; " + h.db.journal_mode : "")
      + kpi("Crypoverse SSE", h.workers.crypoverse_listeners_active + "", "active listeners")
      + "</div>"
      + sub("Background workers", '<table>'
          + "<tr><th>Payment poller (on-chain)</th><td>" + okBadge(h.workers.payment_poller_enabled) + "</td></tr>"
          + "<tr><th>Crypoverse provider</th><td>" + okBadge(h.workers.crypoverse_enabled) + "</td></tr>"
          + "<tr><th>Crypoverse listeners</th><td><strong>" + h.workers.crypoverse_listeners_active + "</strong> running</td></tr>"
          + "<tr><th>Backup scheduler</th><td>" + okBadge(h.workers.backup_scheduler_enabled) + "</td></tr>"
          + "<tr><th>Last backup</th><td>" + (h.workers.last_backup
              ? (h.workers.last_backup.ok
                  ? '<span class="pill valid">ok</span> ' + escapeHtml(fmtRel(h.workers.last_backup.at)) + " &#xB7; " + fmtBytes(h.workers.last_backup.size || 0)
                  : '<span class="pill revoked">failed</span> ' + escapeHtml(fmtRel(h.workers.last_backup.at)) + " &#xB7; " + escapeHtml(h.workers.last_backup.error || ""))
              : '<span style="color:#666">never (no backup since boot)</span>') + "</td></tr>"
          + "</table>")
      + sub("Environment", '<table>'
          + Object.entries(h.env).map(([k,v]) => "<tr><th>" + escapeHtml(k.replaceAll("_", " ")) + "</th><td>" + okBadge(v) + "</td></tr>").join("")
          + "</table>")
      + sub("Database", h.db ? '<table>'
          + "<tr><th>File size</th><td>" + fmtBytes(h.db.file_size_bytes) + "</td></tr>"
          + "<tr><th>Pages</th><td>" + fmtNum(h.db.page_count) + " &#xD7; " + fmtBytes(h.db.page_size) + "</td></tr>"
          + "<tr><th>Journal mode</th><td>" + escapeHtml(h.db.journal_mode) + "</td></tr>"
          + "<tr><th>Customers</th><td>" + fmtNum(h.db.customers) + "</td></tr>"
          + "<tr><th>Orders</th><td>" + fmtNum(h.db.orders) + "</td></tr>"
          + "<tr><th>Licenses</th><td>" + fmtNum(h.db.licenses) + "</td></tr>"
          + "<tr><th>Audit rows</th><td>" + fmtNum(h.db.audit_rows) + "</td></tr>"
          + "</table>" : '<p class="empty">DB unreachable</p>')
      + sub("Recent errors (last 20)", h.recent_errors.length === 0
          ? '<p class="empty">No errors recorded.</p>'
          : '<table><thead><tr><th>Time</th><th>Action</th><th>Details</th></tr></thead><tbody>'
            + h.recent_errors.map((e) =>
                '<tr><td>' + escapeHtml(fmtTs(e.ts)) + "</td>"
                + '<td class="mono">' + escapeHtml(e.action) + "</td>"
                + '<td class="mono" style="font-size:11px;word-break:break-all">' + escapeHtml((e.details || "").slice(0,180)) + "</td>"
                + "</tr>").join("")
            + "</tbody></table>")
      + sub("Runtime", '<table>'
          + "<tr><th>Bun</th><td>" + escapeHtml(h.process.bun_version || "&#x2014;") + "</td></tr>"
          + "<tr><th>Node</th><td>" + escapeHtml(h.process.node_version) + "</td></tr>"
          + "<tr><th>PID</th><td>" + h.process.pid + "</td></tr>"
          + "<tr><th>Started</th><td>" + escapeHtml(fmtTs(h.process.started_at)) + "</td></tr>"
          + "</table>");
  } catch (err) { $("#hc").innerHTML = '<p class="empty">' + escapeHtml(err.message) + "</p>"; }
}

// &#x2500;&#x2500; Settings &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
async function renderSettings() {
  const view = $("#view");
  view.innerHTML = '<h1 class="page">Settings</h1><div id="settings-wrap"><p class="empty">Loading&#x2026;</p></div>';
  try {
    const data = await api("/settings");
    let html = '<section class="card"><h2>Runtime-editable</h2>';
    for (const s of data.catalogue) {
      const current = s.current_value != null ? s.current_value : String(s.default);
      const tsBadge = s.updated_at
        ? '<span class="ts">last changed ' + fmtRel(s.updated_at) + (s.updated_by ? " by " + escapeHtml(s.updated_by) : "") + "</span>"
        : '<span class="ts">using default</span>';
      let valueCtl = "";
      if (s.type === "boolean") {
        const on = current === "true" || current === "1" || current === true;
        valueCtl = '<div class="toggle ' + (on ? "on" : "") + '" data-toggle="' + escapeHtml(s.key) + '" data-on="' + on + '"></div>';
      } else if (s.type === "number") {
        valueCtl = '<input type="number" data-input="' + escapeHtml(s.key) + '" value="' + escapeHtml(String(current)) + '" />';
      } else {
        valueCtl = '<input type="text" data-input="' + escapeHtml(s.key) + '" value="' + escapeHtml(String(current)) + '" />';
      }
      html += '<div class="setting-row">'
        +   '<div class="setting-meta">'
        +     '<div class="k">' + escapeHtml(s.key) + ' <span style="color:var(--muted);font-weight:400;font-size:11px">(default: ' + escapeHtml(String(s.default)) + ")</span></div>"
        +     '<div class="desc">' + escapeHtml(s.description) + "</div>"
        +     '<div class="ts">' + tsBadge + "</div>"
        +   "</div>"
        +   '<div class="setting-value">' + valueCtl + (s.type !== "boolean" ? ' <button data-save="' + escapeHtml(s.key) + '">Save</button>' : "") + "</div>"
        + "</div>";
    }
    html += "</section>";
    html += '<section class="card"><h2>Read-only (env-backed)</h2><table>'
      + '<tr><th>Plan prices (USD)</th><td>monthly: $' + data.env_readonly.plan_prices_usd.monthly
      + " &#xB7; annual: $" + data.env_readonly.plan_prices_usd.annual
      + " &#xB7; lifetime: $" + data.env_readonly.plan_prices_usd.lifetime + "</td></tr>"
      + '<tr><th>Admin user ids</th><td>' + data.env_readonly.admin_user_ids_count + " configured</td></tr>"
      + '<tr><th>Crypoverse</th><td>' + (data.env_readonly.crypoverse_enabled ? '<span class="pill valid">ON</span>' : '<span class="pill revoked">OFF</span>') + "</td></tr>"
      + '<tr><th>Sentry</th><td>' + (data.env_readonly.sentry_enabled ? '<span class="pill valid">ON</span>' : '<span class="pill revoked">OFF</span>') + "</td></tr>"
      + '<tr><th>S3 backup</th><td>' + (data.env_readonly.backup_enabled ? '<span class="pill valid">ON</span>' : '<span class="pill revoked">OFF</span>') + "</td></tr>"
      + '</table><p style="color:var(--muted);font-size:11px;margin-top:10px">These are sourced from env vars / Fly secrets &#x2014; change them with <code>fly secrets set KEY=value</code> followed by a deploy.</p></section>';
    $("#settings-wrap").innerHTML = html;
    // Wire toggles (boolean &#x2014; auto-save on click)
    $$('div[data-toggle]').forEach((el) => el.addEventListener("click", async () => {
      const key = el.dataset.toggle;
      const on = el.dataset.on === "true";
      const next = !on;
      try {
        await api("/settings/" + encodeURIComponent(key), { method: "PUT", body: JSON.stringify({ value: next }) });
        el.classList.toggle("on", next);
        el.dataset.on = String(next);
        toast("Saved &#xB7; " + key + " = " + next);
      } catch (e) { toast(e.message, { err: true }); }
    }));
    // Wire save buttons (number/string &#x2014; explicit save)
    $$('button[data-save]').forEach((b) => b.addEventListener("click", async () => {
      const key = b.dataset.save;
      const input = $('input[data-input="' + key + '"]');
      try {
        await api("/settings/" + encodeURIComponent(key), { method: "PUT", body: JSON.stringify({ value: input.value }) });
        toast("Saved &#xB7; " + key);
        renderSettings();
      } catch (e) { toast(e.message, { err: true }); }
    }));
  } catch (err) { $("#settings-wrap").innerHTML = '<p class="empty">' + escapeHtml(err.message) + "</p>"; }
  // Step 4: 2FA card appended below the editable + read-only sections.
  await append2faCard();
}

// &#x2500;&#x2500; Audit log (advanced) &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
const auditState = { offset: 0, limit: 50 };
async function renderAudit() {
  const view = $("#view");
  view.innerHTML = '<h1 class="page">Audit log</h1>'
    + '<section class="card">'
    + '<div class="filters">'
    +   '<input id="a-actor" placeholder="Actor / customer id" />'
    +   '<input id="a-action" placeholder="Action prefix (e.g. license.)" />'
    +   '<input id="a-q" placeholder="Free text search&#x2026;" />'
    +   '<input id="a-since" type="date" />'
    +   '<input id="a-until" type="date" />'
    +   '<button id="a-apply">Apply</button>'
    +   '<button class="ghost" id="a-csv">&#x2193; Export CSV</button>'
    + "</div>"
    + '<div id="a-table"><p class="empty">Loading&#x2026;</p></div>'
    + '<div style="margin-top:14px;display:flex;gap:8px;align-items:center">'
    +   '<button class="ghost" id="a-prev">&#x2190; Prev</button>'
    +   '<span id="a-page" style="color:var(--muted);font-size:12px"></span>'
    +   '<button class="ghost" id="a-next">Next &#x2192;</button>'
    + "</div></section>";
  function qstring() {
    const p = [];
    const since = $("#a-since").value ? Math.floor(new Date($("#a-since").value).getTime()/1000) : null;
    const until = $("#a-until").value ? Math.floor(new Date($("#a-until").value + "T23:59:59Z").getTime()/1000) : null;
    if ($("#a-actor").value) p.push("actor=" + encodeURIComponent($("#a-actor").value));
    if ($("#a-action").value) p.push("action=" + encodeURIComponent($("#a-action").value));
    if ($("#a-q").value) p.push("q=" + encodeURIComponent($("#a-q").value));
    if (since) p.push("since=" + since);
    if (until) p.push("until=" + until);
    p.push("limit=" + auditState.limit);
    p.push("offset=" + auditState.offset);
    return p.join("&");
  }
  async function reload() {
    try {
      const r = await api("/audit?" + qstring());
      $("#a-page").textContent = "Showing " + (r.rows.length === 0 ? "0" : (auditState.offset+1) + "&#x2013;" + (auditState.offset + r.rows.length)) + " of " + r.total;
      $("#a-prev").disabled = auditState.offset === 0;
      $("#a-next").disabled = auditState.offset + r.rows.length >= r.total;
      $("#a-table").innerHTML = r.rows.length === 0
        ? '<p class="empty">No matching audit rows.</p>'
        : '<table><thead><tr><th style="width:160px">Time</th><th>Action</th><th>Details</th></tr></thead><tbody>'
          + r.rows.map((row) => {
              let pretty = row.details || "";
              try { pretty = JSON.stringify(JSON.parse(row.details), null, 2); } catch {}
              return '<tr><td style="vertical-align:top">' + escapeHtml(fmtTs(row.ts)) + "</td>"
                + '<td class="mono" style="vertical-align:top">' + escapeHtml(row.action) + "</td>"
                + '<td><details class="audit-row"><summary class="mono" style="font-size:11px;color:var(--muted)">' + escapeHtml((row.details || "").slice(0, 180)) + "</summary>"
                + "<pre>" + escapeHtml(pretty) + "</pre></details></td>"
                + "</tr>";
            }).join("")
          + "</tbody></table>";
    } catch (err) { toast(err.message, { err: true }); }
  }
  $("#a-apply").addEventListener("click", () => { auditState.offset = 0; reload(); });
  $("#a-prev").addEventListener("click", () => { auditState.offset = Math.max(0, auditState.offset - auditState.limit); reload(); });
  $("#a-next").addEventListener("click", () => { auditState.offset += auditState.limit; reload(); });
  $("#a-csv").addEventListener("click", () => { window.open("/admin/api/audit/export.csv?" + qstring(), "_blank"); });
  reload();
}

// &#x2500;&#x2500; Bulk selection system &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
// Tables that opt in render <input type="checkbox" data-bulk="<scope>"
// value="<id>" /> and call rebindBulkSelection(scope). The bar shows
// scope-specific actions and posts to the corresponding bulk endpoint.
const bulkSel = { scope: null, ids: new Set() };
function rebindBulkSelection(scope, actions) {
  bulkSel.scope = scope;
  bulkSel.ids.clear();
  refreshBulkBar(actions);
  $$('input[data-bulk="' + scope + '"]').forEach((cb) => {
    cb.checked = false;
    cb.addEventListener("change", () => {
      if (cb.checked) bulkSel.ids.add(cb.value); else bulkSel.ids.delete(cb.value);
      refreshBulkBar(actions);
    });
  });
  const headerCb = $('input[data-bulk-all="' + scope + '"]');
  if (headerCb) {
    headerCb.checked = false;
    headerCb.addEventListener("change", () => {
      $$('input[data-bulk="' + scope + '"]').forEach((cb) => { cb.checked = headerCb.checked; if (headerCb.checked) bulkSel.ids.add(cb.value); else bulkSel.ids.delete(cb.value); });
      refreshBulkBar(actions);
    });
  }
}
function refreshBulkBar(actions) {
  const bar = $("#bulkbar");
  $("#bulkCount").textContent = bulkSel.ids.size;
  if (bulkSel.ids.size === 0) { bar.hidden = true; return; }
  bar.hidden = false;
  $("#bulkActions").innerHTML = actions.map((a) => '<button data-bulk-act="' + a.id + '" class="' + (a.danger ? "danger" : "") + '">' + escapeHtml(a.label) + "</button>").join(" ");
  $$('button[data-bulk-act]').forEach((b) => b.addEventListener("click", async () => {
    const act = actions.find((x) => x.id === b.dataset.bulkAct);
    if (!act) return;
    if (act.confirm && !confirm(act.confirm.replace("{n}", bulkSel.ids.size))) return;
    let extra = {};
    if (act.prompt) {
      const v = prompt(act.prompt, "");
      if (v === null) return;
      extra = act.extra ? act.extra(v) : { reason: v };
    } else if (act.extra) {
      extra = act.extra();
    }
    try {
      const r = await api(act.endpoint, { method: "POST", body: JSON.stringify({ ids: Array.from(bulkSel.ids), ...extra }) });
      toast("Bulk " + act.id + ": " + (r.ok ? r.ok.length : "?") + " ok" + (r.errors && r.errors.length ? ", " + r.errors.length + " failed" : ""));
      bulkSel.ids.clear();
      bar.hidden = true;
      route();
    } catch (e) { toast(e.message, { err: true }); }
  }));
}
$("#bulkClear").addEventListener("click", () => { bulkSel.ids.clear(); $("#bulkbar").hidden = true; $$('input[data-bulk], input[data-bulk-all]').forEach((cb) => { cb.checked = false; }); });

// &#x2500;&#x2500; Communications (broadcast) &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
async function renderComms() {
  const view = $("#view");
  view.innerHTML = '<h1 class="page">Communications</h1>'
    + '<section class="card">'
    + '<h2>Push broadcast via Telegram bot</h2>'
    + '<div class="setting-row" style="display:block;border:0;padding-top:0">'
    +   '<label class="k" for="cm-segment" style="display:block;margin-bottom:6px">Segment</label>'
    +   '<select id="cm-segment" style="width:100%;max-width:520px;background:var(--bg);color:var(--text);padding:9px 12px;border-radius:7px;border:1px solid var(--border);font:inherit"><option value="">Loading segments&#x2026;</option></select>'
    + '</div>'
    + '<div class="setting-row" style="display:block;border:0">'
    +   '<label class="k" for="cm-msg" style="display:block;margin-bottom:6px">Message (max 4000 chars, Markdown supported)</label>'
    +   '<textarea id="cm-msg" rows="6" placeholder="Hi @user! &#x2026;" style="width:100%;background:var(--bg);color:var(--text);padding:10px 12px;border-radius:7px;border:1px solid var(--border);font:inherit;resize:vertical"></textarea>'
    +   '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px"><span id="cm-count" style="color:var(--muted);font-size:11px">0 / 4000</span> <button id="cm-send">&#x1F4E2; Send broadcast</button></div>'
    + '</div>'
    + '</section>'
    + '<section class="card"><h2>Recent broadcasts</h2><div id="cm-history"><p class="empty">Loading&#x2026;</p></div></section>';
  // Populate segments
  try {
    const seg = await api("/broadcasts/segments");
    $("#cm-segment").innerHTML = seg.segments.map((s) => '<option value="' + escapeHtml(s.segment) + '">' + escapeHtml(s.label) + " (" + s.count + " recipients)</option>").join("");
  } catch (err) { toast(err.message, { err: true }); }
  // Counter
  $("#cm-msg").addEventListener("input", () => { $("#cm-count").textContent = $("#cm-msg").value.length + " / 4000"; });
  // Send
  $("#cm-send").addEventListener("click", async () => {
    const segment = $("#cm-segment").value;
    const message = $("#cm-msg").value.trim();
    if (!segment || !message) { toast("Pick a segment and write a message.", { err: true }); return; }
    const segText = $("#cm-segment").options[$("#cm-segment").selectedIndex].text;
    if (!confirm("Send this broadcast to: " + segText + " ?\n\nThis cannot be undone.")) return;
    $("#cm-send").disabled = true;
    $("#cm-send").textContent = "Sending&#x2026;";
    try {
      const r = await api("/broadcasts", { method: "POST", body: JSON.stringify({ segment, message, parse_mode: "Markdown" }) });
      toast("Broadcast: " + r.broadcast.delivered + "/" + r.broadcast.total + " delivered" + (r.broadcast.failed ? " (" + r.broadcast.failed + " failed)" : ""));
      $("#cm-msg").value = "";
      $("#cm-count").textContent = "0 / 4000";
      loadHistory();
    } catch (e) { toast(e.message, { err: true }); }
    finally { $("#cm-send").disabled = false; $("#cm-send").textContent = "&#x1F4E2; Send broadcast"; }
  });
  async function loadHistory() {
    try {
      const r = await api("/broadcasts?limit=30");
      $("#cm-history").innerHTML = r.broadcasts.length === 0
        ? '<p class="empty">No broadcasts sent yet.</p>'
        : '<table><thead><tr><th>When</th><th>Segment</th><th>Sent by</th><th>Delivered</th><th>Failed</th><th>Message preview</th></tr></thead><tbody>'
          + r.broadcasts.map((b) => '<tr><td>' + escapeHtml(fmtTs(b.sent_at)) + "</td>"
              + "<td>" + escapeHtml(b.segment) + "</td>"
              + "<td>" + escapeHtml(b.sent_by) + "</td>"
              + "<td><strong>" + fmtNum(b.delivered) + "</strong> / " + fmtNum(b.total) + "</td>"
              + "<td>" + (b.failed > 0 ? '<span class="pill revoked">' + b.failed + "</span>" : "<span style=\"color:#666\">0</span>") + "</td>"
              + '<td style="max-width:380px;color:var(--muted);font-size:11px;word-break:break-word">' + escapeHtml(b.message.slice(0,180)) + (b.message.length > 180 ? "&#x2026;" : "") + "</td>"
              + "</tr>").join("")
          + "</tbody></table>";
    } catch (err) { $("#cm-history").innerHTML = '<p class="empty">' + escapeHtml(err.message) + "</p>"; }
  }
  loadHistory();
}

// &#x2500;&#x2500; Live activity feed (subscribed once globally) &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
const liveFeed = { events: [], lastId: 0, source: null, maxKeep: 100 };
function startLiveFeed() {
  if (liveFeed.source) return;
  try {
    const otp = sessionStorage.getItem("admin_otp");
    // EventSource can't set headers &#x2014; for the SSE we rely on BasicAuth
    // cookies and the OTP being already established via prior /api/
    // calls. If 2FA is on AND the operator hasn't unlocked it yet, the
    // SSE 401s; we silently retry on the next nav.
    const url = "/admin/api/events?since=" + liveFeed.lastId;
    liveFeed.source = new EventSource(url, { withCredentials: true });
    liveFeed.source.addEventListener("admin", (e) => {
      try {
        const ev = JSON.parse(e.data);
        liveFeed.lastId = Math.max(liveFeed.lastId, ev.id);
        liveFeed.events.unshift(ev);
        if (liveFeed.events.length > liveFeed.maxKeep) liveFeed.events.length = liveFeed.maxKeep;
        renderLiveFeedWidget();
      } catch (_) {}
    });
    liveFeed.source.addEventListener("hello", () => {});
    liveFeed.source.onerror = () => {
      // Drop + retry on next route (cheap exponential-ish backoff)
      try { liveFeed.source.close(); } catch (_) {}
      liveFeed.source = null;
      setTimeout(startLiveFeed, 5000);
    };
  } catch (_) { liveFeed.source = null; }
}
function eventIcon(t) {
  return ({ signup:"&#x1F195;", order_created:"&#x1F4E6;", order_paid:"&#x1F4B0;", order_cancelled:"&#x1F6AB;",
            license_issued:"&#x1F39F;&#xFE0F;", license_revoked:"&#x26D4;", crypoverse_paid:"&#x1F4B3;",
            crypoverse_failed:"&#x274C;", team_created:"&#x1F465;", broadcast_sent:"&#x1F4E2;",
            system_error:"&#x1F6A8;" }[t]) || "&#x2022;";
}
function renderLiveFeedWidget() {
  const widget = $("#live-feed");
  if (!widget) return;
  widget.innerHTML = liveFeed.events.length === 0
    ? '<p class="empty">Waiting for live events&#x2026;</p>'
    : '<ul style="list-style:none;padding:0;margin:0;max-height:380px;overflow-y:auto">'
      + liveFeed.events.slice(0, 30).map((ev) => {
          const handle = ev.payload.customer_telegram ? "@" + String(ev.payload.customer_telegram).replace(/^@/, "") : "";
          const detail = (ev.type === "order_paid" || ev.type === "crypoverse_paid")
              ? handle + " &#xB7; " + (ev.payload.amount_usd ? "$" + ev.payload.amount_usd : "")
              : ev.type === "order_created"
                ? handle + " &#xB7; " + (ev.payload.interval || "") + " &#xB7; " + (ev.payload.amount_usd ? "$" + ev.payload.amount_usd : "") + " &#xB7; " + (ev.payload.method || "")
                : ev.type === "broadcast_sent"
                  ? ev.payload.segment + " &#xB7; " + ev.payload.delivered + "/" + ev.payload.total
                  : JSON.stringify(ev.payload).slice(0,80);
          return '<li style="padding:8px 10px;border-bottom:1px solid rgba(255,255,255,0.05);display:flex;gap:10px;align-items:center;font-size:12px">'
            + '<span style="font-size:18px">' + eventIcon(ev.type) + "</span>"
            + '<div style="flex:1"><strong>' + escapeHtml(ev.type.replaceAll("_", " ")) + "</strong> <span style=\"color:var(--muted)\">" + escapeHtml(detail) + "</span></div>"
            + '<span style="color:var(--muted);font-size:11px">' + fmtRel(ev.ts) + "</span>"
            + "</li>";
        }).join("")
      + "</ul>";
}
// Live feed widget is appended directly inside the renderOverview body.

// &#x2500;&#x2500; 2FA wizard (rendered inside Settings via injection) &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
async function append2faCard() {
  try {
    const status = await api("/2fa/status");
    const wrap = $("#settings-wrap");
    if (!wrap) return;
    const card = document.createElement("section");
    card.className = "card";
    card.innerHTML =
        '<h2>Two-factor authentication (TOTP)</h2>'
      + (status.enabled
          ? '<p style="color:var(--muted);margin-bottom:14px"><span class="pill valid">ENABLED</span> Admin requests must include a 6-digit OTP in the <code>X-Admin-OTP</code> header. The dashboard prompts for it after login and caches it for the tab.</p>'
            + '<div><input id="tfa-disable-code" placeholder="6-digit code" maxlength="6" style="background:var(--bg);color:var(--text);padding:8px 12px;border-radius:7px;border:1px solid var(--border)" /> <button class="danger" id="tfa-disable">Disable 2FA</button></div>'
          : '<p style="color:var(--muted);margin-bottom:14px"><span class="pill revoked">OFF</span> Recommended for production. Once enabled, BasicAuth alone is no longer enough &#x2014; every admin call must also carry a current 6-digit TOTP code.</p>'
            + '<button id="tfa-setup">&#x2699;&#xFE0F; Set up 2FA now</button>'
            + '<div id="tfa-wizard" hidden style="margin-top:18px"></div>');
    wrap.appendChild(card);
    if (status.enabled) {
      $("#tfa-disable").addEventListener("click", async () => {
        const code = $("#tfa-disable-code").value.trim();
        if (!/^\d{6}$/.test(code)) { toast("Need a 6-digit code", { err: true }); return; }
        if (!confirm("Disable 2FA? Future admin requests will require only BasicAuth.")) return;
        try {
          await api("/2fa/disable", { method: "POST", body: JSON.stringify({ code }) });
          toast("2FA disabled");
          sessionStorage.removeItem("admin_otp");
          renderSettings();
        } catch (e) { toast(e.message, { err: true }); }
      });
    } else {
      $("#tfa-setup").addEventListener("click", async () => {
        try {
          const s = await api("/2fa/setup", { method: "POST", body: "{}" });
          const w = $("#tfa-wizard");
          w.hidden = false;
          w.innerHTML =
              '<div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start">'
            +   '<img src="' + escapeHtml(s.qr_url) + '" alt="TOTP QR" style="border-radius:8px;background:#fff;padding:6px" />'
            +   '<div style="flex:1;min-width:280px">'
            +     '<p style="margin-top:0">1) Scan this QR with Google Authenticator / Authy / 1Password / Bitwarden, or type the secret manually:</p>'
            +     '<code style="background:var(--bg);padding:8px;border-radius:6px;display:block;font-size:13px;letter-spacing:2px;word-break:break-all">' + escapeHtml(s.secret) + "</code>"
            +     '<p style="margin-top:14px">2) Enter the current 6-digit code to confirm + enable:</p>'
            +     '<div style="display:flex;gap:8px"><input id="tfa-enable-code" placeholder="123456" maxlength="6" style="background:var(--bg);color:var(--text);padding:8px 12px;border-radius:7px;border:1px solid var(--border);font-family:ui-monospace,monospace;letter-spacing:4px;font-size:14px" /> <button id="tfa-enable">Enable</button></div>'
            +   "</div>"
            + "</div>";
          $("#tfa-enable").addEventListener("click", async () => {
            const code = $("#tfa-enable-code").value.trim();
            if (!/^\d{6}$/.test(code)) { toast("Need a 6-digit code", { err: true }); return; }
            try {
              await api("/2fa/enable", { method: "POST", body: JSON.stringify({ secret: s.secret, code }) });
              toast("&#x2705; 2FA enabled &#x2014; keep your authenticator app safe!");
              sessionStorage.setItem("admin_otp", code);
              renderSettings();
            } catch (e) { toast(e.message, { err: true }); }
          });
        } catch (e) { toast(e.message, { err: true }); }
      });
    }
  } catch (_) {}
}
// 2FA card is appended directly inside the renderSettings body.
// api() handles OTP injection inline (see its body &#x2014; reads sessionStorage
// and on otp_required prompts + retries once).

// &#x1F4BC; Payments — wallets balance, settlements unified history, provider config.
async function renderPayments() {
  const view = $("#view");
  view.innerHTML = '<h1 class="page">Payments</h1>'
    + '<div id="pay-cfg"><p class="empty">Loading config&#x2026;</p></div>'
    + '<section class="card"><h2>On-chain wallets</h2><div id="pay-wallets"><p class="empty">Fetching live balances&#x2026;</p></div></section>'
    + '<section class="card"><h2>Settlement history</h2>'
    +   '<div style="margin-bottom:10px;color:var(--muted);font-size:12px">Unified ledger across on-chain + Crypoverse. Most recent first.</div>'
    +   '<div id="pay-settlements"><p class="empty">Loading&#x2026;</p></div>'
    + '</section>';
  // 1. Config
  try {
    const cfg = await api("/payments/config");
    const okBadge = (v) => v ? '<span class="pill valid">ON</span>' : '<span class="pill revoked">OFF</span>';
    $("#pay-cfg").innerHTML =
      '<div class="kpi-grid">'
      + kpi("On-chain", cfg.providers.onchain_enabled ? "ENABLED" : "off", cfg.providers.onchain_wallets_configured + " wallets")
      + kpi("Crypoverse", cfg.providers.crypoverse_enabled ? "ENABLED" : "off", cfg.providers.crypoverse_listeners_active + " listeners")
      + kpi("Monthly", "$" + cfg.plan_prices_usd.monthly)
      + kpi("Annual", "$" + cfg.plan_prices_usd.annual)
      + kpi("Lifetime", "$" + cfg.plan_prices_usd.lifetime)
      + kpi("Poll interval", cfg.poller_interval_seconds + "s", "on-chain")
      + '</div>'
      + '<section class="card"><h2>Provider env config</h2><table>'
      +   "<tr><th>BTC_WALLET_ADDRESS</th><td>" + okBadge(cfg.env.btc_wallet_set) + "</td></tr>"
      +   "<tr><th>LTC_WALLET_ADDRESS</th><td>" + okBadge(cfg.env.ltc_wallet_set) + "</td></tr>"
      +   "<tr><th>ETH_WALLET_ADDRESS</th><td>" + okBadge(cfg.env.eth_wallet_set) + "</td></tr>"
      +   "<tr><th>ETHERSCAN_API_KEY</th><td>" + okBadge(cfg.env.etherscan_api_key) + ' <span style="color:var(--muted);font-size:11px">(optional &#x2014; fallback Blockcypher)</span></td></tr>'
      +   "<tr><th>CRYPOVERSE_API_KEY</th><td>" + okBadge(cfg.env.crypoverse_api_key) + "</td></tr>"
      + "</table><p style=\"color:var(--muted);font-size:11px;margin-top:10px\">Wallet addresses + API keys are env-only: <code>fly secrets set KEY=value</code> followed by a deploy. Prices are hard-coded; runtime changes via Settings &#x2192; default_trial_days etc.</p></section>";
  } catch (err) { $("#pay-cfg").innerHTML = '<p class="empty">' + escapeHtml(err.message) + "</p>"; }

  // 2. Wallets with live balance
  try {
    const data = await api("/payments/wallets");
    if (!data.wallets.length) {
      $("#pay-wallets").innerHTML = '<p class="empty">No on-chain wallets configured. Set <code>BTC_WALLET_ADDRESS</code>, <code>LTC_WALLET_ADDRESS</code> and/or <code>ETH_WALLET_ADDRESS</code> as Fly secrets and redeploy.</p>';
    } else {
      $("#pay-wallets").innerHTML = '<div style="display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))">'
        + data.wallets.map((w) =>
            '<div style="border:1px solid var(--border);border-radius:10px;padding:16px;background:var(--bg)">'
            +   '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">'
            +     '<div><strong style="font-size:16px">' + escapeHtml(w.currency) + '</strong> <span style="color:var(--muted);font-size:11px">'+ w.min_confirmations + ' conf needed</span></div>'
            +     (w.error ? '<span class="pill revoked">' + escapeHtml(w.error) + '</span>' : '<span class="pill valid">live</span>')
            +   '</div>'
            +   '<div style="text-align:center;margin-bottom:12px">'
            +     '<img src="' + escapeHtml(w.qr_url) + '" alt="QR ' + w.currency + '" style="background:#fff;padding:8px;border-radius:8px;max-width:180px" />'
            +   '</div>'
            +   '<div class="mono" style="font-size:10px;word-break:break-all;background:var(--panel);padding:8px;border-radius:6px;margin-bottom:10px">' + escapeHtml(w.address) + '</div>'
            +   '<div style="display:flex;justify-content:space-between;font-size:12px">'
            +     '<span style="color:var(--muted)">Balance</span>'
            +     '<strong>' + escapeHtml(w.balance_formatted) + ' ' + escapeHtml(w.currency) + '</strong>'
            +   '</div>'
            +   (w.usd_value != null ? '<div style="display:flex;justify-content:space-between;font-size:12px;margin-top:4px"><span style="color:var(--muted)">USD value</span><strong>' + fmtUsd(w.usd_value) + '</strong></div>' : '')
            +   '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:8px"><span>tx count</span><span>' + fmtNum(w.tx_count) + '</span></div>'
            +   '<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-top:4px"><span>updated</span><span>' + escapeHtml(fmtRel(w.fetched_at)) + '</span></div>'
            + '</div>',
          ).join("")
        + '</div>'
        + '<p style="color:var(--muted);font-size:11px;margin-top:14px">Balances cached for 60s. Click <button class="ghost" id="pay-refresh">&#x21BB; Refresh now</button> to force-fetch.</p>';
      $("#pay-refresh")?.addEventListener("click", renderPayments);
    }
  } catch (err) { $("#pay-wallets").innerHTML = '<p class="empty">' + escapeHtml(err.message) + "</p>"; }

  // 3. Settlements unified history
  try {
    const r = await api("/payments/settlements?limit=100");
    if (!r.settlements.length) {
      $("#pay-settlements").innerHTML = '<p class="empty">No paid settlements yet.</p>';
    } else {
      const total = r.settlements.reduce((s, x) => s + (x.amount_usd || 0), 0);
      $("#pay-settlements").innerHTML =
        '<div style="margin-bottom:10px"><strong>' + r.settlements.length + '</strong> paid settlements &#xB7; total <strong>' + fmtUsd(total) + '</strong></div>'
        + '<table><thead><tr><th>When</th><th>Source</th><th>Order</th><th>Customer</th><th>Plan</th><th>Amount</th><th>Currency</th><th>Tx hash</th></tr></thead><tbody>'
        + r.settlements.map((s) => {
            const explorer = s.tx_hash
              ? (s.currency === "BTC" ? "https://mempool.space/tx/" + s.tx_hash
                : s.currency === "LTC" ? "https://litecoinspace.org/tx/" + s.tx_hash
                : s.currency === "ETH" ? "https://etherscan.io/tx/" + s.tx_hash
                : null)
              : null;
            const txCell = s.tx_hash
              ? (explorer
                  ? '<a class="link mono" href="' + escapeHtml(explorer) + '" target="_blank" rel="noopener" style="font-size:11px">' + escapeHtml(s.tx_hash.slice(0,16)) + "&#x2026;</a>"
                  : '<span class="mono" style="font-size:11px">' + escapeHtml(s.tx_hash.slice(0,20)) + "&#x2026;</span>")
              : '<span style="color:#666">&#x2014;</span>';
            return '<tr><td>' + escapeHtml(fmtTs(s.ts)) + "</td>"
              + '<td>' + (s.source === "crypoverse" ? '<span class="pill" style="background:rgba(255,87,34,0.15);color:#ff8a5c">&#x1F4B3; Crypoverse</span>' : '<span class="pill" style="background:rgba(150,150,150,0.2);color:#aaa">&#x26D3;&#xFE0F; on-chain</span>') + "</td>"
              + '<td class="mono">' + escapeHtml(s.order_id) + "</td>"
              + "<td>" + (s.customer_telegram ? "@" + escapeHtml(s.customer_telegram.replace(/^@/, "")) : '<span style="color:#666">&#x2014;</span>') + "</td>"
              + "<td>" + escapeHtml(s.interval) + "</td>"
              + "<td><strong>" + fmtUsd(s.amount_usd) + "</strong></td>"
              + "<td>" + escapeHtml(s.currency) + "</td>"
              + "<td>" + txCell + "</td>"
              + "</tr>";
          }).join("")
        + "</tbody></table>";
    }
  } catch (err) { $("#pay-settlements").innerHTML = '<p class="empty">' + escapeHtml(err.message) + "</p>"; }
}

function renderComingSoon(name) { return function () { $("#view").innerHTML = '<h1 class="page">' + escapeHtml(name) + '</h1><section class="card"><p class="empty">Coming in the next iteration of the dashboard.</p></section>'; }; }

// &#x2500;&#x2500; action bindings (delegated) &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
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

// &#x2500;&#x2500; Search (global, debounced) &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
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
      if (r.customers.length) sections.push('<div class="group">Customers</div>' + r.customers.map((c) => '<a href="#customers/' + escapeHtml(c.id) + '"><strong>' + (c.telegram ? "@" + escapeHtml(c.telegram.replace(/^@/, "")) : escapeHtml(c.email || c.id)) + '</strong> <span class="meta">' + escapeHtml(c.id) + " &#xB7; " + escapeHtml(c.approval_status) + "</span></a>").join(""));
      if (r.orders.length) sections.push('<div class="group">Orders</div>' + r.orders.map((o) => '<a href="#orders"><strong class="mono">' + escapeHtml(o.id) + '</strong> <span class="meta">' + escapeHtml(o.interval) + " &#xB7; " + escapeHtml(o.status) + (o.customer_telegram ? " &#xB7; " + escapeHtml(o.customer_telegram) : "") + "</span></a>").join(""));
      if (r.licenses.length) sections.push('<div class="group">Licenses</div>' + r.licenses.map((l) => '<a href="#customers/' + escapeHtml(l.customer_id) + '"><strong class="mono">' + escapeHtml(l.id) + '</strong> <span class="meta">' + escapeHtml(l.interval) + (l.revoked_at ? " &#xB7; revoked" : "") + "</span></a>").join(""));
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

// &#x2500;&#x2500; Mini chart (canvas, no deps) &#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;&#x2500;
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
    tip.innerHTML = "<strong>" + p.day + "</strong><br>" + fmtUsd(p.revenue_usd) + " &#xB7; " + p.orders + " orders";
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

  // 2FA gate (optional — only kicks in once enabled in Settings). The SPA
  // shell, 2FA setup/disable endpoints, and the OTP-status probe are
  // whitelisted so the operator can always recover access through the
  // browser UI. Everything else under /admin/api/* requires the OTP if
  // 2FA is on. The OTP travels in the `X-Admin-OTP` header; the
  // dashboard prompts for it after BasicAuth and caches in sessionStorage.
  r.use("/api/*", async (c, next) => {
    const secret = getEnabledSecret()
    if (!secret) return next() // 2FA disabled
    const path = c.req.path
    // Exempt the endpoints needed to disable/probe 2FA so a misconfigured
    // device can't lock the operator out forever.
    if (path.endsWith("/2fa/status") || path.endsWith("/2fa/disable")) return next()
    const otp = c.req.header("x-admin-otp") ?? ""
    if (!otp || !verifyTotpCode(secret, otp)) {
      return c.json({ error: "otp_required", code_expected: 6 }, 401)
    }
    await next()
  })

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
    // Direct SQL — paginate raw customers ordered by signup time.
    // (getDb is imported statically so the single-file Bun build doesn't
    // trip on require() against modules with top-level await.)
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

  // ── Step 2: Crypoverse invoices ────────────────────────────────
  r.get("/api/crypoverse/stats", (c) => c.json(getCrypoverseStats()))

  r.get("/api/crypoverse/invoices", (c) => {
    const limit = Number.parseInt(c.req.query("limit") ?? "100", 10) || 100
    const status = c.req.query("status") ?? "all"
    const query = c.req.query("q") ?? ""
    return c.json({
      invoices: listInvoicesForAdmin({ limit, status, query }),
    })
  })

  r.get("/api/crypoverse/invoices/:tx", (c) => {
    const tx = c.req.param("tx")
    const inv = getCrypoverseInvoice(tx)
    if (!inv) return c.json({ error: "not_found" }, 404)
    // Pretty-print the last event payload if it's valid JSON so the
    // dashboard can render it nicely.
    let last_event_parsed: unknown = null
    if (inv.last_event_payload) {
      try {
        last_event_parsed = JSON.parse(inv.last_event_payload)
      } catch {
        last_event_parsed = inv.last_event_payload
      }
    }
    return c.json({ ...inv, last_event_parsed })
  })

  r.post("/api/crypoverse/invoices/:tx/retry", (c) => {
    const tx = c.req.param("tx")
    const result = crypoverseRetryListener(tx)
    return c.json(result)
  })

  // ── Step 2: Teams ──────────────────────────────────────────────
  r.get("/api/teams", (c) => {
    const limit = Number.parseInt(c.req.query("limit") ?? "200", 10) || 200
    return c.json({ teams: listAllTeamsForAdmin(limit) })
  })

  r.get("/api/teams/:id", (c) => {
    const id = c.req.param("id")
    const d = getTeamDetailForAdmin(id)
    if (!d) return c.json({ error: "not_found" }, 404)
    return c.json(d)
  })

  r.post("/api/teams/:id/transfer", async (c) => {
    const id = c.req.param("id")
    const body = (await c.req.json().catch(() => ({}))) as { new_owner_customer_id?: string }
    if (!body.new_owner_customer_id) return c.json({ error: "missing_new_owner_customer_id" }, 400)
    try {
      const team = transferOwnershipAsAdmin(id, body.new_owner_customer_id)
      return c.json({ ok: true, team })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  // ── Step 2: System health ──────────────────────────────────────
  r.get("/api/health", (c) => c.json(getSystemHealth()))

  // ── Step 3: Bulk actions ───────────────────────────────────────
  r.post("/api/licenses/bulk-revoke", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: string[]; reason?: string }
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return c.json({ error: "missing_ids" }, 400)
    }
    return c.json(bulkRevokeLicenses(body.ids, body.reason ?? null))
  })

  r.post("/api/orders/bulk-cancel", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: string[] }
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return c.json({ error: "missing_ids" }, 400)
    }
    return c.json(bulkCancelOrders(body.ids))
  })

  r.post("/api/customers/bulk-approve", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: string[]; trial_days?: number }
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return c.json({ error: "missing_ids" }, 400)
    }
    const days = Math.max(1, Math.min(365, Number(body.trial_days ?? 7)))
    const ok: string[] = []
    const errors: Array<{ id: string; error: string }> = []
    for (const id of body.ids) {
      try {
        const r = approveCustomer(id, { trialDays: days, approvedBy: "admin-panel:bulk" })
        if (r) ok.push(id)
        else errors.push({ id, error: "customer_not_found" })
      } catch (err) {
        errors.push({ id, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return c.json({ ok, errors, trial_days: days })
  })

  // ── Step 3: Settings ───────────────────────────────────────────
  // GET returns the editable settings table joined with the in-code
  // defaults so the UI can render a 'Reset to default' button when
  // the operator has overridden a value.
  r.get("/api/settings", (c) => {
    const rows = listAppSettings()
    const byKey: Record<string, { value: string; updated_at: number; updated_by: string | null }> = {}
    for (const r2 of rows) {
      byKey[r2.key] = { value: r2.value, updated_at: r2.updated_at, updated_by: r2.updated_by }
    }
    // Editable settings catalogue — keep in sync with whatever code reads
    // via getAppSetting(). Each entry declares its default + type + a
    // human-readable description for the dashboard.
    const catalogue = [
      {
        key: "default_trial_days",
        type: "number" as const,
        default: 7,
        description: "Trial length (days) granted when an admin approves a new signup without specifying.",
      },
      {
        key: "signup_approval_required",
        type: "boolean" as const,
        default: true,
        description: "If false, new signups skip the approval queue and start their trial immediately.",
      },
      {
        key: "maintenance_mode",
        type: "boolean" as const,
        default: false,
        description: "Shows a 'maintenance' banner across all client surfaces. Does not block requests.",
      },
      {
        key: "maintenance_message",
        type: "string" as const,
        default: "Manutenzione programmata. Tornerà tutto online tra poco.",
        description: "Message shown when maintenance_mode is on.",
      },
    ]
    return c.json({
      catalogue: catalogue.map((entry) => ({
        ...entry,
        current_value: byKey[entry.key]?.value ?? null,
        updated_at: byKey[entry.key]?.updated_at ?? null,
        updated_by: byKey[entry.key]?.updated_by ?? null,
      })),
      // Read-only settings (env-backed, plan prices, admin user ids count) —
      // surfaced so the operator sees the full picture, can't be edited
      // here (they'd need a redeploy with new secrets/code).
      env_readonly: {
        plan_prices_usd: { monthly: 20, annual: 200, lifetime: 500 },
        admin_user_ids_count: ((process.env.TELEGRAM_ADMIN_USER_IDS ?? "").split(/[,\s]+/).filter(Boolean).length)
          + (process.env.OPENCODE_ADMIN_CHAT_ID ? 1 : 0),
        crypoverse_enabled: Boolean(process.env.CRYPOVERSE_API_KEY),
        sentry_enabled: Boolean(process.env.SENTRY_DSN),
        backup_enabled: Boolean(
          process.env.S3_BUCKET || process.env.AWS_S3_BUCKET || process.env.LICENSE_BACKUP_BUCKET,
        ),
      },
    })
  })

  r.put("/api/settings/:key", async (c) => {
    const key = c.req.param("key")
    const body = (await c.req.json().catch(() => ({}))) as { value?: unknown }
    if (body.value === undefined) return c.json({ error: "missing_value" }, 400)
    try {
      // Stringify booleans/numbers consistently — the getter parses them
      // back to the correct type based on the in-code default's type.
      const v =
        typeof body.value === "object" && body.value !== null
          ? (body.value as object)
          : (String(body.value) as string)
      setAppSetting(key, v, "admin-panel")
      return c.json({ ok: true, key, value: v })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  // ── Step 3: Audit log (advanced) ───────────────────────────────
  r.get("/api/audit", (c) => {
    // Bind to keep `this` pointing at c.req — Hono's c.req.query is a
    // method, plain destructuring loses the binding and throws
    // "undefined is not an object (this.url)".
    const q = c.req.query.bind(c.req)
    return c.json(
      listAuditAdvanced({
        actor: q("actor") || undefined,
        action: q("action") || undefined,
        since: q("since") ? Number(q("since")) : undefined,
        until: q("until") ? Number(q("until")) : undefined,
        query: q("q") || undefined,
        limit: q("limit") ? Number(q("limit")) : 100,
        offset: q("offset") ? Number(q("offset")) : 0,
      }),
    )
  })

  r.get("/api/audit/export.csv", (c) => {
    const q = c.req.query.bind(c.req)
    const csv = audtCsvExport({
      actor: q("actor") || undefined,
      action: q("action") || undefined,
      since: q("since") ? Number(q("since")) : undefined,
      until: q("until") ? Number(q("until")) : undefined,
      query: q("q") || undefined,
    })
    c.header("Content-Type", "text/csv; charset=utf-8")
    c.header("Content-Disposition", 'attachment; filename="audit-' + new Date().toISOString().slice(0, 10) + '.csv"')
    return c.body(csv)
  })

  // ── Step 4: Communications broadcasts ─────────────────────────
  r.get("/api/broadcasts/segments", (c) => c.json({ segments: listSegmentSizes() }))

  r.get("/api/broadcasts", (c) => {
    const limit = Number.parseInt(c.req.query("limit") ?? "50", 10) || 50
    return c.json({ broadcasts: listBroadcasts(limit) })
  })

  r.post("/api/broadcasts", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      segment?: string
      message?: string
      parse_mode?: "Markdown" | "HTML" | null
    }
    if (!body.segment || !body.message) return c.json({ error: "missing_segment_or_message" }, 400)
    if (body.message.length > 4000) return c.json({ error: "message_too_long_max_4000" }, 400)
    try {
      const row = await sendBroadcast({
        segment: body.segment as BroadcastSegment,
        message: body.message,
        parse_mode: body.parse_mode === "HTML" ? null : "Markdown",
        sent_by: "admin-panel",
      })
      emitAdminEvent("broadcast_sent", {
        segment: row.segment,
        total: row.total,
        delivered: row.delivered,
        failed: row.failed,
      })
      return c.json({ ok: true, broadcast: row })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    }
  })

  // ── Step 4: Live SSE feed ─────────────────────────────────────
  r.get("/api/events", (c) => {
    const since = Number(c.req.query("since") ?? "0") || 0
    // Build a manual SSE stream — Hono lets us return a ReadableStream
    // with the right text/event-stream headers + we own the lifecycle.
    let unsubscribe: () => void = () => undefined
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        const write = (chunk: string) => {
          try {
            controller.enqueue(enc.encode(chunk))
          } catch {
            // controller already closed (client disconnected) — clean up
            unsubscribe()
          }
        }
        // Backfill from buffer + subscribe to live
        unsubscribe = subscribeAdminEvents((ev) => {
          write("event: admin\ndata: " + JSON.stringify(ev) + "\n\n")
        }, since)
        // Keepalive every 25s so intermediaries (Cloudflare, Caddy) don't
        // drop the idle connection. SSE comments are `: text\n\n` and
        // browsers ignore them.
        const ka = setInterval(() => write(": keepalive\n\n"), 25_000)
        // Initial hello to flush headers
        write("event: hello\ndata: " + JSON.stringify({ ts: Math.floor(Date.now() / 1000) }) + "\n\n")
        ;(controller as ReadableStreamDefaultController<Uint8Array> & { _ka?: NodeJS.Timeout })._ka = ka
      },
      cancel() {
        unsubscribe()
      },
    })
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    })
  })

  r.get("/api/events/recent", (c) => {
    const limit = Math.max(1, Math.min(200, Number.parseInt(c.req.query("limit") ?? "30", 10) || 30))
    return c.json({ events: getRecentEvents(limit) })
  })

  // ── Step 4: TOTP 2FA ──────────────────────────────────────────
  r.get("/api/2fa/status", (c) => c.json({ enabled: is2faEnabled() }))

  r.post("/api/2fa/setup", (c) => {
    // Generate a fresh secret to display. Not persisted yet — the
    // operator confirms by submitting the first valid code via /enable.
    const secret = generateTotpSecret()
    return c.json({
      secret,
      otpauth_url: otpauthUrl(secret, "admin"),
      qr_url:
        "https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=" +
        encodeURIComponent(otpauthUrl(secret, "admin")),
    })
  })

  r.post("/api/2fa/enable", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { secret?: string; code?: string }
    if (!body.secret || !body.code) return c.json({ error: "missing_secret_or_code" }, 400)
    const result = enable2fa(body.secret, body.code, "admin-panel")
    if (!result.ok) return c.json({ error: result.reason ?? "enable_failed" }, 400)
    return c.json({ ok: true, enabled: true })
  })

  r.post("/api/2fa/disable", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { code?: string }
    if (!body.code) return c.json({ error: "missing_code" }, 400)
    const result = disable2fa(body.code, "admin-panel")
    if (!result.ok) return c.json({ error: result.reason ?? "disable_failed" }, 400)
    return c.json({ ok: true, enabled: false })
  })

  // ── Step Final: Payments dashboard (wallets + settlements + config) ──
  r.get("/api/payments/wallets", async (c) => {
    const wallets = await getWalletsWithBalance()
    return c.json({ wallets })
  })

  r.get("/api/payments/settlements", (c) => {
    const limit = Math.max(1, Math.min(500, Number.parseInt(c.req.query("limit") ?? "100", 10) || 100))
    return c.json({ settlements: getSettlementHistory(limit) })
  })

  r.get("/api/payments/config", (c) => c.json(getPaymentConfig()))

  return r
}
