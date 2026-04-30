/**
 * /admin — single-page web dashboard for managing API keys, viewing
 * live usage statistics, configuring webhooks, and inspecting recent
 * deliveries.
 *
 * Auth: Basic auth (username "admin", password = $ADMIN_PASSWORD).
 * If $ADMIN_PASSWORD is unset the entire /admin tree returns 503.
 *
 * UX:
 *   /admin              dashboard SPA (vanilla JS, single HTML file)
 *   /admin/api/*        JSON API the SPA consumes (also useful for
 *                       scripting from CLI / Ansible / Terraform)
 *
 * The HTML is one file with inline CSS + JS so deployments don't need
 * a build step or a static asset server. Total size <30 KB.
 */
import { Hono } from "hono"
import { basicAuth } from "hono/basic-auth"
import { randomBytes } from "node:crypto"
import { getDb } from "./db.ts"
import { signJwt } from "./auth.ts"
import { listWebhooks, createWebhook, deleteWebhook, toggleWebhook, recentDeliveries } from "./webhooks.ts"
import { resetCurrentPeriod, getQuotaStatus } from "./quota.ts"
import { getProviderStats } from "./upstream.ts"

export function adminRouter() {
  const r = new Hono()
  const password = process.env.ADMIN_PASSWORD ?? ""

  // Hard gate — if no password is set, every /admin request is refused
  // with a clear message instead of letting the operator footgun.
  r.use("*", async (c, next) => {
    if (!password) {
      return c.json(
        {
          error: {
            message: "/admin disabled. Set ADMIN_PASSWORD env to enable the dashboard.",
            type: "config",
          },
        },
        503,
      )
    }
    await next()
  })

  r.use("*", basicAuth({ username: "admin", password }))

  // ── HTML SPA ────────────────────────────────────────────────────
  r.get("/", (c) => c.html(DASHBOARD_HTML))

  // ── JSON API ────────────────────────────────────────────────────
  r.get("/api/stats", (c) => {
    const db = getDb()
    const now = Date.now()
    const dayMs = 86_400_000
    const total = db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM usage").get()!.c
    const last24 = db.query<{ c: number }, [number]>("SELECT COUNT(*) AS c FROM usage WHERE ts > ?").get(now - dayMs)!.c
    const last7 = db.query<{ c: number }, [number]>("SELECT COUNT(*) AS c FROM usage WHERE ts > ?").get(now - 7 * dayMs)!.c
    const errors = db
      .query<{ c: number }, [number]>("SELECT COUNT(*) AS c FROM usage WHERE status >= 400 AND ts > ?")
      .get(now - dayMs)!.c
    const tokens = db
      .query<{ s: number | null }, [number]>(
        "SELECT SUM(COALESCE(prompt_tokens,0)+COALESCE(completion_tokens,0)) AS s FROM usage WHERE ts > ?",
      )
      .get(now - dayMs)!.s ?? 0
    const byModel = db
      .query<{ model: string; c: number; t: number | null }, [number]>(
        "SELECT model, COUNT(*) AS c, SUM(COALESCE(prompt_tokens,0)+COALESCE(completion_tokens,0)) AS t FROM usage WHERE ts > ? AND model IS NOT NULL GROUP BY model ORDER BY c DESC LIMIT 10",
      )
      .all(now - 7 * dayMs)
    const byKey = db
      .query<{ key_label: string; c: number; t: number | null }, [number]>(
        "SELECT key_label, COUNT(*) AS c, SUM(COALESCE(prompt_tokens,0)+COALESCE(completion_tokens,0)) AS t FROM usage WHERE ts > ? AND key_label IS NOT NULL GROUP BY key_label ORDER BY c DESC LIMIT 20",
      )
      .all(now - 7 * dayMs)
    return c.json({ total, last24, last7, errors, tokens24: tokens, byModel, byKey })
  })

  // Daily series (24 buckets of 1h) for the dashboard chart.
  r.get("/api/timeseries", (c) => {
    const db = getDb()
    const now = Date.now()
    const buckets: Array<{ hour: number; req: number; tok: number }> = []
    for (let i = 23; i >= 0; i--) {
      const start = now - (i + 1) * 3600_000
      const end = now - i * 3600_000
      const row = db
        .query<{ c: number; t: number | null }, [number, number]>(
          "SELECT COUNT(*) AS c, SUM(COALESCE(prompt_tokens,0)+COALESCE(completion_tokens,0)) AS t FROM usage WHERE ts >= ? AND ts < ?",
        )
        .get(start, end)!
      buckets.push({ hour: end, req: row.c, tok: row.t ?? 0 })
    }
    return c.json({ buckets })
  })

  // Provider pool stats — visibile in dashboard come la card "Backends"
  r.get("/api/providers", (c) => c.json(getProviderStats()))

  // Keys CRUD
  r.get("/api/keys", (c) => {
    const db = getDb()
    const rows = db
      .query(
        `SELECT id, kind, label, tenant_id, rpm, monthly_token_quota, monthly_request_quota,
                scopes, disabled, created_at, notes
         FROM keys ORDER BY id DESC`,
      )
      .all() as Array<Record<string, unknown>>
    // augment with current period usage
    return c.json({
      keys: rows.map((k) => {
        const q = getQuotaStatus(k.id as number)
        return {
          ...k,
          currentPeriod: q.current,
          history: q.history,
        }
      }),
    })
  })

  r.post("/api/keys", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      label: string
      kind?: "static" | "jwt"
      rpm?: number
      monthlyTokenQuota?: number
      monthlyRequestQuota?: number
      scopes?: string[]
      tenantId?: string
      notes?: string
    }
    if (!body.label) return c.json({ error: "label required" }, 400)
    const kind = body.kind ?? "static"
    const secret = kind === "static" ? `sk-${randomBytes(20).toString("hex")}` : null
    const db = getDb()
    const r2 = db.run(
      `INSERT INTO keys (kind, label, secret, tenant_id, rpm, monthly_token_quota, monthly_request_quota, scopes, created_at, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        kind,
        body.label,
        secret,
        body.tenantId ?? null,
        body.rpm ?? null,
        body.monthlyTokenQuota ?? null,
        body.monthlyRequestQuota ?? null,
        body.scopes?.join(",") ?? null,
        Date.now(),
        body.notes ?? null,
      ],
    )
    return c.json({ id: Number(r2.lastInsertRowid), secret })
  })

  r.patch("/api/keys/:id", async (c) => {
    const id = Number(c.req.param("id"))
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const allowed = ["label", "rpm", "monthly_token_quota", "monthly_request_quota", "scopes", "disabled", "notes", "tenant_id"]
    const sets: string[] = []
    const params: Array<string | number | null> = []
    for (const k of allowed) {
      if (k in body) {
        sets.push(`${k} = ?`)
        let v = body[k]
        if (k === "scopes" && Array.isArray(v)) v = (v as string[]).join(",")
        params.push(v as string | number | null)
      }
    }
    if (sets.length === 0) return c.json({ error: "no fields" }, 400)
    params.push(id)
    getDb().run(`UPDATE keys SET ${sets.join(", ")} WHERE id = ?`, params)
    return c.json({ ok: true })
  })

  r.delete("/api/keys/:id", (c) => {
    const id = Number(c.req.param("id"))
    getDb().run("DELETE FROM keys WHERE id = ?", [id])
    return c.json({ ok: true })
  })

  r.post("/api/keys/:id/reset-quota", (c) => {
    resetCurrentPeriod(Number(c.req.param("id")))
    return c.json({ ok: true })
  })

  // Issue a JWT linked to a key (for testing or one-shot tokens)
  r.post("/api/keys/:id/jwt", async (c) => {
    const id = Number(c.req.param("id"))
    const secret = process.env.JWT_SECRET
    if (!secret) return c.json({ error: "JWT_SECRET not configured" }, 503)
    const row = getDb().query<{ tenant_id: string | null; label: string }, [number]>("SELECT tenant_id, label FROM keys WHERE id = ?").get(id)
    if (!row) return c.json({ error: "not found" }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { expires_in?: number }
    const sub = row.tenant_id ?? `key-${id}`
    const token = signJwt({ sub, label: row.label }, secret, body.expires_in ?? 30 * 86400)
    return c.json({ token })
  })

  // Webhooks CRUD
  r.get("/api/webhooks", (c) => c.json({ webhooks: listWebhooks() }))
  r.post("/api/webhooks", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { url: string; event?: string; secret?: string; description?: string }
    if (!body.url) return c.json({ error: "url required" }, 400)
    const id = createWebhook(body)
    return c.json({ id })
  })
  r.delete("/api/webhooks/:id", (c) => {
    deleteWebhook(Number(c.req.param("id")))
    return c.json({ ok: true })
  })
  r.post("/api/webhooks/:id/toggle", (c) => {
    toggleWebhook(Number(c.req.param("id")))
    return c.json({ ok: true })
  })
  r.get("/api/webhooks/deliveries", (c) => c.json({ deliveries: recentDeliveries(100) }))

  return r
}

// ─── Inline HTML — vanilla, no build step ───────────────────────────────

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>CrimeOpus API · Admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0b0d12;color:#f0f0f5}
header{padding:14px 20px;border-bottom:1px solid #1f2230;background:linear-gradient(180deg,rgba(99,102,241,.07),transparent);display:flex;align-items:center;gap:12px}
header h1{margin:0;font-size:16px;font-weight:700;letter-spacing:.02em}
header span.tag{font-size:10px;background:#6366f1;color:#0b0d12;padding:2px 6px;border-radius:4px;font-weight:700;letter-spacing:.05em}
nav{display:flex;gap:6px;padding:0 20px;border-bottom:1px solid #1f2230;background:#10131c}
nav button{background:transparent;border:0;color:#9aa0b4;padding:10px 14px;font:inherit;font-weight:600;cursor:pointer;border-bottom:2px solid transparent}
nav button.active{color:#fff;border-bottom-color:#6366f1}
nav button:hover{color:#fff}
main{padding:20px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px}
.card{background:#141826;border:1px solid #1f2230;border-radius:8px;padding:14px}
.card .label{font-size:11px;color:#9aa0b4;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}
.card .value{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums}
.section{background:#141826;border:1px solid #1f2230;border-radius:8px;padding:16px;margin-bottom:16px}
.section h2{margin:0 0 12px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#9aa0b4}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #1f2230;vertical-align:top}
th{font-weight:600;color:#9aa0b4;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
tr:hover td{background:#181c2c}
button.btn{background:#6366f1;color:#fff;border:0;padding:7px 12px;border-radius:6px;cursor:pointer;font:inherit;font-weight:600}
button.btn:hover{filter:brightness(1.1)}
button.btn.danger{background:#ef4444}
button.btn.ghost{background:transparent;border:1px solid #2a2f44;color:#cfd0dc}
input,select{background:#0b0d12;border:1px solid #2a2f44;color:#f0f0f5;padding:7px 10px;border-radius:6px;font:inherit;width:100%}
.row{display:flex;gap:8px;align-items:center;margin-bottom:8px}
.flex{display:flex;gap:8px;flex-wrap:wrap}
.bar{height:6px;background:#1f2230;border-radius:3px;overflow:hidden;margin-top:4px}
.bar>span{display:block;height:100%;background:linear-gradient(90deg,#22c55e,#84cc16,#eab308,#ef4444);border-radius:3px}
.muted{color:#7a8092;font-size:11px}
code.k{font-family:ui-monospace,monospace;font-size:11px;background:#0b0d12;padding:2px 5px;border-radius:3px;border:1px solid #1f2230}
.toast{position:fixed;top:14px;right:14px;background:#22c55e;color:#0b0d12;padding:10px 16px;border-radius:6px;font-weight:600;animation:fade 4s forwards}
.toast.err{background:#ef4444;color:#fff}
@keyframes fade{0%{opacity:0;transform:translateX(20px)}5%,80%{opacity:1;transform:translateX(0)}100%{opacity:0}}
.chart{height:120px;display:flex;align-items:flex-end;gap:2px;border-bottom:1px solid #1f2230;padding-bottom:6px}
.chart .b{flex:1;background:linear-gradient(180deg,#6366f1,#4338ca);border-radius:2px 2px 0 0;min-height:2px;transition:height .2s}
.chart .b:hover{filter:brightness(1.3)}
.tag{display:inline-block;font-size:10px;font-weight:700;padding:2px 6px;border-radius:3px;letter-spacing:.05em;text-transform:uppercase;background:#2a2f44;color:#cfd0dc}
.tag.static{background:#22c55e;color:#0b0d12}
.tag.jwt{background:#a855f7;color:#fff}
.tag.disabled{background:#6b7280;color:#fff}
</style>
</head>
<body>
<header>
  <h1>CrimeOpus API</h1>
  <span class="tag">ADMIN</span>
  <span class="muted" id="connection">connecting…</span>
</header>
<nav>
  <button data-tab="overview" class="active">Overview</button>
  <button data-tab="keys">Keys & Quota</button>
  <button data-tab="webhooks">Webhooks</button>
  <button data-tab="deliveries">Deliveries</button>
</nav>
<main>
  <section id="overview"></section>
  <section id="keys" hidden></section>
  <section id="webhooks" hidden></section>
  <section id="deliveries" hidden></section>
</main>
<div id="toast-host"></div>
<script>
const API='/admin/api';
function toast(msg,err){const d=document.createElement('div');d.className='toast'+(err?' err':'');d.textContent=msg;document.getElementById('toast-host').appendChild(d);setTimeout(()=>d.remove(),4500)}
async function f(method,path,body){const r=await fetch(API+path,{method,headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});if(!r.ok){const e=await r.text();throw new Error(e||r.status)}return r.status===204?{}:r.json()}
function fmt(n){return n==null?'∞':n.toLocaleString()}
function pct(used,max){if(!max)return 0;return Math.min(100,Math.round(used/max*100))}
function ago(ts){const s=Math.round((Date.now()-ts)/1000);if(s<60)return s+'s';if(s<3600)return Math.round(s/60)+'m';if(s<86400)return Math.round(s/3600)+'h';return Math.round(s/86400)+'d'}

// Tab switching
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('nav button').forEach(x=>x.classList.toggle('active',x===b));
  document.querySelectorAll('main section').forEach(s=>s.hidden=s.id!==b.dataset.tab);
  render(b.dataset.tab);
});

// Renderers
async function renderOverview(){
  const root=document.getElementById('overview');
  try{
    const [s,t]=await Promise.all([f('GET','/stats'),f('GET','/timeseries')]);
    document.getElementById('connection').textContent='✓ connected';
    const max=Math.max(...t.buckets.map(b=>b.req),1);
    root.innerHTML=\`
      <div class="cards">
        <div class="card"><div class="label">Last 24h</div><div class="value">\${fmt(s.last24)}</div><div class="muted">\${fmt(s.tokens24)} tokens</div></div>
        <div class="card"><div class="label">Last 7 days</div><div class="value">\${fmt(s.last7)}</div></div>
        <div class="card"><div class="label">All-time</div><div class="value">\${fmt(s.total)}</div></div>
        <div class="card"><div class="label">Errors 24h</div><div class="value">\${fmt(s.errors)}</div></div>
      </div>
      <div class="section">
        <h2>Requests · last 24h (1h buckets)</h2>
        <div class="chart">\${t.buckets.map(b=>\`<div class="b" style="height:\${(b.req/max*100).toFixed(0)}%" title="\${new Date(b.hour).toLocaleTimeString()}: \${b.req} req · \${b.tok} tok"></div>\`).join('')}</div>
      </div>
      <div class="section">
        <h2>Top models · 7 days</h2>
        <table><thead><tr><th>Model</th><th>Requests</th><th>Tokens</th></tr></thead><tbody>
        \${(s.byModel||[]).map(r=>\`<tr><td><code class="k">\${r.model||'-'}</code></td><td>\${fmt(r.c)}</td><td>\${fmt(r.t||0)}</td></tr>\`).join('')||'<tr><td colspan="3" class="muted">No data yet.</td></tr>'}
        </tbody></table>
      </div>
      <div class="section">
        <h2>Top keys · 7 days</h2>
        <table><thead><tr><th>Key label</th><th>Requests</th><th>Tokens</th></tr></thead><tbody>
        \${(s.byKey||[]).map(r=>\`<tr><td>\${r.key_label||'-'}</td><td>\${fmt(r.c)}</td><td>\${fmt(r.t||0)}</td></tr>\`).join('')||'<tr><td colspan="3" class="muted">No data yet.</td></tr>'}
        </tbody></table>
      </div>\`;
  }catch(e){toast('Failed to load: '+e.message,1);document.getElementById('connection').textContent='✗ '+e.message}
}

async function renderKeys(){
  const root=document.getElementById('keys');
  try{
    const {keys}=await f('GET','/keys');
    root.innerHTML=\`
      <div class="section">
        <h2>Generate API key</h2>
        <div class="row">
          <input id="newLabel" placeholder="Label (es. alice)" />
          <input id="newRpm" type="number" placeholder="RPM (vuoto = default)" />
          <input id="newTokQ" type="number" placeholder="Token quota / month" />
          <input id="newReqQ" type="number" placeholder="Request quota / month" />
          <button class="btn" onclick="createKey()">Genera</button>
        </div>
        <div class="muted">La chiave generata viene mostrata UNA SOLA VOLTA. Copiala subito.</div>
      </div>
      <div class="section">
        <h2>Keys (\${keys.length})</h2>
        <table>
          <thead><tr><th>Label</th><th>Kind</th><th>Quota uso (mese)</th><th>RPM</th><th>Scopes</th><th>Created</th><th></th></tr></thead>
          <tbody>
          \${keys.map(k=>{
            const cur=k.currentPeriod||{used_tokens:0,used_requests:0};
            const tokPct=pct(cur.used_tokens,k.monthly_token_quota);
            const reqPct=pct(cur.used_requests,k.monthly_request_quota);
            const tag=k.disabled?'disabled':k.kind;
            return \`<tr>
              <td><strong>\${k.label}</strong>\${k.tenant_id?'<br><span class="muted">tenant: '+k.tenant_id+'</span>':''}\${k.notes?'<br><span class="muted">'+k.notes+'</span>':''}</td>
              <td><span class="tag \${tag}">\${tag}</span></td>
              <td>
                <div class="muted">tok \${fmt(cur.used_tokens)} / \${fmt(k.monthly_token_quota)} · \${tokPct}%</div>
                <div class="bar"><span style="width:\${tokPct}%"></span></div>
                <div class="muted" style="margin-top:6px">req \${fmt(cur.used_requests)} / \${fmt(k.monthly_request_quota)} · \${reqPct}%</div>
                <div class="bar"><span style="width:\${reqPct}%"></span></div>
              </td>
              <td>\${k.rpm??'<span class="muted">def</span>'}</td>
              <td>\${k.scopes?\`<code class="k">\${k.scopes}</code>\`:'<span class="muted">all</span>'}</td>
              <td class="muted">\${ago(k.created_at)}</td>
              <td class="flex">
                <button class="btn ghost" onclick="resetQuota(\${k.id})">Reset quota</button>
                <button class="btn ghost" onclick="toggleKey(\${k.id},\${k.disabled?0:1})">\${k.disabled?'Enable':'Disable'}</button>
                <button class="btn danger" onclick="deleteKey(\${k.id})">Elimina</button>
              </td>
            </tr>\`}).join('')}
          </tbody>
        </table>
      </div>\`;
  }catch(e){toast('Failed: '+e.message,1)}
}

async function createKey(){
  const label=document.getElementById('newLabel').value.trim();
  if(!label){toast('Inserisci una label',1);return}
  const rpm=Number(document.getElementById('newRpm').value)||null;
  const tq=Number(document.getElementById('newTokQ').value)||null;
  const rq=Number(document.getElementById('newReqQ').value)||null;
  try{
    const r=await f('POST','/keys',{label,rpm,monthlyTokenQuota:tq,monthlyRequestQuota:rq});
    if(r.secret){
      const ok=window.prompt('Chiave generata (copiala SUBITO, non sarà mostrata di nuovo):',r.secret);
      void ok;
    }
    toast('Chiave creata');
    renderKeys();
  }catch(e){toast(e.message,1)}
}
async function resetQuota(id){if(!confirm('Reset quota per questa chiave?'))return;await f('POST','/keys/'+id+'/reset-quota');toast('Quota azzerata');renderKeys()}
async function toggleKey(id,d){await f('PATCH','/keys/'+id,{disabled:d});renderKeys()}
async function deleteKey(id){if(!confirm('Eliminare questa chiave? Le richieste future saranno rifiutate.'))return;await f('DELETE','/keys/'+id);toast('Eliminata');renderKeys()}

async function renderWebhooks(){
  const root=document.getElementById('webhooks');
  try{
    const {webhooks}=await f('GET','/webhooks');
    root.innerHTML=\`
      <div class="section">
        <h2>Subscribe new webhook</h2>
        <div class="row">
          <input id="whUrl" placeholder="https://example.com/hook" />
          <select id="whEvent">
            <option value="*">All events</option>
            <option value="quota.warning">quota.warning (80%)</option>
            <option value="quota.exceeded">quota.exceeded (100%)</option>
            <option value="upstream.error">upstream.error</option>
            <option value="ratelimit.exceeded">ratelimit.exceeded</option>
            <option value="audio.error">audio.error</option>
            <option value="key.created">key.created</option>
            <option value="key.disabled">key.disabled</option>
          </select>
          <input id="whSecret" placeholder="Signing secret (opzionale)" />
          <button class="btn" onclick="createHook()">Aggiungi</button>
        </div>
        <div class="muted">Il body POST è <code class="k">{event,ts,data}</code>. Se è impostato un secret, viene aggiunto header <code class="k">X-CrimeOpus-Signature: sha256=…</code></div>
      </div>
      <div class="section">
        <h2>Subscriptions (\${webhooks.length})</h2>
        <table>
          <thead><tr><th>URL</th><th>Event</th><th>Status</th><th>Created</th><th></th></tr></thead>
          <tbody>
          \${webhooks.map(w=>\`<tr>
            <td><code class="k">\${w.url}</code>\${w.description?'<br><span class="muted">'+w.description+'</span>':''}</td>
            <td><code class="k">\${w.event}</code></td>
            <td><span class="tag \${w.enabled?'static':'disabled'}">\${w.enabled?'enabled':'disabled'}</span></td>
            <td class="muted">\${ago(w.created_at)}</td>
            <td class="flex">
              <button class="btn ghost" onclick="toggleHook(\${w.id})">\${w.enabled?'Disable':'Enable'}</button>
              <button class="btn danger" onclick="deleteHook(\${w.id})">Elimina</button>
            </td>
          </tr>\`).join('')||'<tr><td colspan="5" class="muted">Nessun webhook configurato.</td></tr>'}
          </tbody>
        </table>
      </div>\`;
  }catch(e){toast('Failed: '+e.message,1)}
}
async function createHook(){
  const url=document.getElementById('whUrl').value.trim();
  if(!url){toast('URL obbligatorio',1);return}
  await f('POST','/webhooks',{url,event:document.getElementById('whEvent').value,secret:document.getElementById('whSecret').value||undefined});
  toast('Webhook creato');renderWebhooks();
}
async function deleteHook(id){if(!confirm('Eliminare?'))return;await f('DELETE','/webhooks/'+id);renderWebhooks()}
async function toggleHook(id){await f('POST','/webhooks/'+id+'/toggle');renderWebhooks()}

async function renderDeliveries(){
  const root=document.getElementById('deliveries');
  try{
    const {deliveries}=await f('GET','/webhooks/deliveries');
    root.innerHTML=\`
      <div class="section">
        <h2>Recent deliveries (\${deliveries.length})</h2>
        <table>
          <thead><tr><th>Time</th><th>Event</th><th>URL</th><th>Status</th><th>Attempt</th><th>Detail</th></tr></thead>
          <tbody>\${deliveries.map(d=>\`<tr>
            <td class="muted">\${ago(d.ts)} ago</td>
            <td><code class="k">\${d.event}</code></td>
            <td><code class="k">\${d.url}</code></td>
            <td>\${d.status==null?'<span style="color:#ef4444">ERR</span>':d.status<400?'<span style="color:#22c55e">'+d.status+'</span>':'<span style="color:#ef4444">'+d.status+'</span>'}</td>
            <td>\${d.attempt}</td>
            <td class="muted" style="max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${d.error||d.response_excerpt||''}</td>
          </tr>\`).join('')||'<tr><td colspan="6" class="muted">Nessuna consegna ancora.</td></tr>'}</tbody>
        </table>
      </div>\`;
  }catch(e){toast('Failed: '+e.message,1)}
}

const RENDERERS={overview:renderOverview,keys:renderKeys,webhooks:renderWebhooks,deliveries:renderDeliveries};
function render(tab){RENDERERS[tab||'overview']()}

// Boot + auto-refresh overview every 10s
render('overview');
setInterval(()=>{
  const active=document.querySelector('nav button.active');
  if(active&&active.dataset.tab==='overview')renderOverview();
},10000);
</script>
</body>
</html>`
